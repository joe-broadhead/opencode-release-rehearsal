import type { Plugin } from "@opencode/plugin"
import type { TavilyKey } from "./credential.js"
import { HOST_RANGE, TESTED_TEXT, type HostCheck } from "./host-version.js"
import type { KeyCheck, KeyChecker } from "./key-check.js"
import { SERVER_NAME, SERVER_URL, type ServerState } from "./mcp.js"
import { defaultRules, isUnguarded, KNOWN_ACTIONS, type Rule } from "./permissions.js"
import type { Access } from "./options.js"
import {
  accessText,
  accountText,
  agentsText,
  authText,
  blockLines,
  hostText,
  skillsText,
  STATE_LABELS,
  toolsText,
  websearchText,
  type Status,
} from "./rpc/index.js"
import { PLUGIN_VERSION } from "./version.js"
import type { WebsearchState } from "./websearch.js"

/**
 * The fix for agents that miss the inserted rules, in the wording all the plugins share: the block first in each
 * agent's own `permissions`, then the user's top-level Tavily rules again, because an agent's own rules come after
 * the top-level ones. The top-level `permissions` are no fix: they come after Explore's `* * deny` too, so they would
 * loosen Explore.
 */
const AGENT_FIX =
  "Put the default rules shown by /tavily-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for Tavily tools."

/**
 * The tools RPC calls only a server the plugin can vouch for: its own, or the user's own at Tavily's URL. Any other
 * server named `tavily` may be anything, so scripts get SERVER_CONFLICT.
 */
const USER_SERVER_SCRIPTS = `Scripts can't use your own tavily server, because its URL is not Tavily's (${SERVER_URL}); point it at that URL, or remove it from opencode.json, to use the tools RPC.`

/** OpenCode's state of an MCP server. */
type ServerStatus = "connected" | "pending" | "needs_auth" | "failed" | "disabled"

const STATE_OF: Record<ServerStatus, Status["state"]> = {
  connected: "connected",
  pending: "connecting",
  needs_auth: "sign_in_required",
  failed: "failed",
  disabled: "disabled",
}

/** Everything status depends on, gathered from public host APIs and the plugin's own state. */
interface StatusFacts {
  readonly server?: { readonly status: ServerStatus }
  readonly userServer: boolean
  /** The user's own server is at Tavily's URL, so scripts can use it. */
  readonly userServerAtTavily: boolean
  readonly key?: TavilyKey
  /** Tavily's answer for `key`. */
  readonly keyCheck?: KeyCheck
  /** The OAuth credential label of the server's integration. */
  readonly oauthAccount?: string
  /** What the default rules allow: the `access` option; `all` when not given. */
  readonly access?: Access
  /** Every tool OpenCode lists; status counts the `tavily` server's. */
  readonly tools: readonly { readonly id: string }[]
  readonly websearchDefault: boolean
  readonly host: HostCheck
  readonly agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]
  /** The plugin's own skills, and the skills OpenCode lists; the listed one wins when both have an id. */
  readonly skills?: { readonly own: readonly SkillPath[]; readonly listed: readonly SkillPath[] }
}

interface SkillPath {
  readonly id: string
  readonly path: string
}

/** The plugin's skills that OpenCode lists from another file: a skill with the same id, such as a user's, replaced it. */
function shadowedOf(facts: StatusFacts): SkillPath[] {
  return (facts.skills?.own ?? []).flatMap((own) => {
    const listed = facts.skills?.listed.find((skill) => skill.id === own.id)
    return listed && listed.path !== own.path ? [{ id: own.id, path: listed.path }] : []
  })
}

const TOOL_PREFIX = `${SERVER_NAME}_`
const LISTED_UNKNOWN = 20
// A tool name comes from the server; list only plain names.
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/

