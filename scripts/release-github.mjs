#!/usr/bin/env node
// The release workflow's GitHub steps (.github/workflows/release.yml). Each subcommand is one job's write or check:
//
//   plan    --sha <P> [--native-run <id>] [--manifest-out <file>]
//           Refuses a release that must not start: a run not on master, a sha that is not master's head, no green CI on
//           it, a version or CHANGELOG not ready, a leftover release branch, a release that does not move forward, a
//           native run that is wrong, or one given to a plugin that is not native. Finds a tag left by a run that failed
//           after tagging (mode resume). Writes version, tag, hosts, native, mode, commit, ci_run and manifest_sha256 (the
//           vetted native manifest's, which the commit job requires byte for byte) to GITHUB_OUTPUT.
//   commit  --files <dir> --parent <P> --tag <tag> --native <true|false> [--manifest-sha256 <the plan's>]
//           Makes the release commit on the temporary branch release/<tag>, with GraphQL createCommitOnBranch and the
//           workflow's token, so GitHub signs it. Checks the files, computes the tree they must give, and refuses a commit
//           that GitHub does not verify, that has another parent, or another tree. Deletes the branch when it fails.
//   tag     --tag <tag> --commit <C> --parent <P> --mode <new|resume>
//           After the owner's approval: checks everything again, then creates the annotated, unsigned tag on C, or
//           reuses one the kit already made there. Never moves or replaces a tag.
//   cleanup --tag <tag> --parent <P> [--commit <C>]
//           Deletes release/<tag> when it points at P, at C, or (C unknown) at a release commit the kit made on P.
//           Never touches another branch, or the branch at any other commit.
//   native  --dir <dir> --commit <C>
//           Checks the staged Release files against C's manifest/native.json: each native file's size and sha256, each
//           gzip's executable, nothing unpinned, nothing missing, and only SHA256SUMS and one tarball besides.
//   sums    --dir <dir> --sums-sha256 <digest>
//           Checks that the staged SHA256SUMS has the digest the approver saw in the run summary, and every staged
//           Release file against it.
//
// The repository is GITHUB_REPOSITORY. Every `gh` call of the kit, here and in check-release-shape.mjs,
// publish-release.mjs and attach-native.mjs, goes through ghOutput (scripts/release-rules.mjs), which allows only the
// kit's own calls: never approving or rejecting a deployment, environments, rulesets, bypasses or branch protection.
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { gunzipSync } from "node:zlib"
import { basename, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { changelogProblems } from "./changelog.mjs"
import { MANIFEST_PATH, manifestProblems } from "./native-manifest.mjs"
import { NATIVE_WORKFLOW, sha256 } from "./release-commit.mjs"
import {
  ACTIONS_BOT,
  allowedPath,
  api,
  COMMIT_MUTATION,
  commitIdentityProblems,
  fetchReleases,
  ghOutput,
  nativeRunProblems,
  packageProblems,
  releaseBranch,
  releasedTags,
  releaseHeadline,
  releaseOrder,
  releasePackageText,
  tagObjectProblems,
  tagRefProblems,
} from "./release-rules.mjs"
import { isReleaseTag, tagFor, versionProblem } from "./release-version.mjs"
import { testedHosts } from "./tested-hosts.mjs"

const SHA1 = /^[0-9a-f]{40}$/
const MB = 1024 * 1024
/** createCommitOnBranch's limits, as tools/gh-push.mjs proved them: 5 MB per file, and the request's base64 under 40 MB. */
export const MAX_FILE = 5 * MB
export const MAX_PAYLOAD = 40 * MB

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message)
}

function gitIn(cwd, args, { env, allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: env ?? process.env, maxBuffer: 64 * MB })
  if (result.status !== 0) {
    if (allowFailure) return undefined
    refuse(`git ${args[0]} failed: ${(result.stderr || "").trim().split("\n")[0]}`)
  }
  return result.stdout.trim()
}

