import { Effect, Schema } from "effect"
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { MAX_BYTES, open, parseJson, save } from "../src/archive"
import { measure } from "../src/measure"
import { openRepo } from "../src/repo-archive"
import { measureRepo } from "../src/repo-measure"
import { compareDirectory } from "../src/repo-report"
import { inspectJournal } from "../src/journal"

const args = process.argv.slice(2)
const [command, file, output] = args
const arities = new Map<string, readonly number[]>([
  ["record", [2]],
  ["replay", [2]],
  ["measure", [3, 4, 5]],
  ["fork", [3, 4]],
  ["experiment", [4, 5]],
  ["isolation", [2]],
  ["compare", [2]],
  ["inspect", [2]],
])
if (!file || !arities.get(command)?.includes(args.length))
  throw new Error(
    "Usage: cli.ts record|replay <capsule.json>; measure <capsule.json> <verifier-id> [--trust-local-code] [--isolated]; fork <capsule.json> <output.json> [--trust-local-code]; experiment <task.json> <new-output-dir> --trust-local-code [--isolated]; compare|inspect <run-dir>; isolation diagnose",
  )

async function recordCommand() {
  const { record } = await import("../src/index")
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const result = await Effect.runPromise(record(file))
  return { file, digest: result.capsule.digest, live: result.live }
}
async function replayCommand() {
  if (isRepo(file)) {
    const { replayRepo } = await import("../src/repo")
    return Effect.runPromise(replayRepo(openRepo(file)))
  }
  const { replay } = await import("../src/index")
  return Effect.runPromise(replay(open(file)))
}
async function measureCommand() {
  if (!output) throw new Error("measure requires a verifier ID")
  if (isRepo(file)) {
    const options = verifierFlags()
    if (output !== "public" && output !== "heldout") throw new Error("Repo verifier must be public or heldout")
    return measureRepo(openRepo(file), output, path.dirname(path.resolve(file)), true, options)
  }
  if (args.length !== 3) throw new Error("Usage: memory measure takes three arguments")
  return measure(open(file), output, path.dirname(path.resolve(file)))
}
async function forkCommand() {
  if (!output) throw new Error("fork requires an output filename")
  if (existsSync(output)) throw new Error(`EEXIST: output exists: ${output}`)
  if (isRepo(file)) {
    if (args[3] !== "--trust-local-code") throw new Error("Requires --trust-local-code")
    const { forkRepo, saveRepo } = await import("../src/repo")
    const directory = `${output}.run`
    mkdirSync(directory)
    const capsule = await Effect.runPromise(forkRepo(openRepo(file), directory, true))
    saveRepo(output, capsule)
    return { file: output, digest: capsule.digest, parent: capsule.manifest.parent }
  }
  if (args.length !== 3) throw new Error("Usage: memory fork takes three arguments")
  const { fork } = await import("../src/index")
  const result = await Effect.runPromise(fork(open(file)))
  save(output, result.capsule)
  return { file: output, ancestry: result.ancestry, isolated: result.isolated }
}
async function experimentCommand() {
  if (!output) throw new Error("experiment requires an output directory")
  const options = verifierFlags()
  const { experiment } = await import("../src/repo")
  return Effect.runPromise(experiment(readBounded(file), output, true, options))
}

function verifierFlags() {
  const flags = args.slice(3)
  if (!flags.includes("--trust-local-code"))
    throw new Error("Requires --trust-local-code (isolated oracle is not tamper-proof)")
  if (
    new Set(flags).size !== flags.length ||
    flags.some((flag) => !["--trust-local-code", "--isolated"].includes(flag))
  )
    throw new Error("Unknown or duplicate verifier flag")
  return { isolation: flags.includes("--isolated") ? ("docker-required" as const) : ("trusted-host" as const) }
}

async function isolationCommand() {
  if (file !== "diagnose") throw new Error("Usage: isolation diagnose (read-only)")
  const { dockerCapability } = await import("../src/verifier-isolation")
  const capability = await dockerCapability()
  return {
    mode: "read-only; no container start or image pull",
    endpoint: capability.endpoint,
    imageID: capability.imageID,
    platform: capability.platform,
    engine: capability.engine,
    bun: capability.bun,
  }
}

function readBounded(file: string) {
  if (statSync(file).size > MAX_BYTES) throw new Error("Input exceeds 8 MiB")
  return parseJson(readFileSync(file, "utf8"))
}
function isRepo(file: string) {
  return (
    Schema.decodeUnknownSync(Schema.Struct({ manifest: Schema.Struct({ profile: Schema.String }) }))(readBounded(file))
      .manifest.profile === "scripted-repo-v1"
  )
}
function inspect(directory: string) {
  return {
    directory,
    mode: "read-only; no resume/retry",
    effects: inspectJournal(directory),
  }
}

const commands = new Map<string, () => unknown>([
  ["record", recordCommand],
  ["replay", replayCommand],
  ["measure", measureCommand],
  ["fork", forkCommand],
  ["experiment", experimentCommand],
  ["compare", () => compareDirectory(file)],
  ["inspect", () => inspect(file)],
  ["isolation", isolationCommand],
])
const run = commands.get(command)
if (!run) throw new Error(`Unknown command: ${command}`)
console.log(JSON.stringify(await run(), null, 2))
