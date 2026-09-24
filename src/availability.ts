/**
 * The ADR-035 B2 reactive availability floor: one classified launch failure
 * per fixed-schema JSONL line at `<root>/.herdr/availability/cooldowns.jsonl`,
 * where `root` is the trusted manager/session project directory — never a
 * caller-controlled child `cwd`.
 *
 * Classification runs on typed failure codes only — the surfaced module code
 * plus the wrapped cause code (e.g. the backend `cli:agent:start` envelope
 * code carried on `details.causeCode` at agent_start) — never on message
 * text: provider prose can hide auth, config, or correctness failures behind
 * quota-sounding wording (ADR-006). Six classes — quota / auth /
 * unsupported-config / permission-prompt / transport / task-failure — and
 * only `quota` cools a key down. An unrecognized code classifies
 * `task-failure`: unknown evidence is never quota evidence, so no cooldown is
 * ever invented from an unfamiliar string. `ATTACHMENT_QUOTA_EXCEEDED` is the
 * local attachment store's bound, not a provider account, and never cools a
 * key down either.
 *
 * Cooldowns key on provider + billingProduct + account + scope via the B1
 * `quotaKeyFor` derivation — the runner name is never part of the key, so two
 * candidates sharing an account share the cooldown. A quota record excludes
 * the key until the source's own reset signal (`retryNotBefore`), or — when
 * the source gave none — for the fallback quarantine window; the reported
 * `retryNotBefore` is a future source signal or `null`, never a fabricated
 * ETA. Non-quota records are evidence only: a recent transport failure marks
 * the key `local-capacity-limited` (the local launch channel — CLI, socket,
 * read path — is the limit, not the provider), any other recent failure marks
 * it `degraded`, and no evidence is `unknown` — never treated as exhausted.
 *
 * Persistence reuses the router-log discipline exactly: allowlisted typed
 * fields before `modelSafeJson` (no message text, stderr, or envelope bodies
 * can reach the file), one whole-line append inside a short exclusive
 * `acquireFlockHolder` section, owner-only directories, and a 0600 append-only
 * file proven before each append. Reads are lock-free — whole-line O_APPEND
 * writes keep a snapshot coherent; a torn or foreign line counts as malformed
 * evidence, never exhaustion. Append failures throw
 * `AVAILABILITY_LOG_UNAVAILABLE` with no claim of persistence; an unreadable
 * or untrusted record file degrades answers to `unknown` — the floor is
 * admission evidence, not a launch precondition.
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { quotaKeyFor, type AvailabilitySubject, type QuotaKey, type RunnerEntry } from "./catalog.js";
import { acquireFlockHolder, assertOwnerOnlyDirectory } from "./pane-write-lock.js";
import { modelSafeJson } from "./redaction.js";

export class AvailabilityLogError extends Error {
  readonly code = "AVAILABILITY_LOG_UNAVAILABLE";

  constructor(message = "Availability cooldown record is unavailable") {
    super(message);
    this.name = "AvailabilityLogError";
  }
}

const availabilityFailure = (message: string): AvailabilityLogError => new AvailabilityLogError(message);

/** Bound on flock's own contention wait for one append section. */
export const AVAILABILITY_LOCK_WAIT_MS = 5_000;
const AVAILABILITY_LOG_READY = "HERDR_AVAILABILITY_LOCK_READY";
/**
 * Quarantine applied to a quota-class failure whose source gave no reset
 * signal — a policy bound on how soon the key is re-probed, never a claimed
 * provider ETA, and never surfaced as `retryNotBefore`.
 */
export const DEFAULT_QUOTA_COOLDOWN_MS = 15 * 60_000;
/** How long a classified failure remains availability evidence for degraded / local-capacity-limited. */
export const AVAILABILITY_EVIDENCE_WINDOW_MS = 15 * 60_000;

export const LAUNCH_FAILURE_CLASSES = [
  "quota",
  "auth",
  "unsupported-config",
  "permission-prompt",
  "transport",
  "task-failure"
] as const;
export type LaunchFailureClass = (typeof LAUNCH_FAILURE_CLASSES)[number];

