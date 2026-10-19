import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Event } from "@opencode/schema/event"
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { EmbeddedHost } from "../../sdk/src/internal/host"
import { testEffect } from "../../core/test/lib/effect"
import { withScratch } from "../../replay/src/runtime"
import { start } from "../src/collector"
import { TraceRecords } from "../src/records"
import type { Enabled } from "../src/options"
import type { Sink } from "../src/sink"
import { TokenUsage } from "@opencode/schema/token-usage"
import { Location } from "@opencode/schema/location"

const it = testEffect(Layer.empty)
const SECRET = "synthetic-canary-input-output-url-query-header-env-cause-stack"
const sessionID = Session.ID.make(`ses_${SECRET}`)
const messageID = SessionMessage.ID.make(`msg_${SECRET}`)
const options: Enabled = { enabled: true, outputDirectory: "/unused", selection: { sessions: [sessionID] } }

const Tool = Event.ephemeral({
  type: "session.tool.called",
  schema: {
    sessionID: Schema.String,
    assistantMessageID: Schema.String,
    id: Schema.String,
    input: Schema.Unknown,
    output: Schema.Unknown,
  },
})
const Name = Event.ephemeral({
  type: "session.tool.input.started",
  schema: {
    sessionID: Schema.String,
    assistantMessageID: Schema.String,
    id: Schema.String,
    name: Schema.String,
  },
})
const data = { sessionID, assistantMessageID: messageID, id: SECRET, input: SECRET, output: SECRET }

const scratchGlobal = (directory: string) =>
  Layer.succeed(Global.Service, {
    home: directory,
    data: directory,
    cache: directory,
    config: directory,
    state: directory,
    tmp: directory,
    bin: directory,
    log: directory,
    repos: directory,
  })

const withCollector = <A, E, R>(
  config: Enabled,
  sink: Sink,
  use: (collector: Effect.Success<ReturnType<typeof start>>, bus: Bus.Interface) => Effect.Effect<A, E, R>,
  replacements: LayerNode.Replacements = [],
) =>
  withScratch((directory) =>
    Effect.gen(function* () {
      const collector = yield* start(config, sink)
      const context = yield* Layer.build(
        LayerNode.compile(LayerNode.group([SdkPlugins.node, Bus.node]), {
          replacements: [Global.node.replace(scratchGlobal(directory)), ...replacements, ...collector.overrides],
        }),
      )
      return yield* use(collector, Context.get(context, Bus.Service))
    }),
  ).pipe(Effect.scoped)

function memorySink() {
  const lines: string[] = []
  return {
    lines,
    write: (line: string) =>
      Effect.sync(() => {
        lines.push(line)
      }),
    close: Effect.void,
  }
}

it.live("privacy projection precedes the bounded queue, not merely disk serialization", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const sink = memorySink()
    yield* withCollector(
      { ...options, limits: { queueRecords: 2, queueBytes: 2048 } },
      {
        write: (line) => Deferred.await(gate).pipe(Effect.andThen(sink.write(line))),
        close: Effect.void,
      },
      (collector, bus) =>
        Effect.gen(function* () {
          yield* bus.publish(Tool, data, {
            metadata: {
              prompt: SECRET,
              reasoning: SECRET,
              instructions: SECRET,
              environment: SECRET,
              url: `https://example.test/?secret=${SECRET}`,
              headers: { authorization: SECRET },
              error: { cause: SECRET, stack: SECRET },
            },
          })
          yield* bus.publish(Name, { ...data, name: SECRET })
          expect(collector.pending()).toHaveLength(2)
          const projected = collector.pending().join("")
          expect(projected).not.toContain(SECRET)
          expect(projected).not.toContain("https:")
          expect(projected).not.toContain("authorization")
          const records = collector
            .pending()
            .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecords.Metadata))(line))
          expect(records[0].tool).toBe(records[1].tool)
          expect(records[1].category).toBe("custom")
          const started = performance.now()
          yield* Effect.forEach(Array.from({ length: 1000 }), () => bus.publish(Tool, data), { discard: true })
          expect(performance.now() - started).toBeLessThan(1000)
          expect(collector.health().peakRecords).toBe(2)
          expect(collector.health().peakBytes).toBeLessThanOrEqual(2048)
          expect(collector.health().dropped).toBe(1000)
          expect(collector.health().firstLoss).toBe(2)
          expect(collector.health().lastLoss).toBe(1001)
          yield* Deferred.succeed(gate, undefined)
          yield* collector.close
          expect(collector.health().complete).toBe(false)
          expect(sink.lines.join("")).not.toContain(SECRET)
        }),
    )
  }),
)

