// The README and the configuration guide print the block the plugin inserts, in full, generated from
// defaultRules(): it is what an administrator copies into managed config, so it cannot be elided or drift. Every
// "tested on …" mention states TESTED_HOSTS, so a release added to the list cannot leave a stale sentence behind.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { TESTED_HOSTS } from "../../src/host-version.js"
import { defaultRules } from "../../src/permissions.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

describe("the default rules block", () => {
  test("the README's Permissions section prints defaultRules() in full", () => {
    const section = /## Permissions([\s\S]*?)## Configure/.exec(read("README.md"))?.[1] ?? ""
    const printed = /generated from[\s\S]*?```json\n([\s\S]*?)\n\s*```/.exec(section)?.[1] ?? "[]"
    expect(JSON.parse(printed)).toEqual(defaultRules())
  })

  test("the configuration guide prints the block for every access value", () => {
    const raw = read("docs/configuration.md")
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      const block = new RegExp(`\`access: "${access}"\`[\\s\\S]*?\n\n\`\`\`json\n([\\s\\S]*?)\n\`\`\``).exec(raw)?.[1] ?? "[]"
      expect({ access, block: JSON.parse(block) }).toEqual({ access, block: defaultRules(access) })
    }
  })

  test("the agent fix example starts with the block's rules", () => {
    const raw = read("docs/configuration.md")
    const example = /for an agent named `reviewer`[\s\S]*?```jsonc\n([\s\S]*?)\n```/.exec(raw)?.[1] ?? "{}"
    const permissions = (JSON.parse(example.replace(/\/\/.*$/gm, "")) as { agents: { reviewer: { permissions: unknown[] } } }).agents.reviewer.permissions
    expect(permissions.slice(0, defaultRules().length)).toEqual(defaultRules())
  })
})

describe("tested hosts", () => {
  const UNRELEASED = /## \[Unreleased\]([\s\S]*?)(?=\n## |$)/.exec(read("CHANGELOG.md"))?.[1] ?? ""
  const SOURCES: [string, string][] = [
    ["README.md", read("README.md")],
    ["AGENTS.md", read("AGENTS.md")],
    ["SECURITY.md", read("SECURITY.md")],
    ["docs/configuration.md", read("docs/configuration.md")],
    ["CHANGELOG.md (Unreleased)", UNRELEASED],
  ]

  test.each(SOURCES)("%s names exactly TESTED_HOSTS wherever it says what is tested", (file, text) => {
    const mentions = text
      .split("\n")
      .flatMap((line) => line.split(/\.\s+/))
      .filter((sentence) => /\btested\b/i.test(sentence))
      // A status sample reads `2.2.3 (tested)`, and the supported range is not a tested release.
      .filter((sentence) => !/\(\s*tested\s*\)/.test(sentence))
      .map((sentence) => sentence.replace(/`[^`]*>=[^`]*`/g, ""))
      .map((sentence) => [...sentence.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((version) => version[0]!))
      .filter((versions) => versions.length > 0)
    for (const versions of mentions) expect({ file, versions: [...new Set(versions)].sort() }).toEqual({ file, versions: [...TESTED_HOSTS].sort() })
  })

  test("the untested example is 2.2.99, and no doc names a future release as tested", () => {
    const all = SOURCES.map(([, text]) => text).join("\n")
    expect(all).toContain("2.2.99")
    expect(all).not.toMatch(/\b2\.2\.(?:7|8|9[0-8])\b(?!\d)/)
  })
})
