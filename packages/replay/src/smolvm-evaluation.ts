import {
  constants,
  closeSync,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { AppProcess } from "@opencode/util/process"
import { MachineSmolVM } from "@opencode/core/environment/machine-smolvm"
import { MachineRuntime } from "@opencode/core/environment/machine"
import { durableWrite, encode, hash } from "./archive"
import { temporary } from "./scratch"
import {
  Artifact,
  Checkpoint,
  Measurement,
  Verifier,
  collectArtifact,
  createEvaluationDirectory,
  fixtures,
  measureArtifact,
  requireEvaluationDirectory,
  unknownMeasurement,
} from "./artifact-evaluator"

export const help = `Trusted synthetic SmolVM artifact evaluation (no Docker, models, or network).
Usage: bun run smolvm:evaluate [new-output-directory] --trust-local-code
       bun run smolvm:evaluate remeasure <directory> <measurement-file> [public-v1|policy-v1|policy-v2]
Uses an installed smolvm wrapper and its bundled Alpine rootfs; never pulls an image.
Only fixed trusted guest commands run. Host scoring parses data, not candidate code.
Exports are artifact evidence, NOT proof that a runtime applied the config.
--help prints this message without starting a VM.`

export function parseArguments(args: readonly string[]) {
  if (args.includes("--help")) return { mode: "help" } as const
  if (args[0] === "remeasure") {
    if (args.length < 3 || args.length > 4) throw new Error(help)
    return {
      mode: "remeasure",
      directory: args[1],
      file: args[2],
      verifier: Schema.decodeUnknownSync(Verifier)(args[3] ?? "policy-v2"),
    } as const
  }
  if (!args.includes("--trust-local-code")) throw new Error("Requires --trust-local-code; no VM was started")
  const positional = args.filter((arg) => arg !== "--trust-local-code")
  if (positional.length > 1 || positional.some((arg) => arg.startsWith("-"))) throw new Error(help)
  return {
    mode: "evaluate",
    directory: positional[0] ?? path.join(realpathSync(temporary()), "evaluation"),
  } as const
}

export function remeasure(directory: string, file: string, verifier: Verifier) {
  requireEvaluationDirectory(directory)
  if (!/^measurement-[a-f0-9-]{36}\.json$/.test(file)) throw new Error("Expected one measurement filename, not a path")
  const receipt = readMeasurement(path.join(directory, file))
  if (!receipt.artifact) throw new Error("This UNKNOWN collection has no artifact to remeasure")
  return measureArtifact(directory, receipt.artifact, verifier)
}

function readMeasurement(file: string) {
  // Opening nonblocking and refusing special files avoids waiting on a FIFO.
  // Read a fixed buffer even if the owner grows a file after fstat.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
      throw new Error("Measurement must be an owned mode-0600 regular file")
    if (stat.size > 65_536) throw new Error("Measurement exceeds byte limit")
    const buffer = Buffer.alloc(65_537)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size > 65_536) throw new Error("Measurement exceeds byte limit")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))
    return Schema.decodeUnknownSync(Schema.fromJsonString(Measurement))(text)
  } finally {
    closeSync(fd)
  }
}

