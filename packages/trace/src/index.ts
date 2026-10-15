export * as Trace from "./index"
export { TraceRecords } from "./records"

import { Effect } from "effect"
import { Schema } from "effect"
import { emptyHealth, start } from "./collector"
import { Options } from "./options"
import { fileSink } from "./sink"

export { Options } from "./options"

/** Scoped, opt-in metadata capture; pass overrides to OpenCode.create's embed options. */
export const capture = Effect.fnUntraced(function* (input: Options = { enabled: false }) {
  const options = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.toType(Options))(input),
    catch: () => new Error("Invalid trace options"),
  })
  if (!options.enabled)
    return {
      overrides: [],
      runDirectory: undefined,
      health: () => emptyHealth("disabled"),
      close: Effect.void,
    }
  const output = yield* fileSink(options.outputDirectory).pipe(
    Effect.mapError(() => new Error("Trace output unavailable")),
  )
  const collector = yield* start(options, output.sink)
  return {
    overrides: collector.overrides,
    health: collector.health,
    close: collector.close,
    runDirectory: output.runDirectory,
  }
})
