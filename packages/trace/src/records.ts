export * as TraceRecords from "./records"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"

export const Types = [
  "session.created",
  "session.forked",
  "session.moved",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.retry.scheduled",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
] as const

export const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
export const NumberValue = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e15 }))
export const Pseudonym = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/))
export const Metadata = Schema.Struct({
  kind: Schema.Literal("event"),
  format: Schema.Literal(1),
  type: Schema.Literals(Types),
  ordinal: Count,
  created: NumberValue,
  started: optional(NumberValue),
  event: Pseudonym,
  session: Pseudonym,
  parent: optional(Pseudonym),
  message: optional(Pseudonym),
  inbox: optional(Pseudonym),
  tool: optional(Pseudonym),
  sequence: optional(Count),
  version: optional(Count),
  attemptOrdinal: optional(Count),
  category: optional(Schema.Literals(["read", "write", "shell", "custom"])),
  finish: optional(Schema.Literals(["stop", "length", "tool-calls", "content-filter", "error", "unknown"])),
  interruption: optional(Schema.Literals(["user", "shutdown", "superseded", "inactivity"])),
  compaction: optional(Schema.Literals(["auto", "manual"])),
  cost: optional(NumberValue),
  tokens: optional(
    Schema.Struct({
      input: NumberValue,
      output: NumberValue,
      reasoning: NumberValue,
      cacheRead: NumberValue,
      cacheWrite: NumberValue,
    }),
  ),
}).annotate({ identifier: "Trace.Metadata.v1" })
export type Metadata = typeof Metadata.Type

export const Coverage = Schema.Struct({
  delivery: Schema.Literal("best-effort-live-metadata"),
  physicalAttempts: Schema.Literal("unavailable"),
  nestedCausality: Schema.Literal("unavailable"),
  content: Schema.Literal("excluded"),
  replay: Schema.Literal(false),
  verification: Schema.Literal("not-collected"),
  sourceContinuity: Schema.Literal("not-verified"),
})
export const coverage = Coverage.make({
  delivery: "best-effort-live-metadata",
  physicalAttempts: "unavailable",
  nestedCausality: "unavailable",
  content: "excluded",
  replay: false,
  verification: "not-collected",
  sourceContinuity: "not-verified",
})

export const Health = Schema.Struct({
  state: Schema.Literals(["disabled", "recording", "closing", "closed", "failed"]),
  complete: Schema.Boolean,
  observed: Count,
  written: Count,
  dropped: Count,
  unsupported: Count,
  collectionFailures: Count,
  sinkFailures: Count,
  queued: Count,
  queuedBytes: Count,
  peakRecords: Count,
  peakBytes: Count,
  bytes: Count,
  firstLoss: optional(Count),
  lastLoss: optional(Count),
}).annotate({ identifier: "Trace.Health.v1" })
export type Health = typeof Health.Type

export const Header = Schema.Struct({
  kind: Schema.Literal("header"),
  format: Schema.Literal(1),
  coverage: Coverage,
})
export const Summary = Schema.Struct({
  kind: Schema.Literal("summary"),
  format: Schema.Literal(1),
  coverage: Coverage,
  health: Health,
  closure: Schema.Literal("unconfirmed"),
})
export const Record = Schema.Union([Header, Metadata, Summary]).annotate({ identifier: "Trace.Record.v1" })
