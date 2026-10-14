import { mkdirSync, mkdtempSync } from "node:fs"
import path from "node:path"
import os from "node:os"

export const temporary = () => {
  const directory = path.join(os.tmpdir(), "opencode")
  mkdirSync(directory, { recursive: true })
  return mkdtempSync(path.join(directory, "bounded-replay-"))
}
