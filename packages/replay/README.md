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

- Only the fixed `/fixture/repair.txt` native direct read/write path; serial calls.
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
