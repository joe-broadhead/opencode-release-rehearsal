import { describe, expect, test } from "bun:test"
import type { TavilyKey } from "../../src/credential.js"
import { defaultRules, type Rule } from "../../src/permissions.js"

type StatusFacts = Parameters<typeof buildStatus>[0]
import type { Status } from "../../src/rpc/index.js"
import {
  buildStatus,
  formatStatus,
  readStatus,
  registerStatusCommand,
  unavailable,
} from "../../src/status.js"
import {
  agent,
  integration,
  keyConnection,
  LOCATION,
  transforms,
  type AgentInfo,
  type EditorOf,
  type McpServer,
} from "./fake.js"
import type { Plugin } from "@opencode/plugin"
import pkg from "../../package.json" with { type: "json" }

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }
const guarded = { id: "build", permissions: [BASE, ...defaultRules()] }
/** The host check for a tested release, and the same host as status reports it. */
const CHECK = { version: "2.2.3", tested: true, inRange: true }
const HOST = { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true }
const USER_SERVER_SCRIPTS =
  "Scripts can't use your own tavily server, because its URL is not Tavily's (https://mcp.tavily.com/mcp/); point it at that URL, or remove it from opencode.json, to use the tools RPC."
const KNOWN = ["search", "extract", "map", "crawl", "research"].map((name) => ({ id: `tavily_tavily_${name}` }))
const FIVE = { visible: 5, unknown: 0, unknownNames: [] }
const NONE = { visible: 0, unknown: 0, unknownNames: [] }
const ENV_REPLACE = `run /connect, choose Tavily and connect a working key (it wins over TAVILY_API_KEY), or replace TAVILY_API_KEY with "opencode service set env TAVILY_API_KEY <key>"`

const facts = (overrides: Partial<StatusFacts> = {}): StatusFacts => ({
  access: "all",
  server: { status: "connected" },
  userServer: false,
  userServerAtTavily: false,
  tools: KNOWN,
  websearchDefault: true,
  host: CHECK,
  agents: [guarded],
  ...overrides,
})

