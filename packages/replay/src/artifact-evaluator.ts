import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Hash, durableWrite, encode, hash } from "./archive"

export const ARTIFACT_BYTES = 4096
const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/))
export const Checkpoint = Schema.Struct({
  id: Name,
  machine: Name,
  parent: Schema.NullOr(Name),
  kind: Schema.Literal("live-branch-file-export"),
  image: Hash,
})
export const Artifact = Schema.Struct({
  file: Schema.String.check(Schema.isPattern(/^artifact-[a-f0-9-]{36}\.json$/)),
  sha256: Hash,
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: ARTIFACT_BYTES })),
  checkpoint: Checkpoint,
})
export type Artifact = typeof Artifact.Type
export const Verifier = Schema.Literals(["public-v1", "policy-v1", "policy-v2"])
export type Verifier = typeof Verifier.Type
const Reason = Schema.Literals([
  "missing",
  "truncated",
  "oversized",
  "invalid-utf8",
  "invalid-json",
  "invalid-config",
  "digest-mismatch",
  "collection-failed",
  "loopback-required",
  "authentication-required",
  "audit-required",
  "service-changed",
])
export const Measurement = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("artifact-evaluation-not-world-attestation"),
  id: Name,
  verifier: Verifier,
  verifierDigest: Hash,
  artifact: Schema.NullOr(Artifact),
  status: Schema.Literals(["PASSED", "FAILED", "UNKNOWN"]),
  reasons: Schema.Array(Reason),
})
export type Measurement = typeof Measurement.Type
const Config = Schema.Struct({
  listen: Schema.String,
  authRequired: Schema.Boolean,
  auditEnabled: Schema.Boolean,
  service: Schema.Struct({ enabled: Schema.Boolean, route: Schema.String, response: Schema.String }),
})
const implementation = hash(readFileSync(import.meta.filename, "utf8"))
const policy = {
  listen: "127.0.0.1",
  authRequired: true,
  auditEnabled: true,
  service: { enabled: true, route: "/health", response: "ok" },
} as const
export const fixtures = {
  baseline: { ...policy, listen: "0.0.0.0", authRequired: false, auditEnabled: false },
  general: policy,
  overfit: { ...policy, auditEnabled: false, service: { ...policy.service, enabled: false } },
}

/** New, owner-only directory; no aliasing an existing directory or symlinked parent. */
export function createEvaluationDirectory(directory: string) {
  const absolute = path.resolve(directory)
  if (realpathSync(path.dirname(absolute)) !== path.dirname(absolute)) throw new Error("Use a canonical output parent")
  mkdirSync(absolute, { mode: 0o700 })
  return absolute
}

export function requireEvaluationDirectory(directory: string) {
  const stat = lstatSync(directory)
  if (realpathSync(directory) !== path.resolve(directory)) throw new Error("Non-canonical evaluation directory")
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error("Evaluation directory must be owned and mode 0700")
}

/** Only the collected bytes are authoritative. Candidate-supplied score fields are ignored. */
export function freezeArtifact(directory: string, bytes: Uint8Array, checkpoint: typeof Checkpoint.Type): Artifact {
  requireEvaluationDirectory(directory)
  if (bytes.length > ARTIFACT_BYTES) throw new Error("Artifact exceeds byte limit")
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  const artifact = Schema.decodeUnknownSync(Artifact)({
    file: `artifact-${crypto.randomUUID()}.json`,
    sha256: hash(text),
    bytes: bytes.length,
    checkpoint: Schema.decodeUnknownSync(Checkpoint)(checkpoint),
  })
  durableWrite(path.join(directory, artifact.file), text)
  return artifact
}

export function collectArtifact(
  directory: string,
  result: { stdout: string; exitCode: number; truncated?: boolean } | undefined,
  checkpoint: typeof Checkpoint.Type,
) {
  if (!result) return unknownMeasurement(directory, "collection-failed")
  if (result.truncated) return unknownMeasurement(directory, "truncated")
  if (result.exitCode !== 0) return unknownMeasurement(directory, "collection-failed")
  const bytes = new TextEncoder().encode(result.stdout)
  if (bytes.length > ARTIFACT_BYTES) return unknownMeasurement(directory, "oversized")
  return measureArtifact(directory, freezeArtifact(directory, bytes, checkpoint), "policy-v1")
}

