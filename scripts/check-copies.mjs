// Fails when a shared module's copy in this plugin differs from the one every plugin carries.
//   node scripts/check-copies.mjs          check the copies this plugin has
//   node scripts/check-copies.mjs --print  print each copy's hash, after a change made in every plugin at once
// Each plugin keeps its own copy, because each bundle and each test suite stands alone. The hashes below name the one
// version all plugins carry: the tools RPC outside its PLUGIN-SPECIFIC block, and the declaration test kit whole.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

const BEGIN = "// >>> PLUGIN-SPECIFIC >>>"
const END = "// <<< PLUGIN-SPECIFIC <<<"

const COPIES = [
  { path: "src/host/tools-rpc.ts", optional: true, sha256: "15d82caa53aaae7ad9efb88dddb97056d3895c4dbf49b8efbb85b743871b2a6d", part: sharedPart },
  { path: "test/support/jelly-kit.ts", optional: false, sha256: "ab599abcf041044c77e7938c3d9a081e00072487a7ec20b654d86c8230951190", part: (text) => text },
]

function sharedPart(text, path) {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin === -1 || end === -1 || end < begin) throw new Error(`${path}: the PLUGIN-SPECIFIC markers are missing or out of order`)
  return text.slice(0, begin) + text.slice(end + END.length)
}

const print = process.argv.includes("--print")
let failed = 0
for (const copy of COPIES) {
  if (!existsSync(copy.path)) {
    if (copy.optional) continue
    console.error(`MISSING: ${copy.path}`)
    failed++
    continue
  }
  const hash = createHash("sha256").update(copy.part(readFileSync(copy.path, "utf8").replaceAll("\r\n", "\n"), copy.path)).digest("hex")
  if (print) console.log(`${copy.path}: ${hash}`)
  else if (hash === copy.sha256) console.log(`same: ${copy.path}`)
  else {
    console.error(`DRIFT: ${copy.path} differs from the copy every plugin carries. Change it in every plugin at once, then update its hash here.`)
    failed++
  }
}
process.exit(failed === 0 ? 0 : 1)
