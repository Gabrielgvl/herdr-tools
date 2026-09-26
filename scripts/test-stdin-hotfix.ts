import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOTFIX_LABEL = "HOTFIX_PI_ONLY" as const;
export const REQUIRED_SESSION = "herdr-tools-pi-hotfix-readback" as const;
export const HOTFIX_HOST_FILES = [
  "test/hotfix/pi.stdin.hotfix.test.ts",
  "test/hotfix/mcp.stdio.hotfix.test.ts"
] as const;
export const HOTFIX_MANDATORY_CASES = [
  "seven-tool-smoke",
  "pi-inline-launch",
  "normal-prompt",
  "steer-working",
  "attachment-complete-body"
] as const;

const HOTFIX_CASE_KINDS: Record<string, "pi" | "claude"> = {
  "seven-tool-smoke": "pi",
  "pi-inline-launch": "pi",
  "normal-prompt": "pi",
  "steer-working": "pi",
  "attachment-complete-body": "pi"
};

type HotfixHost = "pi" | "mcp";

const HOTFIX_TOOL_SMOKE: Record<HotfixHost, readonly string[]> = {
  pi: ["herdr_inspect", "herdr_communicate", "herdr_wait", "herdr_jobs", "herdr_launch", "herdr_pane", "herdr_tab"],
  mcp: ["herdr_launch", "herdr_run", "herdr_status"]
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function exactStrings(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new Error(`${label} does not contain the exact mandatory set`);
  }
}

export function parseSession(argv: readonly string[]): string {
  let session: string = REQUIRED_SESSION;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--session") {
      session = argv[index + 1] ?? "";
      index += 1;
    } else if (value?.startsWith("--session=")) {
      session = value.slice("--session=".length);
    } else {
      throw new Error(`Unsupported hotfix argument: ${String(value)}`);
    }
  }
  if (session !== REQUIRED_SESSION) throw new Error(`Hotfix session must be ${REQUIRED_SESSION}`);
  return session;
}

export function vitestArguments(hostFiles: readonly string[] = HOTFIX_HOST_FILES): string[] {
  return ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.hotfix.config.ts", ...hostFiles];
}

export function childExitCode(result: Pick<SpawnSyncReturns<Buffer>, "status" | "error">): number {
  return result.error || result.status === null ? 1 : result.status;
}

function sha256(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
}

function nonPlaceholder(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0 || /^(?:unknown|undefined|null|placeholder|n\/a)$/iu.test(value)) {
    throw new Error(`${label} is missing or placeholder`);
  }
}

