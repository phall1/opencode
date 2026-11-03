#!/usr/bin/env bash
# Keep phall1/opencode `v2` merged with upstream `dev`. Meant for a scheduled
# runner (launchd/cron) in a dedicated worktree, never a working checkout.
#
#   script/fork-sync.sh            merge, verify, publish, land when clean
#   FORK_SYNC_DRY_RUN=1 ...        merge and verify locally; publish nothing
#   FORK_SYNC_BRANCH=...           bot-owned sync branch and PR (upstream-sync)
#   FORK_SYNC_AGENT='opencode run --auto' ...
#                                  let an agent repair conflicts or checks;
#                                  repaired syncs follow the same CI-gated
#                                  publication and landing path as clean merges
#
# Clean merges land only after `bun run check` passes locally and the fork's
# CI passes on the PR. Anything else opens or updates the tracking issue when
# the repository has issues enabled; the message is always logged to stderr.
# Every attempt reuses one bot-owned branch and PR, so review never fragments;
# only that branch is force-updated, never the base branch's history.
# Exit: 0 current or landed, 2 needs attention.
set -euo pipefail

repo="${FORK_SYNC_REPO:-phall1/opencode}"
base="${FORK_SYNC_BASE:-v2}"
upstream_url="${FORK_SYNC_UPSTREAM_URL:-https://github.com/anomalyco/opencode.git}"
upstream_branch="${FORK_SYNC_UPSTREAM_BRANCH:-dev}"
sync_branch="${FORK_SYNC_BRANCH:-upstream-sync}"
issue_title="Upstream sync needs attention"
# Upstream workflows that arrive with a merge start enabled; only these stay on.
allowed_workflows=(.github/workflows/replay-native.yml)

log() { printf '[fork-sync] %s\n' "$*" >&2; }
dry() { [[ "${FORK_SYNC_DRY_RUN:-0}" == 1 ]]; }

# A scheduler's PATH can lag the checkout's packageManager pin. Keep installs,
# checks and post-repair verification on that runtime without changing globals.
with_bun() {
  local version
  version="$(command bun -p "require('./package.json').packageManager.slice(4)")" || return 1
  if [[ "$(command bun --version)" == "$version" ]]; then
    "$@"
    return
  fi
  if ! command -v mise >/dev/null 2>&1; then
    log "Bun $version is required; put it on PATH or install mise to select it"
    return 1
  fi
  mise exec "bun@$version" -- "$@"
}

main() {
  cd "$(git rev-parse --show-toplevel)"
  [[ -z "$(git status --porcelain)" ]] || { log 'worktree is dirty; refusing to run'; exit 2; }
  git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$upstream_url"
  git fetch --quiet origin "$base"
  git fetch --quiet upstream "$upstream_branch"
  local behind
  behind="$(git rev-list --count "origin/$base..upstream/$upstream_branch")"
  if [[ "$behind" == 0 ]]; then
    log "origin/$base already contains upstream/$upstream_branch"
    exit 0
  fi
  local upstream_sha branch repaired=0
  upstream_sha="$(git rev-parse --short "upstream/$upstream_branch")"
  branch="$sync_branch"
  log "merging $behind upstream commits ($upstream_sha) into $branch"
  git checkout --quiet -B "$branch" "origin/$base"

  if ! merge_upstream || ! verify; then
    repair "$behind" || attention "Merging $behind commits from upstream/$upstream_branch ($upstream_sha) needs a human or agent: $(failure_summary)"
    repaired=1
  fi
  dry && { log "dry run: verified $branch locally; nothing published"; park; exit 0; }

  push_branch "$branch"
  supersede_other_prs "$branch"
  local pr
  pr="$(open_pr "$branch" "$behind" "$repaired")"
  if ! wait_for_checks "$pr"; then
    repair_ci "$pr" "$behind" || attention "Upstream sync PR $pr needs attention: $(failure_summary)"
  fi
  gh pr merge "$pr" --repo "$repo" --merge --delete-branch --match-head-commit "$(git rev-parse HEAD)"
  disable_new_workflows
  close_issue
  park
  log "landed $pr"
}

# Only this script owns `upstream-sync`; replacing it advances the single open
# PR without rewriting any history that has already landed on the base branch.
push_branch() {
  local branch="$1" remote_sha
  remote_sha="$(git ls-remote --heads origin "refs/heads/$branch" | cut -f1)"
  with_bun git push --quiet --force-with-lease="refs/heads/$branch:$remote_sha" origin "$branch"
}

