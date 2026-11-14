import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin/tui"
import type { Status } from "../../src/rpc/index.js"
import { DEFAULT_LOCATION, fakeContext, LOCATION, settle } from "./fake.js"

// The first render loads OpenTUI's native renderer, which is slow on a busy machine.
setDefaultTimeout(60_000)

// The test renders the shipped build, not the source.
const DIST = new URL("../../dist/tui.js", import.meta.url)
let plugin: Plugin.Definition

beforeAll(async () => {
  if (!existsSync(fileURLToPath(DIST))) throw new Error("dist/tui.js is missing. Run npm run build first.")
  plugin = ((await import(DIST.href)) as { default: Plugin.Definition }).default
})

const REFRESH_ON = ["server.connected", "mcp.status.changed", "agent.updated", "integration.updated", "credential.updated", "credential.switched"]

const connected: Status = {
  version: "0.0.0",
  state: "connected",
  access: "all",
  auth: "oauth",
  account: "jo@example.com",
  tools: { visible: 5, unknown: 0, unknownNames: [] },
  websearchDefault: true,
  host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true },
  unguardedAgents: [],
  nextStep: "Nothing to do.",
}

const needsAuth: Status = {
  version: "0.0.0",
  state: "sign_in_required",
  access: "all",
  auth: "oauth",
  tools: { visible: 6, unknown: 1, unknownNames: ["tavily_feedback"] },
  websearchDefault: false,
  host: { version: "2.2.4", range: ">=2.2.3 <2.3.0", tested: true },
  unguardedAgents: ["reviewer"],
  permissionsBlock: [
    { action: "tavily_*", resource: "*", effect: "allow" },
    { action: "tavily_tavily_search", resource: "*", effect: "allow" },
  ],
  nextStep: "Run /connect and choose Tavily account to sign in, or choose Tavily to use an API key.",
}

/** A dialog row: the label in its 29-column field, a gap, then the value. */
const row = (label: string, value: string) => `${label.padEnd(30)}${value}`

