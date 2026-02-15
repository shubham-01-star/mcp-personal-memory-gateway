import { mkdir } from "node:fs/promises";
import process from "node:process";

// Module 3 smoke validates embedding + vector retrieval for local memory store.
process.env.LANCE_DB_PATH = "data/lancedb-test";
process.env.LANCE_TABLE_NAME = "memory_test";
process.env.MEMORY_QUERY_SCOPE = "hybrid";
process.env.MEMORY_STRICT_QUERY_MATCH = "1";

await mkdir("data", { recursive: true });

try {
  const { saveToMemory, saveUserFact, searchMemory } = await import("../dist/memory/memory-repository.js");

  const sampleA = "I earn $100k.";
  const sampleB = "I like black coffee.";
  const userFact = "I prefer black coffee.";

  // Verify a query can retrieve the exact stored line.
  await saveToMemory(sampleA);
  await saveToMemory(sampleB);
  await saveUserFact(userFact, "preferences");

  const results = await searchMemory(sampleA, 3);
  const match = results.find((text) => text.includes(sampleA));
  const preferenceResults = await searchMemory("what are my preferences", 3);
  const preferenceMatch = preferenceResults.find((text) =>
    text.toLowerCase().includes("black coffee")
  );

  console.log("Module 3 Smoke Test");
  console.log(`Results: ${results.length}`);
  console.log(`Match found: ${Boolean(match)}`);
  console.log(`Top results: ${results.join(" | ")}`);
  console.log(`Preference query results: ${preferenceResults.join(" | ")}`);
  console.log(`Preference match found: ${Boolean(preferenceMatch)}`);

  if (!match || !preferenceMatch) {
    process.exitCode = 1;
  }
} catch (error) {
  process.exitCode = 1;
  console.error("Module 3 Smoke Test failed.");
  console.error(error instanceof Error ? error.message : error);
}
