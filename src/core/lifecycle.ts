import type { ChildProcessWithoutNullStreams } from "node:child_process";
/** One grace budget per shutdown, shared by runners and their owned processes. */
export const EXIT_GRACE_MS = 1500;
export class TransportLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportLost";
  }
}
export async function grace(
  work: Promise<unknown>,
  force: () => void,
  ms = EXIT_GRACE_MS,
) {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        force();
        resolve();
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
  await work;
}
export function closeChild(
  child: ChildProcessWithoutNullStreams,
  force = false,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  const done = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  if (force) {
    child.kill("SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  } else child.stdin.end();
  return done;
}
