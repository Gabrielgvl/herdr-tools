import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { isAlias, isMap, isSeq, parseDocument, type Node } from "yaml";
import { normalizeScopedResourcePath } from "./profiles/parser.js";
import { AGY_MODES, CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, DEVIN_PERMISSION_MODES, THINKING_LEVELS, type AgyMode, type ClaudeEffort, type ClaudePermissionMode, type DevinPermissionMode, type ThinkingLevel } from "./profiles/types.js";
import { TIER_ENVELOPES, type ClassBound, type CostClass, type LatencyClass, type QualityTier } from "./routing-policy.js";

export class CatalogError extends Error {
  readonly code = "INVALID_CATALOG" as const;
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CatalogError";
  }
}

export const RUNNER_KINDS = ["pi", "claude", "agy", "devin"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

export const MAX_CATALOG_BYTES = 64 * 1024;
/** Bundled catalog location, relative to the package (scope) root. */
export const CATALOG_PATH = "herdr-profiles/catalog.yaml";

/** A below-runner quota override: fields present merge over the runner's quota tuple. */
export interface QuotaOverride {
  billingProduct?: string;
  account?: string;
}

/**
 * The runner+model pair an availability or launch-failure probe resolves a
 * quota key for (ADR-037): the chain-era per-candidate provider/quota/account
 * overrides are gone — attribution comes from the reviewed model entries.
 */
export interface AvailabilitySubject {
  runner: RunnerKind;
  model: string;
}

/** The availability tuple: provider + billing product + account + scope, never a runner name. */
export interface QuotaKey {
  provider: string;
  billingProduct: string;
  account: string;
  scope: string;
}

export type QuotaSourceKind = "floor" | "proactive" | "coarse";
export interface QuotaSource {
  name: string;
  kind: QuotaSourceKind;
  runner?: RunnerKind;
}

export interface RunnerDefaults {
  timeoutMinutes: number;
  sessionPersistence: boolean;
  thinking?: ThinkingLevel;
  effort?: ClaudeEffort;
  mode?: AgyMode;
  permissionMode?: ClaudePermissionMode | DevinPermissionMode;
}

/**
 * The fixed launch mechanics a runner integration actually has. The values are
 * mechanism facts, not preferences: Pi has an exact skill allowlist and a
 * session opt-out; Claude's plugin dirs are additive; AGY bootstraps
 * interactively; Devin has no prompt channel at all.
 */
export interface RunnerPlumbing {
  sessionPersistence: "required" | "optional";
  promptDelivery: "file" | "bootstrap" | "none";
  skillSelection: "exact" | "additive" | "ambient";
  toolSelection: "allowlist" | "ambient";
}

export interface RunnerPools {
  tools: readonly string[];
  extensions: readonly string[];
  skills: readonly string[];
  plugins: readonly string[];
  mcp: readonly string[];
}

/**
 * One reviewed model entry. `provider`/`quota` attribute the model's
 * availability to a quota domain below the runner (Pi spans openai-codex,
 * zai, and opencode-go); absent fields fall back to the runner's tuple.
 * `supportedReasoning` is the model's own declared reasoning axis — absent
 * or empty means the model is unreasoned by design and yields a single
 * bare operating point.
 */
export interface ModelEntry {
  model: string;
  provider?: string;
  quota?: QuotaOverride;
  supportedReasoning?: readonly (ThinkingLevel | ClaudeEffort)[];
}

export interface RunnerEntry {
  kind: RunnerKind;
  /** The reviewed model set; every operating point generates from one of these. */
  models: readonly ModelEntry[];
  quota: QuotaKey;
  defaults: RunnerDefaults;
  plumbing: RunnerPlumbing;
  pools: RunnerPools;
}

export interface McpServer {
  plugin: string;
}

/** Reviewed per-point metadata (ADR-037): the catalog-declared cost and latency classes. */
export interface PointPolicy {
  readonly costClass: CostClass;
  readonly latencyClass: LatencyClass;
}

/** A generated operating point before its reviewed classes are joined. */
interface GeneratedPoint {
  /** Opaque stable id — `${runner}:${model}:${reasoning}`, the reasoning segment omitted when empty or model-encoded. Never parsed or split. */
  readonly id: string;
  readonly runner: RunnerKind;
  readonly model: string;
  readonly reasoning?: ThinkingLevel | ClaudeEffort;
  /** Provider attribution below the runner — pi/codex, pi/zai, and pi/opencode-go are distinct domains. */
  readonly provider: string;
  /** The merged quota tuple this point's availability is keyed under. */
  readonly quota: QuotaKey;
}

/** One exact runner + model + runner-native reasoning combination carrying its reviewed classes. */
export interface OperatingPoint extends GeneratedPoint, PointPolicy {}

export interface CatalogSource {
  path: string;
  scopeRoot: string;
}

export interface Catalog {
  version: 2;
  runners: ReadonlyMap<RunnerKind, RunnerEntry>;
  /** Reviewed skill trees (resolved to absolute paths), the Pi `--skill` unit. */
  skills: readonly string[];
  /** Reviewed plugin roots (resolved to absolute paths), the Claude `--plugin-dir` unit. */
  plugins: readonly string[];
  mcpServers: ReadonlyMap<string, McpServer>;
  quotaSources: readonly QuotaSource[];
  /**
   * Generated operating points joined with their reviewed policy classes.
   * Always populated by parseCatalog; optional so hand-built Catalog values
   * authored before ADR-037 stay valid. Empty when the file declares no
   * pointPolicy — an unreviewed combination is never an operating point.
   */
  points?: readonly OperatingPoint[];
  /** The validated pointPolicy map, keyed by exact point id. Empty when the file declares none. */
  pointPolicy?: ReadonlyMap<string, PointPolicy>;
  /** sha256 hex over the raw catalog bytes — the catalog revision recorded in decision evidence. */
  catalogRevision?: string;
  source: CatalogSource;
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new CatalogError(message, details);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) fail(`${field} must be a non-empty single-line string`, { field });
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}`, { field, key });
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`, { field });
  const list = value.map((item, index) => stringField(item, `${field}[${index}]`));
  if (new Set(list).size !== list.length) fail(`${field} must not contain duplicates`, { field });
  return list;
}

