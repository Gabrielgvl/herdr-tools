import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverProfiles, type Profile, type ProfileCatalog, type RuntimeProfile } from "../../src/profiles/index.js";
import {
  ROUTER_CONFIDENCE_THRESHOLD,
  assembleRouteDecision,
  groupByRole,
  loadRouterCatalog,
  projectRouterCatalog,
  roleForProfile,
  type RoleJudgment,
  type RouteDecision,
  type RouterResult,
} from "../../src/router.js";

const RUNTIMES: Record<"pi" | "claude" | "agy" | "devin", RuntimeProfile> = {
  pi: { kind: "pi", model: "pi-model", thinking: "low", tools: ["read", "write"], extensions: ["./ext.ts"], skills: ["./skill"] },
  claude: { kind: "claude", model: "claude-model", effort: "medium", permissionMode: "default", allowedTools: ["Read"], disallowedTools: ["Task"], addDirs: [], pluginDirs: [], developmentChannels: [] },
  agy: { kind: "agy", model: "agy-model", mode: "plan", addDirs: [] },
  devin: { kind: "devin", model: "devin-model", permissionMode: "normal" }
};

function profile(name: string, kind: keyof typeof RUNTIMES = "pi", description = `Description of ${name}`): Profile {
  return {
    name,
    description,
    timeoutMinutes: 30,
    sessionPersistence: false,
    runtime: { ...RUNTIMES[kind] },
    fallbackProfiles: [`${name}-fallback`],
    body: `secret body for ${name}`,
    source: { kind: "bundled", path: `/catalog/${name}.md`, scopeRoot: "/catalog", precedence: 0 }
  };
}

function catalogOf(profiles: Profile[], extra: Partial<ProfileCatalog> = {}): ProfileCatalog {
  return {
    effective: new Map(profiles.map((item) => [item.name, item])),
    candidates: [],
    diagnostics: [],
    ...extra
  };
}

function judgment(overrides: Partial<RoleJudgment> = {}): RoleJudgment {
  return {
    role: "worker",
    candidates: ["worker-agy", "worker-claude", "worker-devin", "worker-pi"],
    noul: 0.9,
    score: { value: 2, confidence: 0.9 },
    choice: { profile: "worker-pi", confidence: 0.9 },
    ...overrides
  };
}

function roleJudgment(role: string, candidates: readonly string[], overrides: Partial<RoleJudgment> = {}): RoleJudgment {
  return { role, candidates, noul: 0.9, score: { value: 0, confidence: 0.9 }, choice: { profile: candidates[0]!, confidence: 0.9 }, ...overrides };
}

function route(assignments: Array<{ role: string; profile: string; count: number }>): RouteDecision {
  return {
    kind: "route",
    assignments: assignments.map(({ role, profile: profileName, count }) => ({ profile: profileName, count, purpose: `Perform the ${role} role for the supplied objective.` }))
  };
}

const abstain = (reason: string, component?: string): RouterResult => ({ kind: "abstain", reason, ...(component === undefined ? {} : { component }) }) as RouterResult;

describe("roleForProfile", () => {
  it("derives the role from the segment before the first dash without an allowlist", () => {
    expect(roleForProfile("worker-pi")).toBe("worker");
    expect(roleForProfile("scout-agy")).toBe("scout");
    expect(roleForProfile("manager-claude")).toBe("manager");
    expect(roleForProfile("custom-ops-devin")).toBe("custom");
    expect(roleForProfile("solo")).toBe("solo");
  });
});

