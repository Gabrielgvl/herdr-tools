/**
 * §11 best-effort idle hints (node N2.5).
 *
 * After a run-scoped event persists to the owner mailbox, the sink re-reads
 * the owner pane with one fresh `pane get` and sends exactly one
 * `agent.prompt` — carrying the unread count and IDs, the mailbox path, and
 * the MCP-surface read pointer — only when the pane is `idle`/`done`,
 * still carries the recorded owner session, and its kind is in the qualified
 * set. Busy, unknown, unproven, unsupported (`agy`), and non-qualified kinds
 * get zero writes: the mailbox is the durable path. Hints are coalesced to at
 * most one per manager session per `IDLE_HINT_COALESCE_MS`; a failed hint is
 * logged and dropped, never retried into a busy pane, and never blocks event
 * persistence or ownership operations. No Enter, no key synthesis.
 *
 * The qualified set is a daemon start option. The production default in
 * src/daemon/main.ts is {pi, claude, devin} — the set the C9 canary proved
 * consumes the hint as a real turn (N5.2); a daemon started without the
 * option still writes nothing.
 */

import { join } from "node:path";
import type { JsonEnvelope } from "../cli.js";
import type { AgentSessionIdentity } from "../messages/prompt.js";
import { paneFrom, stateOf } from "../messages/prompt-target.js";
import { managerSessionKey } from "./intents.js";
import type { DaemonNamespace } from "./namespace.js";

/** One hint per manager session per this window (spec §11). */
export const IDLE_HINT_COALESCE_MS = 5_000;
/** A hint attempt is bounded so a wedged endpoint cannot pin the writer's tail. */
const IDLE_HINT_TIMEOUT_MS = 10_000;

/** Kinds structurally incapable of consuming a pane prompt — never hinted, even if qualified. */
const UNSUPPORTED_KINDS = new Set(["agy"]);

// C9 finding: a devin owner consumes the hint as a turn only when it was
// launched with `--permission-mode dangerous` — under the default `auto`
// mode the mailbox-read turn stalls at the interactive tool-approval dialog
// (pane state `blocked`, never settles). Supervised devin owners must run
// non-interactively for hints to be consumed; the hint still lands durably
// in the mailbox either way.

/** The run's current owner — the supervisor's recorded owner, re-targeted on transfer/claim. */
export interface IdleHintOwner {
  paneId: string;
  session: AgentSessionIdentity | null;
}

/** One persisted mailbox event eligible for an idle hint. */
export interface IdleHintEvent {
  runId: string;
  /** The durable mailbox event ID that just landed. */
  eventId: string;
  owner: IdleHintOwner;
}

/** The seam a supervisor fires once per persisted run event. */
export type IdleHintSink = (hint: IdleHintEvent) => void;

/** The narrow Herdr surface a hint needs — `HerdrCli` satisfies it. */
export interface IdleHintCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
  prompt(target: string, text: string, signal: AbortSignal): Promise<JsonEnvelope>;
}

export interface IdleHintsOptions {
  cli: IdleHintCli;
  /** Unread listing for the hint body's count and IDs (`Mailbox` satisfies it). */
  mailbox: { list(managerSessionKey: string): Promise<string[]> };
  /** The daemon namespace the mailbox path is rendered from. */
  namespace: DaemonNamespace;
  /**
   * Kinds proven to consume a pane prompt as a turn. Unset means EMPTY — a
   * daemon started without this option writes nothing even for idle panes of
   * candidate kinds. The stock daemon passes the C9-proved {pi, claude,
   * devin} set (N5.2).
   */
  qualifiedKinds?: readonly string[];
  coalesceMs?: number;
  now?: () => number;
  /** Daemon lifetime abort — an in-flight hint ends with the daemon. */
  signal?: AbortSignal;
  /** Visible drop sink; defaults to stderr. */
  log?: (line: string) => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact four-field identity — the pane must still carry the recorded owner session. */
function sameSession(value: unknown, session: AgentSessionIdentity): boolean {
  return record(value)
    && value.source === session.source
    && value.agent === session.agent
    && value.kind === session.kind
    && value.value === session.value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createIdleHints(options: IdleHintsOptions): IdleHintSink {
  const qualified = new Set(options.qualifiedKinds ?? []);
  const coalesceMs = options.coalesceMs ?? IDLE_HINT_COALESCE_MS;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  /** managerSessionKey → last send attempt; one send per window, bursts coalesce. */
  const lastSent = new Map<string, number>();
  /** Keys with an in-flight delivery; the in-flight send's fresh reads cover the burst. */
  const inflight = new Set<string>();

  async function deliver(owner: IdleHintOwner, session: AgentSessionIdentity, key: string): Promise<void> {
    const signal = options.signal === undefined
      ? AbortSignal.timeout(IDLE_HINT_TIMEOUT_MS)
      : AbortSignal.any([options.signal, AbortSignal.timeout(IDLE_HINT_TIMEOUT_MS)]);
    // Fresh read every event — a cached pane state is not proof of idle.
    const pane = paneFrom((await options.cli.runJson(["pane", "get", owner.paneId], signal)).result, owner.paneId);
    // Unproven: the pane no longer holds the recorded owner session.
    if (!sameSession(pane.agent_session, session)) return;
    const state = stateOf(pane);
    if (state !== "idle" && state !== "done") return;
    const ids = await options.mailbox.list(key);
    if (ids.length === 0) return;
    const unread = join(options.namespace.dir, "mailbox", key, "unread");
    // §11: the pointer is the caller's own MCP surface — herdr_status carries
    // the read projection and herdr_run the ack; there is no CLI path.
    const body = `herdr mailbox: ${ids.length} unread (${ids.join(", ")}) at ${unread}; read via your MCP surface (herdr_status / executor → MCP)`;
    lastSent.set(key, now());
    await options.cli.prompt(owner.paneId, body, signal);
  }

  return (hint) => {
    try {
      const session = hint.owner.session;
      // Unproven owner session, unsupported kind, or a kind the owner has not
      // qualified — the mailbox alone carries the event.
      if (session === null || qualified.size === 0 || UNSUPPORTED_KINDS.has(session.agent) || !qualified.has(session.agent)) return;
      const key = managerSessionKey(session);
      if (inflight.has(key)) return;
      const last = lastSent.get(key);
      if (last !== undefined && now() - last < coalesceMs) return;
      inflight.add(key);
      void deliver(hint.owner, session, key)
        .catch((error: unknown) => log(`herdr-tools-daemon hint dropped: ${errorText(error)}`))
        .finally(() => inflight.delete(key));
    } catch (error) {
      // A hint that cannot even be scheduled is dropped visibly, never thrown
      // into the supervisor's event path.
      log(`herdr-tools-daemon hint dropped: ${errorText(error)}`);
    }
  };
}
