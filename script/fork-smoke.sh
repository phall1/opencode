#!/usr/bin/env bash
# Exercise the installed artifact without starting/replacing any managed service.
set -euo pipefail
binary="${1:?binary required}"
version="${OPENCODE_VERSION:?fork build version required}"
# Avoid shims that consult the host's trust store after HOME is isolated.
json_tool=''
while IFS= read -r candidate; do
  [[ "$candidate" == */mise/shims/* ]] && continue
  json_tool="$candidate"
  break
done < <(type -ap jq)
[[ -n "$json_tool" ]] || { echo 'A native jq executable is required for isolated smoke checks' >&2; exit 1; }
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export HOME="$root" XDG_DATA_HOME="$root/data" XDG_STATE_HOME="$root/state" XDG_CACHE_HOME="$root/cache" XDG_CONFIG_HOME="$root/config"
export OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_PROJECT_CONFIG=1
[[ "$("$binary" --version)" == "opencode v$version" ]]
[[ "$("$binary" debug paths db)" == "$root/data/opencode/opencode-fork.db" ]]
"$binary" api get /api/info --standalone > "$root/info.json"
# shellcheck disable=SC2016 # jq receives its version variable through --arg.
"$json_tool" -e --arg version "$version" '.version == $version and .pid > 0' "$root/info.json" >/dev/null
if "$binary" upgrade 2.0.0 --method curl > "$root/upgrade.log" 2>&1; then
  echo 'Fork unexpectedly allowed an upstream upgrade' >&2
  exit 1
fi
grep -q 'opencode-fork-update' "$root/upgrade.log"
echo "Fork artifact smoke passed: $version"
