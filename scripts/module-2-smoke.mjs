import { runPrivacyPipeline } from "../dist/privacy/privacy-redaction-pipeline.js";

// Module 2 smoke validates base redaction and risk scoring behavior.
const input = "My number is 9876543210.";
const result = runPrivacyPipeline(input);

const expectedText = "My number is [REDACTED_PHONE].";
const textOk = result.cleanedText === expectedText;
const riskOk = result.riskLevel === "LOW";

console.log("Module 2 Smoke Test");
console.log(`Input: ${input}`);
console.log(`Cleaned: ${result.cleanedText}`);
console.log(`Redactions: ${result.redactionCount}`);
console.log(`Risk: ${result.riskLevel}`);
console.log(`Text match: ${textOk}`);
console.log(`Risk match: ${riskOk}`);

if (!textOk || !riskOk) {
  process.exitCode = 1;
}
