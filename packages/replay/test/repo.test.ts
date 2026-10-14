import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { Environment } from "@opencode/core/environment/index"
import { Agent } from "@opencode/schema/agent"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"
import { NativeExport, durableWrite, encode, hash, parseJson, type ToolEntry } from "../src/archive"
import {
  RepoCapsule,
  freezeRepo,
  openRepo,
  repoBlob,
  repoContext,
  repoFiles,
  repoTools,
  saveRepo,
  validateRepo,
} from "../src/repo-archive"
import { demoTask, experiment, forkRepo, replayRepo } from "../src/repo"
import { RepoMeasurement, measureRepo, verifyFiles } from "../src/repo-measure"
import { compareDirectory, compareRepo } from "../src/repo-report"
import { decodeTask } from "../src/repo-task"
import { diskWorld, snapshotDisk } from "../src/repo-world"
import { SESSION_ID } from "../src/runtime"
import { temporary } from "../src/scratch"
import { ToolTape } from "../src/tape"
import { inspectJournal, requireJournalComplete } from "../src/journal"
import { parseJunit, readVerifierReport } from "../src/repo-junit"

const root = temporary()
const directory = path.join(root, "experiment")
let checkpoint: RepoCapsule
let general: RepoCapsule
let overfit: RepoCapsule
beforeAll(async () => {
  await Effect.runPromise(experiment(demoTask, directory, true))
  checkpoint = openRepo(path.join(directory, "checkpoint.json"))
  general = openRepo(path.join(directory, "general.json"))
  overfit = openRepo(path.join(directory, "overfit.json"))
}, 60_000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

function replace(
  capsule: RepoCapsule,
  key: "tools" | "http" | "context" | "initial" | "checkpoint" | "parent",
  text: string,
) {
  const id = hash(text)
  const manifest = { ...capsule.manifest, [key]: id }
  const blobs = Object.fromEntries(
    Object.entries(capsule.blobs).filter(
      ([id]) => id !== capsule.manifest[key] || Object.values(manifest).includes(id),
    ),
  )
  return freezeRepo(manifest, { ...blobs, [id]: text })
}
function retape(capsule: RepoCapsule, tools: readonly ToolEntry[]) {
  return replace(
    { ...capsule, manifest: { ...capsule.manifest, evidence: { ...capsule.manifest.evidence, tools: tools.length } } },
    "tools",
    encode(tools),
  )
}
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../script/cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}
function measurements() {
  return readdirSync(directory)
    .filter((file) => /^measurement-[a-f0-9-]+\.json$/.test(file))
    .map((file) =>
      Schema.decodeUnknownSync(Schema.fromJsonString(RepoMeasurement))(
        readFileSync(path.join(directory, file), "utf8"),
      ),
    )
}

