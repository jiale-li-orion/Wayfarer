import fs from "node:fs/promises";
import path from "node:path";
import { connect, sleep } from "./lib/live.mjs";
const output = process.argv[2];
if (!output) throw Error("Output folder required");
await fs.mkdir(output, { recursive: true });
const l = await connect();
if (!/^acceptance-resources \((?:Workspace|工作区)\)/.test(l.session.name))
  throw Error("Use isolated acceptance workspace");
try {
  await l.command("Workspace Map: 查看机器资源");
  const c = await l.canvas();
  await l.normalizeWindow();
  const value = (x) => l.evaluate(c, x);
  const wait = async (f) => {
    for (let i = 0; i < 150; i++) {
      if (await f()) return;
      await sleep(100);
    }
    throw Error("Resource preview did not load");
  };
  const shot = async (name) => {
    await l.call("Page.bringToFront", {}, l.sid);
    const r = await l.call("Page.captureScreenshot", { format: "png" }, l.sid);
    await fs.writeFile(
      path.join(output, name + ".png"),
      Buffer.from(r.data, "base64"),
    );
  };
  await value(
    '(()=>{document.querySelector(".breadcrumbs button").click();document.querySelector(".export-menu").open=false})()',
  );
  await wait(() =>
    value('document.querySelectorAll(".machine-card").length===4'),
  );
  await sleep(6000);
  await shot("01-overview");
  await value(
    '[...document.querySelectorAll(".machine-card")].find(e=>e.textContent.includes("训练机")).click()',
  );
  await wait(() => value('!!document.querySelector(".resource-tabs")'));
  await value(
    '[...document.querySelectorAll(".resource-tabs button")].find(e=>e.textContent==="GPU").click()',
  );
  await wait(() =>
    value('document.querySelectorAll("button.gpu-row").length===8'),
  );
  await shot("02-machine-gpus");
  await value('document.querySelector("button.gpu-row").click()');
  await wait(() => value('!!document.querySelector(".resource-drawer dl")'));
  await sleep(500);
  await value(
    '[...document.querySelectorAll(".resource-drawer dt")].filter(e=>e.textContent==="设备标识").forEach(e=>e.nextElementSibling.style.filter="blur(5px)")',
  );
  await shot("03-gpu-detail");
  await value(
    '[...document.querySelectorAll(".resource-drawer dt")].filter(e=>e.textContent==="设备标识").forEach(e=>e.nextElementSibling.style.filter="")',
  );
  console.log("Captured three resource levels; public device UUID masked");
} finally {
  l.close();
}
