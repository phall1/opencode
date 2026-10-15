import { chmodSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Hash, encode, hash, parseJson } from "./archive"
import { MAX_REPORT_BYTES, parseJunit, reportEvidence, type VerifierReport } from "./repo-junit"
import { runProcess } from "./verifier-process"
import { temporary } from "./scratch"

export const IMAGE = "oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895"
export const OWNER_LABEL = "org.opencode.replay.verifier"
const implementation = hash(
  readFileSync(import.meta.filename, "utf8") +
    readFileSync(path.join(import.meta.dir, "verifier-process.ts"), "utf8") +
    readFileSync(path.join(import.meta.dir, "verifier-effect.ts"), "utf8"),
)
export const IsolationMode = Schema.Literals(["trusted-host", "docker-required"])
export type IsolationMode = typeof IsolationMode.Type
export type VerifierOptions = { isolation?: IsolationMode; signal?: AbortSignal }
const GuestProof = Schema.Struct({
  uid: Schema.Int,
  bun: Schema.String,
  noNewPrivs: Schema.String,
  capEff: Schema.String,
  seccomp: Schema.String,
  memory: Schema.String,
  swap: Schema.String,
  cpu: Schema.String,
  pids: Schema.String,
  memoryEvents: Schema.String,
  pidEvents: Schema.String,
})
export const Isolation = Schema.Struct({
  mode: IsolationMode,
  engine: Schema.String,
  profile: Schema.String,
  image: Schema.Union([Schema.String, Schema.Null]),
  imageID: Schema.Union([Schema.String, Schema.Null]),
  platform: Schema.String,
  implementation: Hash,
  enforced: Schema.Array(Schema.String),
  limits: Schema.Struct({
    memoryBytes: Schema.Int,
    nanoCPUs: Schema.Int,
    pids: Schema.Int,
    tmpBytes: Schema.Int,
    outputBytes: Schema.Int,
  }),
  container: Schema.Union([Schema.String, Schema.Null]),
  policyDigest: Schema.Union([Hash, Schema.Null]),
  policy: Schema.NullOr(Schema.Json),
  oomKilled: Schema.NullOr(Schema.Boolean),
  guest: Schema.NullOr(GuestProof),
  securityOptions: Schema.Array(Schema.String),
  cgroupVersion: Schema.NullOr(Schema.String),
  kernel: Schema.NullOr(Schema.String),
  pidLimitHit: Schema.NullOr(Schema.Boolean),
  guestScope: Schema.Literals(["unsupported-host", "before-candidate", "after-candidate"]),
  containerState: Schema.NullOr(
    Schema.Struct({ Running: Schema.Boolean, ExitCode: Schema.Int, OOMKilled: Schema.Boolean, Error: Schema.String }),
  ),
})
export type Isolation = typeof Isolation.Type
export const hostIsolation = (): Isolation => ({
  mode: "trusted-host",
  engine: "host",
  profile: "UNSUPPORTED: no OS containment",
  image: null,
  imageID: null,
  platform: `${process.platform}/${process.arch}`,
  implementation,
  enforced: [],
  limits: { memoryBytes: 0, nanoCPUs: 0, pids: 0, tmpBytes: 0, outputBytes: 0 },
  container: null,
  policyDigest: null,
  policy: null,
  oomKilled: null,
  guest: null,
  securityOptions: [],
  cgroupVersion: null,
  kernel: null,
  pidLimitHit: null,
  guestScope: "unsupported-host",
  containerState: null,
})
export function isolationSummary(isolation?: Isolation) {
  if (!isolation) return "legacy trusted-host: UNSUPPORTED OS containment (no isolation provenance)"
  if (isolation.mode === "docker-required")
    return "docker-required: inspected filesystem/network/process containment; oracle NOT tamper-proof"
  return "trusted-host: UNSUPPORTED OS containment"
}

