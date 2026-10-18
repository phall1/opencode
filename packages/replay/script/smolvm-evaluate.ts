import { Effect, Logger } from "effect"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { evaluateSmolvm, help, parseArguments, remeasure } from "../src/smolvm-evaluation"

const options = parseArguments(process.argv.slice(2))
if (options.mode === "help") console.log(help)
if (options.mode === "remeasure")
  console.log(JSON.stringify(remeasure(options.directory, options.file, options.verifier), null, 2))
if (options.mode === "evaluate") {
  const result = await Effect.runPromise(
    evaluateSmolvm({ directory: options.directory, trustLocalCode: true }).pipe(
      Effect.provide(LayerNode.compile(AppProcess.node)),
      Effect.provideService(Logger.LogToStderr, true),
    ),
  )
  console.log(JSON.stringify(result, null, 2))
  if (result.report.status !== "COMPLETE") process.exitCode = 1
}
