import fs from "node:fs/promises";
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Ref, EndpointConfig } from "../shared/types";
export interface SavedWorkspace {
  id: string;
  name: string;
  uri?: string;
  locations: { ref: Ref; endpoint: EndpointConfig }[];
  created: number;
  updated: number;
}
export function workspaceUriKey(value: string) {
  const uri = new URL(value),
    decoded = decodeURIComponent(uri.pathname);
  return uri.protocol === "file:" && /^\/[a-z]:\//i.test(decoded)
    ? "file://" + uri.host.toLowerCase() + decoded.toLowerCase()
    : uri.protocol + "//" + uri.host + decoded;
}
/** Shared metadata only. File lock protects read/modify/write across VS Code windows. */
export class WorkspaceStore {
  constructor(readonly directory: string) {}
  private get file() {
    return path.join(this.directory, "workspaces.json");
  }
  async list(): Promise<SavedWorkspace[]> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!Array.isArray(value)) throw Error("Invalid workspace catalog");
      return value;
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  private async mutate(run: (items: SavedWorkspace[]) => SavedWorkspace[]) {
    await fs.mkdir(this.directory, { recursive: true });
    const lock = this.file + ".lock",
      token = randomUUID();
    let acquired = false;
    for (let i = 0; i < 100; i++) {
      try {
        const h = await fs.open(lock, "wx", 0o600);
        await h.writeFile(JSON.stringify({ pid: process.pid, token }));
        await h.close();
        acquired = true;
        break;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        try {
          const owner = JSON.parse(await fs.readFile(lock, "utf8"));
          try {
            process.kill(owner.pid, 0);
          } catch (e: any) {
            if (e.code === "ESRCH") await fs.unlink(lock).catch(() => {});
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    if (!acquired) throw Error("工作区清单正在更新，请重试");
    try {
      const items = run(await this.list());
      const temp = this.file + "." + token + ".tmp";
      try {
        await fs.writeFile(temp, JSON.stringify(items), { mode: 0o600 });
        await fs.rename(temp, this.file);
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
      return items;
    } finally {
      await fs.unlink(lock).catch(() => {});
    }
  }
  save(input: {
    name: string;
    uri?: string;
    locations?: SavedWorkspace["locations"];
  }) {
    if (!input.name?.trim()) throw Error("填写工作区名称");
    if (!input.uri && !input.locations?.length)
      throw Error("选择工作区文件或目录");
    if (input.uri && !/^(file|vscode-remote):/.test(input.uri))
      throw Error("选择原生工作区 URI");
    return this.mutate((items) => {
      const locations = input.locations ?? [];
      const same = items.find((x) =>
        input.uri
          ? !!x.uri && workspaceUriKey(x.uri) === workspaceUriKey(input.uri)
          : !x.uri && JSON.stringify(x.locations) === JSON.stringify(locations),
      );
      if (same) {
        same.name = input.name.trim();
        same.updated = Date.now();
        return items;
      }
      return [
        ...items,
        {
          id: randomUUID(),
          name: input.name.trim(),
          uri: input.uri,
          locations,
          created: Date.now(),
          updated: Date.now(),
        },
      ];
    });
  }
  update(
    id: string,
    changes: {
      name?: string;
      uri?: string;
      direction?: "up" | "down";
      remove?: boolean;
    },
  ) {
    return this.mutate((items) => {
      const index = items.findIndex((x) => x.id === id);
      if (index < 0) throw Error("工作区收藏已移除");
      if (changes.remove) return items.filter((x) => x.id !== id);
      if (changes.name !== undefined) {
        if (!changes.name.trim()) throw Error("填写工作区名称");
        items[index].name = changes.name.trim();
      }
      if (changes.uri !== undefined) {
        if (!/^(file|vscode-remote):/.test(changes.uri))
          throw Error("选择原生工作区 URI");
        items[index].uri = changes.uri;
      }
      items[index].updated = Date.now();
      if (changes.direction) {
        const next = index + (changes.direction === "up" ? -1 : 1);
        if (next >= 0 && next < items.length)
          [items[index], items[next]] = [items[next], items[index]];
      }
      return items;
    });
  }
}

/** Resolve the file's current root declarations; favorite locations are connection hints, not a root snapshot. */
export function workspaceFolderUris(
  documentUri: string,
  folders: { path?: string; uri?: string }[],
) {
  const base = new URL(documentUri);
  return folders.map((folder) => {
    if (folder.uri) return new URL(folder.uri).toString();
    if (typeof folder.path !== "string")
      throw Error("工作区目录缺少 path／uri");
    const target = new URL(base);
    const decoded = decodeURIComponent(base.pathname);
    if (
      base.protocol === "file:" &&
      (/^\/[a-z]:\//i.test(decoded) || base.host)
    ) {
      const source = base.host
        ? "\\\\" + base.host + decoded.replaceAll("/", "\\")
        : decoded.slice(1).replaceAll("/", "\\");
      const result = path.win32.resolve(
        path.win32.dirname(source),
        folder.path,
      );
      if (result.startsWith("\\\\")) {
        const parts = result.slice(2).split("\\");
        target.host = parts.shift()!;
        target.pathname = "/" + parts.join("/");
      } else {
        target.host = "";
        target.pathname = "/" + result.replaceAll("\\", "/");
      }
    } else
      target.pathname = path.posix.resolve(
        path.posix.dirname(decoded),
        folder.path,
      );
    return target.toString();
  });
}

export function parseWorkspaceRoots(uri: string, text: string) {
  if (Buffer.byteLength(text) > 256 * 1024)
    throw Error("工作区清单超过 256KiB；选择具体项目目录查看");
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !Array.isArray(data?.folders))
    throw Error("工作区 folders 清单格式错误");
  return workspaceFolderUris(uri, data.folders);
}
