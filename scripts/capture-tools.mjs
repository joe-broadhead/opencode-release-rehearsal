#!/usr/bin/env node
// Captures an MCP server's served tool list, read-only, into test/fixtures/live-tools.json and provenance.json.
// Kit script: one copy in every plugin, pinned by check-copies.mjs. Run by hand by a maintainer (`npm run capture`), never
// by `npm run check`, CI or the release workflow; scripts/check-drift.mjs checks the plugin against what it writes.
//
//   node scripts/capture-tools.mjs                                 capture the server the committed capture names
//   node scripts/capture-tools.mjs --server <name>                 capture through the running, signed-in OpenCode
//   node scripts/capture-tools.mjs --server <name> --check         capture again and report drift; write nothing
//   node scripts/capture-tools.mjs --server <name> --out <dir>     write the two files into <dir> instead
//   node scripts/capture-tools.mjs --catalog <file> --server <n>   record a Code Mode catalog dump (names only; weaker)
//   add --endpoint <url> --token-env <VAR> for a key-based server whose key OpenCode reads from the environment
//   (Tavily: --endpoint https://mcp.tavily.com/mcp/ --token-env TAVILY_API_KEY; on boxd run node with
//   NODE_OPTIONS=--use-system-ca, because the egress proxy that swaps the placeholder for the key re-signs TLS)
//
// How it reaches the provider. It asks the OpenCode server that is already running on this machine (OPENCODE_SERVER,
// default http://127.0.0.1:4096; password from OPENCODE_SERVER_PASSWORD or OPENCODE_PASSWORD) for the server's status
// (`GET /api/mcp`) and, in memory only, for the server's active credential (`GET /api/credential`). It then speaks MCP
// to the credential's own `serverUrl` and nowhere else: `initialize`, `notifications/initialized`, `tools/list` (every
// page), and a session `DELETE`. The request sender refuses every other method before it is sent, so it cannot call a
// tool. It never refreshes a token: providers such as Notion rotate refresh tokens, and a refresh made here would revoke
// the owner's sign-in. An access token that has expired, or expires within --min-ttl seconds, is not used; the script
// first tries the list without a credential, and otherwise exits 3 and says the server needs a fresh token (OpenCode
// refreshes it the next time the server is used). Nothing is written to OpenCode's data directory, and no token,
// header, account id or result text is printed or written: the fixture is checked for the token before it is written.
//
// What it records, per tool: name, title, the four MCP annotation hints (null when absent), the raw `annotations`,
// `inputSchema`, `outputSchema`, and the description in full with its sha256 and length (public tool metadata). Per
// capture: the date, OpenCode's version, the endpoint, the protocol version and the server's name and version. The
// server's `instructions` are not recorded: some providers put the signed-in person's name in them.
//
// The signed-in account's own values are redacted before anything is digested or written. Some servers write them into
// tool descriptions (Slack: "Your user_id: <member id>"). The script learns them, with no extra call, from what it already
// has: an identity phrase followed by an id, email or quoted value in the descriptions or the `initialize` instructions,
// and the id, email, name and team fields of the credential's own metadata. Each is replaced everywhere by a placeholder
// (U00CURRENTUSER for a Slack member id, T00CURRENTTEAM for a team, current.user@example.invalid, CURRENT_ACCOUNT_ID,
// Current User); documented examples every account sees (U0123456ABC, alice@acme.com, Notion's example ids) stay. The
// capture records how many were replaced, and is refused if a learned value is still in it.
//
// provenance.json gets this capture's entry and `live`; a waiver of the release gate's age limit is for one capture, so
// a new capture drops it.
//
// Exit codes: 0 written (or --check found no drift), 1 drift found by --check, 2 usage or file error, 3 skipped (not
// signed in, token expired, server unreachable).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ACCOUNT_PLACEHOLDERS, accountPattern, accountValuesIn, canonical, FIXTURE_SCHEMA, isAccountValue, namespaceOf, permissionOf, sha256, stringsIn, toolsDigest } from "./check-drift.mjs"

export { canonical, FIXTURE_SCHEMA, namespaceOf, permissionOf, sha256, toolsDigest }
export const ALLOWED_METHODS = new Set(["initialize", "notifications/initialized", "tools/list"])
export const PROTOCOL_VERSION = "2025-06-18"

export class Skip extends Error {}

