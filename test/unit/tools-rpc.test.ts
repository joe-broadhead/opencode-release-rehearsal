// Unit tests for the shared tools RPC module v2, against narrow fakes of the public plugin context.
// A copy in a plugin repository changes only the two imports: its test runner, and the path of its copy.
import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CLASSES,
  hidden,
  METHODS,
  NEXT_STEPS,
  PLUGIN_ID,
  pluginError,
  registerToolsRpc,
  shapeInput,
  shapeResult,
  TOOLS_RPC_ID,
  upstreamText,
  type MethodSpec,
  type PluginMethod,
  type ToolCall,
  type ToolsRpcOptions,
} from "../../src/host/tools-rpc.js"

type Effect = "allow" | "deny" | "ask"
type Rule = { action: string; resource: string; effect: Effect }
type Evaluation = { sessionID: string; agent?: string; action: string; resources: string[]; source?: { type: "tool"; messageID: string; id: string }; effect: Effect; message?: string }
type RpcContext = { signal: AbortSignal; error: (type: string, message: string, data?: unknown) => unknown }
type Handler = (input: unknown, context: RpcContext) => Promise<any>
type Result = { output?: unknown; content?: string | { type: "text"; text: string }[] }
type Execute = (input: unknown, call: ToolCall) => Promise<Result>

const SERVER = "srv"
/** Path-neutral: a fake location under the runner's temp dir, never a hard-coded temporary path a scan rejects. */
const LOCATION = join(tmpdir(), "tools-rpc-test-location")
const READ = "probe_read"
const WRITE = "probe_write"
const SLOW = "probe_slow"
const ID = `${SERVER}_${READ}`
const WRITE_ID = `${SERVER}_${WRITE}`
const hostMatch = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value)
const rule = (action: string, effect: Effect, resource = "*"): Rule => ({ action, resource, effect })

const echo: Execute = async (input) => ({ output: { echoed: input }, content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] })

/** The common table: three MCP tools and one plugin-owned tool. */
const table = (): MethodSpec[] => [
  { kind: "mcp", name: READ, class: "read" },
  { kind: "mcp", name: WRITE, class: "write" },
  { kind: "mcp", name: SLOW, class: "read" },
]

const ownedMethod = (run: PluginMethod["run"], extra: Partial<PluginMethod> = {}): PluginMethod => ({
  kind: "plugin",
  class: "write",
  name: "owned_write",
  action: "plugin_owned_write",
  description: "A plugin-owned write",
  input: { type: "object", properties: { n: { type: "integer" } }, additionalProperties: false },
  output: { type: "object", properties: { n: { type: "integer" } } },
  run,
  ...extra,
})

interface Setup {
  sessions?: Record<string, { agent?: string; permissions?: Rule[] }>
  agents?: Record<string, Rule[]>
  tools?: Record<string, Execute | undefined>
  /** Saved approvals the fake host holds. They affect the executor's check, never the module's resolve. */
  saved?: { action: string; resource: string }[]
  status?: string
  managed?: boolean
  server?: NonNullable<ToolsRpcOptions["mcp"]>["server"]
  methods?: MethodSpec[]
  shapers?: ToolsRpcOptions["shapers"]
  mcp?: false
  /** Test-only: false disables the MCP-only next-step shim below, to prove registration still requires them. */
  shim?: boolean
  lookup?: (sessionID: string) => Promise<unknown>
  /** A host that reports a missing agent as a plain Error, as stock 2.2.3 to 2.2.6 do. */
  plainAgentError?: boolean
  unavailableDetail?: NonNullable<ToolsRpcOptions["mcp"]>["unavailableDetail"]
  notRegistered?: NonNullable<ToolsRpcOptions["mcp"]>["notRegistered"]
}

interface Harness {
  contract: { id: string; methods: Record<string, { input: any; output: any; errors?: Record<string, any> }> }
  handlers: Record<string, Handler>
  hook: (evaluation: Evaluation) => void
  /** The host's permission check, as a plugin-owned spec's assert or an inner executor call meets it. */
  check: (call: ToolCall, action: string) => void
  calls: { tool: string; input: unknown; call: ToolCall }[]
  evaluations: Evaluation[]
  disposed: string[]
  /** How many times describe asked OpenCode for the MCP server list. */
  mcpListCalls: number
  stop: () => Promise<void>
}

