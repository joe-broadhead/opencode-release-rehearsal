// The built package as users get it: `npm pack`, then `npm install --ignore-scripts` of the tarball into an empty
// project, offline, with the npm on PATH. Run it after `npm run build` (check does). PACK_TARBALL tests a tarball that
// is already packed instead, such as the one the release workflow publishes. The tarball holds only
// JavaScript, skills, docs and the Jelly icon; the install adds nothing else; and the installed package imports, and
// loads in each stock OpenCode release it is tested on (startStock in ../host/harness.ts). On each release it also
// signs in both ways, OAuth and an API key, against a loopback fake Tavily, and a script calls the tools through the
// tools RPC.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { Tavily } from "../../src/rpc/index.js"
import { defaultRules } from "../../src/permissions.js"
import { SERVER_URL } from "../../src/mcp.js"
import { METHODS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { NEW_TOOL, RECORDED_TOOLS } from "../host/catalog.js"
import { RATE_LIMITED, startFakeTavily, UPSTREAM_FAILURE, type FakeTavily } from "../host/fake-tavily.js"
import { cleanup, npm, REPO, root, startStock, STOCK_VERSIONS, until, type Host } from "../host/harness.js"
import { schemaErrors } from "../schema.js"

/** Tavily's key check, which the bundle calls. */
const USAGE_URL = "https://api.tavily.com/usage"

// Packing, installing, and downloading and starting a stock host take minutes in a slow container (see READY_MS in
// harness.ts).
setDefaultTimeout(300_000)

const NAME = "@joe-broadhead/opencode-release-rehearsal"
const ALLOWED = /^(package\.json|README\.md|LICENSE|CHANGELOG\.md|assets\/icon(-128|-256)?\.(svg|png)|dist\/.+|skills\/.+)$/
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "assets/icon.svg",
  "assets/icon-128.png",
  "assets/icon-256.png",
  "dist/index.js",
  "dist/tui.js",
  "skills/tavily/SKILL.md",
  "skills/tavily-research/SKILL.md",
]
const LIFECYCLE = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepack", "postpack"]
  .concat(["prepublish", "prepublishOnly", "publish", "postpublish", "preuninstall", "uninstall", "postuninstall", "dependencies"])
/** What OpenCode supplies to plugins at runtime. Nothing else may be imported. */
const HOST_MODULES = /^(@opencode\/plugin(\/.+)?|@opentui\/(core|solid)(\/.+)?|solid-js(\/.+)?)$/
const UI_MODULES = /^(@opentui\/|solid-js)/

const work = join(root, "pack")
const project = join(work, "project")
const installed = join(project, "node_modules", NAME)

type Packed = { filename: string; size: number; unpackedSize: number; entryCount: number; files: { path: string }[] }
let packed: Packed
let manifest: Record<string, any>

beforeAll(async () => {
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "tavily-pack-test", version: "0.0.0", private: true }))
  let tarball: string
  if (process.env.PACK_TARBALL) {
    tarball = resolve(process.env.PACK_TARBALL)
    ;[packed] = JSON.parse(await npm(["pack", "--dry-run", "--ignore-scripts", "--json", tarball], project)) as Packed[]
  } else {
    if (!existsSync(join(REPO, "dist/index.js"))) throw new Error("dist/ is missing. Run npm run build first.")
    ;[packed] = JSON.parse(await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", work], REPO)) as Packed[]
    tarball = join(work, packed.filename)
  }
  // Offline: the tarball must need nothing from the registry.
  await npm(["install", "--ignore-scripts", "--offline", tarball], project)
  manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
})
afterAll(cleanup)

const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  )

