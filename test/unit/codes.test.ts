// One typed code table, and two docs that must match it exactly. A code that is thrown or returned anywhere must be in
// the table, and the README's Troubleshooting table and the scripting doc's refusal table must not drift in either
// direction.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_CODES, RPC_CODES } from "../../src/codes.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path)
  }
  return out
}

/**
 * Every SCREAMING_SNAKE code in src: one quoted exactly, as a `code:` field, or one that starts a message as
 * `CODE: what happened`.
 */
const raised = new Set(
  walk("src").flatMap((file) => {
    const text = read(file)
    return [
      ...[...text.matchAll(/["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)["']/g)].map((match) => match[1]!),
      ...[...text.matchAll(/["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+): /g)].map((match) => match[1]!),
    ]
  }),
)

/** The codes in a Markdown table row's cell: one code, or several in a row that names them. */
const codesIn = (cell: string) => [...cell.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)`/g)].map((match) => match[1]!)

/** The codes in one column of a Markdown table inside `section`. */
function tableCodes(markdown: string, column: number): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .flatMap((line) => codesIn(line.split("|")[column] ?? ""))
}

const section = (text: string, heading: string) => {
  const at = text.indexOf(`\n${heading}\n`)
  return at === -1 ? "" : text.slice(at + heading.length + 2)
}
const TROUBLESHOOTING = section(read("README.md"), "## Troubleshooting").split(/\n#{1,2} /)[0] ?? ""
const SCRIPTING = read("docs/scripting.md")

describe("codes", () => {
  test("every code raised in src is in one of the two tables", () => {
    // ACCOUNT_UNKNOWN comes from the shared tools RPC and only exists for per-account servers; this plugin has none.
    const known = new Set<string>([...PLUGIN_CODES, ...RPC_CODES, "ACCOUNT_UNKNOWN"])
    // Not plugin codes: HTTP methods, JSON Schema and platform names, and Node's errno codes.
    const plain = new Set([
      "GET", "HEAD", "PUT", "PATCH", "DELETE", "POST", "UTC", "JSON", "MCP", "UUID", "PKCE", "TUI", "API", "URL",
      "ENOENT", "EACCES", "EEXIST", "ENOTDIR", "EISDIR", "EPERM", "ENOSPC", "EMFILE",
    ])
    expect([...raised].filter((code) => !known.has(code) && !plain.has(code)).sort()).toEqual([])
  })

  test("the README's Troubleshooting table lists exactly the plugin's codes", () => {
    // The table's columns are Code, When, Next step.
    expect([...new Set(tableCodes(TROUBLESHOOTING, 1))].sort()).toEqual([...PLUGIN_CODES].sort())
  })

  test("docs/scripting.md lists exactly the tools RPC's codes", () => {
    expect([...new Set(tableCodes(SCRIPTING, 1))].sort()).toEqual([...RPC_CODES].sort())
  })

  test("docs/configuration.md lists exactly the plugin's codes", () => {
    const configuration = section(read("docs/configuration.md"), "## Errors").split(/\n#{1,2} /)[0] ?? ""
    expect([...new Set(tableCodes(configuration, 1))].sort()).toEqual([...PLUGIN_CODES].sort())
  })
})