function toolsOf(facts: StatusFacts): Status["tools"] {
  const ids = facts.tools.map((tool) => tool.id).filter((id) => id.startsWith(TOOL_PREFIX))
  const unknown = ids.filter((id) => !KNOWN_ACTIONS.includes(id)).map((id) => id.slice(TOOL_PREFIX.length))
  const unknownNames = unknown.filter((name) => SAFE_NAME.test(name)).slice(0, LISTED_UNKNOWN)
  return { visible: ids.length, unknown: unknown.length, unknownNames }
}

function authOf(facts: StatusFacts): Status["auth"] {
  if (!facts.server) return "none"
  if (facts.userServer) return "user_server"
  if (!facts.key) return "oauth"
  return facts.key.source === "env" ? "key_env" : "key_connected"
}

function nextStepOf(state: Status["state"], auth: Status["auth"], facts: StatusFacts, unguarded: string[], shadowed: SkillPath[]) {
  const replaceKey =
    auth === "key_env"
      ? `run /connect, choose Tavily and connect a working key (it wins over TAVILY_API_KEY), or replace TAVILY_API_KEY with "opencode service set env TAVILY_API_KEY <key>"`
      : "run /connect, choose Tavily and replace the key"
  switch (state) {
    case "not_configured":
      return `Check that no other plugin or policy removes the "tavily" MCP server, then run "opencode reload".`
    case "disabled":
      return `Enable the tavily server in /mcps, or remove "disabled": true from mcp.servers.tavily in opencode.json.`
    case "connecting":
      return `Wait a few seconds, then run /tavily-status again.`
    case "sign_in_required":
      if (auth === "oauth") return `Run /connect and choose Tavily account to sign in, or choose Tavily to use an API key.`
      if (auth === "user_server") return `Run /connect and choose tavily to sign in to your own server.`
      return `Tavily did not accept the API key: ${replaceKey}.`
    case "failed":
      if (auth === "key_env" || auth === "key_connected") return `Check your network. If it works, ${replaceKey}.`
      return `Run "opencode mcp list" to see the error, and check your network.`
  }
  if (facts.keyCheck === "rejected" && (auth === "key_env" || auth === "key_connected"))
    return `Tavily did not accept the API key: ${replaceKey}.`
  if (unguarded.length > 0) return AGENT_FIX
  if (auth === "user_server" && !facts.userServerAtTavily) return USER_SERVER_SCRIPTS
  if (shadowed.length > 0)
    return `Rename or move ${shadowed.map((skill) => `the "${skill.id}" skill at ${skill.path}`).join(" and ")}, which OpenCode loads instead of the plugin's skill of the same name.`
  // An untested release inside the range changes nothing; outside it, the plugin runs only with allowUntestedHost.
  if (!facts.host.inRange) return `If Tavily misbehaves, use OpenCode ${TESTED_TEXT}.`
  return "Nothing to do."
}

export function buildStatus(facts: StatusFacts): Status {
  const state = facts.server ? STATE_OF[facts.server.status] : "not_configured"
  const auth = authOf(facts)
  const account = auth === "key_connected" ? facts.key?.label : auth === "key_env" ? undefined : facts.oauthAccount
  const access = facts.access ?? "all"
  const unguarded = facts.agents.filter((agent) => isUnguarded(agent.permissions, access)).map((agent) => agent.id)
  const shadowed = shadowedOf(facts)
  const nextStep = nextStepOf(state, auth, facts, unguarded, shadowed)
  const keyCheck = auth === "key_env" || auth === "key_connected" ? facts.keyCheck : undefined
  return {
    version: PLUGIN_VERSION,
    state,
    access,
    auth,
    ...(account === undefined ? {} : { account }),
    ...(keyCheck === undefined ? {} : { keyCheck }),
    tools: toolsOf(facts),
    websearchDefault: facts.websearchDefault,
    host: { version: facts.host.version, range: HOST_RANGE, tested: facts.host.tested },
    unguardedAgents: unguarded,
    ...(unguarded.length === 0 ? {} : { permissionsBlock: defaultRules(facts.access).map((rule) => ({ ...rule })) }),
    ...(shadowed.length === 0 ? {} : { shadowedSkills: shadowed }),
    nextStep,
  }
}

