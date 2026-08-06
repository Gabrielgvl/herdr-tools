import { readFile } from "node:fs/promises";

export const SETTINGS_PATH = "/home/gabriel/.pi/agent/extensions/herdr-tools/config.json";

export interface SettingsFile {
  wait?: {
    reviewCadenceMinutes?: unknown;
    reviewerModel?: unknown;
  };
}

export interface Settings {
  reviewCadenceMinutes: number;
  reviewerModel: string;
  reviewerThinking: "low";
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  reviewCadenceMinutes: 5,
  reviewerModel: "openai-codex/gpt-5.6-luna",
  reviewerThinking: "low"
});

export class SettingsError extends Error {
  readonly code = "INVALID_SETTINGS" as const;
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SettingsError";
  }
}

interface SettingsIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  toolInput?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) throw new SettingsError("Settings must be a JSON object");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "wait")) throw new SettingsError("Settings contains unknown fields");
  const wait = value.wait;
  if (!isRecord(wait)) throw new SettingsError("Settings.wait must be an object");
  if (Object.keys(wait).some((key) => key !== "reviewCadenceMinutes" && key !== "reviewerModel")) {
    throw new SettingsError("Settings.wait contains unknown fields");
  }
  const cadence = wait.reviewCadenceMinutes;
  const model = wait.reviewerModel;
  if (!Number.isInteger(cadence) || (cadence as number) < 1 || (cadence as number) > 30) {
    throw new SettingsError("wait.reviewCadenceMinutes must be an integer from 1 through 30");
  }
  if (typeof model !== "string" || model.trim() === "" || model !== model.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    throw new SettingsError("wait.reviewerModel must be a non-empty model identifier");
  }
  return { reviewCadenceMinutes: cadence as number, reviewerModel: model, reviewerThinking: "low" };
}

export async function loadSettings(io: Partial<SettingsIo> = {}): Promise<Settings> {
  const read = io.readFile ?? ((path: string, encoding: "utf8") => readFile(path, encoding));
  let raw: string;
  try {
    raw = await read(SETTINGS_PATH, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { ...DEFAULT_SETTINGS };
    throw new SettingsError("Unable to read extension-owned settings", { cause: error instanceof Error ? error.message : String(error) });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsError("Extension-owned settings are malformed JSON");
  }
  return parseSettings(parsed);
}
