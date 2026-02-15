// In-memory consent gate for one-time high-risk context overrides.
const DEFAULT_CONSENT_TTL_MS = 5 * 60 * 1000;
const topicConsentExpiries = new Map<string, number>();

function normalizeTopic(topic: string): string {
  // Topic keys are case-insensitive to avoid duplicate consent entries.
  return topic.trim().toLowerCase();
}

function getConsentTtlMs(): number {
  // TTL remains configurable, with safe fallback for invalid values.
  const parsed = Number(process.env.CONSENT_TTL_MS ?? DEFAULT_CONSENT_TTL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CONSENT_TTL_MS;
  }
  return Math.floor(parsed);
}

export function grantConsent(topic: string): void {
  // Consent is one-time and expires automatically after TTL.
  const normalized = normalizeTopic(topic);
  if (!normalized) {
    return;
  }
  topicConsentExpiries.set(normalized, Date.now() + getConsentTtlMs());
}

export function denyConsent(topic: string): void {
  // Explicit deny clears any existing grant for the same topic.
  const normalized = normalizeTopic(topic);
  if (!normalized) {
    return;
  }
  topicConsentExpiries.delete(normalized);
}

export function consumeConsent(topic: string): boolean {
  // Consume-and-delete semantics prevent reuse of stale consent decisions.
  const normalized = normalizeTopic(topic);
  if (!normalized) {
    return false;
  }

  const expiry = topicConsentExpiries.get(normalized);
  if (!expiry) {
    return false;
  }

  topicConsentExpiries.delete(normalized);
  if (expiry < Date.now()) {
    return false;
  }
  return true;
}
