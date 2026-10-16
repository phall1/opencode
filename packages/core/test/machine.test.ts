import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { MachineRuntime } from "@opencode/core/environment/machine"
import { make } from "@opencode/core/environment/machine-memory"
import { it } from "./lib/effect"

describe("MachineRuntime memory adapter", () => {
  const itLocal = it as any

  itLocal.effect("runs commands and forks children as COW-like state", () =>
    Effect.gen(function* () {
      const runtime = make("memory")
      const parent = yield* runtime.create({ image: "base", cpus: 2 })
      const child = yield* runtime.fork({ parent: parent.id, name: "child" })
      expect(parent.id).not.toBe(child.id)

      const run = yield* runtime.exec({ id: child.id, command: ["echo", "ok"], timeoutMs: 1000 })
      expect(run.exitCode).toBe(0)
      expect(run.stdout).toBe("ok")
      yield* runtime.stop({ id: parent.id })
      yield* runtime.destroy({ id: child.id })
      yield* runtime.destroy({ id: parent.id })
    }),
  )

  itLocal.effect("registry isolates providers and reports unknown names", () =>
    Effect.gen(function* () {
      const registry = MachineRuntime.registry({
        smol: make("smol"),
        forkd: make("forkd"),
      })

      const smol = yield* registry.get("smol")
      const forkd = yield* registry.get("forkd")
      expect(smol.provider).toBe("smol")
      expect(forkd.provider).toBe("forkd")

      const failure = yield* registry.get("cube").pipe(Effect.flip)
      expect(failure._tag).toBe("MachineRuntime.ProviderNotFound")
      expect((failure as any).provider).toBe("cube")
    }),
  )
})
