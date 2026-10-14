import { Auth, LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Config } from "@opencode/core/config"
import { EnvironmentMemory } from "@opencode/core/environment/memory"
import { Environment } from "@opencode/core/environment/index"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Formatter } from "@opencode/core/formatter"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { HttpRecorder } from "@opencode/http-recorder"
import { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { AbsolutePath } from "@opencode/schema/schema"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Workspace } from "@opencode/schema/workspace"
import { OpenCode } from "@opencode/sdk/effect"
import { SimulationNetwork } from "@opencode/simulation/backend/network"
import { SimulationOpenAI } from "@opencode/simulation/backend/openai"
import { SimulatedProvider } from "@opencode/simulation/backend/simulated-provider"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Files, NativeExport, ToolEntry, encode, hash, parseJson } from "./archive"
import { ToolTape } from "./tape"
import { boundedFileSystemNode } from "./filesystem"

export const INSTRUCTIONS =
  "Bounded public text repair fixture. Use only read and write on /fixture/repair.txt. No processes or network tools."
export const PROMPT = "Read /fixture/repair.txt and repair teh to the."
export const INITIAL = { "/fixture/repair.txt": "teh small fixture\n" }
export interface Counters {
  provider: number
  http: number
  failures: string[]
}
export const SESSION_ID = Session.ID.make("ses_bounded_replay_fixture")
export const ROOT = path.resolve(import.meta.dir, "../../..")
const SOURCES = [
  "bun.lock",
  "package.json",
  "packages/core/src/session.ts",
  "packages/core/src/session/runner/llm.ts",
  "packages/core/src/session/runner/step.ts",
  "packages/core/src/session/model-request.ts",
  "packages/core/src/session/instruction-state.ts",
  "packages/core/src/session/instructions.ts",
  "packages/core/src/file-access.ts",
  "packages/core/src/file-mutation.ts",
  "packages/util/src/fs-util.ts",
  "packages/core/src/session/runner/to-llm-message.ts",
  "packages/core/src/tool.ts",
  "packages/core/src/tool/plugin/read.ts",
  "packages/core/src/tool/plugin/write.ts",
  "packages/core/src/environment/memory.ts",
  "packages/core/src/config.ts",
  "packages/core/src/permission.ts",
  "packages/ai/src/protocols/openai-chat.ts",
  "packages/ai/src/route/executor.ts",
  "packages/sdk/src/effect/opencode.ts",
  "packages/http-recorder/src/http/recorder.ts",
  "packages/replay/src/runtime.ts",
  "packages/replay/src/tape.ts",
  "packages/replay/src/archive.ts",
  "packages/replay/src/filesystem.ts",
  "packages/replay/src/index.ts",
]

export const sourcePins = () => {
  const resolved = readFileSync(
    path.resolve(realpathSync(Bun.resolveSync("effect", import.meta.dir)), "../../package.json"),
    "utf8",
  )
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.Literal("4.0.1") })))(resolved)
  return {
    ...Object.fromEntries(SOURCES.map((file) => [file, hash(readFileSync(path.join(ROOT, file), "utf8"))])),
    "resolved/effect/package.json": hash(resolved),
  }
}
export const temporary = () => {
  const directory = path.join(os.tmpdir(), "opencode")
  mkdirSync(directory, { recursive: true })
  return mkdtempSync(path.join(directory, "bounded-replay-"))
}

export const withScratch = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(Effect.sync(temporary), (directory) =>
    Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(use))

export const makeWorld = Effect.fn("Replay.makeWorld")(function* (files: typeof Files.Type) {
  const driver = EnvironmentMemory.makeMemoryDriver()
  const tree = Environment.makeFiles(driver)
  yield* tree.mkdir("/fixture")
  yield* Effect.forEach(Object.entries(files), ([file, text]) => tree.write(file, new TextEncoder().encode(text)), {
    concurrency: 1,
  })
  return driver
})

export const snapshotWorld = Effect.fn("Replay.snapshotWorld")(function* (driver: EnvironmentMemory.MemoryDriver) {
  const tree = Environment.makeFiles(driver)
  const walk = (directory: string): Effect.Effect<readonly (readonly [string, string])[], unknown> =>
    Effect.gen(function* () {
      const entries = yield* tree.list(directory)
      const nested = yield* Effect.forEach(
        entries,
        (entry) => {
          const file = `${directory}/${entry.name}`
          if (entry.type === "directory") return walk(file)
          if (entry.type !== "file") return Effect.die("Unsupported checkpoint entry")
          return tree
            .read(file)
            .pipe(
              Effect.map((result) => [[file, new TextDecoder("utf8", { fatal: true }).decode(result.bytes)] as const]),
            )
        },
        { concurrency: 1 },
      )
      return nested.flat()
    })
  return Schema.decodeUnknownSync(Files)(Object.fromEntries(yield* walk("/fixture")))
})

