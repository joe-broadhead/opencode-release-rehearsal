import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/options.js"

const NEXT_STEP = "Next step: Fix the plugin's options in opencode.json."

describe("parseOptions", () => {
  test("applies the defaults to an empty entry", () => {
    expect(parseOptions({})).toEqual({ websearch: true, executionTimeoutMs: 900_000, allowUntestedHost: false, access: "all" })
  })

  test("accepts every option", () => {
    expect(parseOptions({ websearch: false, executionTimeoutMs: 60_000, allowUntestedHost: true, access: "read-only" })).toEqual({
      websearch: false,
      executionTimeoutMs: 60_000,
      allowUntestedHost: true,
      access: "read-only",
    })
    expect(parseOptions({ executionTimeoutMs: 3_600_000 }).executionTimeoutMs).toBe(3_600_000)
  })

  test("refuses an unknown key and names it", () => {
    expect(() => parseOptions({ foo: 1 })).toThrow(`OPTIONS_INVALID: Unknown option "foo"; the options are websearch, executionTimeoutMs, allowUntestedHost, access. ${NEXT_STEP}`)
    expect(() => parseOptions({ allowTools: ["tavily_x"] })).toThrow(`Unknown option "allowTools"`)
  })

  test.each([59_999, 3_600_001, 1.5, "900000", null])("refuses executionTimeoutMs %p", (value) => {
    expect(() => parseOptions({ executionTimeoutMs: value })).toThrow(
      `OPTIONS_INVALID: "executionTimeoutMs" must be an integer from 60000 to 3600000. ${NEXT_STEP}`,
    )
  })

  test.each(["websearch", "allowUntestedHost"])("refuses a non-boolean %s", (key) => {
    expect(() => parseOptions({ [key]: "yes" })).toThrow(`OPTIONS_INVALID: "${key}" must be true or false. ${NEXT_STEP}`)
  })

  test.each(["everything", "", null, 1])("refuses access %p", (value) => {
    expect(() => parseOptions({ access: value })).toThrow(`OPTIONS_INVALID: "access" must be "all", "ask-changes" or "read-only". ${NEXT_STEP}`)
  })
})
