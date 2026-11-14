# Architecture

The plugin is a thin layer over OpenCode's public plugin API. Tavily's hosted MCP server provides the tools, and OpenCode runs them: OAuth, the MCP connection, permission prompts and tool results. The plugin chooses the server's settings, adds default permission rules, chooses the web search default and reports status. It adds no tools of its own. It changes one kind of result only: Tavily's error object, which Tavily's server sends as an ordinary result, becomes an error (see [Tavily's error objects](#tavilys-error-objects)).

It uses only APIs that are public in OpenCode 2.2.3. It is tested on stock OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6 (`TESTED_HOSTS` in `src/host-version.ts`). A later 2.2 release runs too, and status calls it untested. Outside `>=2.2.3 <2.3.0` the plugin does not start, unless `allowUntestedHost` is set.

`setup` runs in this order: options, host check, skills, key, then the MCP, agent, web search, skill and command transforms, the status RPC, the tool namespace and `execute.after` hook, the tools RPC, and last the key and `/connect` watchers. A failed check stops `setup` before the plugin registers anything.

## The MCP server

The plugin registers this server as `tavily`, through `ctx.mcp.transform`:

```js
{ type: "remote", url: "https://mcp.tavily.com/mcp/", timeout: { execution: executionTimeoutMs } }
```

With an API key, it adds `oauth: false` and `headers: { Authorization: "Bearer <key>" }`. It leaves `protocol` and `codemode` at OpenCode's defaults.

- **The key.** The plugin reads the active connection of OpenCode's built-in `tavily` integration with `ctx.integration.connection.active("tavily")` and `.resolve()`. It uses the result only when its type is `key`. The source is a key connected with `/connect` → Tavily or `opencode auth login tavily`, or `TAVILY_API_KEY`. The key stays in memory and is never logged or written.
- **Key changes.** Transforms must be synchronous, so the plugin reads the key in `setup`. It then listens for `credential.updated`, `credential.switched` and `integration.updated`. When the key itself changes, it calls `ctx.mcp.reload()`. OpenCode then reconnects the server with the key, or with OAuth.
- **Your own server.** If your config already defines a server named `tavily`, the transform leaves it unchanged. Status then reports `user_server`. The tools RPC calls it only when it is a remote server at Tavily's URL (with or without the final slash or a query); any other gets `SERVER_CONFLICT`, and status's next step says so.
- **The `/connect` entries.** OpenCode's built-in key integration is named "Tavily". Without a key, OpenCode gives the server an OAuth integration, `mcp_` and 16 hex digits of the SHA-1 of `tavily`, NUL and the URL, and names it after the server. The plugin renames it **Tavily account**. OpenCode registers that integration, with its name, after plugin setup and again on every MCP reload, and transforms replay in registration order. So the plugin checks the name on `integration.updated`, and polls for the first 10 seconds because a subscription has no start acknowledgement; when the name was reset, it registers its rename again, after OpenCode's, and disposes the old one.
- **The key check.** Tavily's MCP server accepts any bearer token at `initialize` and `tools/list`, and reports a wrong key only inside each tool result, with `isError: false`. So a server with a wrong key shows `connected`. The plugin checks each key once with `GET https://api.tavily.com/usage` (401 for a wrong key, no credits), at setup, on every `mcp.status.changed` of `tavily`, and when status is read; a check that could not reach Tavily runs again next time. Status reports the answer as `keyCheck`.
- **A rejected key.** On `mcp.status.changed`, when a connected key is in use and the key check rejects it, or the server needs sign-in, the plugin reports `needs_auth` on the key's connection with `ctx.integration.connection.status`, so `/connect` shows "Sign in required" on **Tavily**. It clears the report once the key is accepted.
- **`TAVILY_API_KEY`.** The plugin runs in the OpenCode server, usually the background service. That service gets the environment of the command that started it, plus `opencode service set env` variables, so a variable exported in a terminal later never reaches it. The TUI runs in the terminal: the dialog compares the terminal's `TAVILY_API_KEY` (only whether it is set) with the server's sign-in, and names the mismatch.
- **Code Mode.** OpenCode's default applies: MCP tools are in Code Mode, as `tools.tavily.tavily_search` and so on. The plugin describes the `tavily` namespace in Code Mode's catalog with `editor.namespace` (`src/tools.ts`). With Code Mode off, they are direct tools named `tavily_tavily_search` and so on. OpenCode's own `websearch` tool covers simple searches outside Code Mode.

## Permissions: default ask rules

The permission mechanism that shipped is **default `ask` rules added through `ctx.agent.transform`**. There is no `allowTools` option and no permission hook.

In every agent, right after the first `{ action: "*", resource: "*", effect: "allow" }`, the plugin adds the block below. An agent without that rule gets nothing, because the block's `ask` would loosen its default deny.

- `{ action: "tavily_*", resource: "*", effect: "ask" }`, so unknown and new tools ask;
- one `allow` for each of Tavily's five read-only tools: `tavily_tavily_search`, `_extract`, `_map`, `_crawl` and `_research`.

The plugin adds the block only when the agent does not already have it, so rebuilds add nothing. OpenCode asserts `<server>_<tool>` on resource `*` for each MCP call, and the last matching rule wins. So every later rule wins over the block: the agent's own denies (Explore's `* * deny`, Plan's limits), your `permissions` and your saved "Always allow" answers.

An escalating permission hook was rejected. It would run after the rules and saved approvals, so it would override a user's explicit allow.

**Limit.** OpenCode creates agents that are defined only in user config after plugins run, so those agents never get the block. Status lists them in `unguardedAgents` with the fix ([Configuration](configuration.md#agents-defined-only-in-your-config)); the top-level `permissions` are no fix, because they come after Explore's `* * deny`.

## Web search

When the `websearch` option is `true`, the plugin calls `e.default.set("tavily")` in `ctx.websearch.transform`, but only if no earlier transform chose a provider. It adds no provider of its own: OpenCode 2.2.3 ships one for Tavily, with the `tavily` integration.

OpenCode applies `websearch` from `opencode.json` in its own plugin, which runs after package plugins, so that choice wins and the plugin cannot see it. OpenCode uses the provider that the user chose when it first asked only when no transform set a provider.

## Status and RPC

One status object feeds `/tavily-status`, the RPC and the dialog:

```ts
{
  version: string             // the plugin's version
  state: "connected" | "sign_in_required" | "connecting" | "failed" | "disabled" | "not_configured"
  auth: "oauth" | "key_connected" | "key_env" | "user_server" | "none"
  account?: string            // a credential label, never a secret
  keyCheck?: "accepted" | "rejected" | "unchecked" // with an API key: Tavily's answer from /usage
  tools: { visible: number; unknown: number; unknownNames: string[] } // the tavily server's tools OpenCode lists
  websearchDefault: boolean   // the plugin chose Tavily; opencode.json can still override it
  host: { version: string | null; range: string; tested: boolean } // tested: 2.2.3, 2.2.4, 2.2.5 or 2.2.6
  unguardedAgents: string[]   // agents without the default rules; empty when none
  permissionsBlock?: Rule[]   // the block to paste, when unguardedAgents is not empty
  shadowedSkills?: { id: string; path: string }[] // the plugin's skills that a same-id skill replaces, and its file
  nextStep: string            // one next step; "Nothing to do." when ready
}
```

The plugin reads it from `ctx.mcp.list()`, `ctx.tool.list()`, `ctx.agent.list()`, `ctx.skill.list()`, `ctx.integration.connection.active()` and its own state. It holds no key or token. An agent counts as guarded when the block appears anywhere after its first base allow: other plugins insert their blocks at the same place. An agent is listed in `unguardedAgents` only when it has a base allow, lacks the block, and its own rules would let a new Tavily tool run without asking; one whose rules ask or deny for every Tavily tool needs no fix. `unknownNames` lists at most 20 plain names. OpenCode lists one skill per id, and a user's or project's skill with the plugin's id wins, so the plugin's own never loads; `ctx.skill.list()` then gives the other file's path.

`version`, `host`, `state`, `unguardedAgents` and `nextStep` are the fields every plugin of this family shares in its status RPC. `state` is the server's state; a release inside the range that is not a tested one changes only `host.tested` and the `OpenCode` row, never `state` or the next step. The plugin does not start outside the range unless `allowUntestedHost` is set, and then runs normally, so `state` is never `host_untested`.

`/tavily-status` posts the text as a synthetic message with `resume: false`, so no model turn starts.

The RPC is `rehearsal.kit`, with one read-only method, `status`. Its contract is `Tavily` in `src/rpc/index.ts`.

- **Input:** `{}`. The input schema is an object with no properties and `additionalProperties: false`. A call with no input, or with any key, fails with OpenCode's `rpc.invalid_input` error (HTTP 400). From a client, call `client.rpc(Tavily).status({}, { location })`. Over HTTP, `POST /api/rpc/rehearsal.kit/status` with the body `{"input":{}}`.
- **Output:** the status object, checked against its JSON Schema.
- **Error:** `unavailable`, when the status cannot be read. Its message starts with `STATUS_UNAVAILABLE`, and its `data.nextStep` says what to do.

## Tools RPC

`rehearsal.kit.tools` lets a script call the five tools with no model; [Scripting](scripting.md) is the user's view. Its methods are `describe` and one per known read, named after the upstream tool. It is an allowlist: a tool that Tavily adds later, which asks on the model path, is never a method.

A call is `{ sessionID, input }`. The module:

1. looks up the session with `ctx.session.get`, and its agent's rules with `ctx.agent.get` in the session's location (`SESSION_UNKNOWN`, `SESSION_AGENT_REQUIRED`);
2. refuses the tool when the last rule that matches `tavily_<tool>` on `*`, in the agent's rules followed by the session's, is a deny: OpenCode hides such a tool from the model (`PERMISSION_DENIED`);
3. refuses with `SERVER_CONFLICT` while the user's own `tavily` server is in use;
4. finds the tool's executor in `ctx.tool.list()`, or names the server's connection state (`AUTH_REQUIRED` and so on) or `TOOL_UNAVAILABLE`;
5. calls `execute(input, { sessionID, agent, messageID, id, signal, progress })` with a new call id. OpenCode's executor checks `tavily_<tool>` on `*` itself, with the agent's rules, the session's rules and saved approvals, and sends OpenCode's own credential;
6. returns `{ output?, text }`: the tool's structured content and its text parts.

While a call runs, its id is live. A `permission.hook("evaluate")` turns an `ask` whose source id is live into a deny, so the script gets `PERMISSION_DENIED` at once and no prompt waits. It changes nothing else; this is the plugin's only `evaluate` hook, and the forbidden-API scan allows exactly this one.

A `Tool.Error` with a cause is a permission refusal; one without a cause is Tavily's own error (`isError`), which becomes `UPSTREAM_ERROR` with its first line, at most 300 characters, with tokens and URL queries removed. Tavily's error object in an ordinary result becomes `UPSTREAM_ERROR` too, in `shapeResult`, with Tavily's status and words redacted the same way and a next step for its status. Any other failure is OpenCode's own and passes through.

OpenCode decodes a plain JSON Schema input with Effect, which drops unknown keys of an object that has properties instead of refusing them. So the envelope's schema carries a strict Standard Schema validator as a non-enumerable `~standard` property, which OpenCode prefers. The contract still reads and serialises as plain JSON Schema, and OpenCode answers a bad envelope with `rpc.invalid_input`.

The executor does not run `execute.before` and `execute.after` hooks, so `shapeResult` does what the plugin's `execute.after` hook does for the model. Every other result is returned unchanged.

## Tavily's error objects

Tavily's hosted server answers some failures, such as its rate limit, as an ordinary result: `{"error":"Map failed","status":429,"detail":{"error":"…"},"documentation":"…"}`. A model or a script would read that as data. The plugin recognises an object with an integer `status` of 400 or more together with an `error`, in the result's structured content or as its whole text (`src/tavily-error.ts`):

- **For the model**, an `execute.after` hook on `tavily_*` tools replaces such a result with `UPSTREAM_ERROR: tavily_<tool> failed: Tavily answered with error <status>: <Tavily's words>. This is an error from Tavily, not a result. Next step: …`.
- **For scripts**, `shapeResult` gives the same error as `UPSTREAM_ERROR`.
- The next step depends on the status: 429, wait and retry, then check the plan and key; 432 and 433, the plan's limits, where a retry fails; 401 and 403, `/tavily-status`; 5xx, wait and retry; any other, the input.

Every other result, successful or not, is left exactly as it is.

## Terminal UI

`dist/tui.js` is prebuilt JavaScript from `src/tui/index.tsx`. OpenCode does not compile `.tsx` files from `node_modules`, so the package ships no TSX. The RPC contract is inlined into it, so it imports only `@opencode/plugin/rpc`, `@opentui/core`, `@opentui/solid` and `solid-js`, which OpenCode supplies.

The TUI part registers one global command from setup: the palette entry **Tavily: Status**, with the slash alias `/tavily`. It opens one dialog that calls the RPC and shows the rows Connection, Account, Access, Sign-in, Web search, Skills, Tools, Agents without default rules (with the block), OpenCode and Next step, in that order; `/tavily-status` prints the same rows. `r` refreshes it and `Esc` closes it; the hint reads `r refresh · esc close`. It subscribes to events only while the dialog is open, and refreshes on `server.connected`, `mcp.status.changed`, `agent.updated`, `integration.updated`, `credential.updated` and `credential.switched`. OpenCode 2.2.3's client has no `mcp.tools.changed` event, and OpenCode lists a server's tools shortly after the server connects, so the tool count can lag until the next refresh or `r`. The part stops every listener, aborts open requests and closes the dialog when it is disposed.

## Package

- JavaScript only: `dist`, `skills`, `README.md`, `LICENSE`, `CHANGELOG.md` and `package.json`.
- `dist/` holds exactly two self-contained files, built by `scripts/build.mjs` with esbuild: `index.js` (the server part) and `tui.js` (the TUI part, after Babel compiles its JSX). Each inlines every module it uses, the RPC contract included, so neither has a relative import. OpenCode reloads a plugin in place but keeps the module records of unchanged paths, so a sibling module could otherwise be a stale copy. Only `@opencode/plugin`, OpenTUI, Solid and `node:*` stay imports; the build fails on anything else. `tsc` only typechecks.
- The server part finds `skills/` at `../skills/` from `dist/index.js`, the package root.
- No `dependencies` and no peer dependencies. OpenCode supplies `@opencode/plugin`, OpenTUI and Solid to plugins at runtime. They are dev dependencies here, for types, the build and the tests, with `@opencode/plugin` pinned at 2.2.3.
- `"opencode": { "host": ">=2.2.3 <2.3.0" }` states the tested range. The start-up check uses the same range.
- No lifecycle scripts. OpenCode installs plugins with scripts turned off, so `dist/` is built before packing.
- Exports: `.` → `./dist/index.js` and `./tui` → `./dist/tui.js`. The package ships no declaration files.

## Why the plugin has no tools of its own

| Candidate | Decision |
| --- | --- |
| Wrappers for search, extract, map and crawl | No. They copied Tavily's schemas, broke when Tavily changed its wording, and needed a short deadline and a lossy normalizer. Tavily's own tools are typed, marked read-only and maintained by Tavily. |
| A Research wrapper with progress | No. It would need a second, key-only REST path beside `tavily_research`. |
| `status` or `catalog` tools for the model | No. The model sees OpenCode's errors and the sign-in state. People use `/tavily-status` or the **Tavily: Status** dialog. |
| A plugin web search provider | No. OpenCode ships one for Tavily, and the plugin selects it. |

## Research

- Tavily's Research result reaches the model unchanged. In Tavily's open-source MCP server (`tavily-ai/tavily-mcp`, `formatResearchResults`) it is the report's text alone, or `Research Error: …` as plain text, which is not an error object and so stays text. The hosted server was not observed, because a run costs credits; the `tavily-research` skill is worded to hold either way.
- `executionTimeoutMs` (15 minutes by default) bounds each call. OpenCode's own default is 12 hours, which does not stop a call that hangs.
- There is no progress. OpenCode asks the MCP server for progress only to keep the call alive and does not show it. A plugin cannot add progress to a tool that it does not own, so the `tavily-research` skill tells the model what to expect.

## Code Mode and declined calls

On OpenCode 2.2.3, when the user declines a tool call inside a Code Mode program, the program gets an error that it can catch, and the program continues. A program could therefore try a different route after a decline. The `tavily` skill tells the model to accept a decline and not to try another route. The upstream pull request [anomalyco/opencode#60112](https://github.com/anomalyco/opencode/pull/60112) proposes to end the run on a decline instead. This plugin does not work around it.

## Upstream drift

`npm run check:upstream` (`tools/check-upstream.mjs`) is a check for maintainers. It lists the tools of Tavily's hosted server without a key and compares them with the five known reads. It prints added and removed tools, and always exits with 0. Nothing at runtime depends on it: a new tool follows the `access` rules until the plugin classifies it, and a removed tool leaves an unused allow rule.

## OpenCode facts the design relies on

The links point to the OpenCode source at tag `v2.2.3`.

| Fact | Source |
| --- | --- |
| `ctx.mcp.transform` registers a remote server with `type`, `url`, `headers`, `oauth`, `timeout`, `codemode` and `protocol`. | [`packages/schema/src/mcp.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/schema/src/mcp.ts) |
| A remote server without `oauth: false` gets an OAuth integration named after the server, with the id `mcp_` and the first 16 hex digits of the SHA-1 of its name and URL. So it cannot collide with the built-in `tavily` integration. | [`packages/core/src/mcp/index.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/mcp/index.ts) |
| Each MCP tool call asserts the permission `<server>_<tool>` on resource `*`. | [`packages/core/src/tool/mcp.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/tool/mcp.ts) |
| The last matching rule wins. Denies are checked first. Saved approvals come after agent and session rules, and are saved for the project. | [`packages/core/src/permission.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/permission.ts) |
| Config `permissions` are appended to every agent after its built-in rules. Agents defined only in config are created after package plugins run: from the default agent, then the top-level rules, then their own. | [`packages/core/src/config/plugin/agent.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/config/plugin/agent.ts) |
| `DEFAULT_EXECUTION_TIMEOUT` is 12 hours. Tool calls pass `onprogress: () => {}`, so progress is never shown. | [`packages/core/src/mcp/client.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/mcp/client.ts) |
| OpenCode ships the `tavily` web search provider and the `tavily` integration (named "Tavily", with `key` and `TAVILY_API_KEY` methods). The provider sends the key, or uses Tavily's keyless mode when there is none. | [`packages/core/src/plugin/websearch/tavily.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/plugin/websearch/tavily.ts) |
| The web search provider is the one chosen by the transforms. The user's stored first-use choice is used only when no transform chose one. | [`packages/core/src/websearch.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/websearch.ts) |
| The `websearch` setting in `opencode.json` is applied by OpenCode's own `opencode.config.websearch` plugin, which runs after package plugins. | [`packages/core/src/config/plugin/websearch.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/config/plugin/websearch.ts) |
| `ctx.integration.connection.active(id)` and `.resolve()` are public. A saved account wins over an environment connection. | [`packages/core/src/integration.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/integration.ts) |
| `ctx.tool.list()` returns each MCP tool with a callable `execute`, which checks `<server>_<tool>` with the agent's and the session's rules and saved approvals, and gives the `evaluate` hook the call's `source`. A deny is a `Tool.Error` with a cause; the server's `isError` is one without. `execute.before` and `execute.after` hooks do not run for it. Not documented as an entry point. | [`packages/core/src/tool/mcp.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/tool/mcp.ts) |
| An RPC input given as a Standard Schema is validated with it; a plain JSON Schema is decoded with Effect, which drops unknown keys of an object that has properties. | `@opencode/core` 2.2.3, the RPC service's `parse` |
| A permission decline inside a Code Mode program becomes an error that the program can catch. | [`packages/core/src/codemode/tool.ts`](https://github.com/anomalyco/opencode/blob/v2.2.3/packages/core/src/codemode/tool.ts) |