export function validateHotfixReceipt(value: unknown, host: HotfixHost): void {
  const receipt = record(value, `${host} receipt`);
  if (receipt.label !== HOTFIX_LABEL || receipt.host !== host || receipt.status !== "passed" || receipt.actualExitCode !== 0) {
    throw new Error(`${host} receipt is not a passed ${HOTFIX_LABEL} receipt`);
  }
  exactStrings(receipt.mandatoryCases, HOTFIX_MANDATORY_CASES, `${host} mandatoryCases`);
  exactStrings(receipt.toolSmoke, HOTFIX_TOOL_SMOKE[host], `${host} toolSmoke`);
  if (typeof receipt.mcpPollingDifference !== "string" || receipt.mcpPollingDifference.length === 0) throw new Error(`${host} receipt omitted host qualification notes`);
  if (!Array.isArray(receipt.receipts)) throw new Error(`${host} receipt omitted case receipts`);
  const cases = new Set<string>();
  let receiptSession: string | undefined;
  for (const item of receipt.receipts) {
    const caseReceipt = record(item, `${host} case receipt`);
    if (typeof caseReceipt.case !== "string" || cases.has(caseReceipt.case)) throw new Error(`${host} case receipts are missing or duplicated`);
    cases.add(caseReceipt.case);
    if (caseReceipt.effect !== "confirmed" || caseReceipt.source !== "recipient-generated" || caseReceipt.requestCount !== 1 || caseReceipt.actualCommandExitCode !== 0) {
      throw new Error(`${host}/${caseReceipt.case} is not an exact confirmed receipt`);
    }
    nonPlaceholder(caseReceipt.session, `${host}/${caseReceipt.case} session`);
    if (receiptSession === undefined) receiptSession = caseReceipt.session as string;
    if (caseReceipt.observedBodySource !== "recipient-body-file" || caseReceipt.session !== receiptSession) {
      throw new Error(`${host}/${caseReceipt.case} is missing recipient body/session provenance`);
    }
    nonPlaceholder(caseReceipt.commandExitFilePath, `${host}/${caseReceipt.case} commandExitFilePath`);
    const expectedKind = HOTFIX_CASE_KINDS[caseReceipt.case];
    if (expectedKind === undefined) throw new Error(`${host}/${caseReceipt.case} is not a mandatory case`);
    if (typeof caseReceipt.nativeRequestId !== "string" || caseReceipt.nativeRequestId.length === 0) throw new Error(`${host}/${caseReceipt.case} omitted native request ID`);
    sha256(caseReceipt.expectedBodySha256, `${host}/${caseReceipt.case} expected body`);
    sha256(caseReceipt.observedBodySha256, `${host}/${caseReceipt.case} observed body`);
    if (typeof caseReceipt.expectedBodyBytes !== "number" || typeof caseReceipt.observedBodyBytes !== "number") throw new Error(`${host}/${caseReceipt.case} omitted body byte counts`);
    if (caseReceipt.expectedBodySha256 !== caseReceipt.observedBodySha256 || caseReceipt.expectedBodyBytes !== caseReceipt.observedBodyBytes) {
      throw new Error(`${host}/${caseReceipt.case} expected and observed bodies differ`);
    }
    const identity = record(caseReceipt.identity, `${host}/${caseReceipt.case} identity`);
    for (const field of ["paneId", "terminalId", "agentName", "agentKind"]) nonPlaceholder(identity[field], `${host}/${caseReceipt.case} ${field}`);
    if (identity.agentKind !== expectedKind) throw new Error(`${host}/${caseReceipt.case} has the wrong recipient kind`);
    const agentSession = record(identity.agentSession, `${host}/${caseReceipt.case} agentSession`);
    for (const field of ["source", "agent", "kind", "value"]) nonPlaceholder(agentSession[field], `${host}/${caseReceipt.case} agentSession.${field}`);
  }
  for (const mandatory of HOTFIX_MANDATORY_CASES) if (!cases.has(mandatory)) throw new Error(`${host} missing mandatory case ${mandatory}`);
}

export function validateHotfixEvidence(evidenceDir: string): void {
  for (const [host, file] of [["pi", "pi.json"], ["mcp", "mcp.json"]] as const) {
    const path = join(evidenceDir, file);
    if (!existsSync(path)) throw new Error(`missing ${host} evidence receipt: ${path}`);
    validateHotfixReceipt(JSON.parse(readFileSync(path, "utf8")), host);
  }
}

export function runHotfix(argv: readonly string[], cwd = process.cwd()): number {
  const session = parseSession(argv);
  if (process.env.HERDR_TOOLS_RUN_INTEGRATION !== "1") throw new Error("HERDR_TOOLS_RUN_INTEGRATION=1 is required for the disposable hotfix");
  const build = spawnSync("npm", ["run", "build:mcp"], { cwd, stdio: "inherit", timeout: 180_000, killSignal: "SIGKILL" });
  const buildStatus = childExitCode(build);
  if (buildStatus !== 0) {
    process.stderr.write(`${HOTFIX_LABEL} MCP build exit=${buildStatus}\n`);
    return buildStatus;
  }
  const evidenceDir = process.env.HERDR_TOOLS_HOTFIX_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), `herdr-tools-hotfix-${process.pid}-${randomUUID()}-`));
  const result = spawnSync(process.execPath, vitestArguments(), {
    cwd,
    env: {
      ...process.env,
      HERDR_TOOLS_RUN_INTEGRATION: "1",
      HERDR_TOOLS_HOTFIX: "1",
      HERDR_TOOLS_HOTFIX_LABEL: HOTFIX_LABEL,
      HERDR_TOOLS_HOTFIX_EVIDENCE_DIR: evidenceDir,
      HERDR_TOOLS_INTEGRATION_SESSION: session
    },
    stdio: "inherit",
    timeout: 1_100_000,
    killSignal: "SIGKILL"
  });
  const status = childExitCode(result);
  if (status !== 0) {
    process.stderr.write(`${HOTFIX_LABEL} child exit=${status} evidence=${resolve(evidenceDir)}\n`);
    return status;
  }
  validateHotfixEvidence(evidenceDir);
  process.stdout.write(`${HOTFIX_LABEL} evidence=${resolve(evidenceDir)} status=PASS\n`);
  return 0;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv.some((value) => resolve(value) === scriptPath)) {
  try {
    process.exitCode = runHotfix(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${HOTFIX_LABEL} blocked: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
