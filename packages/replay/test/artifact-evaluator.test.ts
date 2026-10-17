import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import {
  ARTIFACT_BYTES,
  collectArtifact,
  createEvaluationDirectory,
  fixtures,
  freezeArtifact,
  measureArtifact,
} from "../src/artifact-evaluator"
import { durableWrite, encode, hash } from "../src/archive"
import { temporary } from "../src/scratch"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function setup() {
  const root = realpathSync(temporary())
  roots.push(root)
  const directory = createEvaluationDirectory(path.join(root, "evaluation"))
  const checkpoint = {
    id: crypto.randomUUID(),
    machine: "synthetic-parent",
    parent: null,
    kind: "live-branch-file-export",
    image: hash("synthetic-image"),
  } as const
  const freeze = (text: string) => freezeArtifact(directory, new TextEncoder().encode(text), checkpoint)
  return { root, directory, checkpoint, freeze }
}

test("independent oracle: baseline bad, general all-pass, overfit public-pass/full-policy-fail", () => {
  const fixture = setup()
  const baseline = fixture.freeze(encode({ ...fixtures.baseline, status: "PASSED", reasons: [] }))
  expect(measureArtifact(fixture.directory, baseline).receipt.status).toBe("FAILED")
  const general = fixture.freeze(encode(fixtures.general))
  expect(measureArtifact(fixture.directory, general).receipt.status).toBe("PASSED")
  const overfit = fixture.freeze(encode(fixtures.overfit))
  expect(measureArtifact(fixture.directory, overfit, "public-v1").receipt.status).toBe("PASSED")
  expect(measureArtifact(fixture.directory, overfit).receipt.reasons).toEqual(["audit-required", "service-changed"])
})

test("malformed JSON/schema is UNKNOWN, data and candidate labels are never executed", () => {
  const fixture = setup()
  for (const text of [
    "",
    "{",
    "null",
    '{"listen":5}',
    `Bun.write(${JSON.stringify(path.join(fixture.root, "pwned"))}, "oops")`,
  ])
    expect(measureArtifact(fixture.directory, fixture.freeze(text)).receipt.status).toBe("UNKNOWN")
  const harmless = fixture.freeze(
    encode({ ...fixtures.general, code: "throw new Error('executed')", status: "FAILED" }),
  )
  expect(measureArtifact(fixture.directory, harmless).receipt.status).toBe("PASSED")
  expect(existsSync(path.join(fixture.root, "pwned"))).toBe(false)
  // JSON uses documented last-key-wins semantics, not a new parser dialect.
  const duplicate = fixture.freeze(
    encode(fixtures.general).replace('"authRequired":true', '"authRequired":false,"authRequired":true'),
  )
  expect(measureArtifact(fixture.directory, duplicate).receipt.status).toBe("PASSED")
})

test("bounded collection fails closed without inventing task failures", () => {
  const fixture = setup()
  for (const result of [
    undefined,
    { stdout: "{}", exitCode: 1 },
    { stdout: "{}", exitCode: 0, truncated: true },
    { stdout: "a".repeat(ARTIFACT_BYTES + 1), exitCode: 0 },
  ]) {
    const measured = collectArtifact(fixture.directory, result, fixture.checkpoint)
    expect(measured.receipt.status).toBe("UNKNOWN")
    expect(measured.receipt.artifact).toBeNull()
  }
  expect(readdirSync(fixture.directory).filter((name) => name.startsWith("artifact-"))).toHaveLength(0)
  expect(() => freezeArtifact(fixture.directory, new Uint8Array([0xff]), fixture.checkpoint)).toThrow()
  expect(() => fixture.freeze("a".repeat(ARTIFACT_BYTES + 1))).toThrow()
})

test("offline remeasurement detects mutation, missing, oversized and invalid UTF-8 bytes", () => {
  const fixture = setup()
  const artifact = fixture.freeze(encode(fixtures.general))
  const file = path.join(fixture.directory, artifact.file)
  writeFileSync(file, encode(fixtures.baseline))
  expect(measureArtifact(fixture.directory, artifact).receipt.reasons).toEqual(["digest-mismatch"])
  writeFileSync(file, new Uint8Array([0xff]))
  expect(measureArtifact(fixture.directory, artifact).receipt.reasons).toEqual(["invalid-utf8"])
  writeFileSync(file, "a".repeat(ARTIFACT_BYTES + 1))
  expect(measureArtifact(fixture.directory, artifact).receipt.reasons).toEqual(["oversized"])
  unlinkSync(file)
  expect(measureArtifact(fixture.directory, artifact).receipt.reasons).toEqual(["missing"])
})

test("UTF-8 BOM and multibyte artifact bytes are frozen exactly, not normalized", () => {
  const fixture = setup()
  const text = `\uFEFF${encode({ ...fixtures.general, metadata: "λ🔒" })}`
  const artifact = fixture.freeze(text)
  expect(readFileSync(path.join(fixture.directory, artifact.file))).toEqual(Buffer.from(text))
  expect(artifact.sha256).toBe(hash(text))
  expect(artifact.bytes).toBe(Buffer.byteLength(text))
  expect(measureArtifact(fixture.directory, artifact).receipt.reasons).not.toContain("digest-mismatch")
})

test("exclusive 0600 artifacts and receipts survive remeasurement and verifier upgrades unchanged", () => {
  const fixture = setup()
  const artifact = fixture.freeze(encode(fixtures.general))
  const first = measureArtifact(fixture.directory, artifact)
  const before = Object.fromEntries(
    readdirSync(fixture.directory).map((file) => [file, readFileSync(path.join(fixture.directory, file), "utf8")]),
  )
  const second = measureArtifact(fixture.directory, artifact)
  const upgraded = measureArtifact(fixture.directory, artifact, "policy-v2")
  expect(first.receipt.id).not.toBe(second.receipt.id)
  expect(first.receipt.verifierDigest).not.toBe(upgraded.receipt.verifierDigest)
  expect(first.sha256).toBe(hash(encode(first.receipt)))
  for (const [file, bytes] of Object.entries(before)) {
    expect(readFileSync(path.join(fixture.directory, file), "utf8")).toBe(bytes)
    expect(lstatSync(path.join(fixture.directory, file)).mode & 0o777).toBe(0o600)
    expect(() => durableWrite(path.join(fixture.directory, file), "overwrite")).toThrow()
  }
  expect(() => createEvaluationDirectory(fixture.directory)).toThrow()
})

test("path traversal, symlinked files/parents and non-private output directories are rejected", () => {
  const fixture = setup()
  const artifact = fixture.freeze(encode(fixtures.general))
  expect(() => measureArtifact(fixture.directory, { ...artifact, file: "../escape.json" })).toThrow()
  const alias = path.join(fixture.root, "alias")
  symlinkSync(fixture.directory, alias)
  expect(() => createEvaluationDirectory(path.join(alias, "child"))).toThrow()
  const file = path.join(fixture.directory, artifact.file)
  unlinkSync(file)
  symlinkSync(path.join(fixture.root, "external"), file)
  expect(measureArtifact(fixture.directory, artifact).receipt.status).toBe("UNKNOWN")
  const publicDirectory = path.join(fixture.root, "public")
  mkdirSync(publicDirectory)
  chmodSync(publicDirectory, 0o755)
  expect(() => freezeArtifact(publicDirectory, new Uint8Array(), fixture.checkpoint)).toThrow()
})