describe("catalog projection", () => {
  it("projects exactly the five allowlisted fields and no sensitive or tool fields", () => {
    const catalog = catalogOf([profile("worker-pi"), profile("worker-agy", "agy")]);
    const entries = projectRouterCatalog(catalog);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["description", "model", "name", "runner", "timeout"]);
      const serialized = JSON.stringify(entry);
      for (const leaked of ["body", "tools", "extensions", "skills", "allowedTools", "disallowedTools", "addDirs", "pluginDirs", "fallbackProfiles", "sessionPersistence", "source", "permissionMode", "thinking", "effort", "mode"]) {
        expect(serialized).not.toContain(`"${leaked}"`);
      }
      expect(serialized).not.toContain("secret body");
      expect(serialized).not.toContain("/catalog/");
    }
    expect(entries.find((entry) => entry.name === "worker-pi")).toEqual({ name: "worker-pi", description: "Description of worker-pi", runner: "pi", model: "pi-model", timeout: 30 });
    expect(entries.find((entry) => entry.name === "worker-agy")).toEqual({ name: "worker-agy", description: "Description of worker-agy", runner: "agy", model: "agy-model", timeout: 30 });
  });

  it("preserves the actual runtime kind and model rather than inferring them from the name", () => {
    const entries = projectRouterCatalog(catalogOf([profile("worker-pi", "devin")]));
    expect(entries[0]).toMatchObject({ name: "worker-pi", runner: "devin", model: "devin-model" });
  });

  it("sorts by exact name independently of map insertion order", () => {
    const names = ["worker-pi", "manager-devin", "scout-agy", "planner-claude", "worker-agy", "manager-claude"];
    const forward = catalogOf(names.map((name) => profile(name)));
    const reversed = catalogOf([...names].reverse().map((name) => profile(name)));
    const shuffled = catalogOf(["scout-agy", "worker-pi", "manager-claude", "worker-agy", "planner-claude", "manager-devin"].map((name) => profile(name)));
    const expectedOrder = ["manager-claude", "manager-devin", "planner-claude", "scout-agy", "worker-agy", "worker-pi"];
    for (const catalog of [forward, reversed, shuffled]) {
      expect(projectRouterCatalog(catalog).map((entry) => entry.name)).toEqual(expectedOrder);
    }
  });

  it("groups projected entries locally by derived role while the projection stays flat", () => {
    const entries = projectRouterCatalog(catalogOf([profile("worker-pi"), profile("worker-agy", "agy"), profile("scout-pi"), profile("solo")]));
    expect(entries.map((entry) => entry.name)).toEqual(["scout-pi", "solo", "worker-agy", "worker-pi"]);
    const groups = groupByRole(entries);
    expect([...groups.keys()]).toEqual(["scout", "solo", "worker"]);
    expect(groups.get("worker")!.map((entry) => entry.name)).toEqual(["worker-agy", "worker-pi"]);
    expect(groups.get("solo")!.map((entry) => entry.name)).toEqual(["solo"]);
  });

  it("projects all 24 bundled entries including AGY and privileged roles", async () => {
    const root = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
    const catalog = await discoverProfiles({ bundledDir: join(root, "herdr-profiles"), bundledScopeRoot: root, userDir: join(root, ".missing-user"), projectDir: join(root, ".missing-project") });
    const entries = projectRouterCatalog(catalog);
    expect(entries).toHaveLength(24);
    expect(entries.map((entry) => entry.name)).toEqual([...entries.map((entry) => entry.name)].sort());
    const groups = groupByRole(entries);
    expect([...groups.keys()].sort()).toEqual(["manager", "planner", "promoter", "researcher", "reviewer", "scout", "worker"]);
    // No runner is invented for a role that does not ship one: the orchestrator
    // roles have exactly their bundled claude/devin/pi candidates, no AGY.
    for (const role of ["manager", "planner", "promoter"] as const) {
      expect(groups.get(role)!.map((entry) => entry.name)).toEqual([`${role}-claude`, `${role}-devin`, `${role}-pi`]);
    }
    for (const role of ["researcher", "scout", "worker"] as const) {
      expect(groups.get(role)!.map((entry) => entry.name)).toEqual([`${role}-agy`, `${role}-claude`, `${role}-devin`, `${role}-pi`]);
    }
    expect(groups.get("reviewer")!.map((entry) => entry.name)).toEqual(["reviewer-claude", "reviewer-devin", "reviewer-pi"]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["description", "model", "name", "runner", "timeout"]);
      expect(typeof entry.description).toBe("string");
      expect(typeof entry.runner).toBe("string");
      expect(typeof entry.model).toBe("string");
      expect(typeof entry.timeout).toBe("number");
    }
    const agyRunners = entries.filter((entry) => entry.runner === "agy").map((entry) => entry.name).sort();
    expect(agyRunners).toEqual(["researcher-agy", "scout-agy", "worker-agy"]);
  });

  it("keeps custom effective profiles and roles without an allowlist", () => {
    const entries = projectRouterCatalog(catalogOf([profile("ninja-pi"), profile("worker-pi"), profile("solo", "claude")]));
    expect(entries.map((entry) => entry.name)).toEqual(["ninja-pi", "solo", "worker-pi"]);
    const groups = groupByRole(entries);
    expect(groups.get("ninja")).toHaveLength(1);
    expect(groups.get("solo")).toHaveLength(1);
  });

  it("excludes blocked names instead of inventing alternatives", () => {
    const catalog = catalogOf([profile("scout-pi")], { blocked: new Set(["worker-pi"]) });
    const entries = projectRouterCatalog(catalog);
    expect(entries.map((entry) => entry.name)).toEqual(["scout-pi"]);
  });
});

