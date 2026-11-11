// A loopback model for the embedded host: an LM Studio-compatible API (`/api/v1/models` and a streamed
// `/v1/chat/completions`), so a session turn runs a real tool call and a test sees exactly what a model receives.
// A request that offers tools is an agent turn: after n tool results the model makes the n-th scripted call, then
// answers "Done.". Every chat request body is kept.
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const MODEL_ID = "host-test-model"

/** A tool call the model makes, by the tool name it was offered. */
export interface ScriptedCall {
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

export interface ChatRequest {
  readonly tools?: readonly { readonly function: { readonly name: string; readonly description?: string } }[]
  readonly messages?: readonly { readonly role: string; readonly content?: unknown }[]
}

export interface FakeModel {
  /** The `baseURL` for the lmstudio provider. */
  readonly baseURL: string
  script: ScriptedCall[]
  readonly requests: ChatRequest[]
  close(): Promise<void>
}

export async function startFakeModel(): Promise<FakeModel> {
  const model = { script: [] as ScriptedCall[], requests: [] as ChatRequest[] }

  function chat(response: ServerResponse, body: string) {
    const request = JSON.parse(body) as ChatRequest
    model.requests.push(request)
    const results = (request.messages ?? []).filter((message) => message.role === "tool").length
    const call = request.tools?.length ? model.script[results] : undefined
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: "chatcmpl-host-test", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const usage = `data: ${JSON.stringify({ id: "chatcmpl-host-test", object: "chat.completion.chunk", created: 0, model: MODEL_ID, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${results + 1}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: "Done." }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`${chunk(delta, null)}${chunk({}, call ? "tool_calls" : "stop")}${usage}data: [DONE]\n\n`)
  }

  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    if (path === "/api/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      return void response.end(
        JSON.stringify({
          models: [{ type: "llm", key: MODEL_ID, display_name: "Host test model", loaded_instances: [], max_context_length: 32_000, capabilities: { vision: false, trained_for_tool_use: true } }],
        }),
      )
    }
    if (path === "/v1/chat/completions") return chat(response, body)
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    get script() {
      return model.script
    },
    set script(calls) {
      model.script = calls
    },
    requests: model.requests,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  }
}
