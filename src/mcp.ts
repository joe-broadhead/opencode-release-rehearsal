import type { Mcp, Plugin } from "@opencode/plugin"
import { resolveKey, type TavilyKey } from "./credential.js"

export const SERVER_NAME = "tavily"
export const SERVER_URL = "https://mcp.tavily.com/mcp/"

/** What the transform and the credential watcher know; status reads it. */
export interface ServerState {
  key: TavilyKey | undefined
  /** The user's config already defines a `tavily` server, which the plugin leaves untouched. */
  userServer: boolean
  /** That server is at Tavily's URL, so the tools RPC may call it: it is Tavily, whatever its sign-in. */
  userServerAtTavily: boolean
}

/** True for a remote server at Tavily's URL, with or without the final slash or a query such as `?tavilyApiKey=`. */
export function isTavilyServer(config: Mcp.ServerConfig): boolean {
  if (config.type !== "remote") return false
  const path = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, "")}`
  try {
    return path(new URL(config.url)) === path(new URL(SERVER_URL))
  } catch {
    return false
  }
}

export function serverConfig(input: { readonly key?: string; readonly executionTimeoutMs: number }): Mcp.ServerConfig {
  const config = { type: "remote", url: SERVER_URL, timeout: { execution: input.executionTimeoutMs } } as const
  if (input.key === undefined) return config
  return { ...config, oauth: false, headers: { Authorization: `Bearer ${input.key}` } }
}

export function registerServer(mcp: Pick<Plugin.Context["mcp"], "transform">, state: ServerState, executionTimeoutMs: number) {
  return mcp.transform((editor) => {
    const own = editor.get(SERVER_NAME)
    state.userServer = own !== undefined
    state.userServerAtTavily = own !== undefined && isTavilyServer(own)
    if (own) return
    editor.set(SERVER_NAME, serverConfig({ key: state.key?.key, executionTimeoutMs }))
  })
}

/** Resolves the key; when OpenCode cannot read it, warns without the key and keeps `fallback`. */
export function readKey(
  integration: Pick<Plugin.Context["integration"], "connection">,
  fallback: TavilyKey | undefined,
  warn: (message: string) => void,
) {
  return resolveKey(integration).catch((error: unknown) => {
    warn(
      `KEY_UNAVAILABLE: OpenCode could not read the Tavily API key (${message(error)}). Next step: Run /connect and choose Tavily, then connect the key again.`,
    )
    return fallback
  })
}

const CREDENTIAL_EVENTS = ["credential.updated", "credential.switched", "integration.updated"] as const

/** Re-resolves the key on credential events and reloads the server only when the key itself changes. */
export async function watchKey(
  ctx: {
    readonly event: Plugin.Context["event"]
    readonly integration: Pick<Plugin.Context["integration"], "connection">
    readonly mcp: Pick<Plugin.Context["mcp"], "reload">
  },
  state: ServerState,
  signal: AbortSignal,
  warn: (message: string) => void,
) {
  try {
    for await (const _ of ctx.event.subscribe({ types: CREDENTIAL_EVENTS, signal })) {
      const next = await readKey(ctx.integration, state.key, warn)
      const changed = next?.key !== state.key?.key
      state.key = next
      if (changed) await ctx.mcp.reload()
    }
  } catch (error) {
    if (signal.aborted) return
    warn(
      `KEY_WATCH_STOPPED: The plugin stopped watching for Tavily key changes (${message(error)}). Next step: Restart OpenCode after you change the key.`,
    )
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
