#!/usr/bin/env node
// Checks a plugin's Jelly declaration, registry, skills and docs against the tool list its provider serves, as the
// committed capture records it. Kit script: one copy in every plugin, pinned by check-copies.mjs. It reads files only:
// no network, no credential, no child process.
//
//   node scripts/check-drift.mjs              offline; the kit tests run it on the repository in `npm run check`
//   node scripts/check-drift.mjs --release    the release gate: release-commit.mjs runs it in the release's build job
//   node scripts/check-drift.mjs --json       the findings as JSON
//   options: --root <repo> --today YYYY-MM-DD --max-age <days>
//
// Inputs, all in the repository:
//   package.json                      `jelly.tools`: { name, permission, effect, readOnly?, note? }
//   test/fixtures/live-tools.json     the capture, written by `npm run capture` (scripts/capture-tools.mjs)
//   test/fixtures/provenance.json     where the capture came from; `live` names it; an optional `waiver` (below)
//   test/fixtures/tool-registry.json  optional:
//     own: ["events_list"]                     tools the plugin defines itself, never served upstream
//     tools: { "<tool>": { availability: "plan" | "scope" | "account", reason },     declared, not served to this sign-in
//              "<tool>": { readOnlyOverride: { value, reason } } }               stricter than the server's readOnlyHint
//     docIgnore: ["granola_events"]           identifiers in docs that look like tools and are not
//     captureWording: [{ rule, phrase, reason }]   provider words in the capture that a forbidden-word rule would catch
//     upstream: "none"                         the plugin serves only its own tools: no capture is expected
//   test/fixtures/effect-exceptions.json  optional, owner-approved: { "<permission>": "reason" } for an effect not allow
//   skills/**/*.md, README.md, docs/**/*.md
//
// Findings are FAIL (exit 1), WARN (shown, and in GitHub Actions as a warning annotation) or note.
//   schema               more than 256 tools, an unknown key in a tool, a name or permission declared twice
//   effect-not-allow     an effect other than allow (OD-29), unless effect-exceptions.json gives the owner's reason
//   registry             an unknown key or availability, an entry with no reason, a captureWording phrase the capture
//                        does not hold
//   capture              the capture is malformed: count, duplicates, digest, server, or provenance.json disagrees
//   capture-account      the capture holds a signed-in account's own value: an identity phrase ("Your user_id:", "user_id
//                        is", "logged in as", "signed in as", …) followed by an id, email or quoted value that is not a
//                        placeholder or a documented example (any capture, older formats too; npm run capture redacts)
//   namespace            a declared permission outside the capture's namespace
//   served-not-declared  a served tool `jelly.tools` lacks: a write there escapes Jelly's read-only-helper fence
//   declared-not-served  a declared tool the capture lacks, unless it is the plugin's own, or gated in the registry
//                        (availability and reason) with a note on the declared tool
//   own-served           an own tool the server serves as well
//   readonly-mismatch    readOnly (default false) differs from readOnlyHint, unless readOnlyOverride gives a reason
//   registry-stale       an availability entry for a served tool; an override equal to the server's hint
//   doc-unknown-tool     a skill or doc names a tool that is neither served, own, nor declared and gated
//   doc-unknown-param    a skill or doc passes a parameter the served tool's input schema lacks
//   jelly-count          docs/jelly.md's "N tools are declared (M read-only)" disagrees with the declaration
//   capture-stale        (--release) a live capture older than --max-age days (default 14), with no waiver in
//                        provenance.json for exactly that capture: { "waiver": { "listedAt": "<the capture's date>",
//                        "reason": "…", "approvedBy": "…" } }. A new capture drops the waiver.
//   WARN, not FAIL, until the plugin has a capture: no capture (upstream not "none"), a capture in an older format, a
//   names-only (catalog) capture. No `jelly.tools` and no capture: nothing to check.
// Exit codes: 0 no FAIL, 1 a FAIL, 2 a missing or malformed file.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const FIXTURE_SCHEMA = "opencode-family/live-tools@1"
export const FIXTURE = "test/fixtures/live-tools.json"
export const PROVENANCE = "test/fixtures/provenance.json"
export const REGISTRY = "test/fixtures/tool-registry.json"
export const EFFECT_EXCEPTIONS = "test/fixtures/effect-exceptions.json"
export const MAX_TOOLS = 256
export const MAX_AGE_DAYS = 14
export const TOOL_KEYS = new Set(["name", "permission", "effect", "readOnly", "note"])
export const AVAILABILITY = new Set(["plan", "scope", "account"])
const REGISTRY_KEYS = new Set(["own", "tools", "docIgnore", "captureWording", "upstream"])
const ENTRY_KEYS = new Set(["availability", "reason", "readOnlyOverride"])
const DAY = 86_400_000

