import { Rpc } from "@opencode/plugin/rpc"
import type { Access } from "../options.js"

/** The shared status states (S13) Tavily reports, in machine form; the status rows use STATE_LABELS. */
const STATES = ["connected", "sign_in_required", "connecting", "failed", "disabled", "not_configured"] as const
const AUTH_SOURCES = ["oauth", "key_connected", "key_env", "user_server", "none"] as const
const KEY_CHECKS = ["accepted", "rejected", "unchecked"] as const

export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/** The plugin's read-only status. It never carries a key or token. */
export interface Status {
  /** The plugin's version. */
  readonly version: string
  /** The tavily server's state. */
  readonly state: (typeof STATES)[number]
  /** What the default rules allow: `all`, `ask-changes` or `read-only`. */
  readonly access: Access
  readonly auth: (typeof AUTH_SOURCES)[number]
  /** The credential's label, never a secret. */
  readonly account?: string
  /**
   * With an API key: whether Tavily accepts it. `unchecked` when Tavily's API could not be reached. The MCP server
   * connects with any key, so only this tells a wrong key apart.
   */
  readonly keyCheck?: (typeof KEY_CHECKS)[number]
  /** The `tavily` server's tools that OpenCode lists; unknown ones are not among the five known reads and follow the access. */
  readonly tools: { readonly visible: number; readonly unknown: number; readonly unknownNames: readonly string[] }
  /** This plugin selected Tavily as the web search default. A `websearch` choice in opencode.json still wins. */
  readonly websearchDefault: boolean
  /** OpenCode's version (null when it reports none), the supported range, and whether it is a tested release. */
  readonly host: { readonly version: string | null; readonly range: string; readonly tested: boolean }
  /**
   * Agents that miss the plugin's default rules and would run new Tavily tools without asking; empty when none.
   * OpenCode creates agents defined only in user config after plugins run, so those agents never receive the rules.
   */
  readonly unguardedAgents: readonly string[]
  /** The default rules to paste into each unguarded agent's own permissions; present with `unguardedAgents`. */
  readonly permissionsBlock?: readonly PermissionRule[]
  /** The plugin's skills that OpenCode loads from another file with the same id, and that file; absent when none. */
  readonly shadowedSkills?: readonly { readonly id: string; readonly path: string }[]
  /** The one next step; `Nothing to do.` when everything is ready. */
  readonly nextStep: string
}

export const STATE_LABELS: Record<Status["state"], string> = {
  connected: "connected",
  connecting: "connecting",
  sign_in_required: "sign-in required",
  failed: "failed",
  disabled: "disabled",
  not_configured: "not configured",
}

/** What the access value does here, one sentence each: every known tool only reads from the web. */
export function accessText(status: Status) {
  switch (status.access) {
    case "all":
      return "every tool runs without asking: the five reads and any tool Tavily adds later. "
        + 'Set the access option to "ask-changes" or "read-only" to restrict a tool Tavily adds later.'
    case "read-only":
      return "the five reads run without asking, and any tool Tavily adds later is denied. "
        + "All five only read from the web, so no value changes what they do."
    case "ask-changes":
      return "the five reads run without asking; any tool Tavily adds later asks first. "
        + "All five only read from the web, so no value changes what they do."
  }
}

const AUTH_LABELS: Record<Status["auth"], string> = {
  oauth: "OAuth (/connect → Tavily account)",
  key_connected: "API key (/connect → Tavily)",
  key_env: "API key from TAVILY_API_KEY",
  user_server: "your own tavily server in opencode.json",
  none: "none",
}

const KEY_CHECK_TEXT: Record<NonNullable<Status["keyCheck"]>, string> = {
  accepted: "accepted by Tavily",
  rejected: "rejected by Tavily",
  unchecked: "not checked: Tavily's API could not be reached",
}

export const authText = (status: Status) =>
  status.keyCheck === undefined ? AUTH_LABELS[status.auth] : `${AUTH_LABELS[status.auth]}, ${KEY_CHECK_TEXT[status.keyCheck]}`

