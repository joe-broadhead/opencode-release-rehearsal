import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { INTEGRATION_ID } from "../../src/credential.js"
import { SERVER_NAME } from "../../src/mcp.js"
import { parseOptions } from "../../src/options.js"
import { defaultRules, KNOWN_ACTIONS } from "../../src/permissions.js"
import { declarationProblems, docProblems, effectFromRules, readPackage } from "../support/jelly-kit.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly's agents have no base
 * "allow everything" rule, so this plugin's own default rules never reach them; Jelly writes each declared "ask" or
 * "deny" as that tool's default instead. The shared kit checks the declaration against Jelly's plugin authors'
 * standard; the tests below add what only Tavily declares.
 */
const ROOT = new URL("../../", import.meta.url)
const pkg = readPackage(ROOT)
const signIns = pkg.jelly?.signIns ?? []

describe("the jelly declaration", () => {
  test("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    expect(declarationProblems(ROOT, { effectOf: effectFromRules(defaultRules()), registered: KNOWN_ACTIONS })).toEqual([])
  })

  test("declares each tool read-only", () => {
    for (const tool of pkg.jelly?.tools ?? []) expect(tool.readOnly, tool.name).toBe(true)
  })

  test("exposes the flat access and websearch options", () => {
    const settings = (pkg.jelly?.contributes as { settings: { key: string; type: string; default: unknown }[] }).settings
    expect(settings.map(({ key, type }) => ({ key, type }))).toEqual([
      { key: "access", type: "string" },
      { key: "websearch", type: "boolean" },
    ])
    expect(parseOptions({ access: "read-only", websearch: false })).toMatchObject({ access: "read-only", websearch: false })
    const defaults = parseOptions({})
    for (const setting of settings) expect(setting.default).toBe(defaults[setting.key as "access" | "websearch"])
  })

  test("declares the two sign-ins: an API key through the built-in Tavily entry, or OAuth with a Tavily account", () => {
    const key = signIns.find((signIn) => signIn.id === "key")
    const account = signIns.find((signIn) => signIn.id === "account")
    expect(signIns).toHaveLength(2)
    expect(key).toMatchObject({ integration: INTEGRATION_ID, label: "Tavily" })
    expect(account).toMatchObject({ server: SERVER_NAME, label: "Tavily account" })
    expect((key as { group?: string }).group).toBe((account as { group?: string }).group)
  })
})

describe("docs/jelly.md", () => {
  test("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })

  test("quotes the message /connect shows for a rejected key", () => {
    expect(readFileSync(new URL("docs/jelly.md", ROOT), "utf8")).toContain(
      "> Tavily did not accept this API key. Replace it, or remove it to sign in with your Tavily account.",
    )
  })
})
