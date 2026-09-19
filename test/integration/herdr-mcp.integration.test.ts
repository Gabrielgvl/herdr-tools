import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, vi } from "vitest";
import { HerdrCli } from "../../src/cli.js";
import { JobRegistry } from "../../src/job-registry.js";
import { RuntimeOwnership } from "../../src/ownership.js";
import { publishedInputSchema } from "../../src/mcp/adapter.js";
import { LAUNCH_DIAGNOSTIC_MARKER, LAUNCH_DIAGNOSTIC_SUMMARY, LAUNCH_RECOVERY_GUIDANCE } from "../../src/tools/launch.js";
import { createPreflight, createToolSurface, CORE_TOOL_NAMES } from "../../src/tool-surface.js";
import { stopDisposableServer } from "./disposable-session.js";
import { stubSupervision } from "../unit/supervision-fixtures.js";

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = "herdr-tools-integration";
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(repoRoot, "dist/src/mcp-server.js");
/**
 * Herdr 0.8.0 attaches a shell to a freshly created pane asynchronously and
 * exposes no readiness field, so `agent start` against a brand-new pane races
 * with `agent_pane_busy`. The launch therefore targets a pane created earlier in
 * this run, and this bounded settle covers the remainder of that gap. It relaxes
 * no assertion: the launch must still succeed and prove its evidence.
 */
const PANE_SETTLE_MS = 3_000;
/** Planted as a pane environment override; it must never appear in a tool result. */
const ENVIRONMENT_SENTINEL = "integration-environment-sentinel";
/**
 * A pane-output literal no target can ever print: it is generated per run and is
 * never written to a pane, never sent as a message, and never part of a prompt.
 * It keeps a long wait's initial observation unmatched without depending on what
 * the live child happens to have on screen.
 */
const IMPOSSIBLE_OUTPUT_LITERAL = `herdr-tools-impossible-output-${process.pid}-${randomUUID()}`;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/** Every field `herdr_launch` publishes to the model on failure, and nothing else. */
const LAUNCH_DIAGNOSTIC_FIELDS = ["agentStarted", "code", "created", "effectCertainty", "phase", "promptSubmitted", "recipientRegistered", "recoveryGuidance"];
const LAUNCH_UNCONFIRMED_DIAGNOSTIC_FIELDS = [...LAUNCH_DIAGNOSTIC_FIELDS, "assignmentState", "paneId", "supervisorJobId"];
const LAUNCH_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
/** The identifier fields the diagnostic's `created` block may carry. */
const LAUNCH_CREATED_FIELDS = ["tabId", "paneId", "agentId"];

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("integration response is not an object");
  return value as Record<string, unknown>;
}

function returnedPane(result: unknown): Record<string, unknown> {
  const root = record(result);
  const candidate = root.pane ?? record(root.split_result ?? root.move_result).pane;
  const pane = record(candidate);
  if (typeof pane.pane_id !== "string" || pane.pane_id.length === 0) throw new Error("integration mutation omitted its pane ID");
  return pane;
}

/** The bounded structured evidence block the adapter appends, or the sole JSON block. */
function evidence(result: ToolResult): Record<string, unknown> {
  const details = result.content.find((block) => block.text.startsWith("herdr-details\n"));
  if (details) return record(JSON.parse(details.text.slice("herdr-details\n".length)));
  const only = result.content.at(-1);
  if (!only) throw new Error("tool result carried no content");
  return record(JSON.parse(only.text));
}

function text(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

/**
 * A surface built purely to read the shared TypeBox `parameters`, so the wire
 * schema can be compared against the schema the server validates with. No CLI
 * call is made: `tools/list` needs none.
 */
function schemaReferenceSurface() {
  const cli = new HerdrCli(async () => ({ stdout: "{}", stderr: "", code: 0, killed: false }));
  return createToolSurface({
    cli,
    context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" },
    environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true },
    preflight: createPreflight(cli),
    settingsLoader: async () => ({ reviewCadenceMinutes: 5, reviewerModel: "reference", reviewerThinking: "low" }),
    jobs: new JobRegistry(),
    profiles: { load: async () => ({ effective: new Map(), candidates: [], diagnostics: [] }) as never },
    ownership: new RuntimeOwnership(),
    supervision: stubSupervision(),
    cwd: "/reference"
  });
}

