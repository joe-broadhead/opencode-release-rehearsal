# Repository rules

This repository builds `@joe-broadhead/opencode-tavily`, an OpenCode plugin that registers Tavily's official remote MCP server (`https://mcp.tavily.com/mcp/`) and uses Tavily's own tools. Setup, checks and releases are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Platform

- Use only public `@opencode/plugin` APIs that exist in OpenCode 2.2.3. The host range is exactly `>=2.2.3 <2.3.0`, never `^2.2.3`.
- Test against stock OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6, the list in `src/host-version.ts` (`TESTED_HOSTS`). The host, pack and stock stages and CI take their versions from it.
- `npm run lint` (`test/forbidden`) scans `src/` and `dist/` and fails on any of these:
  - `ctx.generate.text` or `experimental.generate.text`;
  - `ctx.experimental.artifact`;
  - a `permission.hook("evaluate")`, except the one in `src/host/tools-rpc.ts`: it turns an `ask` on one of the tools RPC's own script calls in flight into a deny, because no one can answer it, and touches nothing else;
  - an import of `@opencode/ai`, `effect` or the V1 `@opencode-ai/` packages;
  - an import of `@opentui/*` or `solid-js` outside `src/tui`.
- Code outside `src/tui` imports only `@opencode/plugin`, `@opencode/plugin/*`, `node:*` and other files in `src/`. `src/tui` may also import `../rpc/index.js`, which the build inlines.
- `src/host/tools-rpc.ts` is a copy of a module shared by several plugins. Change only its block between the `PLUGIN-SPECIFIC` markers here; change the rest in the shared copy first.
- Tests import no host source: only `@opencode/plugin`, `@opencode/sdk` and `@opencode/client` at 2.2.3. The host stage runs the same suite against each other tested SDK, installed into a temp folder outside the lockfile (`tools/host-tests.mjs`), and fails when a release did not run. Write test doubles as narrow `Pick<Plugin.Context, ...>` fakes.

## Permissions

- Every tool is allowed by default. `src/permissions.ts` generates the block from the tool classes and the `access` option (`all`, the default; `ask-changes`; `read-only`) and inserts it after each agent's first base allow. A user's rules always win.
- `defaultRules(access)` is printed in full in the README and in `docs/configuration.md` for each value; `test/unit/docs.test.ts` asserts the docs equal it.
- The package declares `opencode.icons` and `opencode.vendor`, with `assets/icon.svg`, `icon-128.png` and `icon-256.png`; `scripts/check-icons.mjs` is the kit's copy, verbatim.

## Greenfield

- No legacy or dead code, exports, dependencies, docs, tests or fixtures. Delete rather than deprecate.
- No plugin-owned Tavily tools, no plugin web search provider and no keyless MCP mode.
- No runtime manifests, schema pinning or attestation. `npm run check:upstream` warns about upstream drift and never fails.
- Never write keys, tokens, personal data or machine-local absolute paths into the repository. Never log or store the Tavily key.

## Package

- Releases come only from `.github/workflows/release.yml`, started by hand on
  `master` with the sha CI passed (and the native run's id), after the owner
  approves the `release` environment. Never publish, commit a release or tag by
  hand. The tag is exactly `v` and the `version` in `package.json`; the workflow
  makes it after the approval ("Releasing" in [CONTRIBUTING.md](CONTRIBUTING.md)).
  Agents never approve a release, never call the deployment-approval API, and
  never bypass a ruleset or the environment. Never re-run the older
  `apply-release-kit.mjs`: it would revert the release kit.
- No personal email in anything we publish. Every commit is authored as
  `joe-broadhead <91376460+joe-broadhead@users.noreply.github.com>`, except the
  release commit and tag, which the release workflow makes as `github-actions[bot]`. Before committing or tagging, check that
  `git config user.email` is that address: a fresh clone inherits the machine's global identity, which is not that
  address. Never commit, tag or publish with a work or personal address, or with a local hostname.
- The version appears only in `package.json` and `CHANGELOG.md`. `scripts/build.mjs` defines `__PLUGIN_VERSION__` from `package.json` for `src/version.ts`, and `bunfig.toml` preloads `test/version.ts`, which does the same for the tests.
- No `dependencies`, peer dependencies, lifecycle scripts or declaration files. `exports` lists only `.` → `./dist/index.js` and `./tui` → `./dist/tui.js`.
- `dist/` holds exactly `index.js` and `tui.js`, each a self-contained esbuild bundle with no relative imports (`scripts/build.mjs`). Only `@opencode/plugin*`, `@opentui/*`, `solid-js` and `node:*` stay external. `tsc` only typechecks.
- `@opencode/plugin`, `@opencode/sdk`, `@opencode/client` and `@opencode/theme` are exact dev dependencies at 2.2.3. Do not add 2.2.4 to `package-lock.json`.
- npm installs and runs the scripts (`npm ci`, `npm run check`); Bun 1.4.4 runs the tests.
- The stages are `typecheck`, `build`, `unit`, `tui`, `host`, `pack`, `lint`, `icons` and `actionlint` (a notice when it is not on PATH). CI runs `actionlint` in its own job, and the host and pack stages run every release in `TESTED_HOSTS`.

## Contracts

Keep these stable: plugin id `rehearsal.kit`, TUI id `rehearsal.kit.tui`, MCP server name `tavily`, RPC id `rehearsal.kit` with the method `status`, the tools RPC `rehearsal.kit.tools` with `describe` and one method per known tool, each with its class, and skill ids `tavily` and `tavily-research`. Users' permission rules and saved approvals name the server's tools, and clients call the RPC by its id.

## Commits

`npm run check` passes before every commit. Use `type(scope): summary`, with a body line such as `Refs #10`.