describe("buildStatus", () => {
  test("connected through OAuth is ready, with the account label", () => {
    expect(buildStatus(facts({ oauthAccount: "jo@example.com" }))).toEqual({
      version: pkg.version,
      state: "connected",
      access: "all",
      auth: "oauth",
      account: "jo@example.com",
      tools: FIVE,
      websearchDefault: true,
      host: HOST,
      unguardedAgents: [],
      nextStep: "Nothing to do.",
    })
  })

  test("counts the tavily server's tools and names the unknown ones", () => {
    const tools = [...KNOWN, { id: "tavily_tavily_feedback" }, { id: "tavily_Bad Name" }, { id: "read" }, { id: "other_tavily_search" }]
    expect(buildStatus(facts({ tools })).tools).toEqual({ visible: 7, unknown: 2, unknownNames: ["tavily_feedback"] })
    expect(buildStatus(facts({ tools: [] })).tools).toEqual(NONE)
  })

  test("a connected key reports its credential label", () => {
    const status = buildStatus(facts({ key: { key: "tvly-secret", source: "connected", label: "Tavily" } }))
    expect(status).toMatchObject({ auth: "key_connected", account: "Tavily" })
    expect(status.nextStep).toBe("Nothing to do.")
  })

  test("a key carries Tavily's check; OAuth and a user's own server carry none", () => {
    const key = { key: "tvly-secret", source: "connected", label: "Tavily" } as const
    expect(buildStatus(facts({ key, keyCheck: "accepted" }))).toMatchObject({ keyCheck: "accepted", nextStep: "Nothing to do." })
    expect(buildStatus(facts({ key, keyCheck: "unchecked" }))).toMatchObject({ keyCheck: "unchecked", nextStep: "Nothing to do." })
    expect(buildStatus(facts({ keyCheck: "accepted" }))).not.toHaveProperty("keyCheck")
    expect(buildStatus(facts({ key, userServer: true, keyCheck: "rejected" }))).not.toHaveProperty("keyCheck")
  })

  test("a rejected key is the next step even while the server shows connected", () => {
    const connected = buildStatus(facts({ key: { key: "k", source: "connected", label: "Tavily" }, keyCheck: "rejected" }))
    expect(connected).toMatchObject({ state: "connected", auth: "key_connected", keyCheck: "rejected" })
    expect(connected.nextStep).toBe("Tavily did not accept the API key: run /connect, choose Tavily and replace the key.")
    // Before the agents' fix: a key that does not work blocks every tool.
    const unguarded = buildStatus(facts({ key: { key: "k", source: "env" }, keyCheck: "rejected", agents: [{ id: "reviewer", permissions: [BASE] }] }))
    expect(unguarded.nextStep).toBe(`Tavily did not accept the API key: ${ENV_REPLACE}.`)
  })

  test("an environment key has no account", () => {
    const status = buildStatus(facts({ key: { key: "tvly-secret", source: "env" }, oauthAccount: "ignored" }))
    expect(status.auth).toBe("key_env")
    expect(status).not.toHaveProperty("account")
  })

  test("a user's own server is reported, whatever key exists", () => {
    const status = buildStatus(facts({ userServer: true, key: { key: "tvly-secret", source: "env" }, oauthAccount: "me" }))
    expect(status).toMatchObject({ auth: "user_server", account: "me" })
  })

  test("a user's own server at another URL: status says scripts can't use it, and why", () => {
    expect(buildStatus(facts({ userServer: true })).nextStep).toBe(USER_SERVER_SCRIPTS)
    // Sign-in and the agents' fix come first.
    expect(buildStatus(facts({ userServer: true, server: { status: "needs_auth" } })).nextStep).toBe(
      "Run /connect and choose tavily to sign in to your own server.",
    )
    expect(buildStatus(facts({ userServer: true, agents: [{ id: "reviewer", permissions: [BASE] }] })).nextStep).toStartWith("Put the default rules shown by /tavily-status first")
  })

  test("a user's own server at Tavily's URL serves scripts: nothing to do", () => {
    expect(buildStatus(facts({ userServer: true, userServerAtTavily: true })).nextStep).toBe("Nothing to do.")
  })

  test("needs sign-in, for each auth source", () => {
    const needsAuth = { server: { status: "needs_auth" } } as const
    expect(buildStatus(facts(needsAuth)).nextStep).toBe(
      "Run /connect and choose Tavily account to sign in, or choose Tavily to use an API key.",
    )
    expect(buildStatus(facts({ ...needsAuth, userServer: true })).nextStep).toBe(
      "Run /connect and choose tavily to sign in to your own server.",
    )
    expect(buildStatus(facts({ ...needsAuth, key: { key: "k", source: "env" } })).nextStep).toBe(
      `Tavily did not accept the API key: ${ENV_REPLACE}.`,
    )
    expect(buildStatus(facts({ ...needsAuth, key: { key: "k", source: "connected" } })).nextStep).toBe(
      "Tavily did not accept the API key: run /connect, choose Tavily and replace the key.",
    )
  })

  test("failed, with and without a key", () => {
    expect(buildStatus(facts({ server: { status: "failed" } })).nextStep).toBe(
      `Run "opencode mcp list" to see the error, and check your network.`,
    )
    expect(buildStatus(facts({ server: { status: "failed" }, key: { key: "k", source: "env" } })).nextStep).toBe(
      `Check your network. If it works, ${ENV_REPLACE}.`,
    )
  })

  test("pending, disabled and not registered", () => {
    expect(buildStatus(facts({ server: { status: "pending" } })).nextStep).toBe("Wait a few seconds, then run /tavily-status again.")
    expect(buildStatus(facts({ server: { status: "disabled" } })).nextStep).toBe(
      `Enable the tavily server in /mcps, or remove "disabled": true from mcp.servers.tavily in opencode.json.`,
    )
    const missing = buildStatus(facts({ server: undefined }))
    expect(missing).toMatchObject({ state: "not_configured", auth: "none" })
    expect(missing.nextStep).toBe(
      `Check that no other plugin or policy removes the "tavily" MCP server, then run "opencode reload".`,
    )
  })

  test("names agents that miss the default rules, with the block to paste and the per-agent fix", () => {
    const configOnly = { id: "reviewer", permissions: [BASE] }
    const other = { id: "docs/writer", permissions: [BASE] }
    const strict = { id: "readonly", permissions: [BASE, { action: "*", resource: "*", effect: "deny" } as const] }
    const status = buildStatus(facts({ agents: [guarded, configOnly, other, strict] }))
    expect(status.unguardedAgents).toEqual(["reviewer", "docs/writer"])
    expect(status.permissionsBlock).toEqual(defaultRules())
    expect(status.nextStep).toBe(
      "Put the default rules shown by /tavily-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for Tavily tools.",
    )
    // Sign-in comes first; the agents and the block stay listed.
    const signIn = buildStatus(facts({ server: { status: "needs_auth" }, agents: [configOnly] }))
    expect(signIn).toMatchObject({ unguardedAgents: ["reviewer"], permissionsBlock: defaultRules() })
    expect(signIn.nextStep).toStartWith("Run /connect and choose Tavily account")
  })

  test("the block counts anywhere after the base allow, even after another plugin's block, but not before it", () => {
    const other = { action: "linear_*", resource: "*", effect: "ask" } as const
    const behind = { id: "build", permissions: [BASE, other, ...defaultRules()] }
    const before = { id: "custom", permissions: [...defaultRules(), BASE] }
    expect(buildStatus(facts({ agents: [behind, before] })).unguardedAgents).toEqual(["custom"])
  })

  test("an agent fixed through its own permissions is no longer named", () => {
    // The host's order for a config-only agent: the base rules, the top-level rules, then the agent's own rules.
    const topLevel = { action: "tavily_tavily_research", resource: "*", effect: "ask" } as const
    const fixed = { id: "reviewer", permissions: [BASE, { action: "read", resource: "*.env", effect: "ask" } as const, topLevel, ...defaultRules(), topLevel] }
    const status = buildStatus(facts({ agents: [fixed] }))
    expect(status.unguardedAgents).toEqual([])
    expect(status).not.toHaveProperty("permissionsBlock")
  })

  test("an agent whose own rules ask or deny for every Tavily tool needs no fix, and isn't listed", () => {
    const asks = { id: "perf-probe", permissions: [BASE, { action: "*", resource: "*", effect: "ask" } as const] }
    const denies = { id: "locked", permissions: [BASE, { action: "tavily_*", resource: "*", effect: "deny" } as const] }
    const allows = { id: "smoke-bot", permissions: [BASE, { action: "*", resource: "*", effect: "allow" } as const] }
    expect(buildStatus(facts({ agents: [asks, denies, allows] })).unguardedAgents).toEqual(["smoke-bot"])
  })

  test("an agent without a base allow gets no block, so it is never listed, even when its rules allow Tavily", () => {
    const own = { id: "researcher", permissions: [{ action: "tavily_*", resource: "*", effect: "allow" } as const] }
    expect(buildStatus(facts({ agents: [own] })).unguardedAgents).toEqual([])
  })

  test("an untested release inside the range runs normally: same state and next step, host.tested false", () => {
    const status = buildStatus(facts({ host: { version: "2.2.99", tested: false, inRange: true } }))
    expect(status).toMatchObject({ state: "connected", host: { version: "2.2.99", range: ">=2.2.3 <2.3.0", tested: false } })
    expect(status.nextStep).toBe("Nothing to do.")
    expect(formatStatus(status)).toContain("- OpenCode: 2.2.99 (untested; supported range >=2.2.3 <2.3.0)\n")
  })

  test("a host outside the range, run with allowUntestedHost, is reported once everything else is ready", () => {
    const status = buildStatus(facts({ host: { version: "3.0.0", tested: false, inRange: false } }))
    expect(status).toMatchObject({ state: "connected", host: { version: "3.0.0", range: ">=2.2.3 <2.3.0", tested: false } })
    expect(status.nextStep).toBe("If Tavily misbehaves, use OpenCode 2.2.3, 2.2.4, 2.2.5 or 2.2.6.")
    const unknown = buildStatus(facts({ host: { version: null, tested: false, inRange: false } }))
    expect(unknown.host.version).toBeNull()
    expect(formatStatus(unknown)).toContain("- OpenCode: unknown version (untested; supported range >=2.2.3 <2.3.0)\n")
  })

  test("never carries the key", () => {
    for (const source of ["connected", "env"] as const)
      for (const status of ["connected", "needs_auth", "failed"] as const)
        expect(JSON.stringify(buildStatus(facts({ server: { status }, key: { key: "tvly-secret", source, label: "Tavily" } })))).not.toContain(
          "tvly-secret",
        )
  })
})

