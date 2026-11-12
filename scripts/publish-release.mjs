#!/usr/bin/env node
// Creates the GitHub Release for a tag, or, when the Release already exists, adds the kit's files that are missing.
// It never deletes or replaces an asset, and never refuses an asset it does not know: assets attached later (a backup of
// speech files, for example) stay where they are, and are listed. A kit file already on the Release must have the same
// sha256 as the local file; if one does not, nothing is uploaded. The kit's files are every file under the folder, the
// native binaries in its native/ subfolder included; an asset's name is its file name. `gh` runs only through ghOutput
// (scripts/release-rules.mjs), which allows only the kit's own calls.
//
//   node scripts/publish-release.mjs --tag <tag> --dir <folder: the kit's files, SHA256SUMS included> --notes <notes file>
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ghOutput } from "./release-rules.mjs"

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")

/** Every file under the folder, as { name, path }; a Release asset is one file, so two files with one name refuse. */
export function kitFiles(dir) {
  const found = []
  const walk = (folder) => {
    for (const entry of readdirSync(folder).sort()) {
      const full = join(folder, entry)
      if (statSync(full).isDirectory()) walk(full)
      else found.push({ name: entry, path: full })
    }
  }
  walk(dir)
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const names = found.map((file) => file.name)
  const repeated = names.find((name, index) => names.indexOf(name) !== index)
  if (repeated) throw new Error(`two kit files are named ${repeated}: a Release asset is one file name`)
  return found
}

/**
 * Publishes the folder's files on the tag's Release. `gh(args)` runs the GitHub CLI and returns its output, or throws with
 * the CLI's message. Returns { action, uploaded, unknown }: what was done, the names uploaded now, and the names on the
 * Release that are not kit files (left alone).
 */
export function publish({ tag, dir, notes, gh }) {
  const kit = kitFiles(dir)
  if (!kit.some((file) => file.name === "SHA256SUMS")) throw new Error(`${dir} has no SHA256SUMS: the kit's files are not all there`)

  let view
  try {
    view = JSON.parse(gh(["release", "view", tag, "--json", "assets,isDraft"]))
  } catch (error) {
    if (!/not found/i.test(String(error.message))) throw error
    view = undefined
  }

  if (!view) {
    gh(["release", "create", tag, "--verify-tag", "--title", tag, "--notes-file", notes, ...kit.map((file) => file.path)])
    return { action: "created", uploaded: kit.map((file) => file.name), unknown: [] }
  }
  if (view.isDraft) throw new Error(`the Release for ${tag} is a draft: publish or delete it by hand, then run again`)

  const onRelease = new Set(view.assets.map((asset) => asset.name))
  const missing = kit.filter((file) => !onRelease.has(file.name))

  // Plan first: every kit file already on the Release must match before anything is uploaded.
  const scratch = mkdtempSync(join(tmpdir(), "publish-release-"))
  try {
    for (const file of kit.filter((item) => onRelease.has(item.name))) {
      gh(["release", "download", tag, "--pattern", file.name, "--dir", scratch])
      if (sha256(join(scratch, file.name)) !== sha256(file.path)) {
        throw new Error(`${file.name} is on the Release with other contents: nothing was uploaded; remove that asset by hand if it is wrong`)
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  if (missing.length) gh(["release", "upload", tag, ...missing.map((file) => file.path)])
  const names = new Set(kit.map((file) => file.name))
  const unknown = [...onRelease].filter((name) => !names.has(name)).sort()
  return { action: missing.length ? "uploaded" : "unchanged", uploaded: missing.map((file) => file.name), unknown }
}

function main(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const tag = value("--tag")
  const dir = value("--dir")
  const notes = value("--notes")
  if (!tag || !dir || !notes) {
    console.error("usage: publish-release.mjs --tag <tag> --dir <folder> --notes <notes file>")
    process.exit(2)
  }
  try {
    const result = publish({ tag, dir, notes, gh: (args) => ghOutput(args) })
    console.log(`release ${tag}: ${result.action}; uploaded now: ${result.uploaded.join(", ") || "none"}`)
    if (result.unknown.length) console.log(`left alone (not kit files): ${result.unknown.join(", ")}`)
  } catch (error) {
    console.error(`publish-release: ${error.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
