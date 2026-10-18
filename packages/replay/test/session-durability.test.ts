import { expect } from "bun:test"
import { Database } from "@opencode/core/database/database"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Layer } from "effect"
import path from "node:path"
import { testEffect } from "../../core/test/lib/effect"
import { INITIAL, createHost, withScratch, type Counters } from "../src/runtime"
import { ToolTape } from "../src/tape"

const it = testEffect(Layer.empty)

it.live("an explicit SQLite path preserves the Session and parked admission across embedded host reopen", () =>
  withScratch((directory) =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_synthetic_durable_admission")
      const id = SessionMessage.ID.create()
      const counters: Counters = { provider: 0, http: 0, failures: [] }
      const open = () =>
        createHost({
          directory,
          files: INITIAL,
          tape: new ToolTape("record", directory),
          counters,
          embed: {
            overrides: [Database.node.replace(Database.configured({ path: path.join(directory, "session.sqlite") }))],
          },
        })

      yield* Effect.gen(function* () {
        const host = yield* open()
        yield* host.opencode.sessions.create({
          id: sessionID,
          location: host.location,
          title: "Synthetic persisted work",
        })
        yield* host.opencode.sessions.prompt({
          id,
          sessionID,
          text: "First admission wins",
          resume: false,
        })
        expect((yield* host.opencode.sessions.inbox.list({ sessionID })).map((item) => item.id)).toEqual([id])
      }).pipe(Effect.scoped)

      yield* Effect.gen(function* () {
        const host = yield* open()
        expect((yield* host.opencode.sessions.get({ sessionID })).title).toBe("Synthetic persisted work")
        yield* host.opencode.sessions.prompt({
          id,
          sessionID,
          text: "A retried payload must not overwrite the original",
          resume: false,
        })
        const pending = yield* host.opencode.sessions.inbox.list({ sessionID })
        expect(pending).toHaveLength(1)
        expect(pending[0].type === "user" && pending[0].payload.text).toBe("First admission wins")
      }).pipe(Effect.scoped)

      expect(counters.provider).toBe(0)
      expect(counters.http).toBe(0)
      expect(counters.failures).toEqual([])
    }),
  ),
)

it.live("the embedded fixture's default in-memory database does not survive host reopen", () =>
  withScratch((directory) =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make("ses_synthetic_ephemeral_host")
      const open = () =>
        createHost({
          directory,
          files: INITIAL,
          tape: new ToolTape("record", directory),
          counters: { provider: 0, http: 0, failures: [] },
        })
      yield* Effect.gen(function* () {
        const host = yield* open()
        yield* host.opencode.sessions.create({ id: sessionID, location: host.location })
      }).pipe(Effect.scoped)
      yield* Effect.gen(function* () {
        const host = yield* open()
        const error = yield* host.opencode.sessions.get({ sessionID }).pipe(Effect.flip)
        expect(error._tag).toBe("Session.NotFoundError")
      }).pipe(Effect.scoped)
    }),
  ),
)
