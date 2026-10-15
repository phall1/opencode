import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { mkdirSync, readFileSync, realpathSync, existsSync } from "node:fs"
import { Trace, TraceRecords } from "../src/index"
import { start } from "../src/collector"
import type { Sink } from "../src/sink"
import {
  INITIAL,
  PROMPT,
  contextView,
  createHost,
  runPrompt,
  snapshotWorld,
  makeWorld,
  withScratch,
  toolResponse,
  textResponse,
  type Counters,
} from "../../replay/src/runtime"
import { ToolTape } from "../../replay/src/tape"

export const CANARY = "synthetic-secret-trace-8eb905"
export const SESSION_ID = Session.ID.make(`ses_${CANARY}`)

/** Synthetic transport through the production SDK, provider parser, and runner. */
export const scenario = Effect.fn("Trace.fixture")(function* (enabled: boolean, ownedSink?: Sink, longIDs = false) {
  return yield* withScratch((directory) =>
    Effect.gen(function* () {
      const outputDirectory = `${realpathSync(directory)}/traces`
      if (enabled) mkdirSync(outputDirectory)
      const trace = ownedSink
        ? {
            ...(yield* start({ enabled: true, outputDirectory, selection: { allHostSessions: true } }, ownedSink)),
            runDirectory: undefined,
          }
        : yield* Trace.capture(
            enabled ? { enabled: true, outputDirectory, selection: { allHostSessions: true } } : { enabled: false },
          )
      const callID = longIDs ? CANARY.repeat(20) : CANARY
      const counters: Counters = { provider: 0, http: 0, failures: [] }
      const tape = new ToolTape("record", directory)
      const host = yield* createHost({
        directory,
        tape,
        files: { ...INITIAL, "/fixture/repair.txt": `teh small fixture\n${CANARY}` },
        counters,
        embed: { overrides: trace.overrides },
        profile: {
          instructions: `Only read/write /fixture/repair.txt. ${CANARY}`,
          steps: 4,
          requests: 8,
          responses: [
            toolResponse(`${callID}-read`, "read", { path: "/fixture/repair.txt" }),
            toolResponse(`${callID}-write`, "write", {
              path: "/fixture/repair.txt",
              content: `the small fixture\n${CANARY}`,
            }),
            [{ type: "reasoningDelta", text: CANARY }, ...textResponse(`repaired ${CANARY}`)],
          ],
        },
      })
      yield* host.opencode.sessions.create({
        id: SESSION_ID,
        agent: Agent.ID.make("fixture"),
        location: host.location,
        title: CANARY,
        metadata: { canary: CANARY },
      })
      const context = yield* runPrompt(host.opencode, SESSION_ID, `${PROMPT} ${CANARY}`)
      yield* host.opencode.sessions.fork({ sessionID: SESSION_ID })
      const secondWorld = yield* makeWorld(INITIAL)
      const secondLocation = yield* host.attach(secondWorld)
      yield* host.opencode.sessions.create({
        id: Session.ID.make("ses_second_native_fixture"),
        agent: Agent.ID.make("fixture"),
        location: secondLocation,
        title: CANARY,
      })
      const world = yield* snapshotWorld(host.world)
      yield* trace.close
      const text = trace.runDirectory ? readFileSync(`${trace.runDirectory}/events.jsonl`, "utf8") : ""
      return {
        context: contextView(context.messages),
        world,
        outcome: context.info.outcome,
        provider: counters.provider,
        http: counters.http,
        tools: tape.live,
        text,
        records: text.trim()
          ? text
              .trim()
              .split("\n")
              .map((text) => Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecords.Record))(text))
          : [],
        health: trace.health(),
        disabledArtifacts: !enabled && existsSync(outputDirectory),
      }
    }),
  ).pipe(Effect.scoped)
})