describe("readStatus", () => {
  const server = (entry: McpServer) => ({ list: async () => ({ location: LOCATION, data: [entry] }) })
  const agents = (data: AgentInfo[]) => ({ list: async () => ({ location: LOCATION, data }) })
  const tool = { list: async () => [...KNOWN, { id: "tavily_tavily_feedback" }] as never }
  const OWN = [{ id: "tavily", path: "/pkg/skills/tavily/SKILL.md" }]
  const skillList = (data: { id: string; path: string }[]) => ({ list: async () => ({ location: LOCATION, data }) as never })
  const skill = skillList(OWN)
  const checked: string[] = []
  const checkKey = async (key: string) => (checked.push(key), "rejected" as const)
  const state = {
    access: "all" as const,
    server: { key: undefined, userServer: false, userServerAtTavily: false },
    websearch: { tavilyDefault: true },
    host: CHECK,
    checkKey,
    skills: OWN,
  }

  test("reads the server, the OAuth account and the agents through public APIs", async () => {
    const credentials = integration({ connection: keyConnection("jo@example.com") })
    const status = await readStatus(
      {
        mcp: server({ name: "tavily", status: { status: "connected" }, integrationID: "mcp_abc" }),
        integration: credentials.domain,
        agent: agents([agent("reviewer")]),
        tool,
        skill,
      },
      state,
    )
    expect(status).toMatchObject({
      state: "connected",
      auth: "oauth",
      account: "jo@example.com",
      tools: { visible: 6, unknown: 1, unknownNames: ["tavily_feedback"] },
      unguardedAgents: ["reviewer"],
    })
  })

  test("a failed account lookup leaves the rest of the status intact", async () => {
    const credentials = integration({})
    credentials.state.failActive = new Error("store locked")
    const status = await readStatus(
      {
        mcp: server({ name: "tavily", status: { status: "needs_auth", error: "401" }, integrationID: "mcp_abc" }),
        integration: credentials.domain,
        agent: agents([]),
        tool,
        skill,
      },
      state,
    )
    expect(status).toMatchObject({ state: "sign_in_required", auth: "oauth" })
    expect(status).not.toHaveProperty("account")
  })

  test("checks the key with Tavily, but not OAuth or a user's own server", async () => {
    checked.length = 0
    const ctx = {
      mcp: server({ name: "tavily", status: { status: "connected" } }),
      integration: integration({}).domain,
      agent: agents([]),
      tool,
      skill,
    }
    const key = { key: "tvly-k", source: "env" } as const
    expect(await readStatus(ctx, { ...state, server: { key, userServer: false, userServerAtTavily: false } })).toMatchObject({ keyCheck: "rejected" })
    expect(checked).toEqual(["tvly-k"])
    expect(await readStatus(ctx, { ...state, server: { key, userServer: true, userServerAtTavily: false } })).not.toHaveProperty("keyCheck")
    expect(await readStatus(ctx, state)).not.toHaveProperty("keyCheck")
    expect(checked).toEqual(["tvly-k"])
  })

  test("reports the key it checked, when the key switches during the read", async () => {
    const server: { key: TavilyKey | undefined; userServer: boolean; userServerAtTavily: boolean } = {
      key: { key: "tvly-old", source: "connected", label: "Old" },
      userServer: false,
      userServerAtTavily: false,
    }
    const switching = async () => {
      server.key = { key: "tvly-new", source: "env" }
      return "rejected" as const
    }
    const mcp = { list: async () => ({ location: LOCATION, data: [{ name: "tavily", status: { status: "connected" } } as McpServer] }) }
    const status = await readStatus({ mcp, integration: integration({}).domain, agent: agents([]), tool, skill }, { ...state, server, checkKey: switching })
    expect(status).toMatchObject({ auth: "key_connected", account: "Old", keyCheck: "rejected" })
  })

  test("names a skill with the plugin's id that OpenCode loads from another file, and the next step moves it", async () => {
    const ctx = { mcp: server({ name: "tavily", status: { status: "connected" } }), integration: integration({}).domain, agent: agents([]), tool }
    const user = { id: "tavily", path: "/home/jo/.config/opencode/skills/tavily/SKILL.md" }
    expect(await readStatus({ ...ctx, skill: skillList([user]) }, state)).toMatchObject({
      shadowedSkills: [user],
      nextStep: `Rename or move the "tavily" skill at ${user.path}, which OpenCode loads instead of the plugin's skill of the same name.`,
    })
    expect(await readStatus({ ...ctx, skill }, state)).not.toHaveProperty("shadowedSkills")
    // A failed skill list leaves the rest of the status intact.
    const failing = { list: async () => Promise.reject(new Error("no skills")) } as never
    expect(await readStatus({ ...ctx, skill: failing }, state)).toMatchObject({ state: "connected", nextStep: "Nothing to do." })
  })

  test("another server name is not Tavily", async () => {
    const status = await readStatus(
      { mcp: server({ name: "other", status: { status: "connected" } }), integration: integration({}).domain, agent: agents([]), tool, skill },
      state,
    )
    expect(status.state).toBe("not_configured")
  })
})

