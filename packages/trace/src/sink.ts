import { Effect } from "effect"
import { open, opendir, mkdtemp, realpath } from "node:fs/promises"
import path from "node:path"

/** Internal owned I/O seam. Tests can stall/fail it without mocking global FS. */
export interface Sink {
  readonly write: (line: string) => Effect.Effect<void, unknown>
  readonly close: Effect.Effect<void, unknown>
}

export const fileSink = Effect.fnUntraced(function* (directory: string) {
  // Caller supplies an existing, non-symlinked directory. A unique private run
  // directory and exclusive file creation cannot overwrite their files.
  const root = path.resolve(directory)
  const canonical = yield* Effect.tryPromise(() => realpath(root))
  if (canonical !== root) return yield* Effect.fail(new Error("Trace directory must be canonical"))
  yield* Effect.tryPromise(async () => {
    const entries = await opendir(root)
    let count = 0
    for await (const _entry of entries) {
      if (++count >= 16) throw new Error("Trace directory retention limit reached")
    }
  })
  const runDirectory = yield* Effect.tryPromise(() => mkdtemp(path.join(root, "trace-v1-")))
  const handle = yield* Effect.acquireRelease(
    Effect.tryPromise(() => open(path.join(runDirectory, "events.jsonl"), "wx", 0o600)),
    (handle) =>
      Effect.tryPromise(() => handle.close()).pipe(Effect.interruptible, Effect.timeoutOption(2000), Effect.ignore),
  )
  const sink: Sink = {
    write: (line) =>
      Effect.tryPromise(async () => {
        const bytes = Buffer.from(line)
        const written = await handle.write(bytes)
        if (written.bytesWritten !== bytes.byteLength) throw new Error("Short trace write")
      }),
    close: Effect.tryPromise(() => handle.close()),
  }
  return { sink, runDirectory }
})
