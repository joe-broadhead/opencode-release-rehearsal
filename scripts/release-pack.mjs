#!/usr/bin/env node
// Runs the repository's own pack stage against the release tarball. The release workflow calls it after `npm pack`.
//
// The stage is the first of these that exists: a `test:pack`, `pack-smoke` or `check:pack` script in package.json, else
// `node scripts/check.mjs pack` when scripts/check.mjs has a pack stage. A repository with none is refused, with the reason.
// The stage gets the tarball as PACK_TARBALL (the file) and PACKED_DIR (its folder; utilities' pack test reads that). When
// no file under scripts/, test/ or tests/ reads either, the stage may test its own tarball: that is printed as a warning.
//
//   node scripts/release-pack.mjs --tarball <path to the packed release tarball>
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const STAGE_SCRIPTS = ["test:pack", "pack-smoke", "check:pack"]

/**
 * The pack stage for a package.json. `read(path)` returns a file's text, or undefined when there is no such file.
 * Returns { label, command, args }. Throws, with the reason, when the repository has no pack stage.
 */
export function packStage(pkg, read) {
  const scripts = pkg.scripts ?? {}
  for (const name of STAGE_SCRIPTS) {
    if (typeof scripts[name] === "string" && scripts[name].trim() !== "") {
      return { label: `npm run ${name}`, command: "npm", args: ["run", name] }
    }
  }
  const check = read("scripts/check.mjs")
  if (check !== undefined && /["']pack["']/.test(check)) {
    return { label: "node scripts/check.mjs pack", command: "node", args: ["scripts/check.mjs", "pack"] }
  }
  throw new Error(
    'no pack stage: add a "test:pack", "pack-smoke" or "check:pack" script to package.json, or a scripts/check.mjs with a pack stage',
  )
}

/** Whether a file under scripts/, test/ or tests/ of the repository at `root` names PACK_TARBALL or PACKED_DIR. */
export function readsTarball(root) {
  const walk = (dir) => {
    if (!existsSync(dir)) return false
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules" && walk(full)) return true
      } else if (/\.(m?[jt]sx?|sh)$/.test(name) && /PACK_TARBALL|PACKED_DIR/.test(readFileSync(full, "utf8"))) {
        return true
      }
    }
    return false
  }
  return ["scripts", "test", "tests"].some((part) => walk(join(root, part)))
}

function main(argv) {
  const at = argv.indexOf("--tarball")
  const tarball = at >= 0 && argv[at + 1] ? resolve(argv[at + 1]) : undefined
  if (!tarball || !existsSync(tarball)) {
    console.error("release-pack: --tarball must name the packed release tarball")
    process.exit(2)
  }
  const root = process.cwd()
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  let stage
  try {
    stage = packStage(pkg, (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined))
  } catch (error) {
    console.error(`release-pack: ${error.message}`)
    process.exit(1)
  }
  console.log(`pack stage: ${stage.label}`)
  if (!readsTarball(root)) {
    console.log("WARN no file under scripts/, test/ or tests/ reads PACK_TARBALL or PACKED_DIR: the stage may test its own tarball, not this one")
  }
  const result = spawnSync(stage.command, stage.args, {
    stdio: "inherit",
    env: { ...process.env, PACK_TARBALL: tarball, PACKED_DIR: dirname(tarball) },
  })
  if (result.error) {
    console.error(`release-pack: ${result.error.message}`)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
