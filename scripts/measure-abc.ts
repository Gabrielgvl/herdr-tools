import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  SUPERVISION_BLOCKED_THRESHOLD,
  SUPERVISION_EVIDENCE_THRESHOLD,
  SUPERVISION_PROGRESS_THRESHOLD,
  SUPERVISION_RISK_THRESHOLD,
  SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD,
  SUPERVISION_STALLED_THRESHOLD,
} from "../src/reviewer.js";
import {
  SUPERVISION_REPRESENTATIONS,
  type SupervisionRepresentation,
} from "../src/supervision/review-log.js";

export const ABC_REPLAY_TYPE = "abc-replay" as const;
export const ABC_OUTCOME_TYPE = "supervision-outcome" as const;
export const ABC_SIGNALS = ["progress", "stalled", "blocked", "risk"] as const;

export type AbcSignal = (typeof ABC_SIGNALS)[number];

type SignalProbabilities = Record<AbcSignal | "appears_complete", number>;
type OutcomeSignals = Record<AbcSignal, boolean>;

interface Observation {
  cadence: string;
  representation: SupervisionRepresentation;
  evidenceSufficiency?: number;
  signals?: SignalProbabilities;
  previousClassification: string | null;
  attention: boolean;
  tokens?: number;
  payloadBytes?: number;
}

interface Outcome {
  cadence: string;
  signals: OutcomeSignals;
  wake: boolean;
}

export interface RatioMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface UsageMetric {
  samples: number;
  total: number;
  mean: number | null;
}

export interface RepresentationMeasurement {
  status: "measured" | "skipped";
  reason?: "no_observations" | "vcc_supervision_view_unavailable";
  observations: number;
  pairedCadences: number;
  evidenceSufficient: RatioMetric;
  accuracy: Record<AbcSignal, RatioMetric>;
  tokens: UsageMetric;
  payloadBytes: UsageMetric;
  falsePositiveWakeups: RatioMetric;
  missedWakeups: RatioMetric;
}

export interface AbcMeasurementReport {
  schemaVersion: 1;
  thresholds: {
    evidenceSufficient: number;
    progress: number;
    stalled: number;
    stalledFirstObservation: number;
    blocked: number;
    risk: number;
  };
  outcomes: number;
  diagnostics: {
    inputRecords: number;
    reviewRecords: number;
    replayRecords: number;
    outcomeRecords: number;
    ignoredRecords: number;
    inferredLegacyARecords: number;
    rejectedCReplays: number;
    unpairedObservations: number;
    unusedOutcomes: number;
  };
  representations: Record<SupervisionRepresentation, RepresentationMeasurement>;
}

