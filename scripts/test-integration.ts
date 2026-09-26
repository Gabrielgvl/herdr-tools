import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_SESSION = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? "herdr-tools-integration";

function parseSession(argv: string[]): string {
  let session = REQUIRED_SESSION;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--session") {
      session = argv[index + 1] ?? "";
      index += 1;
    } else if (value.startsWith("--session=")) {
      session = value.slice("--session=".length);
    } else {
      throw new Error(`Unsupported integration argument: ${value}`);
    }
  }
  if (session !== REQUIRED_SESSION) throw new Error(`Integration session must be ${REQUIRED_SESSION}`);
  return session;
}

const session = parseSession(process.argv.slice(2));
if (process.env.HERDR_TOOLS_RUN_INTEGRATION !== "1") {
  throw new Error("HERDR_TOOLS_RUN_INTEGRATION=1 is required for disposable integration");
}
const runAgy = process.env.HERDR_TOOLS_RUN_AGY_INTEGRATION === "1";
const agyProofPath = runAgy ? join(tmpdir(), `herdr-tools-agy-proof-${process.pid}-${randomUUID()}`) : undefined;
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HERDR_TOOLS_RUN_INTEGRATION: "1",
    HERDR_TOOLS_INTEGRATION_SESSION: session,
    ...(agyProofPath ? { HERDR_TOOLS_AGY_INTEGRATION_PROOF: agyProofPath } : {})
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
try {
  if (runAgy && (!agyProofPath || !existsSync(agyProofPath) || readFileSync(agyProofPath, "utf8") !== "qualified")) {
    throw new Error("HERDR_TOOLS_RUN_AGY_INTEGRATION=1 did not complete the disposable AGY qualification");
  }
  process.exitCode = result.status ?? 1;
} finally {
  if (agyProofPath) rmSync(agyProofPath, { force: true });
}
