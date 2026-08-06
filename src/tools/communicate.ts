import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli } from "../cli.js";
import { CommunicateParamsSchema, isNamedKey, type CommunicateParams } from "../schemas.js";
import { parseSnapshotResult, resolveTarget, type CurrentContext } from "../targets.js";
import { formatCall, formatResult } from "../tui.js";

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

function paneFrom(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || typeof (value as { pane?: unknown }).pane !== "object" || (value as { pane?: unknown }).pane === null) {
    throw Object.assign(new Error("Invalid Herdr pane response"), { code: "CLI_PROTOCOL_ERROR" });
  }
  return (value as { pane: Record<string, unknown> }).pane;
}

function stateOf(pane: Record<string, unknown>): string {
  return typeof pane.agent_status === "string" ? pane.agent_status : "unknown";
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
      const before = paneFrom((await deps.cli.runJson(["pane", "get", target.paneId!], signal!)).result);
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

      const postState = paneFrom((await deps.cli.runJson(["pane", "get", target.paneId!], signal!)).result);
      if (params.operation !== "keys" && stateOf(postState) !== "working") {
        throw Object.assign(new Error("Target did not enter working state"), { code: "POSTSTATE_UNAVAILABLE", details: { target: target.paneId, postState } });
      }
      const details: CommunicateDetails = {
        operation: params.operation,
        outcome: "sent",
        target: { paneId: target.paneId, tabId: target.tabId, workspaceId: target.workspaceId, label: target.label, agentName: target.agentName },
        postState
      };
      return { content: [{ type: "text", text: formatResult({ operation: "communicate", outcome: "success", targetId: target.paneId, postState: { agent_status: stateOf(postState) } }) }], details };
    },
    renderCall(args) { return { render: () => [formatCall("herdr_communicate", args.operation, args.target)], invalidate() {} }; },
    renderResult(result) { return { render: () => [formatResult({ operation: "communicate", outcome: "success", targetId: result.details?.target.paneId, postState: result.details?.postState as { agent_status?: string } })], invalidate() {} }; }
  };
}
