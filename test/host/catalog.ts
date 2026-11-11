// Tavily's hosted tools as a keyless `tools/list` on https://mcp.tavily.com/mcp/ returned them on 2026-10-28
// (server tavily-mcp 4.1.4): names, order, titles and annotations as recorded; input schemas cut to their required
// field. The fake server and the drift check's test serve this list, so no test contacts Tavily.
const READ_ONLY = { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: true }

const tool = (name: string, title: string, required: string) => ({
  name,
  title,
  description: `${title} (host test copy)`,
  inputSchema: { type: "object", properties: { [required]: {} }, required: [required] },
  annotations: READ_ONLY,
})

export const RECORDED_TOOLS = [
  tool("tavily_search", "Tavily Search", "query"),
  tool("tavily_extract", "Tavily Extract", "urls"),
  tool("tavily_crawl", "Tavily Crawl", "url"),
  tool("tavily_map", "Tavily Map", "url"),
  tool("tavily_research", "Tavily Research", "input"),
]

export type CatalogTool = (typeof RECORDED_TOOLS)[number]

/** A tool Tavily might add later. The plugin has no rule of its own for it, so it asks. */
export const NEW_TOOL: CatalogTool = {
  name: "tavily_feedback",
  title: "Tavily Feedback",
  description: "Send feedback about a result (host test tool)",
  inputSchema: { type: "object", properties: { query: {} }, required: ["query"] },
  annotations: { ...READ_ONLY, readOnlyHint: false },
}
