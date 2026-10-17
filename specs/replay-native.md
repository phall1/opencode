# Replay-native execution substrate

## Decision

Build an opt-in execution mode around OpenCode's native embedded host. Keep one
reasoning loop, provider parser, tool dispatcher, and session history. Do not
start a new coding harness, scheduler, workflow language, or training platform.

The useful experiment is not “can a transcript be displayed?” It is “can a
finished execution be reproduced from its retained observations, then can a new
execution start from the matching historical context and world state?”

## Five fundamentals

| Fundamental  | Meaning                                                                          | Required distinction                                         |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Execution    | A policy consuming observations and producing actions through the native runtime | A recorded model answer is not a newly sampled answer        |
| Episode      | Immutable inputs, observations, outcomes, and provenance for one execution       | UI telemetry is not a lossless episode                       |
| Checkpoint   | Agent context and supported world state at the same quiescent boundary           | Copying messages does not restore files or services          |
| Continuation | New actions from a checkpoint, with their own observations and outcomes          | New actions cannot borrow unrelated answers from an old tape |
| Measurement  | A versioned judgment of immutable evidence                                       | Regrading is not rerunning an agent                          |

These fundamentals compose without a universal environment implementation. A
file fixture, a service lab, and a cyber range can have different state adapters
while declaring exactly what they can capture and restore.

## One path, different effect providers

```text
prompt / restored context
          ↓
native OpenCode host → provider encoding/parsing → native tool dispatcher
          ↓                                       ↓
recorded or simulated model transport       supported world capabilities
          └──────────────────┬────────────────────┘
                             ↓
                   immutable episode capsule
                             ↓
               independent versioned measurement
```

Record delegates supported actions to their real implementation and commits the
delivered observation before returning it. Strict replay matches the action and
returns its retained observation without invoking that implementation. Simulation
supplies a declared world model or scripted transport through the same runtime.
A continuation changes the input or policy and creates a new suffix.

Replacing the entire LLM client is useful for orchestration unit tests but does
not demonstrate native provider-path fidelity. The finite acceptance profile
replaces outbound transport while exercising the real provider wire parser.

## Evidence contract

### Independent artifact scoring

An evaluator need not execute candidate code. For bounded configuration tasks,
collect immutable bytes, reject missing/truncated/oversized or malformed inputs,
and evaluate them with host-owned, versioned rules. Bind each append-only receipt
to its artifact and verifier digests. Offline remeasurement must not start a VM,
invoke a provider, or rewrite the collected evidence. A valid but incorrect
configuration fails; an unavailable observation is unknown, not a negative score.

This separates the scorer from the actor without making Docker a universal
dependency. It establishes facts about the collected data, not an uncompromised
guest or actual running-service behavior. Generic executable-code grading still
needs its own containment and oracle-integrity acceptance. See
[current integration and durability limits](../packages/replay/READINESS.md).

### Recording and restoration

- Pin the runtime, policy, instructions, tool contracts, task inputs, and supported
  environment profile. Capture final effective requests, not just pre-hook drafts.
- Give each observation a stable identity and an owning execution. Serial
  occurrence order is sufficient only for an explicitly serial profile.
- Validate retained data at its owning boundary. Integrity checks detect changed
  bytes relative to the trusted manifest; hashes alone do not establish authorship.
- Missing, mismatched, corrupt, or unused observations fail strict replay. Never
  quietly fall back to live I/O or declare a partially replayed episode complete.
- Strict replay invokes no live model/world capability, including current task
  file reads. Reading the archive and writing episode-local projections are
  permitted. Independent artifact verification is a separate operation.
- Restore the world before admitting new actions. A replayed successful write
  receipt does not itself reconstruct that write's world state.
- A checkpoint is accepted only at a supported settled boundary. Mutable state
  outside its declared coverage must not be presented as historically restored.
- Preserve the parent episode when creating a continuation or new measurement.
  Missing verifier inputs mean “not regradable,” not fabricated evidence.

