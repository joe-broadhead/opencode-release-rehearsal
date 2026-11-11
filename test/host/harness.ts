// Hosts the plugin on OpenCode through public packages only, in two ways:
// - startHost: the embedded host of @opencode/sdk (the dev pin, 2.2.3) in this process, with the plugin from src.
//   Requests to mcp.tavily.com and to Tavily's key check, api.tavily.com/usage, go to `hostedTavily`, a loopback fake
//   that answers as Tavily does, and any other request off loopback fails.
// - startStock: `opencode serve` of a stock release on a free loopback port with a password, loading an installed
//   package. Its HTTP(S) proxy refuses every request, so Tavily's server reports "failed", and the models fetch, the
//   update check and the free models are off.
// Each host gets its own folder in one temp root, holding HOME, XDG_*, OPENCODE_TEST_HOME, TMPDIR, the config, the
// database and the project, and runs in it, so no real config or credential is read. Each host checks that
// OpenCode's global paths are inside the temp root. Nothing reaches Tavily.
// The temp root is under /tmp, never under the user's home: OpenCode searches the folders above a project for
// `.opencode/` config, so a root inside the home would pick up the user's agents and skills. Each project is its own
// git worktree, where that search stops, and no folder above the root may hold `.opencode/`. A stock host's managed
// service, if its CLI ever starts one, has its own port, never OpenCode's default.
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type AddressInfo, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OpenCode as Client, type OpenCodeClient } from "@opencode/client"
import { Plugin, type PluginOptions } from "@opencode/plugin"
import plugin from "../../src/index.js"
import { TESTED_HOSTS } from "../../src/host-version.js"
import { RECORDED_TOOLS } from "./catalog.js"
import { startFakeTavily, type FakeTavily } from "./fake-tavily.js"
import probe from "./probe.js"

export const REPO = fileURLToPath(new URL("../../", import.meta.url))

/** The temp root of every host and of the pack test: under /tmp (/private/tmp on macOS), whatever TMPDIR says. */
export const root = realpathSync(mkdtempSync("/tmp/tavily-host-"))

/** Throws when a folder above the temp root holds `.opencode/`, which OpenCode's upward config search would read. */
function expectNoConfigAbove(folder: string) {
  for (let parent = dirname(folder); ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".opencode")))
      throw new Error(`The test isolation failed: ${join(parent, ".opencode")} is above the temp root ${root}, and OpenCode would read it.`)
    if (parent === dirname(parent)) return
  }
}
expectNoConfigAbove(root)

/** Keys the fake Tavily rejects at its key check; Tavily's MCP endpoint still accepts them, as it accepts any. */
export const REJECTED = "rejected"

let hosted: Promise<FakeTavily> | undefined

/** The fake that answers the embedded hosts' requests to Tavily, started on first use. */
export const hostedTavily = () =>
  (hosted ??= startFakeTavily(RECORDED_TOOLS, { requireAuth: true, accepts: (key) => !key.includes(REJECTED) }))

/** Removes every host's temp root and stops the fake Tavily; call once after every host in the file has closed. */
export async function cleanup() {
  await (await hosted)?.close()
  rmSync(root, { recursive: true, force: true })
}

/** Stock binaries given as OPENCODE_BIN_2_2_3 and so on, read before the environment is cleared below. */
const GIVEN_BINARIES = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("OPENCODE_BIN_")))

/** A home inside the temp root. Bun's os.homedir() ignores HOME, so OpenCode takes its home from OPENCODE_TEST_HOME. */
export function isolatedEnv(home: string): Record<string, string> {
  const tmp = join(home, "tmp")
  mkdirSync(tmp, { recursive: true })
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENCODE_TEST_HOME: home,
    TMPDIR: tmp,
  }
}

/** Throws unless every path is inside the temp root. */
function expectInsideRoot(what: string, paths: Readonly<Record<string, string | undefined>>) {
  const outside = Object.entries(paths).filter(([, path]) => !path?.startsWith(`${root}/`))
  if (outside.length > 0)
    throw new Error(`${what} must be inside ${root}, but ${outside.map(([name, path]) => `${name} is ${path}`).join(", ")}`)
}

// The embedded host reads these when it loads, so isolate before the first import, and drop anything a parent
// OpenCode or the user's shell set: no OPENCODE_* settings and no real Tavily key. The host also opens a location at
// the working directory, so work in the temp root too.
for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE") || key.startsWith("TAVILY")) delete process.env[key]
Object.assign(process.env, isolatedEnv(join(root, "home")))
process.chdir(join(root, "home"))

/** The locked @opencode/sdk, or another 2.2.x installed outside the lockfile in HOST_SDK_DIR's node_modules. */
const SDK = process.env.HOST_SDK_DIR
  ? join(realpathSync(process.env.HOST_SDK_DIR), "node_modules", "@opencode", "sdk")
  : fileURLToPath(new URL("../../node_modules/@opencode/sdk", import.meta.url))
