/**
 * The durable launch-intent store (spec: durable-supervisor §6, D1–D3).
 *
 * One record per `(managerSessionKey, idempotencyKey)` binding at
 * `intents/<managerSessionKey>/<key>.json` inside the owner-only N1.1
 * namespace. Every write is the D1 discipline — same-directory temp file,
 * fsync, rename, directory fsync — performed while holding that manager's
 * `intents.lock` flock, so the read–check–write a launch decision depends on
 * is atomic against concurrent same-key launches.
 *
 * Lifecycle: `recorded` (fsynced before the first effect) → `effecting`
 * (written immediately before the first durable or child mutation) →
 * `completed | failed`. `failed` is reachable only with evidence that no
 * child effect exists — `effectCertainty: "absent"` and zero recorded
 * children; any `partial`, `unknown`, or `confirmed` certainty settles
 * `unresolved`, never `failed`. An interrupted `effecting` record becomes
 * `unresolved` through `recoverInterrupted` on restart; the store never
 * auto-replays an effect.
 *
 * Replay: `begin` on a `recorded` binding resumes the launch under the same
 * minted `launchId`; on `effecting | completed | failed` it returns the
 * recorded state for a zero-effect `replayed:false` answer — an `effecting`
 * record seen there can only be a live in-flight effect, because restart
 * recovery has already rewritten every interrupted one; on `unresolved` it
 * returns the recorded child names and run IDs for the caller's `reconcile`.
 * Same key and session with a different `taskDigest` or `projectRoot` is
 * `IDEMPOTENCY_KEY_CONFLICT`; the same textual key under another
 * `managerSessionKey` is an independent binding in another directory, never
 * a conflict.
 *
 * Only allowlisted typed fields are persisted — digests, minted identifiers,
 * states, dispositions, bounded codes — never message text, stderr, or
 * envelope bodies.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Value } from "typebox/value";
import { LaunchTaskSchema, type LaunchTask } from "../launch-schema.js";
import type { AgentSessionIdentity } from "../messages/prompt.js";
import { acquireFlockHolder, assertOwnerOnlyDirectory, type FlockHolderLease } from "../pane-write-lock.js";
import { modelSafeJson } from "../redaction.js";
import type { LaunchEffectCertainty } from "../tools/launch.js";
import type { DaemonNamespace } from "./namespace.js";

export type DaemonIntentErrorCode =
  | "INTENT_STORE_UNAVAILABLE"
  | "INTENT_MALFORMED"
  | "INTENT_REQUEST_INVALID"
  | "INTENT_STATE_CONFLICT"
  | "IDEMPOTENCY_KEY_CONFLICT";

export class DaemonIntentError extends Error {
  constructor(readonly code: DaemonIntentErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DaemonIntentError";
  }
}

export type LaunchIntentState = "recorded" | "effecting" | "completed" | "failed" | "unresolved";

/** The §8 reconcile classification of one recorded child identity. */
export type LaunchIntentChildDisposition = "bound" | "identity_lost" | "ambiguous";

/** A child identity the launch recorded — name first, run ID once allocated. */
export interface LaunchIntentChild {
  name: string;
  runId?: string;
  /** Reconcile classification; absent while the child is unclassified. */
  disposition?: LaunchIntentChildDisposition;
  /** Bounded snapshot evidence; no free-form message or envelope bodies. */
  evidence?: { at: string; reason: string; terminalId?: string; session?: AgentSessionIdentity };
}

/** Why an intent rests `unresolved`: interrupted on restart, or effect certainty short of `absent`. */
export type LaunchIntentResolution = "interrupted" | "effect_uncertain";

/** The D2 binding plus lifecycle — the only fields an intent record may carry. */
export interface LaunchIntentRecord {
  v: 1;
  managerSessionKey: string;
  idempotencyKey: string;
  taskDigest: string;
  launchId: string;
  projectRoot: string;
  state: LaunchIntentState;
  recordedAt: string;
  updatedAt: string;
  children: LaunchIntentChild[];
  /** The launcher's effect certainty at settle time, preserved for classification. */
  effectCertainty?: LaunchEffectCertainty;
  /** Bounded typed failure code (`^[A-Z][A-Z0-9_]{0,63}$`); never message text. */
  failureCode?: string;
  resolution?: LaunchIntentResolution;
  /** Present only on `completed` when `reconcile` closed the intent (§8). */
  reconciled?: true;
}

