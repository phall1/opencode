import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { existsSync } from "node:fs"
import { HttpRecorder } from "../src"
import { post, seedCassetteDirectory, tempDirectory } from "./support"

describe("explicit HTTP modes", () => {
  test("missing replay never delegates or writes a cassette", async () => {
    using directory = tempDirectory("http-explicit-missing-")
    let live = 0
    const upstream = HttpClient.make((request) =>
      Effect.sync(() => {
        live++
        return HttpClientResponse.fromWeb(request, new Response("live"))
      }),
    )
    await expect(
      Effect.runPromise(
        post("https://example.test/value", { value: 1 }).pipe(
          Effect.provide(HttpRecorder.layer("missing", { directory: directory.path, mode: "replay" })),
          Effect.provide(Layer.succeed(HttpClient.HttpClient, upstream)),
        ),
      ),
    ).rejects.toThrow("not found")
    expect(live).toBe(0)
    expect(existsSync(`${directory.path}/missing.json`)).toBe(false)
  })

  test("record then replay uses the same client path without live replay calls", async () => {
    using directory = tempDirectory("http-explicit-record-")
    let live = 0
    const upstream = HttpClient.make((request) =>
      Effect.sync(() => {
        live++
        return HttpClientResponse.fromWeb(request, new Response("recorded"))
      }),
    )
    const run = (mode: "record" | "replay") =>
      Effect.runPromise(
        post("https://example.test/value", { value: 1 }).pipe(
          Effect.provide(HttpRecorder.layer("episode", { directory: directory.path, mode })),
          Effect.provide(Layer.succeed(HttpClient.HttpClient, upstream)),
        ),
      )
    expect(await run("record")).toBe("recorded")
    expect(live).toBe(1)
    expect(await run("replay")).toBe("recorded")
    expect(live).toBe(1)
  })

  test("passthrough delegates without retaining observations", async () => {
    using directory = tempDirectory("http-explicit-passthrough-")
    const upstream = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("live"))),
    )
    const result = await Effect.runPromise(
      post("https://example.test/value", { value: 1 }).pipe(
        Effect.provide(HttpRecorder.layer("episode", { directory: directory.path, mode: "passthrough" })),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, upstream)),
      ),
    )
    expect(result).toBe("live")
    expect(existsSync(`${directory.path}/episode.json`)).toBe(false)
  })

  test("explicit replay mismatch rejects without live fallback", async () => {
    using directory = tempDirectory("http-explicit-mismatch-")
    await seedCassetteDirectory(directory.path, "episode", [
      {
        transport: "http",
        request: { method: "POST", url: "https://example.test/value", headers: {}, body: '{"value":1}' },
        response: { status: 200, headers: {}, body: "recorded" },
      },
    ])
    let live = 0
    const upstream = HttpClient.make((request) =>
      Effect.sync(() => {
        live++
        return HttpClientResponse.fromWeb(request, new Response("live"))
      }),
    )
    await expect(
      Effect.runPromise(
        post("https://example.test/value", { value: 2 }).pipe(
          Effect.provide(HttpRecorder.layer("episode", { directory: directory.path, mode: "replay" })),
          Effect.provide(Layer.succeed(HttpClient.HttpClient, upstream)),
        ),
      ),
    ).rejects.toThrow("does not match")
    expect(live).toBe(0)
  })
})
