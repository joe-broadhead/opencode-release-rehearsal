#!/usr/bin/env node
// Checks that a release commit, and its tag once it exists, have the shape the release kit makes. The release workflow
// runs it before the tag exists (verify, stage) and after (publish). It reads git objects and the GitHub API, and never
// changes anything.
//
//   node scripts/check-release-shape.mjs [--tag v<version> | --commit <sha> --tag-name v<version>] [--branch master]
//     [--allow <path>]... [--verify github-api] [--identity github-actions]
//     [--rebuilt <dir>]  a directory whose dist/ is a fresh build of the commit's parent: compared byte for byte
//     [--notes <file>]   writes the release notes: the CHANGELOG's section for the version up to the next ## heading,
//                        then the README's Known limits. The CHANGELOG must be in the release shape (scripts/changelog.mjs).
//
// --tag checks a tagged release; it defaults to v<version> of the checkout's package.json. --commit checks a release
// commit before it is tagged, for the tag --tag-name: every check but the tag's own. Checks, in order: the tag (GitHub
// API) is annotated, named and titled exactly the tag, on the release commit, tagged by github-actions[bot] and
// unsigned; the release commit (GitHub API) is verified by GitHub, authored by github-actions[bot] and committed by
// GitHub's web-flow; the tag name is exactly v<version>, where the version is the x.y.z of the commit's package.json;
// the commit has one parent, which is on the branch; the release moves forward from the last published GitHub Release
// (an older version, whose parent is an ancestor of this one); package.json is exactly the parent's without its
// lifecycle scripts and is private (npm never publishes it; a GitHub install does not read it); the paths it changes from its parent are exactly the allowed set, each a regular
// file (mode 100644, no symlink or executable); dist/ is committed; a native plugin's manifest and run are right.
//
// The signature and the identities prove only that GitHub made the commit through its API for the workflow: anyone with
// write access can make such a commit. What binds the release to master is the content: the parent, the package.json
// rule, the allowed paths and the byte-for-byte rebuild. Never relax those because the commit is signed.
//
// The repository is GITHUB_REPOSITORY, or the origin remote. The published Releases are read with `gh api`; a tag that
// never became a Release, or a draft, does not count. When they cannot be listed, the order check fails: it never passes
// without them. The parent need not be the branch's head: the branch can move while a release waits for its approval.
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import {
  allowedPath,
  api,
  commitIdentityProblems,
  fetchReleases,
  ghOutput,
  LIFECYCLE_SCRIPTS,
  modeProblems,
  nativeRunProblems,
  originRepository,
  RELEASE_MODE,
  releaseOrder,
  releasePackageText,
  releasedTags,
  tagObjectProblems,
  tagRefProblems,
} from "./release-rules.mjs"
import { MANIFEST_PATH, manifestProblems } from "./native-manifest.mjs"
import { changelogProblems, releaseNotes } from "./changelog.mjs"
import { isReleaseTag, tagFor, tagProblem } from "./release-version.mjs"

function parseArgs(argv) {
  const options = { tag: undefined, commit: undefined, tagName: undefined, branch: "master", allow: [], verify: "github-api", identity: "github-actions", rebuilt: undefined, notes: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--tag") options.tag = argv[++i]
    else if (arg === "--commit") options.commit = argv[++i]
    else if (arg === "--tag-name") options.tagName = argv[++i]
    else if (arg === "--branch") options.branch = argv[++i]
    else if (arg === "--allow") options.allow.push(argv[++i])
    else if (arg === "--verify") options.verify = argv[++i]
    else if (arg === "--identity") options.identity = argv[++i]
    else if (arg === "--rebuilt") options.rebuilt = argv[++i]
    else if (arg === "--notes") options.notes = argv[++i]
    else throw new Error(`unknown argument ${arg}`)
  }
  if (options.verify !== "github-api") throw new Error('--verify is "github-api": GitHub verifies the release commit; there is no key to check locally')
  if (options.identity !== "github-actions") throw new Error('--identity is "github-actions": the release workflow makes the commit and the tag')
  if (options.commit !== undefined) {
    if (options.tag !== undefined) throw new Error("--commit and --tag are two modes: pass one")
    if (!/^[0-9a-f]{40}$/.test(options.commit)) throw new Error("--commit must be a full sha")
    if (!options.tagName) throw new Error("--commit needs --tag-name v<version>: the tag it will get")
  } else {
    if (options.tagName !== undefined) throw new Error("--tag-name goes with --commit")
    options.tag ??= tagFor(JSON.parse(readFileSync("package.json", "utf8")).version)
  }
  return options
}

