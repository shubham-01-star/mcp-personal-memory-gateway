// HTTP side-channel for dashboard telemetry (SSE + counters + file map).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  getRecentEvents,
  publishEvent,
  subscribeEvents,
  type DashboardEvent,
} from "./event-bus.js";
import { getStatsSnapshot, startStatsCollector } from "./statistics-collector.js";
import {
  clearAllDocuments,
  clearAllUserFacts,
  deleteDocumentsBySourceFile,
  getRecentMemories,
} from "../memory/memory-repository.js";
import { denyConsent, grantConsent } from "../security/consent-gate.js";
import {
  clearIngestionManifest,
  getIngestionManifestSnapshot,
  ingestFileWithManifest,
  removeIngestionManifestEntry,
  SUPPORTED_INGEST_EXTENSIONS,
} from "../ingestion/file-ingestion-worker.js";
import { createServer as createMcpServer } from "../model-context-protocol/personal-memory-server.js";
import { createLogger } from "../platform/application-logger.js";

const DEFAULT_TELEMETRY_PORT = 8787;
const DEFAULT_MCP_HTTP_PORT = 8787;
const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DASHBOARD_DIRECTORY = path.resolve(MODULE_DIRECTORY, "../../dashboard");

type SseClient = {
  id: string;
  response: ServerResponse;
};

type UploadPayload = {
  fileName: string;
  contentBase64: string;
};

type StreamableSession = {
  kind: "streamable";
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
};

type MappedSseSession = {
  kind: "sse";
  transport: SSEServerTransport;
  server: ReturnType<typeof createMcpServer>;
};

type MappedMcpSession = StreamableSession | MappedSseSession;

const logger = createLogger("dashboard_server");
let telemetryServerPromise: Promise<void> | null = null;

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  // Shared JSON responder with permissive CORS for local dashboard clients.
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(payload));
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

async function parseJsonBody(request: IncomingMessage): Promise<unknown> {
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

function writeSseEvent(response: ServerResponse, event: DashboardEvent): void {
  // SSE frame format: id + event + data.
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeStatic(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

function isPathInsideDirectory(targetPath: string, rootDirectory: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootDirectory);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

async function handleIngestionFiles(response: ServerResponse): Promise<void> {
  // Expose manifest entries so dashboard can display indexed files.
  const manifest = await getIngestionManifestSnapshot();
  const files = Object.entries(manifest).map(([filePath, meta]) => ({
    filePath,
    mtimeMs: meta.mtimeMs,
    size: meta.size,
  }));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  writeJson(response, 200, { files });
}

function getUploadMaxBytes(): number {
  const parsed = Number(process.env.DASHBOARD_UPLOAD_MAX_BYTES ?? DEFAULT_UPLOAD_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_UPLOAD_MAX_BYTES;
}

function getIngestionDirectory(): string {
  return process.env.INGEST_DIR ?? "my_data";
}

function getChunkSize(): number {
  const parsed = Number(process.env.CHUNK_SIZE ?? 500);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 500;
}

function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  return baseName.slice(0, 128);
}

function isSupportedUpload(fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  return SUPPORTED_INGEST_EXTENSIONS.includes(extension);
}

function isUploadAuthorized(request: IncomingMessage): boolean {
  const expectedToken = (process.env.DASHBOARD_UPLOAD_TOKEN ?? "").trim();
  if (!expectedToken) {
    return true;
  }

  const dashboardHeader = request.headers["x-dashboard-token"];
  const dashboardToken = Array.isArray(dashboardHeader) ? dashboardHeader[0] : dashboardHeader;
  if (dashboardToken === expectedToken) {
    return true;
  }

  const authorizationHeader = request.headers.authorization;
  if (!authorizationHeader) {
    return false;
  }
  const bearerPrefix = "Bearer ";
  if (!authorizationHeader.startsWith(bearerPrefix)) {
    return false;
  }
  return authorizationHeader.slice(bearerPrefix.length).trim() === expectedToken;
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    request.on("error", (error) => {
      reject(error);
    });
  });
}

function parseUploadPayload(rawBody: string): UploadPayload {
  const parsed = JSON.parse(rawBody) as Partial<UploadPayload>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid upload payload.");
  }
  if (typeof parsed.fileName !== "string" || !parsed.fileName.trim()) {
    throw new Error("Missing fileName in upload payload.");
  }
  if (typeof parsed.contentBase64 !== "string" || !parsed.contentBase64.trim()) {
    throw new Error("Missing contentBase64 in upload payload.");
  }
  return {
    fileName: parsed.fileName.trim(),
    contentBase64: parsed.contentBase64.trim(),
  };
}

