import { readFileSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Hash, durableWrite, encode, hash } from "./archive"
import { RepoCapsule, repoFiles, repoTask, validateRepo } from "./repo-archive"
import { HIDDEN, RepoFiles, Task } from "./repo-task"
import { restoreFiles } from "./repo-world"
import { temporary } from "./scratch"
import { VerifierReport, readVerifierReport, validateVerifierReport } from "./repo-junit"
import {
  Isolation,
  IsolationMode,
  hostIsolation,
  isolationSummary,
  runDockerVerifier,
  type VerifierOptions,
} from "./verifier-isolation"
import { runProcess } from "./verifier-process"

const implementation = hash(readFileSync(import.meta.filename, "utf8"))
export const RepoMeasurement = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  episode: Hash,
  verifier: Schema.String,
  scope: Schema.Literals(["public", "heldout"]),
  implementation: Hash,
  testSource: Hash,
  artifact: Hash,
  status: Schema.Literals([
    "passed",
    "test-failed",
    "timeout",
    "output-truncated",
    "verifier-incomplete",
    "resource-exhausted",
  ]),
  report: VerifierReport,
  passed: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Int,
  timedOut: Schema.Boolean,
  truncated: Schema.Boolean,
  elapsedMs: Schema.Finite,
  execPath: Schema.String,
  bun: Schema.String,
  containment: Schema.String,
  isolation: Schema.optional(Isolation),
})
export type RepoMeasurement = typeof RepoMeasurement.Type
export type VerifierResult = Awaited<ReturnType<typeof verifyFiles>>
export function requireTrust(trustLocalCode: boolean) {
  if (trustLocalCode !== true)
    throw new Error("Requires --trust-local-code: trusted code only; isolation does not make the verifier tamper-proof")
}

