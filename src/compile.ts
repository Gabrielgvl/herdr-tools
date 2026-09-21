import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { quotaKeyFor, type Catalog, type QuotaKey, type ResolvedCandidate, type RunnerKind, type RunnerPlumbing, type RunnerPools } from "./catalog.js";
import { buildRuntimeArgv } from "./profiles/adapters.js";
import { normalizeScopedResourcePath } from "./profiles/parser.js";
import { assertPhysicalContainment } from "./profiles/skill-bundles.js";
import type { ClaudePermissionMode, DevinPermissionMode, RuntimeProfile } from "./profiles/types.js";

export type CompileErrorCode = "INVALID_SELECTION" | "SELECTION_OUTSIDE_POOL" | "CANDIDATE_NOT_REVIEWED" | "EMPTY_PERMIT_SET";

/**
 * A typed compile failure. Jev's selection can narrow the reviewed pool but
 * never widen it: a name outside the pool, a candidate outside the reviewed
 * model set, or a permit set argv cannot express all refuse the contract —
 * nothing is silently dropped and nothing is granted.
 */
export class CompileError extends Error {
  constructor(readonly code: CompileErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CompileError";
  }
}

/** The part of a caller-authored spec the compiler binds to: identity only. */
export interface CompileSpec {
  label: string;
}

/** Jev's resource picks for one chain candidate, keyed by pool field. */
export type ResourceSelection = Partial<Record<keyof RunnerPools, readonly string[]>>;

/**
 * The deterministic steps between Jev's validated picks and the effective
 * sets: declared dependencies added, incompatible pairs removed, deny-channel
 * rules derived. The flat order is the audit trail — same input, same log.
 */
export interface CompileDerivation {
  action: "dependency" | "incompatible" | "deny";
  field: keyof RunnerPools;
  name: string;
  reason: string;
}

/**
 * What the catalog cannot express, recorded rather than dropped. `deny-coverage`
 * means the runner's deny channel can only carry reviewed pool members — denies
 * of ambient tools outside the pool (the profile matrix's blanket `Task` /
 * per-role `NotebookEdit` denies) have no catalog equivalent. `ambient-exposure`
 * means the contract permits a resource whose actual binding is environment
 * state Herdr does not control.
 */
export interface CompileGap {
  kind: "deny-coverage" | "ambient-exposure";
  message: string;
}

/** The three recorded facts, kept distinct per ADR-035: what exists in the reviewed pool, what the compiled argv makes reachable, and what policy permits — plus the deny channel output. */
export interface CompiledResourceSet {
  installed: readonly string[];
  /** Jev's validated picks in canonical pool order (pre-derivation). */
  selected: readonly string[];
  exposed: readonly string[];
  permitted: readonly string[];
  denied: readonly string[];
}

/** A launchable execution contract: the effective per-runner configuration plus the evidence of how it was derived. */
export interface CompiledContract {
  specLabel: string;
  candidate: { index: number; runner: RunnerKind; model: string; account?: string };
  /** The availability tuple this candidate is admitted under. */
  quota: QuotaKey;
  scopeRoot: string;
  sessionPersistence: boolean;
  timeoutMinutes: number;
  plumbing: RunnerPlumbing;
  /** The compiled runtime block — the same shape `buildRuntimeArgv` already drives. */
  runtime: RuntimeProfile;
  resources: Partial<Record<keyof RunnerPools, CompiledResourceSet>>;
  derivations: readonly CompileDerivation[];
  gaps: readonly CompileGap[];
}

/** Canonical field order: matches `RunnerPools` declaration order so the recorded contract is byte-stable. */
const POOL_FIELDS = ["tools", "extensions", "skills", "plugins", "mcp"] as const;

/** The pool fields a runner can consume; AGY and Devin select nothing. Mirrors catalog.ts's parse-time table — mechanism facts, not config. */
const CONSUMABLE_FIELDS: Record<RunnerKind, readonly (keyof RunnerPools)[]> = {
  pi: ["tools", "extensions", "skills", "mcp"],
  claude: ["tools", "plugins", "mcp"],
  agy: [],
  devin: [],
};

