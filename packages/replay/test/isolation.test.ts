import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { durableWrite, encode, parseJson } from "../src/archive"
import { inspectJournal } from "../src/journal"
import { RepoMeasurement, measureRepo, verifyFiles } from "../src/repo-measure"
import { demoTask, experiment, openRepo, replayRepo } from "../src/repo"
import { compareDirectory } from "../src/repo-report"
import { temporary } from "../src/scratch"
import {
  Container,
  IMAGE,
  IsolationMode,
  OWNER_LABEL,
  assertContainerPolicy,
  dockerCapability,
  withDockerCapability,
  localEndpoint,
} from "../src/verifier-isolation"
import { runProcess } from "../src/verifier-process"
import { isolatedFixture, isolationChecks } from "../script/isolation-checks"
import { dockerShim, shimEvents, verifierObserver, waitingTask } from "./isolation-control"
import { awaitVerifier } from "../src/verifier-effect"

const root = temporary()
afterAll(() => rmSync(root, { recursive: true, force: true }))
const cli = path.join(import.meta.dir, "../script/cli.ts")
const isolation = { isolation: "docker-required" as const }

test("verifier Effect finalizer waits for settlement and preserves cleanup defects", async () => {
  const started = Promise.withResolvers<void>()
  const abort = new AbortController()
  const file = path.join(root, "cleanup-settled.txt")
  const pending = Effect.runPromiseExit(
    awaitVerifier(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              void Bun.sleep(20).then(() => {
                durableWrite(file, "settled")
                reject(new Error("UNKNOWN synthetic cleanup defect"))
              })
            },
            { once: true },
          )
          started.resolve()
        }),
    ),
    { signal: abort.signal },
  )
  await started.promise
  abort.abort()
  const exit = await pending
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true)
    expect(Cause.pretty(exit.cause)).toContain("UNKNOWN synthetic cleanup defect")
  }
  expect(readFileSync(file, "utf8")).toBe("settled")
})

test("isolation admission still requires explicit trust and rejects invalid modes/endpoints", async () => {
  await expect(verifyFiles(demoTask, demoTask.files, "heldout", false, isolation)).rejects.toThrow("--trust-local-code")
  expect(() => Schema.decodeUnknownSync(IsolationMode)("automatic")).toThrow()
  expect(() => localEndpoint("tcp://127.0.0.1:2375")).toThrow("local absolute unix")
  expect(() => localEndpoint("ssh://localhost")).toThrow("local absolute unix")
  expect(() => localEndpoint("unix://relative")).toThrow("local absolute unix")
})

async function admission(env: Record<string, string>, marker: string) {
  const source = `import {verifyFiles} from ${JSON.stringify(path.join(import.meta.dir, "../src/repo-measure.ts"))};import {demoTask} from ${JSON.stringify(path.join(import.meta.dir, "../src/repo-task.ts"))};const task={...demoTask,verifier:{...demoTask.verifier,testSource:${JSON.stringify(`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'fallback');process.exit(0);`)}}};await verifyFiles(task,task.files,'heldout',true,{isolation:'docker-required'});`
  return runProcess([process.execPath, "--eval", source], env, 15000, 65536)
}

test("missing Docker and nonlocal selected endpoint never fall back to host Bun", async () => {
  const marker = path.join(root, "must-not-run")
  const noCLI = await admission({ PATH: path.join(root, "missing"), HOME: root }, marker)
  expect(noCLI.exitCode).not.toBe(0)
  expect(noCLI.stderr.text).toContain("CLI missing")
  const nonlocal = await admission(
    { PATH: process.env.PATH ?? "", HOME: root, DOCKER_HOST: "tcp://127.0.0.1:2375" },
    marker,
  )
  expect(nonlocal.exitCode).not.toBe(0)
  // CLI-less machines reject earlier; neither outcome may execute the fixture.
  expect(nonlocal.stderr.text).toMatch(/local absolute unix|CLI missing/)
  expect(existsSync(marker)).toBe(false)
})

