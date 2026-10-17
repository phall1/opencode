export * as MachineSmolVM from "./machine-smolvm.js"

import { MachineRuntime } from "./machine.js"
import { ChildProcess } from "effect/process"
import { Cause, Effect, Exit, Schema } from "effect"
import { AppProcess } from "@opencode/util/process"
import path from "node:path"

export interface Options {
  readonly processes: AppProcess.Interface
  readonly binary?: string
  readonly namePrefix?: string
  readonly cpus?: number
  readonly memoryMB?: number
  readonly diskGB?: number
  /** Private HOME/cache/data roots; SMOLVM_DATA_DIR alone is ignored on macOS. */
  readonly dataDirectory?: string
  /** Record a uniquely named cleanup intent before create/branch can have an ambiguous outcome. */
  readonly onCreateIntent?: (id: string) => void
  /** An explicit CLI conflict revokes the corresponding cleanup intent. */
  readonly onCreateConflict?: (id: string) => void
}

const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/))
const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 }))
const Configuration = Schema.Struct({
  binary: Schema.String,
  prefix: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$/)),
  cpus: Positive,
  memoryMB: Positive,
  diskGB: Schema.optional(Positive),
  dataDirectory: Schema.optional(Schema.String),
})
const ManagementError = Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) })
const OUTPUT_BYTES = 32_768
const COMPLETION_BYTES = 128

/** Exec requires a POSIX /bin/sh supporting `exec --`; unsupported guests fail UNKNOWN. */
export const make = (options: Options) => {
  const config = configuration(options)
  const fresh = () => `${config.prefix}-${crypto.randomUUID()}`
  const home = config.dataDirectory ?? process.env.HOME
  const env = {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    XDG_CACHE_HOME: config.dataDirectory && path.join(config.dataDirectory, "cache"),
    XDG_DATA_HOME: config.dataDirectory && path.join(config.dataDirectory, "data"),
    XDG_CONFIG_HOME: config.dataDirectory && path.join(config.dataDirectory, "config"),
    LANG: "C.UTF-8",
    TZ: "UTC",
  }
  const run = (args: readonly string[], timeoutMs = 30_000, completion?: string) =>
    options.processes
      .run(
        ChildProcess.make(config.binary, ["--error-format", "json", ...args], {
          stdin: "ignore",
          env,
          extendEnv: false,
          cwd: home,
        }),
        // Reserve stderr trailer space while keeping combined capture at 64 KiB.
        {
          timeout: `${timeoutMs} millis`,
          maxOutputBytes: OUTPUT_BYTES - COMPLETION_BYTES,
          maxErrorBytes: OUTPUT_BYTES + COMPLETION_BYTES,
        },
      )
      .pipe(
        Effect.mapError(
          () => new MachineRuntime.Error({ message: "SmolVM controller launch/timeout failed; outcome UNKNOWN" }),
        ),
        Effect.flatMap((result) => decodeResult(result, completion, args[1] === "delete")),
      )
  const remove = (id: string) => run(["machine", "delete", "--name", id, "--force"]).pipe(Effect.asVoid)
  const cleanupFailure = (id: string) => (exit: Exit.Exit<unknown, MachineRuntime.Error>) => {
    if (Exit.isSuccess(exit)) return Effect.void
    const error = Cause.findErrorOption(exit.cause)
    if (
      error._tag === "Some" &&
      error.value.cause instanceof ManagementFailure &&
      error.value.cause.code === "CONFLICT"
    )
      return Effect.sync(() => options.onCreateConflict?.(id))
    return remove(id)
  }

  return MachineRuntime.make({
    provider: "smolvm",
    create: ({ image, cpus: requestedCpus, memoryMB: requestedMemory }) =>
      Effect.gen(function* () {
        const name = fresh()
        const resources = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(Schema.Struct({ cpus: Positive, memoryMB: Positive }))({
              cpus: requestedCpus ?? config.cpus,
              memoryMB: requestedMemory ?? config.memoryMB,
            }),
          catch: () => new MachineRuntime.Error({ message: "Invalid SmolVM resources" }),
        })
        yield* Effect.sync(() => options.onCreateIntent?.(name))
        yield* Effect.acquireUseRelease(
          run([
            "machine",
            "create",
            "--name",
            name,
            "--image",
            image,
            "--cpus",
            String(resources.cpus),
            "--mem",
            String(resources.memoryMB),
            ...(config.diskGB === undefined
              ? []
              : ["--storage", String(config.diskGB), "--overlay", String(config.diskGB)]),
          ]).pipe(Effect.onExit(cleanupFailure(name))),
          () => run(["machine", "start", "--name", name, "--branchable"]),
          // A start conflict does not revoke ownership established by create.
          (_, exit) => (Exit.isFailure(exit) ? remove(name) : Effect.void),
        )
        return { id: name }
      }),
    fork: ({ parent, name }) =>
      Effect.gen(function* () {
        const child = yield* validName(name ?? fresh())
        yield* validName(parent)
        if (name)
          yield* run(["machine", "status", "--name", child]).pipe(
            Effect.matchEffect({
              onSuccess: () =>
                Effect.fail(new MachineRuntime.Error({ message: "Machine name already exists; branch not attempted" })),
              onFailure: (error) =>
                error.cause instanceof ManagementFailure && error.cause.code === "NOT_FOUND"
                  ? Effect.void
                  : Effect.fail(error),
            }),
          )
        yield* Effect.sync(() => options.onCreateIntent?.(child))
        yield* run(["machine", "branch", "--from", parent, "--name", child], 30_000).pipe(
          Effect.onExit(cleanupFailure(child)),
        )
        return { id: child }
      }),
    exec: ({ id, command, timeoutMs }) =>
      Effect.gen(function* () {
        yield* validName(id)
        if (command.length === 0)
          return yield* Effect.fail(new MachineRuntime.Error({ message: "Guest command is empty" }))
        const timeout = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Positive)(timeoutMs ?? 30_000),
          catch: () => new MachineRuntime.Error({ message: "Invalid SmolVM timeout" }),
        })
        const completion = `opencode-${crypto.randomUUID()}`
        return yield* run(
          [
            "machine",
            "exec",
            "--name",
            id,
            "--timeout",
            `${timeout}ms`,
            "--",
            "/bin/sh",
            "-c",
            completionScript,
            "opencode-exec",
            completion,
            ...command,
          ],
          timeout + 5000,
          completion,
        )
      }),
    stop: ({ id }) =>
      validName(id).pipe(
        Effect.flatMap(() => run(["machine", "stop", "--name", id], 30_000)),
        Effect.asVoid,
      ),
    destroy: ({ id }) => validName(id).pipe(Effect.flatMap(remove)),
  })
}

