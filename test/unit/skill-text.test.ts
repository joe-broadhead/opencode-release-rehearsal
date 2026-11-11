import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { KNOWN_ACTIONS } from "../../src/permissions.js"

/**
 * The skills name only Tavily's known tools and their real parameters. `npm run check:upstream` compares only tool
 * names, so this catches a skill that drifts from the schemas. The parameters are Tavily's hosted schemas as Code
 * Mode listed them on 2026-11-05; update them when a re-check shows drift.
 */
const PARAMETERS: Record<string, readonly string[]> = {
  tavily_search: [
    "query", "max_results", "search_depth", "topic", "time_range", "include_images", "include_image_descriptions",
    "include_raw_content", "include_domains", "exclude_domains", "country", "include_favicon", "start_date", "end_date",
    "exact_match", "include_published_date", "filter_by_published_date",
  ],
  tavily_extract: ["urls", "extract_depth", "include_images", "format", "include_favicon", "query", "include_usage"],
  tavily_map: ["url", "max_depth", "max_breadth", "limit", "instructions", "select_paths", "select_domains", "allow_external", "include_usage"],
  tavily_crawl: [
    "url", "max_depth", "max_breadth", "limit", "instructions", "select_paths", "select_domains", "allow_external",
    "extract_depth", "format", "include_favicon", "include_usage", "chunks_per_source",
  ],
  tavily_research: ["input", "model", "files"],
}
/** Result fields the skills name. */
const RESULT_FIELDS = ["failed_results"]

const tools = KNOWN_ACTIONS.map((action) => action.replace(/^tavily_/, ""))
const known = new Set([...tools, ...KNOWN_ACTIONS, ...Object.values(PARAMETERS).flat(), ...RESULT_FIELDS])

/** The leading snake_case name of each inline code span, such as `search_depth` in `search_depth: "basic"`. */
function names(text: string) {
  const prose = text.replace(/```[\s\S]*?```/g, "")
  return [...prose.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)/g)].map((match) => match[1])
}

describe("the skills' tool and parameter names", () => {
  test("the recorded tools are exactly the known reads", () => {
    expect(Object.keys(PARAMETERS).sort()).toEqual([...tools].sort())
  })

  for (const id of ["tavily", "tavily-research"])
    test(`skills/${id} names only known tools and live parameters`, () => {
      const found = names(readFileSync(new URL(`../../skills/${id}/SKILL.md`, import.meta.url), "utf8"))
      expect(found.length).toBeGreaterThan(0)
      expect(found.filter((name) => !known.has(name))).toEqual([])
    })
})

describe("the skills' links", () => {
  // An agent reads a link with webfetch: the plain file, not GitHub's HTML page around it.
  for (const id of ["tavily", "tavily-research"])
    test(`skills/${id} links to this repository's files only as raw files`, () => {
      const text = readFileSync(new URL(`../../skills/${id}/SKILL.md`, import.meta.url), "utf8")
      const links = [...text.matchAll(/https:\/\/[^\s)`>]+/g)].map((match) => match[0])
      expect(links.filter((link) => /^https:\/\/github\.com\/joe-broadhead\//.test(link))).toEqual([])
      for (const link of links.filter((link) => link.includes("joe-broadhead/opencode-tavily")))
        expect(link).toMatch(/^https:\/\/raw\.githubusercontent\.com\/joe-broadhead\/opencode-tavily\/HEAD\/[\w./-]+$/)
    })
})
