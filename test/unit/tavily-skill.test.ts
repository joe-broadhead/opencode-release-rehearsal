// The tavily skill decides whether a web question becomes a search. Rule 2 must send a fact to a page the model knows
// exists, and otherwise to a search, so a guessed URL is never fetched in place of a search.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const skill = readFileSync(fileURLToPath(new URL("../../skills/tavily/SKILL.md", import.meta.url)), "utf8").replace(/\r\n/g, "\n")
const rule2 = skill.split("\n").find((line) => line.includes("**A fact:**")) ?? ""

describe("the tavily skill, rule 2 for a fact", () => {
  test("fetches a page only when it is known to exist, and never a guessed URL", () => {
    expect(rule2).toContain("if you know an official page exists")
    expect(rule2).toContain("do not guess a URL")
    expect(rule2).not.toContain("obvious official page")
  })

  test("otherwise sends the question to one tavily_search", () => {
    expect(rule2).toContain("Otherwise one `tavily_search`")
  })
})