/** Trusted host by default; requested Docker isolation fails closed without fallback. */
export async function verifyFiles(
  task: Task,
  files: typeof RepoFiles.Type,
  verifier: "public" | "heldout",
  trustLocalCode: boolean,
  options: VerifierOptions = {},
) {
  requireTrust(trustLocalCode)
  const mode = Schema.decodeUnknownSync(IsolationMode)(options.isolation ?? "trusted-host")
  const root = temporary()
  const started = performance.now()
  try {
    const prepared = prepareVerifier(root, task, files, verifier)
    const execution =
      mode === "docker-required"
        ? await runDockerVerifier({
            root,
            target: prepared.target,
            timeoutMs: task.budgets.timeoutMs,
            outputBytes: task.budgets.outputBytes,
            signal: options.signal,
          })
        : await runHostVerifier(prepared, task, options.signal)
    const status = verifierStatus(
      execution.timedOut,
      execution.truncated,
      execution.exitCode,
      execution.report,
      exhausted(execution.isolation),
    )
    return {
      scope: verifier,
      verifier: verifier === "public" ? "public-smoke-v1" : task.verifier.id,
      implementation,
      testSource: hash(prepared.source),
      artifact: hash(encode(files)),
      status,
      report: execution.report,
      passed: status === "passed",
      stdout: execution.stdout.text,
      stderr: execution.stderr.text,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      truncated: execution.truncated,
      elapsedMs: performance.now() - started,
      execPath: execution.execPath,
      bun: execution.bun,
      containment: isolationSummary(execution.isolation),
      isolation: execution.isolation,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function runHostVerifier(prepared: ReturnType<typeof prepareVerifier>, task: Task, signal?: AbortSignal) {
  const result = await runProcess(
    [
      process.execPath,
      "--no-install",
      "--no-env-file",
      "--no-orphans",
      `--config=${prepared.config}`,
      "test",
      "--reporter=junit",
      `--reporter-outfile=${prepared.report}`,
      `./${prepared.target}`,
    ],
    { HOME: prepared.home, TMPDIR: prepared.tmp, LANG: "C.UTF-8", TZ: "UTC" },
    task.budgets.timeoutMs,
    task.budgets.outputBytes,
    { cwd: prepared.directory, signal },
  )
  return {
    ...result,
    report: readVerifierReport(prepared.report),
    isolation: hostIsolation(),
    execPath: process.execPath,
    bun: Bun.version,
  }
}

function prepareVerifier(root: string, task: Task, files: typeof RepoFiles.Type, verifier: "public" | "heldout") {
  const directory = path.join(root, "repository")
  restoreFiles(directory, files)
  const target = verifier === "public" ? "smoke.test.ts" : HIDDEN
  const source = verifier === "public" ? files[target] : task.verifier.testSource
  if (source === undefined) throw new Error("Missing verifier source")
  if (verifier === "heldout") durableWrite(path.join(directory, target), source)
  const home = path.join(root, "home")
  const tmp = path.join(root, "tmp")
  mkdirSync(home)
  mkdirSync(tmp)
  const config = path.join(root, "bunfig.toml")
  durableWrite(config, "# Fixed trusted verifier config: no preload or install\n")
  return { directory, target, source, home, tmp, config, report: path.join(root, "junit.xml") }
}

export function verifierStatus(
  timeout: boolean,
  truncated: boolean,
  exitCode: number,
  report: VerifierReport,
  resourceExhausted = false,
) {
  validateVerifierReport(report)
  if (timeout) return "timeout" as const
  if (resourceExhausted) return "resource-exhausted" as const
  if (truncated) return "output-truncated" as const
  if (exitCode !== 0) return "test-failed" as const
  return completedStatus(report)
}

export function validateMeasurement(result: RepoMeasurement) {
  if (result.passed !== (result.status === "passed")) throw new Error("Measurement status mismatch")
  if (
    result.status !==
    verifierStatus(result.timedOut, result.truncated, result.exitCode, result.report, exhausted(result.isolation))
  )
    throw new Error("Measurement exit/limit status mismatch")
  validateIsolation(result.isolation)
}

function validateIsolation(isolation?: Isolation) {
  if (!isolation) return // Published legacy receipts explicitly retain unsupported trusted-host semantics.
  if (isolation.policyDigest !== (isolation.policy === null ? null : hash(encode(isolation.policy))))
    throw new Error("Isolation policy provenance digest mismatch")
  if (isolation.mode === "trusted-host") {
    if (isolation.policy !== null || isolation.guest !== null)
      throw new Error("Host receipt claims enforced Docker policy")
    return
  }
  requireDockerProvenance(isolation)
}

function requireDockerProvenance(isolation: Isolation) {
  if (isolation.policy === null || isolation.guest === null || !isolation.container || !isolation.image)
    throw new Error("Docker receipt requires inspected policy and guest provenance")
}

function exhausted(isolation?: Isolation) {
  return isolation?.oomKilled || isolation?.pidLimitHit || false
}

function completedStatus(report: VerifierReport) {
  if (!report.counts) return "verifier-incomplete" as const
  if (report.counts.failures) return "test-failed" as const
  if (report.counts.tests <= report.counts.skipped || report.counts.assertions === 0)
    return "verifier-incomplete" as const
  return "passed" as const
}

export async function measureRepo(
  capsule: RepoCapsule,
  verifier: "public" | "heldout",
  directory: string,
  trustLocalCode: boolean,
  options: VerifierOptions = {},
) {
  requireTrust(trustLocalCode)
  validateRepo(capsule)
  const id = crypto.randomUUID()
  const task = repoTask(capsule)
  durableWrite(
    path.join(directory, `measurement-${id}.started.json`),
    encode({
      version: 1,
      id,
      episode: capsule.digest,
      verifier,
      implementation,
      artifact: capsule.manifest.checkpoint,
      state: "started; missing receipt means UNKNOWN; do not repeat",
      testSource: hash(verifier === "public" ? task.files["smoke.test.ts"] : task.verifier.testSource),
      isolation: Schema.decodeUnknownSync(IsolationMode)(options.isolation ?? "trusted-host"),
    }),
  )
  const result = Schema.decodeUnknownSync(RepoMeasurement)({
    version: 1,
    id,
    episode: capsule.digest,
    ...(await verifyFiles(task, repoFiles(capsule, "checkpoint"), verifier, trustLocalCode, options)),
  })
  durableWrite(path.join(directory, `measurement-${result.id}.json`), encode(result))
  return result
}
