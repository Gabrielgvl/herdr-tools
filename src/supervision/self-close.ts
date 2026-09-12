/**
 * Correlates a pane close this host initiated through `herdr_pane` with the
 * `pane_closed` wake one of its own supervisors would otherwise send.
 *
 * `begin` marks the exact resolved target just before the close dispatches and
 * returns an idempotent finisher; the finisher's `confirmed` flag is set only
 * when the close's own readback proved success (`reconciled === false`).
 * `consume` is the supervisor's one-wake claim: no live entry wakes normally, a
 * confirmed entry suppresses exactly once, and a still-pending attempt hands
 * back a bounded promise so an absence observed mid-close still suppresses the
 * wake once the success lands. Every failure, unknown outcome, expiry,
 * overflow, and shutdown resolves toward waking — suppression never loses the
 * event or its settlement, only the notification.
 *
 * Bounds: a pending attempt expires 60s after `begin`; a confirmed unconsumed
 * marker expires 60s after confirmation (covering the 30s reconciliation
 * cadence plus socket latency with margin); at most 128 live entries are
 * retained, and admission beyond that fails toward an ordinary wake.
 *
 * ponytail: this is pane-id plus timing correlation, not proof that this host's
 * close caused the observed absence. An unconsumed confirmed marker can still
 * collide with a recycled pane id inside its TTL; if that ceiling ever becomes
 * a requirement, the upgrade path is exact-generation correlation (the
 * launch-side target_generation_refs shape), not a longer TTL or a wider map.
 */

const SELF_CLOSE_PENDING_TTL_MS = 60_000;
const SELF_CLOSE_CONFIRMED_TTL_MS = 60_000;
const SELF_CLOSE_MAX_ENTRIES = 128;

/** Settles one `begin`ed attempt; `confirmed` means the close proved itself. */
export type SelfCloseFinisher = (confirmed: boolean) => void;

export interface SelfCloseTracker {
  /**
   * Start tracking a close of `paneId`. The returned finisher is idempotent and
   * bound to this attempt only: a late call can neither confirm nor delete a
   * newer entry for the same pane. Refused admission returns a no-op finisher.
   */
  begin(paneId: string): SelfCloseFinisher;
  /**
   * Claim this pane's one suppressible wake. `false` when nothing is tracked;
   * `true` for a confirmed, not-yet-consumed success; a bounded promise for an
   * attempt still in flight. A second claim on the same attempt gets `false`.
   */
  consume(paneId: string): boolean | Promise<boolean>;
  /** Permanently retire the tracker: clear timers, resolve pending claims `false`. */
  clear(): void;
}

interface SelfCloseEntry {
  paneId: string;
  /** Monotonic `performance.now()` deadline after which the entry is inert. */
  deadline: number;
  confirmed: boolean;
  claimed: boolean;
  finished: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  waiters: Array<(suppress: boolean) => void>;
}

const noopFinisher: SelfCloseFinisher = () => undefined;

export function createSelfCloseTracker(): SelfCloseTracker {
  const entries = new Map<string, SelfCloseEntry>();
  let cleared = false;

  const now = (): number => performance.now();

  const retire = (entry: SelfCloseEntry, suppress: boolean): void => {
    clearTimeout(entry.timer);
    entries.delete(entry.paneId);
    for (const resolve of entry.waiters.splice(0)) resolve(suppress);
  };

  const rearm = (entry: SelfCloseEntry): void => {
    clearTimeout(entry.timer);
    const timer = setTimeout(() => retire(entry, false), Math.max(0, entry.deadline - now()));
    timer.unref?.();
    entry.timer = timer;
  };

  const begin = (paneId: string): SelfCloseFinisher => {
    if (cleared) return noopFinisher;
    const at = now();
    // Overdue entries are dead regardless of whether their timer already ran.
    for (const entry of [...entries.values()]) {
      if (at >= entry.deadline) retire(entry, false);
    }
    // Re-closing the same pane supersedes the older attempt; its pending claim
    // resolves toward waking rather than inheriting the newer outcome.
    const existing = entries.get(paneId);
    if (existing !== undefined) retire(existing, false);
    // Full means live pending attempts stay put; the new close simply proceeds
    // untracked and its pane_closed wakes normally.
    if (entries.size >= SELF_CLOSE_MAX_ENTRIES) return noopFinisher;
    const entry: SelfCloseEntry = {
      paneId,
      deadline: at + SELF_CLOSE_PENDING_TTL_MS,
      confirmed: false,
      claimed: false,
      finished: false,
      timer: undefined,
      waiters: [],
    };
    entries.set(paneId, entry);
    rearm(entry);
    return (confirmed) => {
      if (entry.finished) return;
      entry.finished = true;
      // A retired or replaced attempt — expiry, consumption, a newer begin, or
      // clear() — cannot be resurrected by a late finisher.
      if (entries.get(paneId) !== entry) return;
      if (now() >= entry.deadline) {
        retire(entry, false);
        return;
      }
      if (entry.claimed) {
        // The claim was already made; the attempt's outcome decides it and the
        // entry is spent either way.
        retire(entry, confirmed);
        return;
      }
      if (!confirmed) {
        retire(entry, false);
        return;
      }
      entry.confirmed = true;
      entry.deadline = now() + SELF_CLOSE_CONFIRMED_TTL_MS;
      rearm(entry);
    };
  };

  const consume = (paneId: string): boolean | Promise<boolean> => {
    const entry = entries.get(paneId);
    if (entry === undefined) return false;
    if (now() >= entry.deadline) {
      retire(entry, false);
      return false;
    }
    if (entry.confirmed) {
      retire(entry, true);
      return true;
    }
    if (entry.claimed) return false;
    // Claimed pending attempts keep counting against the cap until the
    // finisher or the begin-time deadline settles them.
    entry.claimed = true;
    return new Promise<boolean>((resolve) => {
      entry.waiters.push(resolve);
    });
  };

  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    for (const entry of [...entries.values()]) retire(entry, false);
  };

  return { begin, consume, clear };
}