/** The embedded host's version: the dev pin, or the release tools/host-tests.mjs installed. */
export const HOST_VERSION = (JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }).version

const offLoopback: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init)
    if (url.origin === "https://mcp.tavily.com" || `${url.origin}${url.pathname}` === "https://api.tavily.com/usage")
      return hostedTavily().then((fake) => {
        const target = new URL(`${url.pathname}${url.search}`, fake.origin)
        return realFetch(input instanceof Request ? new Request(target, input) : target, init)
      })
    offLoopback.push(url.origin)
    return Promise.reject(new Error(`host test blocked a fetch to ${url.origin}`))
  },
  { preconnect: realFetch.preconnect },
) as typeof fetch

/** Runs the npm on PATH with its own home, config and cache in the temp root. */
export async function npm(args: string[], cwd: string) {
  const home = join(root, "npm")
  const run = Bun.spawn(["npm", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // npm's user config and cache are in HOME.
      ...isolatedEnv(home),
      npm_config_globalconfig: join(home, "npmrc"),
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
    },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(`npm ${args.join(" ")} failed (${code}):\n${stderr}`)
  return stdout
}

export interface HostInput {
  /** Plugin options, as a user writes them in opencode.json. */
  readonly options?: PluginOptions
  /** Extra user config: permissions, agents, mcp, websearch. */
  readonly config?: Record<string, unknown>
  /** Extra host environment, such as TAVILY_API_KEY. */
  readonly env?: Readonly<Record<string, string>>
  readonly plugins?: readonly Plugin.Plugin[]
}

export type HostClient = Omit<OpenCodeClient, "plugin"> & { readonly plugin: Pick<OpenCodeClient["plugin"], "list"> }

export interface Host {
  readonly client: HostClient
  readonly location: { readonly directory: string }
  /** A stock host's server log so far. */
  readonly log?: () => string
  close(): Promise<void>
}

/** How long a host may take to load the plugin and settle the tavily server. Generous: CI and containers are slow. */
const READY_MS = 180_000

/**
 * Keeps the built-in local providers from probing their default ports, and turns on schedules, which is how a host test
 * runs Code Mode with nobody present to answer a prompt.
 */
const LOCAL_PROVIDERS_OFF = {
  experimental: { schedules: true },
  providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
}

let hosts = 0

/** A new folder for one host; `work` is its project and working directory, a git worktree of its own. */
function hostFolder(name: string) {
  const base = join(root, `${name}-${++hosts}`)
  const work = join(base, "work")
  mkdirSync(work, { recursive: true })
  const git = spawnSync("git", ["init", "--quiet", work], { encoding: "utf8" })
  if (git.status !== 0) throw new Error(`git init ${work} failed: ${git.stderr || git.error?.message}`)
  return { base, work }
}

/** A loopback port for a managed service, away from OpenCode's default (49374) and from the ports `freePort` gives. */
const servicePort = () => 20_000 + Math.floor(Math.random() * 20_000)

/** The embedded host with the plugin from src and the web search probe. */
export async function startHost(input: HostInput = {}): Promise<Host> {
  const { base, work } = hostFolder("host")
  const env = input.env ?? {}
  Object.assign(process.env, env)
  // OpenCode's global paths come from these, and the embedded host's location from the working directory.
  const sources = ["HOME", "OPENCODE_TEST_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"]
  expectInsideRoot("The embedded host's home, temp folder and working directory", {
    ...Object.fromEntries(sources.map((key) => [key, process.env[key]])),
    tmpdir: tmpdir(),
    cwd: process.cwd(),
  })
  // The dev pin from this checkout, or the release tools/host-tests.mjs installed, which is why the path, not the name.
  const { OpenCode } = (await import(pathToFileURL(join(SDK, "dist", "index.js")).href)) as typeof import("@opencode/sdk")
  const client = await OpenCode.create({
    plugins: [Plugin.define({ id: plugin.id, setup: (ctx) => plugin.setup({ ...ctx, options: input.options ?? {} }) }), probe, ...(input.plugins ?? [])],
    // An embedded host reports "unknown" unless told, and the plugin's host check refuses that.
    app: { version: HOST_VERSION },
    config: { content: JSON.stringify({ ...LOCAL_PROVIDERS_OFF, ...input.config }), directory: join(base, "config"), project: false, claude: false },
    database: { path: join(base, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error" },
  })
  return ready({
    client,
    location: { directory: work },
    async close() {
      await client.close()
      for (const key of Object.keys(env)) delete process.env[key]
      if (offLoopback.length) throw new Error(`the host tried to leave loopback: ${[...new Set(offLoopback)].join(", ")}`)
    },
  })
}

/** The stock releases the plugin is tested on: src/host-version.ts's list, which status and the docs use too. */
export const STOCK_VERSIONS = TESTED_HOSTS

const binaries = new Map<string, Promise<string>>()

/**
 * The stock `opencode` binary of a release: OPENCODE_BIN_2_2_3 and so on when set, or else the release's platform
 * package, installed from npm with scripts off. Its wrapper, @opencode/cli, only links that binary in a script.
 * Memoised per version: hosts start in parallel, and two installs into one folder fail.
 */
function stockBinary(version: string) {
  let binary = binaries.get(version)
  if (!binary) binaries.set(version, (binary = installStock(version)))
  return binary
}

async function installStock(version: string) {
  const given = GIVEN_BINARIES[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (given) return realpathSync(given)
  const project = join(root, `opencode-${version}`)
  const name = `@opencode/cli-${process.platform}-${process.arch}`
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ private: true }))
  await npm(["install", "--ignore-scripts", `${name}@${version}`], project)
  return join(project, "node_modules", name, "bin", "opencode")
}

/**
 * `opencode serve` of a stock release, with the installed package directory `pkg` and `config`, such as agents, in its
 * user config, and `serveEnv` added to the server's environment only, such as TAVILY_API_KEY.
 */
export async function startStock(
  version: string,
  pkg: string,
  serveEnv: Readonly<Record<string, string>> = {},
  config: Readonly<Record<string, unknown>> = {},
): Promise<Host> {
  const binary = await stockBinary(version)
  const { base, work } = hostFolder(`stock-${version}`)
  const home = join(base, "home")
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ ...LOCAL_PROVIDERS_OFF, ...config, plugins: [pkg] }, null, 2))
  writeFileSync(join(home, ".config", "opencode", "service.json"), JSON.stringify({ port: servicePort() }))
  const env = {
    ...isolatedEnv(home),
    PATH: "/usr/bin:/bin",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
  }
  const run = (args: string[]) => spawnSync(binary, args, { cwd: work, env, encoding: "utf8" }).stdout
  const reported = /\d+\.\d+\.\d+\S*/.exec(run(["--version"]))?.[0]
  if (reported !== version) throw new Error(`${binary} reports OpenCode ${reported ?? "with no version"}, not ${version}`)
  // Every path the binary prints; home and tmp must be among them.
  const paths: Record<string, string | undefined> = { home: undefined, tmp: undefined }
  for (const line of run(["debug", "paths"]).split("\n")) {
    const match = /^(\S+)\s+(\S.*)$/.exec(line.trim())
    if (match) paths[match[1]] = match[2]
  }
  expectInsideRoot(`\`opencode debug paths\` of ${version}`, paths)

  const proxy = await refusingProxy()
  const port = await freePort()
  const password = randomBytes(18).toString("base64url")
  const log = createWriteStream(join(base, "serve.log"))
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "warn"], {
    cwd: work,
    env: { ...env, ...serveEnv, OPENCODE_PASSWORD: password, ...proxyEnv(proxy.url) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const client = Client.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  })
  const close = async () => {
    child.kill("SIGTERM")
    await Promise.race([exited, Bun.sleep(10_000).then(() => child.kill("SIGKILL"))])
    await proxy.close()
  }
  try {
    await until(`opencode serve answers on port ${port}`, () => client.server.info().then(() => true, () => false), READY_MS)
  } catch (error) {
    await close()
    throw new Error(`${(error as Error).message}\n${readFileSync(join(base, "serve.log"), "utf8").slice(-2000)}`)
  }
  return ready({ client, location: { directory: work }, log: () => readFileSync(join(base, "serve.log"), "utf8"), close })
}

