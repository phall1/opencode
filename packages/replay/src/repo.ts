import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect, Schema, type Scope } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { NativeExport, durableWrite, encode, hash } from "./archive"
import {
  RepoCapsule,
  freezeRepo,
  repoBlob,
  repoContext,
  repoFiles,
  repoHttp,
  repoParent,
  repoTask,
  repoTools,
  saveRepo,
  validateRepo,
} from "./repo-archive"
import { Task, decodeTask, virtual, type Policy } from "./repo-task"
import { diskWorld, poisonWorld, snapshotDisk } from "./repo-world"
import { ToolTape } from "./tape"
import {
  ROOT,
  SESSION_ID,
  contextView,
  createHost,
  exportText,
  makeRunDirectory,
  runPrompt,
  sourcePins,
  textResponse,
  toolResponse,
  withScratch,
  type Counters,
  type HostProfile,
} from "./runtime"
import { measureRepo, requireTrust } from "./repo-measure"
import { compareRepo } from "./repo-report"

export { Task, Action, RepoFiles, demoTask, decodeTask, type Policy } from "./repo-task"
export { RepoCapsule, RepoManifest, openRepo, saveRepo, validateRepo } from "./repo-archive"
export { RepoMeasurement, measureRepo } from "./repo-measure"
export { compareRepo } from "./repo-report"

const REPO_SOURCES = [
  "packages/replay/src/repo.ts",
  "packages/replay/src/repo-task.ts",
  "packages/replay/src/repo-world.ts",
  "packages/replay/src/repo-archive.ts",
  "packages/replay/src/scratch.ts",
  "packages/core/src/environment/local.ts",
  "packages/util/src/global.ts",
  "packages/http-recorder/src/cassette/model.ts",
  "packages/http-recorder/src/http/model.ts",
]
const repoPins = () => ({
  ...sourcePins(),
  ...Object.fromEntries(REPO_SOURCES.map((file) => [file, hash(readFileSync(path.join(ROOT, file), "utf8"))])),
})
const counts = (): Counters => ({ provider: 0, http: 0, failures: [] })
// Serialized JSON may escape one UTF-8 byte as six bytes; the driver bounds actual file bytes.
const rules = (task: Task) => ({
  read: task.readPaths.map(virtual),
  write: task.writePaths.map(virtual),
  tools: task.budgets.tools,
  bytes: task.budgets.fileBytes * 6 + 1024,
})

function profile(task: Task, policy: "assessment" | Policy, world = poisonWorld()): HostProfile {
  const actions =
    policy === "assessment"
      ? [
          ...task.readPaths.map((file) => ({ kind: "read" as const, path: file })),
          { kind: "text" as const, text: "Assessment complete; no edits made." },
        ]
      : task.policies[policy]
  return {
    instructions: task.instructions,
    steps: task.budgets.steps,
    requests: task.budgets.requests,
    world,
    responses: actions.map((action, index) => {
      if (action.kind === "text") return textResponse(action.text)
      return toolResponse(`repo-${policy}-${index}`, action.kind, {
        path: virtual(action.path),
        ...(action.kind === "write" ? { content: action.content } : {}),
      })
    }),
  }
}

function requirePins(capsule: RepoCapsule) {
  validateRepo(capsule)
  if (capsule.manifest.identity.bun !== Bun.version || encode(capsule.manifest.identity.sources) !== encode(repoPins()))
    throw new Error("Repo runtime/source pin mismatch")
}

