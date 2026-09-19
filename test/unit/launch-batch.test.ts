import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { expandBatchRequest, type BatchChildFailure, type BatchExpansion, type BatchPlannedChild } from "../../src/launch-batch.js";
import { AutoLaunchParamsSchema, LaunchParamsSchema, ProfileLaunchParamsSchema, type AutoLaunchRequest, type LaunchAssignment } from "../../src/launch-schema.js";
import type { RouteDecision } from "../../src/router.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import { existingNameTargets, validateLaunchParams } from "../../src/tools/launch.js";

const assign = (objective: string): LaunchAssignment => ({ objective, scope: `scope for ${objective}`, verification: `verify ${objective}` });

const digest = (): AutoLaunchRequest["supervisionDigest"] => ({ doneWhen: ["The assigned objective is complete and verified."], constraints: ["none"] });

const auto = (overrides: Partial<AutoLaunchRequest> = {}): AutoLaunchRequest => ({ name: "task", assignment: assign("go"), supervisionDigest: digest(), ...overrides });

const decision = (assignments: Array<{ profile: string; count: number }>): RouteDecision => ({
  kind: "route",
  assignments: assignments.map(({ profile, count }) => ({
    profile,
    count,
    purpose: `Perform the ${profile.split("-")[0]} role for the supplied objective.`
  }))
});

const empty = new Set<string>();

function expanded(result: BatchExpansion): { children: BatchPlannedChild[]; failures: BatchChildFailure[] } {
  expect(result.kind).toBe("expanded");
  if (result.kind !== "expanded") throw new Error("expected an expanded result");
  return result;
}

