import type { JsonEnvelope, HerdrCli } from "./cli.js";

const MAX_EVIDENCE_CHARS = 2_000;
const MAX_OBJECT_KEYS = 24;
const MAX_ARRAY_ITEMS = 16;
const ENVIRONMENT_KEY = /^(env|environment|env_vars|environment_variables|environment_overrides|environmentoverrides)$/i;

function boundedString(value: string): string {
  return value.length > MAX_EVIDENCE_CHARS ? `${value.slice(0, MAX_EVIDENCE_CHARS)}...[truncated]` : value;
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundedString(value);
  if (depth > 5) return "[nested value omitted]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrub(item, depth + 1));
    return value.length > items.length ? [...items, `[${value.length - items.length} items omitted]`] : items;
  }
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).filter(([key]) => !ENVIRONMENT_KEY.test(key)).slice(0, MAX_OBJECT_KEYS);
  const result: Record<string, unknown> = Object.fromEntries(entries.map(([key, item]) => [boundedString(key), scrub(item, depth + 1)]));
  if (Object.keys(value).length > entries.length) result["[fields omitted]"] = Object.keys(value).length - entries.length;
  return result;
}

export function boundedEvidence(value: unknown): unknown {
  const sanitized = scrub(value);
  try {
    const serialized = JSON.stringify(sanitized);
    if (serialized.length <= MAX_EVIDENCE_CHARS) return sanitized;
    return { summary: boundedString(serialized), truncated: true };
  } catch {
    return { summary: "[evidence unavailable]", truncated: true };
  }
}

export function errorEvidence(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return { message: boundedString(String(error)) };
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  const result: Record<string, unknown> = { message: boundedString(typeof candidate.message === "string" ? candidate.message : String(error)) };
  if (typeof candidate.code === "string") result.code = boundedString(candidate.code);
  if (candidate.details !== undefined) result.details = boundedEvidence(candidate.details);
  return result;
}

export interface CloseReadbackResult<TSnapshot> {
  operationId?: string;
  mutationResult?: unknown;
  readback: TSnapshot;
  reconciled: boolean;
}

export interface CloseReadbackOptions<TSnapshot> {
  cli: HerdrCli;
  argv: string[];
  signal: AbortSignal;
  targetId: string;
  readback: (signal: AbortSignal) => Promise<TSnapshot>;
  targetPresent: (snapshot: TSnapshot) => boolean;
  summarize: (snapshot: TSnapshot) => unknown;
}

export async function closeWithReadback<TSnapshot>(options: CloseReadbackOptions<TSnapshot>): Promise<CloseReadbackResult<TSnapshot>> {
  if (options.signal.aborted) {
    throw Object.assign(new Error("Operation aborted before close dispatch"), { code: "ABORTED" });
  }

  let mutation: JsonEnvelope | undefined;
  let mutationError: unknown;
  try {
    mutation = await options.cli.runJson(options.argv, options.signal, true);
  } catch (error) {
    mutationError = error;
  }

  const readbackSignal = new AbortController().signal;
  let after: TSnapshot | undefined;
  let readbackError: unknown;
  try {
    after = await options.readback(readbackSignal);
  } catch (error) {
    readbackError = error;
  }

  if (after !== undefined && !options.targetPresent(after)) {
    if (mutation) {
      return {
        operationId: mutation.id,
        mutationResult: boundedEvidence(mutation.result),
        readback: after,
        reconciled: false
      };
    }
    return { readback: after, reconciled: true };
  }

  throw Object.assign(new Error(`Close mutation is uncertain for target ${options.targetId}`), {
    code: "MUTATION_UNCERTAIN",
    details: {
      targetId: options.targetId,
      original: mutation ? { operationId: mutation.id, result: boundedEvidence(mutation.result) } : errorEvidence(mutationError),
      readback: readbackError
        ? errorEvidence(readbackError)
        : after === undefined
          ? { status: "unavailable" }
          : { status: "target_present", postState: boundedEvidence(options.summarize(after)) }
    }
  });
}