export class FileError extends Error {}

/** Canonical JSON: object keys sorted, undefined dropped, so a digest does not depend on key order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex")

/** The digest a capture records: canonical JSON of its tools, sorted by name. */
export const toolsDigest = (tools) => sha256(canonical([...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))))

/**
 * The signed-in account's own values in a capture. Some servers write them into tool descriptions (Slack: "Your user_id:
 * <member id>", "Current logged in user's user_id is <member id>"), so a raw tools/list would publish them. capture-tools
 * writes these placeholders instead, and the drift check fails a capture that holds anything else after such a phrase.
 */
export const ACCOUNT_PLACEHOLDERS = { member: "U00CURRENTUSER", team: "T00CURRENTTEAM", email: "current.user@example.invalid", id: "CURRENT_ACCOUNT_ID", name: "Current User" }
const PLACEHOLDER_VALUES = new Set(Object.values(ACCOUNT_PLACEHOLDERS))
/**
 * Documented examples that providers print the same for every account, kept as they are: an explicit list (Slack's,
 * Notion's and the family's captured examples), and any address at an RFC 2606 example domain. Not a "same in every
 * capture" rule: that would need two accounts' captures of each server.
 */
export const EXAMPLE_VALUES = new Set([
  "U071CCRCVFH",
  "U0123456ABC",
  "alice@acme.com",
  "bob@acme.com",
  "alex@acme.com",
  "john@company.com",
  "00000000-0000-0000-0000-000000000000",
  "00000000-0000-4000-8000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "12345678-90ab-4def-8234-567890abcdef",
  "12345678-90ab-cdef-1234-567890abcdef",
  "141083e9-5e66-4c8f-8a38-bce5762903c2",
  "1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
  "26ab1f9f-4c5f-80b1-8d3b-d10a6b1d2f4e",
  "abcdef12-3456-4890-abcd-ef1234567890",
  "f336d0bc-b841-465b-8045-024475c079dd",
  "fedcba98-7654-4321-8fed-cba987654321",
  "550e8400-e29b-41d4-a716-446655440000",
])
const EXAMPLE_DOMAIN = /@(?:[\w-]+\.)*example\.(?:com|org|net|invalid)$/i
/** A value that is account data: not a placeholder and not a documented example. */
export const isAccountValue = (value) => !PLACEHOLDER_VALUES.has(value) && !EXAMPLE_VALUES.has(value) && !EXAMPLE_VALUES.has(value.toLowerCase()) && !EXAMPLE_DOMAIN.test(value)
const ID_VALUE = String.raw`[UWTBE](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,11}|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}`
const ACCOUNT_PHRASE = "your user[ _]?id(?: is)?|current(?:ly)?(?: logged[ -]in| signed[ -]in)? user(?:'s)?(?: user[ _]?id| id| email)? is|user[ _]?id is|logged[ -]in as|signed[ -]in as|your (?:email(?: address)?|account id|team id|workspace id|member id) is"
/** An identity phrase, then an id, email, UUID, long number or quoted value: groups 1 phrase, 2 gap, 3 quote, 4 quoted, 5 bare. */
export const accountPattern = () => new RegExp(String.raw`\b(${ACCOUNT_PHRASE})(\s*:?\s*)(?:(["'\x60])([^"'\x60\n]{2,80})\3|(${ID_VALUE})(?![\w@-]))`, "gi")

/** The identity phrases in a text whose value is account data: [{ phrase, value, index }]. */
export function accountValuesIn(text) {
  const out = []
  for (const match of String(text).matchAll(accountPattern())) {
    const value = match[4] ?? match[5]
    if (isAccountValue(value)) out.push({ phrase: match[1], value, index: match.index })
  }
  return out
}

