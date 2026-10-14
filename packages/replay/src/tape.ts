import { Effect, Schema } from "effect"
import { Tool } from "@opencode/schema/tool"
import { Result, ToolEntry, canonical, durableWrite, encode, json } from "./archive"

const Input = Schema.Struct({ path: Schema.String })
export interface TapeRules {
  read: readonly string[]
  write: readonly string[]
  tools?: number
  bytes?: number
}

/** One serial episode. Mismatches poison the episode even if the native runner recovers. */
export class ToolTape {
  readonly entries: ToolEntry[] = []
  readonly failures: string[] = []
  live = 0
  consumed = 0
  active = false
  uncertain = false

  constructor(
    readonly mode: "record" | "replay",
    readonly directory: string,
    readonly expected: readonly ToolEntry[] = [],
    readonly rules: TapeRules = { read: ["/fixture/repair.txt"], write: ["/fixture/repair.txt"] },
    readonly persist = durableWrite,
  ) {}

  wrap(name: "read" | "write", execute: Tool.Info["execute"]): Tool.Info["execute"] {
    return (input, context) =>
      Effect.suspend(() => {
        if (this.uncertain) return this.reject("UNKNOWN tool effect; refusing automatic repeat")
        if (this.active) return this.reject("Concurrent tools are unsupported")
        this.active = true
        return this.invoke(name, input, () => execute(input, context)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.active = false
            }),
          ),
        )
      })
  }

  private invoke(name: "read" | "write", input: unknown, execute: () => ReturnType<Tool.Info["execute"]>) {
    return Effect.gen({ self: this }, function* () {
      const args = yield* Effect.try(() => json(input)).pipe(Effect.orDie)
      const issue = this.inputIssue(name, args)
      if (issue) return yield* this.reject(issue)
      if (this.mode === "replay") return yield* this.replay(name, args)
      const occurrence = this.entries.length + 1
      this.persist(
        `${this.directory}/tool-${occurrence}.started.json`,
        encode({ occurrence, name, input: args, state: "started; missing receipt means UNKNOWN" }),
      )
      this.uncertain = true
      this.live++
      const outcome = yield* execute().pipe(
        Effect.match({
          onFailure: (error) => ({ status: "error" as const, message: error.message }),
          onSuccess: (result) => ({ status: "completed" as const, result: Schema.decodeUnknownSync(Result)(result) }),
        }),
      )
      const entry = Schema.decodeUnknownSync(ToolEntry)({
        occurrence: this.entries.length + 1,
        name,
        input: args,
        outcome,
      })
      // Persist and fsync before the runner can retire the tool's native result.
      this.persist(`${this.directory}/tool-${entry.occurrence}.json`, encode(entry))
      this.entries.push(entry)
      this.uncertain = false
      return yield* deliver(entry)
    })
  }

  private inputIssue(name: "read" | "write", args: Schema.Json) {
    const valid = Schema.decodeUnknownOption(Input)(args)
    if (valid._tag === "None") return "Only absolute fixture text paths are supported"
    if (!this.rules[name].includes(valid.value.path))
      return "Only absolute fixture text paths declared for this operation are supported"
    if (this.live + this.consumed >= (this.rules.tools ?? 32)) return "Tool budget exceeded"
    if (Buffer.byteLength(encode(args)) > (this.rules.bytes ?? 1024 * 1024)) return "Tool input byte budget exceeded"
  }

  private replay(name: string, input: Schema.Json) {
    const entry = this.expected[this.consumed]
    if (!entry) return this.reject(`Missing tool result at occurrence ${this.consumed + 1}`)
    if (entry.occurrence !== this.consumed + 1 || entry.name !== name || canonical(entry.input) !== canonical(input))
      return this.reject(`Tool result mismatch at occurrence ${this.consumed + 1}`)
    this.consumed++
    return deliver(entry)
  }

  private reject(message: string) {
    this.failures.push(message)
    return Effect.fail(new Tool.Error({ message }))
  }

  assertComplete() {
    if (this.uncertain) throw new Error("UNKNOWN tool effect: started without durable receipt")
    if (this.failures.length) throw new Error(this.failures.join("; "))
    if (this.mode === "replay" && this.consumed !== this.expected.length) throw new Error("Unused tool results")
  }
}

function deliver(entry: ToolEntry) {
  if (entry.outcome.status === "error") return Effect.fail(new Tool.Error({ message: entry.outcome.message }))
  return Effect.succeed(entry.outcome.result)
}