function configuration(options: Options) {
  const config = Schema.decodeUnknownSync(Configuration)({
    binary: options.binary ?? Bun.which("smolvm") ?? "smolvm",
    prefix: options.namePrefix ?? "opencode",
    cpus: options.cpus ?? 1,
    memoryMB: options.memoryMB ?? 256,
    dataDirectory: options.dataDirectory,
    diskGB: options.diskGB,
  })
  if (!path.isAbsolute(config.binary)) throw new Error("SmolVM requires an absolute executable path")
  if (config.dataDirectory && !path.isAbsolute(config.dataDirectory))
    throw new Error("SmolVM dataDirectory must be absolute")
  return config
}

class ManagementFailure extends Error {
  constructor(
    readonly code: string,
    stderr: string,
  ) {
    super(stderr)
  }
}

function validName(name: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(Name)(name),
    catch: () => new MachineRuntime.Error({ message: "Invalid machine name" }),
  })
}

// The subprocess exec preserves argv semantics (including names like exit/exec)
// without replacing the wrapper that must report completion. This is a trusted
// guest completion protocol, not an attestation against a compromised guest.
const completionScript =
  'marker=$1; shift; (exec -- "$@"); status=$?; printf "\\n%s:%s\\n" "$marker" "$status" >&2; exit 0'

function decodeResult(result: AppProcess.RunResult, completion: string | undefined, deleting: boolean) {
  return Effect.try({
    try: () => {
      if (result.stdoutTruncated || result.stderrTruncated) throw new Error("SmolVM output truncated; outcome UNKNOWN")
      const stdout = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout)
      const stderr = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stderr)
      if (completion !== undefined) return decodeTask(result.exitCode, stdout, stderr, completion)
      return decodeManagement(result.exitCode, stdout, stderr, deleting)
    },
    catch: (error) =>
      new MachineRuntime.Error({
        message: "SmolVM command incomplete; outcome UNKNOWN",
        cause: error,
      }),
  })
}

function decodeTask(cliExit: number, stdout: string, stderr: string, completion: string) {
  if (cliExit !== 0) throw new Error("SmolVM guest completion unconfirmed; outcome UNKNOWN")
  const start = stderr.lastIndexOf(`\n${completion}:`)
  if (start < 0) throw new Error("POSIX guest completion trailer missing; outcome UNKNOWN")
  const code = stderr.slice(start + completion.length + 2)
  if (!/^(?:0|[1-9][0-9]{0,2})\n$/.test(code) || Number(code) > 255)
    throw new Error("Invalid guest completion trailer; outcome UNKNOWN")
  const original = stderr.slice(0, start)
  if (Buffer.byteLength(original) > OUTPUT_BYTES) throw new Error("Guest stderr exceeds byte limit; outcome UNKNOWN")
  return { stdout, stderr: original, exitCode: Number(code) }
}

function decodeManagement(exitCode: number, stdout: string, stderr: string, deleting: boolean) {
  const management = stderr.split("\n").flatMap((line) => {
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ManagementError))(line)
    return parsed._tag === "Some" ? [parsed.value.error.code] : []
  })
  if (deleting && management.length === 1 && management[0] === "NOT_FOUND") return { stdout, stderr, exitCode: 0 }
  if (management.length > 0) throw new ManagementFailure(management[0], stderr)
  if (exitCode !== 0) throw new Error("SmolVM management failure; outcome UNKNOWN")
  return { stdout, stderr, exitCode }
}
