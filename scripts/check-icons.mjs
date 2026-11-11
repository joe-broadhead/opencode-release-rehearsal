#!/usr/bin/env node
// check-icons.mjs -- the icon contract for the @joe-broadhead OpenCode plugins.
//
// Contract: CONTRACT.md revision 1 (2026-11-06), in the family's icon kit
//   (the family's shared icon set). Copy this file verbatim into a plugin as
//   scripts/check-icons.mjs; do not edit the copy. check-icons-copy.mjs in the
//   kit verifies a copy is byte-identical.
//
// The sanitizer below is Jelly's, copied from
//   protocol/contracts/src/plugin-icon.ts  (function cleanPluginIcon, lines
//   22-160, and the ELEMENTS / ATTRIBUTES sets and the TAG, ATTRIBUTE, LABEL
//   and safeValue helpers it depends on), with the conformance vectors of
//   protocol/contracts/src/plugin-icon.test.ts (lines 12-68).
// Source: jelly's plugin contract (protocol/contracts), branch origin/master,
//   read 2026-11-06. That is the single definition of a
//   clean plugin icon: the one Jelly keeps at review, at install and at
//   render. This copy is byte-identical except for the TypeScript annotations,
//   which plain JavaScript cannot carry.
//
// Shared block SHA-256: 34f125900257d27f159ffb514a6ddfff9627b4547d0743572be8433598fe22a1
//   The block is everything between the two "SHARED" markers below. It is
//   checked against this constant on every run, so a hand-edited copy fails
//   before it can pass a bad icon.
//
// Usage:
//   node scripts/check-icons.mjs            check the plugin in the current directory
//   node scripts/check-icons.mjs <dir>      check another directory
//   node scripts/check-icons.mjs --print    print this file's hash, to stamp elsewhere
//
// Exit: 0 when every rule holds, 1 with one line per problem.

import { readFileSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

const CONTRACT_REVISION = 1
const SELF = fileURLToPath(import.meta.url)

// >>> SHARED: plugin-icon.ts + plugin-icon.test.ts >>>

/** The largest icon kept, in characters: a mark, not an illustration. */
const PLUGIN_ICON_MAX_LENGTH = 16_384

const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
])

const ATTRIBUTES = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "d",
  "points",
  "fill",
  "fill-rule",
  "fill-opacity",
  "clip-rule",
  "clip-path",
  "mask",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "transform",
  "id",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "maskUnits",
  "clipPathUnits",
  "vector-effect",
])

const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][A-Za-z0-9:-]*\s*=\s*"[^"<>]*")*)\s*(\/?)>/gu
const ATTRIBUTE = /([A-Za-z][A-Za-z0-9:-]*)\s*=\s*"([^"]*)"/gu
/** A `<title>` or `<desc>` holding text only: no markup, no CDATA, so nothing else goes with it. */
const LABEL = /<(title|desc)(?:\s+[A-Za-z][A-Za-z0-9:-]*\s*=\s*"[^"<>]*")*\s*(?:\/>|>[^<]*<\/\1\s*>)/gu