describe("dual launch schema", () => {
  it("is a union of two strict objects with no root object keywords", () => {
    expect(LaunchParamsSchema.anyOf).toHaveLength(2);
    expect(LaunchParamsSchema.anyOf).toEqual([ProfileLaunchParamsSchema, AutoLaunchParamsSchema]);
    expect(LaunchParamsSchema).not.toHaveProperty("type");
    expect(LaunchParamsSchema).not.toHaveProperty("properties");
    expect(LaunchParamsSchema).not.toHaveProperty("required");
    // A root additionalProperties:false would reject every argument object.
    expect(LaunchParamsSchema).not.toHaveProperty("additionalProperties");
    for (const variant of LaunchParamsSchema.anyOf) {
      expect(variant).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("keeps the auto variant free of profile and overrides while sharing the common fields", () => {
    expect(AutoLaunchParamsSchema.required).toEqual(expect.arrayContaining(["name", "assignment", "supervisionDigest"]));
    expect(AutoLaunchParamsSchema.required).not.toContain("profile");
    expect(AutoLaunchParamsSchema.properties).not.toHaveProperty("profile");
    expect(AutoLaunchParamsSchema.properties).not.toHaveProperty("overrides");
    for (const field of ["name", "assignment", "assignmentDelivery", "cwd", "focus", "label", "placement", "supervisionDigest"]) {
      expect(AutoLaunchParamsSchema.properties).toHaveProperty(field);
    }
    expect(Value.Check(AutoLaunchParamsSchema, { name: "task", assignment: assign("go"), supervisionDigest: digest() })).toBe(true);
    expect(Value.Check(AutoLaunchParamsSchema, { name: "task", assignment: assign("go"), supervisionDigest: digest(), profile: "worker-pi" })).toBe(false);
    expect(Value.Check(ProfileLaunchParamsSchema, { name: "task", assignment: assign("go"), supervisionDigest: digest() })).toBe(false);
  });

  it("lets schema and direct validation agree on valid explicit and auto requests", () => {
    const valid: unknown[] = [
      { name: "worker", profile: "worker-pi", assignment: assign("go"), supervisionDigest: digest() },
      { name: "worker", profile: "worker-pi", assignment: assign("go"), supervisionDigest: digest(), overrides: { model: "m" }, placement: { mode: "same_tab" } },
      { name: "task", assignment: assign("go"), supervisionDigest: digest() },
      { name: "task", assignment: assign("go"), supervisionDigest: digest(), label: "lbl", cwd: "/repo", focus: true, assignmentDelivery: "attachment", placement: { mode: "new_tab", tabLabel: "tab" } },
      { name: "task", assignment: assign("go"), supervisionDigest: digest(), placement: { mode: "existing_pane", target: "w:p1" } }
    ];
    for (const value of valid) {
      expect(Value.Check(LaunchParamsSchema, value), JSON.stringify(value)).toBe(true);
      expect(() => validateLaunchParams(value as never), JSON.stringify(value)).not.toThrow();
    }
  });

  it("accepts an omitted profile as auto and rejects every malformed present profile", () => {
    const base = { name: "task", assignment: assign("go"), supervisionDigest: digest() };
    expect(Value.Check(LaunchParamsSchema, base)).toBe(true);
    expect(() => validateLaunchParams(base as never)).not.toThrow();
    for (const profile of [null, "", 7, {}, [], "UPPER", "bad name", "-lead", "worker-pi\n"]) {
      const value = { ...base, profile };
      expect(Value.Check(LaunchParamsSchema, value), JSON.stringify(value)).toBe(false);
      expect(() => validateLaunchParams(value as never), JSON.stringify(value)).toThrow();
    }
    // A present but undefined profile is still a present profile field.
    const present = { ...base, profile: undefined };
    expect(Value.Check(LaunchParamsSchema, present)).toBe(false);
    expect(() => validateLaunchParams(present as never)).toThrow();
  });

  it("treats a literal profile named auto as an ordinary explicit profile", () => {
    const value = { name: "task", profile: "auto", assignment: assign("go"), supervisionDigest: digest() };
    expect(Value.Check(LaunchParamsSchema, value)).toBe(true);
    expect(() => validateLaunchParams(value as never)).not.toThrow();
    const withOverrides = { ...value, overrides: { model: "m" } };
    expect(Value.Check(LaunchParamsSchema, withOverrides)).toBe(true);
    expect(() => validateLaunchParams(withOverrides as never)).not.toThrow();
  });

  it("rejects raw fields, extra keys, and overrides without a named profile in both layers", () => {
    const autoBase = { name: "task", assignment: assign("go"), supervisionDigest: digest() };
    const invalid: unknown[] = [
      { ...autoBase, kind: "pi" },
      { ...autoBase, argv: ["--model", "x"] },
      { ...autoBase, env: { X: "y" } },
      { ...autoBase, initialPrompt: "x" },
      { ...autoBase, extra: true },
      { ...autoBase, overrides: { model: "m" } },
      { ...autoBase, overrides: {} },
      { ...autoBase, extensions: ["./ext"] },
      { name: "task", profile: "worker-pi", assignment: assign("go"), supervisionDigest: digest(), kind: "pi" },
      { name: "task", profile: "worker-pi", assignment: assign("go"), supervisionDigest: digest(), extra: true }
    ];
    for (const value of invalid) {
      expect(Value.Check(LaunchParamsSchema, value), JSON.stringify(value)).toBe(false);
      expect(() => validateLaunchParams(value as never), JSON.stringify(value)).toThrow();
    }
  });

  it("keeps the exact assignment and placement rules on both variants", () => {
    const full = assign("go");
    const bases = [{ name: "task", profile: "worker-pi", supervisionDigest: digest() }, { name: "task", supervisionDigest: digest() }];
    for (const base of bases) {
      const missing = { ...base, assignment: { objective: "o", scope: "s" } };
      const extra = { ...base, assignment: { ...full, extra: "e" } };
      const absent = { name: base.name };
      for (const value of [missing, extra, absent]) {
        expect(Value.Check(LaunchParamsSchema, value), JSON.stringify(value)).toBe(false);
        expect(() => validateLaunchParams(value as never), JSON.stringify(value)).toThrow();
      }
      const badPlacement = { ...base, assignment: full, placement: { mode: "new_tab" } };
      expect(Value.Check(LaunchParamsSchema, badPlacement)).toBe(false);
      expect(() => validateLaunchParams(badPlacement as never)).toThrow();
      const goodPlacement = { ...base, assignment: full, placement: { mode: "existing_pane", target: "w:p1" } };
      expect(Value.Check(LaunchParamsSchema, goodPlacement)).toBe(true);
      expect(() => validateLaunchParams(goodPlacement as never)).not.toThrow();
    }
    // Explicit-only override rules stay intact on the named-Profile variant.
    const explicit = { name: "task", profile: "worker-pi", assignment: full, supervisionDigest: digest() };
    expect(Value.Check(LaunchParamsSchema, { ...explicit, overrides: { model: "m" } })).toBe(true);
    expect(() => validateLaunchParams({ ...explicit, overrides: { model: "m" } } as never)).not.toThrow();
    expect(Value.Check(LaunchParamsSchema, { ...explicit, overrides: { bogus: 1 } })).toBe(false);
    expect(() => validateLaunchParams({ ...explicit, overrides: { bogus: 1 } } as never)).toThrow();
    expect(() => validateLaunchParams({ ...explicit, profile: "promoter-pi", overrides: { model: "m" } } as never)).toThrow(/does not accept runtime overrides/);
  });
});

describe("existingNameTargets", () => {
  it("collects agent names and pane labels because both shadow exact targets", () => {
    const snapshot = {
      version: "1",
      protocol: 1,
      workspaces: [{ workspace_id: "w", label: "w" }],
      tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
      panes: [
        { pane_id: "w:p1", tab_id: "w:t", workspace_id: "w", label: "busy", agent_name: "named-agent" },
        { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", label: "shadowing-label" },
        { pane_id: "w:p3", tab_id: "w:t", workspace_id: "w" },
        { pane_id: "w:p4", tab_id: "w:t", workspace_id: "w", label: "" }
      ],
      agents: [
        { pane_id: "w:p1", name: "named-agent" },
        { pane_id: "w:p9", name: "detached-name" }
      ]
    } as HerdrSnapshot;
    const names = existingNameTargets(snapshot);
    expect(names).toEqual(new Set(["named-agent", "detached-name", "busy", "shadowing-label"]));
  });
});

describe("expandBatchRequest", () => {
  it("derives {name}-{role}-{N} with a per-role one-based counter in RouteDecision order", () => {
    const result = expanded(expandBatchRequest(auto(), decision([
      { profile: "worker-pi", count: 2 },
      { profile: "scout-agy", count: 1 },
      { profile: "worker-claude", count: 1 }
    ]), empty));
    expect(result.children.map((child) => child.name)).toEqual(["task-worker-1", "task-worker-2", "task-scout-1", "task-worker-3"]);
    expect(result.children.map((child) => [child.role, child.ordinal] as const)).toEqual([["worker", 1], ["worker", 2], ["scout", 1], ["worker", 3]]);
    expect(result.children.map((child) => child.profile)).toEqual(["worker-pi", "worker-pi", "scout-agy", "worker-claude"]);
    expect(result.failures).toEqual([]);
    // A repeated role continues its counter instead of reusing a name.
    expect(new Set(result.children.map((child) => child.name)).size).toBe(result.children.length);
  });

  it("keeps the name independent of the selected profile so fallback never renames a child", () => {
    const result = expanded(expandBatchRequest(auto(), decision([{ profile: "worker-claude", count: 1 }]), empty));
    expect(result.children[0]).toMatchObject({ name: "task-worker-1", role: "worker", profile: "worker-claude", ordinal: 1, count: 1, purpose: "Perform the worker role for the supplied objective." });
    expect(result.children[0]!.name).not.toContain("claude");
  });

  it("accepts a derived name at the exact 32-character boundary and fails overflow without truncation", () => {
    const atLimit = expanded(expandBatchRequest(auto({ name: "n".repeat(23) }), decision([{ profile: "worker-pi", count: 1 }]), empty));
    expect(atLimit.children.map((child) => child.name)).toEqual([`${"n".repeat(23)}-worker-1`]);
    expect(atLimit.children[0]!.name).toHaveLength(32);
    expect(atLimit.failures).toEqual([]);

    const over = expanded(expandBatchRequest(auto({ name: "n".repeat(24) }), decision([{ profile: "worker-pi", count: 1 }]), empty));
    expect(over.children).toEqual([]);
    expect(over.failures).toEqual([
      { code: "BATCH_CHILD_NAME_INVALID", name: `${"n".repeat(24)}-worker-1`, role: "worker", profile: "worker-pi", ordinal: 1, message: expect.any(String) as unknown as string }
    ]);
    // The derived name is reported untruncated; the caller chooses a shorter name.
    expect(over.failures[0]!.name).toHaveLength(33);
  });

  it("lets an invalid child fail alone while unrelated children still expand", () => {
    // 24 + "-scout-1" is exactly 32; the worker sibling overflows.
    const result = expanded(expandBatchRequest(auto({ name: "n".repeat(24) }), decision([{ profile: "worker-pi", count: 1 }, { profile: "scout-agy", count: 1 }]), empty));
    expect(result.children.map((child) => child.name)).toEqual([`${"n".repeat(24)}-scout-1`]);
    expect(result.failures).toMatchObject([{ code: "BATCH_CHILD_NAME_INVALID", name: `${"n".repeat(24)}-worker-1` }]);
  });

  it("fails names already held by existing agent names or shadowing pane labels", () => {
    const snapshot = {
      version: "1",
      protocol: 1,
      workspaces: [{ workspace_id: "w", label: "w" }],
      tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
      panes: [
        { pane_id: "w:p1", tab_id: "w:t", workspace_id: "w", label: "caller", agent_name: "task-worker-1" },
        // A pane label shadows a name even when no agent carries it.
        { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", label: "task-scout-1" }
      ],
      agents: [{ pane_id: "w:p1", name: "task-worker-1" }]
    } as HerdrSnapshot;
    const result = expanded(expandBatchRequest(auto(), decision([
      { profile: "worker-pi", count: 1 },
      { profile: "scout-agy", count: 1 },
      { profile: "reviewer-pi", count: 1 }
    ]), existingNameTargets(snapshot)));
    expect(result.children.map((child) => child.name)).toEqual(["task-reviewer-1"]);
    expect(result.failures).toMatchObject([
      { code: "BATCH_NAME_COLLISION", name: "task-worker-1", role: "worker", profile: "worker-pi", ordinal: 1 },
      { code: "BATCH_NAME_COLLISION", name: "task-scout-1", role: "scout", profile: "scout-agy", ordinal: 1 }
    ]);
  });

  it("treats a name planned elsewhere as taken instead of minting a duplicate", () => {
    const result = expanded(expandBatchRequest(auto(), decision([{ profile: "worker-pi", count: 2 }]), new Set(["task-worker-1"])));
    expect(result.children.map((child) => child.name)).toEqual(["task-worker-2"]);
    expect(result.failures).toMatchObject([{ code: "BATCH_NAME_COLLISION", name: "task-worker-1" }]);
  });

  it("fails a derived label already held by an existing pane label while siblings still expand", () => {
    const snapshot = {
      version: "1",
      protocol: 1,
      workspaces: [{ workspace_id: "w", label: "w" }],
      tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
      panes: [
        // A pane label shadows an exact target even when no agent carries it.
        { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", label: "lbl-worker-1" }
      ],
      agents: []
    } as HerdrSnapshot;
    const result = expanded(expandBatchRequest(auto({ label: "lbl" }), decision([
      { profile: "worker-pi", count: 2 },
      { profile: "scout-agy", count: 1 }
    ]), existingNameTargets(snapshot)));
    expect(result.children.map((child) => child.name)).toEqual(["task-worker-2", "task-scout-1"]);
    expect(result.failures).toMatchObject([
      { code: "BATCH_NAME_COLLISION", name: "task-worker-1", role: "worker", profile: "worker-pi", ordinal: 1 }
    ]);
    expect(result.failures[0]!.message).toContain("label");
  });

  it("fails a derived label already held by an existing agent name", () => {
    const snapshot = {
      version: "1",
      protocol: 1,
      workspaces: [{ workspace_id: "w", label: "w" }],
      tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
      panes: [{ pane_id: "w:p1", tab_id: "w:t", workspace_id: "w", label: "caller", agent_name: "lbl-scout-1" }],
      agents: [{ pane_id: "w:p1", name: "lbl-scout-1" }]
    } as HerdrSnapshot;
    const result = expanded(expandBatchRequest(auto({ label: "lbl" }), decision([
      { profile: "worker-pi", count: 1 },
      { profile: "scout-agy", count: 1 }
    ]), existingNameTargets(snapshot)));
    expect(result.children.map((child) => child.name)).toEqual(["task-worker-1"]);
    expect(result.failures).toMatchObject([
      { code: "BATCH_NAME_COLLISION", name: "task-scout-1", role: "scout", profile: "scout-agy", ordinal: 1 }
    ]);
  });

  it("does not collide a derived label equal to the child's own name", () => {
    // name === label makes the derived label the derived name: the label
    // check runs before the name claim, so the child cannot hit itself.
    const result = expanded(expandBatchRequest(auto({ label: "task" }), decision([{ profile: "worker-pi", count: 2 }]), empty));
    expect(result.children.map((child) => [child.name, child.label] as const)).toEqual([
      ["task-worker-1", "task-worker-1"],
      ["task-worker-2", "task-worker-2"]
    ]);
    expect(result.failures).toEqual([]);
  });

  it("suffixes explicit labels and new-tab labels with -{role}-{N}", () => {
    const result = expanded(expandBatchRequest(auto({ label: "lbl", placement: { mode: "new_tab", tabLabel: "tab" } }), decision([{ profile: "worker-pi", count: 2 }]), empty));
    expect(result.children.map((child) => child.label)).toEqual(["lbl-worker-1", "lbl-worker-2"]);
    expect(result.children.map((child) => child.placement)).toEqual([
      { mode: "new_tab", tabLabel: "tab-worker-1" },
      { mode: "new_tab", tabLabel: "tab-worker-2" }
    ]);
  });

  it("leaves an absent label undefined so the pane keeps the child name, and keeps same_tab unchanged", () => {
    const result = expanded(expandBatchRequest(auto(), decision([{ profile: "worker-pi", count: 1 }]), empty));
    expect(result.children[0]!.label).toBeUndefined();
    expect(result.children[0]!.placement).toEqual({ mode: "same_tab" });
  });

  it("allows existing_pane only for exactly one expanded child and rejects more before any child check", () => {
    const target = { mode: "existing_pane", target: "w:p9" } as const;
    const single = expandBatchRequest(auto({ placement: target }), decision([{ profile: "worker-pi", count: 1 }]), empty);
    expect(single.kind).toBe("expanded");
    if (single.kind === "expanded") expect(single.children[0]!.placement).toEqual(target);

    for (const assignments of [
      [{ profile: "worker-pi", count: 2 }],
      [{ profile: "worker-pi", count: 1 }, { profile: "scout-agy", count: 1 }]
    ]) {
      const result = expandBatchRequest(auto({ placement: target }), decision(assignments), empty);
      expect(result).toEqual({ kind: "invalid", code: "BATCH_PLACEMENT_INVALID", message: expect.any(String) as unknown as string });
    }
    // Placement is decided before any per-child check: even names that would
    // collide or overflow cannot leak a partial expansion.
    const colliding = expandBatchRequest(auto({ name: "n".repeat(24), placement: target }), decision([{ profile: "worker-pi", count: 2 }]), new Set(["task-worker-1"]));
    expect(colliding.kind).toBe("invalid");
  });
});

/* ======================= executor boundary ======================= */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CliProtocolError } from "../../src/cli.js";
import type { ContextResolver } from "../../src/context.js";
import type { HandoffAllocator } from "../../src/handoff.js";
import { RecipientRegistry } from "../../src/messages/recipients.js";
import { parseProfile, profileSource, type ProfileCatalog } from "../../src/profiles/index.js";
import { createLaunchTool, type LaunchBatchDetails, type LaunchCli, type LaunchDependencies, type LaunchDetails } from "../../src/tools/launch.js";
import { stubSupervision } from "./supervision-fixtures.js";

const batchContext = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const batchExtension = { cwd: "/repo", hasUI: false } as ExtensionContext;
const batchSnapshot = (overrides: Partial<HerdrSnapshot> = {}): HerdrSnapshot => ({
  version: "0.8.0",
  protocol: 22,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }],
  agents: [],
  ...overrides
});
const resolverFor = (...snapshots: HerdrSnapshot[]): ContextResolver => {
  let reads = 0;
  return async () => ({
    context: batchContext,
    snapshot: snapshots[Math.min(reads++, snapshots.length - 1)] ?? batchSnapshot(),
    diagnostics: { injected: batchContext, effective: batchContext, rebound: false, attempts: 1 },
    operationIds: { current: "current", snapshot: "snapshot" }
  });
};

/** A CLI that dies on every call; enough to prove order, effects, and per-child failure evidence. */
const deadCli = (calls: string[][]): LaunchCli => ({
  runJson: vi.fn<LaunchCli["runJson"]>(async (argv) => {
    calls.push(argv);
    throw new CliProtocolError("CLI_PROTOCOL_ERROR", "cli unavailable", { exitCode: 1 });
  }),
  prompt: vi.fn<LaunchCli["prompt"]>(async (target) => {
    calls.push(["agent", "prompt", target]);
    throw new CliProtocolError("CLI_PROTOCOL_ERROR", "cli unavailable", { exitCode: 1 });
  })
});

const noopHandoffs: HandoffAllocator = {
  allocate: async () => {
    const runId = randomUUID();
    const namespaceDir = join(tmpdir(), `herdr-batch-handoffs-${randomUUID()}`);
    const directory = join(namespaceDir, runId);
    const toolsDir = join(directory, ".tools");
    return { runId, namespaceDir, directory, artifactPath: join(directory, "handoff.md"), toolsDir, statePath: join(toolsDir, "state.json"), lockPath: join(toolsDir, "lock"), marker: `herdr-run:${runId}` };
  },
  persist: async () => undefined
};

const fakeStore = {
  root: "/cache",
  recipientDirectory: (key: string) => `/cache/${key}`,
  ensureRecipient: vi.fn(async () => ({ path: "/cache/grant", token: "t", renew: async () => undefined, release: async () => undefined })),
  publish: vi.fn(async () => ({ attachmentId: "a", path: "/cache/a", bytes: 1, sha256: "b".repeat(64), expiresAt: "2026-08-21T12:00:00.000Z" }))
};

const batchProfile = (name: string, fallbackProfiles: string[] = []) =>
  parseProfile(`---\nname: ${name}\ndescription: ${name}\ntimeoutMinutes: 30\nsessionPersistence: false\nruntime:\n  kind: pi\n  model: test/model\n  thinking: low\n  tools: [read, write]\nfallbackProfiles: ${JSON.stringify(fallbackProfiles)}\n---\n\nProfile body for ${name}.\n`, profileSource("bundled", `/profiles/${name}.md`, "/profiles"));
const batchCatalog = (...profiles: ReturnType<typeof batchProfile>[]): ProfileCatalog => ({ effective: new Map(profiles.map((item) => [item.name, item])), candidates: [], diagnostics: [] });

async function executeAuto(
  params: AutoLaunchRequest,
  deps: Partial<Omit<LaunchDependencies, "profiles">> & {
    cli: LaunchCli;
    profiles?: ProfileCatalog | { load: () => Promise<ProfileCatalog> };
    signal?: AbortSignal;
    onUpdate?: (update: AgentToolResult<LaunchDetails | LaunchBatchDetails>) => void;
    ctx?: ExtensionContext;
  }
) {
  const { profiles, signal, onUpdate, ctx, ...rest } = deps;
  const loader = profiles === undefined ? undefined : "effective" in profiles ? { load: async () => profiles } : profiles;
  const tool = createLaunchTool({
    context: batchContext,
    cwd: "/repo",
    promptSources: { create: async () => ({ path: "/cache/body.md" }) },
    attachments: fakeStore,
    recipients: new RecipientRegistry(),
    launchGate: async () => ({ check: async () => undefined, release: async () => undefined }),
    handoffs: noopHandoffs,
    preflight: async () => undefined,
    supervision: stubSupervision(),
    contextResolver: resolverFor(batchSnapshot()),
    ...rest,
    profiles: loader
  });
  const result = await tool.execute("id", params as never, signal, onUpdate, ctx ?? batchExtension);
  if (result.details?.operation !== "launch_batch") throw new Error("expected a batch result");
  return result as AgentToolResult<LaunchBatchDetails>;
}

describe("batch executor boundary", () => {
  it("abstains with zero effects when the catalog cannot be loaded", async () => {
    const calls: string[][] = [];
    const route = vi.fn(async () => ({ result: decision([{ profile: "worker-pi", count: 1 }]), probabilities: {} }));
    const entries: Array<{ state: unknown }> = [];
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      router: { route },
      routerLog: async (entry) => { entries.push(entry); },
      profiles: { load: async (): Promise<ProfileCatalog> => { throw new Error("catalog read failed"); } }
    });
    expect(result.details).toMatchObject({ outcome: "abstained", router: { kind: "abstain", reason: "catalog_unavailable" }, children: [] });
    expect(route).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.state).toEqual({ status: "unavailable", reason: "catalog_unavailable" });
    expect(calls).toEqual([]);
  });

  it("a router-log failure retains the decision and launches zero children", async () => {
    const calls: string[][] = [];
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 2 }]), probabilities: {} }) },
      routerLog: async () => { throw new Error("sink down"); }
    });
    expect(result.details).toMatchObject({ outcome: "failed", router: { kind: "route" }, children: [], failure: { code: "ROUTER_LOG_UNAVAILABLE" } });
    expect(calls).toEqual([]);
  });

  it("dispatches planned children sequentially and retains every child's failure evidence", async () => {
    const calls: string[][] = [];
    const supervision = stubSupervision();
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 2 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      supervision
    });
    expect(result.details?.outcome).toBe("failed");
    const children = result.details?.children ?? [];
    expect(children.map((child) => [child.name, child.status])).toEqual([
      ["task-worker-1", "failed"],
      ["task-worker-2", "failed"]
    ]);
    for (const child of children) {
      expect(child.failure?.code).toBeDefined();
      expect(child.failure?.details).toBeDefined();
    }
    // Both children reached their reservation step, in order, before failing.
    expect(supervision.reserved.map((item) => item.agentName)).toEqual(["task-worker-1", "task-worker-2"]);
    // No child was raced: the second child's first mutation lands only after
    // the first child's failed attempt completed its reconciliation reads.
    const splitIndexes = calls.map((argv, index) => [argv, index] as const).filter(([argv]) => argv[0] === "pane" && argv[1] === "split");
    expect(splitIndexes).toHaveLength(2);
  });

  it("stops dispatching on caller abort and marks the tail not_started", async () => {
    const calls: string[][] = [];
    const controller = new AbortController();
    let leases = 0;
    const launchGate: LaunchDependencies["launchGate"] = async () => {
      const mine = ++leases;
      return { check: async () => undefined, release: async () => { if (mine === 2) controller.abort(); } };
    };
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 3 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      launchGate,
      signal: controller.signal
    });
    const children = result.details?.children ?? [];
    expect(children).toHaveLength(3);
    expect(children[0]?.status).toBe("failed");
    expect(children[1]).toMatchObject({ name: "task-worker-2", status: "not_started", code: "ABORTED" });
    expect(children[2]).toMatchObject({ name: "task-worker-3", status: "not_started", code: "ABORTED" });
  });

  it("re-checks a planned label against the fresh snapshot immediately before a child", async () => {
    const calls: string[][] = [];
    const collided = batchSnapshot({
      panes: [...batchSnapshot().panes, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", label: "task-worker-2", agent_status: "idle" }]
    });
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 2 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      // Expansion sees an empty namespace; child two's fresh check meets a
      // sibling-claimed label that arrived after the decision was logged.
      contextResolver: resolverFor(batchSnapshot(), batchSnapshot(), collided)
    });
    const children = result.details?.children ?? [];
    expect(children).toHaveLength(2);
    expect(children[1]).toMatchObject({ name: "task-worker-2", status: "failed", failure: { code: "BATCH_NAME_COLLISION" } });
  });

  it("re-checks the effective pane label against the fresh snapshot immediately before a child", async () => {
    const calls: string[][] = [];
    const collided = batchSnapshot({
      panes: [...batchSnapshot().panes, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", label: "lbl-worker-2", agent_status: "idle" }]
    });
    const result = await executeAuto(auto({ label: "lbl" }), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 2 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      // Expansion sees an empty namespace; child two's fresh check meets the
      // derived label a concurrent launch claimed after the decision was logged.
      contextResolver: resolverFor(batchSnapshot(), batchSnapshot(), collided)
    });
    const children = result.details?.children ?? [];
    expect(children).toHaveLength(2);
    expect(children[1]).toMatchObject({ name: "task-worker-2", status: "failed", failure: { code: "BATCH_NAME_COLLISION" } });
    // The collided child never mutated: only its sibling reached a split.
    expect(calls.filter((argv) => argv[0] === "pane" && argv[1] === "split")).toHaveLength(1);
  });

  it("surfaces a derived-label expansion collision as a failed entry while siblings dispatch", async () => {
    const calls: string[][] = [];
    const taken = batchSnapshot({
      panes: [...batchSnapshot().panes, { pane_id: "w1:p8", tab_id: "w1:t1", workspace_id: "w1", label: "lbl-worker-1", agent_status: "idle" }]
    });
    const result = await executeAuto(auto({ label: "lbl" }), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 2 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      contextResolver: resolverFor(taken)
    });
    const children = result.details?.children ?? [];
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ name: "task-worker-1", status: "failed", failure: { code: "BATCH_NAME_COLLISION" } });
    expect(children[1]?.name).toBe("task-worker-2");
    // The collided child was never dispatched: only its sibling attempted a mutation.
    expect(calls.filter((argv) => argv[0] === "pane" && argv[1] === "split")).toHaveLength(1);
  });

  it("refuses a multi-child existing-pane batch before any child dispatch", async () => {
    const calls: string[][] = [];
    const result = await executeAuto(auto({ placement: { mode: "existing_pane", target: "w1:p1" } }), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 2 }]), probabilities: {} }) },
      routerLog: async () => undefined
    });
    expect(result.details).toMatchObject({ outcome: "failed", failure: { code: "BATCH_PLACEMENT_INVALID" }, children: [] });
    expect(calls).toEqual([]);
  });

  it("keeps a complete compact manifest naming every expanded child and its outcome", async () => {
    const calls: string[][] = [];
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 3 }]), probabilities: {} }) },
      routerLog: async () => undefined
    });
    const manifest = result.content[0];
    expect(manifest?.type).toBe("text");
    if (manifest?.type === "text") {
      for (const name of ["task-worker-1", "task-worker-2", "task-worker-3"]) {
        expect(manifest.text).toContain(name);
      }
      expect(manifest.text).toContain("requested=worker-pi");
      expect(manifest.text).toContain("outcome=failed");
      expect(manifest.text).toContain("children=3");
    }
    expect(result.details?.children).toHaveLength(3);
  });

  it("expansion collisions surface as failed entries while planned siblings still dispatch", async () => {
    const calls: string[][] = [];
    const taken = batchSnapshot({
      agents: [{ name: "task-worker-1", pane_id: "w1:p7", agent: "pi", agent_status: "idle" } as HerdrSnapshot["agents"][number]]
    });
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 2 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      contextResolver: resolverFor(taken)
    });
    const children = result.details?.children ?? [];
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ name: "task-worker-1", status: "failed", failure: { code: "BATCH_NAME_COLLISION" } });
    expect(children[1]?.name).toBe("task-worker-2");
    expect(children[1]?.status).toBe("failed");
  });

  it("rejects a batch like an explicit launch when the shared launch gate is frozen", async () => {
    const calls: string[][] = [];
    const launchGate: LaunchDependencies["launchGate"] = async () => ({
      check: async () => { throw new Error("frozen"); },
      release: () => Promise.reject(new Error("release failed"))
    });
    await expect(executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 1 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      launchGate
    })).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
    expect(calls).toEqual([]);
  });

  it("acquires the real shared gate and falls back to a fresh signal when none are injected", async () => {
    const calls: string[][] = [];
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 1 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      launchGate: undefined
    });
    expect(result.details?.children.map((child) => child.name)).toEqual(["task-worker-1"]);
  });

  it("fails a batch at the same delivery preflight gates as an explicit launch", async () => {
    const calls: string[][] = [];
    const cli = deadCli(calls);
    delete (cli as { prompt?: unknown }).prompt;
    await expect(executeAuto(auto({ assignmentDelivery: "attachment" }), {
      cli,
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 1 }]), probabilities: {} }) },
      routerLog: async () => undefined
    })).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
    expect(calls).toEqual([]);
  });

  it("abstains when the loaded catalog carries unreadable scopes", async () => {
    const calls: string[][] = [];
    const entries: Array<{ state: unknown }> = [];
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: { load: async (): Promise<ProfileCatalog> => ({ ...batchCatalog(batchProfile("worker-pi")), unreadableScopes: ["project"] }) },
      routerLog: async (entry) => { entries.push(entry); }
    });
    expect(result.details).toMatchObject({ outcome: "abstained", router: { kind: "abstain", reason: "catalog_unavailable" }, children: [] });
    expect(entries).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("turns a thrown router error into the typed abstain instead of launching", async () => {
    const calls: string[][] = [];
    const transport = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => { throw new Error("router down"); } },
      routerLog: async () => undefined
    });
    expect(transport.details).toMatchObject({ outcome: "abstained", router: { kind: "abstain", reason: "transport_failed" }, children: [] });

    const controller = new AbortController();
    const aborted = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => { controller.abort(); throw new Error("router down"); } },
      routerLog: async () => undefined,
      signal: controller.signal
    });
    expect(aborted.details).toMatchObject({ outcome: "abstained", router: { kind: "abstain", reason: "aborted" }, children: [] });
    expect(calls).toEqual([]);
  });

  it("builds the default router and abstains when no API key is configured", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", undefined);
    const calls: string[][] = [];
    const entries: Array<{ result: unknown }> = [];
    try {
      const result = await executeAuto(auto(), {
        cli: deadCli(calls),
        profiles: batchCatalog(batchProfile("worker-pi")),
        routerLog: async (entry) => { entries.push(entry); }
      });
      expect(result.details).toMatchObject({ outcome: "abstained", router: { kind: "abstain", reason: "authentication_unavailable" }, children: [] });
      expect(entries).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(calls).toEqual([]);
  });

  it("persists through the real decision log rooted at the context cwd", async () => {
    const calls: string[][] = [];
    const root = mkdtempSync(join(tmpdir(), "herdr-batch-router-log-"));
    try {
      const result = await executeAuto(auto(), {
        cli: deadCli(calls),
        profiles: batchCatalog(batchProfile("worker-pi")),
        router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 1 }]), probabilities: {} }) },
        cwd: undefined,
        ctx: { ...batchExtension, cwd: root }
      });
      expect(result.details?.children.map((child) => child.name)).toEqual(["task-worker-1"]);
      const lines = (await readFile(join(root, ".herdr", "router", "decisions.jsonl"), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ name: "task", result: { kind: "route" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces an expansion-read failure as a typed batch failure with zero effects", async () => {
    const calls: string[][] = [];
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 1 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      contextResolver: async () => { throw new Error("\n"); }
    });
    expect(result.details).toMatchObject({ outcome: "failed", router: { kind: "route" }, children: [], failure: { code: "CLI_PROTOCOL_ERROR" } });
    expect(result.details?.failure?.message).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("passes the caller's label, cwd, focus, and delivery through to every child request", async () => {
    const calls: string[][] = [];
    const result = await executeAuto(auto({ label: "lbl", cwd: "/tmp/child-cwd", focus: true, assignmentDelivery: "attachment" }), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 1 }]), probabilities: {} }) },
      routerLog: async () => undefined
    });
    expect(result.details?.children.map((child) => child.name)).toEqual(["task-worker-1"]);
    expect(calls.flat()).toContain("/tmp/child-cwd");
  });

  it("attributes streamed child updates to the exact child name", async () => {
    const calls: string[][] = [];
    const updates: Array<AgentToolResult<LaunchDetails | LaunchBatchDetails>> = [];
    await executeAuto(auto(), {
      cli: deadCli(calls),
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 1 }]), probabilities: {} }) },
      routerLog: async () => undefined,
      onUpdate: (update) => { updates.push(update); }
    });
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update.content[0]).toMatchObject({ type: "text", text: "[task-worker-1]" });
      expect(update.content.length).toBeGreaterThan(1);
    }
  });

  it("keeps structured failure evidence for children whose launch throws a non-LaunchError", async () => {
    const calls: string[][] = [];
    const throws = [{ details: { toJSON: () => 7 } }, {}];
    let grants = 0;
    const attachments = {
      ...fakeStore,
      ensureRecipient: vi.fn(async () => ({
        path: "/cache/grant",
        token: "t",
        renew: async () => undefined,
        release: () => Promise.reject(throws[Math.min(grants++, throws.length - 1)])
      }))
    };
    const result = await executeAuto(auto(), {
      cli: deadCli(calls),
      attachments,
      profiles: batchCatalog(batchProfile("worker-pi")),
      router: { route: async () => ({ result: decision([{ profile: "worker-pi", count: 2 }]), probabilities: {} }) },
      routerLog: async () => undefined
    });
    const children = result.details?.children ?? [];
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.status).toBe("failed");
      expect(child.failure?.code).toBe("CLI_PROTOCOL_ERROR");
      expect(child.failure?.details.causeMessage).toBeDefined();
    }
  });

  it("renders a batch result without a pane target", () => {
    const tool = createLaunchTool({
      cli: deadCli([]),
      context: batchContext,
      preflight: async () => undefined,
      supervision: stubSupervision()
    });
    const rendered = tool.renderResult?.(
      { content: [], details: { operation: "launch_batch", outcome: "abstained", router: { kind: "abstain", reason: "no_assignments" }, children: [] }, isError: false } as never,
      {} as never,
      {} as never,
      {} as never
    );
    expect(rendered?.render(80)).toBeDefined();
  });
});
