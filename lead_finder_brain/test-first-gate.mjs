import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadLocalEnv, verifyPlantCandidate, verifyPlantCandidateHeuristic } from "./plant-verifier.mjs";
import { verifierFixtures } from "./test-fixtures.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const outputDir = path.resolve(import.meta.dirname, "test-output");
const useHeuristic = process.argv.includes("--heuristic");
const onlyIndex = process.argv.indexOf("--only");
const onlyId = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : "";

await loadLocalEnv({ cwd: rootDir });
await mkdir(outputDir, { recursive: true });

const model = process.env.PLANT_VERIFIER_MODEL || "gpt-5-mini";
const fixtures = onlyId
  ? verifierFixtures.filter((fixture) => fixture.id === onlyId)
  : verifierFixtures;
if (onlyId && !fixtures.length) {
  console.error(`No fixture found for --only ${onlyId}`);
  process.exit(1);
}

const results = [];

for (const fixture of fixtures) {
  const started = Date.now();
  try {
    const result = useHeuristic
      ? verifyPlantCandidateHeuristic(fixture.candidate)
      : await verifyPlantCandidate(fixture.candidate, { model });
    const passed = result.qualified === fixture.expectedQualified;
    results.push({
      id: fixture.id,
      expectedQualified: fixture.expectedQualified,
      actualQualified: result.qualified,
      passed,
      elapsedMs: Date.now() - started,
      reject_reason: result.reject_reason,
      confidence: result.confidence,
      result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      id: fixture.id,
      expectedQualified: fixture.expectedQualified,
      actualQualified: null,
      passed: false,
      elapsedMs: Date.now() - started,
      error: message
    });

    if (/insufficient_quota|quota|429/i.test(message)) {
      console.error("Stopping after quota/API limit error. Fix the key/billing or use --heuristic for local shape testing.");
      break;
    }
  }
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = path.join(outputDir, `first-gate-results-${timestamp}.json`);
await writeFile(outputPath, JSON.stringify({ mode: useHeuristic ? "heuristic" : "api", model, results }, null, 2) + "\n", "utf8");

console.log(`Mode: ${useHeuristic ? "heuristic" : "api"}`);
console.log(`Model: ${model}`);
console.log(`Results: ${outputPath}`);
console.table(results.map((entry) => ({
  id: entry.id,
  expected: entry.expectedQualified,
  actual: entry.actualQualified,
  passed: entry.passed,
  confidence: entry.confidence || "",
  reason: entry.reject_reason || entry.error || ""
})));

const failed = results.filter((entry) => !entry.passed);
if (failed.length) {
  console.error(`${failed.length} fixture(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("All first-gate fixtures passed.");
}
