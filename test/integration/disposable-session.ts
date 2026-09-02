import type { ChildProcess } from "node:child_process";

export async function waitForCondition<T>(
  sample: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<T | undefined> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await sample();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

/**
 * A named integration server is a process-owned resource. Do not let the next
 * test recreate the same session until this child has actually exited.
 */
export async function stopDisposableServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      server.removeListener("close", finish);
      server.removeListener("error", finish);
      resolve();
    };
    server.once("close", finish);
    server.once("error", finish);
    if (!server.kill("SIGTERM") && server.exitCode !== null) finish();
  });
}