function repositoryOf(env) {
  const repository = env.GITHUB_REPOSITORY
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) refuse("GITHUB_REPOSITORY is not set to owner/name")
  return repository
}

/**
 * The CI run a release stands on: the newest run of ci.yml for a push to master on exactly `sha`. Returns { run } or
 * { problem }. Every run on the sha must have finished, and the newest must have succeeded.
 */
export function ciProblem(runs, sha) {
  const mine = (runs ?? []).filter((run) => run.head_sha === sha && run.event === "push" && run.head_branch === "master" && basename(String(run.path ?? "")) === "ci.yml")
  if (!mine.length) return { problem: `no ci.yml run for a push to master on ${sha.slice(0, 12)}: push it to master, and wait for CI` }
  const running = mine.filter((run) => run.status !== "completed")
  if (running.length) return { problem: `CI is still running on ${sha.slice(0, 12)} (run ${running.map((run) => run.id).join(", ")}): wait for it` }
  const newest = [...mine].sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1))[0]
  if (newest.conclusion !== "success") return { problem: `the newest CI run on ${sha.slice(0, 12)} (run ${newest.id}) concluded ${newest.conclusion}` }
  return { run: newest }
}

/** The plan job: every refusal before anything is built or written. Returns the outputs; throws a Refusal. */
export function plan({ sha, nativeRun, manifestOut, env, gh, cwd }) {
  const repository = repositoryOf(env)
  if (env.GITHUB_REF !== "refs/heads/master") refuse(`a release runs from master only, and this run is on ${env.GITHUB_REF}`)
  if (!SHA1.test(sha ?? "")) refuse("--sha must be the full 40-character sha of the master head CI passed")
  if (env.GITHUB_SHA !== sha) refuse(`the run is on master at ${String(env.GITHUB_SHA).slice(0, 12)}, not ${sha.slice(0, 12)}: dispatch again with master's head, or wait for CI on it`)
  if (gitIn(cwd, ["rev-parse", "HEAD"]) !== sha) refuse(`the checkout is not ${sha.slice(0, 12)}`)

  const pkgText = readFileSync(join(cwd, "package.json"), "utf8")
  const packageRefusals = packageProblems(pkgText)
  if (packageRefusals.length) refuse(packageRefusals.join("; "))
  const pkg = JSON.parse(pkgText)
  const versionRefusal = versionProblem(pkg.version)
  if (versionRefusal) refuse(versionRefusal)
  const tag = tagFor(pkg.version)
  if (!pkg.scripts?.build) refuse('package.json has no "build" script: the release builds with npm run build')
  const changelogPath = join(cwd, "CHANGELOG.md")
  if (!existsSync(changelogPath)) refuse("there is no CHANGELOG.md: the release notes come from it")
  const changelog = changelogProblems(readFileSync(changelogPath, "utf8"), pkg.version)
  if (changelog.length) refuse(`CHANGELOG.md is not ready for ${tag}: ${changelog.join("; ")}`)

  const native = existsSync(join(cwd, NATIVE_WORKFLOW))
  const run = nativeRun === undefined || nativeRun === "" ? undefined : nativeRun
  if (native && run === undefined) refuse(`this plugin is native: run the native workflow on ${sha.slice(0, 12)}, then dispatch with native_run set to its run id`)
  if (!native && run !== undefined) refuse(`native_run is set, and this plugin has no ${NATIVE_WORKFLOW}: dispatch without it`)
  if (run !== undefined && !/^\d+$/.test(run)) refuse("native_run must be a run id")

  const ci = ciProblem(api(gh, `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=master&per_page=100`).workflow_runs, sha)
  if (ci.problem) refuse(ci.problem)

  let manifestText = ""
  if (run !== undefined) {
    const problems = nativeRunProblems(api(gh, `repos/${repository}/actions/runs/${run}`), { sha })
    if (problems.length) refuse(`native run ${run}: ${problems.join("; ")}`)
    const dir = mkdtempSync(join(tmpdir(), "native-manifest-"))
    let manifest
    try {
      gh(["run", "download", run, "--repo", repository, "--name", "native-manifest", "--dir", dir])
      try {
        manifest = JSON.parse(readFileSync(join(dir, "native.json"), "utf8"))
      } catch {
        refuse(`native run ${run} has no native-manifest artifact with native.json`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const manifestRefusals = manifestProblems(manifest, { plugin: pkg.name.replace(/^@[^/]+\//, ""), tag, commit: sha, repository })
    if (manifestRefusals.length) refuse(`the native manifest of run ${run} is not right: ${manifestRefusals.join("; ")}`)
    // The bytes the build job copies into the release commit; the commit job refuses any other (manifest_sha256).
    manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    if (manifestOut) {
      mkdirSync(join(manifestOut, ".."), { recursive: true })
      writeFileSync(manifestOut, manifestText)
    }
  }

  const branch = releaseBranch(tag)
  if (api(gh, `repos/${repository}/git/ref/heads/${branch}`, { allow404: true })) {
    refuse(`the branch ${branch} is left from an earlier run: check it is not a run waiting for approval, then delete it (gh api -X DELETE repos/${repository}/git/refs/heads/${branch})`)
  }

  let released
  try {
    released = releasedTags(fetchReleases(repository, gh))
  } catch (error) {
    refuse(`the published Releases could not be listed (${error.message})`)
  }
  if (released.includes(tag)) refuse(`${tag} is already a published Release: release the next version`)

  // A tag that exists is a resume only when the kit made it, on a release commit on this sha, and it never became a
  // published Release. Any other tag burns the version.
  let mode = "new"
  let commit = ""
  const ref = api(gh, `repos/${repository}/git/ref/tags/${tag}`, { allow404: true })
  if (ref) {
    const why = (problems) => refuse(`the tag ${tag} exists and is not one this release can resume (${problems.join("; ")}): release the next version`)
    const refProblems = tagRefProblems(ref, tag)
    if (refProblems.length) why(refProblems)
    const tagObject = api(gh, `repos/${repository}/git/tags/${ref.object.sha}`)
    const tagged = tagObject?.object?.sha
    const objectProblems = tagObjectProblems(tagObject, { tag, commit: tagged })
    if (objectProblems.length) why(objectProblems)
    const apiCommit = api(gh, `repos/${repository}/commits/${tagged}`)
    const identity = commitIdentityProblems(apiCommit)
    if (identity.length) why(identity)
    if (apiCommit.parents[0].sha !== sha) why([`its release commit's parent is ${apiCommit.parents[0].sha.slice(0, 12)}, not ${sha.slice(0, 12)}`])
    mode = "resume"
    commit = tagged
  }

  const order = releaseOrder({ tag, parent: sha, released, cwd })
  if (order.problem) refuse(order.problem)

  let hosts
  try {
    hosts = testedHosts(cwd)
  } catch (error) {
    refuse(error.message)
  }
  return { version: pkg.version, tag, hosts: JSON.stringify(hosts), native: String(native), mode, commit, ci_run: String(ci.run.id), previous: order.previous ?? "", manifest_sha256: manifestText ? sha256(manifestText) : "" }
}

/** Every file under a folder, as repository paths, refusing anything that is not a regular file or a folder. */
function walkFiles(root) {
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const stat = lstatSync(full)
      const path = relative(root, full).split("\\").join("/")
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) found.push(path)
      else refuse(`${path} is not a regular file`)
    }
  }
  walk(root)
  return found
}

/**
 * The files the build job wrote, checked: exactly the paths and sha256s of its paths.txt, each in the allowed set, a
 * package.json that is exactly the parent's without its lifecycle scripts, the manifest only for a native plugin, and the
 * sizes createCommitOnBranch takes. Returns [{ path, bytes }].
 */
export function releaseFiles({ dir, parent, native, cwd, manifestSha256, limits = { file: MAX_FILE, payload: MAX_PAYLOAD } }) {
  const listedText = existsSync(join(dir, "paths.txt")) ? readFileSync(join(dir, "paths.txt"), "utf8") : refuse("the release files have no paths.txt")
  const listed = new Map()
  for (const line of listedText.split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
    if (!match || listed.has(match[2])) refuse(`paths.txt has a line that is not one "<sha256>  <path>": ${line.slice(0, 80)}`)
    listed.set(match[2], match[1])
  }
  const found = walkFiles(dir).filter((path) => path !== "paths.txt")
  const unlisted = found.filter((path) => !listed.has(path))
  const missing = [...listed.keys()].filter((path) => !found.includes(path))
  if (unlisted.length || missing.length) refuse(`the release files are not what the build listed: ${[...unlisted.map((p) => `extra ${p}`), ...missing.map((p) => `missing ${p}`)].join(", ")}`)

  const outside = found.filter((path) => !allowedPath(path, { native }))
  if (outside.length) refuse(`paths outside the allowed set: ${outside.join(", ")}`)
  if (!found.includes("package.json") || !found.some((path) => path.startsWith("dist/"))) refuse("the release commit must add dist/ and change package.json")
  if (native !== found.includes(MANIFEST_PATH)) refuse(native ? `a native plugin's release needs ${MANIFEST_PATH}` : `${MANIFEST_PATH} is only for a native plugin`)
  if (native && !/^[0-9a-f]{64}$/.test(manifestSha256 ?? "")) refuse("a native plugin's release needs the sha256 of the manifest the plan job vetted (--manifest-sha256)")

  let payload = 0
  const files = found.map((path) => {
    const bytes = readFileSync(join(dir, path))
    if (sha256(bytes) !== listed.get(path)) refuse(`${path} does not match its sha256 in paths.txt`)
    if (bytes.length > limits.file) refuse(`${path} is ${(bytes.length / MB).toFixed(1)} MB, over the ${(limits.file / MB).toFixed(1)} MB a file can be`)
    if (path === MANIFEST_PATH && sha256(bytes) !== manifestSha256) refuse(`${MANIFEST_PATH} is not, byte for byte, the manifest the plan job vetted`)
    payload += Math.ceil(bytes.length / 3) * 4 + path.length
    return { path, bytes }
  })
  if (payload > limits.payload) refuse(`the release commit needs a ${(payload / MB).toFixed(1)} MB request, over the ${(limits.payload / MB).toFixed(1)} MB limit`)

  const parentPkg = gitIn(cwd, ["show", `${parent}:package.json`])
  const expected = releasePackageText(JSON.parse(parentPkg))
  if (files.find((file) => file.path === "package.json").bytes.toString("utf8") !== expected) refuse("package.json is not exactly the parent's without its lifecycle scripts")
  return files
}

/** The tree the release commit must have: the parent's, with the files written as regular files. Computed locally. */
export function expectedTree({ files, parent, cwd, dir }) {
  const folder = mkdtempSync(join(tmpdir(), "release-index-"))
  const env = { ...process.env, GIT_INDEX_FILE: join(folder, "index") }
  try {
    gitIn(cwd, ["read-tree", parent], { env })
    for (const file of files) {
      const blob = gitIn(cwd, ["hash-object", "-w", "--no-filters", "--", join(dir, file.path)], { env })
      gitIn(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`], { env })
    }
    return gitIn(cwd, ["write-tree"], { env })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

/** The commit job. Returns { commit, tree }; throws after deleting the branch it made, when anything is wrong. */
export function commit({ dir, parent, tag, native, manifestSha256, env, gh, cwd, limits, sleep = pause, output = () => {}, log = () => {} }) {
  const repository = repositoryOf(env)
  if (!isReleaseTag(tag)) refuse(`${tag} is not a release tag`)
  if (!SHA1.test(parent ?? "")) refuse("--parent must be a full sha")
  const files = releaseFiles({ dir, parent, native, cwd, manifestSha256, limits })
  const tree = expectedTree({ files, parent, cwd, dir })
  log(`${files.length} files checked; the release commit's tree must be ${tree}`)

  const branch = releaseBranch(tag)
  if (api(gh, `repos/${repository}/git/ref/heads/${branch}`, { allow404: true })) refuse(`the branch ${branch} already exists`)
  gh(["api", "-X", "POST", `repos/${repository}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${parent}`])
  log(`created ${branch} at ${parent}`)

  let made
  const fail = (message) => {
    let cleaned
    try {
      cleaned = cleanup({ tag, parent, commit: made, env, gh }).message
    } catch (error) {
      cleaned = `${branch} could not be deleted (${error.message}); the cleanup job tries again`
    }
    refuse(`${message}; ${cleaned}`)
  }
  const input = {
    branch: { repositoryNameWithOwner: repository, branchName: branch },
    message: { headline: releaseHeadline(tag) },
    fileChanges: { additions: files.map((file) => ({ path: file.path, contents: file.bytes.toString("base64") })) },
    expectedHeadOid: parent,
  }
  try {
    made = JSON.parse(gh(["api", "graphql", "--input", "-"], { input: JSON.stringify({ query: COMMIT_MUTATION, variables: { input } }) })).data.createCommitOnBranch.commit.oid
  } catch (error) {
    fail(`createCommitOnBranch failed: ${error.message}`)
  }
  if (!SHA1.test(made ?? "")) fail("createCommitOnBranch returned no commit")
  output("commit", made)

  let apiCommit
  for (let attempt = 0; ; attempt++) {
    apiCommit = api(gh, `repos/${repository}/commits/${made}`)
    const reason = apiCommit?.commit?.verification?.reason
    if (apiCommit?.commit?.verification?.verified || attempt >= 5 || !/gpgverify_(unavailable|error)/.test(String(reason))) break
    sleep(2000)
  }
  const problems = commitIdentityProblems(apiCommit)
  if (apiCommit?.parents?.[0]?.sha !== parent) problems.push(`its parent is not ${parent.slice(0, 12)}`)
  if (apiCommit?.commit?.tree?.sha !== tree) problems.push(`its tree is ${String(apiCommit?.commit?.tree?.sha).slice(0, 12)}, and the files give ${tree.slice(0, 12)}`)
  if (problems.length) fail(`the release commit ${made.slice(0, 12)} is not right: ${problems.join("; ")}`)
  output("tree", tree)
  log(`release commit ${made} on ${branch}: verified (valid), author ${ACTIONS_BOT.name}, parent ${parent.slice(0, 12)}, tree ${tree.slice(0, 12)}`)
  return { commit: made, tree }
}

/**
 * Deletes release/<tag> when it points at the parent, at the run's commit, or, when the run's commit is unknown, at a
 * release commit the kit made on the parent. Returns { action, message }: absent, deleted or left.
 */
export function cleanup({ tag, parent, commit: made, env, gh }) {
  const repository = repositoryOf(env)
  if (!isReleaseTag(tag)) refuse(`${tag} is not a release tag, so there is no release branch to clean up`)
  const branch = releaseBranch(tag)
  const ref = api(gh, `repos/${repository}/git/ref/heads/${branch}`, { allow404: true })
  if (!ref) return { action: "absent", message: `${branch} does not exist` }
  const at = ref.object?.sha
  let ours = at === parent || (made && at === made)
  if (!ours && !made && at) {
    const apiCommit = api(gh, `repos/${repository}/commits/${at}`, { allow404: true })
    ours = Boolean(apiCommit) && !commitIdentityProblems(apiCommit).length && apiCommit.parents[0].sha === parent && apiCommit.commit.message.split("\n")[0] === releaseHeadline(tag)
  }
  if (!ours) return { action: "left", message: `${branch} points at ${String(at).slice(0, 12)}, which is neither the parent nor this run's commit: left alone` }
  gh(["api", "-X", "DELETE", `repos/${repository}/git/refs/heads/${branch}`])
  return { action: "deleted", message: `deleted ${branch} (it pointed at ${at.slice(0, 12)})` }
}

/** The publish job's tag step. Returns { action: created | reused, tagObject }; throws before any write when a check fails. */
export function tagRelease({ tag, commit: release, parent, mode, env, gh, cwd, now = () => new Date().toISOString() }) {
  const repository = repositoryOf(env)
  if (!isReleaseTag(tag)) refuse(`${tag} is not a release tag`)
  if (!SHA1.test(release ?? "") || !SHA1.test(parent ?? "")) refuse("--commit and --parent must be full shas")
  if (!["new", "resume"].includes(mode)) refuse("--mode is new or resume")

  const apiCommit = api(gh, `repos/${repository}/commits/${release}`)
  const identity = commitIdentityProblems(apiCommit)
  if (identity.length) refuse(`the release commit is not right: ${identity.join("; ")}`)
  if (apiCommit.parents[0].sha !== parent) refuse(`the release commit's parent is not ${parent.slice(0, 12)}`)
  const compare = api(gh, `repos/${repository}/compare/${parent}...master`)
  if (compare?.merge_base_commit?.sha !== parent) refuse(`${parent.slice(0, 12)} is no longer on master`)

  let released
  try {
    released = releasedTags(fetchReleases(repository, gh))
  } catch (error) {
    refuse(`the published Releases could not be listed (${error.message})`)
  }
  if (released.includes(tag)) refuse(`${tag} is already a published Release`)
  const order = releaseOrder({ tag, parent, released, cwd })
  if (order.problem) refuse(order.problem)

  const readTag = () => {
    const ref = api(gh, `repos/${repository}/git/ref/tags/${tag}`, { allow404: true })
    if (!ref) return undefined
    const refProblems = tagRefProblems(ref, tag)
    if (refProblems.length) return { problems: refProblems }
    const tagObject = api(gh, `repos/${repository}/git/tags/${ref.object.sha}`)
    return { problems: tagObjectProblems(tagObject, { tag, commit: release }), tagObject }
  }
  const existing = readTag()
  if (existing) {
    if (existing.problems.length) refuse(`the tag ${tag} already exists and is not the kit's tag on ${release.slice(0, 12)} (${existing.problems.join("; ")}): nothing was written`)
    return { action: "reused", tagObject: existing.tagObject }
  }
  if (mode === "resume") refuse(`resume: the tag ${tag} is gone, so there is nothing to resume`)
  const branch = api(gh, `repos/${repository}/git/ref/heads/${releaseBranch(tag)}`, { allow404: true })
  if (branch?.object?.sha !== release) refuse(`${releaseBranch(tag)} no longer points at the release commit ${release.slice(0, 12)}`)

  const body = { tag, message: tag, object: release, type: "commit", tagger: { name: ACTIONS_BOT.name, email: ACTIONS_BOT.email, date: now() } }
  const made = JSON.parse(gh(["api", "-X", "POST", `repos/${repository}/git/tags`, "--input", "-"], { input: JSON.stringify(body) }))
  gh(["api", "-X", "POST", `repos/${repository}/git/refs`, "--input", "-"], { input: JSON.stringify({ ref: `refs/tags/${tag}`, sha: made.sha }) })
  const confirmed = readTag()
  if (!confirmed || confirmed.problems.length) refuse(`the tag ${tag} was created, and reading it back fails: ${confirmed?.problems.join("; ") ?? "it is missing"}`)
  return { action: "created", tagObject: confirmed.tagObject }
}

/**
 * The problems with a folder of Release files: its SHA256SUMS must have the sha256 `sumsSha256`, the digest the stage job
 * showed the approver in the run summary, and every file must be listed in it once, by its name, and equal. Without the
 * digest the files are refused: a SHA256SUMS that only agrees with itself binds nothing to what was approved.
 */
export function sumsProblems(dir, { sumsSha256 } = {}) {
  if (!/^[0-9a-f]{64}$/.test(sumsSha256 ?? "")) return ["the sha256 of SHA256SUMS that the approver saw was not given"]
  const files = walkFiles(dir).filter((path) => basename(path) !== "SHA256SUMS")
  const sumsPaths = walkFiles(dir).filter((path) => basename(path) === "SHA256SUMS")
  if (sumsPaths.length !== 1) return [`there are ${sumsPaths.length} SHA256SUMS files; one is needed`]
  const sumsBytes = readFileSync(join(dir, sumsPaths[0]))
  if (sha256(sumsBytes) !== sumsSha256) return [`SHA256SUMS has the sha256 ${sha256(sumsBytes)}, not ${sumsSha256}, the one the approver saw: nothing is published`]
  const sums = new Map()
  const problems = []
  for (const line of sumsBytes.toString("utf8").split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}([^/]+)$/.exec(line)
    if (!match || sums.has(match[2])) problems.push(`SHA256SUMS has a line that is not one "<sha256>  <name>"`)
    else sums.set(match[2], match[1])
  }
  const names = files.map((path) => basename(path))
  for (const path of files) {
    const name = basename(path)
    if (!sums.has(name)) problems.push(`${name} is not in SHA256SUMS`)
    else if (sha256(readFileSync(join(dir, path))) !== sums.get(name)) problems.push(`${name} does not match SHA256SUMS`)
  }
  for (const name of sums.keys()) if (!names.includes(name)) problems.push(`${name} is in SHA256SUMS and not staged`)
  if (new Set(names).size !== names.length) problems.push("two staged files have one name")
  return problems
}

/**
 * The problems with the staged Release files against the manifest the release commit carries (`manifest`, parsed, or
 * undefined for a plugin that is not native). The publish job runs it after the approval, where no repository or
 * dependency code has run: every file under native/ is one the manifest pins, with its size and sha256, every gzip
 * decompresses to the executable the manifest pins (size and sha256), every pinned file is there, and outside native/
 * there is only SHA256SUMS and one tarball.
 */
export function nativeAssetProblems({ dir, manifest }) {
  const problems = []
  const files = walkFiles(dir)
  const outside = files.filter((path) => !path.startsWith("native/") && path !== "SHA256SUMS")
  if (outside.length !== 1 || !/^[^/]+\.tgz$/.test(outside[0])) problems.push(`outside native/ the staged files must be SHA256SUMS and one tarball, and they are ${outside.join(", ") || "none"}`)
  const native = files.filter((path) => path.startsWith("native/"))
  if (!manifest) {
    if (native.length) problems.push(`the release commit has no ${MANIFEST_PATH}, and native files are staged: ${native.join(", ")}`)
    return problems
  }
  const expected = new Map()
  for (const [module, platforms] of Object.entries(manifest.modules ?? {})) {
    for (const [platform, entry] of Object.entries(platforms ?? {})) expected.set(entry?.name, { label: `${module} ${platform}`, entry, gzipped: true })
  }
  for (const licence of manifest.licences ?? []) expected.set(licence?.name, { label: `licence ${licence?.name}`, entry: licence, gzipped: false })
  for (const path of native) if (!expected.has(path.slice("native/".length))) problems.push(`${path} is staged, and the manifest does not pin it`)
  for (const [name, { label, entry, gzipped }] of expected) {
    const path = `native/${name}`
    if (!native.includes(path)) {
      problems.push(`${label}: ${path} is not staged`)
      continue
    }
    const bytes = readFileSync(join(dir, path))
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      problems.push(`${label}: ${name} is not the file the manifest pins (${bytes.length} bytes; the manifest pins ${entry.bytes} and its sha256)`)
      continue
    }
    if (!gzipped) continue
    let executable
    try {
      executable = gunzipSync(bytes)
    } catch {
      problems.push(`${label}: ${name} does not decompress`)
      continue
    }
    if (executable.length !== entry.executable?.bytes || sha256(executable) !== entry.executable?.sha256) {
      problems.push(`${label}: ${name} does not hold the executable the manifest pins (${executable.length} bytes; the manifest pins ${entry.executable?.bytes} and its sha256)`)
    }
  }
  return problems
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--") || i + 1 >= argv.length) refuse(`unexpected argument ${arg}`)
    flags[arg.slice(2)] = argv[++i]
  }
  return flags
}

function writeOutput(env, key, value) {
  if (/[\n\r]/.test(String(value))) refuse(`the output ${key} has a line break`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

function main(argv) {
  const [command, ...rest] = argv
  const flags = parseFlags(rest)
  const env = process.env
  const cwd = process.cwd()
  const gh = (args, options) => ghOutput(args, options)
  const output = (key, value) => writeOutput(env, key, value)
  if (command === "plan") {
    const outputs = plan({ sha: flags.sha, nativeRun: flags["native-run"], manifestOut: flags["manifest-out"], env, gh, cwd })
    for (const [key, value] of Object.entries(outputs)) output(key, value)
    console.log(`plan: ${outputs.tag} (${outputs.mode}${outputs.commit ? `, the tagged commit ${outputs.commit}` : ""}) on ${flags.sha}; CI run ${outputs.ci_run}; ${outputs.previous ? `after ${outputs.previous}` : "the first published Release"}; hosts ${outputs.hosts}${outputs.native === "true" ? `; native run ${flags["native-run"]}` : ""}`)
  } else if (command === "commit") {
    commit({ dir: flags.files, parent: flags.parent, tag: flags.tag, native: flags.native === "true", manifestSha256: flags["manifest-sha256"] || undefined, env, gh, cwd, output, log: console.log })
  } else if (command === "tag") {
    const result = tagRelease({ tag: flags.tag, commit: flags.commit, parent: flags.parent, mode: flags.mode, env, gh, cwd })
    console.log(`tag ${flags.tag}: ${result.action} (tag object ${result.tagObject.sha}) on ${flags.commit}`)
  } else if (command === "cleanup") {
    const result = cleanup({ tag: flags.tag, parent: flags.parent, commit: flags.commit || undefined, env, gh })
    console.log(`cleanup: ${result.message}`)
    if (result.action === "left") process.exitCode = 1
  } else if (command === "sums") {
    const problems = sumsProblems(flags.dir, { sumsSha256: flags["sums-sha256"] })
    if (problems.length) refuse(`the staged Release files are not the approved ones: ${problems.join("; ")}`)
    console.log(`sums: SHA256SUMS is ${flags["sums-sha256"]}, the digest in the run summary, and every staged file matches it`)
  } else if (command === "native") {
    if (!SHA1.test(flags.commit ?? "")) refuse("--commit must be the release commit's full sha")
    const text = gitIn(cwd, ["show", `${flags.commit}:${MANIFEST_PATH}`], { allowFailure: true })
    const manifest = text === undefined ? undefined : JSON.parse(text)
    if (manifest) {
      const structure = manifestProblems(manifest, { repository: env.GITHUB_REPOSITORY })
      if (structure.length) refuse(`the release commit's ${MANIFEST_PATH} is not right: ${structure.join("; ")}`)
    }
    const problems = nativeAssetProblems({ dir: flags.dir, manifest })
    if (problems.length) refuse(`the staged Release files are not the ones the release commit pins: ${problems.join("; ")}`)
    console.log(manifest ? `native: every staged native file is the one ${MANIFEST_PATH} pins, executables included` : "native: no native files, as the release commit has no manifest")
  } else refuse(`unknown command ${command ?? "(none)"}: plan, commit, tag, cleanup, sums or native`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`release-github: ${error.message}`)
    process.exit(1)
  }
}
