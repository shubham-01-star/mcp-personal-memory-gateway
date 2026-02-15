import "dotenv/config";
import { mkdir } from "node:fs/promises";
import process from "node:process";

// Quick end-to-end helper: ingest file and query MCP tool in one command.
const query = process.argv[2] ?? "profile";
const inputPath = process.argv[3] ?? "my_data/profile.txt";
const chunkSizeRaw = process.env.CHUNK_SIZE ?? "1000";
const chunkSize = Number(chunkSizeRaw);
const effectiveChunkSize =
  Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : 1000;

if (!process.env.LANCE_DB_PATH) {
  // Use run-scoped DB path to avoid polluting default local state.
  process.env.LANCE_DB_PATH = `data/lancedb-onecommand-${Date.now()}`;
}
if (!process.env.LANCE_TABLE_NAME) {
  process.env.LANCE_TABLE_NAME = `onecommand_${Date.now()}`;
}
if (!("ARCHESTRA_ENABLE" in process.env)) {
  process.env.ARCHESTRA_ENABLE = "0";
}
if (!("ARCHESTRA_EXTRACTIVE_MODE" in process.env)) {
  process.env.ARCHESTRA_EXTRACTIVE_MODE = "0";
}

await mkdir("data", { recursive: true });

// Import built output so this script mirrors production runtime wiring.
const { ingestFile } = await import("../dist/ingestion/file-ingestion-worker.js");
const { createServer } = await import("../dist/model-context-protocol/personal-memory-server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

console.log("Step 1: Ingest file ->", inputPath);
const chunks = await ingestFile(inputPath, effectiveChunkSize);
console.log("Chunks ingested:", chunks);

console.log("Step 2: Call MCP tool query_personal_memory");
// In-memory transport keeps flow self-contained (no stdio process management required).
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: "one-command-flow", version: "0.1.0" });

await server.connect(serverTransport);
await client.connect(clientTransport);

const result = await client.callTool({
  name: "query_personal_memory",
  arguments: { topic: query },
});

const textItem = result.content?.find((item) => item.type === "text");
const text = textItem?.text ?? "";

console.log("\nStep 3: MCP Response\n");
console.log(text);

await client.close();
await server.close();
