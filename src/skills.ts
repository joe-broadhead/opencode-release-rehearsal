import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Skill, type Plugin } from "@opencode/plugin"

/** `skills/` at the package root, next to `dist/` (and next to `src/` in the repository). */
const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url))

const invalid = (what: string) => new Error(`SKILLS_INVALID: ${what}. Next step: Reinstall the plugin.`)

/** Parses `---` frontmatter with `name` and `description`; the body after it is the skill's content. */
export function parseSkill(directory: string, path: string, text: string): Skill.Info {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"))
  const where = `skills/${directory}/SKILL.md`
  if (!match) throw invalid(`${where} has no frontmatter`)
  const fields = new Map(
    match[1].split("\n").flatMap((line) => {
      const separator = line.indexOf(":")
      return separator === -1 ? [] : [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const]
    }),
  )
  const name = fields.get("name")
  const description = fields.get("description")
  if (!name) throw invalid(`${where} has no "name" in its frontmatter`)
  if (!description) throw invalid(`${where} has no "description" in its frontmatter`)
  if (name !== directory) throw invalid(`${where} is named "${name}" but must be named "${directory}"`)
  return {
    id: Skill.ID.make(name),
    name: Skill.Name.make(name),
    description,
    path: Skill.Info.fields.path.make(path),
    content: match[2].trim(),
  }
}

export async function loadSkills(directory = SKILLS_DIR) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    throw invalid("The skills folder is missing from the package")
  })
  const skills = entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const path = join(directory, entry.name, "SKILL.md")
      const text = await readFile(path, "utf8").catch(() => {
        throw invalid(`skills/${entry.name} has no SKILL.md`)
      })
      return parseSkill(entry.name, path, text)
    })
  return Promise.all(skills)
}

export function registerSkills(skill: Pick<Plugin.Context["skill"], "transform">, skills: readonly Skill.Info[]) {
  return skill.transform((editor) => {
    for (const info of skills) editor.add(info)
  })
}
