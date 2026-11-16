import path from "node:path";
import type { EndpointConfig } from "./types";
export const pathApi = (c: EndpointConfig) =>
  c.kind === "windows" ? path.win32 : path.posix;
export const normalized = (c: EndpointConfig, p: string) => {
  const a = pathApi(c);
  if (!a.isAbsolute(p)) throw Error("Path must be absolute");
  return a.normalize(p);
};
export function alias(c: EndpointConfig, p: string): string {
  const n = normalized(c, p);
  if (c.kind === "windows")
    return "windows:" + n.replaceAll("\\", "/").toLowerCase();
  if (c.kind === "wsl" && /^\/mnt\/[a-z](\/|$)/i.test(n))
    return (
      "windows:" + n.slice(5, 6).toLowerCase() + ":" + n.slice(6).toLowerCase()
    );
  if (c.kind === "local") return "local:" + n;
  if (c.kind === "wsl") return "wsl:" + c.distro + ":" + n;
  if (c.kind === "ssh")
    return (
      "ssh:" +
      JSON.stringify([c.distro ?? "", c.sshConfig ?? "", c.host]) +
      ":" +
      n
    );
  return c.id + ":" + n;
}
export const contains = (a: string, b: string) =>
  a === b || b.startsWith(a.replace(/[\\/]$/, "") + "/");
export function assertName(c: EndpointConfig, name: string) {
  if (!name || name === "." || name === ".." || /[\x00/]/.test(name))
    throw Error("Invalid filename");
  if (
    c.kind === "windows" &&
    (/[<>:"\\|?*\x00-\x1f]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name))
  )
    throw Error("Name unsupported by Windows: " + name);
}
export function changed(a: any, b: any) {
  return (
    a.identity !== b.identity ||
    a.size !== b.size ||
    a.mtime !== b.mtime ||
    a.ctime !== b.ctime
  );
}
