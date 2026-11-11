/**
 * The declaration test kit: the checks every plugin's `test/jelly.test.ts` runs on its `jelly` declaration, so that
 * no plugin restates Jelly's schema, summary rule or icon rule on its own. Shared module: every plugin keeps an
 * identical copy at `test/support/jelly-kit.ts`, and `scripts/check-copies.mjs` fails `npm run check` when this copy
 * differs from the one all the plugins carry. Change it in every plugin at once, and update the hash there.
 *
 * Each function returns the problems it finds, as sentences, so a test asserts `toEqual([])` with any runner. The
 * rules are Jelly's plugin authors' standard (hey-jelly `docs/guides/plugin-authors.md`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"

export type DeclaredTool = { name: string; permission: string; effect: string; readOnly?: boolean; note?: string }
export type DeclaredSignIn = { id: string; label: string; integration?: string; server?: string }
export type Declaration = {
  title?: string
  summary?: string
  icon?: string
  tools?: DeclaredTool[]
  skills?: string[]
  signIns?: DeclaredSignIn[]
  [key: string]: unknown
}
export type Package = { name: string; version: string; files?: string[]; dependencies?: Record<string, string>; jelly?: Declaration }

/** The top-level keys of Jelly's `PluginDeclarationSchema`. Jelly leaves an unknown one out, so a typo goes unseen. */
export const DECLARATION_KEYS = [
  "title",
  "summary",
  "icon",
  "tools",
  "skills",
  "rpc",
  "views",
  "signIns",
  "contributes",
  "resources",
  "asks",
  "requires",
] as const

/** The drawing elements Jelly's icon cleaner keeps (hey-jelly `plugin-icon.ts`); it drops an icon with any other. */
const ICON_ELEMENTS = new Set([
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "title", "desc",
])

/** Words that state a policy. A summary says what the plugin reaches; what asks first is on the plugin's card. */
const POLICY = /\b(ask|asks|asking|approval|approve|read-only|unless|allowed?)\b/i

export function readPackage(root: URL): Package {
  return JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as Package
}

export type DeclarationOptions = {
  /** The effect the plugin's own default rules give a permission after a base "allow everything" rule. */
  effectOf: (permission: string) => string | undefined
  /** Every tool permission the plugin registers or brings. Each must be declared, and nothing else. */
  registered?: readonly string[]
  /**
   * The permissions name risk actions (`gws.write`), because one tool spans several risk categories. Then a tool's
   * `permission` equals its `name`. Otherwise the permission is the engine's tool name, `<ns>_<tool>`.
   */
  actionPermissions?: boolean
}

/** The engine's permission for a declared tool name: `plaud-*.get_file` is `plaud_get_file`. */
export function permissionOf(name: string): string {
  return name.replace(/-?\*/u, "").replaceAll(".", "_")
}

/** A "last matching rule wins" lookup over the plugin's default rules, after a base allow. */
export function effectFromRules(
  rules: readonly { permission?: string; action?: string; pattern?: string; resource?: string; effect: string }[],
): (permission: string) => string | undefined {
  const wildcard = (pattern: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "u")
  const all = [{ permission: "*", pattern: "*", effect: "allow" }, ...rules]
  return (permission) =>
    [...all]
      .reverse()
      .find((rule) => wildcard(rule.permission ?? rule.action ?? "").test(permission) && (rule.pattern ?? rule.resource ?? "*") === "*")
      ?.effect
}

