# Bounded native replay and evaluation

Workspace-private package in the public maintained fork—not a universal world
replay engine or RL trainer.

```sh
cd packages/replay
bun run demo                       # chooses a fresh temporary output directory
bun run demo /path/to/new-output   # never overwrites either capsule
bun test
bun typecheck
```

The benign public fixture repairs `teh` to `the` in a memory-backed text file.
The **scripted** provider emits OpenAI SSE through the existing simulation network.
The real SDK host, SessionRunner, native provider parser, permission checks, and
native `read`/`write` executors run the episode. No provider keys, paid calls,
shell tools, real network, service configuration changes, or second agent loop.
The isolated host uses the native plugin supervisor with an explicit fixture
allowlist: read/write, model identity, and the fixture transform, plus native
guarded policy/Console plugins with empty scratch credentials. Ambient provider
discovery is not activated, and the host-global process spawner is denied.

Expected demo evidence:

- Record: 3 fixture provider calls, 2 real native tool calls.
- Fresh-host replay: equal model-visible context, 3 HTTP and 2 tool results
  consumed; **0 provider calls and 0 native tool calls**, including reads.
- Final-idle checkpoint fork: old prefix makes 0 live calls; a new scripted
  continuation makes 2 provider calls and 1 real native write. Only child one
  changes; child two and the restored parent remain unchanged.
- Two versioned verifier IDs independently measure frozen file evidence. Separate
  append-only measurement files leave the capsule bytes and digest unchanged.
- The child is a self-contained capsule too: cold replay consumes the embedded
  parent prefix plus its new suffix with 0 live calls, and `child-one-v1` measures
  it independently. A child can itself be forked (maximum four forks in a lineage).

`capsule.json` embeds the manifest and SHA-256-addressed blobs: initial files,
idle world, native Session export, complete provider cassette and tool result tape.
`child-capsule.json` embeds its immutable parent as a hashed blob, pairs its initial
world with the parent's checkpoint, and captures its own native suffix context,
HTTP/tool tape, and checkpoint. The same open/replay/measure/fork APIs accept it.
`measurement-<uuid>.json` stores each versioned verifier result separately.

## Reuse an archive (including from a new process)

```sh
bun run script/cli.ts record /path/to/capsule.json
bun run script/cli.ts replay /path/to/capsule.json
bun run script/cli.ts measure /path/to/capsule.json repair-exact-v1
bun run script/cli.ts measure /path/to/capsule.json repair-no-typo-v1
bun run script/cli.ts fork /path/to/capsule.json /path/to/child-capsule.json
bun run script/cli.ts replay /path/to/child-capsule.json
bun run script/cli.ts measure /path/to/child-capsule.json child-one-v1
```

Library API from `@opencode/replay`:

```ts
import { Effect } from "effect"
import { open, save, record, replay, fork, measure } from "@opencode/replay"

await Effect.runPromise(record("/path/to/new-capsule.json"))
const capsule = open("/path/to/new-capsule.json")
await Effect.runPromise(replay(capsule))
const child = (await Effect.runPromise(fork(capsule))).capsule
save("/path/to/new-child.json", child)
await Effect.runPromise(replay(open("/path/to/new-child.json")))
measure(capsule, "repair-exact-v1", "/path/to/existing-results-directory")
measure(child, "child-one-v1", "/path/to/existing-results-directory")
```

Verifier-only consumers can import `@opencode/replay/measure` and
`@opencode/replay/archive` without loading the SDK/harness runtime.