/** Same discipline as profile frontmatter: strict core schema, no anchors, aliases, or tags. */
function validateNode(node: Node | null): void {
  if (node === null) return;
  if (isAlias(node) || ("anchor" in node && node.anchor !== undefined) || node.tag !== undefined) fail("YAML anchors, aliases, and tags are not supported");
  if (isMap(node)) {
    for (const item of node.items) {
      validateNode(item.key as Node | null);
      validateNode(item.value as Node | null);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) validateNode(item as Node | null);
  }
}

function scopedPaths(value: unknown, field: string, scopeRoot: string): string[] {
  return uniqueStrings(value, field).map((item) => {
    try {
      return normalizeScopedResourcePath(item, field, scopeRoot);
    } catch (error) {
      fail((error as Error).message, { field });
    }
  });
}

/** A runner pool entry must name a member of the reviewed set — never a grant outside it. */
function poolPaths(value: unknown, field: string, scopeRoot: string, reviewed: readonly string[]): string[] {
  const paths = scopedPaths(value, field, scopeRoot);
  const set = new Set(reviewed);
  for (const path of paths) if (!set.has(path)) fail(`${field} names a resource outside the reviewed set`, { field, path });
  return paths;
}

function poolNames(value: unknown, field: string, reviewed: Iterable<string>): string[] {
  const names = uniqueStrings(value, field);
  const set = new Set(reviewed);
  for (const name of names) if (!set.has(name)) fail(`${field} names a resource outside the reviewed set`, { field, name });
  return names;
}

function quotaKey(value: unknown, field: string): QuotaKey {
  if (!record(value)) fail(`${field} must be an object`, { field });
  exactKeys(value, ["provider", "billingProduct", "account", "scope"], field);
  return {
    provider: stringField(value.provider, `${field}.provider`),
    billingProduct: stringField(value.billingProduct, `${field}.billingProduct`),
    account: stringField(value.account, `${field}.account`),
    scope: stringField(value.scope, `${field}.scope`),
  };
}

function timeoutMinutes(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 60) fail(`${field}.timeoutMinutes must be an integer from 1 through 60`, { field });
  return value as number;
}

