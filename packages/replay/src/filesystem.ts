import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Layer, PlatformError } from "effect"
import path from "node:path"

const fixture = (value: string) => {
  const resolved = path.posix.resolve("/", value)
  return resolved === "/fixture" || resolved.startsWith("/fixture/")
}

/** Keep host bookkeeping, but remove host observations of virtual fixture paths. */
export function boundedFileSystem(fs: FSUtil.Interface): FSUtil.Interface {
  const denied = (value: string, method: string) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "ReplayFS",
        method,
        pathOrDescriptor: value,
        description: "Fixture paths exist only through their isolated Environment world",
      }),
    )
  return {
    ...fs,
    resolve: (value) =>
      fixture(value) || value === "/" ? Effect.succeed(path.posix.resolve("/", value)) : fs.resolve(value),
    realPath: (value) => (fixture(value) ? Effect.succeed(path.posix.resolve("/", value)) : fs.realPath(value)),
    up: (options) => (fixture(options.start) ? Effect.succeed([]) : fs.up(options)),
    findUp: (target, start, stop) => (fixture(start) ? Effect.succeed([]) : fs.findUp(target, start, stop)),
    globUp: (pattern, start, stop) => (fixture(start) ? Effect.succeed([]) : fs.globUp(pattern, start, stop)),
    stat: (value) => (fixture(value) ? denied(value, "stat") : fs.stat(value)),
    exists: (value) => (fixture(value) ? Effect.succeed(false) : fs.exists(value)),
    existsSafe: (value) => (fixture(value) ? Effect.succeed(false) : fs.existsSafe(value)),
    isFile: (value) => (fixture(value) ? Effect.succeed(false) : fs.isFile(value)),
    isDir: (value) => (fixture(value) ? Effect.succeed(false) : fs.isDir(value)),
    readDirectory: (value, options) => (fixture(value) ? Effect.succeed([]) : fs.readDirectory(value, options)),
    readDirectoryEntries: (value) => (fixture(value) ? Effect.succeed([]) : fs.readDirectoryEntries(value)),
    readFileStringSafe: (value) => (fixture(value) ? Effect.undefined : fs.readFileStringSafe(value)),
    readFileString: (value, encoding) =>
      fixture(value) ? denied(value, "readFileString") : fs.readFileString(value, encoding),
    readFile: (value) => (fixture(value) ? denied(value, "readFile") : fs.readFile(value)),
    readJson: (value) => (fixture(value) ? denied(value, "readJson") : fs.readJson(value)),
  }
}

export const boundedFileSystemNode = () =>
  FSUtil.node.mapLayer((layer) =>
    Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        return boundedFileSystem(fs)
      }),
    ).pipe(Layer.provide(layer)),
  )
