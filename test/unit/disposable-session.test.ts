import { EventEmitter } from "node:events";
import { createConnection, createServer, type Server } from "node:net";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDisposableGitWorkspace, startDisposableSocketProxy, stopDisposableServer } from "../integration/disposable-session.js";

describe("disposable integration server cleanup", () => {
  it("waits for the named server child to close before returning", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null; kill: ChildProcess["kill"] };
    child.exitCode = null;
    child.kill = vi.fn(() => true);
    let settled = false;
    const stopping = stopDisposableServer(child as ChildProcess).then(() => { settled = true; });

    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);

    child.exitCode = 0;
    child.emit("close", 0, "SIGTERM");
    await stopping;
    expect(settled).toBe(true);
  });

  it("does not signal an already exited server", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null; kill: ChildProcess["kill"] };
    child.exitCode = 0;
    child.kill = vi.fn(() => true);

    await stopDisposableServer(child as ChildProcess);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it("separates a trusted-root exclusion from an unterminated existing rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-exclude-test-"));
    const previous = process.env.HERDR_TOOLS_INTEGRATION_TRUSTED_ROOT;
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "-c", "user.name=Herdr Test", "-c", "user.email=herdr@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"]);
      const exclude = join(root, ".git", "info", "exclude");
      await writeFile(exclude, "# keep this comment");
      const trustedRoot = join(root, "nested");
      const trustedAlias = join(root, "trusted-alias");
      await mkdir(trustedRoot);
      await symlink(trustedRoot, trustedAlias, "dir");
      process.env.HERDR_TOOLS_INTEGRATION_TRUSTED_ROOT = trustedAlias;

      const workspace = await createDisposableGitWorkspace("herdr-no-newline-");

      expect(await readFile(exclude, "utf8")).toBe("# keep this comment\n/nested/.herdr-no-newline-*\n");
      expect(() => execFileSync("git", ["-C", root, "check-ignore", "-q", workspace])).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.HERDR_TOOLS_INTEGRATION_TRUSTED_ROOT;
      else process.env.HERDR_TOOLS_INTEGRATION_TRUSTED_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards one complete prompt frame and records its target and body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herdr-socket-proxy-test-"));
    const backendPath = join(directory, "backend.sock");
    const proxyPath = join(directory, "proxy.sock");
    let backend: Server | undefined;
    try {
      backend = createServer((client) => {
        client.on("data", (chunk) => client.write(chunk));
      });
      await new Promise<void>((resolve, reject) => {
        backend!.once("error", reject);
        backend!.listen(backendPath, resolve);
      });
      const seen: string[] = [];
    const proxy = await startDisposableSocketProxy(backendPath, proxyPath, { onRequest: (request) => { seen.push(JSON.stringify(request)); } });
      const client = createConnection({ path: proxy.path });
      const response = new Promise<string>((resolve, reject) => {
        let output = "";
        client.on("data", (chunk) => {
          output += chunk.toString("utf8");
          if (output.includes("\n")) resolve(output);
        });
        client.once("error", reject);
      });
      const frame = `${JSON.stringify({ id: "socket-test-1", method: "agent.prompt", params: { target: "w1:p1", text: "receipt-body" } })}\n`;
      client.write(frame.slice(0, 17));
      client.write(frame.slice(17));
      await expect(response).resolves.toBe(frame);
      await vi.waitFor(() => expect(seen).toEqual([JSON.stringify({ id: "socket-test-1", method: "agent.prompt", target: "w1:p1", text: "receipt-body" })]));
      client.destroy();
      await proxy.close();
    } finally {
      await new Promise<void>((resolve) => backend?.close(() => resolve()) ?? resolve());
      await rm(directory, { recursive: true, force: true });
    }
  });
});
