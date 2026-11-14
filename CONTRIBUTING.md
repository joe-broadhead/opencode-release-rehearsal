# Contributing

Repository rules for contributors and agents are in [AGENTS.md](AGENTS.md).

## Setup

You need Node.js 24 or later, whose `npm` installs and runs the scripts, and [Bun](https://bun.sh) 1.4.4, which runs the tests.
`npm ci` on Node 24 prints `EBADENGINE` warnings for `@opentui/core`, which asks for Node 26.4 or Bun 1.3.14. They are warnings only: the TUI tests run under Bun 1.4.4, and CI passes on Node 24.

```sh
git clone https://github.com/joe-broadhead/opencode-tavily.git
cd opencode-tavily
npm ci --ignore-scripts
npm run build
```

To try a local build, add the checkout's directory to `plugins` in your OpenCode config, then run `opencode reload`:

```jsonc
{ "plugins": ["/path/to/opencode-tavily"] }
```

## Checks

```sh
npm run check
```

`npm run build` runs `scripts/build.mjs`: esbuild bundles `src/index.ts` into `dist/index.js` and `src/tui/index.tsx`, after Babel compiles its JSX, into `dist/tui.js`. Each file is self-contained, with no relative imports, so an in-place plugin reload never mixes it with a stale sibling module. `tsc` only typechecks.

`check` runs, in order: `typecheck` (the source and the whole test tree), `build`, the unit tests (`test`), the TUI tests (`test:tui`), the host tests (`test:host`), the package test (`test:pack`) and the forbidden-API scan (`lint`). Nothing calls Tavily.

- The host tests start OpenCode from `@opencode/sdk` inside the test process, in a temporary home with a proxy that refuses every request. A scripted loopback model runs real session turns, so the tests see what a model receives from a Tavily tool. `tools/host-tests.mjs` runs the suite on every tested release: the locked 2.2.3, then 2.2.4, 2.2.5 and 2.2.6 each installed from npm into a temp folder, and the stage fails when a release did not run. `HOST_SDK_DIR=<dir>` runs only the SDK in that folder.
- **Isolation.** Every test host lives in one temp root under `/tmp` (`/private/tmp` on macOS), whatever `TMPDIR` says. OpenCode reads `.opencode/` folders above a project, so a root inside your home would pick up your own agents and skills. Each project is its own git worktree, and the harness fails if a folder above the root holds `.opencode/`. Each stock host serves on its own free port and pins its managed-service port, so no CLI call reaches a running OpenCode.
- The package test checks that `dist/` holds exactly `index.js` and `tui.js` with no relative `import`, `import()` or `require`. It packs the plugin with `npm`, installs the tarball offline into an empty project, and loads it in each tested stock OpenCode release, 2.2.3, 2.2.4, 2.2.5 and 2.2.6 (`TESTED_HOSTS` in `src/host-version.ts`). Set `OPENCODE_BIN_2_2_3`, `OPENCODE_BIN_2_2_4`, `OPENCODE_BIN_2_2_5` and `OPENCODE_BIN_2_2_6` to those `opencode` binaries; otherwise it downloads each release from npm on every run, as CI does. `PACK_TARBALL` tests an existing tarball instead of packing one.
- `npm run check:upstream` is for maintainers. It lists the tools of Tavily's hosted server without a key and prints tools that were added or removed. It needs the network, only warns, and is not part of `check`.

## Releasing

Each release is the GitHub tag `v<version>`, where `<version>` is the `version` in `package.json`, and users install from
that tag. The release is one commit on top of a `master` head that CI passed, and the tag points at it. The release
workflow makes both, in GitHub Actions: nobody builds, commits or tags a release on their own machine, and no personal
key signs it.

While changes land, their notes go under `## [Unreleased]` at the top of `CHANGELOG.md`. Each earlier GitHub release is
a `## [x.y.z] - YYYY-MM-DD` heading below it, newest first, and the npm history stays last, under
`## Earlier releases on npm`.

1. On `master`, set `version` in `package.json` to the new version, and change every install spec in the README,
   `CONTRIBUTING.md` and `docs/` to `#v<version>` (`test/docs.test.ts` fails until they match). Then run
   `node scripts/changelog.mjs release`: it turns `## [Unreleased]` into `## [<version>] - <today>`, above the earlier
   releases, and refuses a CHANGELOG it cannot shape. Run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. Start the release with that commit's full sha:
   `gh workflow run release.yml --ref master -f sha=<full sha>`, or from Actions → release →
   Run workflow, on `master`.
4. Read the run's summary, then approve the `release` environment. The summary is on the run page, under the `stage`
   job: the tag, the parent and its CI run, the release commit and its tree, the sha256 of `SHA256SUMS` and the staged
   artifact's id, `SHA256SUMS` itself, and the notes. Open the release commit on `release/v<version>` and read them
   before approving: the approval releases exactly those bytes. Only the owner approves a release. Agents never approve
   one, never call the deployment-approval API, and never bypass a ruleset or the environment; the kit's scripts make
   only their own GitHub calls and refuse every other.
5. Check the published Release: not a draft, its notes, and every asset against `SHA256SUMS`.

`package.json` stays `"private": true`, so npm can never publish the plugin by accident; a GitHub install does not read
it, and `npm pack` still packs the release tarball. It is kept in its canonical form, `JSON.stringify(pkg, null, 2)` and
one newline: the kit tests check both in `npm run check`, as the release planner does.

Before the approval, the workflow:
- **plans:** refuses a run that is not on `master`, a sha that is not `master`'s head, a sha without a successful
  `ci.yml` push run, a version that is not `x.y.z`, a `package.json` that is not `"private": true` or not in its
  canonical form, a CHANGELOG whose newest release is not this version, a release that does not move forward from the
  last published Release, a leftover `release/v<version>` branch, a native run that did not build this sha on `master`,
  by hand, with success, and a missing `native_run` (or one given to a plugin that is not native);
- **builds** `dist/` with `npm ci --ignore-scripts` and `npm run build`, with a read-only token, and writes the release
  files: `dist/`, `package.json` without its lifecycle scripts, and the vetted native manifest;
- **commits** them on a temporary branch `release/v<version>` at the parent, through GitHub's API with the workflow's token,
  so GitHub signs the commit (author `github-actions[bot]`, committer GitHub). This job runs no npm. It refuses a commit
  that GitHub does not verify, or whose parent or tree is not the one the files give;
- **verifies** on a fresh runner: the commit's identity, one parent on `master`, `package.json` exactly the parent's
  without the lifecycle scripts, only regular files in the allowed paths, no `package.json` under `dist/`, and a second,
  independent build of the parent (its own job) equal to the committed `dist/` byte for byte;
- **installs** the release commit with `plugin add` on each stock OpenCode host (2.2.3 to 2.2.6);
- **packs** the commit before installing anything and keeps that tarball, then runs the pack stage against a copy;
- **stages** the Release: verifies the attested native files, writes `SHA256SUMS` and the notes (the version's CHANGELOG
  section), and shows them all in the run summary with the sha256 of `SHA256SUMS`.

A job either runs repository or dependency code (`npm ci`, the build, the pack stage, a host install) and has no write
token, or uses the API and runs only the kit's scripts on a fresh checkout, after checking that the release commit's
`scripts/` and `.github/` are the parent's. The first kind is not token-free: `actions/checkout` fetches with the job's
read-only (`contents: read`) token, and its post step and the artifact uploads run after repository code on the same
runner, so that code could reach a read-only token for this public repository and the runner's artifact token. Jobs
pass files as artifacts downloaded by the id the uploading job gave, and each is checked again on arrival.

After the approval, it downloads the staged artifact by the id the summary names, and refuses unless `SHA256SUMS` has
the sha256 the summary shows and every staged file matches it, and every native file is the one the release commit's
`manifest/native.json` pins, size and sha256, with each gzip holding the pinned executable. Then it checks everything again, creates the annotated tag
`v<version>` on the release commit (tagger `github-actions[bot]`, unsigned), checks the tag, creates the Release with the
notes, the tarball, the native files and `SHA256SUMS`, and deletes `release/v<version>`. The tag keeps the commit.

GitHub's signature and the bot identity show only that GitHub made the commit through its API for the workflow; anyone
with write access can make such a commit. What ties the release to `master` is its content: one parent CI passed, the
exact `package.json`, the allowed paths and the byte-for-byte rebuild. Never relax those because the commit is signed.

**A rejected, expired or failed run** leaves nothing behind: the `cleanup` job deletes `release/v<version>` when it points
at the parent or at that run's commit, and never touches another branch. No tag exists before the approval, so the
version is not burned: fix `master` and start again. If `cleanup` itself failed, the next run refuses until the branch
is deleted: `gh api -X DELETE repos/joe-broadhead/opencode-release-rehearsal/git/refs/heads/release/v<version>`.

**Resume.** If the run fails after creating the tag and before the Release is complete, start it again with the same `sha`. The plan finds the kit's tag on a release commit on that sha with no published Release, and resumes:
it makes no new commit, checks and installs the tagged commit, stages the files, and after a new approval reuses the tag
and adds what the Release lacks. Delete a draft Release a failed upload left first: the publish step refuses a draft.
Any other existing tag is refused: release the next version.

The repository's tag ruleset keeps a `v*` tag from being moved or deleted. A stray `v*` tag, one that never became a
Release, does not block later releases: only published Releases count, and drafts do not. Its version cannot be
released, so release the next one. To remove the tag anyway, an admin disables the `release tags` ruleset, deletes the
tag, and restores the ruleset exactly as it was.

**Known limit: a `v*` tag pushed by hand.** No ruleset limits who creates a `v*` tag, so anyone with write access can
push one by hand, pointing at any commit. Such a tag has no published Release, the forward-only check ignores it, and
Jelly installs only a published Release whose `SHA256SUMS` it verifies. But a user who installs
`github:joe-broadhead/opencode-release-rehearsal#v<x>` directly gets whatever that tag points at. Only the release workflow makes
release tags; never push one by hand.

The release kit is these files, the same in every plugin: `scripts/release-rules.mjs`, `scripts/release-commit.mjs`,
`scripts/release-github.mjs`, `scripts/check-release-shape.mjs`, `scripts/changelog.mjs`, `scripts/release-version.mjs`,
`scripts/release-pack.mjs`, `scripts/publish-release.mjs`, `scripts/attach-native.mjs`, `scripts/native-manifest.mjs`,
`scripts/tested-hosts.mjs`, `scripts/check-release-plugin-add.sh`, `scripts/release-kit.test.mjs` and
`.github/workflows/release.yml`. Do not re-run the older `apply-release-kit.mjs`: it writes back the kit that could
release only `v0.0.0`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the old entry with `opencode plugin remove github:joe-broadhead/opencode-tavily#v0.0.0`, then add the new tag with `opencode plugin add github:joe-broadhead/opencode-tavily#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-tavily#v0.0.1" }] }
```
