// The host suite on every tested OpenCode release (TESTED_HOSTS in src/host-version.ts), the way R11 asks for it: the
// locked @opencode/sdk for the dev pin, and each other release installed from npm into a folder under the system's
// /tmp, outside the lockfile, once per run. A release whose host suite does not run, or fails, fails this stage.
//   node tools/host-tests.mjs                        every tested release
//   HOST_SDK_DIR=<dir> node tools/host-tests.mjs     only the SDK installed in <dir>, for a CI retry
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const env = { ...process.env, PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` }
// Node loads src/host-version.ts by stripping its types, so the one list of tested releases is the one this loop runs.
const { TESTED_HOSTS } = await import(new URL("../src/host-version.ts", import.meta.url).href)
const DEV_PIN = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["@opencode/sdk"]

const run = (command, args, extra = {}) => spawnSync(command, args, { cwd: root, stdio: "inherit", env, ...extra }).status ?? 1

if (process.env.HOST_SDK_DIR) {
  // One SDK, for a retry: the caller installed it and set HOST_SDK_DIR.
  process.exit(run("bun", ["test", "./test/host"]))
}

const ran = []
for (const version of TESTED_HOSTS) {
  console.log(`\n[host] @opencode/sdk ${version}${version === DEV_PIN ? " (the dev pin, this checkout's copy)" : ""}`)
  if (version === DEV_PIN) {
    const code = run("bun", ["test", "./test/host"])
    if (code !== 0) process.exit(code)
    ran.push(version)
    continue
  }
  const dir = mkdtempSync(join(realpathSync("/tmp"), `tavily-host-sdk-${version}-`))
  try {
    // Its own package.json, so npm never walks up to another one.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tavily-host-sdk", private: true }))
    const installed = run("npm", ["install", `@opencode/sdk@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: dir })
    if (installed !== 0) process.exit(installed)
    const code = run("bun", ["test", "./test/host"], { env: { ...env, HOST_SDK_DIR: dir } })
    if (code !== 0) process.exit(code)
    ran.push(version)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A release that did not run is a failure, in CI as here: nothing may skip silently.
const missing = TESTED_HOSTS.filter((version) => !ran.includes(version))
if (missing.length > 0) {
  console.error(`[host] FAILED: no host suite ran on ${missing.join(", ")}.`)
  process.exit(1)
}
console.log(`\n[host] passed on @opencode/sdk ${ran.join(", ")}`)