/** Runs `run` with this process's TAVILY_API_KEY set to `value`, or unset, and restores it after. */
async function withTerminalKey(value: string | undefined, run: () => Promise<void>) {
  const saved = process.env.TAVILY_API_KEY
  if (value === undefined) delete process.env.TAVILY_API_KEY
  else process.env.TAVILY_API_KEY = value
  try {
    await run()
  } finally {
    if (saved === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = saved
  }
}

const harnesses: ReturnType<typeof fakeContext>[] = []

/** Sets the plugin up on a fake context and opens the view through its command; the host renders a dialog on show. */
async function open(options = { location: LOCATION as typeof LOCATION | undefined }) {
  const fake = fakeContext(options)
  harnesses.push(fake)
  const cleanup = await plugin.setup(fake.context as unknown as Plugin.Context)
  if (!cleanup) throw new Error("setup returned no cleanup")
  await fake.command("rehearsal.kit.tui.status").run()
  await fake.frame()
  return { ...fake, cleanup }
}

afterEach(() => {
  for (const fake of harnesses.splice(0)) fake.dialog.screen?.renderer.destroy()
})

describe("Tavily TUI status view", () => {
  test("registers the palette entry and the /rehearsal slash command", async () => {
    const fake = fakeContext()
    harnesses.push(fake)
    expect(plugin.id).toBe("rehearsal.kit.tui")
    await plugin.setup(fake.context as unknown as Plugin.Context)
    const command = fake.command("rehearsal.kit.tui.status")
    expect(command).toMatchObject({ title: "Tavily: Status", palette: true, slash: { name: "rehearsal" } })
    expect(fake.dialog.open).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
    // Nothing listens until the dialog opens.
    expect(fake.subscribed).toEqual([])
    expect(fake.listeners()).toBe(0)
  })

  test("shows loading, then asks the status RPC with {} for the current location", async () => {
    const view = await open()
    expect(view.dialog.size).toBe("large")
    const frame = await view.frame()
    expect(frame).toContain("Tavily status")
    expect(frame).toContain("Loading Tavily status…")
    expect(frame).toContain("r refresh · esc close")
    expect(frame).not.toContain("refreshing…")
    expect(view.calls).toHaveLength(1)
    expect(view.calls[0]).toMatchObject({ rpcID: "rehearsal.kit", input: {}, options: { location: LOCATION } })
    expect(view.calls[0].options.signal).toBeInstanceOf(AbortSignal)
  })

  test("falls back to the default location when the TUI has none", async () => {
    const view = await open({ location: undefined })
    expect(view.calls[0].options.location).toEqual(DEFAULT_LOCATION)
  })

  test("renders a connected account, with Nothing to do as the next step", async () => {
    const view = await open()
    view.calls[0].resolve(connected)
    await settle()
    const frame = await view.frame()
    expect(frame).not.toContain("Loading")
    for (const [label, value] of [
      ["Connection", "connected"],
      ["Account", "jo@example.com"],
      ["Access", "every tool runs without asking"],
      ["Sign-in", "OAuth (/connect → Tavily account)"],
      ["Web search", `Tavily, unless opencode.json sets "websearch"`],
      ["Tools", "5 available"],
      ["Agents without default rules", "none"],
      ["OpenCode", "2.2.3 (tested)"],
      ["Next step", "Nothing to do."],
    ])
      expect(frame).toContain(row(label, value))
  })

  test("shows Tavily's check of a key, and no terminal hint while the server uses a key", async () => {
    await withTerminalKey("tvly-terminal-only", async () => {
      const view = await open()
      view.calls[0].resolve({ ...connected, auth: "key_connected", account: "Tavily", keyCheck: "rejected", nextStep: "Replace the key." })
      await settle()
      const frame = await view.frame()
      expect(frame).toContain(row("Sign-in", "API key (/connect → Tavily), rejected by Tavily"))
      expect(frame).not.toContain("Terminal key")
    })
  })

  test("names a TAVILY_API_KEY that only this terminal has, without its value", async () => {
    await withTerminalKey("tvly-terminal-only", async () => {
      const view = await open()
      view.calls[0].resolve(connected)
      await settle()
      const frame = await view.frame()
      expect(frame).toContain(row("Terminal key", "TAVILY_API_KEY is set in this terminal"))
      expect(frame).not.toContain("tvly-terminal-only")
    })
    await withTerminalKey(undefined, async () => {
      const view = await open()
      view.calls[0].resolve(connected)
      await settle()
      expect(await view.frame()).not.toContain("Terminal key")
    })
  })

  test("renders sign-in required with unknown tools, agents without default rules and their block, in the S9 order", async () => {
    const view = await open()
    view.calls[0].resolve(needsAuth)
    await settle()
    const frame = await view.frame()
    const order = [
      row("Connection", "sign-in required"),
      row("Account", "none"),
      row("Access", "every tool runs without asking"),
      row("Sign-in", "OAuth (/connect → Tavily account)"),
      row("Web search", "not set by this plugin"),
      row("Skills", "the plugin's own"),
      row("Tools", "6 available, 1 unknown (new tools run too): tavily_feedback"),
      row("Agents without default rules", "reviewer"),
      `{"action":"tavily_*","resource":"*","effect":"allow"},`,
      `{"action":"tavily_tavily_search","resource":"*","effect":"allow"}`,
      row("OpenCode", "2.2.4 (tested)"),
      row("Next step", "Run /connect and choose Tavily account to sign in"),
    ]
    const positions = order.map((text) => frame.indexOf(text))
    expect(positions.filter((position) => position < 0)).toEqual([])
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    // The agents row holds only the names; the block follows it.
    expect(frame.split("\n").find((line) => line.includes("Agents without default rules"))).not.toContain("{")
  })

  test("shows the next step the RPC error carries", async () => {
    const view = await open()
    view.calls[0].reject({
      type: "unavailable",
      message: "STATUS_UNAVAILABLE: Could not read Tavily's status (boom).",
      data: { nextStep: "Run /tavily-status again, and restart OpenCode if it keeps failing." },
    })
    await settle()
    const frame = await view.frame()
    expect(frame).toContain("Tavily status unavailable")
    expect(frame).toContain("STATUS_UNAVAILABLE: Could not read Tavily's status (boom).")
    expect(frame).toContain(row("Next step", "Run /tavily-status again, and restart OpenCode if it keeps failing."))
  })

  test("gives its own next step when the RPC cannot be reached", async () => {
    const view = await open()
    view.calls[0].reject(new Error("fetch failed"))
    await settle()
    const frame = await view.frame()
    expect(frame).toContain("Tavily status unavailable")
    expect(frame).toContain("fetch failed")
    expect(frame).toContain(row("Next step", "Run /tavily-status in a session, and restart OpenCode if that fails too."))
  })

  test("r refreshes, keeps the last status while it loads and drops a superseded answer", async () => {
    const view = await open()
    view.calls[0].resolve(needsAuth)
    await settle()
    expect(view.layerOf("r")?.mode).toBe("modal")
    await view.command("r").run()
    expect(await view.frame()).toContain("refreshing…")
    expect(await view.frame()).toContain("sign-in required")
    await view.command("r").run()
    expect(view.calls).toHaveLength(3)
    expect(view.calls[1].options.signal?.aborted).toBe(true)
    view.calls[2].resolve(connected)
    await settle()
    const frame = await view.frame()
    expect(frame).toContain(row("Connection", "connected"))
    expect(frame).not.toContain("refreshing…")
    expect(frame).not.toContain("unavailable")
  })

  test("subscribes while open, refreshes on each event that can change it, and unsubscribes on close", async () => {
    const view = await open()
    expect(view.subscribed).toEqual(REFRESH_ON)
    expect(view.listeners()).toBe(REFRESH_ON.length)
    view.calls[0].resolve(needsAuth)
    await settle()
    for (const [index, type] of REFRESH_ON.entries()) {
      view.emit(type)
      expect(view.calls).toHaveLength(index + 2)
    }
    view.emit("session.idle")
    expect(view.calls).toHaveLength(REFRESH_ON.length + 1)
    view.calls.at(-1)?.resolve(connected)
    await settle()
    expect(await view.frame()).toContain(row("Connection", "connected"))
    await view.command("escape").run()
    expect(view.listeners()).toBe(0)
    for (const type of REFRESH_ON) view.emit(type)
    expect(view.calls).toHaveLength(REFRESH_ON.length + 1)
  })

  test("esc closes the view, aborts its request and removes its keys", async () => {
    const view = await open()
    expect(view.hasCommand("r")).toBe(true)
    await view.command("escape").run()
    expect(view.dialog.open).toBeUndefined()
    expect(view.calls[0].options.signal?.aborted).toBe(true)
    expect(view.hasCommand("r")).toBe(false)
    expect(view.hasCommand("escape")).toBe(false)
    expect(view.hasCommand("rehearsal.kit.tui.status")).toBe(true)
  })

  test("opening it again while open keeps it live", async () => {
    const view = await open()
    await view.command("rehearsal.kit.tui.status").run()
    expect(view.calls[0].options.signal?.aborted).toBe(true)
    view.calls[1].resolve(connected)
    await settle()
    view.emit("mcp.status.changed")
    expect(view.calls).toHaveLength(3)
    // The first opening's listeners are gone; only the open dialog's remain.
    expect(view.listeners()).toBe(REFRESH_ON.length)
  })

  test("dispose stops listening, aborts the request and closes the view", async () => {
    const view = await open()
    expect(view.listeners()).toBe(REFRESH_ON.length)
    await view.cleanup()
    expect(view.listeners()).toBe(0)
    expect(view.calls[0].options.signal?.aborted).toBe(true)
    expect(view.dialog.open).toBeUndefined()
    view.calls[0].resolve(connected)
    await settle()
    expect(view.calls).toHaveLength(1)
  })
})