The public API owns host lifetime. Tool results are schema-validated and fsynced
before returning to the runner. Replay matches serial occurrence, tool name and
canonical arguments; missing, mismatched and unused results fail the **episode**,
even if a native tool error could ordinarily be recovered by the model. HTTP
replay explicitly forbids live fallback and requires complete cassette consumption.
Archive writes use exclusive creation, validate hashes and schemas, and cap the
whole capsule at 8 MiB. Manifest references are hashes, never input filenames.
Native read-side instruction discovery is disabled at its capability boundary:
fixture path resolution is lexical, host fixture walks/reads/stat and missing-file
directory suggestions are excluded, and ambient `SessionInstructions.load` is
disabled. Real memory-file tools and their permission/side-effect ordering remain
native. Host metadata and archive bookkeeping outside the fixture are unaffected.
Child validation recursively verifies parent integrity, matching checkpoint and
runtime identity, and bounded ancestry. Verifier results include their loaded
implementation's source hash separately from episode runtime pins, so a new
verifier can regrade old frozen artifacts without invalidating their identity.

## Deliberate coverage limits

- The memory profile supports only `/fixture/repair.txt`; the repository profile
  supports explicitly declared virtual `/fixture/<relative-file>` read/write paths.
  Both capture serial calls only.
  Other tools, Code Mode, arbitrary paths, processes and formatters are disabled.
- Memory world is a known UTF-8 text tree. No OS/process/database/remote-service,
  binary, symlink, hardware, arbitrary historical `asOf`, or in-flight checkpoint.
  Directories are derived from file paths; empty directories and file metadata
  such as timestamps/permissions are excluded.
- A supported checkpoint is the recorded **final idle boundary** with empty inbox
  and no active native drain. Fork first replays the immutable prefix into a fresh
  native host to restore instruction history, then uses native Session fork and
  movement into separately cloned worlds. No export/import claim of full runtime
  restoration; native exports alone do not include complete instruction state.
- Context equality excludes generated projection IDs, timestamps and accounting;
  it includes user/system text, model identity, assistant text and native tool
  inputs/results. Requests are compared by method, URL and complete canonical
  JSON body. Transient HTTP headers are intentionally excluded.
  Location-change comparison retains the directory that native request lowering
  renders; generated workspace IDs do not enter that model-visible message.
- Selected load-bearing native source hashes, the harness sources, Bun and Effect
  versions (including the actually resolved Effect package), root manifest,
  `bun.lock`, instructions, model identity and policy are pinned. Changed pins reject
  replay; this is not automatic version migration. The capsule carries frozen
  evidence, not an entire native executable distribution.
- Hashes detect content corruption, not malicious authorship. Captured fixtures
  are public; this package is not a general secret-redaction service.
- Component replay is **not OS security containment**. Embedded-host metadata,
  projections and archive IO still use the host runtime. No untrusted agent code
  is executed. Phux can launch/observe these CLI runs; interactive phux driving,
  live model evaluation and RL policy optimization are not implemented here.
- Tool error tapes preserve the model-facing message, not host stacks or defect
  graphs. The shipped successful episode exercises actual native file results.

To extend this foundation, add a real bounded world/tool seam and coverage tests
before declaring that world replayable. Do not add a second model scheduler.

## Trusted synthetic repository experiment

```sh
bun run repo-demo                           # repository-owned synthetic fixture
bun run script/cli.ts experiment task.json /path/to/new-output --trust-local-code
bun run script/cli.ts replay /path/to/new-output/general.json
bun run script/cli.ts measure /path/to/new-output/general.json heldout --trust-local-code
bun run script/cli.ts fork /path/to/new-output/checkpoint.json /path/to/new-child.json --trust-local-code
bun run script/cli.ts compare /path/to/new-output
bun run script/cli.ts inspect /path/to/new-output
```

`@opencode/replay/repo` exposes `experiment`, `replayRepo`, `forkRepo`,
`measureRepo`, and the repo archive APIs. Ordinary CLI replay/measure/fork dispatch
both profiles. CLI fork selects the general scripted policy; the typed API can
also select `overfit`. There is no live-provider option or second reasoning loop.

The task shape is exported as `Task` in `src/repo-task.ts`; `demoTask` is a complete
example. JSON declares ID, fixed instructions, assessment/repair prompts, UTF-8
relative files, separate readable/mutable paths, finite budgets, two explicit
read/write/text response plans, and a `bun-test-v1` verifier with frozen test source.
No executable command field, dependency installation, plugin discovery, or shell
tool is supported. Actor files include `package.json` and `smoke.test.ts`; only
declared source files are mutable. Unsafe paths, symlinks/special entries, mutable
tests, oversized text, undeclared writes and hidden verifier files are rejected.