test("configured nonlocal context and missing cached image fail closed with a clean controller environment", async () => {
  const directory = path.join(root, "fake-controller")
  mkdirSync(directory)
  const socket = path.join(directory, "local.sock")
  const listener = Bun.listen({ unix: socket, socket: { data() {} } })
  const marker = path.join(directory, "must-not-execute")
  const log = path.join(directory, "calls.jsonl")
  const info = {
    OSType: "linux",
    Architecture: "aarch64",
    ServerVersion: "synthetic",
    SecurityOptions: ["name=seccomp,profile=builtin"],
    CgroupVersion: "2",
    KernelVersion: "synthetic",
    MemoryLimit: true,
    SwapLimit: true,
    CpuCfsQuota: true,
    PidsLimit: true,
  }
  const response = path.join(directory, "response.json")
  durableWrite(response, encode({ info }))
  durableWrite(
    path.join(directory, "docker"),
    `#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);const response=JSON.parse(fs.readFileSync(${JSON.stringify(response)},'utf8'));fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,env:process.env})+'\\n');if(args[0]==='context'&&args[1]==='inspect'){console.log(JSON.stringify([{Endpoints:{docker:{Host:'tcp://127.0.0.1:2375'}}}]))}else if(args.includes('info')){if(response.daemonError){console.error('synthetic daemon unavailable');process.exit(1)}console.log(JSON.stringify(response.info))}else if(args.includes('image')&&response.image){console.log(JSON.stringify([response.image]))}else{console.error('synthetic pinned image absent');process.exit(1)}`,
  )
  const { chmodSync, symlinkSync } = await import("node:fs")
  chmodSync(path.join(directory, "docker"), 0o700)
  const socketLink = path.join(directory, "selected.sock")
  symlinkSync(socket, socketLink)
  try {
    expect(localEndpoint(`unix://${socketLink}`)).toBe(localEndpoint(`unix://${socket}`))
    const context = await admission(
      {
        PATH: directory,
        HOME: root,
        DOCKER_CONTEXT: "nonlocal",
        DOCKER_HOST: `unix://${socket}`,
        DOCKER_CONFIG: "must-not-copy",
        SYNTHETIC_CREDENTIAL: "must-not-copy",
      },
      marker,
    )
    expect(context.exitCode).not.toBe(0)
    expect(context.stderr.text).toContain("local absolute unix")
    const image = await admission(
      { PATH: directory, HOME: root, DOCKER_HOST: `unix://${socket}`, SYNTHETIC_CREDENTIAL: "must-not-copy" },
      marker,
    )
    expect(image.exitCode).not.toBe(0)
    expect(image.stderr.text).toContain("synthetic pinned image absent")
    const scenarios = [
      { data: { info, daemonError: true }, message: "synthetic daemon unavailable" },
      { data: { info: { ...info, SecurityOptions: [] } }, message: "builtin seccomp" },
      { data: { info: { ...info, MemoryLimit: false } }, message: "resource limits unavailable" },
      {
        data: {
          info,
          image: {
            Id: "synthetic",
            Architecture: "amd64",
            Os: "linux",
            Config: { Labels: { "org.opencontainers.image.version": "1.4.2" } },
          },
        },
        message: "daemon platform",
      },
    ]
    for (const scenario of scenarios) {
      await Bun.write(response, encode(scenario.data))
      const rejected = await admission({ PATH: directory, HOME: root, DOCKER_HOST: `unix://${socket}` }, marker)
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.stderr.text).toContain(scenario.message)
    }
    expect(existsSync(marker)).toBe(false)
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((raw) =>
        Schema.decodeUnknownSync(
          Schema.Struct({ args: Schema.Array(Schema.String), env: Schema.Record(Schema.String, Schema.String) }),
        )(parseJson(raw)),
      )
    expect(
      calls.some((call) => call.args.includes("create") || call.args.includes("exec") || call.args.includes("pull")),
    ).toBe(false)
    expect(
      calls.every(
        (call) =>
          !call.env.DOCKER_HOST &&
          !call.env.DOCKER_CONTEXT &&
          (call.args[0] === "context" || call.env.DOCKER_CONFIG !== "must-not-copy") &&
          !call.env.SYNTHETIC_CREDENTIAL,
      ),
    ).toBe(true)
    expect(calls.find((call) => call.args[0] === "context")?.env.DOCKER_CONFIG).toBe("must-not-copy")
    expect(calls.find((call) => call.args.includes("image"))?.args.slice(0, 2)).toEqual([
      "--host",
      localEndpoint(`unix://${socket}`),
    ])
  } finally {
    listener.stop(true)
  }
})

