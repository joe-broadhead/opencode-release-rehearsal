import { describe, expect, test } from "bun:test"
import { readPackage } from "../support/jelly-kit.js"
import plugin from "../../src/index.js"

/**
 * This repository is the release kit's rehearsal, not a plugin to offer. It carries no `jelly` declaration and a plugin
 * id of its own, so no catalogue scan (Jelly's, or any that looks for a declaration or for Tavily's id) takes it for
 * opencode-tavily, whose tree it copies.
 */
const ROOT = new URL("../../", import.meta.url)
const pkg = readPackage(ROOT) as ReturnType<typeof readPackage> & { keywords?: string[] }

describe("the rehearsal is not a plugin to offer", () => {
  test("package.json has no jelly declaration", () => {
    expect(Object.keys(pkg)).not.toContain("jelly")
  })

  test("its package, plugin id and keywords name the rehearsal, not Tavily", () => {
    expect(pkg.name).toBe("@joe-broadhead/opencode-release-rehearsal")
    expect(plugin.id).toBe("rehearsal.kit")
    expect(pkg.keywords ?? []).not.toContain("opencode-plugin")
    expect(pkg.keywords ?? []).not.toContain("tavily")
  })
})
