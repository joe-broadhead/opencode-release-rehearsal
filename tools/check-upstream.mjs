// Maintainer-run drift check: lists the tools of Tavily's hosted MCP server without a key and compares them with the
// tools the plugin knows (the five reads its default rules allow). It only warns: it always exits 0, and nothing
// depends on it at runtime. A new tool asks before it runs; a removed tool leaves a harmless allow rule.
//
// Usage: bun tools/check-upstream.mjs [endpoint]    (default: the plugin's server URL)
import { SERVER_NAME, SERVER_URL } from "../src/mcp.ts"
import { KNOWN_ACTIONS } from "../src/permissions.ts"

const PROTOCOL = "2025-03-26"
/** Bounds the whole check, however many pages the tool list has. */
const LIMIT_MS = 30_000

const endpoint = process.argv[2] ?? SERVER_URL
const known = KNOWN_ACTIONS.map((action) => action.slice(`${SERVER_NAME}_`.length))

/** Reads the JSON-RPC reply with `id` from a JSON or Server-Sent Events response. */
async function reply(response, id) {
  const text = await response.text()
  const type = response.headers.get("content-type") ?? ""
  const messages = type.includes("text/event-stream")
    ? text
        .replace(/\r\n/g, "\n")
        .split("\n\n")
        .map((event) => event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"))
        .filter(Boolean)
        .map((data) => JSON.parse(data))
    : [JSON.parse(text)]
  const message = messages.find((candidate) => candidate?.id === id)
  if (!message) throw new Error(`no reply to request ${id}`)
  if (message.error) throw new Error(`${message.error.message ?? "error"} (code ${message.error.code})`)
  return message.result
}

async function listTools(signal) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-tavily-access-mode": "keyless" }
  let id = 0
  const post = async (method, params, notification = false) => {
    const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal })
    if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`)
    if (notification) return void (await response.body?.cancel())
    const session = response.headers.get("mcp-session-id")
    if (session) headers["mcp-session-id"] = session
    return reply(response, body.id)
  }
  const init = await post("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "opencode-tavily-check-upstream", version: "0" } })
  headers["mcp-protocol-version"] = init.protocolVersion ?? PROTOCOL
  await post("notifications/initialized", {}, true)
  const tools = []
  let cursor
  do {
    const result = await post("tools/list", cursor === undefined ? {} : { cursor })
    tools.push(...(result.tools ?? []))
    cursor = result.nextCursor
  } while (cursor)
  if (headers["mcp-session-id"]) await fetch(endpoint, { method: "DELETE", headers, signal }).catch(() => {})
  return { server: init.serverInfo, names: tools.map((tool) => tool.name) }
}

console.log(`Tavily server drift check: ${endpoint} (keyless)`)
try {
  const { server, names } = await listTools(AbortSignal.timeout(LIMIT_MS))
  const added = names.filter((name) => !known.includes(name))
  const removed = known.filter((name) => !names.includes(name))
  console.log(`Server: ${server?.name ?? "unknown"} ${server?.version ?? ""}, ${names.length} tools: ${names.join(", ")}`)
  if (added.length === 0 && removed.length === 0) console.log(`No drift: Tavily lists exactly the ${known.length} tools the plugin knows.`)
  if (added.length > 0)
    console.log(`Warning: added upstream: ${added.join(", ")}. They ask before running; review them and add the reads to KNOWN_ACTIONS in src/permissions.ts.`)
  if (removed.length > 0)
    console.log(`Warning: removed upstream: ${removed.join(", ")}. Remove them from KNOWN_ACTIONS in src/permissions.ts and the skills.`)
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)
  console.log(`Warning: could not list Tavily's tools (${reason}). Try again later; this check never fails.`)
}
process.exitCode = 0
