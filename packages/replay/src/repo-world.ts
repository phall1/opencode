import { Environment } from "@opencode/core/environment/index"
import { Effect, Schema } from "effect"
import { make } from "effect/process/ChildProcessSpawner"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { RepoFiles, Task, validateFiles, virtual } from "./repo-task"

/** All operations supplied: execDefaults can never fall through to a process. */
export function poisonWorld(observations = { world: 0, process: 0 }): Environment.Driver {
  const forbidden = () =>
    Effect.suspend(() => {
      observations.world++
      return Effect.die("Live world observation forbidden during strict replay")
    })
  const spawner = make(() =>
    Effect.suspend(() => {
      observations.process++
      return Effect.die("Actor process execution forbidden")
    }),
  )
  return {
    spawner,
    overrides: {
      read: forbidden,
      write: forbidden,
      stat: forbidden,
      list: forbidden,
      remove: forbidden,
      move: forbidden,
      mkdir: forbidden,
    },
  }
}

export function restoreFiles(directory: string, files: typeof RepoFiles.Type) {
  const declared = Schema.decodeUnknownSync(RepoFiles, { onExcessProperty: "error" })(files)
  mkdirSync(directory)
  Object.entries(declared).forEach(([file, text]) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    writeFileSync(path.join(directory, file), text, { flag: "wx", mode: 0o600 })
  })
}

export function diskWorld(directory: string, task: Task, files: typeof RepoFiles.Type): Environment.Driver {
  validateFiles(task, files)
  restoreFiles(directory, files)
  const spawner = poisonWorld().spawner
  const local = Environment.makeLocalDriver(spawner).overrides
  if (!local?.read || !local.write || !local.stat || !local.list)
    throw new Error("Native local file adapter unavailable")
  const native = { read: local.read, write: local.write, stat: local.stat, list: local.list }
  const mapped = (value: string) => safePath(directory, files, value)
  const unsupported = () => Effect.die("Unsupported repo world mutation")
  return {
    spawner,
    overrides: {
      read: (value, range) => Effect.suspend(() => native.read(mapped(value), range)),
      stat: (value) => Effect.suspend(() => native.stat(mapped(value))),
      list: (value) => Effect.suspend(() => native.list(mapped(value))),
      write: (value, bytes) =>
        Effect.suspend(() => {
          if (!task.writePaths.map(virtual).includes(value)) return Effect.die("Undeclared mutable path")
          if (bytes.length > task.budgets.fileBytes) return Effect.die("File byte budget exceeded")
          new TextDecoder("utf8", { fatal: true }).decode(bytes)
          return native.write(mapped(value), bytes)
        }),
      remove: unsupported,
      move: unsupported,
      mkdir: unsupported,
    },
  }
}

function safePath(directory: string, files: typeof RepoFiles.Type, value: string) {
  const paths = Object.keys(files).map(virtual)
  if (!paths.some((file) => file === value || file.startsWith(`${value}/`))) throw new Error("Out-of-scope world path")
  const relative = value.replace(/^\/fixture\/?/, "")
  const target = path.join(directory, relative)
  const parts = relative ? relative.split("/") : []
  ;[directory, ...parts.map((_part, index) => path.join(directory, ...parts.slice(0, index + 1)))].forEach(
    (component) => {
      const entry = lstatSync(component)
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        throw new Error("Symlink/special file world entry forbidden")
    },
  )
  return target
}

export function snapshotDisk(directory: string, task: Task) {
  const files = Object.fromEntries(
    Object.keys(task.files).map((file) => [
      file,
      new TextDecoder("utf8", { fatal: true }).decode(readFileSync(safePath(directory, task.files, virtual(file)))),
    ]),
  )
  validateFiles(task, files)
  return files
}
