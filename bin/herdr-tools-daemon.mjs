#!/usr/bin/env node
/* global process */
// Thin launcher for the emitted daemon entrypoint. The systemd unit executes
// `dist/src/daemon/main.js` directly; this exists for manual runs after
// `npm run build:mcp`.
import { runDaemonMain } from "../dist/src/daemon/main.js";

process.exitCode = await runDaemonMain();
