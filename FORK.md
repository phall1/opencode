# OpenCode replay-native fork

This public, independent fork keeps OpenCode V2 as the execution runtime. It is
not affiliated with the upstream OpenCode team. Upstream's MIT license and
attribution remain intact. No recorded personal sessions or credentials belong
in this repository.

## Working here

Use Bun for execution/tests, Oxc for linting, and the native TypeScript checker
already pinned by the workspace. Replay code has an Oxc complexity ceiling of
10 per function; do not add a second runtime, test framework, or lint pipeline.

- **Maintained base:** `v2`; **upstream:** `anomalyco/opencode`, branch `v2`.
- Work on short feature branches in dedicated worktrees. Compare changes against
  `origin/v2`, not upstream's legacy `dev` branch.
- Merge upstream updates rather than rewriting published fork history. Preserve
  fork-specific behavior, regenerate the lockfile, then run `bun run check`.
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

## The fundamentals

The composition and acceptance contract is [specs/replay-native.md](specs/replay-native.md).

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
