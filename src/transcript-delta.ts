/**
 * The one transcript-delta rule both reviewers use.
 *
 * A pane read returns the latest bounded window, not what changed since the last
 * read, so a reviewer that is handed that window every time re-reads stale output
 * as new evidence. This computes what is actually new by aligning the previous
 * window against the current one, tolerating the window having scrolled.
 */

const TRANSCRIPT_DELTA_LINES = 100;

function samePrefix(previous: string[], current: string[]): number {
  let index = 0;
  while (index < previous.length && index < current.length && previous[index] === current[index]) index += 1;
  return index;
}

export function deltaLines(previous: string[], current: string[]): string[] {
  if (previous.length === 0) return current.slice(-TRANSCRIPT_DELTA_LINES);
  if (current.length >= previous.length && previous.every((line, index) => current[index] === line)) return current.slice(previous.length, previous.length + TRANSCRIPT_DELTA_LINES);
  let overlap = Math.min(previous.length, current.length);
  while (overlap > 0) {
    const priorTail = previous.slice(previous.length - overlap);
    if (priorTail.every((line, index) => line === current[index])) return current.slice(overlap, overlap + TRANSCRIPT_DELTA_LINES);
    overlap -= 1;
  }
  const prefix = samePrefix(previous, current);
  if (prefix === current.length) return [];
  return current.slice(Math.max(prefix, current.length - TRANSCRIPT_DELTA_LINES), current.length);
}
