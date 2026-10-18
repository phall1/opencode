import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { Effect, Exit } from "effect"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { MachineSmolVM } from "@opencode/core/environment/machine-smolvm"
import { evaluateSmolvm, parseArguments, remeasure } from "../src/smolvm-evaluation"
import { createEvaluationDirectory } from "../src/artifact-evaluator"
import { runProcess } from "../src/verifier-process"
import { encode, hash } from "../src/archive"
import { temporary } from "../src/scratch"
import { probeSmolvm } from "../script/smolvm-probe"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const processes = LayerNode.compile(AppProcess.node)
const run = <A, E>(effect: Effect.Effect<A, E, AppProcess.Service>, signal?: AbortSignal) =>
  Effect.runPromise(effect.pipe(Effect.provide(processes)), { signal })

/** A real executable fixture exercises production AppProcess; it never boots a VM. */
function fixture(mode = "normal") {
  const root = realpathSync(temporary())
  roots.push(root)
  const binary = path.join(root, "fake-smolvm")
  const rootfs = path.join(root, "rootfs")
  mkdirSync(rootfs)
  writeFileSync(path.join(rootfs, "synthetic"), "offline fake image")
  const log = path.join(root, "calls.jsonl")
  writeFileSync(
    binary,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const op = args[3];
const name = args[args.indexOf('--name') + 1];
const parent = args[args.indexOf('--from') + 1];
const file = path.join(process.env.HOME, 'state.json');
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
appendFileSync(${JSON.stringify(log)}, JSON.stringify({op,name,args,home:process.env.HOME,secret:process.env.AWS_SECRET_ACCESS_KEY,smolDirectory:process.env.SMOLVM_DATA_DIR}) + '\\n');
const fail = (code) => { console.error(JSON.stringify({error:{code,message:'untrusted diagnostic omitted'}})); process.exit(1); };
if (op === 'create') { state[name] = mode === 'create-conflict' ? 'PEER' : ''; writeFileSync(file, JSON.stringify(state)); if(mode === 'create-conflict') fail('CONFLICT'); if(mode === 'create-failure') fail('STORAGE_ERROR'); }
if (op === 'start' && mode === 'start-failure') fail('INVALID_STATE');
if (op === 'start' && mode === 'start-conflict') fail('CONFLICT');
if (op === 'branch') { state[name] = mode === 'branch-conflict' ? 'PEER' : state[parent]; writeFileSync(file,JSON.stringify(state)); if(mode === 'branch-conflict') fail('CONFLICT'); if(mode === 'branch-failure') fail('STORAGE_ERROR'); }
if (op === 'status' && !(name in state)) fail('NOT_FOUND');
if (op === 'exec') {
  const wrapper = args.slice(args.indexOf('--')+1);
  const marker = wrapper[4];
  const command = wrapper.slice(5);
  let guestExit = 0;
  if (command[0] === '/bin/sh' && command[2].startsWith("printf '%s'")) { state[name] = command.at(-1); writeFileSync(file,JSON.stringify(state)); }
  if (command[0] === '/bin/sh' && command[2].startsWith('exit ')) guestExit = Number(command[2].slice(5));
  if (command[0] === '/bin/sh' && command[2] === 'echo probe-ok; uname -m') process.stdout.write('probe-ok\\naarch64\\n');
  if (command[0] === '/bin/cat') {
    if (mode === 'missing-artifact') guestExit = 1;
    else if (mode === 'malformed') process.stdout.write('{');
    else if (mode === 'truncated') process.stdout.write('a'.repeat(70000));
    else process.stdout.write(state[name] ?? '');
  }
  if (command[0] === '/fixture/emit') { guestExit = Number(command[1]); process.stdout.write(command[2]); process.stderr.write(command[3]); }
  if (command[0] === 'management-error') fail('NOT_FOUND');
  if (command[0] === 'invalid-utf8') process.stdout.write(new Uint8Array([255]));
  if (command[0] === 'invalid-stderr-utf8') process.stderr.write(new Uint8Array([255]));
  if (command[0] === 'oversized') process.stdout.write('a'.repeat(70000));
  if (command[0] === 'oversized-stderr') process.stderr.write('a'.repeat(70000));
  if (command[0] === 'controller-timeout') await Bun.sleep(20000);
  if (command[0] === 'missing-marker') process.exit(0);
  if (command[0] === 'forged-marker') { process.stderr.write('\\nopencode-'+crypto.randomUUID()+':0\\n'); process.exit(0); }
  if (command[0] === 'invalid-marker') { process.stderr.write('\\n'+marker+':999\\n'); process.exit(0); }
  if (command[0] === 'nonterminal-marker') { process.stderr.write('\\n'+marker+':0\\ntail'); process.exit(0); }
  if (command[0] === 'cli-zero-error') { console.error(JSON.stringify({error:{code:'NOT_FOUND',message:'management-looking diagnostic'}})); process.exit(0); }
  if (command[0] === 'cli-nonzero-marker') { process.stderr.write('\\n'+marker+':0\\n'); process.exit(1); }
  process.stderr.write('\\n'+marker+':'+guestExit+'\\n');
}
if (op === 'start' && mode === 'interrupt') { writeFileSync(${JSON.stringify(path.join(root, "ready"))}, 'ready'); await Bun.sleep(20000); }
if (op === 'delete') {
  if(mode === 'cleanup-failure') fail('STORAGE_ERROR');
  if(!(name in state)) fail('NOT_FOUND');
  delete state[name]; writeFileSync(file,JSON.stringify(state));
}
`,
  )
  chmodSync(binary, 0o700)
  const directory = path.join(root, "evaluation")
  return {
    root,
    binary,
    rootfs,
    directory,
    log,
    calls: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  }
}

test("CLI help/trust/invalid arguments never launch a VM", async () => {
  expect(parseArguments(["--help"]).mode).toBe("help")
  expect(() => parseArguments([])).toThrow("--trust-local-code")
  expect(() => parseArguments(["--trust-local-code", "--net"])).toThrow()
  expect(() => parseArguments(["--trust-local-code", "one", "two"])).toThrow()
  expect(() => parseArguments(["remeasure", "one"])).toThrow()
  const command = Bun.spawn([process.execPath, "run", "script/smolvm-evaluate.ts", "--help"], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await new Response(command.stdout).text()).toContain("no Docker")
  expect(await command.exited).toBe(0)
  const denied = Bun.spawn([process.execPath, "run", "script/smolvm-evaluate.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await new Response(denied.stderr).text()).toContain("no VM was started")
  expect(await denied.exited).not.toBe(0)
  const f = fixture()
  expect(Exit.isFailure(await run(evaluateSmolvm({ ...f, trustLocalCode: false }).pipe(Effect.exit)))).toBe(true)
  expect(existsSync(f.log)).toBe(false)
  expect(existsSync(f.directory)).toBe(false)
})

test("production profile has offline oracle controls, isolated branches, reverse cleanup and immutable remeasurement", async () => {
  const f = fixture()
  const result = await run(evaluateSmolvm({ ...f, trustLocalCode: true }))
  expect(result.report.status).toBe("COMPLETE")
  expect(result.report.results?.baseline.receipt.status).toBe("FAILED")
  expect(result.report.results?.general.receipt.status).toBe("PASSED")
  expect(result.report.results?.overfit.receipt.status).toBe("FAILED")
  expect(result.report.results?.overfitPublic.receipt.status).toBe("PASSED")
  expect(result.report.results?.parentUnchanged).toBe(true)
  const calls = f.calls()
  const created = calls.filter((c) => ["create", "branch"].includes(c.op)).map((c) => c.name)
  expect(result.report.cleanup.map((c) => c.machine)).toEqual(created.toReversed())
  expect(calls.some((c) => c.args.includes("--net") || c.args.includes("--volume"))).toBe(false)
  expect(calls.every((c) => c.secret === undefined)).toBe(true)
  expect(result.privateHome).toBeNull()
  expect(existsSync(calls[0].home)).toBe(false)
  const original = result.report.results!.general
  const filename = `measurement-${original.receipt.id}.json`
  const before = readFileSync(path.join(f.directory, filename), "utf8")
  expect(remeasure(f.directory, filename, "policy-v2").receipt.status).toBe("PASSED")
  expect(readFileSync(path.join(f.directory, filename), "utf8")).toBe(before)
  expect(original.sha256).toBe(hash(encode(original.receipt)))
  expect(() => remeasure(f.directory, "../run.json", "policy-v2")).toThrow()
})

test("failed create/start/branch cleans exact owned resources; missing delete is idempotent", async () => {
  for (const mode of [
    "create-failure",
    "start-failure",
    "start-conflict",
    "branch-failure",
    "truncated",
    "missing-artifact",
    "malformed",
  ]) {
    const f = fixture(mode)
    const result = await run(evaluateSmolvm({ ...f, trustLocalCode: true }))
    expect(result.report.status).toBe("UNKNOWN")
    const intents = readdirSync(f.directory).filter((name) => name.startsWith("resource-"))
    expect(result.report.cleanup).toHaveLength(intents.length)
    expect(result.report.cleanup.every((item) => item.status === "removed")).toBe(true)
    const calls = f.calls()
    const owned = calls.filter((c) => ["create", "branch"].includes(c.op)).map((c) => c.name)
    expect(calls.filter((c) => c.op === "delete").every((c) => owned.includes(c.name))).toBe(true)
    expect(owned.length).toBe(new Set(owned).size) // No automatic create/branch retries.
    for (const file of readdirSync(f.directory).filter((name) => name.startsWith("measurement-")))
      expect(readFileSync(path.join(f.directory, file), "utf8")).not.toContain("untrusted diagnostic omitted")
  }
})

test("offline remeasurement rejects special, linked, oversized and non-private receipts without blocking", async () => {
  const root = realpathSync(temporary())
  roots.push(root)
  const directory = createEvaluationDirectory(path.join(root, "evaluation"))
  const filename = () => `measurement-${crypto.randomUUID()}.json`
  const fifo = filename()
  expect((await runProcess(["/usr/bin/mkfifo", path.join(directory, fifo)], {}, 5000, 4096)).exitCode).toBe(0)
  const script = path.resolve(import.meta.dir, "../script/smolvm-evaluate.ts")
  const refused = await runProcess([process.execPath, script, "remeasure", directory, fifo], {}, 5000, 4096)
  expect(refused.timedOut).toBe(false)
  expect(refused.exitCode).not.toBe(0)
  expect(refused.stderr.text).toContain("regular file")
  const data = filename()
  writeFileSync(path.join(directory, data), "{}", { mode: 0o600 })
  const alias = filename()
  symlinkSync(path.join(directory, data), path.join(directory, alias))
  expect(() => remeasure(directory, alias, "policy-v1")).toThrow()
  const linked = filename()
  linkSync(path.join(directory, data), path.join(directory, linked))
  expect(() => remeasure(directory, linked, "policy-v1")).toThrow("regular file")
  const oversized = filename()
  writeFileSync(path.join(directory, oversized), "a".repeat(65_537), { mode: 0o600 })
  expect(() => remeasure(directory, oversized, "policy-v1")).toThrow("byte limit")
  const publicFile = filename()
  writeFileSync(path.join(directory, publicFile), "{}", { mode: 0o600 })
  chmodSync(path.join(directory, publicFile), 0o644)
  expect(() => remeasure(directory, publicFile, "policy-v1")).toThrow("regular file")
})

test("cleanup failure is UNKNOWN, preserves private inventory and never reports clean success", async () => {
  const f = fixture("cleanup-failure")
  const result = await run(evaluateSmolvm({ ...f, trustLocalCode: true }))
  expect(result.report.status).toBe("UNKNOWN")
  expect(result.report.cleanup.every((item) => item.status === "UNKNOWN")).toBe(true)
  expect(result.privateHome).not.toBeNull()
  expect(existsSync(result.privateHome!)).toBe(true)
  // Fake fixture has no VMs. Reclaim only this test's exact retained home.
  rmSync(result.privateHome!, { recursive: true })
})

test("explicit create/branch conflicts revoke cleanup ownership and preserve the peer inventory", async () => {
  for (const mode of ["create-conflict", "branch-conflict"]) {
    const f = fixture(mode)
    const result = await run(evaluateSmolvm({ ...f, trustLocalCode: true }))
    expect(result.report.status).toBe("UNKNOWN")
    expect(result.report.nonOwned).toHaveLength(1)
    expect(result.privateHome).not.toBeNull()
    const id = result.report.nonOwned[0]
    expect(f.calls().some((call) => call.op === "delete" && call.name === id)).toBe(false)
    expect(JSON.parse(readFileSync(path.join(result.privateHome!, "state.json"), "utf8"))).toEqual({ [id]: "PEER" })
    expect(JSON.parse(readFileSync(path.join(f.directory, `resource-${id}.not-owned.json`), "utf8")).status).toBe(
      "NOT_OWNED",
    )
    expect(result.report.cleanup.every((item) => item.status === "removed")).toBe(true)
    expect(result.report.cleanup).toHaveLength(mode === "branch-conflict" ? 1 : 0)
    // Only a fake peer's state file exists here; production intentionally retains it.
    rmSync(result.privateHome!, { recursive: true })
  }
})

test("interruption awaits cleanup of an ambiguous create before returning", async () => {
  const f = fixture("interrupt")
  const abort = new AbortController()
  const result = run(evaluateSmolvm({ ...f, trustLocalCode: true }), abort.signal).catch(() => undefined)
  const deadline = Date.now() + 5000
  while (!existsSync(path.join(f.root, "ready")) && Date.now() < deadline) await Bun.sleep(5)
  expect(existsSync(path.join(f.root, "ready"))).toBe(true)
  abort.abort()
  await result
  const calls = f.calls()
  expect(calls.at(-1).op).toBe("delete")
  expect(existsSync(calls[0].home)).toBe(false)
  expect(JSON.parse(readFileSync(path.join(f.directory, "run.json"), "utf8")).status).toBe("UNKNOWN")
})

test("Smol adapter preserves ordinary guest exits and rejects management/truncation/launch failures", async () => {
  const f = fixture()
  await run(
    Effect.gen(function* () {
      const app = yield* AppProcess.Service
      const runtime = MachineSmolVM.make({ processes: app, binary: f.binary, dataDirectory: f.root })
      for (const exitCode of [0, 1, 125, 126, 127])
        expect(
          (yield* runtime.exec({ id: "synthetic", command: ["/bin/sh", "-c", `exit ${exitCode}`] })).exitCode,
        ).toBe(exitCode)
      for (const command of [
        ["management-error"],
        ["oversized"],
        ["oversized-stderr"],
        ["invalid-utf8"],
        ["invalid-stderr-utf8"],
        ["missing-marker"],
        ["forged-marker"],
        ["invalid-marker"],
        ["nonterminal-marker"],
        ["cli-zero-error"],
        ["cli-nonzero-marker"],
        ["controller-timeout"],
      ])
        expect((yield* runtime.exec({ id: "synthetic", command, timeoutMs: 1 }).pipe(Effect.flip))._tag).toBe(
          "MachineRuntime.Error",
        )
      expect(() => MachineSmolVM.make({ processes: app, binary: f.binary, cpus: Number.NaN })).toThrow()
      expect(() => MachineSmolVM.make({ processes: app, binary: f.binary, memoryMB: -1 })).toThrow()
      expect(
        (yield* runtime.exec({ id: "synthetic", command: ["/bin/sh", "-c", "exit 0"], timeoutMs: 0 }).pipe(Effect.flip))
          ._tag,
      ).toBe("MachineRuntime.Error")
      const missing = MachineSmolVM.make({ processes: app, binary: path.join(f.root, "missing") })
      expect(
        (yield* missing.exec({ id: "synthetic", command: ["/bin/sh", "-c", "exit 0"] }).pipe(Effect.flip))._tag,
      ).toBe("MachineRuntime.Error")
    }),
  )
})

test("completion protocol preserves guest JSON diagnostics and exact stream bytes for every ordinary exit", async () => {
  const f = fixture()
  await run(
    Effect.gen(function* () {
      const app = yield* AppProcess.Service
      const runtime = MachineSmolVM.make({ processes: app, binary: f.binary, dataDirectory: f.root })
      for (const exitCode of [0, 1, 125, 126, 127]) {
        for (const suffix of ["", "\n"]) {
          const stdout = `\uFEFFstdout-λ🔒${suffix}`
          const stderr =
            JSON.stringify({ error: { code: "CONFLICT", message: "guest diagnostic, not management" } }) + suffix
          const result = yield* runtime.exec({
            id: "synthetic",
            command: ["/fixture/emit", String(exitCode), stdout, stderr],
          })
          expect(result).toEqual({ exitCode, stdout, stderr })
        }
      }
      const stderr = "x".repeat(32_768)
      expect((yield* runtime.exec({ id: "synthetic", command: ["/fixture/emit", "0", "", stderr] })).stderr).toBe(
        stderr,
      )
      expect((yield* runtime.exec({ id: "synthetic", command: [] }).pipe(Effect.flip))._tag).toBe(
        "MachineRuntime.Error",
      )
    }),
  )
})

test("legacy timing probe uses private local images, unique children and the same failure/conflict cleanup", async () => {
  const f = fixture()
  const result = await run(probeSmolvm({ ...f, iterations: 2 }))
  expect(result.report.status).toBe("COMPLETE")
  expect(result.report.samples).toHaveLength(2)
  expect(result.report.samples.every((sample) => sample.stdout === "probe-ok\naarch64")).toBe(true)
  expect(new Set(result.report.samples.map((sample) => sample.child)).size).toBe(2)
  expect(result.report.cleanup).toHaveLength(3)
  expect(result.privateHome).toBeNull()
  expect(f.calls().every((call) => call.home !== process.env.HOME)).toBe(true)
  expect(f.calls().find((call) => call.op === "create").args).toContain(path.join(f.directory, "image"))
  for (const mode of ["start-failure", "start-conflict", "branch-failure", "create-conflict", "branch-conflict"]) {
    const failing = fixture(mode)
    const failed = await run(probeSmolvm({ ...failing, iterations: 2 }))
    expect(failed.report.status).toBe("UNKNOWN")
    expect(failed.report.cleanup.every((item) => item.status === "removed")).toBe(true)
    if (failed.privateHome) {
      expect(failed.report.nonOwned).toHaveLength(1)
      const id = failed.report.nonOwned[0]
      expect(failing.calls().some((call) => call.op === "delete" && call.name === id)).toBe(false)
      expect(JSON.parse(readFileSync(path.join(failed.privateHome, "state.json"), "utf8"))[id]).toBe("PEER")
      rmSync(failed.privateHome, { recursive: true })
    }
  }
})

test("legacy probe CLI retains top-level timings and never forwards ambient inventory or credentials", async () => {
  const f = fixture()
  symlinkSync(f.binary, path.join(f.root, "smolvm"))
  symlinkSync(f.rootfs, path.join(f.root, "agent-rootfs"))
  const script = path.resolve(import.meta.dir, "../script/smolvm-probe.ts")
  const ambient = path.join(f.root, "ambient-must-not-exist")
  const result = await runProcess(
    [process.execPath, script, "1", f.directory],
    {
      PATH: `${f.root}:/usr/bin:/bin`,
      SMOLVM_DATA_DIR: ambient,
      AWS_SECRET_ACCESS_KEY: "synthetic-not-a-secret",
    },
    10_000,
    65_536,
  )
  expect(result.exitCode).toBe(0)
  const report = JSON.parse(result.stdout.text)
  expect(report.status).toBe("COMPLETE")
  expect(report.samples).toHaveLength(1)
  expect(report.outputDirectory).toBe(f.directory)
  expect(report.parentReadyMs).toBeGreaterThanOrEqual(0)
  expect(report).not.toHaveProperty("report")
  expect(f.calls().every((call) => call.secret === undefined && call.smolDirectory === undefined)).toBe(true)
  expect(existsSync(ambient)).toBe(false)
  expect(existsSync(f.calls()[0].home)).toBe(false)
})

test("evaluator CLI reserves stdout for a complete JSON result and routes process logs to stderr", async () => {
  const f = fixture()
  symlinkSync(f.binary, path.join(f.root, "smolvm"))
  symlinkSync(f.rootfs, path.join(f.root, "agent-rootfs"))
  const result = await runProcess(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../script/smolvm-evaluate.ts"),
      f.directory,
      "--trust-local-code",
    ],
    { PATH: `${f.root}:/usr/bin:/bin` },
    10_000,
    65_536,
  )
  expect(result.exitCode).toBe(0)
  expect(result.timedOut).toBe(false)
  const parsed = JSON.parse(result.stdout.text)
  expect(parsed.report.status).toBe("COMPLETE")
  expect(parsed.report.results.general.receipt.status).toBe("PASSED")
  expect(parsed.directory).toBe(f.directory)
  expect(result.stderr.text).toContain("spawning process")
  expect(result.stdout.text).not.toContain("spawning process")
})

test("named fork refuses an existing machine without branching or deleting it", async () => {
  const f = fixture()
  await run(
    Effect.gen(function* () {
      const app = yield* AppProcess.Service
      const runtime = MachineSmolVM.make({ processes: app, binary: f.binary, dataDirectory: f.root })
      const parent = yield* runtime.create({ image: f.rootfs })
      expect((yield* runtime.fork({ parent: parent.id, name: parent.id }).pipe(Effect.flip))._tag).toBe(
        "MachineRuntime.Error",
      )
      expect(f.calls().some((call) => ["delete", "branch"].includes(call.op))).toBe(false)
      const child = yield* runtime.fork({ parent: parent.id, name: "owned-child" })
      yield* runtime.destroy({ id: child.id })
      yield* runtime.destroy({ id: parent.id })
    }),
  )
})

test.skipIf(process.env.OPENCODE_REPLAY_SMOLVM !== "1")(
  "real opt-in SmolVM profile and cleanup",
  async () => {
    const root = realpathSync(temporary())
    roots.push(root)
    const result = await run(evaluateSmolvm({ directory: path.join(root, "evaluation"), trustLocalCode: true }))
    expect(result.report.status).toBe("COMPLETE")
    expect(result.report.cleanup).toHaveLength(3)
    expect(result.report.cleanup.every((item) => item.status === "removed")).toBe(true)
    expect(result.report.results?.general.receipt.status).toBe("PASSED")
    expect(result.report.results?.overfitPublic.receipt.status).toBe("PASSED")
    expect(result.report.results?.overfit.receipt.status).toBe("FAILED")
    expect(result.report.results?.parentUnchanged).toBe(true)
    expect(result.privateHome).toBeNull()
    // Exercise actual guest nonzero/timeout paths, then fail deliberately: release must finish.
    const home = path.join(
      realpathSync("/tmp"),
      `oc-${Buffer.from(crypto.randomUUID().replaceAll("-", ""), "hex").toString("base64url")}`,
    )
    mkdirSync(home, { mode: 0o700 })
    const deleted: string[] = []
    await run(
      Effect.gen(function* () {
        const app = yield* AppProcess.Service
        const runtime = MachineSmolVM.make({
          processes: app,
          binary: result.report.binary,
          dataDirectory: home,
          diskGB: 1,
        })
        const machine = yield* Effect.acquireRelease(
          runtime.create({ image: path.join(root, "evaluation/image") }),
          ({ id }) =>
            runtime.destroy({ id }).pipe(
              Effect.tap(() => Effect.sync(() => deleted.push(id))),
              Effect.orDie,
            ),
        )
        for (const exitCode of [0, 1, 125, 126, 127]) {
          for (const suffix of ["", "\n"]) {
            const stdout = `\uFEFFliteral $() ; λ🔒${suffix}`
            const stderr = JSON.stringify({ error: { code: "NOT_FOUND", message: "guest JSON diagnostic" } }) + suffix
            const observed = yield* runtime.exec({
              id: machine.id,
              command: [
                "/bin/sh",
                "-c",
                'printf "%s" "$1"; printf "%s" "$2" >&2; exit "$3"',
                "fixture",
                stdout,
                stderr,
                String(exitCode),
              ],
            })
            expect(observed).toEqual({ exitCode, stdout, stderr })
          }
        }
        for (const command of [
          ["exit", "0"],
          ["exec", "/bin/true"],
        ])
          expect((yield* runtime.exec({ id: machine.id, command })).exitCode).toBe(127)
        expect(
          (yield* runtime.exec({ id: `missing-${crypto.randomUUID()}`, command: ["/bin/true"] }).pipe(Effect.flip))
            ._tag,
        ).toBe("MachineRuntime.Error")
        const timeout = yield* runtime
          .exec({
            id: machine.id,
            command: ["/bin/sh", "-c", "sleep 1; printf survived > /workspace/timeout-marker"],
            timeoutMs: 100,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(timeout) || timeout.value.exitCode !== 0).toBe(true)
        yield* Effect.sleep("1500 millis")
        expect(
          (yield* runtime.exec({ id: machine.id, command: ["/bin/cat", "/workspace/timeout-marker"] })).exitCode,
        ).not.toBe(0)
        return yield* Effect.fail(new Error("deliberate task failure after guest checks"))
      }).pipe(Effect.scoped, Effect.flip),
    )
    expect(deleted).toHaveLength(1)
    rmSync(home, { recursive: true })
  },
  120_000,
)
