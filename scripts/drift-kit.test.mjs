// Tests for the kit's tool capture (capture-tools.mjs) and drift check (check-drift.mjs). release-kit.test.mjs imports
// this file, so `node --test scripts/release-kit.test.mjs`, the kit stage of `npm run check`, runs them. Loopback fakes
// only: nothing here reaches a provider or OpenCode.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  accountRedactor,
  assertNoSecrets,
  capture,
  diffTools,
  fromCatalog,
  identityValues,
  mcpClient,
  messagesOf,
  paramsOfSignature,
  provenanceWith,
  recordTool,
  Skip,
  writeFixture,
} from "./capture-tools.mjs"
import { accountValuesIn, ageInDays, canonical, checkDrift, driftReport, FIXTURE_SCHEMA, maskCaptureWording, objectKeys, permissionOf, referencesIn, reportLines, sha256, toolsDigest } from "./check-drift.mjs"

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), "drift-kit-test-"))
after(() => rmSync(scratch, { recursive: true, force: true }))
let made = 0
const folder = () => {
  const dir = join(scratch, String(made++))
  mkdirSync(dir, { recursive: true })
  return dir
}

const tool = (name, readOnly = true, extra = {}) => ({ name: `demo.${name}`, permission: `demo_${name}`, effect: "allow", readOnly, ...extra })
const served = (name, readOnlyHint, { params = ["query"], destructiveHint = null } = {}) => ({
  name,
  readOnlyHint,
  destructiveHint,
  inputSchema: { type: "object", properties: Object.fromEntries(params.map((key) => [key, { type: "string" }])) },
})
/** A capture as capture-tools.mjs writes it, and the provenance.json it writes with it. */
const fixture = (tools, extra = {}) => {
  const base = { schema: FIXTURE_SCHEMA, server: "demo", namespace: "demo", evidence: "live-observed", listedAt: "2026-11-10", count: tools.length, digest: toolsDigest(tools), tools }
  return { ...base, ...extra }
}
const provenanceOf = (capture, extra = {}) => ({
  captures: [{ fixture: "live-tools.json", evidence: capture.evidence, listedAt: capture.listedAt, digest: { algorithm: "sha256", value: capture.digest } }],
  live: capture.evidence === "live-observed" ? { fixture: "live-tools.json", listedAt: capture.listedAt } : null,
  ...extra,
})
const run = (input) => checkDrift({ provenance: input.fixture ? provenanceOf(input.fixture) : undefined, ...input })
const failing = (findings) => findings.filter((finding) => finding.level === "fail").map((finding) => `${finding.kind}:${finding.tool ?? finding.file ?? ""}${finding.param ? `.${finding.param}` : ""}`)
const at = (findings, level) => findings.filter((finding) => finding.level === level).map((finding) => finding.kind)

describe("check-drift: the declaration against the capture", () => {
  test("is clean when every served tool is declared with the server's readOnly (absent readOnly is false)", () => {
    const findings = run({ pkg: { jelly: { tools: [tool("search"), { ...tool("save"), readOnly: undefined }] } }, fixture: fixture([served("search", true), served("save", false)]) })
    assert.deepEqual(failing(findings), [])
    assert.deepEqual(at(findings, "warn"), [])
  })

  test("fails a served tool the declaration lacks, and says a write is not fenced from read-only helpers", () => {
    const findings = run({ pkg: { jelly: { tools: [tool("search")] } }, fixture: fixture([served("search", true), served("submit_batch_call", false, { destructiveHint: true })]) })
    assert.deepEqual(failing(findings), ["served-not-declared:submit_batch_call"])
    assert.match(findings.find((finding) => finding.kind === "served-not-declared").detail, /a destructive write; not fenced from read-only helpers/)
  })

  test("fails a declared tool the server lacks, unless it is the plugin's own, or gated with a reason and a note", () => {
    const pkg = { jelly: { tools: [tool("search"), tool("events_list"), tool("ai_search", true, { note: "Needs a Business plan." }), tool("gone"), tool("unnoted")] } }
    const registry = { own: ["events_list"], tools: { ai_search: { availability: "plan", reason: "Notion AI plans only" }, unnoted: { availability: "scope", reason: "not in the pinned scope" } } }
    const findings = run({ pkg, fixture: fixture([served("search", true)]), registry })
    assert.deepEqual(failing(findings), ["declared-not-served:gone", "declared-not-served:unnoted"])
    assert.deepEqual(at(findings, "note"), ["declared-not-served"])
  })

  test("fails a readOnly disagreement unless the registry overrides it with a reason; a missing hint is a note", () => {
    const pkg = { jelly: { tools: [tool("a", true), tool("b", false), tool("c", false), tool("d", true)] } }
    const registry = { tools: { b: { readOnlyOverride: { value: false, reason: "returns a signed URL, a credential for the file" } } } }
    const findings = run({ pkg, fixture: fixture([served("a", false), served("b", true), served("c", false), served("d", null)]), registry })
    assert.deepEqual(failing(findings), ["readonly-mismatch:a"])
    assert.deepEqual(at(findings, "note"), ["readonly-unverified"])
  })

  test("fails a registry entry that no longer applies: a served tool marked gated, an override equal to the hint, an own tool served", () => {
    const pkg = { jelly: { tools: [tool("search", true, { note: "x" }), tool("save", false), tool("events_list")] } }
    const registry = { own: ["events_list"], tools: { search: { availability: "plan", reason: "once plan-only" }, save: { readOnlyOverride: { value: false, reason: "stricter" } } } }
    const findings = run({ pkg, fixture: fixture([served("search", true), served("save", false), served("events_list", true)]), registry })
    assert.deepEqual(failing(findings).sort(), ["own-served:events_list", "registry-stale:save", "registry-stale:search"])
  })

  test("fails an unknown registry key, an availability outside plan, scope and account, and an entry with no reason", () => {
    const pkg = { jelly: { tools: [tool("search")] } }
    const registry = { owned: [], tools: { a: { availability: "region", reason: "x" }, b: { availability: "plan" }, c: { readOnlyOverride: { value: true } }, d: { note: "x" } } }
    const details = run({ pkg, fixture: fixture([served("search", true)]), registry }).filter((finding) => finding.kind === "registry").map((finding) => `${finding.tool ?? ""}:${finding.detail}`)
    assert.deepEqual(details, [":unknown key owned in test/fixtures/tool-registry.json", "a:availability must be plan, scope or account, with a reason", "b:availability must be plan, scope or account, with a reason", "c:readOnlyOverride needs a boolean value and a reason", "d:unknown key note"])
  })

  test("fails a permission outside the capture's namespace", () => {
    const findings = run({ pkg: { jelly: { tools: [tool("search"), { name: "other.x", permission: "other_x", effect: "allow", readOnly: true }] } }, fixture: fixture([served("search", true)]) })
    assert.ok(failing(findings).includes("namespace:other.x"))
  })

  test("fails an effect other than allow unless effect-exceptions.json gives the owner's reason", () => {
    const pkg = { jelly: { tools: [tool("a", false, { effect: "ask" }), tool("b", false, { effect: "deny" })] } }
    const findings = run({ pkg, fixture: fixture([served("a", false), served("b", false)]), effectExceptions: { demo_b: "owner-approved 2026-11-14" } })
    assert.deepEqual(failing(findings), ["effect-not-allow:demo.a"])
  })

  test("checks the schema: unknown tool keys, duplicates, and the 256-tool cap", () => {
    const many = Array.from({ length: 257 }, (_, index) => tool(`t${index}`))
    const pkg = { jelly: { tools: [...many, { ...tool("t0"), extra: 1 }] } }
    const schema = run({ pkg, fixture: fixture(many.map((item) => served(item.permission.slice(5), true))) })
      .filter((finding) => finding.kind === "schema")
      .map((finding) => finding.detail)
    assert.ok(schema.some((detail) => /at most 256/.test(detail)))
    assert.ok(schema.some((detail) => /unknown key extra/.test(detail)))
    assert.ok(schema.some((detail) => /declared twice/.test(detail)))
  })
})

