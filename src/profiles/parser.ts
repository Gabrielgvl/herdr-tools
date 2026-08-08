import { parseDocument, type Node } from "yaml";
import { basename } from "node:path";
import {
  CLAUDE_EFFORTS,
  MAX_PROFILE_BODY_BYTES,
  MAX_PROFILE_BYTES,
  PROFILE_KINDS,
  THINKING_LEVELS,
  type ClaudeEffort,
  type ProfileKind,
  type Profile,
  type ProfileSource,
  type RuntimeProfile,
  type ThinkingLevel,
} from "./types.js";

export class ProfileParseError extends Error {
  readonly code = "INVALID_PROFILE" as const;
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProfileParseError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new ProfileParseError(message, details);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) fail(`${field} must be a non-empty single-line string`, { field });
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}`, { field, key });
}

function arrayOfStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`, { field });
  return value.map((item, index) => stringField(item, `${field}[${index}]`));
}

function optionalTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return arrayOfStrings(value, "runtime.tools");
}

function parseRuntime(value: unknown): RuntimeProfile {
  if (!record(value)) fail("runtime must be an object");
  if (!PROFILE_KINDS.includes(value.kind as ProfileKind)) fail("runtime.kind must be pi or claude");
  if (value.kind === "pi") {
    exactKeys(value, ["kind", "model", "thinking", "tools"], "runtime");
    if (!THINKING_LEVELS.includes(value.thinking as ThinkingLevel)) fail("runtime.thinking is invalid");
    return { kind: "pi", model: stringField(value.model, "runtime.model"), thinking: value.thinking as ThinkingLevel, tools: optionalTools(value.tools) };
  }
  exactKeys(value, ["kind", "model", "effort", "tools"], "runtime");
  if (!CLAUDE_EFFORTS.includes(value.effort as ClaudeEffort)) fail("runtime.effort is invalid");
  return { kind: "claude", model: stringField(value.model, "runtime.model"), effort: value.effort as ClaudeEffort, tools: optionalTools(value.tools) };
}

function yamlValue(node: Node): unknown {
  if ("items" in node && Array.isArray(node.items)) for (const item of node.items) yamlValue(item as Node);
  if ("value" in node && typeof node.value === "object" && node.value !== null) yamlValue(node.value as Node);
  return (node as { toJSON?: () => unknown }).toJSON?.();
}

function frontmatter(text: string): { values: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) fail("profile must start with YAML frontmatter");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) fail("profile frontmatter must have a closing delimiter and Markdown body");
  if (/(^|[\n ])(?:[&*][A-Za-z]|![A-Za-z])/.test(match[1])) fail("YAML anchors, aliases, and tags are not supported");
  const document = parseDocument(match[1], { version: "1.2", schema: "core", strict: true, uniqueKeys: true, prettyErrors: false });
  if (document.errors.length > 0) fail("invalid YAML frontmatter");
  if (document.contents?.constructor.name !== "YAMLMap") fail("YAML frontmatter must be a mapping");
  return { values: yamlValue(document.contents) as Record<string, unknown>, body: match[2] };
}

export function parseProfile(text: string, source: ProfileSource): Profile {
  if (Buffer.byteLength(text, "utf8") > MAX_PROFILE_BYTES) fail("profile exceeds the 64 KiB limit");
  const { values, body } = frontmatter(text);
  if (body.trim().length === 0 || Buffer.byteLength(body, "utf8") > MAX_PROFILE_BODY_BYTES) fail("profile Markdown body must be non-empty and at most 32 KiB");
  exactKeys(values, ["name", "description", "timeoutMinutes", "sessionPersistence", "runtime", "fallbackProfiles"], "profile");
  const name = stringField(values.name, "name");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) fail("name must be lowercase kebab-case", { name });
  if (basename(source.path) !== `${name}.md`) fail("filename stem must equal profile name", { name, path: source.path });
  if (!Number.isInteger(values.timeoutMinutes) || (values.timeoutMinutes as number) < 1 || (values.timeoutMinutes as number) > 60) fail("timeoutMinutes must be an integer from 1 through 60");
  if (typeof values.sessionPersistence !== "boolean") fail("sessionPersistence must be a boolean");
  const fallbackProfiles = values.fallbackProfiles === undefined ? [] : arrayOfStrings(values.fallbackProfiles, "fallbackProfiles");
  for (const fallback of fallbackProfiles) if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(fallback)) fail("fallbackProfiles must contain lowercase kebab-case names", { fallback });
  if (new Set(fallbackProfiles).size !== fallbackProfiles.length) fail("fallbackProfiles must not contain duplicates");
  return { name, description: stringField(values.description, "description"), timeoutMinutes: values.timeoutMinutes as number, sessionPersistence: values.sessionPersistence, runtime: parseRuntime(values.runtime), fallbackProfiles, body, source };
}

export function profileSource(kind: ProfileSource["kind"], path: string, scopeRoot: string): ProfileSource {
  return { kind, path, scopeRoot, precedence: kind === "bundled" ? 0 : kind === "user" ? 1 : 2 };
}