describe.skipIf(!enabled)("disposable Herdr MCP integration", () => {
  it("serves the seven tools over stdio against the named disposable session only", async () => {
    expect(requestedSession).toBe(REQUIRED_SESSION);
    expect(process.env.HERDR_ENV).toBe("1");
    expect([process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID].every(Boolean)).toBe(true);

    let workspaceId: string | undefined;
    let reboundWorkspaceId: string | undefined;
    let sessionStarted = false;
    let server: ChildProcess | undefined;
    let client: Client | undefined;
    let failure: unknown;
    const cwd = await mkdtemp(`${tmpdir()}/herdr-mcp-it-`);
    const label = `mcp-herdr-tools-it-${process.pid}`;
    const socketPath = `/home/gabriel/.config/herdr/sessions/${REQUIRED_SESSION}/herdr.sock`;

    const run = async (...args: string[]): Promise<unknown> => {
      const result = await execFileAsync("herdr", args, { cwd, maxBuffer: 4_000_000 });
      return JSON.parse(result.stdout);
    };
    const runNamed = (args: string[]) => run("--session", REQUIRED_SESSION, ...args);
    const diagnosticRecord = (value: unknown): Record<string, unknown> => {
      const source = record(value);
      const diagnostic = Object.fromEntries(["pane_id", "terminal_id", "agent_id", "name", "agent_name", "agent", "agent_status", "state_change_seq", "revision", "interactive_ready", "screen_detection_skipped"].flatMap((field): Array<[string, unknown]> => {
        const candidate = source[field];
        return typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean" || candidate === null ? [[field, candidate]] : [];
      }));
      const session = source.agent_session;
      if (typeof session === "object" && session !== null && !Array.isArray(session)) {
        const identity = session as Record<string, unknown>;
        if (["source", "agent", "kind", "value"].every((field) => typeof identity[field] === "string")) {
          const full = [identity.source, identity.agent, identity.kind, identity.value] as string[];
          diagnostic.agent_session = { source: full[0]!.slice(0, 256), agent: full[1]!.slice(0, 256), kind: full[2]!.slice(0, 256), value: full[3]!.slice(0, 256) };
          diagnostic.agent_session_fingerprint = createHash("sha256").update(JSON.stringify(full)).digest("hex");
        }
      }
      return diagnostic;
    };
    /**
     * The whole model-visible failure projection for `herdr_launch`, asserted as
     * an exact shape rather than by sampling fields. Production deliberately
     * withholds every raw failure field over MCP — cause code and cause message,
     * the CLI error envelope, prompt submission and confirmation evidence, phase
     * timing, attempts, the retained attachment — and publishes one fixed-shape
     * diagnostic instead. This asserts both halves of that contract: exactly the
     * published fields are present, and the withheld ones are absent from the
     * result and from the message. Authoritative failure evidence still comes
     * from the CLI readbacks below, which is where it belongs.
     */
    const launchFailureDiagnostic = (result: ToolResult): Record<string, unknown> => {
      const failure = evidence(result);
      expect(Object.keys(failure).sort()).toEqual(["code", "details", "message"]);
      expect(typeof failure.code).toBe("string");
      const details = record(failure.details);
      expect(Object.keys(details).sort()).toEqual(["diagnostic", "tool"]);
      expect(details.tool).toBe("herdr_launch");
      const diagnostic = record(details.diagnostic);
      const assignmentUnconfirmed = diagnostic.assignmentState === "unconfirmed";
      expect(Object.keys(diagnostic).sort()).toEqual([...(assignmentUnconfirmed ? LAUNCH_UNCONFIRMED_DIAGNOSTIC_FIELDS : LAUNCH_DIAGNOSTIC_FIELDS)].sort());
      if (assignmentUnconfirmed) {
        expect(typeof diagnostic.paneId).toBe("string");
        expect(typeof diagnostic.supervisorJobId).toBe("string");
      }
      expect(String(diagnostic.code)).toMatch(LAUNCH_CODE_PATTERN);
      expect(typeof diagnostic.phase).toBe("string");
      for (const flag of ["agentStarted", "promptSubmitted", "recipientRegistered"]) {
        expect(typeof diagnostic[flag], flag).toBe("boolean");
      }
      expect(["absent", "partial", "unknown", "confirmed"]).toContain(diagnostic.effectCertainty);
      expect(Object.values(LAUNCH_RECOVERY_GUIDANCE)).toContain(diagnostic.recoveryGuidance);
      const created = record(diagnostic.created);
      for (const [field, value] of Object.entries(created)) {
        expect(LAUNCH_CREATED_FIELDS, field).toContain(field);
        expect(typeof value, field).toBe("string");
      }
      // The message is the fixed summary plus exactly this diagnostic: no cause
      // text, and no second record the projection did not publish.
      const separator = ` ${LAUNCH_DIAGNOSTIC_MARKER} `;
      const message = String(failure.message);
      const offset = message.indexOf(separator);
      expect(offset, message).toBeGreaterThan(0);
      expect(message.slice(0, offset)).toBe(LAUNCH_DIAGNOSTIC_SUMMARY);
      expect(JSON.parse(message.slice(offset + separator.length))).toEqual(diagnostic);
      // Nothing the model receives may carry the withheld raw evidence.
      for (const withheld of ["causeCode", "causeMessage", "cliFailure", "promptConfirmation", "initialPromptSubmission", "promptConsumption", "timing", "attempts", "readiness", "reconciliation", "attachment", "recipientGrant"]) {
        expect(text(result), withheld).not.toContain(withheld);
      }
      return diagnostic;
    };
    const schedulingToleranceMs = 500;
    /** Success-path phase timing; a failure publishes no timing over MCP. */
    const assertLaunchPhaseTiming = (details: Record<string, unknown>, monotonicWallElapsedMs: number): void => {
      const readiness = record(details.readiness);
      const confirmation = record(details.promptConfirmation);
      const timing = record(details.timing);
      const selectedStartReadinessMs = timing.selectedStartReadinessMs;
      const promptSubmissionAckMs = timing.promptSubmissionAckMs;
      const postAckConfirmationMs = timing.postAckConfirmationMs;
      for (const duration of [selectedStartReadinessMs, promptSubmissionAckMs, postAckConfirmationMs]) {
        expect(Number.isSafeInteger(duration)).toBe(true);
        expect(Number(duration)).toBeGreaterThanOrEqual(0);
      }
      const decomposedPhaseElapsedMs = Number(selectedStartReadinessMs) + Number(promptSubmissionAckMs) + Number(postAckConfirmationMs);
      expect(decomposedPhaseElapsedMs).toBeLessThanOrEqual(monotonicWallElapsedMs + schedulingToleranceMs);
      expect(readiness.elapsedMs).toBe(selectedStartReadinessMs);
      expect(confirmation.elapsedMs).toBe(postAckConfirmationMs);
    };
    /**
     * The model-visible diagnostic is what MCP publishes, so it is what gets
     * logged. Everything richer is read back from the CLI below, which is the
     * authoritative source for the raw fields this projection withholds.
     */
    const recordLaunchFailureBeforeTeardown = async (diagnostic: Record<string, unknown>, paneId: string, elapsedMs: number): Promise<void> => {
      process.stderr.write(`INTEGRATION_LAUNCH_FAILURE_BEFORE_TEARDOWN ${JSON.stringify({ elapsedMs, diagnostic })}\n`);
      for (const [label, args] of [
        ["agent_get", ["agent", "get", paneId]],
        ["pane_get", ["pane", "get", paneId]]
      ] as const) {
        try {
          const value = record(record(await runNamed([...args])).result);
          const candidate = value.agent ?? value.pane ?? value;
          process.stderr.write(`INTEGRATION_LAUNCH_${label.toUpperCase()} ${JSON.stringify(diagnosticRecord(candidate))}\n`);
        } catch (error) {
          process.stderr.write(`INTEGRATION_LAUNCH_${label.toUpperCase()}_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      try {
        const state = record(record(record(await runNamed(["api", "snapshot"])).result).snapshot);
        const panes = Array.isArray(state.panes) ? state.panes.map(record).filter((item) => item.pane_id === paneId).map(diagnosticRecord) : [];
        const agents = Array.isArray(state.agents) ? state.agents.map(record).filter((item) => item.pane_id === paneId).map(diagnosticRecord) : [];
        process.stderr.write(`INTEGRATION_LAUNCH_SNAPSHOT ${JSON.stringify({ panes, agents })}\n`);
      } catch (error) {
        process.stderr.write(`INTEGRATION_LAUNCH_SNAPSHOT_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
      }
    };
    const topologyIds = (snapshot: Record<string, unknown>) => ({
      workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces.map((item) => record(item).workspace_id).sort() : [],
      tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs.map((item) => record(item).tab_id).sort() : [],
      panes: Array.isArray(snapshot.panes) ? snapshot.panes.map((item) => record(item).pane_id).sort() : []
    });
    const defaultSnapshot = async () => record(record(record(await run("api", "snapshot")).result).snapshot);

    try {
      const sessions = record(await run("session", "list", "--json"));
      const existing = Array.isArray(sessions.sessions) && sessions.sessions.some((session) => record(session).name === REQUIRED_SESSION);
      if (existing) throw new Error(`refusing to reuse existing session ${REQUIRED_SESSION}`);

      // The built entry is what the plugin's server map runs, so the run under
      // test is the emitted JavaScript, not the TypeScript sources.
      await execFileAsync(process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: repoRoot, maxBuffer: 4_000_000 });

      let startupError = "";
      server = spawn("herdr", ["--session", REQUIRED_SESSION, "server"], { cwd, stdio: ["ignore", "ignore", "pipe"] });
      server.stderr?.on("data", (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-2_000); });
      const startupDeadline = performance.now() + 10_000;
      while (performance.now() < startupDeadline) {
        if (server.exitCode !== null) throw new Error(`named Herdr server exited during startup: ${startupError}`);
        const listed = record(await run("session", "list", "--json"));
        sessionStarted = Array.isArray(listed.sessions) && listed.sessions.some((session) => {
          const value = record(session);
          return value.name === REQUIRED_SESSION && value.running === true;
        });
        if (sessionStarted) break;
        await new Promise((settle) => setTimeout(settle, 100));
      }
      if (!sessionStarted) throw new Error(`named Herdr server did not become ready: ${startupError}`);
      const namedSocket = record((Array.isArray(record(await run("session", "list", "--json")).sessions) ? (record(await run("session", "list", "--json")).sessions as unknown[]) : []).find((session) => record(session).name === REQUIRED_SESSION));
      expect(namedSocket.socket_path).toBe(socketPath);
      // `herdr server` creates the session directory honoring the process umask,
      // which is 002 on hosts whose primary group is the user: the dir lands
      // 0775 and the handoff/lock namespaces reject any group-writable parent.
      // The disposable session is deleted at teardown, so tightening it here is
      // safe; it does not relax the production owner-only check.
      await chmod(dirname(socketPath), 0o700);

      const liveBaseline = topologyIds(await defaultSnapshot());
      const created = record(record(await runNamed(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"])).result);
      workspaceId = record(created.workspace ?? created).workspace_id as string;
      if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new Error("workspace create did not return an opaque workspace ID");
      const fixture = record(record(record(await runNamed(["api", "snapshot"])).result).snapshot);
      const fixturePanes = Array.isArray(fixture.panes) ? fixture.panes.map(record) : [];
      const rootPane = fixturePanes.find((pane) => pane.workspace_id === workspaceId);
      if (!rootPane || typeof rootPane.pane_id !== "string" || typeof rootPane.tab_id !== "string") throw new Error("fixture snapshot omitted its root pane context");

      const reboundWorkspace = record(record(await runNamed(["workspace", "create", "--cwd", cwd, "--label", `${label}-rebound`, "--no-focus"])).result);
      reboundWorkspaceId = record(reboundWorkspace.workspace ?? reboundWorkspace).workspace_id as string;
      if (typeof reboundWorkspaceId !== "string" || reboundWorkspaceId.length === 0 || reboundWorkspaceId === workspaceId) throw new Error("rebound workspace create did not return a distinct opaque workspace ID");

      // Reproduce the stale-terminal topology: create a pane, move that same
      // pane across workspaces into a new tab, then start MCP with every
      // original injected ID. The move must allocate a new public pane ID;
      // only the live terminal identity can make the old pane ID safe to rebind.
      const contextSplit = record(record(await runNamed(["pane", "split", rootPane.pane_id, "--direction", "right", "--cwd", cwd, "--no-focus"])).result);
      const splitPane = returnedPane(contextSplit);
      const originalPaneId = String(splitPane.pane_id);
      const originalTabId = rootPane.tab_id;
      const moved = record(record(await runNamed(["pane", "move", originalPaneId, "--new-tab", "--workspace", reboundWorkspaceId, "--label", `${label}-moved`, "--no-focus"])).result);
      const movedPane = returnedPane(moved);
      expect(String(movedPane.pane_id)).not.toBe(originalPaneId);
      const afterMove = record(record(record(await runNamed(["api", "snapshot"])).result).snapshot);
      const afterMovePanes = Array.isArray(afterMove.panes) ? afterMove.panes.map(record) : [];
      expect(afterMovePanes.some((pane) => pane.pane_id === originalPaneId)).toBe(false);
      const movedRecord = afterMovePanes.find((pane) => pane.pane_id === movedPane.pane_id);
      if (!movedRecord || typeof movedRecord.tab_id !== "string" || typeof movedRecord.workspace_id !== "string" || movedRecord.workspace_id !== reboundWorkspaceId || movedRecord.tab_id === originalTabId) throw new Error("cross-workspace pane move did not produce the expected authoritative context");
      const movedTabId = movedRecord.tab_id;

      // The socket path is the only thing that binds the server to the
      // disposable session; every `herdr` call it makes inherits it.
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverEntry],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          HERDR_ENV: "1",
          HERDR_SOCKET_PATH: socketPath,
          HERDR_WORKSPACE_ID: workspaceId,
          // Deliberately preserve every ID captured before the cross-workspace
          // move. The resolver must follow the live pane alias and rebind all
          // three IDs without accepting an unrelated replacement.
          HERDR_TAB_ID: originalTabId,
          HERDR_PANE_ID: originalPaneId,
          HERDR_PROJECT_DIR: cwd
        },
        stderr: "pipe"
      });
      client = new Client({ name: "herdr-tools-integration", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);
      let serverStderr = "";
      transport.stderr?.on("data", (chunk: Buffer) => { serverStderr += chunk.toString(); });
      // Every tool result is swept for the environment value planted below, so
      // no block this server publishes can echo an owner-supplied secret.
      const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        const result = await (client!.callTool({ name, arguments: args }) as Promise<ToolResult>);
        expect(text(result), name).not.toContain(ENVIRONMENT_SENTINEL);
        return result;
      };

      const reboundContext = await call("herdr_inspect", { mode: "context" });
      expect(reboundContext.isError).toBeUndefined();
      expect(evidence(reboundContext)).toMatchObject({
        context: {
          injected: { workspaceId, tabId: originalTabId, paneId: originalPaneId },
          effective: { workspaceId: reboundWorkspaceId, tabId: movedTabId, paneId: String(movedPane.pane_id) },
          rebound: true
        }
      });

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...CORE_TOOL_NAMES]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);

      // The schema the client receives must be the schema the server validates
      // with, so the model can never be shown a looser contract than the one
      // enforced.
      for (const definition of schemaReferenceSurface().definitions) {
        const wire = listed.tools.find((tool) => tool.name === definition.name)?.inputSchema;
        expect(wire, definition.name).toEqual(publishedInputSchema(definition.parameters));
      }
      const mixedShape = await call("herdr_inspect", { mode: "context", collection: "panes" });
      expect(mixedShape.isError).toBe(true);
      expect(text(mixedShape)).toContain("INVALID_INPUT");
      expect(text(mixedShape)).toContain("additionalProperties");

      const health = await call("herdr_inspect", { mode: "health" });
      expect(health.isError).toBeUndefined();
      expect(evidence(health)).toMatchObject({ operation: "inspect", kind: "health", outcome: "success", socketReachable: true, compatible: true, environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true } });

      const profiles = await call("herdr_inspect", { mode: "collection", collection: "profiles" });
      const catalog = evidence(profiles);
      expect(catalog).toMatchObject({ operation: "inspect", kind: "collection", collection: "profiles", outcome: "success" });
      expect(Array.isArray(catalog.items) ? catalog.items : []).toHaveLength(24);
      expect(catalog.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "worker-pi", kind: "pi" }),
        expect.objectContaining({ name: "promoter-pi", kind: "pi", fallbackProfiles: [] }),
        expect.objectContaining({ name: "manager-claude", kind: "claude", model: "fable", effort: "high", permissionMode: "default", fallbackProfiles: ["manager-pi"] }),
        expect.objectContaining({ name: "scout-agy", kind: "agy", model: "gemini-3.8-flash-low", mode: "plan", dangerouslySkipPermissions: true, addDirs: [], fallbackProfiles: ["scout-claude"] }),
        expect.objectContaining({ name: "worker-agy", kind: "agy", model: "gemini-3.8-flash-high", mode: "accept-edits", dangerouslySkipPermissions: true, addDirs: [], fallbackProfiles: ["worker-claude"] }),
        expect.objectContaining({ name: "researcher-agy", kind: "agy", model: "gemini-3.8-flash-low", mode: "plan", dangerouslySkipPermissions: true, addDirs: [], fallbackProfiles: ["researcher-claude"] }),
        expect.objectContaining({ name: "worker-devin", kind: "devin", model: "swe-2-max", permissionMode: "dangerous", fallbackProfiles: ["worker-pi"] }),
        expect.objectContaining({ name: "reviewer-devin", kind: "devin", model: "swe-2-max", permissionMode: "dangerous", fallbackProfiles: ["reviewer-pi"] })
      ]));
      expect(catalog.diagnostics ?? []).toEqual([]);

      // Create a disposable pane through this same runtime so the result still
      // proves environment redaction, then let the launch exercise its default
      // same-tab placement against the rebound caller pane.
      const prepared = await call("herdr_pane", { operation: "split", target: String(movedPane.pane_id), label: "mcp-prepared", direction: "right", focus: false, env: { HERDR_TOOLS_IT_SECRET: ENVIRONMENT_SENTINEL } });
      const preparedPaneId = evidence(prepared).paneId as string;
      expect(typeof preparedPaneId).toBe("string");

      const createdTab = await call("herdr_tab", { operation: "create", label: "mcp-smoke" });
      const createdTabId = evidence(createdTab).tabId as string;
      expect(typeof createdTabId).toBe("string");
      const closedTab = await call("herdr_tab", { operation: "close", target: createdTabId });
      expect(closedTab.isError).toBeUndefined();

      const panes = await call("herdr_inspect", { mode: "collection", collection: "panes" });
      expect(evidence(panes).items).toEqual(expect.arrayContaining([expect.objectContaining({ workspace_id: reboundWorkspaceId })]));

      await new Promise((settle) => setTimeout(settle, PANE_SETTLE_MS));

      // A launched child is covered by its exact supervisor before this wait
      // starts. The MCP host has no explicit wait-review model service, so a
      // redundant reviewer would fail the job; remaining live proves the
      // supervisor retained sole semantic-review ownership.
      const reviewerTargetLaunch = await call("herdr_launch", { name: "mcp-reviewer-target", profile: "scout-pi", assignment: { objective: "Stay idle as a supervised wait target.", scope: "Change nothing.", verification: "The pane stays live at the same identity." }, supervisionDigest: { doneWhen: ["The pane stays live at the same identity."], constraints: ["none"] } });
      expect(reviewerTargetLaunch.isError, text(reviewerTargetLaunch)).toBeUndefined();
      const reviewerTargetEvidence = evidence(reviewerTargetLaunch);
      expect(reviewerTargetEvidence).toMatchObject({
        operation: "launch",
        outcome: "launched",
        placement: { mode: "same_tab" },
        kind: "pi",
        initialPromptSent: true,
        promptSubmitted: true,
        supervision: { jobId: expect.any(String), state: "active" }
      });
      const reviewerPaneId = String(reviewerTargetEvidence.paneId);
      const supervisorJobId = String(record(reviewerTargetEvidence.supervision).jobId);
      const supervisedWait = await call("herdr_wait", {
        targets: [reviewerPaneId],
        match: "any",
        condition: { kind: "output", match: { kind: "literal", value: IMPOSSIBLE_OUTPUT_LITERAL } },
        timeoutMs: 31 * 60_000,
        label: "mcp supervised long wait"
      });
      expect(supervisedWait.isError, text(supervisedWait)).toBeUndefined();
      const supervisedWaitJobId = evidence(supervisedWait).jobId as string;
      await vi.waitFor(async () => {
        const job = await call("herdr_jobs", { operation: "get", jobId: supervisedWaitJobId });
        const jobEvidence = evidence(job);
        expect(jobEvidence).toMatchObject({
          operation: "jobs",
          view: "job",
          jobId: supervisedWaitJobId,
          operation_phase: "running"
        });
        expect(jobEvidence).not.toHaveProperty("wait_result");
        expect(jobEvidence).not.toHaveProperty("error");
      }, { timeout: 20_000, interval: 100 });
      const supervisor = evidence(await call("herdr_jobs", { operation: "get", jobId: supervisorJobId }));
      expect(supervisor).toMatchObject({
        operation: "jobs",
        view: "job",
        jobId: supervisorJobId,
        operation_phase: "running",
        request: { targetIds: [reviewerPaneId] },
        supervision: { state: expect.stringMatching(/^(?:active|degraded)$/u), child: { paneId: reviewerPaneId } }
      });
      const cancelledSupervisedWait = await call("herdr_jobs", { operation: "cancel", jobId: supervisedWaitJobId });
      expect(cancelledSupervisedWait.isError, text(cancelledSupervisedWait)).toBeUndefined();
      expect(evidence(cancelledSupervisedWait)).toMatchObject({ operation_phase: "settled", wait_result: "cancelled" });
      const closedReviewerPane = await call("herdr_pane", { operation: "close", target: reviewerPaneId });
      expect(closedReviewerPane.isError, text(closedReviewerPane)).toBeUndefined();

      const prelaunch = await call("herdr_inspect", { mode: "target", target: preparedPaneId });
      const prelaunchMetadata = record(evidence(prelaunch).metadata);
      expect(prelaunchMetadata).toMatchObject({ pane_id: preparedPaneId, agent_status: "unknown" });
      expect(prelaunchMetadata).not.toHaveProperty("agent_name");
      expect(prelaunchMetadata).not.toHaveProperty("agent_id");
      expect(prelaunchMetadata).not.toHaveProperty("agent");
      const launchStartedAt = performance.now();
      const launched = await call("herdr_launch", { name: "mcp-integration-worker", profile: "worker-pi", assignment: { objective: "Use the bash tool to run pwd, then report the working directory.", scope: "Run pwd only. Change nothing.", verification: "The reported directory is the working directory pwd printed." }, supervisionDigest: { doneWhen: ["The reported directory is the working directory pwd printed."], constraints: ["none"] } });
      const launchElapsedMs = performance.now() - launchStartedAt;
      if (launched.isError) {
        const diagnostic = launchFailureDiagnostic(launched);
        const created = record(diagnostic.created);
        const launchFailurePaneId = typeof created.paneId === "string" ? created.paneId : preparedPaneId;
        await recordLaunchFailureBeforeTeardown(diagnostic, launchFailurePaneId, launchElapsedMs);
        // Exactly one live launch failure is an accepted outcome: the agent
        // started, the prompt was acknowledged, and its consumption could not be
        // proven inside the confirmation window, so the launch fails closed and
        // preserves the pane. Any other failure is a real defect and must fail
        // this run rather than be tolerated by a loose shape.
        expect(diagnostic).toMatchObject({
          code: "LAUNCH_FAILED",
          phase: "prompt_verification",
          agentStarted: true,
          promptSubmitted: true,
          assignmentState: "unconfirmed",
          paneId: expect.any(String),
          supervisorJobId: expect.any(String),
          // Recipient registration remains gated on consumption confirmation;
          // the exact supervisor was already bound before prompt dispatch.
          recipientRegistered: false,
          recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.preserveUnconfirmed
        });
        // A submitted prompt can never be reconciled as having had no effect.
        expect(["partial", "unknown"]).toContain(diagnostic.effectCertainty);
        expect(typeof created.paneId).toBe("string");
        // Do not run wait, steer, transcript, reviewer, job, or close assertions
        // against an assignment whose consumption was not proven.
        return;
      }
      const launchEvidence = evidence(launched);
      const workerPaneId = String(launchEvidence.paneId);
      expect(launchEvidence).toMatchObject({
        operation: "launch",
        outcome: "launched",
        placement: { mode: "same_tab" },
        kind: "pi",
        paneId: workerPaneId,
        initialPromptSent: true,
        envelope: { version: "v1", kind: "assignment" },
        promptConfirmation: { elapsedMs: expect.any(Number) },
        timing: { selectedStartReadinessMs: expect.any(Number), promptSubmissionAckMs: expect.any(Number), postAckConfirmationMs: expect.any(Number) },
        profile: { name: "worker-pi", selected: "worker-pi", runtime: { kind: "pi", model: expect.stringMatching(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/u), thinking: "max" } }
      });
      assertLaunchPhaseTiming(launchEvidence, launchElapsedMs);
      expect(record(launchEvidence.sender).paneId).toBe(String(movedPane.pane_id));
      expect(record(record(launchEvidence.profile).source).kind).toBe("bundled");
      const launchedSnapshot = record(record(record(await runNamed(["api", "snapshot"])).result).snapshot);
      const launchedPane = (Array.isArray(launchedSnapshot.panes) ? launchedSnapshot.panes.map(record) : []).find((pane) => pane.pane_id === workerPaneId);
      expect(launchedPane).toMatchObject({ pane_id: workerPaneId, tab_id: movedTabId, workspace_id: reboundWorkspaceId });

      const confirmedState = record(launchEvidence.initialPromptObservation).state;
      const confirmedWaitState = confirmedState === "working" ? "working" : confirmedState === "blocked" ? "needs_input" : "completed";
      const shortWait = await call("herdr_wait", { targets: [workerPaneId], match: "any", condition: { kind: "state", state: confirmedWaitState }, timeoutMs: 10_000 });
      expect(shortWait.isError, text(shortWait)).toBeUndefined();
      const shortWaitJobId = evidence(shortWait).jobId as string;
      await vi.waitFor(async () => {
        const job = await call("herdr_jobs", { operation: "get", jobId: shortWaitJobId });
        expect(evidence(job)).toMatchObject({ operation: "jobs", view: "job", jobId: shortWaitJobId, operation_phase: "settled", wait_result: "condition_met" });
      }, { timeout: 20_000, interval: 100 });

      // `steer` is the provenance-preserving operation for a target that is
      // already working on its assignment; `prompt` correctly refuses to
      // interrupt one.
      const communicated = await call("herdr_communicate", { target: workerPaneId, operation: "steer", text: "Also report the current user." });
      expect(communicated.isError, text(communicated)).toBeUndefined();
      expect(evidence(communicated)).toMatchObject({ operation: "steer", envelope: { version: "v1", kind: "steer" }, sender: { paneId: String(movedPane.pane_id) } });
      const transcript = await call("herdr_inspect", { mode: "target", target: workerPaneId });
      expect(JSON.stringify(evidence(transcript).recentUnwrappedLines)).toContain("[HERDR AGENT MESSAGE v1]");
      const detached = await call("herdr_wait", { targets: [workerPaneId], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 20_000, label: "mcp detached" });
      const jobId = evidence(detached).jobId as string;
      expect(jobId.startsWith("job_")).toBe(true);
      const jobs = await call("herdr_jobs", { operation: "list" });
      expect(jobs.content).toHaveLength(1);
      expect(text(jobs)).toContain(jobId);
      const job = await call("herdr_jobs", { operation: "get", jobId });
      expect(evidence(job)).toMatchObject({ operation: "jobs", view: "job", jobId });
      const cancelled = await call("herdr_jobs", { operation: "cancel", jobId });
      expect(cancelled.isError).toBeUndefined();

      const closedPane = await call("herdr_pane", { operation: "close", target: workerPaneId });
      expect(closedPane.isError, text(closedPane)).toBeUndefined();

      expect(serverStderr).toBe("");
      await client.close();
      client = undefined;

      // Fail-closed startup, exercised against the same built entry.
      const refusals: Array<[NodeJS.ProcessEnv, string]> = [
        [{ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: rootPane.tab_id, HERDR_PANE_ID: rootPane.pane_id, HERDR_PROJECT_DIR: join(cwd, "missing") }, "PROJECT_DIR"],
        [{ HERDR_SOCKET_PATH: socketPath, HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: rootPane.tab_id, HERDR_PANE_ID: rootPane.pane_id, HERDR_PROJECT_DIR: cwd }, "HERDR_ENV"],
        [{ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PROJECT_DIR: cwd }, "INJECTED_CONTEXT"]
      ];
      for (const [refusedEnv, reason] of refusals) {
        const refusal = await new Promise<{ code: number | null; stderr: string; stdout: string }>((settle) => {
          const child = spawn(process.execPath, [serverEntry], { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...refusedEnv }, stdio: ["pipe", "pipe", "pipe"] });
          let stderrText = "";
          let stdoutText = "";
          child.stderr.on("data", (chunk: Buffer) => { stderrText += chunk.toString(); });
          child.stdout.on("data", (chunk: Buffer) => { stdoutText += chunk.toString(); });
          child.once("close", (code) => settle({ code, stderr: stderrText, stdout: stdoutText }));
        });
        expect(refusal.code, `${reason}: ${refusal.stderr}`).not.toBe(0);
        expect(refusal.stdout).toBe("");
        expect(refusal.stderr.trimEnd().split("\n")).toHaveLength(1);
        expect(refusal.stderr).toContain(`herdr-tools mcp server refused to start: ${reason}`);
      }

      expect(topologyIds(await defaultSnapshot())).toEqual(liveBaseline);
    } catch (error) {
      failure = error;
      process.stderr.write(`INTEGRATION_FAILURE_RECORDED ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    } finally {
      if (failure !== undefined) process.stderr.write("INTEGRATION_FAILURE_RECORDED_BEFORE_TEARDOWN\n");
      await client?.close().catch(() => undefined);
      for (const disposableWorkspaceId of [reboundWorkspaceId, workspaceId]) {
        if (disposableWorkspaceId) {
          await runNamed(["workspace", "close", disposableWorkspaceId]).catch((error: unknown) => process.stderr.write(`INTEGRATION_TEARDOWN_FAILURE ${String(error)}\n`));
        }
      }
      if (sessionStarted) await run("session", "stop", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_STOP_FAILURE ${String(error)}\n`));
      await stopDisposableServer(server);
      if (sessionStarted) await run("session", "delete", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_DELETE_FAILURE ${String(error)}\n`));
      await rm(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
