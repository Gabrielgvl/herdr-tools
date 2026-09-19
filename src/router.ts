import type { LaunchAssignment } from "./launch-schema.js";
import type { Profile, ProfileCatalog } from "./profiles/types.js";

export interface RouterCatalogEntry {
  name: string;
  description: string;
  runner: Profile["runtime"]["kind"];
  model: string;
  timeout: number;
}

export interface RouterState {
  assignment: LaunchAssignment;
  catalog: RouterCatalogEntry[];
}

export interface Assignment {
  profile: string;
  count: number;
  purpose: string;
}

export interface RouteDecision {
  kind: "route";
  assignments: Assignment[];
}

export interface Abstain {
  kind: "abstain";
  reason:
    | "low_confidence"
    | "no_assignments"
    | "catalog_unavailable"
    | "invalid_response"
    | "authentication_unavailable"
    | "transport_failed"
    | "aborted";
  component?: string;
}

export type RouterResult = RouteDecision | Abstain;

export const ROUTER_CONFIDENCE_THRESHOLD = 0.8;

/** One Role's validated judgments plus its exact projected candidate names. */
export interface RoleJudgment {
  role: string;
  candidates: readonly string[];
  /** Noul probability of yes, finite in [0,1]. */
  noul: number;
  /** Expected Score level, finite in [0,4], with its reported confidence in [0,1]. */
  score: { value: number; confidence: number };
  /** Selected Profile and its confidence; ignored when the Role answers no. */
  choice?: { profile: string; confidence: number };
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function abstain(reason: Abstain["reason"], component?: string): Abstain {
  return component === undefined ? { kind: "abstain", reason } : { kind: "abstain", reason, component };
}

/** The Role a Profile serves: the segment before the first `-`, or the whole name. */
export function roleForProfile(name: string): string {
  const dash = name.indexOf("-");
  return dash === -1 ? name : name.slice(0, dash);
}

/** Stable name-sorted five-field projection of the effective catalog; nothing else reaches Jev. */
export function projectRouterCatalog(catalog: ProfileCatalog): RouterCatalogEntry[] {
  return [...catalog.effective.values()]
    .sort((left, right) => ordinal(left.name, right.name))
    .map((profile) => ({
      name: profile.name,
      description: profile.description,
      runner: profile.runtime.kind,
      model: profile.runtime.model,
      timeout: profile.timeoutMinutes
    }));
}

/** Local grouping for per-Role questions; the projection itself stays flat. */
export function groupByRole(entries: readonly RouterCatalogEntry[]): Map<string, RouterCatalogEntry[]> {
  const groups = new Map<string, RouterCatalogEntry[]>();
  for (const entry of entries) {
    const role = roleForProfile(entry.name);
    const group = groups.get(role);
    if (group) group.push(entry);
    else groups.set(role, [entry]);
  }
  return groups;
}

/**
 * Loads the same manager/session-rooted catalog as explicit launch, once per
 * decision. A loader that is absent, throws, or reports an unreadable scope
 * cannot be projected authoritatively; blocked names are already absent from
 * the effective map and are never invented back.
 */
export async function loadRouterCatalog(profiles: { load: () => Promise<ProfileCatalog> } | undefined): Promise<RouterCatalogEntry[] | Abstain> {
  if (profiles === undefined) return abstain("catalog_unavailable", "catalog");
  let catalog: ProfileCatalog;
  try {
    catalog = await profiles.load();
  } catch {
    return abstain("catalog_unavailable", "catalog");
  }
  if (!catalog || !(catalog.effective instanceof Map) || (catalog.unreadableScopes?.length ?? 0) > 0) {
    return abstain("catalog_unavailable", "catalog");
  }
  return projectRouterCatalog(catalog);
}

/**
 * Deterministic whole-decision policy: every applicable component gates at
 * ROUTER_CONFIDENCE_THRESHOLD or the entire decision abstains. Only a no
 * Role's Choice is ignored; its Score confidence is still gated. Confidences
 * are never multiplied.
 */
export function assembleRouteDecision(judgments: readonly RoleJudgment[]): RouterResult {
  const ordered = [...judgments].sort((left, right) => ordinal(left.role, right.role));
  const selected: Array<{ role: string; assignment: Assignment }> = [];
  for (const judgment of ordered) {
    const usefulId = `${judgment.role}_useful`;
    if (!probability(judgment.noul)) return abstain("invalid_response", usefulId);
    // Binary confidence derives from the probability of the chosen answer.
    if (Math.max(judgment.noul, 1 - judgment.noul) < ROUTER_CONFIDENCE_THRESHOLD) return abstain("low_confidence", usefulId);
    const useful = judgment.noul >= 0.5;
    const countId = `${judgment.role}_count`;
    const scoreValue = judgment.score?.value;
    const scoreConfidence = judgment.score?.confidence;
    if (typeof scoreValue !== "number" || !Number.isFinite(scoreValue) || scoreValue < 0 || scoreValue > 4 || !probability(scoreConfidence)) {
      return abstain("invalid_response", countId);
    }
    if (scoreConfidence < ROUTER_CONFIDENCE_THRESHOLD) return abstain("low_confidence", countId);
    if (!useful) continue;
    const profileId = `${judgment.role}_profile`;
    const choice = judgment.choice;
    if (!choice || !probability(choice.confidence) || !Array.isArray(judgment.candidates) || !judgment.candidates.includes(choice.profile)) {
      return abstain("invalid_response", profileId);
    }
    if (choice.confidence < ROUTER_CONFIDENCE_THRESHOLD) return abstain("low_confidence", profileId);
    selected.push({
      role: judgment.role,
      assignment: {
        profile: choice.profile,
        // Nearest level, halves up; a raw score of 0 means one agent.
        count: Math.round(scoreValue) + 1,
        purpose: `Perform the ${judgment.role} role for the supplied objective.`
      }
    });
  }
  if (selected.length === 0) return abstain("no_assignments");
  selected.sort((left, right) => ordinal(left.role, right.role) || ordinal(left.assignment.profile, right.assignment.profile));
  return { kind: "route", assignments: selected.map(({ assignment }) => assignment) };
}
