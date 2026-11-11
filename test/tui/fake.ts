// A narrow fake of the TUI context, typed against the public @opencode/plugin/tui 2.2.3 API. No host source.
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { getOwner, onCleanup } from "solid-js"
import type { Status } from "../../src/rpc/index.js"

type Context = Plugin.Context
type Layer = ReturnType<Parameters<Context["keymap"]["layer"]>[0]>
type Command = NonNullable<Layer["commands"]>[number]
type Location = NonNullable<Context["location"]>
type Screen = Awaited<ReturnType<typeof testRender>>

export type FakeContext = Pick<Context, "location" | "theme"> & {
  readonly client: Pick<Context["client"], "rpc">
  readonly data: Pick<Context["data"], "on"> & { readonly location: Pick<Context["data"]["location"], "default"> }
  readonly keymap: Pick<Context["keymap"], "layer">
  readonly ui: { readonly dialog: Pick<Context["ui"]["dialog"], "show" | "set" | "clear"> }
}

export const LOCATION = { directory: "/tmp/tavily-tui-test" } as Location
export const DEFAULT_LOCATION = { directory: "/tmp/tavily-tui-default" } as Location

/** One `status` call that the test settles. */
export interface Call {
  readonly rpcID: string
  readonly input: unknown
  readonly options: { readonly location?: unknown; readonly signal?: AbortSignal }
  readonly resolve: (status: Status) => void
  readonly reject: (error: unknown) => void
}

const gray = RGBA.fromInts(128, 128, 128, 255)
const feedback = { base: gray, muted: gray }
// The view reads only the text colours of the dialog surface.
const theme: Context["theme"] = {
  text: { base: gray, muted: gray, faint: gray, feedback: { success: feedback, warning: feedback, error: feedback, info: feedback } },
  surface: () => theme,
} as unknown as Context["theme"]

export function fakeContext({ location }: { readonly location: Location | undefined } = { location: LOCATION }) {
  const calls: Call[] = []
  const layers = new Set<Layer>()
  const listeners = new Map<string, Set<() => void>>()
  const subscribed: string[] = []
  const dialog = {
    open: undefined as { readonly render: () => unknown; readonly onClose?: () => void } | undefined,
    screen: undefined as Screen | undefined,
    size: undefined as string | undefined,
  }

  // The host destroys a dialog's view and calls its onClose when the dialog is cleared or replaced.
  const close = () => {
    const current = dialog.open
    dialog.open = undefined
    dialog.screen?.renderer.destroy()
    dialog.screen = undefined
    current?.onClose?.()
  }

  // The real client calls `rpc.call` and rejects with the fetch AbortError when the signal aborts.
  const rpc = ((definition: { readonly id: string }) => ({
    status: (input: unknown, options: Call["options"] = {}) =>
      new Promise<Status>((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
        calls.push({ rpcID: definition.id, input, options, resolve, reject })
      }),
  })) as unknown as Context["client"]["rpc"]

  const context: FakeContext = {
    location,
    theme,
    client: { rpc },
    data: {
      on: (type: string, handler: (event: never) => void) => {
        subscribed.push(type)
        const listener = () => handler(undefined as never)
        const set = listeners.get(type) ?? new Set()
        listeners.set(type, set.add(listener))
        return () => set.delete(listener)
      },
      location: { default: () => DEFAULT_LOCATION },
    },
    keymap: {
      layer: (factory) => {
        const layer = factory()
        layers.add(layer)
        // The host removes a layer when the component that created it is disposed.
        if (getOwner()) onCleanup(() => layers.delete(layer))
      },
    },
    ui: {
      dialog: {
        show: (render, onClose) => {
          close()
          dialog.open = { render, onClose }
        },
        set: (options) => {
          dialog.size = options.size
        },
        clear: close,
      },
    },
  }

  const commands = () => [...layers].flatMap((layer) => (layer.commands ?? []).map((command) => ({ layer, command })))

  return {
    context,
    calls,
    layers,
    dialog,
    subscribed,
    /** Finds a reachable command by its key binding or id. */
    command(key: string): Command {
      const found = commands().find(({ command }) => command.bind === key || command.id === key)
      if (!found) throw new Error(`no command ${key}`)
      return found.command
    },
    hasCommand: (key: string) => commands().some(({ command }) => command.bind === key || command.id === key),
    layerOf: (key: string) => commands().find(({ command }) => command.bind === key || command.id === key)?.layer,
    emit: (type: string) => listeners.get(type)?.forEach((listener) => listener()),
    listeners: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    /** Renders the open dialog with the OpenTUI test renderer and returns its text. */
    async frame() {
      if (!dialog.open) throw new Error("no dialog is open")
      const open = dialog.open
      dialog.screen ??= await testRender(() => open.render() as ReturnType<Parameters<typeof testRender>[0]>, { width: 110, height: 30 })
      await dialog.screen.renderOnce()
      return dialog.screen.captureCharFrame()
    },
  }
}

/** Lets promise chains settle. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