export const AVAILABILITY_STATUSES = ["known-exhausted", "degraded", "unknown", "local-capacity-limited"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

const FAILURE_CLASSES: ReadonlySet<string> = new Set(LAUNCH_FAILURE_CLASSES);
/** Module codes are UPPER_SNAKE; backend envelope codes are lower_snake — both are bounded identifiers. */
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const KEY_FIELD_MAX_BYTES = 240;

/**
 * Typed launch-boundary codes mapped to the six ADR-035 classes. UPPER_SNAKE
 * entries are module codes surfaced by the launch path and its collaborators;
 * lower_snake entries are backend/provider envelope codes carried on
 * `causeCode`. Only unambiguous provider quota vocabulary maps to `quota`;
 * anything absent here classifies `task-failure` by default.
 */
const FAILURE_CLASS_BY_CODE: Readonly<Record<string, LaunchFailureClass>> = {
  // quota — provider quota, rate-limit, or capacity exhaustion.
  quota_exceeded: "quota",
  quota_exhausted: "quota",
  insufficient_quota: "quota",
  account_quota_exceeded: "quota",
  billing_exhausted: "quota",
  credits_exhausted: "quota",
  rate_limit: "quota",
  rate_limited: "quota",
  rate_limit_exceeded: "quota",
  too_many_requests: "quota",
  resource_exhausted: "quota",
  overloaded: "quota",
  capacity_exceeded: "quota",
  capacity_exhausted: "quota",
  // auth — credential or authorization failures for the account.
  unauthorized: "auth",
  unauthenticated: "auth",
  forbidden: "auth",
  denied: "auth",
  auth_failed: "auth",
  authentication_failed: "auth",
  authentication_required: "auth",
  invalid_credentials: "auth",
  invalid_api_key: "auth",
  credentials_expired: "auth",
  token_expired: "auth",
  login_required: "auth",
  permission_denied: "auth",
  access_denied: "auth",
  account_disabled: "auth",
  // unsupported-config — the requested configuration or capability is unsupported.
  unsupported_config: "unsupported-config",
  invalid_config: "unsupported-config",
  config_not_supported: "unsupported-config",
  unsupported_model: "unsupported-config",
  model_not_found: "unsupported-config",
  unknown_model: "unsupported-config",
  unsupported_capability: "unsupported-config",
  capability_unsupported: "unsupported-config",
  unsupported_operation: "unsupported-config",
  ATTACHMENT_TARGET_UNVERIFIED: "unsupported-config",
  HANDOFF_TARGET_UNVERIFIED: "unsupported-config",
  INVALID_PROFILE: "unsupported-config",
  INVALID_PROFILE_OVERRIDE: "unsupported-config",
  INVALID_CATALOG: "unsupported-config",
  CHAIN_UNRESOLVABLE: "unsupported-config",
  PROFILE_RESOLUTION_INVALID: "unsupported-config",
  PROFILE_SKILL_PATH_ESCAPES_SCOPE: "unsupported-config",
  PROFILE_SKILL_TREE_UNSAFE: "unsupported-config",
  PROFILE_SKILL_SOURCE_NOT_APPROVED: "unsupported-config",
  PROFILE_SKILL_BUNDLE_STALE: "unsupported-config",
  PROFILE_SKILL_BUNDLE_REGISTRY_INVALID: "unsupported-config",
  // permission-prompt — the runner stopped on an interactive permission gate.
  permission_prompt: "permission-prompt",
  permission_required: "permission-prompt",
  interactive_permission_required: "permission-prompt",
  approval_required: "permission-prompt",
  approval_needed: "permission-prompt",
  consent_required: "permission-prompt",
  user_consent_required: "permission-prompt",
  // transport — the local channel failed to carry or prove the launch.
  CLI_NOT_FOUND: "transport",
  CLI_INCOMPATIBLE: "transport",
  CLI_PROTOCOL_ERROR: "transport",
  CLI_TIMEOUT: "transport",
  CLI_OUTPUT_OVERFLOW: "transport",
  BACKEND_UNAVAILABLE: "transport",
  READ_FAILED: "transport",
  READ_MALFORMED: "transport",
  READ_TIMEOUT: "transport",
  POSTSTATE_UNAVAILABLE: "transport",
  POSTSTATE_IDENTITY_UNAVAILABLE: "transport",
  TARGET_IDENTITY_UNAVAILABLE: "transport",
  PROMPT_DISPATCH_UNKNOWN: "transport",
  PROFILE_CATALOG_UNAVAILABLE: "transport",
  PROFILE_LAUNCH_FROZEN: "transport",
  ROUTER_LOG_UNAVAILABLE: "transport",
  REVIEW_LOG_UNAVAILABLE: "transport",
  AVAILABILITY_LOG_UNAVAILABLE: "transport",
  SUPERVISION_UNAVAILABLE: "transport",
  SUPERVISION_SOCKET_UNAVAILABLE: "transport",
  SUPERVISION_SOCKET_CLOSED: "transport",
  SUPERVISION_REQUEST_TIMEOUT: "transport",
  PANE_WRITE_LOCK_UNAVAILABLE: "transport",
  PROJECT_SCOPE_DISCOVERY_ERROR: "transport",
  agent_start_transport_failed: "transport",
  transport_failed: "transport",
  connection_failed: "transport",
  connect_failed: "transport",
  connection_refused: "transport",
  network_error: "transport",
  network_unreachable: "transport",
  timeout: "transport",
  timed_out: "transport",
  unavailable: "transport",
  deadline_exceeded: "transport",
  // task-failure — a definitive attempt failure or an unrecognized cause.
  ABORTED: "task-failure",
  INVALID_INPUT: "task-failure",
  LAUNCH_FAILED: "task-failure",
  READY_TIMEOUT: "task-failure",
  PROMPT_UNCONFIRMED: "task-failure",
  SUPERVISION_UNCONFIRMED: "task-failure",
  POSTSTATE_IDENTITY_CHANGED: "task-failure",
  POSTSTATE_CONTRADICTORY: "task-failure",
  TARGET_IDENTITY_CHANGED: "task-failure",
  TARGET_BLOCKED: "task-failure",
  AGENT_NAME_TAKEN: "task-failure",
  ADOPT_TARGET_UNQUALIFIED: "task-failure",
  ATTACHMENT_QUOTA_EXCEEDED: "task-failure",
  ATTACHMENT_STORE_FAILED: "task-failure",
  PAYLOAD_TOO_LARGE: "task-failure",
  PAYLOAD_TOO_LARGE_FOR_INLINE: "task-failure",
  BATCH_NAME_COLLISION: "task-failure",
  BATCH_CHILD_NAME_INVALID: "task-failure",
  BATCH_PLACEMENT_INVALID: "task-failure",
  BATCH_ROUTE_EMPTY: "task-failure",
  agent_start_failed: "task-failure",
  agent_pane_busy: "task-failure",
  agent_name_taken: "task-failure",
  agent_not_found: "task-failure",
  agent_blocked: "task-failure",
  agent_prompt_stalled: "task-failure",
  tab_create_failed: "task-failure"
};

/**
 * The failure evidence a caller attributes to a candidate: the surfaced launch
 * code, the wrapped cause code when one is carried (the backend
 * `cli:agent:start` envelope code at agent_start, otherwise the originating
 * module code), and the source's own reset signal when it gave one.
 */
export interface LaunchFailureSignal {
  code: string;
  causeCode?: string;
  /** The source-supplied reset instant — ISO string, epoch ms, or Date; null/absent means the source gave none. */
  retryNotBefore?: string | number | Date | null;
}

/** The fixed record schema appended as one JSONL line; every field is validated before it is written. */
export interface CooldownRecord {
  timestamp: string;
  provider: string;
  billingProduct: string;
  account: string;
  scope: string;
  failureClass: LaunchFailureClass;
  code: string;
  causeCode: string | null;
  retryNotBefore: string | null;
}

export interface AvailabilityPaths {
  directory: string;
  records: string;
  lock: string;
}

export interface RecordLaunchFailureOptions {
  /** Trusted manager/session project root — never a caller-controlled child cwd. */
  root: string;
  /** Clock seam for deterministic timestamps; defaults to `new Date()`. */
  now?: () => Date;
  /** Bound on flock's own contention wait (default {@link AVAILABILITY_LOCK_WAIT_MS}). */
  waitMs?: number;
  /** Bound on the holder's ready marker; defaults to waitMs plus spawn margin. */
  deadlineMs?: number;
}

export interface AvailabilityOptions {
  /** Trusted manager/session project root — never a caller-controlled child cwd. */
  root: string;
  /** Clock seam for deterministic evaluation; defaults to `new Date()`. */
  now?: () => Date;
}

/** Bounded evidence for an availability answer; never carries prose. */
export interface AvailabilityEvidence {
  /** Records in the file that matched this candidate's key. */
  records: number;
  /** File lines that failed the record schema and were skipped. */
  malformed?: number;
  /** The record file could not be trusted or read; the answer is `unknown`. */
  unreadable?: boolean;
  /** Most recent matching record's timestamp, class, and code. */
  lastFailureAt?: string;
  lastClass?: LaunchFailureClass;
  lastCode?: string;
}

export interface CandidateAvailability {
  status: AvailabilityStatus;
  /** The source's own reset signal when an active quota cooldown carries one; `null` otherwise. */
  retryNotBefore: string | null;
  evidence: AvailabilityEvidence;
}

/** The cooldown record paths under one trusted project root; artifacts stay under `.herdr/availability/`. */
export function availabilityPaths(root: string): AvailabilityPaths {
  const directory = join(root, ".herdr", "availability");
  return { directory, records: join(directory, "cooldowns.jsonl"), lock: join(directory, "cooldowns.lock") };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function uid(): number {
  const value = process.getuid?.();
  /* c8 ignore next -- flock only exists on platforms that provide getuid. */
  if (value === undefined) throw availabilityFailure("Availability cooldown record owner is unavailable");
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailureClass(value: unknown): value is LaunchFailureClass {
  return typeof value === "string" && FAILURE_CLASSES.has(value);
}

function signalOf(failure: string | LaunchFailureSignal): LaunchFailureSignal {
  return typeof failure === "string" ? { code: failure } : record(failure) ? failure : { code: "" };
}

/**
 * Classify one launch failure into exactly one ADR class. The wrapped
 * `causeCode` — the backend envelope code at agent_start, otherwise the
 * originating module code — is the more specific signal and wins when it is
 * known; the surfaced `code` is the fallback. Anything unrecognized is
 * `task-failure`: unknown evidence is never quota evidence.
 */
export function classifyLaunchFailure(failure: string | LaunchFailureSignal): LaunchFailureClass {
  const signal = signalOf(failure);
  if (typeof signal.causeCode === "string") {
    const caused = FAILURE_CLASS_BY_CODE[signal.causeCode];
    if (caused !== undefined) return caused;
  }
  return FAILURE_CLASS_BY_CODE[signal.code] ?? "task-failure";
}

/** A key field is a non-empty single-line identifier; anything else refuses the append. */
function keyField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value) || Buffer.byteLength(value, "utf8") > KEY_FIELD_MAX_BYTES) {
    throw availabilityFailure(`Cooldown key ${field} is untrusted`);
  }
  return value;
}

