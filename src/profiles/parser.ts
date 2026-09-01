import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import {
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSION_MODES,
  MAX_PROFILE_BODY_BYTES,
  MAX_PROFILE_BYTES,
  PROFILE_KINDS,
  THINKING_LEVELS,
  type ClaudeEffort,
  type ClaudePermissionMode,
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

function stringArray(value: unknown, field: string): string[] {
  return value === undefined ? [] : arrayOfStrings(value, field);
}

export function normalizeScopedResourcePath(value: string, field: string, scopeRoot: string): string {
  if (value.length === 0 || /[\0\r\n]/.test(value)) fail(`${field} must be a non-empty single-line relative path`, { field });
  if (isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) fail(`${field} must be relative to the profile scope root`, { field });
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0)) fail(`${field} contains an unsafe empty path segment`, { field });
  const root = resolve(scopeRoot);
  const resolved = resolve(root, value.replace(/[\\/]/g, sep));
  const fromRoot = relative(root, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) || win32.isAbsolute(fromRoot)) {
    fail(`${field} escapes the profile scope root`, { field, scopeRoot: root });
  }
  return resolved;
}

/**
 * A Claude channel entry must be tagged, exactly as `--channels` requires:
 * `server:<name>` for a configured MCP server, `plugin:<name>@<marketplace>`
 * for a plugin-provided one. An untagged entry is refused rather than guessed.
 */
function channelEntries(value: unknown): string[] {
  return stringArray(value, "runtime.developmentChannels").map((item) => {
    if (!/^(?:server:[A-Za-z0-9._-]+|plugin:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+)$/.test(item)) {
      fail("runtime.developmentChannels entries must be server:<name> or plugin:<name>@<marketplace>", { field: "runtime.developmentChannels" });
    }
    return item;
  });
}

function resourcePaths(value: unknown, field: string, scopeRoot: string): string[] {
  return stringArray(value, field).map((item) => normalizeScopedResourcePath(item, field, scopeRoot));
}

function parseRuntime(value: unknown, scopeRoot: string): RuntimeProfile {
  if (!record(value)) fail("runtime must be an object");
  if (!PROFILE_KINDS.includes(value.kind as ProfileKind)) fail("runtime.kind must be pi or claude");
  if (value.kind === "pi") {
    exactKeys(value, ["kind", "model", "thinking", "tools", "extensions", "skills"], "runtime");
    if (!THINKING_LEVELS.includes(value.thinking as ThinkingLevel)) fail("runtime.thinking is invalid");
    return { kind: "pi", model: stringField(value.model, "runtime.model"), thinking: value.thinking as ThinkingLevel, tools: stringArray(value.tools, "runtime.tools"), extensions: resourcePaths(value.extensions, "runtime.extensions", scopeRoot), skills: resourcePaths(value.skills, "runtime.skills", scopeRoot) };
  }
  exactKeys(value, ["kind", "model", "effort", "permissionMode", "allowedTools", "disallowedTools", "addDirs", "pluginDirs", "developmentChannels"], "runtime");
  if (!CLAUDE_EFFORTS.includes(value.effort as ClaudeEffort)) fail("runtime.effort is invalid");
  const mode = value.permissionMode ?? "default";
  if (!CLAUDE_PERMISSION_MODES.includes(mode as ClaudePermissionMode)) fail("runtime.permissionMode is invalid");
  return { kind: "claude", model: stringField(value.model, "runtime.model"), effort: value.effort as ClaudeEffort, permissionMode: mode as ClaudePermissionMode, allowedTools: stringArray(value.allowedTools, "runtime.allowedTools"), disallowedTools: stringArray(value.disallowedTools, "runtime.disallowedTools"), addDirs: resourcePaths(value.addDirs, "runtime.addDirs", scopeRoot), pluginDirs: resourcePaths(value.pluginDirs, "runtime.pluginDirs", scopeRoot), developmentChannels: channelEntries(value.developmentChannels) };
}

