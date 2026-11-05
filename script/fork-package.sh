#!/usr/bin/env bash
# Package an already-built fork executable. No model calls, installs or publishing.
set -euo pipefail
target="${1:?target required}"
binary="${2:?binary required}"
output="${3:?output directory required}"
commit="${GITHUB_SHA:?full source commit required}"
version="${OPENCODE_VERSION:?fork build version required}"
[[ "$target" =~ ^(darwin|linux)-(arm64|x64)$ ]] || { echo 'Unsupported fork target' >&2; exit 1; }
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid source commit' >&2; exit 1; }
[[ "$version" =~ ^0\.0\.0-fork-[0-9]+(\.[0-9]+)?$ ]] || { echo 'Invalid fork version' >&2; exit 1; }
[[ -f "$binary" && ! -L "$binary" ]] || { echo 'Expected a regular executable' >&2; exit 1; }
mkdir -p "$output"
output="$(cd "$output" && pwd)"
archive="opencode-fork-$target.tar.gz"
[[ ! -e "$output/$archive" ]] || { echo 'Refusing to overwrite an archive' >&2; exit 1; }
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/bin"
cp "$binary" "$stage/bin/opencode"
chmod 755 "$stage/bin/opencode"
tar -czf "$output/$archive" -C "$stage" bin/opencode
jq -n --arg commit "$commit" --arg buildVersion "$version" --arg target "$target" \
  '{version:1,repository:"phall1/opencode",commit:$commit,channel:"fork",buildVersion:$buildVersion,targets:[$target]}' \
  > "$output/manifest-$target.json"
(cd "$output" && shasum -a 256 "$archive" > "SHA256SUMS-$target")
