// Builds the two files the host loads, each self-contained: dist/index.js (the server part) and dist/tui.js (the TUI
// part). OpenCode reloads a plugin in place but keeps module records for unchanged paths, so a sibling module could
// be stale; with one file per entry there is none. Shared code, such as the RPC contract, is inlined into both.
// OpenTUI's JSX compiler skips node_modules, so Babel compiles the TUI's JSX first and the package ships no TSX.
// OpenCode supplies @opencode/plugin, OpenTUI and Solid at runtime, so they stay imports; the build fails if an
// output imports anything else.
import { transformAsync } from "@babel/core"
import typescript from "@babel/preset-typescript"
import solid from "babel-preset-solid"
import { build } from "esbuild"
import { readFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const HOST = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]
const allowed = (path) =>
  path.startsWith("node:") || HOST.some((name) => (name.endsWith("/*") ? path.startsWith(name.slice(0, -1)) : path === name))

/** Compiles `.tsx` with Solid's universal JSX transform for OpenTUI; esbuild handles plain `.ts`. */
const solidJsx = {
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await readFile(path, "utf8"), {
        babelrc: false,
        configFile: false,
        filename: path,
        presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [typescript]],
      })
      if (!result?.code) throw new Error(`build: Babel produced no output for ${path}.`)
      return { contents: result.code, loader: "js" }
    })
  },
}

const { version } = JSON.parse(await readFile(new URL("package.json", `file://${ROOT}`), "utf8"))

await rm(new URL("dist/", `file://${ROOT}`), { recursive: true, force: true })
const result = await build({
  absWorkingDir: ROOT,
  entryPoints: { index: "src/index.ts", tui: "src/tui/index.tsx" },
  outdir: "dist",
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  target: "es2023",
  external: HOST,
  plugins: [solidJsx],
  legalComments: "none",
  // src/version.ts: the version lives only in package.json.
  define: { __PLUGIN_VERSION__: JSON.stringify(version) },
  metafile: true,
  logLevel: "warning",
})

const outputs = Object.keys(result.metafile.outputs).sort()
if (outputs.join() !== "dist/index.js,dist/tui.js") throw new Error(`build: expected dist/index.js and dist/tui.js, got ${outputs.join(", ")}.`)
const unexpected = Object.entries(result.metafile.outputs).flatMap(([file, output]) =>
  output.imports.filter((entry) => !allowed(entry.path)).map((entry) => `${file}: ${entry.path}`),
)
if (unexpected.length > 0) throw new Error(`build: outputs import modules the host does not supply:\n  ${unexpected.join("\n  ")}`)
for (const [file, output] of Object.entries(result.metafile.outputs)) console.log(`built ${file} (${(output.bytes / 1024).toFixed(1)} KiB)`)