The native assessment reads source/package/smoke and ends **idle before edits**.
Its files must still equal the initial files. An independent verifier fails that
baseline. Two native fork/move continuations restore the actual assessment prefix
and clone separate disposable on-disk repositories: general whitespace repair
passes public and heldout tests; plausible first-space-only repair passes public
smoke but fails heldout. The original disk files are checked unchanged. This is
scripted-policy evidence, **not model-ability evaluation or an RL framework**.

Virtual model paths remain stable across processes; private host paths never enter
recorded requests. Native permission/file ordering is unchanged. All Environment
file operations are supplied, with unsupported operations and actor processes
poisoned. Ambient instruction discovery and host fixture observations remain
disabled; SDK global metadata/storage is rooted in owned scratch directories.
AWS/gcloud credential discovery and Azure CLI probing are excluded at activation,
not merely ignored in the zero-live counters; synthetic discovery regressions
cover recording and a separate-process cold replay.
Strict cold replay restores ancestry through native replay/fork/move, substitutes
HTTP/tool tapes, poisons all world/process capabilities, and never runs a verifier.

Verification is separate trusted code execution: frozen files are restored into
another fresh directory, heldout source is added there only, and fixed direct Bun
test argv use `--no-install`, `--no-env-file`, `--no-orphans`, an owned bunfig, a separate HOME,
sanitized environment, timeout, and capped stdout/stderr. **This is not an OS
sandbox:** JavaScript can access host files/network and create descendants; Bun's
orphan flag is not a verified process-tree containment contract. Custom
tasks, capsule measurement and new repo continuations require an explicit trust
acknowledgment; capsule hashes, task IDs and self-declared trust cannot grant it.
No secrets/ambient credentials are copied, but host access is not denied by the OS.
Untrusted code, live/untrusted policies, ranges and paid models remain gated on
real containment and deny checks. There is no implicit install/network allowance.

Self-contained hashed repo capsules freeze task/policy/prompts, budgets, source
pins, initial/checkpoint files, native context, HTTP/tool results, parent evidence,
suffix-only fixture usage and explicitly scoped elapsed timing. Native success
does not imply task success; real model cost remains UNKNOWN/not measured.
Verifier measurements and JSON/Markdown comparisons are append-only portable
files; remeasurement never changes capsule bytes. `compare` includes every stored
continuation measurement, distinguishing test failures from timeout/truncation and
native execution failure. No service, scheduler or phux control plane is added.

A zero verifier exit code alone is not a pass. The fixed Bun invocation writes a
bounded native JUnit completion report; pass requires a complete, consistent suite
with at least one executed test and one assertion, and no failures. Early exit,
empty tests, all-skipped tests, and missing/malformed reports are
`verifier-incomplete`, distinct from ordinary failure, timeout and output truncation.
Measurements freeze the report, digest, parser provenance and counts. This detects
accidental verifier incompleteness, not tampering by untrusted code with host access.

Preflight manifests and fsynced write-ahead started markers precede native effects;
fsynced receipts precede retirement. Missing or invalid receipts mean **UNKNOWN**, not safe to
repeat. Defects/interruption stay failures, incomplete evidence cannot become a
capsule/report, and no uncertain effect is retried or resumed. `inspect` is read-only
and shares comparison's typed journal validation: receipts must be bounded regular
files matching the started tool/native/measurement metadata, not merely filenames.
and retained ledgers survive scratch-world cleanup. The experiment's checkpoint is
specifically quiescent assessment idle, before edits. Further forks use only a
capsule's succeeded final-idle boundary, the same pinned instructions, and bounded
ancestry—not arbitrary in-flight/asOf state, historical instruction migration,
processes, metadata, empty directories or OS checkpoints.
Changed source pins may reject older capsules; no migration compatibility claim.