/**
 * The TUI runs in the user's terminal; the plugin runs in OpenCode's server, usually the background service, which
 * has its own environment. A TAVILY_API_KEY exported only in the terminal never reaches the plugin. Shown only when
 * the terminal has the variable and the server uses no key.
 */
export function terminalKeyText(status: Status, terminalHasKey: boolean) {
  if (!terminalHasKey || (status.auth !== "oauth" && status.auth !== "none")) return undefined
  return "TAVILY_API_KEY is set in this terminal, but OpenCode's server does not see it, so Tavily uses OAuth. Run /connect and choose Tavily to connect the key."
}

export function toolsText(status: Status) {
  const { tools } = status
  if (tools.visible === 0) return "none listed yet"
  const posture = status.access === "all" ? "new tools run too" : status.access === "read-only" ? "new tools are denied" : "they ask first"
  const unknown = tools.unknown === 0 ? "" : `, ${tools.unknown} unknown (${posture}): ${tools.unknownNames.join(", ")}`
  return `${tools.visible} available${unknown}`
}

export const websearchText = (status: Status) =>
  status.websearchDefault ? `Tavily, unless opencode.json sets "websearch"` : "not set by this plugin"

export const accountText = (status: Status) => status.account ?? "none"

/** The agents row: names only; the block to paste follows it. */
export const agentsText = (status: Status) => (status.unguardedAgents.length === 0 ? "none" : status.unguardedAgents.join(", "))

export const skillsText = (status: Status) =>
  status.shadowedSkills === undefined
    ? "the plugin's own"
    : status.shadowedSkills.map((skill) => `${skill.id} replaced by ${skill.path}`).join("; ")

export const hostText = ({ host }: Status) =>
  `${host.version ?? "unknown version"} (${host.tested ? "tested" : `untested; supported range ${host.range}`})`

/** The permission block as lines to paste: one rule per line, comma-separated. */
export const blockLines = (block: readonly PermissionRule[]) =>
  block.map((rule, index) => `${JSON.stringify(rule)}${index < block.length - 1 ? "," : ""}`)

const strings = { type: "array", items: { type: "string" } } as const

const rule = {
  type: "object",
  properties: {
    action: { type: "string" },
    resource: { type: "string" },
    effect: { type: "string", enum: ["allow", "deny", "ask"] },
  },
  required: ["action", "resource", "effect"],
  additionalProperties: false,
} as const

const status = {
  type: "object",
  properties: {
    version: { type: "string" },
    state: { type: "string", enum: [...STATES] },
    access: { type: "string", enum: ["all", "ask-changes", "read-only"] },
    auth: { type: "string", enum: [...AUTH_SOURCES] },
    account: { type: "string" },
    keyCheck: { type: "string", enum: [...KEY_CHECKS] },
    tools: {
      type: "object",
      properties: { visible: { type: "integer" }, unknown: { type: "integer" }, unknownNames: strings },
      required: ["visible", "unknown", "unknownNames"],
      additionalProperties: false,
    },
    websearchDefault: { type: "boolean" },
    host: {
      type: "object",
      properties: { version: { type: ["string", "null"] }, range: { type: "string" }, tested: { type: "boolean" } },
      required: ["version", "range", "tested"],
      additionalProperties: false,
    },
    unguardedAgents: strings,
    permissionsBlock: { type: "array", items: rule },
    shadowedSkills: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, path: { type: "string" } },
        required: ["id", "path"],
        additionalProperties: false,
      },
    },
    nextStep: { type: "string" },
  },
  required: ["version", "state", "access", "auth", "tools", "websearchDefault", "host", "unguardedAgents", "nextStep"],
  additionalProperties: false,
} as const

/** Call `status` with `{}` as the input. */
export const Tavily = Rpc.define({
  id: "tavily.web",
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: status,
      errors: {
        unavailable: {
          type: "object",
          properties: { nextStep: { type: "string" } },
          required: ["nextStep"],
          additionalProperties: false,
        },
      },
    },
  },
  events: {},
})
