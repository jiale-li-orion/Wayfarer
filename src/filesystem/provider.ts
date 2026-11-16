import * as vscode from "vscode";
import type { Core } from "../core/core";
import { pathApi } from "../shared/paths";
import type { Ref, Entry, Job } from "../shared/types";
export class FileProvider
  implements vscode.FileSystemProvider, vscode.Disposable
{
  private events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.events.event;
  constructor(private core: Core) {
    core.directories.on("change", this.changed);
    core.directories.on("file", this.changed);
  }
  private changed = (ref: Ref) =>
    this.events.fire([
      { type: vscode.FileChangeType.Changed, uri: this.uri(ref) },
    ]);
  uri(r: Ref) {
    const windows =
      this.core.endpoints.get(r.endpoint).config.kind === "windows";
    return vscode.Uri.from({
      scheme: windows ? "workspacemap-win" : "workspacemap",
      authority: r.endpoint,
      path: windows ? "/" + r.path.replaceAll("\\", "/") : r.path,
    });
  }
  private ref(uri: vscode.Uri): Ref {
    return {
      endpoint: uri.authority,
      path:
        uri.scheme === "workspacemap-win"
          ? uri.path.slice(1).replaceAll("/", "\\")
          : uri.path,
    };
  }
  private type(e: Entry) {
    return e.kind === "directory"
      ? vscode.FileType.Directory
      : e.kind === "symlink"
        ? vscode.FileType.SymbolicLink |
          (e.targetKind === "directory"
            ? vscode.FileType.Directory
            : vscode.FileType.File)
        : e.kind === "file"
          ? vscode.FileType.File
          : vscode.FileType.Unknown;
  }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const s: Entry = await this.core.dispatch("stat", { ref: this.ref(uri) });
    return { type: this.type(s), ctime: s.ctime, mtime: s.mtime, size: s.size };
  }
  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const ref = this.ref(uri);
    const result: [string, vscode.FileType][] = [];
    let cursor: string | undefined;
    do {
      const page = await this.core.directories.list(
        ref,
        cursor,
        true,
        "editor",
      );
      result.push(
        ...page.entries.map(
          (e: Entry) => [e.name, this.type(e)] as [string, vscode.FileType],
        ),
      );
      cursor = page.cursor;
    } while (cursor);
    return result;
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const ref = this.ref(uri);
    const s: Entry = await this.core.dispatch("stat", { ref });
    if (s.size > 64 * 1048576)
      throw vscode.FileSystemError.Unavailable(
        "文件大于 64 MiB；使用文件传输到本机后打开",
      );
    const b = Buffer.alloc(s.size);
    const e = this.core.endpoints.get(ref.endpoint);
    for (let i = 0; i < s.size; i += 1048576)
      Buffer.from(
        await e.call("read", {
          path: ref.path,
          offset: i,
          length: Math.min(1048576, s.size - i),
        }),
        "base64",
      ).copy(b, i);
    return b;
  }
  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ) {
    const ref = this.ref(uri);
    let exists = false;
    try {
      await this.core.dispatch("stat", { ref });
      exists = true;
    } catch (e: any) {
      if (!["ENOENT", 2].includes(e.code) && e.type !== "FileNotFoundError")
        throw e;
    }
    if (exists && !options.overwrite)
      throw vscode.FileSystemError.FileExists(uri);
    if (!exists && !options.create)
      throw vscode.FileSystemError.FileNotFound(uri);
    await this.wait(
      await this.core.dispatch("write", {
        ref,
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
        exclusive: !exists,
      }),
    );
    this.events.fire([
      {
        type: exists
          ? vscode.FileChangeType.Changed
          : vscode.FileChangeType.Created,
        uri,
      },
    ]);
  }
  async createDirectory(uri: vscode.Uri) {
    await this.wait(
      await this.core.dispatch("mkdirPath", { ref: this.ref(uri) }),
    );
  }
  async delete(uri: vscode.Uri) {
    const j = await this.core.dispatch("delete", { refs: [this.ref(uri)] });
    await this.wait(j);
  }
  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ) {
    const src = this.ref(oldUri),
      dest = this.ref(newUri);
    if (src.endpoint !== dest.endpoint)
      throw vscode.FileSystemError.Unavailable(
        "Use Workspace Map cross-endpoint transfer",
      );
    await this.wait(
      await this.core.dispatch("renamePath", {
        ref: src,
        dest: dest.path,
        overwrite: options.overwrite,
      }),
    );
  }
  watch(uri: vscode.Uri): vscode.Disposable {
    const ref = this.ref(uri);
    let closed = false;
    let release: (() => void) | undefined;
    void this.core
      .dispatch("stat", { ref })
      .then((s: Entry) => {
        if (closed) return;
        const config = this.core.endpoints.get(ref.endpoint).config;
        release = this.core.directories.retain(
          s.kind === "directory"
            ? ref
            : {
                endpoint: ref.endpoint,
                path: pathApi(config).dirname(ref.path),
              },
        );
      })
      .catch(() => {});
    return {
      dispose() {
        closed = true;
        release?.();
      },
    };
  }
  private wait(j: Job): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (value: Job) => {
        if (value.id !== j.id) return;
        if (value.state === "completed") {
          this.core.jobs.off("change", done);
          resolve();
        } else if (["failed", "cancelled", "paused"].includes(value.state)) {
          this.core.jobs.off("change", done);
          reject(Error(value.error ?? value.state));
        }
      };
      this.core.jobs.on("change", done);
      done(this.core.jobs.get(j.id));
    });
  }
  dispose() {
    this.core.directories.off("change", this.changed);
    this.core.directories.off("file", this.changed);
    this.events.dispose();
  }
}