describe("loadRouterCatalog", () => {
  const profiles = (catalog: ProfileCatalog) => ({ load: async () => catalog });

  it("returns the projected catalog once per decision", async () => {
    let loads = 0;
    const result = await loadRouterCatalog({ load: async () => (loads += 1, catalogOf([profile("worker-pi")])) });
    expect(loads).toBe(1);
    expect(result).toEqual([{ name: "worker-pi", description: "Description of worker-pi", runner: "pi", model: "pi-model", timeout: 30 }]);
  });

  it("yields catalog_unavailable when the loader is missing, throws, or the catalog is unreadable", async () => {
    await expect(loadRouterCatalog(undefined)).resolves.toEqual({ kind: "abstain", reason: "catalog_unavailable", component: "catalog" });
    await expect(loadRouterCatalog({ load: async () => { throw new Error("discovery failed"); } })).resolves.toEqual({ kind: "abstain", reason: "catalog_unavailable", component: "catalog" });
    const unreadable = catalogOf([profile("worker-pi")], { unreadableScopes: ["project"] });
    await expect(loadRouterCatalog(profiles(unreadable))).resolves.toEqual({ kind: "abstain", reason: "catalog_unavailable", component: "catalog" });
  });

  it("does not invent entries for a blocked or empty effective catalog", async () => {
    const blocked = catalogOf([profile("scout-pi")], { blocked: new Set(["worker-pi"]) });
    await expect(loadRouterCatalog(profiles(blocked))).resolves.toEqual([{ name: "scout-pi", description: "Description of scout-pi", runner: "pi", model: "pi-model", timeout: 30 }]);
    await expect(loadRouterCatalog(profiles(catalogOf([])))).resolves.toEqual([]);
  });
});

