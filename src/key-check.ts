/**
 * Tavily's usage endpoint. It answers 401 for a key that Tavily does not accept and costs no credits. The MCP server
 * cannot tell: it accepts any bearer token at `initialize` and `tools/list`, and reports a rejected key only inside
 * each tool result, so a server with a wrong key still shows as connected.
 */
const USAGE_URL = "https://api.tavily.com/usage"

/** `unchecked`: Tavily's API could not be reached, or gave an answer that says nothing about the key. */
export type KeyCheck = "accepted" | "rejected" | "unchecked"

export type KeyChecker = (key: string) => Promise<KeyCheck>

const TIMEOUT_MS = 5_000

/** Asks Tavily whether it accepts `key`. Never throws, and nothing it returns or logs contains the key. */
export async function checkKey(key: string, fetcher: typeof fetch = fetch): Promise<KeyCheck> {
  try {
    const response = await fetcher(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    await response.body?.cancel().catch(() => undefined)
    if (response.ok) return "accepted"
    return response.status === 401 || response.status === 403 ? "rejected" : "unchecked"
  } catch {
    return "unchecked"
  }
}

/** Checks each key once. A check that ends `unchecked` runs again on the next call, so a passing outage clears. */
export function keyChecker(fetcher: typeof fetch = fetch): KeyChecker {
  let current: { readonly key: string; readonly result: Promise<KeyCheck> } | undefined
  return (key) => {
    if (current?.key !== key) current = { key, result: checkKey(key, fetcher) }
    const mine = current
    return mine.result.then((result) => {
      if (result === "unchecked" && current === mine) current = undefined
      return result
    })
  }
}
