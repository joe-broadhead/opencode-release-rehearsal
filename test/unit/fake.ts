// Fakes typed against the public @opencode/plugin 2.2.3 Context. No host source.
import { Agent, type Credential, type Mcp, type Plugin } from "@opencode/plugin"

type Context = Plugin.Context
export type EditorOf<D extends { readonly transform: (...args: any) => unknown }> = Parameters<Parameters<D["transform"]>[0]>[0]
type McpEditor = EditorOf<Context["mcp"]>
type StoredServer = NonNullable<ReturnType<McpEditor["get"]>>
export type Connection = NonNullable<Awaited<ReturnType<Context["integration"]["connection"]["active"]>>>
export type McpServer = Awaited<ReturnType<Context["mcp"]["list"]>>["data"][number]
export type AgentInfo = Awaited<ReturnType<Context["agent"]["list"]>>["data"][number]
type Rules = EditorOf<Context["agent"]>["list"] extends () => readonly (infer A extends { permissions: unknown })[]
  ? A["permissions"]
  : never

export const LOCATION = { directory: "/tmp/tavily-test" }
const registration = { dispose: async () => {} }

/** Records transform callbacks so a test can replay them, as the host does on every rebuild. */
export function transforms<E>() {
  const callbacks: ((editor: E) => void)[] = []
  return {
    transform: async (callback: (editor: E) => void) => {
      callbacks.push(callback)
      return registration
    },
    run: (editor: E) => callbacks.forEach((callback) => callback(editor)),
  }
}

// A JSON copy turns the readonly config into the editor's mutable shape, as the host's editor does.
const copy = (config: Mcp.ServerConfig): StoredServer => JSON.parse(JSON.stringify(config))

export function mcpEditor(initial: Record<string, Mcp.ServerConfig> = {}) {
  const servers = new Map(Object.entries(initial).map(([name, config]) => [name, copy(config)]))
  const sets: string[] = []
  const editor: McpEditor = {
    list: () => [...servers.entries()],
    get: (name) => servers.get(name),
    set: (name, config) => {
      sets.push(name)
      servers.set(name, copy(config))
    },
    update: () => {},
    remove: (name) => void servers.delete(name),
  }
  return { editor, servers, sets }
}

export function agent(id: string, permissions: Rules = Agent.Info.default(Agent.ID.make(id)).permissions) {
  return { ...Agent.Info.default(Agent.ID.make(id)), permissions: permissions.map((rule) => ({ ...rule })) }
}

export function agentEditor(agents: ReturnType<typeof agent>[]) {
  const editor: EditorOf<Context["agent"]> = {
    list: () => agents,
    get: (id) => agents.find((entry) => entry.id === id),
    default: () => {},
    update: (id, update) => {
      const entry = agents.find((candidate) => candidate.id === id)
      if (entry) update(entry)
    },
    remove: () => {},
  }
  return editor
}

export function websearchEditor(selected: string | false | undefined) {
  const state = { selected, sets: 0 }
  const editor: EditorOf<Context["websearch"]> = {
    add: () => {},
    default: {
      get: () => state.selected,
      set: (selection) => {
        state.selected = selection
        state.sets++
      },
    },
  }
  return { editor, state }
}

/** The built-in `tavily` integration: an optional active connection and what it resolves to. */
export function integration(initial: { connection?: Connection; value?: Credential.Value }) {
  const state = { ...initial, resolves: 0, fail: undefined as Error | undefined, failActive: undefined as Error | undefined }
  const domain: Pick<Context["integration"], "connection"> = {
    connection: {
      active: async () => {
        if (state.failActive) throw state.failActive
        return state.connection
      },
      resolve: async () => {
        state.resolves++
        if (state.fail) throw state.fail
        return state.value
      },
      status: async () => {},
    },
  }
  return { domain, state }
}

export const keyConnection = (label = "Tavily"): Connection => ({ type: "credential", id: "cred_1", label, method: "key" })
export const envConnection = (): Connection => ({ type: "env", name: "TAVILY_API_KEY" })
export const keyValue = (key: string): Credential.Value => ({ type: "key", key })

/** A live-only event stream that ends when the subscriber's signal aborts. */
export function events() {
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  const subscribe = (options?: { readonly signal?: AbortSignal }) =>
    (async function* () {
      const signal = options?.signal
      while (!signal?.aborted) {
        if (queue.length > 0) yield queue.shift()
        else
          await new Promise<void>((resolve) => {
            wake = resolve
            signal?.addEventListener("abort", () => resolve(), { once: true })
          })
      }
    })()
  return {
    // The fake stream yields only the type and the data that the plugin reads.
    domain: { subscribe } as unknown as Context["event"],
    push: (type: string, data?: unknown) => {
      queue.push({ type, data })
      wake?.()
    },
  }
}

/** Resolves after pending microtasks and timers, so async loops can catch up. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