const limits = { memoryBytes: 268435456, nanoCPUs: 1000000000, pids: 64, tmpBytes: 16777216, outputBytes: 1048576 }
const guestEnv = [
  "HOME=/tmp/home",
  "TMPDIR=/tmp",
  "LANG=C.UTF-8",
  "TZ=UTC",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
  "BUN_INSTALL_BIN=/usr/local/bin",
]
// Keep tmpfs mounted until bounded report retrieval. The candidate runs in a native Docker exec.
const keeperArgs = [
  "--no-install",
  "--no-env-file",
  "--config=/verifier/bunfig.toml",
  "--eval",
  "setInterval(() => {}, 1000)",
]
const Image = Schema.Struct({
  Id: Schema.String,
  Architecture: Schema.String,
  Os: Schema.Literal("linux"),
  Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
})
const Info = Schema.Struct({
  OSType: Schema.Literal("linux"),
  Architecture: Schema.String,
  ServerVersion: Schema.String,
  SecurityOptions: Schema.Array(Schema.String),
  CgroupVersion: Schema.String,
  KernelVersion: Schema.String,
  MemoryLimit: Schema.Boolean,
  SwapLimit: Schema.Boolean,
  CpuCfsQuota: Schema.Boolean,
  PidsLimit: Schema.Boolean,
})
export const Container = Schema.Struct({
  Id: Schema.String,
  Image: Schema.String,
  Config: Schema.Struct({
    Image: Schema.String,
    User: Schema.String,
    WorkingDir: Schema.String,
    Env: Schema.Array(Schema.String),
    Entrypoint: Schema.Array(Schema.String),
    Cmd: Schema.Array(Schema.String),
    Labels: Schema.Record(Schema.String, Schema.String),
    Volumes: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  HostConfig: Schema.Struct({
    NetworkMode: Schema.String,
    ReadonlyRootfs: Schema.Boolean,
    Privileged: Schema.Boolean,
    Init: Schema.Boolean,
    CapDrop: Schema.Array(Schema.String),
    CapAdd: Schema.NullOr(Schema.Array(Schema.String)),
    SecurityOpt: Schema.Array(Schema.String),
    PidMode: Schema.String,
    IpcMode: Schema.String,
    UTSMode: Schema.String,
    UsernsMode: Schema.String,
    CgroupnsMode: Schema.String,
    Memory: Schema.Int,
    MemorySwap: Schema.Int,
    NanoCpus: Schema.Int,
    PidsLimit: Schema.Int,
    LogConfig: Schema.Struct({ Type: Schema.String }),
    Tmpfs: Schema.Record(Schema.String, Schema.String),
    Binds: Schema.NullOr(Schema.Array(Schema.String)),
    Devices: Schema.Array(Schema.Unknown),
    DeviceRequests: Schema.NullOr(Schema.Array(Schema.Unknown)),
    PortBindings: Schema.Record(Schema.String, Schema.Unknown),
    PublishAllPorts: Schema.Boolean,
    RestartPolicy: Schema.Struct({ Name: Schema.String }),
  }),
  Mounts: Schema.Array(
    Schema.Struct({
      Type: Schema.String,
      Source: Schema.String,
      Destination: Schema.String,
      RW: Schema.Boolean,
      Propagation: Schema.String,
    }),
  ),
  State: Schema.Struct({
    Running: Schema.Boolean,
    ExitCode: Schema.Int,
    OOMKilled: Schema.Boolean,
    Error: Schema.String,
  }),
})
type Docker = { cli: string; endpoint: string; env: Record<string, string> }

/** Only a selected local Unix endpoint. Environment/context never controls later Docker calls. */
export function localEndpoint(value: string) {
  if (!/^unix:\/\/\/[a-zA-Z0-9_./ -]+$/.test(value))
    throw new Error("Docker isolation requires a local absolute unix endpoint")
  return `unix://${resolveLocalSocket(value.slice("unix://".length))}`
}

function resolveLocalSocket(file: string, depth = 0): string {
  if (depth > 16) throw new Error("Docker socket symlink depth exceeded")
  // Bun's macOS realpath rejects Unix sockets (EOPNOTSUPP); canonicalize the parent instead.
  const resolved = path.join(realpathSync(path.dirname(file)), path.basename(file))
  const stat = lstatSync(resolved)
  if (stat.isSocket()) return resolved
  if (stat.isSymbolicLink())
    return resolveLocalSocket(path.resolve(path.dirname(resolved), readlinkSync(resolved)), depth + 1)
  throw new Error("Docker endpoint is not a local Unix socket")
}

async function selectedDocker(): Promise<Docker> {
  const cli = Bun.which("docker")
  if (!cli) throw new Error("Docker isolation unavailable: Docker CLI missing; no host fallback")
  const env = clientEnvironment()
  if (process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT)
    return { cli, env, endpoint: localEndpoint(process.env.DOCKER_HOST) }
  const context =
    process.env.DOCKER_CONTEXT ?? (await control({ cli, env, endpoint: "" }, ["context", "show"], false)).trim()
  const result = await control({ cli, env, endpoint: "" }, ["context", "inspect", context], false)
  const contexts = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ Endpoints: Schema.Struct({ docker: Schema.Struct({ Host: Schema.String }) }) })),
  )(parseJson(result))
  if (contexts.length !== 1) throw new Error("Docker context must select one local endpoint")
  return { cli, env, endpoint: localEndpoint(contexts[0].Endpoints.docker.Host) }
}