export interface AbcMeasurementFiles {
  reviewsPath: string;
  decisionsPath: string;
  fixturePaths?: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a probability`);
  }
  return value;
}

function optionalProbability(value: unknown, label: string): number | undefined {
  return value === null || value === undefined ? undefined : probability(value, label);
}

function counter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function optionalCounter(value: unknown, label: string): number | undefined {
  return value === null || value === undefined ? undefined : counter(value, label);
}

function representation(value: unknown, label: string): SupervisionRepresentation {
  if (typeof value !== "string" || !(SUPERVISION_REPRESENTATIONS as readonly string[]).includes(value)) {
    throw new Error(`${label} has an unknown representation`);
  }
  return value as SupervisionRepresentation;
}

function cadenceKey(value: Record<string, unknown>, timeField: "atMs" | "reviewAtMs", label: string): string {
  if (typeof value.jobId !== "string" || value.jobId.length === 0) throw new Error(`${label} is missing jobId`);
  const atMs = counter(value[timeField], `${label}.${timeField}`);
  return JSON.stringify([value.jobId, atMs]);
}

function probabilities(value: unknown, label: string): SignalProbabilities | undefined {
  if (value === null || value === undefined) return undefined;
  if (!record(value)) throw new Error(`${label} must be an object`);
  return {
    progress: probability(value.progress, `${label}.progress`),
    stalled: probability(value.stalled, `${label}.stalled`),
    blocked: probability(value.blocked, `${label}.blocked`),
    risk: probability(value.risk, `${label}.risk`),
    appears_complete: probability(value.appears_complete, `${label}.appears_complete`),
  };
}

function truths(value: unknown, label: string): OutcomeSignals {
  if (!record(value)) throw new Error(`${label} must be an object`);
  const result = {} as OutcomeSignals;
  for (const signal of ABC_SIGNALS) {
    if (typeof value[signal] !== "boolean") throw new Error(`${label}.${signal} must be boolean`);
    result[signal] = value[signal];
  }
  return result;
}

function bytesForPayload(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined) throw new Error("payload is not JSON serializable");
  return Buffer.byteLength(serialized, "utf8");
}

function observationUsage(value: Record<string, unknown>, fallbackBytes?: unknown): Pick<Observation, "tokens" | "payloadBytes"> {
  const tokens = optionalCounter(value.tokens, "observation.tokens");
  const payloadBytes = value.payload === undefined
    ? optionalCounter(value.payloadBytes ?? fallbackBytes, "observation.payloadBytes")
    : bytesForPayload(value.payload);
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(payloadBytes === undefined ? {} : { payloadBytes }),
  };
}

function validSupervisionView(value: unknown): boolean {
  if (!record(value) || value.compiler !== "vcc-supervision" || value.contractVersion !== 1 || !Array.isArray(value.lines)) return false;
  return value.lines.every((line) => record(line) && typeof line.ref === "string" && typeof line.text === "string");
}

function reviewObservation(value: Record<string, unknown>): { observation?: Observation; inferredLegacyA: boolean } {
  const label = "review record";
  const provenance = value.provenance;
  let selected: SupervisionRepresentation | undefined;
  let inferredLegacyA = false;
  if (record(provenance)) {
    selected = representation(provenance.representation, label);
  } else if (provenance === null || provenance === undefined) {
    const evidence = value.evidence;
    const transcriptLines = record(evidence) ? evidence.transcriptLines : undefined;
    if (typeof transcriptLines === "number" && Number.isSafeInteger(transcriptLines) && transcriptLines >= 0 && transcriptLines <= 100) {
      selected = "A-tmux-lines";
      inferredLegacyA = true;
    }
  } else {
    throw new Error(`${label}.provenance must be an object or null`);
  }
  if (selected === undefined) return { inferredLegacyA };
  if (typeof value.attention !== "boolean") throw new Error(`${label}.attention must be boolean`);
  const previous = value.previousClassification;
  if (previous !== null && previous !== undefined && typeof previous !== "string") throw new Error(`${label}.previousClassification must be a string or null`);
  return {
    inferredLegacyA,
    observation: {
      cadence: cadenceKey(value, "atMs", label),
      representation: selected,
      evidenceSufficiency: optionalProbability(value.evidenceSufficiency, `${label}.evidenceSufficiency`),
      signals: probabilities(value.signals, `${label}.signals`),
      previousClassification: typeof previous === "string" ? previous : null,
      attention: value.attention,
      ...observationUsage(value, record(provenance) ? provenance.stateBytes : undefined),
    },
  };
}

function replayObservation(value: Record<string, unknown>): { observation?: Observation; rejectedC: boolean } {
  const label = "ABC replay record";
  const selected = representation(value.representation, label);
  if (selected === "C-vcc-supervision-view" && !validSupervisionView(value.supervisionView)) {
    return { rejectedC: true };
  }
  if (typeof value.attention !== "boolean") throw new Error(`${label}.attention must be boolean`);
  const previous = value.previousClassification;
  if (previous !== null && previous !== undefined && typeof previous !== "string") throw new Error(`${label}.previousClassification must be a string or null`);
  const viewBytes = selected === "C-vcc-supervision-view" && value.payload === undefined && value.payloadBytes === undefined
    ? bytesForPayload(value.supervisionView)
    : undefined;
  return {
    rejectedC: false,
    observation: {
      cadence: cadenceKey(value, "reviewAtMs", label),
      representation: selected,
      evidenceSufficiency: optionalProbability(value.evidenceSufficiency, `${label}.evidenceSufficiency`),
      signals: probabilities(value.signals, `${label}.signals`),
      previousClassification: typeof previous === "string" ? previous : null,
      attention: value.attention,
      ...observationUsage(value, viewBytes),
    },
  };
}

function outcome(value: Record<string, unknown>): Outcome {
  if (typeof value.wake !== "boolean") throw new Error("supervision outcome.wake must be boolean");
  return {
    cadence: cadenceKey(value, "reviewAtMs", "supervision outcome"),
    signals: truths(value.signals, "supervision outcome.signals"),
    wake: value.wake,
  };
}

function ratio(numerator: number, denominator: number): RatioMetric {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

function usage(values: Array<number | undefined>): UsageMetric {
  const measured = values.filter((value): value is number => value !== undefined);
  const total = measured.reduce((sum, value) => sum + value, 0);
  return { samples: measured.length, total, mean: measured.length === 0 ? null : total / measured.length };
}

function signalPrediction(observation: Observation, signal: AbcSignal): boolean | undefined {
  const signals = observation.signals;
  if (signals === undefined) return undefined;
  if (signal === "risk") return signals.risk >= SUPERVISION_RISK_THRESHOLD;
  if (signal === "blocked") return signals.blocked >= SUPERVISION_BLOCKED_THRESHOLD;
  if (observation.evidenceSufficiency === undefined) return undefined;
  if (observation.evidenceSufficiency < SUPERVISION_EVIDENCE_THRESHOLD) return false;
  if (signal === "progress") return signals.progress >= SUPERVISION_PROGRESS_THRESHOLD;
  const threshold = observation.previousClassification === null
    ? SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD
    : SUPERVISION_STALLED_THRESHOLD;
  return signals.stalled >= threshold;
}

function measureRepresentation(
  selected: SupervisionRepresentation,
  observations: readonly Observation[],
  outcomes: ReadonlyMap<string, Outcome>,
): RepresentationMeasurement {
  const own = observations.filter((observation) => observation.representation === selected);
  const paired = own.flatMap((observation) => {
    const expected = outcomes.get(observation.cadence);
    return expected === undefined ? [] : [{ observation, expected }];
  });
  const evidence = own.flatMap((observation) => observation.evidenceSufficiency === undefined ? [] : [observation.evidenceSufficiency]);
  const accuracy = {} as Record<AbcSignal, RatioMetric>;
  for (const signal of ABC_SIGNALS) {
    let correct = 0;
    let total = 0;
    for (const pair of paired) {
      const predicted = signalPrediction(pair.observation, signal);
      if (predicted === undefined) continue;
      total += 1;
      if (predicted === pair.expected.signals[signal]) correct += 1;
    }
    accuracy[signal] = ratio(correct, total);
  }
  const noWake = paired.filter((pair) => !pair.expected.wake);
  const shouldWake = paired.filter((pair) => pair.expected.wake);
  return {
    status: own.length === 0 ? "skipped" : "measured",
    ...(own.length === 0 ? { reason: selected === "C-vcc-supervision-view" ? "vcc_supervision_view_unavailable" as const : "no_observations" as const } : {}),
    observations: own.length,
    pairedCadences: paired.length,
    evidenceSufficient: ratio(evidence.filter((value) => value >= SUPERVISION_EVIDENCE_THRESHOLD).length, evidence.length),
    accuracy,
    tokens: usage(own.map((observation) => observation.tokens)),
    payloadBytes: usage(own.map((observation) => observation.payloadBytes)),
    falsePositiveWakeups: ratio(noWake.filter((pair) => pair.observation.attention).length, noWake.length),
    missedWakeups: ratio(shouldWake.filter((pair) => !pair.observation.attention).length, shouldWake.length),
  };
}

/** Compute ADR-036's A/B/C metrics from persisted records and replay fixture records. */
export function measureAbc(records: readonly unknown[]): AbcMeasurementReport {
  const observations: Observation[] = [];
  const outcomes = new Map<string, Outcome>();
  const observationKeys = new Set<string>();
  let reviewRecords = 0;
  let replayRecords = 0;
  let outcomeRecords = 0;
  let ignoredRecords = 0;
  let inferredLegacyARecords = 0;
  let rejectedCReplays = 0;

  for (const value of records) {
    if (!record(value)) {
      ignoredRecords += 1;
      continue;
    }
    if (value.type === "review") {
      reviewRecords += 1;
      const parsed = reviewObservation(value);
      if (parsed.inferredLegacyA) inferredLegacyARecords += 1;
      if (parsed.observation === undefined) continue;
      const key = `${parsed.observation.representation}:${parsed.observation.cadence}`;
      if (observationKeys.has(key)) throw new Error("duplicate representation observation for one cadence");
      observationKeys.add(key);
      observations.push(parsed.observation);
      continue;
    }
    if (value.type === ABC_REPLAY_TYPE) {
      replayRecords += 1;
      const parsed = replayObservation(value);
      if (parsed.rejectedC) {
        rejectedCReplays += 1;
        continue;
      }
      const observation = parsed.observation!;
      const key = `${observation.representation}:${observation.cadence}`;
      if (observationKeys.has(key)) throw new Error("duplicate representation observation for one cadence");
      observationKeys.add(key);
      observations.push(observation);
      continue;
    }
    if (value.type === ABC_OUTCOME_TYPE) {
      outcomeRecords += 1;
      const parsed = outcome(value);
      if (outcomes.has(parsed.cadence)) throw new Error("duplicate supervision outcome for one cadence");
      outcomes.set(parsed.cadence, parsed);
      continue;
    }
    ignoredRecords += 1;
  }

  const observedCadences = new Set(observations.map((observation) => observation.cadence));
  return {
    schemaVersion: 1,
    thresholds: {
      evidenceSufficient: SUPERVISION_EVIDENCE_THRESHOLD,
      progress: SUPERVISION_PROGRESS_THRESHOLD,
      stalled: SUPERVISION_STALLED_THRESHOLD,
      stalledFirstObservation: SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD,
      blocked: SUPERVISION_BLOCKED_THRESHOLD,
      risk: SUPERVISION_RISK_THRESHOLD,
    },
    outcomes: outcomes.size,
    diagnostics: {
      inputRecords: records.length,
      reviewRecords,
      replayRecords,
      outcomeRecords,
      ignoredRecords,
      inferredLegacyARecords,
      rejectedCReplays,
      unpairedObservations: observations.filter((observation) => !outcomes.has(observation.cadence)).length,
      unusedOutcomes: [...outcomes.keys()].filter((cadence) => !observedCadences.has(cadence)).length,
    },
    representations: Object.fromEntries(SUPERVISION_REPRESENTATIONS.map((selected) => [
      selected,
      measureRepresentation(selected, observations, outcomes),
    ])) as Record<SupervisionRepresentation, RepresentationMeasurement>,
  };
}

export async function readJsonl(path: string): Promise<unknown[]> {
  const content = await readFile(path, "utf8");
  const records: unknown[] = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as unknown);
    } catch {
      throw new Error(`${path}:${index + 1} is not valid JSON`);
    }
  }
  return records;
}

export async function measureAbcFiles(paths: AbcMeasurementFiles): Promise<AbcMeasurementReport> {
  const inputs = [paths.reviewsPath, paths.decisionsPath, ...(paths.fixturePaths ?? [])];
  const groups = await Promise.all(inputs.map((path) => readJsonl(path)));
  return measureAbc(groups.flat());
}

function help(): string {
  return [
    "Usage: tsx scripts/measure-abc.ts [options]",
    "  --reviews <path>    persisted supervision reviews JSONL",
    "  --decisions <path>  decision/outcome JSONL",
    "  --fixture <path>    replay JSONL; repeat for more fixtures",
  ].join("\n");
}

export async function runMeasureAbc(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      reviews: { type: "string", default: resolve(".herdr/supervision/reviews.jsonl") },
      decisions: { type: "string", default: resolve(".herdr/router/decisions.jsonl") },
      fixture: { type: "string", multiple: true },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const report = await measureAbcFiles({
    reviewsPath: values.reviews,
    decisionsPath: values.decisions,
    fixturePaths: values.fixture,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv.some((value) => resolve(value) === scriptPath)) {
  runMeasureAbc(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`measure-abc: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
