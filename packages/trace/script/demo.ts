import { Effect } from "effect"
import { scenario } from "./fixture"

async function measure(enabled: boolean) {
  const started = performance.now()
  const cpu = process.cpuUsage()
  const result = await Effect.runPromise(scenario(enabled))
  if (result.outcome !== "succeeded" || result.disabledArtifacts) throw new Error("Native fixture failed")
  if (enabled && !result.health.complete) throw new Error("Incomplete trace")
  return {
    result,
    sample: {
      enabled,
      elapsedMs: Math.round(performance.now() - started),
      cpu: process.cpuUsage(cpu),
      rssBytes: process.memoryUsage().rss,
      traceBytes: result.health.bytes,
      queuePeak: result.health.peakRecords,
      queuePeakBytes: result.health.peakBytes,
      drops: result.health.dropped,
      scriptedProviderRequests: result.provider,
      nativeTools: result.tools,
    },
  }
}

const samples: Awaited<ReturnType<typeof measure>>["sample"][] = []
for (let index = 0; index < 5; index++) {
  const off = await measure(false)
  const on = await measure(true)
  if (off.result.context !== on.result.context) throw new Error("Native context changed")
  if (JSON.stringify(off.result.world) !== JSON.stringify(on.result.world)) throw new Error("Native world changed")
  samples.push(off.sample, on.sample)
}
const timings = (enabled: boolean) => {
  const values = samples
    .filter((sample) => sample.enabled === enabled)
    .map((sample) => sample.elapsedMs)
    .sort((a, b) => a - b)
  return { p50Ms: values[2], p95Ms: values[4] }
}
console.log(
  JSON.stringify(
    {
      scope:
        "Five local synthetic SDK pairs; cold/warm mixed, unrepresentative; scripted transport, no live provider or exporter network. RSS is process-wide, CPU is per-sample microseconds.",
      off: timings(false),
      on: timings(true),
      samples,
    },
    null,
    2,
  ),
)
