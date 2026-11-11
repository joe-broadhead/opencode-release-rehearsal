#!/usr/bin/env node
// Prints the OpenCode versions this plugin is tested on, read from its TESTED_HOSTS list in src/, as `hosts=<JSON array>`
// for the release workflow's matrix. The workflow reads the list here, so the versions are never written into it.
//
// The list is an array literal, or a name bound to one: a const in the same file, or a default import of a JSON array
// (history keeps its list in src/host/tested-hosts.json and re-exports it as TESTED_HOSTS). Refuses when there is no list,
// more than one, an empty one, or an entry that is not an x.y.z version.
//
//   node scripts/tested-hosts.mjs           (run from the repository root; the workflow appends the output to GITHUB_OUTPUT)
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const DECLARATION = /export const TESTED_HOSTS\b[^=]*=\s*(\[[\s\S]*?\]|[A-Za-z_$][\w$]*)/g
const VERSION = /^\d+\.\d+\.\d+$/

/** Every .ts file under a directory, skipping node_modules and dist. */
function sourceFiles(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full))
    else if (name.endsWith(".ts")) found.push(full)
  }
  return found
}

const quotedStrings = (text) => [...text.matchAll(/["']([^"']*)["']/g)].map((match) => match[1])

/** The list a name stands for, in the file that uses it: a JSON default import, or a const array in the same file. */
function listNamed(file, name, source) {
  const jsonImport = new RegExp(`import\\s+${name}\\s+from\\s+["']([^"']+\\.json)["']`).exec(source)
  if (jsonImport) {
    const json = JSON.parse(readFileSync(resolve(dirname(file), jsonImport[1]), "utf8"))
    if (!Array.isArray(json) || !json.every((entry) => typeof entry === "string")) {
      throw new Error(`${jsonImport[1]} is not a list of strings`)
    }
    return json
  }
  const constant = new RegExp(`const\\s+${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(source)
  if (constant) return quotedStrings(constant[1])
  throw new Error(`TESTED_HOSTS names ${name}, which is neither a JSON import nor a const array in ${file}`)
}

/** The TESTED_HOSTS versions of the repository at `root`, in the order the list gives them. Throws when they are not right. */
export function testedHosts(root) {
  const declarations = []
  for (const file of sourceFiles(join(root, "src"))) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(DECLARATION)) {
      const value = match[1]
      declarations.push(value.startsWith("[") ? quotedStrings(value.slice(1, -1)) : listNamed(file, value, source))
    }
  }
  if (declarations.length !== 1) throw new Error(`expected one TESTED_HOSTS list under src/, found ${declarations.length}`)
  const hosts = declarations[0]
  if (hosts.length === 0) throw new Error("TESTED_HOSTS is empty")
  const bad = hosts.filter((host) => !VERSION.test(host))
  if (bad.length) throw new Error(`TESTED_HOSTS has entries that are not x.y.z versions: ${bad.join(", ")}`)
  return hosts
}

function main() {
  try {
    console.log(`hosts=${JSON.stringify(testedHosts(process.cwd()))}`)
  } catch (error) {
    console.error(`tested-hosts: ${error.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
