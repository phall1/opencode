# OpenCode replay-native fork

This public, independent fork keeps OpenCode V2 as the execution runtime. It is
not affiliated with the upstream OpenCode team. Upstream's MIT license and
attribution remain intact. No recorded personal sessions or credentials belong
in this repository.

## Working here

Use Bun for execution/tests, Oxc for linting, and the native TypeScript checker
already pinned by the workspace. Replay code has an Oxc complexity ceiling of
10 per function; do not add a second runtime, test framework, or lint pipeline.

- **Maintained base:** `v2`; **upstream:** `anomalyco/opencode`, branch `dev`.
  Upstream moved its active line from `v2` to `dev` (its `v2` branch is frozen
  at 2026-10-10); sync with `git merge upstream/dev`.
- Work on short feature branches in dedicated worktrees. Compare changes against
  `origin/v2`.
- Merge upstream updates rather than rewriting published fork history. Preserve
  fork-specific behavior, regenerate the lockfile, then run `bun run check`.
- `script/fork-sync.sh` automates that from a dedicated worktree on a schedule:
  it merges `upstream/dev` onto the bot-owned `upstream-sync` branch, resolves
  lockfile-only conflicts, runs `bun run check`, and merges the single sync PR
  only after `replay-native` CI passes; it then disables newly arrived upstream
  workflows. Each attempt force-updates that branch and PR, and closes PRs left
  by the earlier one-branch-per-attempt scheme, instead of opening another.
  Other conflicts or failures are logged (the dotfiles wrapper notifies) and
  update the "Upstream sync needs attention" issue when the repository has
  issues enabled. With `FORK_SYNC_AGENT` set, an agent may attempt the repair,
  but its result is only proposed as a PR, never auto-merged.
- Pull requests target **this fork**. An upstream PR requires separate explicit
  permission. Never treat maintaining a fork as permission to publish upstream.
- Run experiments through an embedded, isolated host. Do not replace the managed
  background service, install a development binary globally, or attach to real
  phux panes to test replay.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run replay:test
