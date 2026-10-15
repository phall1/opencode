import { lstatSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Hash, MAX_BYTES, ToolEntry, canonical, hash, parseJson } from "./archive"
import { RepoMeasurement, validateMeasurement } from "./repo-measure"
import { IsolationMode } from "./verifier-isolation"

const ToolStarted = Schema.Struct({
  occurrence: Schema.Int,
  name: Schema.Literals(["read", "write"]),
  input: Schema.Json,
  state: Schema.Literal("started; missing receipt means UNKNOWN"),
})
const TrackedStarted = Schema.Struct({
  state: Schema.Literal("started"),
  name: Schema.String,
  missingReceipt: Schema.Literal("UNKNOWN; do not repeat"),
})
const MeasurementStarted = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  episode: Hash,
  verifier: Schema.Literals(["public", "heldout"]),
  implementation: Hash,
  artifact: Hash,
  state: Schema.Literal("started; missing receipt means UNKNOWN; do not repeat"),
  testSource: Hash,
  isolation: Schema.optional(IsolationMode),
})
const Started = Schema.Union([ToolStarted, TrackedStarted, MeasurementStarted])
const TrackedReceipt = Schema.Struct({ state: Schema.Literal("completed"), name: Schema.String })
const decodeStarted = Schema.decodeUnknownSync(Started, { onExcessProperty: "error" })

/** Read-only evidence inspection. A filename's existence is never a receipt. */
export function inspectJournal(directory: string) {
  if (!lstatSync(directory).isDirectory()) throw new Error("Journal directory must be a real directory")
  return readdirSync(directory, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".started.json"))
    .map((file) => inspectEffect(directory, file))
}

function inspectEffect(directory: string, file: string) {
  try {
    const started = decodeStarted(readJournalFile(path.join(directory, file)).value)
    const receipt = matchingReceipt(path.join(directory, file), started)
    return {
      started: file,
      state: "completed" as const,
      receipt: path.relative(directory, receipt.file),
      digest: receipt.digest,
    }
  } catch (error) {
    return { started: file, state: "UNKNOWN; must not repeat" as const, detail: String(error) }
  }
}

export function readJournalFile(file: string) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw new Error("Receipt must be a bounded regular file, not symlink/directory")
  const raw = readFileSync(file, "utf8")
  return { value: parseJson(raw), digest: hash(raw) }
}

function matchingReceipt(file: string, started: typeof Started.Type) {
  const base = file.replace(/\.started\.json$/, "")
  if ("occurrence" in started) {
    requireFilename(file, `tool-${started.occurrence}.started.json`)
    const read = readJournalFile(`${base}.json`)
    const receipt = Schema.decodeUnknownSync(ToolEntry, { onExcessProperty: "error" })(read.value)
    if (
      receipt.occurrence !== started.occurrence ||
      receipt.name !== started.name ||
      canonical(receipt.input) !== canonical(started.input)
    )
      throw new Error("Tool receipt does not match started effect")
    return { file: `${base}.json`, digest: read.digest }
  }
  if ("id" in started) return measurementReceipt(file, base, started)
  requireFilename(file, `${started.name}.started.json`)
  const read = readJournalFile(`${base}.receipt.json`)
  const receipt = Schema.decodeUnknownSync(TrackedReceipt, { onExcessProperty: "error" })(read.value)
  if (receipt.name !== started.name) throw new Error("Native receipt does not match started effect")
  return { file: `${base}.receipt.json`, digest: read.digest }
}

function measurementReceipt(file: string, base: string, started: typeof MeasurementStarted.Type) {
  requireFilename(file, `measurement-${started.id}.started.json`)
  const read = readJournalFile(`${base}.json`)
  const receipt = Schema.decodeUnknownSync(RepoMeasurement, { onExcessProperty: "error" })(read.value)
  validateMeasurement(receipt)
  const actual = {
    id: receipt.id,
    episode: receipt.episode,
    verifier: receipt.scope,
    implementation: receipt.implementation,
    artifact: receipt.artifact,
    testSource: receipt.testSource,
    isolation: receipt.isolation?.mode ?? "trusted-host",
  }
  const expected = {
    id: started.id,
    episode: started.episode,
    verifier: started.verifier,
    implementation: started.implementation,
    artifact: started.artifact,
    testSource: started.testSource,
    isolation: started.isolation ?? "trusted-host",
  }
  if (canonical(actual) !== canonical(expected)) throw new Error("Measurement receipt does not match started effect")
  return { file: `${base}.json`, digest: read.digest }
}

function requireFilename(file: string, expected: string) {
  if (path.basename(file) !== expected) throw new Error("Started filename does not match effect metadata")
}

export function requireJournalComplete(directory: string) {
  const unknown = inspectJournal(directory).find((effect) => effect.state !== "completed")
  if (unknown) throw new Error(`UNKNOWN effect ${unknown.started}: ${unknown.detail}; inspect only, do not repeat`)
}
