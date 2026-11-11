// The release kit's shared rules: what a release commit may change, the identities GitHub gives the commit and the tag
// the release workflow makes, the native run a release may use, the order releases move in, and the one `gh` every kit
// script calls. Pure functions and small helpers only; no side effects at import, so every kit script and the tests can
// import it.
import { spawnSync } from "node:child_process"
import { basename } from "node:path"
import { MANIFEST_PATH } from "./native-manifest.mjs"
import { compareVersions, isReleaseTag } from "./release-version.mjs"

/** Lifecycle scripts a git install runs, or that npm runs around install and publish. The release commit drops them. */
export const LIFECYCLE_SCRIPTS = [
  "build",
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
]

/** The author of a commit made with the release workflow's token, and the tagger the kit writes on the tag. Public, fixed. */
export const ACTIONS_BOT = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com", login: "github-actions[bot]" }
/** The committer GitHub records, and signs as, for a commit made through its API ("web-flow"). Public, fixed. */
export const WEB_FLOW = { name: "GitHub", email: "noreply@github.com" }

/** The release commit's headline. */
export const releaseHeadline = (tag) => `chore(release): ${tag} with the built dist/ and no lifecycle scripts`
/** The temporary branch the release commit is made on, before the tag exists. */
export const releaseBranch = (tag) => `release/${tag}`

/**
 * The paths the release commit may add or change. The manifest is allowed only for a native plugin. No package.json
 * under dist/: one there would change how the host resolves the bundles.
 */
export function allowedPath(path, { native = false } = {}) {
  if (path.startsWith("dist/")) return !/(^|\/)package\.json$/.test(path.slice("dist/".length))
  return path === "package.json" || (native && path === MANIFEST_PATH)
}

/** The one git mode a release path may have: a regular, non-executable file. No symlink, executable or submodule. */
export const RELEASE_MODE = "100644"

/** The paths, of { path, mode } entries, whose git mode is not RELEASE_MODE, as sentences. */
export function modeProblems(entries) {
  const kinds = { "100755": "an executable", "120000": "a symlink", "160000": "a submodule", "000000": "deleted" }
  return entries.filter(({ mode }) => mode !== RELEASE_MODE).map(({ path, mode }) => `${path} is ${kinds[mode] ?? `mode ${mode}`}, not a regular file`)
}

/** package.json with its lifecycle scripts removed. Keys keep their order, and the JSON form stays the repository's. */
export function withoutLifecycle(pkg) {
  const scripts = pkg.scripts ?? {}
  const removed = Object.keys(scripts).filter((name) => LIFECYCLE_SCRIPTS.includes(name))
  const kept = Object.fromEntries(Object.entries(scripts).filter(([name]) => !LIFECYCLE_SCRIPTS.includes(name)))
  const next = { ...pkg }
  if (Object.keys(kept).length) next.scripts = kept
  else delete next.scripts
  return { next, removed }
}

export const serialise = (pkg) => `${JSON.stringify(pkg, null, 2)}\n`

/** The release commit's package.json, exactly: the parent's, without its lifecycle scripts, in the canonical form. */
export const releasePackageText = (pkg) => serialise(withoutLifecycle(pkg).next)

/**
 * Why a release commit, as the REST API returns it (GET repos/{r}/commits/{sha}), is not one the release workflow made:
 * GitHub verifies its signature, its author is github-actions[bot], its committer is GitHub's web-flow, and it has one
 * parent. Sentences; an address that is not one of the two fixed public ones is never printed.
 */
export function commitIdentityProblems(apiCommit) {
  const problems = []
  const verification = apiCommit?.commit?.verification
  if (verification?.verified !== true || verification.reason !== "valid") {
    problems.push(`GitHub does not verify the release commit's signature (reason: ${verification?.reason ?? "none"})`)
  }
  const author = apiCommit?.commit?.author ?? {}
  if (author.email !== ACTIONS_BOT.email) problems.push(`the release commit's author is another address, not ${ACTIONS_BOT.name}`)
  if (apiCommit?.author?.login !== ACTIONS_BOT.login || apiCommit?.author?.type !== "Bot") {
    problems.push(`the release commit's author account is not the ${ACTIONS_BOT.login} app`)
  }
  const committer = apiCommit?.commit?.committer ?? {}
  if (committer.email !== WEB_FLOW.email || committer.name !== WEB_FLOW.name) problems.push("the release commit's committer is not GitHub's web-flow")
  const parents = apiCommit?.parents ?? []
  if (parents.length !== 1) problems.push(`the release commit has ${parents.length} parents; it needs exactly one`)
  return problems
}