bun run replay:demo
bun run replay:repo
bun run trace:demo
bun run trace:test
bun run replay:isolation
```

The explicit archive commands run through the same entrypoint:

```sh
bun run replay record /path/to/new-capsule.json
bun run replay replay /path/to/capsule.json
bun run replay measure /path/to/capsule.json repair-exact-v1
bun run replay fork /path/to/capsule.json /path/to/new-child.json
bun run replay replay /path/to/new-child.json
bun run replay measure /path/to/new-child.json child-one-v1
```

`--ignore-scripts` avoids running dependency lifecycle scripts during setup.
Core's optional native PTY setup may be needed for interactive TUI development;
the finite replay demo does not require it. Tests run from their package
directories, never from the repository root.

Use the Bun version pinned in `package.json`'s `packageManager` field. The local
`mise.toml` enables reading that pin instead of inheriting a stale global Bun
version, including in the scheduled fork-sync worktree when mise's shims are on
`PATH`. When setting up a new checkout with mise, run `mise trust` and
`mise install`; this does not change the installed OpenCode binary or its
managed service.

## The fundamentals

The composition and acceptance contract is [specs/replay-native.md](specs/replay-native.md).
Current integration and persistence limits, including the distinction from Pi
Durable, are in [replay readiness](packages/replay/READINESS.md).

1. **Execution:** OpenCode's normal session runner, provider request encoding and
   parsing, permissions, and tool dispatch. Evaluation does not get a second
   agent loop.
2. **Episode:** immutable inputs, observed requests/results, and artifacts for one
   execution, with explicit capture coverage.
3. **Checkpoint:** a matched context boundary and environment state. A
   conversation fork alone does not clone files, processes, databases, or services.
4. **Continuation:** new execution from a checkpoint. Changed actions or model
   responses create new evidence, not deterministic replay of an old answer.
5. **Measurement:** a versioned verifier result referencing frozen artifacts.
   Changing a verifier must not rewrite the episode or require running the agent.

Strict replay substitutes recorded observations at supported effect seams. It
must not invoke live model/world capabilities, including current filesystem
reads, or silently fall back to them. Archive reads and episode-local runtime
bookkeeping are permitted. These guarantees are narrower than reproducing every
OS race, external service, or live model sample.

## Responsibilities

| Piece                       | Owns                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| OpenCode core/SDK           | Native execution and supported environment seams                     |
| `packages/replay`           | Bounded episode/checkpoint/replay/measurement experiment             |
| `packages/http-recorder`    | Native HTTP request/response capture and strict matching             |
| Existing simulation package | Scripted transport responses through real provider parsing           |
| phux                        | Presence, interactive control, and observation; not a replay archive |
| ops                         | Episode links and outcome summaries; not lossless tool storage       |
| Future range/Harbor adapter | Isolated task lifecycle and independent verification                 |

The first supported world is a bounded file fixture, not a general cyber range.
Shells, remote services, browser state, arbitrary plugins, and concurrent nested
Code Mode are not implicitly replayable. Consult the replay package's coverage
contract before importing another workload.

The runnable profile captures serial native `read`/`write` outcomes and provider
HTTP, then cold-replays them through the native host. Its successful final-idle
checkpoint includes exported context and memory-backed text files. Native forks
restore independent worlds and produce self-contained child capsules, retaining
their parent evidence. The same replay and measurement commands accept children;
lineages are bounded to four forks and archives to 8 MiB. Nothing snapshots OS
processes, databases, remote services, or hidden model state.

The repository experiment extends one capability at a time: declared source
files on disposable disk, a settled assessment checkpoint before the repair, two
scripted continuations, and independent Bun test verification of frozen results.
Agent tools remain bounded native reads/writes; there is no unrestricted shell
tool, replacement reasoning loop, live-model sampler, or training optimizer.
Execution success and independently verified task success are different facts.

Custom local executable fixtures require explicit trust acknowledgement. Clean
environment variables and fixed command arguments do not provide OS containment.
Untrusted or live-policy-produced code, a cyber range, and RL experiments remain
expansion gates until containment and trustworthy reward checks are verified.
An action with no committed receipt is unknown, not permission to retry it.

### Readiness is capability-specific

| Capability                       | Required evidence before expansion                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted scripted repo experiment | Baseline and negative controls, independent verification, isolated checkpoints, complete cold replay, immutable evidence                 |
| Custom local code                | Explicit executable-code acknowledgement; no trust inferred from an ID or self-signed capsule digest                                     |
| Untrusted or live-policy code    | Tested filesystem/network/process containment and verifier integrity, failing closed when containment is unavailable                     |
| Live model comparison            | Separate provider/spending approval, recorded effective policy, comparable task/checkpoint identity, honest usage/cost accounting        |
| Cyber-range task                 | Isolated resettable range adapter, denied production access, independent verifier, declared state coverage                               |
| RL/training                      | Trustworthy rollouts/rewards, scenario-level data splits, explicit truncation/failure semantics; sibling forks are not independent tasks |

Being ready for the first row does not establish any of the later rows. Portable
reports may link immutable capsules into phux/ops; their bounded telemetry is not
a substitute for episode evidence.

### Native tracing, not a second harness

Metadata tracing is explicitly opt-in and local. It observes the existing native
runtime, projects sensitive fields away before its bounded queue, and reports
loss/collector health. It does not enable personal-session content capture,
remote telemetry, a new agent loop, or a lossless replay guarantee. The demo uses
synthetic embedded executions; it does not modify the installed binary, managed
service, global configuration or live sessions.

Keep environment choice separate: Docker is one working execution adapter,
not the tracing model. A microVM's filesystem or RAM snapshot is not restoration
of external providers, remote peers or OpenCode's complete historical context.
Validate exact captured/restored/excluded state before adding another backend.

### Contained verifier profile

The Docker-required verifier is an explicit opt-in to a single fixed profile,
not permission to run arbitrary container images or daemon options. It requires
an already-running local Unix-socket engine and the cached official Bun image
`oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895`.
Image preparation is a separate setup step; verifier execution never pulls,
starts the engine, or falls back to host execution.

The backend supports Linux arm64/amd64 guests with cgroup v2 and built-in seccomp;
native guest probes must confirm effective privilege and resource restrictions.
The macOS host uses its existing Linux Docker VM. This does not add a macOS
`sandbox-exec` backend or promise support for every Docker configuration.

The acceptance command uses owned synthetic canaries. No user credentials or
production paths are mounted into the candidate. Inspect the effective policy
before candidate admission; use no network, read-only inputs/root, bounded tmpfs,
non-root identity, dropped capabilities, private process namespaces, and finite
resource limits. Remove only the exact labelled container owned by the attempt.

Process containment and reward integrity are separate capabilities. Bun tests and
JUnit receipts remain a trusted-fixture oracle: candidate code in the same test
process can still subvert it. Keep `--trust-local-code`, and do not enable
untrusted/live-policy workloads, range execution, or training solely because
container denial checks pass. Docker's engine, kernel, and pinned image remain
trusted; this is not a claim of protection against kernel exploits.

### Baseline verification

The synced V2 baseline passes the canonical root lint/typecheck (with existing
GUI lint warnings), HTTP recorder tests, simulation tests, and the recorded
native-runner test. A broader SDK test run currently has unrelated failing
assertions: two Effect SDK missing-session error tags, Workerd cold plugin model
selection, plugin-backed web search, and Promise stream cancellation. Do not
claim a clean SDK-wide gate from the focused replay checks. Keep replay's host
configuration isolated from ambient personal configuration; some upstream SDK
tests load it by default.

## Maintenance and publication

Fork-specific checks use `.github/workflows/replay-native.yml` on ordinary GitHub
runners, without provider/deployment secrets. Inherited deployment, release,
triage, and upstream-runner workflows stay disabled in this fork. Publication of
binaries/packages and deployments remain separate decisions.

An experiment is ready to expand only when cold replay is complete and strict,
checkpoint restores are isolated, changed requests reject, and remeasurement
leaves original evidence unchanged. Next add one capability at a time: durable
process effects, causal nested-call identities, historical instruction restore,
then an independently verified range task. Do not label these unimplemented
capabilities as supported because the basic demo passes.