/**
 * The subject's availability tuple via the B1 derivation — the model entry's
 * below-runner attribution merged over the runner's quota tuple. The runner
 * name never enters the key, so points sharing provider/billingProduct/
 * account/scope share the cooldown regardless of which runner they launch on.
 */
function availabilityKeyFor(candidate: AvailabilitySubject, runner: RunnerEntry): QuotaKey {
  const key = quotaKeyFor(candidate, runner);
  return {
    provider: keyField(key.provider, "provider"),
    billingProduct: keyField(key.billingProduct, "billingProduct"),
    account: keyField(key.account, "account"),
    scope: keyField(key.scope, "scope")
  };
}

function codeField(value: unknown, field: string): string {
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    throw availabilityFailure(`Cooldown ${field} is untrusted`);
  }
  return value;
}

/**
 * The source's reset signal normalized to an ISO instant. `undefined`/`null`
 * means the source gave none — `null` is recorded, never a synthesized ETA. A
 * present-but-unparseable signal is untrusted input and refuses the append.
 */
function retryInstant(value: string | number | Date | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw availabilityFailure("Cooldown reset signal is untrusted");
  try {
    return new Date(ms).toISOString();
  } catch {
    throw availabilityFailure("Cooldown reset signal is untrusted");
  }
}

/** Build the persisted record or refuse the append; nothing is written on rejection. */
function buildRecord(
  key: QuotaKey,
  failureClass: LaunchFailureClass,
  signal: LaunchFailureSignal,
  now: () => Date
): CooldownRecord {
  return {
    timestamp: now().toISOString(),
    provider: key.provider,
    billingProduct: key.billingProduct,
    account: key.account,
    scope: key.scope,
    failureClass,
    code: codeField(signal.code, "code"),
    causeCode: signal.causeCode === undefined ? null : codeField(signal.causeCode, "causeCode"),
    retryNotBefore: retryInstant(signal.retryNotBefore)
  };
}