/** `begin` input: the daemon's verified request fields. `task` is digested inside. */
export interface BeginIntentInput {
  managerSessionKey: string;
  idempotencyKey: string;
  task: LaunchTask;
  projectRoot: string;
}

/**
 * The `begin` verdict. `launch` means the caller owns the effect — a fresh
 * record (`resumed:false`) or a still-`recorded` binding resumed under its
 * original `launchId` (`resumed:true`). `replay` means `effecting`,
 * `completed`, or `failed`: return the recorded state with `replayed:false`
 * and zero effect. `unresolved` means return the recorded child names and run
 * IDs — the caller reconciles, then retries through `recoveryOf` or a new key.
 */
export type BeginIntentResult =
  | { kind: "launch"; intent: LaunchIntentRecord; resumed: boolean }
  | { kind: "replay"; intent: LaunchIntentRecord }
  | { kind: "unresolved"; intent: LaunchIntentRecord };

/** The `fail` input: the launcher's preserved effect certainty drives the failed/unresolved rule. */
export interface FailIntentInput {
  effectCertainty: LaunchEffectCertainty;
  /** Optional bounded typed code; message text is never persisted. */
  failureCode?: string;
  children?: LaunchIntentChild[];
}

export interface IntentStore {
  /** The D2 read–check–write under the per-manager flock (§6 replay/conflict rules). */
  begin(input: BeginIntentInput): Promise<BeginIntentResult>;
  /** `recorded` → `effecting`, written immediately before the first durable/child mutation. */
  markEffecting(intent: LaunchIntentRecord): Promise<LaunchIntentRecord>;
  /** Merge observed child identities while `effecting`; shrinks the unknown-effect window. */
  recordChildren(intent: LaunchIntentRecord, children: LaunchIntentChild[]): Promise<LaunchIntentRecord>;
  /** `effecting` → `completed`. */
  complete(intent: LaunchIntentRecord, children?: LaunchIntentChild[]): Promise<LaunchIntentRecord>;
  /** `recorded | effecting` → `failed` iff certainty is `absent` with zero recorded children, else `unresolved`. */
  fail(intent: LaunchIntentRecord, outcome: FailIntentInput): Promise<LaunchIntentRecord>;
  /** `unresolved` → `completed(reconciled)` once every recorded child is bound or provably absent (§8). */
  reconcile(intent: LaunchIntentRecord, dispositions: LaunchIntentChild[]): Promise<LaunchIntentRecord>;
  get(managerSessionKey: string, idempotencyKey: string): Promise<LaunchIntentRecord | undefined>;
  list(managerSessionKey: string): Promise<LaunchIntentRecord[]>;
  /** Every `intents/<managerSessionKey>` directory present, for the D4 restart sweep. */
  listManagers(): Promise<string[]>;
  /** D3 restart rule: every `effecting` record becomes `unresolved(interrupted)`, durably. */
  recoverInterrupted(managerSessionKey?: string): Promise<LaunchIntentRecord[]>;
}

export interface IntentStoreOptions {
  namespace: DaemonNamespace | (() => Promise<DaemonNamespace>);
  /** Bound on flock's own contention wait for one intent section. */
  waitMs?: number;
  now?: () => Date;
}

export const DAEMON_INTENTS_DIR_NAME = "intents";
const INTENT_LOCK_NAME = "intents.lock";
const INTENT_LOCK_READY = "HERDR_INTENT_LOCK_READY";
const INTENT_LOCK_WAIT_MS = 5_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]+$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const INTENT_STATES = new Set<LaunchIntentState>(["recorded", "effecting", "completed", "failed", "unresolved"]);
const CHILD_DISPOSITIONS = new Set<LaunchIntentChildDisposition>(["bound", "identity_lost", "ambiguous"]);
const EFFECT_CERTAINTIES = new Set<LaunchEffectCertainty>(["absent", "partial", "unknown", "confirmed"]);
const INTENT_RESOLUTIONS = new Set<LaunchIntentResolution>(["interrupted", "effect_uncertain"]);

