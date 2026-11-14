import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type RGBA } from "@opentui/core"
import { createSignal, For, Show } from "solid-js"
import {
  accessText,
  accountText,
  agentsText,
  authText,
  blockLines,
  hostText,
  skillsText,
  STATE_LABELS,
  Tavily,
  terminalKeyText,
  toolsText,
  websearchText,
  type Status,
} from "../rpc/index.js"

type View =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly status: Status }
  | { readonly state: "unavailable"; readonly message: string; readonly nextStep: string }

type Tone = "success" | "warning" | "error"

/** Wide enough for the longest label, "Agents without default rules". */
const LABEL_WIDTH = 29

const TONE: Record<Status["state"], Tone> = {
  connected: "success",
  connecting: "warning",
  sign_in_required: "warning",
  failed: "error",
  disabled: "warning",
  not_configured: "error",
}

/** Events after which the open dialog can be out of date: a reconnect, the server's state, agents, credentials. */
const REFRESH_ON = [
  "server.connected",
  "mcp.status.changed",
  "agent.updated",
  "integration.updated",
  "credential.updated",
  "credential.switched",
] as const

const RETRY = "Run /tavily-status in a session, and restart OpenCode if that fails too."

/** The RPC client rejects with `{ type, message, data }` for the errors a method declares, such as `unavailable`. */
function unavailable(error: unknown): View {
  const known = typeof error === "object" && error !== null
  const message = known && "message" in error ? `${error.message}` : `${error}`
  const data = known && "data" in error ? error.data : undefined
  const declared = typeof data === "object" && data !== null && "nextStep" in data ? data.nextStep : undefined
  const nextStep = (typeof declared === "string" ? declared : undefined) ?? RETRY
  return { state: "unavailable", message, nextStep }
}

function Row(props: { readonly label: string; readonly value: string; readonly fg: RGBA; readonly muted: RGBA }) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.muted} width={LABEL_WIDTH} flexShrink={0}>
        {props.label}
      </text>
      <text fg={props.fg} flexGrow={1} wrapMode="word">
        {props.value}
      </text>
    </box>
  )
}

function StatusDialog(props: {
  readonly context: Plugin.Context
  readonly view: View
  readonly refreshing: boolean
  readonly refresh: () => void
  /** This terminal has TAVILY_API_KEY set; its value is never read. */
  readonly terminalHasKey: boolean
}) {
  // Created inside the dialog, so the host removes the layer when the dialog closes.
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { id: "rehearsal.kit.tui.refresh", title: "Refresh Tavily status", group: "Tavily", bind: "r", run: () => props.refresh() },
      { title: "Close Tavily status", group: "Tavily", bind: "escape", run: () => props.context.ui.dialog.clear() },
    ],
  }))
  const theme = () => props.context.theme.surface("dialog")
  const tone = (value: Tone) => theme().text.feedback[value].base
  const ready = () => (props.view.state === "ready" ? props.view.status : undefined)
  const failure = () => (props.view.state === "unavailable" ? props.view : undefined)
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          Tavily status
        </text>
        <text fg={theme().text.muted}>
          {props.refreshing && props.view.state !== "loading" ? "refreshing…" : "r refresh · esc close"}
        </text>
      </box>
      <Show when={props.view.state === "loading"}>
        <text fg={theme().text.muted}>Loading Tavily status…</text>
      </Show>
      <Show when={ready()}>
        {(status) => (
          <box flexDirection="column">
            <Row
              label="Connection"
              value={STATE_LABELS[status().state]}
              fg={tone(TONE[status().state])}
              muted={theme().text.muted}
            />
            <Row label="Account" value={accountText(status())} fg={theme().text.base} muted={theme().text.muted} />
            <Row label="Access" value={accessText(status())} fg={theme().text.base} muted={theme().text.muted} />
            <Row
              label="Sign-in"
              value={authText(status())}
              fg={status().keyCheck === "rejected" ? tone("error") : theme().text.base}
              muted={theme().text.muted}
            />
            <Show when={terminalKeyText(status(), props.terminalHasKey)}>
              {(text) => <Row label="Terminal key" value={text()} fg={tone("warning")} muted={theme().text.muted} />}
            </Show>
            <Row label="Web search" value={websearchText(status())} fg={theme().text.base} muted={theme().text.muted} />
            <Row
              label="Skills"
              value={skillsText(status())}
              fg={status().shadowedSkills === undefined ? theme().text.base : tone("warning")}
              muted={theme().text.muted}
            />
            <Row
              label="Tools"
              value={toolsText(status())}
              fg={status().tools.unknown === 0 ? theme().text.base : tone("warning")}
              muted={theme().text.muted}
            />
            <Row
              label="Agents without default rules"
              value={agentsText(status())}
              fg={status().unguardedAgents.length > 0 ? tone("warning") : theme().text.base}
              muted={theme().text.muted}
            />
            <For each={blockLines(status().permissionsBlock ?? [])}>
              {(line) => (
                <text fg={theme().text.base} paddingLeft={LABEL_WIDTH + 1}>
                  {line}
                </text>
              )}
            </For>
            <Row
              label="OpenCode"
              value={hostText(status())}
              fg={status().host.tested ? theme().text.base : tone("warning")}
              muted={theme().text.muted}
            />
            <Row label="Next step" value={status().nextStep} fg={theme().text.base} muted={theme().text.muted} />
          </box>
        )}
      </Show>
      <Show when={failure()}>
        {(failed) => (
          <box flexDirection="column">
            <text fg={tone("error")}>Tavily status unavailable</text>
            <text fg={theme().text.muted} wrapMode="word">
              {failed().message}
            </text>
            <Row label="Next step" value={failed().nextStep} fg={theme().text.base} muted={theme().text.muted} />
          </box>
        )}
      </Show>
    </box>
  )
}

