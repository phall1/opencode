import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Drives script/fork-sync.sh against throwaway git repositories, with `gh`
// and `bun` replaced by recording fakes. No network and no real GitHub.
const script = path.resolve(import.meta.dir, "../../../script/fork-sync.sh")
const roots: string[] = []

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe("fork-sync", () => {
  test("does nothing when the fork already contains upstream", () => {
    const fx = fixture()
    const result = fx.run()
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("already contains")
    expect(fx.calls()).toEqual([])
  })

  test("lands a clean merge only after local checks and CI, then disables new upstream workflows", () => {
    const fx = fixture()
    fx.forkCommit("fork.txt", "fork-only work")
    fx.upstreamCommit("upstream.txt", "new upstream work")
    const result = fx.run({ FAKE_HAS_ISSUES: "false" })
    expect(result.exitCode).toBe(0)
    const calls = fx.calls().join("\n")
    expect(calls).toContain("pr create --repo phall1/opencode --base v2 --head upstream-sync")
    expect(calls).toMatch(
      /pr merge https:\/\/example\.invalid\/pr\/1 --repo phall1\/opencode --merge --delete-branch --match-head-commit [0-9a-f]{40}/,
    )
    expect(calls).toContain("workflow disable .github/workflows/models-snapshot.yml")
    expect(calls).not.toContain("workflow disable .github/workflows/replay-native.yml")
    expect(fx.git("ls-remote", "--heads", "origin", "refs/heads/upstream-sync")).toContain("refs/heads/upstream-sync")
    fx.expectParked()
  })

  test("reuses the single sync branch and updates its PR instead of opening another", () => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "first upstream work")
    expect(fx.run({ FAKE_HAS_ISSUES: "false" }).exitCode).toBe(0)
    fx.upstreamCommit("second.txt", "second upstream work")
    const second = fx.run({ FAKE_HAS_ISSUES: "false" })
    expect(second.exitCode).toBe(0)
    const calls = fx.calls()
    expect(calls.filter((call) => call.startsWith("pr create"))).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith("pr edit"))).toEqual([
      expect.stringContaining("pr edit https://example.invalid/pr/1 --title chore: sync fork with upstream dev"),
    ])
    expect(calls.join("\n")).toContain("pr merge https://example.invalid/pr/1 --repo phall1/opencode")
    expect(fx.git("ls-remote", "--heads", "origin", "refs/heads/upstream-sync")).not.toBe("")
    fx.expectParked()
  })

  test("closes PRs left by the earlier one-branch-per-attempt scheme", () => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "work")
    const result = fx.run({
      FAKE_HAS_ISSUES: "false",
      FAKE_STALE_PRS: "12\tupstream-sync-abc123\n7\tupstream-sync\n99\tunrelated\n",
    })
    expect(result.exitCode).toBe(0)
    const calls = fx.calls().join("\n")
    expect(calls).toContain("pr close 12 --repo phall1/opencode --delete-branch")
    expect(calls).toContain("Superseded by a newer sync attempt.")
    expect(calls).not.toContain("pr close 7 ")
    expect(calls).not.toContain("pr close 99 ")
    expect(result.stderr).toContain("closed superseded sync PR #12")
  })

  test("resolves a lockfile-only conflict mechanically", () => {
    const fx = fixture()
    fx.forkCommit("bun.lock", "fork lock")
    fx.upstreamCommit("bun.lock", "upstream lock")
    const result = fx.run({ FORK_SYNC_DRY_RUN: "1" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("dry run: verified")
    expect(fx.calls()).toEqual([])
    fx.expectParked()
  })

  test("uses the merged Bun pin for installs and checks when the scheduler runtime is older", () => {
    const fx = fixture()
    fx.upstreamCommit("package.json", JSON.stringify({ packageManager: "bun@1.4.5" }))
    const result = fx.run({ FORK_SYNC_DRY_RUN: "1", FAKE_BUN_VERSION: "1.4.3" })
    expect(result.stderr).toContain("dry run: verified")
    expect(result.exitCode).toBe(0)
    expect(fx.runtimeCalls()).toEqual(["exec bun@1.4.5 -- bun install", "exec bun@1.4.5 -- bun run check"])
    fx.expectParked()
  })

  test("selects pinned Bun while resolving a lockfile conflict", () => {
    const fx = fixture()
    fx.forkCommit("bun.lock", "fork lock")
    fx.upstreamCommit("bun.lock", "upstream lock")
    const result = fx.run({ FORK_SYNC_DRY_RUN: "1", FAKE_BUN_VERSION: "1.4.3" })
    expect(result.stderr).toContain("dry run: verified")
    expect(result.exitCode).toBe(0)
    expect(fx.runtimeCalls()).toEqual([
      "exec bun@1.4.4 -- bun install",
      "exec bun@1.4.4 -- bun install",
      "exec bun@1.4.4 -- bun run check",
    ])
    fx.expectParked()
  })

  test("does not publish when the pinned runtime is unavailable", () => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "work")
    const result = fx.run({ FAKE_BUN_VERSION: "1.4.3", FAKE_MISE_FAIL: "1" })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("pinned runtime unavailable")
    expect(fx.calls().join("\n")).not.toContain("pr create")
    fx.expectParked()
  })

  test("publishes with pinned Bun available to the pre-push hook", () => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "work")
    const hook = path.join(fx.work, ".git/hooks/pre-push")
    writeFileSync(hook, '#!/bin/sh\n[ "$(bun --version)" = "1.4.4" ]\n')
    chmodSync(hook, 0o755)
    const result = fx.run({ FAKE_BUN_VERSION: "1.4.3", FAKE_HAS_ISSUES: "false" })
    expect(result.exitCode).toBe(0)
    expect(fx.calls().join("\n")).toContain("pr create")
    expect(fx.runtimeCalls()).toContainEqual(expect.stringContaining("exec bun@1.4.4 -- git push"))
    fx.expectParked()
  })

  test("files the tracking issue on a real conflict and leaves the worktree clean", () => {
    const fx = fixture()
    fx.forkCommit("shared.txt", "fork change")
    fx.upstreamCommit("shared.txt", "upstream change")
    const result = fx.run()
    expect(result.exitCode).toBe(2)
    expect(fx.calls().join("\n")).toMatch(
      /issue create --repo phall1\/opencode --title Upstream sync needs attention --body .*conflicts: shared\.txt/,
    )
    expect(fx.calls().join("\n")).not.toContain("pr merge")
    fx.expectParked()
  })

  test("without repository issues, attention is logged and nothing fails on the issue API", () => {
    const fx = fixture()
    fx.forkCommit("shared.txt", "fork change")
    fx.upstreamCommit("shared.txt", "upstream change")
    const result = fx.run({ FAKE_HAS_ISSUES: "false" })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("conflicts: shared.txt")
    expect(fx.calls().join("\n")).not.toContain("issue ")
    fx.expectParked()
  })

  test("lands an agent repair after local verification and fresh CI", () => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "breaks checks")
    const agent = path.join(fx.root, "agent")
    writeFileSync(agent, "#!/bin/sh\necho fixed > fixed\ngit add fixed\ngit commit -qm 'fix: repair upstream sync'\n")
    chmodSync(agent, 0o755)
    const result = fx.run({ FAKE_CHECK_NEEDS: "fixed", FORK_SYNC_AGENT: agent, FAKE_BUN_VERSION: "1.4.3" })
    expect(result.exitCode).toBe(0)
    const calls = fx.calls().join("\n")
    expect(calls).toContain("successful replay-native CI on the repaired head")
    expect(calls.indexOf("--watch")).toBeLessThan(calls.indexOf("pr merge"))
    expect(calls).toContain("pr merge")
    expect(fx.runtimeCalls()).toEqual([
      "exec bun@1.4.4 -- bun install",
      "exec bun@1.4.4 -- bun run check",
      "exec bun@1.4.4 -- bun run check",
      expect.stringContaining("exec bun@1.4.4 -- git push"),
    ])
    fx.expectParked()
  })

  test("lands a repaired merge conflict, preserving both histories", () => {
    const fx = fixture()
    fx.forkCommit("shared.txt", "fork change")
    fx.upstreamCommit("shared.txt", "upstream change")
    const agent = path.join(fx.root, "agent")
    writeFileSync(
      agent,
      "#!/bin/sh\nprintf 'fork change\\nupstream change\\n' > shared.txt\ngit add shared.txt\ngit commit -qm 'fix: preserve both behaviors'\n",
    )
    chmodSync(agent, 0o755)
    expect(fx.run({ FORK_SYNC_AGENT: agent }).exitCode).toBe(0)
    expect(fx.calls().join("\n")).toContain("pr merge")
    expect(fx.git("show", "origin/upstream-sync:shared.txt")).toBe("fork change\nupstream change\n")
    fx.expectParked()
  })

  test("repairs failing CI using its logs, republishes, and waits again before merging", () => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "work")
    const agent = path.join(fx.root, "agent")
    writeFileSync(
      agent,
      `#!/bin/sh\nprintf '%s' "$1" > '${fx.root}/prompt'\necho fixed > fixed\ngit add fixed\ngit commit -qm 'fix: repair CI'\n`,
    )
    chmodSync(agent, 0o755)
    const result = fx.run({ FAKE_CI_NEEDS: "fixed", FORK_SYNC_AGENT: agent, FAKE_ISSUE_NUMBER: "1" })
    expect(result.stderr).toContain("asking agent to repair")
    expect(result.exitCode).toBe(0)
    const calls = fx.calls()
    expect(calls.filter((call) => call.includes("--watch"))).toHaveLength(2)
    expect(calls.filter((call) => call.startsWith("pr create"))).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith("pr edit"))).toHaveLength(1)
    expect(calls.join("\n")).toContain("run view 123 --repo phall1/opencode --log-failed")
    expect(readFileSync(path.join(fx.root, "prompt"), "utf8")).toContain("synthetic CI diagnostic")
    expect(calls.at(-1)).toContain("issue close")
    expect(calls.join("\n")).toContain("pr merge")
    fx.expectParked()
  })

  test("escalates a failed CI repair without merging or retrying forever", () => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "work")
    const agent = path.join(fx.root, "agent")
    writeFileSync(agent, `#!/bin/sh\necho attempt >> '${fx.root}/attempts'\n`)
    chmodSync(agent, 0o755)
    expect(fx.run({ FAKE_CI_NEEDS: "fixed", FORK_SYNC_AGENT: agent }).exitCode).toBe(2)
    expect(readFileSync(path.join(fx.root, "attempts"), "utf8")).toBe("attempt\n")
    expect(fx.calls().join("\n")).not.toContain("pr merge")
    expect(fx.calls().filter((call) => call.includes("--watch"))).toHaveLength(2)
    fx.expectParked()
  })

  test.each(["MISSING", "SKIPPING", "FAILURE"])("does not merge when replay-native is %s", (state) => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "work")
    expect(fx.run({ FAKE_REPLAY_STATE: state }).exitCode).toBe(2)
    expect(fx.calls().join("\n")).not.toContain("pr merge")
    fx.expectParked()
  })

  test("does not merge when the PR head changes during CI", () => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "work")
    expect(fx.run({ FAKE_HEAD_CHANGE: "1" }).exitCode).toBe(2)
    expect(fx.calls().join("\n")).not.toContain("pr merge")
    fx.expectParked()
  })

  test("refuses a dirty worktree", () => {
    const fx = fixture()
    writeFileSync(path.join(fx.work, "stray.txt"), "user work")
    const result = fx.run()
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("dirty")
  })
})

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "fork-sync-"))
  roots.push(root)
  const bin = path.join(root, "bin")
  const upstream = path.join(root, "upstream")
  const work = path.join(root, "work")
  const log = path.join(root, "calls")
  mkdirSync(bin)
  writeFileSync(log, "")
  const prs = path.join(root, "prs")
  const runtime = path.join(root, "runtime-calls")
  writeFileSync(runtime, "")
  fake(
    bin,
    "bun",
    [
      String.raw`[ "$1" = -p ] && { sed -n 's/.*"packageManager":"bun@\([^"]*\)".*/\1/p' package.json; exit 0; }`,
      `[ "$1" = --version ] && { echo "$FAKE_BUN_VERSION"; exit 0; }`,
      String.raw`[ "$FAKE_BUN_VERSION" = "$(sed -n 's/.*"packageManager":"bun@\([^"]*\)".*/\1/p' package.json)" ] || { echo "wrong Bun runtime" >&2; exit 1; }`,
      `[ "$1" = run ] && [ -n "$FAKE_CHECK_NEEDS" ] && [ ! -f "$FAKE_CHECK_NEEDS" ] && { echo "check failed" >&2; exit 1; }`,
      "exit 0",
    ].join("\n"),
  )
  fake(
    bin,
    "mise",
    [
      `printf '%s\\n' "$*" >> "${runtime}"`,
      `[ "$FAKE_MISE_FAIL" = 1 ] && { echo "pinned runtime unavailable" >&2; exit 1; }`,
      `export FAKE_BUN_VERSION="\${2#bun@}"`,
      "shift 3",
      'exec "$@"',
    ].join("\n"),
  )
  // Tracks created PRs so a second run exercises the reuse path for real.
  fake(
    bin,
    "gh",
    [
      `printf '%s\\n' "$*" >> "${log}"`,
      `case "$1 $2" in`,
      `  "pr create")`,
      `    echo "$*" >> "${prs}"`,
      `    echo "https://example.invalid/pr/$(wc -l < "${prs}" | tr -d ' ')" ;;`,
      `  "pr list")`,
      `    case "$*" in`,
      `      *"--head "*) if [ -s "${prs}" ]; then echo "https://example.invalid/pr/$(wc -l < "${prs}" | tr -d ' ')"; fi ;;`,
      `      *) printf '%s' "\${FAKE_STALE_PRS:-}" ;;`,
      `    esac ;;`,
      `  "pr view") if [ "$FAKE_HEAD_CHANGE" = 1 ] && [ -f '${root}/watched' ]; then echo wrong-head; else git rev-parse HEAD; fi ;;`,
      `  "pr checks")`,
      `    state="$FAKE_REPLAY_STATE"`,
      `    [ -n "$FAKE_CI_NEEDS" ] && [ ! -f "$FAKE_CI_NEEDS" ] && state=FAILURE`,
      `    case "$*" in`,
      `      *"--watch"*) touch '${root}/watched'; [ "$state" != FAILURE ] || exit 1 ;;`,
      `      *"--json"*) echo "$state" ;;`,
      `      *) echo "replay $state" ;;`,
      `    esac ;;`,
      `  "run list") echo 123 ;;`,
      `  "run view") echo 'synthetic CI diagnostic' ;;`,
      `  "issue list") echo "$FAKE_ISSUE_NUMBER" ;;`,
      `  "workflow list") printf '%s\\n' .github/workflows/replay-native.yml .github/workflows/models-snapshot.yml ;;`,
      `  "api repos/phall1/opencode") echo "\${FAKE_HAS_ISSUES:-true}" ;;`,
      `esac`,
    ].join("\n"),
  )
  // Registration polling is deterministic; never spend real seconds in tests.
  fake(bin, "sleep", "exit 0")
  // CI runners have no git identity; the script's merge commits need one.
  const env = {
    ...process.env,
    // Never launch the scheduler's real repair agent or use its target configuration.
    FORK_SYNC_AGENT: "",
    FORK_SYNC_REPO: "phall1/opencode",
    FORK_SYNC_BASE: "v2",
    FORK_SYNC_UPSTREAM_URL: upstream,
    FORK_SYNC_UPSTREAM_BRANCH: "dev",
    FORK_SYNC_DRY_RUN: "0",
    FAKE_HAS_ISSUES: "true",
    FAKE_CHECK_NEEDS: "",
    FAKE_BUN_VERSION: "1.4.4",
    FAKE_MISE_FAIL: "0",
    FAKE_REPLAY_STATE: "SUCCESS",
    FAKE_CI_NEEDS: "",
    FAKE_HEAD_CHANGE: "0",
    FAKE_ISSUE_NUMBER: "",
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fork-sync",
    GIT_AUTHOR_EMAIL: "fork-sync@example.invalid",
    GIT_COMMITTER_NAME: "fork-sync",
    GIT_COMMITTER_EMAIL: "fork-sync@example.invalid",
  }
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.stdout.toString()
  }
  git(root, "init", "-q", "-b", "dev", upstream)
  writeFileSync(path.join(upstream, "shared.txt"), "base\n")
  writeFileSync(path.join(upstream, "package.json"), JSON.stringify({ packageManager: "bun@1.4.4" }))
  git(upstream, "add", ".")
  git(upstream, "commit", "-qm", "base")
  git(root, "clone", "-q", "--bare", upstream, path.join(root, "origin.git"))
  git(path.join(root, "origin.git"), "branch", "-m", "dev", "v2")
  git(root, "clone", "-q", "-b", "v2", path.join(root, "origin.git"), work)
  git(work, "remote", "add", "upstream", upstream)

  const commit = (repo: string, branch: string, file: string, content: string) => {
    git(repo, "checkout", "-q", branch)
    writeFileSync(path.join(repo, file), `${content}\n`)
    git(repo, "add", file)
    git(repo, "commit", "-qm", content)
  }
  return {
    root,
    work,
    git: (...args: string[]) => git(work, ...args),
    upstreamCommit: (file: string, content: string) => commit(upstream, "dev", file, content),
    forkCommit: (file: string, content: string) => {
      commit(work, "v2", file, content)
      git(work, "push", "-q", "origin", "v2")
      git(work, "checkout", "-q", "--detach", "origin/v2")
    },
    run: (extra: Record<string, string> = {}) => {
      const result = Bun.spawnSync(["bash", script], { cwd: work, env: { ...env, ...extra } })
      return { exitCode: result.exitCode, stderr: result.stderr.toString() }
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    runtimeCalls: () => readFileSync(runtime, "utf8").split("\n").filter(Boolean),
    expectParked: () => {
      expect(git(work, "status", "--porcelain")).toBe("")
      expect(git(work, "branch", "--show-current").trim()).toBe("")
      expect(git(work, "branch", "--list", "upstream-sync*").trim()).toBe("")
    },
  }
}

function fake(bin: string, name: string, body: string) {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(path.join(bin, name), 0o755)
}
