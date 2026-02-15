import { mkdir } from "node:fs/promises";
import process from "node:process";

// Module 2+3 smoke validates memory retrieval feeding into privacy pipeline.
process.env.LANCE_DB_PATH = "data/lancedb-test";
process.env.LANCE_TABLE_NAME = "memory_module2_3_test";

await mkdir("data", { recursive: true });

const { saveToMemory, searchMemory } = await import("../dist/memory/memory-repository.js");
const { runPrivacyPipeline } = await import("../dist/privacy/privacy-redaction-pipeline.js");

const sampleA = "My number is 9876543210.";
const sampleB = "I earn $100k.";

// Store mixed sensitive/non-sensitive samples and query for phone-related context.
await saveToMemory(sampleA);
await saveToMemory(sampleB);

const results = await searchMemory("number", 3);
const combined = results.join("\n");
const { cleanedText, redactionCount, riskLevel } = runPrivacyPipeline(combined);

const redactionOk = cleanedText.includes("[REDACTED_PHONE]");
const countOk = redactionCount >= 1;
const riskOk = ["LOW", "MEDIUM", "HIGH"].includes(riskLevel);

console.log("Module 2+3 Integration Smoke Test");
console.log(`Results: ${results.length}`);
console.log(`Cleaned: ${cleanedText}`);
console.log(`Redactions: ${redactionCount}`);
console.log(`Risk: ${riskLevel}`);
console.log(`Redaction present: ${redactionOk}`);
console.log(`Count ok: ${countOk}`);
console.log(`Risk ok: ${riskOk}`);

if (!redactionOk || !countOk || !riskOk) {
  process.exitCode = 1;
}