const RECORD_FIELDS = [
  "timestamp",
  "provider",
  "billingProduct",
  "account",
  "scope",
  "failureClass",
  "code",
  "causeCode",
  "retryNotBefore"
] as const;

/**
 * Read-side schema proof for one parsed line: exact field set, every field
 * within its bound. Anything else is a foreign or torn line — skipped as
 * malformed evidence, never trusted.
 */
function parseRecord(value: unknown): CooldownRecord | undefined {
  if (!record(value) || Object.keys(value).length !== RECORD_FIELDS.length) return undefined;
  const { timestamp, provider, billingProduct, account, scope, failureClass, code, causeCode, retryNotBefore } = value;
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return undefined;
  if (typeof provider !== "string" || provider.length === 0) return undefined;
  if (typeof billingProduct !== "string" || billingProduct.length === 0) return undefined;
  if (typeof account !== "string" || account.length === 0) return undefined;
  if (typeof scope !== "string" || scope.length === 0) return undefined;
  if (!isFailureClass(failureClass)) return undefined;
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) return undefined;
  if (causeCode !== null && (typeof causeCode !== "string" || !CODE_PATTERN.test(causeCode))) return undefined;
  if (retryNotBefore !== null && (typeof retryNotBefore !== "string" || !Number.isFinite(Date.parse(retryNotBefore)))) {
    return undefined;
  }
  return { timestamp, provider, billingProduct, account, scope, failureClass, code, causeCode, retryNotBefore };
}

