#!/home/gabriel/.volta/tools/image/node/25.9.0/bin/node
import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = "/home/gabriel/.hindsight/coding-agent.json";
const SERVER = "/home/gabriel/.hindsight/coding-agents/dist/mcp-server.js";
const HARNESSES = ["pi", "claude-code", "codex", "cursor", "gemini", "opencode", "devin", "agy"];

function expandedRoot(root) {
  return root === "~" || root.startsWith("~/") ? homedir() + root.slice(1) : root;
}

export function resolveProjectBank(config, cwd) {
  const current = realpathSync(cwd);
  const mappings = config?.mapPathToBank;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throw new Error("Hindsight path-to-bank mapping is invalid");
  }
  const matches = [];
  for (const [root, bankId] of Object.entries(mappings)) {
    if (!isAbsolute(expandedRoot(root)) || typeof bankId !== "string" || !bankId) {
      throw new Error("Hindsight path-to-bank mapping is invalid");
    }
    let projectRoot;
    try { projectRoot = realpathSync(expandedRoot(root)); } catch { continue; }
    const rel = relative(projectRoot, current);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      matches.push({ bankId, projectRoot });
    }
  }
  matches.sort((a, b) => b.projectRoot.length - a.projectRoot.length);
  if (!matches[0]) throw new Error("No Hindsight bank is mapped for this project");
  const selected = matches[0];
  if (matches.some(m => m.projectRoot === selected.projectRoot && m.bankId !== selected.bankId)) {
    throw new Error("Ambiguous Hindsight bank mapping for this project");
  }
  // The upstream server uses lexical paths. Verify it will select the same bank,
  // rather than falling back to a generated bank for a symlinked mapping.
  const lexical = Object.entries(mappings)
    .map(([root, bankId]) => ({ root: normalize(expandedRoot(root)).replace(/\/+$/, ""), bankId }))
    .filter(({ root }) => current === root || current.startsWith(root + sep))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (lexical?.bankId !== selected.bankId) {
    throw new Error("Hindsight server mapping differs from the canonical project binding");
  }
  if (config.banks?.[selected.bankId]?.bank && config.banks[selected.bankId].bank !== selected.bankId) {
    throw new Error("Hindsight bank override differs from the canonical project binding");
  }
  return { ...selected, cwd: current };
}

export function resolveHarnessConfig(raw, harness) {
  if (!HARNESSES.includes(harness)) throw new Error("A supported Hindsight harness is required");
  const layer = raw.harnesses?.[harness] ?? {};
  return { ...raw, ...layer, banks: { ...raw.banks, ...layer.banks } };
}

export function main() {
  const harness = process.argv[2];
  const raw = JSON.parse(readFileSync(process.env.HINDSIGHT_CONFIG || CONFIG, "utf8"));
  const project = resolveProjectBank(resolveHarnessConfig(raw, harness), process.cwd());
  const env = { ...process.env, HINDSIGHT_MCP_PROJECT_CWD: project.cwd, HINDSIGHT_MCP_HARNESS: harness };
  if (typeof process.execve === "function") {
    // One process per lane: execve replaces this wrapper with the server in
    // place, so signals and stdio stay on the same pid — no child to forward.
    process.chdir(project.cwd);
    process.execve(process.execPath, [process.execPath, SERVER], env);
    return;
  }
  // Node <24 lacks execve; keep the spawn shim for that case only.
  const child = spawn(process.execPath, [SERVER], { cwd: project.cwd, env, stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", () => { console.error("Hindsight MCP server could not start"); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try { main(); } catch {
    console.error("Hindsight MCP refused startup: verify the harness and canonical project-to-bank mapping");
    process.exitCode = 1;
  }
}