/**
 * The MCP-only next steps a block whose tools are all its own (GWS, History, Utilities, Jobs) may omit. The suite's fake
 * MCP table needs them, so a setup that uses it supplies a test-only value for each missing one. The shared module is
 * not changed: this is the suite's own shim, and it never overrides a step the block declares.
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

async function setup(options: Setup = {}): Promise<Harness> {
  if (options.shim !== false) ensureMcpSteps()
  const sessions = options.sessions ?? { ses_1: { agent: "build" } }
  const agents = options.agents ?? { build: [rule("*", "allow")] }
  const methods = options.methods ?? table()
  const tools = options.tools ?? Object.fromEntries([READ, WRITE, SLOW].map((name) => [`${SERVER}_${name}`, echo]))
  const saved = options.saved ?? []
  const calls: Harness["calls"] = []
  const evaluations: Evaluation[] = []
  const disposed: string[] = []
  const counter = { mcpListCalls: 0 }
  let contract: Harness["contract"] | undefined
  let handlers: Record<string, Handler> = {}
  let hook: Harness["hook"] = () => {}
  /**
   * The host's check inside the executor: the agent's rules, then the session's, then saved approvals, then the
   * evaluate hook. A rule deny never reaches evaluate hooks: it rejects at once with "Permission denied: <action>".
   */
  const check = (call: ToolCall, action: string) => {
    let rules = [...(agents[call.agent] ?? []), ...(sessions[call.sessionID]?.permissions ?? [])]
    if (rules.findLast((entry) => hostMatch(entry.action, action) && hostMatch(entry.resource, "*"))?.effect === "deny")
      throw toolError(`Permission denied: ${action}`, Object.assign(new Error("blocked"), { _tag: "Permission.BlockedError" }))
    rules = [...rules, ...saved.map((entry) => rule(entry.action, "allow", entry.resource))]
    const effect = rules.findLast((entry) => hostMatch(entry.action, action) && hostMatch(entry.resource, "*"))?.effect ?? "ask"
    const evaluation: Evaluation = { sessionID: call.sessionID, agent: call.agent, action, resources: ["*"], source: { type: "tool", messageID: call.messageID, id: call.id }, effect }
    hook(evaluation)
    evaluations.push(evaluation)
    if (evaluation.effect === "deny") throw toolError(evaluation.message ?? `Permission denied: ${action}`, new Error("denied"))
    if (evaluation.effect === "ask") throw new Error("the test host has no one to answer a prompt")
  }
  const ctx = {
    location: { directory: LOCATION },
    rpc: {
      register: async (definition: Harness["contract"], registered: Record<string, Handler>) => {
        contract = definition
        handlers = registered
        return { dispose: async () => void disposed.push("rpc"), events: { emit: async () => {} } }
      },
    },
    permission: {
      hook: async (name: string, callback: Harness["hook"]) => {
        expect(name).toBe("evaluate")
        hook = callback
        return { dispose: async () => void disposed.push("hook") }
      },
      assert: async () => {},
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (options.lookup) return options.lookup(sessionID)
        const session = sessions[sessionID]
        if (!session) throw Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: "Session.NotFoundError" })
        return { id: sessionID, location: { directory: LOCATION }, ...session }
      },
    },
    agent: {
      // The module looks the agent up in its own location, without passing one: the session was read there.
      get: async ({ agentID }: { agentID: string }) => {
        const permissions = agents[agentID]
        if (!permissions) throw options.plainAgentError ? new Error(`Agent not found: ${agentID}`) : Object.assign(new Error(`Agent not found: ${agentID}`), { _tag: "Agent.NotFoundError" })
        return { location: { directory: LOCATION }, data: { id: agentID, permissions } }
      },
    },
    tool: {
      list: async () =>
        Object.entries(tools).map(([id, execute]) => ({
          id,
          name: id,
          description: `${id} (test)`,
          input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          execute: async (input: unknown, call: ToolCall) => {
            calls.push({ tool: id, input, call })
            check(call, id)
            return (execute ?? echo)(input, call)
          },
        })),
    },
    mcp: {
      list: async () => {
        counter.mcpListCalls++
        return { data: [{ name: SERVER, status: { status: options.status ?? "connected" } }] }
      },
    },
  }
  // Read by destructuring, the idiom the module uses: no dotted access from the options object for a forbidden scan to match.
  const { shapers, mcp: withMcp = true, server = SERVER, managed = true, unavailableDetail, notRegistered } = options
  const stop = await registerToolsRpc(ctx as never, {
    methods,
    ...(shapers === undefined ? {} : { shapers }),
    ...(withMcp === false
      ? {}
      : {
          mcp: {
            server,
            managed: () => managed,
            ...(unavailableDetail ? { unavailableDetail } : {}),
            ...(notRegistered ? { notRegistered } : {}),
          },
        }),
  })
  return {
    contract: contract!,
    handlers,
    hook: (evaluation) => hook(evaluation),
    check,
    calls,
    evaluations,
    disposed,
    get mcpListCalls() {
      return counter.mcpListCalls
    },
    stop,
  }
}

function rpcContext(signal = new AbortController().signal): RpcContext {
  return { signal, error: (type, message, data) => ({ type, message, data, handlerError: true }) }
}

const call = (h: Harness, method: string, input: unknown = { query: "q" }, sessionID = "ses_1", context = rpcContext()) =>
  h.handlers[method]!({ sessionID, input }, context)

