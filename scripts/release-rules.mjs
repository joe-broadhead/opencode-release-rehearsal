// The release kit's shared rules: what a release commit may change, the identities GitHub gives the commit and the tag
// the release workflow makes, the native run a release may use, the order releases move in, and the one `gh` every kit
// script calls. Pure functions and small helpers only; no side effects at import, so every kit script and the tests can
// import it.
import { spawnSync } from "node:child_process"
import { basename } from "node:path"
import { MANIFEST_PATH } from "./native-manifest.mjs"
import { compareVersions, isReleaseTag, VERSION_SOURCE } from "./release-version.mjs"

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

/** The one GraphQL request the kit sends: the release commit (scripts/release-github.mjs commit). */
export const COMMIT_MUTATION = "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }"

const REPO = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
const SHA = "[0-9a-f]{40}"
const TAG = `v${VERSION_SOURCE}`
const exact = (source) => new RegExp(`^${source}$`)
const TAG_EXACT = exact(TAG)
const REPO_EXACT = exact(REPO)
const SHA_EXACT = exact(SHA)

/** The REST reads the kit makes: `gh api <path>`, nothing else. */
const READS = [
  `repos/${REPO}/actions/workflows/ci\\.yml/runs\\?head_sha=${SHA}&event=push&branch=master&per_page=100`,
  `repos/${REPO}/actions/runs/\\d+`,
  `repos/${REPO}/git/ref/heads/release/${TAG}`,
  `repos/${REPO}/git/ref/tags/${TAG}`,
  `repos/${REPO}/git/tags/${SHA}`,
  `repos/${REPO}/commits/${SHA}`,
  `repos/${REPO}/releases\\?per_page=100&page=\\d+`,
  `repos/${REPO}/compare/${SHA}\\.\\.\\.master`,
].map(exact)

/**
 * JSON.parse that also refuses a key repeated in one object. `gh` sends the raw text, and GitHub may read a repeated key
 * differently from JSON.parse (which keeps the last), so a body the kit checks must have one meaning only.
 */
export function strictJson(text) {
  if (typeof text !== "string") throw new Error("the body is not text")
  const value = JSON.parse(text)
  const stack = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      for (;;) {
        const quote = text.indexOf('"', j)
        let slashes = 0
        while (text[quote - 1 - slashes] === "\\") slashes++
        if (slashes % 2 === 0) {
          j = quote
          break
        }
        j = quote + 1
      }
      const top = stack.at(-1)
      if (top?.object && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1))
        if (top.keys.has(key)) throw new Error(`the key ${JSON.stringify(key)} appears twice in one object`)
        top.keys.add(key)
        top.expectKey = false
      }
      i = j
    } else if (c === "{") stack.push({ object: true, keys: new Set(), expectKey: true })
    else if (c === "[") stack.push({ object: false })
    else if (c === "}" || c === "]") stack.pop()
    else if (c === "," && stack.at(-1)?.object) stack.at(-1).expectKey = true
  }
  return value
}

/**
 * Whether a repository path is plain: relative, no empty, "." or ".." part, no backslash, NUL or other control character.
 * REST paths must also have no `%`, `#` or whitespace; file paths may.
 */
