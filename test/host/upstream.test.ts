// tools/check-upstream.mjs against the recorded catalog on a loopback fake: it reports drift, calls keyless, and
// always exits 0. The live run against Tavily is a maintainer step.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createServer, type AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { NEW_TOOL, RECORDED_TOOLS, type CatalogTool } from "./catalog.js"
import { startFakeTavily, type FakeTavily } from "./fake-tavily.js"

const REPO = fileURLToPath(new URL("../../", import.meta.url))

// Each check spawns Bun, which is slow on a busy machine.
setDefaultTimeout(60_000)

let fake: FakeTavily | undefined
afterEach(() => fake?.close())

async function check(endpoint: string) {
  const run = Bun.spawn([process.execPath, "tools/check-upstream.mjs", endpoint], { cwd: REPO, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  return { stdout, stderr, code }
}

async function against(tools: readonly CatalogTool[]) {
  fake = await startFakeTavily(tools)
  return { fake, ...(await check(fake.url)) }
}

describe("check-upstream", () => {
  test("reports no drift for the recorded catalog, over a keyless session", async () => {
    const { fake, stdout, stderr, code } = await against(RECORDED_TOOLS)
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 })
    expect(stdout).toContain("Server: fake-tavily 0.0.0, 5 tools: tavily_search, tavily_extract, tavily_crawl, tavily_map, tavily_research")
    expect(stdout).toContain("No drift: Tavily lists exactly the 5 tools the plugin knows.")
    expect(fake.requests.map((request) => request.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "DELETE"])
    expect(fake.requests.every((request) => request.accessMode === "keyless" && !request.authorized)).toBe(true)
  })

  test("warns about added and removed tools and still exits 0", async () => {
    const tools = [...RECORDED_TOOLS.filter((tool) => tool.name !== "tavily_map"), NEW_TOOL]
    const { stdout, code } = await against(tools)
    expect(code).toBe(0)
    expect(stdout).toContain("Warning: added upstream: tavily_feedback.")
    expect(stdout).toContain("Warning: removed upstream: tavily_map.")
    expect(stdout).not.toContain("No drift")
  })

  test("warns when the server cannot be reached and still exits 0", async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const { port } = closed.address() as AddressInfo
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const { stdout, code } = await check(`http://127.0.0.1:${port}/mcp/`)
    expect(code).toBe(0)
    expect(stdout).toContain("Warning: could not list Tavily's tools (")
  })
})