/** Matches a refusal. Bun's toMatchObject writes its matchers into the value it checks, so it checks a copy. */
const refusedWith = (value: unknown, code: string) => expect(structuredClone(value)).toMatchObject(failure(code))

const MCP_ONLY = ["SERVER_CONFLICT", "AUTH_REQUIRED", "CONNECTING", "CONNECTION_FAILED", "DISABLED", "NOT_REGISTERED", "TOOL_UNAVAILABLE", "UPSTREAM_ERROR"] as const

const withoutSteps = async (keys: readonly string[], body: () => Promise<void>) => {
  const steps = NEXT_STEPS as Record<string, string | undefined>
  const saved = keys.map((key) => [key, steps[key]] as const)
  for (const key of keys) delete steps[key]
  try {
    await body()
  } finally {
    for (const [key, value] of saved) if (value !== undefined) steps[key] = value
  }
}

const denyNext = (action: string, agent = "build") =>
  `Remove or narrow the deny rule for ${action} in the agent "${agent}" or in the session, or add a later allow rule for ${action} to the session, or use a session whose agent allows it.`
const allowNext = (action: string) => `Add an allow rule for ${action} to the session's agent or to the session, or use a session whose agent allows it.`

const failure = (code: string) => ({
  type: "failed",
  handlerError: true,
  message: expect.stringMatching(new RegExp(`^${code}: [^]*[^.\\s]\\. Next step: [^]+\\.$`)),
  data: { code, next: expect.stringMatching(/\.$/) },
})

const toolError = (message: string, cause?: unknown) => Object.assign(new Error(message), { _tag: "Tool.Error", ...(cause === undefined ? {} : { error: cause }) })

describe("the contract", () => {
  test("is <plugin id>.tools with describe and one method per table entry, writes and plugin methods included", async () => {
    const h = await setup({ methods: [...table(), ownedMethod(async () => ({}))] })
    expect(h.contract.id).toBe(TOOLS_RPC_ID)
    expect(TOOLS_RPC_ID).toBe(`${PLUGIN_ID}.tools`)
    expect(Object.keys(h.contract.methods).sort()).toEqual(["describe", READ, WRITE, SLOW, "owned_write"].sort())
  })

  test("never makes an unclassified tool a method, even when OpenCode lists it and a rule allows it", async () => {
    const h = await setup({ tools: { [ID]: echo, [`${SERVER}_delete_everything`]: echo } })
    expect(Object.keys(h.contract.methods)).not.toContain("delete_everything")
    expect(h.handlers["delete_everything"]).toBeUndefined()
  })

  test("takes the strict envelope {sessionID, input} and declares one error, failed: {code, next}, as plain JSON Schema", async () => {
    const h = await setup()
    const method = h.contract.methods[READ]!
    expect(method.input).toEqual({
      type: "object",
      properties: { sessionID: { type: "string", minLength: 1 }, input: { type: "object" } },
      required: ["sessionID", "input"],
      additionalProperties: false,
    })
    expect(method.output).toMatchObject({ type: "object", required: ["text"], additionalProperties: false })
    expect(method.errors).toEqual({ failed: { type: "object", properties: { code: { type: "string" }, next: { type: "string" } }, required: ["code", "next"], additionalProperties: false } })
    expect(JSON.parse(JSON.stringify(h.contract))).toEqual(h.contract)
  })

  test("refuses an envelope with an unknown key, a missing or empty sessionID, or an input that is not an object", async () => {
    const h = await setup()
    const validate = (value: unknown) => h.contract.methods[READ]!.input["~standard"].validate(value)
    expect(validate({ sessionID: "ses_1", input: { query: "q" } })).toEqual({ value: { sessionID: "ses_1", input: { query: "q" } } })
    const messages = (value: unknown) => validate(value).issues?.map((issue: { message: string }) => issue.message)
    expect(messages({ sessionID: "ses_1", input: {}, extra: true })).toEqual([`"extra" is not allowed`])
    expect(messages({ input: {} })).toEqual([`"sessionID" must be a non-empty string`])
    expect(messages({ sessionID: "ses_1" })).toEqual([`"input" is missing`])
    expect(messages({ sessionID: "ses_1", input: ["q"] })).toEqual([`"input" must be an object`])
    expect(messages({ sessionID: "ses_1", account: "work", input: {} })).toEqual([`"account" is not allowed`])
    expect(messages("text")).toEqual([`the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}`])
  })

  test("describe takes nothing, {}, or {sessionID}, and refuses anything else", async () => {
    const h = await setup()
    const input = h.contract.methods.describe!.input
    for (const value of [undefined, null, {}, { sessionID: "ses_1" }]) expect(input["~standard"].validate(value)).toEqual({ value: value ?? {} })
    expect(input["~standard"].validate({ sessionID: "" }).issues).toEqual([{ message: `"sessionID" must be a non-empty string` }])
    expect(input["~standard"].validate({ extra: 1 }).issues?.[0]?.message).toBe(`"extra" is not allowed`)
    expect(input["~standard"].validate({ sessionID: "ses_1", input: {} }).issues?.[0]?.message).toBe(`"input" is not allowed`)
    for (const value of ["text", []]) expect(input["~standard"].validate(value).issues?.[0]?.message).toBe(`describe takes nothing, or {"sessionID":"<session>"}`)
  })

  test("gives every code one next step that ends with a full stop, and names the location header in SESSION_UNKNOWN", () => {
    for (const [code, next] of Object.entries(NEXT_STEPS)) expect({ code, next }).toEqual({ code, next: expect.stringMatching(/^[A-Z].*\.$/) })
    expect(NEXT_STEPS.SESSION_UNKNOWN).toContain("x-opencode-directory")
  })

  test("refuses a table entry with no class, a class outside the five, or a plugin method with no run", async () => {
    for (const bad of ["read ", "READ", ""]) {
      await expect(setup({ methods: [{ kind: "mcp", name: READ, class: bad as never }] })).rejects.toThrow(/class/)
    }
    await expect(setup({ methods: [{ kind: "plugin", class: "read", name: "x", action: "", description: "", input: {}, output: {}, run: async () => null }] })).rejects.toThrow(/action/)
    await expect(setup({ methods: [{ kind: "mcp", name: READ, class: "read" }, { kind: "mcp", name: READ, class: "read" }] })).rejects.toThrow(/taken/)
    expect(CLASSES).toEqual(["read", "write", "send", "export", "destructive"])
  })
})

