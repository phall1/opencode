import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { SelectedSession } from "./projection"

const limit = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }))
export const Options = Schema.Union([
  Schema.Struct({ enabled: Schema.Literal(false) }),
  Schema.Struct({
    enabled: Schema.Literal(true),
    outputDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    selection: Schema.Union([
      Schema.Struct({ sessions: Schema.NonEmptyArray(SelectedSession).check(Schema.isMaxLength(256)) }),
      Schema.Struct({ allHostSessions: Schema.Literal(true) }),
    ]),
    limits: optional(
      Schema.Struct({
        queueRecords: optional(limit(256)),
        queueBytes: optional(limit(256 * 1024)),
        records: optional(limit(10_000)),
        fileBytes: optional(Schema.Int.check(Schema.isBetween({ minimum: 8192, maximum: 4 * 1024 * 1024 }))),
        shutdownMs: optional(limit(2000)),
      }),
    ),
  }),
])
export type Options = typeof Options.Type
export type Enabled = Extract<Options, { enabled: true }>
export const limits = (options: Enabled) => {
  const value = options.limits ?? {}
  return {
    queueRecords: value.queueRecords ?? 256,
    queueBytes: value.queueBytes ?? 256 * 1024,
    records: value.records ?? 10_000,
    fileBytes: value.fileBytes ?? 4 * 1024 * 1024,
    shutdownMs: value.shutdownMs ?? 2000,
  }
}
