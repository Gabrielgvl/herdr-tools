import {
  APIError,
  choice,
  noul,
  type EntryType,
  type Fetch,
  type Questions,
} from "@typesafe-ai/sdk";
import { isAbsolute, relative } from "node:path";
import type { Catalog, RunnerEntry, RunnerKind, RunnerPools } from "./catalog.js";
import {
  MODIFIER_THRESHOLD,
  ROUTER_CONFIDENCE_THRESHOLD,
  SEMANTIC_MODIFIERS,
  WORKLOAD_INTENTS,
  type AbstainReason,
  type Abstained,
  type RoutingTask,
  type SemanticModifier,
  type TaskModelDecision,
} from "./router.js";
import { QUALITY_TIERS, type WorkloadIntent, type WorkspaceState } from "./routing-policy.js";
import type { AuthJsonCredentialStore } from "./supervision/auth-json-credential-store.js";
import { createTypeSafeClient, resolveTypesafeApiKey } from "./typesafe-reviewer.js";

const SPEC_MODEL = "jev-latest";
const PROBABILITY_SUM_TOLERANCE = 1e-6;

const QUALITY_DONE_WHEN = "done_when_verifiable";
const INTENT_QUESTION = "intent";
const RESOURCE_PREFIX = "resource_";
const FITNESS_PREFIX = "fitness:";

const POOL_FIELDS: readonly (keyof RunnerPools)[] = ["tools", "extensions", "skills", "plugins", "mcp"];
type PoolField = (typeof POOL_FIELDS)[number];

const RESOURCE_NOUN: Record<PoolField, string> = {
  tools: "tool",
  extensions: "extension",
  skills: "skill",
  plugins: "plugin",
  mcp: "MCP server",
};

const INTENT_DESCRIPTIONS: Record<string, string> = {
  explore: "Understand, navigate, or answer questions about code or data without changing it.",
  reason: "Analyze, design, plan, or evaluate options; judgment-heavy work that may not touch files.",
  implement: "Write, modify, or refactor code or artifacts to achieve the objective.",
  debug: "Diagnose and fix a concrete failure, defect, or unexpected behavior.",
  verify: "Check that existing work meets its contract: run checks, review outputs, validate evidence.",
  review: "Critique completed or in-flight work for correctness, quality, or adherence — not to implement it.",
  coordinate: "Organize, delegate, or synchronize work across agents, tasks, or components.",
};

const MODIFIER_INSTRUCTIONS: Record<SemanticModifier, { question: string; yes: string; no: string }> = {
  mutation_broad: {
    question: "Does this Task require broad mutation — writes spanning many files or subsystems? Writes the Task delegates to child workers count as part of the Task.",
    yes: "The Task's writes span many files or subsystems, including writes made through delegated children.",
    no: "The Task's writes are bounded or absent.",
  },
  scope_repo_wide: {
    question: "Does this Task span repo-wide semantic breadth — changes across independent subsystems or a global contract? Raw file count alone does not make scope repo-wide.",
    yes: "The Task crosses independent subsystems or a global contract.",
    no: "The Task stays within one subsystem or a local area.",
  },
  horizon_long: {
    question: "Does this Task have a long horizon — for example four or more sequential delegated workers with gated handoffs, or multi-stage work whose later steps depend on earlier results — even within one subsystem?",
    yes: "The Task is multi-stage or long-running in the sense described.",
    no: "The Task completes in a short single stage.",
  },
  ambiguity_high: {
    question: "Is this Task highly ambiguous — are the objective, the approach, or the done-when open to materially different reasonable interpretations?",
    yes: "A competent agent could reasonably interpret the Task in materially different ways.",
    no: "The Task pins down what to do and how to prove it.",
  },
};

const TIER_DESCRIPTIONS: Record<string, string> = {
  utility: "minimize cost and latency, accepting later recovery escalation",
  economy: "optimize cost per successful completion",
  standard: "optimize expected total cost per accepted result",
  strong: "bias toward first-pass completion",
  frontier: "strongly bias toward completion reliability",
  max: "maximize success probability within reviewed limits",
};

