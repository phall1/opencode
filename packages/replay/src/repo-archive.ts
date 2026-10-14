import { Schema } from "effect"
import { readFileSync, statSync } from "node:fs"
import {
  Hash,
  MAX_ANCESTRY,
  MAX_BYTES,
  NativeExport,
  ToolEntry,
  durableWrite,
  encode,
  hash,
  parseJson,
  requireIdleContext,
} from "./archive"
import { RepoFiles, Task, decodeTask, validateFiles } from "./repo-task"
// Workspace-private harness reuses the recorder's canonical archive schema, not a copy.
import { CassetteModel } from "../../http-recorder/src/cassette/model"

export const RepoManifest = Schema.Struct({
  version: Schema.Literal(1),
  profile: Schema.Literal("scripted-repo-v1"),
  state: Schema.Literal("complete"),
  task: Hash,
  policy: Schema.Literals(["assessment", "general", "overfit"]),
  prompt: Schema.String,
  identity: Schema.Struct({
    bun: Schema.String,
    sources: Schema.Record(Schema.String, Hash),
    model: Schema.Literal("fixture/repair-v1"),
  }),
  initial: Hash,
  checkpoint: Hash,
  context: Hash,
  http: Hash,
  tools: Hash,
  parent: Schema.optional(Hash),
  evidence: Schema.Struct({
    elapsedMs: Schema.Finite,
    elapsedScope: Schema.Literals(["assessment host+rollout", "cold prefix restore+fork+new rollout"]),
    requests: Schema.Int,
    provider: Schema.Int,
    tools: Schema.Int,
    outcome: Schema.Literal("succeeded"),
    nativeUsage: Schema.Json,
    realCost: Schema.Literal("UNKNOWN/not measured (scripted)"),
  }),
})
export const RepoCapsule = Schema.Struct({
  digest: Hash,
  manifest: RepoManifest,
  blobs: Schema.Record(Hash, Schema.String),
})
export type RepoCapsule = typeof RepoCapsule.Type
export const repoBlob = (capsule: RepoCapsule, id: string) => {
  const text = capsule.blobs[id]
  if (text === undefined) throw new Error(`Missing repo blob: ${id}`)
  return text
}
export const repoTask = (capsule: RepoCapsule) => decodeTask(parseJson(repoBlob(capsule, capsule.manifest.task)))
export const repoFiles = (capsule: RepoCapsule, key: "initial" | "checkpoint") =>
  Schema.decodeUnknownSync(Schema.fromJsonString(RepoFiles), { onExcessProperty: "error" })(
    repoBlob(capsule, capsule.manifest[key]),
  )
export const repoTools = (capsule: RepoCapsule) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ToolEntry)), { onExcessProperty: "error" })(
    repoBlob(capsule, capsule.manifest.tools),
  )
export const repoContext = (capsule: RepoCapsule) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(NativeExport), { onExcessProperty: "error" })(
    repoBlob(capsule, capsule.manifest.context),
  )
export const repoHttp = (capsule: RepoCapsule) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(CassetteModel.CassetteSchema), { onExcessProperty: "error" })(
    repoBlob(capsule, capsule.manifest.http),
  )
export const repoParent = (capsule: RepoCapsule): RepoCapsule | undefined =>
  capsule.manifest.parent ? validateRepo(parseJson(repoBlob(capsule, capsule.manifest.parent))) : undefined

export function validateRepo(input: unknown, depth = 0): RepoCapsule {
  if (depth > MAX_ANCESTRY) throw new Error("Maximum four repo forks")
  const capsule = Schema.decodeUnknownSync(RepoCapsule, { onExcessProperty: "error" })(input)
  if (Buffer.byteLength(encode(capsule)) > MAX_BYTES) throw new Error("Archive exceeds 8 MiB limit")
  if (hash(encode(capsule.manifest)) !== capsule.digest) throw new Error("Repo manifest digest mismatch")
  Object.entries(capsule.blobs).forEach(([id, text]) => {
    if (hash(text) !== id) throw new Error("Repo blob digest mismatch")
  })
  const refs = [
    capsule.manifest.task,
    capsule.manifest.initial,
    capsule.manifest.checkpoint,
    capsule.manifest.context,
    capsule.manifest.http,
    capsule.manifest.tools,
    ...(capsule.manifest.parent ? [capsule.manifest.parent] : []),
  ]
  refs.forEach((id) => repoBlob(capsule, id))
  if (Object.keys(capsule.blobs).some((id) => !refs.includes(id))) throw new Error("Unreferenced repo blob")
  validateEvidence(capsule)
  validateParent(capsule, depth)
  return capsule
}

