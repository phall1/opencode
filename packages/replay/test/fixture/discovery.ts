import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const directory = process.argv[2]
const mode = process.argv[3]
const cloud = path.join(directory, "cloud")
const binary = path.join(directory, "bin")
const marker = path.join(directory, "az-called.txt")
mkdirSync(cloud)
mkdirSync(binary)
process.env.AWS_CONFIG_FILE = path.join(cloud, "aws-config")
process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(cloud, "aws-credentials")
process.env.CLOUDSDK_CONFIG = path.join(cloud, "gcloud")
process.env.AZURE_CONFIG_DIR = path.join(cloud, "azure")
process.env.PATH = binary
mkdirSync(process.env.CLOUDSDK_CONFIG, { recursive: true })
mkdirSync(process.env.AZURE_CONFIG_DIR, { recursive: true })
writeFileSync(process.env.AWS_CONFIG_FILE, "[profile synthetic]\n")
writeFileSync(process.env.AWS_SHARED_CREDENTIALS_FILE, "[synthetic]\n")
writeFileSync(
  path.join(process.env.AZURE_CONFIG_DIR, "azureProfile.json"),
  JSON.stringify({ subscriptions: [{ id: "synthetic", name: "synthetic", tenantId: "synthetic", isDefault: true }] }),
)
writeFileSync(
  path.join(binary, "az"),
  `#!${process.execPath}\nimport { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "called\\n"); process.exit(1)\n`,
  { mode: 0o755 },
)

const observations = { reads: 0 }
let acquisitions = 0
Object.defineProperty(FSUtil, "node", {
  value: FSUtil.node.mapLayer((layer) =>
    Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        acquisitions++
        const fs = yield* FSUtil.Service
        return FSUtil.Service.of({
          ...fs,
          readFileStringSafe: (file) => {
            if (file.startsWith(`${cloud}/`)) observations.reads++
            return fs.readFileStringSafe(file)
          },
        })
      }),
    ).pipe(Layer.provide(layer)),
  ),
})

const { demoTask, experiment, openRepo, replayRepo } = await import("../../src/repo")
if (mode === "record") await Effect.runPromise(experiment(demoTask, path.join(directory, "experiment"), true))
if (mode === "replay") await Effect.runPromise(replayRepo(openRepo(process.argv[4])))
if (acquisitions === 0 || observations.reads !== 0 || existsSync(marker))
  throw new Error("Ambient provider discovery performed live I/O")
console.log(JSON.stringify({ acquisitions, observations, cliCalls: existsSync(marker) ? 1 : 0 }))
