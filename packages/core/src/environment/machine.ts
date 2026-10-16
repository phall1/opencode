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
   * Portable name of the backend that can create, fork and restore the
   * supplied machine instances, e.g. `smol`, `forkd`, or `cube`.
   */
  readonly provider: string
  /**
   * Create or adopt a base machine from an immutable image. Providers key
   * the resource by `image` and a provider-private name so repeated calls
   * are idempotent.
   */
  readonly create: (input: {
    readonly image: string
    readonly memoryMB?: number
    readonly cpus?: number
  }) => Effect.Effect<{ readonly id: string }, Error>
  /**
   * Create a copy-on-write or restored child from a stopped or warmed
   * parent. Parent identity stays intact; only the returned child mutates.
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