test("CLI rejects missing trust, unknown isolation flags and memory profile isolation", async () => {
  const task = path.join(root, "task.json")
  durableWrite(task, encode(demoTask))
  const missing = await runProcess(
    [process.execPath, cli, "experiment", task, path.join(root, "no-trust"), "--isolated"],
    { PATH: process.env.PATH ?? "" },
    10000,
    65536,
  )
  expect(missing.exitCode).not.toBe(0)
  expect(missing.stderr.text).toContain("Requires --trust-local-code")
  const unknown = await runProcess(
    [process.execPath, cli, "experiment", task, path.join(root, "unknown"), "--trust-local-code", "--unsafe"],
    {},
    10000,
    65536,
  )
  expect(unknown.exitCode).not.toBe(0)
  expect(unknown.stderr.text).toContain("Unknown or duplicate")
  expect(existsSync(path.join(root, "no-trust"))).toBe(false)
  const memory = path.join(root, "memory.json")
  durableWrite(memory, encode({ manifest: { profile: "memory" } }))
  const forbidden = await runProcess(
    [process.execPath, cli, "measure", memory, "repair-exact-v1", "--isolated"],
    {},
    10000,
    65536,
  )
  expect(forbidden.exitCode).not.toBe(0)
  expect(forbidden.stderr.text).toContain("memory measure takes three arguments")
})

