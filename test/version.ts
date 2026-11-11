// Preloaded by bunfig.toml for every `bun test`: the tests run src/, so they need the value the build defines there.
import { readFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
Object.assign(globalThis, { __PLUGIN_VERSION__: version })
