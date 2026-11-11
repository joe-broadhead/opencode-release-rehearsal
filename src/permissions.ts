import type { Plugin } from "@opencode/plugin"
import type { Access } from "./options.js"
import type { PermissionRule as Rule } from "./rpc/index.js"

export type { Rule }

/** The permission actions of Tavily's documented tools. Hosted discovery marks all five read-only. */
export const KNOWN_ACTIONS = ["search", "extract", "map", "crawl", "research"].map((tool) => `tavily_tavily_${tool}`)

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

/**
 * The block the plugin inserts. Broad first, narrow last, because the last matching rule wins.
 *
 * At the default `access: "all"` every Tavily tool is allowed, and so is one Tavily adds later, through the `tavily_*`
 * namespace. All five known tools only read, so `"ask-changes"` and `"read-only"` change only what a tool Tavily adds
 * later does: it asks, or it is denied. The known reads are allowed at every value.
 */
export function defaultRules(access: Access = "all"): Rule[] {
  const other: Rule["effect"] = access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"
  return [rule("tavily_*", other), ...KNOWN_ACTIONS.map((action) => rule(action, "allow"))]
}

const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }

const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect

/**
 * True when the default rules appear as one contiguous block anywhere after the agent's first base allow. Other
 * plugins insert their blocks at the same place, so the block need not come first.
 */
export function hasDefaultRules(rules: readonly Rule[], access: Access = "all") {
  const base = rules.findIndex((rule) => same(rule, BASE_ALLOW))
  if (base === -1) return false
  const block = defaultRules(access)
  return rules.some(
    (_, start) =>
      start > base &&
      block.every((rule, offset) => {
        const candidate = rules[start + offset]
        return candidate !== undefined && same(candidate, rule)
      }),
  )
}

/**
 * Inserts the default rules right after the agent's first base allow. Every later rule (agent-specific denies, the
 * user's `permissions`, saved approvals) still wins, because the last match wins. An agent without a base allow gets
 * nothing: there, unlisted tools are not allowed anyway.
 */
export function insertDefaultRules(rules: Rule[], access: Access = "all") {
  const base = rules.findIndex((rule) => same(rule, BASE_ALLOW))
  if (base === -1 || hasDefaultRules(rules, access)) return
  rules.splice(base + 1, 0, ...defaultRules(access).map((rule) => ({ ...rule })))
}

/** A tool Tavily might add later: no rule names it, so the block's `tavily_*` rule decides it. */
const UNKNOWN_TOOL = `tavily_unknown`

/**
 * An agent is unguarded when it has a base allow, lacks the block, and its own rules would let a new Tavily tool run
 * without asking. An agent whose rules already ask or deny for every Tavily tool needs no fix.
 */
export function isUnguarded(rules: readonly Rule[], access: Access = "all") {
  return rules.some((rule) => same(rule, BASE_ALLOW)) && !hasDefaultRules(rules, access) && evaluate(rules, UNKNOWN_TOOL) === "allow"
}

/** Host wildcards: `*` matches any run of characters and `?` one character, over the whole string. */
const matches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)

/** The effect of `rules` for an MCP-style call (resource `*`): the last matching rule wins, and no match asks. */
export function evaluate(rules: readonly Rule[], action: string): Rule["effect"] {
  return rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, "*"))?.effect ?? "ask"
}

export function registerDefaultRules(agent: Pick<Plugin.Context["agent"], "transform">, access: Access = "all") {
  return agent.transform((editor) => {
    for (const { id } of editor.list()) editor.update(id, (info) => insertDefaultRules(info.permissions, access))
  })
}
