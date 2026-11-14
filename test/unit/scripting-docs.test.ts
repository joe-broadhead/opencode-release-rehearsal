// docs/scripting.md and the README's scripting lines are the contract a script author copies. Every example must use a
// method this plugin registers, carry the location header and the strict envelope, and name only fields that method's
// schema accepts, so a doc example cannot drift from the code.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { METHODS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { RECORDED_TOOLS } from "../host/catalog.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const FILES = ["docs/scripting.md", "README.md"]
const METHODS_BY_NAME = new Map(METHODS.map((method) => [method.name, method]))
/** The tool the method runs: the method `tavily_search` runs the recorded tool `tavily_search`. */
const TOOL_OF = new Map(RECORDED_TOOLS.map((tool) => [tool.name, tool]))

interface Example {
  readonly file: string
  readonly line: number
  readonly method: string
  readonly body: unknown
  readonly statement: string
}

/** Every `opencode api post /api/rpc/…` call in a file, as its method name and its parsed body. */
function calls(file: string, text: string): Example[] {
  return [...text.matchAll(/opencode api post \/api\/rpc\/([A-Za-z0-9.]+)\/([A-Za-z0-9_]+)/g)].map((match) => {
    const start = match.index!
    // A statement runs to the end of its fenced block or the next blank line.
    const rest = text.slice(start)
    const end = rest.search(/\n\s*\n|\n```/)
    const statement = (end === -1 ? rest : rest.slice(0, end)).trim()
    return {
      file,
      line: text.slice(0, start).split("\n").length,
      method: match[2]!,
      body: bodyOf(statement),
      statement,
    }
  })
}

/** The `-d '{…}'` body of a statement, by matching braces. */
function bodyOf(statement: string): unknown {
  const at = statement.indexOf("-d '{")
  if (at === -1) return undefined
  let depth = 0
  let inString = false
  for (let i = at + 4; i < statement.length; i++) {
    const char = statement[i]
    if (inString) {
      if (char === "\\") i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(statement.slice(at + 4, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

const examples = FILES.flatMap((file) => calls(file, readFileSync(join(ROOT, file), "utf8")))

/** The tool's input nested in the strict envelope. */
const inputOf = (body: unknown) => (body as { input?: { input?: unknown } } | undefined)?.input?.input

describe("the scripting examples", () => {
  test("there are examples to check", () => {
    expect(examples.length).toBeGreaterThan(2)
  })

  test.each(examples)("$file:$line calls $method with this plugin's RPC id and a real method", (example) => {
    expect(example.statement).toContain("/api/rpc/rehearsal.kit.tools/")
    expect(TOOLS_RPC_ID).toBe("rehearsal.kit.tools")
    expect(example.method === "describe" || METHODS_BY_NAME.has(example.method)).toBe(true)
  })

  test.each(examples)("$file:$line sends the location header", (example) => {
    expect(example.statement).toContain('-H "x-opencode-directory:$PWD"')
  })

  test.each(examples)("$file:$line sends the strict envelope", (example) => {
    const envelope = (example.body as { input?: Record<string, unknown> } | undefined)?.input
    expect(envelope).toBeDefined()
    if (example.method === "describe") {
      expect(Object.keys(envelope!).filter((key) => key !== "sessionID")).toEqual([])
      return
    }
    expect(Object.keys(envelope!).sort()).toEqual(["input", "sessionID"])
    expect(typeof envelope!["sessionID"]).toBe("string")
    expect(typeof envelope!["input"]).toBe("object")
  })

  test.each(examples.filter((example) => example.method !== "describe"))("$file:$line names only fields $method accepts", (example) => {
    const method = METHODS_BY_NAME.get(example.method)!
    expect(method.kind).toBe("mcp")
    // The recorded catalog keeps each tool's required fields, so those are the fields an example may name.
    const tool = TOOL_OF.get(example.method)!
    const properties = Object.keys((tool.inputSchema.properties ?? {}) as object)
    const input = (inputOf(example.body) ?? {}) as Record<string, unknown>
    for (const key of Object.keys(input)) expect({ key, known: properties.includes(key) }).toEqual({ key, known: true })
    for (const key of tool.inputSchema.required as readonly string[]) expect({ key, given: key in input }).toEqual({ key, given: true })
  })
})
