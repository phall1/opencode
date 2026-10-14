import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fork, measure, open, record, replay } from "../src/index"
import { temporary } from "../src/runtime"
import { save } from "../src/archive"

const directory = process.argv[2] ? path.resolve(process.argv[2]) : temporary()
mkdirSync(directory, { recursive: true })
const file = path.join(directory, "capsule.json")
const recorded = await Effect.runPromise(record(file))
const capsule = open(file)
const replayed = await Effect.runPromise(replay(capsule))
const checkpoint = await Effect.runPromise(fork(capsule))
const childFile = path.join(directory, "child-capsule.json")
save(childFile, checkpoint.capsule)
const child = open(childFile)
const childReplay = await Effect.runPromise(replay(child))
const childMeasure = measure(child, "child-one-v1", directory)
const first = measure(capsule, "repair-exact-v1", directory)
const second = measure(capsule, "repair-no-typo-v1", directory)
console.log(
  JSON.stringify(
    {
      file,
      digest: capsule.digest,
      recordLive: recorded.live,
      replay: replayed,
      childFile,
      childReplay,
      childMeasure,
      checkpoint: {
        isolated: checkpoint.isolated,
        prefixLive: checkpoint.prefixLive,
        childLive: checkpoint.trajectory.live,
      },
      verifiers: [first, second],
      immutable: open(file).digest === capsule.digest,
    },
    null,
    2,
  ),
)
