export * as MachineSmolVM from "./machine-smolvm.js"

import { MachineRuntime } from "./machine.js"
import { ChildProcess } from "effect/process"
import { Effect } from "effect"
import { AppProcess } from "@opencode/util/process"

export interface Options {
  readonly processes: AppProcess.Interface
  readonly binary?: string
  readonly namePrefix?: string
  readonly cpus?: number
  readonly memoryMB?: number
}

export const make = (options: Options) => {
  const binary = options.binary ?? "smolvm"
  const prefix = options.namePrefix ?? "opencode"
  const cpus = options.cpus ?? 1
  const memoryMB = options.memoryMB ?? 256
  const names = new Map<string, string>()
  const fresh = () => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

  const machineError = (error: unknown) =>
    error instanceof MachineRuntime.Error
      ? error
      : new MachineRuntime.Error({ message: error instanceof Error ? error.message : String(error) })

  const run = (args: readonly string[], timeoutMs = 30_000) =>
    options.processes.run(ChildProcess.make(binary, args, { stdin: "ignore" }), {
      timeout: `${timeoutMs} millis`,
    }).pipe(
      Effect.mapError(machineError),
      Effect.flatMap((result) => {
        const typed = result as { readonly exitCode: number; readonly stdout: Buffer; readonly stderr: Buffer }
        const stdout = typed.stdout.toString("utf8")
        const stderr = typed.stderr.toString("utf8")
        if (typed.exitCode !== 0) {
          return Effect.fail(new MachineRuntime.Error({
            message: stderr.trim() || stdout.trim() || `${binary} exited with code ${typed.exitCode}`,
          }))
        }
        return Effect.succeed({ stdout, stderr, code: typed.exitCode })
      }),
    )

  return MachineRuntime.make({
    provider: "smolvm",
    create: ({ image, cpus: requestedCpus, memoryMB: requestedMemory }) =>
      Effect.gen(function* () {
        const name = fresh()
        yield* run(["machine", "create", "--name", name, "--image", image,
          "--cpus", String(requestedCpus ?? cpus),
          "--mem", String(requestedMemory ?? memoryMB),
        ])
        yield* run(["machine", "start", "--name", name, "--branchable"])
        names.set(name, name)
        return { id: name }
      }),
    fork: ({ parent, name }) =>
      Effect.gen(function* () {
        const child = name ?? fresh()
        yield* run(["machine", "branch", "--from", parent, "--name", child], 15_000)
        return { id: child }
      }),
    exec: ({ id, command, timeoutMs }) =>
      Effect.gen(function* () {
        const result = yield* run(
          ["machine", "exec", "--name", id, "--", ...command],
          timeoutMs ?? 30_000,
        )
        return {
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        }
      }),
    stop: ({ id }) => run(["machine", "stop", "--name", id], 30_000).pipe(Effect.asVoid),
    destroy: ({ id }) => run(["machine", "delete", "--name", id, "--force"], 30_000).pipe(Effect.asVoid),
  })
}