/** Runs git and returns its stdout as a Buffer, or undefined when it fails. */
function gitBuffer(args) {
  const result = spawnSync("git", args, { maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : undefined
}
const git = (args) => gitBuffer(args)?.toString("utf8").trim()

function main() {
  const options = parseArgs(process.argv.slice(2))
  const failures = []
  const ok = (name) => console.log(`ok   ${name}`)
  const fail = (name, why) => {
    failures.push(`${name}: ${why}`)
    console.log(`FAIL ${name}: ${why}`)
  }
  const stop = (message) => {
    console.error(`check-release-shape: ${message}`)
    process.exit(1)
  }

  const repository = process.env.GITHUB_REPOSITORY || originRepository()
  if (!repository) stop("neither GITHUB_REPOSITORY nor a GitHub origin names the repository")
  const gh = (args) => ghOutput(args, { repository })
  const read = (path, allow404) => {
    try {
      return api(gh, `repos/${repository}/${path}`, { allow404 })
    } catch (error) {
      stop(`GitHub could not be read (${path.split("/")[0]}: ${error.message})`)
    }
  }

  // The tag and the commit it points at: from GitHub, the tag the release job made. Before the tag, the commit itself.
  const tag = options.tag ?? options.tagName
  let target = options.commit
  if (options.tag !== undefined) {
    const ref = read(`git/ref/tags/${tag}`, true)
    if (!ref) stop(`no tag ${tag} on GitHub`)
    const refProblems = tagRefProblems(ref, tag)
    if (refProblems.length) {
      fail("the tag is annotated", refProblems.join("; "))
      target = ref.object.sha
    } else {
      ok("the tag is annotated")
      const tagObject = read(`git/tags/${ref.object.sha}`)
      target = tagObject?.object?.sha
      const problems = tagObjectProblems(tagObject, { tag, commit: target })
      if (problems.length) fail("the tag", problems.join("; "))
      else ok(`the tag is the kit's: ${tag}, tagged by github-actions[bot], unsigned, on ${String(target).slice(0, 12)}`)
    }
    const local = git(["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`])
    if (local && local !== target) fail("the tag", `the checkout's ${tag} points at ${local.slice(0, 12)}, and GitHub's at ${String(target).slice(0, 12)}`)
  } else ok(`${tag} is not tagged yet: the tag's own checks run when the release job has tagged the commit`)
  if (!target || spawnSync("git", ["cat-file", "-e", `${target}^{commit}`]).status !== 0) stop(`the release commit ${String(target).slice(0, 12)} is not in this checkout: fetch it`)

  // The release commit: GitHub verifies it, and the workflow made it.
  const identity = commitIdentityProblems(read(`commits/${target}`))
  if (identity.length) fail("the release commit", identity.join("; "))
  else ok("GitHub verifies the release commit, made by github-actions[bot] through GitHub's API, with one parent")

  // package.json is a regular file before it is read: a symlink's blob is its target's path, not the package.
  const pkgMode = (git(["ls-tree", target, "--", "package.json"]) ?? "").split(" ")[0]
  const pkgText = pkgMode === RELEASE_MODE ? gitBuffer(["show", `${target}:package.json`])?.toString("utf8") : undefined
  let pkg
  try {
    pkg = pkgText ? JSON.parse(pkgText) : undefined
  } catch {
    pkg = undefined
  }
  if (!pkg) {
    fail("package.json", pkgMode && pkgMode !== RELEASE_MODE ? modeProblems([{ path: "package.json", mode: pkgMode }])[0] : "the release commit has no package.json that parses")
    process.exit(1)
  }

  // The version: package.json's x.y.z, and the tag is exactly v<version>.
  const versionRefusal = tagProblem(tag, pkg.version)
  if (!versionRefusal) ok(`the tag is ${tag}, and the version is ${pkg.version}`)
  else fail("the version", versionRefusal)

  // One parent, on the branch.
  const parents = (git(["rev-list", "--parents", "-n", "1", target]) ?? "").split(" ").slice(1)
  if (parents.length !== 1) fail("the parent", `the release commit has ${parents.length} parents; it needs exactly one`)
  else {
    const parent = parents[0]
    const onBranch = spawnSync("git", ["merge-base", "--is-ancestor", parent, options.branch]).status === 0
    if (onBranch) ok(`the parent ${parent.slice(0, 12)} is on ${options.branch}`)
    else fail("the parent", `the parent is not on ${options.branch}`)

    // Releases move forward from the last published Release, so a release never ships source older than it. Only
    // published Releases count: a v* tag cannot be deleted, so a stray one must not block every later release.
    if (isReleaseTag(tag)) {
      let released
      try {
        released = releasedTags(fetchReleases(repository, gh))
      } catch (error) {
        fail("the release order", `the published Releases could not be listed (${error.message}), so the order is not checked`)
      }
      if (released) {
        const order = releaseOrder({ tag, parent, released })
        if (order.problem) fail("the release order", order.problem)
        else if (order.previous) ok(`the parent descends from the parent of ${order.previous}, the last published Release`)
        else ok(`${tag} is the first published Release`)
      }
    }

    // package.json is exactly what release-commit.mjs writes from the parent's: nothing added, removed or reordered.
    const parentPkg = gitBuffer(["show", `${parent}:package.json`])?.toString("utf8")
    let expected
    try {
      expected = parentPkg === undefined ? undefined : releasePackageText(JSON.parse(parentPkg))
    } catch {
      expected = undefined
    }
    if (expected === undefined) fail("package.json", "the parent has no package.json that parses")
    else if (pkgText === expected) ok("package.json is the parent's without its lifecycle scripts")
    else fail("package.json", "it is not exactly the parent's without its lifecycle scripts: release-commit.mjs writes nothing else")

    // The change from the parent is exactly the allowed set. The manifest is in the set only when the commit carries one.
    const native = spawnSync("git", ["cat-file", "-e", `${target}:${MANIFEST_PATH}`]).status === 0
    // `--raw` lines read ":<old mode> <new mode> <old blob> <new blob> <status>\t<path>"; the new mode is the tag's.
    const raw = (git(["diff", "--raw", "--no-renames", "-z", parent, target]) ?? "").split("\0").filter(Boolean)
    const changes = []
    for (let i = 0; i + 1 < raw.length; i += 2) changes.push({ mode: raw[i].split(" ")[1], path: raw[i + 1] })
    const changed = changes.map((change) => change.path)
    const outside = changed.filter((path) => !allowedPath(path, { native }) && !options.allow.includes(path))
    if (changed.length && !outside.length) ok(`the change from the parent is the allowed set (${changed.length} paths${native ? ", with the native manifest" : ""})`)
    else fail("the change from the parent", changed.length ? `paths outside the allowed set: ${outside.join(", ")}` : "the release commit changes nothing")
    const modes = modeProblems(changes)
    if (!modes.length) ok("every path it changes is a regular file")
    else fail("the file modes", modes.join("; "))

    // A native plugin's manifest: where its binaries come from, and the run that built them. The run is checked on GitHub.
    if (native) {
      const manifest = JSON.parse(gitBuffer(["show", `${target}:${MANIFEST_PATH}`]).toString("utf8"))
      const problems = manifestProblems(manifest, { plugin: pkg.name.replace(/^@[^/]+\//, ""), tag, commit: parent, repository })
      if (problems.length) fail("the native manifest", problems.join("; "))
      else ok(`the native manifest names ${tag}, the parent, and native run ${manifest.built.run}`)
      const runProblems = nativeRunProblems(read(`actions/runs/${manifest.built.run}`), { sha: parent })
      if (runProblems.length) fail("the native run", runProblems.join("; "))
      else ok("the native run succeeded on master, for the parent, started by hand")
    }

    // The build is committed: dist/ holds the bundles the host loads.
    const dist = (git(["ls-tree", "-r", "--name-only", target, "--", "dist"]) ?? "").split("\n").filter(Boolean)
    if (dist.includes("dist/index.js") && dist.includes("dist/tui.js")) ok(`dist/ is committed (${dist.length} files)`)
    else fail("dist/", "dist/index.js and dist/tui.js must be committed")

    // A fresh build of the parent reproduces dist/ byte for byte.
    if (options.rebuilt) {
      const built = listFiles(join(options.rebuilt, "dist"))
      const committed = dist.map((path) => relative("dist", path))
      const mismatched = committed.filter((rel) => {
        const blob = gitBuffer(["show", `${target}:dist/${rel}`])
        try {
          return !blob || !blob.equals(readFileSync(join(options.rebuilt, "dist", rel)))
        } catch {
          return true
        }
      })
      if (built.length === committed.length && !mismatched.length) ok("a fresh build of the parent reproduces dist/ byte for byte")
      else fail("the rebuild", `${mismatched.length} files differ, and the file counts are ${committed.length} committed and ${built.length} built`)
    }
  }

  // The package: no lifecycle scripts, and private, so npm never publishes it.
  const lifecycle = Object.keys(pkg.scripts ?? {}).filter((name) => LIFECYCLE_SCRIPTS.includes(name))
  if (!lifecycle.length) ok("package.json has no lifecycle scripts")
  else fail("package.json", `lifecycle scripts remain: ${lifecycle.join(", ")}`)
  if (pkg.private === true) ok('the package is private ("private": true)')
  else fail("the package", 'package.json has no "private": true')

  if (options.notes) writeNotes(target, pkg.version, options.notes, (message) => fail("the release notes", message), ok)

  if (failures.length) {
    console.error(`check-release-shape: ${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`check-release-shape: ${options.tag !== undefined ? tag : `${target.slice(0, 12)}, for ${tag},`} has the release shape`)
}

function listFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(dir, path))
    }
  }
  walk(dir)
  return out
}

/** The CHANGELOG section for the version, then the README's Known limits (D3), written to the file. */
function writeNotes(target, version, file, fail, ok) {
  const changelog = gitBuffer(["show", `${target}:CHANGELOG.md`])?.toString("utf8") ?? ""
  const shape = changelogProblems(changelog, version)
  if (shape.length) return fail(`CHANGELOG.md is not in the release shape for ${version}: ${shape.join("; ")}`)
  let section
  try {
    section = releaseNotes(changelog, version)
  } catch (error) {
    return fail(error.message)
  }
  const readme = gitBuffer(["show", `${target}:README.md`])?.toString("utf8") ?? ""
  const limits = sectionOf(readme, "## Known limits")
  writeFileSync(file, [section.trim(), ...(limits ? ["", "### Known limits", "", limits.trim().replace(/^## Known limits\s*/, "")] : [])].join("\n") + "\n")
  ok(`release notes written from the CHANGELOG section${limits ? " and the Known limits" : ""}`)
  // D3: known limits are in the README and in the release notes. Without the section the notes lack them: a warning here,
  // so the owner decides whether the release waits for it.
  if (!limits) console.log("WARN the README has no Known limits section, so the release notes omit it (D3)")
}

function sectionOf(text, heading) {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.startsWith(heading))
  if (start < 0) return undefined
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
  return lines.slice(start, end < 0 ? undefined : end).join("\n")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
