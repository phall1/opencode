import assert from "node:assert/strict"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { experiment } from "../../src/repo"
import { inspectJournal } from "../../src/journal"
import { withDockerCapability } from "../../src/verifier-isolation"
import { verifierObserver, waitingTask } from "../isolation-control"

const root = process.argv[2]
const input = waitingTask()
const output = path.join(root, `effect-${input.nonce}`)
const abort = new AbortController()
const pending = Effect.runPromiseExit(experiment(input.task, output, true, { isolation: "docker-required" }), {
  signal: abort.signal,
}).then((exit) =>
  Exit.isSuccess(exit)
    ? { state: "succeeded" as const, detail: "" }
    : { state: "failed" as const, detail: Cause.pretty(exit.cause) },
)
try {
  await withDockerCapability(async (capability) => {
    const observer = verifierObserver(capability, root)
    const id = await Promise.race([
      observer.running(input),
      pending.then((result) => {
        throw new Error(`Experiment ended before candidate readiness: ${result.detail}`)
      }),
    ])
    abort.abort(new Error("synthetic Effect cancellation"))
    const result = await pending
    assert.equal(result.state, "failed")
    assert.notEqual(result.detail, "")
    assert.deepEqual(await observer.inspect([id], performance.now() + 10000), [])
    const journal = inspectJournal(output)
    assert.ok(journal.some((entry) => entry.started.startsWith("measurement-") && entry.state.includes("UNKNOWN")))
    console.log(JSON.stringify({ ...result, id, output, journal }))
  })
} finally {
  abort.abort()
  await pending
}
