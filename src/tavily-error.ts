/**
 * Tavily's hosted server answers some failures as an ordinary result, not as an MCP error: a JSON object such as
 * `{"error":"Map failed","status":429,"detail":{"error":"Your request has been blocked…"}}`. A model or a script
 * would read that as data. This module recognises the object and gives the error and the next step.
 */
export interface TavilyError {
  /** Tavily's HTTP status, 400 or more. */
  readonly status: number
  /** Tavily's own words: its `error`, then its `detail`'s, when they differ. */
  readonly message: string
  readonly next: string
}

/** Tavily's error objects are small; a result longer than this is data, and is not parsed. */
const MAX_ERROR_TEXT = 16_384

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const words = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined
  if (record(value)) return words(value["error"]) ?? words(value["message"])
  return undefined
}

/** The next step for Tavily's status codes, as its API reference documents them. */
function nextStep(status: number) {
  if (status === 429) return "Wait a minute, then retry; if it keeps happening, check your Tavily plan and API key at https://app.tavily.com."
  if (status === 432 || status === 433)
    return "Check your Tavily plan's usage and limits at https://app.tavily.com; a retry fails until the limit resets or the plan changes."
  // 403 too: the key check (src/key-check.ts) counts it as a rejected key.
  if (status === 401 || status === 403) return "Run /tavily-status and follow its next step to sign in again or replace the key."
  if (status >= 500) return "Wait a minute, then retry; Tavily had a problem on its side."
  return "Check the input against the tool's schema, then retry with a corrected input."
}

/** Tavily's error object: an integer `status` of 400 or more, together with an `error`. */
export function tavilyErrorOf(value: unknown): TavilyError | undefined {
  if (!record(value)) return undefined
  const status = value["status"]
  const error = words(value["error"])
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || error === undefined) return undefined
  const detail = words(value["detail"])
  const message = detail === undefined || detail === error ? error : `${error}: ${detail}`
  return { status, message, next: nextStep(status) }
}

/** Tavily's error object in a tool result: its structured content, or its text when that is one JSON object. */
export function tavilyErrorIn(output: unknown, text: string): TavilyError | undefined {
  const structured = tavilyErrorOf(output)
  if (structured) return structured
  const trimmed = text.trim()
  if (trimmed.length > MAX_ERROR_TEXT || !trimmed.startsWith("{")) return undefined
  try {
    return tavilyErrorOf(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}

/** Tavily's status and its words, without a final full stop. */
export const tavilyErrorLine = (error: TavilyError) => `Tavily answered with error ${error.status}: ${error.message.replace(/[.\s]+$/, "")}`

/** The text a model receives instead of Tavily's error object. */
export const modelText = (tool: string, error: TavilyError) =>
  `UPSTREAM_ERROR: ${tool} failed: ${tavilyErrorLine(error)}. This is an error from Tavily, not a result. Next step: ${error.next}`
