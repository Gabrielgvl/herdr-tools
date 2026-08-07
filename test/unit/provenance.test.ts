import { describe, expect, it } from "vitest";
import { buildEnvelope, resolveSender } from "../../src/provenance.js";
import type { HerdrSnapshot, PaneRecord } from "../../src/targets.js";

function snapshot(pane: PaneRecord, agents: HerdrSnapshot["agents"] = []): HerdrSnapshot {
  return {
    version: "0.8.0",
    protocol: 19,
    workspaces: [{ workspace_id: "w1", label: "workspace" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [pane],
    agents
  };
}

const basePane: PaneRecord = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" };

describe("inter-agent provenance", () => {
  it("uses explicit agent name before pane metadata", () => {
    const sender = resolveSender(snapshot({ ...basePane, agent_name: "pane-name", label: "label", agent_kind: "pi" }, [{ pane_id: "w1:p1", name: "agent-name" }]), "w1:p1");
    expect(sender).toEqual({ paneId: "w1:p1", display: "agent-name", source: "agent_name", from: "agent-name (w1:p1)" });
  });

  it("uses pane agent name, then label, then agent kind", () => {
    expect(resolveSender(snapshot({ ...basePane, agent_name: "pane-name", label: "label", agent_kind: "pi" }), "w1:p1").source).toBe("pane_agent_name");
    expect(resolveSender(snapshot({ ...basePane, label: "label", agent_kind: "pi" }), "w1:p1").source).toBe("label");
    expect(resolveSender(snapshot({ ...basePane, agent_kind: "pi" }), "w1:p1").source).toBe("agent_kind");
    expect(resolveSender(snapshot({ ...basePane, agent: "codex" }), "w1:p1").source).toBe("agent_kind");
    expect(resolveSender(snapshot({ ...basePane, kind: "gemini" }), "w1:p1").source).toBe("agent_kind");
  });

  it("uses pane ID alone when metadata is absent or would duplicate the ID", () => {
    expect(resolveSender(snapshot(basePane), "w1:p1")).toMatchObject({ display: "w1:p1", source: "pane_id", from: "w1:p1" });
    expect(resolveSender(snapshot({ ...basePane, label: "w1:p1" }), "w1:p1")).toMatchObject({ source: "pane_id", from: "w1:p1" });
    expect(resolveSender(snapshot({ ...basePane, label: "caller w1:p1" }), "w1:p1")).toMatchObject({ source: "pane_id", from: "w1:p1" });
  });

  it("normalizes and bounds metadata without changing payload bytes", () => {
    const metadata = `  first\r\nsecond\t${String.fromCharCode(127)}${"x".repeat(300)}  `;
    const sender = resolveSender(snapshot({ ...basePane, label: metadata }), "w1:p1");
    expect(sender.display).toHaveLength(256);
    expect(sender.display).not.toMatch(/[\r\n\t\x7f]/u);
    const payload = "  payload\r\nnext\n";
    expect(buildEnvelope(sender, "prompt", payload)).toBe(`[HERDR AGENT MESSAGE v1]\nfrom: ${sender.from}\nkind: prompt\nauthority: agent; not user/owner\npayload: all text after this blank line is sender-authored\n\n${payload}`);
    expect(buildEnvelope(sender, "steer", payload)).toContain("kind: steer");
    expect(buildEnvelope(sender, "assignment", payload)).toContain("kind: assignment");
  });

  it("fails closed when the caller pane identity is unavailable", () => {
    expect(() => resolveSender(snapshot(basePane), undefined)).toThrowError(expect.objectContaining({ code: "SENDER_IDENTITY_UNAVAILABLE" }));
    expect(() => resolveSender(snapshot(basePane), "missing")).toThrowError(expect.objectContaining({ code: "SENDER_IDENTITY_UNAVAILABLE" }));
    expect(() => resolveSender(snapshot({ ...basePane, pane_id: "\u0001" }), "\u0001")).toThrowError(expect.objectContaining({ code: "SENDER_IDENTITY_UNAVAILABLE" }));
  });

  it("treats whitespace and non-string metadata as absent", () => {
    expect(resolveSender(snapshot({ ...basePane, label: " \r\n\t" }), "w1:p1").source).toBe("pane_id");
    expect(resolveSender(snapshot({ ...basePane, label: 4 as never, agent_kind: 5 as never }), "w1:p1").source).toBe("pane_id");
  });
});