async function handleIngestionUpload(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!isUploadAuthorized(request)) {
    writeJson(response, 401, { error: "Unauthorized upload request." });
    return;
  }

  const maxBytes = getUploadMaxBytes();
  const contentType = request.headers["content-type"] ?? "";
  if (!String(contentType).toLowerCase().includes("application/json")) {
    writeJson(response, 415, { error: "Upload expects application/json body." });
    return;
  }

  let payload: UploadPayload;
  try {
    const rawBody = await readRequestBody(request, maxBytes);
    payload = parseUploadPayload(rawBody);
  } catch (error) {
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid upload body.",
    });
    return;
  }

  const safeFileName = sanitizeFileName(payload.fileName);
  if (!safeFileName || !isSupportedUpload(safeFileName)) {
    writeJson(response, 400, {
      error: `Unsupported file type. Allowed: ${SUPPORTED_INGEST_EXTENSIONS.join(", ")}`,
    });
    return;
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = Buffer.from(payload.contentBase64, "base64");
  } catch {
    writeJson(response, 400, { error: "Invalid base64 content." });
    return;
  }

  if (fileBuffer.length === 0) {
    writeJson(response, 400, { error: "Uploaded file is empty." });
    return;
  }
  if (fileBuffer.length > maxBytes) {
    writeJson(response, 413, { error: `File exceeds max size (${maxBytes} bytes).` });
    return;
  }

  const ingestDirectory = getIngestionDirectory();
  const resolvedDirectory = path.resolve(ingestDirectory);
  const targetPath = path.resolve(resolvedDirectory, safeFileName);
  if (!targetPath.startsWith(`${resolvedDirectory}${path.sep}`)) {
    writeJson(response, 400, { error: "Invalid upload path." });
    return;
  }

  try {
    await mkdir(resolvedDirectory, { recursive: true });
    await writeFile(targetPath, fileBuffer);
  } catch (error) {
    logger.error("dashboard_upload_failed", {
      fileName: safeFileName,
      error: error instanceof Error ? error.message : String(error),
    });
    writeJson(response, 500, { error: "Failed to upload file." });
    return;
  }

  try {
    const indexedChunks = await ingestFileWithManifest(targetPath, getChunkSize());

    logger.info("dashboard_upload_ingested", {
      fileName: safeFileName,
      bytes: fileBuffer.length,
      indexedChunks,
    });

    writeJson(response, 200, {
      ok: true,
      fileName: safeFileName,
      bytes: fileBuffer.length,
      indexedChunks,
      filePath: targetPath,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("dashboard_upload_ingest_failed", {
      fileName: safeFileName,
      error: errorMessage,
    });
    // File write succeeded but indexing failed; return warning so UI can show partial success.
    writeJson(response, 200, {
      ok: true,
      fileName: safeFileName,
      bytes: fileBuffer.length,
      indexedChunks: 0,
      filePath: targetPath,
      warning: "File uploaded but ingest/index failed.",
      ingestError: errorMessage,
    });
  }
}

async function unlinkIfPresent(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function handleDeleteIngestionFile(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (!isUploadAuthorized(request)) {
    writeJson(response, 401, { error: "Unauthorized delete request." });
    return;
  }

  const rawFilePath = (requestUrl.searchParams.get("filePath") ?? "").trim();
  if (!rawFilePath) {
    writeJson(response, 400, { error: "Missing 'filePath' query param." });
    return;
  }

  const ingestDirectory = path.resolve(getIngestionDirectory());
  const targetPath = path.resolve(rawFilePath);
  const sourceFile = path.basename(targetPath);

  if (!isSupportedUpload(sourceFile)) {
    writeJson(response, 400, {
      error: `Unsupported file type. Allowed: ${SUPPORTED_INGEST_EXTENSIONS.join(", ")}`,
    });
    return;
  }

  if (!isPathInsideDirectory(targetPath, ingestDirectory)) {
    writeJson(response, 400, { error: "Invalid file path." });
    return;
  }

  try {
    const wasInManifest = await removeIngestionManifestEntry(targetPath);

    const deletedFile = await unlinkIfPresent(targetPath);
    const deletedMemoryChunks = await deleteDocumentsBySourceFile(sourceFile);

    logger.info("dashboard_upload_deleted", {
      filePath: targetPath,
      deletedFile,
      wasInManifest,
      deletedMemoryChunks,
    });

    writeJson(response, 200, {
      ok: true,
      filePath: targetPath,
      deletedFile,
      removedFromManifest: wasInManifest,
      deletedMemoryChunks,
    });
  } catch (error) {
    logger.error("dashboard_upload_delete_failed", {
      filePath: targetPath,
      error: error instanceof Error ? error.message : String(error),
    });
    writeJson(response, 500, { error: "Failed to delete indexed file." });
  }
}

async function handleClearIngestionData(
  request: IncomingMessage,
  response: ServerResponse,
  includeUserFacts = false
): Promise<void> {
  if (!isUploadAuthorized(request)) {
    writeJson(response, 401, { error: "Unauthorized clear request." });
    return;
  }

  const ingestDirectory = path.resolve(getIngestionDirectory());

  try {
    const manifest = await getIngestionManifestSnapshot();
    const trackedPaths = Object.keys(manifest).filter((filePath) =>
      isPathInsideDirectory(filePath, ingestDirectory)
    );

    let deletedFiles = 0;
    let missingFiles = 0;
    for (const filePath of trackedPaths) {
      const deleted = await unlinkIfPresent(filePath);
      if (deleted) {
        deletedFiles += 1;
      } else {
        missingFiles += 1;
      }
    }

    await clearIngestionManifest();
    const deletedMemoryChunks = await clearAllDocuments();
    const deletedUserFacts = includeUserFacts ? await clearAllUserFacts() : 0;

    logger.info("dashboard_upload_cleared", {
      trackedFiles: trackedPaths.length,
      deletedFiles,
      missingFiles,
      deletedMemoryChunks,
      deletedUserFacts,
    });

    writeJson(response, 200, {
      ok: true,
      trackedFiles: trackedPaths.length,
      deletedFiles,
      missingFiles,
      deletedMemoryChunks,
      deletedUserFacts,
    });
  } catch (error) {
    logger.error("dashboard_upload_clear_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    writeJson(response, 500, { error: "Failed to clear indexed data." });
  }
}

function getTelemetryPort(): number {
  // Validate configured port and fallback to default.
  const parsed = Number(process.env.DASHBOARD_PORT ?? DEFAULT_TELEMETRY_PORT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TELEMETRY_PORT;
}

function getMcpHttpPort(): number {
  // Keep MCP bridge on dashboard port when both defaults are used.
  const parsed = parsePort(process.env.MCP_HTTP_PORT, DEFAULT_MCP_HTTP_PORT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_HTTP_PORT;
}

async function serveDashboardAsset(
  response: ServerResponse,
  relativePath: string,
  contentType: string
): Promise<void> {
  // Resolve assets relative to installed package first, then cwd fallback for dev.
  const candidateDirectories = [
    PACKAGE_DASHBOARD_DIRECTORY,
    path.resolve("dashboard"),
  ];

  for (const candidateDirectory of candidateDirectories) {
    const filePath = path.resolve(candidateDirectory, relativePath);
    if (!isPathInsideDirectory(filePath, candidateDirectory)) {
      continue;
    }
    try {
      const content = await readFile(filePath, "utf-8");
      writeStatic(response, 200, contentType, content);
      return;
    } catch {
      // Try next candidate.
    }
  }

  writeJson(response, 404, { error: "Dashboard asset not found" });
}

export async function startTelemetryServer(): Promise<void> {
  // Singleton server startup prevents accidental duplicate listeners.
  if (telemetryServerPromise) {
    return telemetryServerPromise;
  }

  telemetryServerPromise = new Promise((resolve, reject) => {
    startStatsCollector();
    const clients = new Map<string, SseClient>();
    const mcpSessions = new Map<string, MappedMcpSession>();
    const telemetryPort = getTelemetryPort();
    const mcpRoutesEnabled =
      process.env.MCP_HTTP_ENABLE !== "0" && getMcpHttpPort() === telemetryPort;

    const cleanupMcpSession = async (sessionId: string): Promise<void> => {
      const session = mcpSessions.get(sessionId);
      if (!session) {
        return;
      }
      mcpSessions.delete(sessionId);
      try {
        await session.transport.close();
      } catch (error) {
        logger.warn("dashboard_mcp_transport_close_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await session.server.close();
      } catch (error) {
        logger.warn("dashboard_mcp_server_close_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Broadcast every event to all connected SSE clients.
    const unsubscribe = subscribeEvents((event) => {
      for (const client of clients.values()) {
        writeSseEvent(client.response, event);
      }
    });

    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (method === "OPTIONS") {
        // Preflight response for browser dashboard calls.
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers":
            "content-type,authorization,x-dashboard-token,mcp-session-id",
        });
        response.end();
        return;
      }

      if (mcpRoutesEnabled && (requestUrl.pathname === "/mcp" || requestUrl.pathname === "/sse")) {
        try {
          if (requestUrl.pathname === "/mcp") {
            const parsedBody = method === "POST" ? await parseJsonBody(request) : undefined;
            const sessionIdHeader = request.headers["mcp-session-id"];
            const sessionId = Array.isArray(sessionIdHeader)
              ? sessionIdHeader[0]
              : sessionIdHeader;

            let sessionRecord: MappedMcpSession | undefined;
            if (sessionId) {
              sessionRecord = mcpSessions.get(sessionId);
            } else if (method === "POST") {
              const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newSessionId) => {
                  mcpSessions.set(newSessionId, {
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
                void cleanupMcpSession(generatedSessionId);
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

          if (requestUrl.pathname === "/sse" && method === "GET") {
            const transport = new SSEServerTransport("/sse", response);
            const mcpServer = createMcpServer();
            await mcpServer.connect(transport);

            const sessionId = transport.sessionId;
            mcpSessions.set(sessionId, {
              kind: "sse",
              transport,
              server: mcpServer,
            });

            response.on("close", () => {
              void cleanupMcpSession(sessionId);
            });
            return;
          }

          if (requestUrl.pathname === "/sse" && method === "POST") {
            const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
            const sessionRecord = mcpSessions.get(sessionId);
            if (!sessionRecord || sessionRecord.kind !== "sse") {
              writeJson(response, 400, { error: "No SSE session found for sessionId." });
              return;
            }

            const parsedBody = await parseJsonBody(request);
            await sessionRecord.transport.handlePostMessage(request, response, parsedBody);
            return;
          }

          if (requestUrl.pathname === "/sse" && method === "DELETE") {
            const sessionId = requestUrl.searchParams.get("sessionId") ?? "";
            if (!sessionId) {
              writeJson(response, 400, { error: "Missing sessionId." });
              return;
            }
            await cleanupMcpSession(sessionId);
            writeJson(response, 200, { ok: true });
            return;
          }

          writeJson(response, 405, { error: "Method not allowed" });
          return;
        } catch (error) {
          logger.error("dashboard_mcp_request_failed", {
            method,
            pathname: requestUrl.pathname,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
          });
          writeJson(response, 500, { error: "MCP HTTP server error." });
          return;
        }
      }

      if (requestUrl.pathname === "/ingestion/upload") {
        if (method !== "POST") {
          writeJson(response, 405, { error: "Method not allowed" });
          return;
        }
        await handleIngestionUpload(request, response);
        return;
      }

      if (requestUrl.pathname === "/ingestion/files" && method === "DELETE") {
        await handleDeleteIngestionFile(request, response, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/ingestion/clear") {
        if (method !== "POST") {
          writeJson(response, 405, { error: "Method not allowed" });
          return;
        }
        await handleClearIngestionData(request, response);
        return;
      }

      if (requestUrl.pathname === "/memory/clear") {
        if (method !== "POST") {
          writeJson(response, 405, { error: "Method not allowed" });
          return;
        }
        await handleClearIngestionData(request, response, true);
        return;
      }

      if (method !== "GET") {
        writeJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (requestUrl.pathname === "/healthz") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/" || requestUrl.pathname === "/dashboard") {
        await serveDashboardAsset(response, "index.html", "text/html; charset=utf-8");
        return;
      }

      if (requestUrl.pathname === "/dashboard/app.js") {
        await serveDashboardAsset(response, "app.js", "text/javascript; charset=utf-8");
        return;
      }

      if (requestUrl.pathname === "/stats") {
        writeJson(response, 200, getStatsSnapshot() as unknown as Record<string, unknown>);
        return;
      }

      if (requestUrl.pathname === "/ingestion/files") {
        await handleIngestionFiles(response);
        return;
      }

      if (requestUrl.pathname === "/graph") {
        try {
          const memories = await getRecentMemories(50);
          writeJson(response, 200, { nodes: memories });
        } catch (err) {
          writeJson(response, 500, { error: "Failed to fetch graph data" });
        }
        return;
      }

      if (
        requestUrl.pathname === "/consent/allow" ||
        requestUrl.pathname === "/consent/deny"
      ) {
        // Consent endpoints let dashboard approve/deny one-time high-risk retries.
        const topic = (requestUrl.searchParams.get("topic") ?? "").trim();
        if (!topic) {
          writeJson(response, 400, { error: "Missing 'topic' query param" });
          return;
        }

        if (requestUrl.pathname === "/consent/allow") {
          grantConsent(topic);
          publishEvent("consent_decision", {
            topic,
            decision: "ALLOW",
          });
        } else {
          denyConsent(topic);
          publishEvent("consent_decision", {
            topic,
            decision: "DENY",
          });
        }

        writeJson(response, 200, { ok: true, topic });
        return;
      }

      if (requestUrl.pathname === "/events") {
        // SSE endpoint streams live events and replays a small recent window.
        const replay = Number(requestUrl.searchParams.get("replay") ?? "20");
        const replayLimit =
          Number.isFinite(replay) && replay > 0 ? Math.min(Math.floor(replay), 200) : 20;

        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });

        const clientId = randomUUID();
        clients.set(clientId, { id: clientId, response });

        response.write(`event: connected\ndata: {"clientId":"${clientId}"}\n\n`);
        for (const event of getRecentEvents(replayLimit)) {
          writeSseEvent(response, event);
        }

        const keepAlive = setInterval(() => {
          // Keep proxies/load balancers from closing idle event streams.
          response.write(": ping\n\n");
        }, 15000);

        request.on("close", () => {
          clearInterval(keepAlive);
          clients.delete(clientId);
        });
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    });

    server.on("error", (error) => {
      unsubscribe();
      reject(error);
    });

    server.listen(telemetryPort, () => {
      logger.info("dashboard_server_started", {
        port: telemetryPort,
        mcpRoutesEnabled,
      });
      resolve();
    });
  });

  return telemetryServerPromise;
}