describe("check-drift: the capture and its provenance", () => {
  const pkg = { jelly: { tools: [tool("search")] } }
  const capture = fixture([served("search", true)])

  test("fails a capture edited by hand, a wrong count, a server and namespace that disagree, and a tool listed twice", () => {
    assert.deepEqual(failing(run({ pkg, fixture: { ...capture, tools: [served("search", false)] }, provenance: provenanceOf(capture) })), ["capture:", "readonly-mismatch:search"])
    assert.deepEqual(failing(run({ pkg, fixture: { ...capture, count: 2 } })), ["capture:"])
    assert.deepEqual(failing(run({ pkg, fixture: { ...capture, server: "other" } })), ["capture:"])
    const twice = fixture([served("search", true), served("search", true)])
    assert.ok(failing(run({ pkg, fixture: twice })).includes("capture:search"))
  })

  test("fails without provenance.json, or when it records another capture", () => {
    assert.deepEqual(failing(checkDrift({ pkg, fixture: capture })), ["capture:"])
    assert.deepEqual(failing(checkDrift({ pkg, fixture: capture, provenance: provenanceOf({ ...capture, listedAt: "2026-11-01" }) })), ["capture:", "capture:"])
  })

  test("warns, and does not fail, until there is a capture: none, an older format, names only", () => {
    const none = checkDrift({ pkg, release: true, today: "2026-11-24" })
    assert.deepEqual([at(none, "fail"), at(none, "warn")], [[], ["no-capture"]])
    const older = checkDrift({ pkg, fixture: { evidence: "live-observed", retrieved: "2026-11-12", tools: [{ name: "search" }] }, release: true, today: "2026-11-24" })
    assert.deepEqual([at(older, "fail"), at(older, "warn")], [[], ["capture-format"]])
    const names = fixture([{ name: "search", readOnlyHint: null, inputSchema: null, inputParams: ["query"] }], { evidence: "catalog" })
    const catalog = run({ pkg, fixture: names, release: true, today: "2026-11-24" })
    assert.deepEqual([at(catalog, "fail"), at(catalog, "warn")], [[], ["capture-names-only", "capture-stale"]])
  })

  test("a plugin that serves only its own tools says so, and then has no capture; no declaration has nothing to check", () => {
    assert.deepEqual(at(checkDrift({ pkg, registry: { upstream: "none" } }), "note"), ["no-upstream"])
    assert.deepEqual(failing(run({ pkg, registry: { upstream: "none" }, fixture: capture })), ["registry:"])
    assert.deepEqual(failing(checkDrift({ pkg, registry: { upstream: "some" } })), ["registry:"])
    assert.deepEqual(at(checkDrift({ pkg: { name: "x" } }), "note"), ["no-declaration"])
    assert.deepEqual(failing(run({ pkg: { name: "x" }, fixture: capture })), ["schema:"])
  })
})

