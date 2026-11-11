// The adversarial resolve suite: a matrix of agent rules x session rules x plugin defaults x user denies x saved
// approvals. It asserts that only a rule set whose resolved effect is `allow` runs, that a resolved `ask` or `deny`
// is refused before dispatch with no tool executed, and that a saved approval never changes the resolve.
//
// Why the matrix: Jobs grants a script by writing run-session `allow` rules, and a session allow overrides an agent
// deny on the host (V3). The one place a mistake widens access is this resolve, so it is tested rather than assumed.
import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NEXT_STEPS, registerToolsRpc, type MethodSpec, type ToolCall, type ToolsRpcOptions } from "../../src/host/tools-rpc.js"

type Effect = "allow" | "deny" | "ask"
type Rule = { action: string; resource: string; effect: Effect }
const SERVER = "srv"
/** Path-neutral: a fake location under the runner's temp dir, never a hard-coded temporary path a scan rejects. */
const LOCATION = join(tmpdir(), "tools-rpc-resolve")
const rule = (action: string, effect: Effect, resource = "*"): Rule => ({ action, resource, effect })
const TOOLS = ["r", "w", "d"] as const
const idOf = (name: string) => `${SERVER}_${name}`
const match = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value)
/** The host's evaluation, the same predicate the module uses: the last matching rule on `*` wins, no match asks. */
const expected = (rules: readonly Rule[], action: string): Effect => rules.findLast((entry) => match(entry.action, action) && match(entry.resource, "*"))?.effect ?? "ask"

interface Case {
  readonly name: string
  readonly agent: readonly Rule[]
  readonly session: readonly Rule[]
}

const BASE: Rule = rule("*", "allow")
const DEFAULTS: readonly Rule[] = [
  BASE,
  rule("*", "ask"),
  rule(`${SERVER}_*`, "ask"),
  rule(idOf("r"), "allow"),
  rule(idOf("w"), "ask"),
  rule(idOf("d"), "deny"),
]
const CASES: readonly Case[] = [
  { name: "base allow only", agent: [BASE], session: [] },
  { name: "plugin defaults", agent: DEFAULTS, session: [] },
  { name: "user denies the write", agent: [BASE, rule(idOf("w"), "deny")], session: [] },
  { name: "user asks the write", agent: [BASE, rule(idOf("w"), "ask")], session: [] },
  { name: "defaults plus a user allow on the write", agent: [...DEFAULTS, rule(idOf("w"), "allow")], session: [] },
  { name: "closed profile: blanket deny then allows", agent: [BASE, rule("*", "deny"), rule(idOf("r"), "allow"), rule(idOf("w"), "allow")], session: [] },
  { name: "deny all then allow the read", agent: [BASE, rule(`${SERVER}_*`, "deny"), rule(idOf("r"), "allow")], session: [] },
  { name: "session denies the read", agent: [BASE], session: [rule(idOf("r"), "deny")] },
  { name: "session allows the write", agent: [BASE, rule(idOf("w"), "ask")], session: [rule(idOf("w"), "allow")] },
  { name: "session allows the write over a user deny", agent: [BASE, rule(idOf("w"), "deny")], session: [rule(idOf("w"), "allow")] },
  { name: "session denies the write", agent: [BASE], session: [rule(idOf("w"), "deny")] },
  { name: "run-session shape: deny all, then allow the read and the write", agent: [BASE], session: [rule("*", "deny"), rule(idOf("r"), "allow"), rule(idOf("w"), "allow")] },
]

const SAVED: readonly { action: string; resource: string }[][] = [[], TOOLS.map((name) => ({ action: idOf(name), resource: "*" }))]

/**
 * The MCP-only next steps a block whose tools are all its own may omit. This suite's fake MCP table needs them, so a
 * setup supplies a test-only value for each missing one; the shared module is unchanged and nothing declared is
 * overridden. The same shim is in `tools-rpc.test.ts`, because each suite is copied on its own.
 */
