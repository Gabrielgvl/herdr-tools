import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveHandoffNamespace } from "../src/handoff.js";

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_MS = 5_000;
const OUTPUT_ROOT = resolve(".reviewer-benchmark/captures");
const abort = new AbortController();

interface RunState {
  runId?: unknown;
  endpoint?: unknown;
  createdAt?: unknown;
  child?: { paneId?: unknown };
  lifecycle?: { state?: unknown };
  artifact?: { status?: unknown };
}

interface Capture {
  at: string;
  runId: string;
  paneId: string;
  lifecycle: string;
  artifactStatus?: string;
  windowSha256?: string;
  recentUnwrappedLines?: string[];
  repeatCount?: number;
  readUnavailable?: true;
}

interface WindowState {
  sha256: string;
  repeats: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--interval-ms must be a positive integer");
  return parsed;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runState(value: unknown): RunState | undefined {
  if (!record(value) || typeof value.runId !== "string" || typeof value.endpoint !== "string" || !record(value.child) || !record(value.lifecycle)) return undefined;
  return value as RunState;
}

async function readState(path: string): Promise<RunState | undefined> {
  try {
    return runState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

async function paneLines(paneId: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync("herdr", ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "100", "--format", "text"], {
      env: process.env,
      timeout: 10_000,
      maxBuffer: 1_048_576,
      signal: abort.signal,
    });
    return stdout.length === 0 ? [] : stdout.split(/\r?\n/u).slice(-100);
  } catch {
    return undefined;
  }
}

async function appendCapture(directory: string, capture: Capture): Promise<void> {
  const path = join(directory, `${capture.runId}.jsonl`);
  await appendFile(path, `${JSON.stringify(capture)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function tick(
  namespace: Awaited<ReturnType<typeof resolveHandoffNamespace>>,
  directory: string,
  tracked: Set<string>,
  windows: Map<string, WindowState>,
): Promise<number> {
  const entries = await readdir(namespace.dir, { withFileTypes: true });
  let written = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await readState(join(namespace.dir, entry.name, ".tools", "state.json"));
    if (state === undefined || state.endpoint !== namespace.endpoint || typeof state.runId !== "string") continue;
    const lifecycle = state.lifecycle?.state;
    const paneId = state.child?.paneId;
    const active = lifecycle === "awaiting_handoff" && typeof paneId === "string";
    if (!tracked.has(state.runId) && !active) continue;
    if (active) tracked.add(state.runId);
    if (typeof paneId !== "string" || typeof lifecycle !== "string") continue;
    const lines = await paneLines(paneId);
    const status = state.artifact?.status;
    const base = {
      at: new Date().toISOString(),
      runId: state.runId,
      paneId,
      lifecycle,
      ...(typeof status === "string" ? { artifactStatus: status } : {}),
    };
    if (lines === undefined) {
      await appendCapture(directory, { ...base, readUnavailable: true });
    } else {
      const sha256 = createHash("sha256").update(JSON.stringify(lines)).digest("hex");
      const previous = windows.get(state.runId);
      if (previous?.sha256 === sha256) {
        previous.repeats += 1;
        await appendCapture(directory, { ...base, windowSha256: sha256, repeatCount: previous.repeats });
      } else {
        windows.set(state.runId, { sha256, repeats: 0 });
        await appendCapture(directory, { ...base, windowSha256: sha256, recentUnwrappedLines: lines });
      }
    }
    written += 1;
    if (!active) {
      tracked.delete(state.runId);
      windows.delete(state.runId);
    }
  }
  return written;
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const intervalMs = positiveInteger(argument("--interval-ms"), DEFAULT_INTERVAL_MS);
  const namespace = await resolveHandoffNamespace();
  const endpoint = createHash("sha256").update(namespace.endpoint).digest("hex").slice(0, 16);
  const directory = join(OUTPUT_ROOT, endpoint);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(resolve(".reviewer-benchmark"), 0o700);
  await chmod(resolve(".reviewer-benchmark/captures"), 0o700);
  await chmod(directory, 0o700);
  const tracked = new Set<string>();
  const windows = new Map<string, WindowState>();
  do {
    const written = await tick(namespace, directory, tracked, windows);
    process.stdout.write(`${new Date().toISOString()} captured=${written} tracked=${tracked.size}\n`);
    if (!once) await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, intervalMs);
      abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolveWait(); }, { once: true });
    });
  } while (!once && !abort.signal.aborted);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());

await main();
