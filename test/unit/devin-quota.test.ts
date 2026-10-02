import { chmod, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { devinQuotaSignal } from "../../src/supervision/devin-quota.js";
import { devinCliDataDir } from "../../src/supervision/devin-trace.js";

/**
 * Trimmed from a real Devin CLI process log (2026-10-02, session renamed,
 * trace IDs zeroed): the session_db lines that name the session, the two
 * WARN retries, the ERROR stall line, and the trailing save.
 */
const fixture = new URL("./fixtures/devin-provider-limit.log", import.meta.url);
const session = { source: "herdr:devin", agent: "devin", kind: "id", value: "tidal-vase" };
const promptMs = Date.parse("2026-10-02T01:33:00.000Z");
/** The ERROR line's own timestamp plus the 26 minutes it states. */
const RESET = "2026-10-02T01:59:04.421Z";
const ERROR_LINE = /^.*ERROR affogato.*$/mu;

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function put(name: string, text: string, mode = 0o664): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text, { mode });
  return path;
}

it("returns the ERROR line's reset instant for the bound session, never the WARN retries", async () => {
  dir = await mkdtemp(join(tmpdir(), "devin-quota-"));
  const text = await readFile(fixture, "utf8");
  await put("devin_20261001-223258_3826277.log", text);
  expect(await devinQuotaSignal(session, promptMs, dir)).toEqual({ retryNotBefore: RESET });
  // WARN-only: the retries before the stall are not a stall.
  await put("devin_20261001-223258_3826277.log", text.replace(ERROR_LINE, ""));
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  // Another session's log — even one carrying the same stall — proves nothing for this session.
  await put("devin_20261001-223258_3826277.log", text.replaceAll("tidal-vase", "other-session"));
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  // A log that names two sessions is ambiguous for either.
  await put("devin_20261001-223258_3826277.log", text.replace("Created new session: tidal-vase", "Created new session: other-session"));
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  // A stall logged before the cycle's prompt belongs to an earlier cycle.
  await put("devin_20261001-223258_3826277.log", text);
  expect(await devinQuotaSignal(session, Date.parse("2026-10-02T01:33:05.000Z"), dir)).toBe(false);
});

it("fails closed on truncated, unreadable, untrusted, stale, or foreign evidence", async () => {
  dir = await mkdtemp(join(tmpdir(), "devin-quota-"));
  const text = await readFile(fixture, "utf8");
  // A torn last line — the writer mid-record — is never trusted.
  const torn = text.slice(0, text.indexOf("\n", text.search(ERROR_LINE)));
  await put("devin_20261001-223258_3826277.log", torn);
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  // Only Devin's own log names are candidates.
  await put("devin_20261001-223258_3826277.log.gz", text);
  await put("notes.log", text);
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  // A world-writable log and a symlink are untrusted.
  const path = await put("devin_20261001-223258_3826277.log", text);
  await chmod(path, 0o666);
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  await rm(path);
  await put("target.log", text);
  await symlink(join(dir, "target.log"), path);
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  await rm(path);
  // A log last written before the prompt cannot hold a post-prompt stall.
  await put("devin_20261001-223258_3826277.log", text);
  await utimes(path, new Date(promptMs - 60_000), new Date(promptMs - 60_000));
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  // A missing or unreadable directory is no evidence.
  expect(await devinQuotaSignal(session, promptMs, join(dir, "missing"))).toBe(false);
  await mkdir(join(dir, "locked"), { mode: 0o000 });
  expect(await devinQuotaSignal(session, promptMs, join(dir, "locked"))).toBe(false);
  await chmod(join(dir, "locked"), 0o700);
  // Only a Devin session id is looked up at all.
  await put("devin_20261001-223258_3826277.log", text);
  expect(await devinQuotaSignal({ ...session, source: "herdr:claude" }, promptMs, dir)).toBe(false);
  expect(await devinQuotaSignal({ ...session, value: "../escape" }, promptMs, dir)).toBe(false);
});

it("scans newest-first past other processes' logs and parses every stated reset unit", async () => {
  dir = await mkdtemp(join(tmpdir(), "devin-quota-"));
  const text = await readFile(fixture, "utf8");
  const [stall] = text.match(ERROR_LINE)!;
  // An idle sibling process with a newer log and no session lines is skipped.
  await put("devin_20261001-223258_3826277.log", text);
  await put("devin_20261002-000000_1.log", "2026-10-02T01:40:00.000000Z  INFO run_acp_server: chisel_agent::skills_loading: skills discovery\n");
  expect(await devinQuotaSignal(session, promptMs, dir)).toEqual({ retryNotBefore: RESET });
  for (const [phrase, expected] of [
    ["Your limit will reset in 1 hour.", "2026-10-02T02:33:04.421Z"],
    ["Your limit will reset in 90 seconds.", "2026-10-02T01:34:34.421Z"],
    ["Upgrade to Max for higher limits.", null],
  ] as const) {
    const line = stall.replace(/Your limit will reset in 26 minutes\./u, phrase);
    await put("devin_20261001-223258_3826277.log", text.replace(ERROR_LINE, line));
    expect(await devinQuotaSignal(session, promptMs, dir)).toEqual({ retryNotBefore: expected });
  }
  // An exhausted-retries line for another inference error is not a provider limit.
  await put("devin_20261001-223258_3826277.log", text.replaceAll("Reached free model rate limit.", "Internal server error."));
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  // An unparseable stall timestamp is unorderable, so it never counts.
  await put("devin_20261001-223258_3826277.log", text.replace(ERROR_LINE, stall.replace("2026-10-02T01:33:04.421266Z", "not-a-time")));
  expect(await devinQuotaSignal(session, promptMs, dir)).toBe(false);
  // The tail read drops a partial first line of a log larger than the window.
  const padding = `${"2026-10-02T01:33:03.000000Z  INFO run_acp_server: chisel_agent::skills_loading: skills discovery".padEnd(400, " ")}\n`;
  await put("devin_20261001-223258_3826277.log", padding.repeat(700) + text);
  expect(await devinQuotaSignal(session, promptMs, dir)).toEqual({ retryNotBefore: RESET });
});

it("resolves Devin's data directory from XDG_DATA_HOME or the home default", () => {
  const prior = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = "/tmp/xdg";
    expect(devinCliDataDir()).toBe("/tmp/xdg/devin/cli");
    delete process.env.XDG_DATA_HOME;
    expect(devinCliDataDir().endsWith("/.local/share/devin/cli")).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prior;
  }
});