const hint = (annotations, key) => (annotations && typeof annotations[key] === "boolean" ? annotations[key] : null)

/** One served tool as the fixture records it. */
export function recordTool(raw) {
  const description = typeof raw.description === "string" ? raw.description : ""
  const annotations = raw.annotations && typeof raw.annotations === "object" ? raw.annotations : null
  return {
    name: raw.name,
    ...(typeof raw.title === "string" ? { title: raw.title } : annotations && typeof annotations.title === "string" ? { title: annotations.title } : {}),
    readOnlyHint: hint(annotations, "readOnlyHint"),
    destructiveHint: hint(annotations, "destructiveHint"),
    idempotentHint: hint(annotations, "idempotentHint"),
    openWorldHint: hint(annotations, "openWorldHint"),
    annotations,
    inputSchema: raw.inputSchema ?? null,
    ...(raw.outputSchema ? { outputSchema: raw.outputSchema } : {}),
    description: { sha256: sha256(description), length: description.length, text: description },
  }
}

/** Messages in an MCP HTTP response: one JSON body, or the `data:` lines of an SSE stream. */
export function messagesOf(text, contentType) {
  if (!text.trim()) return []
  if (/text\/event-stream/i.test(contentType ?? "")) {
    const out = []
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data) continue
      try {
        const parsed = JSON.parse(data)
        out.push(...(Array.isArray(parsed) ? parsed : [parsed]))
      } catch {}
    }
    return out
  }
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** Identity values in the credential's own metadata (never a URL, client id, scope or token): [{ value, kind }]. */
export function identityValues(metadata) {
  const out = []
  for (const { path, text } of stringsIn(metadata ?? {})) {
    const key = path.split(".").pop().replace(/\[\d+\]$/, "").toLowerCase()
    if (/client|server|url|scope|token|secret|type|issuer|redirect|endpoint|version/.test(key) || text.includes("://") || text.trim().length < 4) continue
    if (/email/.test(key)) out.push({ value: text.trim(), kind: "email" })
    else if (/name|login/.test(key) && !/id$/.test(key)) out.push({ value: text.trim(), kind: "name" })
    else if (/^(user|account|member|team|workspace|org)|(user|account|member|team|workspace|org)_?id$|^(id|uid|sub)$/.test(key)) out.push({ value: text.trim(), kind: "id" })
  }
  return out.filter((item) => isAccountValue(item.value))
}

/** The placeholder for one account value. */
export function placeholderFor(value, kind) {
  if (kind === "name") return ACCOUNT_PLACEHOLDERS.name
  if (value.includes("@")) return ACCOUNT_PLACEHOLDERS.email
  if (/^[UW](?=[A-Za-z0-9]*\d)[A-Z0-9]{8,11}$/.test(value)) return ACCOUNT_PLACEHOLDERS.member
  if (/^[TE](?=[A-Za-z0-9]*\d)[A-Z0-9]{8,11}$/.test(value)) return ACCOUNT_PLACEHOLDERS.team
  return ACCOUNT_PLACEHOLDERS.id
}

/**
 * Redacts the signed-in account's own values: learn() takes them from identity phrases in any text, and from the
 * credential's metadata (`known`); redact() replaces each, wherever it appears, by its placeholder. No call is made.
 */
export function accountRedactor({ known = [] } = {}) {
  const learned = new Map(known.map((item) => [item.value, placeholderFor(item.value, item.kind)]))
  let count = 0
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return {
    learned,
    get count() {
      return count
    },
    learn(text) {
      for (const match of String(text ?? "").matchAll(accountPattern())) {
        const value = match[4] ?? match[5]
        if (isAccountValue(value) && !learned.has(value)) learned.set(value, placeholderFor(value, match[4] !== undefined ? "name" : undefined))
      }
    },
    redact(text) {
      let out = text.replace(accountPattern(), (whole, phrase, gap, quote, quoted, bare) => {
        const value = quoted ?? bare
        if (!isAccountValue(value)) return whole
        count++
        const placeholder = learned.get(value) ?? placeholderFor(value, quoted !== undefined ? "name" : undefined)
        return `${phrase}${gap}${quote ?? ""}${placeholder}${quote ?? ""}`
      })
      for (const [value, placeholder] of [...learned].sort((a, b) => b[0].length - a[0].length)) {
        out = out.replace(new RegExp(`(?<![\\w@.-])${literal(value)}(?![\\w@-])`, "g"), () => {
          count++
          return placeholder
        })
      }
      return out
    },
  }
}