it.live("native shell and legacy bash names share the coarse shell category", () => {
  const sink = memorySink()
  return withCollector(options, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* Effect.forEach(["shell", "bash"], (name) => bus.publish(Name, { ...data, name }), { discard: true })
      yield* collector.close
      const records = sink.lines
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecords.Record))(line))
        .filter((record) => record.kind === "event")
      expect(records.map((record) => record.category)).toEqual(["shell", "shell"])
    }),
  )
})

it.live("unselected Sessions do not consume queue, counters or pseudonym state; call IDs are qualified", () => {
  const sink = memorySink()
  return withCollector(options, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        Array.from({ length: 300 }),
        (_, index) =>
          bus.publish(Tool, {
            ...data,
            sessionID: `ses_unselected_${index}`,
          }),
        { discard: true },
      )
      yield* bus.publish(Tool, { ...data, sessionID: `ses_${SECRET.repeat(10)}` })
      expect(collector.health().observed).toBe(0)
      expect(collector.health().unsupported).toBe(0)
      expect(collector.health().collectionFailures).toBe(0)
      expect(collector.health().dropped).toBe(0)
      yield* bus.publish(Tool, data)
      yield* bus.publish(Tool, { ...data, assistantMessageID: "msg_other" })
      yield* collector.close
      const events = sink.lines
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecords.Record))(line))
        .filter((record) => record.kind === "event")
      expect(events).toHaveLength(2)
      expect(events[0].tool).not.toBe(events[1].tool)
      expect(events[0].session).toBe(events[1].session)
      expect(collector.health().complete).toBe(true)
    }),
  )
})

it.live("all-host selection is explicit and Session qualifiers prevent message/call ID collisions", () => {
  const sink = memorySink()
  return withCollector({ ...options, selection: { allHostSessions: true } }, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* bus.publish(Tool, data, { location: { directory: AbsolutePath.make("/fixture/location-a") } })
      yield* bus.publish(
        Tool,
        { ...data, sessionID: "ses_other" },
        { location: { directory: AbsolutePath.make("/fixture/location-b") } },
      )
      yield* collector.close
      const events = sink.lines
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecords.Record))(line))
        .filter((record) => record.kind === "event")
      expect(events).toHaveLength(2)
      expect(events[0].session).not.toBe(events[1].session)
      expect(events[0].message).not.toBe(events[1].message)
      expect(events[0].tool).not.toBe(events[1].tool)
    }),
  )
})

it.live("all-host capture still rejects oversized Session IDs without breaking publication", () => {
  const sink = memorySink()
  return withCollector({ ...options, selection: { allHostSessions: true } }, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* bus.publish(Tool, { ...data, sessionID: `ses_${SECRET.repeat(10)}` })
      yield* bus.publish(Tool, data)
      yield* collector.close
      expect(collector.health().observed).toBe(2)
      expect(collector.health().collectionFailures).toBe(1)
      expect(collector.health().dropped).toBe(1)
      expect(collector.health().written).toBe(1)
      expect(collector.health().complete).toBe(false)
      expect(sink.lines.join("")).not.toContain(SECRET)
    }),
  )
})

it.live("synchronous projection defects cannot break non-isolated ephemeral Bus publication", () => {
  const sink = memorySink()
  return withCollector(options, sink, (collector, bus) =>
    Effect.gen(function* () {
      const published = yield* bus.publish(Tool, { ...data, id: SECRET.repeat(1000) })
      expect(published.type).toBe("session.tool.called")
      yield* bus.publish(Tool, data)
      yield* collector.close
      expect(collector.health().collectionFailures).toBe(1)
      expect(collector.health().written).toBe(1)
      expect(collector.health().complete).toBe(false)
      expect(JSON.stringify(collector.health())).not.toContain(SECRET)
      expect(sink.lines.join("")).not.toContain(SECRET)
    }),
  )
})