describe("trusted synthetic disk repository", () => {
  test("native assessment is a pre-edit idle checkpoint with independently failing baseline", () => {
    expect(repoFiles(checkpoint, "initial")).toEqual(demoTask.files)
    expect(repoFiles(checkpoint, "checkpoint")).toEqual(demoTask.files)
    expect(repoTools(checkpoint).map((entry) => entry.name)).toEqual(["read", "read", "read"])
    expect(repoContext(checkpoint).messages.at(-1)?.type).toBe("idle")
    expect(repoContext(checkpoint).info.outcome).toBe("succeeded")
    expect(measurements().find((measurement) => measurement.episode === checkpoint.digest)?.status).toBe("test-failed")
    expect(parseJson(readFileSync(path.join(directory, "completed.json"), "utf8"))).toMatchObject({
      originalUnchanged: true,
    })
  })

  test("two native forks inherit the same frozen prefix and independently repair real disk files", () => {
    expect(general.manifest.parent).toBe(overfit.manifest.parent)
    expect(general.manifest.initial).toBe(checkpoint.manifest.checkpoint)
    expect(repoContext(general).info.fork?.sessionID).toBe(SESSION_ID)
    expect(repoContext(overfit).info.fork?.sessionID).toBe(SESSION_ID)
    expect(repoFiles(general, "checkpoint")["slug.ts"]).toBe(
      demoTask.policies.general[0].kind === "write" ? demoTask.policies.general[0].content : "",
    )
    expect(repoFiles(overfit, "checkpoint")["slug.ts"]).not.toBe(repoFiles(general, "checkpoint")["slug.ts"])
    expect(repoFiles(checkpoint, "checkpoint")).toEqual(demoTask.files)
    expect(general.manifest.evidence).toMatchObject({
      provider: 2,
      requests: 2,
      tools: 1,
      outcome: "succeeded",
      elapsedScope: "cold prefix restore+fork+new rollout",
    })
    const usage = Schema.decodeUnknownSync(
      Schema.Struct({ messages: Schema.Array(Schema.Unknown), priceUSD: Schema.Null }),
    )(general.manifest.evidence.nativeUsage)
    expect(usage.messages.length).toBe(2)
    expect(usage.priceUSD).toBeNull()
  })

  test("known reference passes but plausible overfit fails independent heldout while smoke passes", async () => {
    const observed = measurements()
    expect(observed.filter((result) => result.episode === general.digest).map((result) => result.status)).toEqual([
      "passed",
      "passed",
    ])
    expect(
      observed
        .filter((result) => result.episode === overfit.digest)
        .map((result) => result.status)
        .sort(),
    ).toEqual(["passed", "test-failed"])
    const again = await verifyFiles(demoTask, repoFiles(general, "checkpoint"), "heldout", true)
    expect(again.passed).toBe(true)
    expect(again.testSource).toBe(hash(demoTask.verifier.testSource))
    expect(again.containment).toContain("UNSUPPORTED")
  })

  test("hidden verifier source and host actor paths never enter provider or context evidence", () => {
    ;[checkpoint, general, overfit].forEach((capsule) => {
      const observed = repoBlob(capsule, capsule.manifest.http) + repoBlob(capsule, capsule.manifest.context)
      expect(observed).not.toContain("heldout multiple whitespace")
      expect(observed).not.toContain(root)
      expect(observed).not.toContain("assessment-world")
      expect(Object.keys(repoFiles(capsule, "checkpoint"))).not.toContain("heldout.test.ts")
    })
  })

  test("dynamic repo paths never consult ambient host instructions or fixture filesystem", async () => {
    const target = path.join(root, "ambient")
    mkdirSync(target)
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/ambient.ts"), target, "repo"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    expect(parseJson(stdout)).toMatchObject({
      clean: true,
      observations: { resolve: 0, up: 0, read: 0, directory: 0, stat: 0 },
    })
  }, 60_000)

  test("disk adapter actually edits disk, rejects symlinks and prevents fallback operations", async () => {
    const actor = path.join(root, "adapter")
    const driver = diskWorld(actor, demoTask, demoTask.files)
    const files = Environment.makeFiles(driver)
    await Effect.runPromise(files.write("/fixture/slug.ts", new TextEncoder().encode("changed on disk\n")))
    expect(readFileSync(path.join(actor, "slug.ts"), "utf8")).toBe("changed on disk\n")
    expect(snapshotDisk(actor, demoTask)["slug.ts"]).toBe("changed on disk\n")
    await expect(Effect.runPromise(files.write("/fixture/smoke.test.ts", new Uint8Array()))).rejects.toThrow(
      "Undeclared mutable",
    )
    await expect(Effect.runPromise(files.read("/etc/passwd"))).rejects.toThrow("Out-of-scope")
    await expect(Effect.runPromise(files.remove("/fixture/slug.ts"))).rejects.toThrow("Unsupported")
    await expect(Effect.runPromise(files.move("/fixture/slug.ts", "/fixture/new.ts"))).rejects.toThrow("Unsupported")
    await expect(Effect.runPromise(files.mkdir("/fixture/new"))).rejects.toThrow("Unsupported")
    unlinkSync(path.join(actor, "slug.ts"))
    symlinkSync(path.join(actor, "smoke.test.ts"), path.join(actor, "slug.ts"))
    await expect(Effect.runPromise(files.read("/fixture/slug.ts"))).rejects.toThrow("Symlink")
    expect(() => snapshotDisk(actor, demoTask)).toThrow("Symlink")
    const nestedTask = decodeTask({ ...demoTask, files: { ...demoTask.files, "nested/value.ts": "value\n" } })
    const nested = path.join(root, "nested-adapter")
    const nestedFiles = Environment.makeFiles(diskWorld(nested, nestedTask, nestedTask.files))
    rmSync(path.join(nested, "nested"), { recursive: true })
    symlinkSync(actor, path.join(nested, "nested"))
    await expect(Effect.runPromise(nestedFiles.read("/fixture/nested/value.ts"))).rejects.toThrow("Symlink")
  })
})

