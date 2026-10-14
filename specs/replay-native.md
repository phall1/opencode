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