describe("check-drift: skills and docs", () => {
  const pkg = { jelly: { tools: [tool("search_meetings"), tool("list_meetings"), tool("events_list"), tool("delete_issue", false, { note: "Needs the delete scope." })] } }
  const capture = fixture([served("search_meetings", true, { params: ["keywords", "from_date", "to_date"] })])
  const registry = { own: ["events_list"], docIgnore: ["demo_events"], tools: { delete_issue: { availability: "scope", reason: "the pinned sign-in asks for no delete scope" } } }

  test("finds a declared tool that is neither served nor gated, and a parameter the served schema lacks, in every form", () => {
    const docs = [
      {
        file: "skills/demo/SKILL.md",
        text: [
          "Call `list_meetings` for a window:",
          "",
          "```js",
          'list_meetings({ time_range: "custom", from_date, to_date })',
          'await tools.demo.search_meetings({ keywords: "x", time_range: "week" })',
          'await tools["demo"]["search_meetings"]({ from_date: "a", to_date: "b" })',
          "```",
          "Also `demo_list_meetings`, `demo_events` (an event type), `demo_events_list` and `demo_search_meetings`.",
        ].join("\n"),
      },
    ]
    const findings = run({ pkg, fixture: capture, registry, docs })
    assert.deepEqual(failing(findings).filter((item) => item.startsWith("doc")).sort(), ["doc-unknown-param:search_meetings.time_range", "doc-unknown-tool:list_meetings", "doc-unknown-tool:list_meetings", "doc-unknown-tool:list_meetings"])
    assert.deepEqual(findings.filter((finding) => finding.kind === "doc-unknown-tool").map((finding) => finding.line).sort(), [1, 4, 8])
  })

  test("accepts a declared tool the registry gates (Jira's delete scope, Notion's plan tools) wherever a skill or doc names it", () => {
    const docs = [{ file: "skills/demo-write/SKILL.md", text: "Deleting needs the scope: `delete_issue`, `demo_delete_issue`, and\n\n```js\nawait tools.demo.delete_issue({ issueIdOrKey: \"A-1\" })\n```\n" }]
    assert.deepEqual(failing(run({ pkg, fixture: capture, registry, docs })).filter((item) => item.startsWith("doc")), [])
    const ungated = { ...registry, tools: {} }
    assert.deepEqual(failing(run({ pkg, fixture: capture, registry: ungated, docs })).filter((item) => item.startsWith("doc")), ["doc-unknown-tool:delete_issue", "doc-unknown-tool:delete_issue"], "once per line")
  })

  test("leaves prose and other functions alone", () => {
    const docs = [{ file: "README.md", text: "Run `npm test`, then `fetch({ url })` and `demo_unrelated_option`. Nothing about meetings." }]
    assert.deepEqual(failing(run({ pkg, fixture: capture, registry, docs })).filter((item) => item.startsWith("doc")), [])
  })

  test("checks docs/jelly.md's count sentence, with a capture or without one", () => {
    const counted = (jellyDoc, fixtureOrNot = capture) => failing(run({ pkg, fixture: fixtureOrNot, registry, jellyDoc })).filter((item) => item.startsWith("jelly"))
    assert.deepEqual(counted("4 tools are declared (3 read-only), every tool."), [])
    assert.deepEqual(counted("4 tools are declared, every reviewed tool."), [])
    assert.deepEqual(counted("5 tools are declared (3 read-only)."), ["jelly-count:docs/jelly.md"])
    assert.deepEqual(counted("4 tools are declared (4 read-only)."), ["jelly-count:docs/jelly.md"])
    assert.deepEqual(counted("5 tools are declared (3 read-only).", undefined), ["jelly-count:docs/jelly.md"])
  })

  test("parsers: objectKeys reads the top level of an object literal; referencesIn finds Code Mode calls with their keys", () => {
    const text = 'x({ a: 1, "b-c": { d: 2 }, e, ...rest, f: [1, { g: 3 }], h: "i, j: k" })'
    assert.deepEqual(objectKeys(text, text.indexOf("{")), ["a", "b-c", "e", "f", "h"])
    const refs = referencesIn('await tools.demo.search({ query: "x" })\nawait tools.demo["other-tool"]()', "demo")
    assert.deepEqual(refs.map((ref) => [ref.tool, ref.keys]), [["search", ["query"]], ["other-tool", undefined]])
  })
})

describe("check-drift: the capture's own words and the forbidden-word check", () => {
  const pkg = { jelly: { tools: [tool("search")] } }
  const capture = fixture([{ ...served("search", true), description: { text: "Search issues the Blue Widget team owns." } }])
  const wording = [{ rule: "house-words", phrase: "blue widget", reason: "the provider's own tool description, recorded verbatim" }]

  test("an exemption names a rule, a phrase the capture holds, and a reason", () => {
    assert.deepEqual(failing(run({ pkg, fixture: capture, registry: { captureWording: wording } })), [])
    assert.deepEqual(failing(run({ pkg, fixture: capture, registry: { captureWording: [{ ...wording[0], phrase: "red widget" }] } })), ["registry:"])
    assert.deepEqual(failing(run({ pkg, fixture: capture, registry: { captureWording: [{ rule: "house-words", phrase: "blue widget" }] } })), ["registry:"])
  })

  test("maskCaptureWording blanks only that phrase, only for that rule, only in the capture", () => {
    const root = folder()
    mkdirSync(join(root, "test", "fixtures"), { recursive: true })
    writeFileSync(join(root, "test", "fixtures", "tool-registry.json"), JSON.stringify({ captureWording: wording }))
    const mask = maskCaptureWording(root)
    const line = '"text": "Search issues the Blue Widget team owns; a blue gadget too."'
    const masked = mask("test/fixtures/live-tools.json", "house-words", line)
    assert.doesNotMatch(masked, /blue widget/i)
    assert.match(masked, /a blue gadget too/, "the rest of the line is still checked")
    assert.equal(masked.length, line.length)
    assert.equal(mask("test/fixtures/live-tools.json", "other-rule", line), line)
    assert.equal(mask("docs/notes.md", "house-words", line), line)
    assert.equal(maskCaptureWording(folder())("test/fixtures/live-tools.json", "house-words", line), line, "no registry, no exemption")
  })
})