function clientEnvironment() {
  // Honor selected settings for offline context discovery; bound calls replace this configuration.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    LANG: "C.UTF-8",
  }
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG
  return env
}

function command(docker: Docker, args: string[], bound = true) {
  return [docker.cli, ...(bound ? ["--host", docker.endpoint] : []), ...args]
}
async function control(docker: Docker, args: string[], bound = true) {
  const result = await runProcess(command(docker, args, bound), docker.env, 10000, 65536, { stopOnOverflow: true })
  if (result.timedOut || result.truncated || result.exitCode !== 0)
    throw new Error(
      `Docker controller failed closed (${args[0]}, exit=${result.exitCode}, timeout=${result.timedOut}, truncated=${result.truncated}): ${result.stderr.text}`,
    )
  return result.stdout.text
}
async function inspect(docker: Docker, name: string) {
  const result = Schema.decodeUnknownSync(Schema.Array(Container))(
    parseJson(await control(docker, ["container", "inspect", name])),
  )
  if (result.length !== 1) throw new Error("Expected one owned verifier container")
  return result[0]
}

async function inspectCapability(docker: Docker) {
  const info = Schema.decodeUnknownSync(Info)(parseJson(await control(docker, ["info", "--format", "{{json .}}"])))
  requireDaemonLimits(info)
  const images = Schema.decodeUnknownSync(Schema.Array(Image))(
    parseJson(await control(docker, ["image", "inspect", IMAGE])),
  )
  if (images.length !== 1) throw new Error("Pinned verifier image missing; pull explicitly outside replay")
  const image = images[0]
  const arch = { aarch64: "arm64", x86_64: "amd64", arm64: "arm64", amd64: "amd64" }[info.Architecture]
  if (!arch || image.Architecture !== arch) throw new Error("Pinned verifier image unavailable for daemon platform")
  if (image.Config.Labels["org.opencontainers.image.version"] !== "1.4.2")
    throw new Error("Unexpected pinned Bun version")
  return {
    docker,
    imageID: image.Id,
    platform: `linux/${arch}`,
    engine: `docker/${info.ServerVersion}`,
    bun: "1.4.2",
    securityOptions: info.SecurityOptions,
    cgroupVersion: info.CgroupVersion,
    kernel: info.KernelVersion,
  }
}

