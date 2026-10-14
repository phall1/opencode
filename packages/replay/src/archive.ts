import { createHash } from "node:crypto"
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"

export const MAX_BYTES = 8 * 1024 * 1024
export const MAX_ANCESTRY = 4
export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const FilePath = Schema.String.check(Schema.isPattern(/^\/fixture\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.txt$/))
export const Files = Schema.Record(FilePath, Schema.String)
export const Result = Schema.Struct({
  output: Schema.optional(Schema.Json),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Tool.Content)])),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
})
export const ToolEntry = Schema.Struct({
  occurrence: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.Literals(["read", "write"]),
  input: Schema.Json,
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literal("completed"), result: Result }),
    Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }),
  ]),
})
export type ToolEntry = typeof ToolEntry.Type
export const NativeExport = Schema.Struct({ info: Session.Info, messages: Schema.Array(SessionMessage.Info) })
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  profile: Schema.Literal("serial-text-files-v1"),
  identity: Schema.Struct({
    bun: Schema.String,
    effect: Schema.Literal("4.0.1"),
    sources: Schema.Record(Schema.String, Hash),
    model: Schema.Literal("fixture/repair-v1"),
    instructions: Schema.String,
    policy: Schema.Literal("read-write-only;fixed-tree;steps=4;no-formatters"),
  }),
  prompt: Schema.String,
  initial: Hash,
  checkpoint: Hash,
  tools: Hash,
  http: Hash,
  context: Hash,
  parent: Schema.optional(Hash),
})
export const Capsule = Schema.Struct({
  digest: Hash,
  manifest: Manifest,
  blobs: Schema.Record(Hash, Schema.String),
})
export type Capsule = typeof Capsule.Type

export function canonical(value: Schema.Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

export const json = Schema.decodeUnknownSync(Schema.Json)
export const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
export const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export const encode = (value: unknown) => canonical(json(value))

export function durableWrite(file: string, text: string) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Archive exceeds 8 MiB limit")
  const fd = openSync(file, "wx", 0o600)
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function freeze(manifest: typeof Manifest.Type, blobs: Record<string, string>): Capsule {
  return validate({ digest: hash(encode(manifest)), manifest, blobs })
}

export function validate(input: unknown): Capsule {
  return validateAtDepth(input, 0)
}

function validateAtDepth(input: unknown, depth: number): Capsule {
  if (depth > MAX_ANCESTRY) throw new Error("Unsupported ancestry depth (maximum four forks)")
  const capsule = Schema.decodeUnknownSync(Capsule, { onExcessProperty: "error" })(input)
  if (Buffer.byteLength(encode(capsule)) > MAX_BYTES) throw new Error("Archive exceeds 8 MiB limit")
  if (hash(encode(capsule.manifest)) !== capsule.digest) throw new Error("Manifest digest mismatch")
  Object.entries(capsule.blobs).forEach(([id, text]) => {
    if (hash(text) !== id) throw new Error(`Blob digest mismatch: ${id}`)
  })
  const refs = ["initial", "checkpoint", "tools", "http", "context"] as const
  refs.forEach((key) => blob(capsule, capsule.manifest[key]))
  const referenced = new Set([
    ...refs.map((key) => capsule.manifest[key]),
    ...(capsule.manifest.parent ? [capsule.manifest.parent] : []),
  ])
  if (Object.keys(capsule.blobs).some((id) => !referenced.has(id))) throw new Error("Unreferenced archive blob")
  decodeFiles(capsule, "initial")
  decodeFiles(capsule, "checkpoint")
  decodeTools(capsule)
  requireIdleContext(
    Schema.decodeUnknownSync(Schema.fromJsonString(NativeExport))(blob(capsule, capsule.manifest.context)),
  )
  parseJson(blob(capsule, capsule.manifest.http))
  validateLineage(capsule, depth)
  return capsule
}

function validateLineage(capsule: Capsule, depth: number) {
  if (!capsule.manifest.parent) return
  const ancestor = validateAtDepth(parseJson(blob(capsule, capsule.manifest.parent)), depth + 1)
  if (capsule.manifest.initial !== ancestor.manifest.checkpoint)
    throw new Error("Child initial world does not match parent checkpoint")
  if (encode(capsule.manifest.identity) !== encode(ancestor.manifest.identity))
    throw new Error("Child runtime provenance does not match parent")
}

function requireIdleContext(context: typeof NativeExport.Type) {
  if (context.info.outcome !== "succeeded") throw new Error("Unsupported checkpoint outcome")
  const last = context.messages.at(-1)
  if (last?.type !== "idle" || last.outcome !== "succeeded")
    throw new Error("Checkpoint must end at a succeeded native idle boundary")
}

export const parent = (capsule: Capsule): Capsule | undefined =>
  capsule.manifest.parent ? validate(parseJson(blob(capsule, capsule.manifest.parent))) : undefined

export function ancestryDepth(capsule: Capsule): number {
  const ancestor = parent(capsule)
  return ancestor ? ancestryDepth(ancestor) + 1 : 0
}

export function blob(capsule: Capsule, id: string) {
  const text = capsule.blobs[id]
  if (text === undefined) throw new Error(`Missing blob: ${id}`)
  return text
}

export const decodeFiles = (capsule: Capsule, key: "initial" | "checkpoint") =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Files), { onExcessProperty: "error" })(
    blob(capsule, capsule.manifest[key]),
  )
export const decodeTools = (capsule: Capsule) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ToolEntry)))(blob(capsule, capsule.manifest.tools))

export function open(file: string) {
  if (statSync(file).size > MAX_BYTES) throw new Error("Archive exceeds 8 MiB limit")
  const raw = readFileSync(file)
  if (raw.byteLength > MAX_BYTES) throw new Error("Archive exceeds 8 MiB limit")
  return validate(parseJson(raw.toString("utf8")))
}

export function save(file: string, capsule: Capsule) {
  durableWrite(file, encode(validate(capsule)))
}
