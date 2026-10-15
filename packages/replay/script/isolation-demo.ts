import { Effect } from "effect"
import path from "node:path"
import assert from "node:assert/strict"
import { demoTask, experiment, openRepo, replayRepo } from "../src/repo"
import { temporary } from "../src/scratch"
import { isolationChecks } from "./isolation-checks"

if (process.argv.length > 3) throw new Error("Usage: isolation-demo.ts [new-output-directory]")
const output = process.argv[2] ?? path.join(temporary(), "experiment")
const checks = await isolationChecks(temporary())
const result = await Effect.runPromise(experiment(demoTask, output, true, { isolation: "docker-required" }))
assert.equal(result.baseline, "test-failed")
assert.deepEqual(
  result.continuations.map((entry) => [entry.policy, entry.public, entry.heldout]),
  [
    ["general", "passed", "passed"],
    ["overfit", "passed", "test-failed"],
  ],
)
const cold = await Promise.all(
  ["checkpoint", "general", "overfit"].map((policy) =>
    Effect.runPromise(replayRepo(openRepo(path.join(output, `${policy}.json`)))),
  ),
)
assert.ok(cold.every((replay) => replay.equal && Object.values(replay.live).every((count) => count === 0)))
console.log(JSON.stringify({ ...result, checks, cold }, null, 2))
