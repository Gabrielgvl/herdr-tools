import {
  APIError,
  choice,
  noul,
  type EntryType,
  type Fetch,
  type Questions,
} from "@typesafe-ai/sdk";
import { isAbsolute, relative } from "node:path";
import type { Catalog, ChainCandidate, RunnerEntry, RunnerKind, RunnerPools } from "./catalog.js";
import type { LaunchSpec } from "./launch-schema.js";
import type {
  AbstainReason,
  Abstained,
  CandidateJudgment,
  SpecModelDecision,
} from "./router.js";
import type { AuthJsonCredentialStore } from "./supervision/auth-json-credential-store.js";
import { createTypeSafeClient, resolveTypesafeApiKey } from "./typesafe-reviewer.js";

const SPEC_MODEL = "jev-latest";
const PROBABILITY_SUM_TOLERANCE = 1e-6;

const QUALITY_INSTRUCTIONS = "instructions_adequate";
const QUALITY_ASSIGNMENT = "assignment_verifiable";
const CATEGORY_QUESTION = "category";
const COMPOSITION_QUESTION = "missing_area";
const RESOURCE_PREFIX = "resource_";

const POOL_FIELDS: readonly (keyof RunnerPools)[] = ["tools", "extensions", "skills", "plugins", "mcp"];
type PoolField = (typeof POOL_FIELDS)[number];

const RESOURCE_NOUN: Record<PoolField, string> = {
  tools: "tool",
  extensions: "extension",
  skills: "skill",
  plugins: "plugin",
  mcp: "MCP server",
};

/**
 * The client's outcome: either the normalized model response that `routeSpec`
 * consumes as `SpecRouteInput.response`, or a typed fail-closed abstention the
 * caller may return verbatim — it is already a `SpecDecision` member.
 */
export type SpecEvaluation = { kind: "response"; response: SpecModelDecision } | Abstained;

export interface TypeSafeSpecOptions {
  /** Explicit key wins; otherwise `resolveTypesafeApiKey` (env → Pi auth store). */
  apiKey?: string;
  fetch?: Fetch;
  /** Credential-store seam for `resolveTypesafeApiKey`; defaults to the real auth.json store. */
  credentials?: Pick<AuthJsonCredentialStore, "read">;
}