/** Context discovery may read the selected local settings; execution never inherits client config. */
export async function withDockerCapability<A>(
  use: (capability: Awaited<ReturnType<typeof inspectCapability>>) => Promise<A>,
) {
  const config = temporary()
  try {
    const selected = await selectedDocker()
    const docker = { ...selected, env: { ...selected.env, DOCKER_CONFIG: config } }
    return await use(await inspectCapability(docker))
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
}

export async function dockerCapability() {
  return withDockerCapability(async (capability) => ({
    endpoint: capability.docker.endpoint,
    imageID: capability.imageID,
    platform: capability.platform,
    engine: capability.engine,
    bun: capability.bun,
    securityOptions: capability.securityOptions,
    cgroupVersion: capability.cgroupVersion,
    kernel: capability.kernel,
  }))
}

function requireDaemonLimits(info: typeof Info.Type) {
  if (!info.SecurityOptions.includes("name=seccomp,profile=builtin") || info.CgroupVersion !== "2")
    throw new Error("Docker isolation requires builtin seccomp and cgroup v2")
  if (![info.MemoryLimit, info.SwapLimit, info.CpuCfsQuota, info.PidsLimit].every(Boolean))
    throw new Error("Docker isolation resource limits unavailable")
}

function tmpfs(uid: number, bytes: number, inodes: number) {
  return `rw,nosuid,nodev,noexec,size=${bytes},nr_inodes=${inodes},uid=${uid},gid=${uid},mode=700`
}
function fixedArgs(target: string) {
  return [
    "--no-install",
    "--no-env-file",
    "--no-orphans",
    "--config=/verifier/bunfig.toml",
    "test",
    "--reporter=junit",
    "--reporter-outfile=/output/junit.xml",
    `./${target}`,
  ]
}
function createArgs(name: string, root: string, uid: number) {
  return [
    "create",
    "--pull=never",
    "--name",
    name,
    "--label",
    `${OWNER_LABEL}=${name}`,
    "--network=none",
    "--read-only",
    "--init",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user",
    `${uid}:${uid}`,
    "--ipc=private",
    "--cgroupns=private",
    "--memory",
    String(limits.memoryBytes),
    "--memory-swap",
    String(limits.memoryBytes),
    "--cpus=1",
    "--pids-limit",
    String(limits.pids),
    "--log-driver=none",
    "--restart=no",
    "--mount",
    `type=bind,source=${root},target=/verifier,readonly,bind-propagation=rprivate`,
    "--tmpfs",
    `/tmp:${tmpfs(uid, limits.tmpBytes, 256)}`,
    "--tmpfs",
    `/output:${tmpfs(uid, limits.outputBytes, 64)}`,
    ...guestEnv.flatMap((value) => ["--env", value]),
    "--workdir=/verifier/repository",
    "--entrypoint=/usr/local/bin/bun",
    IMAGE,
    ...keeperArgs,
  ]
}

function requireEqual(actual: unknown, expected: unknown, name: string) {
  if (encode(actual) !== encode(expected)) throw new Error(`Docker effective policy mismatch: ${name}`)
}
export function assertContainerPolicy(
  container: typeof Container.Type,
  expected: { name: string; root: string; uid: number; imageID: string },
) {
  const config = container.Config
  requireEqual(
    [container.Image, config.Image, config.User, config.WorkingDir, config.Entrypoint, config.Cmd],
    [
      expected.imageID,
      IMAGE,
      `${expected.uid}:${expected.uid}`,
      "/verifier/repository",
      ["/usr/local/bin/bun"],
      keeperArgs,
    ],
    "execution",
  )
  requireEqual(config.Env.toSorted(), guestEnv.toSorted(), "environment")
  requireEqual(config.Labels[OWNER_LABEL], expected.name, "ownership")
  requireEqual(config.Volumes, null, "image volumes")
  assertHostPolicy(container.HostConfig, expected.uid)
  requireEqual(
    container.Mounts,
    [{ Type: "bind", Source: expected.root, Destination: "/verifier", RW: false, Propagation: "rprivate" }],
    "mounts",
  )
  if (container.State.Running) throw new Error("Candidate started before policy validation")
}

function assertHostPolicy(host: typeof Container.Type.HostConfig, uid: number) {
  requireEqual(
    [host.NetworkMode, host.ReadonlyRootfs, host.Privileged, host.CapDrop, host.CapAdd, host.SecurityOpt],
    ["none", true, false, ["ALL"], null, ["no-new-privileges"]],
    "privilege/network",
  )
  requireEqual(host.Init, true, "orphan reaper")
  requireEqual(
    [host.PidMode, host.IpcMode, host.UTSMode, host.UsernsMode, host.CgroupnsMode],
    ["", "private", "", "", "private"],
    "namespaces",
  )
  requireEqual(
    [host.Memory, host.MemorySwap, host.NanoCpus, host.PidsLimit, host.LogConfig.Type],
    [limits.memoryBytes, limits.memoryBytes, limits.nanoCPUs, limits.pids, "none"],
    "resources/logging",
  )
  requireEqual(
    host.Tmpfs,
    { "/tmp": tmpfs(uid, limits.tmpBytes, 256), "/output": tmpfs(uid, limits.outputBytes, 64) },
    "tmpfs",
  )
  requireEqual(
    [host.Binds, host.Devices, host.DeviceRequests, host.PortBindings, host.PublishAllPorts, host.RestartPolicy.Name],
    [null, [], null, {}, false, "no"],
    "unexpected host access",
  )
}

function makeRootReadable(root: string) {
  chmodSync(root, 0o755)
  readdirSync(root, { withFileTypes: true }).forEach((entry) => {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) return makeRootReadable(file)
    chmodSync(file, 0o444)
  })
}