# Earlier runs opened one PR per upstream sha; retire those so a single open PR
# always describes the current attempt.
supersede_other_prs() {
  local branch="$1" number head
  while IFS=$'\t' read -r number head; do
    [[ -n "$number" && "$head" != "$branch" ]] || continue
    if gh pr close "$number" --repo "$repo" --delete-branch --comment 'Superseded by a newer sync attempt.' >/dev/null; then
      log "closed superseded sync PR #$number ($head)"
    else
      log "could not close superseded sync PR #$number ($head)"
    fi
  done < <(gh pr list --repo "$repo" --state open --json number,headRefName \
    --jq '.[] | "\(.number)\t\(.headRefName)"' | awk -F'\t' '$2 ~ /^upstream-sync(-|$)/')
}

pr_head() { gh pr view "$1" --repo "$repo" --json headRefOid --jq .headRefOid 2>/dev/null; }

# A reused PR keeps checks from its previous head, and CI registers a few
# seconds after a push, so watch only once the PR reports our commit.
wait_for_checks() {
  local pr="$1" head state=MISSING
  head="$(git rev-parse HEAD)"
  for _ in $(seq 1 40); do
    [[ "$(pr_head "$pr")" == "$head" ]] || { sleep 5; continue; }
    state="$(replay_state "$pr")"
    [[ "$state" != MISSING ]] && break
    sleep 5
  done
  [[ "$(pr_head "$pr")" == "$head" ]] || { FAILURE="PR $pr is not at $head"; return 1; }
  [[ "$state" != MISSING ]] || { FAILURE="replay-native check did not register for $head"; return 1; }
  if ! gh pr checks "$pr" --repo "$repo" --watch --interval 30 >/dev/null 2>&1; then
    FAILURE="CI failed for $head: $(gh pr checks "$pr" --repo "$repo" 2>&1 || true)"
    return 1
  fi
  [[ "$(pr_head "$pr")" == "$head" ]] || { FAILURE="PR $pr changed while waiting for CI"; return 1; }
  state="$(replay_state "$pr")"
  [[ "$state" == SUCCESS ]] || { FAILURE="replay-native check is $state, not SUCCESS, for $head"; return 1; }
}

# Skipped or unrelated checks must not authorize landing, even when gh exits 0.
replay_state() {
  local state
  state="$(gh pr checks "$1" --repo "$repo" --json name,state,workflow \
    --jq '[.[] | select(.workflow == "replay-native" and .name == "replay") | .state] | if length == 1 then .[0] else "MISSING" end' 2>/dev/null)" || true
  printf '%s\n' "${state:-MISSING}"
}

# One CI repair per attempt, with the failing run's diagnostics. Never loop
# indefinitely or merge a repair that has not passed fresh checks on its own head.
repair_ci() {
  local pr="$1" behind="$2" run
  run="$(gh run list --repo "$repo" --commit "$(git rev-parse HEAD)" --workflow replay-native.yml --json databaseId --jq '.[0].databaseId' 2>/dev/null)" || return 1
  if [[ -n "$run" ]]; then
    FAILURE="$FAILURE
$(gh run view "$run" --repo "$repo" --log-failed 2>&1 | tail -n 120)"
  fi
  repair "$behind" || return 1
  push_branch "$sync_branch" || return 1
  open_pr "$sync_branch" "$behind" 1 >/dev/null || return 1
  wait_for_checks "$pr"
}

# Leave the worktree detached so local sync branches never accumulate.
park() {
  local branch
  branch="$(git branch --show-current)"
  git checkout --quiet --detach "origin/$base"
  [[ -z "$branch" ]] || git branch --quiet -D "$branch"
}

# A lockfile-only conflict is mechanical: take upstream's and regenerate.
merge_upstream() {
  if ! git merge --quiet --no-edit "upstream/$upstream_branch" >/dev/null; then
    local conflicts
    conflicts="$(git diff --name-only --diff-filter=U)"
    [[ "$conflicts" == bun.lock ]] || { FAILURE="conflicts: $(paste -sd, - <<< "$conflicts")"; return 1; }
    git checkout --quiet --theirs bun.lock
    with_bun bun install >/dev/null
    git add bun.lock
    git commit --quiet --no-edit
  fi
  with_bun bun install >/dev/null
  if [[ -n "$(git status --porcelain bun.lock)" ]]; then
    git add bun.lock
    git commit --quiet -m 'chore: regenerate lockfile after upstream sync'
  fi
}

