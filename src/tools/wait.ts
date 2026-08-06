import RE2 from "re2";
import type { AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CliTextResult, HerdrCli, JsonEnvelope } from "../cli.js";
import { loadSettings, type Settings } from "../settings.js";
import { parseSnapshotResult, resolveTarget, type CurrentContext, type ResolvedTarget } from "../targets.js";
import { createPiModelReviewer, ReviewerFailure, type ReviewerRequest, type ReviewerResult, type WaitReviewer } from "../reviewer.js";
import { validateWaitParams, WaitParamsSchema, type SafeRegex, type WaitCondition, type WaitParams } from "../wait-schema.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

export interface WaitClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error("Operation aborted"), { code: "ABORTED" }));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Operation aborted"), { code: "ABORTED" }));
    }, { once: true });
  })
};

export interface WaitCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
  runText(argv: string[], signal: AbortSignal): Promise<string>;
  runTextResult?(argv: string[], signal: AbortSignal): Promise<CliTextResult>;
}

export interface WaitTargetSnapshot {
  target: string;
  targetId: string;
  metadata: Record<string, unknown>;
  recentUnwrappedLines: string[];
  outputTruncated?: boolean;
  observedAtMs: number;
  matched: boolean;
}

export interface ReviewerSummary {
  target: string;
  targetId: string;
  classification: ReviewerResult["classification"];
  summary: string;
}

export interface WaitDetails {
  operation: "wait";
  outcome: "progress" | "success" | "timeout" | "manager_judgment_required";
  matched: boolean;
  reason?: "condition_met" | "timeout" | "manager_judgment_required";
  match: WaitParams["match"];
  condition: WaitCondition;
  targets: WaitTargetSnapshot[];
  reviewerSummaries?: ReviewerSummary[];
}

export class WaitError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "ABORTED" | "REVIEWER_FAILED" | "CLI_PROTOCOL_ERROR" | "CLI_TIMEOUT" | "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "TARGET_TYPE_MISMATCH" | "CONTEXT_UNAVAILABLE", message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "WaitError";
  }
}

export interface WaitDependencies {
  cli: WaitCli | HerdrCli;
  context: CurrentContext;
  settingsLoader?: () => Promise<Settings>;
  clock?: WaitClock;
  pollIntervalMs?: number;
  reviewerFactory?: (settings: Settings, context: ExtensionContext) => WaitReviewer;
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

function abort(): never {
  throw new WaitError("ABORTED", "ABORTED: wait was cancelled");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) abort();
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WaitError("CLI_PROTOCOL_ERROR", message);
  return value as Record<string, unknown>;
}

function paneFrom(result: unknown, expectedPaneId: string): Record<string, unknown> {
  const record = asRecord(result, "CLI_PROTOCOL_ERROR: pane response is invalid");
  const pane = asRecord(record.pane ?? record, "CLI_PROTOCOL_ERROR: pane response is invalid");
  if (typeof pane.pane_id !== "string" || pane.pane_id.length === 0 || pane.pane_id !== expectedPaneId) {
    throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: pane response is missing the requested pane");
  }
  return pane;
}

export function boundedLines(output: string): string[] {
  if (output.length === 0) return [];
  return output.split(/\r?\n/).slice(-100);
}

function rawState(metadata: Record<string, unknown>): string {
  const value = metadata.agent_status ?? metadata.status;
  return typeof value === "string" ? value : "unknown";
}

export function matchesState(state: string, requested: string): boolean {
  if (["idle", "working", "blocked", "done", "unknown"].includes(requested)) return state === requested;
  if (requested === "started") return state === "working";
  if (requested === "completed") return state === "idle" || state === "done";
  return requested === "needs_input" && state === "blocked";
}

export function matches(snapshot: WaitTargetSnapshot, condition: WaitCondition, regex?: SafeRegex): boolean {
  if (condition.kind === "state") return matchesState(rawState(snapshot.metadata), condition.state);
  const output = snapshot.recentUnwrappedLines.filter((line) => !(snapshot.outputTruncated && line === "[output truncated]")).join("\n");
  return condition.match.kind === "literal" ? output.includes(condition.match.value) : (regex ?? new RE2(condition.match.value)).test(output);
}

function samePrefix(previous: string[], current: string[]): number {
  let index = 0;
  while (index < previous.length && index < current.length && previous[index] === current[index]) index += 1;
  return index;
}

