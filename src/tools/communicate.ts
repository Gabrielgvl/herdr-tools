import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli } from "../cli.js";
import { CommunicateParamsSchema, isNamedKey, type CommunicateParams } from "../schemas.js";
import { parseSnapshotResult, resolveTarget, type CurrentContext } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

interface CommunicateDetails {
  operation: "prompt" | "steer" | "keys";
  outcome: "sent";
  target: { paneId?: string; tabId?: string; workspaceId?: string; label?: string; agentName?: string };
  postState: Record<string, unknown>;
}

export interface CommunicateDependencies {
  cli: HerdrCli;
  context: CurrentContext;
}

const AUTHORITATIVE_STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);

function withoutSensitiveMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSensitiveMetadata);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(env|environment|env_vars|environment_variables|environment_overrides|environmentoverrides)$/i.test(key))
    .map(([key, item]) => [key, withoutSensitiveMetadata(item)]));
}

function paneFrom(value: unknown, expectedPaneId: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || typeof (value as { pane?: unknown }).pane !== "object" || (value as { pane?: unknown }).pane === null) {
    throw Object.assign(new Error("Invalid Herdr pane response"), { code: "CLI_PROTOCOL_ERROR" });
  }
  const pane = (value as { pane: Record<string, unknown> }).pane;
  if (!["pane_id", "tab_id", "workspace_id"].every((field) => typeof pane[field] === "string" && (pane[field] as string).length > 0)) {
    throw Object.assign(new Error("Herdr pane response is missing authoritative identifiers"), { code: "CLI_PROTOCOL_ERROR" });
  }
  if (pane.pane_id !== expectedPaneId) {
    throw Object.assign(new Error("Herdr pane response does not match the resolved target"), { code: "CLI_PROTOCOL_ERROR", details: { expectedPaneId, actualPaneId: pane.pane_id } });
  }
  return pane;
}

function stateOf(pane: Record<string, unknown>): string {
  return pane.agent_status as string;
}

function assertPostState(pane: Record<string, unknown>): void {
  if (typeof pane.agent_status !== "string" || !AUTHORITATIVE_STATES.has(pane.agent_status)) {
    throw Object.assign(new Error("Authoritative target post-state is unavailable"), { code: "POSTSTATE_UNAVAILABLE", details: { postState: withoutSensitiveMetadata(pane) } });
  }
}

export function createCommunicateTool(deps: CommunicateDependencies): ToolDefinition<typeof CommunicateParamsSchema, CommunicateDetails> {
  return {
    name: "herdr_communicate",
    label: "Herdr Communicate",
    description: "Send a normal prompt, explicitly steer, or send validated named keys to an exact Herdr agent target.",
    parameters: CommunicateParamsSchema,
    async execute(_id, params: CommunicateParams, signal) {
      if (params.operation === "keys" && params.keys.some((key) => !isNamedKey(key))) {
        throw Object.assign(new Error("Unsupported named key"), { code: "KEY_REJECTED" });
      }
      const snapshot = parseSnapshotResult((await deps.cli.runJson(["api", "snapshot"], signal!)).result);
      const target = resolveTarget(snapshot, params.target, "agent", deps.context);
      const before = paneFrom((await deps.cli.runJson(["pane", "get", target.paneId!], signal!)).result, target.paneId!);
      assertPostState(before);
      if (params.operation === "prompt" && stateOf(before) === "working") {
        throw Object.assign(new Error("Target is working; normal prompt refuses to interrupt"), { code: "TARGET_BUSY", details: { target: target.paneId } });
      }

      if (params.operation === "keys") {
        await deps.cli.runJson(["agent", "send-keys", target.paneId!, ...params.keys], signal!);
      } else if (params.operation === "steer") {
        await deps.cli.runJson(["agent", "send-keys", target.paneId!, "esc"], signal!);
        await deps.cli.runJson(["agent", "prompt", target.paneId!, params.text, "--wait", "--until", "working", "--timeout", "5000"], signal!);
      } else {
        await deps.cli.runJson(["agent", "prompt", target.paneId!, params.text, "--wait", "--until", "working", "--timeout", "5000"], signal!);
      }

      const postState = paneFrom((await deps.cli.runJson(["pane", "get", target.paneId!], signal!)).result, target.paneId!);
      assertPostState(postState);
      if (params.operation !== "keys" && stateOf(postState) !== "working") {
        throw Object.assign(new Error("Target did not enter working state"), { code: "POSTSTATE_UNAVAILABLE", details: { target: target.paneId, postState: withoutSensitiveMetadata(postState) } });
      }
      const details: CommunicateDetails = {
        operation: params.operation,
        outcome: "sent",
        target: { paneId: target.paneId, tabId: target.tabId, workspaceId: target.workspaceId, label: target.label, agentName: target.agentName },
        postState: withoutSensitiveMetadata(postState) as Record<string, unknown>
      };
      return { content: [{ type: "text", text: formatResult({ operation: "communicate", outcome: "success", targetId: target.paneId, postState: { agent_status: stateOf(postState) } }) }], details };
    },
    renderCall(args, theme) {
      return textComponent(formatCall("herdr_communicate", args.operation, args.target), theme, "accent");
    },
    renderResult(result, options, theme) {
      return renderResultComponent("communicate", result, options, theme, result.details?.target.paneId);
    }
  };
}