describe("formatStatus", () => {
  test("renders every field in the view's order, with the block to paste", () => {
    const status: Status = {
      version: "0.0.0",
      state: "sign_in_required",
      access: "all",
      auth: "oauth",
      tools: { visible: 6, unknown: 1, unknownNames: ["tavily_feedback"] },
      websearchDefault: true,
      host: HOST,
      unguardedAgents: ["reviewer"],
      permissionsBlock: defaultRules().slice(0, 2),
      nextStep: "Sign in.",
    }
    expect(formatStatus(status)).toBe(
      [
        "Tavily status",
        "- Connection: sign-in required",
        "- Account: none",
        '- Access: every tool runs without asking: the five reads and any tool Tavily adds later. Set the access option to "ask-changes" or "read-only" to restrict a tool Tavily adds later.',
        "- Sign-in: OAuth (/connect → Tavily account)",
        `- Web search: Tavily, unless opencode.json sets "websearch"`,
        "- Skills: the plugin's own",
        "- Tools: 6 available, 1 unknown (new tools run too): tavily_feedback",
        "- Agents without default rules: reviewer",
        `  {"action":"tavily_*","resource":"*","effect":"allow"},`,
        `  {"action":"tavily_tavily_search","resource":"*","effect":"allow"}`,
        "- OpenCode: 2.2.3 (tested)",
        "- Next step: Sign in.",
      ].join("\n"),
    )
  })

  test("a ready status ends with one next step: Nothing to do.", () => {
    const text = formatStatus({
      version: "0.0.0",
      state: "connected",
      access: "all",
      auth: "key_connected",
      account: "Tavily",
      tools: NONE,
      websearchDefault: false,
      host: HOST,
      unguardedAgents: [],
      nextStep: "Nothing to do.",
    })
    expect(text).toContain("- Account: Tavily")
    expect(text).toContain("- Sign-in: API key (/connect → Tavily)\n")
    const rejected: Status = {
      version: "0.0.0",
      state: "connected",
      access: "all",
      auth: "key_env",
      keyCheck: "rejected",
      tools: NONE,
      websearchDefault: true,
      host: HOST,
      unguardedAgents: [],
      nextStep: "x",
    }
    expect(formatStatus(rejected)).toContain("- Sign-in: API key from TAVILY_API_KEY, rejected by Tavily\n")
    expect(text).toContain("- Tools: none listed yet")
    expect(text).toContain("- Web search: not set by this plugin")
    expect(text).toContain("- Agents without default rules: none")
    expect(text.split("\n").filter((line) => line.startsWith("- Next step:"))).toEqual(["- Next step: Nothing to do."])
  })
})

