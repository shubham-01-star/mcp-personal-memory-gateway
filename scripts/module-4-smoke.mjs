import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";

// Module 4 smoke validates file ingestion into vector memory.
process.env.LANCE_DB_PATH = "data/lancedb-test";
process.env.LANCE_TABLE_NAME = "memory_module4_test";

const ingestDir = "data/ingest-test";

await mkdir(ingestDir, { recursive: true });

const sample = "My number is 9876543210 and I like black coffee.";
const samplePath = `${ingestDir}/sample.txt`;

// Write one file, ingest it, then verify searchable content appears in memory.
await writeFile(samplePath, sample, "utf-8");

try {
  const { ingestFile } = await import("../dist/ingestion/file-ingestion-worker.js");
  const { searchMemory } = await import("../dist/memory/memory-repository.js");

  const chunks = await ingestFile(samplePath, 1000);
  const results = await searchMemory("number", 3);
  const match = results.some((text) => text.includes("9876543210"));

  console.log("Module 4 Smoke Test");
  console.log(`Chunks ingested: ${chunks}`);
  console.log(`Results: ${results.length}`);
  console.log(`Match found: ${match}`);

  if (!match) {
    process.exitCode = 1;
  }
} catch (error) {
  process.exitCode = 1;
  console.error("Module 4 Smoke Test failed.");
  console.error(error instanceof Error ? error.message : error);
}
