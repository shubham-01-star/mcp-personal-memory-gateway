// MCP server that exposes query_personal_memory with privacy controls.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runPrivacyPipeline } from "../privacy/privacy-redaction-pipeline.js";
import { searchMemory } from "../memory/memory-repository.js";
import { startIngestionWorker } from "../ingestion/file-ingestion-worker.js";
import { generateArchestraAnswer } from "../model-orchestration/archestra-orchestrator.js";
import { publishEvent } from "../observability/event-bus.js";
import { startTelemetryServer } from "../observability/telemetry-dashboard-server.js";
import { consumeConsent } from "../security/consent-gate.js";
import { createLogger } from "../platform/application-logger.js";

export const TOOL_NAME = "query_personal_memory";

const DEBUG = process.env.MCP_DEBUG === "1";
const DASHBOARD_ALLOW_ORIGINAL = process.env.DASHBOARD_ALLOW_ORIGINAL === "1";
const logger = createLogger("mcp_server");

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolveRetrievalTopK(): number {
  // Smaller top-k keeps MCP tool responses snappy in interactive chat loops.
  const configured = parsePositiveInt(process.env.MEMORY_RETRIEVAL_TOP_K, 3);
  return Math.min(Math.max(configured, 1), 10);
}

function resolveResultMaxChars(): number {
  // Limit each recalled block so tool payloads stay compact.
  const configured = parsePositiveInt(process.env.MEMORY_RESULT_MAX_CHARS, 320);
  return Math.min(Math.max(configured, 120), 2000);
}

