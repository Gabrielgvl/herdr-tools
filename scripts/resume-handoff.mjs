#!/usr/bin/env node
/* global AbortSignal, console, process */
// Read-only native-session handoff inspection. Identity is never a CLI argument.
import { HerdrCli } from "../dist/src/cli.js";
import { resolveEffectiveContext } from "../dist/src/context.js";
import { createHandoffAllocator, RUN_ID_PATTERN } from "../dist/src/handoff.js";
import { resumeHandoff } from "../dist/src/handoff-resume.js";
import { createNodeExec, resolveStartup } from "../dist/src/mcp/host.js";

try {
  const [runId, ...extra] = process.argv.slice(2);
  if (!runId || !RUN_ID_PATTERN.test(runId) || extra.length !== 0) {
    throw Object.assign(new Error("Usage: resume-handoff.mjs RUN_UUID"), { code: "USAGE" });
  }
  const startup = await resolveStartup();
  const cli = new HerdrCli(createNodeExec({ cwd: startup.projectDir }), 10_000, 50_000);
  const caller = await resolveEffectiveContext(cli, startup.context, AbortSignal.timeout(25_000));
  const run = await createHandoffAllocator().open(runId);
  console.log(JSON.stringify(await resumeHandoff(run, caller)));
} catch (error) {
  console.error(JSON.stringify({
    error: typeof error === "object" && error !== null && "code" in error ? error.code : "HANDOFF_RESUME_FAILED",
    message: error instanceof Error ? error.message.slice(0, 500) : "Handoff resume failed"
  }));
  process.exitCode = 1;
}
