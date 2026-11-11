/**
 * Every code this plugin raises, in one typed table: its own status and log codes, and the ones the tools RPC adds. A
 * test fails when a code appears in `src` and in neither table, and when the README's Troubleshooting table or
 * `docs/scripting.md`'s refusal table drifts from them in either direction.
 */

/** The codes the plugin's own code raises, as `CODE: What happened. Next step: What to do.` */
export type PluginCode =
  | "HOST_UNTESTED"
  | "KEY_UNAVAILABLE"
  | "KEY_WATCH_STOPPED"
  | "OPTIONS_INVALID"
  | "SKILLS_INVALID"
  | "STATUS_UNAVAILABLE"
  | "UPSTREAM_ERROR"

export const PLUGIN_CODES: readonly PluginCode[] = [
  "HOST_UNTESTED",
  "KEY_UNAVAILABLE",
  "KEY_WATCH_STOPPED",
  "OPTIONS_INVALID",
  "SKILLS_INVALID",
  "STATUS_UNAVAILABLE",
  "UPSTREAM_ERROR",
]

/**
 * The codes the tools RPC shares with every plugin of this family, from the shared module and from OpenCode rather than
 * from this plugin's own code. `UPSTREAM_ERROR` is in both: Tavily's own error objects carry it too.
 */
export type RpcCode =
  | "AUTH_REQUIRED"
  | "CANCELLED"
  | "CONNECTING"
  | "CONNECTION_FAILED"
  | "DISABLED"
  | "NOT_REGISTERED"
  | "PERMISSION_DENIED"
  | "SERVER_CONFLICT"
  | "SESSION_AGENT_REQUIRED"
  | "SESSION_UNKNOWN"
  | "TOOL_UNAVAILABLE"
  | "UPSTREAM_ERROR"

export const RPC_CODES: readonly RpcCode[] = [
  "AUTH_REQUIRED",
  "CANCELLED",
  "CONNECTING",
  "CONNECTION_FAILED",
  "DISABLED",
  "NOT_REGISTERED",
  "PERMISSION_DENIED",
  "SERVER_CONFLICT",
  "SESSION_AGENT_REQUIRED",
  "SESSION_UNKNOWN",
  "TOOL_UNAVAILABLE",
  "UPSTREAM_ERROR",
]
