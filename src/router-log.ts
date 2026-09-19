/**
 * The ADR-032 local decision log: exactly one fixed-schema JSONL record per
 * Router outcome at `<root>/.herdr/router/decisions.jsonl`, where `root` is the
 * trusted manager/session project directory — never a caller-controlled child
 * `cwd`.
 *
 * Persistence is allowlisted before `modelSafeJson` ever runs: the line is
 * built from typed fields — caller name, the SHA-256 digest of the exact
 * RouterState JSON handed to Jev, validated numeric probability evidence
 * scoped to the sent question/option keys, and the Assignment or Abstain
 * outcome — so no objective/scope/verification text, profile body or
 * description, source path, tools, environment, key, request/response text,
 * or exception message can reach the file. When the state could not be
 * constructed the record carries an explicit unavailable marker with the typed
 * catalog reason instead of a digest of unsent state.
 *
 * Appends serialize on the existing flock holder (`decisions.lock`) inside one
 * short exclusive section; the lock is never held across inference or launch.
 * Every failure — untrusted input, unsafe or symlink targets, lock
 * acquisition, or write errors — surfaces as `ROUTER_LOG_UNAVAILABLE` with no
 * claim of persistence. There is no retry, repair, rotation, or fsync/WAL
 * durability promise, and existing records are never truncated.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isAgentName } from "./agent-identity.js";
import { acquireFlockHolder, assertOwnerOnlyDirectory } from "./pane-write-lock.js";
import { modelSafeJson } from "./redaction.js";
import { groupByRole, roleForProfile, type Abstain, type Assignment, type RouterResult, type RouterState } from "./router.js";
import type { RouteOutcome, RouterProbabilities, RouterQuestionEvidence } from "./typesafe-router.js";

export class RouterLogError extends Error {
  readonly code = "ROUTER_LOG_UNAVAILABLE";

  constructor(message = "Router decision log is unavailable") {
    super(message);
    this.name = "RouterLogError";
  }
}

const routerLogFailure = (message: string): RouterLogError => new RouterLogError(message);

/** Bound on flock's own contention wait for one append section. */
export const ROUTER_LOG_LOCK_WAIT_MS = 5_000;
const ROUTER_LOG_READY = "HERDR_ROUTER_LOG_LOCK_READY";
const SCORE_OPTION_KEYS = ["0", "1", "2", "3", "4"];
const PROBABILITY_SUM_TOLERANCE = 1e-6;
const ABSTAIN_REASONS = new Set<Abstain["reason"]>([
  "low_confidence",
  "no_assignments",
  "catalog_unavailable",
  "invalid_response",
  "authentication_unavailable",
  "transport_failed",
  "aborted"
]);
/** Component tokens that name pipeline stages rather than questions. */
const BOUNDED_COMPONENTS = new Set(["catalog", "api_key", "response", "transport"]);
const HTTP_COMPONENT = /^http_\d{1,3}$/;

/** Marker supplied instead of a RouterState when the catalog could not be projected. */
export interface UnavailableRouterState {
  status: "unavailable";
  reason: "catalog_unavailable";
}

/** One Router outcome plus the caller context the record requires. */
export interface RouterLogEntry extends RouteOutcome {
  name: string;
  state: RouterState | UnavailableRouterState;
}

/** The fixed record schema appended as one JSONL line. */
export interface RouterLogRecord {
  timestamp: string;
  name: string;
  stateDigest: string | null;
  stateUnavailable: { reason: "catalog_unavailable" } | null;
  probabilities: RouterProbabilities;
  result: RouterResult;
}

export interface AppendRouterLogOptions {
  /** Trusted manager/session project root — never a caller-controlled child cwd. */
  root: string;
  /** Clock seam for deterministic timestamps; defaults to `new Date()`. */
  now?: () => Date;
  /** Bound on flock's own contention wait (default {@link ROUTER_LOG_LOCK_WAIT_MS}). */
  waitMs?: number;
  /** Bound on the holder's ready marker; defaults to waitMs plus spawn margin. */
  deadlineMs?: number;
}

