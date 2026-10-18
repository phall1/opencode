import { Cause, Effect, Exit, Logger, Schema } from "effect"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { MachineRuntime } from "@opencode/core/environment/machine"
import path from "node:path"
import { realpathSync, rmSync } from "node:fs"
import { prepareSmolvmRun, smolvmClean } from "../src/smolvm-evaluation"
import { createEvaluationDirectory } from "../src/artifact-evaluator"
import { durableWrite, encode, hash } from "../src/archive"
import { temporary } from "../src/scratch"

const Iterations = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))
export const probeHelp = `Fixed trusted SmolVM echo/branch timing probe; no Docker, models, image pulls, or network.
Usage: bun run smolvm:probe [iterations:1-16] [new-output-directory]
Uses the installed wrapper's local bundled Alpine rootfs and a private machine inventory.
--help prints this message without starting a VM.`

export function parseProbeArguments(args: readonly string[]) {
  if (args.includes("--help")) return { mode: "help" } as const
  if (args.length > 2) throw new Error(probeHelp)
  const iterations = args[0] ?? "3"
  if (!/^(?:[1-9]|1[0-6])$/.test(iterations)) throw new Error(probeHelp)
  return {
    mode: "probe",
    iterations: Number(iterations),
    directory: args[1] ?? path.join(realpathSync(temporary()), "probe"),
  } as const
}

export const probeSmolvm = (options: { iterations: number; directory: string; binary?: string; rootfs?: string }) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const iterations = yield* Effect.try(() => Schema.decodeUnknownSync(Iterations)(options.iterations))
      const processes = yield* AppProcess.Service
      const directory = yield* Effect.try(() => createEvaluationDirectory(options.directory))
      const owned = yield* prepareSmolvmRun(directory, processes, options)
      const result = yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => owned.finalize)
        return yield* restore(probeSamples(owned.runtime, path.join(directory, "image"), iterations))
      }).pipe(Effect.scoped, Effect.exit)
      if (Exit.isFailure(result))
        yield* Effect.sync(() =>
          durableWrite(path.join(directory, "diagnostic.txt"), Cause.pretty(result.cause).slice(0, 8192)),
        )
      const clean = smolvmClean(owned)
      const privateHome = clean ? null : owned.home
      const samples = Exit.isSuccess(result) ? result.value.samples : []
      const report = {
        version: 1,
        profile: "trusted-smolvm-probe-v1",
        status: Exit.isSuccess(result) && clean ? "COMPLETE" : "UNKNOWN",
        host: { date: new Date().toISOString(), runtime: "smolvm" },
        outputDirectory: directory,
        image: owned.image,
        binary: owned.binary,
        parentReadyMs: Exit.isSuccess(result) ? result.value.parentReadyMs : null,
        samples,
        branchAverageMs: average(samples.map((sample) => sample.branchMs)),
        execAverageMs: average(samples.map((sample) => sample.execMs)),
        exitCodes: samples.map((sample) => sample.exitCode),
        cleanup: owned.cleanup,
        nonOwned: owned.nonOwned,
        privateHome,
      }
      yield* Effect.sync(() => durableWrite(path.join(directory, "run.json"), encode(report)))
      if (clean) yield* Effect.sync(() => rmSync(owned.home, { recursive: true }))
      return { directory, report, sha256: hash(encode(report)), privateHome }
    }),
  )

function probeSamples(runtime: MachineRuntime.Interface, image: string, iterations: number) {
  return Effect.gen(function* () {
    const parentStart = Date.now()
    const parent = yield* runtime.create({ image })
    const parentReadyMs = Date.now() - parentStart
    const samples: Array<{
      iteration: number
      child: string
      branchMs: number
      execMs: number
      exitCode: number
      stdout: string
    }> = []
    for (let index = 0; index < iterations; index++) {
      const branchStart = Date.now()
      const child = yield* runtime.fork({ parent: parent.id })
      const branchMs = Date.now() - branchStart
      const execStart = Date.now()
      const result = yield* runtime.exec({
        id: child.id,
        command: ["/bin/sh", "-c", "echo probe-ok; uname -m"],
        timeoutMs: 5000,
      })
      samples.push({
        iteration: index + 1,
        child: child.id,
        branchMs,
        execMs: Date.now() - execStart,
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
      })
    }
    return { parentReadyMs, samples }
  })
}

function average(samples: readonly number[]) {
  return samples.length === 0 ? null : Math.round(samples.reduce((sum, sample) => sum + sample, 0) / samples.length)
}

if (import.meta.main) {
  const options = parseProbeArguments(process.argv.slice(2))
  if (options.mode === "help") console.log(probeHelp)
  if (options.mode === "probe") {
    const result = await Effect.runPromise(
      probeSmolvm(options).pipe(
        Effect.provide(LayerNode.compile(AppProcess.node)),
        Effect.provideService(Logger.LogToStderr, true),
      ),
    )
    // Preserve the legacy top-level timing fields for CLI consumers.
    console.log(JSON.stringify(result.report, null, 2))
    if (result.report.status !== "COMPLETE") process.exitCode = 1
  }
}