export function deltaLines(previous: string[], current: string[]): string[] {
  if (previous.length === 0) return current.slice(-100);
  if (current.length >= previous.length && previous.every((line, index) => current[index] === line)) return current.slice(previous.length, previous.length + 100);
  let overlap = Math.min(previous.length, current.length);
  while (overlap > 0) {
    const priorTail = previous.slice(previous.length - overlap);
    if (priorTail.every((line, index) => line === current[index])) return current.slice(overlap, overlap + 100);
    overlap -= 1;
  }
  const prefix = samePrefix(previous, current);
  if (prefix === current.length) return [];
  return current.slice(Math.max(prefix, current.length - 100), current.length);
}

const COMPACT_METADATA_KEYS = ["pane_id", "tab_id", "workspace_id", "label", "agent_name", "agent", "agent_status", "status", "cwd", "revision"] as const;
export function compactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(COMPACT_METADATA_KEYS.filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]));
}

function emitUpdate(onUpdate: AgentToolUpdateCallback<WaitDetails> | undefined, details: WaitDetails, text: string): void {
  onUpdate?.({ content: [{ type: "text", text }], details });
}

async function readTarget(cli: WaitCli, resolved: ResolvedTarget, ref: string, clock: WaitClock, signal: AbortSignal): Promise<WaitTargetSnapshot> {
  checkAbort(signal);
  try {
    const pane = paneFrom((await cli.runJson(["pane", "get", resolved.paneId!], signal)).result, resolved.paneId!);
    const readArgs = ["pane", "read", "--source", "recent-unwrapped", "--lines", "100", "--format", "text", resolved.paneId!];
    const output = cli.runTextResult ? await cli.runTextResult(readArgs, signal) : { value: await cli.runText(readArgs, signal), truncated: false };
    checkAbort(signal);
    return { target: ref, targetId: resolved.paneId!, metadata: pane, recentUnwrappedLines: boundedLines(output.value), outputTruncated: output.truncated, observedAtMs: clock.now(), matched: false };
  } catch (error) {
    if (signal.aborted || errorCode(error) === "ABORTED") abort();
    if (error instanceof WaitError) throw error;
    throw new WaitError((errorCode(error) as WaitError["code"] | undefined) ?? "CLI_PROTOCOL_ERROR", `Unable to read target ${ref}`, { target: ref, targetId: resolved.paneId, cause: error instanceof Error ? error.message : String(error) });
  }
}

async function readAll(cli: WaitCli, resolved: ReadonlyArray<{ ref: string; target: ResolvedTarget }>, clock: WaitClock, signal: AbortSignal): Promise<WaitTargetSnapshot[]> {
  checkAbort(signal);
  const values = await Promise.all(resolved.map((item) => readTarget(cli, item.target, item.ref, clock, signal)));
  checkAbort(signal);
  return values;
}

async function readAndMatch(cli: WaitCli, resolved: ReadonlyArray<{ ref: string; target: ResolvedTarget }>, clock: WaitClock, signal: AbortSignal, deadline: number, condition: WaitCondition, regex?: SafeRegex): Promise<{ snapshots: WaitTargetSnapshot[]; expired: boolean }> {
  const snapshots = await readAll(cli, resolved, clock, signal);
  if (expired(clock, deadline, snapshots)) return { snapshots, expired: true };
  snapshots.forEach((snapshot) => { snapshot.matched = matches(snapshot, condition, regex); });
  return { snapshots, expired: expired(clock, deadline, snapshots) };
}

function resultDetails(params: WaitParams, snapshots: WaitTargetSnapshot[], outcome: WaitDetails["outcome"], reason: WaitDetails["reason"], reviewerSummaries?: ReviewerSummary[]): WaitDetails {
  return { operation: "wait", outcome, matched: outcome === "success", reason, match: params.match, condition: params.condition, targets: snapshots, ...(reviewerSummaries && reviewerSummaries.length > 0 ? { reviewerSummaries } : {}) };
}

function aggregate(params: WaitParams, snapshots: WaitTargetSnapshot[]): boolean {
  const count = snapshots.filter((snapshot) => snapshot.matched).length;
  return params.match === "any" ? count > 0 : count === snapshots.length;
}

function expired(clock: WaitClock, deadline: number, snapshots: WaitTargetSnapshot[]): boolean {
  if (clock.now() < deadline) return false;
  snapshots.forEach((snapshot) => { snapshot.matched = false; });
  return true;
}