export interface RouterLogPaths {
  directory: string;
  decisions: string;
  lock: string;
}

/** The log paths under one trusted project root; artifacts stay under `.herdr/router/`. */
export function routerLogPaths(root: string): RouterLogPaths {
  const directory = join(root, ".herdr", "router");
  return { directory, decisions: join(directory, "decisions.jsonl"), lock: join(directory, "decisions.lock") };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function uid(): number {
  const value = process.getuid?.();
  /* c8 ignore next -- flock only exists on platforms that provide getuid. */
  if (value === undefined) throw routerLogFailure("Router decision log owner is unavailable");
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * The exact allowlisted state bytes handed to Jev — the same projection the
 * router's wire body uses, so the digest covers only what the model saw and
 * stray fields on the input cannot alter it.
 */
function stateForJev(state: RouterState): unknown {
  return {
    assignment: {
      objective: state.assignment.objective,
      scope: state.assignment.scope,
      verification: state.assignment.verification
    },
    catalog: state.catalog.map(({ name, description, runner, model, timeout }) => ({ name, description, runner, model, timeout }))
  };
}

/** SHA-256 hex of the exact deterministic RouterState JSON supplied to Jev. */
export function routerStateDigest(state: RouterState): string {
  return createHash("sha256").update(JSON.stringify(stateForJev(state))).digest("hex");
}

function isUnavailableMarker(state: RouterState | UnavailableRouterState): state is UnavailableRouterState {
  return record(state) && state.status === "unavailable" && state.reason === "catalog_unavailable" && !("assignment" in state) && !("catalog" in state);
}

/** Structural check for the fields the record itself derives from; the rest only feeds the digest. */
function validateRouterState(state: RouterState): void {
  if (!record(state) || !record(state.assignment) || !Array.isArray(state.catalog)) {
    throw routerLogFailure("Router decision state is malformed");
  }
  for (const entry of state.catalog) {
    if (!record(entry) || typeof entry.name !== "string") throw routerLogFailure("Router decision state is malformed");
  }
}

interface QuestionSpec {
  type: RouterQuestionEvidence["type"];
  /** Exact option-key set for a distribution answer; empty for Noul. */
  options: readonly string[];
}

/** The question ids and option keys derivable from the sent state; nothing else may be evidenced. */
function expectedQuestions(state: RouterState): Map<string, QuestionSpec> {
  const expected = new Map<string, QuestionSpec>();
  for (const [role, entries] of groupByRole(state.catalog)) {
    expected.set(`${role}_useful`, { type: "noul", options: [] });
    expected.set(`${role}_count`, { type: "score", options: SCORE_OPTION_KEYS });
    expected.set(`${role}_profile`, { type: "choice", options: entries.map((entry) => entry.name) });
  }
  return expected;
}

/** Exact-key probability map: every sent key present once, each in [0,1], summing to one. */
function distribution(value: unknown, keys: readonly string[]): Record<string, number> | undefined {
  if (!record(value) || Object.keys(value).length !== keys.length) return undefined;
  const parsed: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const entry = value[key];
    if (!Object.prototype.hasOwnProperty.call(value, key) || !probability(entry)) return undefined;
    parsed[key] = entry;
    sum += entry;
  }
  return Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE ? parsed : undefined;
}

/** Rebuild one evidence entry from allowlisted numeric fields; anything else refuses the append. */
function evidence(value: unknown, spec: QuestionSpec): RouterQuestionEvidence {
  if (!record(value) || value.type !== spec.type) throw routerLogFailure("Router decision evidence is untrusted");
  if (spec.type === "noul") {
    if (!probability(value.noul)) throw routerLogFailure("Router decision evidence is untrusted");
    return { type: "noul", noul: value.noul };
  }
  if (spec.type === "score") {
    if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > SCORE_OPTION_KEYS.length - 1 || !probability(value.confidence)) {
      throw routerLogFailure("Router decision evidence is untrusted");
    }
    const probabilities = distribution(value.probabilities, SCORE_OPTION_KEYS);
    if (probabilities === undefined) throw routerLogFailure("Router decision evidence is untrusted");
    return { type: "score", score: value.score, confidence: value.confidence, probabilities };
  }
  if (typeof value.choice !== "string" || !spec.options.includes(value.choice) || !probability(value.confidence)) {
    throw routerLogFailure("Router decision evidence is untrusted");
  }
  const probabilities = distribution(value.probabilities, spec.options);
  if (probabilities === undefined) throw routerLogFailure("Router decision evidence is untrusted");
  return { type: "choice", choice: value.choice, confidence: value.confidence, probabilities };
}