/** The instant a quota record stops excluding its key: the source's own signal, or the fallback quarantine. */
function cooldownExpiryMs(entry: CooldownRecord): number {
  if (entry.retryNotBefore !== null) return Date.parse(entry.retryNotBefore);
  return Date.parse(entry.timestamp) + DEFAULT_QUOTA_COOLDOWN_MS;
}

/** The `.herdr` and `availability` directories are created owner-only and then proven trusted. */
async function ensureLogDirectory(directory: string): Promise<void> {
  for (const path of [dirname(directory), directory]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw availabilityFailure("Availability cooldown directory is unavailable");
    }
    let value;
    try {
      value = await lstat(path);
    } catch {
      throw availabilityFailure("Availability cooldown directory is unavailable");
    }
    assertOwnerOnlyDirectory(path, value, availabilityFailure, "Availability cooldown");
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
    if (!isNodeError(error, "ENOENT")) throw availabilityFailure("Availability cooldown file is indeterminate");
  }
  if (value !== undefined && (!value.isFile() || value.isSymbolicLink() || value.uid !== uid() || (Number(value.mode) & 0o22) !== 0)) {
    throw availabilityFailure("Availability cooldown file is not trusted");
  }
  /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
  const flags = constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path, flags, 0o600);
  } catch {
    throw availabilityFailure("Availability cooldown file is unavailable");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== uid() || (Number(opened.mode) & 0o22) !== 0) {
      throw availabilityFailure("Availability cooldown file is not trusted");
    }
    await handle.appendFile(line);
  } finally {
    // A failed close cannot unwrite what the append already did; the section
    // promises no fsync, so close errors settle quietly like release errors.
    await handle.close().catch(() => undefined);
  }
}

type ReadResult = { records: CooldownRecord[]; malformed: number } | "unreadable";

/**
 * Lock-free read of the cooldown record. Whole-line O_APPEND writes keep a
 * snapshot coherent; the file itself must pass the same trust proof appends
 * require, an absent file is empty evidence, and anything else — foreign
 * ownership, symlink, unreadable bytes — is "unreadable": `unknown`, never
 * exhaustion. Malformed lines are skipped and counted rather than trusted.
 */
async function readRecords(path: string): Promise<ReadResult> {
  let value;
  try {
    value = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { records: [], malformed: 0 };
    return "unreadable";
  }
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== uid() || (Number(value.mode) & 0o22) !== 0) {
    return "unreadable";
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return "unreadable";
  }
  const records: CooldownRecord[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const entry = parseRecord(parsed);
    if (entry === undefined) {
      malformed += 1;
    } else {
      records.push(entry);
    }
  }
  return { records, malformed };
}

/**
 * Record one classified launch failure on the candidate's availability tuple.
 * Validation happens before the lock section; the flock is held only for the
 * append itself. Every class is persisted — quota starts a cooldown, the rest
 * are evidence — and any failure throws `AvailabilityLogError`
 * (`AVAILABILITY_LOG_UNAVAILABLE`) claiming no persistence. Returns the class
 * the failure was recorded under.
 */