export function fixtureProvider(counters: { provider: number }, continuation = false): SimulatedProvider.Interface {
  const responses: readonly (readonly SimulatedProvider.ProviderResponseEvent[])[] = continuation
    ? [
        toolResponse("child-write", "write", { path: "/fixture/repair.txt", content: "child one only\n" }),
        textResponse("child repaired"),
      ]
    : [
        toolResponse("read-1", "read", { path: "/fixture/repair.txt" }),
        toolResponse("write-1", "write", { path: "/fixture/repair.txt", content: "the small fixture\n" }),
        textResponse("repaired"),
      ]
  return {
    stream: () =>
      Stream.suspend(() => {
        const response = responses[counters.provider++]
        if (!response)
          return Stream.fail(
            new SimulatedProvider.ProviderDisconnectedError({ message: "Fixture response budget exhausted" }),
          )
        return Stream.fromIterable(response)
      }),
  }
}

function toolResponse(
  id: string,
  name: string,
  input: Schema.Json,
): readonly SimulatedProvider.ProviderResponseEvent[] {
  return [
    { type: "toolCall", index: 0, id, name, input },
    { type: "finish", reason: "tool-calls" },
  ]
}
function textResponse(text: string): readonly SimulatedProvider.ProviderResponseEvent[] {
  return [
    { type: "textDelta", text },
    { type: "finish", reason: "stop" },
  ]
}

export function boundedPlugin(tape: () => ToolTape) {
  return Plugin.define({
    id: "bounded-replay",
    effect: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.agent.transform((editor) => {
          editor.list().forEach((agent) => editor.remove(agent.id))
          editor.update(Agent.ID.make("fixture"), (agent) => {
            agent.system = INSTRUCTIONS
            agent.steps = 4
            agent.permissions = [
              { action: "*", resource: "*", effect: "deny" },
              { action: "read", resource: "*", effect: "allow" },
              { action: "edit", resource: "*", effect: "allow" },
            ]
          })
          editor.default(Agent.ID.make("fixture"))
        })
        yield* ctx.tool.transform((editor) => {
          editor.list().forEach((tool) => {
            if (tool.name !== "read" && tool.name !== "write") {
              editor.remove(tool.id)
              return
            }
            const name = tool.name
            editor.update(tool.id, (definition) => {
              definition.options = { codemode: false, ...(name === "write" ? { permission: "edit" } : {}) }
              const execute = definition.execute
              definition.execute = (input, context) => tape().wrap(name, execute)(input, context)
            })
          })
        })
        yield* ctx.session.hook("retry", (event) =>
          Effect.sync(() => {
            event.decision = { retry: false }
          }),
        )
        yield* ctx.session.hook("title", (event) =>
          Effect.sync(() => {
            event.result = "Bounded repair"
          }),
        )
      }).pipe(Effect.orDie),
  })
}