/**
 * Evidence is scoped to the questions derivable from the sent state: a foreign
 * id — or any id at all when no state exists — means the input does not belong
 * to this decision and is refused rather than filtered.
 */
function projectProbabilities(input: RouterProbabilities, expected: ReadonlyMap<string, QuestionSpec> | null): RouterProbabilities {
  if (!record(input)) throw routerLogFailure("Router decision evidence is untrusted");
  const out: RouterProbabilities = {};
  for (const qid of Object.keys(input).sort()) {
    const spec = expected?.get(qid);
    if (spec === undefined) throw routerLogFailure("Router decision evidence is untrusted");
    out[qid] = evidence(input[qid], spec);
  }
  return out;
}

function projectAssignment(value: unknown, catalog: ReadonlySet<string>): Assignment {
  if (!record(value) || typeof value.profile !== "string" || !catalog.has(value.profile)) {
    throw routerLogFailure("Router decision assignment is untrusted");
  }
  if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 1 || value.count > SCORE_OPTION_KEYS.length) {
    throw routerLogFailure("Router decision assignment is untrusted");
  }
  // Purpose is deterministic role/template text; a mismatch means the input is
  // not a policy-produced RouteDecision and is refused, never persisted.
  const purpose = `Perform the ${roleForProfile(value.profile)} role for the supplied objective.`;
  if (value.purpose !== purpose) throw routerLogFailure("Router decision assignment is untrusted");
  return { profile: value.profile, count: value.count, purpose };
}

/** Abstain components are question ids or bounded stage/status tokens, never arbitrary text. */
function safeComponent(component: unknown, expected: ReadonlyMap<string, QuestionSpec> | null): component is string {
  if (typeof component !== "string") return false;
  return BOUNDED_COMPONENTS.has(component) || HTTP_COMPONENT.test(component) || expected?.has(component) === true;
}

function projectResult(result: RouterResult, catalog: ReadonlySet<string> | null, expected: ReadonlyMap<string, QuestionSpec> | null): RouterResult {
  if (!record(result)) throw routerLogFailure("Router decision result is malformed");
  if (result.kind === "route") {
    if (catalog === null || !Array.isArray(result.assignments) || result.assignments.length === 0) {
      throw routerLogFailure("Router decision result is malformed");
    }
    return { kind: "route", assignments: result.assignments.map((assignment) => projectAssignment(assignment, catalog)) };
  }
  if (result.kind !== "abstain" || !ABSTAIN_REASONS.has(result.reason)) throw routerLogFailure("Router decision result is malformed");
  if (result.component !== undefined && !safeComponent(result.component, expected)) throw routerLogFailure("Router decision result is malformed");
  return result.component === undefined
    ? { kind: "abstain", reason: result.reason }
    : { kind: "abstain", reason: result.reason, component: result.component };
}