/** The TUI runs in the user's terminal, so this is the terminal's environment, not the server's. */
const terminalHasKey = () => Boolean(globalThis.process?.env.TAVILY_API_KEY)

const plugin: Plugin.Definition = {
  id: "rehearsal.kit.tui",
  setup(context) {
    const [view, setView] = createSignal<View>({ state: "loading" })
    const [refreshing, setRefreshing] = createSignal(false)
    let controller: AbortController | undefined
    // Identifies the open dialog; showing another dialog closes this one.
    let open: object | undefined
    // Event listeners live only while the dialog is open.
    let stops: (() => void)[] = []
    const unsubscribe = () => {
      for (const stop of stops.splice(0)) stop()
    }

    const refresh = () => {
      controller?.abort()
      const current = new AbortController()
      controller = current
      setRefreshing(true)
      context.client
        .rpc(Tavily)
        .status({}, { location: context.location ?? context.data.location.default(), signal: current.signal })
        // A JSON Schema output is `unknown` to the client; the server has already validated it against `Status`'s schema.
        .then((status): View => ({ state: "ready", status: status as Status }), unavailable)
        .then((next) => {
          if (current.signal.aborted) return
          setView(next)
          setRefreshing(false)
        })
    }

    const show = () => {
      const token = {}
      setView({ state: "loading" })
      context.ui.dialog.show(
        () => (
          <StatusDialog
            context={context}
            view={view()}
            refreshing={refreshing()}
            refresh={refresh}
            terminalHasKey={terminalHasKey()}
          />
        ),
        () => {
          if (open !== token) return
          open = undefined
          unsubscribe()
          controller?.abort()
        },
      )
      context.ui.dialog.set({ size: "large" })
      open = token
      unsubscribe()
      stops = REFRESH_ON.map((type) => context.data.on(type, refresh))
      refresh()
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "rehearsal.kit.tui.status",
          title: "Tavily: Status",
          description: "Show Tavily's connection, sign-in, tools, web search default and next step",
          group: "Tavily",
          palette: true,
          slash: { name: "rehearsal" },
          run: show,
        },
      ],
    }))

    return () => {
      unsubscribe()
      controller?.abort()
      if (open) context.ui.dialog.clear()
    }
  },
}

export default plugin
