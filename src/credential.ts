import type { Plugin } from "@opencode/plugin"

/** OpenCode's built-in Tavily integration: `/connect` → Tavily, `opencode auth login tavily` or `TAVILY_API_KEY`. */
export const INTEGRATION_ID = "tavily"

export interface TavilyKey {
  readonly key: string
  readonly source: "connected" | "env"
  /** The saved credential's label, never the key. */
  readonly label?: string
}

/** Reads the active key of the built-in integration. The key stays in memory and is never logged. */
export async function resolveKey(integration: Pick<Plugin.Context["integration"], "connection">) {
  const connection = await integration.connection.active(INTEGRATION_ID)
  if (!connection) return undefined
  const value = await integration.connection.resolve(connection)
  if (value?.type !== "key") return undefined
  const key: TavilyKey =
    connection.type === "env"
      ? { key: value.key, source: "env" }
      : { key: value.key, source: "connected", label: connection.label }
  return key
}
