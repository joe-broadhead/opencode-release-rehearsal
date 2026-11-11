import { describe, expect, test } from "bun:test"
import { checkHost, HOST_RANGE, inHostRange, TESTED_HOSTS, TESTED_TEXT } from "../../src/host-version.js"
import pkg from "../../package.json" with { type: "json" }

describe("host check", () => {
  test("the range is the 2.2 line from 2.2.3, matches opencode.host, and the package declares no peers", () => {
    expect(HOST_RANGE).toBe(">=2.2.3 <2.3.0")
    expect(pkg.opencode.host).toBe(HOST_RANGE)
    expect(pkg).not.toHaveProperty("peerDependencies")
    expect(pkg).not.toHaveProperty("peerDependenciesMeta")
  })

  test("the tested releases are 2.2.3, 2.2.4, 2.2.5 and 2.2.6, all inside the range", () => {
    expect([...TESTED_HOSTS]).toEqual(["2.2.3", "2.2.4", "2.2.5", "2.2.6"])
    expect(TESTED_HOSTS.every(inHostRange)).toBe(true)
    expect(TESTED_TEXT).toBe("2.2.3, 2.2.4, 2.2.5 or 2.2.6")
  })

  test.each(["2.2.3", "2.2.4", "2.2.5", "2.2.6"])("%s is tested", (version) => {
    expect(checkHost(version, false, () => {})).toEqual({ version, tested: true, inRange: true })
  })

  test.each(["2.2.99", "2.2.10"])("%s is inside the range but untested: it runs, without a warning", (version) => {
    const warnings: string[] = []
    expect(checkHost(version, false, (message) => warnings.push(message))).toEqual({ version, tested: false, inRange: true })
    expect(warnings).toEqual([])
  })

  test.each([
    "2.2.2",
    "2.1.9",
    "2.3.0",
    "2.9.0",
    "2.10.12",
    "3.0.0",
    "1.9.9",
    "0.0.0-dev-1",
    "2.2.4-beta.1",
    "2.3.0-rc.1",
    "v2.2.3",
  ])("%p is refused", (version) => {
    expect(inHostRange(version)).toBe(false)
    expect(() => checkHost(version, false, () => {})).toThrow(
      `HOST_UNTESTED: This plugin supports OpenCode >=2.2.3 <2.3.0, and this is ${version}. Next step: Use OpenCode 2.2.3, 2.2.4, 2.2.5 or 2.2.6, or set "allowUntestedHost": true to run anyway.`,
    )
  })

  test("a host that reports no version is refused, and reported as null with the override", () => {
    expect(() => checkHost("", false, () => {})).toThrow(
      `HOST_UNTESTED: This plugin supports OpenCode >=2.2.3 <2.3.0, and this is a release that reports no version. Next step:`,
    )
    expect(checkHost(" ", true, () => {})).toEqual({ version: null, tested: false, inRange: false })
  })

  test.each(["2.3.0", "3.0.0", "2.2.2", "0.0.0-dev-1"])("the override warns once for %p and continues", (version) => {
    const warnings: string[] = []
    expect(checkHost(version, true, (message) => warnings.push(message))).toEqual({ version, tested: false, inRange: false })
    expect(warnings).toEqual([
      `HOST_UNTESTED: This plugin supports OpenCode >=2.2.3 <2.3.0, and this is ${version}; it runs because "allowUntestedHost" is true. Next step: If Tavily misbehaves, use OpenCode 2.2.3, 2.2.4, 2.2.5 or 2.2.6.`,
    ])
  })

  test("a tested host does not warn, even with the override", () => {
    const warnings: string[] = []
    checkHost("2.2.3", true, (message) => warnings.push(message))
    expect(warnings).toEqual([])
  })
})