## First bounded profile

Start with synthetic fixtures, direct serial file tools, scripted model HTTP,
and isolated text-file state. Prove cold replay after the original host is gone,
request mismatch rejection, two independent restores, changed child state, and
verifier-only remeasurement.

This profile must explicitly exclude arbitrary plugins, Code Mode host fetch,
concurrent nested calls, shells, detached processes, browsers, remote services,
and opaque model state until each has a tested capture/restore contract. A memory
workspace is a contained fixture, not a security sandbox for hostile plugin code.

Replay mechanics alone do not measure model ability. A separately authorized
fresh model rollout is a different experiment, with its own costs and outcomes.

## How phux, evals, and RL fit

OpenCode owns execution. The capsule retains evidence. phux can observe and
control the execution; ops can index its digest and outcomes. Neither system's
bounded telemetry becomes the authoritative archive.

A range adapter supplies an isolated resettable world and independent verifier.
Harbor/ATIF can project task/trajectory/artifact data without becoming the native
execution engine. An RL-facing `reset(checkpoint)` and `step(action)` interface
must call the same world executor, keep hidden verifier state out of actor
observations, and distinguish budget truncation from success or failure.

Recorded observations can support logged behavior. They cannot answer arbitrary
counterfactual actions; those require a restored real world or an explicitly
labeled simulator. Keep data splits by root scenario, not sibling continuation.

## Expansion gates

1. Complete cold replay and strict rejection on the finite profile.
2. Checkpoint isolation and historical context fidelity.
3. Explicit child/nested identities and captured completion order.
4. Crash uncertainty: an effect without a committed receipt is unknown, not
   silently safe to repeat. Reconcile receipts/idempotency or refuse continuation.
5. One benign, independently verified range task with denied production access.
6. Only then compare policies, collect representative rollouts, or train.

Pass evidence and actual coverage live with the implementation and its tests;
this specification does not claim that all expansion gates are already met.

## Native metadata tracing

Broad instrumentation and strict replay have different contracts. Start with
opt-in local metadata collection around the existing native execution, not a
second agent loop or a vendor tracing SDK as the domain model. Metadata can
diagnose admissions, delivery, execution, steps and tools; it cannot reconstruct
provider payloads, missing observations, environment checkpoints or training
token IDs/logprobs.

Project an explicit field allowlist at the native observation seam **before** any
collector-owned queue. Exclude prompts, reasoning, instructions, tool input and
output, errors/stacks, paths, environment values, URLs/headers and arbitrary
plugin metadata. Default to pseudonymous causal identities; do not mistake
message identity for a Physical Attempt. Require an explicit Session allowlist
or an explicit host-wide opt-in. Disabled collection creates no artifact or
exporter traffic.

Native plugin `event.subscribe` uses an unbounded body-bearing Bus subscription;
remote HTTP subscriptions instead use the separately bounded serialized event
feed. Neither establishes a fully bounded metadata pipeline. The first collector
must use native pre-queue projection and a nonblocking bounded metadata queue,
with no filesystem or network work in the publication callback. Preserve native
publication/projection semantics and the existing reasoning loop.

Bound records, bytes, file storage and shutdown drain. Show dropped records,
collector failures and incomplete coverage rather than hiding them. Collector
failure must not alter agent control flow; collection completion is not task
success or a lossless-archive claim. Synthetic acceptance must plant sensitive
content across supported channels, exercise backpressure/failures/interruption,
and compare native results with collection disabled/enabled. Measure overhead;
do not claim it is free.

Environment adapters remain below OpenCode's native runtime. Docker, a local
microVM and a managed sandbox may differ in execution and snapshot capabilities;
none changes the metadata contract or supplies a trustworthy RL reward by itself.
Add only capabilities demonstrated by a concrete adapter and workload, not a
speculative universal backend registry.

## Repository experiment acceptance

