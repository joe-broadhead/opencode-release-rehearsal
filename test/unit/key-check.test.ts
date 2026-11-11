import { describe, expect, test } from "bun:test"
import { checkKey, keyChecker } from "../../src/key-check.js"
import { terminalKeyText, type Status } from "../../src/rpc/index.js"

/** A fetch that answers each request with the next status, or throws for `"throw"`. */
function fakeFetch(answers: (number | "throw")[]) {
  const requests: { url: string; authorization: string | null }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
    const answer = answers.shift() ?? 500
    if (answer === "throw") throw new Error("network down for tvly-secret")
    return new Response("{}", { status: answer })
  }) as typeof fetch
  return { fetcher, requests }
}

describe("checkKey", () => {
  test("asks Tavily's usage endpoint with the key as a bearer token", async () => {
    const { fetcher, requests } = fakeFetch([200])
    expect(await checkKey("tvly-secret", fetcher)).toBe("accepted")
    expect(requests).toEqual([{ url: "https://api.tavily.com/usage", authorization: "Bearer tvly-secret" }])
  })

  test("401 and 403 reject the key; anything else, or no answer, leaves it unchecked", async () => {
    const { fetcher } = fakeFetch([401, 403, 429, 500, "throw"])
    const results = []
    for (let i = 0; i < 5; i++) results.push(await checkKey("tvly-secret", fetcher))
    expect(results).toEqual(["rejected", "rejected", "unchecked", "unchecked", "unchecked"])
  })
})

describe("keyChecker", () => {
  test("checks each key once and checks again when the key changes", async () => {
    const { fetcher, requests } = fakeFetch([200, 401])
    const check = keyChecker(fetcher)
    expect(await Promise.all([check("tvly-a"), check("tvly-a")])).toEqual(["accepted", "accepted"])
    expect(await check("tvly-a")).toBe("accepted")
    expect(await check("tvly-b")).toBe("rejected")
    expect(await check("tvly-b")).toBe("rejected")
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer tvly-a", "Bearer tvly-b"])
  })

  test("an unchecked result is retried on the next call", async () => {
    const { fetcher, requests } = fakeFetch(["throw", 200])
    const check = keyChecker(fetcher)
    expect(await check("tvly-a")).toBe("unchecked")
    expect(await check("tvly-a")).toBe("accepted")
    expect(await check("tvly-a")).toBe("accepted")
    expect(requests).toHaveLength(2)
  })
})

describe("terminalKeyText", () => {
  const status = (auth: Status["auth"]): Status => ({
    version: "0.0.0",
    state: "connected",
    access: "all",
    auth,
    tools: { visible: 5, unknown: 0, unknownNames: [] },
    websearchDefault: true,
    host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true },
    unguardedAgents: [],
    nextStep: "Nothing to do.",
  })

  test("only when the terminal has TAVILY_API_KEY and the server uses no key", () => {
    expect(terminalKeyText(status("oauth"), true)).toBe(
      "TAVILY_API_KEY is set in this terminal, but OpenCode's server does not see it, so Tavily uses OAuth. Run /connect and choose Tavily to connect the key.",
    )
    expect(terminalKeyText(status("none"), true)).toBeDefined()
    expect(terminalKeyText(status("oauth"), false)).toBeUndefined()
    for (const auth of ["key_connected", "key_env", "user_server"] as const) expect(terminalKeyText(status(auth), true)).toBeUndefined()
  })
})
