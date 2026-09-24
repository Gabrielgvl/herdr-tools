import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { claudeQuotaSignal } from "../../src/supervision/claude-quota.js";

const uuid = "5ab55aa9-8ec3-47dd-896b-156ad524e7e6";
const session = { source: "herdr:claude", agent: "claude", kind: "id", value: uuid };
const cwd = "/home/worker/project";
const before = Date.now() - 1000;
const record = (fields: Record<string, unknown> = {}) => ({ type: "assistant", sessionId: uuid, cwd,
  isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, requestId: "req-1", timestamp: new Date().toISOString(), ...fields });
let home: string;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });

it("requires exact Claude session, cwd, typed assistant quota and trusted native file", async () => {
  home = await mkdtemp(join(tmpdir(), "claude-quota-"));
  const projects = join(home, ".claude", "projects");
  await mkdir(join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, mode: 0o700 });
  const path = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${uuid}.jsonl`);
  const put = async (...rows: object[]) => writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  await put(record({ sessionId: "another-session" }), record({ cwd: "/other/project" }), record({ error: "auth" }), record({ isApiErrorMessage: false }), record({ apiErrorStatus: 500 }), record({ timestamp: new Date(before - 1000).toISOString() }));
  expect(await claudeQuotaSignal(session, cwd, before, home)).toBe(false);
  await put(record({ error: "429" }), record());
  expect(await claudeQuotaSignal(session, cwd, before, home)).toBe(true);
  expect(await claudeQuotaSignal({ ...session, source: "foreign" }, cwd, before, home)).toBe(false);
  expect(await claudeQuotaSignal({ ...session, value: "695bc6bc-a5da-4b30-9f00-ca2a6e67c64c" }, cwd, before, home)).toBe(false);
  await rm(path);
  await symlink(join(projects, "missing"), path);
  expect(await claudeQuotaSignal(session, cwd, before, home)).toBe(false);
});
