/**
 * `launch` — the intent-gated daemon launch (durable-supervisor §6): the
 * caller's claimed identity is verified against one fresh `session.snapshot`
 * (D2a) and its canonical project root becomes `deps.cwd`; the intent ledger
 * mints the launch ID and rules begin / replay / conflict before any effect;
 * the pipeline's before-first-effect hook carries the `effecting` write; and
 * the launch result settles the intent `completed`, `failed`, or `unresolved`
 * by the effect certainty the pipeline itself computed — never a fabricated
 * terminal state.
 */

import { Value } from "typebox/value";
import { realpath, stat } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IdempotencyKeySchema, LaunchTaskSchema, type LaunchTask } from "../../launch-schema.js";
import {
  createLaunchTool,
  type LaunchEffectCertainty,
  type LaunchResult,
} from "../../tools/launch.js";
import type { HandoffAllocator } from "../../handoff.js";
import { createPreflight } from "../../tool-surface.js";
import {
  daemonContextResolver,
  daemonRequestError,
  parseCallerClaim,
  verifyDaemonCaller,
  type DaemonRuntime,
  type VerifiedDaemonCaller,
} from "../runtime.js";
import { DaemonRequestError } from "../protocol.js";
import type {
  LaunchIntentChild,
  LaunchIntentChildDisposition,
  LaunchIntentRecord,
  LaunchIntentResolution,
  LaunchIntentState,
} from "../intents.js";

export type DaemonLaunchReply =
  | {
      kind: "launch";
      launchId: string;
      state: LaunchIntentState;
      /** The pipeline executed now — `true` when it resumed a pre-effect intent. */
      resumed: boolean;
      result: LaunchResult;
      children: LaunchIntentChild[];
    }
  | {
      kind: "launch";
      launchId: string;
      state: LaunchIntentState;
      /** Recorded state returned with zero effect — `replayed` is never true. */
      replayed: false;
      children: LaunchIntentChild[];
      resolution?: LaunchIntentResolution;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCode(value: unknown): string | undefined {
  /* c8 ignore next -- every caller supplies a typed code or undefined; the non-string and unbounded sides guard a foreign error shape. */
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : undefined;
}

/** A bounded typed code carried by the thrown cause, when it carries one. */
function thrownCode(error: unknown): string | undefined {
  /* c8 ignore next -- the pipeline only ever throws a LaunchError record; a foreign thrown shape still settles without a code. */
  return safeCode(isRecord(error) ? error.code : undefined);
}

/** The certainty a thrown launch carried in its own details, else fail-closed `unknown`. */
function thrownCertainty(error: unknown): LaunchEffectCertainty {
  /* c8 ignore next -- the pipeline throws only LaunchError records; a foreign thrown shape stays fail-closed. */
  const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
  const value = details?.effectCertainty;
  /* c8 ignore next -- post-effect failures land in the launch result, not a throw, so `partial`/`confirmed` never arrive here. */
  return value === "absent" || value === "partial" || value === "unknown" || value === "confirmed" ? value : "unknown";
}

/**
 * The caller's claimed canonical project root (§6 D2a): it must canonicalize
 * to itself and be an accessible directory — the verified value becomes
 * `deps.cwd`, never a silently substituted path.
 */
async function verifyProjectRoot(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.length === 0) throw new DaemonRequestError("PROJECT_ROOT_UNVERIFIED");
  let resolved: string;
  let stats;
  try {
    resolved = await realpath(value);
    stats = await stat(resolved);
  } catch {
    throw new DaemonRequestError("PROJECT_ROOT_UNVERIFIED");
  }
  if (resolved !== value || !stats.isDirectory()) throw new DaemonRequestError("PROJECT_ROOT_UNVERIFIED");
  return resolved;
}

/**
 * Wrap the run allocator so every persisted run joins the intent record while
 * `effecting` — the shrink-the-window write the ledger describes. A record
 * failure fails the child closed: an unrecorded effect is the exact hazard
 * intents exist to prevent.
 */
function intentAllocator(allocator: HandoffAllocator, runtime: DaemonRuntime, intent: LaunchIntentRecord, observed: LaunchIntentChild[]): HandoffAllocator {
  return {
    allocate: () => allocator.allocate(),
    open: (runId) => allocator.open(runId),
    persist: async (run, identity, provenance) => {
      await allocator.persist(run, identity, provenance);
      const child = { name: identity.child.agentName, runId: run.runId };
      observed.push(child);
      await runtime.intents.recordChildren(intent, [child]);
    },
    selectCandidate: (run, operatingPointId, agentKind, resolvedModel) => allocator.selectCandidate(run, operatingPointId, agentKind, resolvedModel),
  };
}

/**
 * Settle-time dispositions merged onto the progressively recorded children:
 * `bound` for launched children, `ambiguous` for failed ones — reconcile
 * re-classifies them against live evidence before the intent can close.
 */
function settleChildren(observed: LaunchIntentChild[], result: LaunchResult | undefined): LaunchIntentChild[] {
  const dispositions = new Map<string, LaunchIntentChildDisposition>();
  for (const child of result?.children ?? []) {
    if (child.state === "launched") dispositions.set(child.target, "bound");
    if (child.state === "failed") dispositions.set(child.target, "ambiguous");
  }
  return observed.map((child) => {
    const disposition = dispositions.get(child.name);
    /* c8 ignore next -- a recorded child always produced a same-named result child; only a thrown pre-persist launch reaches here, with `observed` empty. */
    return disposition === undefined ? child : { ...child, disposition };
  });
}

