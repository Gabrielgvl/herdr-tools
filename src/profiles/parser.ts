import { parseDocument, type Node } from "yaml";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  CLAUDE_PERMISSION_MODES,
  MAX_PROFILE_BODY_BYTES,
  MAX_PROFILE_BYTES,
  THINKING_LEVELS,
  type ClaudePermissionMode,
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

function relativeResourcePath(value: unknown, field: string): string {
  const path = stringField(value, field);
  const normalized = path.replaceAll("\\", "/");
  if (isAbsolute(path) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    fail(`${field} must be a safe relative runtime-resource path`, { field });
  }
  return normalized;
}

function resourcePaths(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  return arrayOfStrings(value, field).map((item, index) => relativeResourcePath(item, `${field}[${index}]`));
}

function parseRuntime(value: unknown): RuntimeProfile {
  if (!record(value)) fail("runtime must be an object");
  if (value.kind === "pi") {
    exactKeys(value, ["kind", "model", "thinking", "extensions", "skills"], "runtime");
    if (!THINKING_LEVELS.includes(value.thinking as ThinkingLevel)) fail("runtime.thinking is invalid");
    return {
      kind: "pi",
      model: stringField(value.model, "runtime.model"),
      thinking: value.thinking as ThinkingLevel,
      extensions: resourcePaths(value.extensions, "runtime.extensions"),
      skills: resourcePaths(value.skills, "runtime.skills"),
    };
  }
  if (value.kind === "claude") {
    exactKeys(value, ["kind", "model", "permissionMode", "extensions", "skills"], "runtime");
    if (!CLAUDE_PERMISSION_MODES.includes(value.permissionMode as ClaudePermissionMode)) fail("runtime.permissionMode is invalid");
    return {
      kind: "claude",
      model: stringField(value.model, "runtime.model"),
      permissionMode: value.permissionMode as ClaudePermissionMode,
      extensions: resourcePaths(value.extensions, "runtime.extensions"),
      skills: resourcePaths(value.skills, "runtime.skills"),
    };
  }
  fail("runtime.kind must be pi or claude");
}

function yamlValue(node: Node | null | undefined): unknown {
  if (!node) return undefined;
  if (typeof node === "object") {
    if ("tag" in node && node.tag) fail("YAML tags are not supported");
    if ("anchor" in node && node.anchor) fail("YAML anchors and aliases are not supported");
    if (node.constructor.name === "Alias") fail("YAML anchors and aliases are not supported");
    if ("items" in node && Array.isArray(node.items)) for (const item of node.items) yamlValue(item as Node);
    if ("value" in node && typeof node.value === "object" && node.value !== null) yamlValue(node.value as Node);
  }
  return (node as { toJSON?: () => unknown }).toJSON?.();
}

function frontmatter(text: string): { values: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) fail("profile must start with YAML frontmatter");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) fail("profile frontmatter must have a closing delimiter and Markdown body");
  const document = parseDocument(match[1], { version: "1.2", schema: "core", strict: true, uniqueKeys: true, prettyErrors: false });
  if (document.errors.length > 0) fail(`invalid YAML frontmatter: ${document.errors[0]?.message ?? "parse error"}`);
  if (document.warnings.length > 0) fail(`invalid YAML frontmatter: ${document.warnings[0]?.message ?? "warning"}`);
  if (!document.contents || document.contents.constructor.name !== "YAMLMap") fail("YAML frontmatter must be a mapping");
  const values = yamlValue(document.contents);
  if (!record(values)) fail("YAML frontmatter must be a mapping");
  return { values, body: match[2] };
}

function resolveResources(runtime: RuntimeProfile, source: ProfileSource): RuntimeProfile {
  const paths = (values: string[]) => values.map((value) => {
    const resolved = resolve(source.scopeRoot, value);
    const rel = relative(source.scopeRoot, resolved);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) fail("runtime resource resolved outside profile scope", { value });
    return resolved;
  });
  return runtime.kind === "pi"
    ? { ...runtime, extensions: paths(runtime.extensions), skills: paths(runtime.skills) }
    : { ...runtime, extensions: paths(runtime.extensions), skills: paths(runtime.skills) };
}

export function parseProfile(text: string, source: ProfileSource): Profile {
  if (Buffer.byteLength(text, "utf8") > MAX_PROFILE_BYTES) fail("profile exceeds the 64 KiB limit");
  const { values, body } = frontmatter(text);
  if (body.trim().length === 0 || Buffer.byteLength(body, "utf8") > MAX_PROFILE_BODY_BYTES) fail("profile Markdown body must be non-empty and at most 32 KiB");
  exactKeys(values, ["name", "description", "runtime", "fallbacks"], "profile");
  const name = stringField(values.name, "name");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) fail("name must be lowercase kebab-case", { name });
  if (basename(source.path) !== `${name}.md`) fail("filename stem must equal profile name", { name, path: source.path });
  const fallbacks = values.fallbacks === undefined ? [] : arrayOfStrings(values.fallbacks, "fallbacks");
  for (const fallback of fallbacks) if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(fallback)) fail("fallback names must be lowercase kebab-case", { fallback });
  if (new Set(fallbacks).size !== fallbacks.length) fail("fallbacks must not contain duplicates");
  const runtime = resolveResources(parseRuntime(values.runtime), source);
  return { name, description: stringField(values.description, "description"), runtime, fallbacks, body, source };
}

export function profileSource(kind: ProfileSource["kind"], path: string, scopeRoot: string): ProfileSource {
  return { kind, path, scopeRoot, precedence: kind === "bundled" ? 0 : kind === "user" ? 1 : 2 };
}
