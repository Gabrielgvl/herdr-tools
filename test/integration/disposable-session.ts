import type { ChildProcess } from "node:child_process";

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
