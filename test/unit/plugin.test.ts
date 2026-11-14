import { describe, expect, test } from "bun:test"
import plugin from "../../src/index.js"
import type { Plugin } from "@opencode/plugin"

/** A context that records any registration. Setup must refuse before it registers anything. */
function context(version: string, options: Record<string, unknown>) {
  const registered: string[] = []
  const domain = (name: string) => ({
    transform: async () => {
      registered.push(name)
      return { dispose: async () => {} }
    },
  })
  const fake = {
    app: { name: "cli", version, channel: "latest" },
    options,
    mcp: domain("mcp"),
    agent: domain("agent"),
    websearch: domain("websearch"),
    skill: domain("skill"),
    command: domain("command"),
    rpc: { register: async () => void registered.push("rpc") },
    event: { subscribe: () => void registered.push("event") },
    integration: { connection: { active: async () => void registered.push("integration") } },
  }
  // Only the members setup reaches before it refuses are present.
  return { ctx: fake as unknown as Plugin.Context, registered }
}

describe("plugin", () => {
  test("keeps the id rehearsal.kit", () => {
    expect(plugin.id).toBe("rehearsal.kit")
  })

  test("an untested host is refused before anything is registered", async () => {
    const { ctx, registered } = context("0.0.0-dev-1", {})
    await expect(plugin.setup(ctx)).rejects.toThrow("HOST_UNTESTED: This plugin supports OpenCode >=2.2.3 <2.3.0, and this is 0.0.0-dev-1. Next step:")
    expect(registered).toEqual([])
  })

  test("an invalid option is refused before anything is registered", async () => {
    const { ctx, registered } = context("2.2.3", { websearch: "yes" })
    await expect(plugin.setup(ctx)).rejects.toThrow(`OPTIONS_INVALID: "websearch" must be true or false.`)
    expect(registered).toEqual([])
  })
})
