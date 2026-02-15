// Archestra provider wrapper: OpenAI-compatible or Gemini proxy with strict grounding.
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ArchestraOptions = {
  baseURL?: string;
  profileId?: string;
  apiKey?: string;
  model?: string;
  provider?: "openai" | "gemini" | "chatgpt" | "claude" | "anthropic";
  geminiBaseURL?: string;
  geminiApiKey?: string;
  agentId?: string;
};

const DEFAULT_BASE_URL = "http://localhost:9000/v1/openai";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_GEMINI_BASE_URL = "http://localhost:9000/v1/gemini";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const FALLBACK_ANSWER = "I don't know based on the provided context.";
const DEFAULT_GROUNDING_MODE = "excerpt";
const DEFAULT_EXTRACTIVE_MODE = "0";

let openaiPromise: Promise<typeof import("openai")> | null = null;

async function loadOpenAI(): Promise<typeof import("openai")> {
  // Cache the dynamic import so repeated calls do not reload the SDK.
  if (!openaiPromise) {
    openaiPromise = import("openai").catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(
        "OpenAI SDK not installed. Run `npm install openai` and retry.\n" +
          message
      );
    });
  }
  return openaiPromise;
}

function normalizeProfileId(profileId?: string): string | undefined {
  // Accept either raw UUID or full proxy URL and normalize to plain UUID segment.
  if (!profileId) {
    return undefined;
  }
  const trimmed = profileId.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/").filter(Boolean);
    return parts[parts.length - 1];
  }
  return trimmed;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function extractProxyProfileId(baseURL: string, provider: "openai" | "gemini"): string | undefined {
  const pattern =
    provider === "openai"
      ? /\/v1\/openai\/([^/]+)/i
      : /\/v1\/gemini\/([^/]+)/i;
  const match = baseURL.match(pattern);
  return match?.[1];
}

function resolveBaseURL(baseURL?: string, profileId?: string): string {
  // Allow either full proxy URL or base URL + profile id composition.
  const normalizedProfileId = normalizeProfileId(profileId);
  const base = stripTrailingSlash(baseURL ?? DEFAULT_BASE_URL);
  const profileFromBase = extractProxyProfileId(base, "openai");

  if (profileFromBase) {
    return base;
  }
  if (normalizedProfileId) {
    return `${base}/${normalizedProfileId}`;
  }
  return base;
}

function resolveGeminiBaseURL(baseURL?: string, profileId?: string): string {
  // Normalized output always points to Gemini v1beta endpoint with profile in path.
  const normalizedProfileId = normalizeProfileId(profileId);
  const rawBase = stripTrailingSlash(baseURL ?? DEFAULT_GEMINI_BASE_URL);
  const base = rawBase.replace(/\/v1beta$/i, "");
  const profileFromBase = extractProxyProfileId(base, "gemini");
  const resolvedProfileId = profileFromBase ?? normalizedProfileId;
  const withProfile = profileFromBase
    ? base
    : resolvedProfileId
      ? `${base}/${resolvedProfileId}`
      : base;

  if (!extractProxyProfileId(withProfile, "gemini")) {
    throw new Error(
      "Missing Gemini profile ID. Set ARCHESTRA_PROFILE_ID or include it in ARCHESTRA_GEMINI_BASE_URL."
    );
  }
  return `${withProfile}/v1beta`;
}

function resolveApiKey(explicitKey?: string): string | null {
  // Prefer call-time key and then fall back to environment keys.
  if (explicitKey) {
    return explicitKey;
  }
  return process.env.ARCHESTRA_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
}

function resolveGeminiApiKey(explicitKey?: string): string | null {
  // Keep Gemini key resolution independent from OpenAI-compatible keys.
  if (explicitKey) {
    return explicitKey;
  }
  return process.env.ARCHESTRA_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? null;
}

function resolveAgentId(explicitId?: string): string | null {
  // Agent ID is optional and only used for Archestra telemetry headers.
  if (explicitId) {
    return explicitId;
  }
  return process.env.ARCHESTRA_AGENT_ID ?? null;
}

