// Tests for the release kit: the CHANGELOG shape, the version and its tag, the release commit's and tag's identities, the
// calls the kit never makes, the shape check, the workflow's plan, build, commit, tag, cleanup and sums steps against a
// GitHub in memory, the workflow file's shape, the pack stage's tarball check, and the Release upload that never deletes
// or replaces an asset. They run with Node's own runner and need only git; `gh` and `npm` are stand-ins:
//
//   node --test scripts/release-kit.test.mjs
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { changelogProblems, releaseNotes, shapeChangelog } from "./changelog.mjs"
import { publish } from "./publish-release.mjs"
import { pathsText } from "./release-commit.mjs"
import { cleanup, commit, MAX_FILE, MAX_PAYLOAD, plan, sumsProblems, tagRelease } from "./release-github.mjs"
import {
  ACTIONS_BOT,
  allowedPath,
  commitIdentityProblems,
  fetchReleases,
  forbiddenCall,
  ghOutput,
  modeProblems,
  releasedTags,
  releasePackageText,
  serialise,
  tagObjectProblems,
  tagRefProblems,
  WEB_FLOW,
} from "./release-rules.mjs"
import { namesTarball, readsTarball } from "./release-pack.mjs"
import { RELEASE_VERSION, tagFor, tagProblem, versionProblem } from "./release-version.mjs"

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), "release-kit-test-"))
after(() => rmSync(scratch, { recursive: true, force: true }))
let made = 0
const folder = () => {
  const dir = join(scratch, String(made++))
  mkdirSync(dir, { recursive: true })
  return dir
}

const PREAMBLE = "# Changelog\n\nAll notable changes to this project are documented here.\n"
const EARLIER = "## Earlier releases on npm\n\nThese versions were published to npm.\n\n### npm 0.0.10 - 2026-11-08\n\n#### Added\n\n- An npm feature.\n"
const V000 = "## [0.0.0] - 2026-11-10\n\n### Changed\n\n- Installed from GitHub.\n"
const V001 = "## [0.0.1] - 2026-11-12\n\n### Fixed\n\n- A config fix.\n"
const UNRELEASED = "## [Unreleased]\n\n### Fixed\n\n- A config fix.\n"
const doc = (...sections) => [PREAMBLE, ...sections].join("\n")

/** One GitHub release, then the npm history. */
const ONE = doc(V000, EARLIER)
/** Two GitHub releases, newest first, then the npm history. */
const TWO = doc(V001, V000, EARLIER)

describe("the CHANGELOG with one GitHub release", () => {
  test("is in the release shape for that version, and its notes are its section", () => {
    assert.deepEqual(changelogProblems(ONE, "0.0.0"), [])
    assert.equal(releaseNotes(ONE, "0.0.0"), V000.trim())
  })

  test("is refused for a version it has no heading for", () => {
    assert.deepEqual(changelogProblems(ONE, "0.0.1"), ["expected one ## [0.0.1] heading, found 0"])
    assert.throws(() => releaseNotes(ONE, "0.0.1"), /no "## \[0\.0\.1\]" heading/)
  })
})