const failure = (message: string): DaemonIntentError => new DaemonIntentError("INTENT_STORE_UNAVAILABLE", message);

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function uid(): number {
  const value = process.getuid?.();
  /* c8 ignore next -- flock only exists on platforms that provide getuid. */
  if (value === undefined) throw failure("Intent store owner is unavailable");
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value);
}

function assertManagerSessionKey(value: string): void {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new DaemonIntentError("INTENT_REQUEST_INVALID", "manager session key is malformed", { field: "managerSessionKey" });
  }
}

function assertIdempotencyKey(value: string): void {
  if (typeof value !== "string" || value.length > 128 || !IDEMPOTENCY_KEY.test(value)) {
    throw new DaemonIntentError("INTENT_REQUEST_INVALID", "idempotency key is malformed", { field: "idempotencyKey" });
  }
}

/**
 * The D2 binding's session half: `sha256(JSON.stringify([source, agent, kind,
 * value]))` over the manager's complete `agent_session` (spec §4). One key is
 * one native session — a restarted manager agent is a different key.
 */
export function managerSessionKey(session: AgentSessionIdentity): string {
  for (const field of ["source", "agent", "kind", "value"] as const) {
    if (!isIdentifier(session[field])) {
      throw new DaemonIntentError("INTENT_REQUEST_INVALID", "manager session is incomplete", { field: `managerSession.${field}` });
    }
  }
  return createHash("sha256").update(JSON.stringify([session.source, session.agent, session.kind, session.value]), "utf8").digest("hex");
}

/** Recursively key-sorted JSON with no insignificant whitespace — the D2 canonical form. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (record(value)) {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The D2 taskDigest: lowercase-hex sha256 over the deterministic JSON
 * serialization of the validated Task as received — only fields whose
 * omission is semantically identical to a value are normalized
 * (`constraints` ≡ `[]`, `replicas` ≡ 1). `tier` is digested verbatim:
 * omission means "the workload floor decides" while an explicit tier steers
 * routing, so the two must never digest identically. Every contract field
 * participates (`tier`, `replicas`, `recoveryOf`, `label`, `cwd` included):
 * the same key carrying any changed field is a conflict, never a replay.
 */
export function taskDigest(task: LaunchTask): string {
  const normalized = modelSafeJson({ ...task, constraints: task.constraints ?? [], replicas: task.replicas ?? 1 });
  return createHash("sha256").update(canonicalJson(normalized), "utf8").digest("hex");
}

function isIntentChild(value: unknown): value is LaunchIntentChild {
  if (!record(value) || !isIdentifier(value.name)) return false;
  if (value.runId !== undefined && !isIdentifier(value.runId)) return false;
  if (value.disposition !== undefined && (typeof value.disposition !== "string" || !CHILD_DISPOSITIONS.has(value.disposition as LaunchIntentChildDisposition))) return false;
  if (value.evidence !== undefined) {
    const evidence = value.evidence;
    if (!record(evidence) || !Object.keys(evidence).every((key) => ["at", "reason", "terminalId", "session"].includes(key))
      || typeof evidence.at !== "string" || evidence.at.length > 32 || !Number.isFinite(Date.parse(evidence.at))
      || typeof evidence.reason !== "string" || !/^[a-z_]{1,64}$/.test(evidence.reason)
      || (evidence.terminalId !== undefined && (!isIdentifier(evidence.terminalId) || evidence.terminalId.length > 256))) return false;
    if (evidence.session !== undefined && (!record(evidence.session) || Object.keys(evidence.session).length !== 4
      || !["source", "agent", "kind", "value"].every((key) => isIdentifier(evidence.session && (evidence.session as Record<string, unknown>)[key])
        && String((evidence.session as Record<string, unknown>)[key]).length <= 4096))) return false;
  }
  return true;
}

