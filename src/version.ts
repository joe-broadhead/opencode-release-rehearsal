// The build (scripts/build.mjs) and the tests' preload (test/version.ts) replace __PLUGIN_VERSION__ with package.json's
// version, so no source repeats it.
declare const __PLUGIN_VERSION__: string

/** The plugin's version, as status reports it. */
export const PLUGIN_VERSION: string = __PLUGIN_VERSION__
