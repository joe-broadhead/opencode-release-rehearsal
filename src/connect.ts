import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { INTEGRATION_ID } from "./credential.js"
import type { KeyChecker } from "./key-check.js"
import { SERVER_NAME, SERVER_URL, type ServerState } from "./mcp.js"

/** OpenCode's built-in key integration is "Tavily" in /connect; the server's OAuth integration gets this name. */
const OAUTH_NAME = "Tavily account"

/** OpenCode's id for a remote server's OAuth integration: `mcp_` and 16 hex digits of the SHA-1 of name, NUL, URL. */
const OAUTH_INTEGRATION_ID = `mcp_${createHash("sha1").update(`${SERVER_NAME}\u0000${SERVER_URL}`).digest("hex").slice(0, 16)}`

/** What /connect shows on the Tavily entry for a connected key that Tavily rejects. */
const KEY_REJECTED = "Tavily did not accept this API key. Replace it, or remove it to sign in with your Tavily account."

// OpenCode registers the OAuth integration only after plugin setup, and a subscription has no start
// acknowledgement, so the first seconds are also polled.
const STARTUP_MS = 10_000
const POLL_MS = 250

type Ctx = {
  readonly event: Plugin.Context["event"]
  readonly integration: Pick<Plugin.Context["integration"], "get" | "transform" | "connection">
  readonly mcp: Pick<Plugin.Context["mcp"], "list">
}

/**
 * Keeps what /connect shows right:
 * - the server's OAuth integration is named "Tavily account", not "tavily". OpenCode's own transform sets the name, and it
 *   registers that transform again on every MCP reload, after the plugin's. So the plugin registers its rename again,
 *   after OpenCode's, whenever it finds the name reset.
 * - a connected key that Tavily rejects shows "Sign in required" on the Tavily entry, until the key is replaced. Tavily's
 *   MCP server connects with any key, so the key check decides, as well as a server that asks for sign-in.
 */
export async function watchConnect(ctx: Ctx, state: ServerState, checkKey: KeyChecker, signal: AbortSignal) {
  let rename: Awaited<ReturnType<Ctx["integration"]["transform"]>> | undefined
  let flagged = false

  const applyName = async () => {
    if (state.userServer || signal.aborted) return
    const info = await ctx.integration.get({ integrationID: OAUTH_INTEGRATION_ID }).catch(() => undefined)
    if (!info || info.data.name === OAUTH_NAME) return
    const previous = rename
    rename = await ctx.integration.transform((editor) => {
      if (editor.get(OAUTH_INTEGRATION_ID)) editor.update(OAUTH_INTEGRATION_ID, (ref) => void (ref.name = OAUTH_NAME))
    })
    await previous?.dispose()
  }
  // One rename at a time: the startup poll and the events both ask.
  let naming = Promise.resolve()
  const name = () => (naming = naming.then(applyName).catch(() => undefined))

  const report = async () => {
    const server = (await ctx.mcp.list()).data.find((entry) => entry.name === SERVER_NAME)
    // Every key is checked, so status has the answer early; only a connected key has an entry to mark.
    const key = state.key
    const check = key && (await checkKey(key.key))
    const rejected = key?.source === "connected" && (server?.status.status === "needs_auth" || check === "rejected")
    if (rejected === flagged) return
    const connection = await ctx.integration.connection.active(INTEGRATION_ID)
    if (connection?.type !== "credential") return
    await ctx.integration.connection.status({
      integrationID: INTEGRATION_ID,
      connection,
      status: rejected ? { status: "needs_auth", message: KEY_REJECTED } : undefined,
    })
    flagged = rejected
  }

  const startup = (async () => {
    for (const until = Date.now() + STARTUP_MS; !signal.aborted && Date.now() < until; ) {
      await name()
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  })()
  try {
    for await (const event of ctx.event.subscribe({ types: ["integration.updated", "mcp.status.changed"], signal })) {
      if (event.type === "integration.updated") await name()
      else if (event.data.server === SERVER_NAME) await report().catch(() => undefined)
    }
  } catch {
    // The stream ends with the plugin; nothing on /connect depends on the plugin to work.
  }
  await startup
  await rename?.dispose()
}