function rejectYamlAliases(node: Node | null): void {
  if (node === null) return;
  if (isAlias(node)) fail("YAML anchors, aliases, and tags are not supported");
  if (isMap(node)) {
    for (const item of node.items) {
      rejectYamlAliases(item.key as Node | null);
      rejectYamlAliases(item.value as Node | null);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) rejectYamlAliases(item as Node | null);
  }
}

function validateYamlNode(node: Node | null): void {
  if (node === null) return;
  if ("anchor" in node && node.anchor !== undefined) fail("YAML anchors, aliases, and tags are not supported");
  if (node.tag !== undefined) fail("YAML anchors, aliases, and tags are not supported");
  if (isMap(node)) {
    for (const item of node.items) {
      validateYamlNode(item.key as Node | null);
      validateYamlNode(item.value as Node | null);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) validateYamlNode(item as Node | null);
  } else {
    isScalar(node);
  }
}

function validateProfileYamlNode(node: Node | null): void {
  rejectYamlAliases(node);
  validateYamlNode(node);
}

function yamlValue(node: Node): unknown {
  validateProfileYamlNode(node);
  return node.toJSON();
}

function frontmatter(text: string): { values: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) fail("profile must start with YAML frontmatter");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) fail("profile frontmatter must have a closing delimiter and Markdown body");
  const document = parseDocument(match[1], { version: "1.2", schema: "core", strict: true, uniqueKeys: true, prettyErrors: false });
  if (document.errors.length > 0) fail("invalid YAML frontmatter");
  if (document.contents === null || !isMap(document.contents)) fail("YAML frontmatter must be a mapping");
  const values = yamlValue(document.contents) as Record<string, unknown>;
  return { values, body: match[2] };
}

export function parseProfile(text: string, source: ProfileSource): Profile {
  if (Buffer.byteLength(text, "utf8") > MAX_PROFILE_BYTES) fail("profile exceeds the 64 KiB limit");
  const { values, body } = frontmatter(text);
  if (body.trim().length === 0 || body.includes("\0") || Buffer.byteLength(body, "utf8") > MAX_PROFILE_BODY_BYTES) fail("profile Markdown body must be non-empty, NUL-free, and at most 32 KiB");
  exactKeys(values, ["name", "description", "timeoutMinutes", "sessionPersistence", "runtime", "fallbackProfiles"], "profile");
  const name = stringField(values.name, "name");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) fail("name must be lowercase kebab-case", { name });
  if (basename(source.path) !== `${name}.md`) fail("filename stem must equal profile name", { name, path: source.path });
  if (!Number.isInteger(values.timeoutMinutes) || (values.timeoutMinutes as number) < 1 || (values.timeoutMinutes as number) > 60) fail("timeoutMinutes must be an integer from 1 through 60");
  if (typeof values.sessionPersistence !== "boolean") fail("sessionPersistence must be a boolean");
  const fallbackProfiles = values.fallbackProfiles === undefined ? [] : arrayOfStrings(values.fallbackProfiles, "fallbackProfiles");
  for (const fallback of fallbackProfiles) if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(fallback)) fail("fallbackProfiles must contain lowercase kebab-case names", { fallback });
  if (new Set(fallbackProfiles).size !== fallbackProfiles.length) fail("fallbackProfiles must not contain duplicates");
  const runtime = parseRuntime(values.runtime, source.scopeRoot);
  if (runtime.kind === "claude" && values.sessionPersistence === false) fail("Claude profiles must set sessionPersistence to true for interactive launches");
  return { name, description: stringField(values.description, "description"), timeoutMinutes: values.timeoutMinutes as number, sessionPersistence: values.sessionPersistence, runtime, fallbackProfiles, body, source };
}

export function profileSource(kind: ProfileSource["kind"], path: string, scopeRoot: string): ProfileSource {
  return { kind, path, scopeRoot, precedence: kind === "bundled" ? 0 : kind === "user" ? 1 : 2 };
}
