import type { Plugin } from "@opencode/plugin"

/** OpenCode's built-in Tavily web search provider. The plugin adds no provider of its own. */
const PROVIDER_ID = "tavily"

export interface WebsearchState {
  /** This plugin selected Tavily, or found it already selected by an earlier plugin. */
  tavilyDefault: boolean
}

/**
 * Selects the built-in provider when nothing earlier chose one. OpenCode applies a `websearch` choice from
 * opencode.json after plugins, so that choice still wins; the plugin cannot see it.
 */
export function selectWebsearchDefault(websearch: Pick<Plugin.Context["websearch"], "transform">, state: WebsearchState) {
  return websearch.transform((editor) => {
    const selected = editor.default.get()
    if (selected === undefined) editor.default.set(PROVIDER_ID)
    state.tavilyDefault = (selected ?? PROVIDER_ID) === PROVIDER_ID
  })
}
