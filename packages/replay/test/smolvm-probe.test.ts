import { expect, test } from "bun:test"
import path from "node:path"
import { parseProbeArguments } from "../script/smolvm-probe"
import { runProcess } from "../src/verifier-process"

test("legacy probe accepts only finite integer iterations 1-16", () => {
  expect(parseProbeArguments(["--help"]).mode).toBe("help")
  expect(parseProbeArguments(["1", "/new-output"])).toEqual({ mode: "probe", iterations: 1, directory: "/new-output" })
  expect(parseProbeArguments(["16", "/new-output"]).mode).toBe("probe")
  for (const count of ["0", "-1", "17", "NaN", "Infinity", "1.5", "1e2", "--net", ""]) {
    expect(() => parseProbeArguments([count])).toThrow("Usage:")
  }
  expect(() => parseProbeArguments(["1", "/new-output", "extra"])).toThrow("Usage:")
})

test("legacy probe CLI help and invalid arguments run without a SmolVM binary", async () => {
  const script = path.resolve(import.meta.dir, "../script/smolvm-probe.ts")
  const env = { PATH: "/usr/bin:/bin" }
  const help = await runProcess([process.execPath, script, "--help"], env, 5000, 8192)
  expect(help.exitCode).toBe(0)
  expect(help.stdout.text).toContain("private machine inventory")
  expect(help.stdout.text).toContain("iterations:1-16")
  for (const arg of ["NaN", "Infinity", "0", "17"]) {
    const result = await runProcess([process.execPath, script, arg], env, 5000, 8192)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.text).toContain("Usage:")
    expect(result.stdout.text).not.toContain("spawning process")
  }
})
