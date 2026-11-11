#!/bin/sh
# Installs a release tag as a Git plugin on one stock OpenCode host, in an isolated HOME, and checks that the plugin
# loads: the running service lists it at the tag, its status RPC answers, and its skill is listed. The release workflow
# runs it once per host; it runs locally the same way, with no other change.
#
#   sh scripts/check-release-plugin-add.sh <host version> <checkout dir> <tag> <work dir> <skill id> <status rpc id>
#
# The stock host is the @opencode/cli package at that version, from npm, installed with lifecycle scripts off. Nothing
# here reads or writes a credential, and the work dir is removed first. A status that reports tested: false for this
# host is printed as a warning: the plugin loads, but its own TESTED_HOSTS does not list the host.
set -eu

if [ "$#" -ne 6 ]; then
  echo "usage: $0 <host version> <checkout dir> <tag> <work dir> <skill id> <status rpc id>" >&2
  exit 2
fi
version="$1"
checkout="$2"
tag="$3"
work="$4"
skill="$5"
rpc="$6"

fail() {
  echo "check-release-plugin-add: $version: $1" >&2
  exit 1
}

stop() {
  "$bin" service stop >/dev/null 2>&1 || true
}

rm -rf "$work"
mkdir -p "$work/stock" "$work/home" "$work/project"
npm install --prefix "$work/stock" --ignore-scripts --no-audit --no-fund "@opencode/cli@$version" > "$work/npm.txt" 2>&1 || { tail -n 20 "$work/npm.txt" >&2; fail "could not install @opencode/cli@$version"; }
# BEGIN select-binary
# The stock binary for this machine: the platform package named for it (linux-x64, darwin-arm64, ...). npm installs every
# optional package whose os and cpu fit, so a Linux machine also gets the musl and baseline builds. Those are never picked:
# a musl build needs /lib/ld-musl, which a glibc system does not have, and `find | head -n 1` picked one by directory order
# (tavily's release run, 2026-11-11: "could not set the service port").
platform="$(node -p 'process.platform + "-" + process.arch')"
bin="$work/stock/node_modules/@opencode/cli-$platform/bin/opencode"
[ -f "$bin" ] || fail "no @opencode/cli-$platform binary in @opencode/cli@$version: the platform package for this machine is missing"
chmod +x "$bin"
"$bin" --version > "$work/version.txt" 2>&1 || { cat "$work/version.txt" >&2; fail "the $platform binary does not run"; }
# END select-binary

# An isolated profile: its own HOME (so the global plugin config is this one) and its own service port.
export HOME="$work/home"
(cd "$work/project" && git init -q)
port="$(node -e 'const s = require("net").createServer(); s.listen(0, () => { console.log(s.address().port); s.close() })')"
"$bin" service set port "$port" > "$work/port.txt" 2>&1 || { cat "$work/port.txt" >&2; fail "could not set the service port"; }

"$bin" plugin add "git+file://$checkout#$tag" >"$work/add.log" 2>&1 || { cat "$work/add.log" >&2; fail "plugin add of $tag failed"; }

"$bin" service start >"$work/service.log" 2>&1 || { cat "$work/service.log" >&2; fail "the service did not start"; }

# Plugins load after the server answers, so the status RPC is the wait.
status=""
i=0
while [ "$i" -lt 90 ]; do
  status="$("$bin" api POST "/api/rpc/$rpc/status" -H "x-opencode-directory: $work/project" -d '{"input":{}}' 2>/dev/null || true)"
  case "$status" in *'"state"'*) break ;; esac
  i=$((i + 1))
  sleep 1
done
case "$status" in *'"state"'*) ;; *) stop; fail "the status RPC $rpc did not answer" ;; esac

(cd "$work/project" && "$bin" plugin list >"$work/plugins.txt" 2>&1) || { stop; fail "plugin list failed"; }
grep -q "#$tag" "$work/plugins.txt" || { cat "$work/plugins.txt" >&2; stop; fail "the plugin list does not show $tag"; }

skills="$("$bin" api GET /api/skill -H "x-opencode-directory: $work/project" 2>/dev/null || true)"
case "$skills" in *"\"id\":\"$skill\""*) ;; *) stop; fail "the skill $skill is not listed" ;; esac

stop
case "$status" in *'"tested":true'*) tested="tested on $version" ;; *) tested="WARN: the plugin reports tested: false on $version" ;; esac
echo "ok: $version loads $tag ($rpc status answers, skill $skill is listed; $tested)"
