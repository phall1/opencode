import { Effect, Schema, type Scope } from "effect"
import { readFileSync } from "node:fs"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Environment } from "@opencode/core/environment/index"
import {
  Capsule,
  MAX_ANCESTRY,
  Files,
  ToolEntry,
  NativeExport,
  blob,
  ancestryDepth,
  decodeFiles,
  decodeTools,
  durableWrite,
  encode,
  freeze,
  hash,
  parent,
  save,
  validate,
} from "./archive"
import { ToolTape } from "./tape"
import {
  INITIAL,
  INSTRUCTIONS,
  PROMPT,
  SESSION_ID,
  contextView,
  createHost,
  exportText,
  makeRunDirectory,
  makeWorld,
  runPrompt,
  snapshotWorld,
  sourcePins,
  withScratch,
  type Counters,
} from "./runtime"

export { Capsule, open, save } from "./archive"
export { measure } from "./measure"

export const record = Effect.fn("Replay.record")(function* (file: string) {
  return yield* withScratch((directory) =>
    Effect.gen(function* () {
      const counters: Counters = { provider: 0, http: 0, failures: [] }
      const tape = new ToolTape("record", directory)
      const host = yield* createHost({ directory, tape, files: INITIAL, counters })
      yield* host.opencode.sessions.create({
        id: SESSION_ID,
        agent: Agent.ID.make("fixture"),
        location: host.location,
        title: "Bounded repair",
      })
      const context = yield* runPrompt(host.opencode, SESSION_ID, PROMPT)
      tape.assertComplete()
      assertToolCoverage(context, tape.entries.length)
      if (counters.failures.length) return yield* Effect.die(counters.failures.join("; "))
      const checkpoint = yield* snapshotWorld(host.world)
      if (checkpoint["/fixture/repair.txt"] !== "the small fixture\n")
        return yield* Effect.die("Native fixture repair failed")
      const capsule = assemble({
        initial: INITIAL,
        checkpoint,
        prompt: PROMPT,
        context,
        tools: tape.entries,
        http: readFileSync(`${directory}/provider.json`, "utf8"),
      })
      save(file, capsule)
      return { capsule, live: { provider: counters.provider, tool: tape.live }, requests: counters.http }
    }),
  ).pipe(Effect.scoped, Effect.timeout("30 seconds"))
})

function assemble(input: {
  initial: typeof Files.Type
  checkpoint: typeof Files.Type
  prompt: string
  context: typeof NativeExport.Type
  tools: readonly ToolEntry[]
  http: string
  parent?: Capsule
}) {
  const blobs: Record<string, string> = {}
  const put = (text: string) => {
    const id = hash(text)
    blobs[id] = text
    return id
  }
  return freeze(
    {
      version: 1,
      profile: "serial-text-files-v1",
      prompt: input.prompt,
      identity: input.parent?.manifest.identity ?? {
        bun: Bun.version,
        effect: "4.0.6",
        sources: sourcePins(),
        model: "fixture/repair-v1",
        instructions: INSTRUCTIONS,
        policy: "read-write-only;fixed-tree;steps=4;no-formatters",
      },
      initial: put(input.parent ? blob(input.parent, input.parent.manifest.checkpoint) : encode(input.initial)),
      checkpoint: put(encode(input.checkpoint)),
      tools: put(encode(input.tools)),
      http: put(input.http),
      context: put(exportText(input.context)),
      ...(input.parent ? { parent: put(encode(input.parent)) } : {}),
    },
    blobs,
  )
}

function requireProfile(capsule: Capsule) {
  validate(capsule)
  if (capsule.manifest.identity.bun !== Bun.version) throw new Error("Bun runtime pin mismatch")
  if (encode(capsule.manifest.identity.sources) !== encode(sourcePins())) throw new Error("Native source pins mismatch")
  if (capsule.manifest.identity.instructions !== INSTRUCTIONS) throw new Error("Instruction pin mismatch")
}

function toolCalls(context: typeof NativeExport.Type) {
  return context.messages.flatMap((message) =>
    message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
  )
}
function assertToolCoverage(context: typeof NativeExport.Type, count: number) {
  const calls = toolCalls(context)
  if (calls.length !== count || calls.some((call) => call.name !== "read" && call.name !== "write"))
    throw new Error("Unsupported or uncaptured native tool invocation")
}

const HttpTape = Schema.Struct({ interactions: Schema.Array(Schema.Unknown) })

type Host = Effect.Success<ReturnType<typeof createHost>>
type Restored = {
  host: Host
  world: Environment.Driver
  sessionID: Session.ID
  context: typeof NativeExport.Type
  counters: Counters
  tape: ToolTape
  consumed: { http: number; tool: number }
}

const forkWorld = Effect.fn("Replay.forkWorld")(function* (
  host: Host,
  sessionID: Session.ID,
  world: Environment.Driver,
) {
  const child = yield* host.opencode.sessions.fork({ sessionID })
  const location = yield* host.attach(world)
  yield* host.opencode.sessions.move({ sessionID: child.id, ...location })
  yield* host.opencode.sessions.wait({ sessionID: child.id })
  return child.id
})