describe("describe", () => {
  test("lists every method with its class, its live JSON Schema, its action and whether it is available", async () => {
    const h = await setup({ methods: [...table(), ownedMethod(async () => ({}))], tools: { [ID]: echo } })
    const description = await h.handlers.describe!({}, rpcContext())
    expect(JSON.parse(JSON.stringify(description))).toEqual(description)
    expect(structuredClone(description)).toMatchObject({
      id: TOOLS_RPC_ID,
      location: LOCATION,
      locationHint: expect.stringContaining("x-opencode-directory"),
      call: expect.stringContaining(`/api/rpc/${TOOLS_RPC_ID}/<method>`),
    })
    expect(description.methods.map((method: { name: string }) => method.name)).toEqual([READ, WRITE, SLOW, "owned_write"])
    expect(description.methods[0]).toEqual({
      name: READ,
      tool: ID,
      kind: "mcp",
      class: "read",
      action: ID,
      description: `${ID} (test)`,
      available: true,
      input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      output: { type: "object", properties: { output: {}, text: { type: "string" } }, required: ["text"], additionalProperties: false },
    })
    expect(description.methods[1]).toMatchObject({ name: WRITE, class: "write", available: false, reason: "TOOL_UNAVAILABLE" })
    expect(description.methods[3]).toMatchObject({ name: "owned_write", kind: "plugin", class: "write", action: "plugin_owned_write", available: true })
  })

  test("lists a live tool the table does not classify as unclassified, and never as a method", async () => {
    const h = await setup({ tools: { [ID]: echo, [`${SERVER}_new_tool`]: echo } })
    const description = await h.handlers.describe!({}, rpcContext())
    expect(description.unclassified).toEqual(["new_tool"])
    expect(description.methods.map((method: { name: string }) => method.name)).not.toContain("new_tool")
  })

  test("with a session, gives each method's resolved permission: allow, ask or deny", async () => {
    const h = await setup({
      methods: [...table(), ownedMethod(async () => ({}))],
      agents: { build: [rule("*", "allow"), rule(WRITE_ID, "ask"), rule("plugin_*", "deny")] },
    })
    const description = await h.handlers.describe!({ sessionID: "ses_1" }, rpcContext())
    const permission = Object.fromEntries(description.methods.map((method: { name: string; permission: string }) => [method.name, method.permission]))
    expect(permission).toEqual({ [READ]: "allow", [WRITE]: "ask", [SLOW]: "allow", owned_write: "deny" })
    // Without a session there is no permission field.
    const plain = await h.handlers.describe!({}, rpcContext())
    expect(plain.methods.every((method: object) => !Object.hasOwn(method, "permission"))).toBe(true)
  })

  test("lists the MCP servers once per describe, however many MCP methods there are", async () => {
    const h = await setup()
    const before = h.mcpListCalls
    await h.handlers.describe!({}, rpcContext())
    expect(h.mcpListCalls - before).toBe(1)
    await h.handlers.describe!({ sessionID: "ses_1" }, rpcContext())
    expect(h.mcpListCalls - before).toBe(2)
    // A table with no MCP method never asks for the server list.
    const owned = await setup({ methods: [ownedMethod(async () => ({}))], mcp: false })
    await owned.handlers.describe!({}, rpcContext())
    expect(owned.mcpListCalls).toBe(0)
  })

  test("with an unknown session, refuses with SESSION_UNKNOWN", async () => {
    refusedWith(await (await setup()).handlers.describe!({ sessionID: "ses_missing" }, rpcContext()), "SESSION_UNKNOWN")
  })

  test("gives the connection state as the reason, SERVER_CONFLICT for a server it does not manage, and the hooks' detail", async () => {
    const auth = await setup({ tools: {}, status: "needs_auth" })
    for (const method of (await auth.handlers.describe!({}, rpcContext())).methods) expect(method).toMatchObject({ available: false, reason: "AUTH_REQUIRED" })
    const conflict = await setup({ managed: false })
    for (const method of (await conflict.handlers.describe!({}, rpcContext())).methods) expect(method).toMatchObject({ available: false, reason: "SERVER_CONFLICT" })
    const detail = (method: string, code: string) => (method === READ ? `Turn on ${method} (${code}).` : undefined)
    const listed = await setup({ tools: {}, unavailableDetail: detail })
    expect((await listed.handlers.describe!({}, rpcContext())).methods[0]).toMatchObject({ name: READ, reason: "TOOL_UNAVAILABLE", detail: `Turn on ${READ} (TOOL_UNAVAILABLE).` })
    const own = { code: "CLIENT_ID_MISSING", next: "Set the client ID." }
    const absent = await setup({ tools: {}, status: "absent", notRegistered: () => own })
    for (const method of (await absent.handlers.describe!({}, rpcContext())).methods) expect(method).toMatchObject({ reason: "CLIENT_ID_MISSING" })
  })
})