/** Finite scripted VM-driver scenario, deliberately not OpenCode's native Session loop. */
export const evaluateSmolvm = (options: {
  directory: string
  trustLocalCode: boolean
  binary?: string
  rootfs?: string
}) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (!options.trustLocalCode) return yield* Effect.fail(new Error("Requires --trust-local-code"))
      const processes = yield* AppProcess.Service
      const directory = yield* Effect.try(() => createEvaluationDirectory(options.directory))
      const owned = yield* prepareSmolvmRun(directory, processes, options)
      const result = yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => owned.finalize)
        return yield* restore(scenario(owned.runtime, directory, owned.image))
      }).pipe(Effect.scoped, Effect.exit)
      if (Exit.isFailure(result))
        yield* Effect.sync(() =>
          durableWrite(path.join(directory, "diagnostic.txt"), Cause.pretty(result.cause).slice(0, 8192)),
        )
      const clean = smolvmClean(owned)
      const privateHome = clean ? null : owned.home
      const status = Exit.isSuccess(result) && clean ? "COMPLETE" : "UNKNOWN"
      if (status === "UNKNOWN") yield* Effect.sync(() => unknownMeasurement(directory, "collection-failed"))
      const report = {
        version: 1,
        profile: "trusted-smolvm-config-artifact-v1",
        status,
        image: owned.image,
        imageSource: "local-bundled-alpine-rootfs",
        binary: owned.binary,
        checkpointCoverage: "live branches and frozen file bytes only; no persisted VM/RAM checkpoint",
        evaluationCoverage: "artifact-evaluation-not-world-attestation",
        cleanup: owned.cleanup,
        nonOwned: owned.nonOwned,
        privateHome,
        results: Exit.isSuccess(result) ? result.value : null,
      }
      yield* Effect.sync(() => durableWrite(path.join(directory, "run.json"), encode(report)))
      // Keep private inventory/diagnostics when cleanup is uncertain; never hide a leaked resource.
      if (clean) yield* Effect.sync(() => rmSync(owned.home, { recursive: true }))
      return { directory, report, sha256: hash(encode(report)), privateHome }
    }),
  )

/** Shared only by the two fixed trusted SmolVM scenarios; no ambient inventory. */
export function prepareSmolvmRun(
  directory: string,
  processes: AppProcess.Interface,
  options: { binary?: string; rootfs?: string } = {},
) {
  return Effect.try(() => {
    const owned = prepareImage(directory, options.binary, options.rootfs)
    const intents = new Set<string>()
    const cleanup: Array<{ machine: string; status: "removed" | "UNKNOWN" }> = []
    const nonOwned: string[] = []
    const runtime = MachineSmolVM.make({
      processes,
      binary: owned.binary,
      dataDirectory: owned.home,
      namePrefix: "artifact",
      memoryMB: 256,
      diskGB: 1,
      onCreateIntent: (id) => {
        durableWrite(
          path.join(directory, `resource-${id}.started.json`),
          encode({ id, home: owned.home, state: "UNKNOWN until cleanup receipt" }),
        )
        intents.add(id)
      },
      onCreateConflict: (id) => {
        // Revoke before writing: even a receipt I/O failure must not delete a peer.
        intents.delete(id)
        nonOwned.push(id)
        durableWrite(
          path.join(directory, `resource-${id}.not-owned.json`),
          encode({ id, home: owned.home, status: "NOT_OWNED" }),
        )
      },
    })
    const finalize = Effect.suspend(() =>
      Effect.forEach(Array.from(intents).toReversed(), (id) =>
        runtime.destroy({ id }).pipe(
          Effect.match({
            onSuccess: () => {
              cleanup.push({ machine: id, status: "removed" })
            },
            onFailure: () => {
              cleanup.push({ machine: id, status: "UNKNOWN" })
            },
          }),
        ),
      ),
    )
    return { ...owned, runtime, finalize, cleanup, nonOwned }
  })
}

export function smolvmClean(owned: { nonOwned: readonly string[]; cleanup: ReadonlyArray<{ status: string }> }) {
  return (
    owned.nonOwned.length === 0 && owned.cleanup.length > 0 && owned.cleanup.every((item) => item.status === "removed")
  )
}

function prepareImage(directory: string, executable?: string, rootfs?: string) {
  const binary = realpathSync(executable ?? Bun.which("smolvm") ?? "/missing-smolvm")
  const source = realpathSync(rootfs ?? path.join(path.dirname(binary), "agent-rootfs"))
  const destination = path.join(directory, "image")
  cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true })
  const image = hash(encode(imageEntries(destination)))
  durableWrite(path.join(directory, "image.json"), encode({ version: 1, source, sha256: image }))
  // Darwin's Unix sockets require a short HOME. SMOLVM_DATA_DIR is Linux-only.
  const home = path.join(
    realpathSync("/tmp"),
    `oc-${Buffer.from(crypto.randomUUID().replaceAll("-", ""), "hex").toString("base64url")}`,
  )
  mkdirSync(home, { mode: 0o700 })
  return { binary, home, image }
}

