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
    fx.upstreamCommit("upstream.txt", "new upstream work")
    const result = fx.run()
    expect(result.exitCode).toBe(0)
    const calls = fx.calls().join("\n")
    expect(calls).toContain("pr create --repo phall1/opencode --base v2 --head upstream-sync-")
    expect(calls).toMatch(/pr merge https:\/\/example\.invalid\/pr\/1 --repo phall1\/opencode --merge --delete-branch --match-head-commit [0-9a-f]{40}/)
    expect(calls).toContain("workflow disable .github/workflows/models-snapshot.yml")
    expect(calls).not.toContain("workflow disable .github/workflows/replay-native.yml")
    expect(fx.git("ls-remote", "--heads", "origin", "upstream-sync-*")).toContain("upstream-sync-")
    fx.expectParked()
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

  test("files the tracking issue on a real conflict and leaves the worktree clean", () => {
    const fx = fixture()
    fx.forkCommit("shared.txt", "fork change")
    fx.upstreamCommit("shared.txt", "upstream change")
    const result = fx.run()
    expect(result.exitCode).toBe(2)
    expect(fx.calls().join("\n")).toMatch(/issue create --repo phall1\/opencode --title Upstream sync needs attention --body .*conflicts: shared\.txt/)
    expect(fx.calls().join("\n")).not.toContain("pr merge")
    fx.expectParked()
  })

  test("an agent repair is proposed for review and never auto-merged", () => {
    const fx = fixture()
    fx.upstreamCommit("upstream.txt", "breaks checks")
    const agent = path.join(fx.root, "agent")
    writeFileSync(agent, "#!/bin/sh\necho fixed > fixed\ngit add fixed\ngit commit -qm 'fix: repair upstream sync'\n")
    chmodSync(agent, 0o755)
    const result = fx.run({ FAKE_CHECK_NEEDS: "fixed", FORK_SYNC_AGENT: agent })
    expect(result.exitCode).toBe(3)
    const calls = fx.calls().join("\n")
    expect(calls).toContain("never auto-merged")
    expect(calls).not.toContain("pr merge")
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
  fake(bin, "bun", `[ "$1" = run ] && [ -n "$FAKE_CHECK_NEEDS" ] && [ ! -f "$FAKE_CHECK_NEEDS" ] && { echo "check failed" >&2; exit 1; }\nexit 0`)
  fake(
    bin,
    "gh",
    [
      `printf '%s\\n' "$*" >> "${log}"`,
      `case "$1 $2" in`,
      `  "pr create") echo https://example.invalid/pr/1 ;;`,
      `  "pr checks") echo replay ;;`,
      `  "workflow list") printf '%s\\n' .github/workflows/replay-native.yml .github/workflows/models-snapshot.yml ;;`,
      `esac`,
    ].join("\n"),
  )
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.stdout.toString()
  }
  git(root, "init", "-q", "-b", "dev", upstream)
  writeFileSync(path.join(upstream, "shared.txt"), "base\n")
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
    expectParked: () => {
      expect(git(work, "status", "--porcelain")).toBe("")
      expect(git(work, "branch", "--show-current").trim()).toBe("")
      expect(git(work, "branch", "--list", "upstream-sync-*").trim()).toBe("")
    },
  }
}

function fake(bin: string, name: string, body: string) {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(path.join(bin, name), 0o755)
}