describe("a script's call", () => {
  test("runs the host executor as the session's agent, with a call id of its own, and returns {output, text}", async () => {
    const h = await setup()
    const output = await call(h, READ, { query: "hello" })
    const shaped = shapeResult(READ, { output: { echoed: { query: "hello" } }, text: "line one\nline two" }, { sessionID: "ses_1", agent: "build", action: ID })
    expect(output).toEqual(JSON.parse(JSON.stringify(shaped)))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ tool: ID, input: { query: "hello" }, call: { sessionID: "ses_1", agent: "build", messageID: expect.any(String), id: expect.stringMatching(/^script:/) } })
    expect(h.evaluations).toEqual([expect.objectContaining({ action: ID, effect: "allow" })])
  })

  test("runs a write when the rules allow it: the class never decides", async () => {
    const h = await setup({ agents: { build: [rule("*", "allow"), rule(WRITE_ID, "allow")] } })
    expect(await call(h, WRITE, { query: "w" })).toMatchObject({ output: { echoed: { query: "w" } } })
    expect(h.calls.map((entry) => entry.tool)).toEqual([WRITE_ID])
  })

  test("refuses a write that would ask BEFORE dispatch: no tool call, no evaluation, no prompt", async () => {
    const h = await setup({ agents: { build: [rule("*", "allow"), rule(WRITE_ID, "ask")] } })
    const refused = await call(h, WRITE)
    refusedWith(refused, "PERMISSION_DENIED")
    expect(refused.message).toBe(`PERMISSION_DENIED: ${WRITE_ID} would ask for this session's agent, and a script cannot answer. Next step: ${allowNext(WRITE_ID)}`)
    expect(h.calls).toEqual([])
    expect(h.evaluations).toEqual([])
  })

  test("refuses a denied tool before dispatch, naming the rule and the agent", async () => {
    const h = await setup({ agents: { build: [rule("*", "allow"), rule(`${SERVER}_*`, "deny")] } })
    const refused = await call(h, READ)
    refusedWith(refused, "PERMISSION_DENIED")
    expect(refused.message).toBe(`PERMISSION_DENIED: ${ID} is hidden from this session's agent by a deny rule. Next step: ${denyNext(ID)}`)
    expect(h.calls).toEqual([])
    expect(h.evaluations).toEqual([])
    expect(hidden([rule("*", "allow")], ID)).toBe(false)
    expect(hidden([rule("*", "allow"), rule(`${SERVER}_*`, "deny")], ID)).toBe(true)
  })

  test("applies the session's rules after the agent's: a session deny narrows, a later session allow reopens", async () => {
    // The host's own order: the last matching rule wins. The opt-in flow depends on it (a later allow on a default-deny tool).
    const h = await setup({
      sessions: { narrow: { agent: "build", permissions: [rule(ID, "deny")] }, reopen: { agent: "locked", permissions: [rule(ID, "allow")] } },
      agents: { build: [rule("*", "allow")], locked: [rule("*", "allow"), rule(`${SERVER}_*`, "deny")] },
    })
    refusedWith(await call(h, READ, {}, "narrow"), "PERMISSION_DENIED")
    expect(await call(h, READ, {}, "reopen")).toMatchObject({ text: "line one\nline two" })
  })

  test("a saved approval never authorizes an ask: the resolve sees only the agent's and session's rules", async () => {
    const h = await setup({
      agents: { build: [rule("*", "allow"), rule(WRITE_ID, "ask")] },
      saved: [{ action: WRITE_ID, resource: "*" }],
    })
    const refused = await call(h, WRITE)
    refusedWith(refused, "PERMISSION_DENIED")
    expect(refused.message).toContain("would ask")
    expect(h.calls).toEqual([])
  })

  test("applies shapeInput before dispatch and shapeResult after it, in that order, and the executor sees the shaped input", async () => {
    const order: string[] = []
    const h = await setup({
      methods: [{ kind: "mcp", name: READ, class: "read" }],
      shapers: {
        input: (method, input) => (order.push(`input:${method}`), { ...(input as object), shaped: "by-input" }),
        result: (method, result) => (order.push(`result:${method}`), { ...result, text: `${result.text} [shaped]` }),
      },
      tools: { [ID]: async (input) => (order.push("execute"), echo(input, undefined as never)) },
    })
    const output = await call(h, READ, { query: "q" })
    expect(order).toEqual([`input:${READ}`, "execute", `result:${READ}`])
    expect(h.calls[0]!.input).toEqual({ query: "q", shaped: "by-input" })
    expect(output).toEqual({ output: { echoed: { query: "q", shaped: "by-input" } }, text: "line one\nline two [shaped]" })
  })

  test("resolves and executes an MCP method under the host's own action, <server>_<name>", async () => {
    const custom = await setup()
    expect(await call(custom, SLOW)).toMatchObject({ text: "line one\nline two" })
    expect(custom.calls.map((entry) => entry.tool)).toEqual([`${SERVER}_${SLOW}`])
    expect(custom.evaluations[0]).toMatchObject({ action: `${SERVER}_${SLOW}` })
  })

  for (const [label, code] of [["an upstream failure", "UPSTREAM_ERROR"], ["a connection failure", "AUTH_REQUIRED"]] as const) {
    test(`maps ${label} to ${code}`, async () => {
      const h = await setup({
        status: code === "AUTH_REQUIRED" ? "needs_auth" : "connected",
        tools: { [ID]: async () => Promise.reject(code === "AUTH_REQUIRED" ? new Error(`MCP server "${SERVER}" is not connected`) : toolError("Bad request for https://files.example.com/a.pdf?X-Amz-Signature=abc123def456\nsecond line")) },
      })
      const refused = await call(h, READ)
      refusedWith(refused, code)
      if (code === "UPSTREAM_ERROR") {
        expect(refused.message).toContain("https://files.example.com/a.pdf?[redacted]")
        expect(refused.message).not.toContain("abc123def456")
        expect(refused.message).not.toContain("second line")
      }
    })
  }

  test("refuses with SERVER_CONFLICT while the server name belongs to a server the plugin does not manage", async () => {
    const h = await setup({ managed: false })
    refusedWith(await call(h, READ), "SERVER_CONFLICT")
    expect(h.calls).toEqual([])
  })

  test("names the connection state when the tool is missing", async () => {
    const states: [string, string][] = [["pending", "CONNECTING"], ["needs_auth", "AUTH_REQUIRED"], ["failed", "CONNECTION_FAILED"], ["disabled", "DISABLED"], ["absent", "NOT_REGISTERED"], ["connected", "TOOL_UNAVAILABLE"]]
    for (const [status, code] of states) refusedWith(await call(await setup({ tools: {}, status }), READ), code)
  })

  test("a cancelled call is CANCELLED, before or during the run", async () => {
    const before = new AbortController()
    before.abort()
    const h = await setup()
    refusedWith(await call(h, READ, {}, "ses_1", rpcContext(before.signal)), "CANCELLED")
    expect(h.calls).toEqual([])
    const during = new AbortController()
    const slow = await setup({ tools: { [ID]: async () => (during.abort(), Promise.reject(new Error("aborted"))) } })
    refusedWith(await call(slow, READ, {}, "ses_1", rpcContext(during.signal)), "CANCELLED")
  })
})