const restorePrefix: (capsule: Capsule, directory: string) => Effect.Effect<Restored, unknown, Scope.Scope> = Effect.fn(
  "Replay.restorePrefix",
)(function* (capsule, directory) {
  requireProfile(capsule)
  const ancestor = parent(capsule)
  if (ancestor) {
    const prefix = yield* restorePrefix(ancestor, makeRunDirectory(directory, "parent"))
    const world = yield* makeWorld(decodeFiles(capsule, "checkpoint"))
    const sessionID = yield* forkWorld(prefix.host, prefix.sessionID, world)
    durableWrite(`${directory}/provider.json`, blob(capsule, capsule.manifest.http))
    const trajectory = yield* prefix.host.beginTrajectory(directory, decodeTools(capsule))
    const context = yield* runPrompt(prefix.host.opencode, sessionID, capsule.manifest.prompt)
    assertReplay(capsule, context, trajectory, toolCalls(prefix.context).length)
    return {
      host: prefix.host,
      world,
      sessionID,
      context,
      ...trajectory,
      consumed: {
        http: prefix.consumed.http + trajectory.counters.http,
        tool: prefix.consumed.tool + trajectory.tape.consumed,
      },
    }
  }
  durableWrite(`${directory}/provider.json`, blob(capsule, capsule.manifest.http))
  const tape = new ToolTape("replay", directory, decodeTools(capsule))
  const counters: Counters = { provider: 0, http: 0, failures: [] }
  // Replay never calls the world. Seed its recorded idle world for a subsequent fork.
  const host = yield* createHost({ directory, tape, files: decodeFiles(capsule, "checkpoint"), counters })
  yield* host.opencode.sessions.create({
    id: SESSION_ID,
    agent: Agent.ID.make("fixture"),
    location: host.location,
    title: "Bounded repair",
  })
  const context = yield* runPrompt(host.opencode, SESSION_ID, capsule.manifest.prompt)
  assertReplay(capsule, context, { tape, counters }, 0)
  return {
    host,
    world: host.world,
    sessionID: SESSION_ID,
    counters,
    tape,
    context,
    consumed: { http: counters.http, tool: tape.consumed },
  }
})

function assertReplay(
  capsule: Capsule,
  context: typeof NativeExport.Type,
  trajectory: { tape: ToolTape; counters: Counters },
  prefixCalls: number,
) {
  trajectory.tape.assertComplete()
  assertToolCoverage(context, trajectory.tape.consumed + prefixCalls)
  if (trajectory.counters.failures.length) throw new Error(trajectory.counters.failures.join("; "))
  const expected = Schema.decodeUnknownSync(Schema.fromJsonString(NativeExport))(
    blob(capsule, capsule.manifest.context),
  )
  if (contextView(context.messages) !== contextView(expected.messages))
    throw new Error("Native replay context mismatch")
  const http = Schema.decodeUnknownSync(Schema.fromJsonString(HttpTape))(blob(capsule, capsule.manifest.http))
  if (trajectory.counters.http !== http.interactions.length) throw new Error("Unused HTTP results")
  if (trajectory.counters.provider !== 0 || trajectory.tape.live !== 0)
    throw new Error("Replay invoked a live component")
}

export const replay = Effect.fn("Replay.replay")(function* (capsule: Capsule) {
  return yield* withScratch((directory) =>
    restorePrefix(capsule, directory).pipe(
      Effect.map((result) => ({
        digest: capsule.digest,
        equal: true,
        live: { provider: result.counters.provider, tool: result.tape.live },
        consumed: result.consumed,
      })),
    ),
  ).pipe(Effect.scoped, Effect.timeout("30 seconds"))
})

/** Only the capsule's supported final idle boundary; not arbitrary historical/asOf restoration. */
export const fork = Effect.fn("Replay.fork")(function* (capsule: Capsule) {
  if (ancestryDepth(capsule) >= MAX_ANCESTRY)
    return yield* Effect.die("Unsupported ancestry depth (maximum four forks)")
  return yield* withScratch((directory) =>
    Effect.gen(function* () {
      const prefix = yield* restorePrefix(capsule, directory)
      const checkpoint = decodeFiles(capsule, "checkpoint")
      const one = yield* makeWorld(checkpoint)
      const two = yield* makeWorld(checkpoint)
      const childOne = yield* forkWorld(prefix.host, prefix.sessionID, one)
      yield* forkWorld(prefix.host, prefix.sessionID, two)
      const trajectory = yield* prefix.host.beginTrajectory(makeRunDirectory(directory, "child"))
      const prompt = "Write child one only to /fixture/repair.txt."
      const context = yield* runPrompt(prefix.host.opencode, childOne, prompt)
      trajectory.tape.assertComplete()
      assertToolCoverage(context, toolCalls(prefix.context).length + trajectory.tape.entries.length)
      if (trajectory.counters.failures.length) return yield* Effect.die(trajectory.counters.failures.join("; "))
      const worlds = yield* Effect.all({
        parent: snapshotWorld(prefix.world),
        one: snapshotWorld(one),
        two: snapshotWorld(two),
      })
      const isolated =
        encode(worlds.parent) === encode(checkpoint) &&
        encode(worlds.two) === encode(checkpoint) &&
        worlds.one["/fixture/repair.txt"] === "child one only\n"
      if (!isolated) return yield* Effect.die(`Checkpoint children are not isolated: ${encode(worlds)}`)
      return {
        capsule: assemble({
          initial: checkpoint,
          checkpoint: worlds.one,
          prompt,
          context,
          tools: trajectory.tape.entries,
          http: readFileSync(`${directory}/child/provider.json`, "utf8"),
          parent: capsule,
        }),
        ancestry: capsule.digest,
        boundary: "final-idle" as const,
        isolated,
        worlds,
        prefixLive: { provider: prefix.counters.provider, tool: prefix.tape.live },
        trajectory: {
          live: { provider: trajectory.counters.provider, tool: trajectory.tape.live },
          context: Schema.encodeSync(NativeExport)(context),
          http: readFileSync(`${directory}/child/provider.json`, "utf8"),
          tools: trajectory.tape.entries,
        },
      }
    }),
  ).pipe(Effect.scoped, Effect.timeout("30 seconds"))
})