/**
 * The client's outcome: either the normalized model response that `routeTask`
 * consumes as `TaskRouteInput.response`, or a typed fail-closed abstention the
 * caller may return verbatim — it is already a `SpecDecision` member.
 */
export type TaskEvaluation = { kind: "response"; response: TaskModelDecision } | Abstained;

export interface TypeSafeSpecOptions {
  /** Explicit key wins; otherwise `resolveTypesafeApiKey` (env → Pi auth store). */
  apiKey?: string;
  fetch?: Fetch;
  /** Credential-store seam for `resolveTypesafeApiKey`; defaults to the real auth.json store. */
  credentials?: Pick<AuthJsonCredentialStore, "read">;
}

export interface TaskEvaluationInput {
  task: RoutingTask;
  catalog: Catalog;
  /** Runtime-owned workspace state; absent means clean. */
  workspaceState?: WorkspaceState;
}

export interface ResourceQuestion {
  id: string;
  runner: RunnerKind;
  field: keyof RunnerPools;
  /** The exact pool entry; this is the key the normalized `resources` map carries. */
  name: string;
}

export interface FitnessQuestion {
  id: string;
  /** The point's position in `catalog.points` — the key the normalized `fitness` map carries. */
  index: number;
  tier: (typeof QUALITY_TIERS)[number];
}