function timeoutResult(params: WaitParams, snapshots: WaitTargetSnapshot[], reviewerSummaries?: ReviewerSummary[]) {
  const details = resultDetails(params, snapshots, "timeout", "timeout", reviewerSummaries);
  return { content: [{ type: "text" as const, text: formatResult({ operation: "wait", outcome: "timeout" }) }], details };
}

function successResult(params: WaitParams, snapshots: WaitTargetSnapshot[], reviewerSummaries?: ReviewerSummary[]) {
  const details = resultDetails(params, snapshots, "success", "condition_met", reviewerSummaries);
  return { content: [{ type: "text" as const, text: formatResult({ operation: "wait", outcome: "success", targetId: snapshots.find((snapshot) => snapshot.matched)?.targetId }) }], details };
}

function timeoutIfExpired(params: WaitParams, read: { snapshots: WaitTargetSnapshot[]; expired: boolean }, reviewerSummaries?: ReviewerSummary[]) {
  return read.expired ? timeoutResult(params, read.snapshots, reviewerSummaries) : undefined;
}

export function mapReviewerFailure(error: unknown): WaitError {
  if (error instanceof WaitError) return error;
  if (error instanceof ReviewerFailure) return new WaitError("REVIEWER_FAILED", `REVIEWER_FAILED: ${error.message}`, error.details);
  return new WaitError("REVIEWER_FAILED", "REVIEWER_FAILED: reviewer call failed", { cause: error instanceof Error ? error.message : String(error) });
}

