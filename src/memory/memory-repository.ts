// Local LanceDB memory with real embeddings and hybrid search.
import { randomUUID } from "node:crypto";
import type { Connection, Table } from "@lancedb/lancedb";
import { generateEmbedding } from "./embedding-service.js";
import { createLogger } from "../platform/application-logger.js";

export type MemoryRecord = {
  id: string;
  text: string;
  vector: number[];
  createdAt: string;
  // Optional metadata that can be used by UI filters and graph views.
  category?: string;
  source?: string; // 'document' | 'user_fact'
  score?: number; // Used only in search responses.
};

// Logical table split keeps ingested docs and explicit user facts separate.
const DEFAULT_DB_PATH = "data/lancedb";
const DOCUMENTS_TABLE = "documents";
const FACTS_TABLE = "user_facts";

const DB_PATH = process.env.LANCE_DB_PATH ?? DEFAULT_DB_PATH;
const logger = createLogger("memory");

let dbPromise: Promise<Connection> | null = null;
let lancedbPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;

async function loadLanceDb(): Promise<typeof import("@lancedb/lancedb")> {
  // Lazy-load dependency so processes that never query memory can still boot.
  if (!lancedbPromise) {
    lancedbPromise = import("@lancedb/lancedb").catch((error) => {
      throw new Error(
        "LanceDB dependency not installed. Run `npm install @lancedb/lancedb`.\n" +
        (error instanceof Error ? error.message : String(error))
      );
    });
  }
  return lancedbPromise;
}

async function getDb(): Promise<Connection> {
  // Maintain one shared DB connection per process.
  if (!dbPromise) {
    dbPromise = (async () => {
      const lancedb = await loadLanceDb();
      return lancedb.connect(DB_PATH);
    })();
  }
  return dbPromise;
}

// --- Table Management ---

async function getTable(
  db: Connection,
  tableName: string
): Promise<Table | null> {
  // LanceDB throws when opening a missing table, so check names first.
  const names = await db.tableNames();
  if (names.includes(tableName)) {
    return db.openTable(tableName);
  }
  return null;
}

function toSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// --- Write Operations ---

async function saveRecord(
  tableName: string,
  text: string,
  metadata: Partial<MemoryRecord> = {}
): Promise<void> {
  // Write path: embed text, compose record, then append/create table.
  try {
    const vector = await generateEmbedding(text);
    if (vector.length === 0) {
      logger.warn("embedding_empty_vector", {
        tableName,
        sample: text.substring(0, 50),
      });
      return;
    }

    const record: MemoryRecord = {
      id: randomUUID(),
      text,
      vector,
      createdAt: new Date().toISOString(),
      ...metadata,
    };

    const db = await getDb();
    const table = await getTable(db, tableName);

    if (table) {
      await table.add([record]);
    } else {
      await db.createTable(tableName, [record]);
    }
  } catch (error) {
    logger.error("save_record_failed", {
      tableName,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    throw error;
  }
}

export async function saveDocument(text: string, sourceFile?: string): Promise<void> {
  // File chunks are written as "document" source records.
  await saveRecord(DOCUMENTS_TABLE, text, { source: "document", category: sourceFile });
}

export async function saveUserFact(fact: string, category: string = "general"): Promise<void> {
  // Explicit user statements are written to the user facts table.
  await saveRecord(FACTS_TABLE, fact, { source: "user_fact", category });
}

// --- Search Operations ---

type SearchResult = {
  text: string;
  score: number;
  source: string;
  category?: string;
  keywordHits: number;
  phraseMatch: boolean;
};

type MemoryQueryScope = "hybrid" | "facts_only" | "documents_only";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "do",
  "for",
  "i",
  "in",
  "is",
  "me",
  "my",
  "of",
  "on",
  "the",
  "to",
  "what",
  "you",
  "your",
]);

