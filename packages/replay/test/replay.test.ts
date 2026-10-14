import { beforeAll, afterAll, describe, expect } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { readFileSync, rmSync } from "node:fs"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { testEffect } from "../../core/test/lib/effect"
import {
  Capsule,
  MAX_BYTES,
  Manifest,
  NativeExport,
  blob,
  decodeFiles,
  decodeTools,
  encode,
  durableWrite,
  freeze,
  hash,
  open,
  parseJson,
  save,
  validate,
} from "../src/archive"
import { fork, record, replay } from "../src/index"
import { measure } from "../src/measure"
import {
  INITIAL,
  PROMPT,
  SESSION_ID,
  contextView,
  createHost,
  runPrompt,
  snapshotWorld,
  temporary,
  withScratch,
  type Counters,
} from "../src/runtime"
import { ToolTape } from "../src/tape"

const it = testEffect(Layer.empty)
const directory = temporary()
const file = `${directory}/capsule.json`
let capsule: Capsule
let childCapsule: Capsule
const childFile = `${directory}/child.json`

beforeAll(async () => {
  capsule = (await Effect.runPromise(record(file))).capsule
  childCapsule = (await Effect.runPromise(fork(capsule))).capsule
  save(childFile, childCapsule)
}, 60_000)
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function replace(
  capsule: Capsule,
  key: "initial" | "checkpoint" | "tools" | "http" | "context" | "parent",
  text: string,
) {
  const blobs = { ...capsule.blobs }
  const old = capsule.manifest[key]
  if (old) delete blobs[old]
  const id = hash(text)
  blobs[id] = text
  return freeze({ ...capsule.manifest, [key]: id }, blobs)
}

