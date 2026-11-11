#!/usr/bin/env node
// The CHANGELOG's release shape. Each GitHub release is a top-level `## [x.y.z] - YYYY-MM-DD` heading, newest first.
// While a release is being prepared, its notes sit under `## [Unreleased]`, above the released ones. The npm history
// stays under `## Earlier releases on npm`, the last section, as `### npm <version> - <date>` headings. The release
// notes are the section of the version being released. check-release-shape.mjs and release-github.mjs read the notes
// and the problems; it works on text only.
//
//   node scripts/changelog.mjs release [--date YYYY-MM-DD]   turns `## [Unreleased]` into `## [<version>] - <date>`, for
//                                                           package.json's version (the date is today's, UTC, by default)
//   node scripts/changelog.mjs check                        prints what the release of package.json's version would refuse
//
// Known limits: the Markdown scan follows CommonMark for fences at the top level only (up to three spaces of
// indentation), and for `## ` headings at the start of a line. It does not read container blocks, so a fence inside a
// list item indented by four or more spaces is not seen as a fence. It does not read setext headings (a line of text
// underlined with `---` or `===`), or ATX headings written with a tab or with closing `#`s.
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { compareVersions, RELEASE_VERSION, VERSION_SOURCE } from "./release-version.mjs"

export const UNRELEASED_HEADING = "## [Unreleased]"
export const EARLIER_HEADING = "## Earlier releases on npm"

const VERSION_HEADING = new RegExp(`^## \\[(${VERSION_SOURCE})\\](?: - (.+))?$`)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
// CommonMark fences: up to three spaces of indentation, then three or more backticks or tildes. A backtick fence's info
// string has no backtick. The closing fence uses the same character, at least as many, and nothing after but spaces.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const INDENTED_HEADING = /^ {1,3}## /

/**
 * The `## ` heading lines outside fenced code, the `## ` headings indented by one to three spaces (CommonMark renders
 * them as headings too), and the line of a fence that is never closed (CommonMark runs it to the end of the file).
 */
function scan(lines) {
  const headings = []
  const indented = []
  let fence
  lines.forEach((line, index) => {
    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = undefined
      return
    }
    const open = FENCE_OPEN.exec(line)
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) fence = { char: open[1][0], length: open[1].length, line: index }
    else if (line.startsWith("## ")) headings.push(index)
    else if (INDENTED_HEADING.test(line)) indented.push(index)
  })
  return { headings, indented, unclosed: fence?.line }
}

/** What the text's Markdown structure hides from the release shape: an unclosed fence, or an indented heading. */
function structureProblems(lines, { indented, unclosed }) {
  const problems = []
  if (unclosed !== undefined) problems.push(`the code fence on line ${unclosed + 1} is never closed, so everything after it is code`)
  for (const index of indented) problems.push(`line ${index + 1} is a heading indented by spaces: start "${lines[index].trim()}" at the line's beginning`)
  return problems
}

function trimBlank(lines) {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === "") start++
  while (end > start && lines[end - 1].trim() === "") end--
  return lines.slice(start, end)
}

function trimEnd(lines) {
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === "") end--
  return lines.slice(0, end)
}

function classify(heading, body) {
  if (heading === UNRELEASED_HEADING) return { kind: "unreleased", heading, body }
  if (heading === EARLIER_HEADING) return { kind: "earlier", heading, body }
  const match = VERSION_HEADING.exec(heading)
  if (match) return { kind: "version", heading, version: match[1], date: match[2] ?? null, body }
  return { kind: "other", heading, body }
}

/** The lines before the first `## ` heading, one section per `## ` heading, and what the structure hides. */
export function parseChangelog(text) {
  const lines = text.split("\n")
  const found = scan(lines)
  const starts = found.headings
  const preamble = lines.slice(0, starts.length ? starts[0] : lines.length)
  const sections = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length
    return classify(lines[start], lines.slice(start + 1, end))
  })
  return { preamble, sections, structure: structureProblems(lines, found) }
}

/**
 * The CHANGELOG with `## [Unreleased]` released as `## [<version>] - <date>`, above every earlier release. Every other
 * section keeps its text. When the version already has its heading and nothing is unreleased, the text is returned
 * unchanged, so a second run changes nothing. Throws, so the caller writes nothing, on a heading the shape does not
 * know, on an empty or repeated Unreleased section, on Unreleased notes next to a heading for the version, and on a
 * release newer than the version.
 */
