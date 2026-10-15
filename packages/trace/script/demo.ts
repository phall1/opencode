import { Effect } from "effect"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { temporary } from "../../replay/src/scratch"
import { CANARY, scenario } from "./fixture"

if (process.argv.length > 3) throw new Error("Usage: demo.ts [new-output-directory]")
const directory = process.argv[2] ? path.resolve(process.argv[2]) : temporary()
if (process.argv[2]) {
  if (realpathSync(path.dirname(directory)) !== path.dirname(directory))
    throw new Error("Demo output parent must be canonical")
  mkdirSync(directory, { mode: 0o700 })
}
const artifacts: { file: string; digest: string }[] = []

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
  if (on.result.text.includes(CANARY)) throw new Error("Trace contains synthetic sensitive content")
  const file = path.join(directory, `events-${index + 1}.jsonl`)
  writeFileSync(file, on.result.text, { flag: "wx", mode: 0o600 })
  artifacts.push({ file, digest: createHash("sha256").update(on.result.text).digest("hex") })
  samples.push(off.sample, on.sample)
}
const timings = (enabled: boolean) => {
  const values = samples
    .filter((sample) => sample.enabled === enabled)
    .map((sample) => sample.elapsedMs)
    .sort((a, b) => a - b)
  return { p50Ms: values[2], p95Ms: values[4] }
}
const summary = {
  scope:
    "Five local synthetic SDK pairs; cold/warm mixed, unrepresentative; scripted transport, no live provider or exporter network. RSS is process-wide, CPU is per-sample microseconds.",
  directory,
  artifacts,
  off: timings(false),
  on: timings(true),
  samples,
}
writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2), { flag: "wx", mode: 0o600 })
console.log(JSON.stringify(summary, null, 2))
