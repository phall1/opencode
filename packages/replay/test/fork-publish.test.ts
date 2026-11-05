import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { temporary } from "../src/scratch"

const roots: string[] = []
const commit = "b".repeat(40)
const repository = path.resolve(import.meta.dir, "../../..")
const workflow = Schema.decodeUnknownSync(
  Schema.Struct({
    jobs: Schema.Struct({
      "fork-build": Schema.Struct({ env: Schema.Struct({ OPENCODE_VERSION: Schema.String }) }),
      "fork-publish": Schema.Struct({
        steps: Schema.Array(
          Schema.Struct({
            run: Schema.optional(Schema.String),
            env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          }),
        ),
      }),
    }),
  }),
)(Bun.YAML.parse(readFileSync(path.join(repository, ".github/workflows/replay-native.yml"), "utf8")))
const publish = workflow.jobs["fork-publish"].steps.find((step) => step.run)
if (!publish?.run || !publish.env?.BUILD_VERSION) throw new Error("Missing fork publication step")
const script = publish.run
const publicationVersion = publish.env.BUILD_VERSION
const buildVersion = workflow.jobs["fork-build"].env.OPENCODE_VERSION

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function version(template: string, attempt: number) {
  return template.replaceAll("${{ github.run_number }}", "456").replaceAll("${{ github.run_attempt }}", String(attempt))
}

function fixture() {
  const root = temporary()
  roots.push(root)
  const output = path.join(root, "release")
  const bin = path.join(root, "bin")
  const binary = path.join(root, "opencode")
  mkdirSync(output)
  mkdirSync(bin)
  writeFileSync(binary, "synthetic fork bytes\n")
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/calls'
case "$1 $2" in
  'release view')
    [ -f '${root}/draft' ] || exit 1
    case "$*" in *--json*) cat '${root}/draft' ;; esac ;;
  'release create') echo true > '${root}/draft' ;;
  'release upload') [ "\$FAIL_UPLOAD" != 1 ] || exit 1 ;;
  'release edit') echo false > '${root}/draft' ;;
  *) exit 1 ;;
esac
`,
  )
  chmodSync(path.join(bin, "gh"), 0o755)
  const env = { ...process.env, GITHUB_SHA: commit, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "synthetic" }
  const pack = (target: string, attempt: number) => {
    const result = Bun.spawnSync(["bash", path.join(repository, "script/fork-package.sh"), target, binary, output], {
      env: { ...env, OPENCODE_VERSION: version(buildVersion, attempt) },
    })
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
  }
  ;["darwin-arm64", "linux-arm64", "linux-x64"].forEach((target) => pack(target, 1))
  return {
    output,
    pack,
    calls: () => readFileSync(path.join(root, "calls"), "utf8"),
    draft: () => readFileSync(path.join(root, "draft"), "utf8").trim(),
    run: (attempt: number, failUpload = false) =>
      Bun.spawnSync(["bash", "-c", script], {
        cwd: output,
        env: {
          ...env,
          BUILD_VERSION: version(publicationVersion, attempt),
          GITHUB_RUN_ATTEMPT: String(attempt),
          FAIL_UPLOAD: failUpload ? "1" : "0",
        },
      }),
  }
}

test("publish-only retry resumes a draft with the retained successful build artifacts", () => {
  const fx = fixture()
  expect(fx.run(1, true).exitCode).not.toBe(0)
  expect(fx.draft()).toBe("true")
  const retry = fx.run(2)
  expect(retry.stderr.toString()).toBe("")
  expect(retry.exitCode).toBe(0)
  expect(fx.draft()).toBe("false")
  expect(fx.calls().match(/release create/g)).toHaveLength(1)
  expect(fx.calls().match(/release upload/g)).toHaveLength(2)
  expect(fx.run(3).exitCode).toBe(0)
  expect(fx.calls().match(/release upload/g)).toHaveLength(2)
})

test("one-platform retry composes with retained successful matrix artifacts", () => {
  const fx = fixture()
  const retained = readFileSync(path.join(fx.output, "manifest-darwin-arm64.json"), "utf8")
  rmSync(path.join(fx.output, "opencode-fork-linux-arm64.tar.gz"))
  fx.pack("linux-arm64", 2)
  const result = fx.run(2)
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  expect(readFileSync(path.join(fx.output, "manifest-darwin-arm64.json"), "utf8")).toBe(retained)
  expect(fx.draft()).toBe("false")
})
