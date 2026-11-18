import fs from "node:fs/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";
const [recordFile, output, seconds = "610"] = process.argv.slice(2);
const record = JSON.parse(await fs.readFile(recordFile, "utf8"));
if (!record.name.startsWith("acceptance-workspaces "))
  throw Error("Isolated workspace required");
function call(method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID(),
      socket = net.createConnection(record.socket);
    let buffer = "";
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(JSON.stringify({ id, method, args }) + "\n"),
    );
    socket.on("data", (data) => {
      buffer += data;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        const value = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (value.id === id) {
          socket.end();
          value.error ? reject(Error(value.error)) : resolve(value.result);
          return;
        }
      }
    });
  });
}
const samples = [],
  started = Date.now();
for (;;) {
  samples.push({ at: Date.now(), diagnostics: await call("diagnostics") });
  await fs.writeFile(output, JSON.stringify({ started, samples }));
  if (Date.now() - started >= Number(seconds) * 1000) break;
  await new Promise((r) => setTimeout(r, 10000));
}
const first = samples[0],
  last = samples.at(-1);
const cpu =
  (last.diagnostics.host.cpu.user +
    last.diagnostics.host.cpu.system -
    first.diagnostics.host.cpu.user -
    first.diagnostics.host.cpu.system) /
  (last.at - first.at) /
  10;
console.log(
  JSON.stringify({
    samples: samples.length,
    seconds: (last.at - first.at) / 1000,
    singleCoreCpuPercent: cpu,
    heapStart: first.diagnostics.host.memory.heapUsed,
    heapEnd: last.diagnostics.host.memory.heapUsed,
    last: last.diagnostics,
  }),
);