describe("strict disk profile replay and archive integrity", () => {
  test("child cold replay across Bun processes consumes ancestry with zero live capabilities", async () => {
    const result = await cli("replay", path.join(directory, "general.json"))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(parseJson(result.stdout)).toMatchObject({
      equal: true,
      live: { provider: 0, tool: 0, world: 0, process: 0 },
      consumed: { http: 6, tool: 4 },
    })
    const second = await Effect.runPromise(replayRepo(overfit))
    expect(second.live).toEqual({ provider: 0, tool: 0, world: 0, process: 0 })
  }, 60_000)

  test("self-hashed hidden verifier code cannot execute during strict replay or bypass measurement trust", async () => {
    const marker = path.join(root, "must-not-execute.txt")
    const taskText = encode({
      ...demoTask,
      verifier: {
        ...demoTask.verifier,
        testSource: `await Bun.write(${JSON.stringify(marker)}, "executed")\nthrow new Error("strict replay must not run this")\n`,
      },
    })
    const taskID = hash(taskText)
    const parentBlobs = { ...checkpoint.blobs, [taskID]: taskText }
    delete parentBlobs[checkpoint.manifest.task]
    const parent = freezeRepo({ ...checkpoint.manifest, task: taskID }, parentBlobs)
    const parentText = encode(parent)
    const childBlobs = { ...general.blobs, [taskID]: taskText, [hash(parentText)]: parentText }
    delete childBlobs[general.manifest.task]
    if (!general.manifest.parent) throw new Error("Expected parent")
    delete childBlobs[general.manifest.parent]
    const child = freezeRepo({ ...general.manifest, task: taskID, parent: hash(parentText) }, childBlobs)
    const file = path.join(root, "self-hashed.json")
    saveRepo(file, child)
    expect((await cli("replay", file)).code).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect((await cli("measure", file, "heldout")).stderr).toContain("trust-local-code")
    expect(existsSync(marker)).toBe(false)
  }, 60_000)

  test("missing, mismatched, unused and malformed native tapes fail closed", async () => {
    await expect(Effect.runPromise(Effect.suspend(() => replayRepo(retape(general, []))))).rejects.toThrow()
    const entries = repoTools(general)
    await expect(
      Effect.runPromise(
        Effect.suspend(() =>
          replayRepo(retape(general, [{ ...entries[0], input: { path: "/fixture/slug.ts", content: "mismatch" } }])),
        ),
      ),
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(
        Effect.suspend(() => replayRepo(retape(general, [...entries, { ...entries[0], occurrence: 2 }]))),
      ),
    ).rejects.toThrow("unused")
    expect(() => replace(general, "tools", "null")).toThrow()
    expect(() => replace(general, "tools", encode([{ ...entries[0], outcome: { status: "UNKNOWN" } }]))).toThrow()
  }, 60_000)

  test("HTTP mismatches, missing and unused results cannot fall back to live provider", async () => {
    await expect(
      Effect.runPromise(
        replayRepo(freezeRepo({ ...general.manifest, prompt: "changed request" }, { ...general.blobs })),
      ),
    ).rejects.toThrow()
    const schema = Schema.Struct({
      version: Schema.Int,
      metadata: Schema.Json,
      interactions: Schema.Array(Schema.Json),
    })
    const tape = Schema.decodeUnknownSync(Schema.fromJsonString(schema))(repoBlob(general, general.manifest.http))
    expect(() => replace(general, "http", encode({ ...tape, interactions: [null, null] }))).toThrow()
    await expect(
      Effect.runPromise(
        Effect.suspend(() => replayRepo(replace(general, "http", encode({ ...tape, interactions: [] })))),
      ),
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(
        Effect.suspend(() =>
          replayRepo(
            replace(general, "http", encode({ ...tape, interactions: [...tape.interactions, tape.interactions[0]] })),
          ),
        ),
      ),
    ).rejects.toThrow("HTTP evidence")
  }, 60_000)

  test("parent tampering, invalid idle states and mismatched worlds are refused", () => {
    expect(() =>
      replace(
        general,
        "parent",
        encode({ ...checkpoint, blobs: { ...checkpoint.blobs, [checkpoint.manifest.checkpoint]: "tamper" } }),
      ),
    ).toThrow("digest")
    expect(() => replace(general, "initial", encode(repoFiles(general, "checkpoint")))).toThrow("checkpoint mismatch")
    expect(() => validateRepo({ ...general, manifest: { ...general.manifest, state: "started" } })).toThrow()
    expect(() =>
      replace(general, "checkpoint", encode({ ...repoFiles(general, "checkpoint"), "../escape.ts": "outside" })),
    ).toThrow()
    expect(() =>
      replace(general, "checkpoint", encode({ ...repoFiles(general, "checkpoint"), "extra.ts": "undeclared" })),
    ).toThrow("paths differ")
    const context = repoContext(general)
    expect(() =>
      replace(
        general,
        "context",
        encode(Schema.encodeSync(NativeExport)({ ...context, messages: context.messages.slice(0, -1) })),
      ),
    ).toThrow("idle")
    expect(() =>
      validateRepo({ ...general, blobs: { ...general.blobs, [general.manifest.tools]: "missing receipt" } }),
    ).toThrow("digest")
  })

  test("ordinary fork command dispatches repo capsules and the grandchild cold-replays", async () => {
    const target = path.join(root, "grandchild.json")
    const result = await cli("fork", path.join(directory, "general.json"), target, "--trust-local-code")
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    const child = openRepo(target)
    expect(child.manifest.initial).toBe(general.manifest.checkpoint)
    expect((await Effect.runPromise(replayRepo(child))).consumed).toEqual({ http: 8, tool: 5 })
  }, 60_000)
})

