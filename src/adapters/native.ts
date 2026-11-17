import fs from "node:fs/promises";
import { type Dir } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import type { Endpoint, EndpointConfig, Entry } from "../shared/types";
import { changed, normalized } from "../shared/paths";
type Scan = {
  sequence: number;
  users: number;
  lastSequence?: number;
  lastPage?: any;
  gate?: Promise<void>;
  path: string;
  kind: string;
  stack: Dir[];
  bytes: number;
  files: number;
  time: number;
};
export class NativeEndpoint implements Endpoint {
  private closed = false;
  private scans = new Map<string, Scan>();
  private scanTimer?: NodeJS.Timeout;
  private syncScanTimer() {
    if (this.scans.size && !this.scanTimer && !this.closed) {
      this.scanTimer = setInterval(() => {
        for (const [id, scan] of this.scans)
          if (!scan.users && Date.now() - scan.time > 120000)
            void this.closeScan(id);
      }, 30000);
      this.scanTimer.unref();
    } else if (!this.scans.size || this.closed) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
  }
  private procs = new Map<
    string,
    {
      child: ChildProcess;
      output: string;
      code: number | null;
      truncated: boolean;
    }
  >();
  constructor(
    public config: EndpointConfig,
    private trash?: (p: string) => Promise<void>,
  ) {}
  async readInto(p: string, buffer: Buffer, offset: number, length: number) {
    const f = await fs.open(p, "r");
    try {
      return (await f.read(buffer, 0, length, offset)).bytesRead;
    } finally {
      await f.close();
    }
  }
  async writeBuffer(p: string, buffer: Buffer, offset: number) {
    const f = await fs.open(p, "r+");
    try {
      let n = 0;
      while (n < buffer.length)
        n += (await f.write(buffer, n, buffer.length - n, offset + n))
          .bytesWritten;
      return n;
    } finally {
      await f.close();
    }
  }
  async stat(p: string, resolve = true): Promise<Entry> {
    try {
      const s = await fs.lstat(p, { bigint: true });
      const kind = s.isSymbolicLink()
        ? "symlink"
        : s.isDirectory()
          ? "directory"
          : s.isFile()
            ? "file"
            : "special";
      const e: Entry = {
        name: path.basename(p) || p,
        path: p,
        kind,
        size: Number(s.size),
        mtime: Number(s.mtimeNs) / 1e6,
        ctime: Number(s.ctimeNs) / 1e6,
        mode: Number(s.mode) & 0o777,
        identity: s.dev + ":" + s.ino,
      };
      if (kind === "symlink") {
        e.target = await fs.readlink(p);
        e.resolved = await fs.realpath(p).catch(() => p);
        e.targetKind = await fs.stat(p).then(
          (t) => (t.isDirectory() ? "directory" : "file"),
          () => "missing",
        );
      }
      if (resolve && !e.resolved)
        e.resolved = await fs.realpath(p).catch(() => p);
      e.tags = [
        ".cache",
        "node_modules",
        "__pycache__",
        ".gradle",
        ".m2",
      ].includes(e.name)
        ? ["cache"]
        : ["Android", "flutter", ".rustup"].includes(e.name)
          ? ["SDK"]
          : e.name === ".git"
            ? ["Git"]
            : [];
      return e;
    } catch (e: any) {
      if (e.code === "EACCES" || e.code === "EPERM")
        return {
          name: path.basename(p),
          path: p,
          kind: "denied",
          size: 0,
          mtime: 0,
          ctime: 0,
          mode: 0,
          identity: p,
          error: e.message,
        };
      throw e;
    }
  }
  async call<T = any>(method: string, a: Record<string, any> = {}): Promise<T> {
    if (this.closed) throw Error("Endpoint closed");
    const p = a.path === undefined ? "" : normalized(this.config, a.path);
    let r: any;
    switch (method) {
      case "info":
        r = {
          home: os.homedir(),
          platform: process.platform,
          pid: process.pid,
        };
        break;
      case "stat":
        r = await this.stat(p);
        break;
      case "statMany":
        r = await Promise.all(
          a.paths
            .slice(0, 64)
            .map((q: string) =>
              this.stat(q).catch((e) => ({ error: String(e) })),
            ),
        );
        break;
      case "resources":
        for (const [id, scan] of this.scans)
          if (!scan.users && Date.now() - scan.time > 120000)
            await this.closeScan(id);
        r = {
          scope: "shared-extension-host",
          pid: process.pid,
          ...process.memoryUsage(),
          cpu: process.cpuUsage(),
          cursors: this.scans.size,
          processes: this.procs.size,
          children: [...this.procs.values()].map((p) => ({
            pid: p.child.pid,
            exitCode: p.code,
          })),
        };
        break;
      case "sshHosts": {
        const content = await fs.readFile(p, "utf8");
        r = [
          ...new Set(
            content.split(/\r?\n/).flatMap((line) => {
              const words = line.trim().split(/\s+/);
              return words[0]?.toLowerCase() === "host"
                ? words.slice(1).filter((v) => !/[*!?]/.test(v))
                : [];
            }),
          ),
        ];
        break;
      }
      case "realpath":
        r = await fs.realpath(p);
        break;
      case "mkdir":
        r = await fs.mkdir(p, { recursive: true });
        break;
      case "list":
        r = await this.list(p, a);
        break;
      case "scanClose":
        await this.closeScan(a.cursor);
        r = true;
        break;
      case "read": {
        const f = await fs.open(p, "r");
        try {
          const b = Buffer.allocUnsafe(Math.min(a.length ?? 1048576, 1048576));
          const n = await f.read(b, 0, b.length, a.offset ?? 0);
          r = b.subarray(0, n.bytesRead).toString("base64");
        } finally {
          await f.close();
        }
        break;
      }
      case "write": {
        const data = Buffer.from(a.data, "base64");
        if (data.length > 1048576) throw Error("Chunk exceeds 1 MiB");
        let f;
        try {
          f = await fs.open(p, a.exclusive ? "wx" : "r+");
        } catch (e: any) {
          if (e.code !== "ENOENT" || a.exclusive) throw e;
          f = await fs.open(p, "wx");
        }
        try {
          if ((await fs.lstat(p)).isSymbolicLink())
            throw Error("Refusing to write through symlink");
          let n = 0;
          while (n < data.length)
            n += (await f.write(data, n, data.length - n, (a.offset ?? 0) + n))
              .bytesWritten;
          if (a.truncate) await f.truncate((a.offset ?? 0) + data.length);
          r = n;
        } finally {
          await f.close();
        }
        break;
      }
      case "hash": {
        const h = createHash("sha256");
        const buffer = Buffer.allocUnsafe(
          Math.max(4096, Math.min(1048576, a.size ?? 1048576)),
        );
        const f = await fs.open(p, "r");
        try {
          let offset = 0;
          for (;;) {
            const n = (await f.read(buffer, 0, buffer.length, offset))
              .bytesRead;
            if (!n) break;
            h.update(buffer.subarray(0, n));
            offset += n;
          }
        } finally {
          await f.close();
        }
        r = h.digest("hex");
        break;
      }
      case "metadata":
        await fs.chmod(p, a.mode);
        await fs.utimes(p, a.mtime / 1000, a.mtime / 1000);
        r = true;
        break;
      case "rename": {
        const dest = normalized(this.config, a.dest);
        if (
          !a.overwrite &&
          !(
            process.platform === "win32" &&
            p.toLowerCase() === dest.toLowerCase()
          ) &&
          (await fs.lstat(dest).then(
            () => true,
            () => false,
          ))
        )
          throw Object.assign(Error("Destination exists"), { code: "EEXIST" });
        await fs.rename(p, dest);
        r = true;
        break;
      }
      case "remove": {
        if (a.expected && changed(a.expected, await this.stat(p)))
          throw Error("Source changed; retained");
        if (a.trash && this.trash) {
          await this.trash(p);
        } else if (a.recursive) {
          await fs.rm(p, { recursive: true });
        } else {
          const s = await fs.lstat(p);
          if (s.isDirectory() && !s.isSymbolicLink()) await fs.rmdir(p);
          else await fs.unlink(p);
        }
        r = true;
        break;
      }
      case "symlink":
        await fs.symlink(
          a.target,
          p,
          a.linkType === "junction"
            ? "junction"
            : a.targetKind === "directory"
              ? "dir"
              : "file",
        );
        r = true;
        break;
      case "linkInfo": {
        if (process.platform !== "win32") {
          r = { linkType: "symlink" };
          break;
        }
        const literal = p.replaceAll("'", "''");
        const script =
          "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $item=Get-Item -LiteralPath '" +
          literal +
          "' -Force; @{linkType=$item.LinkType;linkTargetKind=$(if($item.PSIsContainer){'directory'}else{'file'})} | ConvertTo-Json -Compress";
        const result = await this.exec(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          os.homedir(),
        );
        if (result.code !== 0)
          throw Error("读取 Windows 链接类型失败：" + result.output);
        const info = JSON.parse(result.output.trim());
        if (!["Junction", "SymbolicLink"].includes(info.linkType))
          throw Error("Unsupported Windows reparse point");
        r = {
          linkType: info.linkType === "Junction" ? "junction" : "symlink",
          linkTargetKind: info.linkTargetKind,
        };
        break;
      }
      case "which": {
        const cmd = process.platform === "win32" ? "where.exe" : "which";
        const result = await this.exec([cmd, a.name], os.homedir());
        r = result.code === 0 ? result.output.trim().split(/\r?\n/)[0] : null;
        break;
      }
      case "execStart": {
        const id = randomUUID();
        const c = spawn(a.argv[0], a.argv.slice(1), {
          cwd: a.cwd,
          env: {
            ...process.env,
            ...(path.isAbsolute(a.argv[0])
              ? {
                  PATH:
                    path.dirname(a.argv[0]) +
                    path.delimiter +
                    (process.env.PATH ?? ""),
                }
              : {}),
          },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        const rec = {
          child: c,
          output: "",
          code: null as number | null,
          truncated: false,
        };
        this.procs.set(id, rec);
        const add = (b: Buffer) => {
          rec.output += b.toString();
          if (rec.output.length > 1048576) {
            rec.output = rec.output.slice(-1048576);
            rec.truncated = true;
          }
        };
        c.stdout?.on("data", add);
        c.stderr?.on("data", add);
        c.on("error", (e) => {
          add(Buffer.from(e.message));
          rec.code = -1;
        });
        c.on("close", (code) => {
          rec.code = code ?? -1;
        });
        r = { id, pid: c.pid };
        break;
      }
      case "execPoll":
      case "execCancel": {
        const rec = this.procs.get(a.id);
        if (!rec) throw Error("Process not found");
        if (method === "execCancel") {
          this.kill(rec.child);
          if (rec.code === null)
            await Promise.race([
              new Promise<void>((resolve) =>
                rec.child.once("close", () => resolve()),
              ),
              new Promise<void>((resolve) => setTimeout(resolve, 1000)),
            ]);
        }
        r = { code: rec.code, output: rec.output, truncated: rec.truncated };
        rec.output = "";
        if (rec.code !== null) this.procs.delete(a.id);
        break;
      }
      default:
        throw Error("Unknown endpoint method: " + method);
    }
    return r as T;
  }
  private async exec(argv: string[], cwd: string) {
    const { id } = await this.call("execStart", { argv, cwd });
    let output = "";
    for (;;) {
      const v = await this.call("execPoll", { id });
      output += v.output;
      if (v.code !== null) return { code: v.code, output };
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  private async list(p: string, a: any) {
    for (const [id, s] of this.scans)
      if (!s.users && Date.now() - s.time > 120000) await this.closeScan(id);
    const id = a.cursor?.split(":")[0] ?? randomUUID();
    const sequence = a.cursor ? Number(a.cursor.split(":")[1] ?? 0) : 0;
    let s = this.scans.get(id);
    if (!s) {
      if (a.cursor) throw Error("Cursor expired; refresh directory");
      if (this.scans.size >= 128)
        throw Error("Too many open directory cursors");
      s = {
        sequence: 0,
        users: 0,
        path: p,
        kind: a.kind ?? "list",
        stack: [await fs.opendir(p, { bufferSize: 64 })],
        bytes: 0,
        files: 0,
        time: Date.now(),
      };
      this.scans.set(id, s);
      this.syncScanTimer();
    }
    if (s.path !== p || s.kind !== (a.kind ?? "list"))
      throw Error("Cursor belongs to another directory");
    const previous = s.gate ?? Promise.resolve();
    let release!: () => void;
    s.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.users++;
    await previous;
    try {
      if (sequence !== s.sequence) {
        if (sequence === s.lastSequence) return s.lastPage;
        throw Error("Cursor has advanced; refresh directory");
      }
      const entries: Entry[] = [];
      const errors: any[] = [];
      const limit = Math.min(1000, a.limit ?? 200);
      const end = performance.now() + 40;
      while (s.stack.length && entries.length < limit) {
        if (s.kind === "list") {
          const batch: string[] = [];
          while (
            s.stack.length &&
            batch.length < Math.min(16, limit - entries.length)
          ) {
            const directory = s.stack.at(-1)!;
            const item = await directory.read();
            if (!item) {
              await directory.close();
              s.stack.pop();
            } else batch.push(path.join(directory.path, item.name));
          }
          entries.push(
            ...(await Promise.all(batch.map((q) => this.stat(q, false)))),
          );
          continue;
        }
        const d = s.stack.at(-1)!;
        const item = await d.read();
        if (!item) {
          await d.close();
          s.stack.pop();
          continue;
        }
        const q = path.join(d.path, item.name);
        {
          try {
            if (item.isDirectory())
              s.stack.push(await fs.opendir(q, { bufferSize: 64 }));
            else if (s.kind === "size") {
              s.bytes += (await fs.lstat(q)).size;
              s.files++;
            }
            if (
              s.kind === "search" &&
              item.name
                .toLocaleLowerCase()
                .includes(String(a.query ?? "").toLocaleLowerCase())
            )
              entries.push(await this.stat(q, false));
          } catch (e) {
            errors.push({ path: q, error: String(e) });
          }
        }
        if (s.kind !== "list" && performance.now() > end) break;
      }
      if (s.kind === "list") {
        const resolved = await fs.realpath(p);
        for (const e of entries) e.resolved ??= path.join(resolved, e.name);
      }
      s.time = Date.now();
      const cursor = s.stack.length ? id + ":" + (sequence + 1) : undefined;
      if (!cursor) {
        this.scans.delete(id);
        this.syncScanTimer();
      }
      const result = {
        entries,
        cursor,
        stamp: Date.now(),
        bytes: s.bytes,
        files: s.files,
        errors,
      };
      s.sequence = sequence + 1;
      s.lastSequence = sequence;
      s.lastPage = result;
      return result;
    } finally {
      s.users--;
      release();
    }
  }
  private async closeScan(id: string) {
    id = id.split(":")[0];
    const s = this.scans.get(id);
    this.scans.delete(id);
    this.syncScanTimer();
    if (s) await Promise.allSettled(s.stack.map((d) => d.close()));
  }
  private kill(c: ChildProcess) {
    if (!c.pid || c.exitCode !== null || c.signalCode !== null) return;
    try {
      if (process.platform === "win32")
        spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], {
          windowsHide: true,
        });
      else {
        process.kill(-c.pid, "SIGTERM");
        setTimeout(() => {
          if (c.exitCode === null && c.signalCode === null)
            try {
              process.kill(-c.pid!, "SIGKILL");
            } catch {}
        }, 750).unref();
      }
    } catch {}
  }
  dispose() {
    this.closed = true;
    this.syncScanTimer();
    for (const s of this.scans.keys()) void this.closeScan(s);
    for (const r of this.procs.values()) this.kill(r.child);
    this.procs.clear();
  }
}
