import "dotenv/config";
import { startStdioServer } from "../model-context-protocol/personal-memory-server.js";
import { createLogger } from "../platform/application-logger.js";
import { validateRuntimeConfig } from "../platform/runtime-configuration.js";
import { startHealthServer } from "./health-check-server.js";
import { startMcpHttpServer } from "./mcp-http-server.js";
import { startTelemetryServer } from "../observability/telemetry-dashboard-server.js";

// Coordinates startup, configuration validation, and graceful shutdown.
const logger = createLogger("bootstrap");

type ShutdownResources = {
  close: () => Promise<void> | void;
};

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export async function runApp(): Promise<void> {
  // Validate all environment-driven runtime behavior before opening transports.
  const validation = validateRuntimeConfig(process.env);

  for (const warning of validation.warnings) {
    logger.warn("config_warning", { warning });
  }

  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      logger.error("config_error", { error });
    }
    process.exitCode = 1;
    return;
  }

  const resources: ShutdownResources[] = [];
  let shuttingDown = false;
  const stdioEnabled = process.env.MCP_STDIO_ENABLE !== "0";
  const mcpHttpEnabled = process.env.MCP_HTTP_ENABLE !== "0";
  const parsedMcpHttpPort = Number(process.env.MCP_HTTP_PORT ?? "");
  const mcpHttpPort = Number.isFinite(parsedMcpHttpPort) && parsedMcpHttpPort > 0
    ? Math.floor(parsedMcpHttpPort)
    : 8787;
  const shouldUseDashboardForMcpHttp =
    !stdioEnabled &&
    validation.config.dashboardEnabled &&
    mcpHttpEnabled &&
    mcpHttpPort === validation.config.dashboardPort;

  // Release resources in reverse order to avoid dependency teardown races.
  const shutdown = async (signal: string, exitCode: number) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("shutdown_started", { signal });

    for (const resource of resources.reverse()) {
      try {
        await resource.close();
      } catch (error) {
        logger.error("shutdown_resource_failed", { error: errorToString(error) });
      }
    }

    logger.info("shutdown_completed", { signal, exitCode });
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", { error: errorToString(error) });
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", { reason: errorToString(reason) });
    void shutdown("unhandledRejection", 1);
  });

  // Health server is optional and disabled by default unless HEALTH_PORT is set.
  const healthServer = await startHealthServer(
    validation.config.healthPort,
    validation.config.healthHost
  );
  if (healthServer) {
    resources.push(healthServer);
  }

  if (shouldUseDashboardForMcpHttp) {
    logger.info("mcp_http_embedded_in_dashboard", {
      dashboardPort: validation.config.dashboardPort,
    });
  } else {
    const mcpHttpServer = await startMcpHttpServer();
    if (mcpHttpServer) {
      resources.push(mcpHttpServer);
    }
  }

  if (!stdioEnabled && validation.config.dashboardEnabled) {
    await startTelemetryServer();
  }

  if (stdioEnabled) {
    const mcpServer = await startStdioServer();
    resources.push({
      close: async () => {
        await mcpServer.close();
      },
    });
  }

  logger.info("app_started", {
    nodeEnv: validation.config.nodeEnv,
    logLevel: validation.config.logLevel,
    archestraEnabled: validation.config.archestraEnabled,
    archestraProvider: validation.config.archestraProvider,
    embeddingProvider: validation.config.embeddingProvider,
    dashboardEnabled: validation.config.dashboardEnabled,
    healthPort: validation.config.healthPort,
    mcpHttpPort: process.env.MCP_HTTP_PORT ?? "8787",
    stdioEnabled,
  });
}