describe("task trust, bounded verification and append-only reports", () => {
  test("schema rejects traversal, absolute paths, commands, undeclared writes and hidden actor files", () => {
    const unsafe = [
      "../slug.ts",
      "/slug.ts",
      "dir/../slug.ts",
      "dir\\slug.ts",
      "heldout.test.ts",
      "node_modules/pkg.ts",
    ]
    unsafe.forEach((file) =>
      expect(() => decodeTask({ ...demoTask, files: { ...demoTask.files, [file]: "bad" } })).toThrow(),
    )
    expect(() => decodeTask({ ...demoTask, command: "sh -c anything" })).toThrow()
    expect(() => decodeTask({ ...demoTask, verifier: { ...demoTask.verifier, command: ["bun", "test"] } })).toThrow()
    expect(() => decodeTask({ ...demoTask, writePaths: ["undeclared.ts"] })).toThrow()
    expect(() => decodeTask({ ...demoTask, writePaths: ["smoke.test.ts"] })).toThrow()
    expect(() =>
      decodeTask({
        ...demoTask,
        policies: {
          ...demoTask.policies,
          general: [
            { kind: "write", path: "outside.ts", content: "bad" },
            { kind: "text", text: "done" },
          ],
        },
      }),
    ).toThrow()
    expect(() => decodeTask({ ...demoTask, budgets: { ...demoTask.budgets, requests: 2 } })).toThrow("Assessment")
    expect(() => decodeTask({ ...demoTask, files: { ...demoTask.files, "slug.ts": "\ud800" } })).toThrow("UTF-8")
    expect(() => decodeTask({ ...demoTask, files: { ...demoTask.files, "slug.ts": "\u0000" } })).toThrow("UTF-8")
    expect(() =>
      decodeTask({ ...demoTask, files: { ...demoTask.files, "slug.ts": "x".repeat(demoTask.budgets.fileBytes + 1) } }),
    ).toThrow("budget")
  })

  test("forged built-in IDs and complete self-hashed capsules still require explicit executable trust", async () => {
    const forged = { ...demoTask, trusted: true }
    expect(() => decodeTask(forged)).toThrow()
    await expect(Effect.runPromise(experiment(demoTask, path.join(root, "untrusted"), false))).rejects.toThrow(
      "trust-local-code",
    )
    expect(existsSync(path.join(root, "untrusted"))).toBe(false)
    await expect(measureRepo(general, "heldout", directory, false)).rejects.toThrow("trust-local-code")
    const custom = path.join(root, "trusted-id-task.json")
    durableWrite(custom, encode(demoTask))
    expect((await cli("experiment", custom, path.join(root, "no-trust"), "--trusted=true")).stderr).toContain(
      "trust-local-code",
    )
    expect((await cli("measure", path.join(directory, "general.json"), "heldout")).stderr).toContain("trust-local-code")
    const ledger = path.join(root, "no-trust-fork")
    mkdirSync(ledger)
    await expect(Effect.runPromise(forkRepo(general, ledger, false))).rejects.toThrow("trust-local-code")
  })

  test("verifier distinguishes nonzero exit, timeout and output truncation", async () => {
    const nonzero = await verifyFiles(demoTask, demoTask.files, "public", true)
    expect(nonzero.status).toBe("test-failed")
    expect(nonzero.exitCode).not.toBe(0)
    const timed = await verifyFiles(
      {
        ...demoTask,
        budgets: { ...demoTask.budgets, timeoutMs: 100 },
        verifier: { ...demoTask.verifier, testSource: "while (true) {}\n" },
      },
      demoTask.files,
      "heldout",
      true,
    )
    expect(timed.status).toBe("timeout")
    expect(timed.timedOut).toBe(true)
    const truncated = await verifyFiles(
      {
        ...demoTask,
        budgets: { ...demoTask.budgets, outputBytes: 64 },
        verifier: {
          ...demoTask.verifier,
          testSource: 'import { test } from "bun:test"\ntest("output", () => console.log("x".repeat(10000)))\n',
        },
      },
      demoTask.files,
      "heldout",
      true,
    )
    expect(truncated.status).toBe("output-truncated")
    expect(truncated.truncated).toBe(true)
    expect(Buffer.byteLength(truncated.stdout)).toBeLessThanOrEqual(64)
    const unicode = await verifyFiles(
      {
        ...demoTask,
        budgets: { ...demoTask.budgets, outputBytes: 65 },
        verifier: {
          ...demoTask.verifier,
          testSource:
            'import { test } from "bun:test"\ntest("output", () => process.stdout.write(Buffer.alloc(10000, 255)))\n',
        },
      },
      demoTask.files,
      "heldout",
      true,
    )
    expect(unicode.status).toBe("output-truncated")
    expect(Buffer.byteLength(unicode.stdout)).toBeLessThanOrEqual(65)
  })

  test("trusted task JSON CLI runs the full configured experiment without installation", async () => {
    const task = path.join(root, "custom-task.json")
    const output = path.join(root, "custom-experiment")
    durableWrite(task, encode({ ...demoTask, id: "custom-slug-v1" }))
    const result = await cli("experiment", task, output, "--trust-local-code")
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(openRepo(path.join(output, "general.json")).manifest.policy).toBe("general")
    const noInstall = await verifyFiles(
      {
        ...demoTask,
        verifier: { ...demoTask.verifier, testSource: 'import "replay-definitely-absent-package-9381"\n' },
      },
      demoTask.files,
      "heldout",
      true,
    )
    expect(noInstall.status).toBe("test-failed")
    expect(noInstall.stderr).toContain("Cannot find")
  }, 60_000)

  test("verifier gets a separate HOME and no ambient credentials or environment", async () => {
    const task = {
      ...demoTask,
      verifier: {
        ...demoTask.verifier,
        testSource:
          'import { test, expect } from "bun:test"\ntest("clean env", () => { expect(process.env.OPENAI_API_KEY).toBeUndefined(); expect(process.env.PATH).toBeUndefined(); expect(process.env.HOME).not.toBe("' +
          process.env.HOME +
          '"); expect(process.cwd()).not.toContain("assessment-world") })\n',
      },
    }
    expect((await verifyFiles(task, demoTask.files, "heldout", true)).passed).toBe(true)
  })

  test("remeasure does not mutate any capsule; reports include every separately frozen measurement", async () => {
    const files = ["checkpoint.json", "general.json", "overfit.json"].map((file) => path.join(directory, file))
    const before = files.map((file) => readFileSync(file, "utf8"))
    const one = await measureRepo(general, "heldout", directory, true)
    const two = await measureRepo(general, "heldout", directory, true)
    expect(one.id).not.toBe(two.id)
    expect(one.implementation).toBe(hash(readFileSync(path.join(import.meta.dir, "../src/repo-measure.ts"), "utf8")))
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before)
    const report = compareDirectory(directory)
    const json = Schema.decodeUnknownSync(
      Schema.Struct({
        continuations: Schema.Array(
          Schema.Struct({ policy: Schema.String, measurements: Schema.Array(RepoMeasurement) }),
        ),
      }),
    )(parseJson(readFileSync(report.file, "utf8")))
    expect(json.continuations.find((entry) => entry.policy === "general")?.measurements.length).toBe(4)
    expect(readFileSync(report.markdown, "utf8")).toContain("UNKNOWN / not measured")
    expect(readFileSync(report.markdown, "utf8")).toContain("test-failed")
    expect((await cli("compare", directory)).code).toBe(0)
    const missing = path.join(directory, "measurement-unknown.started.json")
    durableWrite(missing, encode({ state: "started; missing receipt means UNKNOWN" }))
    expect(() => compareDirectory(directory)).toThrow("UNKNOWN")
    unlinkSync(missing)
  })

  test("CLI refuses invalid argument counts and existing outputs before writing", async () => {
    expect((await cli("replay", path.join(directory, "general.json"), "extra")).stderr).toContain("Usage:")
    const before = readFileSync(path.join(directory, "general.json"), "utf8")
    expect(
      (
        await cli(
          "fork",
          path.join(directory, "checkpoint.json"),
          path.join(directory, "general.json"),
          "--trust-local-code",
        )
      ).stderr,
    ).toContain("EEXIST")
    expect(readFileSync(path.join(directory, "general.json"), "utf8")).toBe(before)
    await expect(Effect.runPromise(experiment(demoTask, directory, true))).rejects.toThrow("EEXIST")
    expect(() => saveRepo(path.join(directory, "general.json"), general)).toThrow("EEXIST")
  })

  test("comparison cannot contradict its linked saved measurement receipt", () => {
    const stored = measurements()
    const baseline = stored.find((entry) => entry.episode === checkpoint.digest)
    const passing = stored.find((entry) => entry.episode === general.digest && entry.scope === "heldout")
    const publicCheck = stored.find((entry) => entry.episode === overfit.digest && entry.scope === "public")
    const heldout = stored.find((entry) => entry.episode === overfit.digest && entry.scope === "heldout")
    if (!baseline || !passing || !publicCheck || !heldout) throw new Error("Missing complete verifier evidence")
    const contradiction = {
      ...heldout,
      report: passing.report,
      status: passing.status,
      passed: passing.passed,
      exitCode: passing.exitCode,
    }
    expect(() =>
      compareRepo(checkpoint, baseline, [{ capsule: overfit, public: publicCheck, heldout: contradiction }], directory),
    ).toThrow("differs from saved receipt")
    const report = compareRepo(checkpoint, baseline, [{ capsule: overfit, public: publicCheck, heldout }], directory)
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        continuations: Schema.Array(
          Schema.Struct({ measurements: Schema.Array(Schema.Struct({ file: Schema.String, digest: Schema.String })) }),
        ),
      }),
    )(parseJson(readFileSync(report.file, "utf8")))
    result.continuations[0].measurements.forEach((entry) =>
      expect(entry.digest).toBe(hash(readFileSync(path.join(directory, entry.file), "utf8"))),
    )
  })

  test("comparison refuses missing verifier scopes and mismatched measurement source or limit status", () => {
    const stored = measurements()
    const baseline = stored.find((entry) => entry.episode === checkpoint.digest)
    const publicCheck = stored.find((entry) => entry.episode === general.digest && entry.scope === "public")
    const heldout = stored.find((entry) => entry.episode === general.digest && entry.scope === "heldout")
    if (!baseline || !publicCheck || !heldout) throw new Error("Missing complete verifier evidence")
    expect(() =>
      compareRepo(checkpoint, baseline, [{ capsule: general, public: publicCheck, heldout: publicCheck }], directory),
    ).toThrow("Incomplete heldout")
    expect(() =>
      compareRepo(
        checkpoint,
        baseline,
        [{ capsule: general, public: publicCheck, heldout: { ...heldout, testSource: "0".repeat(64) } }],
        directory,
      ),
    ).toThrow("source mismatch")
    expect(() =>
      compareRepo(
        checkpoint,
        baseline,
        [{ capsule: general, public: publicCheck, heldout: { ...heldout, timedOut: true } }],
        directory,
      ),
    ).toThrow("status mismatch")
  })
})

