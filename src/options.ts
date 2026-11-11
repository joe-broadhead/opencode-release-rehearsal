import type { PluginOptions } from "@opencode/plugin"

/** What the default rules allow. `all` is the default; the other two are how a user restricts the plugin. */
export type Access = "all" | "ask-changes" | "read-only"

const ACCESS_VALUES: readonly Access[] = ["all", "ask-changes", "read-only"]

interface Options {
  /** Select the built-in Tavily provider as the web search default when config has no choice. */
  readonly websearch: boolean
  /** MCP execution wall time in milliseconds. */
  readonly executionTimeoutMs: number
  /** Run on an OpenCode version outside the tested range, with a warning. */
  readonly allowUntestedHost: boolean
  /** What the generated default rules allow: everything, changes ask, or read-only. */
  readonly access: Access
}

const DEFAULT_OPTIONS: Options = {
  websearch: true,
  executionTimeoutMs: 900_000,
  allowUntestedHost: false,
  access: "all",
}

const MIN_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 3_600_000
// `access` is checked below: it is a string, not one of the booleans or the timeout.
const KEYS = Object.keys(DEFAULT_OPTIONS)

const invalid = (what: string) =>
  new Error(`OPTIONS_INVALID: ${what}. Next step: Fix the plugin's options in opencode.json.`)

const boolean = (input: PluginOptions, key: "websearch" | "allowUntestedHost") => {
  const value = input[key]
  if (value === undefined) return DEFAULT_OPTIONS[key]
  if (typeof value !== "boolean") throw invalid(`"${key}" must be true or false`)
  return value
}

export function parseOptions(input: PluginOptions): Options {
  for (const key of Object.keys(input)) if (!KEYS.includes(key)) throw invalid(`Unknown option "${key}"; the options are ${KEYS.join(", ")}`)
  const timeout = input.executionTimeoutMs === undefined ? DEFAULT_OPTIONS.executionTimeoutMs : input.executionTimeoutMs
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS)
    throw invalid(`"executionTimeoutMs" must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`)
  const access = input.access === undefined ? DEFAULT_OPTIONS.access : input.access
  if (typeof access !== "string" || !(ACCESS_VALUES as readonly string[]).includes(access))
    throw invalid(`"access" must be "all", "ask-changes" or "read-only"`)
  return {
    websearch: boolean(input, "websearch"),
    executionTimeoutMs: timeout,
    allowUntestedHost: boolean(input, "allowUntestedHost"),
    access: access as Access,
  }
}
