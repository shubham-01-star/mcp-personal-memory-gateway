// Regex-based PII redaction with risk scoring and confidence checks.
export type RiskLevel = "LOW" | "HIGH";
export type RedactionConfidence = "HIGH" | "LOW";

type Pattern = {
  name: string;
  regex: RegExp;
  severity: "low" | "medium" | "high";
  captureIndex?: number;
  replacement:
    | string
    | ((match: string, captures: string[]) => string);
};

function resolveSecretToken(secretLabel: string): string {
  // Use label-aware placeholders to preserve semantic context after redaction.
  const label = secretLabel.toLowerCase().trim();
  if (label.includes("password") || label === "pwd") {
    return "[REDACTED_PASSWORD]";
  }
  if (label.includes("aws")) {
    return "[REDACTED_AWS_ACCESS_KEY]";
  }
  if (label.includes("secret")) {
    return "[REDACTED_SECRET]";
  }
  return "[REDACTED_API_KEY]";
}

const PATTERNS: Pattern[] = [
  // Pattern list is intentionally ordered from broad/common to specific structured secrets.
  {
    name: "email",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
    severity: "medium",
    replacement: "[REDACTED_EMAIL]",
  },
  {
    name: "phone",
    regex:
      /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\d{10})\b/g,
    severity: "medium",
    replacement: "[REDACTED_PHONE]",
  },
  {
    name: "ssn",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    severity: "high",
    replacement: "[REDACTED_SSN]",
  },
  {
    name: "credit_card",
    regex: /\b(?:\d[ -]*?){13,16}\b/g,
    severity: "high",
    replacement: "[REDACTED_CREDIT_CARD]",
  },
  {
    name: "financial_amount",
    regex:
      /(?<!\w)(?:\$|₹|€|£)\s?\d+(?:,\d{3})*(?:\.\d+)?(?:[kKmMbB])?\b/g,
    severity: "medium",
    replacement: "[REDACTED_FINANCIAL_AMOUNT]",
  },
  {
    name: "openai_or_stripe_key",
    regex:
      /\b(?:sk|pk)_(?:live|test)_[a-zA-Z0-9]{16,}\b|\bsk-[a-zA-Z0-9]{20,}\b/g,
    severity: "high",
    replacement: "[REDACTED_API_KEY]",
  },
  {
    name: "aws_access_key",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: "high",
    replacement: "[REDACTED_AWS_ACCESS_KEY]",
  },
  {
    name: "jwt",
    regex: /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    severity: "high",
    replacement: "[REDACTED_JWT]",
  },
  {
    name: "generic_secret_assignment",
    regex:
      /\b(api[_\s-]*key|token|secret|password|pwd|access[_\s-]*key)\b(\s*[:=]\s*)([a-zA-Z0-9_\-]{8,})\b/gi,
    severity: "high",
    captureIndex: 3,
    replacement: (_match, captures) => {
      const label = captures[0] ?? "secret";
      const separator = captures[1] ?? ": ";
      return `${label}${separator}${resolveSecretToken(label)}`;
    },
  },
  {
    name: "bank_account",
    regex: /\b(account|acct)\b(\s*[:=]\s*)(\d{6,})\b/gi,
    severity: "high",
    captureIndex: 3,
    replacement: (_match, captures) => {
      const label = captures[0] ?? "account";
      const separator = captures[1] ?? ": ";
      return `${label}${separator}[REDACTED_ACCOUNT_NUMBER]`;
    },
  },
  {
    name: "project_code",
    regex: /\b(project\s*code)\b(\s*[:=]\s*['"]?)([A-Z]-\d{3,})(['"]?)/gi,
    severity: "high",
    captureIndex: 3,
    replacement: (_match, captures) => {
      const label = captures[0] ?? "project code";
      const separator = captures[1] ?? ": ";
      const suffix = captures[3] ?? "";
      return `${label}${separator}[REDACTED_PROJECT_CODE]${suffix}`;
    },
  },
];

function computeRisk(redactionCount: number, highRiskCount: number): RiskLevel {
  // Any high-severity hit escalates risk immediately.
  if (highRiskCount >= 1 || redactionCount >= 5) {
    return "HIGH";
  }
  return "LOW";
}

function computeConfidence(cleanedText: string): RedactionConfidence {
  // Low confidence indicates likely missed sensitive entities after redaction pass.
  const unresolvedSensitivePatterns = [
    /\b\d{3}-\d{2}-\d{4}\b/,
    /\b(?:\d[ -]*?){13,16}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:password|pwd|api[_\s-]*key|token|secret)\b\s*[:=]\s*[a-zA-Z0-9_\-]{8,}/i,
  ];

  for (const pattern of unresolvedSensitivePatterns) {
    if (pattern.test(cleanedText)) {
      return "LOW";
    }
  }
  return "HIGH";
}

export function runPrivacyPipeline(text: string): {
  cleanedText: string;
  redactionCount: number;
  riskLevel: RiskLevel;
  confidence: RedactionConfidence;
  syntheticMap: Record<string, string>;
} {
  // Process text in a single pass over configured regex patterns.
  let cleanedText = text;
  let redactionCount = 0;
  let highRiskCount = 0;
  const syntheticMap: Record<string, string> = {};

  for (const pattern of PATTERNS) {
    cleanedText = cleanedText.replace(pattern.regex, (...args) => {
      const match = args[0] as string;
      const captures = args.slice(1, -2).map((entry) => String(entry ?? ""));
      const replacement =
        typeof pattern.replacement === "function"
          ? pattern.replacement(match, captures)
          : pattern.replacement;
      const sensitiveValue =
        pattern.captureIndex && captures[pattern.captureIndex - 1]
          ? captures[pattern.captureIndex - 1]
          : match;

      // Collect summary counters and synthetic map for observability/debugging.
      redactionCount += 1;
      if (pattern.severity === "high") {
        highRiskCount += 1;
      }
      syntheticMap[sensitiveValue] = replacement;
      return replacement;
    });
  }

  const riskLevel = computeRisk(redactionCount, highRiskCount);
  const confidence = computeConfidence(cleanedText);

  return {
    cleanedText,
    redactionCount,
    riskLevel,
    confidence,
    syntheticMap,
  };
}