describe("the tarball", () => {
  test("holds only dist, skills, assets/icon.svg, README.md, LICENSE, CHANGELOG.md and package.json, under 300 KB and 80 files", () => {
    const paths = packed.files.map((file) => file.path)
    expect(paths.filter((path) => !ALLOWED.test(path))).toEqual([])
    expect(REQUIRED.filter((path) => !paths.includes(path))).toEqual([])
    expect(packed.entryCount).toBeLessThan(80)
    expect(packed.unpackedSize).toBeLessThan(300 * 1024)
  })

  test("ships no TypeScript, TSX or declaration files, only JavaScript", () => {
    expect(packed.files.map((file) => file.path).filter((path) => /\.[cm]?tsx?$/.test(path))).toEqual([])
  })

  test("declares no dependencies, peers or lifecycle scripts, and states the tested host range", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "overrides"])
      expect(manifest[field]).toBeUndefined()
    expect(Object.keys(manifest.scripts ?? {}).filter((script) => LIFECYCLE.includes(script))).toEqual([])
    expect(manifest.opencode).toMatchObject({ host: ">=2.2.3 <2.3.0", vendor: { id: "tavily", name: "Tavily", domain: "tavily.com" } })
    expect(manifest.opencode.icons.map((icon: { src: string }) => icon.src)).toEqual(["assets/icon.svg", "assets/icon-128.png", "assets/icon-256.png"])
    expect(manifest.exports).toEqual({
      ".": "./dist/index.js",
      "./tui": "./dist/tui.js",
      "./icon.svg": "./assets/icon.svg",
      "./icon-128.png": "./assets/icon-128.png",
      "./icon-256.png": "./assets/icon-256.png",
    })
    for (const target of Object.values(manifest.exports as Record<string, string>)) expect(existsSync(join(installed, target))).toBe(true)
  })
})