function isIntentRecord(value: unknown): value is LaunchIntentRecord {
  if (!record(value)) return false;
  if (value.v !== 1
    || typeof value.managerSessionKey !== "string" || !SHA256_HEX.test(value.managerSessionKey)
    || typeof value.idempotencyKey !== "string" || value.idempotencyKey.length > 128 || !IDEMPOTENCY_KEY.test(value.idempotencyKey)
    || typeof value.taskDigest !== "string" || !SHA256_HEX.test(value.taskDigest)
    || !isIdentifier(value.launchId)
    || !isIdentifier(value.projectRoot)
    || typeof value.state !== "string" || !INTENT_STATES.has(value.state as LaunchIntentState)
    || !isIdentifier(value.recordedAt)
    || !isIdentifier(value.updatedAt)
    || !Array.isArray(value.children) || !value.children.every(isIntentChild)) return false;
  if (value.effectCertainty !== undefined && (typeof value.effectCertainty !== "string" || !EFFECT_CERTAINTIES.has(value.effectCertainty as LaunchEffectCertainty))) return false;
  if (value.failureCode !== undefined && (typeof value.failureCode !== "string" || !FAILURE_CODE.test(value.failureCode))) return false;
  if (value.resolution !== undefined && (typeof value.resolution !== "string" || !INTENT_RESOLUTIONS.has(value.resolution as LaunchIntentResolution))) return false;
  if (value.reconciled !== undefined && value.reconciled !== true) return false;
  return true;
}

function assertChildren(children: LaunchIntentChild[], field: string): void {
  if (!Array.isArray(children) || !children.every(isIntentChild)) {
    throw new DaemonIntentError("INTENT_REQUEST_INVALID", "intent children are malformed", { field });
  }
}

/** Merge by name: a later entry fills or replaces fields, never duplicates. */
function mergeChildren(current: LaunchIntentChild[], added: LaunchIntentChild[]): LaunchIntentChild[] {
  const merged = [...current];
  for (const child of added) {
    const index = merged.findIndex((entry) => entry.name === child.name);
    if (index === -1) {
      merged.push(child);
      continue;
    }
    const defined: Partial<LaunchIntentChild> = {};
    if (child.runId !== undefined) defined.runId = child.runId;
    if (child.disposition !== undefined) defined.disposition = child.disposition;
    if (child.evidence !== undefined) defined.evidence = child.evidence;
    merged[index] = { ...merged[index], ...defined };
  }
  return merged;
}

/**
 * Create the store for one host. The namespace resolves lazily on first use
 * and a failure is not cached — a host whose endpoint becomes reachable later
 * is not permanently refused, mirroring the pane-write guard.
 */