/** Waits until the plugin is active and the tavily server has settled, and closes the host if it never does. */
async function ready(host: Host): Promise<Host> {
  let seen = "nothing yet"
  try {
    expectInsideRoot("OpenCode's temp folder", { tmp: (await host.client.server.info()).paths.tmp })
    await until(
      "the Tavily plugin and the tavily server are ready",
      async () => {
        const { data: plugins } = await host.client.plugin.list({ location: host.location })
        const state = plugins.find((entry) => entry.id === plugin.id)?.state
        if (state?.status === "failed") throw new Error(`the Tavily plugin failed: ${state.error}`)
        const { data: servers } = await host.client.mcp.list({ location: host.location })
        const tavily = servers.find((server) => server.name === "tavily")
        seen = `plugin ${state?.status ?? "not listed"}, tavily server ${tavily?.status.status ?? "not listed"}`
        return state?.status === "active" && tavily !== undefined && tavily.status.status !== "pending"
      },
      READY_MS,
    )
  } catch (error) {
    await host.close().catch(() => {})
    throw new Error(`${(error as Error).message} (last seen: ${seen})`)
  }
  return host
}

const proxyEnv = (url: string) => ({
  HTTP_PROXY: url,
  HTTPS_PROXY: url,
  http_proxy: url,
  https_proxy: url,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
})

/** A local HTTP proxy that refuses every request and tunnel, so a stock host never reaches the network. */
async function refusingProxy() {
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"))
    socket.on("error", () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const close = () => new Promise<void>((resolve) => (sockets.forEach((socket) => socket.destroy()), server.close(() => resolve())))
  return { url: `http://127.0.0.1:${port}`, close }
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

export async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await Bun.sleep(50)
  }
}
