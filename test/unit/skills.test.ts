import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadSkills, parseSkill, registerSkills } from "../../src/skills.js"
import { transforms, type EditorOf } from "./fake.js"
import { Skill, type Plugin } from "@opencode/plugin"

const root = await mkdtemp(join(tmpdir(), "tavily-skills-"))
afterAll(() => rm(root, { recursive: true, force: true }))

/** Writes a skills folder fixture: `{ "<dir>": "<SKILL.md text>" | null }`, where null means no SKILL.md. */
async function fixture(name: string, skills: Record<string, string | null>) {
  const directory = join(root, name)
  for (const [skill, text] of Object.entries(skills)) {
    await mkdir(join(directory, skill), { recursive: true })
    if (text !== null) await writeFile(join(directory, skill, "SKILL.md"), text)
  }
  return directory
}

const skill = (name: string, description = `Use ${name}.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`

describe("loadSkills", () => {
  test("loads every skills/*/SKILL.md with its frontmatter and body", async () => {
    const directory = await fixture("valid", { tavily: skill("tavily"), "tavily-research": skill("tavily-research", "Run research.") })
    const skills = await loadSkills(directory)
    expect(skills.map((entry) => String(entry.id)).sort()).toEqual(["tavily", "tavily-research"])
    const research = skills.find((entry) => entry.id === "tavily-research")
    expect(research).toEqual({
      id: Skill.ID.make("tavily-research"),
      name: Skill.Name.make("tavily-research"),
      description: "Run research.",
      path: Skill.Info.fields.path.make(join(directory, "tavily-research", "SKILL.md")),
      content: "# tavily-research\n\nBody.",
    })
    // OpenCode advertises a skill unless autoinvoke is false, so the plugin leaves it unset.
    expect(research).not.toHaveProperty("autoinvoke")
  })

  test("accepts Windows line endings", async () => {
    const directory = await fixture("crlf", { tavily: skill("tavily").replace(/\n/g, "\r\n") })
    expect((await loadSkills(directory))[0]?.description).toBe("Use tavily.")
  })

  test.each([
    ["no frontmatter", "# tavily\n", "skills/tavily/SKILL.md has no frontmatter"],
    ["no name", "---\ndescription: Use it.\n---\nBody\n", `skills/tavily/SKILL.md has no "name" in its frontmatter`],
    ["no description", "---\nname: tavily\n---\nBody\n", `skills/tavily/SKILL.md has no "description" in its frontmatter`],
    ["an empty description", "---\nname: tavily\ndescription:\n---\nBody\n", `skills/tavily/SKILL.md has no "description" in its frontmatter`],
    ["the wrong name", skill("other"), `skills/tavily/SKILL.md is named "other" but must be named "tavily"`],
  ])("refuses a skill with %s", async (label, text, what) => {
    const directory = await fixture(`bad-${label.replace(/\W/g, "-")}`, { tavily: text })
    await expect(loadSkills(directory)).rejects.toThrow(`SKILLS_INVALID: ${what}. Next step: Reinstall the plugin.`)
  })

  test("refuses a skill folder without SKILL.md", async () => {
    const directory = await fixture("no-file", { tavily: null })
    await expect(loadSkills(directory)).rejects.toThrow("SKILLS_INVALID: skills/tavily has no SKILL.md. Next step: Reinstall the plugin.")
  })

  test("refuses a missing skills folder", async () => {
    await expect(loadSkills(join(root, "absent"))).rejects.toThrow(
      "SKILLS_INVALID: The skills folder is missing from the package. Next step: Reinstall the plugin.",
    )
  })

  test("loads the shipped skills from skills/ at the package root", async () => {
    const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
    const shipped = await loadSkills()
    expect(shipped.map((info): string[] => [info.id, info.path]).sort()).toEqual(
      ["tavily", "tavily-research"].map((id) => [id, join(packageRoot, "skills", id, "SKILL.md")]),
    )
    for (const info of shipped) expect(info.content.length, info.id).toBeGreaterThan(0)
  })
})

describe("registerSkills", () => {
  test("adds each skill on every rebuild", async () => {
    const skills = [parseSkill("tavily", "/pkg/skills/tavily/SKILL.md", skill("tavily"))]
    const domain = transforms<EditorOf<Plugin.Context["skill"]>>()
    await registerSkills(domain, skills)
    const added: Skill.Info[] = []
    const editor: EditorOf<Plugin.Context["skill"]> = {
      list: () => [],
      get: () => undefined,
      add: (info) => void added.push(info),
      update: () => {},
      remove: () => {},
    }
    domain.run(editor)
    domain.run(editor)
    expect(added).toEqual([...skills, ...skills])
  })
})
