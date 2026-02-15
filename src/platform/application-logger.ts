// Structured stderr logger used by all modules to keep logs machine-readable.
type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase().trim();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[threshold];
}

function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function writeLog(
  level: LogLevel,
  scope: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const threshold = resolveLogLevel();
  if (!shouldLog(level, threshold)) {
    return;
  }

  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
  };

  if (data && Object.keys(data).length > 0) {
    payload.data = data;
  }

  // Always use stderr to avoid corrupting MCP stdio protocol on stdout.
  process.stderr.write(`${stringifySafe(payload)}\n`);
}

export function createLogger(scope: string) {
  // Bound logger instance so callers never repeat scope labels manually.
  return {
    debug(message: string, data?: Record<string, unknown>) {
      writeLog("debug", scope, message, data);
    },
    info(message: string, data?: Record<string, unknown>) {
      writeLog("info", scope, message, data);
    },
    warn(message: string, data?: Record<string, unknown>) {
      writeLog("warn", scope, message, data);
    },
    error(message: string, data?: Record<string, unknown>) {
      writeLog("error", scope, message, data);
    },
  };
}