describe("deterministic assembly policy", () => {
  const cases: Array<{ name: string; judgments: RoleJudgment[]; expected: RouterResult }> = [
    {
      name: "accepts a noul probability of 0.8 as a confident yes",
      judgments: [judgment({ noul: 0.8 })],
      expected: route([{ role: "worker", profile: "worker-pi", count: 3 }])
    },
    {
      name: "accepts a noul probability of 0.2 as a confident no and abstains with no_assignments",
      judgments: [judgment({ noul: 0.2 })],
      expected: { kind: "abstain", reason: "no_assignments" }
    },
    {
      name: "abstains on a noul probability of 0.5 because confidence 0.5 is below threshold",
      judgments: [judgment({ noul: 0.5 })],
      expected: abstain("low_confidence", "worker_useful")
    },
    {
      name: "abstains on noul probabilities of 0.21 and 0.79 below the binary confidence gate",
      judgments: [judgment({ noul: 0.79 })],
      expected: abstain("low_confidence", "worker_useful")
    },
    {
      name: "abstains on a noul probability of 0.21 below the binary confidence gate",
      judgments: [judgment({ noul: 0.21 })],
      expected: abstain("low_confidence", "worker_useful")
    },
    {
      name: "rejects a non-finite noul probability as invalid_response",
      judgments: [judgment({ noul: Number.NaN })],
      expected: abstain("invalid_response", "worker_useful")
    },
    {
      name: "rejects an out-of-range noul probability as invalid_response",
      judgments: [judgment({ noul: 1.2 })],
      expected: abstain("invalid_response", "worker_useful")
    },
    {
      name: "accepts a score confidence of exactly 0.8",
      judgments: [judgment({ score: { value: 0, confidence: 0.8 } })],
      expected: route([{ role: "worker", profile: "worker-pi", count: 1 }])
    },
    {
      name: "abstains on a score confidence of 0.799 below threshold",
      judgments: [judgment({ score: { value: 0, confidence: 0.799 } })],
      expected: abstain("low_confidence", "worker_count")
    },
    {
      name: "accepts a selected choice confidence of exactly 0.8",
      judgments: [judgment({ choice: { profile: "worker-pi", confidence: 0.8 } })],
      expected: route([{ role: "worker", profile: "worker-pi", count: 3 }])
    },
    {
      name: "abstains on a selected choice confidence of 0.799 below threshold",
      judgments: [judgment({ choice: { profile: "worker-pi", confidence: 0.799 } })],
      expected: abstain("low_confidence", "worker_profile")
    },
    {
      name: "ignores a low-confidence choice for a role answered no",
      judgments: [
        roleJudgment("scout", ["scout-pi"], { noul: 0.2, score: { value: 4, confidence: 0.9 }, choice: { profile: "scout-pi", confidence: 0.1 } }),
        judgment()
      ],
      expected: route([{ role: "worker", profile: "worker-pi", count: 3 }])
    },
    {
      name: "ignores an absent choice for a role answered no",
      judgments: [
        roleJudgment("scout", ["scout-pi"], { noul: 0.2, choice: undefined }),
        judgment()
      ],
      expected: route([{ role: "worker", profile: "worker-pi", count: 3 }])
    },
    {
      name: "ignores unusable choice content for a role answered no",
      judgments: [
        roleJudgment("scout", ["scout-pi"], { noul: 0.2, choice: { profile: "foreign-profile", confidence: Number.NaN } }),
        judgment()
      ],
      expected: route([{ role: "worker", profile: "worker-pi", count: 3 }])
    },
    {
      name: "abstains on a low-confidence score even for a role answered no",
      judgments: [
        roleJudgment("scout", ["scout-pi"], { noul: 0.2, score: { value: 4, confidence: 0.5 } }),
        judgment()
      ],
      expected: abstain("low_confidence", "scout_count")
    },
    {
      name: "routes mixed roles into one assignment per selected role",
      judgments: [
        judgment(),
        roleJudgment("scout", ["scout-agy", "scout-pi"], { choice: { profile: "scout-agy", confidence: 0.95 } })
      ],
      expected: route([{ role: "scout", profile: "scout-agy", count: 1 }, { role: "worker", profile: "worker-pi", count: 3 }])
    },
    {
      name: "maps a raw score of 0 to a count of 1",
      judgments: [judgment({ score: { value: 0, confidence: 0.9 } })],
      expected: route([{ role: "worker", profile: "worker-pi", count: 1 }])
    },
    {
      name: "maps a raw score of 4 to a count of 5",
      judgments: [judgment({ score: { value: 4, confidence: 0.9 } })],
      expected: route([{ role: "worker", profile: "worker-pi", count: 5 }])
    },
    {
      name: "rounds fractional raw scores to the nearest level with halves up",
      judgments: [
        roleJudgment("scout", ["scout-pi"], { score: { value: 2.5, confidence: 0.9 } }),
        roleJudgment("worker", ["worker-pi"], { score: { value: 0.5, confidence: 0.9 } })
      ],
      expected: route([{ role: "scout", profile: "scout-pi", count: 4 }, { role: "worker", profile: "worker-pi", count: 2 }])
    },
    {
      name: "rounds a fractional raw score below the half down to the nearer level",
      judgments: [judgment({ score: { value: 2.49, confidence: 0.9 } })],
      expected: route([{ role: "worker", profile: "worker-pi", count: 3 }])
    },
    {
      name: "abstains with no_assignments when every role confidently answers no",
      judgments: [
        roleJudgment("scout", ["scout-pi"], { noul: 0.1 }),
        judgment({ noul: 0.2 })
      ],
      expected: { kind: "abstain", reason: "no_assignments" }
    },
    {
      name: "rejects a choice outside the role's exact projected candidate list as invalid_response",
      judgments: [judgment({ choice: { profile: "worker-xyz", confidence: 0.9 } })],
      expected: abstain("invalid_response", "worker_profile")
    },
    {
      name: "rejects a missing choice for a role answered yes as invalid_response",
      judgments: [judgment({ choice: undefined })],
      expected: abstain("invalid_response", "worker_profile")
    },
    {
      name: "rejects a non-finite choice confidence for a role answered yes as invalid_response",
      judgments: [judgment({ choice: { profile: "worker-pi", confidence: Number.NaN } })],
      expected: abstain("invalid_response", "worker_profile")
    },
    {
      name: "rejects an out-of-range raw score as invalid_response rather than clamping it",
      judgments: [judgment({ score: { value: 4.1, confidence: 0.9 } })],
      expected: abstain("invalid_response", "worker_count")
    },
    {
      name: "rejects a negative raw score as invalid_response rather than clamping it",
      judgments: [judgment({ score: { value: -0.5, confidence: 0.9 } })],
      expected: abstain("invalid_response", "worker_count")
    },
    {
      name: "rejects a non-finite raw score as invalid_response",
      judgments: [judgment({ score: { value: Number.POSITIVE_INFINITY, confidence: 0.9 } })],
      expected: abstain("invalid_response", "worker_count")
    },
    {
      name: "returns no partial assignments when one gated component fails",
      judgments: [
        roleJudgment("scout", ["scout-pi"], { score: { value: 4, confidence: 0.95 } }),
        judgment({ score: { value: 2, confidence: 0.799 } })
      ],
      expected: abstain("low_confidence", "worker_count")
    },
    {
      name: "returns the whole abstain rather than a partial route when a role's noul is uncertain",
      judgments: [
        judgment(),
        roleJudgment("planner", ["planner-pi"], { noul: 0.5 })
      ],
      expected: abstain("low_confidence", "planner_useful")
    },
    {
      name: "emits all seven roles at count five without an aggregate cap",
      judgments: [
        roleJudgment("manager", ["manager-pi"], { score: { value: 4, confidence: 0.9 } }),
        roleJudgment("planner", ["planner-pi"], { score: { value: 4, confidence: 0.9 } }),
        roleJudgment("promoter", ["promoter-pi"], { score: { value: 4, confidence: 0.9 } }),
        roleJudgment("researcher", ["researcher-pi"], { score: { value: 4, confidence: 0.9 } }),
        roleJudgment("reviewer", ["reviewer-pi"], { score: { value: 4, confidence: 0.9 } }),
        roleJudgment("scout", ["scout-pi"], { score: { value: 4, confidence: 0.9 } }),
        roleJudgment("worker", ["worker-pi"], { score: { value: 4, confidence: 0.9 } })
      ],
      expected: route([
        { role: "manager", profile: "manager-pi", count: 5 },
        { role: "planner", profile: "planner-pi", count: 5 },
        { role: "promoter", profile: "promoter-pi", count: 5 },
        { role: "researcher", profile: "researcher-pi", count: 5 },
        { role: "reviewer", profile: "reviewer-pi", count: 5 },
        { role: "scout", profile: "scout-pi", count: 5 },
        { role: "worker", profile: "worker-pi", count: 5 }
      ])
    }
  ];

  for (const { name, judgments, expected } of cases) {
    it(name, () => {
      expect(assembleRouteDecision(judgments)).toEqual(expected);
    });
  }

  it("sorts assignments by role and profile ordinal regardless of judgment order", () => {
    const result = assembleRouteDecision([
      judgment(),
      roleJudgment("manager", ["manager-pi"]),
      roleJudgment("scout", ["scout-pi"])
    ]);
    expect(result).toEqual(route([
      { role: "manager", profile: "manager-pi", count: 1 },
      { role: "scout", profile: "scout-pi", count: 1 },
      { role: "worker", profile: "worker-pi", count: 3 }
    ]));
  });

  it("breaks a same-role tie by exact profile ordinal", () => {
    const result = assembleRouteDecision([
      roleJudgment("worker", ["worker-agy", "worker-pi"], { choice: { profile: "worker-pi", confidence: 0.9 } }),
      roleJudgment("worker", ["worker-agy", "worker-pi"], { choice: { profile: "worker-agy", confidence: 0.9 } })
    ]);
    expect(result).toEqual(route([
      { role: "worker", profile: "worker-agy", count: 1 },
      { role: "worker", profile: "worker-pi", count: 1 }
    ]));
  });

  it("emits the deterministic fixed-template purpose for every selected role", () => {
    const first = assembleRouteDecision([judgment()]);
    const second = assembleRouteDecision([judgment()]);
    expect(first).toEqual(second);
    expect(first).toEqual(route([{ role: "worker", profile: "worker-pi", count: 3 }]));
    if (first.kind === "route") {
      expect(first.assignments[0]!.purpose).toBe("Perform the worker role for the supplied objective.");
      expect(Object.keys(first.assignments[0]!).sort()).toEqual(["count", "profile", "purpose"]);
    } else {
      throw new Error("expected a route decision");
    }
  });

  it("does not carry a default profile or partial assignment list on abstain", () => {
    const result = assembleRouteDecision([judgment({ noul: 0.5 }), judgment()]);
    expect(result).toEqual(abstain("low_confidence", "worker_useful"));
    expect(JSON.stringify(result)).not.toContain("worker-pi");
    expect(result).not.toMatchObject({ assignments: expect.anything() });
  });
});

describe("router contract", () => {
  it("pins the whole-decision confidence threshold at 0.8", () => {
    expect(ROUTER_CONFIDENCE_THRESHOLD).toBe(0.8);
  });
});
