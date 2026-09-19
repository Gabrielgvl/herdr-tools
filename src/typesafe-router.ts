import {
  APIError,
  TypeSafeClient,
  choice,
  noul,
  score,
  type EntryType,
  type Fetch,
  type Questions,
} from "@typesafe-ai/sdk";
import {
  assembleRouteDecision,
  groupByRole,
  type Abstain,
  type RoleJudgment,
  type RouterCatalogEntry,
  type RouterResult,
  type RouterState,
} from "./router.js";

const ROUTER_MODEL = "jev-latest";
const PROBABILITY_SUM_TOLERANCE = 1e-6;

/**
 * Semantic agent counts one through five; wire legend/probability keys stay the
 * SDK's zero-based score indexes "0" through "4". The wording is the ratified
 * routing contract and must not be reworded.
 */
const SCORE_CRITERIA = [
  "One agent covers this role's useful contribution without a distinct contribution for an additional agent.",
  "Two agents have distinct useful contributions in this role; additional agents would duplicate that work.",
  "Three agents have distinct useful contributions in this role; additional agents would duplicate that work.",
  "Four agents have distinct useful contributions in this role; additional agents would duplicate that work.",
  "Five agents have distinct useful contributions in this role."
] as const;

/** Validated evidence for one answered routing question; only numeric payloads. */
export type RouterQuestionEvidence =
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

/**
 * Validated per-question probability evidence keyed by question id. Only
 * answers that passed validation and that policy actually consumes appear here;
 * an unused no-Role Choice is never copied.
 */
export type RouterProbabilities = Record<string, RouterQuestionEvidence>;

export interface RouteOutcome {
  result: RouterResult;
  probabilities: RouterProbabilities;
}

export interface TypeSafeRouterOptions {
  apiKey?: string;
  fetch?: Fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function refuse(reason: Abstain["reason"], component?: string, probabilities: RouterProbabilities = {}): RouteOutcome {
  return {
    result: component === undefined ? { kind: "abstain", reason } : { kind: "abstain", reason, component },
    probabilities
  };
}

/** The component blamed for an incompatible answer, or "response" for a malformed body. */
interface IncompatibleAnswer {
  component: string;
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

function parseScoreAnswer(answer: unknown): { value: number; confidence: number; probabilities: Record<string, number> } | undefined {
  if (!record(answer) || answer.type !== "score") return undefined;
  const keys = SCORE_CRITERIA.map((_, index) => String(index));
  const legend = answer.legend;
  if (!record(legend) || Object.keys(legend).length !== SCORE_CRITERIA.length || !keys.every((key, index) => legend[key] === SCORE_CRITERIA[index])) {
    return undefined;
  }
  if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > SCORE_CRITERIA.length - 1) return undefined;
  if (!probability(answer.confidence)) return undefined;
  const probabilities = distribution(answer.probabilities, keys);
  if (probabilities === undefined) return undefined;
  return { value: answer.score, confidence: answer.confidence, probabilities };
}

function parseChoiceAnswer(answer: unknown, candidates: readonly string[]): { profile: string; confidence: number; probabilities: Record<string, number> } | undefined {
  if (!record(answer) || answer.type !== "choice") return undefined;
  if (typeof answer.choice !== "string" || !candidates.includes(answer.choice)) return undefined;
  if (!probability(answer.confidence)) return undefined;
  const probabilities = distribution(answer.probabilities, candidates);
  if (probabilities === undefined) return undefined;
  return { profile: answer.choice, confidence: answer.confidence, probabilities };
}

/**
 * Boundary validation of the wire response: the SDK's generic answer types are
 * not trusted. Every Noul and Score must validate; a Choice that fails
 * validation is treated as absent so N1 policy can ignore it for a no-Role or
 * reject it for a yes-Role. Validated evidence accumulates in `out`.
 */
function parseAnswers(body: unknown, groups: ReadonlyMap<string, RouterCatalogEntry[]>, out: RouterProbabilities): RoleJudgment[] | IncompatibleAnswer {
  if (!record(body) || !record(body.answers)) return { component: "response" };
  const answers = body.answers;
  const judgments: RoleJudgment[] = [];
  for (const [role, roleProfiles] of groups) {
    const candidates = roleProfiles.map((entry) => entry.name);
    const usefulId = `${role}_useful`;
    const noulProbability = parseNoulAnswer(answers[usefulId]);
    if (noulProbability === undefined) return { component: usefulId };
    out[usefulId] = { type: "noul", noul: noulProbability };
    const countId = `${role}_count`;
    const scored = parseScoreAnswer(answers[countId]);
    if (scored === undefined) return { component: countId };
    out[countId] = { type: "score", score: scored.value, confidence: scored.confidence, probabilities: scored.probabilities };
    const selected = parseChoiceAnswer(answers[`${role}_profile`], candidates);
    if (selected !== undefined && noulProbability >= 0.5) {
      out[`${role}_profile`] = { type: "choice", choice: selected.profile, confidence: selected.confidence, probabilities: selected.probabilities };
    }
    judgments.push({
      role,
      candidates,
      noul: noulProbability,
      score: { value: scored.value, confidence: scored.confidence },
      ...(selected === undefined ? {} : { choice: { profile: selected.profile, confidence: selected.confidence } })
    });
  }
  return judgments;
}

/**
 * The Jev routing client: one `systemOne` request carrying every Role's Noul,
 * Score, and Choice questions over the projected catalog. No retries, logging,
 * repair calls, or model listing. Exposed evidence carries reason codes and a
 * bounded HTTP status only — never API messages, bodies, or credentials.
 */
export class TypeSafeRouter {
  private readonly apiKey: string | undefined;
  private readonly fetchCall: Fetch | undefined;

