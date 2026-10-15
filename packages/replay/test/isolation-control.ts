import assert from "node:assert/strict"
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Schema } from "effect"
import { durableWrite, parseJson } from "../src/archive"
import { demoTask } from "../src/repo-task"
import { OWNER_LABEL, withDockerCapability } from "../src/verifier-isolation"
import { runProcess } from "../src/verifier-process"

export function waitingTask() {
  const nonce = crypto.randomUUID()
  const file = `cancel-${nonce}.txt`
  const marker = `/output/cancel-ready-${nonce}`
  return {
    nonce,
    file,
    marker,
    task: {
      ...demoTask,
      files: { ...demoTask.files, [file]: nonce },
      budgets: { ...demoTask.budgets, timeoutMs: 30000 },
      verifier: {
        ...demoTask.verifier,
        testSource: `import {test} from 'bun:test';test('wait',async()=>{await Bun.write(${JSON.stringify(marker)},JSON.stringify({nonce:${JSON.stringify(nonce)},pid:process.pid}));await Bun.sleep(60000)},60000);`,
      },
    },
  }
}

const Inspected = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    State: Schema.Struct({ Running: Schema.Boolean }),
    Mounts: Schema.Array(
      Schema.Struct({ Type: Schema.String, Source: Schema.String, Destination: Schema.String, RW: Schema.Boolean }),
    ),
  }),
)

/** Read-only discovery identifies an attempt by its synthetic input, never by global inventory equality. */
export function verifierObserver(
  capability: Parameters<Parameters<typeof withDockerCapability>[0]>[0],
  scratchRoot: string,
) {
  const deadline = performance.now() + 10000
  const invoke = async (args: string[], until = deadline) => {
    const result = await runProcess(
      [capability.docker.cli, "--host", capability.docker.endpoint, ...args],
      capability.docker.env,
      Math.max(1, Math.ceil(until - performance.now())),
      131072,
      { stopOnOverflow: true },
    )
    assert.equal(result.timedOut, false)
    assert.equal(result.truncated, false)
    return result
  }
  const inspect = async (ids: string[], until = deadline) => {
    if (!ids.length) return []
    const result = await invoke(["container", "inspect", ...ids], until)
    // Other sessions may retire their containers between listing and inspection.
    if (result.exitCode !== 0) assert.match(result.stderr.text, /No such (container|object):/)
    return Schema.decodeUnknownSync(Inspected)(parseJson(result.stdout.text))
  }
  const running = async (input: ReturnType<typeof waitingTask>) => {
    while (performance.now() < deadline) {
      const listed = await invoke(["ps", "--quiet", "--filter", `label=${OWNER_LABEL}`])
      assert.equal(listed.exitCode, 0)
      const ids = listed.stdout.text.trim().split(/\s+/).filter(Boolean)
      const container = (await inspect(ids)).find((entry) => matches(entry, input, scratchRoot))
      if (container?.State.Running) {
        // A test-body marker plus a live, non-zombie PID proves the candidate, not merely the keeper.
        const ready = await invoke([
          "exec",
          container.Id,
          "/usr/local/bin/bun",
          "--no-install",
          "--no-env-file",
          "--eval",
          `const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(${JSON.stringify(input.marker)},'utf8'));process.kill(value.pid,0);if(/State:\\s*Z/.test(fs.readFileSync('/proc/'+value.pid+'/status','utf8')))process.exit(1);console.log(value.nonce)`,
        ])
        if (ready.exitCode === 0 && ready.stdout.text.trim() === input.nonce) return container.Id
      }
      await Bun.sleep(25)
    }
    throw new Error(`Own verifier did not start within 10 seconds: ${input.file}`)
  }
  return { invoke, inspect, running }
}

