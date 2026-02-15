import process from "node:process";
import { mkdir } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Module 1 smoke validates MCP server exposure and response contract.
const EXPECTED = "User likes to drink Black Coffee.";
const TOOL_NAME = "query_personal_memory";

const runId = Date.now();
// Isolated test storage prevents cross-run contamination.
process.env.LANCE_DB_PATH = `data/lancedb-test-module1-${runId}`;
process.env.LANCE_TABLE_NAME = `memory_module1_test_${runId}`;
process.env.ARCHESTRA_ENABLE = "0";
process.env.ARCHESTRA_EXTRACTIVE_MODE = "0";

await mkdir("data", { recursive: true });

const { createServer } = await import("../dist/model-context-protocol/personal-memory-server.js");
const { saveToMemory } = await import("../dist/memory/memory-repository.js");

// In-memory transport avoids stdio/IPC restrictions and makes tests deterministic.
const [clientTransport, serverTransport] =
  InMemoryTransport.createLinkedPair();

const server = createServer();
const client = new Client({ name: "module-1-smoke", version: "0.1.0" });

try {
  // Seed one known fact and verify MCP tool retrieval path.
  await saveToMemory(EXPECTED);

  console.log("Connecting in-memory client/server...");
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  console.log("Listing tools...");
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((tool) => tool.name);
  const hasTool = toolNames.includes(TOOL_NAME);

  console.log("Calling tool...");
  const result = await client.callTool({
    name: TOOL_NAME,
    arguments: { topic: "coffee" },
  });

  const textItem = result.content?.find((item) => item.type === "text");
  const text = textItem?.text ?? "";

  const toolOk = hasTool;
  const responseOk =
    text.includes("SANITIZED_CONTEXT:") &&
    text.includes(EXPECTED) &&
    text.includes("Redactions: 0") &&
    text.includes("Risk: LOW");

  console.log("Module 1 Smoke Test");
  console.log(`Tool present: ${toolOk}`);
  console.log(`Response match: ${responseOk}`);
  console.log(`Response text: ${text}`);

  if (!toolOk || !responseOk) {
    process.exitCode = 1;
  }
} catch (error) {
  process.exitCode = 1;
  console.error("Module 1 Smoke Test failed.");
  console.error(error);
} finally {
  await client.close();
  await server.close();
}
