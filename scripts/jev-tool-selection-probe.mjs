// Probe: can Jev select tools per-item via noul, and is the signal usable?
// One systemOne call per assignment; ~28 noul questions (one per pool tool)
// plus one toolset-choice for comparison. Prints noul table, ambiguity stats,
// and latency. Usage: node scripts/jev-tool-selection-probe.mjs
import { TypeSafeClient, noul, choice } from "@typesafe-ai/sdk";

// The pi pool from worker-pi.md with short descriptions Jev can judge.
const TOOL_POOL = [
  ["read", "read file contents from disk"],
  ["bash", "run shell commands"],
  ["grep", "search file contents by pattern"],
  ["find", "find files by name/path"],
  ["ls", "list directory contents"],
  ["ffgrep", "fast content search across the codebase"],
  ["fffind", "fast file lookup across the codebase"],
  ["ctx_execute", "run code inside the context workspace"],
  ["ctx_execute_file", "execute a file inside the context workspace"],
  ["ctx_search", "semantic search over the context workspace"],
  ["web_search", "search the web"],
  ["source_check", "verify a claim against a fetched source"],
  ["fetch_content", "fetch and read a web page"],
  ["get_search_content", "retrieve contents for search results"],
  ["edit", "modify an existing file"],
  ["write", "create or overwrite a file"],
  ["bash_bg", "run a shell command in the background"],
  ["jobs", "list and inspect background jobs"],
  ["job_decide", "approve or deny a pending background job decision"],
  ["monitor", "watch a long-running process or log"],
  ["herdr_communicate", "send messages to other agents"],
  ["herdr_inspect", "inspect agent/session state in the multiplexer"],
  ["change_reasoning", "adjust reasoning effort mid-task (codex adapter)"],
  ["exec_command", "execute a command via the codex adapter"],
  ["write_stdin", "write to a running process stdin (codex adapter)"],
  ["apply_patch", "apply a structured patch to files (codex adapter)"],
  ["exec", "generic exec surface (codex adapter)"],
  ["wait", "wait for a condition or process"],
  ["notebook", "edit notebook cells"],
  ["view_image", "view an image file"],
];

const ASSIGNMENTS = [
  {
    id: "research",
    objective: "Investigate why the router abstains on low-confidence choice answers and report the cause with file/line evidence.",
    scope: "Read-only investigation of src/router.ts and related files. Do not modify anything.",
    verification: "A written report naming the exact code path and confidence comparisons involved.",
  },
  {
    id: "implement",
    objective: "Fix the abstain-handling bug in the router and add a regression test.",
    scope: "src/router.ts and test/unit/router.test.ts. Make the minimal correct change.",
    verification: "The new test fails before the fix and passes after; the unit suite is green.",
  },
  {
    id: "coordinate",
    objective: "Monitor the running worker agents, collect their status, and report which are stalled.",
    scope: "Live herdr session; do not modify repository files.",
    verification: "A per-agent status table with the evidence used to classify each agent.",
  },
];

const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY, defaultModel: "jev-latest", logLevel: "off" });

for (const a of ASSIGNMENTS) {
  const questions = {};
  for (const [name, desc] of TOOL_POOL) {
    questions[`tool_${name}`] = noul(
      `Would an agent performing this assignment plausibly need the ${name} tool (${desc}) to complete the work within scope?`,
      {
        true: `The ${name} tool is necessary or materially useful for this assignment.`,
        false: `The ${name} tool is unnecessary or out of scope for this assignment.`,
      },
    );
  }
  questions.toolset = choice(
    "Which single tool bundle best fits this assignment?",
    {
      readonly: { description: "read, search, and inspection tools only; no file modification", tools: "read grep find ls ffgrep fffind ctx_search web_search fetch_content get_search_content source_check view_image monitor herdr_inspect herdr_communicate" },
      implementation: { description: "full coding surface: read/search plus edit, write, patch, exec, and test running", tools: "all readonly tools plus edit write apply_patch bash ctx_execute ctx_execute_file exec exec_command write_stdin notebook bash_bg jobs job_decide wait new_context history notes change_reasoning get_context_remaining" },
      coordination: { description: "agent supervision and messaging; minimal repo access", tools: "herdr_communicate herdr_inspect monitor jobs read ls grep" },
    },
  );
  const state = { assignment: { objective: a.objective, scope: a.scope, verification: a.verification } };
  const t0 = Date.now();
  const res = await client.systemOne({ state, questions });
  const ms = Date.now() - t0;
  const rows = [];
  for (const [name] of TOOL_POOL) {
    const ans = res.answers[`tool_${name}`];
    rows.push([name, ans?.type === "noul" ? ans.noul : null]);
  }
  rows.sort((x, y) => (y[1] ?? -1) - (x[1] ?? -1));
  console.log(`\n=== ${a.id} (${ms}ms, ${Object.keys(questions).length} questions) ===`);
  for (const [name, v] of rows) console.log(`  ${v === null ? "  ???" : v.toFixed(2)}  ${name}`);
  const band = rows.filter(([, v]) => v !== null && v >= 0.3 && v <= 0.7).length;
  const high = rows.filter(([, v]) => v !== null && v > 0.7).length;
  const low = rows.filter(([, v]) => v !== null && v < 0.3).length;
  console.log(`  -> >0.7: ${high} | 0.3-0.7 ambiguous: ${band} | <0.3: ${low}`);
  const ts = res.answers.toolset;
  console.log(`  toolset choice: ${ts?.choice} (confidence ${ts?.confidence?.toFixed(2)})`);
}
