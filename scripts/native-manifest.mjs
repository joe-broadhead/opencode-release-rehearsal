// The rules for `manifest/native.json` (NATIVE-DESIGN §2.2), shared by release-commit.mjs, release-github.mjs,
// check-release-shape.mjs and attach-native.mjs. A plugin with no native part has no manifest, and none of this applies
// to it.
//
// The manifest names the tag, the master commit and the native run its binaries were built from. Each module lists per
// platform the release asset (a gzip, served from this repository's release on the tag) and the executable it holds,
// both pinned by sha256 and size. Optional `licences` name licence files the same run produced, and the release attaches
// them next to the binaries.
export const MANIFEST_PATH = "manifest/native.json"

const SHA256 = /^[0-9a-f]{64}$/
const SHA1 = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** The platform names a native plugin ships, exactly: the four the native repositories build (UPDATED-6). Any other name is refused. */
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu"]

const isBytes = (value) => Number.isSafeInteger(value) && value > 0

/** The problems with a parsed manifest, as sentences. An empty list means the manifest is well formed for these inputs. */
export function manifestProblems(manifest, { plugin, tag, commit, repository } = {}) {
  const problems = []
  if (!manifest || typeof manifest !== "object") return ["the manifest is not an object"]
  if (manifest.schema !== 1) problems.push(`schema is ${manifest.schema}; it must be 1`)
  if (plugin !== undefined && manifest.plugin !== plugin) problems.push(`plugin is ${manifest.plugin}; the package is ${plugin}`)
  if (typeof manifest.repository !== "string" || !REPOSITORY.test(manifest.repository)) problems.push("repository must be owner/name")
  else if (repository !== undefined && manifest.repository !== repository) problems.push(`repository is ${manifest.repository}; this repository is ${repository}`)
  if (tag !== undefined && manifest.tag !== tag) problems.push(`tag is ${manifest.tag}; the release tag is ${tag}`)
  const built = manifest.built ?? {}
  if (!SHA1.test(built.commit ?? "")) problems.push("built.commit must be a full sha")
  else if (commit !== undefined && built.commit !== commit) problems.push(`built.commit is ${built.commit.slice(0, 12)}; the tag's parent is ${commit.slice(0, 12)}`)
  if (!isBytes(built.run)) problems.push("built.run must be a positive run id")
  if (built.workflow !== "native") problems.push(`built.workflow is ${built.workflow}; it must be native`)

  const base = typeof manifest.repository === "string" && typeof manifest.tag === "string" ? `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/` : undefined
  const modules = manifest.modules ?? {}
  if (!Object.keys(modules).length) problems.push("modules is empty")
  for (const [module, platforms] of Object.entries(modules)) {
    for (const [platform, entry] of Object.entries(platforms ?? {})) {
      const where = `${module} ${platform}`
      if (!PLATFORMS.includes(platform)) problems.push(`${where}: the platform name must be one of ${PLATFORMS.join(", ")}`)
      problems.push(...assetProblems(entry, where, base))
      if (!entry?.executable || typeof entry.executable.name !== "string" || !isBytes(entry.executable.bytes) || !SHA256.test(entry.executable.sha256 ?? "")) {
        problems.push(`${where}: executable must name a file, its bytes and its sha256`)
      }
    }
  }
  for (const licence of manifest.licences ?? []) problems.push(...assetProblems(licence, `licence ${licence?.name}`, base))
  return problems
}

function assetProblems(entry, where, base) {
  const problems = []
  if (!entry || typeof entry !== "object") return [`${where}: the entry is not an object`]
  if (typeof entry.name !== "string" || !entry.name || entry.name.includes("/")) problems.push(`${where}: name must be a plain file name`)
  if (base && entry.url !== undefined && entry.url !== `${base}${entry.name}`) problems.push(`${where}: url must be the release asset of this tag`)
  if (!isBytes(entry.bytes)) problems.push(`${where}: bytes must be a positive size`)
  if (!SHA256.test(entry.sha256 ?? "")) problems.push(`${where}: sha256 must be 64 hex characters`)
  return problems
}

/** The release asset URL the manifest names, for one entry. */
export function assetUrl(manifest, entry) {
  return `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${entry.name}`
}