describe("bounded native replay", () => {
  it.live(
    "host AGENTS and missing-file suggestions are never consulted or captured",
    () =>
      withScratch((directory) =>
        Effect.promise(async () => {
          const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixture/ambient.ts`, directory], {
            stdout: "pipe",
            stderr: "pipe",
          })
          const result = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          expect(result[2]).toBe(0)
          expect(result[1]).toBe("")
          const proof = Schema.decodeUnknownSync(
            Schema.fromJsonString(
              Schema.Struct({
                clean: Schema.Boolean,
                acquisitions: Schema.Int,
                observations: Schema.Record(Schema.String, Schema.Int),
              }),
            ),
          )(result[0])
          expect(proof.clean).toBe(true)
          expect(proof.acquisitions).toBeGreaterThan(0)
          expect(Object.values(proof.observations).every((count) => count === 0)).toBe(true)
          const cold = Bun.spawn(
            [process.execPath, `${import.meta.dir}/../script/cli.ts`, "replay", `${directory}/capsule.json`],
            { stdout: "pipe", stderr: "pipe" },
          )
          const replayed = await Promise.all([
            new Response(cold.stdout).text(),
            new Response(cold.stderr).text(),
            cold.exited,
          ])
          expect(replayed[2]).toBe(0)
          expect(replayed[1]).toBe("")
          expect(
            Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Struct({ live: Schema.Struct({ provider: Schema.Int, tool: Schema.Int }) })),
            )(replayed[0]).live,
          ).toEqual({ provider: 0, tool: 0 })
        }),
      ).pipe(Effect.scoped),
    60_000,
  )

  it.live(
    "poisoned replay world read/list/stat are never invoked",
    () =>
      withScratch((directory) =>
        Effect.gen(function* () {
          durableWrite(`${directory}/provider.json`, blob(capsule, capsule.manifest.http))
          const counters: Counters = { provider: 0, http: 0, failures: [] }
          const tape = new ToolTape("replay", directory, decodeTools(capsule))
          const host = yield* createHost({ directory, tape, counters, files: INITIAL })
          const files = host.world.overrides
          if (!files) throw new Error("Missing replay memory driver overrides")
          const observations = { read: 0, list: 0, stat: 0 }
          ;(["read", "list", "stat"] as const).forEach((operation) =>
            Object.defineProperty(files, operation, {
              value: () => {
                observations[operation]++
                return Effect.die(`Live world ${operation} forbidden`)
              },
            }),
          )
          yield* host.opencode.sessions.create({
            id: SESSION_ID,
            agent: Agent.ID.make("fixture"),
            location: host.location,
            title: "Bounded repair",
          })
          const context = yield* runPrompt(host.opencode, SESSION_ID, PROMPT)
          tape.assertComplete()
          const expected = Schema.decodeUnknownSync(Schema.fromJsonString(NativeExport))(
            blob(capsule, capsule.manifest.context),
          )
          expect(contextView(context.messages)).toBe(contextView(expected.messages))
          expect(observations).toEqual({ read: 0, list: 0, stat: 0 })
          expect(tape.live).toBe(0)
        }),
      ).pipe(Effect.scoped),
    60_000,
  )
  it.live(
    "journals an actual native read error and cold-replays its recovery",
    () =>
      withScratch((directory) =>
        Effect.gen(function* () {
          const recorded = yield* Effect.gen(function* () {
            const counters: Counters = { provider: 0, http: 0, failures: [] }
            const tape = new ToolTape("record", directory)
            const host = yield* createHost({ directory, tape, counters, files: {} })
            yield* host.opencode.sessions.create({
              id: SESSION_ID,
              agent: Agent.ID.make("fixture"),
              location: host.location,
              title: "Bounded repair",
            })
            const context = yield* runPrompt(host.opencode, SESSION_ID, PROMPT)
            tape.assertComplete()
            expect(tape.entries[0].outcome.status).toBe("error")
            expect(tape.entries[1].outcome.status).toBe("completed")
            expect(parseJson(readFileSync(`${directory}/tool-1.json`, "utf8"))).toEqual(tape.entries[0])
            return { context, entries: tape.entries, files: yield* snapshotWorld(host.world) }
          }).pipe(Effect.scoped)
          const counters: Counters = { provider: 0, http: 0, failures: [] }
          const tape = new ToolTape("replay", directory, recorded.entries)
          const host = yield* createHost({ directory, tape, counters, files: recorded.files })
          yield* host.opencode.sessions.create({
            id: SESSION_ID,
            agent: Agent.ID.make("fixture"),
            location: host.location,
            title: "Bounded repair",
          })
          const context = yield* runPrompt(host.opencode, SESSION_ID, PROMPT)
          tape.assertComplete()
          expect(contextView(context.messages)).toBe(contextView(recorded.context.messages))
          expect(counters.provider).toBe(0)
          expect(tape.live).toBe(0)
        }),
      ).pipe(Effect.scoped),
    60_000,
  )
  it.live(
    "reopens after the recording runtime is gone, consumes every native result without live calls",
    () =>
      Effect.gen(function* () {
        const reopened = open(file)
        expect(decodeTools(reopened).map((entry) => entry.name)).toEqual(["read", "write"])
        expect(decodeTools(reopened).every((entry) => entry.outcome.status === "completed")).toBe(true)
        expect(decodeFiles(reopened, "checkpoint")).toEqual({ "/fixture/repair.txt": "the small fixture\n" })
        const result = yield* replay(reopened)
        expect(result.equal).toBe(true)
        expect(result.live).toEqual({ provider: 0, tool: 0 })
        expect(result.consumed).toEqual({ http: 3, tool: 2 })
      }),
    60_000,
  )

  it.live(
    "native idle-boundary forks restore isolated worlds and make a NEW continuation",
    () =>
      Effect.gen(function* () {
        const result = yield* fork(open(file))
        expect(result.ancestry).toBe(capsule.digest)
        expect(result.boundary).toBe("final-idle")
        expect(result.isolated).toBe(true)
        expect(result.prefixLive).toEqual({ provider: 0, tool: 0 })
        expect(result.trajectory.live).toEqual({ provider: 2, tool: 1 })
        expect(result.worlds.parent).toEqual(result.worlds.two)
        expect(result.worlds.one).not.toEqual(result.worlds.parent)
        expect(result.trajectory.http).toContain("Bounded public text repair fixture")
        expect(result.trajectory.http).toContain("the small fixture")
        expect(result.trajectory.context.info.fork?.sessionID).toBe(SESSION_ID)
        expect(result.trajectory.tools[0].input).toEqual({ path: "/fixture/repair.txt", content: "child one only\n" })
      }),
    60_000,
  )

  it.live(
    "missing tool result fails the episode rather than recovering into success",
    () =>
      Effect.promise(async () => {
        const broken = replace(capsule, "tools", encode(decodeTools(capsule).slice(0, 1)))
        await expect(Effect.runPromise(replay(broken))).rejects.toThrow()
      }),
    60_000,
  )

  it.live(
    "CLI replays the durable capsule in an entirely separate process",
    () =>
      Effect.promise(async () => {
        const child = Bun.spawn([process.execPath, `${import.meta.dir}/../script/cli.ts`, "replay", file], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const result = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(result[2]).toBe(0)
        expect(result[1]).toBe("")
        const output = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({ equal: Schema.Boolean, live: Schema.Struct({ provider: Schema.Int, tool: Schema.Int }) }),
          ),
        )(result[0])
        expect(output).toEqual({ equal: true, live: { provider: 0, tool: 0 } })
      }),
    60_000,
  )

  it.live(
    "changed native parser output fails context equality",
    () =>
      Effect.promise(async () => {
        const broken = replace(
          capsule,
          "http",
          blob(capsule, capsule.manifest.http).replaceAll("repaired", "different"),
        )
        await expect(Effect.runPromise(replay(broken))).rejects.toThrow("Native replay context mismatch")
      }),
    60_000,
  )

  it.live(
    "native source and instruction pins fail closed",
    () =>
      Effect.promise(async () => {
        const changed = freeze(
          { ...capsule.manifest, identity: { ...capsule.manifest.identity, sources: {} } },
          { ...capsule.blobs },
        )
        await expect(Effect.runPromise(replay(changed))).rejects.toThrow("Native source pins mismatch")
        const instruction = freeze(
          { ...capsule.manifest, identity: { ...capsule.manifest.identity, instructions: "different" } },
          { ...capsule.blobs },
        )
        await expect(Effect.runPromise(replay(instruction))).rejects.toThrow("Instruction pin mismatch")
      }),
    60_000,
  )

  it.live(
    "unused tool results fail",
    () =>
      Effect.promise(async () => {
        const entries = decodeTools(capsule)
        const broken = replace(capsule, "tools", encode([...entries, { ...entries[0], occurrence: 3 }]))
        await expect(Effect.runPromise(replay(broken))).rejects.toThrow("Unused tool results")
      }),
    60_000,
  )

  it.live(
    "canonical tool input mismatch poisons replay",
    () =>
      Effect.promise(async () => {
        const entries = decodeTools(capsule)
        const broken = replace(
          capsule,
          "tools",
          encode([{ ...entries[0], input: { path: "/fixture/repair.txt", limit: 1 } }, entries[1]]),
        )
        await expect(Effect.runPromise(replay(broken))).rejects.toThrow()
      }),
    60_000,
  )

  it.live(
    "HTTP request mismatch fails strict replay",
    () =>
      Effect.promise(async () => {
        const broken = freeze({ ...capsule.manifest, prompt: "A different request" }, { ...capsule.blobs })
        await expect(Effect.runPromise(replay(broken))).rejects.toThrow()
      }),
    60_000,
  )

  it.live(
    "unused HTTP responses fail",
    () =>
      Effect.promise(async () => {
        const schema = Schema.Struct({
          version: Schema.Int,
          metadata: Schema.Json,
          interactions: Schema.Array(Schema.Json),
        })
        const http = Schema.decodeUnknownSync(Schema.fromJsonString(schema))(blob(capsule, capsule.manifest.http))
        const broken = replace(
          capsule,
          "http",
          encode({ ...http, interactions: [...http.interactions, http.interactions[0]] }),
        )
        await expect(Effect.runPromise(replay(broken))).rejects.toThrow()
      }),
    60_000,
  )

  it.live(
    "missing cassette cannot call the fixture provider or any real tool",
    () =>
      withScratch((directory) =>
        Effect.gen(function* () {
          const counters: Counters = { provider: 0, http: 0, failures: [] }
          const tape = new ToolTape("replay", directory, decodeTools(capsule))
          const host = yield* createHost({ directory, tape, counters, files: INITIAL })
          yield* host.opencode.sessions.create({
            id: SESSION_ID,
            agent: Agent.ID.make("fixture"),
            location: host.location,
          })
          const result = yield* Effect.exit(runPrompt(host.opencode, SESSION_ID, PROMPT))
          expect(Exit.isFailure(result)).toBe(true)
          expect(counters.provider).toBe(0)
          expect(tape.live).toBe(0)
          expect(counters.failures.length).toBeGreaterThan(0)
        }),
      ).pipe(Effect.scoped),
    60_000,
  )
})

describe("immutable capsules and verifier-only measurement", () => {
  it.live("runtime evidence includes the actual lockfile, root manifest and resolved Effect package", () =>
    Effect.sync(() => {
      expect(capsule.manifest.identity.sources["bun.lock"]).toBe(
        hash(readFileSync(`${import.meta.dir}/../../../bun.lock`, "utf8")),
      )
      expect(capsule.manifest.identity.sources["package.json"]).toBe(
        hash(readFileSync(`${import.meta.dir}/../../../package.json`, "utf8")),
      )
      expect(capsule.manifest.identity.sources["resolved/effect/package.json"]).toBe(
        hash(readFileSync(`${import.meta.dir}/../node_modules/effect/package.json`, "utf8")),
      )
      expect(capsule.manifest.identity.sources["packages/replay/src/measure.ts"]).toBeUndefined()
    }),
  )
  it.live("rejects malformed JSON, malformed tool outcomes and archive size overflow", () =>
    Effect.sync(() => {
      const invalid = `${directory}/invalid.json`
      durableWrite(invalid, "not json")
      expect(() => open(invalid)).toThrow()
      expect(() => replace(capsule, "tools", "null")).toThrow()
      expect(() => durableWrite(`${directory}/oversized.json`, "x".repeat(MAX_BYTES + 1))).toThrow("8 MiB")
      expect(() => validate({ ...capsule, digest: "0".repeat(64) })).toThrow("Manifest digest mismatch")
    }),
  )
  it.live("rejects malformed schema, tampered blobs, missing blobs and unsafe paths", () =>
    Effect.sync(() => {
      expect(() => validate({ ...capsule, manifest: { ...capsule.manifest, version: 99 } })).toThrow()
      expect(() =>
        validate({ ...capsule, blobs: { ...capsule.blobs, [capsule.manifest.initial]: "changed" } }),
      ).toThrow("Blob digest mismatch")
      const missing = { ...capsule.blobs }
      delete missing[capsule.manifest.tools]
      expect(() => validate({ ...capsule, blobs: missing })).toThrow("Missing blob")
      expect(() => replace(capsule, "initial", encode({ "../../escape.txt": "no" }))).toThrow()
      expect(() => replace(capsule, "initial", encode({ "/fixture/../escape.txt": "no" }))).toThrow()
      expect(() => Schema.decodeUnknownSync(Manifest)({ ...capsule.manifest, context: "../../outside" })).toThrow()
    }),
  )

  it.live("does not overwrite an existing capsule", () =>
    Effect.sync(() => {
      const original = readFileSync(file, "utf8")
      expect(() => save(file, capsule)).toThrow()
      expect(readFileSync(file, "utf8")).toBe(original)
    }),
  )

  it.live("remeasures frozen artifacts append-only without changing the episode", () =>
    Effect.sync(() => {
      const before = readFileSync(file, "utf8")
      const first = measure(capsule, "repair-exact-v1", directory)
      const second = measure(capsule, "repair-no-typo-v1", directory)
      const again = measure(capsule, "repair-exact-v1", directory)
      expect([first.passed, second.passed, again.passed]).toEqual([true, true, true])
      expect(new Set([first.id, second.id, again.id]).size).toBe(3)
      expect(first.implementation).toBe(hash(readFileSync(`${import.meta.dir}/../src/measure.ts`, "utf8")))
      expect(parseJson(readFileSync(`${directory}/measurement-${first.id}.json`, "utf8"))).toEqual(first)
      expect(readFileSync(file, "utf8")).toBe(before)
      expect(open(file).digest).toBe(first.episode)
    }),
  )

  it.live("unknown verifiers and missing evidence fail; negative evidence stays negative", () =>
    Effect.sync(() => {
      expect(() => measure(capsule, "unknown", directory)).toThrow("Unknown verifier")
      expect(() => measure(capsule, "toString", directory)).toThrow("Unknown verifier")
      expect(() => measure(replace(capsule, "checkpoint", "{}"), "repair-exact-v1", directory)).toThrow(
        "Missing verifier evidence",
      )
      expect(measure(replace(capsule, "checkpoint", encode(INITIAL)), "repair-exact-v1", directory).passed).toBe(false)
    }),
  )
})

describe("reusable immutable native lineage", () => {
  it.live(
    "CLI rejects extra arguments and refuses to overwrite an existing fork output",
    () =>
      Effect.promise(async () => {
        const before = readFileSync(file, "utf8")
        const extra = Bun.spawn([process.execPath, `${import.meta.dir}/../script/cli.ts`, "replay", file, "extra"], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const invalid = await Promise.all([
          new Response(extra.stdout).text(),
          new Response(extra.stderr).text(),
          extra.exited,
        ])
        expect(invalid[2]).not.toBe(0)
        expect(invalid[1]).toContain("Usage:")
        const collision = Bun.spawn([process.execPath, `${import.meta.dir}/../script/cli.ts`, "fork", file, file], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const rejected = await Promise.all([
          new Response(collision.stdout).text(),
          new Response(collision.stderr).text(),
          collision.exited,
        ])
        expect(rejected[2]).not.toBe(0)
        expect(rejected[1]).toContain("EEXIST")
        expect(readFileSync(file, "utf8")).toBe(before)
      }),
    60_000,
  )
  it.live(
    "cold child replay consumes parent prefix and child suffix without live calls",
    () =>
      Effect.gen(function* () {
        const reopened = open(childFile)
        expect(reopened.manifest.parent).toBeDefined()
        expect(reopened.manifest.initial).toBe(capsule.manifest.checkpoint)
        const result = yield* replay(reopened)
        expect(result.equal).toBe(true)
        expect(result.live).toEqual({ provider: 0, tool: 0 })
        expect(result.consumed).toEqual({ http: 5, tool: 3 })
      }),
    60_000,
  )

  it.live("child verifier remeasure leaves both parent and child capsule bytes unchanged", () =>
    Effect.sync(() => {
      const before = [readFileSync(file, "utf8"), readFileSync(childFile, "utf8")]
      const measured = measure(open(childFile), "child-one-v1", directory)
      expect(measured.passed).toBe(true)
      expect(measured.episode).toBe(childCapsule.digest)
      expect(measure(childCapsule, "repair-exact-v1", directory).passed).toBe(false)
      expect([readFileSync(file, "utf8"), readFileSync(childFile, "utf8")]).toEqual(before)
    }),
  )

  it.live(
    "a child is itself forkable and its grandchild is cold-replayable",
    () =>
      Effect.gen(function* () {
        const result = yield* fork(open(childFile))
        expect(result.ancestry).toBe(childCapsule.digest)
        expect(result.isolated).toBe(true)
        const grandchild = `${directory}/grandchild.json`
        save(grandchild, result.capsule)
        const cold = yield* replay(open(grandchild))
        expect(cold.live).toEqual({ provider: 0, tool: 0 })
        expect(cold.consumed).toEqual({ http: 7, tool: 4 })
      }),
    60_000,
  )

  it.live("child validation rejects corrupt parent evidence, missing references and mismatched worlds", () =>
    Effect.sync(() => {
      expect(() =>
        replace(
          childCapsule,
          "parent",
          encode({ ...capsule, blobs: { ...capsule.blobs, [capsule.manifest.checkpoint]: "tamper" } }),
        ),
      ).toThrow("Blob digest mismatch")
      expect(() => freeze({ ...childCapsule.manifest, parent: "0".repeat(64) }, { ...childCapsule.blobs })).toThrow()
      const blobs = { ...childCapsule.blobs }
      if (!childCapsule.manifest.parent) throw new Error("Missing child fixture parent")
      delete blobs[childCapsule.manifest.parent]
      expect(() => validate({ ...childCapsule, blobs })).toThrow("Missing blob")
      expect(() => replace(childCapsule, "initial", encode(INITIAL))).toThrow("Child initial world")
      expect(() => validate({ ...capsule, manifest: { ...capsule.manifest, profile: "os-world" } })).toThrow()
      const context = Schema.decodeUnknownSync(Schema.fromJsonString(NativeExport))(
        blob(childCapsule, childCapsule.manifest.context),
      )
      expect(() =>
        replace(
          childCapsule,
          "context",
          encode(Schema.encodeSync(NativeExport)({ ...context, messages: context.messages.slice(0, -1) })),
        ),
      ).toThrow("native idle boundary")
    }),
  )

  it.live(
    "supported ancestry is explicitly bounded to four native forks",
    () =>
      Effect.gen(function* () {
        const grandchild = (yield* fork(childCapsule)).capsule
        const third = (yield* fork(grandchild)).capsule
        const fourth = (yield* fork(third)).capsule
        expect((yield* replay(fourth)).live).toEqual({ provider: 0, tool: 0 })
        const unsupported = yield* Effect.exit(fork(fourth))
        expect(Exit.isFailure(unsupported)).toBe(true)
      }),
    60_000,
  )
})

describe("native tool result tape boundary", () => {
  const context: Tool.Context = {
    sessionID: SESSION_ID,
    agent: Agent.ID.make("fixture"),
    messageID: SessionMessage.ID.make("msg_fixture"),
    id: Tool.CallID.make("call_fixture"),
    progress: () => Effect.void,
  }

  it.live("captures error results before returning and replays without calling executor", () =>
    withScratch((directory) =>
      Effect.gen(function* () {
        const tape = new ToolTape("record", directory)
        const result = yield* tape
          .wrap("read", () => Effect.fail(new Tool.Error({ message: "fixture error" })))(
            { path: "/fixture/repair.txt" },
            context,
          )
          .pipe(Effect.flip)
        expect(result.message).toBe("fixture error")
        expect(parseJson(readFileSync(`${directory}/tool-1.json`, "utf8"))).toEqual(tape.entries[0])
        const replay = new ToolTape("replay", directory, tape.entries)
        const error = yield* replay
          .wrap("read", () => Effect.die("live executor forbidden"))({ path: "/fixture/repair.txt" }, context)
          .pipe(Effect.flip)
        expect(error.message).toBe("fixture error")
        expect(replay.live).toBe(0)
        replay.assertComplete()
      }),
    ).pipe(Effect.scoped),
  )

  it.live("matches canonical args and requires serial occurrence IDs", () =>
    withScratch((directory) =>
      Effect.gen(function* () {
        const entry = {
          occurrence: 1,
          name: "read" as const,
          input: { path: "/fixture/repair.txt", limit: 1 },
          outcome: { status: "completed" as const, result: { content: "one" } },
        }
        const tape = new ToolTape("replay", directory, [entry])
        const output = yield* tape.wrap("read", () => Effect.die("no live call"))(
          { limit: 1, path: "/fixture/repair.txt" },
          context,
        )
        expect(output.content).toBe("one")
        tape.assertComplete()
        const broken = new ToolTape("replay", directory, [{ ...entry, occurrence: 2 }])
        yield* broken
          .wrap("read", () => Effect.die("no live call"))(entry.input, context)
          .pipe(Effect.flip)
        expect(() => broken.assertComplete()).toThrow("mismatch")
      }),
    ).pipe(Effect.scoped),
  )

  it.live("denies paths outside the fixed tree before calling native tools", () =>
    withScratch((directory) =>
      Effect.gen(function* () {
        const tape = new ToolTape("record", directory)
        yield* tape
          .wrap("write", () => Effect.die("must not execute"))(
            { path: "/fixture/../escape.txt", content: "no" },
            context,
          )
          .pipe(Effect.flip)
        expect(tape.live).toBe(0)
        expect(() => tape.assertComplete()).toThrow("Only absolute fixture text paths")
      }),
    ).pipe(Effect.scoped),
  )
})