verify() {
  local output
  if output="$(with_bun bun run check 2>&1)"; then return 0; fi
  FAILURE="bun run check failed: $(tail -n 20 <<< "$output")"
  return 1
}

# Bounded agent attempt in this worktree; the result must still pass checks
# locally and in CI before the script publishes and lands it.
repair() {
  [[ -n "${FORK_SYNC_AGENT:-}" ]] || return 1
  local behind="$1"
  log "asking agent to repair: $FAILURE"
  # shellcheck disable=SC2086 # FORK_SYNC_AGENT is an intentional command line.
  $FORK_SYNC_AGENT "This worktree is merging $behind commits from upstream/$upstream_branch into the $repo fork branch $base and stopped with: $FAILURE. Read AGENTS.md and FORK.md. Resolve conflicts or failing checks preserving both upstream behavior and fork-specific behavior, regenerate bun.lock if needed, make 'bun run check' and the failing CI checks pass, and commit the result on the current branch. Do not weaken tests or verification gates. Do not push, rebase, or change the user's installed opencode. The parent sync job owns publication, fresh CI verification, and merging after you finish; do not leave those steps as manual follow-up." || return 1
  [[ -z "$(git diff --name-only --diff-filter=U)" && -z "$(git status --porcelain)" ]] || { FAILURE="agent left an unfinished tree"; return 1; }
  git merge-base --is-ancestor "upstream/$upstream_branch" HEAD || { FAILURE="agent result does not contain upstream"; return 1; }
  git merge-base --is-ancestor "origin/$base" HEAD || { FAILURE="agent result does not contain the fork base"; return 1; }
  verify
}

open_pr() {
  local branch="$1" behind="$2" repaired="$3" existing title body note=''
  [[ "$repaired" == 1 ]] && note=$'\n\nAn agent repaired conflicts or failing checks. The sync job lands this PR only after local verification and successful replay-native CI on the repaired head.'
  title="chore: sync fork with upstream $upstream_branch"
  body="Merges $behind commits from upstream/$upstream_branch ($(git rev-parse --short "upstream/$upstream_branch")). Opened by script/fork-sync.sh after a local \`bun run check\`.$note"
  existing="$(gh pr list --repo "$repo" --head "$branch" --state open --json url --jq '.[0].url')"
  if [[ -n "$existing" ]]; then
    gh pr edit "$existing" --title "$title" --body "$body" >/dev/null
    printf '%s\n' "$existing"
    return
  fi
  gh pr create --repo "$repo" --base "$base" --head "$branch" --title "$title" --body "$body"
}

disable_new_workflows() {
  local path
  while IFS=$'\t' read -r path; do
    [[ " ${allowed_workflows[*]} " == *" $path "* ]] && continue
    gh workflow disable "$path" --repo "$repo" >/dev/null && log "disabled upstream workflow $path"
  done < <(gh workflow list --repo "$repo" --all --json path,state --jq '.[] | select(.state == "active") | .path')
}

failure_summary() { printf '%s' "${FAILURE:-unknown failure}"; }

issues_enabled() {
  [[ "$(gh api "repos/$repo" --jq .has_issues 2>/dev/null)" == true ]]
}

attention() {
  local message="$1" number
  log "$message"
  if ! dry && issues_enabled; then
    number="$(gh issue list --repo "$repo" --state open --search "in:title \"$issue_title\"" --json number --jq '.[0].number')"
    if [[ -n "$number" ]]; then
      gh issue comment "$number" --repo "$repo" --body "$message" >/dev/null
    else
      gh issue create --repo "$repo" --title "$issue_title" --body "$message" >/dev/null
    fi
  fi
  git merge --abort >/dev/null 2>&1 || true
  # Only bot-made changes can exist here: main() refuses a dirty worktree.
  git reset --quiet --hard >/dev/null 2>&1 || true
  park
  exit 2
}

close_issue() {
  local number
  issues_enabled || return 0
  number="$(gh issue list --repo "$repo" --state open --search "in:title \"$issue_title\"" --json number --jq '.[0].number')"
  [[ -z "$number" ]] || gh issue close "$number" --repo "$repo" --comment 'Resolved by a landed upstream sync.' >/dev/null
}

main "$@"