function compactResultText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trim()} ...`;
}

function log(...args: unknown[]) {
  if (DEBUG) {
    logger.debug("mcp_debug", { args });
  }
}

type ContextSnapshot = {
  rawContext: string;
  cleanedText: string;
  redactionCount: number;
  riskLevel: "LOW" | "HIGH";
  confidence: "HIGH" | "LOW";
  resultCount: number;
};

function buildRawContext(results: string[]): string {
  return results.map((text, index) => `[${index + 1}] ${text}`).join("\n");
}

function snapshotContext(results: string[]): ContextSnapshot {
  const rawContext = buildRawContext(results);
  const { cleanedText, redactionCount, riskLevel, confidence } =
    runPrivacyPipeline(rawContext);

  return {
    rawContext,
    cleanedText,
    redactionCount,
    riskLevel,
    confidence,
    resultCount: results.length,
  };
}

function pickSafeContext(results: string[]): ContextSnapshot {
  // Start with full context, then progressively shrink to avoid aggregate-risk blocks.
  const fullSnapshot = snapshotContext(results);
  if (
    fullSnapshot.confidence === "HIGH" &&
    fullSnapshot.riskLevel === "LOW"
  ) {
    return fullSnapshot;
  }

  for (let size = 1; size <= results.length; size += 1) {
    const candidate = snapshotContext(results.slice(0, size));
    if (candidate.confidence === "HIGH" && candidate.riskLevel === "LOW") {
      return candidate;
    }
  }

  return fullSnapshot;
}

export function createServer() {
  // Register all MCP tool handlers and their schemas.
  const server = new Server(
    {
      name: "pmg",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log("ListTools requested");
    return {
      tools: [
        {
          name: "query_personal_memory",
          description:
            "Search local memory and return privacy-filtered personal context for a topic. MUST call this tool when user asks to query memory, asks personal preference/history, or explicitly says 'call tool query_personal_memory'. Do not skip tool call in those cases.",
          inputSchema: {
            type: "object",
            properties: {
              topic: {
                type: "string",
                description: "The specific topic, keyword, or question to search for in memory.",
              },
            },
            required: ["topic"],
          },
        },
        {
          name: "save_memory",
          description:
            "Save a new fact, preference, or piece of information to the user's permanent memory. MUST call this tool when user says 'remember this', 'save this', or explicitly says 'call tool save_memory'. Do not reply with a normal answer before attempting the tool call.",
          inputSchema: {
            type: "object",
            properties: {
              fact: {
                type: "string",
                description: "The content to remember (e.g. 'User prefers Python', 'Project Alpha deadline is Dec 25').",
              },
              category: {
                type: "string",
                description: "A category tag for organization (e.g. 'coding_style', 'personal_info', 'work'). Defaults to 'general'.",
              },
            },
            required: ["fact"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log(`CallTool requested: ${name}`, args);

    if (name === "query_personal_memory") {
      // Query flow: search -> redact -> risk gate -> optional model orchestration.
      const topic = typeof args?.topic === "string" ? args.topic : "general";
      const retrievalTopK = resolveRetrievalTopK();
      const resultMaxChars = resolveResultMaxChars();

      publishEvent("query_received", {
        tool: name,
        topic: topic,
      });

      let results: string[] = [];
      try {
        // Retrieve candidate context from both document and user-fact stores.
        const rawResults = await searchMemory(topic, retrievalTopK);
        results = rawResults.map((item) => compactResultText(item, resultMaxChars));
      } catch (error) {
        log("Memory search failed", error);
        return {
          content: [{ type: "text", text: "ERROR: Failed to search memory." }],
          isError: true,
        };
      }

      if (results.length === 0) {
        log("No memory results found");
        return {
          content: [{ type: "text", text: "NO_CONTEXT_FOUND" }],
        };
      }

      // Redact PII and compute risk/confidence before anything leaves this boundary.
      const contextSnapshot = pickSafeContext(results);
      const {
        rawContext,
        cleanedText,
        redactionCount,
        riskLevel,
        confidence,
        resultCount,
      } = contextSnapshot;

      log("Privacy pipeline output", { redactionCount, riskLevel });

      publishEvent("privacy_processed", {
        topic: topic,
        resultCount,
        redactionCount,
        riskLevel,
        confidence,
        redactedContext: cleanedText,
        originalContext: DASHBOARD_ALLOW_ORIGINAL ? rawContext : undefined,
      });

      if (confidence === "LOW") {
        publishEvent("risk_blocked", {
          topic,
          reason: "LOW_CONFIDENCE",
          redactionCount,
          riskLevel,
          confidence,
        });
        return {
          content: [{ type: "text", text: "NO_CONTEXT" }],
        };
      }

      if (riskLevel === "HIGH") {
        // High-risk context requires one-time consent override.
        const consentEnabled = process.env.CONSENT_HOOK_ENABLE !== "0";
        const hasConsentOverride = consentEnabled && consumeConsent(topic);

        if (!hasConsentOverride) {
          if (consentEnabled) {
            publishEvent("consent_required", {
              topic,
              redactionCount,
              riskLevel,
              confidence,
              redactedContext: cleanedText,
            });
          }
          publishEvent("risk_blocked", {
            topic,
            reason: "HIGH_RISK",
            redactionCount,
            riskLevel,
            confidence,
          });
          log("High risk detected. Returning NO_CONTEXT.");
          return {
            content: [{ type: "text", text: "NO_CONTEXT" }],
          };
        }
      }

      // Optional orchestration layer for grounded answer generation.
      const archestraEnabled = process.env.ARCHESTRA_ENABLE === "1";
      if (archestraEnabled) {
        const provider = process.env.ARCHESTRA_PROVIDER ?? "openai";
        publishEvent("archestra_request", {
          topic,
          provider,
        });

        try {
          const answer = await generateArchestraAnswer({
            systemContext: cleanedText,
            userQuery: topic,
            redactionCount,
            riskLevel
          });

          publishEvent("archestra_response", {
            topic,
            provider,
            ok: true,
            answer,
          });

          return {
            content: [{ type: "text", text: answer }]
          };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          publishEvent("archestra_response", {
            topic,
            provider,
            ok: false,
            error: errorMessage,
          });
          logger.warn("archestra_generation_failed_fallback", {
            topic,
            provider,
            error: errorMessage,
          });
          log("Archestra generation failed, falling back to sanitized context", err);
          // Fallback to sending sanitized context directly
        }
      }

      const responseText = [
        "SANITIZED_CONTEXT:",
        cleanedText,
        "",
        `Redactions: ${redactionCount}`,
        `Risk: ${riskLevel}`,
      ].join("\n");

      return {
        content: [{ type: "text", text: responseText }],
      };
    }

    if (name === "save_memory") {
      // Write flow: persist explicit user facts/preferences for future recall.
      const fact = typeof args?.fact === "string" ? args.fact : "";
      const category = typeof args?.category === "string" ? args.category : "general";

      if (!fact) {
        return {
          content: [{ type: "text", text: "ERROR: 'fact' is required." }],
          isError: true,
        };
      }

      try {
        // Dynamic import avoids hard dependency at module load time.
        await import("../memory/memory-repository.js").then(m => m.saveUserFact(fact, category));

        publishEvent("memory_saved", {
          fact,
          category
        });

        return {
          content: [{ type: "text", text: `MEMORY_SAVED: Saved fact to category '${category}'.` }],
        };
      } catch (error) {
        log("Save memory failed", error);
        return {
          content: [{ type: "text", text: "ERROR: Failed to save memory." }],
          isError: true,
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

export async function startStdioServer() {
  // Start MCP stdio transport and optional background services.
  log("Starting stdio server");
  process.stdin.resume();

  if (process.env.DASHBOARD_ENABLE === "1") {
    try {
      await startTelemetryServer();
      log("Telemetry server started", {
        port: process.env.DASHBOARD_PORT ?? "8787",
      });
    } catch (error) {
      log("Telemetry server failed", error);
    }
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Stdio server connected");

  const ingestDisabled = process.env.INGEST_DISABLE === "1";
  if (!ingestDisabled) {
    const watchDir = process.env.INGEST_DIR ?? "my_data";
    const chunkSize = Number(process.env.CHUNK_SIZE ?? 500);

    try {
      await mkdir(watchDir, { recursive: true });
    } catch (error) {
      log("Failed to create ingestion directory", { watchDir, error });
    }

    try {
      await startIngestionWorker({ watchDir, chunkSize });
      log("Ingestion worker started", { watchDir, chunkSize });
    } catch (error) {
      log("Ingestion worker failed", error);
    }
  } else {
    log("Ingestion worker disabled");
  }

  return server;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    await startStdioServer();
  } catch (error) {
    log("Server crashed", error);
    logger.error("server_crashed", {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