function capture(input: {
  task: Task
  policy: "assessment" | Policy
  files: typeof Task.Type.files
  context: typeof NativeExport.Type
  tape: ToolTape
  counters: Counters
  directory: string
  elapsedMs: number
  parent?: RepoCapsule
}) {
  input.tape.assertComplete()
  if (input.counters.failures.length) throw new Error(input.counters.failures.join("; "))
  const plan = profile(input.task, input.policy)
  if (input.counters.provider !== plan.responses.length) throw new Error("Scripted plan incomplete/budget truncation")
  const blobs: Record<string, string> = {}
  const put = (text: string) => {
    const id = hash(text)
    blobs[id] = text
    return id
  }
  return freezeRepo(
    {
      version: 1,
      profile: "scripted-repo-v1",
      state: "complete",
      task: put(encode(input.task)),
      policy: input.policy,
      prompt: input.policy === "assessment" ? input.task.assessmentPrompt : input.task.repairPrompt,
      identity: identity(input.parent),
      initial: put(encode(input.parent ? repoFiles(input.parent, "checkpoint") : input.task.files)),
      checkpoint: put(encode(input.files)),
      context: put(exportText(input.context)),
      tools: put(encode(input.tape.entries)),
      http: put(readFileSync(path.join(input.directory, "provider.json"), "utf8")),
      ...(input.parent ? { parent: put(encode(input.parent)) } : {}),
      evidence: {
        elapsedMs: input.elapsedMs,
        elapsedScope: input.parent ? "cold prefix restore+fork+new rollout" : "assessment host+rollout",
        requests: input.counters.http,
        provider: input.counters.provider,
        tools: input.tape.entries.length,
        outcome: "succeeded",
        nativeUsage: suffixUsage(input.context, input.parent),
        realCost: "UNKNOWN/not measured (scripted)",
      },
    },
    blobs,
  )
}

function identity(parent?: RepoCapsule) {
  return parent?.manifest.identity ?? { bun: Bun.version, sources: repoPins(), model: "fixture/repair-v1" as const }
}

function suffixUsage(context: typeof NativeExport.Type, parent?: RepoCapsule) {
  const prefix = parent ? repoContext(parent).messages.filter((message) => message.type === "assistant").length : 0
  return {
    scope: "new assistant messages only, excluding ancestor prefix",
    accounting: "scripted fixture accounting; not real model tokenization",
    priceUSD: null,
    messages: Schema.encodeSync(NativeExport)(context)
      .messages.filter((message) => message.type === "assistant")
      .slice(prefix)
      .map((message) => ({ tokens: message.tokens ?? null, cost: message.cost ?? null })),
  }
}

/** Persist intent before any native effect. No retry or crash-resume protocol. */
const tracked = <A, E, R>(directory: string, name: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    durableWrite(
      path.join(directory, `${name}.started.json`),
      encode({ state: "started", name, missingReceipt: "UNKNOWN; do not repeat" }),
    )
    const result = yield* effect
    durableWrite(path.join(directory, `${name}.receipt.json`), encode({ state: "completed", name }))
    return result
  })

const assessment = Effect.fn("Repo.assessment")(function* (task: Task, directory: string, scratch: string) {
  const started = performance.now()
  const counters = counts()
  const tape = new ToolTape("record", directory, [], rules(task))
  const actor = path.join(scratch, "assessment-world")
  const host = yield* createHost({
    directory,
    globalDirectory: scratch,
    tape,
    files: {},
    counters,
    profile: profile(task, "assessment", diskWorld(actor, task, task.files)),
  })
  yield* tracked(
    directory,
    "create",
    host.opencode.sessions.create({
      id: SESSION_ID,
      agent: Agent.ID.make("fixture"),
      location: host.location,
      title: "Repo assessment",
    }),
  )
  const context = yield* tracked(directory, "assessment", runPrompt(host.opencode, SESSION_ID, task.assessmentPrompt))
  return capture({
    task,
    policy: "assessment",
    files: snapshotDisk(actor, task),
    context,
    tape,
    counters,
    directory,
    elapsedMs: performance.now() - started,
  })
})

