import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { EndpointConfig } from "../shared/types";

/** One atomic record per SSH endpoint, shared by windows of the same VS Code profile. */
export class MachineStore {
  readonly directory: string;
  constructor(storage: string) {
    this.directory = path.join(storage, "machines");
  }
  prepare() {
    return fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  async list(): Promise<EndpointConfig[]> {
    const entries = (
      await fs.readdir(this.directory, { withFileTypes: true })
    ).filter((e) => e.isFile() && /^[a-zA-Z0-9_-]+[.]json$/.test(e.name));
    const machines: EndpointConfig[] = [];
    for (const entry of entries) {
      try {
        const value: EndpointConfig = JSON.parse(
          await fs.readFile(path.join(this.directory, entry.name), "utf8"),
        );
        if (
          value.kind === "ssh" &&
          entry.name === value.id + ".json" &&
          value.host &&
          value.root
        )
          machines.push(value);
      } catch (error: any) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
    }
    return machines;
  }
  async save(machine: EndpointConfig, importOnly = false) {
    if (
      machine.kind !== "ssh" ||
      !/^[a-zA-Z0-9_-]+$/.test(machine.id) ||
      !machine.host ||
      !machine.root
    )
      throw Error("Invalid SSH machine");
    const record = path.join(this.directory, machine.id + ".json");
    const temp = record + "." + randomUUID() + ".tmp";
    await fs.writeFile(temp, JSON.stringify(machine), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      if (importOnly) {
        // Commit only when absent. A concurrently renamed or added entry takes precedence.
        await fs.link(temp, record).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      } else {
        await fs.rename(temp, record);
      }
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
}
