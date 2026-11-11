// R18: what the model reads says what the default does. Every tool is allowed under `access: "all"`, so no text the
// model sees may say a tool asks first, is read-only, needs an option turned on, or is off until it is classified.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { NAMESPACE_DESCRIPTION } from "../../src/tools.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** A claim that is false under the default block: a tool cannot ask, be refused or be off, because every tool allows. */
const STALE: [string, RegExp][] = [
  // Case-sensitive "asks": the imperative "Ask the user before …" is guidance to the model, not a claim about a rule.
  ["says a tool asks first", /\basks (?:the user )?(?:first|before)\b/],
  ["needs an option turned on", /\bneeds? (?:the (?:plugin )?)?option\b/i],
  ["is off until classified", /\b(?:off|asks?) until (?:it is |they are )?classif/i],
  ["says it is read-only now", /\bread-only now\b/i],
  ["is refused while read-only", /\brefused while (?:the plugin is )?read-only\b/i],
  ["says no tool changes anything", /\bno tool (?:here )?changes\b/i],
]

/** A sentence that names a restricting value describes that value, not the default, so it is not a claim about `all`. */
const atAll = (text: string) =>
  text
    .split(/(?<=[.:])\s+/)
    .filter((sentence) => !/["`'](?:ask-changes|read-only)["`']/.test(sentence))
    .join(" ")

describe("the model-facing text at access all", () => {
  const all = {
    "the Code Mode namespace": NAMESPACE_DESCRIPTION,
    "the Jelly summary": (JSON.parse(read("package.json")) as { jelly?: { summary?: string } }).jelly?.summary ?? "",
    ...Object.fromEntries(readdirSync(join(ROOT, "skills")).map((name) => [`skills/${name}/SKILL.md`, read(`skills/${name}/SKILL.md`)] as const)),
  }

  test.each(Object.entries(all))("%s claims nothing the default block contradicts", (_file, text) => {
    for (const [claim, pattern] of STALE) expect({ claim, hit: pattern.exec(atAll(text))?.[0] ?? null }).toEqual({ claim, hit: null })
  })

  test("the namespace says what a call costs, and names no prompt", () => {
    expect(NAMESPACE_DESCRIPTION).toContain("Each call spends Tavily credits")
  })
})
