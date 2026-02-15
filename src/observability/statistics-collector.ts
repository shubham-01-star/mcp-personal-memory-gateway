// Aggregate dashboard counters from telemetry events.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { subscribeEvents, type DashboardEvent } from "./event-bus.js";

type RedactionCounters = {
  email: number;
  phone: number;
  financialAmount: number;
  secrets: number;
  creditCard: number;
  ssn: number;
  bankAccount: number;
  jwt: number;
};

export type DashboardStats = {
  totalQueries: number;
  blockedHighRisk: number;
  totalRedactions: number;
  totalIngestedFiles: number;
  totalIngestedChunks: number;
  ingestErrors: number;
  redactionByType: RedactionCounters;
  lastUpdatedAt: string | null;
};

const DEFAULT_STATS_PATH = "data/dashboard-stats.json";
const SECRET_TOKENS = [
  "[REDACTED_PASSWORD]",
  "[REDACTED_API_KEY]",
  "[REDACTED_AWS_ACCESS_KEY]",
  "[REDACTED_SECRET]",
] as const;

const stats: DashboardStats = {
  totalQueries: 0,
  blockedHighRisk: 0,
  totalRedactions: 0,
  totalIngestedFiles: 0,
  totalIngestedChunks: 0,
  ingestErrors: 0,
  redactionByType: {
    email: 0,
    phone: 0,
    financialAmount: 0,
    secrets: 0,
    creditCard: 0,
    ssn: 0,
    bankAccount: 0,
    jwt: 0,
  },
  lastUpdatedAt: null,
};

let persistChain: Promise<void> = Promise.resolve();
let telemetryStatsStarted = false;

function getStatsPath(): string {
  // Keep stats file path configurable for local/dev/prod environments.
  return process.env.DASHBOARD_STATS_PATH ?? DEFAULT_STATS_PATH;
}

function countOccurrences(text: string, marker: string): number {
  if (!text.includes(marker)) {
    return 0;
  }
  return text.split(marker).length - 1;
}

function applyRedactionCounts(redactedContext: string): void {
  // Derive per-category counters from placeholder markers in sanitized output.
  stats.redactionByType.email += countOccurrences(redactedContext, "[REDACTED_EMAIL]");
  stats.redactionByType.phone += countOccurrences(redactedContext, "[REDACTED_PHONE]");
  stats.redactionByType.financialAmount += countOccurrences(
    redactedContext,
    "[REDACTED_FINANCIAL_AMOUNT]"
  );
  stats.redactionByType.creditCard += countOccurrences(
    redactedContext,
    "[REDACTED_CREDIT_CARD]"
  );
  stats.redactionByType.ssn += countOccurrences(redactedContext, "[REDACTED_SSN]");
  stats.redactionByType.bankAccount += countOccurrences(
    redactedContext,
    "[REDACTED_ACCOUNT_NUMBER]"
  );
  stats.redactionByType.jwt += countOccurrences(redactedContext, "[REDACTED_JWT]");

  for (const token of SECRET_TOKENS) {
    stats.redactionByType.secrets += countOccurrences(redactedContext, token);
  }
}

async function persistStats(): Promise<void> {
  // Persist current snapshot for dashboard reloads and external inspection.
  const statsPath = getStatsPath();
  await mkdir(path.dirname(statsPath), { recursive: true });
  await writeFile(statsPath, JSON.stringify(stats, null, 2), "utf-8");
}

function schedulePersist(): void {
  // Chain writes to avoid parallel file writes and partial output races.
  persistChain = persistChain
    .then(() => persistStats())
    .catch(() => {
      // Ignore telemetry persistence failures; runtime should stay healthy.
    });
}

function updateStats(event: DashboardEvent): void {
  // Apply event-to-counter mapping with minimal payload assumptions.
  switch (event.type) {
    case "query_received":
      stats.totalQueries += 1;
      break;
    case "privacy_processed": {
      const redactionCount = Number(event.payload.redactionCount ?? 0);
      if (Number.isFinite(redactionCount) && redactionCount > 0) {
        stats.totalRedactions += redactionCount;
      }
      const redactedContext =
        typeof event.payload.redactedContext === "string"
          ? event.payload.redactedContext
          : "";
      if (redactedContext) {
        applyRedactionCounts(redactedContext);
      }
      break;
    }
    case "risk_blocked":
      stats.blockedHighRisk += 1;
      break;
    case "ingest_success": {
      stats.totalIngestedFiles += 1;
      const chunks = Number(event.payload.chunks ?? 0);
      if (Number.isFinite(chunks) && chunks > 0) {
        stats.totalIngestedChunks += chunks;
      }
      break;
    }
    case "ingest_error":
      stats.ingestErrors += 1;
      break;
    default:
      break;
  }

  stats.lastUpdatedAt = event.timestamp;
  schedulePersist();
}

export function startStatsCollector(): void {
  // Idempotent startup protects against duplicate subscriptions.
  if (telemetryStatsStarted) {
    return;
  }
  telemetryStatsStarted = true;
  subscribeEvents(updateStats);
}

export function getStatsSnapshot(): DashboardStats {
  return {
    ...stats,
    redactionByType: { ...stats.redactionByType },
  };
}