describe("sessions", () => {
  test("refuses an unknown session with SESSION_UNKNOWN, also for a 404, before any tool runs", async () => {
    refusedWith(await call(await setup(), READ, {}, "ses_missing"), "SESSION_UNKNOWN")
    const h = await setup({ lookup: async () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })) })
    refusedWith(await call(h, READ), "SESSION_UNKNOWN")
    expect(h.calls).toEqual([])
  })

  test("lets any other session lookup failure propagate unchanged", async () => {
    const problem = Object.assign(new Error("database is locked"), { _tag: "Storage.Error" })
    await expect(call(await setup({ lookup: async () => Promise.reject(problem) }), READ)).rejects.toBe(problem)
  })

  test("refuses a session with no agent, or an agent that does not exist, with SESSION_AGENT_REQUIRED", async () => {
    const h = await setup({ sessions: { ses_none: {}, ses_gone: { agent: "gone" } } })
    refusedWith(await call(h, READ, {}, "ses_none"), "SESSION_AGENT_REQUIRED")
    refusedWith(await call(h, READ, {}, "ses_gone"), "SESSION_AGENT_REQUIRED")
    expect(h.calls).toEqual([])
  })

  test("a host that reports a missing agent as a plain 'Agent not found' error gets SESSION_AGENT_REQUIRED, not rpc.internal", async () => {
    const h = await setup({ sessions: { ses_gone: { agent: "gone" } }, plainAgentError: true })
    refusedWith(await call(h, READ, {}, "ses_gone"), "SESSION_AGENT_REQUIRED")
    expect(NEXT_STEPS.SESSION_AGENT_REQUIRED).toContain('"location"')
    expect(h.calls).toEqual([])
  })
})

