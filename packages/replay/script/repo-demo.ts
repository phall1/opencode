import { Effect } from "effect"
import path from "node:path"
import { demoTask, experiment, openRepo, replayRepo } from "../src/repo"
import { temporary } from "../src/scratch"

if (process.argv.length > 3) throw new Error("Usage: repo-demo.ts [new-output-directory]")
const output = process.argv[2] ?? path.join(temporary(), "experiment")
const result = await Effect.runPromise(experiment(demoTask, output, true))
const general = result.continuations.find((entry) => entry.policy === "general")
const overfit = result.continuations.find((entry) => entry.policy === "overfit")
if (
  result.baseline !== "test-failed" ||
  general?.public !== "passed" ||
  general.heldout !== "passed" ||
  overfit?.public !== "passed" ||
  overfit.heldout !== "test-failed"
)
  throw new Error("Synthetic experiment acceptance failed")
const cold = await Promise.all(
  ["checkpoint", "general", "overfit"].map((policy) =>
    Effect.runPromise(replayRepo(openRepo(path.join(output, `${policy}.json`)))),
  ),
)
console.log(JSON.stringify({ ...result, cold }, null, 2))
