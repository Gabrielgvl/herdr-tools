// Probe 2b: reworded quality questions — account for skills carrying methodology.
// Tests whether rewording rescues 'good' spec scores without rescuing 'lazy'.
import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY, defaultModel: "jev-latest", logLevel: "off" });

const Q = {
  instructions_adequate: noul(
    "Are these instructions sufficient for a competent agent to begin this work correctly? Detailed methodology may arrive via separately selected skills — judge only whether the instructions state the agent's job and conduct clearly enough to start.",
    {
      true: "The instructions state the job and expected conduct clearly enough to begin correctly.",
      false: "The instructions are too vague or missing for the agent to know what job it has or how to behave.",
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

const SPECS = [
  { id: "lazy", spec: { label: "worker", instructions: "do the thing", assignment: { objective: "fix stuff", scope: "the code", verification: "it works" } } },
  { id: "mediocre", spec: { label: "worker", instructions: "You are a worker. Implement the task.", assignment: { objective: "Fix the router abstain bug", scope: "src/router.ts", verification: "tests pass" } } },
  { id: "good", spec: { label: "worker", instructions: "You implement scoped repository changes as the single writer. Preserve strict contracts and report changed paths with verification evidence.", assignment: { objective: "Fix the abstain-handling bug in the router", scope: "src/router.ts and test/unit/router.test.ts; minimal correct change", verification: "A new unit test fails before the fix and passes after; the full unit suite is green" } } },
];

for (const s of SPECS) {
  const res = await client.systemOne({ state: { spec: s.spec }, questions: Q });
  const ic = res.answers.instructions_adequate?.noul;
  const av = res.answers.assignment_verifiable?.noul;
  console.log(`  ${s.id.padEnd(9)} instructions_adequate=${ic?.toFixed(2)}  assignment_verifiable=${av?.toFixed(2)}`);
}