/** Why a tag ref, as the REST API returns it (GET repos/{r}/git/ref/tags/{tag}), is not an annotated tag. */
export function tagRefProblems(apiRef, tag) {
  if (!apiRef?.object) return [`there is no tag ${tag}`]
  return apiRef.object.type === "tag" ? [] : [`${tag} is a lightweight tag (it points at a ${apiRef.object.type}), not an annotated one`]
}

/**
 * Why a tag object, as the REST API returns it (GET repos/{r}/git/tags/{sha}), is not the one the release workflow makes
 * for `tag` on `commit`: named and titled exactly the tag, on that commit, tagged by github-actions[bot], and unsigned.
 * A signature of any kind, valid or not, is refused: the kit never signs a tag.
 */
export function tagObjectProblems(apiTag, { tag, commit }) {
  const problems = []
  if (!apiTag || typeof apiTag !== "object") return [`the tag object of ${tag} could not be read`]
  if (apiTag.tag !== tag) problems.push(`the tag object is named ${apiTag.tag}, not ${tag}`)
  if (typeof apiTag.message !== "string" || apiTag.message.replace(/\n$/, "") !== tag) problems.push(`the tag message is not exactly ${tag}`)
  if (apiTag.object?.type !== "commit") problems.push(`the tag points at a ${apiTag.object?.type ?? "missing object"}, not a commit`)
  else if (commit !== undefined && apiTag.object.sha !== commit) problems.push(`the tag points at ${String(apiTag.object.sha).slice(0, 12)}, not the release commit ${commit.slice(0, 12)}`)
  if (apiTag.tagger?.email !== ACTIONS_BOT.email || apiTag.tagger?.name !== ACTIONS_BOT.name) problems.push(`the tagger is not ${ACTIONS_BOT.name}`)
  const verification = apiTag.verification
  if (verification?.verified !== false || verification.reason !== "unsigned") {
    problems.push(`the tag must be unsigned, and GitHub says ${verification?.verified ? "verified" : "not verified"} (${verification?.reason ?? "no verification"})`)
  }
  return problems
}

/**
 * Why a native run, as the REST API returns it (GET repos/{r}/actions/runs/{id}), cannot supply the release's native
 * files: it must have built `sha`, succeeded, be the native workflow, on master, started by hand (workflow_dispatch).
 */
export function nativeRunProblems(run, { sha }) {
  const problems = []
  if (run?.head_sha !== sha) problems.push(`the run built ${String(run?.head_sha).slice(0, 12)}, not ${sha.slice(0, 12)}`)
  if (run?.conclusion !== "success") problems.push(`the run concluded ${run?.conclusion ?? "nothing yet"}`)
  if (basename(String(run?.path ?? "")) !== "native.yml") problems.push("the run is not the native workflow")
  if (run?.head_branch !== "master") problems.push("the run is not on master")
  if (run?.event !== "workflow_dispatch") problems.push(`the run was started by ${run?.event}, not workflow_dispatch`)
  return problems
}

/** The tags of the published GitHub Releases, from the Releases API: not drafts, published, and named v<x.y.z>. */
export function releasedTags(releases) {
  return releases.filter((release) => release?.draft === false && Boolean(release.published_at) && isReleaseTag(release.tag_name)).map((release) => release.tag_name)
}

/** Every Release of a repository, page by page, through the GitHub CLI. `gh(args)` returns its output or throws. */
export function fetchReleases(repository, gh) {
  const all = []
  for (let page = 1; ; page++) {
    const batch = JSON.parse(gh(["api", `repos/${repository}/releases?per_page=100&page=${page}`]))
    if (!Array.isArray(batch)) throw new Error("the Releases API did not answer with a list")
    all.push(...batch)
    if (batch.length < 100) return all
  }
}

/**
 * GitHub calls the kit never makes, whoever asks: approving or rejecting a deployment, changing an environment or a
 * protection rule, and touching rulesets or their bypasses. The release approval is the owner's alone (CONTRIBUTING.md,
 * "Releasing"); the kit refuses these before `gh` runs.
 */