type Host = Effect.Success<ReturnType<typeof createHost>>
type Restored = { host: Host; sessionID: Session.ID; context: typeof NativeExport.Type; http: number; tools: number }
const restore: (
  capsule: RepoCapsule,
  directory: string,
  observations?: { world: number; process: number },
) => Effect.Effect<Restored, unknown, Scope.Scope> = Effect.fn("Repo.restore")(
  function* (capsule, directory, observations) {
    requirePins(capsule)
    const task = repoTask(capsule)
    const parent = repoParent(capsule)
    durableWrite(path.join(directory, "provider.json"), repoBlob(capsule, capsule.manifest.http))
    if (parent) {
      const prefix = yield* restore(parent, makeRunDirectory(directory, "parent"), observations)
      const sessionID = yield* nativeFork(prefix.host, prefix.sessionID, poisonWorld(observations), directory)
      const trajectory = yield* prefix.host.beginTrajectory(directory, repoTools(capsule))
      const context = yield* runPrompt(prefix.host.opencode, sessionID, capsule.manifest.prompt)
      assertReplay(capsule, context, trajectory.tape, trajectory.counters, prefix.context)
      return {
        host: prefix.host,
        sessionID,
        context,
        http: prefix.http + trajectory.counters.http,
        tools: prefix.tools + trajectory.tape.consumed,
      }
    }
    const tape = new ToolTape("replay", directory, repoTools(capsule), rules(task))
    const counters = counts()
    const host = yield* createHost({
      directory,
      tape,
      counters,
      files: {},
      profile: profile(task, "assessment", poisonWorld(observations)),
    })
    yield* host.opencode.sessions.create({
      id: SESSION_ID,
      agent: Agent.ID.make("fixture"),
      location: host.location,
      title: "Repo assessment",
    })
    const context = yield* runPrompt(host.opencode, SESSION_ID, capsule.manifest.prompt)
    assertReplay(capsule, context, tape, counters)
    return { host, sessionID: SESSION_ID, context, http: counters.http, tools: tape.consumed }
  },
)

const nativeFork = Effect.fn("Repo.nativeFork")(function* (
  host: Host,
  sessionID: Session.ID,
  world: Host["world"],
  directory: string,
) {
  const child = yield* tracked(directory, "fork", host.opencode.sessions.fork({ sessionID }))
  const location = yield* tracked(directory, "attach", host.attach(world))
  yield* tracked(directory, "move", host.opencode.sessions.move({ sessionID: child.id, ...location }))
  yield* host.opencode.sessions.wait({ sessionID: child.id })
  return child.id
})

function toolCount(context?: typeof NativeExport.Type) {
  return context
    ? context.messages.flatMap((message) =>
        message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
      ).length
    : 0
}
function assertReplay(
  capsule: RepoCapsule,
  context: typeof NativeExport.Type,
  tape: ToolTape,
  counters: Counters,
  prefix?: typeof NativeExport.Type,
) {
  tape.assertComplete()
  if (counters.failures.length) throw new Error(counters.failures.join("; "))
  if (toolCount(context) !== toolCount(prefix) + tape.consumed) throw new Error("Uncaptured native tool")
  if (contextView(context.messages) !== contextView(repoContext(capsule).messages))
    throw new Error("Repo native replay context mismatch")
  requireHttpConsumption(capsule, counters)
  if (counters.provider || tape.live) throw new Error("Live repo component during replay")
}

function requireHttpConsumption(capsule: RepoCapsule, counters: Counters) {
  const http = repoHttp(capsule)
  if (counters.http !== http.interactions.length) throw new Error("Unused repo HTTP results")
}

export const replayRepo = Effect.fn("Repo.replay")(function* (capsule: RepoCapsule) {
  const observations = { world: 0, process: 0 }
  return yield* withScratch((directory) =>
    restore(capsule, directory, observations).pipe(
      Effect.map((result) => {
        if (observations.world || observations.process) throw new Error("Live world/process during replay")
        return {
          digest: capsule.digest,
          equal: true,
          live: { provider: 0, tool: 0, ...observations },
          consumed: { http: result.http, tool: result.tools },
        }
      }),
    ),
  ).pipe(Effect.scoped, Effect.timeout("60 seconds"))
})

