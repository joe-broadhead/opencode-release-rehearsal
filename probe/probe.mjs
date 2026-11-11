#!/usr/bin/env node
// TEST ONLY (the release rehearsal): measures what the release workflow depends on, with this run's GITHUB_TOKEN.
//   1. createCommitOnBranch with a payload the size of opencode-charts' dist/ at v0.0.0 (6 files, 7,121,758 bytes, the
//      largest 2,478,606), on a scratch branch: is it accepted, and is the commit verified, by github-actions[bot]?
//   2. An annotated tag v0.0.0-probe-<run> (under the `release tags` ruleset's refs/tags/v*) made through REST, as the
//      kit's publish job makes the release tag: is it created, and unsigned, by the bot?
//   3. A delete of that tag: the ruleset should refuse it.
// The kit's own rules judge each answer. The scratch branch is deleted at the end; the probe tag stays (the ruleset).
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { ACTIONS_BOT, commitIdentityProblems, tagObjectProblems } from "../scripts/release-rules.mjs"

const repo = process.env.GITHUB_REPOSITORY
const run = process.env.GITHUB_RUN_ID
const SIZES = { "dist/browser/echarts.js": 912506, "dist/browser/vega.js": 553429, "dist/index.js": 2270235, "dist/resvg.wasm": 2478606, "dist/tui.js": 4823, "dist/vega-worker.js": 902159 }
const MUTATION = "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }"

const gh = (args, input) => execFileSync("gh", args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] })
const api = (path) => JSON.parse(gh(["api", path]))
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const report = {}

const master = api(`repos/${repo}/git/ref/heads/master`).object.sha
const branch = `probe/payload-${run}`
gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${master}`])
try {
  const additions = Object.entries(SIZES).map(([path, bytes]) => ({ path: `probe/${path}`, contents: randomBytes(bytes).toString("base64") }))
  const body = JSON.stringify({ query: MUTATION, variables: { input: { branch: { repositoryNameWithOwner: repo, branchName: branch }, message: { headline: "probe: a charts-sized dist/ payload" }, fileChanges: { additions }, expectedHeadOid: master } } })
  report.payload = { files: additions.length, rawBytes: Object.values(SIZES).reduce((a, b) => a + b, 0), requestBytes: Buffer.byteLength(body) }
  const started = Date.now()
  const oid = JSON.parse(gh(["api", "graphql", "--input", "-"], body)).data.createCommitOnBranch.commit.oid
  report.payload.seconds = (Date.now() - started) / 1000
  let commit
  for (let i = 0; i < 6; i++) {
    commit = api(`repos/${repo}/commits/${oid}`)
    if (commit.commit.verification.verified || !/gpgverify/.test(commit.commit.verification.reason)) break
    sleep(2000)
  }
  report.commit = {
    oid,
    verification: { verified: commit.commit.verification.verified, reason: commit.commit.verification.reason },
    author: { name: commit.commit.author.name, email: commit.commit.author.email, login: commit.author?.login, type: commit.author?.type },
    committer: { name: commit.commit.committer.name, email: commit.commit.committer.email },
    parentIsMaster: commit.parents.length === 1 && commit.parents[0].sha === master,
    kitIdentityProblems: commitIdentityProblems(commit),
  }

  const tag = `v0.0.0-probe-${run}`
  const made = JSON.parse(gh(["api", "-X", "POST", `repos/${repo}/git/tags`, "--input", "-"], JSON.stringify({ tag, message: tag, object: oid, type: "commit", tagger: { name: ACTIONS_BOT.name, email: ACTIONS_BOT.email, date: new Date().toISOString() } })))
  gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "--input", "-"], JSON.stringify({ ref: `refs/tags/${tag}`, sha: made.sha }))
  const ref = api(`repos/${repo}/git/ref/tags/${tag}`)
  const tagObject = api(`repos/${repo}/git/tags/${ref.object.sha}`)
  report.tag = { name: tag, refType: ref.object.type, tagger: tagObject.tagger, verification: tagObject.verification, kitTagProblems: tagObjectProblems(tagObject, { tag, commit: oid }) }
  try {
    gh(["api", "-X", "DELETE", `repos/${repo}/git/refs/tags/${tag}`])
    report.tag.deletion = "ALLOWED: the release tags ruleset did not stop it"
  } catch (error) {
    report.tag.deletion = `refused: ${String(error.stderr || error.message).trim().split("\n").find((line) => /HTTP|rule/i.test(line)) ?? "error"}`
  }
} finally {
  gh(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`])
  report.branchDeleted = branch
}
console.log(JSON.stringify(report, null, 2))
