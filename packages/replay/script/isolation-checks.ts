import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { durableWrite, encode, parseJson } from "../src/archive"
import { verifyFiles } from "../src/repo-measure"
import { demoTask } from "../src/repo-task"
import { IMAGE, OWNER_LABEL, dockerCapability, withDockerCapability } from "../src/verifier-isolation"
import { runProcess } from "../src/verifier-process"

/** One deliberately uncontained trusted network control; only contacts our own canary server. */
async function reachableHost(port: number) {
  return withDockerCapability(async (capability) => {
    const name = `opencode-verifier-control-${crypto.randomUUID()}`
    const docker = capability.docker
    const invoke = async (args: string[]) => {
      const result = await runProcess([docker.cli, "--host", docker.endpoint, ...args], docker.env, 10000, 65536, {
        stopOnOverflow: true,
      })
      assert.equal(result.timedOut, false)
      assert.equal(result.truncated, false)
      assert.equal(result.exitCode, 0, result.stderr.text)
      return result.stdout.text
    }
    const source = `const address=(await Bun.dns.lookup('host.docker.internal'))[0].address; const response=await fetch('http://'+address+':${port}',{signal:AbortSignal.timeout(2000)}); console.log(JSON.stringify({address,text:await response.text()}));`
    try {
      await invoke([
        "create",
        "--pull=never",
        "--name",
        name,
        "--label",
        `${OWNER_LABEL}=${name}`,
        "--network=bridge",
        "--add-host=host.docker.internal:host-gateway",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user=1000:1000",
        "--memory=128m",
        "--memory-swap=128m",
        "--cpus=1",
        "--pids-limit=32",
        "--log-driver=none",
        "--entrypoint=/usr/local/bin/bun",
        IMAGE,
        "--no-install",
        "--no-env-file",
        "--eval",
        source,
      ])
      const inspected = Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String), User: Schema.String }),
            HostConfig: Schema.Struct({
              NetworkMode: Schema.String,
              ReadonlyRootfs: Schema.Boolean,
              Privileged: Schema.Boolean,
              PidMode: Schema.String,
            }),
            Mounts: Schema.Array(Schema.Unknown),
            State: Schema.Struct({ Running: Schema.Boolean }),
          }),
        ),
      )(parseJson(await invoke(["inspect", name])))
      assert.equal(inspected.length, 1)
      assert.equal(inspected[0].Config.Labels[OWNER_LABEL], name)
      assert.equal(inspected[0].Config.User, "1000:1000")
      assert.deepEqual(inspected[0].HostConfig, {
        NetworkMode: "bridge",
        ReadonlyRootfs: true,
        Privileged: false,
        PidMode: "",
      })
      assert.deepEqual(inspected[0].Mounts, [])
      assert.equal(inspected[0].State.Running, false)
      const result = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String, text: Schema.String }))(
        parseJson(await invoke(["start", "--attach", name])),
      )
      assert.match(result.address, /^\d+\.\d+\.\d+\.\d+$/)
      return result
    } finally {
      const found = await invoke(["ps", "--all", "--quiet", "--filter", `label=${OWNER_LABEL}=${name}`])
      if (found.trim()) await invoke(["rm", "--force", name])
      assert.equal((await invoke(["ps", "--all", "--quiet", "--filter", `label=${OWNER_LABEL}=${name}`])).trim(), "")
    }
  })
}

export async function isolatedFixture(source: string, timeoutMs = 10000) {
  const task = {
    ...demoTask,
    verifier: { ...demoTask.verifier, testSource: source },
    budgets: { ...demoTask.budgets, timeoutMs },
  }
  return verifyFiles(task, task.files, "heldout", true, { isolation: "docker-required" })
}