function runnerDefaults(kind: RunnerKind, value: unknown): RunnerDefaults {
  const field = `runners.${kind}.defaults`;
  if (!record(value)) fail(`${field} must be an object`, { field });
  const timeout = timeoutMinutes(value.timeoutMinutes, field);
  if (typeof value.sessionPersistence !== "boolean") fail(`${field}.sessionPersistence must be a boolean`, { field });
  const sessionPersistence = value.sessionPersistence;
  if (kind === "pi") {
    exactKeys(value, ["thinking", "timeoutMinutes", "sessionPersistence"], field);
    if (!THINKING_LEVELS.includes(value.thinking as ThinkingLevel)) fail(`${field}.thinking is invalid`, { field });
    return { timeoutMinutes: timeout, sessionPersistence, thinking: value.thinking as ThinkingLevel };
  }
  if (kind === "claude") {
    exactKeys(value, ["effort", "permissionMode", "timeoutMinutes", "sessionPersistence"], field);
    if (!CLAUDE_EFFORTS.includes(value.effort as ClaudeEffort)) fail(`${field}.effort is invalid`, { field });
    if (!CLAUDE_PERMISSION_MODES.includes(value.permissionMode as ClaudePermissionMode)) fail(`${field}.permissionMode is invalid`, { field });
    if (!sessionPersistence) fail(`${field}.sessionPersistence must be true: Claude launches are interactive`, { field });
    return { timeoutMinutes: timeout, sessionPersistence, effort: value.effort as ClaudeEffort, permissionMode: value.permissionMode as ClaudePermissionMode };
  }
  if (kind === "agy") {
    exactKeys(value, ["mode", "timeoutMinutes", "sessionPersistence"], field);
    if (!AGY_MODES.includes(value.mode as AgyMode)) fail(`${field}.mode is invalid`, { field });
    if (!sessionPersistence) fail(`${field}.sessionPersistence must be true: AGY launches are interactive`, { field });
    return { timeoutMinutes: timeout, sessionPersistence, mode: value.mode as AgyMode };
  }
  exactKeys(value, ["permissionMode", "timeoutMinutes", "sessionPersistence"], field);
  if (!DEVIN_PERMISSION_MODES.includes(value.permissionMode as DevinPermissionMode)) fail(`${field}.permissionMode is invalid`, { field });
  if (!sessionPersistence) fail(`${field}.sessionPersistence must be true: Devin sessions always persist`, { field });
  return { timeoutMinutes: timeout, sessionPersistence, permissionMode: value.permissionMode as DevinPermissionMode };
}

const PLUMBING_MECHANISMS: Record<RunnerKind, Record<keyof RunnerPlumbing, readonly string[]>> = {
  pi: { sessionPersistence: ["optional"], promptDelivery: ["file"], skillSelection: ["exact"], toolSelection: ["allowlist"] },
  claude: { sessionPersistence: ["required"], promptDelivery: ["file"], skillSelection: ["additive"], toolSelection: ["allowlist"] },
  agy: { sessionPersistence: ["required"], promptDelivery: ["bootstrap"], skillSelection: ["ambient"], toolSelection: ["ambient"] },
  devin: { sessionPersistence: ["required"], promptDelivery: ["none"], skillSelection: ["ambient"], toolSelection: ["ambient"] },
};

function runnerPlumbing(kind: RunnerKind, value: unknown): RunnerPlumbing {
  const field = `runners.${kind}.plumbing`;
  if (!record(value)) fail(`${field} must be an object`, { field });
  exactKeys(value, ["sessionPersistence", "promptDelivery", "skillSelection", "toolSelection"], field);
  const allowed = PLUMBING_MECHANISMS[kind];
  const pick = <K extends keyof RunnerPlumbing>(key: K): RunnerPlumbing[K] => {
    const v = stringField(value[key], `${field}.${key}`);
    if (!allowed[key].includes(v)) fail(`${field}.${key} must be one of ${allowed[key].join(", ")} for ${kind}`, { field: `${field}.${key}`, value: v });
    return v as RunnerPlumbing[K];
  };
  return { sessionPersistence: pick("sessionPersistence"), promptDelivery: pick("promptDelivery"), skillSelection: pick("skillSelection"), toolSelection: pick("toolSelection") };
}