// docker cp cannot read tmpfs on all engines. A fixed fresh process reads a single no-follow FD;
// O_NONBLOCK avoids FIFO hangs, fstat prevents special files, and no untrusted tar is extracted.
const extractor = `const fs = require('node:fs');
let fd;
try {
  fd = fs.openSync('/output/junit.xml', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) console.log(JSON.stringify({state:'unsafe',raw:null}));
  else if (stat.size > ${MAX_REPORT_BYTES}) console.log(JSON.stringify({state:'oversized',raw:null}));
  else {
    const buffer = Buffer.alloc(${MAX_REPORT_BYTES + 1});
    const size = fs.readSync(fd,buffer,0,buffer.length,0);
    console.log(JSON.stringify(size > ${MAX_REPORT_BYTES} ? {state:'oversized',raw:null} : {state:'raw',raw:buffer.subarray(0,size).toString('utf8')}));
  }
} catch (error) {
  if (error.code === 'ENOENT') console.log(JSON.stringify({state:'missing',raw:null}));
  else if (['ELOOP','EISDIR','ENXIO'].includes(error.code)) console.log(JSON.stringify({state:'unsafe',raw:null}));
  else throw error;
} finally { if (fd !== undefined) fs.closeSync(fd); }`
const Extracted = Schema.Union([
  Schema.Struct({ state: Schema.Literal("raw"), raw: Schema.String }),
  Schema.Struct({ state: Schema.Literals(["missing", "unsafe", "oversized"]), raw: Schema.Null }),
])
async function copyReport(docker: Docker, name: string) {
  const result = await runProcess(
    command(docker, [
      "exec",
      name,
      "/usr/local/bin/bun",
      "--no-install",
      "--no-env-file",
      "--config=/verifier/bunfig.toml",
      "--eval",
      extractor,
    ]),
    docker.env,
    10000,
    MAX_REPORT_BYTES * 6 + 1024,
    { stopOnOverflow: true },
  )
  if (result.timedOut || result.truncated || result.exitCode !== 0)
    throw new Error("Docker bounded report retrieval failed")
  const extracted = Schema.decodeUnknownSync(Extracted)(parseJson(result.stdout.text))
  if (extracted.state !== "raw") return reportEvidence(extracted.state, null)
  if (Buffer.byteLength(extracted.raw) > MAX_REPORT_BYTES) return reportEvidence("oversized", null)
  const counts = parseJunit(extracted.raw)
  return reportEvidence(counts ? "complete" : "malformed", extracted.raw, counts)
}

