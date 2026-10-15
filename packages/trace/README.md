# Native local metadata traces

`@opencode/trace` is a private workspace module for **opt-in embedded SDK hosts**.
It observes the production native Bus and writes bounded metadata JSONL locally.
It does not activate tracing for the installed binary, managed service, or personal
sessions. It adds no provider calls, external exporter, daemon, or telemetry SDK.

```ts
import { Effect } from "effect"
import { OpenCode } from "@opencode/sdk/effect"
import { Session } from "@opencode/schema/session"
import { Trace } from "@opencode/trace"

const program = Effect.gen(function* () {
  const trace = yield* Trace.capture({
    enabled: true,
    // Existing canonical (realpath), trusted directory; no symlink ancestors.
    outputDirectory: "/absolute/private/traces",
    selection: { sessions: [Session.ID.make("ses_explicitly-approved")] },
  })
  const host = yield* OpenCode.create(
    { models: { fetch: false }, events: { persist: true } },
    { overrides: trace.overrides },
  )
  // Use the ordinary host.sessions operations and wait for native execution.
  // Optionally stop tracing early; scope exit also closes it.
  yield* trace.close
  return trace.health()
}).pipe(Effect.scoped)
```

Create the capture **before** the host and pass its overrides before admitting
Sessions. `Trace.capture()` / `{ enabled: false }` allocates no observer, worker,
queue, output directory or file and returns no overrides. Enabled capture requires
1–256 explicitly selected Session IDs, or the deliberately broader
`selection: { allHostSessions: true }`. It never infers selection from a Location.
One capture belongs to one host. Do not override `SdkPlugins.node` again after its
capture override: the last embed replacement wins. Other host replacements,
including custom Bus wiring and `events.persist`, remain intact.

## What is recorded

Version 1 Effect schemas are exported through `TraceRecords` and `./records`.
The finite event inventory covers Session creation/fork/move, inbox enqueue /
delivery / cancellation, execution lifecycle, step start / provider stream end /
end / failure, tool input start / call / success / failure, scheduled retries,
and compaction lifecycle. Native event sequence and schema version are retained
when supplied. Native dispatch `started` and event `created` timestamps support
consumer-side duration calculations without a growing correlation map.
Finite bounded usage/cost, native finish/interruption/compaction
codes and coarse read/write/shell/custom tool categories are allowed.

Session, parent, event, inbox, message and tool-call IDs are **per-capture HMAC
pseudonyms**. The random key is never persisted. Message IDs are qualified by
Session; tool IDs by Session and assistant message. Identical IDs correlate within
one capture, not across runs. IDs longer than 256 characters reject projection
without hashing the full string, count a collection failure/drop, and leave native
execution untouched. Parent links use canonical creation/fork metadata only.

Never recorded: prompts, text/reasoning, instructions, tool input/output/content,
results, arbitrary metadata, error types/messages/causes/stacks, environment,
URLs/headers, file paths, snapshot names, provider/model/agent names or custom tool
names. Even apparently harmless freeform names are omitted. Privacy projection
runs synchronously **before the collector queue**, not in the writer.

The deprecated low-level `Bus.listen` is intentional: `Bus.subscribe` and native
plugin `ctx.event.subscribe` have an **unbounded body-bearing upstream PubSub**.
The collector does not use them or SSE. It decorates the existing SDK plugin-store
acquisition node, obtains its already-configured native Bus dependency, registers
a fast synchronous observer, and returns the same plugin store and Bus unchanged.
No native publishing, projection, replay, tool registry, reasoning loop, or tracer
is replaced. Collector failures are caught inside the observer, including for
non-isolated ephemeral publication. Existing OTLP configuration is not overridden.
Collector entrypoints are untraced so they add no spans to a caller's exporter,
including when capture is disabled; native execution spans remain unchanged.

## Bounds, health and shutdown

- At most 256 queued/in-flight event records, 256 KiB of their serialized metadata
  (plus one fixed-size header/footer control line),
  2 KiB per record, 10,000 admitted records, and one 4 MiB file per capture.
