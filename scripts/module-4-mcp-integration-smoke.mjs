import { mkdir, writeFile } from "node:fs/promises";

// Module 4 MCP smoke validates ingest -> memory -> MCP redaction response path.
const runId = Date.now();
process.env.LANCE_DB_PATH = `data/lancedb-test-${runId}`;
process.env.LANCE_TABLE_NAME = `memory_module4_mcp_test_${runId}`;
process.env.ARCHESTRA_ENABLE = "0";
process.env.ARCHESTRA_EXTRACTIVE_MODE = "0";

const watchDir = "my_data";
const samplePath = `${watchDir}/integration-sample.txt`;
const sampleText =
  "My number is 9876543210 and project budget is $100,000.";

// Seed watch directory with one mixed-sensitive sample.
await mkdir(watchDir, { recursive: true });
await writeFile(samplePath, sampleText, "utf-8");

try {
  const { ingestFile } = await import("../dist/ingestion/file-ingestion-worker.js");
  const { searchMemory } = await import("../dist/memory/memory-repository.js");
  const { createServer } = await import("../dist/model-context-protocol/personal-memory-server.js");
  const { Client } = await import(
    "@modelcontextprotocol/sdk/client/index.js"
  );
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );

  await ingestFile(samplePath, 1000);
  const rawResults = await searchMemory(sampleText, 3);
  console.log(`Memory results pre-MCP: ${rawResults.length}`);

  // Query through MCP server contract and validate redaction placeholders.
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "module-4-mcp-smoke", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "query_personal_memory",
    arguments: { topic: sampleText },
  });

  const textItem = result.content?.find((item) => item.type === "text");
  const text = textItem?.text ?? "";

  const hasSanitized = text.includes("SANITIZED_CONTEXT:");
  const hasPhone = text.includes("[REDACTED_PHONE]");
  const hasAmount = text.includes("[REDACTED_FINANCIAL_AMOUNT]");
  const notNoContext = text.trim() !== "NO_CONTEXT";

  console.log("Module 4 MCP Integration Smoke Test");
  console.log(`Sanitized: ${hasSanitized}`);
  console.log(`Phone redacted: ${hasPhone}`);
  console.log(`Amount redacted: ${hasAmount}`);
  console.log(`NO_CONTEXT: ${!notNoContext}`);
  console.log(`Response: ${text}`);

  if (!hasSanitized || !hasPhone || !hasAmount || !notNoContext) {
    process.exitCode = 1;
  }

  await client.close();
  await server.close();
} catch (error) {
  process.exitCode = 1;
  console.error("Module 4 MCP Integration Smoke Test failed.");
  console.error(error instanceof Error ? error.message : error);
}