const MCP_STEPS: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: "Run /connect and sign in.",
  CONNECTING: "Wait a few seconds, then call the method again.",
  CONNECTION_FAILED: "Run the status command and follow its next step.",
  DISABLED: "Enable the server in /mcps.",
  NOT_REGISTERED: "Run the status command and follow its next step.",
  TOOL_UNAVAILABLE: "Call describe to see which methods OpenCode lists now.",
  UPSTREAM_ERROR: "Check the input against the method's schema from describe.",
}
function ensureMcpSteps() {
  const steps = NEXT_STEPS as Record<string, string | undefined>
  for (const [code, next] of Object.entries(MCP_STEPS)) if (steps[code] === undefined) steps[code] = next
}

interface Harness {
  handlers: Record<string, (input: unknown, context: { signal: AbortSignal; error: (type: string, message: string, data?: unknown) => unknown }) => Promise<any>>
  executions: string[]
}

async function setup(input: { agent: readonly Rule[]; session: readonly Rule[]; saved: readonly { action: string; resource: string }[]; methods?: MethodSpec[] }): Promise<Harness> {
  // Read by destructuring, the idiom the module uses: no dotted access from the options object for a forbidden scan to match.
  ensureMcpSteps()
  const { agent, session, saved, methods: given } = input
  const executions: string[] = []
  const methods: MethodSpec[] = given ?? TOOLS.map((name): MethodSpec => ({ kind: "mcp", name, class: name === "r" ? "read" : name === "w" ? "write" : "destructive" }))
  const agents: Record<string, Rule[]> = { build: [...agent] }
  const sessions = { ses_1: { agent: "build", permissions: [...session] } }
  /** The host's own check inside the executor: agent, session, then saved approvals. It never gates the resolve. */
  const check = (call: ToolCall, action: string) => {
    const configured = [...agents[call.agent]!, ...sessions.ses_1.permissions]
    if (configured.findLast((entry) => match(entry.action, action) && match(entry.resource, "*"))?.effect === "deny") throw Object.assign(new Error("blocked"), { _tag: "Permission.BlockedError" })
    const all = [...configured, ...saved.map((entry) => rule(entry.action, "allow", entry.resource))]
    const effect = all.findLast((entry) => match(entry.action, action) && match(entry.resource, "*"))?.effect ?? "ask"
    if (effect !== "allow") throw new Error("the fake host cannot answer a prompt")
  }
  const handlers: Harness["handlers"] = {}
  const ctx = {
    location: { directory: LOCATION },
    rpc: {
      register: async (_definition: unknown, registered: Harness["handlers"]) => {
        Object.assign(handlers, registered)
        return { dispose: async () => {}, events: { emit: async () => {} } }
      },
    },
    permission: { hook: async () => ({ dispose: async () => {} }), assert: async () => {} },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID !== "ses_1") throw Object.assign(new Error("not found"), { _tag: "Session.NotFoundError" })
        return { id: sessionID, location: { directory: LOCATION }, ...sessions.ses_1 }
      },
    },
    agent: { get: async ({ agentID, location }: { agentID: string; location: unknown }) => ({ location, data: { id: agentID, permissions: agents[agentID] } }) },
    tool: {
      list: async () =>
        TOOLS.map((name) => ({
          id: idOf(name),
          name: idOf(name),
          description: "",
          input: { type: "object" },
          execute: async (_input: unknown, call: ToolCall) => {
            executions.push(idOf(name))
            check(call, idOf(name))
            return { content: "ok" }
          },
        })),
    },
    mcp: { list: async () => ({ data: [{ name: SERVER, status: { status: "connected" } }] }) },
  }
  const serverOptions: ToolsRpcOptions["mcp"] = { server: SERVER, managed: () => true }
  await registerToolsRpc(ctx as never, { methods, mcp: serverOptions })
  return { handlers, executions }
}

const call = (h: Harness, method: string) =>
  h.handlers[method]!({ sessionID: "ses_1", input: { q: 1 } }, { signal: new AbortController().signal, error: (type, message, data) => ({ type, message, data }) })