it.live("disk failure stops admission, reports bounded health, and leaves native publication usable", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>()
    yield* withCollector(
      options,
      {
        write: () => Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.fail(new Error(SECRET)))),
        close: Effect.void,
      },
      (collector, bus) =>
        Effect.gen(function* () {
          yield* Deferred.await(failed)
          yield* Effect.yieldNow
          const before = collector.health()
          yield* bus.publish(Tool, data)
          expect(collector.health().observed).toBe(before.observed)
          yield* collector.close
          expect(collector.health().sinkFailures).toBeGreaterThan(0)
          expect(collector.health().state).toBe("failed")
          expect(collector.health().complete).toBe(false)
          expect(JSON.stringify(collector.health())).not.toContain(SECRET)
        }),
    )
  }),
)

it.live("hung sink and close are interrupted within a bounded shutdown and observer is removed first", () => {
  const interrupted = { writes: 0, closes: 0 }
  return withCollector(
    { ...options, limits: { shutdownMs: 20 } },
    {
      write: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted.writes++
            }),
          ),
        ),
      close: Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted.closes++
          }),
        ),
      ),
    },
    (collector, bus) =>
      Effect.gen(function* () {
        yield* bus.publish(Tool, data)
        const started = performance.now()
        yield* collector.close
        expect(performance.now() - started).toBeLessThan(1000)
        expect(interrupted.writes).toBeGreaterThan(0)
        expect(interrupted.closes).toBe(1)
        expect(collector.health().complete).toBe(false)
        expect(collector.health().queued).toBe(0)
        const observed = collector.health().observed
        yield* bus.publish(Tool, data)
        expect(collector.health().observed).toBe(observed)
      }),
  )
})

it.live("file record/byte ceilings stop collection without stalling native events", () => {
  const sink = memorySink()
  return withCollector({ ...options, limits: { records: 1, fileBytes: 8192 } }, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* bus.publish(Tool, data)
      yield* bus.publish(Tool, data)
      yield* collector.close
      expect(collector.health().written).toBe(1)
      expect(collector.health().dropped).toBe(1)
      expect(Buffer.byteLength(sink.lines.join(""))).toBeLessThanOrEqual(8192)
    }),
  )
})

it.live("file byte cap includes header and terminal summary under sustained draining", () => {
  const sink = memorySink()
  return withCollector({ ...options, limits: { fileBytes: 8192 } }, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        Array.from({ length: 80 }),
        () => bus.publish(Tool, data).pipe(Effect.andThen(Effect.sleep("3 millis"))),
        { discard: true },
      )
      yield* collector.close
      expect(collector.health().dropped).toBeGreaterThan(0)
      expect(collector.health().peakRecords).toBeLessThan(256)
      expect(Buffer.byteLength(sink.lines.join(""))).toBeLessThanOrEqual(8192)
      expect(sink.lines.at(-1)).toContain('"kind":"summary"')
    }),
  )
})

it.live("failure is an observed native outcome, interruption and missing terminals are incomplete", () => {
  const sink = memorySink()
  return withCollector(options, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID })
      yield* bus.publish(SessionEvent.Execution.Failed, { sessionID, error: { type: SECRET, message: SECRET } })
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID })
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "shutdown" })
      yield* collector.close
      expect(collector.health().complete).toBe(false)
      expect(sink.lines.join("")).toContain('"interruption":"shutdown"')
      expect(sink.lines.join("")).toContain("session.execution.failed")
      expect(sink.lines.join("")).not.toContain("session.execution.succeeded")
      expect(sink.lines.join("")).not.toContain(SECRET)
    }),
  )
})

it.live("scope cancellation writes incomplete rather than successful collection", () =>
  Effect.gen(function* () {
    const sink = memorySink()
    const scope = yield* Scope.make()
    const collector = yield* start(options, sink).pipe(Scope.provide(scope))
    yield* Scope.close(scope, Exit.interrupt(1))
    expect(collector.health().complete).toBe(false)
    expect(sink.lines.at(-1)).toContain('"complete":false')
  }),
)

