import { DatabaseSync } from "node:sqlite";

/**
 * Fixture builder for Devin's private `sessions.db` store. The schema below
 * encodes the observed production shape (migrations 1–17, compat version "0",
 * the `message_nodes` forest and `sessions.main_chain_id` head pointer) — it
 * deliberately does NOT import the production gate constants, so a wrong
 * allow-list entry fails the gate tests instead of passing itself.
 *
 * The real store is never opened by tests: every fixture lives in `mkdtemp`.
 */

export const SESSIONS_DB_DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  title TEXT,
  main_chain_id INTEGER,
  shell_last_seen_index INTEGER,
  cogs_json TEXT,
  workspace_dirs TEXT,
  hidden INTEGER NOT NULL,
  metadata TEXT
);
CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC);
CREATE INDEX idx_sessions_hidden ON sessions(hidden);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  parent_node_id INTEGER,
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  UNIQUE(session_id, node_id)
);
CREATE INDEX idx_message_nodes_session ON message_nodes(session_id);
CREATE TABLE tool_call_state (
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_call_json TEXT,
  tool_call_update_json TEXT,
  PRIMARY KEY (session_id, tool_call_id)
);
CREATE TABLE subagent_heads (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  chain_node_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);
CREATE TABLE rendered_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  sequence_number INTEGER,
  rendered_html TEXT,
  created_at INTEGER,
  UNIQUE(session_id, sequence_number)
);
CREATE INDEX idx_rendered_commits_session ON rendered_commits(session_id, sequence_number);
CREATE TABLE prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT,
  timestamp INTEGER,
  session_id TEXT,
  is_shell INTEGER
);
CREATE INDEX idx_prompt_history_session ON prompt_history(session_id);
CREATE INDEX idx_prompt_history_timestamp ON prompt_history(timestamp);
CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE refinery_schema_history (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_on TEXT NOT NULL DEFAULT '2026-09-10T21:29:36Z'
);
`;

/** The seventeen migration names the version gate pins, verbatim from the store. */
export const REFINERY_MIGRATION_NAMES: readonly string[] = [
  "initial_schema",
  "add_thinking_column",
  "add_prompt_history",
  "add_metadata_column",
  "message_forest",
  "add_node_metadata",
  "add_shell_context",
  "add_session_cogs",
  "add_rendered_commits",
  "add_workspace_dirs",
  "add_prompt_history_is_shell",
  "add_app_state",
  "rename_permission_mode_to_agent_mode",
  "tool_call_state",
  "add_hidden_column",
  "add_session_json_metadata",
  "subagent_heads",
];

export interface FixtureNode {
  nodeId: number;
  parent: number | null;
  /** Object messages are serialized; strings are stored raw (for corrupt rows). */
  message: Record<string, unknown> | string;
  metadata?: string;
}

/** A store database with the gated schema in WAL mode; the caller closes it. */
export function createFixtureDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SESSIONS_DB_DDL);
  const insert = db.prepare("INSERT INTO refinery_schema_history (version, name) VALUES (?, ?)");
  REFINERY_MIGRATION_NAMES.forEach((name, index) => insert.run(index + 1, name));
  db.prepare("INSERT INTO app_state (key, value) VALUES ('schema_compat_version', '0')").run();
  return db;
}

export function addSession(db: DatabaseSync, sessionId: string, head: number | null): void {
  db.prepare(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, main_chain_id, hidden)
     VALUES (?, '/work', 'local', 'swe-2-max', 'dangerous', 1, 1, ?, 0)`,
  ).run(sessionId, head);
}

export function setHead(db: DatabaseSync, sessionId: string, head: number | null): void {
  db.prepare("UPDATE sessions SET main_chain_id = ?, last_activity_at = last_activity_at + 1 WHERE id = ?").run(head, sessionId);
}

export function addNode(db: DatabaseSync, sessionId: string, node: FixtureNode): void {
  db.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) VALUES (?, ?, ?, ?, 1, ?)").run(
    sessionId,
    node.nodeId,
    node.parent,
    typeof node.message === "string" ? node.message : JSON.stringify(node.message),
    node.metadata ?? null,
  );
}

export function addNodes(db: DatabaseSync, sessionId: string, nodes: FixtureNode[]): void {
  for (const node of nodes) addNode(db, sessionId, node);
}

/** The turn-end batch: every node re-inserted unchanged under fresh row_ids. */
export function remintNodes(db: DatabaseSync, sessionId: string): void {
  const rows = db.prepare("SELECT node_id, parent_node_id, chat_message, metadata FROM message_nodes WHERE session_id = ? ORDER BY node_id").all(sessionId) as Array<{
    node_id: number;
    parent_node_id: number | null;
    chat_message: string;
    metadata: string | null;
  }>;
  const replace = db.prepare("INSERT OR REPLACE INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) VALUES (?, ?, ?, ?, 2, ?)");
  for (const row of rows) replace.run(sessionId, row.node_id, row.parent_node_id, row.chat_message, row.metadata);
}

// ---- chat_message shapes, mirroring the store's real record grammar ----

export function systemMessage(content: string, messageId = "sys-1"): Record<string, unknown> {
  return { message_id: messageId, role: "system", content };
}

export function userMessage(content: string, messageId = "usr-1"): Record<string, unknown> {
  return { message_id: messageId, role: "user", content };
}

export function assistantMessage(
  content: string,
  options: { messageId?: string; calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; model?: string } = {},
): Record<string, unknown> {
  return {
    message_id: options.messageId ?? "asst-1",
    role: "assistant",
    content,
    tool_calls: (options.calls ?? []).map((call, index) => ({ id: call.id, name: call.name, arguments: call.arguments, index, kind: "function" })),
    metadata: { generation_model: options.model ?? "swe-2-max" },
  };
}

export function toolMessage(toolCallId: string, content: string, messageId = `tool-${toolCallId}`): Record<string, unknown> {
  return { message_id: messageId, role: "tool", tool_call_id: toolCallId, content };
}

// ---- the equivalent ATIF transcript document, for parity fixtures ----

export function atifStep(stepId: number, fields: Record<string, unknown>): Record<string, unknown> {
  return { step_id: stepId, timestamp: `t${stepId}`, ...fields };
}

export function atifDoc(sessionId: string, steps: Array<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ schema_version: "ATIF-v1.7", session_id: sessionId, agent: { name: "devin", version: "3000.11.3" }, steps }),
  );
}