const toolContext: Tool.Context = {
  sessionID: SESSION_ID,
  agent: Agent.ID.make("fixture"),
  messageID: SessionMessage.ID.make("msg_repo"),
  id: Tool.CallID.make("call_repo"),
  progress: () => Effect.void,
}
describe("write-ahead uncertainty ledger", () => {
  test("effect commits then receipt write fails: UNKNOWN, no second execution and no success entry", async () => {
    const ledger = path.join(root, "unknown")
    mkdirSync(ledger)
    let calls = 0
    const tape = new ToolTape(
      "record",
      ledger,
      [],
      { read: ["/fixture/slug.ts"], write: ["/fixture/slug.ts"] },
      (file, text) => {
        if (!file.endsWith(".started.json")) throw new Error("Injected fsync/receipt failure")
        durableWrite(file, text)
      },
    )
    const execute = tape.wrap("write", () =>
      Effect.sync(() => {
        calls++
        durableWrite(path.join(ledger, "committed.txt"), "committed")
        return { content: "written" }
      }),
    )
    const first = await Effect.runPromise(
      Effect.exit(execute({ path: "/fixture/slug.ts", content: "changed" }, toolContext)),
    )
    expect(Exit.isFailure(first)).toBe(true)
    expect(tape.uncertain).toBe(true)
    expect(tape.entries).toEqual([])
    expect(calls).toBe(1)
    expect(existsSync(path.join(ledger, "committed.txt"))).toBe(true)
    expect(existsSync(path.join(ledger, "tool-1.json"))).toBe(false)
    await expect(
      Effect.runPromise(execute({ path: "/fixture/slug.ts", content: "again" }, toolContext)),
    ).rejects.toThrow("UNKNOWN")
    expect(calls).toBe(1)
    expect(() => tape.assertComplete()).toThrow("UNKNOWN")
    const inspection = await cli("inspect", ledger)
    expect(inspection.code).toBe(0)
    expect(inspection.stdout).toContain("UNKNOWN; must not repeat")
    expect(() => openRepo(path.join(ledger, "tool-1.started.json"))).toThrow()
    expect(() => compareDirectory(ledger)).toThrow()
  })

  test("defects and interruption remain failures, not captured ordinary tool errors", async () => {
    const ledger = path.join(root, "defect")
    mkdirSync(ledger)
    const tape = new ToolTape("record", ledger)
    const result = await Effect.runPromise(
      Effect.exit(
        tape.wrap("write", () => Effect.die("native defect"))(
          { path: "/fixture/repair.txt", content: "no" },
          toolContext,
        ),
      ),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(tape.entries.length).toBe(0)
    expect(tape.uncertain).toBe(true)
    const interrupted = path.join(root, "interrupted")
    mkdirSync(interrupted)
    const other = new ToolTape("record", interrupted)
    expect(
      Exit.isFailure(
        await Effect.runPromise(
          Effect.exit(other.wrap("read", () => Effect.interrupt)({ path: "/fixture/repair.txt" }, toolContext)),
        ),
      ),
    ).toBe(true)
    expect(other.entries).toEqual([])
    expect(() => other.assertComplete()).toThrow("UNKNOWN")
  })
})

describe("native verifier completion evidence", () => {
  test("early successful exit, empty verifier, all skipped and zero assertions cannot pass", async () => {
    const sources = [
      "process.exit(0)\n",
      "// no assertions\n",
      'import { test } from "bun:test"\ntest.skip("skip", () => {})\n',
      'import { test } from "bun:test"\ntest("empty", () => {})\n',
    ]
    for (const testSource of sources) {
      const result = await verifyFiles(
        { ...demoTask, verifier: { ...demoTask.verifier, testSource } },
        demoTask.files,
        "heldout",
        true,
      )
      expect(result.exitCode).toBe(0)
      expect(result.status).toBe("verifier-incomplete")
      expect(result.passed).toBe(false)
    }
  })

  test("ordinary pass/fail freezes native report, digest, counts and provenance", async () => {
    const pass = await verifyFiles(demoTask, repoFiles(general, "checkpoint"), "heldout", true)
    const fail = await verifyFiles(demoTask, demoTask.files, "heldout", true)
    expect(pass.status).toBe("passed")
    expect(fail.status).toBe("test-failed")
    expect(pass.report.counts).toMatchObject({ tests: 2, assertions: 2, failures: 0, skipped: 0 })
    expect(fail.report.counts?.failures).toBeGreaterThan(0)
    expect(pass.report.digest).toBe(hash(pass.report.raw ?? ""))
    expect(pass.report.provenance).toContain("not tamper-proof")
    expect(pass.report.parser).toBe(hash(readFileSync(path.join(import.meta.dir, "../src/repo-junit.ts"), "utf8")))
  })

  test("missing, malformed, inconsistent, symlink and directory reports are not completion evidence", () => {
    const target = path.join(root, "report-evidence")
    mkdirSync(target)
    expect(readVerifierReport(path.join(target, "missing.xml")).state).toBe("missing")
    const malformed = path.join(target, "malformed.xml")
    durableWrite(malformed, "<testsuites>truncated")
    expect(readVerifierReport(malformed).state).toBe("malformed")
    symlinkSync(malformed, path.join(target, "symlink.xml"))
    expect(readVerifierReport(path.join(target, "symlink.xml")).state).toBe("unsafe")
    expect(readVerifierReport(target).state).toBe("unsafe")
    expect(
      parseJunit(
        '<?xml version="1.0" encoding="UTF-8"?><testsuites tests="1" assertions="1" failures="0" skipped="0"><testsuite tests="1" assertions="1" failures="0" skipped="0"></testsuite></testsuites>',
      ),
    ).toBeUndefined()
  })

  test("missing or corrupted report data cannot authorize a passed measurement comparison", () => {
    const stored = measurements()
    const baseline = stored.find((entry) => entry.episode === checkpoint.digest)
    const publicCheck = stored.find((entry) => entry.episode === general.digest && entry.scope === "public")
    const heldout = stored.find((entry) => entry.episode === general.digest && entry.scope === "heldout")
    if (!baseline || !publicCheck || !heldout) throw new Error("Missing verifier evidence")
    const missing: Record<string, unknown> = { ...heldout }
    delete missing.report
    expect(() => Schema.decodeUnknownSync(RepoMeasurement)(missing)).toThrow()
    expect(() =>
      compareRepo(
        checkpoint,
        baseline,
        [
          {
            capsule: general,
            public: publicCheck,
            heldout: {
              ...heldout,
              report: { ...heldout.report, state: "missing", raw: null, digest: null, counts: null },
            },
          },
        ],
        directory,
      ),
    ).toThrow("status mismatch")
    expect(() =>
      compareRepo(
        checkpoint,
        baseline,
        [
          {
            capsule: general,
            public: publicCheck,
            heldout: { ...heldout, report: { ...heldout.report, digest: "0".repeat(64) } },
          },
        ],
        directory,
      ),
    ).toThrow("digest mismatch")
  })
})

describe("typed read-only journal receipts", () => {
  test("empty, truncated, wrong and mismatched receipts remain UNKNOWN for comparison and inspection", async () => {
    const receipts = [
      "",
      "{",
      encode({ state: "completed", name: "wrong" }),
      encode({ state: "started", name: "create" }),
    ]
    for (const [index, receipt] of receipts.entries()) {
      const target = path.join(root, `bad-receipt-${index}`)
      mkdirSync(target)
      durableWrite(
        path.join(target, "create.started.json"),
        encode({ state: "started", name: "create", missingReceipt: "UNKNOWN; do not repeat" }),
      )
      durableWrite(path.join(target, "create.receipt.json"), receipt)
      expect(inspectJournal(target)[0].state).toBe("UNKNOWN; must not repeat")
      expect(() => requireJournalComplete(target)).toThrow("UNKNOWN")
      expect((await cli("inspect", target)).stdout).toContain("UNKNOWN; must not repeat")
    }
  })

  test("receipt directories/symlinks and mismatched tool metadata cannot unlock a journal", () => {
    const candidates = ["directory", "symlink", "mismatch"]
    candidates.forEach((kind) => {
      const target = path.join(root, `tool-receipt-${kind}`)
      mkdirSync(target)
      durableWrite(
        path.join(target, "tool-1.started.json"),
        encode({
          occurrence: 1,
          name: "write",
          input: { path: "/fixture/slug.ts", content: "new" },
          state: "started; missing receipt means UNKNOWN",
        }),
      )
      const receipt = path.join(target, "tool-1.json")
      const good = encode({
        occurrence: 1,
        name: "write",
        input: { path: "/fixture/slug.ts", content: "new" },
        outcome: { status: "completed", result: { content: "written" } },
      })
      if (kind === "directory") mkdirSync(receipt)
      if (kind === "symlink") {
        durableWrite(path.join(target, "real.json"), good)
        symlinkSync(path.join(target, "real.json"), receipt)
      }
      if (kind === "mismatch") durableWrite(receipt, good.replace('"new"', '"different"'))
      expect(() => requireJournalComplete(target)).toThrow("UNKNOWN")
      expect(inspectJournal(target)[0].state).toBe("UNKNOWN; must not repeat")
    })
  })

  test("measurement receipt must match started scope, source, implementation and artifact", () => {
    const measurement = measurements().find((entry) => entry.episode === general.digest && entry.scope === "heldout")
    if (!measurement) throw new Error("Missing measurement")
    const target = path.join(root, "measurement-journal")
    mkdirSync(target)
    durableWrite(
      path.join(target, `measurement-${measurement.id}.started.json`),
      encode({
        version: 1,
        id: measurement.id,
        episode: measurement.episode,
        verifier: "heldout",
        implementation: measurement.implementation,
        artifact: measurement.artifact,
        state: "started; missing receipt means UNKNOWN; do not repeat",
        testSource: measurement.testSource,
      }),
    )
    durableWrite(
      path.join(target, `measurement-${measurement.id}.json`),
      encode({ ...measurement, artifact: "0".repeat(64) }),
    )
    expect(() => requireJournalComplete(target)).toThrow("UNKNOWN")
    expect(inspectJournal(target)[0].state).toBe("UNKNOWN; must not repeat")
    expect(inspectJournal(directory).every((effect) => effect.state === "completed")).toBe(true)
  })
})