async function executeDaemonLaunch(
  runtime: DaemonRuntime,
  caller: VerifiedDaemonCaller,
  intent: LaunchIntentRecord,
  task: LaunchTask,
  projectRoot: string,
  resumed: boolean,
  signal: AbortSignal,
): Promise<DaemonLaunchReply> {
  const observed: LaunchIntentChild[] = [];
  const tool = createLaunchTool({
    // Host/test seams first — the daemon-owned trust boundary (verified
    // context, verified cwd, the intent allocator, the effecting hook) is
    // applied after them and can never be overridden.
    ownership: runtime.ownership,
    supervision: runtime.supervision,
    queueFlush: runtime.queueFlush,
    attachments: runtime.attachments,
    recipients: runtime.recipients,
    preflight: createPreflight(runtime.cli),
    eventWriter: runtime.eventWriter,
    ...(runtime.launchDeps ?? {}),
    cli: runtime.cli,
    context: caller.context,
    contextResolver: daemonContextResolver(runtime.cli, caller),
    cwd: projectRoot,
    handoffs: intentAllocator(runtime.allocator, runtime, intent, observed),
    beforeFirstEffect: { launchId: intent.launchId, hook: async () => { await runtime.intents.markEffecting(intent); } },
  });
  let result: LaunchResult | undefined;
  let thrown: unknown;
  try {
    const executed = await tool.execute(`daemon-${intent.launchId}`, task, signal, undefined, { cwd: projectRoot, signal } as ExtensionContext);
    result = executed.details as LaunchResult;
  } catch (error) {
    thrown = error;
  }
  const children = settleChildren(observed, result);
  let settled: LaunchIntentRecord;
  try {
    if (result === undefined) {
      const failureCode = thrownCode(thrown);
      settled = await runtime.intents.fail(intent, {
        effectCertainty: thrownCertainty(thrown),
        /* c8 ignore next -- the pipeline only throws coded errors; an uncodeable thrown shape still settles without a code. */
        ...(failureCode === undefined ? {} : { failureCode }),
        children,
      });
    } else if (result.outcome === "failed") {
      const failureCode = result.error === undefined ? undefined : safeCode(result.error.code);
      settled = await runtime.intents.fail(intent, {
        // `absent` only when nothing durable was recorded for any child;
        // a recorded run is itself a launch effect, so it is never `absent`.
        effectCertainty: children.length === 0 ? "absent" : "partial",
        ...(failureCode === undefined ? {} : { failureCode }),
        children,
      });
    } else if (result.outcome === "partial") {
      settled = await runtime.intents.fail(intent, { effectCertainty: "partial", children });
    } else {
      settled = await runtime.intents.complete(intent, children);
    }
  } catch (error) {
    throw daemonRequestError(error);
  }
  if (result === undefined) throw daemonRequestError(thrown, "LAUNCH_FAILED");
  return {
    kind: "launch",
    launchId: settled.launchId,
    state: settled.state,
    resumed,
    result,
    children: settled.children,
  };
}

/**
 * The `launch` request: `{identity, projectRoot, task, idempotencyKey}`. One
 * fresh snapshot verifies the caller (D2a) before the intent store arbitrates
 * begin / replay / conflict; a still-`recorded` intent resumes under its
 * original launch ID, and a concurrent executor for the same binding waits it
 * out rather than launching a duplicate.
 */
export async function handleDaemonLaunch(runtime: DaemonRuntime, params: Record<string, unknown>): Promise<DaemonLaunchReply> {
  const signal = new AbortController().signal;
  const caller = await verifyDaemonCaller(runtime.cli, parseCallerClaim(params.identity), signal);
  const projectRoot = await verifyProjectRoot(params.projectRoot);
  const idempotencyKey = params.idempotencyKey;
  if (!Value.Check(IdempotencyKeySchema, idempotencyKey)) throw new DaemonRequestError("REQUEST_INVALID");
  const task = params.task;
  if (!Value.Check(LaunchTaskSchema, task)) throw new DaemonRequestError("REQUEST_INVALID");
  const flightKey = `${caller.managerSessionKey}/${idempotencyKey}`;
  for (;;) {
    let begun;
    try {
      begun = await runtime.intents.begin({ managerSessionKey: caller.managerSessionKey, idempotencyKey, task, projectRoot });
    } catch (error) {
      throw daemonRequestError(error);
    }
    if (begun.kind === "launch") {
      const prior = runtime.inflight.get(flightKey);
      if (prior !== undefined) {
        // Another request is executing this binding's resume right now: wait
        // for it, then re-begin — the settled state answers as a replay.
        await prior.catch(() => undefined);
        continue;
      }
      const execution = executeDaemonLaunch(runtime, caller, begun.intent, task, projectRoot, begun.resumed, signal);
      runtime.inflight.set(flightKey, execution);
      try {
        return await execution;
      } finally {
        runtime.inflight.delete(flightKey);
      }
    }
    const intent = begun.intent;
    return {
      kind: "launch",
      launchId: intent.launchId,
      state: intent.state,
      replayed: false,
      children: intent.children,
      ...(intent.resolution === undefined ? {} : { resolution: intent.resolution }),
    };
  }
}