/** The declaration: its keys, title, summary, icon, skills, tool names, effects and sign-in labels. */
export function declarationProblems(root: URL, options: DeclarationOptions): string[] {
  const problems: string[] = []
  const pkg = readPackage(root)
  const jelly = pkg.jelly
  if (!jelly) return ["package.json has no jelly declaration"]
  if (!/^@joe-broadhead\/opencode-[a-z0-9-]+$/u.test(pkg.name)) problems.push(`the package is named ${pkg.name}, not @joe-broadhead/opencode-<name>`)
  if (Object.keys(pkg.dependencies ?? {}).length > 0) problems.push("the package has runtime dependencies, so its tarball does not stand alone")

  for (const key of Object.keys(jelly)) {
    if (!(DECLARATION_KEYS as readonly string[]).includes(key)) problems.push(`jelly.${key} is not a key Jelly knows`)
  }
  if (!jelly.title?.trim() || jelly.title.length > 60) problems.push("jelly.title must be 1 to 60 characters")
  problems.push(...summaryProblems(jelly.summary))
  problems.push(...iconProblems(root, pkg))

  const shipped = existsSync(new URL("skills", root)) ? readdirSync(new URL("skills", root)).sort() : []
  const declaredSkills = [...(jelly.skills ?? [])].sort()
  if (JSON.stringify(declaredSkills) !== JSON.stringify(shipped)) problems.push(`jelly.skills ${JSON.stringify(declaredSkills)} are not the skills shipped ${JSON.stringify(shipped)}`)
  if (shipped.length > 0 && !pkg.files?.some((file) => file.replace(/\/$/u, "") === "skills")) problems.push("package.json files does not ship skills/")

  const tools = jelly.tools ?? []
  if (tools.length === 0) problems.push("jelly.tools is empty")
  const names = tools.map((tool) => tool.name)
  if (new Set(names).size !== names.length) problems.push("a tool is declared twice")
  for (const tool of tools) {
    const permission = options.actionPermissions ? tool.name : permissionOf(tool.name)
    if (tool.permission !== permission) problems.push(`${tool.name} asks ${tool.permission}, not ${permission}`)
    const effect = options.effectOf(tool.permission)
    if (effect !== tool.effect) problems.push(`${tool.name} is declared ${tool.effect}, but the plugin's own rules give it ${effect}`)
  }
  if (options.registered) {
    const declared = new Set(tools.map((tool) => tool.permission))
    const registered = new Set(options.registered)
    for (const permission of registered) if (!declared.has(permission)) problems.push(`${permission} is registered but not declared`)
    for (const permission of declared) if (!registered.has(permission)) problems.push(`${permission} is declared but not registered`)
  }

  for (const signIn of jelly.signIns ?? []) {
    if (!signIn.label.trim()) problems.push(`sign-in ${signIn.id} has no label`)
    if (/\bMCP\b/u.test(signIn.label)) problems.push(`sign-in ${signIn.id} is labelled "${signIn.label}": a label names the service, not the protocol`)
    if (Boolean(signIn.integration) === Boolean(signIn.server)) problems.push(`sign-in ${signIn.id} must name exactly one of integration and server`)
  }
  return problems
}

/** The summary: one line of at most 120 characters, a phrase naming what the plugin reaches, with no policy. */
export function summaryProblems(summary: string | undefined): string[] {
  if (!summary?.trim()) return ["jelly.summary is missing"]
  const problems: string[] = []
  if (summary.length > 120) problems.push("jelly.summary is longer than 120 characters")
  if (summary.includes("\n")) problems.push("jelly.summary is more than one line")
  if (!summary.endsWith(".")) problems.push("jelly.summary does not end with a full stop")
  if (POLICY.test(summary)) problems.push(`jelly.summary states a policy ("${summary.match(POLICY)?.[0]}"): say what it reaches, and leave what asks to the card`)
  return problems
}

/** The icon: assets/icon.svg, shipped, one svg root with xmlns and viewBox, only drawing elements, at most 16 KB. */
export function iconProblems(root: URL, pkg: Package): string[] {
  const icon = pkg.jelly?.icon
  if (icon !== "assets/icon.svg") return [`jelly.icon is ${icon}, not assets/icon.svg`]
  const problems: string[] = []
  if (!pkg.files?.some((file) => file === icon || file.replace(/\/$/u, "") === "assets")) problems.push("package.json files does not ship the icon")
  const svg = readFileSync(new URL(icon, root), "utf8").trim()
  if (svg.length > 16_384) problems.push("the icon is larger than 16 KB")
  if (!/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* viewBox="[^"]+"/u.test(svg)) problems.push("the icon does not start with <svg xmlns=… viewBox=…>")
  if (!svg.endsWith("</svg>")) problems.push("the icon does not end with </svg>")
  if (/<style|<script|&|<!/iu.test(svg)) problems.push("the icon has a style, script, entity or declaration")
  const others = [...svg.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)/gu)].map((match) => match[1]!).filter((name) => !ICON_ELEMENTS.has(name))
  if (others.length > 0) problems.push(`the icon has elements Jelly drops: ${[...new Set(others)].join(", ")}`)
  return problems
}

/** docs/jelly.md: it counts the declared tools, names each declared skill, and names no version. */
export function docProblems(root: URL): string[] {
  const path = new URL("docs/jelly.md", root)
  if (!existsSync(path)) return ["docs/jelly.md is missing"]
  const doc = readFileSync(path, "utf8")
  const pkg = readPackage(root)
  const tools = pkg.jelly?.tools ?? []
  const reads = tools.filter((tool) => tool.readOnly).length
  const problems: string[] = []
  if (!doc.includes(`${tools.length} tools are declared (${reads} read-only)`)) problems.push(`docs/jelly.md does not say "${tools.length} tools are declared (${reads} read-only)"`)
  for (const skill of pkg.jelly?.skills ?? []) if (!doc.includes(`\`${skill}\``)) problems.push(`docs/jelly.md does not name the skill \`${skill}\``)
  if (doc.includes(pkg.version)) problems.push(`docs/jelly.md names the version ${pkg.version}, which a release makes untrue`)
  return problems
}

