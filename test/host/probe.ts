// Loaded after the Tavily plugin in every embedded test host. It replaces OpenCode's built-in "tavily" web search
// provider and adds "fakeprobe", so a query shows which provider serves it without reaching Tavily. Public plugin API
// only.
import { Plugin } from "@opencode/plugin"

export const PROBE_PROVIDERS = ["tavily", "fakeprobe"] as const

export default Plugin.define({
  id: "tavily.host-test.probe",
  async setup(ctx) {
    await ctx.websearch.transform((editor) => {
      for (const id of PROBE_PROVIDERS)
        editor.add({ id, name: `Host test ${id}`, execute: async () => [{ url: `https://example.invalid/${id}`, time: {} }] })
    })
  },
})
