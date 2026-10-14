import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Layer } from "effect"
import { mkdirSync, readFileSync } from "node:fs"
import { Agent } from "@opencode/schema/agent"

// Service-seam instrumentation lives only in this disposable Bun process.
const sentinel = "HOST_PRIVATE_REPLAY_SENTINEL_874"
const observations = { resolve: 0, up: 0, read: 0, directory: 0, stat: 0 }
let acquisitions = 0
const fixture = (value: string) => value === "/fixture" || value.startsWith("/fixture/")
Object.defineProperty(FSUtil, "node", {
  value: FSUtil.node.mapLayer((layer) =>
    Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        acquisitions++
        const fs = yield* FSUtil.Service
        return FSUtil.Service.of({
          ...fs,
          resolve: (value) => {
            if (!fixture(value)) return fs.resolve(value)
            observations.resolve++
            return Effect.succeed(value)
          },
          up: (options) => {
            if (!fixture(options.start)) return fs.up(options)
            observations.up++
            return Effect.succeed(["/fixture/AGENTS.md"])
          },
          readFileStringSafe: (value) => {
            if (!fixture(value)) return fs.readFileStringSafe(value)
            observations.read++
            return Effect.succeed(sentinel)
          },
          readDirectory: (value, options) => {
            if (!fixture(value)) return fs.readDirectory(value, options)
            observations.directory++
            return Effect.succeed([`repair.txt-${sentinel}`])
          },
          stat: (value) => {
            if (!fixture(value)) return fs.stat(value)
            observations.stat++
            return Effect.die("Host fixture stat was consulted")
          },
        })
      }),
    ).pipe(Layer.provide(layer)),
  ),
})

const directory = process.argv[2]
if (process.argv[3] === "repo") {
  const { demoTask, experiment } = await import("../../src/repo")
  await Effect.runPromise(experiment(demoTask, `${directory}/repo`, true))
  const clean = ["checkpoint", "general", "overfit"].every(
    (name) => !readFileSync(`${directory}/repo/${name}.json`, "utf8").includes(sentinel),
  )
  if (!clean || acquisitions === 0 || Object.values(observations).some((count) => count !== 0))
    throw new Error("Ambient repo fixture observations leaked")
  console.log(JSON.stringify({ clean, acquisitions, observations }))
  process.exit(0)
}

const { record } = await import("../../src/index")
const { createHost, runPrompt, SESSION_ID, PROMPT } = await import("../../src/runtime")
const { ToolTape } = await import("../../src/tape")
const recorded = await Effect.runPromise(record(`${directory}/capsule.json`))
mkdirSync(`${directory}/missing`)
const missing = await Effect.runPromise(
  Effect.gen(function* () {
    const tape = new ToolTape("record", `${directory}/missing`)
    const host = yield* createHost({
      directory: `${directory}/missing`,
      tape,
      counters: { provider: 0, http: 0, failures: [] },
      files: {},
    })
    yield* host.opencode.sessions.create({
      id: SESSION_ID,
      agent: Agent.ID.make("fixture"),
      location: host.location,
      title: "Bounded repair",
    })
    yield* runPrompt(host.opencode, SESSION_ID, PROMPT)
    tape.assertComplete()
    return tape.entries
  }).pipe(Effect.scoped),
)
const clean =
  !readFileSync(`${directory}/capsule.json`, "utf8").includes(sentinel) && !JSON.stringify(missing).includes(sentinel)
if (!clean || acquisitions === 0 || Object.values(observations).some((count) => count !== 0))
  throw new Error("Ambient fixture observations leaked")
console.log(JSON.stringify({ clean, acquisitions, observations, digest: recorded.capsule.digest }))