/** The pool fields a runner can actually consume; AGY and Devin select nothing. */
const RUNNER_POOL_FIELDS: Record<RunnerKind, readonly (keyof RunnerPools)[]> = {
  pi: ["tools", "extensions", "skills", "mcp"],
  claude: ["tools", "plugins", "mcp"],
  agy: [],
  devin: [],
};

function runnerPools(kind: RunnerKind, value: unknown, scopeRoot: string, skills: readonly string[], plugins: readonly string[], mcp: ReadonlyMap<string, McpServer>): RunnerPools {
  const field = `runners.${kind}.pools`;
  const fields = RUNNER_POOL_FIELDS[kind];
  if (value === undefined) {
    if (fields.length === 0) return { tools: [], extensions: [], skills: [], plugins: [], mcp: [] };
    fail(`${field} must be declared for ${kind}`, { field });
  }
  if (!record(value)) fail(`${field} must be an object`, { field });
  for (const key of Object.keys(value)) if (!(fields as readonly string[]).includes(key)) fail(`${field} field ${key} is not consumable by ${kind}`, { field, key });
  const pools: RunnerPools = { tools: [], extensions: [], skills: [], plugins: [], mcp: [] };
  if (value.tools !== undefined) pools.tools = uniqueStrings(value.tools, `${field}.tools`);
  if (value.extensions !== undefined) pools.extensions = scopedPaths(value.extensions, `${field}.extensions`, scopeRoot);
  if (value.skills !== undefined) pools.skills = poolPaths(value.skills, `${field}.skills`, scopeRoot, skills);
  if (value.plugins !== undefined) pools.plugins = poolPaths(value.plugins, `${field}.plugins`, scopeRoot, plugins);
  if (value.mcp !== undefined) pools.mcp = poolNames(value.mcp, `${field}.mcp`, mcp.keys());
  return pools;
}

function quotaOverride(value: unknown, field: string): QuotaOverride {
  if (!record(value)) fail(`${field} must be an object`, { field });
  exactKeys(value, ["billingProduct", "account"], field);
  const override: QuotaOverride = {};
  if (value.billingProduct !== undefined) override.billingProduct = stringField(value.billingProduct, `${field}.billingProduct`);
  if (value.account !== undefined) override.account = stringField(value.account, `${field}.account`);
  return override;
}

/**
 * A model entry's declared reasoning axis. Every value must sit on the
 * runner's native axis — a setting the runner cannot express is a reviewed
 * data error, never silently dropped. Empty and absent both mean unreasoned.
 */
function reasoningSet(kind: RunnerKind, value: unknown, field: string): (ThinkingLevel | ClaudeEffort)[] | undefined {
  if (value === undefined) return undefined;
  const settings = uniqueStrings(value, field) as (ThinkingLevel | ClaudeEffort)[];
  for (const setting of settings) if (!RUNNER_REASONING[kind].includes(setting)) fail(`${field} names a reasoning setting outside the ${kind} axis`, { field, setting });
  return settings;
}

function modelEntry(kind: RunnerKind, value: unknown, field: string): ModelEntry {
  if (!record(value)) fail(`${field} must be a model entry object`, { field });
  exactKeys(value, ["model", "provider", "quota", "supportedReasoning"], field);
  const provider = value.provider === undefined ? undefined : stringField(value.provider, `${field}.provider`);
  const quota = value.quota === undefined ? undefined : quotaOverride(value.quota, `${field}.quota`);
  // A billing product lives inside a provider namespace: overriding it while
  // inheriting the runner's provider would mint a tuple in the wrong domain.
  if (quota?.billingProduct !== undefined && provider === undefined) fail(`${field}.quota.billingProduct requires a provider override`, { field });
  const entry: ModelEntry = { model: stringField(value.model, `${field}.model`) };
  if (provider !== undefined) entry.provider = provider;
  if (quota !== undefined) entry.quota = quota;
  const reasoning = reasoningSet(kind, value.supportedReasoning, `${field}.supportedReasoning`);
  if (reasoning !== undefined) entry.supportedReasoning = reasoning;
  // The pi runtime always launches with a thinking setting: an undeclared
  // axis would mint a bare point the compiler rejects at start time. Fail at
  // parse instead. Claude effort is optional (haiku is unreasoned); AGY/Devin
  // encode reasoning in the model id.
  if (kind === "pi" && (reasoning === undefined || reasoning.length === 0)) {
    fail(`${field} must declare a supportedReasoning axis for the pi runtime`, { field });
  }
  return entry;
}

