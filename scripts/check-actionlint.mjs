#!/usr/bin/env node
// The workflows are parsed as workflows, not as YAML: `actionlint` catches a `${{ }}` that only exists in one context,
// which makes GitHub reject the whole file and run nothing. CI runs it in its own job; here it runs when the tool is on
// PATH and prints a visible notice when it is not.
import { spawnSync } from "node:child_process"

const probe = spawnSync("actionlint", ["-version"], { encoding: "utf8" })
if (probe.error?.code === "ENOENT") {
  console.log("actionlint is not on PATH, so the workflow check is skipped here; CI runs it in its own job.")
  process.exit(0)
}
const run = spawnSync("actionlint", ["-color"], { stdio: "inherit" })
process.exit(run.status ?? 1)
