import { Bus } from "@opencode/core/bus"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Event } from "@opencode/schema/event"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Exit, Fiber, Layer, Option } from "effect"
import { limits, type Enabled } from "./options"
import { makeProjection } from "./projection"
import { TraceRecords } from "./records"
import type { Sink } from "./sink"

export const emptyHealth = (state: TraceRecords.Health["state"]): TraceRecords.Health => ({
  state,
  complete: false,
  observed: 0,
  written: 0,
  dropped: 0,
  unsupported: 0,
  collectionFailures: 0,
  sinkFailures: 0,
  queued: 0,
  queuedBytes: 0,
  peakRecords: 0,
  peakBytes: 0,
  bytes: 0,
})
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1)
const line = (value: typeof TraceRecords.Record.Type) => JSON.stringify(value) + "\n"
const SUMMARY_RESERVE = 4096
const RECORD_BYTES = 2048

export const start = Effect.fnUntraced(function* (options: Enabled, sink: Sink) {
  const caps = limits(options)
  const sessions = "sessions" in options.selection ? new Set<string>(options.selection.sessions) : undefined
  const project = makeProjection((id) => sessions?.has(id) ?? true)
  const health = { ...emptyHealth("recording") }
  const pending: { text: string; ordinal: number }[] = []
  const active = new Set<string>()
  const unsubscribes = new Set<Bus.Unsubscribe>()
  const state = {
    closing: false,
    attached: false,
    incomplete: false,
    observerReleases: 0,
    accepted: 0,
    reserved: 0,
  }

  const loss = (ordinal: number) => {
    health.dropped = increment(health.dropped)
    health.firstLoss = Math.min(health.firstLoss ?? ordinal, ordinal)
    health.lastLoss = Math.max(health.lastLoss ?? ordinal, ordinal)
    state.incomplete = true
  }
  const admit = (record: TraceRecords.Metadata) => {
    const text = line(record)
    const bytes = Buffer.byteLength(text)
    if (bytes > RECORD_BYTES) return loss(record.ordinal)
    if (state.accepted >= caps.records) return loss(record.ordinal)
    if (state.reserved + bytes > caps.fileBytes - SUMMARY_RESERVE) return loss(record.ordinal)
    if (health.queued >= caps.queueRecords || health.queuedBytes + bytes > caps.queueBytes) return loss(record.ordinal)
    pending.push({ text, ordinal: record.ordinal })
    state.accepted++
    state.reserved += bytes
    health.queued++
    health.queuedBytes += bytes
    health.peakRecords = Math.max(health.peakRecords, health.queued)
    health.peakBytes = Math.max(health.peakBytes, health.queuedBytes)
  }
  const observe = (event: Event.Payload) =>
    Effect.sync(() => {
      if (state.closing || health.state !== "recording") return
      // Catch JS failures *inside* the synchronous observer: ephemeral Bus listeners
      // are not isolated. Neither causes nor body-bearing events escape to a queue.
      try {
        const record = project(event, health.observed)
        if (!record) return
        if (record === "unsupported") {
          health.unsupported = increment(health.unsupported)
          return
        }
        health.observed = increment(health.observed)
        trackExecution(record, active, state)
        admit(record)
      } catch {
        health.collectionFailures = increment(health.collectionFailures)
        loss(health.observed)
        health.observed = increment(health.observed)
      }
    })
  const releaseObserver = Effect.fnUntraced(function* (unsubscribe: Bus.Unsubscribe) {
    // Claim cleanup once: host release and explicit close share this operation.
    if (!unsubscribes.delete(unsubscribe)) return
    state.observerReleases++
    yield* unsubscribe.pipe(
      Effect.interruptible,
      Effect.timeout(caps.shutdownMs),
      Effect.catchCause(() =>
        Effect.sync(() => {
          health.collectionFailures = increment(health.collectionFailures)
          health.state = "failed"
          health.complete = false
          state.incomplete = true
        }),
      ),
      Effect.ensuring(Effect.sync(() => state.observerReleases--)),
    )
  })
  const write = (text: string) =>
    Effect.suspend(() => sink.write(text)).pipe(
      Effect.interruptible,
      Effect.timeout(caps.shutdownMs),
      Effect.tap(() =>
        Effect.sync(() => {
          health.bytes += Buffer.byteLength(text)
        }),
      ),
    )
  const header = line({ kind: "header", format: 1, coverage: TraceRecords.coverage })
  state.reserved = Buffer.byteLength(header)
  const worker = yield* Effect.gen(function* () {
    yield* write(header)
    while (!state.closing || pending.length > 0) {
      const current = pending[0]
      if (current === undefined) {
        yield* Effect.sleep("2 millis")
        continue
      }
      yield* write(current.text)
      pending.shift()
      health.written = increment(health.written)
      health.queued--
      health.queuedBytes -= Buffer.byteLength(current.text)
    }
  }).pipe(
    Effect.catchCause(() =>
      Effect.sync(() => {
        health.state = "failed"
        health.sinkFailures = increment(health.sinkFailures)
        state.incomplete = true
      }),
    ),
    Effect.forkScoped,
  )

  const close = (successfulScope: boolean) =>
    Effect.gen(function* () {
      if (state.closing) return
      // Stop admission before awaiting any I/O, even when explicitly closed while
      // the embedded host is still alive. Layer finalizers may unsubscribe again.
      state.closing = true
      if (health.state !== "failed") health.state = "closing"
      yield* Effect.forEach(Array.from(unsubscribes), releaseObserver, { discard: true })
      const drained = yield* Fiber.join(worker).pipe(Effect.interruptible, Effect.timeoutOption(caps.shutdownMs))
      if (Option.isNone(drained)) {
        state.incomplete = true
        yield* Fiber.interrupt(worker)
      }
      pending.forEach((item) => loss(item.ordinal))
      pending.length = 0
      health.queued = 0
      health.queuedBytes = 0
      // Another scope may already own observer cleanup. Do not certify an
      // unsettled release merely because it was removed from the admission set.
      const complete =
        successfulScope && state.attached && !state.incomplete && active.size === 0 && state.observerReleases === 0
      // An on-disk footer cannot certify the close that happens after its write.
      // Only live health after close may report complete; never leave a success
      // marker on disk when the subsequent close can still fail.
      const summary = line({
        kind: "summary",
        format: 1,
        coverage: TraceRecords.coverage,
        closure: "unconfirmed",
        health: { ...health, complete: false },
      })
      // Failure and timeout are sanitized; never log the sink cause or raw path.
      yield* write(summary).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            health.sinkFailures = increment(health.sinkFailures)
            health.state = "failed"
            health.complete = false
          }),
        ),
      )
      yield* sink.close.pipe(
        Effect.interruptible,
        Effect.timeout(caps.shutdownMs),
        Effect.catchCause(() =>
          Effect.sync(() => {
            health.sinkFailures = increment(health.sinkFailures)
            health.state = "failed"
            health.complete = false
          }),
        ),
      )
      if (health.state !== "failed") {
        health.state = "closed"
        health.complete = complete
      }
    }).pipe(
      Effect.uninterruptible,
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          state.incomplete = true
          health.complete = false
        }),
      ),
    )
  yield* Effect.addFinalizer((exit) => close(Exit.isSuccess(exit)))

  const overrides: LayerNode.Replacements = [
    SdkPlugins.node.replace(
      SdkPlugins.node.mapLayer((layer) =>
        Layer.effect(
          SdkPlugins.Service,
          Effect.gen(function* () {
            const plugins = yield* SdkPlugins.Service
            if (state.closing) return plugins
            if (state.attached) {
              health.collectionFailures = increment(health.collectionFailures)
              state.incomplete = true
              return plugins
            }
            // SdkPlugins already depends on the host's effective Bus. serviceOption
            // preserves mapLayer's generic R contract instead of replacing a configured
            // Bus node (which would silently reset the SDK's persistence setting).
            const bus = yield* Effect.serviceOption(Bus.Service)
            if (Option.isNone(bus)) {
              health.collectionFailures = increment(health.collectionFailures)
              state.incomplete = true
              return plugins
            }
            // Deliberate use of the low-level listener: subscribe() allocates an
            // unbounded body-bearing PubSub backlog before a privacy projection.
            const unsubscribe = yield* bus.value.listen(observe)
            unsubscribes.add(unsubscribe)
            state.attached = true
            yield* Effect.addFinalizer(() => releaseObserver(unsubscribe))
            return plugins
          }),
        ).pipe(Layer.provide(layer)),
      ),
    ),
  ]
  return {
    overrides,
    health: () => ({ ...health }),
    close: close(true),
    // Internal test seam; capture() does not expose the collector-owned buffer.
    pending: () => pending.map((item) => item.text),
  }
})

function trackExecution(record: TraceRecords.Metadata, active: Set<string>, state: { incomplete: boolean }) {
  if (record.type === "session.execution.started") {
    if (active.size >= 256) {
      state.incomplete = true
      return
    }
    active.add(record.session)
  }
  if (record.type === "session.execution.interrupted") state.incomplete = true
  if (
    ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(record.type)
  ) {
    if (!active.delete(record.session)) state.incomplete = true
  }
}
