#!/usr/bin/env node
// Builds the GitHub release commit and its signed tag, locally. Run it in a clean checkout of `master` at the head CI
// passed. The release commit differs from its parent only by the built dist/ (force-added, because master ignores it),
// a package.json without lifecycle scripts, and, for a native plugin, manifest/native.json copied from a native run.
// The tag is annotated and signed, and points at that commit.
//
//   node scripts/release-commit.mjs --ci-sha <full sha CI passed> [--dry-run] [--native-run <run id>]
//
// It never pushes. Refuses: a dirty tree, a branch other than master, a head other than --ci-sha, a git identity that is
// not the GitHub noreply address, a tag that already exists, a version other than 0.0.0, a private package, a native run
// whose head is not the parent, whose conclusion is not success, whose workflow is not native.yml, or whose manifest
// fails the manifest rules, and any staged path outside the allowed set. The identity is checked by domain only, and no
// address is printed.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { MANIFEST_PATH, manifestProblems } from "./native-manifest.mjs"

export const RELEASE_VERSION = "0.0.0"
export const TAG = `v${RELEASE_VERSION}`
export const NOREPLY_DOMAIN = "users.noreply.github.com"
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

/** The paths the release commit may add or change. The manifest is allowed only for a native plugin. */
export function allowedPath(path, { native = false } = {}) {
  return path === "package.json" || path.startsWith("dist/") || (native && path === MANIFEST_PATH)
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

function die(message) {
  console.error(`release-commit: ${message}`)
  process.exit(1)
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { encoding: "utf8" })
  if (result.status !== 0 && !allowFailure) die(`git ${args[0]} failed: ${(result.stderr || "").trim().split("\n")[0]}`)
  return result.status === 0 ? result.stdout.trim() : undefined
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.status !== 0) die(`${command} ${args.join(" ")} failed (exit ${result.status})`)
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.status !== 0) die(`${command} ${args[0]} failed: ${(result.stderr || "").trim().split("\n")[0]}`)
  return result.stdout
}

function parseArgs(argv) {
  const options = { ciSha: undefined, dryRun: false, nativeRun: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--ci-sha") options.ciSha = argv[++i]
    else if (arg === "--native-run") options.nativeRun = argv[++i]
    else die(`unknown argument ${arg}`)
  }
  if (!options.ciSha) die("--ci-sha is required: the full sha of the master head whose CI passed")
  if (!/^[0-9a-f]{40}$/.test(options.ciSha)) die("--ci-sha must be a full 40-character sha")
  if (options.nativeRun !== undefined && !/^\d+$/.test(options.nativeRun)) die("--native-run must be a run id")
  return options
}

/** owner/name of this repository, from its origin remote. */
function repositoryOf() {
  const url = git(["remote", "get-url", "origin"], { allowFailure: true }) ?? ""
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)
  if (!match) die("origin is not a GitHub remote, so the native run cannot be checked")
  return match[1]
}

