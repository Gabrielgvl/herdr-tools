/**
 * Environment-shaped keys carry values the owner supplied for a child process.
 * They may hold secrets, so no tool text, no tool details, and no host
 * projection may echo them, at any nesting depth.
 */
const ENVIRONMENT_KEY = /^(env|environment|env_vars|environment_variables|environment_overrides|environmentoverrides)$/i;

/** Depth beyond which a model-visible projection stops descending. */
export const MODEL_SAFE_DEPTH_LIMIT = 32;
/** Marker for a reference that closes a cycle. */
export const CYCLIC_MARKER = "[cyclic]";
/** Marker for a value deeper than `MODEL_SAFE_DEPTH_LIMIT`. */
export const DEPTH_LIMIT_MARKER = "[depth limit]";

export function isEnvironmentKey(key: string): boolean {
  return ENVIRONMENT_KEY.test(key);
}

/**
 * Environment values are strings by contract: `EnvMap` is a string-to-string map
 * and the CLI transports them as strings. A value with no string at any depth
 * therefore cannot carry one.
 */
function carriesText(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.some(carriesText);
  if (typeof value === "object" && value !== null) return Object.values(value).some(carriesText);
  return false;
}

/**
 * Drop an environment-shaped key whenever its value could hold an environment
 * value. The rule is fail-closed on anything string-bearing, at any depth, and it
 * keeps the typed diagnostic records that legitimately use the name — the
 * `herdr_inspect` health `environment` state is presence booleans, never values.
 */
function redactsEnvironment(key: string, value: unknown): boolean {
  return isEnvironmentKey(key) && carriesText(value);
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !redactsEnvironment(key, item))
    .map(([key, item]) => [key, strip(item)]));
}

/**
 * Drop environment-shaped keys at every depth, keeping every other field. This
 * is the single redaction the tools apply to authoritative records they retain
 * as evidence, so the same projection reaches both hosts.
 */
export function withoutEnvironment<T>(value: T): T {
  return strip(value) as T;
}

function project(value: unknown, seen: Set<object>, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  // A non-finite number serializes as JSON `null`; keeping that explicit here
  // means the projection is exactly what the block will contain.
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  // `undefined`, functions, and symbols have no JSON form; an object field with
  // one is dropped and an array element becomes `null`, matching JSON.
  if (typeof value !== "object") return undefined;
  if (depth > MODEL_SAFE_DEPTH_LIMIT) return DEPTH_LIMIT_MARKER;
  if (seen.has(value)) return CYCLIC_MARKER;
  const custom = (value as { toJSON?: unknown }).toJSON;
  if (typeof custom === "function") return project((custom as () => unknown).call(value), seen, depth);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => project(item, seen, depth + 1) ?? null);
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of Object.entries(value)) {
      const projected = project(item, seen, depth + 1);
      // The projection is measured, not the source: a marker that replaced a cycle
      // or a depth-limited branch under an environment key still redacts the key.
      if (projected === undefined || redactsEnvironment(key, projected)) continue;
      entries.push([key, projected]);
    }
    return Object.fromEntries(entries);
  } finally {
    seen.delete(value);
  }
}

/**
 * The one model-boundary projection. It is environment-stripped, cycle-safe,
 * depth-bounded, and JSON-safe by construction, so the caller can serialize the
 * result without a throw and without leaking an environment value that a tool,
 * a CLI response, or a thrown error carried at any depth.
 */
export function modelSafeJson(value: unknown): unknown {
  return project(value, new Set<object>(), 0);
}
