#!/usr/bin/env node
// The release workflow's build step (the `build` job of .github/workflows/release.yml). In a clean checkout of the master
// commit being released, it builds dist/ and writes the release commit's files to a folder: dist/, package.json without
// its lifecycle scripts, and, for a native plugin, the manifest the `plan` job vetted. It commits, tags and pushes
// nothing, and needs no token: the `commit` job, which runs no npm, turns the folder into the release commit
// (scripts/release-github.mjs commit).
//
//   node scripts/release-commit.mjs --sha <full sha of the checkout> --out <empty folder> [--manifest <vetted native.json>]
//
// The folder holds the files at their repository paths, and paths.txt: one `<sha256>  <path>` line per file, sorted, so
// the commit job can tell that it received exactly what was built. Refuses: a dirty tree, a head other than --sha, a
// version that is not x.y.z, a private package, package.json not in its canonical form, no build script, a native plugin
// (one with .github/workflows/native.yml) without --manifest or a plugin that is not native with one, a manifest that
// does not name this tag and commit, a build that changes tracked files or builds no dist/, and a built path outside the
// allowed set or that is not a regular file.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MANIFEST_PATH, manifestProblems } from "./native-manifest.mjs"
import { allowedPath, releasePackageText, serialise } from "./release-rules.mjs"
import { tagFor, versionProblem } from "./release-version.mjs"

/** The workflow whose presence makes a plugin native. */
export const NATIVE_WORKFLOW = ".github/workflows/native.yml"

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

/** paths.txt for a list of { path, bytes }: one `<sha256>  <path>` line per file, sorted by path. */
export function pathsText(files) {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${sha256(file.bytes)}  ${file.path}\n`)
    .join("")
}

function die(message) {
  console.error(`release-commit: ${message}`)
  process.exit(1)
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { encoding: "utf8" })
  if (result.status !== 0 && !allowFailure) die(`git ${args[0]} failed: ${(result.stderr || "").trim().split("\n")[0]}`)
  return result.status === 0 ? result.stdout.trim() : undefined
}

function npm(args) {
  const result = spawnSync("npm", args, { stdio: "inherit" })
  if (result.status !== 0) die(`npm ${args.join(" ")} failed (exit ${result.status})`)
}

function parseArgs(argv) {
  const options = { sha: undefined, out: undefined, manifest: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--sha") options.sha = argv[++i]
    else if (arg === "--out") options.out = argv[++i]
    else if (arg === "--manifest") options.manifest = resolve(argv[++i])
    else die(`unknown argument ${arg}`)
  }
  if (!options.sha || !/^[0-9a-f]{40}$/.test(options.sha)) die("--sha must be the full 40-character sha of the checkout")
  if (!options.out) die("--out <folder> is required")
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const out = resolve(options.out)
  const root = git(["rev-parse", "--show-toplevel"])
  process.chdir(root)

  if (git(["status", "--porcelain", "--untracked-files=all"])) die("the tree is not clean")
  if (git(["rev-parse", "HEAD"]) !== options.sha) die(`the checkout is not ${options.sha.slice(0, 12)}`)

  const pkgPath = join(root, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  const versionRefusal = versionProblem(pkg.version)
  if (versionRefusal) die(versionRefusal)
  const tag = tagFor(pkg.version)
  if (pkg.private === true) die('package.json has "private": true')
  if (serialise(pkg) !== readFileSync(pkgPath, "utf8")) die("package.json is not in the repository's canonical JSON form")
  if (!pkg.scripts?.build) die('package.json has no "build" script: the release builds with npm run build')

  const native = existsSync(join(root, NATIVE_WORKFLOW))
  if (native && !options.manifest) die(`this plugin is native (${NATIVE_WORKFLOW}), and no vetted manifest was given`)
  if (!native && options.manifest) die(`a manifest was given, and this plugin is not native (no ${NATIVE_WORKFLOW})`)
  let manifestText
  if (native) {
    manifestText = readFileSync(options.manifest, "utf8")
    const problems = manifestProblems(JSON.parse(manifestText), { plugin: pkg.name.replace(/^@[^/]+\//, ""), tag, commit: options.sha })
    if (problems.length) die(`the native manifest is not right: ${problems.join("; ")}`)
  }

  if (existsSync(out) && readdirSync(out).length) die(`${options.out} is not empty`)

  // The build the release ships: the repository's `build` script, after a clean `npm ci` with lifecycle scripts off. The
  // release commit then drops `build` with the other lifecycle scripts, so the install builds nothing.
  npm(["ci", "--ignore-scripts"])
  npm(["run", "build"])
  if (git(["status", "--porcelain", "--untracked-files=all"])) die("the build changed tracked files; the release commit would not be the build")

  // dist/ is git-ignored on master, so the build's files are listed as ignored, untracked files.
  const built = (git(["ls-files", "--others", "--ignored", "--exclude-standard", "--", "dist"], { allowFailure: true }) ?? "").split("\n").filter(Boolean)
  if (!built.length) die("the build produced no dist/ files")
  const outside = built.filter((path) => !allowedPath(path, { native }))
  if (outside.length) die(`built paths outside the allowed set: ${outside.join(", ")}`)
  const irregular = built.filter((path) => !lstatSync(join(root, path)).isFile())
  if (irregular.length) die(`built paths that are not regular files: ${irregular.join(", ")}`)

  const files = [
    ...built.map((path) => ({ path, bytes: readFileSync(join(root, path)) })),
    { path: "package.json", bytes: Buffer.from(releasePackageText(pkg)) },
    ...(native ? [{ path: MANIFEST_PATH, bytes: Buffer.from(manifestText) }] : []),
  ]
  for (const file of files) {
    mkdirSync(dirname(join(out, file.path)), { recursive: true })
    writeFileSync(join(out, file.path), file.bytes)
  }
  writeFileSync(join(out, "paths.txt"), pathsText(files))
  console.log(`release files for ${tag} on ${options.sha.slice(0, 12)}: ${built.length} dist/ files, package.json${native ? `, ${MANIFEST_PATH}` : ""}`)
  console.log(`written to ${options.out}, with paths.txt; nothing is committed, tagged or pushed`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
