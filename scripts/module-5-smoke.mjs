import "dotenv/config";

// Module 5 smoke validates orchestration layer response generation.
process.env.ARCHESTRA_EXTRACTIVE_MODE = "1";

const extractiveMode =
  (process.env.ARCHESTRA_EXTRACTIVE_MODE ?? "0").toLowerCase() === "1" ||
  (process.env.ARCHESTRA_EXTRACTIVE_MODE ?? "0").toLowerCase() === "true";
const provider = (process.env.ARCHESTRA_PROVIDER ?? "openai").toLowerCase();
const hasKey = provider === "gemini"
  ? Boolean(process.env.ARCHESTRA_GEMINI_API_KEY || process.env.GEMINI_API_KEY)
  : Boolean(process.env.ARCHESTRA_API_KEY || process.env.OPENAI_API_KEY);

if (!extractiveMode && !hasKey) {
  // Skip only when remote generation is required and no provider key is configured.
  console.log(
    "Module 5 Smoke Test skipped: missing API key for provider " + provider
  );
  process.exit(0);
}

try {
  const { generateArchestraAnswer } = await import("../dist/model-orchestration/archestra-orchestrator.js");

  // Keep prompt/context deterministic to make pass/fail reliable.
  const answer = await generateArchestraAnswer({
    systemContext: "[1] User likes to drink Black Coffee.",
    userQuery: "What coffee do I like?",
    redactionCount: 0,
    riskLevel: "LOW",
  });

  console.log("Module 5 Smoke Test");
  console.log(`Answer: ${answer}`);

  if (!answer) {
    process.exitCode = 1;
  }
} catch (error) {
  process.exitCode = 1;
  console.error("Module 5 Smoke Test failed.");
  console.error(error instanceof Error ? error.message : error);
}
