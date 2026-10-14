import { Schema } from "effect"
import path from "node:path"
import { readFileSync } from "node:fs"
import { Capsule, Hash, blob, decodeFiles, durableWrite, encode, hash, validate } from "./archive"

const implementation = hash(readFileSync(import.meta.filename, "utf8"))

export const Measurement = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  episode: Hash,
  verifier: Schema.Literals(["repair-exact-v1", "repair-no-typo-v1", "child-one-v1"]),
  implementation: Hash,
  evidence: Hash,
  passed: Schema.Boolean,
})

/** No runner, provider, tool or workspace restoration: only frozen evidence. */
export function measure(capsule: Capsule, verifier: string, directory: string) {
  validate(capsule)
  const files = decodeFiles(capsule, "checkpoint")
  const text = files["/fixture/repair.txt"]
  if (text === undefined) throw new Error("Missing verifier evidence: /fixture/repair.txt")
  const checks = new Map<string, (text: string) => boolean>([
    ["repair-exact-v1", (value) => value === "the small fixture\n"],
    ["repair-no-typo-v1", (value) => !value.includes("teh") && value.includes("the")],
    ["child-one-v1", (value) => value === "child one only\n"],
  ])
  const check = checks.get(verifier)
  if (!check) throw new Error(`Unknown verifier: ${verifier}`)
  const result = Schema.decodeUnknownSync(Measurement)({
    version: 1,
    id: crypto.randomUUID(),
    episode: capsule.digest,
    verifier,
    implementation,
    evidence: hash(blob(capsule, capsule.manifest.checkpoint)),
    passed: check(text),
  })
  durableWrite(path.join(directory, `measurement-${result.id}.json`), encode(result))
  return result
}