/** Pool fields whose members are scope-rooted paths; the rest are bare names. */
const PATH_FIELDS: ReadonlySet<keyof RunnerPools> = new Set(["extensions", "skills", "plugins"]);

function fail(code: CompileErrorCode, message: string, details: Record<string, unknown> = {}): never {
  throw new CompileError(code, message, details);
}

function selectionValues(value: unknown, field: keyof RunnerPools): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("INVALID_SELECTION", `selection.${field} must be an array of resource names`, { field });
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0 || /[\0\r\n]/.test(item)) fail("INVALID_SELECTION", `selection.${field}[${index}] must be a non-empty single-line string`, { field, index });
    return item;
  });
}

/** Path selections resolve against the scope root exactly as pool declarations did; a path that cannot normalize simply fails membership below, still carrying the offending name. */
function normalizeMember(field: keyof RunnerPools, raw: string, scopeRoot: string): string {
  if (!PATH_FIELDS.has(field)) return raw;
  if (isAbsolute(raw)) return resolve(raw);
  try {
    return normalizeScopedResourcePath(raw, `selection.${field}`, scopeRoot);
  } catch {
    return raw;
  }
}

/**
 * The pool boundary. Every selected name must be a reviewed pool member —
 * out-of-pool names are a typed failure carrying the offenders, never dropped
 * and never granted. Valid members come back in canonical pool order, so the
 * selected set is order- and duplicate-insensitive.
 */
function selectWithinPool(pool: readonly string[], raw: readonly string[], field: keyof RunnerPools, scopeRoot: string): string[] {
  const members = new Set(raw.map((item) => normalizeMember(field, item, scopeRoot)));
  const offenders = [...members].filter((name) => !pool.includes(name));
  if (offenders.length > 0) fail("SELECTION_OUTSIDE_POOL", `selection.${field} names resources outside the reviewed pool`, { field, names: offenders });
  const selected = new Set(members);
  return pool.filter((name) => selected.has(name));
}

