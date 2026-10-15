/** Bounded direct subprocess capture; never invokes a shell. */
export async function runProcess(
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number,
  outputBytes: number,
  options: { cwd?: string; signal?: AbortSignal; stopOnOverflow?: boolean } = {},
) {
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const child = Bun.spawn(argv, { cwd: options.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const abort = new AbortController()
  let timedOut = false
  const stop = () => {
    child.kill(9)
    abort.abort()
  }
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  signal.addEventListener("abort", stop, { once: true })
  try {
    const overflow = options.stopOnOverflow ? stop : () => undefined
    const [stdout, stderr, exitCode] = await Promise.all([
      capture(child.stdout, outputBytes, abort.signal, overflow),
      capture(child.stderr, outputBytes, abort.signal, overflow),
      child.exited,
    ])
    signal.throwIfAborted()
    return { stdout, stderr, exitCode, timedOut, truncated: stdout.truncated || stderr.truncated }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", stop)
    if (child.exitCode === null) stop()
    await child.exited
  }
}

async function capture(stream: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal, overflow: () => void) {
  const reader = stream.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const remaining = Math.max(0, limit - total)
      if (remaining > 0) chunks.push(next.value.subarray(0, remaining))
      total += next.value.length
      if (total > limit) overflow()
    }
  } finally {
    signal.removeEventListener("abort", cancel)
  }
  const bytes = Buffer.concat(chunks)
  const text = bytes.toString("utf8")
  return {
    text: new TextDecoder().decode(Buffer.from(text).subarray(0, limit), { stream: true }),
    bytes,
    truncated: total > limit || Buffer.byteLength(text) > limit,
  }
}