describe("/tavily-status", () => {
  async function command(read: () => Promise<Status>) {
    const commands = transforms<EditorOf<Plugin.Context["command"]>>()
    const posted: Parameters<Plugin.Context["session"]["synthetic"]>[0][] = []
    await registerStatusCommand(
      {
        command: commands,
        session: {
          synthetic: async (input) => {
            posted.push(input)
            return {} as never
          },
        },
      },
      read,
    )
    const added: Parameters<EditorOf<Plugin.Context["command"]>["add"]>[0][] = []
    commands.run({ add: (definition) => void added.push(definition) })
    return { added, posted }
  }

  test("posts the status as a synthetic message without starting a model turn", async () => {
    const ready: Status = {
      version: "0.0.0",
      state: "connected",
      access: "all",
      auth: "oauth",
      tools: FIVE,
      websearchDefault: true,
      host: HOST,
      unguardedAgents: [],
      nextStep: "Nothing to do.",
    }
    const { added, posted } = await command(async () => ready)
    expect(added.map((definition) => definition.name)).toEqual(["tavily-status"])
    await added[0]?.execute({ sessionID: "ses_1" as never, prompt: { text: "" }, delivery: "steer" })
    expect(posted).toEqual([{ sessionID: "ses_1", text: formatStatus(ready), description: "Tavily status", resume: false }])
  })

  test("reports an unreadable status with a code and a next step", async () => {
    const { added, posted } = await command(async () => {
      throw new Error("mcp list failed")
    })
    await added[0]?.execute({ sessionID: "ses_1" as never, prompt: { text: "" }, delivery: "steer" })
    expect(posted[0]?.text).toBe(
      "STATUS_UNAVAILABLE: Could not read Tavily's status (mcp list failed). Next step: Run /tavily-status again, and restart OpenCode if it keeps failing.",
    )
    expect(unavailable("x").nextStep).toBe("Run /tavily-status again, and restart OpenCode if it keeps failing.")
  })
})