interface StatusState {
  readonly access: Access
  readonly server: ServerState
  readonly websearch: WebsearchState
  readonly host: HostCheck
  readonly checkKey: KeyChecker
  /** The skills the plugin registers, with their paths. */
  readonly skills: readonly SkillPath[]
}

export async function readStatus(
  ctx: {
    readonly mcp: Pick<Plugin.Context["mcp"], "list">
    readonly integration: Pick<Plugin.Context["integration"], "connection">
    readonly agent: Pick<Plugin.Context["agent"], "list">
    readonly tool: Pick<Plugin.Context["tool"], "list">
    readonly skill: Pick<Plugin.Context["skill"], "list">
  },
  state: StatusState,
) {
  // One key for the whole read: the watcher can switch it while the reads below are in flight.
  const key = state.server.key
  const [servers, agents, tools, keyCheck, listed] = await Promise.all([
    ctx.mcp.list(),
    ctx.agent.list(),
    ctx.tool.list(),
    key && !state.server.userServer && state.checkKey(key.key),
    // The skill check is advice; a failed list must not hide the rest of the status.
    ctx.skill.list().then(
      (result) => result.data,
      () => undefined,
    ),
  ])
  const server = servers.data.find((entry) => entry.name === SERVER_NAME)
  // The account label is optional; a failed lookup must not hide the rest of the status.
  const connection = server?.integrationID
    ? await ctx.integration.connection.active(server.integrationID).catch(() => undefined)
    : undefined
  return buildStatus({
    access: state.access,
    server: server && { status: server.status.status },
    userServer: state.server.userServer,
    userServerAtTavily: state.server.userServerAtTavily,
    key,
    keyCheck: keyCheck || undefined,
    oauthAccount: connection?.type === "credential" ? connection.label : undefined,
    tools,
    websearchDefault: state.websearch.tavilyDefault,
    host: state.host,
    agents: agents.data,
    ...(listed ? { skills: { own: state.skills, listed } } : {}),
  })
}

/** The status as text, in the dialog's order; Sign-in and Web search are Tavily's own rows. */
export function formatStatus(status: Status) {
  return [
    "Tavily status",
    `- Connection: ${STATE_LABELS[status.state]}`,
    `- Account: ${accountText(status)}`,
    `- Access: ${accessText(status)}`,
    `- Sign-in: ${authText(status)}`,
    `- Web search: ${websearchText(status)}`,
    `- Skills: ${skillsText(status)}`,
    `- Tools: ${toolsText(status)}`,
    `- Agents without default rules: ${agentsText(status)}`,
    ...blockLines(status.permissionsBlock ?? []).map((line) => `  ${line}`),
    `- OpenCode: ${hostText(status)}`,
    `- Next step: ${status.nextStep}`,
  ].join("\n")
}

export function unavailable(error: unknown) {
  const reason = error instanceof Error ? error.message : String(error)
  return {
    message: `STATUS_UNAVAILABLE: Could not read Tavily's status (${reason}).`,
    nextStep: "Run /tavily-status again, and restart OpenCode if it keeps failing.",
  }
}

export function registerStatusCommand(
  ctx: { readonly command: Pick<Plugin.Context["command"], "transform">; readonly session: Pick<Plugin.Context["session"], "synthetic"> },
  read: () => Promise<Status>,
) {
  return ctx.command.transform((editor) =>
    editor.add({
      name: "tavily-status",
      description: "Show Tavily's connection, sign-in, tools, web search default and next step",
      execute: async ({ sessionID }) => {
        const text = await read().then(formatStatus, (error: unknown) => {
          const { message, nextStep } = unavailable(error)
          return `${message} Next step: ${nextStep}`
        })
        await ctx.session.synthetic({ sessionID, text, description: "Tavily status", resume: false })
      },
    }),
  )
}
