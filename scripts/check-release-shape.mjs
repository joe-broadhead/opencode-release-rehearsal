#!/usr/bin/env node
// Checks that a release tag has the shape D19 and the release brief require. The release workflow runs it; it runs
// locally too, after release-commit.mjs. It reads only git objects and never changes anything.
//
//   node scripts/check-release-shape.mjs [--tag v0.0.0] [--branch master] [--allow <path>]...
//     [--verify git --allowed-signers <file> | --verify github-api]
//     [--rebuilt <dir>]  a directory whose dist/ is a fresh build of the tag's parent: compared byte for byte
//     [--notes <file>]   writes the release notes: the CHANGELOG's 0.0.0 section up to the next ## heading, then the
//                        README's Known limits. The CHANGELOG must be in the release shape (scripts/changelog.mjs).
//
// Checks, in order: the tag is annotated and signed by the owner; its name is v<version> and the version is 0.0.0;
// its commit has one parent, which is on the branch; the commit and tag identities are the GitHub noreply domain; the
// paths it changes from its parent are exactly the allowed set; package.json has no lifecycle scripts and is not
// private; dist/ is committed. Emails are checked by domain and never printed.
import { execFileSync, spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { allowedPath, LIFECYCLE_SCRIPTS, NOREPLY_DOMAIN, RELEASE_VERSION, TAG } from "./release-commit.mjs"
import { MANIFEST_PATH, manifestProblems } from "./native-manifest.mjs"
import { changelogProblems, releaseNotes } from "./changelog.mjs"

function parseArgs(argv) {
  const options = { tag: TAG, branch: "master", allow: [], verify: "git", allowedSigners: undefined, rebuilt: undefined, notes: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--tag") options.tag = argv[++i]
    else if (arg === "--branch") options.branch = argv[++i]
    else if (arg === "--allow") options.allow.push(argv[++i])
    else if (arg === "--verify") options.verify = argv[++i]
    else if (arg === "--allowed-signers") options.allowedSigners = argv[++i]
    else if (arg === "--rebuilt") options.rebuilt = argv[++i]
    else if (arg === "--notes") options.notes = argv[++i]
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!["git", "github-api"].includes(options.verify)) throw new Error('--verify is "git" or "github-api"')
  if (options.verify === "git" && !options.allowedSigners) throw new Error("--verify git needs --allowed-signers <file>")
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

  const tag = options.tag
  const tagRef = `refs/tags/${tag}`
  const tagObject = git(["rev-parse", "-q", "--verify", tagRef])
  if (!tagObject) {
    console.error(`check-release-shape: no tag ${tag}`)
    process.exit(1)
  }

  // The tag is annotated: its object is a tag object, not a commit.
  if (git(["cat-file", "-t", tagRef]) === "tag") ok("the tag is annotated")
  else fail("the tag is annotated", "the tag is a lightweight tag, not an annotated one")

  const target = git(["rev-parse", `${tag}^{commit}`])
  const pkgText = gitBuffer(["show", `${target}:package.json`])?.toString("utf8")
  const pkg = pkgText ? JSON.parse(pkgText) : undefined
  if (!pkg) {
    fail("package.json", "the tagged commit has no package.json")
    process.exit(1)
  }

  // The version: the tag is v<version>, and every plugin releases as 0.0.0.
  if (pkg.version === RELEASE_VERSION && tag === `v${pkg.version}`) ok(`the tag is v${pkg.version}, and the version is ${pkg.version}`)
  else fail("the version", `the tag is ${tag} and package.json says ${pkg.version}; every plugin releases as ${TAG}`)

  // The signatures: the tag and its commit, by the owner.
  if (options.verify === "git") {
    const signers = ["-c", `gpg.ssh.allowedSignersFile=${options.allowedSigners}`]
    const tagSigned = spawnSync("git", [...signers, "verify-tag", tag], { encoding: "utf8" }).status === 0
    const commitSigned = spawnSync("git", [...signers, "verify-commit", target], { encoding: "utf8" }).status === 0
    if (tagSigned) ok("the tag is signed by an allowed signer")
    else fail("the tag is signed", "git verify-tag failed against the allowed signers")
    if (commitSigned) ok("the release commit is signed by an allowed signer")
    else fail("the release commit is signed", "git verify-commit failed against the allowed signers")
  } else {
    const repo = process.env.GITHUB_REPOSITORY
    if (!repo) fail("the signatures", "GITHUB_REPOSITORY is not set")
    else {
      const api = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }))
      const tagVerification = api(`repos/${repo}/git/tags/${tagObject}`).verification
      const commitVerification = api(`repos/${repo}/commits/${target}`).commit.verification
      if (tagVerification?.verified && tagVerification.reason === "valid") ok("the tag is signed, and GitHub verifies the signature")
      else fail("the tag is signed", `GitHub says ${tagVerification?.reason ?? "no verification"}`)
      if (commitVerification?.verified && commitVerification.reason === "valid") ok("the release commit is signed, and GitHub verifies the signature")
      else fail("the release commit is signed", `GitHub says ${commitVerification?.reason ?? "no verification"}`)
    }
  }

  // The identities: the commit's author and committer, and the tag's tagger, are the noreply domain. Domain only.
  const emails = [...(git(["log", "-1", "--format=%ae%n%ce", target]) ?? "").split("\n"), ...((gitBuffer(["cat-file", "tag", tagRef])?.toString("utf8") ?? "").split("\n").filter((line) => line.startsWith("tagger ")).map((line) => line.slice(line.indexOf("<") + 1, line.indexOf(">"))))]
  const foreign = emails.filter((email) => !email.endsWith(`@${NOREPLY_DOMAIN}`))
  if (emails.length >= 3 && !foreign.length) ok("the commit and the tag use the GitHub noreply identity")
  else fail("the identities", `${foreign.length} of ${emails.length} identities are not the noreply domain`)

  // One parent, on the branch.
  const parents = (git(["rev-list", "--parents", "-n", "1", target]) ?? "").split(" ").slice(1)
  if (parents.length !== 1) fail("the parent", `the release commit has ${parents.length} parents; it needs exactly one`)
  else {
    const parent = parents[0]
    const onBranch = spawnSync("git", ["merge-base", "--is-ancestor", parent, options.branch]).status === 0
    if (onBranch) ok(`the parent ${parent.slice(0, 12)} is on ${options.branch}`)
    else fail("the parent", `the parent is not on ${options.branch}`)

    // The change from the parent is exactly the allowed set. The manifest is in the set only when the commit carries one.
    const native = spawnSync("git", ["cat-file", "-e", `${target}:${MANIFEST_PATH}`]).status === 0
    const changed = (git(["diff", "--name-only", parent, target]) ?? "").split("\n").filter(Boolean)
    const outside = changed.filter((path) => !allowedPath(path, { native }) && !options.allow.includes(path))
    if (changed.length && !outside.length) ok(`the change from the parent is the allowed set (${changed.length} paths${native ? ", with the native manifest" : ""})`)
    else fail("the change from the parent", changed.length ? `paths outside the allowed set: ${outside.join(", ")}` : "the release commit changes nothing")

    // A native plugin's manifest: where its binaries come from, and the run that built them. The run is checked on GitHub.
    if (native) {
      const manifest = JSON.parse(gitBuffer(["show", `${target}:${MANIFEST_PATH}`]).toString("utf8"))
      const repository = process.env.GITHUB_REPOSITORY || undefined
      const problems = manifestProblems(manifest, { plugin: pkg.name.replace(/^@[^/]+\//, ""), tag, commit: parent, repository })
      if (problems.length) fail("the native manifest", problems.join("; "))
      else ok(`the native manifest names ${tag}, the parent, and native run ${manifest.built.run}`)
      if (options.verify === "github-api" && repository) {
        const run = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/actions/runs/${manifest.built.run}`], { encoding: "utf8" }))
        const runProblems = []
        if (run.head_sha !== parent) runProblems.push("the run built another commit")
        if (run.conclusion !== "success") runProblems.push(`the run concluded ${run.conclusion}`)
        if (String(run.path ?? "").split("/").pop() !== "native.yml") runProblems.push("the run is not the native workflow")
        if (run.head_branch !== "master") runProblems.push("the run is not on master")
        if (runProblems.length) fail("the native run", runProblems.join("; "))
        else ok("the native run succeeded on master, for the parent")
      }
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

  // The package: no lifecycle scripts, and not private.
  const lifecycle = Object.keys(pkg.scripts ?? {}).filter((name) => LIFECYCLE_SCRIPTS.includes(name))
  if (!lifecycle.length) ok("package.json has no lifecycle scripts")
  else fail("package.json", `lifecycle scripts remain: ${lifecycle.join(", ")}`)
  if (pkg.private !== true) ok("the package is not private")
  else fail("the package", 'package.json has "private": true')

  if (options.notes) writeNotes(target, options.notes, (message) => fail("the release notes", message), ok)

  if (failures.length) {
    console.error(`check-release-shape: ${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log(`check-release-shape: ${tag} has the release shape`)
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
function writeNotes(target, file, fail, ok) {
  const changelog = gitBuffer(["show", `${target}:CHANGELOG.md`])?.toString("utf8") ?? ""
  const shape = changelogProblems(changelog)
  if (shape.length) return fail(`CHANGELOG.md is not in the release shape: ${shape.join("; ")}`)
  let section
  try {
    section = releaseNotes(changelog)
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
