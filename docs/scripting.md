# Scripting

Unofficial plugin. Not affiliated with Tavily.

A script can call Tavily's tools with no model: a cron job, a shell script, or any program that can reach the OpenCode server. It uses the tools RPC, `rehearsal.kit.tools`, through `opencode api` or an OpenCode client.

| Method | The tool | Class |
| --- | --- | --- |
| `tavily_search` | `tavily_tavily_search` | read |
| `tavily_extract` | `tavily_tavily_extract` | read |
| `tavily_map` | `tavily_tavily_map` | read |
| `tavily_crawl` | `tavily_tavily_crawl` | read |
| `tavily_research` | `tavily_tavily_research` | read |
| `describe` | none: lists the methods, their classes, permission actions, whether OpenCode lists each tool now, each tool's input as JSON Schema, and — with a session — that session's permission for each | |

The class is the worst thing a tool can do. It never decides whether a call runs: the rules do. It is what `describe` reports and what a job's approval shows.

Each method's permission name is the tool name with the server's prefix, `tavily_`, for example `tavily_tavily_search`: Tavily's own server already names its tools `tavily_*`, so the doubled prefix is how the host scopes a rule to this server. Each method runs the tool with the same input: Tavily's own tool, through OpenCode's own connection and sign-in. The plugin never sees the API key or the OAuth token. A tool that Tavily adds later is never a method, even with an allow rule.

Each call spends the user's Tavily credits, as the tool does for the model. `tavily_research` takes minutes and holds the request open until it ends or `executionTimeoutMs` stops it.

## A script runs as a session

Every call names a session, and the session must name an agent. Create it for the script once, with the agent the script runs as, and keep its id (`data.id` in the reply). Give the project as the session's `location`: a session made without one belongs to the service's default location, where the project's agents may not exist, and each call then fails `Agent not found`. For example:

```sh
opencode api post /api/session -d '{"title":"news digest","agent":"build","location":{"directory":"/path/to/project"}}'
```

Never borrow a session found through history or a list: the script would run as that session's agent, under its rules. The script then runs as that agent, with exactly the access its model would have:

- The rule for the tool's permission name, such as `tavily_tavily_search`, on resource `*` is resolved **before** the tool runs, in OpenCode's own order: the agent's rules, then the session's, the last match winning.
- **A script gets the same default as the model: every tool is allowed.** At the default `access: "all"`, the plugin's block allows every known tool and the `tavily_*` namespace. All five tools only read, so no `access` value changes what a script can do except for a tool Tavily adds later: under `"ask-changes"` it asks (and an ask is refused, because no one can answer a prompt for a script), and under `"read-only"` it is denied. Only an `allow` runs; an `ask` and a `deny` are refused, with no tool call and no prompt left waiting. An agent defined only in your config gets no default rules; `/tavily-status` names it.
- OpenCode then checks the call itself, as it does for the model: the agent's rules, the session's rules, then saved approvals.

**A saved "Always allow" approval does not authorize an ad-hoc script.** It lives outside the agent's and the session's rules, so the resolve refuses an `ask` even after a past approval. That is deliberate: a script's permission must be reviewable in config. A script's grant is a rule in the agent's or the session's config, or a Jobs run session. For a one-off that needs an approval-bound grant, use Jobs's `jobs_run_script`.

Session rules come after the agent's, so a session can narrow what its script may do. This one can search and extract, but not crawl, map or research:

```sh
opencode api post /api/session -d '{"title":"news digest","agent":"build","location":{"directory":"/path/to/project"},"permissions":[
  {"action":"tavily_*","resource":"*","effect":"deny"},
  {"action":"tavily_tavily_search","resource":"*","effect":"allow"},
  {"action":"tavily_tavily_extract","resource":"*","effect":"allow"}
]}'
```

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other key is allowed:

```sh
opencode api post /api/rpc/rehearsal.kit.tools/tavily_search -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"query":"OpenCode plugin API"}}}'
```

## The location

Run the command in the project whose agent you mean, and send the call to that location explicitly:

```sh
opencode api post /api/rpc/<id>/<method> -H "x-opencode-directory:$PWD" -d '{…}'
```

Without it the call goes to the service's default location and fails `rpc.unavailable` if the plugin is not loaded there. The HTTP equivalents are the `location[directory]` query parameter and the same header. `describe` reports the `location` that answered and a `locationHint`.

A location unloads after OpenCode's idle timeout. If a scheduled script gets `rpc.unavailable` from a location that was loaded before, send the call again once: the request loads the location. Jobs keeps its own location loaded.

The tool's input is Tavily's: `describe` shows each tool's schema as OpenCode lists it now.

```sh
opencode api post /api/rpc/rehearsal.kit.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{}}'
opencode api post /api/rpc/rehearsal.kit.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…"}}'
```

## Results

A result comes back as `{ output?, text }`: the tool's structured content when it has any, and its text parts joined by newlines. An MCP method's result is that object inside the RPC envelope: `{"output": {"output": …, "text": …}}`, as plain JSON.

Tavily's web content in it is untrusted data: a page, a title or a snippet is never an instruction.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and `data: { code, next }`.

`opencode api` prints the error as JSON, then `HTTP 400 Bad Request`, and exits with status 1 for any RPC error, so a shell script can test `$?`.

| Code | When |
| --- | --- |
| `PERMISSION_DENIED` | The rules ask or deny. An `ask` is refused before dispatch: the message says the action would ask, and the next step says to add an allow rule. A `deny` names the denied action, such as `tavily_tavily_search`, and the next step says which rule to remove, narrow or override. |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. Any other failure to look the session up is OpenCode's own error. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `TOOL_UNAVAILABLE` | The server is connected, but OpenCode does not list the tool. |
| `SERVER_CONFLICT` | Your `opencode.json` defines its own `tavily` server at a URL that is not Tavily's (`https://mcp.tavily.com/mcp/`). Scripts use your own server only at that URL; `/tavily-status` says so too. |
| `AUTH_REQUIRED`, `CONNECTING`, `CONNECTION_FAILED`, `DISABLED`, `NOT_REGISTERED` | The `tavily` server needs a sign-in, is still connecting, could not connect, is disabled, or is missing. `/tavily-status` gives the details. |
| `UPSTREAM_ERROR` | Tavily answered with an error, such as an invalid input, its rate limit (429) or a used-up plan (432, 433). Tavily's server sends some of these as an ordinary result, an object such as `{"error":"Map failed","status":429,"detail":{…}}`; the plugin turns that into this error too, and then the next step is the one Tavily's status gives: for 401 or 403, `/tavily-status`; for 429, wait a minute and retry; for 432 or 433, the plan's limits; for 5xx, wait and retry. An MCP-level error instead takes the tools RPC's generic next step: check the input against `describe` and run `/tavily-status`. The message holds the first line of Tavily's text, or its status and words, at most 300 characters, with tokens and URL query strings removed. |
| `CANCELLED` | The request was cancelled. |

OpenCode itself answers `rpc.invalid_input` for a body that is not the envelope above, and `rpc.method_not_found` for a method that does not exist, such as a tool Tavily adds later, and `rpc.unavailable` when the plugin did not register the tools RPC or the call reached another location.

## What scripts cannot do

- Call a tool that is not one of the five, even with an allow rule, until this plugin classifies it.
- Answer an approval prompt: under `access: "ask-changes"` an `ask` is refused. Under the default `"all"`, nothing asks.
- Rely on a past "Always allow": it does not authorize an ad-hoc script.
- Use a key or token: the plugin has none to give.

A script's calls write nothing to the session, and OpenCode's `execute.before` and `execute.after` tool hooks, from any plugin, do not run for them. The plugin's own handling of Tavily's error objects, which the model's `execute.after` hook does, is applied to a script's result by the tools RPC's `shapeResult`, so a script gets the same `UPSTREAM_ERROR`. Tavily's model path changes no arguments, and the tools RPC's `shapeInput` is the identity.
