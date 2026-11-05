import { afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { temporary } from "../src/scratch"

const roots: string[] = []
const script = path.resolve(import.meta.dir, "../../../script/fork-package.sh")
const commit = "a".repeat(40)
const version = "0.0.0-fork-123.1"

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = temporary()
  roots.push(root)
  const binary = path.join(root, "opencode")
  const output = path.join(root, "release")
  mkdirSync(output)
  writeFileSync(binary, "synthetic executable bytes\n")
  return {
    binary,
    output,
    run: (env: { GITHUB_SHA?: string; OPENCODE_VERSION?: string } = {}) =>
      Bun.spawnSync(["bash", script, "darwin-arm64", binary, output], {
        env: { ...process.env, GITHUB_SHA: commit, OPENCODE_VERSION: version, ...env },
      }),
  }
}

test("fork package binds a minimal archive and checksum to its source and channel", async () => {
  const fx = fixture()
  const result = fx.run()
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  expect(await Bun.file(path.join(fx.output, "manifest-darwin-arm64.json")).json()).toEqual({
    version: 1,
    repository: "phall1/opencode",
    commit,
    channel: "fork",
    buildVersion: version,
    targets: ["darwin-arm64"],
  })
  const archive = path.join(fx.output, "opencode-fork-darwin-arm64.tar.gz")
  const files = Bun.spawnSync(["tar", "-tzf", archive])
  expect(files.exitCode).toBe(0)
  expect(files.stdout.toString()).toBe("bin/opencode\n")
  const bytes = Bun.spawnSync(["tar", "-xOf", archive, "bin/opencode"])
  expect(bytes.exitCode).toBe(0)
  expect(bytes.stdout.toString()).toBe(readFileSync(fx.binary, "utf8"))
  expect(readFileSync(path.join(fx.output, "SHA256SUMS-darwin-arm64"), "utf8")).toBe(
    `${new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")}  opencode-fork-darwin-arm64.tar.gz\n`,
  )
  expect(fx.run().exitCode).not.toBe(0)
})

test.each([{ GITHUB_SHA: "not-a-source-commit" }, { OPENCODE_VERSION: "2.2.5" }])(
  "fork packaging refuses invalid provenance %j",
  (env) => {
    const fx = fixture()
    expect(fx.run(env).exitCode).not.toBe(0)
  },
)

test("fork packaging refuses symlink executables", () => {
  const fx = fixture()
  const original = `${fx.binary}.original`
  writeFileSync(original, readFileSync(fx.binary))
  rmSync(fx.binary)
  symlinkSync(original, fx.binary)
  expect(fx.run().exitCode).not.toBe(0)
})