/** Build the persisted record or refuse the append; nothing is written on rejection. */
function buildRecord(entry: RouterLogEntry, now: () => Date): RouterLogRecord {
  if (!record(entry) || !isAgentName(entry.name)) throw routerLogFailure("Router decision caller name is untrusted");
  let stateDigest: string | null = null;
  let stateUnavailable: RouterLogRecord["stateUnavailable"] = null;
  let expected: Map<string, QuestionSpec> | null = null;
  let catalog: Set<string> | null = null;
  if (isUnavailableMarker(entry.state)) {
    stateUnavailable = { reason: "catalog_unavailable" };
  } else {
    validateRouterState(entry.state);
    stateDigest = routerStateDigest(entry.state);
    expected = expectedQuestions(entry.state);
    catalog = new Set(entry.state.catalog.map((item) => item.name));
  }
  return {
    timestamp: now().toISOString(),
    name: entry.name,
    stateDigest,
    stateUnavailable,
    probabilities: projectProbabilities(entry.probabilities, expected),
    result: projectResult(entry.result, catalog, expected)
  };
}

/** The `.herdr` and `router` directories are created owner-only and then proven trusted. */
async function ensureLogDirectory(directory: string): Promise<void> {
  for (const path of [dirname(directory), directory]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw routerLogFailure("Router decision log directory is unavailable");
    }
    let value;
    try {
      value = await lstat(path);
    } catch {
      throw routerLogFailure("Router decision log directory is unavailable");
    }
    assertOwnerOnlyDirectory(path, value, routerLogFailure, "Router decision log");
  }
}

/**
 * One bounded append: the target is lstat-rejected when unsafe or symlinked,
 * opened with `O_APPEND | O_NOFOLLOW` and `0600` on creation, then the opened
 * description itself is proven a regular owner-only file before the single
 * whole-line append. A failed write is surfaced; a partial trailing line is
 * never repaired by truncating another writer's data.
 */
async function appendLine(path: string, line: string): Promise<void> {
  let value;
  try {
    value = await lstat(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw routerLogFailure("Router decision log file is indeterminate");
  }
  if (value !== undefined && (!value.isFile() || value.isSymbolicLink() || value.uid !== uid() || (Number(value.mode) & 0o22) !== 0)) {
    throw routerLogFailure("Router decision log file is not trusted");
  }
  /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
  const flags = constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path, flags, 0o600);
  } catch {
    throw routerLogFailure("Router decision log file is unavailable");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== uid() || (Number(opened.mode) & 0o22) !== 0) {
      throw routerLogFailure("Router decision log file is not trusted");
    }
    await handle.appendFile(line);
  } finally {
    // A failed close cannot unwrite what the append already did; the section
    // promises no fsync, so close errors settle quietly like release errors.
    await handle.close().catch(() => undefined);
  }
}

/**
 * Append exactly one record for one Router outcome. Validation happens before
 * the lock section; the flock is held only for the append itself. Any failure
 * throws `RouterLogError` (`ROUTER_LOG_UNAVAILABLE`) and claims no persistence.
 */
export async function appendRouterDecision(entry: RouterLogEntry, options: AppendRouterLogOptions): Promise<void> {
  try {
    if (!isAbsolute(options.root)) throw routerLogFailure("Router decision log root is untrusted");
    const line = `${JSON.stringify(modelSafeJson(buildRecord(entry, options.now ?? (() => new Date()))))}\n`;
    const paths = routerLogPaths(options.root);
    await ensureLogDirectory(paths.directory);
    const holder = await acquireFlockHolder({
      lockPath: paths.lock,
      wait: { timeoutMs: options.waitMs ?? ROUTER_LOG_LOCK_WAIT_MS },
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      readyMarker: ROUTER_LOG_READY,
      subject: "Router decision log",
      failure: routerLogFailure
    });
    try {
      await appendLine(paths.decisions, line);
    } finally {
      // A failed release cannot recall what the section already did, so the
      // lease settles quietly; the kernel frees the flock when the holder dies.
      await holder.release().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof RouterLogError) throw error;
    throw new RouterLogError();
  }
}