it.live("every allowlisted event uses its skinny canonical metadata schema, excluding all planted bodies", () => {
  const sink = memorySink()
  const fields = {
    sessionID: Schema.String,
    assistantMessageID: Schema.String,
    parentID: Schema.String,
    inboxID: Schema.String,
    id: Schema.String,
    name: Schema.String,
    reason: Schema.String,
    finish: Schema.Literals(["stop", "content-filter"]),
    cost: Schema.Number,
    tokens: TokenUsage.Info,
    attempt: Schema.Int,
    started: Schema.Int,
    location: Location.Ref,
    secret: Schema.Unknown,
  }
  return withCollector(options, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        TraceRecords.Types,
        (type) =>
          bus.publish(Event.ephemeral({ type, schema: fields }), {
            ...data,
            parentID: sessionID,
            inboxID: messageID,
            name: SECRET,
            reason: type === "session.execution.interrupted" ? "shutdown" : "auto",
            finish: type === "session.step.failed" ? "content-filter" : "stop",
            cost: -1,
            tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
            attempt: 2,
            started: 1,
            location: { directory: AbsolutePath.make("/fixture") },
            secret: {
              prompt: SECRET,
              reasoning: SECRET,
              input: SECRET,
              output: SECRET,
              results: SECRET,
              instructions: SECRET,
              error: { cause: SECRET, stack: SECRET },
              metadata: SECRET,
              env: SECRET,
              model: SECRET,
              provider: SECRET,
              snapshot: SECRET,
              files: [SECRET],
              url: `https://example.test/?secret=${SECRET}`,
              headers: { authorization: SECRET },
            },
          }),
        { discard: true },
      )
      yield* bus.publish(
        Event.ephemeral({ type: "session.future", schema: { sessionID: Schema.String, secret: Schema.String } }),
        { sessionID, secret: SECRET },
      )
      yield* collector.close
      expect(collector.health().collectionFailures).toBe(0)
      expect(collector.health().unsupported).toBe(1)
      const events = sink.lines
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecords.Record))(line))
        .filter((record) => record.kind === "event")
      expect(events.map((record) => record.type)).toEqual([...TraceRecords.Types])
      expect(sink.lines.join("")).not.toContain(SECRET)
      expect(events.find((record) => record.type === "session.step.ended")?.tokens?.cacheWrite).toBe(5)
      expect(events.find((record) => record.type === "session.step.ended")?.cost).toBe(0)
    }),
  )
})

it.live("scheduled retries keep native ordinal and shared message, never invent Physical Attempt IDs", () => {
  const sink = memorySink()
  return withCollector(options, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        [1, 2],
        (attempt) =>
          bus.publish(SessionEvent.RetryScheduled, {
            sessionID,
            assistantMessageID: messageID,
            attempt,
            at: 1,
            error: { type: SECRET, message: SECRET, response: { body: SECRET } },
          }),
        { discard: true },
      )
      yield* collector.close
      const events = sink.lines
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecords.Record))(line))
        .filter((record) => record.kind === "event")
      expect(events.map((record) => record.attemptOrdinal)).toEqual([1, 2])
      expect(events[0].message).toBe(events[1].message)
      expect(sink.lines.join("")).not.toContain(SECRET)
      expect(sink.lines.join("")).not.toContain("physicalAttemptID")
    }),
  )
})

it.live("byte admission bound can reject even the first record without queue growth", () => {
  const sink = memorySink()
  return withCollector({ ...options, limits: { queueBytes: 1 } }, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* bus.publish(Tool, data)
      yield* collector.close
      expect(collector.health().dropped).toBe(1)
      expect(collector.health().peakBytes).toBe(0)
      expect(collector.health().peakRecords).toBe(0)
    }),
  )
})

it.live("missing native execution terminal and failed sink close cannot leave a completion claim", () => {
  const sink = memorySink()
  return withCollector(options, { ...sink, close: Effect.fail(new Error(SECRET)) }, (collector, bus) =>
    Effect.gen(function* () {
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID })
      yield* collector.close
      expect(collector.health().complete).toBe(false)
      expect(collector.health().state).toBe("failed")
      expect(sink.lines.at(-1)).toContain('"closure":"unconfirmed"')
      expect(sink.lines.at(-1)).toContain('"complete":false')
      expect(sink.lines.join("")).not.toContain(SECRET)
    }),
  )
})

it.live("cancellation during explicit close still waits for bounded owned sink cleanup", () =>
  Effect.gen(function* () {
    const closing = yield* Deferred.make<void>()
    const closed = { count: 0 }
    const sink = memorySink()
    yield* withCollector(
      { ...options, limits: { shutdownMs: 100 } },
      {
        ...sink,
        close: Deferred.succeed(closing, undefined).pipe(
          Effect.andThen(Effect.sleep("20 millis")),
          Effect.tap(() =>
            Effect.sync(() => {
              closed.count++
            }),
          ),
        ),
      },
      (collector, bus) =>
        Effect.gen(function* () {
          yield* bus.publish(Tool, data)
          const fiber = yield* collector.close.pipe(Effect.forkScoped)
          yield* Deferred.await(closing)
          yield* Fiber.interrupt(fiber)
          expect(closed.count).toBe(1)
          expect(collector.health().complete).toBe(false)
          yield* collector.close
          expect(closed.count).toBe(1)
        }),
    )
  }),
)