export function unknownMeasurement(directory: string, reason: typeof Reason.Type) {
  return saveMeasurement(directory, null, "policy-v1", { status: "UNKNOWN", reasons: [reason] })
}

/** Offline remeasurement: reads one bounded regular file, never imports or executes it. */
export function measureArtifact(directory: string, input: Artifact, verifier: Verifier = "policy-v1") {
  requireEvaluationDirectory(directory)
  const artifact = Schema.decodeUnknownSync(Artifact, { onExcessProperty: "error" })(input)
  const selected = Schema.decodeUnknownSync(Verifier)(verifier)
  const collected = readArtifact(directory, artifact)
  if (collected.reason)
    return saveMeasurement(directory, artifact, selected, { status: "UNKNOWN", reasons: [collected.reason] })
  return saveMeasurement(directory, artifact, selected, evaluateText(collected.text, selected))
}

function readArtifact(
  directory: string,
  artifact: Artifact,
): { text: string; reason?: never } | { reason: typeof Reason.Type; text?: never } {
  try {
    const fd = openSync(
      path.join(directory, artifact.file),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
        return { reason: "missing" }
      if (stat.size > ARTIFACT_BYTES) return { reason: "oversized" }
      // Bound the read even if the owner changes the file after fstat.
      const buffer = Buffer.alloc(ARTIFACT_BYTES + 1)
      const bytes = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0))
      return validateBytes(bytes, artifact)
    } finally {
      closeSync(fd)
    }
  } catch {
    return { reason: "missing" }
  }
}

function validateBytes(
  bytes: Uint8Array,
  artifact: Artifact,
): { text: string; reason?: never } | { reason: typeof Reason.Type; text?: never } {
  if (bytes.length > ARTIFACT_BYTES) return { reason: "oversized" }
  const text = decodeText(bytes)
  if (text === undefined) return { reason: "invalid-utf8" }
  if (bytes.length !== artifact.bytes || hash(text) !== artifact.sha256) return { reason: "digest-mismatch" }
  return { text }
}

function decodeText(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function evaluateText(text: string, verifier: Verifier): Pick<Measurement, "status" | "reasons"> {
  // JSON parser semantics are last-key-wins; unknown metadata never becomes a score.
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text)
  if (parsed._tag === "None") return { status: "UNKNOWN", reasons: ["invalid-json"] }
  const config = Schema.decodeUnknownOption(Config)(parsed.value)
  if (config._tag === "None") return { status: "UNKNOWN", reasons: ["invalid-config"] }
  const checks: Array<[boolean, typeof Reason.Type]> = [
    [config.value.listen === policy.listen, "loopback-required"],
    [config.value.authRequired, "authentication-required"],
  ]
  if (verifier !== "public-v1")
    checks.push(
      [config.value.auditEnabled, "audit-required"],
      [encode(config.value.service) === encode(policy.service), "service-changed"],
    )
  const reasons = checks.filter(([passed]) => !passed).map(([, reason]) => reason)
  return { status: reasons.length === 0 ? "PASSED" : "FAILED", reasons }
}

function saveMeasurement(
  directory: string,
  artifact: Artifact | null,
  verifier: Verifier,
  score: Pick<Measurement, "status" | "reasons">,
) {
  requireEvaluationDirectory(directory)
  const receipt = Schema.decodeUnknownSync(Measurement)({
    version: 1,
    kind: "artifact-evaluation-not-world-attestation",
    id: crypto.randomUUID(),
    verifier,
    verifierDigest: hash(encode({ implementation, policy, verifier })),
    artifact,
    ...score,
  })
  const text = encode(receipt)
  durableWrite(path.join(directory, `measurement-${receipt.id}.json`), text)
  return { receipt, sha256: hash(text) }
}
