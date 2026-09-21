// Probe 2: validate (a) spec-quality gate discrimination, (b) composition check.
// A: does Jev separate lazy/mediocre/good specs on clarity + verifiability?
// B: does a "coverage sufficient" noul flag worker-only on a task needing
//    independent verification, while passing a worker+reviewer team?
// Usage: node scripts/jev-spec-gate-probe.mjs
import { TypeSafeClient, noul, choice } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY, defaultModel: "jev-latest", logLevel: "off" });

const QUALITY = {
  instructions_clear: noul(
    "Could a competent agent execute these instructions without guessing at the discipline, method, or conduct expected of it?",
    {
      true: "The instructions are clear enough to act on without inventing expectations.",
      false: "The instructions are vague, missing, or force the agent to guess the expected discipline.",
    },
  ),
  assignment_verifiable: noul(
    "Does assignment.verification name concrete, checkable evidence a supervisor could verify without re-doing the work?",
    {
      true: "Verification specifies concrete, falsifiable evidence (tests, outputs, diffs, artifacts).",
      false: "Verification is vague ('it works'), absent, or requires re-doing the work to check.",
    },
  ),
};

const QUALITY_SPECS = [
  {
    id: "lazy",
    spec: { label: "worker", instructions: "do the thing", assignment: { objective: "fix stuff", scope: "the code", verification: "it works" } },
  },
  {
    id: "mediocre",
    spec: { label: "worker", instructions: "You are a worker. Implement the task.", assignment: { objective: "Fix the router abstain bug", scope: "src/router.ts", verification: "tests pass" } },
  },
  {
    id: "good",
    spec: {
      label: "worker",
      instructions:
        "You implement scoped repository changes as the single writer. Preserve strict contracts, apply the project's lazy-senior conventions, and report changed paths with verification evidence. Do not delegate hidden work.",
      assignment: {
        objective: "Fix the abstain-handling bug in the router",
        scope: "src/router.ts and test/unit/router.test.ts; minimal correct change; no refactors",
        verification: "A new unit test fails before the fix and passes after; the full unit suite is green",
      },
    },
  },
];

const COVERAGE = {
  coverage_sufficient: noul(
    "Is the submitted agent set sufficient to cover this assignment — or is a distinct contribution missing that no listed agent provides?",
    {
      true: "The listed agents cover the work; adding another agent would duplicate, not complement.",
      false: "A distinct contribution is missing — e.g., independent verification of one's own work, research before implementation, or coordination across agents.",
    },
  ),
  missing_area: choice(
    "If the agent set is insufficient, what kind of contribution is missing?",
    {
      none: { description: "Nothing is missing; the set is sufficient" },
      implementation: { description: "An agent to perform the primary change/work" },
      independent_verification: { description: "An agent to verify or review work it did not perform" },
      research: { description: "An agent to gather evidence or explore before the work" },
      coordination: { description: "An agent to orchestrate, monitor, or integrate the others' work" },
    },
  ),
};

const TEAMS = [
  {
    id: "worker-only-on-verify-task",
    assignment: { objective: "Implement the profile format migration and independently verify it", scope: "src/profiles/", verification: "migration tests green AND an independent review confirms no contract drift" },
    specs: [{ label: "worker", instructions: "implement the migration" }],
  },
  {
    id: "worker+reviewer-on-verify-task",
    assignment: { objective: "Implement the profile format migration and independently verify it", scope: "src/profiles/", verification: "migration tests green AND an independent review confirms no contract drift" },
    specs: [
      { label: "worker", instructions: "implement the migration" },
      { label: "reviewer", instructions: "independently review the migrated code for contract drift; never edit" },
    ],
  },
  {
    id: "simple-docs-single-worker",
    assignment: { objective: "Fix the typo in the README install section", scope: "README.md only", verification: "the typo is gone" },
    specs: [{ label: "worker", instructions: "fix the typo" }],
  },
  {
    id: "research-task-wrong-agent",
    assignment: { objective: "Map every caller of resolveProfile and report the call graph", scope: "read-only; no modifications", verification: "a complete caller list with file:line" },
    specs: [{ label: "worker", instructions: "implement the change described" }],
  },
];

console.log("=== A: spec-quality discrimination ===");
for (const q of QUALITY_SPECS) {
  const res = await client.systemOne({ state: { spec: q.spec }, questions: QUALITY });
  const ic = res.answers.instructions_clear?.noul;
  const av = res.answers.assignment_verifiable?.noul;
  console.log(`  ${q.id.padEnd(9)} instructions_clear=${ic?.toFixed(2)}  assignment_verifiable=${av?.toFixed(2)}`);
}

console.log("\n=== B: composition check ===");
for (const t of TEAMS) {
  const res = await client.systemOne({ state: { assignment: t.assignment, specs: t.specs }, questions: COVERAGE });
  const cov = res.answers.coverage_sufficient?.noul;
  const miss = res.answers.missing_area;
  console.log(`  ${t.id.padEnd(32)} sufficient=${cov?.toFixed(2)}  missing=${miss?.choice} (conf ${miss?.confidence?.toFixed(2)})`);
}
