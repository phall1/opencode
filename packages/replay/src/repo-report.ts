import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { durableWrite, encode, hash } from "./archive"
import { RepoCapsule, RepoManifest, openRepo, repoTask, validateRepo } from "./repo-archive"
import { RepoMeasurement, validateMeasurement } from "./repo-measure"
import { readJournalFile, requireJournalComplete } from "./journal"

export function compareRepo(
  checkpoint: RepoCapsule,
  baseline: RepoMeasurement,
  entries: readonly { capsule: RepoCapsule; public: RepoMeasurement; heldout: RepoMeasurement }[],
  directory: string,
) {
  return writeComparison(
    checkpoint,
    [baseline],
    entries.map((entry) => ({ capsule: entry.capsule, measurements: [entry.public, entry.heldout] })),
    directory,
  )
}

function checkedMeasurement(capsule: RepoCapsule, input: RepoMeasurement, directory: string) {
  const result = Schema.decodeUnknownSync(RepoMeasurement, { onExcessProperty: "error" })(input)
  if (result.episode !== capsule.digest || result.artifact !== capsule.manifest.checkpoint)
    throw new Error("Measurement artifact/capsule mismatch")
  validateMeasurement(result)
  requireMeasurementSource(capsule, result)
  const file = `measurement-${result.id}.json`
  if (!/^measurement-[a-f0-9-]+\.json$/.test(file)) throw new Error("Invalid measurement receipt filename")
  const saved = readJournalFile(path.join(directory, file))
  if (encode(saved.value) !== encode(result)) throw new Error("Measurement differs from saved receipt")
  return { ...result, file, digest: saved.digest }
}

function requireMeasurementSource(capsule: RepoCapsule, measurement: RepoMeasurement) {
  const task = repoTask(capsule)
  const source = measurement.scope === "public" ? task.files["smoke.test.ts"] : task.verifier.testSource
  const id = measurement.scope === "public" ? "public-smoke-v1" : task.verifier.id
  if (measurement.testSource !== hash(source) || measurement.verifier !== id)
    throw new Error("Measurement verifier/source mismatch")
}

function writeComparison(
  checkpoint: RepoCapsule,
  baseline: readonly RepoMeasurement[],
  entries: readonly { capsule: RepoCapsule; measurements: readonly RepoMeasurement[] }[],
  directory: string,
) {
  requireJournalComplete(directory)
  validateRepo(checkpoint)
  if (checkpoint.manifest.policy !== "assessment" || !baseline.length)
    throw new Error("Comparison requires complete before-repair baseline")
  requireVerifiers(checkpoint, baseline, false)
  const id = crypto.randomUUID()
  const report = {
    version: 1,
    id,
    profile: "scripted-repo-v1",
    taskID: repoTask(checkpoint).id,
    checkpoint: {
      file: "checkpoint.json",
      digest: checkpoint.digest,
      files: checkpoint.manifest.checkpoint,
      context: checkpoint.manifest.context,
      native: checkpoint.manifest.evidence,
      boundary: "quiescent assessment idle, before edits",
    },
    baseline: baseline.map((measurement) => checkedMeasurement(checkpoint, measurement, directory)),
    continuations: entries.map((entry) => {
      validateRepo(entry.capsule)
      const parent = entry.capsule.manifest.parent
      if (!parent || hash(encode(checkpoint)) !== parent || !entry.measurements.length)
        throw new Error("Comparison requires complete checkpoint child evidence")
      requireVerifiers(entry.capsule, entry.measurements, true)
      return {
        policy: entry.capsule.manifest.policy,
        file: `${entry.capsule.manifest.policy}.json`,
        digest: entry.capsule.digest,
        native: entry.capsule.manifest.evidence,
        measurements: entry.measurements.map((measurement) =>
          checkedMeasurement(entry.capsule, measurement, directory),
        ),
      }
    }),
    realCost: "UNKNOWN/not measured (scripted)",
    interpretation:
      "Baseline test failures are pre-existing task failures. Heldout failures are task failures, NOT native execution failures. Timeout/output truncation/verifier-incomplete are indeterminate verification, NOT passes. Native execution failures/incomplete receipts cannot produce comparison capsules.",
    coverage:
      "Scripted provider responses; native runner/read/write/permissions/fork/move. No model-ability, RL, live model, arbitrary historical checkpoint or OS containment claim.",
  }
  const file = path.join(directory, `comparison-${id}.json`)
  const markdown = path.join(directory, `comparison-${id}.md`)
  durableWrite(file, encode(report))
  durableWrite(markdown, render(report))
  return { file, markdown, digest: hash(encode(report)) }
}

