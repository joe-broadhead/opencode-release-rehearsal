import { describe, expect, test } from "bun:test"
import { selectWebsearchDefault, type WebsearchState } from "../../src/websearch.js"
import { transforms, websearchEditor, type EditorOf } from "./fake.js"
import type { Plugin } from "@opencode/plugin"

async function run(selected: string | false | undefined) {
  const domain = transforms<EditorOf<Plugin.Context["websearch"]>>()
  const state: WebsearchState = { tavilyDefault: false }
  await selectWebsearchDefault(domain, state)
  const { editor, state: editorState } = websearchEditor(selected)
  domain.run(editor)
  return { state, editorState }
}

describe("selectWebsearchDefault", () => {
  test("selects the built-in Tavily provider when nothing chose one", async () => {
    const { state, editorState } = await run(undefined)
    expect(editorState).toEqual({ selected: "tavily", sets: 1 })
    expect(state.tavilyDefault).toBe(true)
  })

  test("leaves another provider's selection alone", async () => {
    const { state, editorState } = await run("exa")
    expect(editorState).toEqual({ selected: "exa", sets: 0 })
    expect(state.tavilyDefault).toBe(false)
  })

  test("leaves web search disabled when an earlier plugin disabled it", async () => {
    const { state, editorState } = await run(false)
    expect(editorState).toEqual({ selected: false, sets: 0 })
    expect(state.tavilyDefault).toBe(false)
  })

  test("reports Tavily when it was already selected", async () => {
    const { state, editorState } = await run("tavily")
    expect(editorState.sets).toBe(0)
    expect(state.tavilyDefault).toBe(true)
  })
})