  constructor(options: TypeSafeRouterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.fetchCall = options.fetch;
  }

  async route(state: RouterState, signal: AbortSignal): Promise<RouteOutcome> {
    if (signal.aborted) return refuse("aborted");
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      return refuse("authentication_unavailable", "api_key");
    }
    if (!Array.isArray(state.catalog) || state.catalog.length === 0) {
      return refuse("catalog_unavailable", "catalog");
    }
    const groups = groupByRole(state.catalog);
    const questions: Questions = {};
    for (const [role, roleProfiles] of groups) {
      questions[`${role}_useful`] = noul(
        `Would agents performing the ${role} role contribute useful, in-scope work toward assignment.objective, given assignment.scope, assignment.verification, and the profiles for this role in catalog?`,
        {
          true: `The ${role} role has useful work within the supplied scope that contributes to the objective and verification.`,
          false: `The ${role} role has no useful in-scope contribution to the supplied objective and verification.`
        }
      );
      questions[`${role}_count`] = score(
        `Assuming the ${role} role is useful, how many agents performing this role are warranted by distinct useful contributions within assignment.scope? Each receives the same objective, scope, and verification.`,
        SCORE_CRITERIA
      );
      questions[`${role}_profile`] = choice(
        `Assuming the ${role} role is useful, which profile for this role best fits assignment.objective, assignment.scope, and assignment.verification, considering its description, runner, model, and timeout in catalog?`,
        Object.fromEntries(roleProfiles.map(({ name, description, runner, model, timeout }) => [name, { description, runner, model, timeout }]))
      );
    }
    const outbound = {
      assignment: {
        objective: state.assignment.objective,
        scope: state.assignment.scope,
        verification: state.assignment.verification
      },
      catalog: state.catalog.map(({ name, description, runner, model, timeout }) => ({ name, description, runner, model, timeout }))
    };
    let response: unknown;
    try {
      const client = new TypeSafeClient({
        apiKey: this.apiKey,
        defaultModel: ROUTER_MODEL,
        logLevel: "off",
        retry: { maxRetries: 0 },
        ...(this.fetchCall === undefined ? {} : { fetch: this.fetchCall })
      });
      response = await client.systemOne({ state: outbound as EntryType, questions }, { signal });
    } catch (error) {
      if (signal.aborted) return refuse("aborted");
      return refuse("transport_failed", error instanceof APIError ? `http_${error.status}` : "transport");
    }
    const probabilities: RouterProbabilities = {};
    const parsed = parseAnswers(response, groups, probabilities);
    if (!Array.isArray(parsed)) return refuse("invalid_response", parsed.component, probabilities);
    if (signal.aborted) return refuse("aborted", undefined, probabilities);
    return { result: assembleRouteDecision(parsed), probabilities };
  }
}
