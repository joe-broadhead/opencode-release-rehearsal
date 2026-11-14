import { Plugin } from "@opencode/plugin"
import { watchConnect } from "./connect.js"
import { checkHost } from "./host-version.js"
import { keyChecker } from "./key-check.js"
import { METHODS, registerToolsRpc } from "./host/tools-rpc.js"
import { readKey, registerServer, SERVER_NAME, watchKey, type ServerState } from "./mcp.js"
import { parseOptions } from "./options.js"
import { registerDefaultRules } from "./permissions.js"
import { Tavily } from "./rpc/index.js"
import { loadSkills, registerSkills } from "./skills.js"
import { registerTools } from "./tools.js"
import { readStatus, registerStatusCommand, unavailable } from "./status.js"
import { selectWebsearchDefault, type WebsearchState } from "./websearch.js"

const warn = (message: string) => console.warn(message)

export default Plugin.define({
  id: "rehearsal.kit",
  async setup(ctx) {
    // Options first: they hold the host check's override. Validation has no side effects.
    const options = parseOptions(ctx.options)
    const host = checkHost(ctx.app.version, options.allowUntestedHost, warn)
    const skills = await loadSkills()
    const server: ServerState = { key: await readKey(ctx.integration, undefined, warn), userServer: false, userServerAtTavily: false }
    const websearch: WebsearchState = { tavilyDefault: false }
    const checkKey = keyChecker()
    // Ask Tavily about the key now, so status has the answer; the check never throws.
    if (server.key) void checkKey(server.key.key)

    await registerServer(ctx.mcp, server, options.executionTimeoutMs)
    await registerDefaultRules(ctx.agent, options.access)
    if (options.websearch) await selectWebsearchDefault(ctx.websearch, websearch)
    await registerSkills(ctx.skill, skills)
    const read = () => readStatus(ctx, { server, websearch, host, checkKey, skills, access: options.access })
    await registerStatusCommand(ctx, read)
    await ctx.rpc.register(Tavily, {
      status: (_input, { error }) =>
        read().catch((cause: unknown) => {
          const { message, nextStep } = unavailable(cause)
          return error("unavailable", message, { nextStep })
        }),
    })

    // The Code Mode namespace line, and Tavily's error objects as errors for the model (shapeResult does it for scripts).
    await registerTools(ctx.tool)
    // Scripts call the five tools with no model, as a session and its agent. A user's own server is used only when it
    // is at Tavily's URL; any other is not the plugin's to vouch for.
    const stopTools = await registerToolsRpc(ctx, {
      methods: METHODS,
      mcp: { server: SERVER_NAME, managed: () => !server.userServer || server.userServerAtTavily },
    })

    const controller = new AbortController()
    void watchKey(ctx, server, controller.signal, warn)
    void watchConnect(ctx, server, checkKey, controller.signal)
    return async () => {
      controller.abort()
      await stopTools()
    }
  },
})
