import { expect } from "bun:test"
import { Effect, Layer, Schema, Tracer } from "effect"
import { testEffect } from "../../core/test/lib/effect"
import { CANARY, scenario } from "../script/fixture"
import { Trace, TraceRecords } from "../src/index"
import { withScratch } from "../../replay/src/runtime"
import { existsSync, mkdirSync, realpathSync, readdirSync, statSync, symlinkSync } from "node:fs"

const it = testEffect(Layer.empty)

it.live("disabled capture adds no spans and does not suppress existing native tracing", () => Effect.gen(function* () {
  const names: string[] = []
  const tracer = Tracer.make({ span(options) {
    names.push(options.name)
    return new Tracer.NativeSpan(options)
  } })
  yield* Effect.gen(function* () {
    yield* Trace.capture()
    yield* Effect.void.pipe(Effect.withSpan("native-fixture"))
  }).pipe(Effect.provideService(Tracer.Tracer, tracer))
  expect(names).toEqual(["native-fixture"])
}))

it.live(
  "collector sink failure and projection defects leave actual native execution unchanged",
  () =>
    Effect.gen(function* () {
      const off = yield* scenario(false, undefined, true)
      const failed = yield* scenario(true, { write: () => Effect.fail(new Error(CANARY)), close: Effect.void }, true)
      const defective = yield* scenario(true, { write: () => Effect.void, close: Effect.void }, true)
      const thrown = yield* scenario(
        true,
        {
          write: () => {
            throw new Error(CANARY)
          },
          close: Effect.void,
        },
        true,
      )
      for (const captured of [failed, defective, thrown]) {
        expect(captured.context).toBe(off.context)
        expect(captured.world).toEqual(off.world)
        expect(captured.outcome).toBe("succeeded")
        expect(captured.health.complete).toBe(false)
        expect(JSON.stringify(captured.health)).not.toContain(CANARY)
      }
      expect(failed.health.sinkFailures).toBeGreaterThan(0)
      expect(defective.health.collectionFailures).toBeGreaterThan(0)
    }),
  60_000,
)

it.live(
  "disabled and enabled native SDK hosts have identical context, world, and outcome",
  () =>
    Effect.gen(function* () {
      const off = yield* scenario(false)
      const on = yield* scenario(true)
      expect(on.context).toBe(off.context)
      expect(on.world).toEqual(off.world)
      expect(on.outcome).toBe(off.outcome)
      expect(on.provider).toBe(3)
      expect(on.http).toBe(3)
      expect(on.tools).toBe(2)
      expect(off.health.state).toBe("disabled")
      expect(off.disabledArtifacts).toBe(false)
      expect(off.text).toBe("")
      expect(on.text).not.toContain(CANARY)
      expect(on.text).not.toContain("/fixture")
      expect(on.text).not.toContain("repair-v1")
      expect(on.health.complete).toBe(true)
      expect(on.health.collectionFailures).toBe(0)
      expect(on.health.dropped).toBe(0)
      const events = on.records.filter((record) => record.kind === "event")
      expect(events.map((event) => event.type)).toContain("session.execution.succeeded")
      expect(events.map((event) => event.type)).toContain("session.step.streamed")
      expect(events.map((event) => event.type)).toContain("session.tool.success")
      expect(events.map((event) => event.type)).toContain("session.inbox.delivered")
      expect(events.map((event) => event.type)).toContain("session.forked")
      const parent = events.find((event) => event.type === "session.created")
      const fork = events.find((event) => event.type === "session.forked")
      expect(fork?.parent).toBe(parent?.session)
      expect(fork?.session).not.toBe(parent?.session)
      expect(new Set(events.map((event) => event.session)).size).toBe(3)
      const started = events.filter((event) => event.type === "session.step.started")
      expect(started.every((event) => event.started !== undefined)).toBe(true)
      const ended = events.filter((event) => event.type === "session.step.ended")
      expect(ended.map((event) => event.message)).toEqual(started.map((event) => event.message))
      expect(events.every((event, index) => event.ordinal === index)).toBe(true)
      expect(on.records.at(-1)?.kind).toBe("summary")
    }),
  60_000,
)

it.live("default capture has no overrides or output", () =>
  withScratch((directory) =>
    Effect.gen(function* () {
      const capture = yield* Trace.capture()
      expect(capture.overrides).toEqual([])
      expect(capture.runDirectory).toBeUndefined()
      expect(readdirSync(directory)).toEqual([])
    }),
  ).pipe(Effect.scoped),
)

it.live("private exclusive files, bounded retained runs, no symlink traversal or deletion", () =>
  withScratch((directory) =>
    Effect.gen(function* () {
      const root = realpathSync(directory)
      const outputDirectory = `${root}/traces`
      mkdirSync(outputDirectory)
      const capture = yield* Trace.capture({ enabled: true, outputDirectory, selection: { allHostSessions: true } })
      yield* capture.close
      expect(statSync(capture.runDirectory!).mode & 0o777).toBe(0o700)
      expect(statSync(`${capture.runDirectory}/events.jsonl`).mode & 0o777).toBe(0o600)
      symlinkSync(outputDirectory, `${root}/link`)
      expect(
        yield* Trace.capture({
          enabled: true,
          outputDirectory: `${root}/link`,
          selection: { allHostSessions: true },
        }).pipe(Effect.flip),
      ).toBeInstanceOf(Error)
      for (let index = 0; index < 15; index++) mkdirSync(`${outputDirectory}/user-file-${index}`)
      expect(
        yield* Trace.capture({ enabled: true, outputDirectory, selection: { allHostSessions: true } }).pipe(
          Effect.flip,
        ),
      ).toBeInstanceOf(Error)
      expect(readdirSync(outputDirectory)).toHaveLength(16)
      expect(existsSync(`${outputDirectory}/user-file-0`)).toBe(true)
    }),
  ).pipe(Effect.scoped),
)

it.live("configuration requires explicit bounded selection and limits", () =>
  Effect.sync(() => {
    const invalid = [
      { enabled: true, outputDirectory: "/unused" },
      { enabled: true, outputDirectory: "/unused", selection: { sessions: [] } },
      { enabled: true, outputDirectory: "/unused", selection: { sessions: ["ses_" + "x".repeat(257)] } },
      {
        enabled: true,
        outputDirectory: "/unused",
        selection: { allHostSessions: true },
        limits: { queueRecords: 257 },
      },
    ]
    invalid.forEach((options) => expect(Schema.is(Trace.Options)(options)).toBe(false))
    expect(TraceRecords.coverage.physicalAttempts).toBe("unavailable")
  }),
)
