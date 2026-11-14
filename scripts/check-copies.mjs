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
  // The release kit, whole: one version in every plugin (CONTRIBUTING.md, Releasing). Change it in every plugin at once.
  { path: "scripts/attach-native.mjs", optional: false, sha256: "835b12b5d4e95fe87f61a2656f7be0baf8c805299cadff7110a16a6f2b475f8e", part: (text) => text },
  { path: "scripts/capture-tools.mjs", optional: false, sha256: "bf1276b41979c94519f4d42c580ebf8b077b66cb969fa234063a241d0073fa63", part: (text) => text },
  { path: "scripts/changelog.mjs", optional: false, sha256: "72980c16bea66ebdb991169796db6e1c29779f1f3d491dc5824a5bacc0efdcd9", part: (text) => text },
  { path: "scripts/check-drift.mjs", optional: false, sha256: "ab00422dafac7e8166ffcbbe386469c80f32d76f4d88bc3ea5973d158d5f1e90", part: (text) => text },
  { path: "scripts/check-release-plugin-add.sh", optional: false, sha256: "557fda41255c0b9fd0d3be3e7fc9518fc2cb097cd8fc9766b76fa0b3c3620f89", part: (text) => text },
  { path: "scripts/check-release-shape.mjs", optional: false, sha256: "cca057c01cbbd1c3caead2b769b47fae9037243d3e3e4f322d7dfab02d3b3f46", part: (text) => text },
  { path: "scripts/drift-kit.test.mjs", optional: false, sha256: "41a4ef7f081bc4c0518354b3afa189c5769b9efe8a277923bcf4b25bc4e32504", part: (text) => text },
  { path: "scripts/native-manifest.mjs", optional: false, sha256: "4dc1025825b2802cc6afc31e597745f89dd1da9a50856ca69b3f3322844ecfc7", part: (text) => text },
  { path: "scripts/publish-release.mjs", optional: false, sha256: "9615e2eaab236a8ba01c133be87a2428d17a5612716a4df05c788ff1be7668a1", part: (text) => text },
  { path: "scripts/release-commit.mjs", optional: false, sha256: "d160509cb4ce7e79bdd84561743b874ea6c4e38a6bde4b7252f73fa85e8fed40", part: (text) => text },
  { path: "scripts/release-github.mjs", optional: false, sha256: "8dc817f8166cbeb510737ce35458010c916acca06f5143369053c9880d7e5090", part: (text) => text },
  { path: "scripts/release-kit.test.mjs", optional: false, sha256: "23e770adeff5020acdb84f6109e2c0649763a2b4a467ae30e7b25603a04711ac", part: (text) => text },
  { path: "scripts/release-pack.mjs", optional: false, sha256: "47400eb783dbdcb710efa7073619ac577c044434681113daf782271538cf8e22", part: (text) => text },
  { path: "scripts/release-rules.mjs", optional: false, sha256: "a3448fb08421134c3c1c2101df92d4267c00fb47ac8e4173f8c1b9e40287f6a2", part: (text) => text },
  { path: "scripts/release-version.mjs", optional: false, sha256: "24c2b5f9caca6f381cbadd069178a4c3522c09a8f7a6acb06ce1b347f1c4994b", part: (text) => text },
  { path: "scripts/tested-hosts.mjs", optional: false, sha256: "370b2d6d7243cbc55ef435682bd75f113d0e18e5f7e063dd35407324362ce381", part: (text) => text },
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
