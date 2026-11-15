// The rehearsal's `npm run conformance`. TEST ONLY: the rehearsal is no source plugin and has no source contract, so this
// writes a fixture report, marked as one, in the shape the family's reports share (plugin, version, ok, sources), so a
// rehearsal release exercises the kit's conformance path: the release's conformance job, the report in SHA256SUMS and
// the Release asset. A plugin of the family runs @we-the-rebel-alliance/source-contract's conformance kit here instead.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const report = {
  plugin: pkg.name,
  version: pkg.version,
  contract: "none: a rehearsal fixture, not the source contract's conformance kit",
  fixture: true,
  ok: true,
  sources: [],
}
mkdirSync(join(root, "reports"), { recursive: true })
writeFileSync(join(root, "reports", "conformance-report.json"), `${JSON.stringify(report, null, 2)}\n`)
console.log(`wrote reports/conformance-report.json (rehearsal fixture, ok, ${pkg.name} ${pkg.version})`)