export interface SpecEvaluationInput {
  spec: LaunchSpec;
  catalog: Catalog;
  /** The caller's planned team — every spec in the request. Defaults to this spec alone. */
  team?: readonly LaunchSpec[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** `instanceof Map` alone would widen the generics to `any`; the predicate keeps them. */
function isReadonlyMap<K, V>(value: unknown): value is ReadonlyMap<K, V> {
  return value instanceof Map;
}

function refuse(reason: AbstainReason, component?: string): SpecEvaluation {
  return { kind: "abstained", reason, ...(component === undefined ? {} : { component }) };
}

/** Exact-key probability map: every sent key present once, each in [0,1], summing to one. */
function distribution(value: unknown, keys: readonly string[]): Record<string, number> | undefined {
  if (!record(value) || Object.keys(value).length !== keys.length) return undefined;
  const parsed: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const entry = value[key];
    if (!Object.prototype.hasOwnProperty.call(value, key) || !probability(entry)) return undefined;
    parsed[key] = entry;
    sum += entry;
  }
  return Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE ? parsed : undefined;
}

function parseNoulAnswer(answer: unknown): number | undefined {
  if (!record(answer) || answer.type !== "noul" || !probability(answer.noul)) return undefined;
  return answer.noul;
}

function parseChoiceAnswer(answer: unknown, candidates: readonly string[]): { choice: string; confidence: number; probabilities: Record<string, number> } | undefined {
  if (!record(answer) || answer.type !== "choice") return undefined;
  if (typeof answer.choice !== "string" || !candidates.includes(answer.choice)) return undefined;
  if (!probability(answer.confidence)) return undefined;
  const probabilities = distribution(answer.probabilities, candidates);
  if (probabilities === undefined) return undefined;
  return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

/** The spec fields are schema-validated upstream; this guards the boundary against non-spec input. */
function validSpec(spec: unknown): spec is LaunchSpec {
  return record(spec)
    && typeof spec.label === "string"
    && typeof spec.instructions === "string"
    && record(spec.assignment)
    && typeof spec.assignment.objective === "string"
    && typeof spec.assignment.scope === "string"
    && typeof spec.assignment.verification === "string";
}

/** The spec's allowlisted semantic fields — shared by `state.spec` and each `state.team` member. */
function specState(spec: LaunchSpec): Record<string, unknown> {
  return {
    label: spec.label,
    instructions: spec.instructions,
    assignment: {
      objective: spec.assignment.objective,
      scope: spec.assignment.scope,
      verification: spec.assignment.verification,
    },
    ...(spec.category === undefined ? {} : { category: spec.category }),
  };
}

/** Pool entries are scope-resolved paths; the question text shows the scope-relative name. */
function displayResource(name: string, scopeRoot: string): string {
  if (scopeRoot.length === 0) return name;
  const rel = relative(scopeRoot, name);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? name : rel;
}

interface ResourceQuestion {
  id: string;
  runner: RunnerKind;
  field: PoolField;
  /** The exact pool entry; this is the key the normalized `resources` map carries. */
  name: string;
}

/**
 * The Jev spec client (ADR-035): exactly one `systemOne` request per spec
 * carrying the probe-2b quality gate, the category confirm/override choice, the
 * B13 `missing_area` composition advisory over the planned team, and
 * runner-qualified per-resource nouls covering every chain candidate — the
 * pools are per-runner, so one answer serves every candidate on that runner and
 * a category override or chain fallback never needs a second call. No retries,
 * logging, repair calls, or model listing. Outcomes carry reason codes and a
 * bounded HTTP status only — never API messages, bodies, or credentials.
 */
export class TypeSafeSpecClient {
  private readonly options: TypeSafeSpecOptions;

  constructor(options: TypeSafeSpecOptions = {}) {
    this.options = options;
  }

  async evaluate(input: SpecEvaluationInput, signal: AbortSignal): Promise<SpecEvaluation> {
    if (signal.aborted) return refuse("aborted");
    if (!validSpec(input.spec)) return refuse("invalid_response", "spec");
    const team: readonly LaunchSpec[] = input.team === undefined ? [input.spec] : input.team;
    if (!Array.isArray(team) || team.length === 0 || !team.every(validSpec)) return refuse("invalid_response", "team");
    const categories: unknown = record(input.catalog) ? input.catalog.categories : undefined;
    const runners: unknown = record(input.catalog) ? input.catalog.runners : undefined;
    if (!isReadonlyMap<string, readonly ChainCandidate[]>(categories) || categories.size === 0 || !isReadonlyMap<RunnerKind, RunnerEntry>(runners)) {
      return refuse("catalog_unavailable", "catalog");
    }
    const catalog = input.catalog;
    const apiKey = this.options.apiKey ?? await resolveTypesafeApiKey(this.options.credentials);
    if (apiKey === undefined || apiKey.length === 0) return refuse("authentication_unavailable", "api_key");

    const questions: Questions = {
      [QUALITY_INSTRUCTIONS]: noul(
        "Are these instructions sufficient for a competent agent to begin this work correctly? Detailed methodology may arrive via separately selected skills — judge only whether the instructions state the agent's job and conduct clearly enough to start.",
        {
          true: "The instructions state the job and expected conduct clearly enough to begin correctly.",
          false: "The instructions are too vague or missing for the agent to know what job it has or how to behave.",
        }
      ),
      [QUALITY_ASSIGNMENT]: noul(
        "Does assignment.verification name concrete, checkable evidence a supervisor could verify without re-doing the work?",
        {
          true: "Verification specifies concrete, falsifiable evidence (tests, outputs, diffs, artifacts).",
          false: "Verification is vague ('it works'), absent, or requires re-doing the work to check.",
        }
      ),
      [CATEGORY_QUESTION]: choice(
        input.spec.category === undefined
          ? "Which catalog category best fits this spec's label, instructions, and assignment? Each option lists that category's ordered chain of runner/model candidates; the first eligible candidate is used."
          : `The caller proposed the "${input.spec.category}" category. Which catalog category best fits this spec's label, instructions, and assignment? Confirm the proposed category, or override it only when another category is a clearly better fit. Each option lists that category's ordered chain of runner/model candidates; the first eligible candidate is used.`,
        Object.fromEntries(
          [...categories.entries()].map(([name, chain]) => [
            name,
            {
              chain: chain.map((candidate) => {
                const entry: Record<string, string> = { runner: candidate.runner, model: candidate.model };
                if (candidate.account !== undefined) entry.account = candidate.account;
                return entry;
              }),
            },
          ])
        )
      ),
      // B13 composition advisory — never a gate: the answer feeds an advisory
      // field on the decision, so a missing or malformed answer degrades to
      // "no advisory" instead of an abstention.
      [COMPOSITION_QUESTION]: noul(
        "Is the planned team in `team` missing a distinct contribution — work the specs' assignments call for but no listed spec provides?",
        {
          true: "A distinct contribution is missing — e.g., independent verification of a member's own work, research before implementation, or coordination across members.",
          false: "The listed specs cover their assignments; another member would duplicate, not complement.",
        }
      ),
    };

    // Runner-qualified nouls dedupe across candidates: the pools belong to the
    // runner, so a chain listing the same runner twice (or two categories
    // sharing one) asks each resource once.
    const resourceQuestions: ResourceQuestion[] = [];
    const chainRunners = new Set<RunnerKind>();
    for (const chain of categories.values()) for (const candidate of chain) chainRunners.add(candidate.runner);
    const scopeRoot = record(catalog.source) && typeof catalog.source.scopeRoot === "string" ? catalog.source.scopeRoot : "";
    for (const runner of chainRunners) {
      const entry = runners.get(runner);
      if (entry === undefined) return refuse("catalog_unavailable", "catalog");
      for (const field of POOL_FIELDS) {
        entry.pools[field].forEach((name, index) => {
          const id = `${RESOURCE_PREFIX}${runner}_${field}_${index}`;
          const display = displayResource(name, scopeRoot);
          const noun = RESOURCE_NOUN[field];
          questions[id] = noul(
            `Would an agent executing this spec on the ${runner} runner plausibly need the ${noun} "${display}" to complete the assignment within scope?`,
            {
              true: `The ${noun} "${display}" is necessary or materially useful for this spec on the ${runner} runner.`,
              false: `The ${noun} "${display}" is unnecessary or out of scope for this spec on the ${runner} runner.`,
            }
          );
          resourceQuestions.push({ id, runner, field, name });
        });
      }
    }

    const spec = input.spec;
    const outbound = {
      spec: specState(spec),
      team: team.map(specState),
    };

    let response: unknown;
    try {
      const client = createTypeSafeClient({
        apiKey,
        defaultModel: SPEC_MODEL,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      });
      response = await client.systemOne({ state: outbound as EntryType, questions }, { signal });
    } catch (error) {
      if (signal.aborted) return refuse("aborted");
      return refuse("transport_failed", error instanceof APIError ? `http_${error.status}` : "transport");
    }
    const evaluated = this.normalize(response, categories, resourceQuestions, team.map((member) => member.label));
    if (evaluated.kind === "response" && signal.aborted) return refuse("aborted");
    return evaluated;
  }

  /**
   * Boundary validation of the wire response: the SDK's generic answer types
   * are not trusted. Every sent question must answer with its own type; an
   * answer that fails validation abstains `invalid_response` naming the
   * question id, never silently accepted. The `missing_area` advisory is the
   * deliberate exception — it is not a gate, so its answer degrades to no
   * advisory rather than an abstention.
   */
  private normalize(body: unknown, categories: ReadonlyMap<string, readonly ChainCandidate[]>, resourceQuestions: readonly ResourceQuestion[], assessed: readonly string[]): SpecEvaluation {
    if (!record(body) || !record(body.answers)) return refuse("invalid_response", "response");
    const answers = body.answers;
    const instructions = parseNoulAnswer(answers[QUALITY_INSTRUCTIONS]);
    if (instructions === undefined) return refuse("invalid_response", QUALITY_INSTRUCTIONS);
    const assignment = parseNoulAnswer(answers[QUALITY_ASSIGNMENT]);
    if (assignment === undefined) return refuse("invalid_response", QUALITY_ASSIGNMENT);
    const categoryNames = [...categories.keys()];
    const picked = parseChoiceAnswer(answers[CATEGORY_QUESTION], categoryNames);
    if (picked === undefined) return refuse("invalid_response", CATEGORY_QUESTION);

    const resourcesByRunner = new Map<RunnerKind, Record<string, Record<string, number>>>();
    for (const question of resourceQuestions) {
      const value = parseNoulAnswer(answers[question.id]);
      if (value === undefined) return refuse("invalid_response", question.id);
      let fields = resourcesByRunner.get(question.runner);
      if (fields === undefined) resourcesByRunner.set(question.runner, fields = {});
      (fields[question.field] ??= {})[question.name] = value;
    }

    const chain = categories.get(picked.choice)!;
    const candidates: CandidateJudgment[] = chain.map((candidate, index) => ({
      index,
      runner: candidate.runner,
      model: candidate.model,
      resources: resourcesByRunner.get(candidate.runner) ?? {},
    }));
    // Advisory only: an unparseable `missing_area` omits `composition` — the
    // evaluation never abstains on it, so it can never gate a launch.
    const missingArea = parseNoulAnswer(answers[COMPOSITION_QUESTION]);
    return {
      kind: "response",
      response: {
        quality: { instructions_adequate: instructions, assignment_verifiable: assignment },
        category: { category: picked.choice, confidence: picked.confidence },
        candidates,
        ...(missingArea === undefined ? {} : { composition: { missing_area: missingArea, assessed: [...assessed] } }),
      },
    };
  }
}
