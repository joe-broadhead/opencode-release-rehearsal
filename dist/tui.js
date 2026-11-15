// src/tui/index.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { createSignal, For, Show } from "solid-js";

// src/rpc/index.ts
import { Rpc } from "@opencode/plugin/rpc";
var STATES = ["connected", "sign_in_required", "connecting", "failed", "disabled", "not_configured"];
var AUTH_SOURCES = ["oauth", "key_connected", "key_env", "user_server", "none"];
var KEY_CHECKS = ["accepted", "rejected", "unchecked"];
var STATE_LABELS = {
  connected: "connected",
  connecting: "connecting",
  sign_in_required: "sign-in required",
  failed: "failed",
  disabled: "disabled",
  not_configured: "not configured"
};
function accessText(status2) {
  switch (status2.access) {
    case "all":
      return 'every tool runs without asking: the five reads and any tool Tavily adds later. Set the access option to "ask-changes" or "read-only" to restrict a tool Tavily adds later.';
    case "read-only":
      return "the five reads run without asking, and any tool Tavily adds later is denied. All five only read from the web, so no value changes what they do.";
    case "ask-changes":
      return "the five reads run without asking; any tool Tavily adds later asks first. All five only read from the web, so no value changes what they do.";
  }
}
var AUTH_LABELS = {
  oauth: "OAuth (/connect \u2192 Tavily account)",
  key_connected: "API key (/connect \u2192 Tavily)",
  key_env: "API key from TAVILY_API_KEY",
  user_server: "your own tavily server in opencode.json",
  none: "none"
};
var KEY_CHECK_TEXT = {
  accepted: "accepted by Tavily",
  rejected: "rejected by Tavily",
  unchecked: "not checked: Tavily's API could not be reached"
};
var authText = (status2) => status2.keyCheck === void 0 ? AUTH_LABELS[status2.auth] : `${AUTH_LABELS[status2.auth]}, ${KEY_CHECK_TEXT[status2.keyCheck]}`;
function terminalKeyText(status2, terminalHasKey2) {
  if (!terminalHasKey2 || status2.auth !== "oauth" && status2.auth !== "none") return void 0;
  return "TAVILY_API_KEY is set in this terminal, but OpenCode's server does not see it, so Tavily uses OAuth. Run /connect and choose Tavily to connect the key.";
}
function toolsText(status2) {
  const { tools } = status2;
  if (tools.visible === 0) return "none listed yet";
  const posture = status2.access === "all" ? "new tools run too" : status2.access === "read-only" ? "new tools are denied" : "they ask first";
  const unknown = tools.unknown === 0 ? "" : `, ${tools.unknown} unknown (${posture}): ${tools.unknownNames.join(", ")}`;
  return `${tools.visible} available${unknown}`;
}
var websearchText = (status2) => status2.websearchDefault ? `Tavily, unless opencode.json sets "websearch"` : "not set by this plugin";
var accountText = (status2) => status2.account ?? "none";
var agentsText = (status2) => status2.unguardedAgents.length === 0 ? "none" : status2.unguardedAgents.join(", ");
var skillsText = (status2) => status2.shadowedSkills === void 0 ? "the plugin's own" : status2.shadowedSkills.map((skill) => `${skill.id} replaced by ${skill.path}`).join("; ");
var hostText = ({ host }) => `${host.version ?? "unknown version"} (${host.tested ? "tested" : `untested; supported range ${host.range}`})`;
var blockLines = (block) => block.map((rule2, index) => `${JSON.stringify(rule2)}${index < block.length - 1 ? "," : ""}`);
var strings = { type: "array", items: { type: "string" } };
var rule = {
  type: "object",
  properties: {
    action: { type: "string" },
    resource: { type: "string" },
    effect: { type: "string", enum: ["allow", "deny", "ask"] }
  },
  required: ["action", "resource", "effect"],
  additionalProperties: false
};
var status = {
  type: "object",
  properties: {
    version: { type: "string" },
    state: { type: "string", enum: [...STATES] },
    access: { type: "string", enum: ["all", "ask-changes", "read-only"] },
    auth: { type: "string", enum: [...AUTH_SOURCES] },
    account: { type: "string" },
    keyCheck: { type: "string", enum: [...KEY_CHECKS] },
    tools: {
      type: "object",
      properties: { visible: { type: "integer" }, unknown: { type: "integer" }, unknownNames: strings },
      required: ["visible", "unknown", "unknownNames"],
      additionalProperties: false
    },
    websearchDefault: { type: "boolean" },
    host: {
      type: "object",
      properties: { version: { type: ["string", "null"] }, range: { type: "string" }, tested: { type: "boolean" } },
      required: ["version", "range", "tested"],
      additionalProperties: false
    },
    unguardedAgents: strings,
    permissionsBlock: { type: "array", items: rule },
    shadowedSkills: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, path: { type: "string" } },
        required: ["id", "path"],
        additionalProperties: false
      }
    },
    nextStep: { type: "string" }
  },
  required: ["version", "state", "access", "auth", "tools", "websearchDefault", "host", "unguardedAgents", "nextStep"],
  additionalProperties: false
};
var Tavily = Rpc.define({
  id: "rehearsal.kit",
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: status,
      errors: {
        unavailable: {
          type: "object",
          properties: { nextStep: { type: "string" } },
          required: ["nextStep"],
          additionalProperties: false
        }
      }
    }
  },
  events: {}
});

