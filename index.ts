import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli } from "./src/cli.js";
import { createCommunicateTool } from "./src/tools/communicate.js";
import { createInspectTool } from "./src/tools/inspect.js";
import { createLaunchTool } from "./src/tools/launch.js";
import { createPaneTool } from "./src/tools/pane.js";
import { createTabTool } from "./src/tools/tab.js";
import { createWaitTool } from "./src/tools/wait.js";
import { RuntimeOwnership, resetOwnership, type OwnedResource } from "./src/ownership.js";
import { loadSettings, type Settings } from "./src/settings.js";
import type { CurrentContext } from "./src/targets.js";

export const CORE_TOOL_NAMES = [
  "herdr_inspect",
  "herdr_communicate",
  "herdr_wait",
  "herdr_launch",
  "herdr_pane",
  "herdr_tab",
] as const;

export interface InjectedContextState {
  context: CurrentContext;
  idsPresent: boolean;
  idsValid: boolean;
}

export interface CreatedResourceRegistry {
  record(resource: OwnedResource): void;
}

export interface ExtensionRuntime {
  cli: HerdrCli;
  context: CurrentContext;
  ownership: RuntimeOwnership;
  settings: { load: () => Promise<Settings> };
  idsPresent: boolean;
  idsValid: boolean;
}

function injectedId(value: string | undefined): { value?: string; valid: boolean } {
  if (value === undefined) return { valid: true };
  if (value.length === 0 || value.includes(String.fromCharCode(0)) || value.includes("\r") || value.includes("\n")) return { valid: false };
  return { value, valid: true };
}

export function readInjectedContext(env: NodeJS.ProcessEnv = process.env): InjectedContextState {
  const workspace = injectedId(env.HERDR_WORKSPACE_ID);
  const tab = injectedId(env.HERDR_TAB_ID);
  const pane = injectedId(env.HERDR_PANE_ID);
  const values = [workspace.value, tab.value, pane.value];
  const idsPresent = values.every((value) => value !== undefined);
  const idsValid = workspace.valid && tab.valid && pane.valid && (values.every((value) => value === undefined) || idsPresent);
  return {
    context: {
      ...(workspace.value ? { workspaceId: workspace.value } : {}),
      ...(tab.value ? { tabId: tab.value } : {}),
      ...(pane.value ? { paneId: pane.value } : {}),
    },
    idsPresent,
    idsValid,
  };
}

export function createRuntime(pi: Pick<ExtensionAPI, "exec">, env: NodeJS.ProcessEnv = process.env): ExtensionRuntime {
  const injected = readInjectedContext(env);
  return {
    cli: new HerdrCli(pi.exec.bind(pi)),
    context: injected.context,
    ownership: new RuntimeOwnership(),
    settings: { load: () => loadSettings() },
    idsPresent: injected.idsPresent,
    idsValid: injected.idsValid,
  };
}

export default function herdrToolsExtension(pi: ExtensionAPI): void {
  if (process.env.HERDR_ENV !== "1") return;

  const runtime = createRuntime(pi);
  const environment = {
    enabled: true,
    currentIdsPresent: runtime.idsPresent,
    currentIdsValid: runtime.idsValid,
  };

  pi.on("session_shutdown", async () => {
    resetOwnership(runtime.ownership);
  });
  pi.on("session_start", async () => {
    resetOwnership(runtime.ownership);
  });

  pi.registerTool(createInspectTool({ cli: runtime.cli, context: runtime.context, environment }));
  pi.registerTool(createCommunicateTool({ cli: runtime.cli, context: runtime.context }));
  pi.registerTool(createWaitTool({
    cli: runtime.cli,
    context: runtime.context,
    settingsLoader: runtime.settings.load,
  }));
  pi.registerTool(createLaunchTool({
    cli: runtime.cli,
    context: runtime.context,
    cwd: process.cwd(),
    ownership: runtime.ownership,
  }));
  pi.registerTool(createPaneTool({
    cli: runtime.cli,
    context: runtime.context,
    cwd: process.cwd(),
    ownership: runtime.ownership,
  }));
  pi.registerTool(createTabTool({
    cli: runtime.cli,
    context: runtime.context,
    cwd: process.cwd(),
    ownership: runtime.ownership,
  }));
}