export async function recordLaunchFailure(
  candidate: AvailabilitySubject,
  runner: RunnerEntry,
  failure: string | LaunchFailureSignal,
  options: RecordLaunchFailureOptions
): Promise<LaunchFailureClass> {
  try {
    if (!isAbsolute(options.root)) throw availabilityFailure("Availability cooldown root is untrusted");
    const signal = signalOf(failure);
    const failureClass = classifyLaunchFailure(signal);
    const key = availabilityKeyFor(candidate, runner);
    const line = `${JSON.stringify(modelSafeJson(buildRecord(key, failureClass, signal, options.now ?? (() => new Date()))))}\n`;
    const paths = availabilityPaths(options.root);
    await ensureLogDirectory(paths.directory);
    const holder = await acquireFlockHolder({
      lockPath: paths.lock,
      wait: { timeoutMs: options.waitMs ?? AVAILABILITY_LOCK_WAIT_MS },
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      readyMarker: AVAILABILITY_LOG_READY,
      subject: "Availability cooldown",
      failure: availabilityFailure
    });
    try {
      await appendLine(paths.records, line);
    } finally {
      // A failed release cannot recall what the section already did, so the
      // lease settles quietly; the kernel frees the flock when the holder dies.
      await holder.release().catch(() => undefined);
    }
    return failureClass;
  } catch (error) {
    if (error instanceof AvailabilityLogError) throw error;
    throw new AvailabilityLogError();
  }
}

/**
 * The candidate's current availability under the reactive floor. An active
 * quota cooldown is `known-exhausted` — `retryNotBefore` is the source's own
 * future reset signal or `null`, never fabricated. Otherwise a recent
 * transport failure is `local-capacity-limited` (the local channel is the
 * limit, not the provider), any other recent failure is `degraded`, and no
 * evidence — including an unreadable or untrusted record file — is `unknown`,
 * never treated as exhausted.
 */
export async function availability(
  candidate: AvailabilitySubject,
  runner: RunnerEntry,
  options: AvailabilityOptions
): Promise<CandidateAvailability> {
  try {
    if (!isAbsolute(options.root)) throw availabilityFailure("Availability cooldown root is untrusted");
    const key = availabilityKeyFor(candidate, runner);
    const nowMs = (options.now ?? (() => new Date()))().getTime();
    if (!Number.isFinite(nowMs)) throw availabilityFailure("Availability clock is untrusted");
    const read = await readRecords(availabilityPaths(options.root).records);
    if (read === "unreadable") {
      return { status: "unknown", retryNotBefore: null, evidence: { records: 0, unreadable: true } };
    }
    const matching = read.records.filter(
      (entry) =>
        entry.provider === key.provider &&
        entry.billingProduct === key.billingProduct &&
        entry.account === key.account &&
        entry.scope === key.scope
    );
    const last = matching.at(-1);
    const evidence: AvailabilityEvidence = {
      records: matching.length,
      ...(read.malformed === 0 ? {} : { malformed: read.malformed }),
      ...(last === undefined
        ? {}
        : { lastFailureAt: last.timestamp, lastClass: last.failureClass, lastCode: last.code })
    };
    const activeQuota = matching.filter((entry) => entry.failureClass === "quota" && cooldownExpiryMs(entry) > nowMs);
    if (activeQuota.length > 0) {
      // A signaled record is only active while its signal is future, so every
      // signal surviving this filter is already a future instant.
      const signaled = activeQuota
        .map((entry) => (entry.retryNotBefore === null ? undefined : Date.parse(entry.retryNotBefore)))
        .filter((ms): ms is number => ms !== undefined);
      return {
        status: "known-exhausted",
        retryNotBefore: signaled.length === 0 ? null : new Date(Math.max(...signaled)).toISOString(),
        evidence
      };
    }
    const recent = matching.filter((entry) => nowMs - Date.parse(entry.timestamp) < AVAILABILITY_EVIDENCE_WINDOW_MS);
    if (recent.some((entry) => entry.failureClass === "transport")) {
      return { status: "local-capacity-limited", retryNotBefore: null, evidence };
    }
    if (recent.length > 0) return { status: "degraded", retryNotBefore: null, evidence };
    return { status: "unknown", retryNotBefore: null, evidence };
  } catch (error) {
    if (error instanceof AvailabilityLogError) throw error;
    throw new AvailabilityLogError();
  }
}
