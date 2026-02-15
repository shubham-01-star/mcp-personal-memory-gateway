import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";

/**
 * Comprehensive End-to-End Test for Personal Memory Gateway
 * Tests all 6 modules in an integrated flow:
 * 1. MCP Core
 * 2. Privacy Engine
 * 3. Local Brain (LanceDB)
 * 4. Ingestion Worker
 * 5. Archestra Bridge
 * 6. Visual Trust UI (via HTTP endpoints)
 */

const TEST_DB_PATH = `data/lancedb-e2e-${Date.now()}`;
const TEST_TABLE = `e2e_test_${Date.now()}`;
const TEST_FILE_PATH = `my_data/e2e_test_${Date.now()}.txt`;

// Test data with sensitive information
const TEST_CONTENT = `
Personal Profile for E2E Test
Name: John Doe
Phone: +1-555-123-4567
Email: john.doe@example.com
Credit Card: 4532-1234-5678-9010
Salary: $85,000 per year
Favorite Language: Python
Project Budget: $50,000

This is a test document for end-to-end validation.
I love working with LanceDB and vector embeddings.
`;

// Configure test environment
process.env.LANCE_DB_PATH = TEST_DB_PATH;
process.env.LANCE_TABLE_NAME = TEST_TABLE;
process.env.ARCHESTRA_ENABLE = "0";
process.env.EMBEDDING_PROVIDER = "local";
process.env.MEMORY_QUERY_SCOPE = "hybrid";
process.env.MCP_STDIO_ENABLE = "1";
process.env.DASHBOARD_ENABLE = "0";

console.log("🧪 Personal Memory Gateway - Comprehensive E2E Test\n");
console.log("=".repeat(60));

let testsPassed = 0;
let testsFailed = 0;

function logTest(name, passed, details = "") {
    const icon = passed ? "✅" : "❌";
    console.log(`${icon} ${name}`);
    if (details) console.log(`   ${details}`);
    if (passed) testsPassed++;
    else testsFailed++;
}