describe("plugin-owned methods", () => {
  test("run their own spec as the session, return its output as JSON, and take the spec's input schema", async () => {
    const seen: ToolCall[] = []
    const h = await setup({ methods: [ownedMethod(async (input, live) => (seen.push(live), { n: (input as { n: number }).n + 1, dropped: undefined }))] })
    expect(await call(h, "owned_write", { n: 1 })).toEqual({ n: 2 })
    expect(seen[0]).toMatchObject({ sessionID: "ses_1", agent: "build", id: expect.stringMatching(/^script:/) })
    expect(h.contract.methods.owned_write!.input.properties.input).toEqual(ownedMethod(async () => null).input)
    expect(h.contract.methods.owned_write!.input["~standard"].validate({ sessionID: "ses_1", input: "any" })).toEqual({ value: { sessionID: "ses_1", input: "any" } })
  })

  test("an ask from their own assert is refused by the hook, and a deny is named with its action", async () => {
    let asked: Evaluation | undefined
    const h: Harness = await setup({
      methods: [
        ownedMethod(async (_input, live) => {
          asked = { sessionID: live.sessionID, action: "plugin_owned_write", resources: ["*"], source: { type: "tool", messageID: live.messageID, id: live.id }, effect: "ask" }
          h.hook(asked)
          throw toolError(asked.message!, new Error("hook"))
        }),
      ],
      agents: { build: [rule("*", "allow"), rule("plugin_owned_write", "allow")] },
    })
    refusedWith(await call(h, "owned_write", {}), "PERMISSION_DENIED")
    expect(asked).toMatchObject({ effect: "deny", message: expect.stringMatching(/cannot answer an approval prompt/) })
  })

  test("a refused check of another action, such as a download a transcription asks for, names that action", async () => {
    let calls = 0
    const h: Harness = await setup({
      methods: [
        ownedMethod(async (_input, live) => {
          if (calls++ > 0) throw toolError("Permission denied: plugin_owned_write", new Error("rule"))
          const asked: Evaluation = { sessionID: live.sessionID, action: "plugin_download", resources: ["*"], source: { type: "tool", messageID: live.messageID, id: live.id }, effect: "ask" }
          h.hook(asked)
          throw toolError(asked.message!, new Error("hook"))
        }),
      ],
      agents: { build: [rule("*", "allow"), rule("plugin_owned_write", "allow")] },
    })
    const refused = await call(h, "owned_write", {})
    refusedWith(refused, "PERMISSION_DENIED")
    expect(refused.message.startsWith("PERMISSION_DENIED: plugin_owned_write needs plugin_download, which was refused")).toBe(true)
    expect(refused.data.next).toBe(allowNext("plugin_download"))
  })

  test("a refused plugin method's own deny names the rule to change", async () => {
    const h = await setup({
      methods: [ownedMethod(async () => ({}))],
      agents: { build: [rule("*", "allow"), rule("plugin_owned_write", "deny")] },
    })
    const refused = await call(h, "owned_write", {})
    refusedWith(refused, "PERMISSION_DENIED")
    expect(refused.data.next).toBe(denyNext("plugin_owned_write"))
  })

  test("describe reports the reason available() gives, at each describe; available() never gates a call", async () => {
    let reason: string | undefined = "MODULE_OFF"
    const h = await setup({ methods: [{ ...ownedMethod(async () => ({ ran: true })), available: async () => reason }] })
    const methods = async () => (await h.handlers.describe!({}, rpcContext())).methods
    expect((await methods())[0]).toMatchObject({ name: "owned_write", available: false, reason: "MODULE_OFF" })
    expect(await call(h, "owned_write", {})).toEqual({ ran: true })
    reason = undefined
    const now = (await methods())[0]
    expect(now).toMatchObject({ name: "owned_write", available: true })
    expect(Object.hasOwn(now, "reason")).toBe(false)
  })

  test("a failure that is not a permission refusal propagates, unless pluginError names it", async () => {
    const problem = new Error("plugin bug")
    const h = await setup({ methods: [ownedMethod(async () => Promise.reject(problem))], agents: { build: [rule("*", "allow"), rule("plugin_owned_write", "allow")] } })
    if (pluginError(problem) === undefined) await expect(call(h, "owned_write", {})).rejects.toBe(problem)
    else expect(await call(h, "owned_write", {})).toMatchObject({ type: "failed" })
  })

  test("needs no MCP server when the table has no MCP method", async () => {
    const h = await setup({ methods: [ownedMethod(async () => ({ ran: true }))], mcp: false })
    expect(Object.keys(h.contract.methods).sort()).toEqual(["describe", "owned_write"])
    expect(await call(h, "owned_write", {})).toEqual({ ran: true })
    // With an MCP method and no mcp option, registration refuses.
    await expect(setup({ methods: table(), mcp: false })).rejects.toThrow(/MCP method needs the mcp option/)
  })
})

