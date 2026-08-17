/** Why a queued call never ran. */
export type QueueRefusal = "aborted" | "closed";

/**
 * Session-scoped FIFO serialization for the shared tools that declare
 * `executionMode: "sequential"`.
 *
 * The Pi host schedules those tools one at a time; an MCP client may have many
 * `tools/call` requests in flight, so without this queue two mutations could
 * interleave their read/validate/mutate/read sequences and both report success.
 *
 * Each caller takes a ticket before waiting: it awaits its predecessor's ticket
 * and publishes its own as the next tail. The ticket is resolve-only and is
 * released in `finally`, so a failing or cancelled call cannot poison the queue,
 * and order is exactly the order calls arrived.
 */
export class SequentialToolQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  /**
   * Run `call` after every earlier queued call has settled. Cancellation and
   * shutdown are honored at the moment the turn arrives, so a queued call whose
   * request was cancelled, or that is still waiting when the host shuts down,
   * never executes and reports `refuse` instead.
   */
  async serialize<T>(signal: AbortSignal, call: () => Promise<T>, refuse: (reason: QueueRefusal) => T): Promise<T> {
    const turn = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await turn;
      if (this.closed) return refuse("closed");
      if (signal.aborted) return refuse("aborted");
      return await call();
    } finally {
      release();
    }
  }

  /** Refuse every call still waiting for a turn, so shutdown is deterministic. */
  close(): void {
    this.closed = true;
  }
}
