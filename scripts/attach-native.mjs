#!/usr/bin/env node
// Downloads the artifacts of the native run the release manifest pins, verifies every file against the manifest, and
// stages the verified files for the GitHub Release (NATIVE-DESIGN §4, step 4). It never builds a binary: the release
// re-verifies the bytes that were pinned.
//
//   node scripts/attach-native.mjs --out <dir> [--repo owner/name] [--manifest manifest/native.json]
//
// Per file: size and sha256 equal the manifest; the attestation verifies with `gh attestation verify`. Per module, the
// gzip decompresses to the executable the manifest pins (size and sha256). Any mismatch stops the release. A repository
// with no manifest has nothing to attach: the script says so and exits 0.
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { assetUrl, manifestProblems, MANIFEST_PATH } from "./native-manifest.mjs"
import { ghOutput } from "./release-rules.mjs"

function parseArgs(argv) {
  const options = { out: undefined, repo: process.env.GITHUB_REPOSITORY, manifest: MANIFEST_PATH }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--out") options.out = argv[++i]
    else if (arg === "--repo") options.repo = argv[++i]
    else if (arg === "--manifest") options.manifest = argv[++i]
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!options.out) throw new Error("--out <dir> is required")
  return options
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

/** Every file under a folder, by its file name: the artifacts of one run are downloaded into one folder. */
function filesByName(dir, into = new Map()) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) filesByName(path, into)
    else into.set(name, [...(into.get(name) ?? []), path])
  }
  return into
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.manifest)) {
    console.log(`attach-native: no ${options.manifest}, so this plugin has no native binaries to attach`)
    return
  }
  const manifest = JSON.parse(readFileSync(options.manifest, "utf8"))
  const problems = manifestProblems(manifest, { repository: options.repo })
  if (problems.length) throw new Error(`the manifest is not right: ${problems.join("; ")}`)
  if (!options.repo) throw new Error("the repository is not known: set GITHUB_REPOSITORY or pass --repo")

  const downloads = mkdtempSync(join(tmpdir(), "native-artifacts-"))
  let staged
  try {
    ghOutput(["run", "download", String(manifest.built.run), "--repo", options.repo, "--dir", downloads], { inherit: true })
    const found = filesByName(downloads)
    mkdirSync(options.out, { recursive: true })

    const entries = []
    for (const [module, platforms] of Object.entries(manifest.modules)) {
      for (const [platform, entry] of Object.entries(platforms)) entries.push({ label: `${module} ${platform}`, entry, gzipped: true })
    }
    for (const licence of manifest.licences ?? []) entries.push({ label: `licence ${licence.name}`, entry: licence, gzipped: false })

    for (const { label, entry, gzipped } of entries) {
      const candidates = found.get(entry.name) ?? []
      if (candidates.length !== 1) throw new Error(`${label}: the run's artifacts hold ${candidates.length} files named ${entry.name}; one is needed`)
      const [path] = candidates
      const bytes = readFileSync(path)
      if (bytes.length !== entry.bytes) throw new Error(`${label}: ${entry.name} is ${bytes.length} bytes; the manifest pins ${entry.bytes}`)
      if (sha256(bytes) !== entry.sha256) throw new Error(`${label}: ${entry.name} does not match the manifest's sha256`)
      if (gzipped) {
        const executable = gunzipSync(bytes)
        if (executable.length !== entry.executable.bytes) throw new Error(`${label}: the executable is ${executable.length} bytes; the manifest pins ${entry.executable.bytes}`)
        if (sha256(executable) !== entry.executable.sha256) throw new Error(`${label}: the executable does not match the manifest's sha256`)
      }
      ghOutput(["attestation", "verify", path, "--repo", options.repo], { inherit: true })
      copyFileSync(path, join(options.out, entry.name))
      console.log(`ok   ${label}: ${entry.name} (${bytes.length} bytes, attested) from ${assetUrl(manifest, entry)}`)
    }
    staged = entries.length
  } finally {
    rmSync(downloads, { recursive: true, force: true })
  }
  console.log(`attach-native: ${staged} files verified and staged in ${options.out}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (error) {
    console.error(`attach-native: ${error.message}`)
    process.exit(1)
  }
}
