# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

Jelly names the plugin **Tavily** (`jelly.title`), with the package name and version beneath. Under
that name it shows the one line in `jelly.summary`, and beside it the mark in `jelly.icon`
(`assets/icon.svg`, shipped in the package): Jelly reads that file once, when it records the
plugin, and keeps it only if it is a clean SVG of drawing elements, with no script, style, link
or outside reference. A Jelly whose declaration schema lacks `summary` or `icon` refuses this
declaration, because that schema accepts no unknown keys.

## Tools and permissions

5 tools are declared (5 read-only). Jelly's agents have no base "allow everything"
rule, so this plugin's own default rules, which it puts after that rule, never reach them. Jelly
writes each declared `ask` or `deny` as that tool's default instead (the person's own choice
replaces it), and denies a read-only helper every tool not marked `readOnly`. A declared `allow`
changes nothing in Jelly.

- Ask: none.
- Off: none.
- Everything else runs, as the plugin's own rules let it.

A tool the upstream server adds later is not declared, so in Jelly it is not asked about by
default. Keep `jelly.tools` in step with the known-tool list; `test/**/jelly.test.ts` checks
each declared effect against the plugin's own default rules.

## Skills

Declared: `tavily`, `tavily-research`. Jelly refuses an install whose
skill ids collide with another plugin's or the agent's own.

## Views

None yet.

## Signing in

`jelly.signIns` declares two alternatives in one group, `tavily`: `key`, OpenCode's key integration `tavily` (an API key; the row links to Tavily's key page), or `account`, the `tavily` MCP server's own OAuth ("Tavily account"). Either one connects the card, and once one is connected the card shows only that one. The plugin checks each key once with Tavily's usage endpoint, which costs no credits. A key saved through `/connect` or `opencode auth login tavily` that Tavily turns down shows this plugin's `needs_auth` message on the key row, with Replace the key:

> Tavily did not accept this API key. Replace it, or remove it to sign in with your Tavily account.

A rejected `TAVILY_API_KEY` has no saved connection to mark, so the key row does not show it; the plugin's status names the rejection and the next step.

Jelly folds the declared sign-ins into this plugin's one card, which shows each as Connected, Not signed in or Sign in again (expired or revoked), and starts, renews and signs out of each. An agent's `jelly_connection_request`, or a tool result that names this plugin's "Run /connect and choose …" next step, opens the same card. The plugin still signs in through OpenCode, as it does without Jelly; the declaration only tells Jelly which of the engine's integrations and servers are this plugin's.

## Versions

Jelly's curated catalogue pins an exact version. Publish each release under a new version, so
that a review in Jelly can tell two releases apart.

The declaration test runs the shared kit, `test/support/jelly-kit.ts`, which checks the declaration and this page against Jelly's plugin authors' standard. `scripts/check-copies.mjs` holds the kit, and the shared part of the tools RPC (`src/host/tools-rpc.ts`), equal to the copy every plugin carries.