const continuation = Effect.fn("Repo.continuation")(function* (
  capsule: RepoCapsule,
  policy: Policy,
  directory: string,
  scratch: string,
) {
  const task = repoTask(capsule)
  const started = performance.now()
  const prefix = yield* restore(capsule, makeRunDirectory(scratch, "prefix"))
  const actor = path.join(scratch, "child-world")
  const sessionID = yield* nativeFork(
    prefix.host,
    prefix.sessionID,
    diskWorld(actor, task, repoFiles(capsule, "checkpoint")),
    directory,
  )
  const trajectory = yield* prefix.host.beginTrajectory(directory, undefined, profile(task, policy))
  const context = yield* tracked(directory, "repair", runPrompt(prefix.host.opencode, sessionID, task.repairPrompt))
  if (toolCount(context) !== toolCount(prefix.context) + trajectory.tape.entries.length)
    throw new Error("Uncaptured continuation tool")
  return capture({
    task,
    policy,
    parent: capsule,
    files: snapshotDisk(actor, task),
    context,
    ...trajectory,
    directory,
    elapsedMs: performance.now() - started,
  })
})

function depth(capsule: RepoCapsule): number {
  const parent = repoParent(capsule)
  return parent ? depth(parent) + 1 : 0
}
export const forkRepo = Effect.fn("Repo.fork")(function* (
  capsule: RepoCapsule,
  directory: string,
  trustLocalCode: boolean,
  policy: Policy = "general",
) {
  requireTrust(trustLocalCode)
  requirePins(capsule)
  if (depth(capsule) >= 4) throw new Error("Maximum four repo forks")
  durableWrite(
    path.join(directory, "planned.json"),
    encode({
      profile: "scripted-repo-v1",
      parent: capsule.digest,
      policy,
      task: repoTask(capsule),
      state: "planned; incomplete evidence is not replayable",
    }),
  )
  return yield* withScratch((scratch) => continuation(capsule, policy, directory, scratch)).pipe(
    Effect.scoped,
    Effect.timeout("60 seconds"),
  )
})

/** Trusted synthetic plans only; neither live model evaluation nor OS containment. */
export const experiment = Effect.fn("Repo.experiment")(function* (
  input: unknown,
  output: string,
  trustLocalCode: boolean,
) {
  requireTrust(trustLocalCode)
  const task = decodeTask(input)
  return yield* withScratch((scratch) =>
    Effect.gen(function* () {
      const directory = makeRunDirectory(path.dirname(path.resolve(output)), path.basename(output))
      durableWrite(
        path.join(directory, "planned.json"),
        encode({
          task,
          state: "planned",
          mode: "scripted; trusted; no OS containment",
          policies: ["assessment", "general", "overfit"],
        }),
      )
      const parent = yield* assessment(task, makeRunDirectory(directory, "assessment-run"), scratch).pipe(Effect.scoped)
      saveRepo(path.join(directory, "checkpoint.json"), parent)
      const baseline = yield* Effect.promise(() => measureRepo(parent, "heldout", directory, true))
      const general = yield* forkRepo(parent, makeRunDirectory(directory, "general-run"), true, "general")
      const overfit = yield* forkRepo(parent, makeRunDirectory(directory, "overfit-run"), true, "overfit")
      saveRepo(path.join(directory, "general.json"), general)
      saveRepo(path.join(directory, "overfit.json"), overfit)
      if (encode(snapshotDisk(path.join(scratch, "assessment-world"), task)) !== encode(task.files))
        throw new Error("Original actor world changed")
      const measurements = yield* Effect.promise(async () =>
        Promise.all(
          [general, overfit].map(async (capsule) => ({
            capsule,
            public: await measureRepo(capsule, "public", directory, true),
            heldout: await measureRepo(capsule, "heldout", directory, true),
          })),
        ),
      )
      const report = compareRepo(parent, baseline, measurements, directory)
      durableWrite(
        path.join(directory, "completed.json"),
        encode({ state: "completed", checkpoint: parent.digest, report: report.file, originalUnchanged: true }),
      )
      return {
        directory,
        checkpoint: parent.digest,
        baseline: baseline.status,
        originalUnchanged: true,
        report,
        continuations: measurements.map((entry) => ({
          policy: entry.capsule.manifest.policy,
          digest: entry.capsule.digest,
          public: entry.public.status,
          heldout: entry.heldout.status,
        })),
      }
    }),
  ).pipe(Effect.scoped, Effect.timeout("120 seconds"))
})