/** Every string in a JSON value, with its path. */
export function* stringsIn(value, path = "") {
  if (typeof value === "string") yield { path, text: value }
  else if (Array.isArray(value)) for (const [index, item] of value.entries()) yield* stringsIn(item, `${path}[${index}]`)
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) yield* stringsIn(item, path ? `${path}.${key}` : key)
}

/** OpenCode's tool id for an MCP tool: `<namespace>_<tool>`, each part with unsafe characters replaced. */
export const namespaceOf = (server) => server.replace(/[^a-zA-Z0-9_-]/g, "_")
export const permissionOf = (namespace, tool) => `${namespaceOf(namespace)}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0

function readJson(path, { optional = false } = {}) {
  if (!existsSync(path)) {
    if (optional) return undefined
    throw new FileError(`missing ${path}`)
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new FileError(`malformed ${path}: ${error.message}`)
  }
}

/** Markdown the docs check reads: skills/, README.md and docs/. Never CHANGELOG.md, which records the past. */
export function docFiles(root) {
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith(".md")) out.push(path)
    }
  }
  walk(join(root, "skills"))
  if (existsSync(join(root, "README.md"))) out.push(join(root, "README.md"))
  walk(join(root, "docs"))
  return out
}

/** The top-level keys of the object literal that starts at `text[start] === "{"`. */
export function objectKeys(text, start) {
  const keys = []
  let depth = 0
  let quote
  let segment = ""
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (depth === 1) segment += char
      if (char === "\\") index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      if (depth === 1) segment += char
      continue
    }
    if ("{[(".includes(char)) {
      depth++
      if (depth === 1) continue
    }
    if ("}])".includes(char)) {
      depth--
      if (depth === 0) {
        const key = keyOf(segment)
        if (key) keys.push(key)
        return keys
      }
    }
    if (depth === 1) {
      if (char === ",") {
        const key = keyOf(segment)
        if (key) keys.push(key)
        segment = ""
      } else segment += char
    }
  }
  return keys
}

function keyOf(segment) {
  const trimmed = segment.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()
  if (!trimmed || trimmed.startsWith("...")) return undefined
  const named = trimmed.match(/^["']?([A-Za-z_$][\w$-]*)["']?\s*:/)
  if (named) return named[1]
  const shorthand = trimmed.match(/^([A-Za-z_$][\w$]*)$/)
  return shorthand ? shorthand[1] : undefined
}

/** A served tool's input parameter names: its JSON schema's properties, or a catalog capture's names. */
const paramsOf = (tool) => {
  if (tool?.inputSchema && typeof tool.inputSchema === "object") {
    const properties = tool.inputSchema.properties
    return properties && typeof properties === "object" ? new Set(Object.keys(properties)) : new Set()
  }
  return Array.isArray(tool?.inputParams) ? new Set(tool.inputParams) : undefined
}

const lineAt = (text, index) => text.slice(0, index).split("\n").length

/** Tool references in one markdown file: Code Mode calls anywhere; `<ns>_<tool>` names and `tool({ … })` calls in code. */
export function referencesIn(text, namespace) {
  const refs = []
  const ns = namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const call = (index, length) => (text.slice(index + length).match(/^\s*\(\s*\{/) ? index + length + text.slice(index + length).indexOf("{") : -1)
  const patterns = [
    new RegExp(`tools\\.${ns}\\.([A-Za-z0-9_]+)`, "g"),
    new RegExp(`tools\\.${ns}\\[\\s*["']([^"']+)["']\\s*\\]`, "g"),
    new RegExp(`tools\\[\\s*["']${ns}["']\\s*\\]\\[\\s*["']([^"']+)["']\\s*\\]`, "g"),
    new RegExp(`tools\\[\\s*["']${ns}["']\\s*\\]\\.([A-Za-z0-9_]+)`, "g"),
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const brace = call(match.index, match[0].length)
      refs.push({ kind: "codemode", tool: match[1], line: lineAt(text, match.index), keys: brace === -1 ? undefined : objectKeys(text, brace) })
    }
  }
  const code = []
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) code.push({ start: match.index + match[0].indexOf("\n") + 1, body: match[1] })
  const fenced = (index) => code.some((block) => index >= block.start && index < block.start + block.body.length)
  for (const match of text.matchAll(/`([^`\n]+)`/g)) if (!fenced(match.index)) code.push({ start: match.index + 1, body: match[1] })
  for (const block of code) {
    for (const match of block.body.matchAll(new RegExp(`(?<![\\w.$-])(${ns}_[A-Za-z0-9_-]*[A-Za-z0-9])\\b`, "g"))) {
      refs.push({ kind: "permission", tool: match[1], line: lineAt(text, block.start + match.index) })
    }
    for (const match of block.body.matchAll(/(?<![\w.$\]])([a-z][A-Za-z0-9_-]*)\s*\(\s*\{/g)) {
      const absolute = block.start + match.index
      refs.push({ kind: "call", tool: match[1], line: lineAt(text, absolute), keys: objectKeys(text, absolute + match[0].lastIndexOf("{")) })
    }
    const whole = block.body.trim().match(/^([a-z][A-Za-z0-9_-]*)(?:\(\))?$/)
    if (whole) refs.push({ kind: "bare", tool: whole[1], line: lineAt(text, block.start) })
  }
  return refs
}

/** Age in whole days from a capture's listedAt (YYYY-MM-DD) to today (YYYY-MM-DD); undefined when either is not a date. */
export function ageInDays(listedAt, today) {
  const date = (text) => (typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Number.NaN)
  const from = date(listedAt)
  const to = date(today)
  return Number.isNaN(from) || Number.isNaN(to) ? undefined : Math.round((to - from) / DAY)
}

/**
 * The capture-wording exemptions in force: each registry `captureWording` phrase that the capture file holds. A
 * repository's forbidden-word check calls `maskCaptureWording(root)` and runs each line of the capture through the
 * function it returns, so a provider's own words in its tool descriptions pass and nothing else in the file does.
 */
export function maskCaptureWording(root) {
  const registry = readJson(join(root, REGISTRY), { optional: true }) ?? {}
  const entries = Array.isArray(registry.captureWording) ? registry.captureWording.filter((entry) => nonEmpty(entry?.phrase) && nonEmpty(entry?.rule) && nonEmpty(entry?.reason)) : []
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return (path, rule, line) => {
    if (path.split("\\").join("/") !== FIXTURE) return line
    let out = line
    for (const entry of entries) if (entry.rule === rule) out = out.replace(new RegExp(literal(entry.phrase), "gi"), " ".repeat(entry.phrase.length))
    return out
  }
}

/** Runs every check on what the repository holds. Returns the findings: { level: "fail" | "warn" | "note", kind, … }. */
export function checkDrift({ pkg, fixture, provenance, registry = {}, effectExceptions = {}, docs = [], jellyDoc, fixtureText, release = false, today, maxAgeDays = MAX_AGE_DAYS }) {
  const findings = []
  const add = (level, kind, item) => findings.push({ level, kind, ...item })
  const declared = pkg?.jelly?.tools
  if (declared === undefined) {
    if (fixture) add("fail", "schema", { detail: `${FIXTURE} is committed, and package.json has no jelly.tools to check against it` })
    else add("note", "no-declaration", { detail: "package.json has no jelly.tools: nothing to check" })
    return findings
  }
  if (!Array.isArray(declared)) throw new FileError("package.json's jelly.tools is not an array")

  // schema
  if (declared.length > MAX_TOOLS) add("fail", "schema", { detail: `${declared.length} tools declared; Jelly takes at most ${MAX_TOOLS}` })
  const byPermission = new Map()
  const names = new Set()
  for (const tool of declared) {
    for (const key of Object.keys(tool)) if (!TOOL_KEYS.has(key)) add("fail", "schema", { tool: tool.name, detail: `unknown key ${key}: Jelly refuses an unknown key inside a tool` })
    if (byPermission.has(tool.permission)) add("fail", "schema", { tool: tool.name, detail: `permission ${tool.permission} is declared twice` })
    if (names.has(tool.name)) add("fail", "schema", { tool: tool.name, detail: "declared twice" })
    byPermission.set(tool.permission, tool)
    names.add(tool.name)
  }

  // effects
  for (const tool of declared) {
    if (tool.effect === "allow") continue
    const reason = effectExceptions[tool.permission]
    add(nonEmpty(reason) ? "note" : "fail", "effect-not-allow", { tool: tool.name, detail: nonEmpty(reason) ? `owner-approved: ${reason}` : `effect ${tool.effect}; OD-29 declares every tool allow` })
  }

  // docs/jelly.md's count (every plugin, with a capture or not)
  if (jellyDoc !== undefined && /tools are declared/.test(jellyDoc)) {
    const readOnly = declared.filter((tool) => tool.readOnly === true).length
    const match = jellyDoc.match(/(\d+) tools are declared(?: \((\d+) read-only\))?/)
    if (!match || Number(match[1]) !== declared.length || (match[2] !== undefined && Number(match[2]) !== readOnly)) {
      add("fail", "jelly-count", { file: "docs/jelly.md", detail: `says "${match?.[0] ?? "tools are declared"}"; the declaration has ${declared.length} tools (${readOnly} read-only)` })
    }
  }

  // the registry's own shape
  for (const key of Object.keys(registry)) if (!REGISTRY_KEYS.has(key)) add("fail", "registry", { detail: `unknown key ${key} in ${REGISTRY}` })
  const entries = registry.tools ?? {}
  for (const [name, entry] of Object.entries(entries)) {
    for (const key of Object.keys(entry ?? {})) if (!ENTRY_KEYS.has(key)) add("fail", "registry", { tool: name, detail: `unknown key ${key}` })
    if (entry?.availability !== undefined && (!AVAILABILITY.has(entry.availability) || !nonEmpty(entry.reason))) add("fail", "registry", { tool: name, detail: "availability must be plan, scope or account, with a reason" })
    const override = entry?.readOnlyOverride
    if (override !== undefined && (typeof override?.value !== "boolean" || !nonEmpty(override?.reason))) add("fail", "registry", { tool: name, detail: "readOnlyOverride needs a boolean value and a reason" })
  }
  if (registry.upstream !== undefined && registry.upstream !== "none") add("fail", "registry", { detail: `upstream is ${JSON.stringify(registry.upstream)}; the only value is "none"` })

  if (registry.upstream === "none") {
    if (fixture) add("fail", "registry", { detail: `upstream is "none", and ${FIXTURE} is committed: remove one` })
    else add("note", "no-upstream", { detail: "the plugin serves only its own tools; no capture is expected" })
    return findings
  }
  // The signed-in account's own values, in any capture (an older format too): never in a public repository.
  if (fixture) {
    for (const { path, text } of stringsIn(fixture)) {
      for (const hit of accountValuesIn(text)) {
        const tool = /^tools\[(\d+)\]/.exec(path)
        add("fail", "capture-account", {
          ...(tool && fixture.tools?.[Number(tool[1])]?.name ? { tool: fixture.tools[Number(tool[1])].name } : {}),
          detail: `${path}: "${hit.phrase}" is followed by the signed-in account's own value, not a placeholder. Capture again with npm run capture, which writes ${ACCOUNT_PLACEHOLDERS.member} and the other placeholders instead; never commit an account's id, email or name`,
        })
      }
    }
  }
  if (!fixture) {
    add("warn", "no-capture", { detail: `no ${FIXTURE}: the declaration is not checked against what the provider serves. Capture it with npm run capture` })
    return findings
  }
  if (fixture.schema !== FIXTURE_SCHEMA || !Array.isArray(fixture.tools)) {
    add("warn", "capture-format", { detail: `${FIXTURE} is not a ${FIXTURE_SCHEMA} capture, so it is not checked here. Capture it again with npm run capture` })
    return findings
  }

  // the capture itself, and its provenance
  const namespace = fixture.namespace ?? namespaceOf(fixture.server ?? "")
  const live = fixture.evidence === "live-observed"
  const served = new Map()
  for (const tool of fixture.tools) {
    if (served.has(tool.name)) add("fail", "capture", { tool: tool.name, detail: "listed twice" })
    served.set(tool.name, tool)
  }
  if (!nonEmpty(fixture.server) || namespaceOf(fixture.server) !== namespace) add("fail", "capture", { detail: `server ${JSON.stringify(fixture.server)} and namespace ${JSON.stringify(fixture.namespace)} disagree` })
  if (fixture.count !== fixture.tools.length) add("fail", "capture", { detail: `count is ${fixture.count}, and ${fixture.tools.length} tools are recorded` })
  if (fixture.digest !== toolsDigest(fixture.tools)) add("fail", "capture", { detail: "the digest is not the recorded tools' digest: the capture was edited by hand. Capture it again" })
  if (!provenance) add("fail", "capture", { detail: `no ${PROVENANCE}: npm run capture writes it with the capture` })
  else {
    const entry = (provenance.captures ?? []).find((item) => item.fixture === "live-tools.json")
    if (!entry || entry.digest?.value !== fixture.digest || entry.listedAt !== fixture.listedAt) add("fail", "capture", { detail: `${PROVENANCE} does not record this capture (its date and digest)` })
    if (live && (provenance.live?.fixture !== "live-tools.json" || provenance.live?.listedAt !== fixture.listedAt)) add("fail", "capture", { detail: `${PROVENANCE}'s live is not this capture` })
  }
  if (!live) add("warn", "capture-names-only", { detail: `the capture is ${fixture.evidence} evidence (names only): no readOnlyHint is checked. Capture it live with npm run capture` })

  for (const tool of declared) if (!String(tool.permission).startsWith(`${namespace}_`)) add("fail", "namespace", { tool: tool.name, detail: `${tool.permission} is not in the ${namespace} namespace` })
  const shortOf = (permission) => (permission.startsWith(`${namespace}_`) ? permission.slice(namespace.length + 1) : permission)
  const own = new Set(registry.own ?? [])
  const servedByPermission = new Map(fixture.tools.map((tool) => [permissionOf(namespace, tool.name), tool]))
  const gated = new Map()

  // served, not declared
  for (const [permission, tool] of servedByPermission) {
    if (byPermission.has(permission)) continue
    const kind = tool.readOnlyHint === true ? "a read" : tool.readOnlyHint === false ? (tool.destructiveHint === true ? "a destructive write" : "a write") : "unclassified"
    add("fail", "served-not-declared", { tool: tool.name, permission, detail: `${kind}${tool.readOnlyHint === true ? "" : "; not fenced from read-only helpers"}` })
  }
  // declared, not served
  for (const tool of declared) {
    const short = shortOf(tool.permission)
    if (servedByPermission.has(tool.permission) || own.has(short)) continue
    const entry = entries[short]
    const excused = entry && AVAILABILITY.has(entry.availability) && nonEmpty(entry.reason)
    const noted = excused && nonEmpty(tool.note)
    if (noted) gated.set(short, entry)
    add(noted ? "note" : "fail", "declared-not-served", {
      tool: short,
      detail: noted ? `${entry.availability}-gated: ${entry.reason}` : excused ? `${entry.availability}-gated in the registry, and the declared tool has no note` : "remove it, or record its availability and a reason in the registry and add a note",
    })
  }
  for (const name of own) if (served.has(name)) add("fail", "own-served", { tool: name, detail: "the registry says the plugin defines it, and the server serves it" })

  // readOnly against readOnlyHint, and registry entries that no longer apply
  for (const [permission, tool] of servedByPermission) {
    const mine = byPermission.get(permission)
    if (!mine) continue
    const readOnly = mine.readOnly ?? false
    const override = entries[tool.name]?.readOnlyOverride
    if (tool.readOnlyHint === null || tool.readOnlyHint === undefined) {
      if (live) add("note", "readonly-unverified", { tool: tool.name, detail: `the server gives no readOnlyHint; declared readOnly ${readOnly}` })
      continue
    }
    if (override && override.value === tool.readOnlyHint) add("fail", "registry-stale", { tool: tool.name, detail: `readOnlyOverride ${override.value} is the server's own readOnlyHint: remove it` })
    const expected = override && nonEmpty(override.reason) ? override.value : tool.readOnlyHint
    if (readOnly !== expected) add("fail", "readonly-mismatch", { tool: tool.name, detail: `declared readOnly ${readOnly}; the server's readOnlyHint is ${tool.readOnlyHint}${override ? `, and the registry's override says ${override.value}` : ""}` })
  }
  for (const [name, entry] of Object.entries(entries)) if (entry?.availability !== undefined && served.has(name)) add("fail", "registry-stale", { tool: name, detail: `the server serves it, and the registry says it is ${entry.availability}-gated: remove the entry` })

  // capture wording
  for (const entry of registry.captureWording ?? []) {
    if (!nonEmpty(entry?.rule) || !nonEmpty(entry?.phrase) || !nonEmpty(entry?.reason)) add("fail", "registry", { detail: "a captureWording entry needs rule, phrase and reason" })
    else if (!(fixtureText ?? JSON.stringify(fixture)).toLowerCase().includes(entry.phrase.toLowerCase())) add("fail", "registry", { detail: `captureWording "${entry.phrase}" is not in the capture: remove it` })
  }

  // docs and skills
  const ignore = new Set(registry.docIgnore ?? [])
  const declaredShort = new Set(declared.map((tool) => shortOf(tool.permission)))
  const known = (name) => served.has(name) || own.has(name) || gated.has(name)
  for (const { file, text } of docs) {
    const seen = new Set()
    for (const ref of referencesIn(text, namespace)) {
      let tool = ref.tool
      if (ref.kind === "permission") {
        if (ignore.has(tool)) continue
        const short = tool.slice(namespace.length + 1)
        if (known(short) || declaredShort.has(short)) tool = short
        else if (!known(tool) && !declaredShort.has(tool)) continue // a config key or event type, not a tool
      }
      if ((ref.kind === "call" || ref.kind === "bare") && !known(tool) && !declaredShort.has(tool)) continue
      if (ignore.has(tool)) continue
      const key = `${ref.line}:${tool}`
      if (!known(tool)) {
        if (!seen.has(key)) add("fail", "doc-unknown-tool", { file, line: ref.line, tool, detail: declaredShort.has(tool) ? "declared, not served, and not gated in the registry" : "not served, own or declared" })
        seen.add(key)
        continue
      }
      if (!ref.keys || own.has(tool) || gated.has(tool)) continue
      const params = paramsOf(served.get(tool))
      if (!params) continue
      for (const param of ref.keys) if (!params.has(param)) add("fail", "doc-unknown-param", { file, line: ref.line, tool, param, detail: `${tool} takes ${[...params].sort().join(", ") || "no parameters"}` })
    }
  }

  // the release gate
  if (release) {
    if (!live) add("warn", "capture-stale", { detail: "the release has no live capture to gate on" })
    else {
      const age = ageInDays(fixture.listedAt, today)
      const waiver = provenance?.waiver
      const waived = waiver && waiver.listedAt === fixture.listedAt && nonEmpty(waiver.reason) && nonEmpty(waiver.approvedBy)
      if (age === undefined || age < 0) add("fail", "capture-stale", { detail: `the capture's date ${JSON.stringify(fixture.listedAt)} is not a past date` })
      else if (age > maxAgeDays) {
        if (waived) add("warn", "capture-stale", { detail: `the capture is ${age} days old (gate: ${maxAgeDays}); waived by ${waiver.approvedBy}: ${waiver.reason}` })
        else add("fail", "capture-stale", { detail: `the capture is ${age} days old; a release needs one at most ${maxAgeDays} days old. Run npm run capture, or record the owner's waiver for this capture in ${PROVENANCE}` })
      } else add("note", "capture-fresh", { detail: `the capture is ${age} day(s) old (gate: ${maxAgeDays})` })
    }
  }
  if (provenance?.waiver !== undefined) {
    const waiver = provenance.waiver
    if (!nonEmpty(waiver?.reason) || !nonEmpty(waiver?.approvedBy) || !nonEmpty(waiver?.listedAt)) add("fail", "capture", { detail: `${PROVENANCE}'s waiver needs listedAt, reason and approvedBy` })
    else if (waiver.listedAt !== fixture.listedAt) add("fail", "capture", { detail: `${PROVENANCE}'s waiver is for the capture of ${waiver.listedAt}, not this one: remove it` })
  }
  return findings
}

/** Reads the repository and runs the checks. */
export function driftReport(root, { release = false, today = new Date().toISOString().slice(0, 10), maxAgeDays = MAX_AGE_DAYS } = {}) {
  const pkg = readJson(join(root, "package.json"))
  const fixturePath = join(root, FIXTURE)
  const fixtureText = existsSync(fixturePath) ? readFileSync(fixturePath, "utf8") : undefined
  let fixture
  if (fixtureText !== undefined) {
    try {
      fixture = JSON.parse(fixtureText)
    } catch (error) {
      throw new FileError(`malformed ${FIXTURE}: ${error.message}`)
    }
  }
  const findings = checkDrift({
    pkg,
    fixture,
    fixtureText,
    provenance: readJson(join(root, PROVENANCE), { optional: true }),
    registry: readJson(join(root, REGISTRY), { optional: true }) ?? {},
    effectExceptions: readJson(join(root, EFFECT_EXCEPTIONS), { optional: true }) ?? {},
    docs: docFiles(root).map((path) => ({ file: relative(root, path).split("\\").join("/"), text: readFileSync(path, "utf8") })),
    jellyDoc: existsSync(join(root, "docs", "jelly.md")) ? readFileSync(join(root, "docs", "jelly.md"), "utf8") : undefined,
    release,
    today,
    maxAgeDays,
  })
  const namespace = fixture?.namespace ?? fixture?.server ?? pkg?.name ?? "plugin"
  return { findings, namespace, fixture, failed: findings.filter((finding) => finding.level === "fail"), warned: findings.filter((finding) => finding.level === "warn") }
}

export function format(finding, namespace) {
  const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""} ` : ""
  const tool = finding.tool ? `${namespace}.${finding.tool}${finding.param ? `(${finding.param})` : ""} ` : ""
  return `${finding.level === "fail" ? "FAIL" : finding.level === "warn" ? "WARN" : "note"} ${finding.kind} ${where}${tool}(${finding.detail})`
}

/** The report as lines; in GitHub Actions each FAIL and WARN is also an annotation, so a warning shows on the run. */
export function reportLines({ findings, namespace, fixture }, { actions = process.env.GITHUB_ACTIONS === "true" } = {}) {
  const lines = findings.map((finding) => format(finding, namespace))
  if (actions) for (const finding of findings) if (finding.level !== "note") lines.push(`::${finding.level === "fail" ? "error" : "warning"} title=tool drift (${finding.kind})::${format(finding, namespace).replace(/\r?\n/g, " ")}`)
  const failed = findings.filter((finding) => finding.level === "fail").length
  const warned = findings.filter((finding) => finding.level === "warn").length
  const checked = fixture?.schema === FIXTURE_SCHEMA && Array.isArray(fixture.tools)
  lines.push(failed ? `${failed} finding(s) fail the drift check.` : `No drift${checked ? `: ${fixture.tools.length} served tools (${fixture.evidence}, ${fixture.listedAt})` : ""}${warned ? `; ${warned} warning(s)` : ""}.`)
  return lines
}

function parseArgs(argv) {
  const out = { flags: new Set() }
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index].replace(/^--/, "")
    if (["release", "json"].includes(key)) out.flags.add(key)
    else if (["root", "today", "max-age"].includes(key)) out[key] = argv[++index]
    else throw new FileError(`unknown argument ${argv[index]}`)
  }
  return out
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const root = resolve(args.root ?? fileURLToPath(new URL("..", import.meta.url)))
    const report = driftReport(root, { release: args.flags.has("release"), ...(args.today ? { today: args.today } : {}), maxAgeDays: Number(args["max-age"] ?? MAX_AGE_DAYS) })
    if (args.flags.has("json")) console.log(JSON.stringify({ server: report.fixture?.server ?? null, evidence: report.fixture?.evidence ?? null, listedAt: report.fixture?.listedAt ?? null, findings: report.findings }, null, 2))
    else for (const line of reportLines(report)) console.log(line)
    process.exit(report.failed.length ? 1 : 0)
  } catch (error) {
    console.error(error instanceof FileError ? `check-drift: ${error.message}` : (error?.stack ?? String(error)))
    process.exit(2)
  }
}