/** A JSON value with every string passed through `fn`. */
export const mapStrings = (value, fn) =>
  typeof value === "string" ? fn(value) : Array.isArray(value) ? value.map((item) => mapStrings(item, fn)) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)])) : value

/** Patterns that look like a credential. The fixture must contain none of them, nor the token in use. */
const SECRET_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\btvly-[A-Za-z0-9]{16,}/,
]

/** Throws when the text holds one of `secrets` or anything shaped like a credential. */
export function assertNoSecrets(value, secrets = []) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  for (const secret of secrets) if (secret && secret.length >= 8 && text.includes(secret)) throw new Error("capture-tools: refusing to write: the output contains the credential in use")
  for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) throw new Error(`capture-tools: refusing to write: the output contains something shaped like a credential (${pattern.source.slice(0, 24)}…)`)
}

/** A minimal MCP client over streamable HTTP that can only send the allowed methods. */
export function mcpClient({ endpoint, token, fetchImpl = fetch, timeoutMs = 30_000 }) {
  let sessionId
  let protocol = PROTOCOL_VERSION
  let nextId = 1
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": protocol,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  })
  async function send(method, params, { notification = false } = {}) {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`capture-tools: refused ${method}: only ${[...ALLOWED_METHODS].join(", ")} are sent`)
    const id = notification ? undefined : nextId++
    const body = JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) })
    const response = await fetchImpl(endpoint, { method: "POST", headers: headers(), body, signal: AbortSignal.timeout(timeoutMs) })
    const session = response.headers.get("mcp-session-id")
    if (session) sessionId = session
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel?.()
      throw new Skip(`${method} answered ${response.status}: the server needs a valid sign-in`)
    }
    if (notification) {
      await response.body?.cancel?.()
      if (!response.ok && response.status !== 202) throw new Error(`capture-tools: ${method} answered ${response.status}`)
      return undefined
    }
    const text = await response.text()
    if (!response.ok) throw new Error(`capture-tools: ${method} answered ${response.status}`)
    const message = messagesOf(text, response.headers.get("content-type")).find((item) => item && item.id === id)
    if (!message) throw new Error(`capture-tools: ${method}: no JSON-RPC answer with id ${id}`)
    if (message.error) throw new Error(`capture-tools: ${method}: error ${message.error.code} ${String(message.error.message).slice(0, 120)}`)
    return message.result
  }
  return {
    /** The guarded sender itself, exposed so tests can show the guard refuses before sending. */
    send,
    async list() {
      const init = await send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "opencode-family-capture-tools", version: "1" } })
      if (typeof init?.protocolVersion === "string") protocol = init.protocolVersion
      await send("notifications/initialized", undefined, { notification: true })
      const pages = []
      let cursor
      do {
        const page = await send("tools/list", cursor ? { cursor } : {})
        pages.push(page)
        cursor = page?.nextCursor
        if (pages.length > 100) throw new Error("capture-tools: more than 100 tools/list pages")
      } while (cursor)
      return { init, pages }
    },
    async close() {
      if (!sessionId) return
      await fetchImpl(endpoint, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(10_000) })
        .then((response) => response.body?.cancel?.())
        .catch(() => undefined)
    },
  }
}

