import { Effect } from "effect"

/** Interruption does not return to the caller until the verifier's own cleanup has settled. */
export function awaitVerifier<A>(evaluate: (signal: AbortSignal) => Promise<A>, external?: AbortSignal) {
  return Effect.callback<A>((resume, interrupted) => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, interrupted, external ?? interrupted])
    const pending = Promise.resolve().then(() => evaluate(signal))
    pending.then(
      (value) => resume(Effect.succeed(value)),
      (error: unknown) => resume(Effect.die(error)),
    )
    return Effect.uninterruptible(
      Effect.promise(async () => {
        controller.abort()
        await pending.catch((error: unknown) => {
          // Expected cancellation retains Effect's interruption. Cleanup defects must not disappear.
          if (error !== signal.reason) throw error
        })
      }),
    )
  })
}
