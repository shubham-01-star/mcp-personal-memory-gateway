import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { createLogger } from "../platform/application-logger.js";

// Persistent cache keeps repeated local runs fast and cheap.
const CACHE_DIR = ".cache";
const CACHE_FILE = path.join(CACHE_DIR, "embeddings.json");

const DEFAULT_OPENAI_BASE_URL = "http://localhost:9000/v1/openai";
const DEFAULT_GEMINI_BASE_URL = "http://localhost:9000/v1/gemini";
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_GEMINI_MODEL = "text-embedding-004";
const DEFAULT_LOCAL_MODEL = "local-hash-768";
const DEFAULT_LOCAL_DIMENSION = 768;

type EmbeddingProvider = "openai" | "gemini" | "local";
type EmbeddingCache = Record<string, number[]>;

let cache: EmbeddingCache = {};
let cacheLoaded = false;
const logger = createLogger("embeddings");

async function loadCache() {
  // Load cache only once per process to avoid repeated disk reads.
  if (cacheLoaded) return;

  try {
    if (existsSync(CACHE_FILE)) {
      const data = await readFile(CACHE_FILE, "utf-8");
      cache = JSON.parse(data) as EmbeddingCache;
    }
  } catch (error) {
    logger.warn("cache_load_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  cacheLoaded = true;
}

async function saveCache() {
  // Cache writes are best-effort; embedding generation should continue on failures.
  try {
    if (!existsSync(CACHE_DIR)) {
      await mkdir(CACHE_DIR, { recursive: true });
    }
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (error) {
    logger.warn("cache_save_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeProfileId(profileId?: string): string | undefined {
  // Convert profile values like "/v1/openai/<id>" to "<id>" for URL composition.
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

function isLikelyArchestraToken(value: string): boolean {
  return value.startsWith("archestra_");
}

function resolveEmbeddingProvider(): EmbeddingProvider {
  // Explicit provider wins; otherwise infer from available keys and chat provider.
  const explicit = process.env.EMBEDDING_PROVIDER?.toLowerCase().trim();
  if (explicit === "gemini" || explicit === "google") {
    return "gemini";
  }
  if (explicit === "local" || explicit === "offline") {
    return "local";
  }
  if (
    explicit === "openai" ||
    explicit === "chatgpt" ||
    explicit === "claude" ||
    explicit === "anthropic" ||
    explicit === "openai-compatible"
  ) {
    return "openai";
  }

  const hasGeminiKey = Boolean(
    process.env.ARCHESTRA_EMBEDDING_GEMINI_API_KEY ??
      process.env.ARCHESTRA_GEMINI_API_KEY ??
      process.env.GEMINI_API_KEY
  );
  const hasOpenAIKey = Boolean(
    process.env.ARCHESTRA_EMBEDDING_API_KEY ??
      process.env.ARCHESTRA_API_KEY ??
      process.env.OPENAI_API_KEY
  );
  const chatProvider = process.env.ARCHESTRA_PROVIDER?.toLowerCase().trim();
  if ((chatProvider === "gemini" || chatProvider === "google") && hasGeminiKey) {
    return "gemini";
  }
  if (chatProvider === "local" || chatProvider === "offline") {
    return "local";
  }
  if (hasOpenAIKey) {
    return "openai";
  }
  if (hasGeminiKey) {
    return "gemini";
  }
  return "local";
}

function resolveTargetDimension(): number {
  // Keep vector dimension configurable so storage schema and model output stay aligned.
  const parsed = Number(process.env.MEMORY_VECTOR_DIM ?? process.env.EMBEDDING_DIM);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return DEFAULT_LOCAL_DIMENSION;
}

function alignVectorDimension(vector: number[], targetDimension: number): number[] {
  // Force deterministic vector size by trimming or zero-padding.
  if (!Number.isFinite(targetDimension) || targetDimension <= 0) {
    return vector;
  }
  if (vector.length === targetDimension) {
    return vector;
  }
  if (vector.length > targetDimension) {
    return vector.slice(0, targetDimension);
  }
  return [...vector, ...new Array(targetDimension - vector.length).fill(0)];
}

function normalize(vector: number[]): number[] {
  // Unit-normalization improves similarity search consistency for local vectors.
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vector;
  return vector.map((val) => val / norm);
}

function resolveOpenAIBaseURL(): string {
  // Support both a full proxy URL and base URL + profile ID composition.
  const configured = process.env.ARCHESTRA_EMBEDDING_BASE_URL ?? process.env.ARCHESTRA_BASE_URL;
  const baseURL = stripTrailingSlash(configured ?? DEFAULT_OPENAI_BASE_URL);
  const normalizedProfileId = normalizeProfileId(process.env.ARCHESTRA_PROFILE_ID);
  const profileFromBase = extractProxyProfileId(baseURL, "openai");
  if (profileFromBase) {
    return baseURL;
  }
  return normalizedProfileId ? `${baseURL}/${normalizedProfileId}` : baseURL;
}

function resolveOpenAIKey(): string | null {
  return (
    process.env.ARCHESTRA_EMBEDDING_API_KEY ??
    process.env.ARCHESTRA_API_KEY ??
    process.env.OPENAI_API_KEY ??
    null
  );
}

function resolveGeminiBaseURL(): string {
  const configured =
    process.env.ARCHESTRA_EMBEDDING_GEMINI_BASE_URL ??
    process.env.ARCHESTRA_GEMINI_BASE_URL;
  const rawBase = stripTrailingSlash(configured ?? DEFAULT_GEMINI_BASE_URL);
  const base = rawBase.replace(/\/v1beta$/i, "");
  const normalizedProfileId = normalizeProfileId(process.env.ARCHESTRA_PROFILE_ID);
  const profileFromBase = extractProxyProfileId(base, "gemini");
  const withProfile = profileFromBase
    ? base
    : normalizedProfileId
      ? `${base}/${normalizedProfileId}`
      : base;

  if (!extractProxyProfileId(withProfile, "gemini")) {
    throw new Error(
      "Missing Gemini profile ID for embeddings. Set ARCHESTRA_PROFILE_ID or include it in ARCHESTRA_GEMINI_BASE_URL."
    );
  }
  return `${withProfile}/v1beta`;
}

function resolveGeminiKey(): string | null {
  return (
    process.env.ARCHESTRA_EMBEDDING_GEMINI_API_KEY ??
    process.env.ARCHESTRA_GEMINI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    null
  );
}

function resolveEmbeddingModel(provider: EmbeddingProvider): string {
  const configured = process.env.ARCHESTRA_EMBEDDING_MODEL ?? process.env.EMBEDDING_MODEL;
  if (configured && configured.trim()) {
    return configured.trim();
  }
  if (provider === "gemini") {
    return DEFAULT_GEMINI_MODEL;
  }
  if (provider === "local") {
    return DEFAULT_LOCAL_MODEL;
  }
  return DEFAULT_OPENAI_MODEL;
}

function createOpenAIClient(): OpenAI {
  // OpenAI SDK is used for both direct OpenAI and OpenAI-compatible Archestra proxies.
  const apiKey = resolveOpenAIKey();
  if (!apiKey) {
    throw new Error(
      "Missing OpenAI-compatible embedding key. Set ARCHESTRA_EMBEDDING_API_KEY or ARCHESTRA_API_KEY."
    );
  }

  const agentId = process.env.ARCHESTRA_AGENT_ID;
  return new OpenAI({
    apiKey,
    baseURL: resolveOpenAIBaseURL(),
    defaultHeaders: agentId ? { "X-Archestra-Agent-Id": agentId } : undefined,
  });
}

async function generateOpenAIEmbedding(text: string, model: string): Promise<number[]> {
  // OpenAI-compatible embedding call shape.
  const client = createOpenAIClient() as any;
  const response = await client.embeddings.create({
    model,
    input: text,
  });

  const vector = response?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error("OpenAI-compatible embedding response missing vector.");
  }
  return vector;
}

async function generateGeminiEmbedding(text: string, model: string): Promise<number[]> {
  // Gemini proxy call is performed over HTTP because SDK routes are provider-specific.
  const apiKey = resolveGeminiKey();
  if (!apiKey) {
    throw new Error(
      "Missing Gemini embedding key. Set ARCHESTRA_EMBEDDING_GEMINI_API_KEY or ARCHESTRA_GEMINI_API_KEY."
    );
  }
  if (isLikelyArchestraToken(apiKey)) {
    throw new Error(
      "Invalid Gemini embedding key format. Use provider API key (typically starts with 'AIza'), not Archestra personal token."
    );
  }

  const agentId = process.env.ARCHESTRA_AGENT_ID;
  const url = `${resolveGeminiBaseURL()}/models/${model}:embedContent`;
  const targetDimension = resolveTargetDimension();

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-goog-api-key": apiKey,
  };
  if (agentId) {
    headers["X-Archestra-Agent-Id"] = agentId;
  }

  const payload = {
    // Request the target dimensionality to match local vector storage settings.
    content: {
      parts: [{ text }],
    },
    outputDimensionality: targetDimension,
  };

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
        "Gemini embedding profile ID is invalid. Set ARCHESTRA_PROFILE_ID to the UUID shown in Archestra LLM Proxy UI."
      );
    }
    if (/API key not valid|API_KEY_INVALID|Gemini key format/i.test(errorText)) {
      throw new Error(
        "Gemini embedding API key is invalid. Set ARCHESTRA_GEMINI_API_KEY (or ARCHESTRA_EMBEDDING_GEMINI_API_KEY) to your provider key starting with 'AIza'."
      );
    }
    throw new Error(`Gemini embedding failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    embedding?: {
      values?: number[];
    };
  };
  const vector = data.embedding?.values;
  if (!Array.isArray(vector)) {
    throw new Error("Gemini embedding response missing vector.");
  }
  return vector;
}

function generateLocalEmbedding(text: string, dimension: number): number[] {
  // Deterministic hash-based fallback for offline or keyless development workflows.
  const digest = createHash("sha256").update(text).digest();
  const vector = new Array<number>(dimension);

  for (let i = 0; i < dimension; i += 1) {
    const base = digest[i % digest.length] ?? 0;
    const mixed = (base + i * 31) % 256;
    vector[i] = mixed / 127.5 - 1;
  }

  return normalize(vector);
}

function cacheKeyFor(text: string, provider: EmbeddingProvider, model: string): string {
  return createHash("md5").update(`${provider}|${model}|${text}`).digest("hex");
}

export async function generateEmbedding(text: string): Promise<number[]> {
  // Main flow: normalize -> cache lookup -> provider call -> dimension align -> cache write.
  await loadCache();

  const normalizedText = text.trim().replace(/\s+/g, " ");
  if (!normalizedText) {
    return [];
  }

  const provider = resolveEmbeddingProvider();
  const model = resolveEmbeddingModel(provider);
  const key = cacheKeyFor(normalizedText, provider, model);

  if (cache[key]) {
    return cache[key];
  }

  try {
    let vector: number[];
    if (provider === "gemini") {
      vector = await generateGeminiEmbedding(normalizedText, model);
    } else if (provider === "local") {
      vector = generateLocalEmbedding(normalizedText, resolveTargetDimension());
    } else {
      vector = await generateOpenAIEmbedding(normalizedText, model);
    }

    const aligned = alignVectorDimension(vector, resolveTargetDimension());
    cache[key] = aligned;
    saveCache().catch((error) => {
      logger.warn("cache_persist_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return aligned;
  } catch (error) {
    logger.error("embedding_generation_failed", {
      provider,
      model,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    throw error;
  }
}
