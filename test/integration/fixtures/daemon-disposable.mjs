#!/usr/bin/env node
/* eslint-disable no-undef -- plain-ESM test fixture: process and AbortController are Node globals; the flat config declares them only for TS sources. */
/**
 * Disposable daemon entrypoint for integration tests.
 *
 * Replicates the production wiring in src/daemon/main.ts's invoked block
 * exactly — same namespace, dispatcher, ownership, reattach sweep, and
 * shutdown seams — except the runtime is built with `hintKinds` taken from
 * HERDR_TOOLS_DISPOSABLE_HINT_KINDS (comma-separated, e.g. "pi,claude,devin").
 * The production daemon passes no `hintKinds` and therefore runs with an EMPTY
 * qualified hint set; this fixture is the only place the set may be non-empty,
 * so the C9 idle-hint consumption canary can exercise the hint path end to end.
 */
import { createNodeExec } from "../../../dist/src/mcp/host.js";
import { resolveHandoffNamespace } from "../../../dist/src/handoff.js";
import { parseSnapshotResult } from "../../../dist/src/targets.js";
import { runDaemonMain } from "../../../dist/src/daemon/main.js";
import { resolveDaemonNamespace } from "../../../dist/src/daemon/namespace.js";
import { daemonRunOwnership, reattachDaemonRuns } from "../../../dist/src/daemon/reattach.js";
import { createDaemonRuntime, daemonDispatcher } from "../../../dist/src/daemon/runtime.js";

resolveDaemonNamespace(process.env)
  .then(async (namespace) => {
    const env = process.env;
    const runtime = createDaemonRuntime({
      exec: createNodeExec({ cwd: process.cwd() }),
      env,
      namespace,
      hintKinds: (env.HERDR_TOOLS_DISPOSABLE_HINT_KINDS ?? "")
        .split(",")
        .map((kind) => kind.trim())
        .filter((kind) => kind.length > 0),
    });
    const runs = await resolveHandoffNamespace(env);
    const signal = new AbortController().signal;
    return runDaemonMain({
      namespace,
      handler: daemonDispatcher(runtime),
      ownership: daemonRunOwnership(runtime.allocator),
      reattach: ({ mailbox, startedAt, lastHeartbeat }) => {
        // Same deferred bind as production: the §11 hint ops resolve the
        // mailbox lazily — the serialized status queue exists only now.
        runtime.bindMailbox(mailbox);
        return reattachDaemonRuns({
          namespace,
          runs,
          allocator: runtime.allocator,
          intents: runtime.intents,
          supervision: runtime.supervision,
          jobs: runtime.jobs,
          mailbox,
          snapshot: async () => parseSnapshotResult((await runtime.cli.runJson(["api", "snapshot"], signal)).result),
          startedAt,
          lastHeartbeat,
          log: (line) => process.stderr.write(`${line}\n`),
        });
      },
      seams: { flushHandoffs: async () => undefined, stopSupervisors: () => runtime.supervision.shutdown() },
    });
  })
  .then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
