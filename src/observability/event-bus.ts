// Lightweight in-process event bus for dashboard telemetry.
import { randomUUID } from "node:crypto";

export type DashboardEventType =
  | "query_received"
  | "privacy_processed"
  | "risk_blocked"
  | "consent_required"
  | "consent_decision"
  | "ingest_success"
  | "ingest_error"
  | "archestra_request"
  | "archestra_response"
  | "memory_saved";

export type DashboardEvent = {
  id: string;
  type: DashboardEventType;
  timestamp: string;
  payload: Record<string, unknown>;
};

type EventHandler = (event: DashboardEvent) => void;

const MAX_EVENT_BUFFER = Number(process.env.DASHBOARD_EVENT_BUFFER ?? 200);
const handlers = new Set<EventHandler>();
const events: DashboardEvent[] = [];

function getBufferLimit(): number {
  // Guard against invalid buffer values while preserving bounded memory usage.
  return Number.isFinite(MAX_EVENT_BUFFER) && MAX_EVENT_BUFFER > 0
    ? Math.floor(MAX_EVENT_BUFFER)
    : 200;
}

export function publishEvent(
  type: DashboardEventType,
  payload: Record<string, unknown> = {}
): DashboardEvent {
  // Fan-out event to subscribers and keep a replay window in memory.
  const event: DashboardEvent = {
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    payload,
  };

  events.push(event);
  const limit = getBufferLimit();
  if (events.length > limit) {
    events.splice(0, events.length - limit);
  }

  for (const handler of handlers) {
    try {
      handler(event);
    } catch {
      // Ignore subscriber errors to keep the pipeline resilient.
    }
  }

  return event;
}

export function getRecentEvents(limit = 50): DashboardEvent[] {
  // Replay slice is used by SSE clients during initial connection.
  if (limit <= 0) {
    return [];
  }
  return events.slice(Math.max(0, events.length - limit));
}

export function subscribeEvents(handler: EventHandler): () => void {
  // Return unsubscribe handle for deterministic lifecycle cleanup.
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
