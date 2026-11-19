// Run from WSL against the isolated Windows acceptance map.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { connect, sleep } from "./lib/live.mjs";

const out = process.argv[2],
  endpoint = process.env.WM_VERIFY_ENDPOINT;
if (!out || !endpoint)
  throw Error("Specify acceptance directory and WM_VERIFY_ENDPOINT");
const live = await connect();
assert(live.session.name.startsWith("acceptance-workloads "));
const note = {};
let child,
  suspended = false;
const runId = "accept/" + randomUUID(),
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "wayfarer-workload-"));
async function wait(test) {
  for (let n = 0; n < 120; n++) {
    if (await test()) return;
    await sleep(200);
  }
  throw Error("Timed out");
}
try {
  const configs = await live.ipc("endpoints");
  const ssh = configs.find((c) => c.id === endpoint),
    wsl = configs.find((c) => c.kind === "wsl");
  const pidScript =
    "import os,json,select,sys; p=os.getpid(); s=open('/proc/self/stat').read().rsplit(')',1)[1].split(); print(json.dumps({'pid':p,'identity':str(p)+':'+s[19]}),flush=True); select.select([sys.stdin],[],[],120)";
  const python = "python3 -c '" + pidScript.replaceAll("'", "'\\''") + "'";
  child = spawn(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=6",
      ...(ssh.sshConfig ? ["-F", ssh.sshConfig] : []),
      ssh.host,
      python,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const result = await Promise.race([
    once(lines, "line"),
    exited.then(() => {
      throw Error("SSH fixture exited before identity");
    }),
  ]);
  const processRef = JSON.parse(result[0]);
  lines.close();
  await live.ipc("workloadRegister", {
    runId,
    endpoint,
    name: "SSH 验收",
    process: processRef,
  });
  assert.equal(
    (await live.ipc("workloadDetail", { runId, observe: true })).observed,
    "alive",
  );
  await live.ipc("endpointControl", { endpoint, action: "disconnect" });
  suspended = true;
  assert.equal(
    (await live.ipc("workloadDetail", { runId, observe: true })).connection,
    "offline",
  );
  await live.ipc("endpointControl", { endpoint, action: "connect" });
  suspended = false;
  assert.equal(
    (await live.ipc("workloadDetail", { runId, observe: true })).observed,
    "alive",
  );
  await live.ipc("workloadForget", { runId });
  assert.equal(child.exitCode, null);
  const still = await live.ipc("systemResources", {
    endpoint,
    section: "identities",
    pids: [processRef.pid],
  });
  assert.equal(still.identities[processRef.pid], processRef.identity);
  await live.ipc("workloadRegister", { runId, endpoint, process: processRef });
  child.stdin.end();
  await exited;
  await wait(
    async () =>
      (await live.ipc("workloadDetail", { runId, observe: true })).observed ===
      "exited",
  );
  note.manualProcess =
    "alive → offline → alive → unobserved and alive → explicitly exited";
  const target = path.join(dir, "to");
  await fs.mkdir(target);
  for (const [filename, association] of [
    ["plain", {}],
    ["associated", { workloadId: runId, workloadPhase: "产物" }],
  ]) {
    const source = path.join(dir, filename);
    await fs.writeFile(source, filename);
    await live.finish(
      await live.ipc("transfer", {
        sources: [{ endpoint: wsl.id, path: source }],
        target: { endpoint: wsl.id, path: target },
        mode: "copy",
        conflict: "skip",
        ...association,
      }),
    );
    assert.equal(
      await fs.readFile(path.join(target, filename), "utf8"),
      filename,
    );
  }
  const linked = await live.ipc("jobsPage", {
    kind: "transfer",
    workloadId: runId,
  });
  assert.equal(linked.total, 1);
  assert.equal(linked.history[0].workloadPhase, "产物");
  note.linkedTransfers = 1;
  const peer = configs.find(
    (c) =>
      c.kind === "ssh" &&
      c.id !== endpoint &&
      c.id === process.env.WM_VERIFY_PEER,
  );
  if (peer) {
    const pair = await Promise.all(
      [peer.id, endpoint].map(async (id) => ({
        endpoint: id,
        address: (await live.ipc("linkInterfaces", { endpoint: id }))[0]
          .address,
      })),
    );
    const job = await live.finish(
      await live.ipc("linkProbe", {
        source: pair[0],
        target: pair[1],
        measure: true,
        bytes: 4 * 1024 * 1024,
      }),
    );
    assert(!job.result.measureError, job.result.measureError);
    assert.equal(job.result.directions.length, 2);
    note.link = job.result.directions;
  }
} finally {
  child?.stdin.end();
  if (suspended)
    await live
      .ipc("endpointControl", { endpoint, action: "connect" })
      .catch(() => {});
  await live.ipc("workloadForget", { runId }).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
  await fs.writeFile(
    path.join(out, "workload-bindings.json"),
    JSON.stringify(note, null, 2),
  );
  live.close();
}