/** The outbound request projection, retained so the size measurer and the tests see exactly what ships. */
export interface EvaluationRequest {
  questions: Questions;
  state: Record<string, unknown>;
  resourceQuestions: readonly ResourceQuestion[];
  fitnessQuestions: readonly FitnessQuestion[];
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

function refuse(reason: AbstainReason, component?: string): TaskEvaluation {
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

/** The Task fields are schema-validated upstream; this guards the boundary against non-Task input. */
function validTask(task: unknown): task is RoutingTask {
  return record(task)
    && typeof task.objective === "string"
    && typeof task.scope === "string"
    && Array.isArray(task.doneWhen)
    && task.doneWhen.every((entry) => typeof entry === "string")
    && Array.isArray(task.constraints)
    && task.constraints.every((entry) => typeof entry === "string")
    && (task.tier === undefined || (typeof task.tier === "string" && (QUALITY_TIERS as readonly string[]).includes(task.tier)));
}

/** Pool entries are scope-resolved paths; the question text shows the scope-relative name. */
function displayResource(name: string, scopeRoot: string): string {
  if (scopeRoot.length === 0) return name;
  const rel = relative(scopeRoot, name);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? name : rel;
}

/**
 * The one `systemOne` request per Task (ADR-037): the done_when_verifiable
 * quality gate, the intent Choice — the only confidence gate — the four
 * one-sided positive modifier Nouls, runner-qualified resource Nouls deduped
 * over the operating points' runners, and six speculative tier-fitness Nouls
 * for every reviewed point. Fitness keys are index-qualified
 * (`fitness:t{tier}:{index}`) because point ids contain colons; the ordered
 * id list rides in `state.points`.
 */
export function buildEvaluationRequest(input: TaskEvaluationInput): EvaluationRequest | undefined {
  const catalog = input.catalog;
  if (!record(catalog) || !isReadonlyMap<RunnerKind, RunnerEntry>(catalog.runners)) return undefined;
  const points = Array.isArray(catalog.points) ? catalog.points : [];

  const questions: Questions = {
    [QUALITY_DONE_WHEN]: noul(
      "Does task.doneWhen contain concrete, falsifiable completion evidence relevant to the task's objective and scope — evidence a supervisor could check without re-doing the work?",
      {
        true: "doneWhen names concrete, falsifiable evidence (tests, outputs, diffs, artifacts) relevant to this objective and scope.",
        false: "doneWhen is vague ('it works'), absent, irrelevant to the objective or scope, or requires re-doing the work to check.",
      }
    ),
    [INTENT_QUESTION]: choice(
      "Which workload intent best describes this Task? Judge the whole Task, including work it delegates to child workers.",
      { ...INTENT_DESCRIPTIONS }
    ),
  };
  for (const name of SEMANTIC_MODIFIERS) {
    const modifier = MODIFIER_INSTRUCTIONS[name];
    questions[name] = noul(modifier.question, { true: modifier.yes, false: modifier.no });
  }

  const scopeRoot = record(catalog.source) && typeof catalog.source.scopeRoot === "string" ? catalog.source.scopeRoot : "";

  // Runner-qualified resource Nouls dedupe across points: the pools belong to
  // the runner, so every point on one runner asks each resource once.
  const resourceQuestions: ResourceQuestion[] = [];
  const resources: Record<string, Record<string, string[]>> = {};
  const pointRunners = new Set<RunnerKind>(points.map((point) => point.runner));
  for (const runner of pointRunners) {
    const entry = catalog.runners.get(runner);
    if (entry === undefined) return undefined;
    const fields: Record<string, string[]> = {};
    for (const field of POOL_FIELDS) {
      fields[field] = [];
      entry.pools[field].forEach((name, index) => {
        const id = `${RESOURCE_PREFIX}${runner}_${field}_${index}`;
        const display = displayResource(name, scopeRoot);
        const noun = RESOURCE_NOUN[field];
        questions[id] = noul(
          `Would an agent executing this Task on the ${runner} runner plausibly need the ${noun} "${display}" to complete the task within scope?`,
          {
            true: `The ${noun} "${display}" is necessary or materially useful for this Task on the ${runner} runner.`,
            false: `The ${noun} "${display}" is unnecessary or out of scope for this Task on the ${runner} runner.`,
          }
        );
        fields[field].push(display);
        resourceQuestions.push({ id, runner, field, name });
      });
    }
    resources[runner] = fields;
  }

  const fitnessQuestions: FitnessQuestion[] = [];
  const pointStates = points.map((point, index) => ({
    index,
    id: point.id,
    runner: point.runner,
    model: point.model,
    ...(point.reasoning === undefined ? {} : { reasoning: point.reasoning }),
    provider: point.provider,
    costClass: point.costClass,
    latencyClass: point.latencyClass,
  }));
  for (const [index, point] of points.entries()) {
    for (const [tierIndex, tier] of QUALITY_TIERS.entries()) {
      const id = `${FITNESS_PREFIX}t${tierIndex}:${index}`;
      questions[id] = noul(
        `Rate the fitness of operating point "${point.id}" for this Task under the "${tier}" quality tier (${TIER_DESCRIPTIONS[tier]}). Fitness is the point's expected success on this exact Task within that tier's reviewed cost and latency envelope.`,
        {
          true: `"${point.id}" is a strong fit for this Task at the ${tier} tier.`,
          false: `"${point.id}" is a poor fit for this Task at the ${tier} tier.`,
        }
      );
      fitnessQuestions.push({ id, index, tier });
    }
  }

  const state = {
    task: {
      objective: input.task.objective,
      scope: input.task.scope,
      doneWhen: [...input.task.doneWhen],
      constraints: [...input.task.constraints],
      ...(input.task.tier === undefined ? {} : { tier: input.task.tier }),
    },
    workspaceState: input.workspaceState ?? "clean",
    points: pointStates,
    resources,
  };
  return { questions, state, resourceQuestions, fitnessQuestions };
}

/** The outbound request's size: the question count plus the serialized `{state, questions}` byte length. */
export function specRequestSize(request: Pick<EvaluationRequest, "questions" | "state">): { questions: number; bytes: number } {
  return { questions: Object.keys(request.questions).length, bytes: Buffer.byteLength(JSON.stringify({ state: request.state, questions: request.questions }), "utf8") };
}

/**
 * The Jev spec client (ADR-037): exactly one `systemOne` request per Task. No
 * retries, logging, repair calls, or model listing. Outcomes carry reason
 * codes and a bounded HTTP status only — never API messages, bodies, or
 * credentials.
 */
export class TypeSafeSpecClient {
  private readonly options: TypeSafeSpecOptions;

  constructor(options: TypeSafeSpecOptions = {}) {
    this.options = options;
  }

  async evaluate(input: TaskEvaluationInput, signal: AbortSignal): Promise<TaskEvaluation> {
    if (signal.aborted) return refuse("aborted");
    if (!validTask(input.task)) return refuse("invalid_response", "task");
    const built = buildEvaluationRequest(input);
    if (built === undefined) return refuse("catalog_unavailable", "catalog");
    const apiKey = this.options.apiKey ?? await resolveTypesafeApiKey(this.options.credentials);
    if (apiKey === undefined || apiKey.length === 0) return refuse("authentication_unavailable", "api_key");

    let response: unknown;
    try {
      const client = createTypeSafeClient({
        apiKey,
        defaultModel: SPEC_MODEL,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      });
      response = await client.systemOne({ state: built.state as EntryType, questions: built.questions }, { signal });
    } catch (error) {
      if (signal.aborted) return refuse("aborted");
      return refuse("transport_failed", error instanceof APIError ? `http_${error.status}` : "transport");
    }
    const evaluated = this.normalize(response, built.resourceQuestions, built.fitnessQuestions);
    if (evaluated.kind === "response" && signal.aborted) return refuse("aborted");
    return evaluated;
  }

  /**
   * Boundary validation of the wire response: the SDK's generic answer types
   * are not trusted. Every sent question must answer with its own type; an
   * answer that fails validation abstains `invalid_response` naming the
   * question id, never silently accepted.
   */
  private normalize(body: unknown, resourceQuestions: readonly ResourceQuestion[], fitnessQuestions: readonly FitnessQuestion[]): TaskEvaluation {
    if (!record(body) || !record(body.answers)) return refuse("invalid_response", "response");
    const answers = body.answers;
    const doneWhen = parseNoulAnswer(answers[QUALITY_DONE_WHEN]);
    if (doneWhen === undefined) return refuse("invalid_response", QUALITY_DONE_WHEN);
    const picked = parseChoiceAnswer(answers[INTENT_QUESTION], WORKLOAD_INTENTS);
    if (picked === undefined) return refuse("invalid_response", INTENT_QUESTION);

    const modifiers: TaskModelDecision["modifiers"] = {};
    for (const name of SEMANTIC_MODIFIERS) {
      const value = parseNoulAnswer(answers[name]);
      if (value === undefined) return refuse("invalid_response", name);
      modifiers[name] = { probability: value, applied: value >= MODIFIER_THRESHOLD, confidence: Math.max(value, 1 - value) };
    }

    const resourcesByRunner: Record<string, Record<string, Record<string, number>>> = {};
    for (const question of resourceQuestions) {
      const value = parseNoulAnswer(answers[question.id]);
      if (value === undefined) return refuse("invalid_response", question.id);
      const fields = (resourcesByRunner[question.runner] ??= {});
      ((fields[question.field] ??= {}))[question.name] = value;
    }

    const fitness: Record<string, Record<string, number>> = {};
    for (const question of fitnessQuestions) {
      const value = parseNoulAnswer(answers[question.id]);
      if (value === undefined) return refuse("invalid_response", question.id);
      ((fitness[String(question.index)] ??= {}))[question.tier] = value;
    }

    return {
      kind: "response",
      response: {
        quality: { done_when_verifiable: doneWhen },
        intent: { value: picked.choice as WorkloadIntent, confidence: picked.confidence, probabilities: picked.probabilities },
        modifiers,
        resources: resourcesByRunner,
        fitness,
        // Intent is the only confidence gate; modifiers never abstain, so the
        // only possible uncertain dimension is the intent itself.
        uncertainDimensions: picked.confidence < ROUTER_CONFIDENCE_THRESHOLD ? ["intent"] : [],
      },
    };
  }
}