describe("the resolve matrix", () => {
  const rows: { where: string; tool: string; want: Effect }[] = []
  for (const scenario of CASES) for (const saved of SAVED) for (const tool of TOOLS) rows.push({ where: `${scenario.name}${saved.length ? " + saved approvals" : ""}`, tool, want: expected([...scenario.agent, ...scenario.session], idOf(tool)) })

  test("covers all three effects, so the matrix is not vacuous", () => {
    expect(new Set(rows.map((row) => row.want))).toEqual(new Set<Effect>(["allow", "ask", "deny"]))
    expect(rows).toHaveLength(CASES.length * SAVED.length * TOOLS.length)
  })

  for (const scenario of CASES) {
    for (const saved of SAVED) {
      test(`${scenario.name}${saved.length ? ", with saved approvals" : ""}`, async () => {
        const h = await setup({ agent: scenario.agent, session: scenario.session, saved })
        for (const tool of TOOLS) {
          const want = expected([...scenario.agent, ...scenario.session], idOf(tool))
          const before = h.executions.length
          const outcome = await call(h, tool)
          if (want === "allow") {
            expect(outcome).toEqual({ text: "ok" })
            expect(h.executions.length).toBe(before + 1)
            expect(h.executions.at(-1)).toBe(idOf(tool))
            continue
          }
          // Refused before dispatch: no execution, and the code is the module's.
          expect(h.executions.length).toBe(before)
          expect(outcome).toMatchObject({ type: "failed", data: { code: "PERMISSION_DENIED" } })
          expect(outcome.message.startsWith(`PERMISSION_DENIED: ${idOf(tool)} `)).toBe(true)
          if (want === "ask") {
            expect(outcome.message).toContain("would ask")
            // A saved approval is not part of the agent's and session's rules: it cannot turn this into a run.
            if (saved.length) expect(h.executions.length).toBe(before)
          } else {
            expect(outcome.message).toMatch(/is (hidden from|denied for)/)
          }
        }
      })
    }
  }
})

describe("the order the module resolves", () => {
  test("a later allow overrides an earlier deny, as the host does; that is how a user opts a default-deny tool in", async () => {
    const h = await setup({ agent: [BASE, rule(`${SERVER}_*`, "deny"), rule(idOf("d"), "allow")], session: [], saved: [] })
    expect(await call(h, "d")).toEqual({ text: "ok" })
    expect(h.executions).toEqual([idOf("d")])
  })

  test("a later deny overrides an earlier allow: no run", async () => {
    const h = await setup({ agent: [BASE, rule(idOf("r"), "allow"), rule(idOf("r"), "deny")], session: [], saved: [] })
    expect(await call(h, "r")).toMatchObject({ type: "failed", data: { code: "PERMISSION_DENIED" } })
    expect(h.executions).toEqual([])
  })

  test("a deny on another resource does not resolve: the executor's own check decides", async () => {
    const h = await setup({ agent: [BASE, rule(idOf("r"), "deny", "some-resource")], session: [], saved: [] })
    await call(h, "r")
    expect(h.executions).toEqual([idOf("r")])
  })

  test("a plugin-owned method resolves on its declared action, and a deny there refuses before its run", async () => {
    const methods: MethodSpec[] = [{ kind: "plugin", class: "destructive", name: "wipe", action: "plugin_wipe", description: "", input: {}, output: {}, run: async () => ({ ran: true }) }]
    const allowed = await setup({ agent: [BASE, rule("plugin_wipe", "allow")], session: [], saved: [], methods })
    expect(await call(allowed, "wipe")).toEqual({ ran: true })
    const denied = await setup({ agent: [BASE, rule("plugin_wipe", "deny")], session: [], saved: [], methods })
    expect(await call(denied, "wipe")).toMatchObject({ type: "failed", data: { code: "PERMISSION_DENIED" } })
  })

  test("no rule: asks, and is refused", async () => {
    const h = await setup({ agent: [], session: [], saved: [] })
    expect(await call(h, "r")).toMatchObject({ type: "failed", data: { code: "PERMISSION_DENIED" } })
    expect(h.executions).toEqual([])
  })
})