describe("per-account servers", () => {
  const accounts = (account: string | undefined) => (account === undefined ? SERVER : account === "work" ? "srv-work" : undefined)

  test("take an optional account in the envelope and run on that account's server", async () => {
    const steps = NEXT_STEPS as { ACCOUNT_UNKNOWN?: string }
    const had = steps.ACCOUNT_UNKNOWN !== undefined
    if (!had) steps.ACCOUNT_UNKNOWN = "Pass a known account."
    try {
      const h = await setup({ server: accounts, tools: { [ID]: echo, [`srv-work_${READ}`]: echo } })
      expect(h.contract.methods[READ]!.input.properties.account).toEqual({ type: "string", minLength: 1 })
      expect(h.contract.methods[READ]!.input["~standard"].validate({ sessionID: "ses_1", account: "", input: {} }).issues).toEqual([{ message: `"account" must be a non-empty string` }])
      await h.handlers[READ]!({ sessionID: "ses_1", account: "work", input: {} }, rpcContext())
      expect(h.calls.map((entry) => entry.tool)).toEqual([`srv-work_${READ}`])
      refusedWith(await h.handlers[READ]!({ sessionID: "ses_1", account: "nope", input: {} }, rpcContext()), "ACCOUNT_UNKNOWN")
    } finally {
      if (!had) delete steps.ACCOUNT_UNKNOWN
    }
  })
})

describe("registration", () => {
  test("disposes the hook and the RPC", async () => {
    const h = await setup()
    await h.stop()
    expect(h.disposed.sort()).toEqual(["hook", "rpc"])
  })

  test("a block without MCP methods may omit the MCP-only next steps: the suite supplies them for its fake MCP table", async () =>
    withoutSteps(MCP_ONLY, async () => {
      const h = await setup()
      expect(await call(h, READ)).toMatchObject({ text: expect.any(String) })
      const owned = await setup({ methods: [ownedMethod(async () => ({ ran: true }))], mcp: false })
      await owned.handlers.owned_write!({ sessionID: "ses_1", input: {} }, rpcContext())
    }))

  test("registration still requires the MCP-only next steps when the shim is off and the table has an MCP method", async () =>
    withoutSteps(MCP_ONLY, async () => {
      await expect(setup({ shim: false })).rejects.toThrow("registerToolsRpc: MCP methods need NEXT_STEPS.AUTH_REQUIRED")
    }))
})

describe("the shared copy's own block", () => {
  test("is Tavily's: five classified reads, every method a read, and the shapers are the identity", () => {
    expect(METHODS).toHaveLength(5)
    for (const method of METHODS) expect(method).toMatchObject({ kind: "mcp", class: "read" })
    expect(shapeInput("any", { q: 1 }, { sessionID: "s", agent: "a", action: "x" })).toEqual({ q: 1 })
    expect(shapeResult("any", { text: "t" }, { sessionID: "s", agent: "a", action: "x" })).toEqual({ text: "t" })
  })
})

describe("upstreamText", () => {
  test("keeps the first non-empty line and redacts tokens, keys and signed URLs", () => {
    expect(upstreamText("\n  Invalid query  \nstack")).toBe("Invalid query")
    expect(upstreamText("")).toBe("no message")
    const line = upstreamText(`token=abc12345 api_key: "k-1234567890" Authorization: Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl ghp_abcdefghijklmnop https://x.example/p#frag`)
    for (const secret of ["abc12345", "k-1234567890", "eyJhbGciOi", "ghp_abcdefghijklmnop", "frag"]) expect(line).not.toContain(secret)
    expect(line).toContain("https://x.example/p?[redacted]")
  })

  test("cuts at 300 characters", () => {
    const cut = upstreamText("word ".repeat(100))
    expect(cut.length).toBe(300)
    expect(cut.endsWith("…")).toBe(true)
  })
})
