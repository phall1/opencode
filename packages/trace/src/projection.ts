import { Event } from "@opencode/schema/event"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionID } from "@opencode/schema/session-id"
import { Schema, Struct } from "effect"
import { createHmac, randomBytes } from "node:crypto"
import { TraceRecords } from "./records"

export const boundedID = Schema.String.check(Schema.isMaxLength(256))
export const SelectedSession = SessionID.check(Schema.isMaxLength(256))
const ref = Schema.Struct({ sessionID: SessionID })
const supported = new Set<string>(TraceRecords.Types)

// Decode only this finite projection of each canonical schema, never its body.
// The native Bus input is unknown at this seam; no raw event is retained.
const decode = Schema.decodeUnknownSync(
  Schema.toType(
    Schema.Union([
      metadata(SessionEvent.Created, ["sessionID", "parentID"]),
      metadata(SessionEvent.Forked, ["sessionID", "parentID"]),
      metadata(SessionEvent.Moved, ["sessionID"]),
      metadata(SessionEvent.InboxEnqueued, ["sessionID", "inboxID"]),
      metadata(SessionEvent.InboxDelivered, ["sessionID", "inboxID"]),
      metadata(SessionEvent.InboxCancelled, ["sessionID", "inboxID"]),
      metadata(SessionEvent.Execution.Started, ["sessionID"]),
      metadata(SessionEvent.Execution.Succeeded, ["sessionID"]),
      metadata(SessionEvent.Execution.Failed, ["sessionID"]),
      metadata(SessionEvent.Execution.Interrupted, ["sessionID", "reason"]),
      metadata(SessionEvent.Step.Started, ["sessionID", "assistantMessageID", "started"]),
      metadata(SessionEvent.Step.Streamed, ["sessionID", "assistantMessageID"]),
      metadata(SessionEvent.Step.Ended, ["sessionID", "assistantMessageID", "finish", "cost", "tokens"]),
      metadata(SessionEvent.Step.Failed, ["sessionID", "assistantMessageID", "finish", "cost", "tokens"]),
      metadata(SessionEvent.Tool.Input.Started, ["sessionID", "assistantMessageID", "id", "name"]),
      metadata(SessionEvent.Tool.Called, ["sessionID", "assistantMessageID", "id"]),
      metadata(SessionEvent.Tool.Success, ["sessionID", "assistantMessageID", "id"]),
      metadata(SessionEvent.Tool.Failed, ["sessionID", "assistantMessageID", "id"]),
      metadata(SessionEvent.RetryScheduled, ["sessionID", "assistantMessageID", "attempt"]),
      metadata(SessionEvent.Compaction.Started, ["sessionID", "reason"]),
      metadata(SessionEvent.Compaction.Ended, ["sessionID", "reason", "cost", "tokens"]),
      metadata(SessionEvent.Compaction.Failed, ["sessionID", "reason", "cost", "tokens"]),
    ]),
  ),
)

function metadata<
  const T extends string,
  const Fields extends Schema.Struct.Fields,
  const Keys extends readonly (keyof Fields)[],
>(definition: { type: T; data: Schema.Struct<Fields> }, keys: Keys) {
  return Schema.Struct({ type: Schema.Literal(definition.type), data: definition.data.mapFields(Struct.pick(keys)) })
}

const numeric = (value: number) => Math.min(1e15, Math.max(0, Schema.decodeUnknownSync(Schema.Finite)(value)))

export function makeProjection(selected: (sessionID: string) => boolean) {
  const key = randomBytes(32)
  const pseudonym = (domain: string, ...ids: string[]) => {
    ids.forEach((id) => Schema.decodeUnknownSync(boundedID)(id))
    return createHmac("sha256", key)
      .update(JSON.stringify([domain, ...ids]))
      .digest("hex")
      .slice(0, 32)
  }
  return (event: Event.Payload, ordinal: number): TraceRecords.Metadata | "unsupported" | undefined => {
    if (!event.type.startsWith("session.")) return
    const sessionID = Schema.decodeUnknownSync(ref)(event.data).sessionID
    if (!selected(sessionID)) return
    Schema.decodeUnknownSync(boundedID)(sessionID)
    if (event.type.length > 64) return "unsupported"
    if (!supported.has(event.type)) return "unsupported"
    const input = decode(event)
    return {
      kind: "event",
      format: 1,
      type: input.type,
      ordinal,
      created: numeric(event.created),
      event: pseudonym("event", event.id),
      session: pseudonym("session", sessionID),
      sequence: event.durable ? counter(event.durable.seq) : undefined,
      version: event.durable ? counter(event.durable.version) : undefined,
      ...links(input.data, pseudonym),
      ...details(input.data),
    }
  }
}

type Data = ReturnType<typeof decode>["data"]
type Pseudonym = (domain: string, ...ids: string[]) => string

function links(data: Data, pseudonym: Pseudonym) {
  const message = "assistantMessageID" in data ? data.assistantMessageID : undefined
  return {
    parent: "parentID" in data && data.parentID ? pseudonym("session", data.parentID) : undefined,
    inbox: "inboxID" in data ? pseudonym("message", data.sessionID, data.inboxID) : undefined,
    message: message ? pseudonym("message", data.sessionID, message) : undefined,
    tool: "id" in data ? pseudonym("tool", data.sessionID, data.assistantMessageID, data.id) : undefined,
  }
}

function details(data: Data) {
  return {
    started: "started" in data ? numeric(data.started) : undefined,
    category: "name" in data ? toolCategory(data.name) : undefined,
    finish: "finish" in data ? data.finish : undefined,
    attemptOrdinal: "attempt" in data ? counter(data.attempt) : undefined,
    ...reason(data),
    ...usage(data),
  }
}

function counter(value: number) {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(numeric(value)))
}

function reason(data: Data) {
  if (!("reason" in data)) return {}
  if (data.reason === "auto" || data.reason === "manual") return { compaction: data.reason }
  return { interruption: data.reason }
}
function toolCategory(name: string): "read" | "write" | "shell" | "custom" {
  if (name === "read") return "read"
  if (name === "write" || name === "edit") return "write"
  if (name === "shell" || name === "bash") return "shell"
  return "custom"
}
function usage(data: Data) {
  const tokens = "tokens" in data ? data.tokens : undefined
  return {
    cost: "cost" in data && data.cost !== undefined ? numeric(data.cost) : undefined,
    tokens: tokens
      ? {
          input: numeric(tokens.input),
          output: numeric(tokens.output),
          reasoning: numeric(tokens.reasoning),
          cacheRead: numeric(tokens.cache.read),
          cacheWrite: numeric(tokens.cache.write),
        }
      : undefined,
  }
}
