import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { isAlias, isMap, isSeq, parseDocument, type Node } from "yaml";
import { normalizeScopedResourcePath } from "./profiles/parser.js";
import { AGY_MODES, CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, DEVIN_PERMISSION_MODES, THINKING_LEVELS, type AgyMode, type ClaudeEffort, type ClaudePermissionMode, type DevinPermissionMode, type ThinkingLevel } from "./profiles/types.js";

export class CatalogError extends Error {
  readonly code = "INVALID_CATALOG" as const;
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CatalogError";
  }
}

export class ChainResolutionError extends Error {
  readonly code = "CHAIN_UNRESOLVABLE" as const;
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ChainResolutionError";
  }
}

export const RUNNER_KINDS = ["pi", "claude", "agy", "devin"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

export const CATEGORY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_CATALOG_BYTES = 64 * 1024;
/** ADR-026's ratified attempt bound, carried forward as the default chain depth (plan R4). */
export const DEFAULT_MAX_ATTEMPTS = 4;
/** Bundled catalog location, relative to the package (scope) root. */
export const CATALOG_PATH = "herdr-profiles/catalog.yaml";

export interface ChainCandidate {
  runner: RunnerKind;
  model: string;
  /** Account override within the runner's provider; defaults to the runner's quota account. */
  account?: string;
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

export interface RunnerEntry {
  kind: RunnerKind;
  /** The reviewed model set; a chain entry may only name one of these. */
  models: readonly string[];
  quota: QuotaKey;
  defaults: RunnerDefaults;
  plumbing: RunnerPlumbing;
  pools: RunnerPools;
}

export interface McpServer {
  plugin: string;
}

export interface CatalogSource {
  path: string;
  scopeRoot: string;
}

export interface Catalog {
  version: 1;
  maxAttempts: number;
  categories: ReadonlyMap<string, readonly ChainCandidate[]>;
  runners: ReadonlyMap<RunnerKind, RunnerEntry>;
  /** Reviewed skill trees (resolved to absolute paths), the Pi `--skill` unit. */
  skills: readonly string[];
  /** Reviewed plugin roots (resolved to absolute paths), the Claude `--plugin-dir` unit. */
  plugins: readonly string[];
  mcpServers: ReadonlyMap<string, McpServer>;
  quotaSources: readonly QuotaSource[];
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

function runnerEntry(kind: RunnerKind, value: unknown, scopeRoot: string, skills: readonly string[], plugins: readonly string[], mcp: ReadonlyMap<string, McpServer>): RunnerEntry {
  const field = `runners.${kind}`;
  if (!record(value)) fail(`${field} must be an object`, { field });
  exactKeys(value, ["models", "quota", "defaults", "plumbing", "pools"], field);
  const models = uniqueStrings(value.models, `${field}.models`);
  if (models.length === 0) fail(`${field}.models must be a non-empty reviewed set`, { field });
  const defaults = runnerDefaults(kind, value.defaults);
  const plumbing = runnerPlumbing(kind, value.plumbing);
  return { kind, models, quota: quotaKey(value.quota, `${field}.quota`), defaults, plumbing, pools: runnerPools(kind, value.pools, scopeRoot, skills, plugins, mcp) };
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

function chainCandidate(value: unknown, field: string, runners: ReadonlyMap<RunnerKind, RunnerEntry>): ChainCandidate {
  if (!record(value)) fail(`${field} must be a chain entry object`, { field });
  exactKeys(value, ["runner", "model", "account"], field);
  const runnerName = stringField(value.runner, `${field}.runner`);
  const runner = runners.get(runnerName as RunnerKind);
  if (runner === undefined) fail(`${field}.runner names a runner the catalog does not declare`, { field, runner: runnerName });
  const model = stringField(value.model, `${field}.model`);
  if (!runner.models.includes(model)) fail(`${field}.model is not in the reviewed ${runnerName} model set`, { field, model });
  if (value.account === undefined) return { runner: runnerName as RunnerKind, model };
  return { runner: runnerName as RunnerKind, model, account: stringField(value.account, `${field}.account`) };
}

function categories(value: unknown, runners: ReadonlyMap<RunnerKind, RunnerEntry>, maxAttempts: number): Map<string, ChainCandidate[]> {
  if (!record(value) || Object.keys(value).length === 0) fail("categories must be a non-empty mapping");
  const map = new Map<string, ChainCandidate[]>();
  for (const [name, entries] of Object.entries(value)) {
    if (!CATEGORY_NAME_PATTERN.test(name)) fail("category names must be lowercase kebab-case", { category: name });
    const field = `categories.${name}`;
    if (!Array.isArray(entries) || entries.length === 0) fail(`${field} must be a non-empty chain`, { category: name });
    if (entries.length > maxAttempts) fail(`${field} exceeds the attempt bound`, { category: name, chainLength: entries.length, maxAttempts });
    const chain = entries.map((entry, index) => chainCandidate(entry, `${field}[${index}]`, runners));
    const seen = new Set<string>();
    for (const candidate of chain) {
      const key = `${candidate.runner}\0${candidate.model}\0${candidate.account ?? ""}`;
      if (seen.has(key)) fail(`${field} must not contain duplicate entries`, { category: name, runner: candidate.runner, model: candidate.model });
      seen.add(key);
    }
    map.set(name, chain);
  }
  return map;
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

/**
 * Parse and validate the catalog config. Pure: no I/O. Fails closed — an
 * over-long chain, an undeclared runner or model, a duplicate entry, or a pool
 * naming anything outside the reviewed set invalidates the whole catalog.
 */
export function parseCatalog(text: string, source: CatalogSource): Catalog {
  if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_BYTES) fail("catalog exceeds the 64 KiB limit");
  const document = parseDocument(text, { version: "1.2", schema: "core", strict: true, uniqueKeys: true, prettyErrors: false });
  if (document.errors.length > 0) fail("catalog is not valid YAML", { errors: document.errors.map((error) => error.message) });
  if (document.contents === null || !isMap(document.contents)) fail("catalog must be a YAML mapping");
  validateNode(document.contents);
  const values = document.contents.toJSON() as Record<string, unknown>;
  exactKeys(values, ["version", "maxAttempts", "categories", "runners", "skills", "plugins", "mcp", "quotaSources"], "catalog");
  if (values.version !== 1) fail("catalog version must be 1");
  const maxAttempts = values.maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : values.maxAttempts;
  if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1) fail("maxAttempts must be a positive integer");
  const scopeRoot = resolve(source.scopeRoot);
  const skills = scopedPaths(values.skills ?? [], "skills", scopeRoot);
  const plugins = scopedPaths(values.plugins ?? [], "plugins", scopeRoot);
  const mcp = mcpServers(values.mcp);
  const runners = runnerEntries(values.runners, scopeRoot, skills, plugins, mcp);
  return {
    version: 1,
    maxAttempts: maxAttempts as number,
    categories: categories(values.categories, runners, maxAttempts as number),
    runners,
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
  return parseCatalog(await io.readFile(resolved, "utf8"), { path: resolved, scopeRoot });
}

/** `true` admits; `false` or a string rejects with the string as the recorded reason; an object carries both. */
export type CandidateVerdict = boolean | string | { admissible: boolean; reason?: string };
export type CandidateGate = (candidate: ChainCandidate, runner: RunnerEntry) => CandidateVerdict;

export interface ResolvedCandidate {
  index: number;
  candidate: ChainCandidate;
  runner: RunnerEntry;
}

export interface RejectedCandidate {
  index: number;
  candidate: ChainCandidate;
  gate: "eligibility" | "availability";
  reason?: string;
}

export interface ChainResolution {
  category: string;
  chain: readonly ChainCandidate[];
  /** First admissible candidate, or undefined when the chain is exhausted — the caller reports evidence and a nullable retryNotBefore, never a fabricated ETA. */
  selected: ResolvedCandidate | undefined;
  /** Admissible candidates after the selected one, in chain order — the pre-execution-only fallback. */
  remainder: readonly ResolvedCandidate[];
  /** Every excluded candidate with the gate that excluded it, in chain order. */
  rejected: readonly RejectedCandidate[];
}

function verdict(value: CandidateVerdict): { admissible: boolean; reason?: string } {
  if (typeof value === "boolean") return { admissible: value };
  if (typeof value === "string") return { admissible: false, reason: value };
  return value.reason === undefined ? { admissible: value.admissible } : { admissible: value.admissible, reason: value.reason };
}

/**
 * Pure chain resolution: eligibility first, then the quota/availability filter,
 * in declared order. The first satisfying candidate is selected; the ordered
 * remainder is the fallback. A chain that is unresolvable — unknown category,
 * empty, or over the attempt bound — throws rather than truncating. Exhausted
 * chains are a result, not an error: `selected` is undefined and `rejected`
 * carries the evidence.
 */
export function resolveChain(catalog: Catalog, category: string, eligibility: CandidateGate = () => true, availability: CandidateGate = () => true): ChainResolution {
  if (!CATEGORY_NAME_PATTERN.test(category)) throw new ChainResolutionError("category must be lowercase kebab-case", { category });
  const chain = catalog.categories.get(category);
  if (chain === undefined || chain.length === 0) throw new ChainResolutionError(`category ${category} is not resolvable`, { category });
  if (chain.length > catalog.maxAttempts) throw new ChainResolutionError("category chain exceeds the attempt bound", { category, chainLength: chain.length, maxAttempts: catalog.maxAttempts });
  const admissible: ResolvedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  for (const [index, candidate] of chain.entries()) {
    const runner = catalog.runners.get(candidate.runner);
    if (runner === undefined) throw new ChainResolutionError(`category ${category} names undeclared runner ${candidate.runner}`, { category, runner: candidate.runner });
    let admitted = true;
    for (const [gate, check] of [["eligibility", eligibility], ["availability", availability]] as const) {
      const result = verdict(check(candidate, runner));
      if (!result.admissible) {
        rejected.push(result.reason === undefined ? { index, candidate, gate } : { index, candidate, gate, reason: result.reason });
        admitted = false;
        break;
      }
    }
    if (admitted) admissible.push({ index, candidate, runner });
  }
  const [selected, ...remainder] = admissible;
  return { category, chain, selected, remainder, rejected };
}

/** The quota key a candidate is admitted under: the runner's tuple with any per-candidate account override applied. */
export function quotaKeyFor(candidate: ChainCandidate, runner: RunnerEntry): QuotaKey {
  return { ...runner.quota, account: candidate.account ?? runner.quota.account };
}