export function plainRepositoryPath(path, { rest = false } = {}) {
  if (typeof path !== "string" || path === "") return false
  const control = [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "\\")
  if (control || path.startsWith("/") || path.includes("//")) return false
  if (rest && /[%#\s]/.test(path)) return false
  return !path.split(rest ? /[/?]/ : "/").some((part) => part === "." || part === "..")
}

/** Whether a value is a plain object with exactly these keys. */
const hasKeys = (value, keys) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

/** A JSON object with exactly these keys and no repeated key, or undefined. */
function bodyWith(input, keys) {
  let body
  try {
    body = strictJson(input)
  } catch {
    return undefined
  }
  return hasKeys(body, keys) ? body : undefined
}

/**
 * Why a GraphQL body is not the release commit's createCommitOnBranch, or undefined: the kit's mutation, on
 * `repository`'s release/v<version> branch, at an expected head, with the release headline, adding only paths a release
 * commit may change, and deleting nothing.
 */
function commitRequestProblem(input, repository) {
  const body = bodyWith(input, ["query", "variables"])
  if (body?.query !== COMMIT_MUTATION) return "a GraphQL request other than the release commit's createCommitOnBranch"
  const commit = hasKeys(body.variables, ["input"]) ? body.variables.input : undefined
  if (!hasKeys(commit, ["branch", "message", "fileChanges", "expectedHeadOid"])) return "a createCommitOnBranch whose input is not the release commit's shape"
  if (!repository || !hasKeys(commit.branch, ["repositoryNameWithOwner", "branchName"]) || commit.branch.repositoryNameWithOwner !== repository) return "a createCommitOnBranch on another repository than GITHUB_REPOSITORY"
  const match = exact(`release/(${TAG})`).exec(String(commit.branch.branchName))
  if (!match) return "a createCommitOnBranch on a branch other than release/v<version>"
  if (!SHA_EXACT.test(String(commit.expectedHeadOid))) return "a createCommitOnBranch without an expected head"
  if (!hasKeys(commit.message, ["headline"]) || commit.message.headline !== releaseHeadline(match[1])) return "a createCommitOnBranch without the release headline"
  if (!hasKeys(commit.fileChanges, ["additions"]) || !Array.isArray(commit.fileChanges.additions) || !commit.fileChanges.additions.length) return "a createCommitOnBranch that deletes, or adds nothing"
  const paths = commit.fileChanges.additions.map((file) => (hasKeys(file, ["path", "contents"]) && typeof file.contents === "string" ? file.path : undefined))
  if (paths.some((path) => !plainRepositoryPath(path))) return "a createCommitOnBranch that writes a path with an empty, relative, absolute or control part"
  if (paths.some((path) => !allowedPath(path, { native: true })) || new Set(paths).size !== paths.length) return "a createCommitOnBranch that writes a path outside the release's allowed set"
  return undefined
}

/** A plain local path argument: not an option, not empty. */
const plainPath = (arg) => typeof arg === "string" && arg !== "" && !arg.startsWith("-")

/**
 * Why `gh` with these arguments, and this stdin, is not one of the calls the release kit makes, or undefined when it is.
 * An allowlist: the exact REST reads and writes, the one GraphQL mutation (compared whole), and the `gh run`, `gh
 * attestation` and `gh release` forms the kit uses. Everything else is refused, approving or rejecting a deployment,
 * environments, rulesets, their bypasses and branch protection included, in any spelling: the release approval is the
 * owner's alone (CONTRIBUTING.md, "Releasing").
 */
export function forbiddenCall(args, input, { repository = process.env.GITHUB_REPOSITORY } = {}) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return "arguments that are not strings"
  const [command, sub] = args
  // A call on a repository names exactly GITHUB_REPOSITORY; without a well-formed one, no such call is made.
  const knownRepository = typeof repository === "string" && REPO_EXACT.test(repository)
  const otherRepository = (name) => !knownRepository || name !== repository
  if (command === "api") {
    if (args.length === 4 && sub === "graphql" && args[2] === "--input" && args[3] === "-") return commitRequestProblem(input, repository)
    const method = sub === "-X" ? args[2] : "GET"
    const path = sub === "-X" ? args[3] : sub
    if (!plainRepositoryPath(path, { rest: true })) return "a path with encoded, empty or relative parts"
    if (!knownRepository) return "a call on a repository while GITHUB_REPOSITORY is unset or not owner/name"
    if (otherRepository(path.split("/").slice(1, 3).join("/"))) return `a call on another repository than ${repository}`
    const rest = args.slice(sub === "-X" ? 4 : 2)
    if (method === "GET") return rest.length === 0 && READS.some((pattern) => pattern.test(path)) ? undefined : `GET ${path}, which the kit never reads`
    if (method === "DELETE") return rest.length === 0 && exact(`repos/${REPO}/git/refs/heads/release/${TAG}`).test(path) ? undefined : `DELETE ${path}`
    if (method !== "POST") return `${method} ${path}`
    if (exact(`repos/${REPO}/git/refs`).test(path)) {
      if (rest.length === 4 && rest[0] === "-f" && rest[2] === "-f" && exact(`ref=refs/heads/release/${TAG}`).test(rest[1]) && exact(`sha=${SHA}`).test(rest[3])) return undefined
      const body = rest.length === 2 && rest[0] === "--input" && rest[1] === "-" ? bodyWith(input, ["ref", "sha"]) : undefined
      return body && exact(`refs/tags/${TAG}`).test(String(body.ref)) && SHA_EXACT.test(String(body.sha)) ? undefined : "a ref other than release/<tag> at a commit or the release tag"
    }
    if (exact(`repos/${REPO}/git/tags`).test(path)) {
      const body = rest.length === 2 && rest[0] === "--input" && rest[1] === "-" ? bodyWith(input, ["message", "object", "tag", "tagger", "type"]) : undefined
      return body && TAG_EXACT.test(String(body.tag)) && body.message === body.tag && body.type === "commit" && SHA_EXACT.test(String(body.object)) ? undefined : "a tag object other than the release tag's"
    }
    return `POST ${path}`
  }
  if ((command === "run" || command === "attestation") && !knownRepository) return "a call on a repository while GITHUB_REPOSITORY is unset or not owner/name"
  if ((command === "run" || command === "attestation") && args.includes("--repo") && otherRepository(args[args.indexOf("--repo") + 1])) return `a call on another repository than ${repository}`
  if (command === "run" && sub === "download" && /^\d+$/.test(args[2] ?? "") && args[3] === "--repo" && REPO_EXACT.test(args[4] ?? "")) {
    const rest = args.slice(5)
    if (rest.length === 4 && rest[0] === "--name" && rest[1] === "native-manifest" && rest[2] === "--dir" && plainPath(rest[3])) return undefined
    if (rest.length === 2 && rest[0] === "--dir" && plainPath(rest[1])) return undefined
    return "a run download the kit does not make"
  }
  if (command === "attestation" && sub === "verify" && args.length === 5 && plainPath(args[2]) && args[3] === "--repo" && REPO_EXACT.test(args[4])) return undefined
  if (command === "release" && TAG_EXACT.test(args[2] ?? "")) {
    const [, , tag, ...rest] = args
    if (sub === "view" && rest.length === 2 && rest[0] === "--json" && rest[1] === "assets,isDraft") return undefined
    if (sub === "download" && rest.length === 4 && rest[0] === "--pattern" && plainPath(rest[1]) && rest[2] === "--dir" && plainPath(rest[3])) return undefined
    if (sub === "upload" && rest.length > 0 && rest.every(plainPath)) return undefined
    if (sub === "create" && rest[0] === "--verify-tag" && rest[1] === "--title" && rest[2] === tag && rest[3] === "--notes-file" && rest.length > 5 && rest.slice(4).every(plainPath)) return undefined
    return `gh release ${sub} in a form the kit does not use`
  }
  return `gh ${[command, sub].filter(Boolean).join(" ")}, which the kit never runs`
}

/**
 * Runs `gh`, only for a call the kit makes (forbiddenCall), and returns its output, or throws with its message. `input`
 * is sent on stdin, re-serialised from the checked body, so gh sends exactly what was checked. With `inherit`, gh's
 * output goes to this process's, and nothing is returned. `repository` (GITHUB_REPOSITORY by default) is the one
 * repository every call may name.
 */
export function ghOutput(args, { input, inherit = false, repository = process.env.GITHUB_REPOSITORY } = {}) {
  const forbidden = forbiddenCall(args, input, { repository })
  if (forbidden) throw new Error(`refused: the release kit makes only its own GitHub calls, and not ${forbidden}; only the owner approves a release`)
  const sent = input === undefined ? undefined : JSON.stringify(strictJson(input))
  const result = spawnSync("gh", args, { encoding: "utf8", input: sent, maxBuffer: 256 * 1024 * 1024, stdio: inherit ? ["pipe", "inherit", "inherit"] : "pipe" })
  if (result.error) throw new Error(`gh could not run: ${result.error.message}`)
  if (result.status !== 0) throw new Error(inherit ? `gh ${args.slice(0, 2).join(" ")} failed (exit ${result.status})` : ghError(result.stderr, result.status))
  return inherit ? "" : result.stdout
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
