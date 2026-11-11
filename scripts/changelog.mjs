// The CHANGELOG at v0.0.0 (GH-RELEASE-BRIEF, "CHANGELOG shape at v0.0.0"): one release heading, `## [0.0.0] - <date>`; the
// npm history under `## Earlier releases on npm` as `### npm <version> - <date>`; and the release notes, read from the
// release heading. apply-release-kit.mjs shapes a repo's CHANGELOG with this, and check-release-shape.mjs reads the notes.
// It works on text only and has no dependencies.

export const VERSION = "0.0.0"
export const EARLIER_HEADING = "## Earlier releases on npm"
export const EARLIER_PREFACE =
  "These versions were published to npm before the plugin moved to GitHub releases. Their Git tags have been removed."
// Written under the release heading, so a later run finds the release even when no npm history sits below it.
export const MARKER = "<!-- kit-release: the GitHub release v0.0.0 -->"

const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\](?: - (.+))?$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const FENCE = /^(```|~~~)/

/** Indexes of the `## ` heading lines, skipping fenced code. */
function headingIndexes(lines) {
  const found = []
  let fenced = false
  lines.forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced
    else if (!fenced && line.startsWith("## ")) found.push(index)
  })
  return found
}

function trimBlank(lines) {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === "") start++
  while (end > start && lines[end - 1].trim() === "") end--
  return lines.slice(start, end)
}

/** Blocks of lines, one blank line between the non-empty ones. */
function joinBlocks(blocks) {
  return blocks
    .filter((block) => block.length > 0)
    .reduce((out, block) => (out.length ? [...out, "", ...block] : [...block]), [])
}

/** `### ` and deeper headings move down one level, outside code fences. */
function demote(lines) {
  let fenced = false
  return lines.map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced
      return line
    }
    return !fenced && /^#{3,5} /.test(line) ? `#${line}` : line
  })
}

function classify(heading, body) {
  if (heading === "## [Unreleased]") return { kind: "unreleased", heading, body }
  if (heading === EARLIER_HEADING) return { kind: "earlier", heading, body }
  const match = VERSION_HEADING.exec(heading)
  if (match) return { kind: "version", heading, version: match[1], date: match[2] ?? null, body }
  return { kind: "other", heading, body }
}

/** The body of a section: no marker line, and no blank lines at either end. */
function bodyOf(section) {
  return trimBlank(section.body.filter((line) => line !== MARKER))
}

/** The lines before the first `## ` heading, and one section per `## ` heading. */
export function parseChangelog(text) {
  const lines = text.split("\n")
  const starts = headingIndexes(lines)
  const preamble = lines.slice(0, starts.length ? starts[0] : lines.length)
  const sections = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length
    return classify(lines[start], lines.slice(start + 1, end))
  })
  return { preamble, sections }
}

/**
 * The release heading. An earlier run's marker names it. Otherwise, with the npm history already under the Earlier section,
 * it is the first version heading when that is 0.0.0. Otherwise it is a 0.0.0 first in the file that is unpublished (no
 * date, or Unreleased) or dated the release date. A 0.0.0 dated on an earlier day is published history: never re-dated.
 */
function findRelease(sections, date, today) {
  const versions = sections.filter((s) => s.kind === "version")
  const marked = versions.find((s) => trimBlank(s.body)[0] === MARKER)
  if (marked) return marked
  const first = versions[0]
  if (!first || first.version !== VERSION) return undefined
  if (sections.some((s) => s.kind === "earlier")) return first
  const unpublished = first.date === null || first.date === "Unreleased"
  return unpublished || first.date === (date ?? today) ? first : undefined
}

/**
 * The CHANGELOG in shape. `date` is an explicit release date (it re-dates the unpublished release only); without it the
 * release keeps its date, or takes `today`. Throws on a heading it does not know, so the caller writes nothing.
 * Shaping a shaped CHANGELOG changes nothing.
 */
export function shapeChangelog(text, { date, today }) {
  const { preamble, sections } = parseChangelog(text)
  const unknown = sections.find((s) => s.kind === "other")
  if (unknown) throw new Error(`"${unknown.heading}" is not a heading the release shape knows: edit CHANGELOG.md by hand`)
  const earlier = sections.filter((s) => s.kind === "earlier")
  if (earlier.length > 1) throw new Error("CHANGELOG.md has more than one Earlier releases section")
  const versions = sections.filter((s) => s.kind === "version")
  const release = findRelease(sections, date, today)
  for (const version of versions) {
    if (version !== release && (!version.date || version.date === "Unreleased")) {
      throw new Error(`"${version.heading}" has no release date, so it cannot be moved as published history: edit CHANGELOG.md by hand`)
    }
  }
  const releaseDate = date ?? (release && release.date && ISO_DATE.test(release.date) ? release.date : today)
  const folded = sections.filter((s) => s.kind === "unreleased").map((s) => trimBlank(s.body))
  const releaseBody = joinBlocks([...folded, release ? bodyOf(release) : []])
  const history = versions
    .filter((s) => s !== release)
    .map((s) => {
      const body = bodyOf(s)
      return [`### npm ${s.version} - ${s.date}`, ...(body.length ? ["", ...demote(body)] : [])]
    })
  const existing = earlier.length ? bodyOf(earlier[0]) : []
  const keptEntries = existing[0] === EARLIER_PREFACE ? trimBlank(existing.slice(1)) : existing
  const blocks = []
  const head = trimBlank(preamble)
  if (head.length) blocks.push(head)
  blocks.push([`## [${VERSION}] - ${releaseDate}`, MARKER, ...(releaseBody.length ? ["", ...releaseBody] : [])])
  if (history.length || keptEntries.length) {
    blocks.push([EARLIER_HEADING, "", ...joinBlocks([[EARLIER_PREFACE], joinBlocks(history), keptEntries])])
  }
  return blocks.map((block) => block.join("\n")).join("\n\n") + "\n"
}

/** What the release would refuse about a CHANGELOG (empty means it is in shape). */
export function changelogProblems(text) {
  const { sections } = parseChangelog(text)
  const problems = []
  for (const section of sections.filter((s) => s.kind === "other")) {
    problems.push(`"${section.heading}" is not a heading the release shape knows`)
  }
  if (sections.some((s) => s.kind === "unreleased")) problems.push("an ## [Unreleased] section is still there")
  const versions = sections.filter((s) => s.kind === "version")
  const release = versions.filter((s) => s.version === VERSION)
  if (release.length !== 1) problems.push(`expected one ## [${VERSION}] heading, found ${release.length}`)
  if (versions.length !== release.length) {
    problems.push(`${versions.length - release.length} other ## [x.y.z] heading(s): they belong under "${EARLIER_HEADING}" as ### npm headings`)
  }
  if (release.length === 1 && bodyOf(release[0]).length === 0) problems.push(`the ## [${VERSION}] section has no notes`)
  return problems
}

/** The release notes: the `## [0.0.0]` section, up to the next `## ` heading (fenced code is not a heading), without the marker. */
export function releaseNotes(text) {
  const lines = text.split("\n")
  const starts = headingIndexes(lines)
  const start = starts.find((index) => /^## \[0\.0\.0\](?: - .*)?$/.test(lines[index]))
  if (start === undefined) throw new Error(`CHANGELOG.md has no "## [${VERSION}]" heading`)
  const next = starts.find((index) => index > start)
  return trimBlank(lines.slice(start, next ?? lines.length).filter((line) => line !== MARKER)).join("\n")
}
