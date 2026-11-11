// The release version and its tag, the one rule every kit script uses: a version is x.y.z, numbers without leading zeros,
// with no prerelease or build part, and its tag is exactly v<version>. It has no dependencies.

const CORE = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)"
/** The version part of a pattern, without anchors, for patterns that embed it (a CHANGELOG heading). */
export const VERSION_SOURCE = CORE
/** A whole release version. */
export const RELEASE_VERSION = new RegExp(`^${CORE}$`)

/** The release tag of a version: exactly v<version>. */
export const tagFor = (version) => `v${version}`

/** Whether a tag name is a release tag, v<x.y.z>. */
export const isReleaseTag = (tag) => typeof tag === "string" && tag.startsWith("v") && RELEASE_VERSION.test(tag.slice(1))

/** -1, 0 or 1, comparing two release versions by number. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number))
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/** Why package.json's version cannot be released, or undefined. */
export function versionProblem(version) {
  return typeof version === "string" && RELEASE_VERSION.test(version) ? undefined : `package.json version ${JSON.stringify(version)} is not x.y.z`
}

/** Why a tag cannot release package.json's version, or undefined: the tag must be exactly v<version>. */
export function tagProblem(tag, version) {
  const problem = versionProblem(version)
  if (problem) return problem
  return tag === tagFor(version) ? undefined : `the tag is ${tag}, and package.json's version ${version} releases only as ${tagFor(version)}`
}
