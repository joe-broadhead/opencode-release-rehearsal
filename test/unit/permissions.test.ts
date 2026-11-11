import { describe, expect, test } from "bun:test"
import {
  defaultRules,
  evaluate,
  hasDefaultRules,
  insertDefaultRules,
  KNOWN_ACTIONS,
  registerDefaultRules,
  type Rule,
} from "../../src/permissions.js"
import { agent, agentEditor, transforms, type EditorOf } from "./fake.js"
import type { Plugin } from "@opencode/plugin"

const allow = (action: string): Rule => ({ action, resource: "*", effect: "allow" })
const deny = (action: string): Rule => ({ action, resource: "*", effect: "deny" })
const ask = (action: string): Rule => ({ action, resource: "*", effect: "ask" })
const BASE = allow("*")

describe("default rules", () => {
  test("at the default access every tavily tool is allowed, the five documented ones and any later one", () => {
    expect(defaultRules()[0]).toEqual(allow("tavily_*"))
    expect(KNOWN_ACTIONS).toEqual([
      "tavily_tavily_search",
      "tavily_tavily_extract",
      "tavily_tavily_map",
      "tavily_tavily_crawl",
      "tavily_tavily_research",
    ])
    expect(defaultRules().slice(1)).toEqual(KNOWN_ACTIONS.map(allow))
  })
})

describe("insertDefaultRules", () => {
  test("inserts right after the first base allow", () => {
    const rules = [BASE, ask("read"), BASE, deny("edit")]
    insertDefaultRules(rules)
    expect(rules).toEqual([BASE, ...defaultRules(), ask("read"), BASE, deny("edit")])
  })

  test("leaves an agent without a base allow unchanged, so its default deny stays a deny", () => {
    const rules = [deny("*"), ask("read")]
    insertDefaultRules(rules)
    expect(rules).toEqual([deny("*"), ask("read")])
    expect(evaluate(rules, "tavily_tavily_search")).toBe("deny")
    expect(rules.length).toBe(2)
  })

  test("is idempotent", () => {
    const rules = [BASE, ask("read")]
    insertDefaultRules(rules)
    insertDefaultRules(rules)
    expect(rules.filter((rule) => rule.action === "tavily_*")).toHaveLength(1)
    expect(hasDefaultRules(rules)).toBe(true)
  })

  test("known reads are allowed, unknown tools ask", () => {
    const rules = [BASE]
    insertDefaultRules(rules)
    for (const action of KNOWN_ACTIONS) expect(evaluate(rules, action)).toBe("allow")
    expect(evaluate(rules, "tavily_feedback")).toBe("allow")
    expect(evaluate(rules, "tavily_unknown")).toBe("allow")
    expect(evaluate(rules, "read")).toBe("allow")
  })

  test("an agent with a later `* * deny` still denies every tavily tool", () => {
    const rules = [BASE, ask("read"), deny("*"), allow("grep")]
    insertDefaultRules(rules)
    expect(evaluate(rules, "tavily_tavily_search")).toBe("deny")
    expect(evaluate(rules, "tavily_unknown")).toBe("deny")
  })

  test("a user rule appended later wins", () => {
    const rules = [BASE]
    insertDefaultRules(rules)
    rules.push(allow("tavily_unknown"), ask("tavily_tavily_research"), deny("tavily_tavily_crawl"))
    expect(evaluate(rules, "tavily_unknown")).toBe("allow")
    expect(evaluate(rules, "tavily_tavily_research")).toBe("ask")
    expect(evaluate(rules, "tavily_tavily_crawl")).toBe("deny")
    expect(evaluate(rules, "tavily_tavily_search")).toBe("allow")
  })
})

describe("the access values", () => {
  test("ask-changes keeps the five reads and asks for a tool Tavily adds later", () => {
    const rules = defaultRules("ask-changes")
    expect(rules[0]).toEqual(ask("tavily_*"))
    expect(rules.slice(1)).toEqual(KNOWN_ACTIONS.map(allow))
  })

  test("read-only keeps the five reads and denies a tool Tavily adds later", () => {
    const rules = defaultRules("read-only")
    expect(rules[0]).toEqual(deny("tavily_*"))
    expect(rules.slice(1)).toEqual(KNOWN_ACTIONS.map(allow))
  })

  test("the block for each value is inserted, and a later rule still wins", () => {
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      const rules = [BASE]
      insertDefaultRules(rules, access)
      expect({ access, block: rules.slice(1) }).toEqual({ access, block: defaultRules(access) })
      expect(hasDefaultRules(rules, access)).toBe(true)
      rules.push(deny("tavily_tavily_search"))
      expect({ access, effect: evaluate(rules, "tavily_tavily_search") }).toEqual({ access, effect: "deny" })
    }
  })
})

describe("evaluate", () => {
  test("follows the host's wildcards and treats no match as ask", () => {
    expect(evaluate([allow("tavily_?avily_map")], "tavily_tavily_map")).toBe("allow")
    expect(evaluate([allow("tavily.*")], "tavily_x")).toBe("ask")
    expect(evaluate([], "tavily_x")).toBe("ask")
    expect(evaluate([{ action: "*", resource: "secret", effect: "deny" }], "tavily_x")).toBe("ask")
  })
})

describe("registerDefaultRules", () => {
  test("adds the rules to every agent, once per rebuild", async () => {
    const agentDomain = transforms<EditorOf<Plugin.Context["agent"]>>()
    await registerDefaultRules(agentDomain)
    const agents = [agent("build"), agent("explore", [BASE, deny("*"), allow("read")]), agent("plan")]
    agentDomain.run(agentEditor(agents))
    agentDomain.run(agentEditor(agents))
    for (const entry of agents) {
      expect(entry.permissions[0]).toEqual(BASE)
      expect(entry.permissions.slice(1, 1 + defaultRules().length)).toEqual([...defaultRules()])
      expect(entry.permissions.filter((rule) => rule.action === "tavily_*")).toHaveLength(1)
    }
    expect(evaluate(agents[1].permissions, "tavily_tavily_search")).toBe("deny")
  })
})
