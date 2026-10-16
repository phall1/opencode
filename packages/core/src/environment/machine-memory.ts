export * as MachineMemory from "./machine-memory.js"

import { MachineRuntime } from "./machine.js"
import { Effect } from "effect"

interface Stored {
  readonly id: string
  readonly provider: string
  state: "running" | "stopped" | "destroyed"
  readonly threads: number
  readonly stdout: readonly string[]
}

export const make = (provider = "memory", options?: { memoryMB?: number }) => {
  const machines = new Map<string, Stored>()
  let next = 0

  const resolve = (id: string) =>
    Effect.gen(function* () {
      const machine = machines.get(id)
      if (!machine || machine.state === "destroyed") yield* Effect.fail(new MachineRuntime.Error({ message: `Machine not found: ${id}` }))
      return machine!
    })

  const result = (machine: Stored, command: readonly string[], timeoutMs?: number) => {
    void timeoutMs
    const exitCode = command.length === 0 ? 0 : command[0] === "fail" ? 1 : 0
    const stdout = exitCode === 0 ? command.slice(1).join(" ") : ""
    const stderr = exitCode === 0 ? "" : `${machine.id}: command failed`
    return { exitCode, stdout, stderr }
  }

  return MachineRuntime.make({
    provider,
    create: ({ image, memoryMB, cpus }) =>
      Effect.sync(() => {
        const id = `${provider}-${++next}`
        machines.set(id, {
          id,
          provider,
          state: "running",
          threads: cpus ?? 1,
          stdout: ["image=" + image, " memoryMB=" + (memoryMB ?? options?.memoryMB ?? 128)],
        })
        return { id }
      }),
    fork: ({ parent, name }) =>
      Effect.gen(function* () {
        const original = machines.get(parent)
        if (!original) yield* Effect.fail(new MachineRuntime.Error({ message: `Parent not found: ${parent}` }))
        const id = name ?? `${provider}-${++next}`
        machines.set(id, { ...original, id })
        return { id }
      }),
    exec: ({ id, command, timeoutMs }) =>
      Effect.gen(function* () {
        const machine = yield* resolve(id)
        if (machine.state !== "running") yield* Effect.fail(new MachineRuntime.Error({ message: `Machine not running: ${id}` }))
        return result(machine, command, timeoutMs)
      }),
    stop: ({ id }) =>
      Effect.gen(function* () {
        const machine = yield* resolve(id)
        machine.state = "stopped"
      }),
    destroy: ({ id }) =>
      Effect.sync(() => {
        const machine = machines.get(id)
        if (machine) machine.state = "destroyed"
      }),
  })
}
