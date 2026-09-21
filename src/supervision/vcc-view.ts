/**
 * ADR-036 V2.2-a: deterministic lowering from a bounded runner trace window
 * to the VCC-style SupervisionView consumed by supervision.
 *
 * The compiler keeps the raw trace authoritative. Every emitted line carries
 * a source-relative reference, calls pair with their source result ids, and
 * the view uses E1's cursor identities plus E3's canonical JSON. No model is
 * involved in classification, compaction, or outcome selection.
 */
import { createHash } from "node:crypto";
import { buildExecutionDigest, canonicalJson, type DigestCursorRef } from "./evidence.js";
import type { TraceEvent, TraceSourceKind, TraceWindow } from "./trace-source.js";

export const SUPERVISION_VIEW_COMPILER = "vcc-supervision";
export const SUPERVISION_VIEW_COMPILER_VERSION = "1.0.0";
export const SUPERVISION_VIEW_CONTRACT_VERSION = 1;

export const SUPERVISION_EVENT_CLASSES = ["narration", "tool", "file-change", "command", "signal"] as const;
export type SupervisionEventClass = (typeof SUPERVISION_EVENT_CLASSES)[number];

export const SUPERVISION_ACTION_CLASSES = ["read", "mutation", "execution", "other"] as const;
export type SupervisionActionClass = (typeof SUPERVISION_ACTION_CLASSES)[number];

export interface SupervisionViewLine {
  /** Recoverable source-relative pointer. Paired or compacted lines carry both endpoint refs. */
  ref: string;
  /** Deterministic semantic projection. Raw tool output is represented by structural flags. */
  text: string;
}

export interface SupervisionView {
  compiler: typeof SUPERVISION_VIEW_COMPILER;
  compilerVersion: typeof SUPERVISION_VIEW_COMPILER_VERSION;
  contractVersion: typeof SUPERVISION_VIEW_CONTRACT_VERSION;
  source: "runner-jsonl" | "tmux-fallback";
  fromCursor: string | null;
  toCursor: string | null;
  lines: SupervisionViewLine[];
  rawEventCount: number;
  /** True only when the source reports a byte-budget cut or fallback scroll-off. */
  truncated: boolean;
  /** SHA-256 over the canonical view without this field. */
  digestHash: string;
}