export function createIntentStore(options: IntentStoreOptions): IntentStore {
  const waitMs = options.waitMs ?? INTENT_LOCK_WAIT_MS;
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  let resolved: Promise<DaemonNamespace> | undefined;
  const namespace = (): Promise<DaemonNamespace> => {
    resolved ??= Promise.resolve(typeof options.namespace === "function" ? options.namespace() : options.namespace)
      .catch((error: unknown) => {
        resolved = undefined;
        throw error instanceof DaemonIntentError ? error : failure("Intent store namespace is unavailable");
      });
    return resolved;
  };

  async function intentsRoot(): Promise<string> {
    const dir = (await namespace()).dir;
    try {
      assertOwnerOnlyDirectory(dir, await lstat(dir), failure, "Intent store");
    } catch (error) {
      if (error instanceof DaemonIntentError) throw error;
      throw failure("Intent store namespace is unavailable");
    }
    const root = join(dir, DAEMON_INTENTS_DIR_NAME);
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw failure("Intent store directory is unavailable");
    }
    try {
      assertOwnerOnlyDirectory(root, await lstat(root), failure, "Intent store");
    } catch (error) {
      /* c8 ignore start -- typed refusals rethrow; a foreign lstat failure means the intents root changed between mkdir and stat. */
      if (error instanceof DaemonIntentError) throw error;
      throw failure("Intent store directory is unavailable");
      /* c8 ignore stop */
    }
    return root;
  }

  async function managerDir(key: string, create: boolean): Promise<string | undefined> {
    assertManagerSessionKey(key);
    const dir = join(await intentsRoot(), key);
    if (create) {
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw failure("Intent store manager directory is unavailable");
      }
    }
    let value;
    try {
      value = await lstat(dir);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw failure("Intent store manager directory is unavailable");
    }
    assertOwnerOnlyDirectory(dir, value, failure, "Intent store");
    return dir;
  }

  async function withManagerLock<T>(dir: string, section: () => Promise<T>): Promise<T> {
    const lease: FlockHolderLease = await acquireFlockHolder({
      lockPath: join(dir, INTENT_LOCK_NAME),
      wait: { timeoutMs: waitMs },
      readyMarker: INTENT_LOCK_READY,
      subject: "Intent store",
      failure,
    });
    try {
      return await section();
    } finally {
      // A failed release cannot recall what the section already committed; the
      // kernel frees the flock when the holder dies, matching the pane-write lease.
      /* c8 ignore next -- holder release only fails on an injected filesystem fault; cleanup is best-effort. */
      await lease.release().catch(() => undefined);
    }
  }

  async function readIntent(dir: string, key: string): Promise<LaunchIntentRecord | undefined> {
    const path = join(dir, `${key}.json`);
    let value;
    try {
      value = await lstat(path);
    } catch (error) {
      /* c8 ignore start -- a non-ENOENT record lstat failure requires the manager directory to change between stat and read. */
      if (isNodeError(error, "ENOENT")) return undefined;
      throw failure("Intent record is indeterminate");
      /* c8 ignore stop */
    }
    if (!value.isFile() || value.isSymbolicLink() || value.uid !== uid() || (Number(value.mode) & 0o22) !== 0) {
      throw failure("Intent record is not trusted");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new DaemonIntentError("INTENT_MALFORMED", "Intent record is malformed");
    }
    // The record's own binding fields must match the file it lives under: a
    // record misfiled into another key or manager is not this binding's intent.
    if (!isIntentRecord(parsed) || parsed.idempotencyKey !== key || parsed.managerSessionKey !== basename(dir)) {
      throw new DaemonIntentError("INTENT_MALFORMED", "Intent record is malformed");
    }
    return parsed;
  }

  /** D1: same-directory temp file, fsync, rename, directory fsync — 0600 throughout. */
  async function writeIntent(dir: string, intent: LaunchIntentRecord): Promise<void> {
    const path = join(dir, `${intent.idempotencyKey}.json`);
    const temporary = join(dir, `.${randomUUID()}.tmp`);
    /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    let handle;
    try {
      handle = await open(temporary, flags, 0o600);
    } catch {
      /* c8 ignore next -- the staging open fails only when the locked directory became unwritable mid-section. */
      throw failure("Intent record could not be staged");
    }
    try {
      await handle.writeFile(JSON.stringify(modelSafeJson(intent)));
      await handle.sync();
      await handle.close();
    } catch (error) {
      /* c8 ignore start -- file-handle write, sync, and close rejections are errno-only inside a held handle; cleanup is best-effort and the typed failure shares the fault. */
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof DaemonIntentError) throw error;
      throw failure("Intent record could not be written");
      /* c8 ignore stop */
    }
    try {
      await rename(temporary, path);
    } catch {
      /* c8 ignore start -- a rename failure is an injected filesystem fault beneath an already-committed stage; the stray temp file is cleaned up. */
      await rm(temporary, { force: true }).catch(() => undefined);
      throw failure("Intent record could not be committed");
      /* c8 ignore stop */
    }
    let dirHandle;
    try {
      dirHandle = await open(dir, constants.O_RDONLY);
      await dirHandle.sync();
    } catch {
      /* c8 ignore next -- the directory handle fails only on a filesystem fault after a committed rename. */
      throw failure("Intent store directory could not be synced");
    } finally {
      /* c8 ignore next -- closing the sync handle is best-effort cleanup. */
      await dirHandle?.close().catch(() => undefined);
    }
  }

  async function listDir(dir: string): Promise<LaunchIntentRecord[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      /* c8 ignore next -- readdir fails only if the locked manager directory vanished or lost permissions mid-list. */
      throw failure("Intent store manager directory is unavailable");
    }
    const records: LaunchIntentRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const intent = await readIntent(dir, name.slice(0, -".json".length));
      /* c8 ignore next -- a record file vanishing between readdir and lstat is a filesystem race. */
      if (intent !== undefined) records.push(intent);
    }
    return records;
  }

  async function listManagerKeys(): Promise<string[]> {
    const root = await intentsRoot();
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      /* c8 ignore next -- readdir fails only if the intents root changed between stat and list. */
      throw failure("Intent store directory is unavailable");
    }
    const managers: string[] = [];
    for (const name of names.sort()) {
      if (!SHA256_HEX.test(name)) continue;
      try {
        assertOwnerOnlyDirectory(join(root, name), await lstat(join(root, name)), failure, "Intent store");
      } catch (error) {
        /* c8 ignore start -- typed refusals rethrow; an entry vanishing or failing lstat between readdir and stat is a filesystem race. */
        if (error instanceof DaemonIntentError) throw error;
        if (isNodeError(error, "ENOENT")) continue;
        throw failure("Intent store manager directory is unavailable");
        /* c8 ignore stop */
      }
      managers.push(name);
    }
    return managers;
  }

  /** Every transition re-reads under the flock and fails closed on a moved state. */
  async function transition(
    intent: LaunchIntentRecord,
    expect: LaunchIntentState[],
    mutate: (current: LaunchIntentRecord) => LaunchIntentRecord,
  ): Promise<LaunchIntentRecord> {
    const dir = await managerDir(intent.managerSessionKey, false);
    if (dir === undefined) {
      throw new DaemonIntentError("INTENT_STATE_CONFLICT", "Intent record is absent", { state: "absent" });
    }
    return withManagerLock(dir, async () => {
      const current = await readIntent(dir, intent.idempotencyKey);
      if (current === undefined || current.launchId !== intent.launchId || !expect.includes(current.state)) {
        throw new DaemonIntentError("INTENT_STATE_CONFLICT", "Intent state does not allow the transition", { state: current?.state ?? "absent" });
      }
      const next = mutate(current);
      await writeIntent(dir, next);
      return next;
    });
  }

  return {
    async begin(input) {
      assertManagerSessionKey(input.managerSessionKey);
      assertIdempotencyKey(input.idempotencyKey);
      if (!isIdentifier(input.projectRoot)) {
        throw new DaemonIntentError("INTENT_REQUEST_INVALID", "project root is malformed", { field: "projectRoot" });
      }
      if (!Value.Check(LaunchTaskSchema, input.task)) {
        throw new DaemonIntentError("INTENT_REQUEST_INVALID", "task is not a valid launch task", { field: "task" });
      }
      const digest = taskDigest(input.task);
      const dir = await managerDir(input.managerSessionKey, true);
      /* c8 ignore next -- a just-created manager directory is undefined only if it vanished between its mkdir and lstat. */
      if (dir === undefined) throw failure("Intent store manager directory is unavailable");
      return withManagerLock(dir, async () => {
        const existing = await readIntent(dir, input.idempotencyKey);
        if (existing === undefined) {
          const intent: LaunchIntentRecord = {
            v: 1,
            managerSessionKey: input.managerSessionKey,
            idempotencyKey: input.idempotencyKey,
            taskDigest: digest,
            launchId: randomUUID(),
            projectRoot: input.projectRoot,
            state: "recorded",
            recordedAt: now(),
            updatedAt: now(),
            children: [],
          };
          await writeIntent(dir, intent);
          return { kind: "launch", intent, resumed: false };
        }
        if (existing.taskDigest !== digest) {
          throw new DaemonIntentError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key is bound to a different task", { field: "taskDigest" });
        }
        if (existing.projectRoot !== input.projectRoot) {
          throw new DaemonIntentError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key is bound to a different project root", { field: "projectRoot" });
        }
        if (existing.state === "recorded") return { kind: "launch", intent: existing, resumed: true };
        if (existing.state === "unresolved") return { kind: "unresolved", intent: existing };
        return { kind: "replay", intent: existing };
      });
    },

    markEffecting(intent) {
      return transition(intent, ["recorded"], (current) => ({ ...current, state: "effecting", updatedAt: now() }));
    },

    recordChildren(intent, children) {
      assertChildren(children, "children");
      return transition(intent, ["effecting"], (current) => ({ ...current, children: mergeChildren(current.children, children), updatedAt: now() }));
    },

    complete(intent, children = []) {
      assertChildren(children, "children");
      return transition(intent, ["effecting"], (current) => ({ ...current, state: "completed", children: mergeChildren(current.children, children), updatedAt: now() }));
    },

    fail(intent, outcome) {
      if (typeof outcome.effectCertainty !== "string" || !EFFECT_CERTAINTIES.has(outcome.effectCertainty)) {
        throw new DaemonIntentError("INTENT_REQUEST_INVALID", "effect certainty is malformed", { field: "effectCertainty" });
      }
      if (outcome.failureCode !== undefined && !FAILURE_CODE.test(outcome.failureCode)) {
        throw new DaemonIntentError("INTENT_REQUEST_INVALID", "failure code is malformed", { field: "failureCode" });
      }
      const children = outcome.children ?? [];
      assertChildren(children, "children");
      return transition(intent, ["recorded", "effecting"], (current) => {
        const merged = mergeChildren(current.children, children);
        const next: LaunchIntentRecord = {
          ...current,
          children: merged,
          effectCertainty: outcome.effectCertainty,
          ...(outcome.failureCode === undefined ? {} : { failureCode: outcome.failureCode }),
          updatedAt: now(),
        };
        // `failed` only with evidence that no child effect exists: absent
        // certainty AND zero recorded children. Anything else is unresolved.
        if (outcome.effectCertainty === "absent" && merged.length === 0) {
          return { ...next, state: "failed" };
        }
        return { ...next, state: "unresolved", resolution: "effect_uncertain" };
      });
    },

    reconcile(intent, dispositions) {
      assertChildren(dispositions, "dispositions");
      for (const entry of dispositions) {
        if (entry.disposition === undefined) {
          throw new DaemonIntentError("INTENT_REQUEST_INVALID", "reconcile dispositions are incomplete", { field: "dispositions" });
        }
      }
      return transition(intent, ["unresolved"], (current) => {
        const children = mergeChildren(current.children, dispositions);
        // §8: completed(reconciled) once every recorded child is live-bound or
        // provably absent, with zero ambiguous; anything unaccounted stays
        // unresolved with the dispositions recorded.
        const settled = children.length > 0 && children.every((child) => child.disposition === "bound" || child.disposition === "identity_lost");
        if (!settled) return { ...current, children, updatedAt: now() };
        return { ...current, children, state: "completed", reconciled: true, updatedAt: now() };
      });
    },

    async get(key, idempotencyKey) {
      assertIdempotencyKey(idempotencyKey);
      const dir = await managerDir(key, false);
      return dir === undefined ? undefined : readIntent(dir, idempotencyKey);
    },

    async list(key) {
      const dir = await managerDir(key, false);
      return dir === undefined ? [] : listDir(dir);
    },

    listManagers: listManagerKeys,

    async recoverInterrupted(key) {
      const managers = key === undefined ? await listManagerKeys() : [key];
      const recovered: LaunchIntentRecord[] = [];
      for (const manager of managers) {
        const dir = await managerDir(manager, false);
        if (dir === undefined) continue;
        await withManagerLock(dir, async () => {
          for (const intent of await listDir(dir)) {
            if (intent.state !== "effecting") continue;
            const next: LaunchIntentRecord = {
              ...intent,
              state: "unresolved",
              resolution: "interrupted",
              effectCertainty: intent.effectCertainty ?? "unknown",
              updatedAt: now(),
            };
            await writeIntent(dir, next);
            recovered.push(next);
          }
        });
      }
      return recovered;
    },
  };
}