const FORBIDDEN = [
  [/pending_deployments/, "approving or rejecting a deployment"],
  [/deployment_protection_rule/, "answering a deployment protection rule"],
  [/(^|\/)environments(\/|$|\?)/, "reading or changing an environment"],
  [/(^|\/)rulesets(\/|$|\?)/, "reading or changing a ruleset"],
  [/bypass/i, "a ruleset bypass"],
  [/(^|\/)branches\/[^/]+\/protection/, "changing branch protection"],
]

/** GraphQL mutations the kit never sends, for the same reasons. */
const FORBIDDEN_MUTATIONS = /\b(approveDeployments|rejectDeployments|\w*Environment\w*|\w*Ruleset\w*|\w*BypassRequest\w*|\w*BranchProtectionRule\w*)\s*\(/

/**
 * Why `gh` with these arguments, and this stdin for `gh api graphql --input -`, is a call the kit must never make, or
 * undefined. Only the GraphQL query text is read from the input, never the variables (file contents).
 */
export function forbiddenCall(args, input) {
  const text = args.join(" ")
  if (args[0] === "run" && ["approve", "deploy"].includes(args[1])) return "approving a run"
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) return what
  const graphql = [...args.filter((arg) => /^query=/.test(arg)).map((arg) => arg.slice("query=".length))]
  if (input !== undefined) {
    try {
      graphql.push(String(JSON.parse(input).query ?? ""))
    } catch {
      return "a GraphQL request the kit cannot read"
    }
  }
  if (graphql.some((query) => FORBIDDEN_MUTATIONS.test(query))) return "a deployment, environment, ruleset or protection mutation"
  return undefined
}

/**
 * The GitHub CLI's output, or an error with its message. Refuses a forbidden call before running anything. `input` is
 * sent on stdin (a GraphQL request with --input -).
 */
export function ghOutput(args, { input } = {}) {
  const forbidden = forbiddenCall(args, input)
  if (forbidden) throw new Error(`refused: the release kit never makes this call (${forbidden}); only the owner approves a release`)
  const result = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw new Error(`gh could not run: ${result.error.message}`)
  if (result.status !== 0) throw new Error(ghError(result.stderr, result.status))
  return result.stdout
}

/** gh's error text, one line: the line naming the HTTP status when there is one, else the first non-empty line. */
function ghError(stderr, status) {
  const lines = String(stderr || "").split("\n").map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => /HTTP \d{3}/.test(line)) ?? lines.find((line) => !/^Tip: |boxd/.test(line)) ?? `gh exited ${status}`
}

/** A REST read through `gh`, parsed; undefined when GitHub answers 404 and `allow404` is set. */
export function api(gh, path, { allow404 = false } = {}) {
  try {
    return JSON.parse(gh(["api", path]))
  } catch (error) {
    if (allow404 && /HTTP 404|Not Found/.test(String(error.message))) return undefined
    throw error
  }
}

/** owner/name of a checkout's origin, when it is a GitHub remote. */
export function originRepository(cwd) {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", cwd })
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(result.status === 0 ? result.stdout.trim() : "")?.[1]
}

/**
 * Whether a release of `tag` on `parent` moves forward from the published Releases (`released`, their tag names): every
 * other one is an older version, and the newest of them has a parent that is an ancestor of `parent`, or is it. A tag
 * that never became a Release does not count. Returns { previous, problem }: the last Release, and why the release is
 * refused, or undefined. The previous Release's tag must be in the checkout at `cwd`, to read its parent.
 */
export function releaseOrder({ tag, parent, released, cwd }) {
  const version = tag.slice(1)
  const others = [...new Set(released)].filter((name) => name !== tag)
  const newer = others.filter((name) => compareVersions(name.slice(1), version) >= 0)
  if (newer.length) return { problem: `the published Release ${newer.join(", ")} is not older than ${tag}` }
  const previous = others.sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0]
  if (!previous) return { previous }
  const read = spawnSync("git", ["rev-parse", "-q", "--verify", `${previous}^{commit}^`], { encoding: "utf8", cwd })
  if (read.status !== 0) return { previous, problem: `the tag ${previous} is not in this checkout, so its parent cannot be read: fetch the tags` }
  if (spawnSync("git", ["merge-base", "--is-ancestor", read.stdout.trim(), parent], { cwd }).status !== 0) {
    return { previous, problem: `the parent does not descend from the parent of ${previous}, the last Release: the release would ship older source` }
  }
  return { previous }
}
