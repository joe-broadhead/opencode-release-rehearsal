import { describe, expect, test } from "bun:test"
import { resolveKey } from "../../src/credential.js"
import { isTavilyServer, readKey, registerServer, serverConfig, SERVER_URL, watchKey, type ServerState } from "../../src/mcp.js"
import {
  envConnection,
  events,
  integration,
  keyConnection,
  keyValue,
  mcpEditor,
  settle,
  transforms,
  type EditorOf,
} from "./fake.js"
import type { Plugin } from "@opencode/plugin"

type McpEditor = EditorOf<Plugin.Context["mcp"]>

describe("resolveKey", () => {
  test("no active connection means no key", async () => {
    const { domain, state } = integration({})
    expect(await resolveKey(domain)).toBeUndefined()
    expect(state.resolves).toBe(0)
  })

  test("a saved key carries its label", async () => {
    const { domain } = integration({ connection: keyConnection("Work"), value: keyValue("tvly-saved") })
    expect(await resolveKey(domain)).toEqual({ key: "tvly-saved", source: "connected", label: "Work" })
  })

  test("an environment key has no label", async () => {
    const { domain } = integration({ connection: envConnection(), value: keyValue("tvly-env") })
    expect(await resolveKey(domain)).toEqual({ key: "tvly-env", source: "env" })
  })

  test("a credential that is not a key is ignored", async () => {
    const { domain } = integration({
      connection: keyConnection(),
      value: { type: "external", methodID: "x" as never },
    })
    expect(await resolveKey(domain)).toBeUndefined()
  })
})

describe("readKey", () => {
  test("an unreadable key falls back and warns without the key", async () => {
    const { domain, state } = integration({ connection: keyConnection() })
    state.fail = new Error("store locked")
    const warnings: string[] = []
    expect(await readKey(domain, undefined, (message) => warnings.push(message))).toBeUndefined()
    expect(warnings).toEqual([
      "KEY_UNAVAILABLE: OpenCode could not read the Tavily API key (store locked). Next step: Run /connect and choose Tavily, then connect the key again.",
    ])
  })
})

describe("serverConfig", () => {
  test("without a key, OpenCode's MCP OAuth signs in", () => {
    const config = serverConfig({ executionTimeoutMs: 900_000 })
    expect(config).toEqual({ type: "remote", url: SERVER_URL, timeout: { execution: 900_000 } })
    expect(SERVER_URL).toBe("https://mcp.tavily.com/mcp/")
  })

  test("with a key, OAuth is off and the key is a bearer header", () => {
    expect(serverConfig({ key: "tvly-abc", executionTimeoutMs: 60_000 })).toEqual({
      type: "remote",
      url: SERVER_URL,
      timeout: { execution: 60_000 },
      oauth: false,
      headers: { Authorization: "Bearer tvly-abc" },
    })
  })

  test("never sets protocol, capabilities or responsePolicy", () => {
    for (const config of [serverConfig({ executionTimeoutMs: 1 }), serverConfig({ key: "k", executionTimeoutMs: 1 })])
      for (const field of ["protocol", "capabilities", "responsePolicy", "codemode"]) expect(config).not.toHaveProperty(field)
  })
})

describe("registerServer", () => {
  test("registers tavily, and replays with the current key on every rebuild", async () => {
    const mcp = transforms<McpEditor>()
    const state: ServerState = { key: undefined, userServer: false, userServerAtTavily: false }
    await registerServer(mcp, state, 900_000)

    const first = mcpEditor()
    mcp.run(first.editor)
    expect(first.servers.get("tavily")).toEqual({ type: "remote", url: SERVER_URL, timeout: { execution: 900_000 } })

    state.key = { key: "tvly-new", source: "connected", label: "Tavily" }
    const second = mcpEditor()
    mcp.run(second.editor)
    expect(second.servers.get("tavily")).toMatchObject({ oauth: false, headers: { Authorization: "Bearer tvly-new" } })
    expect(state.userServer).toBe(false)
  })

  test("keeps a user's own tavily server untouched", async () => {
    const mcp = transforms<McpEditor>()
    const state: ServerState = { key: { key: "tvly-k", source: "env" }, userServer: false, userServerAtTavily: false }
    await registerServer(mcp, state, 900_000)
    const own = { type: "local" as const, command: ["tavily-mcp"] }
    const { editor, servers, sets } = mcpEditor({ tavily: own })
    mcp.run(editor)
    expect(sets).toEqual([])
    expect(servers.get("tavily")).toEqual(own)
    expect(state.userServer).toBe(true)

    // A later rebuild without the user's server registers the plugin's again.
    const next = mcpEditor()
    mcp.run(next.editor)
    expect(next.sets).toEqual(["tavily"])
    expect(state.userServer).toBe(false)
  })

  test("marks a user's own server at Tavily's URL, so scripts may use it, and keeps it untouched", async () => {
    const mcp = transforms<McpEditor>()
    const state: ServerState = { key: undefined, userServer: false, userServerAtTavily: false }
    await registerServer(mcp, state, 900_000)
    for (const [url, atTavily] of [
      [SERVER_URL, true],
      ["https://mcp.tavily.com/mcp", true],
      ["https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-k", true],
      ["https://mcp.tavily.com/other/", false],
      ["http://mcp.tavily.com/mcp/", false],
      ["https://mcp.tavily.com.example.invalid/mcp/", false],
      ["not a url", false],
    ] as const) {
      const own = { type: "remote" as const, url }
      const { editor, sets } = mcpEditor({ tavily: own })
      mcp.run(editor)
      expect({ url, sets, userServer: state.userServer, atTavily: state.userServerAtTavily }).toEqual({ url, sets: [], userServer: true, atTavily })
    }
    mcp.run(mcpEditor({ tavily: { type: "local" as const, command: ["tavily-mcp"] } }).editor)
    expect(state.userServerAtTavily).toBe(false)
  })
})

