import { APIError, choice, noul, type EntryType, type Fetch, type Questions } from "@typesafe-ai/sdk";
import type { Catalog } from "./catalog.js";
import { WORKLOAD_INTENTS, type AbstainReason, type Abstained, type RoutingTask, type TaskModelDecision } from "./router.js";
import { QUALITY_TIERS, type QualityTier, type WorkloadIntent, type WorkspaceState } from "./routing-policy.js";
import type { AuthJsonCredentialStore } from "./supervision/auth-json-credential-store.js";
import { createTypeSafeClient, resolveTypesafeApiKey } from "./typesafe-reviewer.js";

const SPEC_MODEL = "jev-latest";
export const MAX_SPEC_REQUEST_BYTES = 96 * 1024;
const PROBABILITY_SUM_TOLERANCE = 1e-6;
const QUALITY_DONE_WHEN = "done_when_verifiable";
const INTENT_QUESTION = "intent";
const TIER_QUESTION = "weakest_sufficient_tier";

const INTENT_DESCRIPTIONS: Record<string, string> = {
  explore: "Understand, navigate, or answer questions about code or data without changing it.",
  reason: "Analyze, design, plan, or evaluate options; judgment-heavy work that may not touch files.",
  implement: "Write, modify, or refactor code or artifacts to achieve the objective.",
  debug: "Diagnose and fix a concrete failure, defect, or unexpected behavior.",
  verify: "Check that existing work meets its contract: run checks, review outputs, validate evidence.",
  review: "Critique completed or in-flight work for correctness, quality, or adherence — not to implement it.",
  coordinate: "Organize, delegate, or synchronize work across agents, tasks, or components.",
};

const TIER_DESCRIPTIONS: Record<QualityTier, string> = {
  utility: "Routine, narrow work where the cheapest competent agent should suffice.",
  economy: "Bounded work needing modest judgment or implementation ability.",
  standard: "Typical production work needing reliable coding and reasoning.",
  strong: "Difficult work with substantial reasoning, debugging, or integration risk.",
  frontier: "Very difficult work where top-tier capability materially improves success.",
  max: "Exceptional work requiring the strongest available capability and reasoning.",
};

export type TaskEvaluation = { kind: "response"; response: TaskModelDecision } | Abstained;

export interface TypeSafeSpecOptions {
  apiKey?: string;
  fetch?: Fetch;
  credentials?: Pick<AuthJsonCredentialStore, "read">;
}

export interface TaskEvaluationInput {
  task: RoutingTask;
  catalog: Catalog;
  workspaceState?: WorkspaceState;
}

/** The exact semantic-only projection sent to Jev. */
export interface EvaluationRequest {
  questions: Questions;
  state: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function refuse(reason: AbstainReason, component?: string, requestSize?: { questions: number; bytes: number }): TaskEvaluation {
  return { kind: "abstained", reason, ...(component === undefined ? {} : { component }), ...(requestSize === undefined ? {} : { requestSize }) };
}

function transportComponent(error: APIError): string {
  const detail = record(error.body) && record(error.body.detail) ? error.body.detail : undefined;
  const errorType = detail?.error_type;
  return typeof errorType === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(errorType)
    ? `http_${error.status}_${errorType}`
    : `http_${error.status}`;
}

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
  return record(answer) && answer.type === "noul" && probability(answer.noul) ? answer.noul : undefined;
}

function parseChoiceAnswer(answer: unknown, candidates: readonly string[]): { choice: string; confidence: number; probabilities: Record<string, number> } | undefined {
  if (!record(answer) || answer.type !== "choice" || typeof answer.choice !== "string" || !candidates.includes(answer.choice) || !probability(answer.confidence)) return undefined;
  const probabilities = distribution(answer.probabilities, candidates);
  return probabilities === undefined ? undefined : { choice: answer.choice, confidence: answer.confidence, probabilities };
}

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