The next useful checkpoint is a completed assessment **before any repair**. A
native execution can succeed in inspecting a task whose independent tests still
fail. Execution success, task success, budget truncation, and an uncertain effect
must remain separate facts.

The finite repository profile must demonstrate:

- Declared inputs, writable paths, prompts, instructions, budgets, and provenance.
- Actual disposable disk files, not a file-world simulation presented as a repo.
- An unchanged assessment checkpoint, two native forks with independent restored
  worlds, and fresh suffix observations for each continuation.
- An external verifier running against fresh copies of frozen artifacts. Its
  held-out tests never enter the actor's world and cannot be edited by the actor.
- Baseline failure, a general repair passing, and an overfit repair failing the
  held-out checks. This tests evaluation mechanics, not model intelligence.
- Complete cold replay without provider, tool, task-file, or verifier execution;
  verification is a separate, explicit operation.
- No ambient provider discovery: host-global credential/configuration reads and
  provider CLI subprocesses are outside the profile too, not invisible exceptions
  to its zero-live counters.
- Immutable capsules, separate measurements, and a portable comparison carrying
  evidence digests and measured outcomes, not just an agent's success message.
- A write-ahead action fact and a committed receipt. An effect without a receipt
  is **unknown**; replay, fork, and comparison must not silently treat it as
  complete or rerun it.

Scripted policies and trusted synthetic executable fixtures remain the first
supported workload. A clean subprocess environment and an argv allowlist are not
OS containment: JavaScript can still read host files, spawn processes, or make
network requests. Explicit acknowledgement is required before running custom
local code; an untrusted or live-policy workload requires a separately verified
containment capability before it is admitted.

Do not add range workloads, live-model comparisons, or training until these gates
have concrete evidence. A report consumable by phux/ops is not a new scheduler,
and a successful scripted comparison is not evidence of RL efficacy.

## Verifier containment gate

Containment is an explicit capability, not an automatically selected fallback.
The first contained verifier uses one fixed Docker profile for local macOS/Linux
and Linux CI. Runtime admission requires an available local Unix-socket engine
and an already-cached digest-pinned Bun image; it must not start a daemon, pull an
image, or run the candidate on the host when admission fails.

Before admitting executable fixture code, inspect the created container's
effective configuration. Require no network, a read-only root filesystem, one
read-only mount of freshly restored verifier inputs, bounded writable tmpfs,
non-root identity, no added capabilities, no-new-privileges, private process
namespaces, and finite memory/CPU/PID budgets. Do not expose credentials, the
Docker socket, host process namespaces, or writable host directories.

Admission intent is not enforcement evidence. Acceptance must exercise actual
denials with owned synthetic host-file and credential canaries, a reachable
network positive control, read-only source mutations, and descendant cleanup.
Timeout, resource exhaustion, incomplete reports, and cleanup uncertainty are
not task success. Cleanup affects only the exact execution-owned container.
Controller/admission errors are not failed task assertions. An unavailable or
ambiguous Docker execution leaves incomplete evidence rather than an ordinary
test-failure receipt. Cancellation must finish owned-process cleanup before the
public operation settles; cancelling an observer alone does not cancel its
underlying effect.

Measurements retain requested/effective isolation, implementation/runtime/image
identity, limits, and observed completion. Existing host-only measurements stay
host-only; remeasurement never upgrades their evidence in place. Strict cold
replay does not probe Docker or launch a verifier.

This gate constrains the candidate's host access. It does **not** make an
in-process Bun test framework or candidate-writable JUnit output an independent,
tamper-proof reward oracle. Executable-code trust acknowledgement remains
required, and untrusted/live-policy rollouts stay gated on verifier integrity.
Containers also retain a trusted engine/kernel/image boundary, not an assurance
against kernel exploits or hostile administrators.

Primary platform references: [Docker security](https://docs.docker.com/engine/security/),
[none networking](https://docs.docker.com/engine/network/drivers/none/), and
[tmpfs lifetime and limits](https://docs.docker.com/engine/storage/tmpfs/).