it.live("failed in-flight writes account for every admitted record in the bounded loss interval", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const failed = yield* Deferred.make<void>()
    const sink = memorySink()
    const calls = { value: 0 }
    yield* withCollector(
      options,
      {
        write: (line) =>
          Effect.suspend(() => {
            calls.value++
            if (calls.value === 1) return Deferred.await(gate).pipe(Effect.andThen(sink.write(line)))
            if (calls.value === 2)
              return Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.fail(new Error(SECRET))))
            return sink.write(line)
          }),
        close: Effect.void,
      },
      (collector, bus) =>
        Effect.gen(function* () {
          yield* Effect.forEach([1, 2, 3], () => bus.publish(Tool, data), { discard: true })
          yield* Deferred.succeed(gate, undefined)
          yield* Deferred.await(failed)
          yield* collector.close
          expect(collector.health().written).toBe(0)
          expect(collector.health().dropped).toBe(3)
          expect(collector.health().firstLoss).toBe(0)
          expect(collector.health().lastLoss).toBe(2)
          expect(collector.health().queued).toBe(0)
        }),
    )
  }),
)

for (const persist of [false, true]) {
  it.live(`actual embedded SDK retains host persistence=${persist} with trace acquisition`, () =>
    withScratch((directory) =>
      Effect.gen(function* () {
        const sink = memorySink()
        const collector = yield* start(options, sink)
        const host = yield* Effect.acquireRelease(
          EmbeddedHost.create(
            {
              events: { persist },
              models: { fetch: false },
              fs: { filewatcher: false },
            },
            { overrides: [Global.node.replace(scratchGlobal(directory)), ...collector.overrides] },
          ),
          (host) => Effect.promise(host.close),
        )
        const bus = Context.get(yield* host.runtime.contextEffect, Bus.Service)
        yield* bus.publish(SessionEvent.Renamed, { sessionID, title: SECRET })
        const entries = yield* bus.log({ aggregateID: sessionID }).pipe(Stream.runCollect)
        expect(entries.filter((event) => event.type !== "log.synced")).toHaveLength(persist ? 1 : 0)
        expect(entries.flatMap((event) => (Bus.isSynced(event) ? [] : [event.data]))).toEqual(
          persist ? [{ sessionID, title: SECRET }] : [],
        )
        yield* collector.close
        expect(collector.health().collectionFailures).toBe(0)
        expect(collector.health().complete).toBe(true)
      }),
    ).pipe(Effect.scoped),
  )
}

for (const fault of ["defect", "interrupt", "stall"] as const) {
  for (const explicit of [false, true]) {
    it.live(`${fault} unsubscribe is bounded and sanitized during ${explicit ? "explicit" : "host"} close`, () => {
      const sink = memorySink()
      const closed = { count: 0 }
      const custom = Bus.node.mapLayer((layer) =>
        Layer.effect(
          Bus.Service,
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            return Bus.Service.of({
              ...bus,
              listen: (listener) =>
                bus
                  .listen(listener)
                  .pipe(
                    Effect.map((unsubscribe) =>
                      unsubscribe.pipe(
                        Effect.andThen(
                          fault === "defect"
                            ? Effect.die(new Error(SECRET))
                            : fault === "interrupt"
                              ? Effect.interrupt
                              : Effect.sleep("2 seconds"),
                        ),
                      ),
                    ),
                  ),
            })
          }),
        ).pipe(Layer.provide(layer)),
      )
      const started = performance.now()
      return withCollector(
        { ...options, limits: { shutdownMs: 5 } },
        {
          write: sink.write,
          close: Effect.sync(() => {
            closed.count++
          }),
        },
        (collector, bus) =>
          Effect.gen(function* () {
            yield* bus.publish(Tool, data)
            if (explicit) {
              yield* collector.close
              yield* collector.close
            }
            return collector.health
          }),
        [Bus.node.replace(custom)],
      ).pipe(
        Effect.tap((health) =>
          Effect.sync(() => {
            expect(performance.now() - started).toBeLessThan(1000)
            expect(closed.count).toBe(1)
            expect(health().state).toBe("failed")
            expect(health().complete).toBe(false)
            expect(health().collectionFailures).toBe(1)
            expect(sink.lines.some((line) => line.includes('"kind":"summary"'))).toBe(true)
            expect(sink.lines.join("")).not.toContain(SECRET)
          }),
        ),
      )
    })
  }
}

