import { Effect } from "effect"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { make as makeSmol } from "@opencode/core/environment/machine-smolvm"
import path from "node:path"
import { mkdirSync } from "node:fs"

const iterations = Math.max(1, Number(process.argv[2] || "3"))
const outputDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join("/tmp", `smolvm-probe-${Date.now()}`)
mkdirSync(outputDir, { recursive: true, mode: 0o700 })

const profile = Effect.gen(function* () {
  const processes = yield* AppProcess.Service
  const runtime = makeSmol({ processes, cpus: 1, memoryMB: 256 })
  const parentStart = yield* Effect.sync(() => Date.now())
  const parent = yield* runtime.create({ image: "alpine" })
  const parentReadyMs = Date.now() - parentStart

  const samples: Array<{ iteration: number; child: string; branchMs: number; execMs: number; exitCode: number; stdout: string }> = []
  for (let index = 0; index < iterations; index++) {
    const branchStart = Date.now()
    const child = yield* runtime.fork({ parent: parent.id, name: `probe-child-${index}` })
    const branchMs = Date.now() - branchStart

    const execStart = Date.now()
    const result = yield* runtime.exec({ id: child.id, command: ["/bin/sh", "-c", "echo probe-ok; uname -m"] })
    const execMs = Date.now() - execStart
    samples.push({ iteration: index + 1, child: child.id, branchMs, execMs, exitCode: result.exitCode, stdout: result.stdout.trim() })
  }

  for (const sample of samples) yield* runtime.destroy({ id: sample.child })
  yield* runtime.stop({ id: parent.id })
  yield* runtime.destroy({ id: parent.id })

  const branchAverage = samples.reduce((sum, value) => sum + value.branchMs, 0) / samples.length
  const execAverage = samples.reduce((sum, value) => sum + value.execMs, 0) / samples.length
  const report = {
    host: { cpus: undefined, date: new Date().toISOString(), runtime: "smolvm" },
    outputDirectory: outputDir,
    parentReadyMs,
    samples,
    branchAverageMs: Math.round(branchAverage),
    execAverageMs: Math.round(execAverage),
    exitCodes: samples.map((sample) => sample.exitCode),
  }
  return report
}).pipe(Effect.provide(LayerNode.compile(AppProcess.node)))

const report = await Effect.runPromise(profile)
console.log(JSON.stringify(report, null, 2))