// src/tui/index.tsx
var TONE = {
  connected: "success",
  connecting: "warning",
  sign_in_required: "warning",
  failed: "error",
  disabled: "warning",
  not_configured: "error"
};
var REFRESH_ON = ["server.connected", "mcp.status.changed", "agent.updated", "integration.updated", "credential.updated", "credential.switched"];
var RETRY = "Run /tavily-status in a session, and restart OpenCode if that fails too.";
function unavailable(error) {
  const known = typeof error === "object" && error !== null;
  const message = known && "message" in error ? `${error.message}` : `${error}`;
  const data = known && "data" in error ? error.data : void 0;
  const declared = typeof data === "object" && data !== null && "nextStep" in data ? data.nextStep : void 0;
  const nextStep = (typeof declared === "string" ? declared : void 0) ?? RETRY;
  return {
    state: "unavailable",
    message,
    nextStep
  };
}
function Row(props) {
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "gap", 1);
    _$setProp(_el$2, "width", 29);
    _$setProp(_el$2, "flexShrink", 0);
    _$insert(_el$2, () => props.label);
    _$setProp(_el$3, "flexGrow", 1);
    _$setProp(_el$3, "wrapMode", "word");
    _$insert(_el$3, () => props.value);
    _$effect((_p$) => {
      var _v$ = props.muted, _v$2 = props.fg;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$;
  })();
}
function StatusDialog(props) {
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [{
      id: "rehearsal.kit.tui.refresh",
      title: "Refresh Tavily status",
      group: "Tavily",
      bind: "r",
      run: () => props.refresh()
    }, {
      title: "Close Tavily status",
      group: "Tavily",
      bind: "escape",
      run: () => props.context.ui.dialog.clear()
    }]
  }));
  const theme = () => props.context.theme.surface("dialog");
  const tone = (value) => theme().text.feedback[value].base;
  const ready = () => props.view.state === "ready" ? props.view.status : void 0;
  const failure = () => props.view.state === "unavailable" ? props.view : void 0;
  return (() => {
    var _el$4 = _$createElement("box"), _el$5 = _$createElement("box"), _el$6 = _$createElement("text"), _el$8 = _$createElement("text");
    _$insertNode(_el$4, _el$5);
    _$setProp(_el$4, "flexDirection", "column");
    _$setProp(_el$4, "gap", 1);
    _$setProp(_el$4, "paddingLeft", 2);
    _$setProp(_el$4, "paddingRight", 2);
    _$setProp(_el$4, "paddingBottom", 1);
    _$insertNode(_el$5, _el$6);
    _$insertNode(_el$5, _el$8);
    _$setProp(_el$5, "flexDirection", "row");
    _$setProp(_el$5, "justifyContent", "space-between");
    _$insertNode(_el$6, _$createTextNode(`Tavily status`));
    _$insert(_el$8, () => props.refreshing && props.view.state !== "loading" ? "refreshing\u2026" : "r refresh \xB7 esc close");
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return props.view.state === "loading";
      },
      get children() {
        var _el$9 = _$createElement("text");
        _$insertNode(_el$9, _$createTextNode(`Loading Tavily status\u2026`));
        _$effect((_$p) => _$setProp(_el$9, "fg", theme().text.muted, _$p));
        return _el$9;
      }
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return ready();
      },
      children: (status2) => (() => {
        var _el$1 = _$createElement("box");
        _$setProp(_el$1, "flexDirection", "column");
        _$insert(_el$1, _$createComponent(Row, {
          label: "Connection",
          get value() {
            return STATE_LABELS[status2().state];
          },
          get fg() {
            return tone(TONE[status2().state]);
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$insert(_el$1, _$createComponent(Row, {
          label: "Account",
          get value() {
            return accountText(status2());
          },
          get fg() {
            return theme().text.base;
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$insert(_el$1, _$createComponent(Row, {
          label: "Access",
          get value() {
            return accessText(status2());
          },
          get fg() {
            return theme().text.base;
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$insert(_el$1, _$createComponent(Row, {
          label: "Sign-in",
          get value() {
            return authText(status2());
          },
          get fg() {
            return _$memo(() => status2().keyCheck === "rejected")() ? tone("error") : theme().text.base;
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$insert(_el$1, _$createComponent(Show, {
          get when() {
            return terminalKeyText(status2(), props.terminalHasKey);
          },
          children: (text) => _$createComponent(Row, {
            label: "Terminal key",
            get value() {
              return text();
            },
            get fg() {
              return tone("warning");
            },
            get muted() {
              return theme().text.muted;
            }
          })
        }), null);
        _$insert(_el$1, _$createComponent(Row, {
          label: "Web search",
          get value() {
            return websearchText(status2());
          },
          get fg() {
            return theme().text.base;
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$insert(_el$1, _$createComponent(Row, {
          label: "Skills",
          get value() {
            return skillsText(status2());
          },
          get fg() {
            return _$memo(() => status2().shadowedSkills === void 0)() ? theme().text.base : tone("warning");
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$insert(_el$1, _$createComponent(Row, {
          label: "Tools",
          get value() {
            return toolsText(status2());
          },
          get fg() {
            return _$memo(() => status2().tools.unknown === 0)() ? theme().text.base : tone("warning");
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$insert(_el$1, _$createComponent(Row, {
          label: "Agents without default rules",
          get value() {
            return agentsText(status2());
          },
          get fg() {
            return _$memo(() => status2().unguardedAgents.length > 0)() ? tone("warning") : theme().text.base;
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$insert(_el$1, _$createComponent(For, {
          get each() {
            return blockLines(status2().permissionsBlock ?? []);
          },
          children: (line) => (() => {
            var _el$10 = _$createElement("text");
            _$setProp(_el$10, "paddingLeft", 30);
            _$insert(_el$10, line);
            _$effect((_$p) => _$setProp(_el$10, "fg", theme().text.base, _$p));
            return _el$10;
          })()
        }), null);
        _$insert(_el$1, _$createComponent(Row, {
          label: "OpenCode",
          get value() {
            return hostText(status2());
          },
          get fg() {
            return _$memo(() => !!status2().host.tested)() ? theme().text.base : tone("warning");
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$insert(_el$1, _$createComponent(Row, {
          label: "Next step",
          get value() {
            return status2().nextStep;
          },
          get fg() {
            return theme().text.base;
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        return _el$1;
      })()
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return failure();
      },
      children: (failed) => (() => {
        var _el$11 = _$createElement("box"), _el$12 = _$createElement("text"), _el$14 = _$createElement("text");
        _$insertNode(_el$11, _el$12);
        _$insertNode(_el$11, _el$14);
        _$setProp(_el$11, "flexDirection", "column");
        _$insertNode(_el$12, _$createTextNode(`Tavily status unavailable`));
        _$setProp(_el$14, "wrapMode", "word");
        _$insert(_el$14, () => failed().message);
        _$insert(_el$11, _$createComponent(Row, {
          label: "Next step",
          get value() {
            return failed().nextStep;
          },
          get fg() {
            return theme().text.base;
          },
          get muted() {
            return theme().text.muted;
          }
        }), null);
        _$effect((_p$) => {
          var _v$6 = tone("error"), _v$7 = theme().text.muted;
          _v$6 !== _p$.e && (_p$.e = _$setProp(_el$12, "fg", _v$6, _p$.e));
          _v$7 !== _p$.t && (_p$.t = _$setProp(_el$14, "fg", _v$7, _p$.t));
          return _p$;
        }, {
          e: void 0,
          t: void 0
        });
        return _el$11;
      })()
    }), null);
    _$effect((_p$) => {
      var _v$3 = theme().text.base, _v$4 = TextAttributes.BOLD, _v$5 = theme().text.muted;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$6, "fg", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$6, "attributes", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$8, "fg", _v$5, _p$.a));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0
    });
    return _el$4;
  })();
}
var terminalHasKey = () => Boolean(globalThis.process?.env.TAVILY_API_KEY);
var plugin = {
  id: "rehearsal.kit.tui",
  setup(context) {
    const [view, setView] = createSignal({
      state: "loading"
    });
    const [refreshing, setRefreshing] = createSignal(false);
    let controller;
    let open;
    let stops = [];
    const unsubscribe = () => {
      for (const stop of stops.splice(0)) stop();
    };
    const refresh = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      setRefreshing(true);
      context.client.rpc(Tavily).status({}, {
        location: context.location ?? context.data.location.default(),
        signal: current.signal
      }).then((status2) => ({
        state: "ready",
        status: status2
      }), unavailable).then((next) => {
        if (current.signal.aborted) return;
        setView(next);
        setRefreshing(false);
      });
    };
    const show = () => {
      const token = {};
      setView({
        state: "loading"
      });
      context.ui.dialog.show(() => _$createComponent(StatusDialog, {
        context,
        get view() {
          return view();
        },
        get refreshing() {
          return refreshing();
        },
        refresh,
        get terminalHasKey() {
          return terminalHasKey();
        }
      }), () => {
        if (open !== token) return;
        open = void 0;
        unsubscribe();
        controller?.abort();
      });
      context.ui.dialog.set({
        size: "large"
      });
      open = token;
      unsubscribe();
      stops = REFRESH_ON.map((type) => context.data.on(type, refresh));
      refresh();
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "rehearsal.kit.tui.status",
        title: "Tavily: Status",
        description: "Show Tavily's connection, sign-in, tools, web search default and next step",
        group: "Tavily",
        palette: true,
        slash: {
          name: "rehearsal"
        },
        run: show
      }]
    }));
    return () => {
      unsubscribe();
      controller?.abort();
      if (open) context.ui.dialog.clear();
    };
  }
};
var tui_default = plugin;
export {
  tui_default as default
};
