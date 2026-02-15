// Centralized runtime configuration parsing and validation.
export type RuntimeConfig = {
  nodeEnv: string;
  logLevel: string;
  archestraEnabled: boolean;
  archestraProvider: "openai" | "gemini";
  embeddingProvider: "openai" | "gemini" | "local";
  chunkSize: number;
  dashboardEnabled: boolean;
  dashboardPort: number;
  healthPort: number;
  healthHost: string;
};

export type ConfigValidationResult = {
  config: RuntimeConfig;
  warnings: string[];
  errors: string[];
};

const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_DASHBOARD_PORT = 8787;
const DEFAULT_HEALTH_PORT = 0;
const DEFAULT_HEALTH_HOST = "127.0.0.1";

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeArchestraProvider(
  raw: string | undefined
): "openai" | "gemini" {
  const provider = (raw ?? "openai").toLowerCase().trim();
  if (provider === "gemini" || provider === "google") {
    return "gemini";
  }
  return "openai";
}

function normalizeEmbeddingProvider(
  raw: string | undefined
): "openai" | "gemini" | "local" {
  const provider = (raw ?? "local").toLowerCase().trim();
  if (provider === "gemini" || provider === "google") {
    return "gemini";
  }
  if (
    provider === "openai" ||
    provider === "chatgpt" ||
    provider === "claude" ||
    provider === "anthropic" ||
    provider === "openai-compatible"
  ) {
    return "openai";
  }
  return "local";
}

function hasGeminiProfileInBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  return /\/v1\/gemini\/[^/]+/i.test(baseUrl);
}

function hasOpenAiProfileInBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  return /\/v1\/openai\/[^/]+/i.test(baseUrl);
}

function isLikelyArchestraToken(value: string | undefined): boolean {
  return Boolean(value?.startsWith("archestra_"));
}

function hasValue(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

export function validateRuntimeConfig(
  env: NodeJS.ProcessEnv
): ConfigValidationResult {
  // Return warnings/errors instead of throwing so startup can emit complete diagnostics.
  const warnings: string[] = [];
  const errors: string[] = [];

  const archestraEnabled = parseBoolean(env.ARCHESTRA_ENABLE, false);
  const archestraProvider = normalizeArchestraProvider(env.ARCHESTRA_PROVIDER);
  const embeddingProvider = normalizeEmbeddingProvider(env.EMBEDDING_PROVIDER);
  const chunkSize = parsePositiveInt(env.CHUNK_SIZE, DEFAULT_CHUNK_SIZE);
  const dashboardEnabled = parseBoolean(env.DASHBOARD_ENABLE, false);
  const dashboardPort = parsePositiveInt(
    env.DASHBOARD_PORT,
    DEFAULT_DASHBOARD_PORT
  );
  const healthPort = parsePositiveInt(env.HEALTH_PORT, DEFAULT_HEALTH_PORT);
  const healthHost = env.HEALTH_HOST?.trim() || DEFAULT_HEALTH_HOST;
  const archestraExtractive = parseBoolean(env.ARCHESTRA_EXTRACTIVE_MODE, false);

  if (chunkSize === 0) {
    warnings.push(
      "CHUNK_SIZE is 0. Falling back to 500 is recommended for predictable ingestion."
    );
  }

  if (dashboardEnabled && dashboardPort <= 0) {
    errors.push("DASHBOARD_ENABLE=1 requires DASHBOARD_PORT > 0.");
  }

  if (healthPort < 0 || healthPort > 65535) {
    errors.push("HEALTH_PORT must be between 0 and 65535.");
  }

  if (archestraEnabled) {
    // Provider-specific key/profile checks catch common setup mistakes early.
    if (archestraProvider === "gemini") {
      const geminiKey =
        env.ARCHESTRA_GEMINI_API_KEY ?? env.GEMINI_API_KEY ?? "";
      const profileConfigured =
        hasValue(env.ARCHESTRA_PROFILE_ID) ||
        hasGeminiProfileInBaseUrl(env.ARCHESTRA_GEMINI_BASE_URL);

      if (!archestraExtractive && !hasValue(geminiKey)) {
        errors.push(
          "ARCHESTRA_ENABLE=1 with Gemini requires ARCHESTRA_GEMINI_API_KEY (or GEMINI_API_KEY), unless ARCHESTRA_EXTRACTIVE_MODE=1."
        );
      }

      if (isLikelyArchestraToken(geminiKey)) {
        errors.push(
          "Gemini key format is invalid. Use provider key (typically starts with 'AIza'), not archestra_ token."
        );
      }

      if (!profileConfigured) {
        errors.push(
          "Gemini profile is missing. Set ARCHESTRA_PROFILE_ID or include profile ID in ARCHESTRA_GEMINI_BASE_URL."
        );
      }
    } else {
      const openAiLikeKey = env.ARCHESTRA_API_KEY ?? env.OPENAI_API_KEY ?? "";
      const openAiBase = env.ARCHESTRA_BASE_URL;

      if (!archestraExtractive && !hasValue(openAiLikeKey)) {
        warnings.push(
          "ARCHESTRA_ENABLE=1 with OpenAI-compatible provider usually requires ARCHESTRA_API_KEY/OPENAI_API_KEY when not in extractive mode."
        );
      }
      if (hasValue(openAiBase) && !hasOpenAiProfileInBaseUrl(openAiBase)) {
        warnings.push(
          "ARCHESTRA_BASE_URL has no profile segment. If required by your gateway, append /<profile_id>."
        );
      }
    }
  }

  if (embeddingProvider === "openai") {
    const embeddingKey =
      env.ARCHESTRA_EMBEDDING_API_KEY ??
      env.ARCHESTRA_API_KEY ??
      env.OPENAI_API_KEY ??
      "";
    if (!hasValue(embeddingKey)) {
      errors.push(
        "EMBEDDING_PROVIDER=openai requires ARCHESTRA_EMBEDDING_API_KEY, ARCHESTRA_API_KEY, or OPENAI_API_KEY."
      );
    }
  }

  if (embeddingProvider === "gemini") {
    const embeddingGeminiKey =
      env.ARCHESTRA_EMBEDDING_GEMINI_API_KEY ??
      env.ARCHESTRA_GEMINI_API_KEY ??
      env.GEMINI_API_KEY ??
      "";
    if (!hasValue(embeddingGeminiKey)) {
      errors.push(
        "EMBEDDING_PROVIDER=gemini requires ARCHESTRA_EMBEDDING_GEMINI_API_KEY, ARCHESTRA_GEMINI_API_KEY, or GEMINI_API_KEY."
      );
    }
    if (isLikelyArchestraToken(embeddingGeminiKey)) {
      errors.push(
        "Gemini embedding key format is invalid. Use provider key (typically starts with 'AIza'), not archestra_ token."
      );
    }
  }

  const config: RuntimeConfig = {
    nodeEnv: env.NODE_ENV ?? "development",
    logLevel: env.LOG_LEVEL ?? "info",
    archestraEnabled,
    archestraProvider,
    embeddingProvider,
    chunkSize: chunkSize > 0 ? chunkSize : DEFAULT_CHUNK_SIZE,
    dashboardEnabled,
    dashboardPort:
      dashboardPort > 0 ? dashboardPort : DEFAULT_DASHBOARD_PORT,
    healthPort,
    healthHost,
  };

  return {
    config,
    warnings,
    errors,
  };
}