function requireVerifiers(capsule: RepoCapsule, measurements: readonly RepoMeasurement[], publicRequired: boolean) {
  if (
    !measurements.some(
      (measurement) => measurement.scope === "heldout" && measurement.verifier === repoTask(capsule).verifier.id,
    )
  )
    throw new Error("Incomplete heldout verification evidence")
  if (publicRequired && !measurements.some((measurement) => measurement.scope === "public"))
    throw new Error("Incomplete public verification evidence")
}

function render(report: {
  taskID: string
  checkpoint: { digest: string; native: typeof RepoManifest.Type.evidence }
  baseline: readonly { status: string; verifier: string; file: string }[]
  continuations: readonly {
    policy: string
    file: string
    digest: string
    native: typeof RepoManifest.Type.evidence
    measurements: readonly { verifier: string; status: string; file: string }[]
  }[]
  interpretation: string
  coverage: string
}) {
  return [
    `# Scripted repository comparison: ${report.taskID}`,
    `\nCheckpoint: [checkpoint.json](checkpoint.json), SHA-256 \`${report.checkpoint.digest}\`. Quiescent assessment idle, before edits.`,
    `\nAssessment: ${report.checkpoint.native.requests} requests / ${report.checkpoint.native.tools} native tools; ${report.checkpoint.native.elapsedMs.toFixed(1)} ms (${report.checkpoint.native.elapsedScope}).`,
    `\nBaseline (pre-existing): ${report.baseline.map((measurement) => `[${measurement.verifier}: ${measurement.status}](${measurement.file})`).join(", ")}.`,
    "\n| Scripted policy | Native execution | New suffix requests / tools | Elapsed ms (scope) | Verification |",
    "| --- | --- | --- | --- | --- |",
    ...report.continuations.map(
      (entry) =>
        `| [${entry.policy}](${entry.file}) | ${entry.native.outcome} | ${entry.native.requests} / ${entry.native.tools} | ${entry.native.elapsedMs.toFixed(1)} (${entry.native.elapsedScope}) | ${entry.measurements.map((measurement) => `[${measurement.verifier}: ${measurement.status}](${measurement.file})`).join("; ")} |`,
    ),
    ...report.continuations.map(
      (entry) =>
        `\n${entry.policy} capsule SHA-256: \`${entry.digest}\`. Native suffix usage (scripted fixture only): \`${encode(entry.native.nativeUsage)}\`.`,
    ),
    "\nReal model cost: **UNKNOWN / not measured**. Scripted responses are not a model-ability benchmark.",
    `\n${report.interpretation}`,
    `\n${report.coverage}`,
    "\nOS/network/process-tree isolation is unsupported; custom code requires explicit trust.\n",
  ].join("\n")
}

export function compareDirectory(directory: string) {
  const checkpoint = openRepo(path.join(directory, "checkpoint.json"))
  const children = ["general", "overfit"].map((policy) => openRepo(path.join(directory, `${policy}.json`)))
  const measurements = readdirSync(directory)
    .filter((file) => /^measurement-[a-f0-9-]+\.json$/.test(file))
    .map((file) =>
      Schema.decodeUnknownSync(Schema.fromJsonString(RepoMeasurement))(
        readFileSync(path.join(directory, file), "utf8"),
      ),
    )
  return writeComparison(
    checkpoint,
    measurements.filter((measurement) => measurement.episode === checkpoint.digest),
    children.map((capsule) => ({
      capsule,
      measurements: measurements.filter((measurement) => measurement.episode === capsule.digest),
    })),
    directory,
  )
}
