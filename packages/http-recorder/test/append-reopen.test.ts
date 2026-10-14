import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { readFileSync, writeFileSync } from "node:fs"
import { HttpRecorder } from "../src"
import { Service } from "../src/cassette/store"
import { post, readCassette, runFileCassette, seedCassetteDirectory, tempDirectory } from "./support"

describe("durable cassette appends", () => {
  test("recording through rebuilt layers preserves earlier evidence", async () => {
    using directory = tempDirectory("http-append-reopen-")
    const upstream = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("new"))),
    )
    await seedCassetteDirectory(directory.path, "episode", [
      {
        transport: "http",
        request: { method: "GET", url: "https://example.test/old", headers: {}, body: "" },
        response: { status: 200, headers: {}, body: "original" },
      },
    ])
    const run = (value: number) =>
      Effect.runPromise(
        post("https://example.test/new", { value }).pipe(
          Effect.provide(HttpRecorder.layer("episode", { directory: directory.path, mode: "record" })),
          Effect.provide(Layer.succeed(HttpClient.HttpClient, upstream)),
        ),
      )
    await run(1)
    await run(2)
    const interactions = readCassette(`${directory.path}/episode.json`).interactions
    expect(interactions).toHaveLength(3)
    expect(interactions[0]).toMatchObject({ response: { body: "original" } })
  })

  test("reopening preserves metadata and refuses to replace malformed evidence", async () => {
    using directory = tempDirectory("http-append-invalid-")
    const interaction = {
      transport: "http" as const,
      request: { method: "GET", url: "https://example.test", headers: {}, body: "" },
      response: { status: 200, headers: {}, body: "safe" },
    }
    await runFileCassette(
      directory.path,
      Effect.gen(function* () {
        const cassette = yield* Service
        yield* cassette.append("metadata", interaction, { source: "retained" })
      }),
    )
    await runFileCassette(
      directory.path,
      Effect.gen(function* () {
        const cassette = yield* Service
        yield* cassette.append("metadata", interaction)
      }),
    )
    expect(readCassette(`${directory.path}/metadata.json`).metadata?.source).toBe("retained")
    writeFileSync(`${directory.path}/invalid.json`, "{not-json")
    await expect(
      runFileCassette(
        directory.path,
        Effect.gen(function* () {
          const cassette = yield* Service
          yield* cassette.append("invalid", interaction)
        }),
      ),
    ).rejects.toThrow("invalid")
    expect(readFileSync(`${directory.path}/invalid.json`, "utf8")).toBe("{not-json")
  })

  test("public fetch replay rejects malformed input without calling Fetch", async () => {
    using directory = tempDirectory("http-fetch-invalid-")
    writeFileSync(`${directory.path}/invalid.json`, "{not-json")
    let live = 0
    const fetch = Object.assign(
      () => {
        live++
        return Promise.resolve(new Response("live"))
      },
      { preconnect: () => undefined },
    )
    await expect(
      Effect.runPromise(
        post("https://example.test/value", { value: 1 }).pipe(
          Effect.provide(HttpRecorder.layerFetch("invalid", { directory: directory.path, mode: "replay" })),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        ),
      ),
    ).rejects.toThrow("invalid")
    expect(live).toBe(0)
  })
})