/** The running OpenCode server: version, the MCP server's row, and its active credential (memory only). */
export async function fromOpenCode({ base, password, server, directory, fetchImpl = fetch }) {
  const auth = password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}
  const get = async (path) => {
    const response = await fetchImpl(new URL(path, base), { headers: auth, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Skip(`OpenCode ${path.split("?")[0]} answered ${response.status}`)
    return response.json()
  }
  const where = `?directory=${encodeURIComponent(directory)}`
  const info = await get(`/api/info`)
  const listed = await get(`/api/mcp${where}`)
  const rows = Array.isArray(listed) ? listed : listed.data ?? []
  const row = rows.find((item) => item.name === server)
  if (!row) throw new Skip(`OpenCode has no MCP server named ${server}`)
  if (row.status?.status !== "connected") throw new Skip(`OpenCode's ${server} server is ${row.status?.status ?? "unknown"}; sign in first`)
  let credential
  if (row.integrationID) {
    const all = await get(`/api/credential${where}`)
    const list = Array.isArray(all) ? all : all.data ?? []
    const mine = list.filter((item) => item.integrationID === row.integrationID)
    credential = mine.find((item) => item.active === true) ?? (mine.length === 1 ? mine[0] : undefined)
  }
  return { version: info.version ?? null, row, credential }
}

/** Runs one capture and returns the fixture. Never writes. */
export async function capture({ server, endpoint, tokenEnv, base = "http://127.0.0.1:4096", password, directory = process.cwd(), minTtlSeconds = 120, now = () => Date.now(), fetchImpl = fetch, log = () => {} }) {
  const host = await fromOpenCode({ base, password, server, directory, fetchImpl })
  const value = host.credential?.value
  const serverUrl = value?.metadata?.serverUrl
  const url = endpoint ?? serverUrl
  if (!url) throw new Skip(`no endpoint: pass --endpoint (the ${server} credential records no serverUrl)`)
  if (endpoint && serverUrl) {
    const path = (text) => {
      const parsed = new URL(text)
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`
    }
    if (path(endpoint) !== path(serverUrl)) throw new Error(`capture-tools: --endpoint ${endpoint} is not the URL the ${server} credential was issued for`)
  }
  const fresh = value?.type === "oauth" && typeof value.access === "string" && (value.expires === 0 || value.expires - now() > minTtlSeconds * 1000)
  // A key-based server (Tavily) whose key OpenCode reads from the environment: --token-env names the variable. On a
  // boxd machine it may hold a host-bound placeholder that the egress proxy swaps for the key on the way out.
  const token = fresh ? value.access : tokenEnv ? process.env[tokenEnv] || undefined : undefined
  let listing
  const auth = token ? "signed-in" : "anonymous"
  try {
    const client = mcpClient({ endpoint: url, token, fetchImpl })
    try {
      listing = await client.list()
    } finally {
      await client.close()
    }
  } catch (error) {
    if (error instanceof Skip && !token) {
      const why = value?.type === "oauth" ? "its access token has expired and this script never refreshes one; OpenCode refreshes it the next time the server is used" : "OpenCode holds no usable credential for it"
      throw new Skip(`${server}: ${error.message}; ${why}`)
    }
    throw error
  }
  log(`${server}: ${auth} tools/list, ${listing.pages.length} page(s)`)
  // The account's own values out first, so every digest is of the redacted text.
  const redactor = accountRedactor({ known: identityValues(value?.metadata) })
  const raw = listing.pages.flatMap((page) => page?.tools ?? [])
  redactor.learn(listing.init?.instructions)
  for (const { text } of stringsIn(raw)) redactor.learn(text)
  const tools = raw.map((tool) => recordTool(mapStrings(tool, (text) => redactor.redact(text)))).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const duplicates = tools.filter((tool, index) => index > 0 && tools[index - 1].name === tool.name).map((tool) => tool.name)
  if (duplicates.length) throw new Error(`capture-tools: the server listed ${duplicates.join(", ")} twice`)
  const fixture = {
    schema: FIXTURE_SCHEMA,
    evidence: "live-observed",
    note: "Captured by scripts/capture-tools.mjs from the server's own tools/list. Descriptions are public tool metadata, recorded in full, with the signed-in account's own values replaced by placeholders (redactions). No tool was called. No token, header, account id, server instructions or result text is recorded.",
    listedAt: new Date(now()).toISOString().slice(0, 10),
    server,
    namespace: namespaceOf(server),
    endpoint: url,
    auth,
    host: { opencode: host.version, via: "running OpenCode server: MCP status and active credential; raw MCP tools/list" },
    protocol: {
      version: listing.init?.protocolVersion ?? null,
      server: listing.init?.serverInfo ? { name: listing.init.serverInfo.name ?? null, version: listing.init.serverInfo.version ?? null } : null,
    },
    pages: listing.pages.length,
    count: tools.length,
    readOnlyHints: tools.filter((tool) => tool.readOnlyHint !== null).length,
    redactions: redactor.count,
    digest: toolsDigest(tools),
    tools,
  }
  assertNoSecrets(fixture, [value?.access, value?.refresh, value?.key, token])
  const text = JSON.stringify(fixture)
  for (const learned of redactor.learned.keys()) if (text.includes(learned)) throw new Error("capture-tools: refusing to write: a value of the signed-in account is still in the capture")
  for (const item of stringsIn(fixture)) if (accountValuesIn(item.text).length) throw new Error("capture-tools: refusing to write: an identity phrase is followed by a value that is not a placeholder")
  return fixture
}

/** Top-level parameter names of a Code Mode signature such as `tools.ns.tool({\n  /** doc *\/\n  url: string,\n  depth?: number,\n})`. */
export function paramsOfSignature(signature) {
  const text = String(signature ?? "").replace(/\/\*[\s\S]*?\*\//g, "")
  const start = text.indexOf("({")
  if (start === -1) return []
  const out = []
  let depth = 0
  let segment = ""
  let quote
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (depth === 1) segment += char
      if (char === "\\") index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      if (depth === 1) segment += char
      continue
    }
    if ("{[(<".includes(char)) {
      depth++
      if (depth === 1) continue
    } else if ("}])>".includes(char) && !(char === ">" && text[index - 1] === "=")) {
      depth--
      if (depth === 0) break
    }
    if (depth !== 1) continue
    if (char === "," || char === "\n" || char === ";") {
      segment = ""
      continue
    }
    segment += char
    const match = segment.match(/^\s*["']?([A-Za-z_$][\w$-]*)["']?\??:$/)
    if (match) {
      out.push(match[1])
      segment = "#"
    }
  }
  return out
}

/**
 * A Code Mode catalog dump `{ tools: [{ name, description?, signature? }] }` as a weaker fixture: names, digests of
 * the description and signature the engine shows the model (after the plugin's transforms), and parameter names.
 */
export function fromCatalog({ server, dump, opencode = null, listedAt }) {
  const tools = dump.tools
    .map((tool) => ({
      ...tool,
      ...(typeof tool.description === "string" ? { descriptionSha256: sha256(tool.description), descriptionLength: tool.description.length } : {}),
      ...(typeof tool.signature === "string" ? { signatureSha256: sha256(tool.signature), params: paramsOfSignature(tool.signature) } : {}),
    }))
    .map((tool) => ({
      name: tool.name,
      readOnlyHint: null,
      destructiveHint: null,
      idempotentHint: null,
      openWorldHint: null,
      annotations: null,
      inputSchema: null,
      description: tool.descriptionSha256 ? { sha256: tool.descriptionSha256, length: tool.descriptionLength ?? null, text: null, transformed: true } : null,
      ...(tool.signatureSha256 ? { signatureSha256: tool.signatureSha256 } : {}),
      ...(Array.isArray(tool.params) ? { inputParams: tool.params } : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  return {
    schema: FIXTURE_SCHEMA,
    evidence: "catalog",
    note: "Names (and digests of the description and signature the engine shows the model, after the plugin's own transforms) from Code Mode's search({ namespace }). No annotations and no JSON schemas: this does not satisfy the release gate.",
    listedAt,
    server,
    namespace: namespaceOf(server),
    endpoint: null,
    auth: "none",
    host: { opencode, via: "Code Mode catalog" },
    protocol: null,
    pages: 0,
    count: tools.length,
    readOnlyHints: 0,
    digest: toolsDigest(tools),
    tools,
  }
}

/** Differences between two fixtures' tool lists. */
export function diffTools(before, after) {
  const map = (list) => new Map(list.map((tool) => [tool.name, tool]))
  const a = map(before)
  const b = map(after)
  const changed = (key) => [...b.keys()].filter((name) => a.has(name) && canonical(a.get(name)[key]) !== canonical(b.get(name)[key]))
  return {
    added: [...b.keys()].filter((name) => !a.has(name)),
    removed: [...a.keys()].filter((name) => !b.has(name)),
    readOnlyHint: [...b.keys()].filter((name) => a.has(name) && a.get(name).readOnlyHint !== b.get(name).readOnlyHint),
    destructiveHint: [...b.keys()].filter((name) => a.has(name) && a.get(name).destructiveHint !== b.get(name).destructiveHint),
    inputSchema: changed("inputSchema"),
    description: [...b.keys()].filter((name) => a.has(name) && a.get(name).description?.sha256 !== b.get(name).description?.sha256),
  }
}

/** The provenance entry for a fixture, merged into an existing provenance.json. */
export function provenanceWith(existing, fixture, { file = "live-tools.json", source = "scripts/capture-tools.mjs" } = {}) {
  const entry = {
    fixture: file,
    evidence: fixture.evidence,
    listedAt: fixture.listedAt,
    server: fixture.server,
    endpoint: fixture.endpoint,
    source: `${source}${fixture.auth === "signed-in" ? ", signed in" : fixture.auth === "anonymous" ? ", no sign-in" : ""}`,
    host: fixture.host.opencode,
    protocol: fixture.protocol?.version ?? null,
    count: fixture.count,
    redactions: fixture.redactions ?? 0,
    annotations: fixture.readOnlyHints === fixture.count ? "every tool" : fixture.readOnlyHints === 0 ? "none" : `${fixture.readOnlyHints} of ${fixture.count}`,
    schemas: fixture.tools.every((tool) => tool.inputSchema) ? "recorded" : "not recorded",
    digest: { algorithm: "sha256", of: "canonical JSON of the recorded tools, sorted by name", value: fixture.digest },
  }
  const captures = [...(existing?.captures ?? []).filter((item) => item.fixture !== file), entry]
  // A waiver of the release gate's age limit is for the capture it names; a new capture replaces that one.
  const kept = { ...(existing ?? {}) }
  delete kept.waiver
  return {
    ...kept,
    captures,
    live: fixture.evidence === "live-observed" ? { fixture: file, listedAt: fixture.listedAt } : existing?.live ?? null,
    note: existing?.note ?? "Digests are for drift detection, not a security signature. live names the newest live-observed capture, which the release gate requires to be at most 14 days old unless a waiver names it.",
  }
}

export function writeFixture(dir, fixture, secrets = []) {
  mkdirSync(dir, { recursive: true })
  const text = `${JSON.stringify(fixture, null, 2)}\n`
  assertNoSecrets(text, secrets)
  writeFileSync(join(dir, "live-tools.json"), text)
  const path = join(dir, "provenance.json")
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined
  writeFileSync(path, `${JSON.stringify(provenanceWith(existing, fixture), null, 2)}\n`)
}

function parseArgs(argv) {
  const out = { flags: new Set() }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`)
    const key = arg.slice(2)
    if (["check", "help"].includes(key)) out.flags.add(key)
    else out[key] = argv[++index]
  }
  return out
}

async function main(argv) {
  const args = parseArgs(argv)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const out = resolve(args.out ?? join(root, "test", "fixtures"))
  // With no --server, the server the committed capture names.
  if (!args.server && existsSync(join(out, "live-tools.json"))) args.server = JSON.parse(readFileSync(join(out, "live-tools.json"), "utf8")).server
  if (args.flags.has("help") || !args.server) {
    console.error("usage: node scripts/capture-tools.mjs [--server <name>] [--endpoint <url>] [--out <dir>] [--check] [--min-ttl <seconds>] | --catalog <file> --server <name> [--out <dir>]")
    return 2
  }
  if (args.catalog) {
    const dump = JSON.parse(readFileSync(args.catalog, "utf8"))
    const fixture = fromCatalog({ server: args.server, dump, opencode: dump.opencode ?? null, listedAt: dump.listedAt ?? new Date().toISOString().slice(0, 10) })
    writeFixture(out, fixture)
    console.log(`Wrote ${join(out, "live-tools.json")}: ${fixture.count} tools from the Code Mode catalog (names only).`)
    return 0
  }
  const fixture = await capture({
    server: args.server,
    endpoint: args.endpoint,
    tokenEnv: args["token-env"],
    base: process.env.OPENCODE_SERVER ?? "http://127.0.0.1:4096",
    password: process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD,
    directory: args.directory ?? process.cwd(),
    minTtlSeconds: Number(args["min-ttl"] ?? 120),
    log: (line) => console.log(line),
  })
  if (args.flags.has("check")) {
    const committed = join(out, "live-tools.json")
    if (!existsSync(committed)) throw new Error(`no ${committed} to compare with`)
    const changes = diffTools(JSON.parse(readFileSync(committed, "utf8")).tools, fixture.tools)
    console.log(JSON.stringify(changes, null, 2))
    return Object.values(changes).some((list) => list.length) ? 1 : 0
  }
  writeFixture(out, fixture)
  console.log(`Wrote ${join(out, "live-tools.json")}: ${fixture.count} tools (${fixture.readOnlyHints} with readOnlyHint) from ${fixture.endpoint}, ${fixture.auth}.`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Skip ? `skipped: ${error.message}` : error instanceof Error ? error.message : String(error))
      process.exit(error instanceof Skip ? 3 : 2)
    },
  )
}
