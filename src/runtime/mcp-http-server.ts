import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer as createMcpServer } from "../model-context-protocol/personal-memory-server.js";
import { createLogger } from "../platform/application-logger.js";

type HttpMcpServerHandle = {
  close: () => Promise<void>;
};

type StreamableSession = {
  kind: "streamable";
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
};

type SseSession = {
  kind: "sse";
  transport: SSEServerTransport;
  server: ReturnType<typeof createMcpServer>;
};

type SessionRecord = StreamableSession | SseSession;

const DEFAULT_MCP_HTTP_PORT = 8787;
const DEFAULT_MCP_HTTP_HOST = "0.0.0.0";
const logger = createLogger("mcp_http");

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function parseJsonBody(
  request: IncomingMessage
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const body = Buffer.concat(chunks).toString("utf-8").trim();
  if (!body) {
    return undefined;
  }
  return JSON.parse(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startMcpHttpServer(): Promise<HttpMcpServerHandle | null> {
  // Local MCP-over-HTTP bridge for Archestra and other remote clients.
  const enabled = process.env.MCP_HTTP_ENABLE !== "0";
  if (!enabled) {
    return null;
  }

  const host = process.env.MCP_HTTP_HOST?.trim() || DEFAULT_MCP_HTTP_HOST;
  const port = parsePort(process.env.MCP_HTTP_PORT, DEFAULT_MCP_HTTP_PORT);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    logger.error("mcp_http_invalid_port", { port: process.env.MCP_HTTP_PORT });
    return null;
  }

  const sessions = new Map<string, SessionRecord>();

  const cleanupSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    sessions.delete(sessionId);
    try {
      await session.transport.close();
    } catch (error) {
      logger.warn("mcp_http_transport_close_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await session.server.close();
    } catch (error) {
      logger.warn("mcp_http_server_close_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const httpServer = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const pathname = requestUrl.pathname;

    // Allow simple browser preflight for local testing dashboards/tools.
    if (method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,mcp-session-id",
      });
      response.end();
      return;
    }

    if (pathname === "/healthz" || pathname === "/readyz") {
      writeJson(response, 200, { ok: true, server: "mcp-http", timestamp: new Date().toISOString() });
      return;
    }

    try {
      if (pathname === "/mcp") {
        const parsedBody = method === "POST" ? await parseJsonBody(request) : undefined;
        const sessionIdHeader = request.headers["mcp-session-id"];
        const sessionId = Array.isArray(sessionIdHeader)
          ? sessionIdHeader[0]
          : sessionIdHeader;

        let sessionRecord: SessionRecord | undefined;
        if (sessionId) {
          sessionRecord = sessions.get(sessionId);
        } else if (method === "POST") {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, {
                kind: "streamable",
                transport,
                server: mcpServer,
              });
            },
          });
          const mcpServer = createMcpServer();
          await mcpServer.connect(transport);

          transport.onclose = () => {
            const generatedSessionId = transport.sessionId;
            if (!generatedSessionId) {
              return;
            }
            void cleanupSession(generatedSessionId);
          };

          sessionRecord = {
            kind: "streamable",
            transport,
            server: mcpServer,
          };
        }

        if (!sessionRecord || sessionRecord.kind !== "streamable") {
          writeJson(response, 400, {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid streamable MCP session.",
            },
            id: null,
          });
          return;
        }

        await sessionRecord.transport.handleRequest(request, response, parsedBody);
        return;
      }

      // Backward-compatible SSE endpoint used by older clients and Archestra setups.
      if (pathname === "/sse" && method === "GET") {
        const transport = new SSEServerTransport("/sse", response);
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);

        const sessionId = transport.sessionId;
        sessions.set(sessionId, {
          kind: "sse",
          transport,
          server: mcpServer,
        });

        response.on("close", () => {
          void cleanupSession(sessionId);
        });
        return;
      }

      if (pathname === "/sse" && method === "POST") {
        const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
        const sessionRecord = sessions.get(sessionId);
        if (!sessionRecord || sessionRecord.kind !== "sse") {
          writeJson(response, 400, { error: "No SSE session found for sessionId." });
          return;
        }

        const parsedBody = await parseJsonBody(request);
        await sessionRecord.transport.handlePostMessage(request, response, parsedBody);
        return;
      }

      if (pathname === "/sse" && method === "DELETE") {
        const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
        if (!sessionId) {
          writeJson(response, 400, { error: "Missing sessionId." });
          return;
        }
        await cleanupSession(sessionId);
        writeJson(response, 200, { ok: true });
        return;
      }
    } catch (error) {
      logger.error("mcp_http_request_failed", {
        method,
        pathname,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      writeJson(response, 500, { error: "MCP HTTP server error." });
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  logger.info("mcp_http_server_started", { host, port });

  return {
    close: async () => {
      for (const sessionId of [...sessions.keys()]) {
        await cleanupSession(sessionId);
      }
      await closeServer(httpServer);
      logger.info("mcp_http_server_stopped", { host, port });
    },
  };
}