function resolveProvider(explicit?: ArchestraOptions["provider"]): ArchestraOptions["provider"] {
  // Normalize common provider aliases to internal routing keys.
  if (explicit) {
    return explicit;
  }
  const envProvider = process.env.ARCHESTRA_PROVIDER?.toLowerCase().trim();
  if (envProvider === "gemini" || envProvider === "google") {
    return "gemini";
  }
  if (
    envProvider === "chatgpt" ||
    envProvider === "claude" ||
    envProvider === "anthropic" ||
    envProvider === "openai-compatible"
  ) {
    return "openai";
  }
  return "openai";
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isExtractiveMode(): boolean {
  const value = (process.env.ARCHESTRA_EXTRACTIVE_MODE ?? DEFAULT_EXTRACTIVE_MODE).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function isTokenMatch(queryToken: string, lineToken: string): boolean {
  return (
    lineToken === queryToken ||
    lineToken.startsWith(queryToken) ||
    queryToken.startsWith(lineToken)
  );
}

type PersonalIntent = "name" | "phone" | "email";

function detectPersonalIntent(query: string): PersonalIntent | null {
  const normalized = query.toLowerCase();
  if (/\bname\b/.test(normalized)) {
    return "name";
  }
  if (/\b(phone|mobile|contact)\b/.test(normalized)) {
    return "phone";
  }
  if (/\bemail\b/.test(normalized)) {
    return "email";
  }
  return null;
}

function lineMatchesPersonalIntent(line: string, intent: PersonalIntent): boolean {
  if (intent === "name") {
    // Support both title-case and all-caps name lines.
    return (
      /\b[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})+\b/.test(line) ||
      /\b[A-Z]{2,}(?:\s+[A-Z]{2,})+\b/.test(line)
    );
  }
  if (intent === "phone") {
    return /\+?\d[\d\s\-()]{7,}\d/.test(line);
  }
  return /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(line);
}

function pickExtractiveLine(context: string, query: string): string | null {
  // Lightweight lexical scorer used for deterministic fallback mode.
  const lines = context
    .split("\n")
    .map((line) => line.replace(/^\[\d+\]\s*/, "").trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  const queryTokens = tokenize(query);
  const personalIntent = detectPersonalIntent(query);
  if (queryTokens.length === 0) {
    if (personalIntent) {
      const intentLine = lines.find((line) =>
        lineMatchesPersonalIntent(line, personalIntent)
      );
      if (intentLine) {
        return intentLine;
      }
    }
    return lines[0] ?? null;
  }

  let bestLine: string | null = null;
  let bestScore = -1;

  for (const line of lines) {
    const lineTokens = tokenize(line);
    let score = 0;
    for (const token of queryTokens) {
      if (lineTokens.some((lineToken) => isTokenMatch(token, lineToken))) {
        score += 1;
      }
    }
    if (personalIntent && lineMatchesPersonalIntent(line, personalIntent)) {
      // Identity queries often omit literal field labels; add intent signal.
      score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = line;
    }
  }

  if (bestScore <= 0) {
    return null;
  }
  return bestLine;
}

function isGroundedAnswer(answer: string, context: string): boolean {
  // Grounding check ensures response text is actually present in sanitized context.
  const normalizedAnswer = normalizeLine(answer);
  if (normalizedAnswer.length < 6) {
    return false;
  }
  if (!/[a-z0-9]{3,}/i.test(normalizedAnswer)) {
    return false;
  }

  const lines = context
    .split("\n")
    .map((line) => normalizeLine(line.replace(/^\[\d+\]\s*/, "")))
    .filter((line) => line.length >= 8);

  const mode =
    (process.env.ARCHESTRA_GROUNDING_MODE ?? DEFAULT_GROUNDING_MODE).toLowerCase();
  if (mode === "exact") {
    return lines.some((line) => line === normalizedAnswer);
  }
  return lines.some((line) => line.includes(normalizedAnswer));
}

function enforceGrounding(answer: string, context: string, query: string): string {
  const trimmed = answer.trim();
  if (!trimmed) {
    return pickExtractiveLine(context, query) ?? FALLBACK_ANSWER;
  }
  if (trimmed === FALLBACK_ANSWER) {
    // When model defaults to fallback despite available context, prefer deterministic extractive recovery.
    return pickExtractiveLine(context, query) ?? trimmed;
  }
  if (isGroundedAnswer(trimmed, context)) {
    return trimmed;
  }
  // Model sometimes ignores strict grounding prompts; recover by extractive fallback.
  return pickExtractiveLine(context, query) ?? FALLBACK_ANSWER;
}

function isLikelyArchestraToken(value: string): boolean {
  return value.startsWith("archestra_");
}

async function generateOpenAIAnswer(options: {
  systemContext: string;
  userQuery: string;
  redactionCount: number;
  riskLevel: string;
  archestra?: ArchestraOptions;
}): Promise<string> {
  // OpenAI-compatible request with strict system prompt + grounding enforcement.
  const apiKey = resolveApiKey(options.archestra?.apiKey);
  if (!apiKey) {
    throw new Error("Missing API key. Set ARCHESTRA_API_KEY or OPENAI_API_KEY.");
  }

  const OpenAI = (await loadOpenAI()).default;
  const baseURL = resolveBaseURL(
    options.archestra?.baseURL ?? process.env.ARCHESTRA_BASE_URL,
    options.archestra?.profileId ?? process.env.ARCHESTRA_PROFILE_ID
  );
  const model = options.archestra?.model ?? process.env.ARCHESTRA_MODEL ?? DEFAULT_MODEL;
  const agentId = resolveAgentId(options.archestra?.agentId);

  const client = new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: agentId ? { "X-Archestra-Agent-Id": agentId } : undefined,
  });

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        // Keep prompt deterministic to maximize extractive answers from proxy models.
        "You are a secure assistant.",
        "You MUST answer using ONLY the provided sanitized context.",
        "Your answer MUST be a verbatim quote or excerpt from the sanitized context.",
        "Do NOT add assumptions or external knowledge.",
        "If the answer is not explicitly in the context, reply exactly:",
        "\"I don't know based on the provided context.\"",
        "",
        "SANITIZED_CONTEXT:",
        options.systemContext,
        "",
        `Redactions: ${options.redactionCount}`,
        `Risk: ${options.riskLevel}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: options.userQuery,
    },
  ];

  const response = await client.chat.completions.create({
    model,
    messages,
  });

  const content = response.choices?.[0]?.message?.content ?? "";
  return enforceGrounding(content, options.systemContext, options.userQuery);
}

async function generateGeminiAnswer(options: {
  systemContext: string;
  userQuery: string;
  redactionCount: number;
  riskLevel: string;
  archestra?: ArchestraOptions;
}): Promise<string> {
  // Gemini proxy request with strict system instruction + grounding enforcement.
  const apiKey = resolveGeminiApiKey(options.archestra?.geminiApiKey);
  if (!apiKey) {
    throw new Error(
      "Missing Gemini API key. Set ARCHESTRA_GEMINI_API_KEY or GEMINI_API_KEY."
    );
  }
  if (isLikelyArchestraToken(apiKey)) {
    throw new Error(
      "Invalid Gemini key format. Use provider API key (typically starts with 'AIza'), not Archestra personal token."
    );
  }

  const baseURL = resolveGeminiBaseURL(
    options.archestra?.geminiBaseURL ?? process.env.ARCHESTRA_GEMINI_BASE_URL,
    options.archestra?.profileId ?? process.env.ARCHESTRA_PROFILE_ID
  );
  const model =
    options.archestra?.model ?? process.env.ARCHESTRA_MODEL ?? DEFAULT_GEMINI_MODEL;
  const url = `${baseURL}/models/${model}:generateContent`;
  const agentId = resolveAgentId(options.archestra?.agentId);

  const systemInstruction = [
    "You are a secure assistant.",
    "You MUST answer using ONLY the provided sanitized context.",
    "Your answer MUST be a verbatim quote or excerpt from the sanitized context.",
    "Do NOT add assumptions or external knowledge.",
    "If the answer is not explicitly in the context, reply exactly:",
    "\"I don't know based on the provided context.\"",
    "",
    "SANITIZED_CONTEXT:",
    options.systemContext,
    "",
    `Redactions: ${options.redactionCount}`,
    `Risk: ${options.riskLevel}`,
  ].join("\n");

  const payload = {
    // Gemini receives the same grounding policy through system_instruction.
    system_instruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: options.userQuery }],
      },
    ],
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-goog-api-key": apiKey,
  };
  if (agentId) {
    headers["X-Archestra-Agent-Id"] = agentId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (
      response.status === 400 &&
      /Invalid UUID|LLMProxy ID/i.test(errorText)
    ) {
      throw new Error(
        "Gemini profile ID is invalid. Set ARCHESTRA_PROFILE_ID to the UUID shown in Archestra LLM Proxy UI."
      );
    }
    if (
      /API key not valid|API_KEY_INVALID|Gemini key format/i.test(errorText)
    ) {
      throw new Error(
        "Gemini API key is invalid. Set ARCHESTRA_GEMINI_API_KEY to your provider key (typically starts with 'AIza')."
      );
    }
    throw new Error(`Gemini request failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return enforceGrounding(text, options.systemContext, options.userQuery);
}

export async function generateArchestraAnswer(options: {
  systemContext: string;
  userQuery: string;
  redactionCount: number;
  riskLevel: string;
  archestra?: ArchestraOptions;
}): Promise<string> {
  // Extractive mode bypasses remote generation for strict privacy/reliability.
  if (isExtractiveMode()) {
    const extracted = pickExtractiveLine(options.systemContext, options.userQuery);
    return extracted ?? FALLBACK_ANSWER;
  }

  // Route to provider-specific runtime while keeping a shared calling contract.
  const provider = resolveProvider(options.archestra?.provider);
  if (provider === "gemini") {
    return generateGeminiAnswer(options);
  }
  return generateOpenAIAnswer(options);
}
