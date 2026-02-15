import { createServer, type Server } from "node:http";
import { createLogger } from "../platform/application-logger.js";

// Lightweight readiness/liveness server for deployments and container probes.
const logger = createLogger("health");

export type HealthServerHandle = {
  close: () => Promise<void>;
};

function writeJson(
  statusCode: number,
  payload: Record<string, unknown>,
  response: import("node:http").ServerResponse
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
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

export async function startHealthServer(
  port: number,
  host: string
): Promise<HealthServerHandle | null> {
  // Port <= 0 means "disabled" to keep local MCP-only runs simple.
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }

  const startedAt = Date.now();
  const server = createServer((request, response) => {
    // Keep surface area intentionally tiny: only health endpoints are exposed.
    if (request.method !== "GET") {
      writeJson(405, { ok: false, error: "Method not allowed" }, response);
      return;
    }

    if (request.url === "/healthz" || request.url === "/readyz") {
      writeJson(
        200,
        {
          ok: true,
          uptimeMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        },
        response
      );
      return;
    }

    writeJson(404, { ok: false, error: "Not found" }, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  logger.info("health_server_started", { host, port });

  return {
    close: async () => {
      await closeServer(server);
      logger.info("health_server_stopped", { host, port });
    },
  };
}