/** Claude binds MCP servers through plugin dirs: `mcp.<server>.plugin` names the providing plugin, and `plugin.json` inside a pool dir is what proves which dir carries that name. */
async function pluginDirsByName(dirs: readonly string[]): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  for (const dir of dirs) {
    let name: unknown;
    try {
      name = (JSON.parse(await fs.readFile(join(dir, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>).name;
    } catch {
      continue;
    }
    if (typeof name === "string" && name.length > 0 && !byName.has(name)) byName.set(name, dir);
  }
  return byName;
}

/** The tool rule a Claude MCP server grant or deny takes on argv: `mcp__plugin_<plugin>_<server>`. */
function mcpToolRule(plugin: string, server: string): string {
  return `mcp__plugin_${plugin}_${server}`;
}

/**
 * Per-field working sets. `selected` is Jev's validated pool members in pool
 * order and is never mutated after membership validation — the audit trail
 * shows what was picked even when a derivation later refuses it. `granted` is
 * `selected` plus added dependencies minus removed incompatibilities; the
 * exposed/permitted/denied facts derive from it.
 */
interface FieldWork {
  selected: Set<string>;
  granted: Set<string>;
  exposed: Set<string>;
  permitted: Set<string>;
  denied: Set<string>;
}

function fieldWork(): FieldWork {
  return { selected: new Set(), granted: new Set(), exposed: new Set(), permitted: new Set(), denied: new Set() };
}

function record(installed: readonly string[], work: FieldWork): CompiledResourceSet {
  return {
    installed,
    selected: [...work.selected],
    exposed: [...work.exposed],
    permitted: [...work.permitted],
    denied: [...work.denied],
  };
}

interface Work {
  resources: Partial<Record<keyof RunnerPools, CompiledResourceSet>>;
  derivations: CompileDerivation[];
  gaps: CompileGap[];
}

async function compilePi(candidate: ResolvedCandidate["candidate"], runner: ResolvedCandidate["runner"], selected: Record<keyof RunnerPools, string[]>, work: Work): Promise<RuntimeProfile> {
  const pools = runner.pools;
  const fields: Record<string, FieldWork> = {};
  for (const field of CONSUMABLE_FIELDS.pi) {
    fields[field] = fieldWork();
    fields[field]!.selected = new Set(selected[field]);
    fields[field]!.granted = new Set(selected[field]);
  }
  // Pi's MCP tool binds every server from ambient host configuration and has
  // no server-scoped allow or deny channel. Remove both direct tool grants and
  // selected servers rather than claiming the reviewed subset is enforceable.
  const ambientMcpReason = "Pi cannot scope ambient MCP servers to the reviewed selection";
  for (const server of pools.mcp.filter((name) => fields.mcp!.selected.has(name))) {
    fields.mcp!.granted.delete(server);
    work.derivations.push({ action: "incompatible", field: "mcp", name: server, reason: ambientMcpReason });
  }
  if (fields.tools!.granted.delete("mcp")) {
    work.derivations.push({ action: "incompatible", field: "tools", name: "mcp", reason: ambientMcpReason });
  }
  for (const field of ["tools", "extensions", "skills"] as const) {
    for (const name of pools[field]) if (fields[field]!.granted.has(name)) fields[field]!.exposed.add(name);
    fields[field]!.permitted = new Set(fields[field]!.exposed);
  }
  // Pi has no deny channel: the `--tools` allowlist and `--no-skills` make the
  // complement unreachable, so `denied` stays empty by mechanism, not omission.
  for (const field of CONSUMABLE_FIELDS.pi) work.resources[field] = record(pools[field], fields[field]!);
  return {
    kind: "pi",
    model: candidate.model,
    thinking: runner.defaults.thinking!,
    tools: [...fields.tools!.permitted],
    extensions: [...fields.extensions!.exposed],
    skills: [...fields.skills!.exposed],
  };
}

async function compileClaude(candidate: ResolvedCandidate["candidate"], runner: ResolvedCandidate["runner"], catalog: Catalog, selected: Record<keyof RunnerPools, string[]>, work: Work): Promise<RuntimeProfile> {
  const pools = runner.pools;
  const fields: Record<string, FieldWork> = {};
  for (const field of CONSUMABLE_FIELDS.claude) {
    fields[field] = fieldWork();
    fields[field]!.selected = new Set(selected[field]);
    fields[field]!.granted = new Set(selected[field]);
  }
  const pluginNames = fields.mcp!.selected.size > 0 || fields.plugins!.selected.size > 0 ? await pluginDirsByName(pools.plugins) : new Map<string, string>();
  const providerOf = (server: string): { plugin: string; dir: string | undefined } | undefined => {
    const plugin = catalog.mcpServers.get(server)?.plugin;
    return plugin === undefined ? undefined : { plugin, dir: pluginNames.get(plugin) };
  };
  // Declared dependency: a selected MCP server is reachable only through the
  // plugin dir that provides it, added inside the pool. A provider outside the
  // pool cannot be granted, so the pair is removed as incompatible.
  for (const server of pools.mcp) {
    if (!fields.mcp!.selected.has(server)) continue;
    const provider = providerOf(server);
    if (provider === undefined || provider.dir === undefined) {
      const reason = provider === undefined ? "provider plugin is undeclared in the catalog" : `provider plugin ${provider.plugin} has no directory in the reviewed plugin pool`;
      fields.mcp!.granted.delete(server);
      work.derivations.push({ action: "incompatible", field: "mcp", name: server, reason });
      continue;
    }
    if (!fields.plugins!.granted.has(provider.dir)) {
      fields.plugins!.granted.add(provider.dir);
      work.derivations.push({ action: "dependency", field: "plugins", name: provider.dir, reason: `provides selected MCP server ${server}` });
    }
  }
  for (const name of pools.plugins) if (fields.plugins!.granted.has(name)) fields.plugins!.exposed.add(name);
  fields.plugins!.permitted = new Set(fields.plugins!.exposed);
  // Plugin dirs are additive: every MCP server a selected plugin provides is
  // exposed whether or not Jev selected it. Only selected servers are
  // permitted; the exposed remainder is denied explicitly on the deny channel.
  for (const server of pools.mcp) {
    const provider = providerOf(server);
    if (provider !== undefined && provider.dir !== undefined && fields.plugins!.exposed.has(provider.dir)) fields.mcp!.exposed.add(server);
  }
  for (const server of pools.mcp) {
    if (!fields.mcp!.exposed.has(server)) continue;
    const provider = providerOf(server)!;
    if (fields.mcp!.granted.has(server)) {
      fields.mcp!.permitted.add(server);
    } else {
      fields.mcp!.denied.add(server);
      work.derivations.push({ action: "deny", field: "mcp", name: server, reason: `exposed by selected plugin ${provider.plugin} but not selected` });
    }
  }
  // Incompatibility: the `Skill` tool with no plugin dirs can only reach
  // unreviewed ambient skills, so the tool itself is removed.
  if (fields.tools!.granted.has("Skill") && fields.plugins!.exposed.size === 0) {
    fields.tools!.granted.delete("Skill");
    work.derivations.push({ action: "incompatible", field: "tools", name: "Skill", reason: "no plugin dirs selected; only unreviewed ambient skills would be reachable" });
  }
  for (const name of pools.tools) {
    if (fields.tools!.granted.has(name)) {
      fields.tools!.exposed.add(name);
      fields.tools!.permitted.add(name);
    } else {
      // The deny channel carries pool ∖ permitted: every reviewed tool Jev did
      // not select is denied explicitly, not merely left off the allowlist.
      fields.tools!.denied.add(name);
      work.derivations.push({ action: "deny", field: "tools", name, reason: "reviewed pool member outside the permitted set" });
    }
  }
  for (const field of CONSUMABLE_FIELDS.claude) work.resources[field] = record(pools[field], fields[field]!);
  // The deny derivation covers reviewed pool members only. Ambient tools
  // outside the pool — the profile matrix's blanket `Task` deny and per-role
  // `NotebookEdit` denies — cannot be expressed from catalog data; the gap is
  // recorded rather than silently dropped.
  work.gaps.push({ kind: "deny-coverage", message: "the deny channel carries reviewed pool members only; denies of ambient tools outside the pool (the profile matrix's Task/NotebookEdit denies) have no catalog equivalent" });
  work.gaps.push({ kind: "ambient-exposure", message: "Claude plugin dirs load additively on ambient plugin and skill configuration; the contract controls what is added, not what the environment already provides" });
  return {
    kind: "claude",
    model: candidate.model,
    effort: runner.defaults.effort!,
    permissionMode: runner.defaults.permissionMode as ClaudePermissionMode,
    allowedTools: [...fields.tools!.permitted, ...[...fields.mcp!.permitted].map((server) => mcpToolRule(providerOf(server)!.plugin, server))],
    disallowedTools: [...fields.tools!.denied, ...[...fields.mcp!.denied].map((server) => mcpToolRule(providerOf(server)!.plugin, server))],
    addDirs: [],
    pluginDirs: [...fields.plugins!.exposed],
    developmentChannels: [],
  };
}

async function compileAmbient(candidate: ResolvedCandidate["candidate"], runner: ResolvedCandidate["runner"], work: Work): Promise<RuntimeProfile> {
  // Ambient pools are empty by construction, so any named selection already
  // failed membership above — the same boundary, not a special case.
  work.gaps.push({ kind: "ambient-exposure", message: `${runner.kind} consumes no pool fields; all resources are ambient and outside catalog review` });
  return runner.kind === "agy"
    ? { kind: "agy", model: candidate.model, mode: runner.defaults.mode!, addDirs: [] }
    : { kind: "devin", model: candidate.model, permissionMode: runner.defaults.permissionMode as DevinPermissionMode };
}

/**
 * Compile one chain candidate into a launchable execution contract: pool ∩
 * selection plus declared dependencies minus incompatibilities, per candidate
 * runner, with the effective config and every derivation recorded. Deterministic
 * — identical inputs produce a byte-identical contract. The only I/O is
 * physical containment of the exposed path-typed resources and plugin manifest
 * reads for declared MCP dependencies.
 */
export async function compileCandidateContract(catalog: Catalog, spec: CompileSpec, resolved: ResolvedCandidate, selection: ResourceSelection = {}): Promise<CompiledContract> {
  const { candidate, runner } = resolved;
  if (candidate.runner !== runner.kind || !runner.models.includes(candidate.model)) fail("CANDIDATE_NOT_REVIEWED", `candidate ${candidate.runner}/${candidate.model} is not in the runner's reviewed model set`, { runner: candidate.runner, model: candidate.model });
  for (const field of Object.keys(selection)) if (!POOL_FIELDS.includes(field as keyof RunnerPools)) fail("INVALID_SELECTION", `selection.${field} is not a pool field`, { field });
  const scopeRoot = catalog.source.scopeRoot;
  // Membership is checked for every pool field, consumable or not: a selection
  // naming a field this runner cannot consume is out-of-pool by construction —
  // never silently ignored.
  const selected: Record<keyof RunnerPools, string[]> = { tools: [], extensions: [], skills: [], plugins: [], mcp: [] };
  for (const field of POOL_FIELDS) selected[field] = selectWithinPool(runner.pools[field], selectionValues(selection[field], field), field, scopeRoot);
  const work: Work = { resources: {}, derivations: [], gaps: [] };
  const runtime = runner.kind === "pi" ? await compilePi(candidate, runner, selected, work) : runner.kind === "claude" ? await compileClaude(candidate, runner, catalog, selected, work) : await compileAmbient(candidate, runner, work);
  // On allowlist-tooling runners an empty permit set emits no allowlist flag
  // at all — argv cannot express "no tools", and omitting the flag would grant
  // the ambient default set, silently widening past the pool. Fail instead.
  const permits = runtime.kind === "pi" ? runtime.tools : runtime.kind === "claude" ? runtime.allowedTools : [];
  if (runner.plumbing.toolSelection === "allowlist" && permits.length === 0) fail("EMPTY_PERMIT_SET", `the compiled permit set is empty and ${runner.kind} argv cannot express it without granting ambient defaults`, { runner: runner.kind });
  // Physical containment on exactly what the argv will expose: lexical pool
  // membership cannot see a symlinked tree that points outside the scope root.
  const exposedPaths = runtime.kind === "pi" ? [...runtime.extensions, ...runtime.skills] : runtime.kind === "claude" ? runtime.pluginDirs : [];
  for (const path of exposedPaths) await assertPhysicalContainment(path, scopeRoot, "compiled selection");
  return {
    specLabel: spec.label,
    candidate: candidate.account === undefined ? { index: resolved.index, runner: candidate.runner, model: candidate.model } : { index: resolved.index, runner: candidate.runner, model: candidate.model, account: candidate.account },
    quota: quotaKeyFor(candidate, runner),
    scopeRoot,
    sessionPersistence: runner.defaults.sessionPersistence,
    timeoutMinutes: runner.defaults.timeoutMinutes,
    plumbing: runner.plumbing,
    runtime,
    resources: work.resources,
    derivations: work.derivations,
    gaps: work.gaps,
  };
}

/** The contract's argv, through the existing per-runner builders. */
export function contractArgv(contract: CompiledContract, promptFilePath?: string, attachmentDirectory?: string, handoffDirectory?: string): string[] {
  return buildRuntimeArgv({ sessionPersistence: contract.sessionPersistence, source: { scopeRoot: contract.scopeRoot } }, contract.runtime, promptFilePath, attachmentDirectory, handoffDirectory);
}