describe.skipIf(process.env.OPENCODE_REPLAY_DOCKER !== "1")(
  "actual Docker containment (requires local pinned image)",
  () => {
    test("real custom Docker config selects its context only during offline discovery", async () => {
      return withDockerCapability(async (capability) => {
        const config = path.join(root, `selected-config-${crypto.randomUUID()}`)
        mkdirSync(config)
        const local = `local-${crypto.randomUUID()}`
        const remote = `remote-${crypto.randomUUID()}`
        const create = async (name: string, endpoint: string) => {
          const result = await runProcess(
            [capability.docker.cli, "--config", config, "context", "create", name, "--docker", `host=${endpoint}`],
            capability.docker.env,
            10000,
            65536,
          )
          expect(result.exitCode).toBe(0)
        }
        await create(local, capability.docker.endpoint)
        await create(remote, "tcp://127.0.0.1:2375")
        const selected = async (name: string, context?: string) => {
          await Bun.write(
            path.join(config, "config.json"),
            encode({ currentContext: name, proxies: { default: { httpProxy: "http://synthetic-proxy.invalid:9" } } }),
          )
          const env: Record<string, string> = {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? root,
            DOCKER_CONFIG: config,
          }
          if (context) {
            env.DOCKER_CONTEXT = context
            env.DOCKER_HOST = "tcp://127.0.0.1:2375"
          }
          const source = `import {dockerCapability} from ${JSON.stringify(path.join(import.meta.dir, "../src/verifier-isolation.ts"))};console.log(JSON.stringify(await dockerCapability()));`
          return runProcess([process.execPath, "--eval", source], env, 15000, 65536)
        }
        const admitted = await selected(local)
        expect(admitted.exitCode).toBe(0)
        expect(
          Schema.decodeUnknownSync(Schema.Struct({ endpoint: Schema.String }))(parseJson(admitted.stdout.text))
            .endpoint,
        ).toBe(capability.docker.endpoint)
        const rejected = await selected(remote)
        expect(rejected.exitCode).not.toBe(0)
        expect(rejected.stderr.text).toContain("local absolute unix")
        const precedence = await selected(remote, local)
        expect(precedence.exitCode).toBe(0)
        expect(
          Schema.decodeUnknownSync(Schema.Struct({ endpoint: Schema.String }))(parseJson(precedence.stdout.text))
            .endpoint,
        ).toBe(capability.docker.endpoint)
      })
    }, 60000)

    test("actual host read/write/network/PID/socket denial, resources and descendant cleanup", async () => {
      const checks = await isolationChecks(root)
      expect(checks.checks).toHaveLength(9)
      const evidence = Schema.decodeUnknownSync(
        Schema.Struct({
          results: Schema.Struct({ denied: Schema.Struct({ isolation: Schema.Struct({ image: Schema.String }) }) }),
        }),
      )(parseJson(readFileSync(checks.file, "utf8")))
      expect(evidence.results.denied.isolation.image).toBe(IMAGE)
    }, 90000)

    test("normal pass/fail and early exit/no-tests retain native JUnit semantics", async () => {
      const pass = await isolatedFixture("import {test,expect} from 'bun:test';test('normal',()=>expect(1).toBe(1));")
      expect(pass.status).toBe("passed")
      expect(pass.report.counts?.assertions).toBe(1)
      expect(pass.isolation.guest).toMatchObject({ noNewPrivs: "1", capEff: "0000000000000000", seccomp: "2" })
      const policy = Schema.decodeUnknownSync(
        Schema.Struct({
          config: Container.fields.Config,
          host: Container.fields.HostConfig,
          mounts: Container.fields.Mounts,
          image: Schema.String,
        }),
      )(pass.isolation.policy)
      const container = Schema.decodeUnknownSync(Container)({
        Id: "synthetic-test-inspection",
        Image: policy.image,
        Config: policy.config,
        HostConfig: policy.host,
        Mounts: policy.mounts,
        State: { Running: false, ExitCode: 0, OOMKilled: false, Error: "" },
      })
      const expected = {
        name: container.Config.Labels[OWNER_LABEL],
        root: container.Mounts[0].Source,
        uid: Number(container.Config.User.split(":")[0]),
        imageID: container.Image,
      }
      expect(() => assertContainerPolicy(container, expected)).not.toThrow()
      const mutations = [
        { ...container, Config: { ...container.Config, User: "0:0" } },
        { ...container, Config: { ...container.Config, Env: [...container.Config.Env, "SYNTHETIC_CREDENTIAL=bad"] } },
        { ...container, HostConfig: { ...container.HostConfig, NetworkMode: "host" } },
        { ...container, HostConfig: { ...container.HostConfig, PidMode: "host" } },
        { ...container, HostConfig: { ...container.HostConfig, CapAdd: ["SYS_ADMIN"] } },
        {
          ...container,
          HostConfig: { ...container.HostConfig, SecurityOpt: ["no-new-privileges", "seccomp=unconfined"] },
        },
        { ...container, HostConfig: { ...container.HostConfig, Memory: 0 } },
        { ...container, Mounts: [{ ...container.Mounts[0], RW: true }] },
      ]
      mutations.forEach((mutation) =>
        expect(() => assertContainerPolicy(mutation, expected)).toThrow("policy mismatch"),
      )
      const fail = await isolatedFixture("import {test,expect} from 'bun:test';test('negative',()=>expect(1).toBe(2));")
      expect(fail.status).toBe("test-failed")
      expect(fail.report.counts?.failures).toBe(1)
      const early = await isolatedFixture("process.exit(0);")
      expect(early.status).toBe("verifier-incomplete")
      const empty = await isolatedFixture("export const noTests = true;")
      expect(empty.status).toBe("verifier-incomplete")
    }, 60000)

    test("unsafe, oversized and missing reports cannot pass; output remains bounded", async () => {
      const sources = [
        "import fs from 'node:fs';fs.writeFileSync('/tmp/target','synthetic');fs.symlinkSync('/tmp/target','/output/junit.xml');process.exit(0)",
        "import fs from 'node:fs';fs.mkdirSync('/output/junit.xml');process.exit(0)",
        "import fs from 'node:fs';fs.writeFileSync('/output/junit.xml','x'.repeat(65537));process.exit(0)",
        "import fs from 'node:fs';fs.writeFileSync('/output/junit.xml',Buffer.alloc(65536,255));process.exit(0)",
      ]
      const results = await Promise.all(sources.map((source) => isolatedFixture(source)))
      expect(results.map((result) => result.report.state)).toEqual(["unsafe", "unsafe", "oversized", "oversized"])
      expect(results.every((result) => result.status === "verifier-incomplete")).toBe(true)
      const noisy = await isolatedFixture("console.log('x'.repeat(100000));process.exit(0)")
      expect(noisy.status).toBe("output-truncated")
      expect(Buffer.byteLength(noisy.stdout)).toBeLessThanOrEqual(demoTask.budgets.outputBytes)
    }, 60000)

    test("cancellation removes its exact owned container", async () => {
      return withDockerCapability(async (capability) => {
        const start = () => {
          const input = waitingTask()
          const abort = new AbortController()
          // Observe rejection immediately, even if readiness observation fails before awaiting it.
          const settled = verifyFiles(input.task, input.task.files, "heldout", true, {
            ...isolation,
            signal: abort.signal,
          }).then(
            () => "unexpected verifier completion",
            (error: unknown) => String(error),
          )
          return { ...input, abort, settled }
        }
        const attempt = start()
        const peer = start()
        const observer = verifierObserver(capability, root)
        try {
          const peerID = await observer.running(peer)
          const id = await observer.running(attempt)
          expect(id).not.toBe(peerID)
          attempt.abort.abort(new Error("synthetic cancel"))
          expect(await attempt.settled).toBe("Error: synthetic cancel")
          const after = performance.now() + 10000
          expect(await observer.inspect([id], after)).toEqual([])
          expect((await observer.inspect([peerID], after))[0]?.State.Running).toBe(true)
        } finally {
          attempt.abort.abort(new Error("synthetic cancel cleanup"))
          peer.abort.abort(new Error("synthetic peer cleanup"))
          await Promise.all([attempt.settled, peer.settled])
        }
      })
    }, 60000)

    test("ambiguous Docker exec and real keeper death leave UNKNOWN journals, not task failures", async () => {
      return withDockerCapability(async (capability) => {
        for (const mode of ["exec-unavailable", "keeper-death"] as const) {
          const input = waitingTask()
          const task =
            mode === "exec-unavailable"
              ? input.task
              : {
                  ...input.task,
                  verifier: {
                    ...input.task.verifier,
                    testSource: `import fs from 'node:fs';const pid=fs.readdirSync('/proc').filter(value=>value!=='1'&&/^\\d+$/.test(value)).find(value=>{try{return fs.readFileSync('/proc/'+value+'/cmdline','utf8').includes('setInterval(() => {}, 1000)')}catch{return false}});if(!pid)throw new Error('synthetic keeper not found');process.kill(Number(pid),'SIGKILL');await Bun.sleep(60000);`,
                  },
                }
          const shim = dockerShim(
            capability,
            path.join(root, `shim-${input.nonce}`),
            mode === "exec-unavailable" ? mode : "observe",
          )
          const taskFile = path.join(root, `task-${input.nonce}.json`)
          const output = path.join(root, `unknown-${input.nonce}`)
          durableWrite(taskFile, encode(task))
          const result = await runProcess(
            [process.execPath, cli, "experiment", taskFile, output, "--trust-local-code", "--isolated"],
            shim.env,
            60000,
            65536,
          )
          expect(result.exitCode).not.toBe(0)
          expect(result.stderr.text).toContain(
            mode === "exec-unavailable"
              ? "UNKNOWN Docker verifier exec: ambiguous exit 125"
              : "keeper stopped unexpectedly",
          )
          const measurements = inspectJournal(output).filter((entry) => entry.started.startsWith("measurement-"))
          expect(measurements).toHaveLength(1)
          expect(measurements[0].state).toContain("UNKNOWN")
          expect(existsSync(path.join(output, measurements[0].started.replace(".started.json", ".json")))).toBe(false)
          const events = shimEvents(shim.log)
          expect(events.filter((event) => event.kind === "candidate")).toHaveLength(1)
          const ids = events.filter((event) => event.kind === "create").map((event) => event.container)
          expect(ids).toHaveLength(1)
          expect(await verifierObserver(capability, root).inspect(ids)).toEqual([])
        }
      })
    }, 120000)

    test("Effect experiment cancellation waits for exact cleanup and leaves a live peer untouched", async () => {
      return withDockerCapability(async (capability) => {
        for (const mode of ["effect", "option"]) {
          const input = waitingTask()
          const peer = waitingTask()
          const abort = new AbortController()
          const peerAbort = new AbortController()
          const output = path.join(root, `interrupted-${input.nonce}`)
          const peerPending = verifyFiles(peer.task, peer.task.files, "heldout", true, {
            ...isolation,
            signal: peerAbort.signal,
          }).then(
            () => "unexpected completion",
            (error: unknown) => String(error),
          )
          const pending = Effect.runPromise(
            experiment(input.task, output, true, {
              ...isolation,
              signal: mode === "option" ? abort.signal : undefined,
            }),
            { signal: mode === "effect" ? abort.signal : undefined },
          ).then(
            () => "unexpected completion",
            (error: unknown) => String(error),
          )
          const observer = verifierObserver(capability, root)
          try {
            const peerID = await observer.running(peer)
            const id = await observer.running(input)
            abort.abort(new Error("synthetic experiment cancel"))
            expect(await pending).not.toBe("unexpected completion")
            const until = performance.now() + 10000
            expect(await observer.inspect([id], until)).toEqual([])
            expect((await observer.inspect([peerID], until))[0]?.State.Running).toBe(true)
            expect(inspectJournal(output).find((entry) => entry.started.startsWith("measurement-"))?.state).toContain(
              "UNKNOWN",
            )
          } finally {
            abort.abort(new Error("synthetic experiment cleanup"))
            peerAbort.abort(new Error("synthetic peer cleanup"))
            await Promise.all([pending, peerPending])
          }
        }
      })
    }, 120000)

    test("parallel measurement failure aborts its running sibling and awaits both cleanups", async () => {
      return withDockerCapability(async (capability) => {
        const input = waitingTask()
        const smoke = `import {test,expect} from 'bun:test';test('public wait',async()=>{await Bun.write('/output/public-ready',${JSON.stringify(input.nonce)});await Bun.sleep(60000);expect(true).toBe(true)},60000);`
        const task = {
          ...input.task,
          files: { ...input.task.files, "smoke.test.ts": smoke },
          verifier: demoTask.verifier,
        }
        const shim = dockerShim(capability, path.join(root, `parallel-${input.nonce}`), "parallel-failure", input.nonce)
        const taskFile = path.join(root, `parallel-task-${input.nonce}.json`)
        const output = path.join(root, `parallel-output-${input.nonce}`)
        durableWrite(taskFile, encode(task))
        const result = await runProcess(
          [process.execPath, cli, "experiment", taskFile, output, "--trust-local-code", "--isolated"],
          shim.env,
          60000,
          65536,
        )
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr.text).toContain("UNKNOWN Docker verifier exec: ambiguous exit 125")
        const events = shimEvents(shim.log)
        expect(events.filter((event) => event.kind === "peer-running")).toHaveLength(1)
        expect(events.filter((event) => event.kind === "candidate")).toHaveLength(3)
        const ids = events.filter((event) => event.kind === "create").map((event) => event.container)
        expect(ids).toHaveLength(3)
        expect(await verifierObserver(capability, root).inspect(ids)).toEqual([])
        const measurements = inspectJournal(output).filter((entry) => entry.started.startsWith("measurement-"))
        expect(measurements.filter((entry) => entry.state.includes("UNKNOWN"))).toHaveLength(2)
        expect(existsSync(path.join(output, "completed.json"))).toBe(false)
      })
    }, 120000)

    test("Effect cancellation awaits failed cleanup acknowledgment and cannot succeed", async () => {
      return withDockerCapability(async (capability) => {
        const shim = dockerShim(
          capability,
          path.join(root, `uncertain-cleanup-${crypto.randomUUID()}`),
          "cleanup-uncertain",
        )
        const result = await runProcess(
          [process.execPath, path.join(import.meta.dir, "fixture/effect-cancel.ts"), root],
          shim.env,
          60000,
          131072,
        )
        if (result.exitCode !== 0) throw new Error(result.stderr.text)
        expect(result.exitCode).toBe(0)
        const evidence = Schema.decodeUnknownSync(
          Schema.Struct({ state: Schema.Literal("failed"), detail: Schema.String, id: Schema.String }),
        )(parseJson(result.stdout.text))
        expect(evidence.detail).not.toBe("")
        const events = shimEvents(shim.log)
        const ids = events.filter((event) => event.kind === "create").map((event) => event.container)
        expect(ids).toEqual([evidence.id])
        expect(events.filter((event) => event.kind === "cleanup-unknown").map((event) => event.container)).toEqual([
          evidence.id,
        ])
        expect(await verifierObserver(capability, root).inspect(ids)).toEqual([])
      })
    }, 90000)

    test("isolated native experiment, immutable remeasurement, journal binding and zero-live cold replay", async () => {
      const output = path.join(root, "isolated-experiment")
      const result = await Effect.runPromise(experiment(demoTask, output, true, isolation))
      expect(result.baseline).toBe("test-failed")
      expect(result.continuations.map((entry) => [entry.policy, entry.public, entry.heldout])).toEqual([
        ["general", "passed", "passed"],
        ["overfit", "passed", "test-failed"],
      ])
      const file = path.join(output, "general.json")
      const bytes = readFileSync(file)
      const capsule = openRepo(file)
      const receipt = await measureRepo(capsule, "heldout", output, true, isolation)
      expect(readFileSync(file)).toEqual(bytes)
      expect(receipt.status).toBe("passed")
      const syntheticHome = path.join(root, "synthetic-docker-home")
      mkdirSync(path.join(syntheticHome, ".docker"), { recursive: true })
      durableWrite(
        path.join(syntheticHome, ".docker/config.json"),
        encode({
          proxies: {
            default: {
              httpProxy: "http://synthetic-proxy.invalid:9",
              httpsProxy: "http://synthetic-proxy.invalid:9",
              noProxy: "synthetic-no-proxy",
            },
          },
        }),
      )
      const endpoint = (await dockerCapability()).endpoint
      const measuredCLI = await runProcess(
        [process.execPath, cli, "measure", file, "heldout", "--isolated", "--trust-local-code"],
        {
          PATH: process.env.PATH ?? "",
          HOME: syntheticHome,
          DOCKER_HOST: endpoint,
          DOCKER_CONFIG: path.join(syntheticHome, ".docker"),
        },
        30000,
        65536,
      )
      expect(measuredCLI.exitCode).toBe(0)
      expect(Schema.decodeUnknownSync(RepoMeasurement)(parseJson(measuredCLI.stdout.text)).isolation?.mode).toBe(
        "docker-required",
      )
      expect(inspectJournal(output).every((entry) => entry.state === "completed")).toBe(true)
      const host = await measureRepo(capsule, "heldout", output, true)
      const report = compareDirectory(output)
      const markdown = readFileSync(report.markdown, "utf8")
      expect(markdown).toContain("docker-required")
      expect(markdown).toContain("trusted-host")
      expect(markdown).toContain(`measurement-${receipt.id}.json`)
      const cold = await Effect.runPromise(replayRepo(capsule))
      expect(cold.live).toEqual({ provider: 0, tool: 0, world: 0, process: 0 })
      const coldCLI = await runProcess(
        [process.execPath, cli, "replay", file],
        { PATH: path.join(root, "missing-docker"), HOME: root, DOCKER_HOST: "tcp://127.0.0.1:2375" },
        30000,
        65536,
      )
      expect(coldCLI.exitCode).toBe(0)
      expect(
        Schema.decodeUnknownSync(
          Schema.Struct({
            live: Schema.Struct({
              provider: Schema.Literal(0),
              tool: Schema.Literal(0),
              world: Schema.Literal(0),
              process: Schema.Literal(0),
            }),
          }),
        )(parseJson(coldCLI.stdout.text)).live,
      ).toEqual({ provider: 0, tool: 0, world: 0, process: 0 })
      const forgedDirectory = path.join(root, "forged-mode")
      mkdirSync(forgedDirectory)
      const started = parseJson(readFileSync(path.join(output, `measurement-${host.id}.started.json`), "utf8"))
      const value = Schema.decodeUnknownSync(
        Schema.Struct({
          id: Schema.String,
          episode: Schema.String,
          verifier: Schema.String,
          implementation: Schema.String,
          artifact: Schema.String,
          testSource: Schema.String,
          state: Schema.String,
        }),
      )(started)
      durableWrite(
        path.join(forgedDirectory, `measurement-${host.id}.started.json`),
        encode({ ...value, version: 1, isolation: "docker-required" }),
      )
      durableWrite(path.join(forgedDirectory, `measurement-${host.id}.json`), encode(host))
      expect(inspectJournal(forgedDirectory)[0].state).toContain("UNKNOWN")
      const legacy = { ...host }
      delete legacy.isolation
      const legacyDirectory = path.join(root, "legacy")
      mkdirSync(legacyDirectory)
      durableWrite(path.join(legacyDirectory, `measurement-${host.id}.started.json`), encode({ ...value, version: 1 }))
      durableWrite(
        path.join(legacyDirectory, `measurement-${host.id}.json`),
        encode(Schema.decodeUnknownSync(RepoMeasurement)(legacy)),
      )
      expect(inspectJournal(legacyDirectory)[0].state).toBe("completed")
    }, 120000)
  },
)