function modelEntries(kind: RunnerKind, value: unknown, field: string): ModelEntry[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of model entries`, { field });
  const entries = value.map((item, index) => modelEntry(kind, item, `${field}[${index}]`));
  if (new Set(entries.map((entry) => entry.model)).size !== entries.length) fail(`${field} must not contain duplicates`, { field });
  return entries;
}

function runnerEntry(kind: RunnerKind, value: unknown, scopeRoot: string, skills: readonly string[], plugins: readonly string[], mcp: ReadonlyMap<string, McpServer>): RunnerEntry {
  const field = `runners.${kind}`;
  if (!record(value)) fail(`${field} must be an object`, { field });
  exactKeys(value, ["models", "quota", "defaults", "plumbing", "pools"], field);
  const models = modelEntries(kind, value.models, `${field}.models`);
  if (models.length === 0) fail(`${field}.models must be a non-empty reviewed set`, { field });
  const quota = quotaKey(value.quota, `${field}.quota`);
  // A `provider/name` model id names a quota domain. When that domain is not
  // the runner's own (pi's zai and opencode-go entries), `provider` is
  // required — without it the model's availability keys would silently fall
  // back to the runner's tuple and collide with its identities.
  for (const [index, entry] of models.entries()) {
    const slash = entry.model.indexOf("/");
    if (slash > 0 && entry.model.slice(0, slash) !== quota.provider && entry.provider === undefined) fail(`${field}.models[${index}].provider is required: the id names a provider domain outside the runner quota`, { field: `${field}.models[${index}]`, model: entry.model });
  }
  const defaults = runnerDefaults(kind, value.defaults);
  const plumbing = runnerPlumbing(kind, value.plumbing);
  return { kind, models, quota, defaults, plumbing, pools: runnerPools(kind, value.pools, scopeRoot, skills, plugins, mcp) };
}

function runnerEntries(value: unknown, scopeRoot: string, skills: readonly string[], plugins: readonly string[], mcp: ReadonlyMap<string, McpServer>): Map<RunnerKind, RunnerEntry> {
  if (!record(value) || Object.keys(value).length === 0) fail("runners must be a non-empty mapping");
  const map = new Map<RunnerKind, RunnerEntry>();
  for (const [name, entry] of Object.entries(value)) {
    if (!RUNNER_KINDS.includes(name as RunnerKind)) fail(`runners.${name} must be one of ${RUNNER_KINDS.join(", ")}`, { runner: name });
    map.set(name as RunnerKind, runnerEntry(name as RunnerKind, entry, scopeRoot, skills, plugins, mcp));
  }
  return map;
}

function mcpServers(value: unknown): Map<string, McpServer> {
  const map = new Map<string, McpServer>();
  if (value === undefined) return map;
  if (!record(value)) fail("mcp must be a mapping");
  for (const [name, entry] of Object.entries(value)) {
    const field = `mcp.${name}`;
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) fail(`${field} names must be lowercase`, { field, name });
    if (!record(entry)) fail(`${field} must be an object`, { field });
    exactKeys(entry, ["plugin"], field);
    map.set(name, { plugin: stringField(entry.plugin, `${field}.plugin`) });
  }
  return map;
}

/** Reviewed class order shared by cost and latency: low < medium < high < extreme. */
const CLASS_ORDER = ["low", "medium", "high", "extreme"] as const;

/**
 * Each runner's native reasoning axis — the validation bound for per-model
 * `supportedReasoning` sets. Empty where reasoning is model-encoded. Pi
 * `minimal` is excluded: it is a runner-level alias of the provider's `low`,
 * and canonical points never mint it.
 */
const RUNNER_REASONING: Record<RunnerKind, readonly (ThinkingLevel | ClaudeEffort)[]> = {
  pi: THINKING_LEVELS.filter((level) => level !== "minimal"),
  claude: CLAUDE_EFFORTS,
  agy: [],
  devin: [],
};

/** A model entry's below-runner attribution merged over the runner's quota tuple. */
function modelQuotaKey(entry: ModelEntry | undefined, runner: RunnerEntry): QuotaKey {
  return {
    provider: entry?.provider ?? runner.quota.provider,
    billingProduct: entry?.quota?.billingProduct ?? runner.quota.billingProduct,
    account: entry?.quota?.account ?? runner.quota.account,
    scope: runner.quota.scope,
  };
}

/**
 * Generate the operating points (ADR-037): each reviewed model entry crossed
 * with its own declared `supportedReasoning` set. An absent or empty set —
 * model-encoded runners, or a reasoning runner's unreasoned model — emits
 * one bare `runner:model` point with no reasoning segment.
 */
function generatePoints(runners: ReadonlyMap<RunnerKind, RunnerEntry>): GeneratedPoint[] {
  const points: GeneratedPoint[] = [];
  for (const [runner, entry] of runners) {
    for (const model of entry.models) {
      const quota = modelQuotaKey(model, entry);
      const settings = model.supportedReasoning ?? [];
      if (settings.length === 0) points.push({ id: `${runner}:${model.model}`, runner, model: model.model, provider: quota.provider, quota });
      else for (const reasoning of settings) points.push({ id: `${runner}:${model.model}:${reasoning}`, runner, model: model.model, reasoning, provider: quota.provider, quota });
    }
  }
  return points;
}

function classValue(value: unknown, field: string): CostClass {
  const name = stringField(value, field);
  if (!CLASS_ORDER.includes(name as CostClass)) fail(`${field} must be one of ${CLASS_ORDER.join(", ")}`, { field, value: name });
  return name as CostClass;
}

/**
 * The declared pointPolicy must cover exactly the generated point set: a
 * missing id, an unknown id, or a duplicate key (refused by the parser's
 * uniqueKeys check) invalidates the catalog. An omitted section stays
 * additive — catalogs authored before ADR-037 still parse — and leaves every
 * generated combination unreviewed, so none survive a tier envelope.
 */
function pointPolicy(value: unknown, generated: readonly GeneratedPoint[]): Map<string, PointPolicy> {
  const map = new Map<string, PointPolicy>();
  if (value === undefined) return map;
  if (!record(value)) fail("pointPolicy must be a mapping keyed by operating point id");
  const expected = new Set(generated.map((point) => point.id));
  for (const [id, entry] of Object.entries(value)) {
    const field = `pointPolicy.${id}`;
    if (!expected.has(id)) fail("pointPolicy names a point the catalog does not generate", { point: id });
    if (!record(entry)) fail(`${field} must be an object`, { field });
    exactKeys(entry, ["costClass", "latencyClass"], field);
    map.set(id, { costClass: classValue(entry.costClass, `${field}.costClass`), latencyClass: classValue(entry.latencyClass, `${field}.latencyClass`) });
  }
  const missing = generated.filter((point) => !map.has(point.id)).map((point) => point.id);
  if (missing.length > 0) fail("pointPolicy must declare every generated operating point", { missing });
  return map;
}

function withinBound(value: CostClass, bound: ClassBound): boolean {
  return bound === "unbounded" || CLASS_ORDER.indexOf(value) <= CLASS_ORDER.indexOf(bound);
}

function quotaSources(value: unknown, runners: ReadonlyMap<RunnerKind, RunnerEntry>): QuotaSource[] {
  if (!Array.isArray(value)) fail("quotaSources must be an array");
  const seen = new Set<string>();
  let floor = 0;
  const sources = value.map((entry, index) => {
    const field = `quotaSources[${index}]`;
    if (!record(entry)) fail(`${field} must be an object`, { field });
    exactKeys(entry, ["name", "kind", "runner"], field);
    const name = stringField(entry.name, `${field}.name`);
    if (seen.has(name)) fail("quotaSources must not contain duplicate names", { name });
    seen.add(name);
    const kind = stringField(entry.kind, `${field}.kind`);
    if (kind !== "floor" && kind !== "proactive" && kind !== "coarse") fail(`${field}.kind must be floor, proactive, or coarse`, { field });
    if (kind === "floor") {
      floor += 1;
      if (entry.runner !== undefined) fail(`${field}.runner must be omitted for the global floor source`, { field });
      return { name, kind: kind as QuotaSourceKind };
    }
    const runner = stringField(entry.runner, `${field}.runner`) as RunnerKind;
    if (!runners.has(runner)) fail(`${field}.runner names a runner the catalog does not declare`, { field, runner });
    return { name, kind: kind as QuotaSourceKind, runner };
  });
  if (floor !== 1) fail("quotaSources must declare exactly one floor source: reactive classified-failure cooldowns are the floor for every runner");
  return sources;
}

/** sha256 hex over the raw catalog bytes — the catalog revision recorded in decision evidence. */
export function catalogRevisionOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Parse and validate the catalog config. Pure: no I/O. Fails closed — an
 * undeclared runner, a duplicate or malformed model entry, a pool naming
 * anything outside the reviewed set, or a declared pointPolicy whose keys do
 * not equal the generated point set invalidates the whole catalog.
 * `revision` defaults to the digest of the parsed text; callers holding the
 * raw bytes may pass their own.
 */
export function parseCatalog(text: string, source: CatalogSource, revision: string = catalogRevisionOf(text)): Catalog {
  if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) fail("catalog exceeds the 64 KiB limit");
  const document = parseDocument(text, { version: "1.2", schema: "core", strict: true, uniqueKeys: true, prettyErrors: false });
  if (document.errors.length > 0) fail("catalog is not valid YAML", { errors: document.errors.map((error) => error.message) });
  if (document.contents === null || !isMap(document.contents)) fail("catalog must be a YAML mapping");
  validateNode(document.contents);
  const values = document.contents.toJSON() as Record<string, unknown>;
  exactKeys(values, ["version", "runners", "skills", "plugins", "mcp", "quotaSources", "pointPolicy"], "catalog");
  if (values.version !== 2) fail("catalog version must be 2");
  const scopeRoot = resolve(source.scopeRoot);
  const skills = scopedPaths(values.skills ?? [], "skills", scopeRoot);
  const plugins = scopedPaths(values.plugins ?? [], "plugins", scopeRoot);
  const mcp = mcpServers(values.mcp);
  const runners = runnerEntries(values.runners, scopeRoot, skills, plugins, mcp);
  const generated = generatePoints(runners);
  const policy = pointPolicy(values.pointPolicy, generated);
  const points: OperatingPoint[] = [];
  for (const point of generated) {
    const classes = policy.get(point.id);
    if (classes !== undefined) points.push({ ...point, ...classes });
  }
  return {
    version: 2,
    runners,
    points,
    pointPolicy: policy,
    catalogRevision: revision,
    skills,
    plugins,
    mcpServers: mcp,
    quotaSources: quotaSources(values.quotaSources, runners),
    source,
  };
}

export interface CatalogReadIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

/**
 * The module's only I/O: one config read, then parse. `scopeRoot` defaults to
 * the package root — the parent of the `herdr-profiles/` directory the catalog
 * lives in.
 */
export async function loadCatalog(path: string, scopeRoot = dirname(dirname(resolve(path))), io: CatalogReadIo = fs): Promise<Catalog> {
  const resolved = resolve(path);
  const text = await io.readFile(resolved, "utf8");
  return parseCatalog(text, { path: resolved, scopeRoot }, catalogRevisionOf(text));
}

/**
 * The quota key a subject is admitted under: the named model entry's
 * below-runner attribution merged over the runner's tuple — so pi/zai and
 * pi/opencode-go points can never collide with the runner's codex identity.
 */
export function quotaKeyFor(subject: AvailabilitySubject, runner: RunnerEntry): QuotaKey {
  return modelQuotaKey(runner.models.find((entry) => entry.model === subject.model), runner);
}

/** The subset of classed points admissible under the tier's cost/latency envelope (ADR-037). */
export function pointsWithinTier<T extends PointPolicy>(points: readonly T[], tier: QualityTier): T[] {
  const envelope = TIER_ENVELOPES[tier];
  return points.filter((point) => withinBound(point.costClass, envelope.maxCostClass) && withinBound(point.latencyClass, envelope.maxLatencyClass));
}
