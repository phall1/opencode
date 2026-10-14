import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { temporary } from "../src/scratch"
import { parseJson } from "../src/archive"

test("provider discovery cannot consult synthetic AWS/gcloud files or execute a synthetic Azure CLI", async () => {
  const directory = temporary()
  const replay = temporary()
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/discovery.ts"), ...args], {
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
    expect(parseJson(stdout)).toMatchObject({ observations: { reads: 0 }, cliCalls: 0 })
  }
  try {
    await run(directory, "record")
    await run(replay, "replay", path.join(directory, "experiment/general.json"))
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(replay, { recursive: true, force: true })
  }
}, 60_000)