const guestProbe = `const fs = require('node:fs');
const status = fs.readFileSync('/proc/self/status','utf8');
const field = name => status.match(new RegExp('^'+name+':\\\\s*(.*)$','m'))?.[1];
const read = name => fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim();
console.log(JSON.stringify({uid:process.getuid(),bun:Bun.version,noNewPrivs:field('NoNewPrivs'),capEff:field('CapEff'),seccomp:field('Seccomp'),memory:read('memory.max'),swap:read('memory.swap.max'),cpu:read('cpu.max'),pids:read('pids.max'),memoryEvents:read('memory.events'),pidEvents:read('pids.events')}));`
async function guestProof(docker: Docker, name: string, uid: number) {
  const proof = Schema.decodeUnknownSync(GuestProof)(
    parseJson(
      await control(docker, [
        "exec",
        name,
        "/usr/local/bin/bun",
        "--no-install",
        "--no-env-file",
        "--config=/verifier/bunfig.toml",
        "--eval",
        guestProbe,
      ]),
    ),
  )
  requireEqual(
    [proof.uid, proof.bun, proof.noNewPrivs, proof.capEff, proof.seccomp],
    [uid, "1.4.2", "1", "0000000000000000", "2"],
    "guest privilege/seccomp",
  )
  requireEqual(
    [proof.memory, proof.swap, proof.cpu, proof.pids],
    [String(limits.memoryBytes), "0", "100000 100000", String(limits.pids)],
    "guest cgroup limits",
  )
  return proof
}

function eventCount(events: string, field: string) {
  return Number(events.match(new RegExp(`^${field} (\\d+)$`, "m"))?.[1] ?? 0)
}

function resourceEvidence(state: typeof Container.Type.State, proof: typeof GuestProof.Type, observedAfter: boolean) {
  return {
    guestScope: observedAfter ? ("after-candidate" as const) : ("before-candidate" as const),
    oomKilled: state.OOMKilled || (observedAfter ? eventCount(proof.memoryEvents, "oom_kill") > 0 : null),
    pidLimitHit: observedAfter ? eventCount(proof.pidEvents, "max") > 0 : null,
    containerState: state,
  }
}

function requireExecStarted(result: Awaited<ReturnType<typeof runProcess>>, state: typeof Container.Type.State) {
  if ([125, 126, 127].includes(result.exitCode))
    throw new Error(`UNKNOWN Docker verifier exec: ambiguous exit ${result.exitCode}; do not repeat`)
  if (state.Error) throw new Error(`UNKNOWN Docker verifier keeper: ${state.Error}; do not repeat`)
  if (result.timedOut || state.OOMKilled) return
  if (!state.Running) throw new Error("UNKNOWN Docker verifier: keeper stopped unexpectedly; do not repeat")
}

function requireExecCompleted(
  result: Awaited<ReturnType<typeof runProcess>>,
  report: VerifierReport,
  resources: ReturnType<typeof resourceEvidence>,
) {
  if (result.timedOut || result.truncated) return
  if (resources.oomKilled || resources.pidLimitHit) return
  if (result.exitCode !== 0 && report.state !== "complete")
    throw new Error("UNKNOWN Docker verifier exec: nonzero exit without completed JUnit evidence; do not repeat")
}

function verifierUid(root: string) {
  const uid = process.getuid?.() ?? 0
  if (uid !== 0) return uid
  makeRootReadable(root)
  return 1000
}