/** Reads the candidate manifest of a native run, after the run's own facts are checked (NATIVE-DESIGN §4, step 3). */
function candidateManifest(id, head, repository) {
  const run = JSON.parse(capture("gh", ["api", `repos/${repository}/actions/runs/${id}`]))
  if (run.head_sha !== head) die(`native run ${id} built ${String(run.head_sha).slice(0, 12)}, not the parent ${head.slice(0, 12)}`)
  if (run.conclusion !== "success") die(`native run ${id} did not succeed (conclusion: ${run.conclusion})`)
  if (basename(String(run.path ?? "")) !== "native.yml") die(`run ${id} is not the native workflow`)
  if (run.head_branch !== "master") die(`native run ${id} was not on master`)
  const dir = mkdtempSync(join(tmpdir(), "native-manifest-"))
  capture("gh", ["run", "download", id, "--repo", repository, "--name", "native-manifest", "--dir", dir])
  const file = join(dir, "native.json")
  let manifest
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    die(`native run ${id} has no native-manifest artifact with native.json`)
  }
  return { manifest, text: `${JSON.stringify(manifest, null, 2)}\n` }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = git(["rev-parse", "--show-toplevel"])
  process.chdir(root)

  if (git(["status", "--porcelain", "--untracked-files=all"])) die("the tree is not clean: commit or stash every change first")
  const branch = git(["symbolic-ref", "--short", "HEAD"], { allowFailure: true })
  if (branch !== "master") die(`the checkout is on "${branch ?? "a detached head"}", not master`)
  const head = git(["rev-parse", "HEAD"])
  if (head !== options.ciSha) die("HEAD is not the head CI passed: check out that commit on master, or pass its sha")

  const email = git(["config", "user.email"], { allowFailure: true }) ?? ""
  if (!email.endsWith(`@${NOREPLY_DOMAIN}`)) die(`git user.email is not a GitHub noreply address (domain ${NOREPLY_DOMAIN}); set it before release`)

  if (git(["rev-parse", "-q", "--verify", `refs/tags/${TAG}`], { allowFailure: true })) {
    die(`tag ${TAG} already exists: delete the old tag first (D19a), then run this again`)
  }

  const pkgPath = join(root, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  if (pkg.version !== RELEASE_VERSION) die(`package.json version is ${pkg.version}; every plugin releases as ${TAG}`)
  if (pkg.private === true) die('package.json has "private": true, so the release would refuse it')
  if (serialise(pkg) !== readFileSync(pkgPath, "utf8")) die("package.json is not in the repository's canonical JSON form; reformat it first")

  // A native run's candidate manifest is read and checked before anything is built or written.
  const native = options.nativeRun !== undefined
  let manifestText
  if (native) {
    const repository = repositoryOf()
    const candidate = candidateManifest(options.nativeRun, head, repository)
    const problems = manifestProblems(candidate.manifest, { plugin: pkg.name.replace(/^@[^/]+\//, ""), tag: TAG, commit: head, repository })
    if (problems.length) die(`the native manifest is not right: ${problems.join("; ")}`)
    manifestText = candidate.text
  }

  // The build the release ships: the repository's `build` script, after a clean `npm ci` with lifecycle scripts off. The
  // release commit then drops `build` with the other lifecycle scripts (LIFECYCLE_SCRIPTS), so the install builds nothing.
  if (!pkg.scripts?.build) die('package.json has no "build" script: the release builds with npm run build')
  run("npm", ["ci", "--ignore-scripts"])
  run("npm", ["run", "build"])
  if (git(["status", "--porcelain", "--untracked-files=all"])) die("the build changed tracked files; the release commit would not be the build")

  // dist/ is git-ignored on master, so the build's files are listed as ignored, untracked files.
  const built = (git(["ls-files", "--others", "--ignored", "--exclude-standard", "--", "dist"], { allowFailure: true }) ?? "").split("\n").filter(Boolean)
  if (!built.length) die("the build produced no dist/ files")

  const { next, removed } = withoutLifecycle(pkg)
  const nextText = serialise(next)

  if (options.dryRun) {
    console.log(`dry run: the release commit on ${head.slice(0, 12)} for ${TAG}, nothing is written or committed`)
    console.log(`  add (force): dist/ (${built.length} files)`)
    for (const path of built.slice(0, 20)) console.log(`    ${path}`)
    if (built.length > 20) console.log(`    … ${built.length - 20} more`)
    console.log(`  change package.json: remove scripts ${removed.length ? removed.join(", ") : "(none)"}`)
    const before = serialise(pkg).split("\n")
    const after = nextText.split("\n")
    for (const line of before) if (!after.includes(line)) console.log(`    - ${line}`)
    for (const line of after) if (!before.includes(line)) console.log(`    + ${line}`)
    if (native) console.log(`  add: ${MANIFEST_PATH} (the candidate of native run ${options.nativeRun})`)
    console.log(`  tag: ${TAG} (annotated, signed), on the new commit. Not pushed.`)
    return
  }

  writeFileSync(pkgPath, nextText)
  if (native) {
    mkdirSync(join(root, "manifest"), { recursive: true })
    writeFileSync(join(root, MANIFEST_PATH), manifestText)
  }
  run("git", ["add", "-f", "--", "dist", "package.json", ...(native ? [MANIFEST_PATH] : [])])

  const staged = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean)
  const outside = staged.filter((path) => !allowedPath(path, { native }))
  if (outside.length) {
    git(["reset", "-q"])
    die(`staged paths outside the allowed set: ${outside.join(", ")}`)
  }
  if (!staged.includes("package.json") || !staged.some((path) => path.startsWith("dist/"))) die("the release commit must add dist/ and change package.json")

  git(["commit", "-S", "-q", "-m", `chore(release): ${TAG} with the built dist/ and no lifecycle scripts`])
  const commit = git(["rev-parse", "HEAD"])
  git(["tag", "-s", "-a", TAG, "-m", TAG, commit])
  console.log(`release commit ${commit} on parent ${head}`)
  console.log(`tag ${TAG} is annotated and signed on it${native ? `; manifest from native run ${options.nativeRun}` : ""}`)
  console.log(`staged: ${staged.length} paths; nothing is pushed. Push the tag only, after review: git push origin ${TAG}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