/** Actual deny controls. Missing capability/denial is an error, never an asserted-green skip. */
export async function isolationChecks(directory: string) {
  const canary = path.join(directory, "synthetic-host-canary.txt")
  const sentinel = `synthetic-${crypto.randomUUID()}`
  const previousCredential = process.env.OPENCODE_SYNTHETIC_CREDENTIAL
  process.env.OPENCODE_SYNTHETIC_CREDENTIAL = sentinel
  writeFileSync(canary, sentinel, { flag: "wx", mode: 0o600 })
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response(sentinel) })
  const hostProcess = Bun.spawn([process.execPath, "--eval", "setInterval(() => {}, 1000)", sentinel], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${server.port}`)).text(), sentinel)
    const network = await reachableHost(server.port!)
    assert.equal(network.text, sentinel, "same guest-target address must positively reach our owned host endpoint")
    const hostSource = `import {test,expect} from 'bun:test'; import fs from 'node:fs'; test('positive host control',()=>{expect(fs.readFileSync(${JSON.stringify(canary)},'utf8')).toBe(${JSON.stringify(sentinel)}); fs.writeFileSync(${JSON.stringify(canary)},'host-write'); expect(fs.readFileSync(${JSON.stringify(canary)},'utf8')).toBe('host-write')});`
    const hostTask = { ...demoTask, verifier: { ...demoTask.verifier, testSource: hostSource } }
    const host = await verifyFiles(hostTask, hostTask.files, "heldout", true)
    assert.equal(host.status, "passed", host.stderr)
    writeFileSync(canary, sentinel)
    const capability = await dockerCapability()
    const denied = await isolatedFixture(`import {test,expect} from 'bun:test'; import fs from 'node:fs';
test('synthetic host read and write denied',()=>{expect(()=>fs.readFileSync(${JSON.stringify(canary)})).toThrow(); expect(()=>fs.writeFileSync(${JSON.stringify(canary)},'bad')).toThrow();});
test('input source and root read-only',()=>{expect(()=>fs.writeFileSync('/verifier/repository/slug.ts','bad')).toThrow();expect(()=>fs.writeFileSync('/root-canary','bad')).toThrow();});
test('no host credentials socket or chosen process',()=>{expect(process.getuid()).not.toBe(0);expect(Object.keys(process.env).sort()).toEqual(['BUN_FEATURE_FLAG_NO_ORPHANS','BUN_INSTALL_BIN','BUN_RUNTIME_TRANSPILER_CACHE_PATH','HOME','HOSTNAME','LANG','NODE_ENV','PATH','TMPDIR','TZ'].sort());expect(process.env.NODE_ENV).toBe('test');expect(Object.values(process.env)).not.toContain(${JSON.stringify(sentinel)});expect(fs.existsSync(${JSON.stringify(capability.endpoint.slice(7))})).toBe(false);expect(fs.existsSync('/var/run/docker.sock')).toBe(false);const file='/proc/${hostProcess.pid}/cmdline';expect(fs.existsSync(file)?fs.readFileSync(file,'utf8').includes(${JSON.stringify(sentinel)}):false).toBe(false);});
test('verified host endpoint denied',async()=>{await expect(fetch('http://${network.address}:${server.port}',{signal:AbortSignal.timeout(700)})).rejects.toThrow();});
test('writable tmpfs is bounded',()=>{expect(()=>fs.writeFileSync('/output/too-large',Buffer.alloc(2*1024*1024))).toThrow();fs.rmSync('/output/too-large',{force:true});});`)
    assert.equal(denied.status, "passed", denied.stderr)
    assert.equal(readFileSync(canary, "utf8"), sentinel)
    assert.equal(denied.isolation.guest?.seccomp, "2")
    const descendant = await isolatedFixture(
      `import {test,expect} from 'bun:test'; import fs from 'node:fs';test('descendant survives intermediate parent',async()=>{const child=Bun.spawn(['/usr/local/bin/bun','--eval',"const grandchild=Bun.spawn(['/usr/local/bin/bun','--eval','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});console.log(grandchild.pid);process.exit(0)"],{env:{HOME:'/tmp',PATH:'/usr/local/bin:/usr/bin:/bin'},stdin:'ignore',stdout:'pipe',stderr:'ignore'});const pid=Number(await new Response(child.stdout).text());await child.exited;expect(fs.existsSync('/proc/'+pid)).toBe(true);console.log('intermediate-parent-exited; descendant-alive',pid);await Bun.sleep(60000);},60000);`,
      1500,
    )
    assert.equal(descendant.status, "timeout", descendant.stderr)
    assert.match(descendant.stdout, /intermediate-parent-exited/)
    assert.equal(descendant.isolation.guestScope, "before-candidate")
    assert.equal(descendant.isolation.pidLimitHit, null, "unobserved post-timeout counters must not claim zero")
    const pids = await isolatedFixture(
      `import {test,expect} from 'bun:test'; test('pid limit',async()=>{const children=[];try {for(let i=0;i<80;i++){children.push(Bun.spawn(['/bin/sleep','30'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}));}}catch(error){console.log('pid-denied',children.length);}finally{children.forEach(child=>child.kill(9));await Promise.all(children.map(child=>child.exited));}expect(children.length).toBeLessThan(80);});`,
    )
    assert.equal(pids.status, "resource-exhausted", pids.stderr)
    assert.equal(pids.isolation.pidLimitHit, true)
    durableWrite(path.join(directory, "isolation-pids.json"), encode(pids))
    const memory = await isolatedFixture(
      `import {test} from 'bun:test'; test('bounded memory exhaustion',()=>{const buffers=[];for(let i=0;i<24;i++)buffers.push(Buffer.alloc(16*1024*1024,1));console.log(buffers.length);});`,
    )
    assert.equal(memory.status, "resource-exhausted", memory.stderr)
    assert.equal(memory.isolation.oomKilled, true)
    assert.equal(memory.isolation.guestScope, "after-candidate")
    const results = { host, denied, descendant, pids, memory }
    const names = Object.values(results).flatMap((result) =>
      result.isolation.container ? [result.isolation.container] : [],
    )
    await withDockerCapability(async (controller) =>
      Promise.all(
        names.map(async (name) => {
          const result = await runProcess(
            [
              controller.docker.cli,
              "--host",
              controller.docker.endpoint,
              "ps",
              "--all",
              "--quiet",
              "--filter",
              `label=${OWNER_LABEL}=${name}`,
            ],
            controller.docker.env,
            10000,
            65536,
          )
          assert.equal(result.exitCode, 0)
          assert.equal(result.stdout.text.trim(), "", `owned descendant container remains: ${name}`)
        }),
      ),
    )
    const file = path.join(directory, "isolation-checks.json")
    durableWrite(
      file,
      encode({
        version: 1,
        profile: "actual Docker containment; trusted fixture; oracle integrity UNSUPPORTED",
        networkPositiveControl: network,
        results,
        cleanedOwnedContainers: names,
      }),
    )
    return {
      file,
      checks: [
        "host read/write denied",
        "input read-only",
        "clean environment",
        "host socket/PID not exposed",
        "owned reachable endpoint denied",
        "tmpfs bounded",
        "descendant timeout cleanup",
        "PID exhaustion",
        "OOM exhaustion",
      ],
      platform: denied.isolation.platform,
    }
  } finally {
    server.stop(true)
    hostProcess.kill(9)
    await hostProcess.exited
    if (previousCredential === undefined) delete process.env.OPENCODE_SYNTHETIC_CREDENTIAL
    else process.env.OPENCODE_SYNTHETIC_CREDENTIAL = previousCredential
  }
}