describe("the CHANGELOG with two GitHub releases", () => {
  test("is in the release shape for the newest, and the notes stop at the next release", () => {
    assert.deepEqual(changelogProblems(TWO, "0.0.1"), [])
    assert.equal(releaseNotes(TWO, "0.0.1"), V001.trim())
    assert.equal(releaseNotes(TWO, "0.0.0"), V000.trim())
  })

  test("is refused for the older release, which is not the newest heading", () => {
    assert.deepEqual(changelogProblems(TWO, "0.0.0"), ["## [0.0.0] is not the newest release heading"])
  })

  test("is refused with the releases out of order, repeated or undated", () => {
    assert.match(changelogProblems(doc(V000, V001, EARLIER), "0.0.1").join("; "), /"## \[0\.0\.0\] - 2026-11-10" is above "## \[0\.0\.1\] - 2026-11-12"/)
    assert.match(changelogProblems(doc(V001, V001, V000), "0.0.1").join("; "), /expected one ## \[0\.0\.1\] heading, found 2/)
    assert.match(changelogProblems(doc("## [0.0.1]\n\n- A fix.\n", V000), "0.0.1").join("; "), /"## \[0\.0\.1\]" is not dated/)
    assert.match(changelogProblems(doc("## [0.0.1] - soon\n\n- A fix.\n", V000), "0.0.1").join("; "), /is not dated/)
  })

  test("is refused with the npm history above a release, or a heading the shape does not know", () => {
    assert.match(changelogProblems(doc(V001, EARLIER, V000), "0.0.1").join("; "), /"## Earlier releases on npm" must be the last section/)
    assert.match(changelogProblems(doc(V001, "## Notes\n\n- Something.\n", V000), "0.0.1").join("; "), /"## Notes" is not a heading the release shape knows/)
  })

  test("is refused when the release has no notes", () => {
    assert.match(changelogProblems(doc("## [0.0.1] - 2026-11-12\n", V000), "0.0.1").join("; "), /the ## \[0\.0\.1\] section has no notes/)
  })
})

describe("a leftover ## [Unreleased]", () => {
  test("is refused, and names the step that releases it", () => {
    const problems = changelogProblems(doc(UNRELEASED, V000, EARLIER), "0.0.1")
    assert.match(problems.join("; "), /an ## \[Unreleased\] section is still there: run node scripts\/changelog\.mjs release/)
    assert.match(problems.join("; "), /expected one ## \[0\.0\.1\] heading, found 0/)
    assert.match(changelogProblems(doc(UNRELEASED, V001, V000), "0.0.1").join("; "), /an ## \[Unreleased\] section is still there/)
  })
})

describe("shapeChangelog", () => {
  const release = (text, version = "0.0.1") => shapeChangelog(text, { version, date: "2026-11-12" })

  test("turns ## [Unreleased] into the dated release, above the earlier ones, and changes nothing else", () => {
    assert.equal(release(doc(UNRELEASED, V000, EARLIER)), TWO)
  })

  test("is idempotent: a released CHANGELOG comes back unchanged", () => {
    assert.equal(release(TWO), TWO)
    assert.equal(release(release(doc(UNRELEASED, V000, EARLIER))), TWO)
    assert.equal(release(ONE, "0.0.0"), ONE)
  })

  test("moves an ## [Unreleased] found below a release to the top", () => {
    assert.equal(release(doc(V000, UNRELEASED, EARLIER)), TWO)
  })

  test("ignores a ## line inside fenced code", () => {
    const fenced = "## [Unreleased]\n\n- A fix:\n\n```md\n## [9.9.9] - not a heading\n```\n"
    const shaped = release(doc(fenced, V000))
    assert.equal(shaped, doc(fenced.replace("## [Unreleased]", "## [0.0.1] - 2026-11-12"), V000))
    assert.deepEqual(changelogProblems(shaped, "0.0.1"), [])
    assert.match(releaseNotes(shaped, "0.0.1"), /## \[9\.9\.9\] - not a heading\n```$/)
  })

  test("refuses what it cannot shape, so nothing is written", () => {
    assert.throws(() => release(ONE), /no ## \[Unreleased\] section to release as 0\.0\.1/)
    assert.throws(() => release(doc(UNRELEASED, V001, V000)), /both ## \[Unreleased\] and a ## \[0\.0\.1\] heading/)
    assert.throws(() => release(doc(UNRELEASED, "## [0.0.2] - 2026-11-11\n\n- Later.\n", V000)), /"## \[0\.0\.2\] - 2026-11-11" is not older than 0\.0\.1/)
    assert.throws(() => release(doc("## [Unreleased]\n", V000)), /has no notes/)
    assert.throws(() => release(doc(UNRELEASED, UNRELEASED, V000)), /2 ## \[Unreleased\] sections/)
    assert.throws(() => release(doc(UNRELEASED, "## Notes\n\n- Something.\n")), /"## Notes" is not a heading/)
    assert.throws(() => shapeChangelog(ONE, { version: "0.0.1-rc.1", date: "2026-11-12" }), /is not x\.y\.z/)
    assert.throws(() => shapeChangelog(ONE, { version: "0.0.1", date: "12 Nov" }), /is not YYYY-MM-DD/)
  })
})

describe("code fences, as CommonMark reads them", () => {
  const fenced = (...lines) => `${lines.join("\n")}\n`

  test("refuse a CHANGELOG whose fence is never closed: it would swallow every later section", () => {
    const open = doc(V001 + fenced("```md", "- code"), V000, EARLIER)
    assert.match(changelogProblems(open, "0.0.1").join("; "), /the code fence on line \d+ is never closed/)
    assert.throws(() => releaseNotes(open, "0.0.1"), /is never closed/)
    assert.throws(() => shapeChangelog(doc(UNRELEASED + fenced("~~~"), V000), { version: "0.0.1", date: "2026-11-12" }), /is never closed/)
  })

  test("close only with the same character, at least as many: a ``` fence does not end at ~~~", () => {
    // The ~~~ line is code; the ``` after it closes the fence, so the ## [0.0.2] below is a real heading, out of order.
    const text = doc(V001 + fenced("```md", "~~~", "```"), "## [0.0.2] - 2026-11-13\n\n- Hidden before.\n", V000)
    assert.match(changelogProblems(text, "0.0.1").join("; "), /"## \[0\.0\.1\] - 2026-11-12" is above "## \[0\.0\.2\] - 2026-11-13"/)
    // Inside a ~~~ fence, ``` is code, and so is the ## line; ~~~ closes it.
    const tilde = doc(V001 + fenced("~~~", "```", "## [9.9.9] - code", "~~~"), V000)
    assert.deepEqual(changelogProblems(tilde, "0.0.1"), [])
    assert.match(releaseNotes(tilde, "0.0.1"), /## \[9\.9\.9\] - code\n~~~$/)
    // A longer fence needs a closing fence as long; one with an info string does not close.
    assert.deepEqual(changelogProblems(doc(V001 + fenced("````", "```", "## [9.9.9] - code", "````"), V000), "0.0.1"), [])
    assert.deepEqual(changelogProblems(doc(V001 + fenced("```", "```js", "## [9.9.9] - code", "```"), V000), "0.0.1"), [])
  })

  test("recognise a fence indented by up to three spaces, and not by four", () => {
    assert.deepEqual(changelogProblems(doc(V001 + fenced("   ```", "## [9.9.9] - code", "   ```"), V000), "0.0.1"), [])
    assert.match(changelogProblems(doc(V001 + fenced("    ```", "## [9.9.9] - code", "    ```"), V000), "0.0.1").join("; "), /9\.9\.9/)
    // A backtick fence's info string has no backtick, so this line opens nothing.
    assert.match(changelogProblems(doc(V001 + fenced("``` a`b", "## [9.9.9] - code"), V000), "0.0.1").join("; "), /9\.9\.9/)
  })

  test("refuse a heading indented by spaces, which renders as a heading but is not one here", () => {
    assert.match(changelogProblems(doc(V001 + fenced("  ## [0.0.2] - 2026-11-13"), V000), "0.0.1").join("; "), /heading indented by spaces/)
  })
})

describe("one version pattern", () => {
  test("x.y.z with no leading zeros and no prerelease or build part, in every kit script", () => {
    for (const version of ["0.0.0", "0.0.1", "1.20.3", "10.0.0"]) assert.match(version, RELEASE_VERSION)
    for (const version of ["01.0.0", "0.01.0", "0.0.01", "0.0.1-rc.1", "0.0.1+build", "0.0", "v0.0.1"]) assert.doesNotMatch(version, RELEASE_VERSION)
    assert.match(changelogProblems(doc("## [01.0.0] - 2026-11-12\n\n- A fix.\n", V000), "0.0.0").join("; "), /"## \[01\.0\.0\] - 2026-11-12" is not a heading the release shape knows/)
    assert.deepEqual(changelogProblems(ONE, "00.0.0"), ['the version "00.0.0" is not x.y.z'])
    assert.throws(() => shapeChangelog(doc(UNRELEASED, V000), { version: "0.0.01", date: "2026-11-12" }), /is not x\.y\.z/)
    for (const script of ["changelog.mjs", "release-commit.mjs", "release-github.mjs", "release-rules.mjs", "check-release-shape.mjs"]) {
      const source = readFileSync(join(SCRIPTS, script), "utf8")
      assert.match(source, /from "\.\/release-version\.mjs"/, script)
      assert.doesNotMatch(source, /\\d\+\\\.|\[1-9\]\\d\*/, `${script} has a version pattern of its own`)
    }
  })
})

describe("the version and its tag", () => {
  test("the tag is exactly v<version>, for an x.y.z version", () => {
    assert.equal(tagFor("0.0.1"), "v0.0.1")
    assert.equal(tagProblem("v0.0.1", "0.0.1"), undefined)
    assert.equal(tagProblem("v1.20.3", "1.20.3"), undefined)
  })

  test("refuses a tag that differs from v<version>", () => {
    assert.equal(tagProblem("v0.0.0", "0.0.1"), "the tag is v0.0.0, and package.json's version 0.0.1 releases only as v0.0.1")
    for (const tag of ["0.0.1", "v0.0.1 ", "V0.0.1", "v0.0.10", "release-0.0.1"]) assert.match(tagProblem(tag, "0.0.1"), /releases only as v0\.0\.1/, tag)
  })

  test("refuses a version that is not x.y.z", () => {
    for (const version of ["0.0.1-rc.1", "0.0.1+build", "01.0.0", "0.0", "v0.0.1", "", undefined, 1]) {
      assert.match(versionProblem(version), /is not x\.y\.z/, String(version))
      assert.match(tagProblem(`v${version}`, version), /is not x\.y\.z/, String(version))
    }
  })
})

/** A published GitHub Release of a tag, as the Releases API lists it, and a draft (never published). */
const published = (tag) => ({ tag_name: tag, draft: false, published_at: "2026-11-10T12:00:00Z" })
const draft = (tag) => ({ tag_name: tag, draft: true, published_at: null })

/** A release commit as GET repos/{r}/commits/{sha} returns it when the release workflow made it. */
const botCommit = ({ sha, tree = "t".repeat(40), parents, message = "chore(release)" }) => ({
  sha,
  commit: {
    author: { name: ACTIONS_BOT.name, email: ACTIONS_BOT.email, date: "2026-11-11T00:00:00Z" },
    committer: { name: WEB_FLOW.name, email: WEB_FLOW.email, date: "2026-11-11T00:00:00Z" },
    message,
    tree: { sha: tree },
    verification: { verified: true, reason: "valid", signature: "-----BEGIN PGP SIGNATURE-----" },
  },
  author: { login: ACTIONS_BOT.login, type: "Bot" },
  committer: { login: "web-flow", type: "User" },
  parents: parents.map((parent) => ({ sha: parent })),
})

/** A tag object as GET repos/{r}/git/tags/{sha} returns the one the kit makes. */
const kitTag = ({ sha, tag, commit }) => ({
  sha,
  tag,
  message: `${tag}\n`,
  tagger: { name: ACTIONS_BOT.name, email: ACTIONS_BOT.email, date: "2026-11-11T00:00:00Z" },
  object: { type: "commit", sha: commit },
  verification: { verified: false, reason: "unsigned", signature: null, payload: null },
})

/**
 * A `gh` for the scripts run as processes. Answers from the routes file first (a path to a JSON body, or 404), then:
 * the Releases from FAKE_GH_RELEASES; a commit, as the workflow would have made it, from the local git; a tag ref and
 * tag object from the local tags, as the kit makes them. FAKE_GH_FAIL fails every call as a refused request does.
 */
const FAKE_GH = `#!/usr/bin/env node
const ACTIONS_BOT = ${JSON.stringify(ACTIONS_BOT)}
const WEB_FLOW = ${JSON.stringify(WEB_FLOW)}
const { readFileSync } = require("node:fs")
const { spawnSync } = require("node:child_process")
const args = process.argv.slice(2)
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1) }
if (process.env.FAKE_GH_FAIL) fail("HTTP 403: Resource not accessible by integration")
if (args[0] !== "api" || args.length !== 2) fail("fake gh: unexpected call: " + args.join(" "))
const routes = JSON.parse(readFileSync(process.env.FAKE_GH_ROUTES, "utf8"))
const git = (...a) => { const r = spawnSync("git", a, { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : undefined }
const print = (body) => { process.stdout.write(JSON.stringify(body)); process.exit(0) }
const prefix = "repos/owner/kit-test/"
const path = args[1]
if (!path.startsWith(prefix)) fail("fake gh: unexpected path " + path)
const rest = path.slice(prefix.length)
if (rest in routes) routes[rest] === 404 ? fail("gh: Not Found (HTTP 404)") : print(routes[rest])
let match
if (rest === "releases?per_page=100&page=1") print(JSON.parse(readFileSync(process.env.FAKE_GH_RELEASES, "utf8")))
if (rest.startsWith("releases?per_page=100&page=")) print([])
if ((match = /^commits\\/([0-9a-f]{40})$/.exec(rest))) {
  const parents = (git("rev-list", "--parents", "-n", "1", match[1]) ?? fail("gh: Not Found (HTTP 404)")).split(" ").slice(1)
  print((${botCommit.toString().replace(/\n\s*/g, " ")})({ sha: match[1], tree: git("rev-parse", match[1] + "^{tree}"), parents, message: git("log", "-1", "--format=%B", match[1]) }))
}
if ((match = /^git\\/ref\\/tags\\/(.+)$/.exec(rest))) {
  const type = git("cat-file", "-t", "refs/tags/" + match[1])
  if (!type) fail("gh: Not Found (HTTP 404)")
  print({ ref: "refs/tags/" + match[1], object: { type, sha: git("rev-parse", "refs/tags/" + match[1]) } })
}
if ((match = /^git\\/tags\\/([0-9a-f]{40})$/.exec(rest))) {
  const text = git("cat-file", "tag", match[1]) ?? fail("gh: Not Found (HTTP 404)")
  const field = (name) => (new RegExp("^" + name + " (.*)$", "m").exec(text) || [])[1]
  print((${kitTag.toString().replace(/\n\s*/g, " ")})({ sha: match[1], tag: field("tag"), commit: field("object") }))
}
fail("fake gh: unexpected path " + path)
`

/** Writes files at their paths under a folder, making the folders. */
function writeTree(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

/**
 * A git repository in a scratch folder, with no global or system config, committing as kit-test. Its origin is
 * owner/kit-test on GitHub, and `gh` is the fake above, answering with `releases` and `setRoutes`. `npm` is a fake that
 * builds with `node build.mjs`.
 */
function repository(files, { releases = [] } = {}) {
  const dir = folder()
  const home = folder()
  const bin = folder()
  writeFileSync(join(home, ".gitconfig"), "")
  writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 })
  writeFileSync(join(bin, "npm"), '#!/bin/sh\ncase "$1 $2" in "ci --ignore-scripts") exit 0 ;; "run build") exec node build.mjs ;; esac\necho "fake npm: $*" >&2\nexit 1\n', { mode: 0o755 })
  const releasesFile = join(home, "releases.json")
  const routesFile = join(home, "routes.json")
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_REPOSITORY: "owner/kit-test",
    FAKE_GH_RELEASES: releasesFile,
    FAKE_GH_ROUTES: routesFile,
    FAKE_GH_FAIL: "",
  }
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" })
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git("init", "-q", "-b", "master")
  git("config", "user.name", "kit-test")
  git("config", "user.email", "kit-test@example.invalid")
  git("config", "commit.gpgsign", "false")
  git("config", "tag.gpgsign", "false")
  git("remote", "add", "origin", "https://github.com/owner/kit-test.git")
  writeTree(dir, files)
  git("add", ".")
  git("commit", "-q", "-m", "chore: the source")
  const setReleases = (list) => writeFileSync(releasesFile, JSON.stringify(list))
  const setRoutes = (routes) => writeFileSync(routesFile, JSON.stringify(routes))
  setReleases(releases)
  setRoutes({})
  const node = (script, args, extra = {}) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: dir, env: { ...env, ...extra }, encoding: "utf8" })
  return { dir, env, git, node, setReleases, setRoutes, head: git("rev-parse", "HEAD") }
}

/** A later commit on master, so a release can have older source than another. Returns its sha. */
function laterCommit(repo, name = "later.txt") {
  writeFileSync(join(repo.dir, name), `${name}\n`)
  repo.git("add", name)
  repo.git("commit", "-q", "-m", `chore: ${name}`)
  return repo.git("rev-parse", "HEAD")
}

/**
 * A release commit on `from`: dist/ and the given package.json text, then back to master. Tagged (annotated) unless
 * `tag` is null; `name` is then the version it is for. `tweak` changes the index before the commit (a mode, a symlink,
 * an extra file). Returns the commit.
 */
function releaseOn(repo, { tag, pkgText, from, tweak }) {
  repo.git("checkout", "-q", "--detach", from ?? repo.git("rev-parse", "master"))
  mkdirSync(join(repo.dir, "dist"), { recursive: true })
  writeFileSync(join(repo.dir, "dist", "index.js"), "export default 1\n")
  writeFileSync(join(repo.dir, "dist", "tui.js"), "export default 2\n")
  writeFileSync(join(repo.dir, "package.json"), pkgText)
  repo.git("add", "-f", "dist", "package.json")
  tweak?.(repo)
  repo.git("commit", "-q", "-m", `chore(release): ${tag ?? "untagged"}`)
  const commit = repo.git("rev-parse", "HEAD")
  if (tag) repo.git("tag", "-a", tag, "-m", tag)
  repo.git("checkout", "-q", "-f", "master")
  return commit
}

/** check-release-shape.mjs on a tag (GitHub's view of it from the fake gh), or on a commit before its tag. */
const shapeOf = (repo, tag, extra) => repo.node("check-release-shape.mjs", ["--tag", tag, "--branch", "master"], extra).stdout
const shapeOfCommit = (repo, commit, tagName, extra) => repo.node("check-release-shape.mjs", ["--commit", commit, "--tag-name", tagName, "--branch", "master"], extra).stdout

describe("the release commit's identity", () => {
  const good = () => botCommit({ sha: "c".repeat(40), parents: ["p".repeat(40)] })

  test("accepts github-actions[bot] as author, GitHub's web-flow as committer, verified and valid, one parent", () => {
    assert.deepEqual(commitIdentityProblems(good()), [])
  })

  test("refuses each of these alone: unverified, a reason other than valid, a person's author, the bot's address on another account, another committer, two parents", () => {
    const cases = {
      unverified: [(c) => (c.commit.verification = { verified: false, reason: "unsigned" }), /does not verify the release commit's signature \(reason: unsigned\)/],
      "reason not valid": [(c) => (c.commit.verification.reason = "expired_key"), /reason: expired_key/],
      "a person's noreply author": [(c) => (c.commit.author.email = "91376460+joe-broadhead@users.noreply.github.com"), /author is another address, not github-actions\[bot\]/],
      "the bot's address, another login": [(c) => (c.author = { login: "joe-broadhead", type: "User" }), /author account is not the github-actions\[bot\] app/],
      "the bot's address, not a Bot": [(c) => (c.author.type = "User"), /author account is not the github-actions\[bot\] app/],
      "no author account": [(c) => (c.author = null), /author account is not/],
      "another committer": [(c) => (c.commit.committer = { name: "GitHub", email: "someone@example.com" }), /committer is not GitHub's web-flow/],
      "two parents": [(c) => c.parents.push({ sha: "q".repeat(40) }), /has 2 parents; it needs exactly one/],
    }
    for (const [label, [change, expected]] of Object.entries(cases)) {
      const apiCommit = good()
      change(apiCommit)
      const problems = commitIdentityProblems(apiCommit)
      assert.equal(problems.length, 1, `${label}: ${problems.join("; ")}`)
      assert.match(problems[0], expected, label)
    }
  })

  test("never prints an address it does not know", () => {
    const apiCommit = good()
    apiCommit.commit.author.email = "private.person@example.com"
    apiCommit.commit.committer.email = "another.person@example.com"
    const text = commitIdentityProblems(apiCommit).join("; ")
    assert.doesNotMatch(text, /private\.person|another\.person|example\.com/)
    assert.match(text, /another address/)
  })
})

describe("the release tag object", () => {
  const COMMIT = "c".repeat(40)
  const good = () => kitTag({ sha: "a".repeat(40), tag: "v0.0.1", commit: COMMIT })

  test("accepts the kit's tag, with or without the message's trailing newline", () => {
    assert.deepEqual(tagObjectProblems(good(), { tag: "v0.0.1", commit: COMMIT }), [])
    assert.deepEqual(tagObjectProblems({ ...good(), message: "v0.0.1" }, { tag: "v0.0.1", commit: COMMIT }), [])
    assert.deepEqual(tagRefProblems({ object: { type: "tag", sha: "a".repeat(40) } }, "v0.0.1"), [])
  })

  test("refuses a lightweight ref, the wrong name or message, another commit, a non-commit object, another tagger, and any signature", () => {
    assert.match(tagRefProblems({ object: { type: "commit", sha: COMMIT } }, "v0.0.1").join(), /lightweight tag/)
    assert.match(tagRefProblems(undefined, "v0.0.1").join(), /there is no tag v0\.0\.1/)
    const cases = {
      "another name": [(t) => (t.tag = "v0.0.2"), /named v0\.0\.2, not v0\.0\.1/],
      "another message": [(t) => (t.message = "Release v0.0.1\n"), /message is not exactly v0\.0\.1/],
      "another commit": [(t) => (t.object.sha = "d".repeat(40)), /points at dddddddddddd, not the release commit/],
      "a tree": [(t) => (t.object.type = "tree"), /points at a tree, not a commit/],
      "another tagger": [(t) => (t.tagger.email = "91376460+joe-broadhead@users.noreply.github.com"), /tagger is not github-actions\[bot\]/],
      "another tagger name": [(t) => (t.tagger.name = "joe-broadhead"), /tagger is not github-actions\[bot\]/],
      "a signature GitHub cannot check": [(t) => (t.verification = { verified: false, reason: "invalid" }), /must be unsigned, and GitHub says not verified \(invalid\)/],
      "a bad email": [(t) => (t.verification = { verified: false, reason: "bad_email" }), /\(bad_email\)/],
      "a valid signature": [(t) => (t.verification = { verified: true, reason: "valid" }), /says verified \(valid\)/],
    }
    for (const [label, [change, expected]] of Object.entries(cases)) {
      const tagObject = good()
      change(tagObject)
      const problems = tagObjectProblems(tagObject, { tag: "v0.0.1", commit: COMMIT })
      assert.equal(problems.length, 1, `${label}: ${problems.join("; ")}`)
      assert.match(problems[0], expected, label)
    }
  })
})

describe("the calls the kit never makes", () => {
  test("approving or rejecting a deployment, environments, rulesets, bypasses and protection are refused before gh runs", () => {
    const refused = [
      ["api", "-X", "POST", "repos/o/r/actions/runs/1/pending_deployments", "-f", "state=approved"],
      ["api", "repos/o/r/actions/runs/1/pending_deployments"],
      ["api", "-X", "POST", "repos/o/r/actions/runs/1/deployment_protection_rule"],
      ["api", "-X", "PUT", "repos/o/r/environments/release"],
      ["api", "repos/o/r/environments/release/deployment-branch-policies"],
      ["api", "-X", "PUT", "repos/o/r/rulesets/1", "--input", "-"],
      ["api", "-X", "DELETE", "repos/o/r/rulesets/1"],
      ["api", "repos/o/r/bypass-requests/push-rules"],
      ["api", "-X", "PUT", "repos/o/r/branches/master/protection"],
      ["run", "approve", "1"],
      ["api", "graphql", "-f", "query=mutation { approveDeployments(input: {}) { clientMutationId } }"],
    ]
    for (const args of refused) assert.ok(forbiddenCall(args), args.join(" "))
    for (const query of ["mutation($i: X!) { approveDeployments(input: $i) { a } }", "mutation { updateRepositoryRuleset(input: {}) { a } }", "mutation { updateEnvironment(input: {}) { a } }", "mutation { createBypassRequest(input: {}) { a } }"]) {
      assert.ok(forbiddenCall(["api", "graphql", "--input", "-"], JSON.stringify({ query })), query)
    }
    assert.throws(() => ghOutput(["api", "-X", "POST", "repos/o/r/actions/runs/1/pending_deployments"]), /refused: the release kit never makes this call \(approving or rejecting a deployment\); only the owner approves a release/)
  })

  test("the kit's own calls pass", () => {
    const allowed = [
      ["api", "repos/o/r/actions/workflows/ci.yml/runs?head_sha=abc&event=push&branch=master&per_page=100"],
      ["api", "repos/o/r/actions/runs/1"],
      ["run", "download", "1", "--repo", "o/r", "--name", "native-manifest", "--dir", "/tmp/x"],
      ["api", "-X", "POST", "repos/o/r/git/refs", "-f", "ref=refs/heads/release/v0.0.1", "-f", "sha=abc"],
      ["api", "-X", "POST", "repos/o/r/git/tags", "--input", "-"],
      ["api", "-X", "DELETE", "repos/o/r/git/refs/heads/release/v0.0.1"],
      ["api", "repos/o/r/compare/abc...master"],
    ]
    for (const args of allowed) assert.equal(forbiddenCall(args), undefined, args.join(" "))
    const mutation = "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }"
    assert.equal(forbiddenCall(["api", "graphql", "--input", "-"], JSON.stringify({ query: mutation, variables: { input: { message: { headline: "approveDeployments(" } } } })), undefined)
  })
})

describe("check-release-shape.mjs: the tag is v<package.json version>", () => {
  test("refuses a tag that is not v<package.json version>, and accepts the one that is", () => {
    const repo = repository({ "package.json": serialise({ name: "kit-test", version: "0.0.1" }), "CHANGELOG.md": TWO })
    repo.git("tag", "-a", "v0.0.2", "-m", "v0.0.2")
    repo.git("tag", "-a", "v0.0.1", "-m", "v0.0.1")
    const wrong = shapeOf(repo, "v0.0.2")
    assert.match(wrong, /FAIL the version: the tag is v0\.0\.2, and package\.json's version 0\.0\.1 releases only as v0\.0\.1/)
    const right = shapeOf(repo, "v0.0.1")
    assert.match(right, /ok {3}the tag is v0\.0\.1, and the version is 0\.0\.1/)
    assert.doesNotMatch(right, /FAIL the version/)
  })
})

describe("check-release-shape.mjs: the tag and the commit, as GitHub has them", () => {
  const SOURCE = { name: "kit-test", version: "0.0.1", scripts: { build: "node build.mjs" } }
  const tagged = () => {
    const repo = repository({ "package.json": serialise(SOURCE), "CHANGELOG.md": TWO })
    const commit = releaseOn(repo, { tag: "v0.0.1", pkgText: releasePackageText(SOURCE) })
    return { repo, commit }
  }

  test("accepts the kit's tag on a commit the workflow made, and the whole release shape", () => {
    const { repo } = tagged()
    const result = repo.node("check-release-shape.mjs", ["--tag", "v0.0.1", "--branch", "master"])
    assert.match(result.stdout, /ok {3}the tag is annotated/)
    assert.match(result.stdout, /ok {3}the tag is the kit's: v0\.0\.1, tagged by github-actions\[bot\], unsigned/)
    assert.match(result.stdout, /ok {3}GitHub verifies the release commit, made by github-actions\[bot\]/)
    assert.doesNotMatch(result.stdout, /FAIL/)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })

  test("refuses a lightweight tag, another tagger, and a commit GitHub does not verify or the workflow did not make", () => {
    const light = repository({ "package.json": serialise(SOURCE), "CHANGELOG.md": TWO })
    const commit = releaseOn(light, { tag: null, pkgText: releasePackageText(SOURCE) })
    light.git("tag", "v0.0.1", commit)
    assert.match(shapeOf(light, "v0.0.1"), /FAIL the tag is annotated: v0\.0\.1 is a lightweight tag/)

    const { repo, commit: release } = tagged()
    const tagSha = repo.git("rev-parse", "refs/tags/v0.0.1")
    repo.setRoutes({ [`git/tags/${tagSha}`]: { ...kitTag({ sha: tagSha, tag: "v0.0.1", commit: release }), tagger: { name: "joe-broadhead", email: "91376460+joe-broadhead@users.noreply.github.com" } } })
    assert.match(shapeOf(repo, "v0.0.1"), /FAIL the tag: the tagger is not github-actions\[bot\]/)

    const parent = repo.git("rev-parse", `${release}^`)
    const unverified = botCommit({ sha: release, parents: [parent] })
    unverified.commit.verification = { verified: false, reason: "unsigned" }
    repo.setRoutes({ [`commits/${release}`]: unverified })
    assert.match(shapeOf(repo, "v0.0.1"), /FAIL the release commit: GitHub does not verify the release commit's signature \(reason: unsigned\)/)
    const person = botCommit({ sha: release, parents: [parent] })
    person.commit.author.email = "private.person@example.com"
    repo.setRoutes({ [`commits/${release}`]: person })
    const out = shapeOf(repo, "v0.0.1")
    assert.match(out, /FAIL the release commit: the release commit's author is another address/)
    assert.doesNotMatch(out, /private\.person/)
  })

  test("refuses a tag GitHub has on another commit than the checkout's", () => {
    const { repo } = tagged()
    const tagSha = repo.git("rev-parse", "refs/tags/v0.0.1")
    repo.setRoutes({ [`git/tags/${tagSha}`]: kitTag({ sha: tagSha, tag: "v0.0.1", commit: repo.head }) })
    assert.match(shapeOf(repo, "v0.0.1"), /FAIL the tag: the checkout's v0\.0\.1 points at [0-9a-f]{12}, and GitHub's at/)
  })

  test("--commit checks a release commit before its tag exists: every content check, and the tag name against the version", () => {
    const repo = repository({ "package.json": serialise(SOURCE), "CHANGELOG.md": TWO })
    const commit = releaseOn(repo, { tag: null, pkgText: releasePackageText(SOURCE) })
    const result = repo.node("check-release-shape.mjs", ["--commit", commit, "--tag-name", "v0.0.1", "--branch", "master"])
    assert.match(result.stdout, /ok {3}v0\.0\.1 is not tagged yet/)
    for (const line of [/the tag is v0\.0\.1, and the version is 0\.0\.1/, /the parent [0-9a-f]{12} is on master/, /v0\.0\.1 is the first published Release/, /package\.json is the parent's without its lifecycle scripts/, /the change from the parent is the allowed set \(3 paths\)/, /every path it changes is a regular file/, /dist\/ is committed \(2 files\)/]) {
      assert.match(result.stdout, new RegExp(`ok {3}${line.source}`))
    }
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(shapeOfCommit(repo, commit, "v0.0.2"), /FAIL the version: the tag is v0\.0\.2, and package\.json's version 0\.0\.1 releases only as v0\.0\.1/)
  })

  test("refuses --verify git, an identity other than the workflow's, and --commit without a tag name", () => {
    const { repo, commit } = tagged()
    assert.match(repo.node("check-release-shape.mjs", ["--tag", "v0.0.1", "--verify", "git"]).stderr, /--verify is "github-api"/)
    assert.match(repo.node("check-release-shape.mjs", ["--tag", "v0.0.1", "--identity", "owner"]).stderr, /--identity is "github-actions"/)
    assert.match(repo.node("check-release-shape.mjs", ["--commit", commit]).stderr, /--commit needs --tag-name/)
  })
})

describe("check-release-shape.mjs: package.json is exactly the parent's without its lifecycle scripts", () => {
  const SOURCE = { name: "kit-test", version: "0.0.1", main: "dist/index.js", scripts: { build: "node build.mjs", test: "node --test" } }
  const RELEASED = JSON.parse(releasePackageText(SOURCE))
  const caseOf = (pkgText, tag = "v0.0.1") => {
    const repo = repository({ "package.json": serialise(SOURCE), "CHANGELOG.md": TWO })
    releaseOn(repo, { tag, pkgText })
    return shapeOf(repo, tag)
  }

  test("accepts what release-commit.mjs writes", () => {
    assert.deepEqual(RELEASED.scripts, { test: "node --test" })
    assert.match(caseOf(releasePackageText(SOURCE)), /ok {3}package\.json is the parent's without its lifecycle scripts/)
  })

  test("refuses an added dependency, a changed main or version, reordered keys, a kept build script and another form", () => {
    const { name, ...rest } = RELEASED
    const cases = {
      "an added dependency": serialise({ ...RELEASED, dependencies: { "left-pad": "1.3.0" } }),
      "a changed main": serialise({ ...RELEASED, main: "dist/tui.js" }),
      "reordered keys": serialise({ ...rest, name }),
      "a kept build script": serialise(SOURCE),
      "another JSON form": `${JSON.stringify(RELEASED, null, "\t")}\n`,
    }
    for (const [label, pkgText] of Object.entries(cases)) {
      assert.match(caseOf(pkgText), /FAIL package\.json: it is not exactly the parent's without its lifecycle scripts/, label)
    }
    const version = caseOf(serialise({ ...RELEASED, version: "0.0.2" }), "v0.0.2")
    assert.match(version, /ok {3}the tag is v0\.0\.2/)
    assert.match(version, /FAIL package\.json: it is not exactly the parent's/)
  })
})

describe("check-release-shape.mjs: regular files only, and no package.json in dist/", () => {
  const SOURCE = { name: "kit-test", version: "0.0.1", scripts: { build: "node build.mjs" } }
  const caseOf = (tweak) => {
    const repo = repository({ "package.json": serialise(SOURCE), "CHANGELOG.md": TWO })
    releaseOn(repo, { tag: "v0.0.1", pkgText: releasePackageText(SOURCE), tweak })
    return shapeOf(repo, "v0.0.1")
  }
  const symlink = (path, to) => (repo) => {
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo.dir, input: to, encoding: "utf8" }).stdout.trim()
    repo.git("update-index", "--add", "--cacheinfo", `120000,${blob},${path}`)
  }

  test("accepts regular files", () => {
    assert.match(caseOf(), /ok {3}every path it changes is a regular file/)
  })

  test("refuses an executable or a symlink in dist/", () => {
    assert.match(caseOf((repo) => repo.git("update-index", "--chmod=+x", "dist/index.js")), /FAIL the file modes: dist\/index\.js is an executable, not a regular file/)
    assert.match(caseOf(symlink("dist/tui.js", "../../outside.js")), /FAIL the file modes: dist\/tui\.js is a symlink, not a regular file/)
  })

  test("refuses a package.json that is executable or a symlink, before reading it", () => {
    assert.match(caseOf((repo) => repo.git("update-index", "--chmod=+x", "package.json")), /FAIL package\.json: package\.json is an executable, not a regular file/)
    const linked = caseOf(symlink("package.json", "dist/index.js"))
    assert.match(linked, /FAIL package\.json: package\.json is a symlink, not a regular file/)
  })

  test("refuses a package.json added anywhere under dist/", () => {
    for (const path of ["dist/package.json", "dist/browser/package.json"]) {
      const out = caseOf((repo) => {
        mkdirSync(join(repo.dir, path, ".."), { recursive: true })
        writeFileSync(join(repo.dir, path), '{ "type": "commonjs" }\n')
        repo.git("add", "-f", path)
      })
      assert.match(out, new RegExp(`FAIL the change from the parent: paths outside the allowed set: ${path.replaceAll(".", "\\.")}`), path)
    }
  })

  test("allowedPath keeps dist/ files and refuses a nested package.json; modeProblems names each mode", () => {
    assert.equal(allowedPath("dist/index.js"), true)
    assert.equal(allowedPath("dist/browser/vega.js"), true)
    assert.equal(allowedPath("dist/package.json"), false)
    assert.equal(allowedPath("dist/a/package.json"), false)
    assert.equal(allowedPath("dist/package.json.map"), true)
    assert.deepEqual(modeProblems([{ path: "a", mode: "100644" }, { path: "b", mode: "100755" }, { path: "c", mode: "120000" }, { path: "d", mode: "160000" }]), [
      "b is an executable, not a regular file",
      "c is a symlink, not a regular file",
      "d is a submodule, not a regular file",
    ])
  })
})

describe("check-release-shape.mjs: releases move forward from the last published Release", () => {
  const PKG = (version) => releasePackageText({ name: "kit-test", version })
  const twoCommits = () => {
    const repo = repository({ "package.json": serialise({ name: "kit-test", version: "0.0.0" }), "CHANGELOG.md": ONE })
    return { repo, first: repo.head, second: laterCommit(repo) }
  }

  test("accepts the first Release, and one whose parent descends from the last Release's parent", () => {
    const { repo, first, second } = twoCommits()
    releaseOn(repo, { tag: "v0.0.0", pkgText: PKG("0.0.0"), from: first })
    assert.match(shapeOf(repo, "v0.0.0"), /ok {3}v0\.0\.0 is the first published Release/)
    repo.setReleases([published("v0.0.0")])
    releaseOn(repo, { tag: "v0.0.1", pkgText: PKG("0.0.1"), from: second })
    assert.match(shapeOf(repo, "v0.0.1"), /ok {3}the parent descends from the parent of v0\.0\.0, the last published Release/)
  })

  test("refuses a release built on older source than the last Release", () => {
    const { repo, first, second } = twoCommits()
    releaseOn(repo, { tag: "v0.0.0", pkgText: PKG("0.0.0"), from: second })
    repo.setReleases([published("v0.0.0")])
    releaseOn(repo, { tag: "v0.0.1", pkgText: PKG("0.0.1"), from: first })
    assert.match(shapeOf(repo, "v0.0.1"), /FAIL the release order: the parent does not descend from the parent of v0\.0\.0, the last Release/)
  })

  test("refuses a version that is not newer than a published Release", () => {
    const { repo, second } = twoCommits()
    releaseOn(repo, { tag: "v0.0.2", pkgText: PKG("0.0.2"), from: second })
    repo.setReleases([published("v0.0.2")])
    releaseOn(repo, { tag: "v0.0.1", pkgText: PKG("0.0.1"), from: second })
    assert.match(shapeOf(repo, "v0.0.1"), /FAIL the release order: the published Release v0\.0\.2 is not older than v0\.0\.1/)
  })

  test("is not blocked by a stray higher tag with no Release, or by a draft", () => {
    const { repo, first, second } = twoCommits()
    releaseOn(repo, { tag: "v0.0.0", pkgText: PKG("0.0.0"), from: first })
    releaseOn(repo, { tag: "v9.9.9", pkgText: PKG("9.9.9"), from: second })
    releaseOn(repo, { tag: "v0.0.2", pkgText: PKG("0.0.2"), from: second })
    repo.setReleases([published("v0.0.0"), draft("v0.0.2"), { ...published("v0.0.3"), draft: true }])
    releaseOn(repo, { tag: "v0.0.1", pkgText: PKG("0.0.1"), from: second })
    const out = shapeOf(repo, "v0.0.1")
    assert.match(out, /ok {3}the parent descends from the parent of v0\.0\.0, the last published Release/)
    assert.doesNotMatch(out, /FAIL the release order/)
  })

  test("refuses, and never passes, when GitHub cannot be read", () => {
    const { repo, first } = twoCommits()
    releaseOn(repo, { tag: "v0.0.1", pkgText: PKG("0.0.1"), from: first })
    const result = repo.node("check-release-shape.mjs", ["--tag", "v0.0.1", "--branch", "master"], { FAKE_GH_FAIL: "1" })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /GitHub could not be read \(git: HTTP 403: Resource not accessible by integration\)/)
    assert.doesNotMatch(result.stdout, /ok {3}.*(first published Release|descends from)/)
  })

  test("refuses the order when only the Releases cannot be listed", () => {
    const { repo, first } = twoCommits()
    const commit = releaseOn(repo, { tag: null, pkgText: PKG("0.0.1"), from: first })
    repo.setRoutes({ "releases?per_page=100&page=1": { message: "Not Found" } })
    assert.match(shapeOfCommit(repo, commit, "v0.0.1"), /FAIL the release order: the published Releases could not be listed \(the Releases API did not answer with a list\), so the order is not checked/)
  })

  test("releasedTags keeps published, non-draft v<x.y.z> Releases; fetchReleases reads every page", () => {
    assert.deepEqual(releasedTags([published("v0.0.0"), draft("v0.0.1"), { ...published("v0.0.2"), published_at: null }, published("v1.0.0-rc.1"), published("nightly")]), ["v0.0.0"])
    const calls = []
    const pages = { 1: Array.from({ length: 100 }, (_, i) => published(`v0.0.${i}`)), 2: [published("v0.1.0")] }
    const gh = (args) => {
      calls.push(args[1])
      return JSON.stringify(pages[Number(/page=(\d+)$/.exec(args[1])[1])] ?? [])
    }
    assert.equal(fetchReleases("owner/kit-test", gh).length, 101)
    assert.deepEqual(calls, ["repos/owner/kit-test/releases?per_page=100&page=1", "repos/owner/kit-test/releases?per_page=100&page=2"])
    assert.throws(() => fetchReleases("owner/kit-test", () => '{"message":"Not Found"}'), /did not answer with a list/)
  })
})

/** A plugin's source, as the release workflow sees it: a build, TESTED_HOSTS, and, when native, native.yml. */
const pluginSource = (version, { native = false, changelog = TWO } = {}) => ({
  "package.json": serialise({ name: "@owner/kit-test", version, scripts: { build: "node build.mjs", test: "node --test" } }),
  "CHANGELOG.md": changelog,
  ".gitignore": "dist/\nnode_modules/\n",
  "build.mjs": 'import { mkdirSync, writeFileSync } from "node:fs"\nmkdirSync("dist", { recursive: true })\nwriteFileSync("dist/index.js", "export default 1\\n")\nwriteFileSync("dist/tui.js", "export default 2\\n")\n',
  "src/host.ts": 'export const TESTED_HOSTS = ["2.2.3", "2.2.6"] as const\n',
  ...(native ? { ".github/workflows/native.yml": "name: native\n" } : {}),
})

/** A manifest the native run would write for the release of `tag` on `commit`. */
const nativeManifest = ({ tag, commit, run = 77 }) => ({
  schema: 1,
  plugin: "kit-test",
  repository: "owner/kit-test",
  tag,
  built: { commit, run, workflow: "native" },
  modules: {
    tool: {
      "linux-x64-gnu": { name: "tool-linux-x64-gnu.gz", bytes: 10, sha256: "a".repeat(64), executable: { name: "tool", bytes: 20, sha256: "b".repeat(64) } },
    },
  },
})

/**
 * GitHub, in memory, for the release-github.mjs functions: refs, tag objects, commits, CI and native runs, Releases. Its
 * createCommitOnBranch writes a real commit into `repo` from the request's files, so trees are git's own. Records every
 * call; `onCommit(apiCommit)` may change what GitHub answers about a new commit.
 */
function fakeGitHub(repo, { onCommit, mergeBase } = {}) {
  const state = { refs: new Map(), tagObjects: new Map(), commits: new Map(), runs: new Map(), manifests: new Map(), ciRuns: [], releases: [] }
  const calls = []
  let made = 0
  const notFound = () => {
    throw new Error("gh: Not Found (HTTP 404)")
  }
  const R = "repos/owner/kit-test/"
  const gh = (args, { input } = {}) => {
    const forbidden = forbiddenCall(args, input)
    if (forbidden) throw new Error(`refused: ${forbidden}`)
    calls.push({ args, input: input === undefined ? undefined : JSON.parse(input) })
    if (args[0] === "run" && args[1] === "download") {
      const manifest = state.manifests.get(args[2])
      if (!manifest) throw new Error("no artifact matches any of the names provided")
      writeFileSync(join(args[args.indexOf("--dir") + 1], "native.json"), JSON.stringify(manifest))
      return ""
    }
    if (args[1] === "graphql") return JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: createCommit(JSON.parse(input).variables.input) } } } })
    const method = args[1] === "-X" ? args[2] : "GET"
    const path = (method === "GET" ? args[1] : args[3]).slice(R.length)
    const field = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
    let match
    const hit = (pattern) => {
      match = pattern.exec(path)
      return match
    }
    if (method === "GET") {
      if (path.startsWith("actions/workflows/ci.yml/runs?")) return JSON.stringify({ workflow_runs: state.ciRuns })
      if (hit(/^actions\/runs\/(\d+)$/)) return JSON.stringify(state.runs.get(match[1]) ?? notFound())
      if (hit(/^git\/ref\/(.+)$/)) {
        const ref = state.refs.get(match[1]) ?? notFound()
        return JSON.stringify({ ref: `refs/${match[1]}`, object: ref })
      }
      if (hit(/^git\/tags\/(\w+)$/)) return JSON.stringify(state.tagObjects.get(match[1]) ?? notFound())
      if (hit(/^commits\/(\w+)$/)) return JSON.stringify(state.commits.get(match[1]) ?? notFound())
      if (path === "releases?per_page=100&page=1") return JSON.stringify(state.releases)
      if (path.startsWith("releases?")) return "[]"
      if (hit(/^compare\/(\w+)\.\.\.master$/)) return JSON.stringify({ merge_base_commit: { sha: mergeBase ?? match[1] } })
    }
    if (method === "POST" && path === "git/refs") {
      const body = input ? JSON.parse(input) : { ref: field("ref"), sha: field("sha") }
      const name = body.ref.slice("refs/".length)
      if (state.refs.has(name)) throw new Error("gh: Reference already exists (HTTP 422)")
      state.refs.set(name, { type: state.tagObjects.has(body.sha) ? "tag" : "commit", sha: body.sha })
      return JSON.stringify({ ref: body.ref, object: state.refs.get(name) })
    }
    if (method === "POST" && path === "git/tags") {
      const body = JSON.parse(input)
      const sha = `${String(++made).padStart(4, "0")}${"e".repeat(36)}`
      state.tagObjects.set(sha, { sha, tag: body.tag, message: body.message, tagger: body.tagger, object: { type: body.type, sha: body.object }, verification: { verified: false, reason: "unsigned" } })
      return JSON.stringify(state.tagObjects.get(sha))
    }
    if (method === "DELETE" && hit(/^git\/refs\/(.+)$/)) {
      if (!state.refs.delete(match[1])) notFound()
      return ""
    }
    throw new Error(`fake GitHub: unexpected call ${args.join(" ")}`)
  }
  function createCommit(input) {
    const name = `heads/${input.branch.branchName}`
    const head = state.refs.get(name)
    if (!head) throw new Error("gh: GraphQL: A ref named ... does not exist")
    if (head.sha !== input.expectedHeadOid) throw new Error("gh: GraphQL: Expected branch to point to ...")
    const index = join(folder(), "index")
    const env = { ...repo.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: ACTIONS_BOT.name, GIT_AUTHOR_EMAIL: ACTIONS_BOT.email, GIT_COMMITTER_NAME: WEB_FLOW.name, GIT_COMMITTER_EMAIL: WEB_FLOW.email }
    const git = (args, stdin) => {
      const result = spawnSync("git", args, { cwd: repo.dir, env, input: stdin, encoding: stdin === undefined ? "utf8" : undefined })
      assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`)
      return String(result.stdout).trim()
    }
    git(["read-tree", head.sha])
    for (const file of input.fileChanges.additions) {
      const blob = git(["hash-object", "-w", "--stdin"], Buffer.from(file.contents, "base64"))
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`])
    }
    const tree = git(["write-tree"])
    const sha = git(["commit-tree", tree, "-p", head.sha, "-m", input.message.headline])
    const apiCommit = botCommit({ sha, tree, parents: [head.sha], message: input.message.headline })
    onCommit?.(apiCommit)
    state.commits.set(sha, apiCommit)
    head.sha = sha
    return sha
  }
  return { gh, state, calls, writes: () => calls.filter(({ args }) => args[1] === "-X" || args[1] === "graphql") }
}

const ENV = (repo, extra = {}) => ({ GITHUB_REPOSITORY: "owner/kit-test", GITHUB_REF: "refs/heads/master", GITHUB_SHA: repo.head, ...extra })
const ciRun = (sha, extra = {}) => ({ id: 501, head_sha: sha, event: "push", head_branch: "master", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", created_at: "2026-11-11T10:00:00Z", ...extra })
const nativeRun = (sha, extra = {}) => ({ id: 77, head_sha: sha, conclusion: "success", path: ".github/workflows/native.yml", head_branch: "master", event: "workflow_dispatch", ...extra })

describe("release-github.mjs plan", () => {
  const setup = ({ version = "0.0.1", native = false, changelog } = {}) => {
    const repo = repository(pluginSource(version, { native, changelog }))
    const github = fakeGitHub(repo)
    github.state.ciRuns = [ciRun(repo.head)]
    const run = (options = {}) => plan({ sha: repo.head, env: ENV(repo), gh: github.gh, cwd: repo.dir, ...options })
    return { repo, github, run }
  }

  test("plans a new release: the version, the tag, the hosts, the CI run", () => {
    const { run } = setup()
    assert.deepEqual(run(), { version: "0.0.1", tag: "v0.0.1", hosts: '["2.2.3","2.2.6"]', native: "false", mode: "new", commit: "", ci_run: "501", previous: "" })
  })

  test("refuses a run that is not on master, or a sha that is not the run's", () => {
    const { repo, run } = setup()
    assert.throws(() => run({ env: ENV(repo, { GITHUB_REF: "refs/heads/side" }) }), /a release runs from master only, and this run is on refs\/heads\/side/)
    assert.throws(() => run({ env: ENV(repo, { GITHUB_SHA: "f".repeat(40) }) }), /the run is on master at ffffffffffff, not [0-9a-f]{12}: dispatch again with master's head/)
    assert.throws(() => run({ sha: "abc" }), /--sha must be the full 40-character sha/)
  })

  test("refuses without a green CI push run on exactly the sha", () => {
    const { repo, github, run } = setup()
    github.state.ciRuns = []
    assert.throws(run, /no ci\.yml run for a push to master on [0-9a-f]{12}: push it to master, and wait for CI/)
    github.state.ciRuns = [ciRun(repo.head, { status: "in_progress", conclusion: null })]
    assert.throws(run, /CI is still running on [0-9a-f]{12} \(run 501\): wait for it/)
    github.state.ciRuns = [ciRun(repo.head, { conclusion: "failure" })]
    assert.throws(run, /the newest CI run on [0-9a-f]{12} \(run 501\) concluded failure/)
    github.state.ciRuns = [ciRun(repo.head, { id: 500 }), ciRun(repo.head, { id: 502, created_at: "2026-11-11T11:00:00Z", conclusion: "cancelled" })]
    assert.throws(run, /\(run 502\) concluded cancelled/)
    github.state.ciRuns = [ciRun(repo.head, { event: "pull_request" }), ciRun("f".repeat(40))]
    assert.throws(run, /no ci\.yml run for a push to master/)
  })

  test("refuses a version or a CHANGELOG that is not ready", () => {
    assert.throws(setup({ version: "0.0.1-rc.1" }).run, /package\.json version "0\.0\.1-rc\.1" is not x\.y\.z/)
    assert.throws(setup({ changelog: doc(UNRELEASED, V000, EARLIER) }).run, /CHANGELOG\.md is not ready for v0\.0\.1: an ## \[Unreleased\] section is still there/)
  })

  test("refuses a leftover release branch, a tag that is not a resume, and a release that is already published", () => {
    const { repo, github, run } = setup()
    github.state.refs.set("heads/release/v0.0.1", { type: "commit", sha: repo.head })
    assert.throws(run, /the branch release\/v0\.0\.1 is left from an earlier run: check it is not a run waiting for approval, then delete it/)
    github.state.refs.clear()
    github.state.refs.set("tags/v0.0.1", { type: "commit", sha: repo.head })
    assert.throws(run, /the tag v0\.0\.1 exists and is not one this release can resume \(v0\.0\.1 is a lightweight tag/)
    github.state.refs.clear()
    github.state.releases = [published("v0.0.1")]
    assert.throws(run, /v0\.0\.1 is already a published Release: release the next version/)
  })

  test("refuses a release that does not move forward", () => {
    const { github, run } = setup()
    github.state.releases = [published("v0.0.2")]
    assert.throws(run, /the published Release v0\.0\.2 is not older than v0\.0\.1/)
  })

  test("a native plugin needs native_run, and a plugin that is not native refuses one", () => {
    assert.throws(() => setup({ native: true }).run(), /this plugin is native: run the native workflow on [0-9a-f]{12}, then dispatch with native_run/)
    assert.throws(() => setup().run({ nativeRun: "77" }), /native_run is set, and this plugin has no \.github\/workflows\/native\.yml: dispatch without it/)
    assert.throws(() => setup({ native: true }).run({ nativeRun: "seven" }), /native_run must be a run id/)
  })

  test("refuses a native run on another sha, failed, of another workflow, branch or event, and a bad manifest", () => {
    const { repo, github, run } = setup({ native: true })
    github.state.manifests.set("77", nativeManifest({ tag: "v0.0.1", commit: repo.head }))
    const cases = {
      "another sha": [{ head_sha: "f".repeat(40) }, /the run built ffffffffffff, not/],
      failed: [{ conclusion: "failure" }, /the run concluded failure/],
      "another workflow": [{ path: ".github/workflows/ci.yml" }, /the run is not the native workflow/],
      "another branch": [{ head_branch: "side" }, /the run is not on master/],
      "another event": [{ event: "push" }, /the run was started by push, not workflow_dispatch/],
    }
    for (const [label, [change, expected]] of Object.entries(cases)) {
      github.state.runs.set("77", nativeRun(repo.head, change))
      assert.throws(() => run({ nativeRun: "77" }), expected, label)
    }
    github.state.runs.set("77", nativeRun(repo.head))
    github.state.manifests.set("77", nativeManifest({ tag: "v0.0.0", commit: repo.head }))
    assert.throws(() => run({ nativeRun: "77" }), /the native manifest of run 77 is not right: tag is v0\.0\.0; the release tag is v0\.0\.1/)
    github.state.manifests.delete("77")
    assert.throws(() => run({ nativeRun: "77" }), /no artifact matches/)
  })

  test("a native plugin with a right run plans, and keeps the vetted manifest for the build", () => {
    const { repo, github, run } = setup({ native: true })
    github.state.runs.set("77", nativeRun(repo.head))
    github.state.manifests.set("77", nativeManifest({ tag: "v0.0.1", commit: repo.head }))
    const out = join(folder(), "native", "native.json")
    assert.equal(run({ nativeRun: "77", manifestOut: out }).native, "true")
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), nativeManifest({ tag: "v0.0.1", commit: repo.head }))
  })
})

describe("release-github.mjs plan: resuming a release whose tag exists", () => {
  const setup = () => {
    const repo = repository(pluginSource("0.0.1"))
    const github = fakeGitHub(repo)
    github.state.ciRuns = [ciRun(repo.head)]
    const release = "c".repeat(40)
    github.state.commits.set(release, botCommit({ sha: release, parents: [repo.head] }))
    github.state.tagObjects.set("a".repeat(40), kitTag({ sha: "a".repeat(40), tag: "v0.0.1", commit: release }))
    github.state.refs.set("tags/v0.0.1", { type: "tag", sha: "a".repeat(40) })
    const run = () => plan({ sha: repo.head, env: ENV(repo), gh: github.gh, cwd: repo.dir })
    return { repo, github, release, run }
  }

  test("resumes the kit's tag on a release commit on this sha with no published Release, even with a draft", () => {
    const { github, release, run } = setup()
    assert.equal(run().mode, "resume")
    assert.equal(run().commit, release)
    github.state.releases = [draft("v0.0.1")]
    assert.equal(run().mode, "resume")
  })

  test("refuses it when the Release is published, the tagger is another, or the commit has another parent", () => {
    let { github, run } = setup()
    github.state.releases = [published("v0.0.1")]
    assert.throws(run, /v0\.0\.1 is already a published Release/)
    ;({ github, run } = setup())
    github.state.tagObjects.get("a".repeat(40)).tagger = { name: "joe-broadhead", email: "91376460+joe-broadhead@users.noreply.github.com" }
    assert.throws(run, /the tag v0\.0\.1 exists and is not one this release can resume \(the tagger is not github-actions\[bot\]\): release the next version/)
    const other = setup()
    other.github.state.commits.set(other.release, botCommit({ sha: other.release, parents: ["f".repeat(40)] }))
    assert.throws(other.run, /its release commit's parent is ffffffffffff, not/)
    const unverified = setup()
    unverified.github.state.commits.get(unverified.release).commit.verification = { verified: false, reason: "unsigned" }
    assert.throws(unverified.run, /does not verify the release commit's signature/)
  })
})

describe("release-commit.mjs: the build step", () => {
  const build = (repo, extra = [], env) => repo.node("release-commit.mjs", ["--sha", repo.git("rev-parse", "HEAD"), "--out", join(repo.dir, "..", `files-${made++}`), ...extra], env)

  test("builds dist/ and writes the release files with paths.txt, and commits nothing", () => {
    const repo = repository(pluginSource("0.0.1"))
    const out = join(folder(), "files")
    const result = repo.node("release-commit.mjs", ["--sha", repo.head, "--out", out])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(out, "package.json"), "utf8"), releasePackageText(JSON.parse(pluginSource("0.0.1")["package.json"])))
    assert.equal(readFileSync(join(out, "dist", "index.js"), "utf8"), "export default 1\n")
    const lines = readFileSync(join(out, "paths.txt"), "utf8").trim().split("\n")
    assert.deepEqual(lines.map((line) => line.split("  ")[1]), ["dist/index.js", "dist/tui.js", "package.json"])
    assert.equal(repo.git("rev-parse", "HEAD"), repo.head)
    assert.equal(repo.git("tag", "--list"), "")
  })

  test("refuses another head, a dirty tree, a version that is not x.y.z, and a manifest that does not fit the plugin", () => {
    const repo = repository(pluginSource("0.0.1"))
    assert.match(repo.node("release-commit.mjs", ["--sha", "f".repeat(40), "--out", join(folder(), "x")]).stderr, /the checkout is not ffffffffffff/)
    writeFileSync(join(repo.dir, "stray.txt"), "x\n")
    assert.match(build(repo).stderr, /the tree is not clean/)
    assert.match(build(repository(pluginSource("01.0.0"))).stderr, /is not x\.y\.z/)
    assert.match(build(repository(pluginSource("0.0.1", { native: true }))).stderr, /this plugin is native \(\.github\/workflows\/native\.yml\), and no vetted manifest was given/)
    const manifest = join(folder(), "native.json")
    writeFileSync(manifest, "{}")
    assert.match(build(repository(pluginSource("0.0.1")), ["--manifest", manifest]).stderr, /a manifest was given, and this plugin is not native/)
  })

  test("adds the vetted manifest for a native plugin, and refuses one for another commit", () => {
    const repo = repository(pluginSource("0.0.1", { native: true }))
    const manifest = join(folder(), "native.json")
    writeFileSync(manifest, `${JSON.stringify(nativeManifest({ tag: "v0.0.1", commit: "f".repeat(40) }), null, 2)}\n`)
    assert.match(build(repo, ["--manifest", manifest]).stderr, /built\.commit is ffffffffffff; the tag's parent is/)
    writeFileSync(manifest, `${JSON.stringify(nativeManifest({ tag: "v0.0.1", commit: repo.head }), null, 2)}\n`)
    const out = join(folder(), "files")
    assert.equal(repo.node("release-commit.mjs", ["--sha", repo.head, "--out", out, "--manifest", manifest]).status, 0)
    assert.match(readFileSync(join(out, "paths.txt"), "utf8"), / {2}manifest\/native\.json\n/)
  })

  test("refuses a build that changes tracked files or writes a package.json under dist/", () => {
    const touch = repository({ ...pluginSource("0.0.1"), "build.mjs": 'import { writeFileSync } from "node:fs"\nwriteFileSync("CHANGELOG.md", "changed\\n")\n' })
    assert.match(build(touch).stderr, /the build changed tracked files/)
    const nested = repository({ ...pluginSource("0.0.1"), "build.mjs": `${pluginSource("0.0.1")["build.mjs"]}writeFileSync("dist/package.json", "{}\\n")\n` })
    assert.match(build(nested).stderr, /built paths outside the allowed set: dist\/package\.json/)
  })
})

describe("release-github.mjs commit", () => {
  const setup = (options = {}) => {
    const repo = repository(pluginSource("0.0.1"))
    const files = join(folder(), "files")
    const result = repo.node("release-commit.mjs", ["--sha", repo.head, "--out", files])
    assert.equal(result.status, 0, result.stderr)
    const github = fakeGitHub(repo, options)
    const outputs = {}
    const run = (extra = {}) => commit({ dir: files, parent: repo.head, tag: "v0.0.1", native: false, env: ENV(repo), gh: github.gh, cwd: repo.dir, sleep: () => {}, output: (key, value) => (outputs[key] = value), ...extra })
    return { repo, files, github, outputs, run }
  }

  test("creates release/v<version> at the parent, then one createCommitOnBranch with exactly the files", () => {
    const { repo, files, github, outputs, run } = setup()
    const result = run()
    const [branch, mutation] = github.writes()
    assert.deepEqual(branch.args, ["api", "-X", "POST", "repos/owner/kit-test/git/refs", "-f", "ref=refs/heads/release/v0.0.1", "-f", `sha=${repo.head}`])
    const { input } = mutation.input.variables
    assert.deepEqual(input.branch, { repositoryNameWithOwner: "owner/kit-test", branchName: "release/v0.0.1" })
    assert.deepEqual(input.message, { headline: "chore(release): v0.0.1 with the built dist/ and no lifecycle scripts" })
    assert.equal(input.expectedHeadOid, repo.head)
    assert.deepEqual(input.fileChanges.additions.map((file) => file.path), ["dist/index.js", "dist/tui.js", "package.json"])
    for (const file of input.fileChanges.additions) assert.equal(Buffer.from(file.contents, "base64").toString("utf8"), readFileSync(join(files, file.path), "utf8"), file.path)
    assert.equal(input.fileChanges.deletions, undefined)
    assert.match(mutation.input.query, /createCommitOnBranch/)
    assert.deepEqual(outputs, { commit: result.commit, tree: result.tree })
    assert.equal(github.state.refs.get("heads/release/v0.0.1").sha, result.commit)
  })

  test("the tree it expects is the tree of a real commit of the same files", () => {
    const { repo, files, run } = setup()
    const { tree } = run()
    repo.git("checkout", "-q", "--detach", repo.head)
    for (const path of ["dist/index.js", "dist/tui.js", "package.json"]) writeTree(repo.dir, { [path]: readFileSync(join(files, path)) })
    repo.git("add", "-f", "dist", "package.json")
    assert.equal(repo.git("write-tree"), tree)
  })

  test("refuses files outside the allowed set, not regular, a package.json under dist/, unlisted, changed, too big", () => {
    const cases = {
      "outside the allowed set": [(dir) => writeTree(dir, { "src/x.js": "x\n" }), /paths outside the allowed set: src\/x\.js/],
      "a package.json under dist/": [(dir) => writeTree(dir, { "dist/a/package.json": "{}\n" }), /paths outside the allowed set: dist\/a\/package\.json/],
      "a symlink": [(dir) => symlinkSync("index.js", join(dir, "dist", "link.js")), /dist\/link\.js is not a regular file/],
      "a changed file": [(dir) => writeFileSync(join(dir, "dist", "index.js"), "changed\n"), /dist\/index\.js does not match its sha256 in paths\.txt/, false],
      "a missing file": [(dir) => rmSync(join(dir, "dist", "tui.js")), /missing dist\/tui\.js/, false],
      "another package.json": [(dir) => writeFileSync(join(dir, "package.json"), serialise({ name: "@owner/kit-test", version: "0.0.1", scripts: { build: "x" } })), /package\.json is not exactly the parent's without its lifecycle scripts/],
    }
    for (const [label, [change, expected, relist = true]] of Object.entries(cases)) {
      const { files, github, run } = setup()
      change(files)
      if (relist) relistPaths(files)
      assert.throws(() => run(), expected, label)
      assert.deepEqual(github.writes(), [], label)
    }
    const big = setup()
    assert.throws(() => big.run({ limits: { file: 10, payload: MAX_PAYLOAD } }), /dist\/index\.js is 0\.0 MB, over the 0\.0 MB a file can be/)
    assert.throws(() => big.run({ limits: { file: MAX_FILE, payload: 40 } }), /the release commit needs a 0\.0 MB request, over the 0\.0 MB limit/)
    assert.deepEqual(big.github.writes(), [])
    assert.equal(MAX_FILE, 5 * 1024 * 1024)
    assert.equal(MAX_PAYLOAD, 40 * 1024 * 1024)
  })

  test("refuses when release/v<version> already exists, and writes nothing", () => {
    const { repo, github, run } = setup()
    github.state.refs.set("heads/release/v0.0.1", { type: "commit", sha: repo.head })
    assert.throws(() => run(), /the branch release\/v0\.0\.1 already exists/)
    assert.deepEqual(github.writes(), [])
  })

  test("on a tree mismatch, an unverified commit or another parent, deletes the branch and fails", () => {
    const cases = {
      "another tree": [(c) => (c.commit.tree.sha = "f".repeat(40)), /its tree is ffffffffffff, and the files give/],
      unverified: [(c) => (c.commit.verification = { verified: false, reason: "unsigned" }), /does not verify the release commit's signature \(reason: unsigned\)/],
      "another parent": [(c) => (c.parents = [{ sha: "f".repeat(40) }]), /its parent is not/],
      "a person as author": [(c) => (c.commit.author.email = "private.person@example.com"), /author is another address/],
    }
    for (const [label, [change, expected]] of Object.entries(cases)) {
      const { github, run } = setup({ onCommit: change })
      assert.throws(() => run(), (error) => expected.test(error.message) && /deleted release\/v0\.0\.1/.test(error.message), label)
      assert.equal(github.state.refs.has("heads/release/v0.0.1"), false, label)
      assert.doesNotMatch(String(github.calls.map((call) => call.args.join(" "))), /private\.person/)
    }
  })

  test("waits while GitHub has not verified the signature yet", () => {
    let reads = 0
    const { github, run } = setup({ onCommit: (c) => (c.commit.verification = { verified: false, reason: "gpgverify_unavailable" }) })
    const read = github.gh
    const gh = (args, options) => {
      const out = read(args, options)
      if (/\/commits\//.test(args[1] ?? "") && ++reads === 2) {
        const body = JSON.parse(out)
        body.commit.verification = { verified: true, reason: "valid" }
        return JSON.stringify(body)
      }
      return out
    }
    let slept = 0
    run({ gh, sleep: () => slept++ })
    assert.equal(slept, 1)
  })
})

/** Rewrites paths.txt for the files now in a folder, as a build that produced them would. */
function relistPaths(dir) {
  const files = []
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name)
      const stat = lstatSync(full)
      if (stat.isDirectory()) walk(full)
      else if (name !== "paths.txt" || at !== dir) files.push({ path: full.slice(dir.length + 1), bytes: stat.isFile() ? readFileSync(full) : Buffer.alloc(0) })
    }
  }
  walk(dir)
  writeFileSync(join(dir, "paths.txt"), pathsText(files))
}

describe("release-github.mjs tag", () => {
  const setup = (options = {}) => {
    const repo = repository(pluginSource("0.0.1"))
    const github = fakeGitHub(repo, options)
    const release = "c".repeat(40)
    github.state.commits.set(release, botCommit({ sha: release, parents: [repo.head] }))
    github.state.refs.set("heads/release/v0.0.1", { type: "commit", sha: release })
    const run = (extra = {}) => tagRelease({ tag: "v0.0.1", commit: release, parent: repo.head, mode: "new", env: ENV(repo), gh: github.gh, cwd: repo.dir, now: () => "2026-11-12T09:00:00Z", ...extra })
    return { repo, github, release, run }
  }

  test("creates the annotated tag object, then the ref, with exact bodies, and reads it back", () => {
    const { github, release, run } = setup()
    const result = run()
    assert.equal(result.action, "created")
    const [object, ref] = github.writes()
    assert.deepEqual(object.args, ["api", "-X", "POST", "repos/owner/kit-test/git/tags", "--input", "-"])
    assert.deepEqual(object.input, { tag: "v0.0.1", message: "v0.0.1", object: release, type: "commit", tagger: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com", date: "2026-11-12T09:00:00Z" } })
    assert.deepEqual(ref.args, ["api", "-X", "POST", "repos/owner/kit-test/git/refs", "--input", "-"])
    assert.deepEqual(ref.input, { ref: "refs/tags/v0.0.1", sha: result.tagObject.sha })
    assert.equal(github.state.refs.get("tags/v0.0.1").type, "tag")
  })

  test("reuses the kit's tag on the commit with no write, and stops with no write at any other tag", () => {
    const { github, release, run } = setup()
    github.state.tagObjects.set("a".repeat(40), kitTag({ sha: "a".repeat(40), tag: "v0.0.1", commit: release }))
    github.state.refs.set("tags/v0.0.1", { type: "tag", sha: "a".repeat(40) })
    assert.equal(run().action, "reused")
    assert.equal(run({ mode: "resume" }).action, "reused")
    github.state.tagObjects.set("a".repeat(40), kitTag({ sha: "a".repeat(40), tag: "v0.0.1", commit: "d".repeat(40) }))
    assert.throws(() => run(), /the tag v0\.0\.1 already exists and is not the kit's tag on cccccccccccc \(the tag points at dddddddddddd, not the release commit cccccccccccc\): nothing was written/)
    github.state.refs.set("tags/v0.0.1", { type: "commit", sha: release })
    assert.throws(() => run(), /lightweight tag/)
    assert.deepEqual(github.writes(), [])
  })

  test("refuses, before any write, a moved branch, a parent no longer on master, a published or newer Release, a commit the workflow did not make", () => {
    const moved = setup()
    moved.github.state.refs.set("heads/release/v0.0.1", { type: "commit", sha: "d".repeat(40) })
    assert.throws(() => moved.run(), /release\/v0\.0\.1 no longer points at the release commit cccccccccccc/)
    assert.throws(() => setup({ mergeBase: "f".repeat(40) }).run(), /is no longer on master/)
    const done = setup()
    done.github.state.releases = [published("v0.0.1")]
    assert.throws(() => done.run(), /v0\.0\.1 is already a published Release/)
    const newer = setup()
    newer.github.state.releases = [published("v0.0.2")]
    assert.throws(() => newer.run(), /the published Release v0\.0\.2 is not older than v0\.0\.1/)
    const person = setup()
    person.github.state.commits.get(person.release).commit.author.email = "private.person@example.com"
    assert.throws(() => person.run(), /the release commit is not right: the release commit's author is another address/)
    const gone = setup()
    assert.throws(() => gone.run({ mode: "resume" }), /resume: the tag v0\.0\.1 is gone/)
    for (const { github } of [moved, done, newer, person, gone]) assert.deepEqual(github.writes(), [])
  })
})

describe("release-github.mjs cleanup", () => {
  const setup = (at) => {
    const repo = repository(pluginSource("0.0.1"))
    const github = fakeGitHub(repo)
    if (at) github.state.refs.set("heads/release/v0.0.1", { type: "commit", sha: at === "parent" ? repo.head : at })
    github.state.refs.set("heads/master", { type: "commit", sha: repo.head })
    const run = (extra = {}) => cleanup({ tag: "v0.0.1", parent: repo.head, env: ENV(repo), gh: github.gh, ...extra })
    return { repo, github, run }
  }

  test("deletes release/v<version> when it points at the parent or the run's commit", () => {
    const atParent = setup("parent")
    assert.equal(atParent.run({ commit: "c".repeat(40) }).action, "deleted")
    assert.equal(atParent.github.state.refs.has("heads/release/v0.0.1"), false)
    const atCommit = setup("c".repeat(40))
    assert.equal(atCommit.run({ commit: "c".repeat(40) }).action, "deleted")
    assert.deepEqual(atCommit.github.writes().map((call) => call.args), [["api", "-X", "DELETE", "repos/owner/kit-test/git/refs/heads/release/v0.0.1"]])
  })

  test("with the run's commit unknown, deletes a release commit the kit made on the parent, and nothing else", () => {
    const kit = setup("c".repeat(40))
    kit.github.state.commits.set("c".repeat(40), botCommit({ sha: "c".repeat(40), parents: [kit.repo.head], message: "chore(release): v0.0.1 with the built dist/ and no lifecycle scripts" }))
    assert.equal(kit.run().action, "deleted")
    const other = setup("d".repeat(40))
    other.github.state.commits.set("d".repeat(40), botCommit({ sha: "d".repeat(40), parents: [other.repo.head], message: "a person's work" }))
    assert.equal(other.run().action, "left")
    assert.deepEqual(other.github.writes(), [])
  })

  test("never a branch at another sha, never master, and a missing branch is fine", () => {
    const elsewhere = setup("d".repeat(40))
    const result = elsewhere.run({ commit: "c".repeat(40) })
    assert.equal(result.action, "left")
    assert.match(result.message, /release\/v0\.0\.1 points at dddddddddddd, which is neither the parent nor this run's commit: left alone/)
    assert.deepEqual(elsewhere.github.writes(), [])
    const missing = setup()
    assert.equal(missing.run().action, "absent")
    assert.throws(() => missing.run({ tag: "master" }), /master is not a release tag/)
    assert.throws(() => missing.run({ tag: "v0.0.1/../../master" }), /is not a release tag/)
    assert.equal(missing.github.state.refs.has("heads/master"), true)
    assert.deepEqual(missing.github.writes(), [])
  })
})

describe("release-github.mjs sums", () => {
  test("accepts staged files that match SHA256SUMS by name, and refuses a changed, extra or missing one", () => {
    const dir = folder()
    writeTree(dir, { "kit-test-0.0.1.tgz": "tarball\n", "native/tool.gz": "gzip\n" })
    const line = (name, text) => `${createHash("sha256").update(text).digest("hex")}  ${name}\n`
    writeFileSync(join(dir, "SHA256SUMS"), line("kit-test-0.0.1.tgz", "tarball\n") + line("tool.gz", "gzip\n"))
    assert.deepEqual(sumsProblems(dir), [])
    writeFileSync(join(dir, "native", "tool.gz"), "other\n")
    assert.deepEqual(sumsProblems(dir), ["tool.gz does not match SHA256SUMS"])
    writeFileSync(join(dir, "native", "tool.gz"), "gzip\n")
    writeFileSync(join(dir, "extra.txt"), "x\n")
    assert.deepEqual(sumsProblems(dir), ["extra.txt is not in SHA256SUMS"])
    rmSync(join(dir, "extra.txt"))
    rmSync(join(dir, "kit-test-0.0.1.tgz"))
    assert.deepEqual(sumsProblems(dir), ["kit-test-0.0.1.tgz is in SHA256SUMS and not staged"])
  })
})

describe("the release workflow's shape", () => {
  const text = readFileSync(join(SCRIPTS, "..", ".github", "workflows", "release.yml"), "utf8")
  const jobs = {}
  {
    const lines = text.slice(text.indexOf("\njobs:\n") + 7).split("\n")
    let name
    for (const line of lines) {
      const match = /^ {2}([\w-]+):$/.exec(line)
      if (match) {
        name = match[1]
        jobs[name] = []
      } else if (name) jobs[name].push(line)
    }
    for (const key of Object.keys(jobs)) jobs[key] = jobs[key].join("\n")
  }
  const top = (key) => new RegExp(`^${key}:[\\s\\S]*?(?=^\\S)`, "m").exec(`${text}\nEND`)?.[0] ?? ""

  test("starts only by hand, with no permission at the top", () => {
    const on = top("on")
    assert.match(on, /^ {2}workflow_dispatch:$/m)
    assert.deepEqual([...on.matchAll(/^ {2}([\w_]+):/gm)].map((match) => match[1]), ["workflow_dispatch"])
    assert.match(text, /^permissions: \{\}$/m)
    assert.match(text, /^ {2}group: release$/m)
    assert.match(text, /^ {2}cancel-in-progress: false$/m)
  })

  test("has the eight jobs, and only publish uses the release environment", () => {
    assert.deepEqual(Object.keys(jobs), ["plan", "build", "commit", "verify", "hosts", "stage", "publish", "cleanup"])
    for (const [name, body] of Object.entries(jobs)) assert.equal(/environment:/.test(body), name === "publish", name)
    assert.match(jobs.publish, /^ {4}environment: release$/m)
  })

  test("contents: write only in commit, publish and cleanup, which run no npm and no build", () => {
    for (const [name, body] of Object.entries(jobs)) {
      const writes = /contents: write/.test(body)
      assert.equal(writes, ["commit", "publish", "cleanup"].includes(name), name)
      if (writes) {
        assert.doesNotMatch(body, /\bnpm\b|\bbun\b|setup-bun|release-pack|check-release-plugin-add/, name)
      }
      assert.match(body, /^ {4}permissions:$/m, `${name} names its permissions`)
    }
    assert.doesNotMatch(text, /write-all|read-all|id-token|secrets\./)
  })

  test("every checkout keeps no credentials, every action is pinned by sha, and nothing approves", () => {
    const checkouts = text.match(/uses: actions\/checkout@/g).length
    assert.equal(text.match(/persist-credentials: false/g).length, checkouts)
    for (const [, action, ref] of text.matchAll(/uses: ([\w./-]+)@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/, action)
    assert.doesNotMatch(text, /pending_deployments|--verify git(?!hub)|allowed-signers|git push|tags: \[/)
    for (const call of text.match(/check-release-shape\.mjs [^\n]*/g)) assert.match(call, /--verify github-api --identity github-actions/, call)
  })
})

describe("the pack stage's tarball", () => {
  test("is named only as a whole word", () => {
    for (const text of ["process.env.PACK_TARBALL", 'env["PACK_TARBALL"]', '"$PACK_TARBALL"', "${PACKED_DIR}/x.tgz", "const { PACKED_DIR } = process.env"]) {
      assert.equal(namesTarball(text), true, text)
    }
    for (const text of ["process.env.SLACK_PACK_TARBALL", "PACK_TARBALLS", "MY_PACKED_DIR", "PACKED_DIR_2", "pack_tarball"]) {
      assert.equal(namesTarball(text), false, text)
    }
  })

  test("is read by a pack test, not by a longer name or the kit's own files", () => {
    const root = folder()
    mkdirSync(join(root, "scripts"))
    mkdirSync(join(root, "test", "pack"), { recursive: true })
    writeFileSync(join(root, "scripts", "release-pack.mjs"), "env: { PACK_TARBALL: tarball, PACKED_DIR: dir }\n")
    writeFileSync(join(root, "scripts", "release-kit.test.mjs"), "namesTarball('process.env.PACK_TARBALL')\n")
    writeFileSync(join(root, "test", "pack", "pack.test.ts"), "const tarball = process.env.SLACK_PACK_TARBALL\n")
    assert.equal(readsTarball(root), false)
    writeFileSync(join(root, "test", "pack", "install.test.ts"), "const tarball = process.env.PACK_TARBALL\n")
    assert.equal(readsTarball(root), true)
  })
})

describe("publish-release.mjs", () => {
  test("never deletes or replaces an asset: a kit file with other contents stops the upload", () => {
    const dir = folder()
    writeFileSync(join(dir, "SHA256SUMS"), "sums\n")
    writeFileSync(join(dir, "kit-test-0.0.1.tgz"), "tarball\n")
    const calls = []
    const gh = (args) => {
      calls.push(args[1])
      if (args[1] === "view") return JSON.stringify({ isDraft: false, assets: [{ name: "SHA256SUMS" }, { name: "speech.bin" }] })
      if (args[1] === "download") writeFileSync(join(args[args.indexOf("--dir") + 1], "SHA256SUMS"), "other sums\n")
      return ""
    }
    assert.throws(() => publish({ tag: "v0.0.1", dir, notes: join(dir, "SHA256SUMS"), gh }), /SHA256SUMS is on the Release with other contents: nothing was uploaded/)
    assert.deepEqual(calls, ["view", "download"])
  })

  test("adds only the missing kit files, and leaves the assets it does not know alone", () => {
    const dir = folder()
    writeFileSync(join(dir, "SHA256SUMS"), "sums\n")
    writeFileSync(join(dir, "kit-test-0.0.1.tgz"), "tarball\n")
    const calls = []
    const gh = (args) => {
      calls.push(args)
      if (args[1] === "view") return JSON.stringify({ isDraft: false, assets: [{ name: "SHA256SUMS" }, { name: "speech.bin" }] })
      if (args[1] === "download") writeFileSync(join(args[args.indexOf("--dir") + 1], "SHA256SUMS"), "sums\n")
      return ""
    }
    const result = publish({ tag: "v0.0.1", dir, notes: join(dir, "SHA256SUMS"), gh })
    assert.deepEqual(result, { action: "uploaded", uploaded: ["kit-test-0.0.1.tgz"], unknown: ["speech.bin"] })
    assert.deepEqual(calls.map((args) => args[1]), ["view", "download", "upload"])
    assert.ok(calls.every((args) => !args.includes("delete") && !args.includes("--clobber")))
  })
})