- Optional `limits` can only lower queue records/bytes, total records/file bytes,
  and shutdown milliseconds (default/max 2,000). File limit minimum is 8 KiB.
  Header/footer space is reserved inside that limit.
- One unique `trace-v1-*` directory (0700), with exclusively created
  `events.jsonl` (0600). Refuse a noncanonical/symlinked output path or a directory
  already containing 16 entries. Nothing rotates, overwrites or deletes user files;
  callers own retention/removal. Concurrent independent captures are not a global
  storage quota; use a dedicated trusted output directory and bound their number.
- Only bounded serialized metadata is queued. Active execution tracking is capped
  at 256 Sessions, and pseudonyms have no growing lookup map.
- Under backpressure the observer drops rather than awaiting the sink. Health
  exposes queue/byte peaks, observed/written/dropped/unsupported counts, sanitized
  failure counts and one first/last-loss ordinal range, not one object per loss.
  Unsupported/excluded Session event types are counted, never serialized.
- Shutdown removes observers **first**, drains with a deadline, interrupts/awaits
  the owned writer, writes a bounded summary, and bounds sink close. Write errors
  or deadlines stop admission and mark incomplete. Outstanding native OS file I/O
  cannot be recalled; after timeout its completion/durability is unknown, never
  proof of lossless capture. No cleanup Promise is deliberately fire-and-forgotten.
  Explicit close and host finalization share one bounded observer-release operation;
  an unsubscribe defect, interruption or timeout is sanitized, marks incomplete,
  and cannot skip writer/sink cleanup or escape into native host shutdown.

`health().complete` after `close` means this collector attached, drained and closed
without observed loss, failures, cancellation or unterminated/interrupted execution.
It is **not** proof of source continuity, native execution success or task success.
The on-disk summary is written before sink close, so its `closure` is explicitly
`unconfirmed` and its `complete` remains false even on a clean run. Live health
after close can establish collector completion; a file alone cannot certify its
later close. Missing footer, process death or collector failure means incomplete /
unknown. Summary bytes are a pre-footer snapshot; live bytes include the footer.

## Coverage is deliberately narrow

Best-effort live metadata is not a lossless event journal, capsule, conversation
checkpoint, environment snapshot, verifier result, full Effect execution capture,
or RL dataset. No history is backfilled. Source continuity is unverified. Native
Physical Attempt identities, auxiliary-request scopes and nested occurrence
causality are unavailable: a message is not an attempt. `attemptOrdinal` is only
the native scheduled-retry ordinal, not a fabricated Physical Attempt ID.
Execution failure remains failure; interruption never fabricates success.
Docker/microVM environment assurance is separate and backend-agnostic.

## Synthetic proof and small measurement

From the repository root: `bun run trace:test` and `bun run trace:demo`.
The demo retains five metadata-only `events-*.jsonl` files and `summary.json` in
an owned temporary directory, printed with each trace digest. Pass a new canonical
output path to retain them elsewhere: `bun run trace:demo /path/to/new-output`.
Existing outputs are never overwritten. These are diagnostic trace artifacts,
not lossless capsules or replay checkpoints.
Keep collection output outside version control; the fork ignores `trace-v1-*`
capture directories and its conventional root `trace-artifacts` directory.
Alternatively, run `bun test --timeout 60000` and `bun run script/demo.ts` from
`packages/trace`. The demo uses the replay fixture's real SDK host, production
runner/tools/provider parser and scripted transport with pinned instructions,
memory files and no ambient personal configuration or live models. It compares
five tracing-off/on pairs, checking equal native context/world/outcome and reporting
elapsed p50/p95, CPU, process RSS, trace bytes, queue peaks and drops. These tiny,
cold/warm-mixed local samples are not representative overhead benchmarks or a
zero-overhead claim. Temporary worlds and body-bearing fixture archives are
removed by scoped cleanup; only the sanitized metadata copies and measurements remain.