/** One request: Task semantics in state; quality, intent, and weakest sufficient tier in questions. */
export function buildEvaluationRequest(input: TaskEvaluationInput): EvaluationRequest | undefined {
  if (!validTask(input.task)) return undefined;
  return {
    questions: {
      [QUALITY_DONE_WHEN]: noul(
        "Does task.doneWhen contain concrete, falsifiable completion evidence relevant to the task's objective and scope — evidence a supervisor could check without re-doing the work?",
        {
          true: "doneWhen names concrete, falsifiable evidence relevant to this objective and scope.",
          false: "doneWhen is vague, absent, irrelevant, or requires re-doing the work to check.",
        },
      ),
      [INTENT_QUESTION]: choice(
        "Which workload intent best describes this Task? Judge the whole Task, including delegated work.",
        { ...INTENT_DESCRIPTIONS },
      ),
      [TIER_QUESTION]: choice(
        "What is the weakest quality tier likely to complete this exact Task successfully? Judge only the Task semantics; no model, provider, runner, or fallback information is available.",
        { ...TIER_DESCRIPTIONS },
      ),
    },
    state: {
      task: {
        objective: input.task.objective,
        scope: input.task.scope,
        doneWhen: [...input.task.doneWhen],
        constraints: [...input.task.constraints],
      },
    },
  };
}

/** Serialized SDK request size, including the fixed model field. */
export function specRequestSize(request: Pick<EvaluationRequest, "questions" | "state">): { questions: number; bytes: number } {
  return {
    questions: Object.keys(request.questions).length,
    bytes: Buffer.byteLength(JSON.stringify({ model: SPEC_MODEL, state: request.state, questions: request.questions }), "utf8"),
  };
}

export class TypeSafeSpecClient {
  constructor(private readonly options: TypeSafeSpecOptions = {}) {}

  async evaluate(input: TaskEvaluationInput, signal: AbortSignal): Promise<TaskEvaluation> {
    if (signal.aborted) return refuse("aborted");
    if (!validTask(input.task)) return refuse("invalid_response", "task");
    const built = buildEvaluationRequest(input)!;
    const size = specRequestSize(built);
    if (size.bytes > MAX_SPEC_REQUEST_BYTES) return refuse("invalid_response", "request_too_large", size);
    const apiKey = this.options.apiKey ?? await resolveTypesafeApiKey(this.options.credentials);
    if (apiKey === undefined || apiKey.length === 0) return refuse("authentication_unavailable", "api_key");

    let response: unknown;
    try {
      const client = createTypeSafeClient({ apiKey, defaultModel: SPEC_MODEL, ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }) });
      response = await client.systemOne({ state: built.state as EntryType, questions: built.questions }, { signal });
    } catch (error) {
      if (signal.aborted) return refuse("aborted");
      return refuse("transport_failed", error instanceof APIError ? transportComponent(error) : "transport", size);
    }
    const evaluated = this.normalize(response);
    /* c8 ignore next -- the SDK rejects an aborted request before returning a response; retain the post-response fence for foreign fetch implementations. */
    return evaluated.kind === "response" && signal.aborted ? refuse("aborted") : evaluated;
  }

  private normalize(body: unknown): TaskEvaluation {
    if (!record(body) || !record(body.answers)) return refuse("invalid_response", "response");
    const doneWhen = parseNoulAnswer(body.answers[QUALITY_DONE_WHEN]);
    if (doneWhen === undefined) return refuse("invalid_response", QUALITY_DONE_WHEN);
    const pickedIntent = parseChoiceAnswer(body.answers[INTENT_QUESTION], WORKLOAD_INTENTS.filter((intent) => intent !== "unknown"));
    if (pickedIntent === undefined) return refuse("invalid_response", INTENT_QUESTION);
    const pickedTier = parseChoiceAnswer(body.answers[TIER_QUESTION], QUALITY_TIERS);
    if (pickedTier === undefined) return refuse("invalid_response", TIER_QUESTION);
    const intent = (pickedIntent.confidence < 0.8 ? "unknown" : pickedIntent.choice) as WorkloadIntent;
    return {
      kind: "response",
      response: {
        quality: { done_when_verifiable: doneWhen },
        intent: { value: intent, confidence: pickedIntent.confidence, probabilities: pickedIntent.probabilities },
        tier: { value: pickedTier.choice as QualityTier, confidence: pickedTier.confidence, probabilities: pickedTier.probabilities },
        uncertainDimensions: intent === "unknown" ? ["intent"] : [],
      },
    };
  }
}