function imageEntries(directory: string, prefix = ""): Array<{ path: string; mode: number; content: string }> {
  return readdirSync(path.join(directory, prefix))
    .sort()
    .flatMap((name) => {
      const relative = path.join(prefix, name)
      const file = path.join(directory, relative)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) return [{ path: relative, mode: stat.mode, content: `link:${readlinkSync(file)}` }]
      if (stat.isDirectory())
        return [{ path: relative, mode: stat.mode, content: "directory" }, ...imageEntries(directory, relative)]
      if (!stat.isFile()) throw new Error("Local rootfs contains an unsupported special file")
      return [{ path: relative, mode: stat.mode, content: Bun.CryptoHasher.hash("sha256", readFileSync(file), "hex") }]
    })
}

function scenario(runtime: MachineRuntime.Interface, directory: string, image: string) {
  return Effect.gen(function* () {
    const parent = yield* runtime.create({ image: path.join(directory, "image") })
    yield* writeConfig(runtime, parent.id, fixtures.baseline)
    const checkpoint = (machine: string, parentID: string | null): typeof Checkpoint.Type => ({
      id: crypto.randomUUID(),
      machine,
      parent: parentID,
      kind: "live-branch-file-export",
      image,
    })
    const baseline = yield* exportConfig(runtime, directory, checkpoint(parent.id, null))
    const general = yield* runtime.fork({ parent: parent.id })
    const overfit = yield* runtime.fork({ parent: parent.id })
    yield* writeConfig(runtime, general.id, fixtures.general)
    yield* writeConfig(runtime, overfit.id, fixtures.overfit)
    const repaired = yield* exportConfig(runtime, directory, checkpoint(general.id, parent.id))
    const negative = yield* exportConfig(runtime, directory, checkpoint(overfit.id, parent.id))
    const unchanged = yield* exportConfig(runtime, directory, checkpoint(parent.id, null))
    const artifact = Schema.decodeUnknownSync(Artifact)(negative.receipt.artifact)
    const publicResult = measureArtifact(directory, artifact, "public-v1")
    const parentUnchanged =
      baseline.receipt.artifact !== null && baseline.receipt.artifact.sha256 === unchanged.receipt.artifact?.sha256
    if (!parentUnchanged) return yield* Effect.fail(new Error("Parent artifact changed"))
    if ([baseline, repaired, negative, unchanged].some((value) => value.receipt.status === "UNKNOWN"))
      return yield* Effect.fail(new Error("Artifact collection or evaluation incomplete"))
    return {
      baseline,
      general: repaired,
      overfit: negative,
      overfitPublic: publicResult,
      parentAfter: unchanged,
      parentUnchanged,
    }
  })
}

function writeConfig(
  runtime: MachineRuntime.Interface,
  id: string,
  config: typeof fixtures.baseline | typeof fixtures.general | typeof fixtures.overfit,
) {
  // Fixed trusted argv: JSON is a positional printf argument, never shell source.
  return runtime
    .exec({
      id,
      command: ["/bin/sh", "-c", "printf '%s' \"$1\" > /workspace/service.json", "fixture", encode(config)],
      timeoutMs: 5000,
    })
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(new MachineRuntime.Error({ message: "Fixture write failed" })),
      ),
    )
}

function exportConfig(runtime: MachineRuntime.Interface, directory: string, checkpoint: typeof Checkpoint.Type) {
  return runtime
    .exec({ id: checkpoint.machine, command: ["/bin/cat", "/workspace/service.json"], timeoutMs: 5000 })
    .pipe(
      Effect.match({
        onSuccess: (result) => collectArtifact(directory, result, checkpoint),
        onFailure: () => collectArtifact(directory, undefined, checkpoint),
      }),
    )
}
