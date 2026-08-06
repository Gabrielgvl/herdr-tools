export interface CompactResult {
  operation: string;
  outcome: "success" | "error" | "timeout" | "aborted" | "partial";
  targetId?: string;
  code?: string;
  postState?: { agent_status?: string };
}

export function formatCall(tool: string, operation: string, target?: string): string {
  return [tool, operation, target].filter(Boolean).join(" · ");
}

export function formatResult(result: CompactResult): string {
  if (result.outcome === "error") return `error ${result.code ?? "UNKNOWN"}${result.targetId ? ` · ${result.targetId}` : ""}`;
  const verb = result.outcome === "success" ? (result.operation === "inspect" ? "inspected" : result.operation === "communicate" ? "sent" : result.operation) : result.outcome;
  const state = result.postState?.agent_status ? ` · ${result.postState.agent_status}` : "";
  return `${verb}${result.targetId ? ` · ${result.targetId}` : ""}${state}`;
}