export const createHost = Effect.fn("Replay.createHost")(function* (options: {
  directory: string
  tape: ToolTape
  files: typeof Files.Type
  counters: Counters
}) {
  const world = yield* makeWorld(options.files)
  const worlds = new Map<Workspace.ID, EnvironmentMemory.MemoryDriver>()
  const driver = WorkspaceDriver.make({
    create: ({ workspaceID }) => Effect.succeed({ binding: { externalID: workspaceID } }),
    connect: ({ workspaceID }) => {
      const connected = worlds.get(workspaceID)
      return connected ? Effect.succeed(connected) : Effect.die("Unknown replay world")
    },
    destroy: () => Effect.void,
    suspendForIdle: () => Effect.void,
  })
  const network =
    options.tape.mode === "record"
      ? SimulationNetwork.layer([SimulationOpenAI.route(fixtureProvider(options.counters))])
      : SimulationNetwork.layer()
  const transport = HttpRecorder.layer("provider", {
    mode: options.tape.mode,
    directory: options.directory,
    match: strictMatch,
  }).pipe(Layer.provide(network))
  const state = {
    client: Context.get(yield* Layer.build(transport), HttpClient.HttpClient),
    tape: options.tape,
    counters: options.counters,
  }
  const counted = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        state.counters.http++
        if (state.counters.http > 8) return Effect.die("HTTP budget exceeded")
        return state.client.execute(request).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              state.counters.failures.push(error.message)
            }),
          ),
        )
      }),
    ),
  )
  const resolved = SessionRunnerModel.resolved(
    LanguageModel.make({ id: "repair-v1", provider: "fixture", route: OpenAIChat.route.with({ auth: Auth.none }) }),
    {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      cost: [],
      limit: { context: 100_000, output: 1_000 },
    },
  )
  const pinned = Instructions.make({
    key: Instructions.Key.make("replay/pinned"),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(INSTRUCTIONS),
    render: { initial: (value) => value, changed: (_before, value) => value },
  })
  const opencode = yield* OpenCode.create(
    {
      models: { fetch: false },
      fs: { filewatcher: false },
      events: { persist: true },
      workspaceProviders: { replay: driver },
      plugins: [boundedPlugin(() => state.tape)],
    },
    {
      overrides: [
        Config.node.replace(Config.testLayer()),
        FSUtil.node.replace(boundedFileSystemNode()),
        SessionInstructions.node.replace(Layer.succeed(SessionInstructions.Service, { load: () => Effect.void })),
        httpClient.replace(counted),
        Snapshot.node.replace(Snapshot.noopLayer),
        Formatter.node.replace(
          Layer.succeed(Formatter.Service, {
            file: () => Effect.succeed(false),
            transform: () => Effect.succeed({ dispose: Effect.void }),
            reload: () => Effect.void,
          }),
        ),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured({ global: false, project: false })),
        InstructionBuiltIns.node.replace(
          Layer.succeed(InstructionBuiltIns.Service, { load: () => Effect.succeed(pinned) }),
        ),
        SkillInstructions.node.replace(
          Layer.succeed(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        ReferenceInstructions.node.replace(
          Layer.succeed(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        McpInstructions.node.replace(
          Layer.succeed(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(resolved) }),
        ),
      ],
    },
  )
  const attach = Effect.fn("Replay.attachWorld")(function* (driver: EnvironmentMemory.MemoryDriver) {
    const workspaceID = yield* opencode.workspace.create({ provider: "replay" })
    worlds.set(workspaceID, driver)
    return Location.Ref.make({ directory: AbsolutePath.make("/"), workspaceID })
  })
  const location = yield* attach(world)
  const beginTrajectory = Effect.fn("Replay.beginTrajectory")(function* (
    directory: string,
    expected?: readonly ToolEntry[],
  ) {
    const counters: Counters = { provider: 0, http: 0, failures: [] }
    const tape = new ToolTape(expected ? "replay" : "record", directory, expected)
    const client = Context.get(
      yield* Layer.build(
        HttpRecorder.layer("provider", { mode: tape.mode, directory, match: strictMatch }).pipe(
          Layer.provide(
            expected
              ? SimulationNetwork.layer()
              : SimulationNetwork.layer([SimulationOpenAI.route(fixtureProvider(counters, true))]),
          ),
        ),
      ),
      HttpClient.HttpClient,
    )
    Object.assign(state, { client, counters, tape })
    return { counters, tape }
  })
  return { opencode, world, attach, location, beginTrajectory }
})

export const runPrompt = Effect.fn("Replay.runPrompt")(function* (
  opencode: OpenCode.Interface,
  sessionID: Session.ID,
  text: string,
) {
  yield* opencode.sessions.prompt({ sessionID, text })
  yield* opencode.sessions.wait({ sessionID })
  const active = yield* opencode.sessions.active()
  if (active[sessionID]) return yield* Effect.die("Checkpoint is not quiescent")
  if ((yield* opencode.sessions.inbox.list({ sessionID })).length)
    return yield* Effect.die("Checkpoint has pending work")
  const result = yield* opencode.sessions.export({ sessionID, sanitize: false })
  if (result.info.outcome !== "succeeded")
    return yield* Effect.die(`Native execution did not succeed: ${result.info.outcome}`)
  return result
})

/** Compare model-visible content, not generated projection IDs, timestamps or accounting. */
export function contextView(messages: readonly SessionMessage.Info[]) {
  return encode(
    messages
      .map((message) => {
        if (message.type === "assistant")
          return {
            type: message.type,
            agent: message.agent,
            model: message.model,
            finish: message.finish,
            content: message.content.map((part) => {
              if (part.type === "tool") return { type: part.type, id: part.id, name: part.name, state: part.state }
              return { type: part.type, text: part.text }
            }),
          }
        if (message.type === "user" || message.type === "system" || message.type === "synthetic")
          return { type: message.type, text: message.text }
        if (message.type === "idle") return { type: message.type, outcome: message.outcome }
        if (message.type === "location-switched") return { type: message.type, directory: message.location.directory }
        throw new Error(`Unsupported bounded context message: ${message.type}`)
      })
      .map((value) => parseJson(JSON.stringify(value))),
  )
}

export const exportText = (value: typeof NativeExport.Type) => encode(Schema.encodeSync(NativeExport)(value))

function strictMatch(recorded: HttpRecorder.RequestSnapshot, incoming: HttpRecorder.RequestSnapshot) {
  return (
    recorded.method === incoming.method &&
    recorded.url === incoming.url &&
    encode(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(recorded.body)) ===
      encode(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(incoming.body))
  )
}

export function makeRunDirectory(directory: string, name: string) {
  const target = path.join(directory, name)
  mkdirSync(target)
  return target
}