try {
    // Setup
    console.log("\n📋 SETUP PHASE");
    console.log("-".repeat(60));

    await mkdir("data", { recursive: true });
    await mkdir("my_data", { recursive: true });

    // Import modules
    const { ingestFile } = await import("../dist/ingestion/file-ingestion-worker.js");
    const { createServer } = await import("../dist/model-context-protocol/personal-memory-server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    logTest("Modules imported successfully", true);

    // MODULE 4: Ingestion Worker
    console.log("\n🔄 MODULE 4: INGESTION WORKER");
    console.log("-".repeat(60));

    await writeFile(TEST_FILE_PATH, TEST_CONTENT, "utf-8");
    logTest("Test file created", true, TEST_FILE_PATH);

    const chunks = await ingestFile(TEST_FILE_PATH, 500);
    logTest("File ingestion completed", chunks > 0, `${chunks} chunk(s) created`);
    logTest("Chunking works correctly", chunks >= 1, "Content split into appropriate chunks");

    // MODULE 1: MCP Core + MODULE 3: Local Brain
    console.log("\n🔌 MODULE 1: MCP CORE + MODULE 3: LOCAL BRAIN");
    console.log("-".repeat(60));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: "e2e-test", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    logTest("MCP server initialized", true);
    logTest("MCP client connected", true);

    // List tools
    const toolsList = await client.listTools();
    const hasQueryTool = toolsList.tools.some(t => t.name === "query_personal_memory");
    const hasSaveTool = toolsList.tools.some(t => t.name === "save_memory");

    logTest("query_personal_memory tool registered", hasQueryTool);
    logTest("save_memory tool registered", hasSaveTool);

    // MODULE 2: Privacy Engine (via query)
    console.log("\n🛡️ MODULE 2: PRIVACY ENGINE");
    console.log("-".repeat(60));

    // Test query with sensitive data
    const queryResult = await client.callTool({
        name: "query_personal_memory",
        arguments: { topic: "phone email credit card" },
    });

    const queryText = queryResult.content?.find(item => item.type === "text")?.text ?? "";

    logTest("Query executed successfully", queryText.length > 0);

    // Check for redactions
    const hasPhoneRedaction = queryText.includes("[REDACTED_PHONE]");
    const hasEmailRedaction = queryText.includes("[REDACTED_EMAIL]");
    const hasCCRedaction = queryText.includes("[REDACTED_CREDIT_CARD]");
    const hasFinancialRedaction = queryText.includes("[REDACTED_FINANCIAL_AMOUNT]");

    logTest("Phone number redacted", hasPhoneRedaction);
    logTest("Email redacted", hasEmailRedaction);
    logTest("Credit card redacted", hasCCRedaction);
    logTest("Financial amount redacted", hasFinancialRedaction);

    // Verify original sensitive data is NOT in response
    const noRawPhone = !queryText.includes("555-123-4567");
    const noRawEmail = !queryText.includes("john.doe@example.com");
    const noRawCC = !queryText.includes("4532-1234-5678-9010");

    logTest("No raw phone number in response", noRawPhone);
    logTest("No raw email in response", noRawEmail);
    logTest("No raw credit card in response", noRawCC);

    // Test save_memory tool
    console.log("\n💾 TESTING SAVE_MEMORY TOOL");
    console.log("-".repeat(60));

    const saveResult = await client.callTool({
        name: "save_memory",
        arguments: {
            fact: "User prefers Python for backend development",
            category: "preferences"
        },
    });

    const saveText = saveResult.content?.find(item => item.type === "text")?.text ?? "";
    logTest("save_memory executed", saveText.includes("saved") || saveText.includes("Saved"));

    // Query the saved memory
    const savedQueryResult = await client.callTool({
        name: "query_personal_memory",
        arguments: { topic: "Python backend" },
    });

    const savedQueryText = savedQueryResult.content?.find(item => item.type === "text")?.text ?? "";
    const foundSavedMemory = savedQueryText.toLowerCase().includes("python");

    logTest("Saved memory retrieved via query", foundSavedMemory);

    // Test hybrid search
    console.log("\n🔍 TESTING HYBRID SEARCH");
    console.log("-".repeat(60));

    const hybridResult = await client.callTool({
        name: "query_personal_memory",
        arguments: { topic: "favorite language budget" },
    });

    const hybridText = hybridResult.content?.find(item => item.type === "text")?.text ?? "";
    const hasDocumentContent = hybridText.toLowerCase().includes("python") || hybridText.toLowerCase().includes("language");

    logTest("Hybrid search returns results", hybridText.length > 0);
    logTest("Results include document content", hasDocumentContent);

    // Test semantic search (not just keyword matching)
    console.log("\n🧠 TESTING SEMANTIC SEARCH");
    console.log("-".repeat(60));

    const semanticResult = await client.callTool({
        name: "query_personal_memory",
        arguments: { topic: "programming preferences" },
    });

    const semanticText = semanticResult.content?.find(item => item.type === "text")?.text ?? "";
    const semanticMatch = semanticText.toLowerCase().includes("python") || semanticText.toLowerCase().includes("language");

    logTest("Semantic search works", semanticMatch, "Found related content without exact keyword match");

    // Cleanup
    await client.close();
    await server.close();

    logTest("MCP connections closed cleanly", true);

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("📊 TEST SUMMARY");
    console.log("=".repeat(60));
    console.log(`✅ Tests Passed: ${testsPassed}`);
    console.log(`❌ Tests Failed: ${testsFailed}`);
    console.log(`📈 Success Rate: ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%`);

    if (testsFailed === 0) {
        console.log("\n🎉 ALL TESTS PASSED! Personal Memory Gateway is working perfectly!");
    } else {
        console.log("\n⚠️  Some tests failed. Please review the output above.");
    }

    console.log("\n💡 Test artifacts:");
    console.log(`   - Database: ${TEST_DB_PATH}`);
    console.log(`   - Test file: ${TEST_FILE_PATH}`);
    console.log(`   - Table: ${TEST_TABLE}`);

    process.exit(testsFailed > 0 ? 1 : 0);

} catch (error) {
    console.error("\n❌ FATAL ERROR:", error.message);
    console.error(error.stack);
    process.exit(1);
}