export function shapeChangelog(text, { version, date }) {
  if (!RELEASE_VERSION.test(version ?? "")) throw new Error(`the version ${JSON.stringify(version)} is not x.y.z`)
  if (!ISO_DATE.test(date ?? "")) throw new Error(`the date ${JSON.stringify(date)} is not YYYY-MM-DD`)
  const { preamble, sections, structure } = parseChangelog(text)
  if (structure.length) throw new Error(`${structure[0]}: edit CHANGELOG.md by hand`)
  const unknown = sections.find((s) => s.kind === "other")
  if (unknown) throw new Error(`"${unknown.heading}" is not a heading the release shape knows: edit CHANGELOG.md by hand`)
  const unreleased = sections.filter((s) => s.kind === "unreleased")
  if (unreleased.length > 1) throw new Error(`CHANGELOG.md has ${unreleased.length} ${UNRELEASED_HEADING} sections: merge them by hand`)
  const versions = sections.filter((s) => s.kind === "version")
  const existing = versions.filter((s) => s.version === version)
  if (!unreleased.length) {
    if (existing.length) return text
    throw new Error(`CHANGELOG.md has no ${UNRELEASED_HEADING} section to release as ${version}`)
  }
  if (existing.length) throw new Error(`CHANGELOG.md has both ${UNRELEASED_HEADING} and a ## [${version}] heading: merge them by hand`)
  const newer = versions.find((s) => compareVersions(s.version, version) >= 0)
  if (newer) throw new Error(`"${newer.heading}" is not older than ${version}: a release goes above every earlier one`)
  const notes = trimEnd(unreleased[0].body)
  if (!trimBlank(notes).length) throw new Error(`the ${UNRELEASED_HEADING} section has no notes`)
  const blocks = []
  const head = trimEnd(preamble)
  if (head.length) blocks.push(head)
  blocks.push([`## [${version}] - ${date}`, ...notes])
  for (const section of sections.filter((s) => s.kind !== "unreleased")) blocks.push([section.heading, ...trimEnd(section.body)])
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`
}

/** What the release of `version` would refuse about a CHANGELOG (empty means it is in shape). */
export function changelogProblems(text, version) {
  if (!RELEASE_VERSION.test(version ?? "")) return [`the version ${JSON.stringify(version)} is not x.y.z`]
  const { sections, structure } = parseChangelog(text)
  const problems = [...structure]
  for (const section of sections.filter((s) => s.kind === "other")) {
    problems.push(`"${section.heading}" is not a heading the release shape knows`)
  }
  if (sections.some((s) => s.kind === "unreleased")) {
    problems.push(`an ${UNRELEASED_HEADING} section is still there: run node scripts/changelog.mjs release`)
  }
  const earlier = sections.filter((s) => s.kind === "earlier")
  if (earlier.length > 1) problems.push(`there are ${earlier.length} "${EARLIER_HEADING}" sections; there may be one`)
  if (earlier.length && sections.at(-1) !== earlier.at(-1)) problems.push(`"${EARLIER_HEADING}" must be the last section`)
  const versions = sections.filter((s) => s.kind === "version")
  for (const section of versions.filter((s) => !ISO_DATE.test(s.date ?? ""))) {
    problems.push(`"${section.heading}" is not dated as ## [x.y.z] - YYYY-MM-DD`)
  }
  versions.forEach((section, index) => {
    const next = versions[index + 1]
    if (next && compareVersions(section.version, next.version) <= 0) {
      problems.push(`"${section.heading}" is above "${next.heading}": GitHub releases go newest first, once each`)
    }
  })
  const release = versions.filter((s) => s.version === version)
  if (release.length !== 1) problems.push(`expected one ## [${version}] heading, found ${release.length}`)
  else {
    if (versions[0] !== release[0]) problems.push(`## [${version}] is not the newest release heading`)
    if (!trimBlank(release[0].body).length) problems.push(`the ## [${version}] section has no notes`)
  }
  return problems
}

/** The release notes of `version`: its `## [x.y.z]` section, up to the next `## ` heading (fenced code is not a heading). */
export function releaseNotes(text, version) {
  const lines = text.split("\n")
  const found = scan(lines)
  const structure = structureProblems(lines, found)
  if (structure.length) throw new Error(`CHANGELOG.md: ${structure[0]}`)
  const starts = found.headings
  const start = starts.find((index) => VERSION_HEADING.exec(lines[index])?.[1] === version)
  if (start === undefined) throw new Error(`CHANGELOG.md has no "## [${version}]" heading`)
  const next = starts.find((index) => index > start)
  return trimBlank(lines.slice(start, next ?? lines.length)).join("\n")
}

function main(argv) {
  const [command, ...rest] = argv
  const version = JSON.parse(readFileSync("package.json", "utf8")).version
  const text = readFileSync("CHANGELOG.md", "utf8")
  if (command === "release") {
    const at = rest.indexOf("--date")
    if (rest.length !== (at >= 0 ? 2 : 0)) throw new Error("usage: changelog.mjs release [--date YYYY-MM-DD]")
    const date = at >= 0 ? rest[at + 1] : new Date().toISOString().slice(0, 10)
    const shaped = shapeChangelog(text, { version, date })
    const problems = changelogProblems(shaped, version)
    if (problems.length) throw new Error(`CHANGELOG.md would still not be in the release shape: ${problems.join("; ")}`)
    if (shaped === text) console.log(`changelog: CHANGELOG.md already releases ${version}; nothing changed`)
    else {
      writeFileSync("CHANGELOG.md", shaped)
      console.log(`changelog: ${UNRELEASED_HEADING} is now ## [${version}] - ${date}`)
    }
  } else if (command === "check" && rest.length === 0) {
    const problems = changelogProblems(text, version)
    if (problems.length) throw new Error(`CHANGELOG.md is not in the release shape for ${version}: ${problems.join("; ")}`)
    console.log(`changelog: CHANGELOG.md is in the release shape for ${version}`)
  } else throw new Error("usage: changelog.mjs release [--date YYYY-MM-DD] | changelog.mjs check")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`changelog: ${error.message}`)
    process.exit(1)
  }
}