const EXECUTION_TOOLS = new Set([
  "bash",
  "exec",
  "execute",
  "run",
  "run_command",
  "shell",
  "write_to_process",
  "ctx_execute",
  "ctx_execute_file",
  "ctx_batch_execute",
]);
const MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "multi_edit",
  "notebook_edit",
  "apply_patch",
  "create",
  "update",
  "delete",
  "remove",
  "move",
  "rename",
  "copy",
  "mkdir",
  "touch",
  "chmod",
]);
const READ_TOOLS = new Set([
  "read",
  "webfetch",
  "fetch",
  "get",
  "list",
  "ls",
  "grep",
  "find",
  "glob",
  "search",
  "query",
  "inspect",
  "view",
  "show",
  "describe",
  "status",
  "diff",
  "log",
  "web_search",
  "find_file_by_name",
  "fffind",
  "ffgrep",
  "ctx_search",
]);
const TARGET_KEYS = ["command", "pattern", "query", "skill", "file_path", "notebook_path", "path", "url", "file", "code", "commands", "queries"] as const;
const EXIT_CODE_PATTERN = /(?:Command exited with code|Exit code:)\s*(-?\d+)/gu;
const ANSI_ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESC}\\[[0-9;:?]*[A-Za-z]`, "gu");
const SYSTEM_REMINDER_PATTERN = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/giu;
const HARNESS_XML_PATTERN = /<harness\b[^>]*>[\s\S]*?<\/harness>/giu;
const SPINNER_PATTERN = /^[|/\\⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏-]\s*(?:loading|working|thinking)?[\s.]*$/iu;
const PROGRESS_PATTERN = /^(?:\[[#=*>.\-\s]+\]\s*)?\d{1,3}%\s*(?:complete|done|eta.*)?$/iu;
const NOISE_EVENT_PATTERN = /(?:^|[-_])(?:token(?:s|_usage)?|usage|accounting|queue(?:_operation)?|stream_fragment)(?:$|[-_])/iu;
const BLOCKED_PATTERN = /(?:^|[.!?]\s*)blocked\s*:|\b(?:i am blocked|i'm blocked|blocked (?:by|on)|cannot proceed|can't proceed|cannot continue|can't continue|waiting for (?:access|approval|dependency|input|permission)|permission (?:is )?required)\b/iu;
const HELP_PATTERN = /\b(?:need (?:your|user|owner) (?:decision|help|input|approval)|please (?:clarify|confirm|provide)|request(?:ing)? (?:help|input)|what should i do)\b/iu;
const COMPLETION_PATTERN = /(?:^|[.!?]\s*)(?:done|completed|finished)\b|\b(?:task|work|implementation|change|fix|verification) (?:is|has been) (?:complete|completed|done|finished)\b|\ball (?:checks|gates|tests) pass(?:ed)?\b/iu;
const TERMINATION_PATTERN = /\b(?:cancel|stop|terminate)\b/iu;
const FAILURE_KIND_PATTERN = /(?:error|exception|failure|refusal)/iu;
const TERMINATION_KIND_PATTERN = /(?:exit|terminat|shutdown|abort|cancel)/iu;
const AUTH_FAILURE_PATTERN = /\b(?:access denied|auth(?:entication)? failed|credentials? (?:missing|invalid|required)|forbidden|permission denied|unauthori[sz]ed)\b/iu;
const TOOL_REFUSAL_PATTERN = /\b(?:denied by policy|not allowed|policy prohibits|refus(?:al|ed))\b/iu;
const EXCEPTION_PATTERN = /\b(?:exception|fatal error|panic|traceback)\b/iu;
const RESULT_ERROR_PATTERN = /(?:^|\n)\s*(?:error|failure)\s*:/iu;
const PROCESS_STOP_TEXT_PATTERN = /\bprocess (?:exited|terminated|was killed)\b/iu;
const STDERR_PATTERN = /(?:^|\n)\s*stderr\s*:/iu;
const TEST_FAILURE_PATTERN = /\b(?:failed tests?|tests? failed|test failure|failures?)\b/iu;
const TEST_COMMAND_PATTERN = /\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)\b|\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b/iu;
const GIT_MUTATION_PATTERN = /(?:^|[;&|]\s*)git\s+(?:add|am|apply|cherry-pick|clean|commit|merge|mv|push|rebase|reset|restore|revert|rm|switch|tag)\b/iu;
const PROCESS_TERMINATION_PATTERN = /(?:^|[;&|]\s*)(?:exit\b|kill\b|pkill\b)/iu;
const TRUNCATION_FAILURES = new Set(["record_exceeds_budget", "source_exceeds_budget", "window_exceeds_budget"]);

interface ToolResult {
  ref: string;
  text: string | undefined;
  isError: boolean;
  timestamp: number | undefined;
}

interface ToolItem {
  kind: "tool";
  ref: string;
  result?: ToolResult;
  tool: string;
  target: string | undefined;
  action: SupervisionActionClass;
  callTimestamp: number | undefined;
  source: TraceSourceKind;
}

interface TextItem {
  kind: "text";
  ref: string;
  eventClass: "narration" | "signal";
  text: string;
  causal: boolean;
}

type ViewItem = ToolItem | TextItem;

interface LoweredLine extends SupervisionViewLine {
  causal: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolKey(name: string): string {
  const leaf = name.toLowerCase().split(/[.:/]/u).at(-1)!;
  return leaf.replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

/** Classify tool semantics rather than treating every VCC tool node alike. */
export function classifySupervisionAction(tool: string): SupervisionActionClass {
  const key = toolKey(tool);
  if (EXECUTION_TOOLS.has(key) || /(?:^|_)(?:bash|exec|execute|shell)(?:_|$)/u.test(key)) return "execution";
  if (MUTATION_TOOLS.has(key) || /(?:^|_)(?:write|edit|patch|create|update|delete|remove|rename)(?:_|$)/u.test(key)) return "mutation";
  if (READ_TOOLS.has(key) || /(?:^|_)(?:read|fetch|get|list|grep|find|glob|search|query|inspect)(?:_|$)/u.test(key)) return "read";
  return "other";
}

function pickValue(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    if (typeof item === "string") return item === "" ? [] : [item];
    if (!isRecord(item)) return [];
    const nested = pickValue(item.command) ?? pickValue(item.path) ?? pickValue(item.query);
    return nested === undefined ? [] : [nested];
  });
  return parts.length === 0 ? undefined : parts.join("; ");
}

function pickTarget(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of TARGET_KEYS) {
    const value = pickValue(args[key]);
    if (value !== undefined) return value;
  }
  if (typeof args.server_name === "string" && typeof args.tool_name === "string") return `${args.server_name}:${args.tool_name}`;
  return undefined;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") return [part.text];
    if (typeof part.thinking === "string") return [part.thinking];
    return [];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
}

function cleanText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const withoutBlocks = value
    .replace(ANSI_PATTERN, "")
    .replace(SYSTEM_REMINDER_PATTERN, " ")
    .replace(HARNESS_XML_PATTERN, " ");
  const lines = withoutBlocks
    .replace(/\r(?!\n)/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !SPINNER_PATTERN.test(line) && !PROGRESS_PATTERN.test(line));
  const text = lines.join(" ").replace(/\s+/gu, " ").trim();
  return text === "" ? undefined : text;
}

function msOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseExitCode(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  let code: number | undefined;
  for (const match of text.matchAll(EXIT_CODE_PATTERN)) {
    const parsed = Number.parseInt(match[1]!, 10);
    if (Number.isSafeInteger(parsed)) code = parsed;
  }
  return code;
}

function eventRef(source: TraceSourceKind, offset: number): string {
  return `${source}@${offset}`;
}

function pairedRef(call: string, result: string | undefined): string {
  return result === undefined || result === call ? call : `${call}+${result}`;
}

function cursorLabel(cursor: DigestCursorRef | undefined): string | null {
  if (cursor === undefined) return null;
  return cursor.position === undefined ? `${cursor.source}:${cursor.hash}` : `${cursor.source}@${cursor.position}:${cursor.hash}`;
}

function isNoiseEvent(event: TraceEvent): boolean {
  const recordType = isRecord(event.record) && typeof event.record.type === "string" ? event.record.type : "";
  return NOISE_EVENT_PATTERN.test(event.kind) || NOISE_EVENT_PATTERN.test(recordType);
}

function signalKinds(text: string, role: string): string[] {
  const signals: string[] = [];
  if (role !== "user") {
    if (BLOCKED_PATTERN.test(text)) signals.push("BLOCKED");
    if (HELP_PATTERN.test(text)) signals.push("HELP");
    if (COMPLETION_PATTERN.test(text)) signals.push("COMPLETION");
    if (AUTH_FAILURE_PATTERN.test(text)) signals.push("AUTH_FAILURE");
    if (TOOL_REFUSAL_PATTERN.test(text)) signals.push("TOOL_REFUSAL");
    if (EXCEPTION_PATTERN.test(text) || RESULT_ERROR_PATTERN.test(text)) signals.push("ERROR");
    if (PROCESS_STOP_TEXT_PATTERN.test(text)) signals.push("PROCESS_TERMINATION");
  }
  if (role === "user" && TERMINATION_PATTERN.test(text)) signals.push("TERMINATION");
  return signals;
}

function pushNarration(items: ViewItem[], source: TraceSourceKind, event: TraceEvent, role: string, raw: string | undefined): void {
  const text = cleanText(raw);
  if (text === undefined) return;
  const signals = signalKinds(text, role);
  if (role === "user" && signals.length === 0) return;
  const ref = eventRef(source, event.offset);
  if (signals.length > 0) {
    items.push({ kind: "text", ref, eventClass: "signal", text: `SIGNAL ${signals.join("+")} role=${role} ${JSON.stringify(text)}`, causal: true });
  } else {
    items.push({ kind: "text", ref, eventClass: "narration", text: `NARRATION role=${role} ${JSON.stringify(text)}`, causal: false });
  }
}

function pushSpecialEvent(items: ViewItem[], source: TraceSourceKind, event: TraceEvent): void {
  if (FAILURE_KIND_PATTERN.test(event.kind)) {
    items.push({ kind: "text", ref: eventRef(source, event.offset), eventClass: "signal", text: `SIGNAL ERROR kind=${JSON.stringify(event.kind)}`, causal: true });
  } else if (TERMINATION_KIND_PATTERN.test(event.kind)) {
    items.push({ kind: "text", ref: eventRef(source, event.offset), eventClass: "signal", text: `SIGNAL PROCESS_TERMINATION kind=${JSON.stringify(event.kind)}`, causal: true });
  }
}

function makeTool(source: TraceSourceKind, event: TraceEvent, name: unknown, args: unknown, timestamp?: unknown): ToolItem {
  const tool = typeof name === "string" && name !== "" ? name : "malformed_tool_call";
  return {
    kind: "tool",
    ref: eventRef(source, event.offset),
    tool,
    target: pickTarget(args),
    action: classifySupervisionAction(tool),
    callTimestamp: msOf(timestamp),
    source,
  };
}

function enqueue(pending: Map<string, ToolItem[]>, id: unknown, tool: ToolItem): void {
  if (typeof id !== "string") return;
  const calls = pending.get(id) ?? [];
  calls.push(tool);
  pending.set(id, calls);
}

function dequeue(pending: Map<string, ToolItem[]>, id: unknown): ToolItem | undefined {
  if (typeof id !== "string") return undefined;
  const calls = pending.get(id);
  const call = calls?.shift();
  if (calls?.length === 0) pending.delete(id);
  return call;
}

function attachResult(tool: ToolItem, event: TraceEvent, content: unknown, isError: boolean, timestamp?: unknown): void {
  tool.result = {
    ref: eventRef(tool.source, event.offset),
    text: contentText(content),
    isError,
    timestamp: msOf(timestamp),
  };
}

function compilePi(window: TraceWindow, items: ViewItem[]): void {
  const pending = new Map<string, ToolItem[]>();
  for (const event of window.events) {
    if (isNoiseEvent(event)) continue;
    const record = isRecord(event.record) ? event.record : undefined;
    const message = event.kind === "message" && record !== undefined && isRecord(record.message) ? record.message : undefined;
    if (message === undefined) {
      pushSpecialEvent(items, window.source, event);
      continue;
    }
    if (message.role === "toolResult") {
      const call = dequeue(pending, message.toolCallId);
      const tool = call ?? makeTool(window.source, event, message.toolName ?? "unpaired_result", undefined);
      attachResult(tool, event, message.content, message.isError === true, message.timestamp ?? record?.timestamp);
      if (call === undefined) items.push(tool);
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isRecord(part) && part.type === "toolCall") {
          const tool = makeTool(window.source, event, part.name, part.arguments, message.timestamp ?? record?.timestamp);
          items.push(tool);
          enqueue(pending, part.id, tool);
        } else {
          pushNarration(items, window.source, event, "assistant", contentText([part]));
        }
      }
      continue;
    }
    if (message.role === "assistant" || message.role === "user") {
      pushNarration(items, window.source, event, message.role, contentText(message.content));
    }
  }
}

function compileDevin(window: TraceWindow, items: ViewItem[]): void {
  for (const event of window.events) {
    if (isNoiseEvent(event)) continue;
    const record = isRecord(event.record) ? event.record : undefined;
    if (record === undefined) {
      pushSpecialEvent(items, window.source, event);
      continue;
    }
    const role = event.kind === "agent" ? "assistant" : event.kind;
    if (role === "assistant" || role === "user") pushNarration(items, window.source, event, role, contentText(record.message));
    if (event.kind !== "agent" || !Array.isArray(record.tool_calls)) {
      pushSpecialEvent(items, window.source, event);
      continue;
    }
    const results = isRecord(record.observation) && Array.isArray(record.observation.results)
      ? record.observation.results.filter(isRecord)
      : [];
    for (const call of record.tool_calls) {
      const tool = makeTool(window.source, event, isRecord(call) ? call.function_name : undefined, isRecord(call) ? call.arguments : undefined);
      items.push(tool);
      const id = isRecord(call) ? call.tool_call_id : undefined;
      const resultIndex = typeof id === "string" ? results.findIndex((result) => result.source_call_id === id) : -1;
      if (resultIndex >= 0) {
        const [result] = results.splice(resultIndex, 1);
        attachResult(tool, event, result?.content, false);
      }
    }
    for (const result of results) {
      const orphan = makeTool(window.source, event, "unpaired_result", { query: result.source_call_id });
      attachResult(orphan, event, result.content, false);
      items.push(orphan);
    }
  }
}

function compileTerminal(window: TraceWindow, items: ViewItem[]): void {
  for (const event of window.events) {
    if (typeof event.record === "string") pushNarration(items, window.source, event, "terminal", event.record);
    else pushSpecialEvent(items, window.source, event);
  }
}

function resultFlags(tool: ToolItem, text: string | undefined, failed: boolean): string[] {
  const flags: string[] = [];
  if (tool.action === "execution" && failed && (TEST_COMMAND_PATTERN.test(tool.target ?? "") || TEST_FAILURE_PATTERN.test(text ?? ""))) flags.push("TEST_FAILURE");
  if (STDERR_PATTERN.test(text ?? "")) flags.push("STDERR");
  if (AUTH_FAILURE_PATTERN.test(text ?? "")) flags.push("AUTH_FAILURE");
  if (TOOL_REFUSAL_PATTERN.test(text ?? "")) flags.push("TOOL_REFUSAL");
  if (EXCEPTION_PATTERN.test(text ?? "")) flags.push("EXCEPTION");
  if (RESULT_ERROR_PATTERN.test(text ?? "")) flags.push("ERROR");
  if (tool.action === "execution" && GIT_MUTATION_PATTERN.test(tool.target ?? "")) flags.push("GIT_MUTATION");
  if (tool.action === "execution" && PROCESS_TERMINATION_PATTERN.test(tool.target ?? "")) flags.push("PROCESS_TERMINATION");
  return flags;
}

function lowerTool(tool: ToolItem): LoweredLine {
  const result = tool.result;
  const rawText = result?.text;
  const exitCode = tool.action === "execution" && (tool.source !== "pi-jsonl" || result?.isError === true)
    ? parseExitCode(rawText)
    : undefined;
  const failureText = rawText ?? "";
  const semanticFailure = AUTH_FAILURE_PATTERN.test(failureText)
    || TOOL_REFUSAL_PATTERN.test(failureText)
    || EXCEPTION_PATTERN.test(failureText)
    || RESULT_ERROR_PATTERN.test(failureText);
  const failed = result !== undefined && (result.isError || (exitCode !== undefined && exitCode !== 0) || semanticFailure);
  const outcome = result === undefined ? "PENDING" : failed ? "FAILURE" : "SUCCESS";
  const flags = resultFlags(tool, rawText, failed);
  const duration = result?.timestamp !== undefined && tool.callTimestamp !== undefined && result.timestamp >= tool.callTimestamp
    ? result.timestamp - tool.callTimestamp
    : undefined;
  const eventClass: SupervisionEventClass = tool.action === "mutation" ? "file-change" : tool.action === "execution" ? "command" : "tool";
  const label = eventClass === "file-change" ? "FILE_CHANGE" : eventClass.toUpperCase();
  const parts = [label, tool.action.toUpperCase(), `tool=${JSON.stringify(tool.tool)}`];
  if (tool.target !== undefined) parts.push(`target=${JSON.stringify(tool.target)}`);
  parts.push(outcome);
  if (exitCode !== undefined) parts.push(`EXIT_CODE=${exitCode}`);
  if (duration !== undefined) parts.push(`DURATION_MS=${duration}`);
  parts.push(...flags);
  return {
    ref: pairedRef(tool.ref, result?.ref),
    text: parts.join(" "),
    causal: tool.action === "mutation" || failed || flags.some((flag) => flag !== "STDERR"),
  };
}

function lowerItems(items: ViewItem[]): LoweredLine[] {
  return items.map((item) => item.kind === "tool" ? lowerTool(item) : { ref: item.ref, text: item.text, causal: item.causal });
}

/** Collapse adjacent identical non-causal lines while retaining both endpoint references. */
function compactLines(lines: LoweredLine[]): SupervisionViewLine[] {
  const output: SupervisionViewLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const first = lines[index]!;
    let end = index + 1;
    while (end < lines.length && !first.causal && !lines[end]!.causal && lines[end]!.text === first.text) end += 1;
    const count = end - index;
    if (count === 1) output.push({ ref: first.ref, text: first.text });
    else {
      const last = lines[end - 1]!;
      output.push({ ref: first.ref === last.ref ? first.ref : `${first.ref}..${last.ref}`, text: `${first.text} REPEATED=${count}` });
    }
    index = end;
  }
  return output;
}

function digestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Compile one already-bounded trace-source window into the V2.2-a contract. */
export function compileSupervisionView(window: TraceWindow): SupervisionView {
  const items: ViewItem[] = [];
  switch (window.source) {
    case "pi-jsonl":
      compilePi(window, items);
      break;
    case "devin-session":
      compileDevin(window, items);
      break;
    case "tmux-fallback":
      compileTerminal(window, items);
      break;
  }

  if (window.typedFailure !== undefined) {
    const detail = window.typedFailure.detail === undefined ? "" : ` detail=${canonicalJson(window.typedFailure.detail)}`;
    items.push({
      kind: "text",
      ref: `${window.source}@failure`,
      eventClass: "signal",
      text: `SIGNAL TRACE_FAILURE kind=${JSON.stringify(window.typedFailure.kind)}${detail}`,
      causal: true,
    });
  }

  const digest = buildExecutionDigest(window);
  const base: Omit<SupervisionView, "digestHash"> = {
    compiler: SUPERVISION_VIEW_COMPILER,
    compilerVersion: SUPERVISION_VIEW_COMPILER_VERSION,
    contractVersion: SUPERVISION_VIEW_CONTRACT_VERSION,
    source: window.source === "tmux-fallback" ? "tmux-fallback" as const : "runner-jsonl" as const,
    fromCursor: cursorLabel(digest.cursorFrom),
    toCursor: cursorLabel(digest.cursorTo),
    lines: compactLines(lowerItems(items)),
    rawEventCount: window.events.length,
    truncated: (window.source === "tmux-fallback" && (window.events[0]?.offset ?? 0) > 0)
      || (window.typedFailure !== undefined && TRUNCATION_FAILURES.has(window.typedFailure.kind)),
  };
  return { ...base, digestHash: digestHash(base) };
}