describe("check-drift: the release gate", () => {
  const pkg = { jelly: { tools: [tool("search")] } }
  const fresh = fixture([served("search", true)], { listedAt: "2026-11-10" })
  const stale = fixture([served("search", true)], { listedAt: "2026-11-01" })
  const waiver = { listedAt: "2026-11-01", reason: "the provider's sign-in was down", approvedBy: "the owner, 2026-11-24" }

  test("passes a live capture at most 14 days old, and is silent about age outside --release", () => {
    assert.equal(ageInDays("2026-11-10", "2026-11-24"), 14)
    assert.deepEqual(failing(run({ pkg, fixture: fresh, release: true, today: "2026-11-24" })), [])
    assert.deepEqual(failing(run({ pkg, fixture: stale, today: "2026-11-24" })), [])
  })

  test("fails a capture more than 14 days old, or dated in the future", () => {
    assert.deepEqual(failing(run({ pkg, fixture: stale, release: true, today: "2026-11-24" })), ["capture-stale:"])
    assert.deepEqual(failing(run({ pkg, fixture: fresh, release: true, today: "2026-11-09" })), ["capture-stale:"])
    assert.deepEqual(failing(run({ pkg, fixture: fresh, release: true, today: "2026-11-24", maxAgeDays: 13 })), ["capture-stale:"])
  })

  test("a written waiver in provenance.json for exactly this capture lets it through, as a warning", () => {
    const findings = checkDrift({ pkg, fixture: stale, provenance: provenanceOf(stale, { waiver }), release: true, today: "2026-11-24" })
    assert.deepEqual(failing(findings), [])
    assert.match(findings.find((finding) => finding.kind === "capture-stale").detail, /23 days old \(gate: 14\); waived by the owner, 2026-11-24: the provider's sign-in was down/)
    for (const partial of [{ ...waiver, approvedBy: "" }, { ...waiver, reason: undefined }, { ...waiver, listedAt: "2026-10-01" }]) {
      assert.ok(failing(checkDrift({ pkg, fixture: stale, provenance: provenanceOf(stale, { waiver: partial }), release: true, today: "2026-11-24" })).includes("capture-stale:"), JSON.stringify(partial))
    }
  })

  test("a waiver left for another capture fails even outside a release, so it is removed", () => {
    assert.deepEqual(failing(checkDrift({ pkg, fixture: fresh, provenance: provenanceOf(fresh, { waiver }) })), ["capture:"])
  })

  test("the report shows FAIL and WARN lines, and in GitHub Actions makes each an annotation", () => {
    const report = { findings: run({ pkg, fixture: stale, release: true, today: "2026-11-24" }).concat(checkDrift({ pkg })), namespace: "demo", fixture: stale }
    const lines = reportLines(report, { actions: true })
    assert.ok(lines.some((line) => /^FAIL capture-stale \(the capture is 23 days old/.test(line)))
    assert.ok(lines.some((line) => /^WARN no-capture /.test(line)))
    assert.ok(lines.some((line) => /^::error title=tool drift \(capture-stale\)::FAIL capture-stale/.test(line)))
    assert.ok(lines.some((line) => /^::warning title=tool drift \(no-capture\)::WARN no-capture/.test(line)))
    assert.equal(reportLines(report, { actions: false }).filter((line) => line.startsWith("::")).length, 0)
  })
})

describe("check-drift: the command", () => {
  const repo = (files) => {
    const root = folder()
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content))
    }
    return root
  }
  const node = (args) => spawnSync(process.execPath, [join(SCRIPTS, "check-drift.mjs"), ...args], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } })

  test("exits 0 clean or with only warnings, 1 on a FAIL, and 2 on a missing or malformed file", () => {
    const capture = fixture([served("search", true)])
    const clean = repo({ "package.json": { jelly: { tools: [tool("search")] } }, "test/fixtures/live-tools.json": capture, "test/fixtures/provenance.json": provenanceOf(capture) })
    const drifted = fixture([served("search", true), served("new_write", false)])
    const drift = repo({ "package.json": { jelly: { tools: [tool("search")] } }, "test/fixtures/live-tools.json": drifted, "test/fixtures/provenance.json": provenanceOf(drifted) })
    const uncaptured = repo({ "package.json": { jelly: { tools: [tool("search")] } } })
    assert.equal(node(["--root", clean]).status, 0)
    const result = node(["--root", drift])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /FAIL served-not-declared demo\.new_write \(a write; not fenced from read-only helpers\)/)
    const warned = node(["--root", uncaptured, "--release"])
    assert.equal(warned.status, 0)
    assert.match(warned.stdout, /WARN no-capture/)
    assert.equal(node(["--root", repo({ "package.json": "{" })]).status, 2)
    assert.equal(node(["--root", repo({})]).status, 2)
    assert.equal(node(["--root", clean, "--release", "--today", "2026-12-31"]).status, 1)
    assert.equal(node(["--root", clean, "--bogus"]).status, 2)
  })

  test("reads no network, no credential and no child process: only node:crypto, fs, path and url", () => {
    const source = readFileSync(join(SCRIPTS, "check-drift.mjs"), "utf8")
    const imports = [...source.matchAll(/^import .* from "([^"]+)"$/gm)].map((match) => match[1]).sort()
    assert.deepEqual(imports, ["node:crypto", "node:fs", "node:path", "node:url"])
    assert.doesNotMatch(source, /\bfetch\s*\(|process\.env\.(?!GITHUB_ACTIONS\b)|\bimport\s*\(|\brequire\s*\(/)
  })

  test("the capture runs by hand only: no workflow, npm check stage or other kit script runs capture-tools.mjs", () => {
    const root = join(SCRIPTS, "..")
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) if (name !== "capture") assert.doesNotMatch(command, /capture-tools/, `npm run ${name}`)
    if (pkg.scripts?.capture !== undefined) assert.equal(pkg.scripts.capture, "node scripts/capture-tools.mjs")
    const workflows = join(root, ".github", "workflows")
    for (const name of existsSync(workflows) ? readdirSync(workflows) : []) assert.doesNotMatch(readFileSync(join(workflows, name), "utf8"), /capture-tools|npm run capture/, name)
    const code = (name) => readFileSync(join(SCRIPTS, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    for (const name of ["check-drift.mjs", "release-commit.mjs", "release-github.mjs", "release-rules.mjs", "check-release-shape.mjs"]) assert.doesNotMatch(code(name), /capture-tools/, name)
  })
})

// ---- capture-tools.mjs

const TOKEN = "access-token-value-0123456789"
const TOOLS = [
  { name: "search", description: "Search things.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "delete_thing", title: "Delete", description: "Deletes a thing.", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "plain", description: "No annotations.", inputSchema: { type: "object" } },
]

/** A fake MCP server (two tools/list pages, SSE answers) and a fake OpenCode server, both on loopback. */
function servers({ expires = Date.now() + 3_600_000, status = "connected", requireToken = true, tools = TOOLS, metadata = {}, instructions = "The signed-in user is Person Name." } = {}) {
  const seen = { methods: [], authorization: [], deleted: 0 }
  const mcp = createServer((req, res) => {
    if (req.method === "DELETE") {
      seen.deleted++
      return res.end()
    }
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      seen.authorization.push(req.headers.authorization ?? null)
      if (requireToken && req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401
        return res.end()
      }
      const message = JSON.parse(body)
      seen.methods.push(message.method)
      res.setHeader("mcp-session-id", "session-1")
      if (message.id === undefined) {
        res.statusCode = 202
        return res.end()
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-06-18", serverInfo: { name: "Fake", version: "1.0" }, instructions }
          : message.params?.cursor
            ? { tools: tools.slice(2) }
            : { tools: tools.slice(0, 2), nextCursor: "page-2" }
      res.setHeader("content-type", "text/event-stream")
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`)
    })
  })
  const opencode = createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    res.setHeader("content-type", "application/json")
    if (url.pathname === "/api/info") return res.end(JSON.stringify({ version: "9.9.9" }))
    if (url.pathname === "/api/mcp") return res.end(JSON.stringify({ data: [{ name: "fake", integrationID: "mcp_1", status: { status } }] }))
    if (url.pathname === "/api/credential") {
      const port = mcp.address().port
      return res.end(JSON.stringify([{ integrationID: "mcp_1", active: true, value: { type: "oauth", access: TOKEN, refresh: "refresh-token-value-0123456789", expires, metadata: { serverUrl: `http://127.0.0.1:${port}/mcp`, ...metadata } } }]))
    }
    res.statusCode = 404
    res.end()
  })
  return {
    seen,
    async start() {
      await new Promise((done) => mcp.listen(0, "127.0.0.1", done))
      await new Promise((done) => opencode.listen(0, "127.0.0.1", done))
      return `http://127.0.0.1:${opencode.address().port}`
    },
    async stop() {
      await new Promise((done) => mcp.close(done))
      await new Promise((done) => opencode.close(done))
    },
  }
}

describe("capture-tools: what it records", () => {
  test("keeps the four hints, null when absent, and the description in full with its digest", () => {
    const [read, write, plain] = TOOLS.map(recordTool)
    assert.equal(read.readOnlyHint, true)
    assert.equal(read.destructiveHint, null)
    assert.equal(write.destructiveHint, true)
    assert.equal(write.title, "Delete")
    assert.equal(plain.readOnlyHint, null)
    assert.equal(plain.annotations, null)
    assert.equal(read.description.text, "Search things.")
    assert.equal(read.description.length, 14)
    assert.match(read.description.sha256, /^[0-9a-f]{64}$/)
  })

  test("canonical JSON ignores key order, so the digest does too; tools are named as OpenCode names them", () => {
    assert.equal(canonical({ b: 1, a: [{ d: 1, c: 2 }] }), canonical({ a: [{ c: 2, d: 1 }], b: 1 }))
    assert.equal(toolsDigest([{ name: "b" }, { name: "a" }]), toolsDigest([{ name: "a" }, { name: "b" }]))
    assert.equal(permissionOf("notion", "notion-search"), "notion_notion-search")
    assert.equal(permissionOf("plaud.work", "get.file"), "plaud_work_get_file")
  })

  test("reads JSON and SSE bodies, and a Code Mode signature's top-level parameter names", () => {
    assert.deepEqual(messagesOf('{"id":1}', "application/json"), [{ id: 1 }])
    assert.deepEqual(messagesOf('event: message\ndata: {"id":2}\n\nevent: x\ndata: [{"id":3}]\n\n', "text/event-stream"), [{ id: 2 }, { id: 3 }])
    const signature = 'tools.ns.tool({\n  /** The root URL, e.g. {a: 1} */\n  url: string,\n  /**\n   * Depth.\n   */\n  max_depth?: number,\n  opts?: { nested: string, other?: Array<string> },\n  "quoted-key"?: "a" | "b",\n}): Promise<{}>'
    assert.deepEqual(paramsOfSignature(signature), ["url", "max_depth", "opts", "quoted-key"])
    assert.deepEqual(paramsOfSignature("tools.ns.tool(): Promise<{}>"), [])
  })

  test("refuses output that holds the token or anything shaped like a credential", () => {
    assert.throws(() => assertNoSecrets({ a: `x ${TOKEN}` }, [TOKEN]), /credential in use/)
    assert.throws(() => assertNoSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), /shaped like a credential/)
    assert.throws(() => assertNoSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"), /shaped like a credential/)
    assert.doesNotThrow(() => assertNoSecrets({ description: "Use a Bearer token from settings." }, [TOKEN]))
  })

  test("diffs two tool lists", () => {
    const a = TOOLS.map(recordTool)
    const changes = diffTools(a, [{ ...a[0], readOnlyHint: false }, a[2], recordTool({ name: "new_tool", description: "" })])
    assert.deepEqual([changes.added, changes.removed, changes.readOnlyHint], [["new_tool"], ["delete_thing"], ["search"]])
  })

  test("the MCP client refuses tools/call and every other method before anything is sent", async () => {
    let sent = 0
    const client = mcpClient({
      endpoint: "http://127.0.0.1:1/mcp",
      fetchImpl: async () => {
        sent++
        return new Response("{}")
      },
    })
    for (const method of ["tools/call", "resources/read", "prompts/get", "sampling/createMessage"]) await assert.rejects(client.send(method, {}), /refused/)
    assert.equal(sent, 0)
  })
})

describe("capture-tools: a capture through OpenCode", () => {
  let fake
  let base
  before(async () => {
    fake = servers()
    base = await fake.start()
  })
  after(() => fake.stop())

  test("lists every page with the active credential, calls no tool, records no account data, and passes the drift check's capture rules", async () => {
    const captured = await capture({ server: "fake", base, password: "pw", now: () => Date.parse("2026-11-14T10:00:00Z") })
    assert.deepEqual(fake.seen.methods, ["initialize", "notifications/initialized", "tools/list", "tools/list"])
    assert.ok(fake.seen.deleted >= 1, "the MCP session is closed")
    assert.deepEqual([captured.schema, captured.evidence, captured.listedAt, captured.host.opencode, captured.auth, captured.pages], [FIXTURE_SCHEMA, "live-observed", "2026-11-14", "9.9.9", "signed-in", 2])
    assert.deepEqual(captured.tools.map((item) => item.name), ["delete_thing", "plain", "search"])
    const text = JSON.stringify(captured)
    assert.ok(!text.includes(TOKEN) && !text.includes("refresh-token-value"))
    assert.ok(!text.includes("Person Name"), "server instructions are not recorded")
    const dir = folder()
    writeFixture(dir, captured)
    const declared = [
      { name: "fake.delete_thing", permission: "fake_delete_thing", effect: "allow", readOnly: false },
      { name: "fake.plain", permission: "fake_plain", effect: "allow", readOnly: false },
      { name: "fake.search", permission: "fake_search", effect: "allow", readOnly: true },
    ]
    const findings = checkDrift({ pkg: { jelly: { tools: declared } }, fixture: JSON.parse(readFileSync(join(dir, "live-tools.json"), "utf8")), provenance: JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")), release: true, today: "2026-11-20" })
    assert.deepEqual(failing(findings), [])
  })

  test("never refreshes: an expired token is not sent, and a server that needs one is skipped", async () => {
    const expired = servers({ expires: Date.parse("2026-11-14T09:00:00Z") })
    const url = await expired.start()
    try {
      await assert.rejects(capture({ server: "fake", base: url, now: () => Date.parse("2026-11-14T10:00:00Z") }), (error) => error instanceof Skip && /expired/.test(error.message))
      assert.deepEqual(expired.seen.authorization, [null], "only one anonymous initialize was tried")
    } finally {
      await expired.stop()
    }
  })

  test("lists anonymously when the server allows it, and skips a server that is not connected", async () => {
    const open = servers({ expires: 1, requireToken: false })
    const off = servers({ status: "needs_auth" })
    const openUrl = await open.start()
    const offUrl = await off.start()
    try {
      assert.equal((await capture({ server: "fake", base: openUrl, now: () => Date.parse("2026-11-14T10:00:00Z") })).auth, "anonymous")
      assert.ok(open.seen.authorization.every((value) => value === null))
      await assert.rejects(capture({ server: "fake", base: offUrl }), (error) => error instanceof Skip && /needs_auth/.test(error.message))
    } finally {
      await open.stop()
      await off.stop()
    }
  })

  test("refuses an --endpoint that is not the credential's own server", async () => {
    await assert.rejects(capture({ server: "fake", base, endpoint: "https://elsewhere.example/mcp" }), /not the URL the fake credential was issued for/)
  })

  test("npm run capture with no --server captures the server the committed capture names, and drops an old waiver", async () => {
    const out = folder()
    writeFileSync(join(out, "live-tools.json"), JSON.stringify({ schema: FIXTURE_SCHEMA, server: "fake", tools: [] }))
    writeFileSync(join(out, "provenance.json"), JSON.stringify({ captures: [], live: null, waiver: { listedAt: "2026-10-01", reason: "x", approvedBy: "y" } }))
    const child = spawn(process.execPath, [join(SCRIPTS, "capture-tools.mjs"), "--out", out], { env: { ...process.env, OPENCODE_SERVER: base, OPENCODE_SERVER_PASSWORD: "pw" } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    const status = await new Promise((done) => child.on("close", done))
    assert.equal(status, 0, stderr)
    assert.match(stdout, /Wrote .*live-tools\.json: 3 tools \(2 with readOnlyHint\)/)
    const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"))
    assert.equal(provenance.waiver, undefined)
    assert.equal(provenance.live.fixture, "live-tools.json")
  })
})

// Slack writes the signed-in member's id into its descriptions: "Your user_id: <member id>". A made-up member id here.
const MEMBER = "U0B7XQ4R2ZK"
const SLACK_TOOLS = [
  { name: "slack_list_channel_members", description: `List members. Your user_id: ${MEMBER}. Does not support DMs.`, inputSchema: { type: "object", properties: { channel_id: { type: "string", description: `e.g. C0123456789; never ${MEMBER}` } } }, annotations: { readOnlyHint: true } },
  { name: "slack_search_public", description: `Search. Current logged in user's user_id is ${MEMBER}. Ask Pat Person (pat@corp.example.net is fine, pat@corp.io is not) in T0QZ7X1Y2B3.`, inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "slack_send_message", description: "Send a message. user_id is the Slack user ID, e.g. U0123456ABC or U071CCRCVFH; alice@acme.com; 00000000-0000-0000-0000-000000000000.", inputSchema: { type: "object", properties: { user_id: { type: "string" } } }, annotations: { readOnlyHint: false } },
]

describe("capture-tools: the signed-in account's own values", () => {
  test("a Slack-shaped capture is written with placeholders, digested after redaction, with documented examples kept", async () => {
    const slack = servers({ tools: SLACK_TOOLS, metadata: { email: "pat@corp.io", userName: "Pat Person", teamId: "T0QZ7X1Y2B3", clientId: "client-0123456789" }, instructions: "You are signed in as pat@corp.io." })
    const url = await slack.start()
    try {
      const captured = await capture({ server: "fake", base: url, now: () => Date.parse("2026-11-14T10:00:00Z") })
      const text = JSON.stringify(captured)
      for (const value of [MEMBER, "pat@corp.io", "Pat Person", "T0QZ7X1Y2B3"]) assert.ok(!text.includes(value), `${value} is not in the capture`)
      for (const kept of ["U0123456ABC", "U071CCRCVFH", "alice@acme.com", "00000000-0000-0000-0000-000000000000", "C0123456789", "user_id is the Slack user ID", "pat@corp.example.net", "client-0123456789"].slice(0, 7)) assert.ok(text.includes(kept), `${kept} is kept`)
      const byName = Object.fromEntries(captured.tools.map((item) => [item.name, item]))
      assert.equal(byName.slack_list_channel_members.description.text, "List members. Your user_id: U00CURRENTUSER. Does not support DMs.")
      assert.equal(byName.slack_list_channel_members.inputSchema.properties.channel_id.description, "e.g. C0123456789; never U00CURRENTUSER")
      assert.equal(byName.slack_search_public.description.text, "Search. Current logged in user's user_id is U00CURRENTUSER. Ask Current User (pat@corp.example.net is fine, current.user@example.invalid is not) in T00CURRENTTEAM.")
      assert.equal(captured.redactions, 6)
      assert.equal(byName.slack_list_channel_members.description.sha256, sha256(byName.slack_list_channel_members.description.text), "the description's digest is of the redacted text")
      assert.equal(captured.digest, toolsDigest(captured.tools), "the capture's digest is of the redacted tools")
      const dir = folder()
      writeFixture(dir, captured)
      assert.equal(JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")).captures[0].redactions, 6)
      const declared = SLACK_TOOLS.map((item) => ({ name: `fake.${item.name}`, permission: `fake_${item.name}`, effect: "allow", readOnly: item.annotations.readOnlyHint }))
      const fixtureText = readFileSync(join(dir, "live-tools.json"), "utf8")
      assert.deepEqual(failing(checkDrift({ pkg: { jelly: { tools: declared } }, fixture: JSON.parse(fixtureText), fixtureText, provenance: JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")) })), [])
    } finally {
      await slack.stop()
    }
  })

  test("learns only from what it already has: identity phrases and the credential's own id, email, name and team fields", () => {
    assert.deepEqual(identityValues({ serverUrl: "https://mcp.example/mcp", clientId: "client-0123456789", scope: "read write", email: "pat@corp.io", userName: "Pat Person", team_id: "T0QZ7X1Y2B3", nested: { accountId: "acct-778899" }, tokenType: "Bearer" }), [
      { value: "pat@corp.io", kind: "email" },
      { value: "Pat Person", kind: "name" },
      { value: "T0QZ7X1Y2B3", kind: "id" },
      { value: "acct-778899", kind: "id" },
    ])
    const redactor = accountRedactor()
    for (const text of ["user_id is the Slack user ID", "signed in as?', 'which account is this?'", "user_id is ignored); admins see all", "e.g. user_id is U0123456ABC"]) {
      redactor.learn(text)
      assert.equal(redactor.redact(text), text, text)
    }
    assert.equal(redactor.learned.size, 0)
    assert.equal(redactor.count, 0)
    assert.match(readFileSync(join(SCRIPTS, "capture-tools.mjs"), "utf8"), /const redactor = accountRedactor\(\{ known: identityValues\(value\?\.metadata\) \}\)/, "the metadata of the credential already fetched; no extra call")
  })

  test("refuses to write a capture that still holds a learned value", () => {
    assert.deepEqual(accountValuesIn(`Your user_id: ${MEMBER}.`).map((hit) => hit.value), [MEMBER])
    assert.deepEqual(accountValuesIn("Your user_id: U00CURRENTUSER. user_id is U0123456ABC. logged in as alex@example.com."), [])
  })
})

describe("check-drift: a committed capture holds no account's own value", () => {
  const pkg = { jelly: { tools: [tool("search")] } }
  const leaking = (text) => fixture([{ ...served("search", true), description: { text } }])

  test("fails an identity phrase followed by anything but a placeholder or a documented example, and never prints the value", () => {
    const findings = run({ pkg, fixture: leaking(`Search. Your user_id: ${MEMBER}. Current logged in user's user_id is ${MEMBER}.`) })
    assert.deepEqual(failing(findings), ["capture-account:search", "capture-account:search"])
    for (const finding of findings) assert.ok(!JSON.stringify(finding).includes(MEMBER), "the report does not repeat the value")
    assert.match(findings[0].detail, /tools\[0\]\.description\.text: "Your user_id" is followed by the signed-in account's own value, not a placeholder/)
    for (const text of ["Your user_id: U00CURRENTUSER.", "user_id is U0123456ABC (an example)", "user_id is the Slack user ID", "Your email is alex@example.com", "logged in as T00CURRENTTEAM"]) assert.deepEqual(failing(run({ pkg, fixture: leaking(text) })), [], text)
    assert.deepEqual(failing(run({ pkg, fixture: leaking('You are logged in as "Pat Person".') })), ["capture-account:search"])
  })

  test("checks a capture in an older format too", () => {
    const older = { evidence: "live-observed", retrieved: "2026-11-12", tools: [{ name: "search", description: `Your user_id: ${MEMBER}` }] }
    assert.deepEqual(at(checkDrift({ pkg, fixture: older }), "fail"), ["capture-account"])
  })
})

describe("capture-tools: provenance", () => {
  test("writes both files, replaces an earlier entry for the same fixture, and drops a waiver", () => {
    const dir = folder()
    const tools = TOOLS.map(recordTool)
    const captured = { schema: FIXTURE_SCHEMA, evidence: "live-observed", listedAt: "2026-11-14", server: "fake", endpoint: "https://x/mcp", auth: "signed-in", host: { opencode: "2.2.6" }, protocol: { version: "2025-06-18" }, count: 3, readOnlyHints: 2, digest: toolsDigest(tools), tools }
    writeFixture(dir, captured)
    const first = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"))
    writeFileSync(join(dir, "provenance.json"), JSON.stringify({ ...first, waiver: { listedAt: "2026-11-14", reason: "r", approvedBy: "o" } }))
    writeFixture(dir, { ...captured, listedAt: "2026-11-15" })
    const provenance = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"))
    assert.equal(provenance.captures.length, 1)
    assert.equal(provenance.captures[0].listedAt, "2026-11-15")
    assert.equal(provenance.captures[0].annotations, "2 of 3")
    assert.deepEqual(provenance.live, { fixture: "live-tools.json", listedAt: "2026-11-15" })
    assert.equal(provenance.waiver, undefined)
  })

  test("a catalog capture records names only, and keeps the earlier live entry as live", () => {
    const catalog = fromCatalog({ server: "fake", dump: { tools: [{ name: "b", description: "d", signature: "tools.fake.b({\n  q: string,\n})" }, { name: "a" }] }, listedAt: "2026-11-14" })
    assert.equal(catalog.evidence, "catalog")
    assert.deepEqual(catalog.tools.map((item) => item.name), ["a", "b"])
    assert.deepEqual(catalog.tools[1].inputParams, ["q"])
    assert.equal(catalog.tools[1].readOnlyHint, null)
    assert.deepEqual(provenanceWith({ captures: [], live: { fixture: "live-tools.json", listedAt: "2026-11-01" } }, catalog).live, { fixture: "live-tools.json", listedAt: "2026-11-01" })
  })
})

// ---- this repository

describe("check-drift: this repository (npm run check, offline)", () => {
  test("its declaration, registry, skills and docs agree with its capture; a missing capture is a warning", (t) => {
    const report = driftReport(join(SCRIPTS, ".."))
    for (const finding of report.findings.filter((item) => item.level !== "note")) t.diagnostic(reportLines({ ...report, findings: [finding] }, { actions: false })[0])
    assert.deepEqual(report.failed.map((finding) => reportLines({ ...report, findings: [finding] }, { actions: false })[0]), [])
  })
})
