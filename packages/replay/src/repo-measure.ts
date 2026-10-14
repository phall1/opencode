import { readFileSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Hash, durableWrite, encode, hash } from "./archive"
import { RepoCapsule, repoFiles, repoTask, validateRepo } from "./repo-archive"
import { HIDDEN, RepoFiles, Task } from "./repo-task"
import { restoreFiles } from "./repo-world"
import { temporary } from "./scratch"
import { VerifierReport, readVerifierReport, validateVerifierReport } from "./repo-junit"

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
  status: Schema.Literals(["passed", "test-failed", "timeout", "output-truncated", "verifier-incomplete"]),
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
})
export type RepoMeasurement = typeof RepoMeasurement.Type
export type VerifierResult = Awaited<ReturnType<typeof verifyFiles>>
export function requireTrust(trustLocalCode: boolean) {
  if (trustLocalCode !== true)
    throw new Error("Requires --trust-local-code: trusted code only; NO OS/network/descendant containment")
}

/** Fixed argv, fresh restored world, bounded capture. This is NOT an OS sandbox. */
export async function verifyFiles(
  task: Task,
  files: typeof RepoFiles.Type,
  verifier: "public" | "heldout",
  trustLocalCode: boolean,
) {
  requireTrust(trustLocalCode)
  const root = temporary()
  const started = performance.now()
  try {
    const prepared = prepareVerifier(root, task, files, verifier)
    const child = Bun.spawn(
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
      {
        cwd: prepared.directory,
        env: { HOME: prepared.home, TMPDIR: prepared.tmp, LANG: "C.UTF-8", TZ: "UTC" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    let timedOut = false
    const abort = new AbortController()
    const timer = setTimeout(() => {
      timedOut = true
      child.kill(9)
      abort.abort()
    }, task.budgets.timeoutMs)
    const [stdout, stderr, exitCode] = await Promise.all([
      capture(child.stdout, task.budgets.outputBytes, abort.signal),
      capture(child.stderr, task.budgets.outputBytes, abort.signal),
      child.exited,
    ]).finally(() => clearTimeout(timer))
    const report = readVerifierReport(prepared.report)
    const status = verifierStatus(timedOut, stdout.truncated || stderr.truncated, exitCode, report)
    return {
      scope: verifier,
      verifier: verifier === "public" ? "public-smoke-v1" : task.verifier.id,
      implementation,
      testSource: hash(prepared.source),
      artifact: hash(encode(files)),
      status,
      report,
      passed: status === "passed",
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
      elapsedMs: performance.now() - started,
      execPath: process.execPath,
      bun: Bun.version,
      containment: "UNSUPPORTED: trusted code can access host/network and create descendants",
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
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

export function verifierStatus(timeout: boolean, truncated: boolean, exitCode: number, report: VerifierReport) {
  validateVerifierReport(report)
  if (timeout) return "timeout" as const
  if (truncated) return "output-truncated" as const
  if (exitCode !== 0) return "test-failed" as const
  return completedStatus(report)
}

export function validateMeasurement(result: RepoMeasurement) {
  if (result.passed !== (result.status === "passed")) throw new Error("Measurement status mismatch")
  if (result.status !== verifierStatus(result.timedOut, result.truncated, result.exitCode, result.report))
    throw new Error("Measurement exit/limit status mismatch")
}

function completedStatus(report: VerifierReport) {
  if (!report.counts) return "verifier-incomplete" as const
  if (report.counts.failures) return "test-failed" as const
  if (report.counts.tests <= report.counts.skipped || report.counts.assertions === 0)
    return "verifier-incomplete" as const
  return "passed" as const
}

async function capture(stream: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal) {
  const reader = stream.getReader()
  // End collection even if trusted fixture descendants keep a pipe open. Not containment.
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const remaining = Math.max(0, limit - total)
      if (remaining > 0) chunks.push(next.value.subarray(0, remaining))
      total += next.value.length
    }
  } finally {
    signal.removeEventListener("abort", cancel)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return {
    text: new TextDecoder().decode(Buffer.from(text).subarray(0, limit), { stream: true }),
    truncated: total > limit || Buffer.byteLength(text) > limit,
  }
}

export async function measureRepo(
  capsule: RepoCapsule,
  verifier: "public" | "heldout",
  directory: string,
  trustLocalCode: boolean,
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
    }),
  )
  const result = Schema.decodeUnknownSync(RepoMeasurement)({
    version: 1,
    id,
    episode: capsule.digest,
    ...(await verifyFiles(task, repoFiles(capsule, "checkpoint"), verifier, trustLocalCode)),
  })
  durableWrite(path.join(directory, `measurement-${result.id}.json`), encode(result))
  return result
}