describe("the install", () => {
  test("adds only this package: no peers, no dependencies, no bundled modules", () => {
    const visible = (directory: string) => readdirSync(directory).filter((entry) => !entry.startsWith("."))
    expect(visible(join(project, "node_modules"))).toEqual(["@joe-broadhead"])
    expect(visible(join(project, "node_modules", "@joe-broadhead"))).toEqual(["opencode-release-rehearsal"])
    expect(existsSync(join(installed, "node_modules"))).toBe(false)
  })

  // OpenCode reloads a plugin in place but keeps the module records of unchanged paths, so a new entry that imports a
  // sibling module can get a stale copy of it. With exactly two self-contained entries there is no sibling to go stale.
  test("dist holds exactly index.js and tui.js, and neither imports, import()s or requires a relative path", () => {
    expect(files(join(installed, "dist")).map((file) => relative(installed, file)).sort()).toEqual(["dist/index.js", "dist/tui.js"])
    const scanner = new Bun.Transpiler({ loader: "js" })
    for (const where of ["dist/index.js", "dist/tui.js"]) {
      const text = readFileSync(join(installed, where), "utf8")
      const relativeImports = scanner.scan(text).imports.filter(({ path }) => !/^(node:|@|[a-z])/.test(path))
      expect({ where, relativeImports }).toEqual({ where, relativeImports: [] })
      expect({ where, require: /\brequire\s*\(/.test(text) }).toEqual({ where, require: false })
    }
  })

  test("its JavaScript imports only Node built-ins and host modules; only dist/tui.js imports the UI", () => {
    const scanner = new Bun.Transpiler({ loader: "js" })
    for (const where of ["dist/index.js", "dist/tui.js"]) {
      for (const { path } of scanner.scan(readFileSync(join(installed, where), "utf8")).imports) {
        expect({ where, path, allowed: path.startsWith("node:") || HOST_MODULES.test(path) }).toEqual({ where, path, allowed: true })
        if (where !== "dist/tui.js") expect({ where, ui: UI_MODULES.test(path) }).toEqual({ where, ui: false })
      }
    }
  })

  test("imports dist/index.js and dist/tui.js when the host modules are supplied", async () => {
    // OpenCode supplies these to plugins. Linking them beside the project, not inside it, keeps the install as it is.
    for (const name of ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"]) {
      mkdirSync(join(work, "node_modules", dirname(name)), { recursive: true })
      symlinkSync(join(REPO, "node_modules", name), join(work, "node_modules", name), "dir")
    }
    const server = await import(join(installed, "dist/index.js"))
    const tui = await import(join(installed, "dist/tui.js"))
    expect(server.default.id).toBe("tavily.web")
    expect(tui.default.id).toBe("tavily.web.tui")
  })
})

/** The host's last-match evaluation of an MCP tool call, which asserts `<server>_<tool>` on resource `*`. */
async function effect(host: Host, agent: string, action: string) {
  const { id: sessionID } = await host.client.session.create({ agent, location: host.location })
  return (await host.client.permission.create({ sessionID, agent, action, resources: ["*"], save: ["*"] })).effect
}

for (const version of STOCK_VERSIONS)
  describe(`the installed package on stock OpenCode ${version}`, () => {
    let host: Host
    beforeAll(async () => {
      host = await startStock(version, installed)
    })
    afterAll(() => host?.close())

    test("loads from its directory with its server and TUI parts", async () => {
      const { data: plugins } = await host.client.plugin.list({ location: host.location })
      const entry = plugins.find((plugin) => plugin.id === "tavily.web")
      expect(entry?.state).toEqual({ status: "active" })
      expect(entry?.source).toEqual({ type: "local", path: expect.stringContaining(join("node_modules", NAME)) })
      // The host reports `rpc` only for a `./rpc` export, which it never loads; the server part registers the RPC.
      expect(entry?.features).toEqual({ server: true, tui: true })
    })

    test("registers the tavily server, /tavily-status and the packaged skills, and answers status", async () => {
      const { data: servers } = await host.client.mcp.list({ location: host.location })
      expect(servers.map((server) => server.name)).toContain("tavily")
      const { data: commands } = await host.client.command.list({ location: host.location })
      expect(commands.map((command) => command.name)).toContain("tavily-status")
      const { data: skills } = await host.client.skill.list({ location: host.location })
      const packaged = skills.filter((skill) => skill.id.startsWith("tavily"))
      expect(packaged.map((skill) => skill.id).sort()).toEqual(["tavily", "tavily-research"])
      for (const skill of packaged) expect(skill.path).toContain(join("node_modules", NAME, "skills"))
      const { output } = await host.client.rpc.call({ rpcID: "tavily.web", method: "status", input: {}, location: host.location })
      expect(schemaErrors(Tavily.methods.status.output, output)).toEqual([])
      // The proxy refuses every request, so the server fails to connect (see startStock).
      expect(output).toMatchObject({ version: manifest.version, state: "failed", auth: "oauth", host: { version, range: ">=2.2.3 <2.3.0", tested: true }, unguardedAgents: [] })
    })

    test("/connect lists the built-in key entry as Tavily and the server's OAuth entry as Tavily account", async () => {
      const { data: servers } = await host.client.mcp.list({ location: host.location })
      const oauth = servers.find((server) => server.name === "tavily")?.integrationID
      const names = await until("the OAuth entry is named Tavily account", async () => {
        const { data } = await host.client.integration.list({ location: host.location })
        const found = Object.fromEntries(data.filter((entry) => entry.id === "tavily" || entry.id === oauth).map((entry) => [entry.id, entry.name]))
        return oauth && found[oauth] === "Tavily account" ? found : undefined
      })
      expect(names).toEqual({ tavily: "Tavily", [oauth!]: "Tavily account" })
    })

    test("puts the default rules right after each built-in agent's base allow, and the host enforces them", async () => {
      const { data: agents } = await host.client.agent.list({ location: host.location })
      for (const id of ["build", "plan", "explore"]) {
        const permissions = agents.find((agent) => agent.id === id)?.permissions
        expect(permissions?.slice(0, 1 + defaultRules().length)).toEqual([{ action: "*", resource: "*", effect: "allow" }, ...defaultRules()])
      }
      expect(await effect(host, "build", "tavily_tavily_feedback")).toBe("allow")
      expect(await effect(host, "build", "tavily_tavily_search")).toBe("allow")
      expect(await effect(host, "explore", "tavily_tavily_search")).toBe("deny")
    })
  })

/**
 * A copy of the installed package whose two Tavily URLs, the MCP server and the key check, point at `fake`. The rest
 * is the installed build, so a stock host's requests to Tavily, and their Authorization headers, can be seen.
 */
function pointedAt(fake: FakeTavily, name: string) {
  const copy = join(work, "pointed", name)
  cpSync(installed, copy, { recursive: true })
  const entry = join(copy, "dist/index.js")
  const text = readFileSync(entry, "utf8")
  for (const url of [SERVER_URL, USAGE_URL]) expect({ url, found: text.includes(url) }).toEqual({ url, found: true })
  writeFileSync(entry, text.replaceAll(SERVER_URL, fake.url).replaceAll(USAGE_URL, `${fake.origin}/usage`))
  return copy
}

const rpcStatus = async (host: Host) =>
  (await host.client.rpc.call({ rpcID: "tavily.web", method: "status", input: {}, location: host.location })).output as Record<string, unknown>

async function tavilyServer(host: Host) {
  const { data } = await host.client.mcp.list({ location: host.location })
  return data.find((server) => server.name === "tavily")
}

/** Waits until `fake` has seen, since request `from`, the MCP handshake, the tool list and the key check with `Bearer <key>`. */
async function sentWith(fake: FakeTavily, from: number, key: string) {
  await until("the server and the key check send the key as a bearer header", async () => {
    const sent = new Set(fake.requests.slice(from).filter((request) => request.authorization === `Bearer ${key}`).map((request) => request.method))
    return ["initialize", "tools/list", "usage"].every((method) => sent.has(method)) || undefined
  })
  expect(fake.requests.some((request) => request.search.includes(key))).toBe(false)
}

/** Waits until status reports `auth` with an accepted key, the server connected and its five tools listed. */
const keyReady = (host: Host, auth: string) =>
  until(`the server is connected with ${auth}`, async () => {
    const status = await rpcStatus(host)
    const tools = status.tools as { visible: number }
    return status.auth === auth && status.state === "connected" && status.keyCheck === "accepted" && tools.visible === 5 ? status : undefined
  })

async function removeKey(host: Host) {
  const credential = (await host.client.credential.list()).find((entry) => entry.integrationID === "tavily")
  await host.client.credential.remove({ credentialID: credential!.id })
}

/** No fake key in an API answer or in the server's log. */
async function expectHidden(host: Host, keys: readonly string[]) {
  const location = { location: host.location }
  const outputs = await Promise.all([host.client.mcp.list(location), host.client.integration.list(location), host.client.config.get(location), rpcStatus(host)])
  const text = JSON.stringify(outputs) + (host.log?.() ?? "")
  for (const key of keys) expect(text.includes(key)).toBe(false)
}

for (const version of STOCK_VERSIONS)
  describe(`OAuth and an API key on stock OpenCode ${version}`, () => {
    const ENV_KEY = "tvly-pack-test-env-key"
    const CONNECTED_KEY = "tvly-pack-test-connected-key"
    let oauthFake: FakeTavily
    let envFake: FakeTavily
    let oauth: Host
    let env: Host
    beforeAll(async () => {
      oauthFake = await startFakeTavily(RECORDED_TOOLS, { requireAuth: true })
      envFake = await startFakeTavily(RECORDED_TOOLS, { requireAuth: true })
      oauth = await startStock(version, pointedAt(oauthFake, `oauth-${version}`))
      // TAVILY_API_KEY in the server's environment, as a background service started with it has.
      env = await startStock(version, pointedAt(envFake, `env-${version}`), { TAVILY_API_KEY: ENV_KEY })
    })
    afterAll(async () => {
      await oauth?.close()
      await env?.close()
      await oauthFake?.close()
      await envFake?.close()
    })

    test("with no key, Tavily asks for OAuth; a connected key connects with a bearer header; removing it returns to OAuth", async () => {
      expect(await rpcStatus(oauth)).toMatchObject({ state: "sign_in_required", auth: "oauth" })
      expect(oauthFake.requests.some((request) => request.authorized)).toBe(false)

      const from = oauthFake.requests.length
      await oauth.client.integration.connect.key({ integrationID: "tavily", key: CONNECTED_KEY, label: "Pack test key", location: oauth.location })
      await sentWith(oauthFake, from, CONNECTED_KEY)
      expect(await keyReady(oauth, "key_connected")).toMatchObject({ account: "Pack test key", nextStep: "Nothing to do." })
      expect((await tavilyServer(oauth))?.integrationID).toBeUndefined()

      const removed = oauthFake.requests.length
      await removeKey(oauth)
      await until("the server returns to OAuth", async () => {
        const server = await tavilyServer(oauth)
        return /^mcp_/.test(server?.integrationID ?? "") && server?.status.status === "needs_auth"
      })
      expect(await rpcStatus(oauth)).toMatchObject({ state: "sign_in_required", auth: "oauth" })
      const after = oauthFake.requests.slice(removed).filter((request) => request.method === "initialize")
      expect(after.length).toBeGreaterThan(0)
      expect(after.every((request) => !request.authorized)).toBe(true)
      await expectHidden(oauth, [CONNECTED_KEY])
    })

    test("TAVILY_API_KEY in the server's environment connects; a connected key wins; removing it returns to TAVILY_API_KEY", async () => {
      await sentWith(envFake, 0, ENV_KEY)
      expect(await keyReady(env, "key_env")).toMatchObject({ nextStep: "Nothing to do." })

      const from = envFake.requests.length
      await env.client.integration.connect.key({ integrationID: "tavily", key: CONNECTED_KEY, label: "Wins", location: env.location })
      await sentWith(envFake, from, CONNECTED_KEY)
      expect(await keyReady(env, "key_connected")).toMatchObject({ account: "Wins" })

      const back = envFake.requests.length
      await removeKey(env)
      await sentWith(envFake, back, ENV_KEY)
      await keyReady(env, "key_env")
      await expectHidden(env, [ENV_KEY, CONNECTED_KEY])
    })
  })

/** A tools RPC call's result, or its error's `{ type, code, message }`. */
async function script(host: Host, method: string, input: unknown): Promise<Record<string, any>> {
  try {
    return { value: (await host.client.rpc.call({ rpcID: TOOLS_RPC_ID, method, input: input as never, location: host.location })).output }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

const rule = (action: string, effect: "allow" | "deny" | "ask") => ({ action, resource: "*", effect })

for (const version of STOCK_VERSIONS)
  describe(`the tools RPC on stock OpenCode ${version}`, () => {
    const KEY = "tvly-pack-test-script-key"
    const sessions: Record<string, string> = {}
    let fake: FakeTavily
    let host: Host
    // Each call the fake Tavily answered since `from`, by tool.
    const toolCalls = (from = 0) => fake.requests.slice(from).filter((request) => request.method === "tools/call").map((request) => request.tool)
    const call = (session: string, method: string, input: unknown) => script(host, method, { sessionID: sessions[session] ?? session, input })

    beforeAll(async () => {
      fake = await startFakeTavily([...RECORDED_TOOLS, NEW_TOOL], { requireAuth: true })
      host = await startStock(version, pointedAt(fake, `tools-${version}`), { TAVILY_API_KEY: KEY }, {
        // Config-only agents carry exactly these rules after the host's defaults.
        agents: { locked: { permissions: [rule("tavily_*", "deny")] }, careful: { permissions: [rule("tavily_tavily_search", "ask")] } },
      })
      await until("the server is connected with its six tools", async () => {
        const status = await rpcStatus(host)
        return status.state === "connected" && (status.tools as { visible: number }).visible === 6
      })
      const create = async (input: Record<string, unknown>) => (await host.client.session.create({ location: host.location, ...input })).id
      sessions.build = await create({ agent: "build" })
      sessions.locked = await create({ agent: "locked" })
      sessions.careful = await create({ agent: "careful" })
      sessions.agentless = await create({})
      // Session rules come after the agent's: one narrows build, the other reopens one tool for locked.
      sessions.narrow = await create({ agent: "build", permissions: [rule("tavily_tavily_search", "deny")] })
      sessions.reopen = await create({ agent: "locked", permissions: [rule("tavily_tavily_search", "allow")] })
    })
    afterAll(async () => {
      await host?.close()
      await fake?.close()
    })

    test("describes exactly the five known reads, with their class and live schemas; a new tool is no method", async () => {
      const description = await script(host, "describe", {})
      expect(description.value.methods.map((method: { name: string }) => method.name)).toEqual(METHODS.map((method) => method.name))
      for (const method of description.value.methods) expect(method).toMatchObject({ kind: "mcp", class: "read", available: true, action: `tavily_${method.name}` })
      expect(description.value.methods[0].input).toEqual(RECORDED_TOOLS[0]!.inputSchema)
      const refused = await script(host, NEW_TOOL.name, { sessionID: sessions.build, input: { query: "q" } })
      expect(refused.type).not.toBe("failed")
      expect(refused.message).toMatch(/not.?found|unknown/i)
      expect(toolCalls()).not.toContain(NEW_TOOL.name)
    })

    test("runs a known read as a session whose agent allows it, through OpenCode's own sign-in, with no model turn", async () => {
      const from = fake.requests.length
      const result = await call("build", "tavily_search", { query: "hello" })
      expect(result).toEqual({ value: { output: { tool: "tavily_search", query: "hello" }, text: "tavily_search: hello" } })
      const sent = fake.requests.slice(from).filter((request) => request.method === "tools/call")
      expect(sent.map((request) => [request.tool, request.authorization === `Bearer ${KEY}`])).toEqual([["tavily_search", true]])
      const session = await host.client.session.get({ sessionID: sessions.build! })
      expect(session.outcome).toBeUndefined()
      expect(session.tokens).toMatchObject({ input: 0, output: 0 })
      expect(JSON.stringify(result)).not.toContain(KEY)
    })

    test("refuses a session whose agent denies Tavily, before Tavily is called", async () => {
      const from = fake.requests.length
      const result = await call("locked", "tavily_search", { query: "q" })
      expect(result).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      expect(toolCalls(from)).toEqual([])
    })

    test("refuses an ask at once, and leaves no approval prompt waiting", async () => {
      const from = fake.requests.length
      const started = Date.now()
      const result = await call("careful", "tavily_search", { query: "q" })
      expect(result).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      expect(result.message).toMatch(/would ask for this session's agent, and a script cannot answer/)
      expect(Date.now() - started).toBeLessThan(5000)
      const { data: pending } = await host.client.permission.request.list({ location: host.location })
      expect(pending.filter((request) => JSON.stringify(request).includes(sessions.careful!))).toEqual([])
      expect(toolCalls(from)).toEqual([])
      // The same agent's other tools have no ask, so they run.
      expect((await call("careful", "tavily_extract", { urls: ["https://example.invalid"] })).value).toMatchObject({ text: expect.any(String) })
    })

    test("applies the session's rules after the agent's", async () => {
      expect(await call("narrow", "tavily_search", { query: "q" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      expect((await call("narrow", "tavily_map", { url: "https://example.invalid" })).value).toMatchObject({ output: { tool: "tavily_map" } })
      expect((await call("reopen", "tavily_search", { query: "q" })).value).toMatchObject({ output: { tool: "tavily_search" } })
      expect(await call("reopen", "tavily_crawl", { url: "https://example.invalid" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    })

    test("gives Tavily's own error as UPSTREAM_ERROR: its first line, with the signed URL redacted", async () => {
      const result = await call("build", "tavily_search", { query: "fail" })
      expect(result).toMatchObject({ type: "failed", code: "UPSTREAM_ERROR" })
      expect(result.message).toContain("https://files.example.invalid/a.pdf?[redacted]")
      for (const hidden of ["fake-signature-123", "second line"]) expect(result.message).not.toContain(hidden)
      expect(UPSTREAM_FAILURE).toContain("fake-signature-123")
    })

    test("gives Tavily's error object, answered as a result, as UPSTREAM_ERROR with its own next step", async () => {
    const result = await call("build", "tavily_map", { url: "https://example.invalid", query: "limit" })
    expect(result).toEqual({
      type: "failed",
      code: "UPSTREAM_ERROR",
      message:
        "UPSTREAM_ERROR: tavily_tavily_map failed: Tavily answered with error 429: Map failed: Your request has been blocked due to excessive requests. Verify you are using production API keys. Next step: Wait a minute, then retry; if it keeps happening, check your Tavily plan and API key at https://app.tavily.com.",
    })
    expect(RATE_LIMITED.status).toBe(429)
  })

  test("names an unknown session, a session without an agent, and rejects an envelope with extra keys", async () => {
      expect(await call("ses_does_not_exist", "tavily_search", { query: "q" })).toMatchObject({ type: "failed", code: "SESSION_UNKNOWN" })
      expect(await call("agentless", "tavily_search", { query: "q" })).toMatchObject({ type: "failed", code: "SESSION_AGENT_REQUIRED" })
      const from = fake.requests.length
      for (const envelope of [{ sessionID: sessions.build, input: { query: "q" }, extra: true }, { input: { query: "q" } }, { sessionID: sessions.build, input: "q" }])
        expect(await script(host, "tavily_search", envelope)).toMatchObject({ type: "rpc.invalid_input" })
      expect(toolCalls(from)).toEqual([])
    })
  })