export function createWaitTool(deps: WaitDependencies): ToolDefinition<typeof WaitParamsSchema, WaitDetails> {
  const clock = deps.clock ?? realClock;
  const settingsLoader = deps.settingsLoader ?? (() => loadSettings());
  return {
    name: "herdr_wait",
    label: "Herdr Wait",
    description: "Wait for exact Herdr targets to satisfy an authoritative state or output condition.",
    parameters: WaitParamsSchema,
    async execute(_id, rawParams, signal, onUpdate, context) {
      const activeSignal = signal ?? new AbortController().signal;
      checkAbort(activeSignal);
      let validation;
      try {
        validation = validateWaitParams(rawParams);
      } catch (error) {
        throw new WaitError("INVALID_INPUT", String(error));
      }
      const params = validation.params;
      let settings: Settings;
      try {
        settings = await settingsLoader();
      } catch (error) {
        if (error instanceof Error && errorCode(error) === "INVALID_SETTINGS") throw error;
        throw new WaitError("INVALID_INPUT", "INVALID_SETTINGS: extension-owned wait settings are invalid", { cause: error instanceof Error ? error.message : String(error) });
      }
      checkAbort(activeSignal);
      const initial = parseSnapshotResult((await deps.cli.runJson(["api", "snapshot"], activeSignal)).result);
      const resolved = params.targets.map((ref) => ({ ref, target: resolveTarget(initial, ref, "agent", deps.context) }));
      const ids = new Set<string>();
      for (const item of resolved) {
        if (ids.has(item.target.id)) throw new WaitError("INVALID_INPUT", "INVALID_INPUT: target references resolve to the same resource", { targetId: item.target.id });
        ids.add(item.target.id);
      }
      const start = clock.now();
      const deadline = start + params.timeoutMs;
      const cadenceMs = settings.reviewCadenceMinutes * 60_000;
      const longWait = params.timeoutMs > cadenceMs;
      let read = await readAndMatch(deps.cli, resolved, clock, activeSignal, deadline, params.condition, validation.regex);
      let snapshots = read.snapshots;
      const initialTimeout = timeoutIfExpired(params, read);
      if (initialTimeout) return initialTimeout;
      if (aggregate(params, snapshots)) return successResult(params, snapshots);
      let reviewer: WaitReviewer | undefined;
      if (longWait) {
        try {
          reviewer = deps.reviewerFactory ? deps.reviewerFactory(settings, context) : createPiModelReviewer(context, settings.reviewerModel);
        } catch (error) {
          throw mapReviewerFailure(error);
        }
      }
      const reviewerSummaries: ReviewerSummary[] = [];
      const sentLines = new Map<string, string[]>();
      let nextReview = start + cadenceMs;
      let lastStates = snapshots.map((snapshot) => rawState(snapshot.metadata));
      const progress = (text: string, outcome: WaitDetails["outcome"] = "progress") => emitUpdate(onUpdate, resultDetails(params, snapshots, outcome, undefined, reviewerSummaries), text.slice(0, 500));
      progress("waiting");

      while (true) {
        checkAbort(activeSignal);
        if (aggregate(params, snapshots)) {
          const details = resultDetails(params, snapshots, "success", "condition_met", reviewerSummaries);
          return { content: [{ type: "text", text: formatResult({ operation: "wait", outcome: "success", targetId: snapshots.find((snapshot) => snapshot.matched)?.targetId }) }], details };
        }
        const now = clock.now();
        if (expired(clock, deadline, snapshots)) return timeoutResult(params, snapshots, reviewerSummaries);
        const untilReview = longWait ? Math.max(0, nextReview - now) : Number.MAX_SAFE_INTEGER;
        await clock.sleep(Math.min(deps.pollIntervalMs ?? 250, deadline - now, untilReview), activeSignal);
        checkAbort(activeSignal);
        if (expired(clock, deadline, snapshots)) return timeoutResult(params, snapshots, reviewerSummaries);
        read = await readAndMatch(deps.cli, resolved, clock, activeSignal, deadline, params.condition, validation.regex);
        snapshots = read.snapshots;
        const pollTimeout = timeoutIfExpired(params, read, reviewerSummaries);
        if (pollTimeout) return pollTimeout;
        const newStates = snapshots.map((snapshot) => rawState(snapshot.metadata));
        if (newStates.some((state, index) => state !== lastStates[index])) {
          progress(`state changed: ${newStates.join(", ")}`);
          lastStates = newStates;
        }
        if (aggregate(params, snapshots)) continue;
        if (!longWait || clock.now() < nextReview) continue;
        nextReview += cadenceMs;
        const requests: ReviewerRequest[] = snapshots.map((snapshot) => {
          const previous = sentLines.get(snapshot.targetId) ?? [];
          const delta = deltaLines(previous, snapshot.recentUnwrappedLines);
          sentLines.set(snapshot.targetId, snapshot.recentUnwrappedLines.slice(-100));
          return { targetId: snapshot.targetId, metadata: compactMetadata(snapshot.metadata), transcriptDelta: delta.slice(-100) };
        });
        let reviews: ReviewerResult[];
        try {
          reviews = await Promise.all(requests.map((request) => reviewer!.review(request, activeSignal)));
          checkAbort(activeSignal);
        } catch (error) {
          if (activeSignal.aborted || errorCode(error) === "ABORTED") abort();
          throw mapReviewerFailure(error);
        }
        let managerJudgment = false;
        for (const review of reviews) {
          const summary: ReviewerSummary = { target: resolved.find((item) => item.target.paneId === review.targetId)?.ref ?? review.targetId, targetId: review.targetId, classification: review.classification, summary: review.summary.slice(0, 500) };
          reviewerSummaries.push(summary);
          const terminal = review.classification === "stalled" || review.classification === "blocked" || review.classification === "risk" || review.classification === "unknown";
          managerJudgment ||= terminal;
          progress(`review ${review.targetId}: ${review.classification} ${review.summary}`, terminal ? "manager_judgment_required" : "progress");
        }
        if (managerJudgment) {
          if (expired(clock, deadline, snapshots)) return timeoutResult(params, snapshots, reviewerSummaries);
          read = await readAndMatch(deps.cli, resolved, clock, activeSignal, deadline, params.condition, validation.regex);
          snapshots = read.snapshots;
          const refreshTimeout = timeoutIfExpired(params, read, reviewerSummaries);
          if (refreshTimeout) return refreshTimeout;
          if (aggregate(params, snapshots)) return successResult(params, snapshots, reviewerSummaries);
          const details = resultDetails(params, snapshots, "manager_judgment_required", "manager_judgment_required", reviewerSummaries);
          return { content: [{ type: "text", text: formatResult({ operation: "wait", outcome: "error", code: "MANAGER_JUDGMENT_REQUIRED" }) }], details };
        }
      }
    },
    renderCall(rawArgs, theme) {
      const args = rawArgs as WaitParams;
      return textComponent(formatCall("herdr_wait", `${args.match ?? "wait"}`, args.targets?.join(",")), theme, "accent");
    },
    renderResult(result, options, theme) {
      return renderResultComponent("wait", result, options, theme);
    }
  };
}