it.live("overlapping host release cannot certify collector completion while unsubscribe is pending", () =>
  withScratch((directory) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const sink = memorySink()
      const collector = yield* start(options, sink)
      const hostScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const custom = Bus.node.mapLayer((layer) =>
        Layer.effect(
          Bus.Service,
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            return Bus.Service.of({
              ...bus,
              listen: (listener) =>
                bus
                  .listen(listener)
                  .pipe(
                    Effect.map((unsubscribe) =>
                      unsubscribe.pipe(
                        Effect.andThen(Deferred.succeed(entered, undefined)),
                        Effect.andThen(Deferred.await(release)),
                      ),
                    ),
                  ),
            })
          }),
        ).pipe(Layer.provide(layer)),
      )
      yield* Layer.build(
        LayerNode.compile(LayerNode.group([SdkPlugins.node, Bus.node]), {
          replacements: [
            Global.node.replace(scratchGlobal(directory)),
            Bus.node.replace(custom),
            ...collector.overrides,
          ],
        }),
      ).pipe(Effect.provideService(Scope.Scope, hostScope))
      const closing = yield* Scope.close(hostScope, Exit.void).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* collector.close
      expect(collector.health().state).toBe("closed")
      expect(collector.health().complete).toBe(false)
      expect(collector.health().collectionFailures).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(collector.health().complete).toBe(false)
    }),
  ).pipe(Effect.scoped),
)

it.live("custom native Bus configuration and actual Bus identity survive observer acquisition", () => {
  const sink = memorySink()
  const original: { bus?: Bus.Interface } = {}
  const custom = Bus.configured({ persist: true, logReadPageSize: 1 }).mapLayer((layer) =>
    Layer.effect(
      Bus.Service,
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        original.bus = bus
        return bus
      }),
    ).pipe(Layer.provide(layer)),
  )
  return withCollector(
    options,
    sink,
    (collector, bus) =>
      Effect.gen(function* () {
        expect(original.bus).toBe(bus)
        yield* bus.publish(SessionEvent.InboxCancelled, { sessionID, inboxID: messageID })
        yield* bus.publish(SessionEvent.InboxCancelled, { sessionID, inboxID: messageID })
        const stored = yield* bus.log({ aggregateID: sessionID }).pipe(Stream.runCollect)
        expect(stored.filter((event) => !Bus.isSynced(event))).toHaveLength(2)
        yield* collector.close
        const events = sink.lines
          .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecords.Record))(line))
          .filter((record) => record.kind === "event")
        expect(events.map((event) => event.sequence)).toEqual([0, 1])
        expect(events.map((event) => event.version)).toEqual([1, 1])
        expect(collector.health().complete).toBe(true)
      }),
    [Bus.node.replace(custom)],
  )
})

it.live("standalone cost survives missing tokens while nonfinite accounting is dropped safely", () => {
  const sink = memorySink()
  const Failed = Event.ephemeral({
    type: "session.step.failed",
    schema: {
      sessionID: Session.ID,
      assistantMessageID: SessionMessage.ID,
      cost: Schema.Number,
      error: Schema.Unknown,
    },
  })
  return withCollector(options, sink, (collector, bus) =>
    Effect.gen(function* () {
      yield* bus.publish(Failed, { ...data, cost: 3, error: { cause: SECRET } })
      yield* bus.publish(Failed, { ...data, cost: 1e100, error: { cause: SECRET } })
      yield* bus.publish(Failed, { ...data, cost: Infinity, error: { cause: SECRET } })
      yield* collector.close
      const events = sink.lines
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecords.Record))(line))
        .filter((record) => record.kind === "event")
      expect(events.map((event) => event.cost)).toEqual([3, 1e15])
      expect(events.every((event) => event.tokens === undefined)).toBe(true)
      expect(collector.health().collectionFailures).toBe(1)
      expect(collector.health().dropped).toBe(1)
      expect(sink.lines.join("")).not.toContain(SECRET)
    }),
  )
})
