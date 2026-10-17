# What is durable, and what is ready?

Status checked against this fork on **17 October 2026**. The native reasoning loop,
session persistence, trace collector, microVM experiments and evaluator are
different capabilities, not one finished hosted product.

## Can I use this for everyday coding and store it somewhere I own?

**Not as a turnkey VM-backed, automatically archived coding service yet.**

- Normal OpenCode runs its native coding tools. The experimental `MachineRuntime`
  port can provision and branch SmolVM machines, but it is not a registered
  `WorkspaceDriver` returning a complete `EnvironmentDriver`. Selecting it does
  not currently redirect ordinary Session tools into a VM.
- `@opencode/trace` is opt-in for embedded SDK hosts. It writes bounded,
  privacy-filtered metadata into a caller-owned local directory. It is not enabled
  in the installed client, and it does not retain prompts, code, tool results or
  complete replay observations. See [trace coverage](../trace/README.md).
- No automatic S3/R2/other remote sink is configured. Local persistence is not
  off-host backup. Choose a private destination, access policy, retention policy
  and content policy before enabling an uploader; never publish personal traces
  into this repository.
- `smolvm:probe` is a synthetic CLI lifecycle/timing experiment, not a native
  coding Session or a security acceptance suite. `smolvm:evaluate` adds a separate
  fixed-artifact scoring experiment; it does not change that integration status.

The remaining daily-use work is a complete environment adapter with filesystem,
process, cancellation and reconnect conformance; a persistent embedded host;
explicit capture/sink selection; and a process-kill/reopen acceptance test tying
Session identity, VM binding and stored evidence together. No live installation
or personal-session migration is implied by these experiments.

## Are Sessions durable?

**With persistent storage, yes; by default in the embedded SDK, no.**

- [`EmbeddedHost.create`](../sdk/src/internal/host.ts) defaults to
  `database.path: ":memory:"`. A host can instead pass
  `OpenCode.create({ database: { path: "/absolute/private/session.sqlite" } })`.
  Reopen the same private database to retain projected Sessions and pending work.
- [`SessionInbox`](../core/src/session/inbox.ts) durably admits prompts before
  execution; retrying the same compatible input ID adopts the first admission.
- [`SessionRestart`](../core/src/session/execution/restart.ts) finds unreleased
  execution claims and resumes orphaned work, with bounded persisted restart
  attempts. This is process-local recovery, **not** clustered ownership,
  exactly-once external effects, or arbitrary function-stack restoration.
- SQLite uses WAL with `synchronous=NORMAL`. Process-crash recovery is not a
  guarantee that the latest commit survives sudden power/storage failure. An
  owner-controlled backup and restore policy is still needed.
- Closing an SDK scope releases its services. The temporary synthetic fixtures
  intentionally remove their working databases/worlds; saving a report does not
  make those fixture Sessions resumable.
- A VM checkpoint and a conversation fork capture different state. Neither
  restores external providers, remote peers or every host side effect. A restored
  file marker alone does not prove a running process or RAM image was restored.

[`session-durability.test.ts`](test/session-durability.test.ts) closes and reopens
real embedded hosts: a file database retains a Session and one idempotently
admitted parked prompt; the default memory database does not. It makes no provider
calls. Core's `session-execution.test.ts` separately tests recovery claims and
restart accounting. Neither test establishes VM/Session recovery as one unit.

## Why an evaluator? Does it require Docker?

The evaluator decides whether a result satisfies a host-controlled task contract.
An agent reporting success, a tool exiting zero, and the task actually passing are
three different facts.

Docker is one existing containment backend for **executing** repository tests.
It is not necessary for every evaluator, and a container does not make a grader
honest. The existing Bun/JUnit verifier remains a trusted-fixture oracle: code in
the same process can subvert its own report.

The artifact evaluator takes a narrower path: freeze bounded configuration bytes
exported from a synthetic VM, validate them as data, then apply fixed rules outside
the guest. It never executes candidate code on the host, so that checker needs
neither Docker nor another VM. Hashes bind receipts to collected bytes; they are
not proof of an uncompromised guest, authenticated authorship, or that the running
service actually used that configuration. Keep runtime observation/attestation as
a separate future gate.

## Compared with Pi Durable

**Pi Durable is more directly aimed at durable application/task execution than
our VM probe and metadata collector.** Do not confuse it with the ordinary Pi
coding agent's resumable JSONL conversation history.

| Concern             | This OpenCode fork                                                                         | Pi Durable's documented contract                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Session storage     | SQLite-backed native Sessions/inbox; embedded default is memory                            | Memory, SQLite, JSONL and Cloudflare Durable Object adapters                                        |
| Restart             | Execution claims, bounded recovery and native history reload                               | Checkpointed generation/tool/custom tasks resume from stored phases                                 |
| Interrupted effects | No exactly-once external-effect guarantee                                                  | Tools rerun only when declared replay-safe; unsafe interrupted tools produce an interruption result |
| Nested calls        | Not claimed durable by this replay profile                                                 | Stable nested-call keys and a journaled deterministic Code Mode recovery contract                   |
| Environment         | Existing Workspace/Environment ports; experimental Smol port not yet wired to native tools | Per-call `ExecutionEnv`, replaceable independently of storage                                       |
| VM reset / training | Narrow synthetic experiments, not general range/RL readiness                               | Harness durability does not itself snapshot machines or supply trustworthy rewards                  |

Pi Durable also requires one storage owner at a time; it does not provide magical
cross-process exactly-once effects. Replay-safe tools with external effects still
need idempotency. It is experimental. Its durability design is useful comparative
evidence, **not** a reason to replace OpenCode's native reasoning loop here.

Sources retrieved 17 October 2026: [Pi Durable announcement](https://earendil.com/posts/pi-durable/),
[pinned package contract](https://github.com/earendil-works/pi/blob/c268154ca1171c2f9eefe75d3d7372a68aada2d5/packages/durable/README.md),
and [Cloudflare integration example](https://github.com/earendil-works/pi-durable-cloudflare).
This comparison uses documentation/source inspection, not a cross-harness runtime
benchmark. No personal transcript, credential or live service was inspected.
