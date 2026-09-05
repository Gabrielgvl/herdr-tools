import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSkillBundles, SKILL_BUNDLE_REGISTRY_FILE } from "../src/profiles/skill-bundles.js";

// Build/install-time materialization of the package-owned generated skill
// bundles declared in <package root>/herdr-skill-bundles.json. Launch never
// generates or repairs; it only validates.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const generations = await generateSkillBundles(packageRoot, "bundled");
  if (generations.length === 0) {
    console.log(`no generated skill bundles registered in ${SKILL_BUNDLE_REGISTRY_FILE}`);
  } else {
    const repinned = generations.filter((generation) => generation.repinnedFrom !== undefined);
    console.log(`generated ${generations.length} skill bundle(s) from ${new Set(generations.map((generation) => generation.physicalSource)).size} canonical source tree(s)`);
    for (const generation of generations) console.log(`  ${relative(packageRoot, generation.target)} <- ${generation.physicalSource}`);
    // A moved pin is a visible change to a tracked file, never a silent one.
    if (repinned.length > 0) console.log(`repinned ${repinned.length} bundle(s) in ${SKILL_BUNDLE_REGISTRY_FILE}:\n${repinned.map((generation) => `  ${relative(packageRoot, generation.target)} ${generation.repinnedFrom} -> ${generation.treeHash}`).join("\n")}`);
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
