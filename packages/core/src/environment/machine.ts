export * as MachineRuntime from "./machine.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"

export class Error extends Schema.TaggedError<Error>()("MachineRuntime.Error", {
  message: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class ProviderNotFound extends Schema.TaggedError<ProviderNotFound>()(
  "MachineRuntime.ProviderNotFound",
  { provider: Schema.String },
) {}

export interface Interface {
  /**
   * Backend name for this lifecycle implementation. This port does not itself
   * promise checkpoint/restore support, equivalent isolation or portable images.
   */
  readonly provider: string
  /**
   * Allocate a new base machine. Repeated calls are not inherently idempotent:
   * an ambiguous result requires reconciling the driver's recorded resource
   * intent, not blindly repeating create. Image preparation is backend-specific.
   */
  readonly create: (input: {
    readonly image: string
    readonly memoryMB?: number
    readonly cpus?: number
  }) => Effect.Effect<{ readonly id: string }, Error>
  /**
   * Create a child without changing the parent's identity. The backend owns
   * readiness requirements and must document exactly which state is copied,
   * shared or excluded; this type alone does not prove full-world isolation.
   */
  readonly fork: (input: { readonly parent: string; readonly name?: string }) =>
    Effect.Effect<{ readonly id: string }, Error>
  /**
   * Run a command in one instance. Nothing here assumes an interactive shell,
   * pager, terminal or agent loop beyond the underlying provider.
   */
  readonly exec: (input: {
    readonly id: string
    readonly command: readonly string[]
    readonly timeoutMs?: number
  }) => Effect.Effect<
    { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
    Error
  >
  readonly stop: (input: { readonly id: string }) => Effect.Effect<void, Error>
  readonly destroy: (input: { readonly id: string }) => Effect.Effect<void, Error>
}

export const make = (runtime: Interface) => runtime

export interface Registry {
  readonly get: (provider: string) => Effect.Effect<Interface, ProviderNotFound>
}

export class RegistryService extends Context.Service<RegistryService, Registry>()(
  "@opencode/MachineRuntimeRegistry",
) {}

export const registry = (runtimes: Readonly<Record<string, Interface>>): Registry => ({
  get: (provider) => {
    const runtime = Object.hasOwn(runtimes, provider) ? runtimes[provider] : undefined
    return runtime ? Effect.succeed(runtime) : Effect.fail(new ProviderNotFound({ provider }))
  },
})

export const registryNode = (runtimes: Readonly<Record<string, Interface>>) =>
  makeGlobalNode({
    service: RegistryService,
    layer: Layer.succeed(RegistryService, RegistryService.of(registry(runtimes))),
    deps: [],
  })

export const node = registryNode({})