function tokenizeQuery(text: string): string[] {
  return normalizeLexicalText(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function normalizeLexicalText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandTokenVariants(token: string): string[] {
  const variants = new Set<string>([token]);

  if (token.endsWith("ies") && token.length > 4) {
    variants.add(`${token.slice(0, -3)}y`);
  }
  if (token.endsWith("ences") && token.length > 7) {
    variants.add(token.slice(0, -5));
  }
  if (token.endsWith("ence") && token.length > 6) {
    variants.add(token.slice(0, -4));
  }
  if (token.endsWith("es") && token.length > 4) {
    variants.add(token.slice(0, -2));
  }
  if (token.endsWith("s") && token.length > 3) {
    variants.add(token.slice(0, -1));
  }
  if (token.endsWith("ing") && token.length > 5) {
    variants.add(token.slice(0, -3));
  }
  if (token.endsWith("ed") && token.length > 4) {
    variants.add(token.slice(0, -2));
  }

  return [...variants].filter((variant) => variant.length >= 2);
}

function countKeywordHits(text: string, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }

  const lower = normalizeLexicalText(text);
  let hits = 0;
  for (const token of tokens) {
    const variants = expandTokenVariants(token);
    if (variants.some((variant) => lower.includes(variant))) {
      hits += 1;
    }
  }
  return hits;
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

function isLikelyNameText(text: string): boolean {
  // Match common "First Last" forms in title case or uppercase resume headers.
  const titleCase = /\b[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,})+\b/;
  const upperCase = /\b[A-Z]{2,}(?:\s+[A-Z]{2,})+\b/;
  return titleCase.test(text) || upperCase.test(text);
}

function matchesPersonalIntent(text: string, intent: PersonalIntent): boolean {
  if (intent === "name") {
    return isLikelyNameText(text);
  }
  if (intent === "phone") {
    return /\+?\d[\d\s\-()]{7,}\d/.test(text);
  }
  return /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(text);
}

function resolveMemoryQueryScope(): MemoryQueryScope {
  const raw = (process.env.MEMORY_QUERY_SCOPE ?? "hybrid").toLowerCase().trim();
  if (raw === "facts_only" || raw === "user_facts_only" || raw === "facts") {
    return "facts_only";
  }
  if (raw === "documents_only" || raw === "docs_only" || raw === "documents") {
    return "documents_only";
  }
  return "hybrid";
}

function isStrictQueryMatchEnabled(): boolean {
  const raw = (process.env.MEMORY_STRICT_QUERY_MATCH ?? "1").toLowerCase().trim();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

async function searchTable(
  tableName: string,
  queryVector: number[],
  limit: number,
  filterText?: string
): Promise<SearchResult[]> {
  // Base retrieval is vector search; optional keyword hint is applied post-search.
  const db = await getDb();
  const table = await getTable(db, tableName);
  if (!table) return [];

  const query = table.vectorSearch(queryVector).limit(limit);

  const results = (await query.toArray()) as MemoryRecord[];
  const normalizedFilter = normalizeLexicalText(filterText ?? "");
  const filterTokens = tokenizeQuery(normalizedFilter);

  // Map LanceDB rows to normalized search result shape.
  let mapped = results.map((r) => {
    const lexicalText = [r.text, r.category, r.source]
      .filter((value): value is string => Boolean(value && value.trim().length > 0))
      .join(" ");
    const normalizedLexicalText = normalizeLexicalText(lexicalText);

    return {
      text: r.text,
      // LanceDB distance is lower-is-better; keep raw value for stable ranking.
      score: (r as any)._distance ?? 0,
      source: tableName,
      category: r.category,
      keywordHits: countKeywordHits(normalizedLexicalText, filterTokens),
      phraseMatch:
        normalizedFilter.length > 0 &&
        normalizedLexicalText.includes(normalizedFilter),
    };
  });

  if (normalizedFilter) {
    // Lightweight lexical boost keeps exact term matches near the top.
    mapped = mapped.map((r) => {
      if (r.phraseMatch) {
        // Exact phrase match should rank highest.
        r.score = Math.max(0, r.score * 0.5);
      } else if (r.keywordHits > 0) {
        // Any keyword overlap gets a smaller, graded boost.
        const multiplier = Math.max(0.6, 1 - r.keywordHits * 0.1);
        r.score = Math.max(0, r.score * multiplier);
      }
      return r;
    });
  }

  return mapped;
}

export async function searchMemory(
  query: string,
  limit = 5
): Promise<string[]> {
  // Hybrid search: vector retrieval with configurable table scope + lexical guardrails.
  const vector = await generateEmbedding(query);
  if (vector.length === 0) return [];

  const scope = resolveMemoryQueryScope();
  const includeDocuments = scope !== "facts_only";
  const includeFacts = scope !== "documents_only";

  const searches: Promise<SearchResult[]>[] = [];
  if (includeDocuments) {
    searches.push(searchTable(DOCUMENTS_TABLE, vector, limit, query));
  }
  if (includeFacts) {
    searches.push(searchTable(FACTS_TABLE, vector, limit, query));
  }

  const searchGroups = await Promise.all(searches);
  let all = searchGroups.flat();

  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length > 0) {
    const lexicalMatches = all.filter((item) => item.phraseMatch || item.keywordHits > 0);

    if (lexicalMatches.length > 0) {
      all = lexicalMatches;
    } else {
      const personalIntent = detectPersonalIntent(query);
      if (personalIntent) {
        // Identity-style queries (name/phone/email) often don't repeat literal field labels.
        const intentMatches = all.filter((item) => matchesPersonalIntent(item.text, personalIntent));
        if (intentMatches.length > 0) {
          all = intentMatches;
        } else if (isStrictQueryMatchEnabled()) {
          all = [];
        }
      } else if (isStrictQueryMatchEnabled()) {
        // Strict mode prevents unrelated semantic-only matches from leaking into replies.
        all = [];
      }
    }
  }

  // Lower score means closer vector distance.
  all.sort((a, b) => a.score - b.score);

  // Return unique texts so repeated chunks do not dominate the response.
  const unique = new Set<string>();
  const topK: string[] = [];

  for (const item of all) {
    if (unique.has(item.text)) continue;
    unique.add(item.text);
    topK.push(item.text);
    if (topK.length >= limit) break;
  }

  return topK;
}

// Deprecated compatibility shim kept for existing scripts.
export async function saveToMemory(text: string): Promise<void> {
  await saveDocument(text, "unknown_source");
}

export async function getRecentMemories(limit: number = 20): Promise<MemoryRecord[]> {
  const db = await getDb();

  const fetchTable = async (name: string) => {
    const table = await getTable(db, name);
    if (!table) return [];
    // Fetch a bounded window from each table and sort in memory for dashboard views.
    try {
      return (await table.query().limit(100).toArray()) as MemoryRecord[];
    } catch (e) {
      logger.warn("fetch_table_failed", {
        table: name,
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  };

  const [docs, facts] = await Promise.all([
    fetchTable(DOCUMENTS_TABLE),
    fetchTable(FACTS_TABLE),
  ]);

  const all = [
    ...docs.map((r) => ({ ...r, source: "document" })),
    ...facts.map((r) => ({ ...r, source: "user_fact" })),
  ];

  // Newest first for operational dashboard readability.
  all.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return all.slice(0, limit);
}

export async function deleteDocumentsBySourceFile(sourceFile: string): Promise<number> {
  const normalizedSource = sourceFile.trim();
  if (!normalizedSource) {
    return 0;
  }

  const db = await getDb();
  const table = await getTable(db, DOCUMENTS_TABLE);
  if (!table) {
    return 0;
  }

  const predicate = `category = ${toSqlStringLiteral(normalizedSource)}`;
  const beforeCount = await table.countRows(predicate);
  if (beforeCount <= 0) {
    return 0;
  }

  await table.delete(predicate);
  return beforeCount;
}

export async function clearAllDocuments(): Promise<number> {
  const db = await getDb();
  const table = await getTable(db, DOCUMENTS_TABLE);
  if (!table) {
    return 0;
  }

  const predicate = `source = ${toSqlStringLiteral("document")}`;
  const beforeCount = await table.countRows(predicate);
  if (beforeCount <= 0) {
    return 0;
  }

  await table.delete(predicate);
  return beforeCount;
}

export async function clearAllUserFacts(): Promise<number> {
  const db = await getDb();
  const table = await getTable(db, FACTS_TABLE);
  if (!table) {
    return 0;
  }

  const predicate = `source = ${toSqlStringLiteral("user_fact")}`;
  const beforeCount = await table.countRows(predicate);
  if (beforeCount <= 0) {
    return 0;
  }

  await table.delete(predicate);
  return beforeCount;
}