function validateEvidence(capsule: RepoCapsule) {
  const task = repoTask(capsule)
  const initial = repoFiles(capsule, "initial")
  const checkpoint = repoFiles(capsule, "checkpoint")
  validateFiles(task, initial)
  validateFiles(task, checkpoint)
  requireIdleContext(repoContext(capsule))
  const tools = repoTools(capsule)
  if (tools.length !== capsule.manifest.evidence.tools) throw new Error("Incomplete tool evidence")
  const http = repoHttp(capsule)
  if (http.interactions.length !== capsule.manifest.evidence.requests) throw new Error("Incomplete HTTP evidence")
  if (http.interactions.some((entry) => entry.transport !== "http")) throw new Error("Unsupported non-HTTP tape")
  if (capsule.manifest.policy === "assessment") requireAssessment(capsule, task, tools, initial)
  Object.keys(task.files)
    .filter((file) => !task.writePaths.includes(file))
    .forEach((file) => {
      if (checkpoint[file] !== task.files[file]) throw new Error("Immutable actor file changed")
    })
}

function requireAssessment(
  capsule: RepoCapsule,
  task: Task,
  tools: readonly ToolEntry[],
  initial: typeof RepoFiles.Type,
) {
  if (
    capsule.manifest.parent ||
    !tools.length ||
    tools.some((entry) => entry.name !== "read" || entry.outcome.status !== "completed")
  )
    throw new Error("Assessment must read without edits")
  if (capsule.manifest.initial !== capsule.manifest.checkpoint || encode(initial) !== encode(task.files))
    throw new Error("Assessment changed initial bytes")
}

function validateParent(capsule: RepoCapsule, depth: number) {
  if (!capsule.manifest.parent) {
    if (capsule.manifest.policy !== "assessment") throw new Error("Continuation requires native checkpoint parent")
    requireToolCoverage(capsule)
    return
  }
  const parent = validateRepo(parseJson(repoBlob(capsule, capsule.manifest.parent)), depth + 1)
  if (capsule.manifest.initial !== parent.manifest.checkpoint) throw new Error("Repo child checkpoint mismatch")
  if (
    capsule.manifest.task !== parent.manifest.task ||
    encode(capsule.manifest.identity) !== encode(parent.manifest.identity)
  )
    throw new Error("Repo child provenance mismatch")
  requireToolCoverage(capsule, parent)
}

function nativeTools(capsule: RepoCapsule) {
  return repoContext(capsule).messages.flatMap((message) =>
    message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
  )
}
function requireToolCoverage(capsule: RepoCapsule, parent?: RepoCapsule) {
  const calls = nativeTools(capsule).slice(parent ? nativeTools(parent).length : 0)
  const tools = repoTools(capsule)
  if (calls.length !== tools.length) throw new Error("Incomplete/unused native tool evidence")
  calls.forEach((call, index) => {
    const entry = tools[index]
    if (entry.occurrence !== index + 1 || entry.name !== call.name || encode(entry.input) !== encode(call.state.input))
      throw new Error("Native tool evidence mismatch")
    if (entry.outcome.status !== call.state.status) throw new Error("Incomplete native tool receipt")
  })
}

export function freezeRepo(manifest: typeof RepoManifest.Type, blobs: Record<string, string>) {
  return validateRepo({ digest: hash(encode(manifest)), manifest, blobs })
}
export function openRepo(file: string) {
  if (statSync(file).size > MAX_BYTES) throw new Error("Archive exceeds 8 MiB limit")
  return validateRepo(parseJson(readFileSync(file, "utf8")))
}
export const saveRepo = (file: string, capsule: RepoCapsule) => durableWrite(file, encode(validateRepo(capsule)))