/** A value an attribute may hold: no markup, no entity, and a `url()` only to an id inside. */
function safeValue(value) {
  if (/[<>&\\]/u.test(value)) return false
  if (/(?:java|vb)script:|data:|expression\s*\(/iu.test(value)) return false
  const references = value.match(/url\s*\([^)]*\)/giu) ?? []
  return references.every((reference) => /^url\(#[A-Za-z][A-Za-z0-9_-]*\)$/u.test(reference))
}

/**
 * The icon as the host keeps it, or null when it is not one.
 *
 * The XML declaration, comments, and each `<title>` and `<desc>` are taken
 * out; anything else outside the allowed drawing vocabulary refuses the whole
 * file: a doctype, an entity, text, a style, a link, an event handler, a
 * foreign element. What is kept is checked whole after that, so taking an
 * element out can never make something unclean pass.
 */
function cleanPluginIcon(text) {
  if (text.length > PLUGIN_ICON_MAX_LENGTH) return null
  const body = text
    .replace(/^\ufeff/u, "")
    .replace(/^\s*<\?xml[^>]*\?>/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(LABEL, "")
    .trim()
  if (body === "" || /<!|<\?|&/u.test(body)) return null
  const open = []
  let last = 0
  let root = false
  for (const match of body.matchAll(TAG)) {
    if (body.slice(last, match.index).trim() !== "") return null
    last = match.index + match[0].length
    const [, closing, name = "", attributes = "", selfClosing] = match
    if (!ELEMENTS.has(name)) return null
    if (closing === "/") {
      if (attributes !== "" || open.pop() !== name) return null
      continue
    }
    if (open.length === 0) {
      // One root, and it is the drawing.
      if (root || name !== "svg") return null
      root = true
    }
    const seen = new Set()
    for (const [, key = "", value = ""] of attributes.matchAll(ATTRIBUTE)) {
      if (!ATTRIBUTES.has(key) || seen.has(key) || !safeValue(value)) return null
      if (key === "xmlns" && value !== SVG_NAMESPACE) return null
      seen.add(key)
    }
    if (name === "svg" && open.length === 0 && (!seen.has("viewBox") || !seen.has("xmlns")))
      return null
    if (selfClosing !== "/") open.push(name)
  }
  if (body.slice(last).trim() !== "" || open.length !== 0 || !root) return null
  return body
}

/**
 * The conformance vectors of plugin-icon.test.ts, as a self-test: a copy that
 * has drifted from Jelly's semantics fails here rather than quietly
 * accepting an icon Jelly would drop.
 */
function sanitizerProblems() {
  const problems = []
  const svg = (inner, attributes = 'viewBox="0 0 24 24"') =>
    `<svg xmlns="${SVG_NAMESPACE}" ${attributes}>${inner}</svg>`

  const kept = svg(
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#g)"/><path d="M4 4h16" stroke="#000" stroke-linecap="round"/>',
  )
  if (cleanPluginIcon(kept) !== kept) problems.push('a clean drawing is not "kept as it is"')
  if (cleanPluginIcon(`<?xml version="1.0"?>\n<!-- a mark -->\n${kept}\n`) !== kept)
    problems.push('an XML declaration and a comment are not "taken out"')

  const drawing = '<rect width="24" height="24" rx="6" fill="#123"/><path d="M4 4h16"/>'
  const mark = svg(drawing)
  if (cleanPluginIcon(svg(`<title>Plaud &amp; notes</title>${drawing}`)) !== mark)
    problems.push('a title is not "taken out with its text"')
  if (cleanPluginIcon(svg(`<g><title>Inner</title>${drawing}</g>`)) !== svg(`<g>${drawing}</g>`))
    problems.push("a nested <title> is not taken out")
  for (const unclean of [
    svg(`<title><script>alert(1)</script></title>${drawing}`),
    svg(`<title><![CDATA[x]]></title>${drawing}`),
    svg(`<title>x${drawing}`),
    svg(`<title><title>x</title></title>${drawing}`),
  ]) {
    if (cleanPluginIcon(unclean) !== null) problems.push("a title holding markup does not refuse the file")
  }

  const refused = [
    ["a script", svg("<script>alert(1)</script>")],
    ["an onload attribute", svg('<rect width="1" height="1"/>', 'viewBox="0 0 1 1" onload="alert(1)"')],
    ["an image href", svg('<image href="https://example.com/x.png"/>')],
    ["a use href", svg('<use href="#a"/>')],
    ["an external url()", svg('<rect fill="url(https://example.com/#a)"/>')],
    ["a javascript: value", svg('<rect fill="javascript:alert(1)"/>')],
    ["a style attribute", svg('<rect style="fill:red"/>')],
    ["a class attribute", svg('<rect class="x"/>')],
    ["a foreignObject", svg("<foreignObject><div/></foreignObject>")],
    ["a text element", svg("<text>hi</text>")],
    ["an entity in a value", svg('<rect fill="&amp;"/>')],
    ["a doctype", `<!DOCTYPE svg [<!ENTITY x "y">]>${svg("")}`],
    ["an unclosed group", svg("<g>")],
    ["two roots", `${svg("")}${svg("")}`],
    ["no xmlns", '<svg viewBox="0 0 1 1"/>'],
    ["no viewBox", `<svg xmlns="${SVG_NAMESPACE}"/>`],
    ["a root that is not svg", "<g/>"],
    ["an empty string", ""],
    ["an oversize file", svg(`<path d="${"M0 0".repeat(PLUGIN_ICON_MAX_LENGTH / 4)}"/>`)],
  ]
  for (const [what, unclean] of refused) {
    if (cleanPluginIcon(unclean) !== null) problems.push(`${what} does not refuse the file`)
  }
  return problems
}

// <<< SHARED: plugin-icon.ts + plugin-icon.test.ts <<<

// --- the contract, revision 1 ----------------------------------------------

const CANVAS = 48
const RADIUS = 11
const SVG_CAP = 4096
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"])
const PNG_CAP = { 128: 24 * 1024, 256: 64 * 1024 }

const ICON_PATH = "assets/icon.svg"

const EXPECTED_ICONS = [
  { src: "assets/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
  { src: "assets/icon-128.png", mimeType: "image/png", sizes: ["128x128"] },
  { src: "assets/icon-256.png", mimeType: "image/png", sizes: ["256x256"] },
]

const ASSET_EXPORTS = [
  ["./icon.svg", "assets/icon.svg"],
  ["./icon-128.png", "assets/icon-128.png"],
  ["./icon-256.png", "assets/icon-256.png"],
]

/** Our own products: no vendor's service is behind them, so no vendor is declared. */
const OWN_PACKAGES = new Set([
  "@joe-broadhead/opencode-utilities",
  "@joe-broadhead/opencode-history",
  "@joe-broadhead/opencode-jobs",
  "@joe-broadhead/opencode-charts",
  "@joe-broadhead/opencode-mem",
  "@joe-broadhead/opencode-voice",
])

const ICON_PATH_SHAPE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+\.(?:svg|png)$/u
const VENDOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u

// --- helpers ---------------------------------------------------------------

const problems = []
const bad = (message) => problems.push(message)
const sha256 = (data) => createHash("sha256").update(data).digest("hex")

function sharedBlock(text) {
  const begin = "// >>> SHARED: plugin-icon.ts + plugin-icon.test.ts >>>"
  const end = "// <<< SHARED: plugin-icon.ts + plugin-icon.test.ts <<<"
  const at = text.indexOf(begin)
  const to = text.indexOf(end)
  if (at === -1 || to === -1 || to < at) return null
  return text.slice(at + begin.length, to)
}

/** Why cleanPluginIcon refuses this file, in one phrase. */
function diagnoseIcon(text) {
  if (text.length > PLUGIN_ICON_MAX_LENGTH)
    return `${text.length} characters, over the ${PLUGIN_ICON_MAX_LENGTH} Jelly allows`
  const body = text
    .replace(/^\ufeff/u, "")
    .replace(/^\s*<\?xml[^>]*\?>/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(LABEL, "")
    .trim()
  if (body === "") return "the file is empty"
  const markup = /<!|<\?|&/u.exec(body)
  if (markup) return `it carries "${markup[0]}" outside a drawing element (a doctype, an entity or an unescaped &)`

  const open = []
  let last = 0
  let root = false
  for (const match of body.matchAll(TAG)) {
    const outside = body.slice(last, match.index).trim()
    if (outside !== "") return `it has text outside a tag: "${outside.slice(0, 40)}"`
    last = match.index + match[0].length
    const [, closing, name = "", attributes = "", selfClosing] = match
    if (!ELEMENTS.has(name)) return `<${name}> is not one of the ${ELEMENTS.size} allowed elements`
    if (closing === "/") {
      if (attributes !== "") return `the closing </${name}> carries attributes`
      if (open.pop() !== name) return `</${name}> does not close the open element`
      continue
    }
    if (open.length === 0) {
      if (root) return "it has more than one root element"
      if (name !== "svg") return `the root is <${name}>, not <svg>`
      root = true
    }
    const seen = new Set()
    for (const [, key = "", value = ""] of attributes.matchAll(ATTRIBUTE)) {
      if (!ATTRIBUTES.has(key)) return `"${key}" on <${name}> is not one of the ${ATTRIBUTES.size} allowed attributes`
      if (seen.has(key)) return `"${key}" appears twice on <${name}>`
      if (!safeValue(value)) return `the value of "${key}" on <${name}> is not allowed: "${value.slice(0, 60)}"`
      if (key === "xmlns" && value !== SVG_NAMESPACE) return `xmlns is "${value.slice(0, 60)}"`
      seen.add(key)
    }
    if (name === "svg" && open.length === 0 && !seen.has("viewBox")) return "the root has no viewBox"
    if (name === "svg" && open.length === 0 && !seen.has("xmlns")) return "the root has no xmlns"
    if (selfClosing !== "/") open.push(name)
  }
  const tail = body.slice(last).trim()
  if (tail !== "") return `it has text after the last tag: "${tail.slice(0, 40)}"`
  if (open.length !== 0) return `<${open[open.length - 1]}> is never closed`
  if (!root) return "it has no <svg> root"
  return null
}

function covers(files, target) {
  return files.some((entry) =>
    entry === target ? true : entry.startsWith("!") ? false : target.startsWith(`${entry}/`),
  )
}

function pngChunks(buffer) {
  const chunks = []
  let at = 8
  while (at + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString("latin1", at + 4, at + 8)
    chunks.push({ type, length, bytes: buffer.subarray(at, at + 12 + length) })
    at += 12 + length
  }
  return chunks
}

// --- 0. this file is the contract ------------------------------------------

const selfText = readFileSync(SELF, "utf8")
const block = sharedBlock(selfText)
const printedHash = sha256(block ?? "")

if (process.argv.includes("--print")) {
  console.log(`contract revision ${CONTRACT_REVISION}`)
  console.log(`shared block  sha256 ${printedHash}`)
  console.log(`this file     sha256 ${sha256(selfText)}`)
  process.exit(0)
}

const pinned = selfText.match(/^\/\/ Shared block SHA-256: ([0-9a-f]{64})$/mu)?.[1]
if (block === null) bad("check-icons.mjs: the SHARED markers are missing, so the sanitizer cannot be verified.")
else if (pinned !== printedHash)
  bad(
    `check-icons.mjs: the shared sanitizer block is not the one the contract pins (got ${printedHash.slice(0, 12)}…, ` +
      `the header says ${pinned ? `${pinned.slice(0, 12)}…` : "nothing"}). Copy the kit's file instead of editing it.`,
  )
if (block !== null) for (const problem of sanitizerProblems()) bad(`check-icons.mjs: the sanitizer self-test fails: ${problem}.`)

// --- 1. the manifest -------------------------------------------------------

const argDir = process.argv.slice(2).find((a) => !a.startsWith("--"))
const root = argDir ? path.resolve(argDir) : process.cwd()
const manifestPath = path.join(root, "package.json")

let manifest = null
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
} catch (error) {
  bad(`package.json: cannot be read as JSON (${error.message}).`)
}

if (manifest) {
  const { jelly, opencode } = manifest
  const icons = opencode?.icons

  // jelly.icon, unchanged.
  if (!jelly || typeof jelly !== "object") bad('package.json: "jelly" is missing; it declares the mark Jelly draws.')
  else if (jelly.icon === undefined) bad(`package.json: "jelly.icon" is missing; it must be "${ICON_PATH}".`)
  else if (jelly.icon !== ICON_PATH) bad(`package.json: "jelly.icon" is "${jelly.icon}"; it must be "${ICON_PATH}".`)

  if (!opencode || typeof opencode !== "object")
    bad('package.json: "opencode" is missing; it carries "opencode.icons" and, for a vendor\'s service, "opencode.vendor".')

  // opencode.icons: exactly MCP's three entries, in this order.
  if (!Array.isArray(icons)) {
    bad(
      'opencode.icons: missing; it must be an array of the three entries ' +
        `${EXPECTED_ICONS.map((e) => e.src).join(", ")}.`,
    )
  } else {
    if (icons.length !== EXPECTED_ICONS.length)
      bad(`opencode.icons: it has ${icons.length} entries; the contract declares exactly ${EXPECTED_ICONS.length}.`)
    EXPECTED_ICONS.forEach((want, index) => {
      const got = icons[index]
      if (!got || typeof got !== "object") {
        bad(`opencode.icons[${index}]: missing; expected ${JSON.stringify(want)}.`)
        return
      }
      for (const key of Object.keys(got)) {
        if (!["src", "mimeType", "sizes", "theme"].includes(key))
          bad(`opencode.icons[${index}]: "${key}" is not an MCP Icon field.`)
      }
      if (got.src !== want.src)
        bad(`opencode.icons[${index}].src: "${got.src}"; it must be "${want.src}".`)
      if (got.mimeType !== want.mimeType)
        bad(`opencode.icons[${index}].mimeType: "${got.mimeType}"; it must be "${want.mimeType}".`)
      const sizes = Array.isArray(got.sizes) ? got.sizes.map(String) : null
      if (!sizes || sizes.join(",") !== want.sizes.join(","))
        bad(`opencode.icons[${index}].sizes: ${JSON.stringify(got.sizes)}; it must be ${JSON.stringify(want.sizes)}.`)
      if (got.theme !== undefined && !["light", "dark"].includes(got.theme))
        bad(`opencode.icons[${index}].theme: "${got.theme}"; it must be "light" or "dark".`)
    })
    if (icons[0] && jelly && icons[0].src !== jelly.icon)
      bad(`opencode.icons[0].src is "${icons[0].src}" but jelly.icon is "${jelly.icon}"; they must be the same file.`)
    for (const [index, entry] of icons.entries()) {
      if (entry && typeof entry.src === "string" && !ICON_PATH_SHAPE.test(entry.src))
        bad(`opencode.icons[${index}].src: "${entry.src}" is not an in-package relative .svg or .png path.`)
    }
  }

  // files: every declared src is in the tarball.
  const files = Array.isArray(manifest.files) ? manifest.files.map(String) : []
  const srcs = Array.isArray(icons)
    ? icons.map((i) => i?.src).filter((s) => typeof s === "string")
    : []
  for (const src of srcs) {
    if (!covers(files, src)) bad(`"files": "${src}" is not shipped, so the icon is in the repository but not the tarball.`)
  }

  // exports: the three asset keys, at exactly their paths.
  const exportsMap = manifest.exports ?? {}
  for (const [key, target] of ASSET_EXPORTS) {
    const value = exportsMap?.[key]
    if (value === undefined) bad(`"exports": "${key}" is missing; it must map to "./${target}".`)
    else if (typeof value === "string" && value !== `./${target}`)
      bad(`"exports": "${key}" maps to "${value}"; it must map to "./${target}".`)
    else if (typeof value === "object" && value !== null && value.default !== `./${target}`)
      bad(`"exports": "${key}" does not resolve to "./${target}".`)
  }

  // opencode.vendor: only for a vendor's service, and then a bare domain.
  if (opencode && "vendor" in opencode) {
    const vendor = opencode.vendor
    if (OWN_PACKAGES.has(manifest.name))
      bad(`opencode.vendor: ${manifest.name} is our own product, so it must not declare a vendor.`)
    if (!vendor || typeof vendor !== "object") {
      bad('opencode.vendor: it must be an object, such as { "id": "notion", "name": "Notion", "domain": "notion.so" }.')
    } else {
      for (const key of Object.keys(vendor)) {
        if (!["id", "name", "domain"].includes(key)) bad(`opencode.vendor: "${key}" is not part of the declaration.`)
      }
      if (typeof vendor.id !== "string" || !VENDOR_ID.test(vendor.id))
        bad(`opencode.vendor.id: ${JSON.stringify(vendor.id)}; it must be lowercase, such as "notion".`)
      if (typeof vendor.name !== "string" || vendor.name.trim() === "")
        bad("opencode.vendor.name: it must be the vendor's display name.")
      if (typeof vendor.domain !== "string" || !DOMAIN.test(vendor.domain))
        bad(
          `opencode.vendor.domain: ${JSON.stringify(vendor.domain)}; it must be a bare domain such as "notion.so", ` +
            "with no scheme, no path and no trailing dot.",
        )
    }
  } else if (manifest.name && !OWN_PACKAGES.has(manifest.name)) {
    bad(
      'opencode.vendor: missing; this package is over a vendor\'s service, so it declares ' +
        '{ "id", "name", "domain" } with the vendor\'s main product domain. Only our own products ' +
        "(Utilities, History, Jobs, Charts, Memory, Voice) leave it out.",
    )
  }
}

// --- 2. the SVG ------------------------------------------------------------

const svgPath = path.join(root, ICON_PATH)
let svgText = null
try {
  const stat = statSync(svgPath)
  if (!stat.isFile()) bad(`${ICON_PATH}: not a regular file.`)
  else svgText = readFileSync(svgPath, "utf8")
} catch {
  bad(`${ICON_PATH}: missing.`)
}

if (svgText !== null) {
  const bytes = Buffer.byteLength(svgText, "utf8")
  if (bytes > SVG_CAP) bad(`${ICON_PATH}: ${bytes} bytes; the family cap is ${SVG_CAP} (Jelly's own cap is ${PLUGIN_ICON_MAX_LENGTH}).`)

  const cleaned = cleanPluginIcon(svgText)
  if (cleaned === null) {
    bad(
      `${ICON_PATH}: Jelly's cleanPluginIcon refuses the whole file — ${diagnoseIcon(svgText) ?? "no single cause could be named"}. ` +
        "Jelly would draw a monogram instead of this mark.",
    )
  } else if (cleaned !== svgText) {
    const why =
      cleaned === svgText.trim()
        ? "surrounding whitespace"
        : /<title|<desc/iu.test(svgText)
          ? "a <title> or <desc>"
          : /<\?xml|<!--/u.test(svgText)
            ? "an XML declaration or a comment"
            : "something cleanPluginIcon takes out"
    bad(
      `${ICON_PATH}: the file is not what cleanPluginIcon keeps, because of ${why}. ` +
        "Ship the file exactly as the cleaner returns it, with no trailing newline.",
    )
  }

  const doc = svgText
  if (/currentColor/u.test(doc))
    bad(`${ICON_PATH}: it uses currentColor, which resolves to black in the <img> Jelly draws it in. Use the palette's ink.`)

  const viewBox = /<svg[^>]*\sviewBox="([^"]*)"/u.exec(doc)?.[1]
  if (viewBox === undefined) bad(`${ICON_PATH}: the root has no viewBox.`)
  else {
    const parts = viewBox.trim().split(/[\s,]+/u).map(Number)
    const square = parts.length === 4 && parts[2] === parts[3]
    if (!square) bad(`${ICON_PATH}: viewBox "${viewBox}" is not square; the family canvas is square.`)
    else if (parts[2] !== CANVAS) bad(`${ICON_PATH}: viewBox is "${viewBox}"; the family canvas is "0 0 ${CANVAS} ${CANVAS}".`)
  }

  // The tile: one opaque rect covering the canvas, at the family corner radius.
  const body = (cleanPluginIcon(doc) ?? doc).replace(/^<svg\b[^>]*>/u, "")
  const tile = /^<rect\s([^>]*?)\/?>/u.exec(body)
  if (!tile) bad(`${ICON_PATH}: the first element must be the tile <rect>.`)
  else {
    const attr = (name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "u").exec(tile[1])?.[1]
    if (attr("width") !== String(CANVAS) || attr("height") !== String(CANVAS))
      bad(`${ICON_PATH}: the tile is ${attr("width")}x${attr("height")}; it must cover the ${CANVAS}x${CANVAS} canvas.`)
    if (attr("rx") !== String(RADIUS))
      bad(`${ICON_PATH}: the tile's rx is "${attr("rx")}"; the family corner radius is ${RADIUS} on ${CANVAS}.`)
    if (!/^#[0-9A-Fa-f]{6}$/u.test(attr("fill") ?? ""))
      bad(`${ICON_PATH}: the tile's fill is "${attr("fill")}"; it must be an opaque #RRGGBB from the family palette.`)
  }

  // Art stays inside the canvas: no absolute number beyond it, allowing relative offsets.
  const numbers = [...(cleanPluginIcon(doc) ?? doc).matchAll(/(?:^|\s)(?:d|points)="([^"]*)"/gu)]
    .flatMap((m) => m[1].match(/-?\d*\.?\d+(?:e-?\d+)?/gu) ?? [])
    .map(Number)
  const outside = numbers.find((n) => Math.abs(n) > CANVAS * 4)
  if (outside !== undefined) bad(`${ICON_PATH}: a path coordinate ${outside} is far outside the ${CANVAS}x${CANVAS} canvas.`)
}

// --- 3. the rasters --------------------------------------------------------

function checkPng(src, size) {
  const file = path.join(root, src)
  let buffer
  try {
    if (!statSync(file).isFile()) {
      bad(`${src}: not a regular file.`)
      return
    }
    buffer = readFileSync(file)
  } catch {
    bad(`${src}: missing.`)
    return
  }

  if (buffer.length < 8 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    bad(`${src}: not a PNG (the signature is ${buffer.subarray(0, 8).toString("hex")}).`)
    return
  }
  if (buffer.length > PNG_CAP[size]) bad(`${src}: ${buffer.length} bytes; the cap is ${PNG_CAP[size]}.`)

  const chunks = pngChunks(buffer)
  const ihdr = chunks[0]
  if (!ihdr || ihdr.type !== "IHDR" || ihdr.length !== 13) {
    bad(`${src}: the first chunk is not a 13-byte IHDR.`)
    return
  }
  const width = ihdr.bytes.readUInt32BE(8)
  const height = ihdr.bytes.readUInt32BE(12)
  if (width !== size || height !== size) bad(`${src}: IHDR is ${width}x${height}; it must be exactly ${size}x${size}.`)
  const depth = ihdr.bytes.readUInt8(16)
  const colour = ihdr.bytes.readUInt8(17)
  if (depth !== 8 || ![2, 6].includes(colour))
    bad(`${src}: IHDR is bit depth ${depth}, colour type ${colour}; it must be 8-bit truecolour, with or without alpha.`)

  for (const chunk of chunks) {
    if (!PNG_KEEP.has(chunk.type))
      bad(`${src}: it carries a "${chunk.type}" chunk; PNG metadata must be empty.`)
  }
  if (chunks[chunks.length - 1]?.type !== "IEND") bad(`${src}: it does not end with IEND.`)
}

checkPng("assets/icon-128.png", 128)
checkPng("assets/icon-256.png", 256)

// --- report ----------------------------------------------------------------

if (problems.length > 0) {
  console.error(`${root}: ${problems.length} problem${problems.length === 1 ? "" : "s"} against the icon contract, revision ${CONTRACT_REVISION}.`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `${root}: icons conform to the contract, revision ${CONTRACT_REVISION} — ` +
    `${ICON_PATH} clean at ${Buffer.byteLength(svgText, "utf8")} bytes, 128 and 256 PNGs, exports and files agree.`,
)