async function findOwnedContainer(docker: Docker, name: string) {
  const result = await runProcess(command(docker, ["container", "inspect", name]), docker.env, 10000, 65536, {
    stopOnOverflow: true,
  })
  if (result.timedOut || result.truncated) throw new Error("UNKNOWN verifier cleanup: inspection failed")
  if (result.exitCode !== 0) {
    if (/No such (container|object):/.test(result.stderr.text)) return null
    throw new Error("UNKNOWN verifier cleanup: container existence unavailable")
  }
  const containers = Schema.decodeUnknownSync(Schema.Array(Container))(parseJson(result.stdout.text))
  if (containers.length !== 1) throw new Error("UNKNOWN verifier cleanup: unexpected container count")
  const container = containers[0]
  if (container.Config.Labels[OWNER_LABEL] !== name) throw new Error("UNKNOWN verifier cleanup: ownership mismatch")
  return container
}

async function removeOwned(docker: Docker, name: string) {
  const container = await findOwnedContainer(docker, name)
  if (!container) return
  await control(docker, ["rm", "--force", container.Id]).catch((error: unknown) => {
    throw new Error(`UNKNOWN verifier cleanup: ${String(error)}`)
  })
  const remaining = await control(docker, ["ps", "--all", "--quiet", "--filter", `label=${OWNER_LABEL}=${name}`])
  if (remaining.trim()) throw new Error("UNKNOWN verifier cleanup: owned container remains")
}

export async function runDockerVerifier(input: {
  root: string
  target: string
  timeoutMs: number
  outputBytes: number
  signal?: AbortSignal
}) {
  const signal = input.signal ?? new AbortController().signal
  signal.throwIfAborted()
  return withDockerCapability(async (capability) => {
    const uid = verifierUid(input.root)
    const name = `opencode-verifier-${crypto.randomUUID()}`
    try {
      signal.throwIfAborted()
      await control(capability.docker, createArgs(name, input.root, uid))
      const container = await inspect(capability.docker, name)
      assertContainerPolicy(container, { name, root: input.root, uid, imageID: capability.imageID })
      const policy = parseJson(
        encode({
          config: container.Config,
          host: container.HostConfig,
          mounts: container.Mounts,
          image: container.Image,
        }),
      )
      const policyDigest = hash(encode(policy))
      signal.throwIfAborted()
      await control(capability.docker, ["start", name])
      const initialProof = await guestProof(capability.docker, name, uid)
      const result = await runProcess(
        command(capability.docker, ["exec", name, "/usr/local/bin/bun", ...fixedArgs(input.target)]),
        capability.docker.env,
        input.timeoutMs,
        input.outputBytes,
        { signal },
      )
      const settled = await inspect(capability.docker, name)
      requireExecStarted(result, settled.State)
      const observedAfter = settled.State.Running && !result.timedOut
      const proof = observedAfter ? await guestProof(capability.docker, name, uid) : initialProof
      const report = observedAfter ? await copyReport(capability.docker, name) : reportEvidence("missing", null)
      const resources = resourceEvidence(settled.State, proof, observedAfter)
      requireExecCompleted(result, report, resources)
      signal.throwIfAborted()
      const isolation: Isolation = {
        mode: "docker-required",
        engine: capability.engine,
        profile: "fixed-bun-verifier-v1",
        image: IMAGE,
        imageID: capability.imageID,
        platform: capability.platform,
        implementation,
        enforced: [
          "inspected before start",
          "network none",
          "read-only root and single prepared bind",
          "private PID/IPC",
          "unprivileged UID",
          "all capabilities dropped",
          "no-new-privileges",
          "bounded memory/CPU/PIDs/tmpfs",
          "no daemon logs",
          "owned container removed before receipt",
        ],
        limits,
        container: name,
        policyDigest,
        policy,
        ...resources,
        guest: proof,
        securityOptions: capability.securityOptions,
        cgroupVersion: capability.cgroupVersion,
        kernel: capability.kernel,
      }
      return { ...result, report, isolation, execPath: "/usr/local/bin/bun", bun: capability.bun }
    } finally {
      await removeOwned(capability.docker, name)
    }
  })
}