function preparedInput(container: (typeof Inspected.Type)[number], file: string, scratchRoot: string) {
  if (container.Mounts.length !== 1) return
  const mount = container.Mounts[0]
  if (mount.Type !== "bind" || mount.Destination !== "/verifier" || mount.RW) return
  if (realpathSync(path.dirname(mount.Source)) !== realpathSync(path.dirname(scratchRoot))) return
  return path.join(mount.Source, "repository", file)
}

function matches(
  container: (typeof Inspected.Type)[number],
  input: ReturnType<typeof waitingTask>,
  scratchRoot: string,
) {
  const file = preparedInput(container, input.file, scratchRoot)
  if (!file) return false
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile()) return false
  return readFileSync(file, "utf8") === input.nonce
}

/** Real Docker delegation with one controlled CLI fault; no simulated containment results. */
export function dockerShim(
  capability: Parameters<Parameters<typeof withDockerCapability>[0]>[0],
  directory: string,
  mode: "observe" | "exec-unavailable" | "cleanup-uncertain" | "parallel-failure",
  publicNonce = "",
) {
  mkdirSync(directory)
  const log = path.join(directory, "events.jsonl")
  const file = path.join(directory, "docker")
  durableWrite(
    file,
    `#!${process.execPath} --no-orphans
import fs from 'node:fs';
import {runProcess} from ${JSON.stringify(path.join(import.meta.dir, "../src/verifier-process.ts"))};
const args=process.argv.slice(2);
const record=(kind,container)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({kind,container})+'\\n');
if(args.includes('exec')&&args.includes('test')){
  record('candidate',args[args.indexOf('exec')+1]);
  if(${JSON.stringify(mode)}==='exec-unavailable'){console.error('synthetic Docker exec unavailable');process.exit(125);}
  if(${JSON.stringify(mode)}==='parallel-failure'&&args.includes('./smoke.test.ts')){
    const gate=${JSON.stringify(path.join(directory, "first-public"))};
    const first=()=>{try{fs.writeFileSync(gate,'claimed',{flag:'wx'});return true}catch(error){if(error.code==='EEXIST')return false;throw error}};
    if(first()){
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){
        const others=fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(JSON.parse).filter(event=>event.kind==='candidate'&&event.container!==args[args.indexOf('exec')+1]);
        for(const other of others){
          const probe=await runProcess([${JSON.stringify(capability.docker.cli)},'--host',${JSON.stringify(capability.docker.endpoint)},'exec',other.container,'/usr/local/bin/bun','--no-install','--no-env-file','--eval',"console.log(require('node:fs').readFileSync('/output/public-ready','utf8'))"],process.env,Math.max(1,deadline-Date.now()),65536);
          if(probe.exitCode===0&&probe.stdout.text.trim()===${JSON.stringify(publicNonce)}){record('peer-running',other.container);console.error('synthetic parallel exec failure');process.exit(125);}
        }
        await Bun.sleep(25);
      }
      throw new Error('synthetic parallel peer did not start');
    }
  }
}
const result=await runProcess([${JSON.stringify(capability.docker.cli)},...args],Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined)),10000,65536,{stopOnOverflow:true});
if(args.includes('create')&&result.exitCode===0)record('create',result.stdout.text.trim());
if(args.includes('rm')&&result.exitCode===0){
  record('removed',args[args.length-1]);
  if(${JSON.stringify(mode)}==='cleanup-uncertain'){record('cleanup-unknown',args[args.length-1]);console.error('synthetic UNKNOWN cleanup acknowledgment');process.exit(1);}
}
process.stdout.write(result.stdout.text);process.stderr.write(result.stderr.text);process.exit(result.exitCode);
`,
  )
  chmodSync(file, 0o700)
  return {
    log,
    env: {
      PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? directory,
      TMPDIR: os.tmpdir(),
      DOCKER_HOST: capability.docker.endpoint,
    },
  }
}

export function shimEvents(log: string) {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((raw) =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          kind: Schema.Literals(["create", "candidate", "peer-running", "removed", "cleanup-unknown"]),
          container: Schema.String,
        }),
      )(parseJson(raw)),
    )
}
