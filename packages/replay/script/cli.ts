import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { open, save } from "../src/archive"
import { measure } from "../src/measure"

const args = process.argv.slice(2)
const [command, file, output] = args
const arities = new Map([
  ["record", 2],
  ["replay", 2],
  ["measure", 3],
  ["fork", 3],
])
if (!file || args.length !== arities.get(command))
  throw new Error(
    "Usage: cli.ts record|replay <capsule.json>; measure <capsule.json> <verifier-id>; fork <capsule.json> <output.json>",
  )

async function run() {
  if (command === "record") {
    const { record } = await import("../src/index")
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    const result = await Effect.runPromise(record(file))
    return { file, digest: result.capsule.digest, live: result.live }
  }
  if (command === "replay") {
    const { replay } = await import("../src/index")
    return Effect.runPromise(replay(open(file)))
  }
  if (command === "measure") {
    if (!output) throw new Error("measure requires a verifier ID")
    return measure(open(file), output, path.dirname(path.resolve(file)))
  }
  if (command === "fork") {
    const { fork } = await import("../src/index")
    if (!output) throw new Error("fork requires an output filename")
    const result = await Effect.runPromise(fork(open(file)))
    save(output, result.capsule)
    return { file: output, ancestry: result.ancestry, isolated: result.isolated }
  }
  throw new Error(`Unknown command: ${command}`)
}

console.log(JSON.stringify(await run(), null, 2))