describe("isTavilyServer", () => {
  test("only a remote server at Tavily's URL", () => {
    expect(isTavilyServer({ type: "remote", url: SERVER_URL })).toBe(true)
    expect(isTavilyServer({ type: "local", command: ["npx", "tavily-mcp"] })).toBe(false)
  })
})

describe("watchKey", () => {
  function setup(initial: Parameters<typeof integration>[0], key: ServerState["key"]) {
    const stream = events()
    const credentials = integration(initial)
    let reloads = 0
    const state: ServerState = { key, userServer: false, userServerAtTavily: false }
    const controller = new AbortController()
    const warnings: string[] = []
    const done = watchKey(
      {
        event: stream.domain,
        integration: credentials.domain,
        mcp: { reload: async () => void reloads++ },
      },
      state,
      controller.signal,
      (message) => warnings.push(message),
    )
    return { stream, credentials, state, controller, done, warnings, reloads: () => reloads }
  }

  test("a failed event stream warns KEY_WATCH_STOPPED with its next step; an abort does not warn", async () => {
    const failing = (error: Error, controller: AbortController) => ({
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            controller.abort()
            throw error
          },
        }),
      }),
    })
    const run = async (abortFirst: boolean) => {
      const warnings: string[] = []
      const controller = new AbortController()
      const events = abortFirst ? failing(new Error("aborted"), controller) : { subscribe: () => { throw new Error("stream closed") } }
      const state: ServerState = { key: undefined, userServer: false, userServerAtTavily: false }
      await watchKey(
        { event: events as never, integration: integration({}).domain, mcp: { reload: async () => {} } },
        state,
        controller.signal,
        (message) => warnings.push(message),
      )
      return warnings
    }
    expect(await run(false)).toEqual([
      "KEY_WATCH_STOPPED: The plugin stopped watching for Tavily key changes (stream closed). Next step: Restart OpenCode after you change the key.",
    ])
    expect(await run(true)).toEqual([])
  })

  test("a key change reloads exactly once, however many events announce it", async () => {
    const watch = setup({ connection: keyConnection(), value: keyValue("tvly-new") }, undefined)
    watch.stream.push("credential.updated")
    watch.stream.push("credential.switched")
    watch.stream.push("integration.updated")
    await settle()
    expect(watch.reloads()).toBe(1)
    expect(watch.state.key).toEqual({ key: "tvly-new", source: "connected", label: "Tavily" })
    watch.controller.abort()
    await watch.done
  })

  test("an unchanged key never reloads", async () => {
    const watch = setup({ connection: envConnection(), value: keyValue("tvly-same") }, { key: "tvly-same", source: "env" })
    watch.stream.push("credential.updated")
    watch.stream.push("integration.updated")
    await settle()
    expect(watch.reloads()).toBe(0)
    expect(watch.credentials.state.resolves).toBe(2)
    watch.controller.abort()
    await watch.done
  })

  test("logging out reloads back to OAuth", async () => {
    const watch = setup({}, { key: "tvly-old", source: "connected", label: "Tavily" })
    watch.stream.push("credential.updated")
    await settle()
    expect(watch.reloads()).toBe(1)
    expect(watch.state.key).toBeUndefined()
    watch.controller.abort()
    await watch.done
  })

  test("a failed lookup keeps the current key, warns without the key, and does not reload", async () => {
    const watch = setup({ connection: keyConnection() }, { key: "tvly-secret", source: "connected", label: "Tavily" })
    watch.credentials.state.fail = new Error("store locked")
    watch.stream.push("credential.updated")
    await settle()
    expect(watch.reloads()).toBe(0)
    expect(watch.state.key?.key).toBe("tvly-secret")
    expect(watch.warnings).toEqual([
      "KEY_UNAVAILABLE: OpenCode could not read the Tavily API key (store locked). Next step: Run /connect and choose Tavily, then connect the key again.",
    ])
    expect(watch.warnings[0]).not.toContain("tvly-secret")
    watch.controller.abort()
    await watch.done
  })

  test("aborting ends the watch quietly", async () => {
    const watch = setup({}, undefined)
    watch.controller.abort()
    await watch.done
    expect(watch.warnings).toEqual([])
  })
})
