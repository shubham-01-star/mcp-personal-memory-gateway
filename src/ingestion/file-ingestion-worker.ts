// Ingestion pipeline: extract text from files, chunk, and store in local memory.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { saveDocument } from "../memory/memory-repository.js";
import { publishEvent } from "../observability/event-bus.js";
import { createLogger } from "../platform/application-logger.js";

const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_MANIFEST_PATH = "data/ingestion-manifest.json";
export const SUPPORTED_INGEST_EXTENSIONS = [
  ".txt",
  ".md",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
];
const SUPPORTED_EXTENSIONS = new Set(SUPPORTED_INGEST_EXTENSIONS);
const DEBUG = process.env.INGEST_DEBUG === "1";
const logger = createLogger("ingestion");

function log(...args: unknown[]) {
  // Debug logging is intentionally gated to keep normal runs quiet.
  if (DEBUG) {
    logger.debug("ingestion_debug", { args });
  }
}

type PdfParseFn = (
  data: Buffer | Uint8Array | ArrayBuffer
) => Promise<{ text: string }>;

type PdfParseClass = new (options: {
  data: Buffer | Uint8Array | ArrayBuffer;
}) => {
  getText(): Promise<{ text: string }>;
  destroy?: () => Promise<void> | void;
};

let pdfParsePromise: Promise<typeof import("pdf-parse")> | null = null;
let chokidarPromise: Promise<typeof import("chokidar")> | null = null;
let tesseractPromise: Promise<unknown> | null = null;
let manifestPromise: Promise<IngestionManifest> | null = null;
let manifestWritePromise: Promise<void> = Promise.resolve();

type IngestionManifest = Record<
  string,
  {
    mtimeMs: number;
    size: number;
  }
>;

async function loadPdfParse(): Promise<typeof import("pdf-parse")> {
  // Lazy-load dependency so runtime can start even without PDF support installed.
  if (!pdfParsePromise) {
    pdfParsePromise = import("pdf-parse").catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(
        "pdf-parse dependency not installed. Run `npm install pdf-parse` and retry.\n" +
          message
      );
    });
  }
  return pdfParsePromise;
}

function resolvePdfParseExports(module: unknown): {
  parseFn?: PdfParseFn;
  parseClass?: PdfParseClass;
} {
  // Support both CJS and ESM export shapes used by different pdf-parse versions.
  if (!module || (typeof module !== "object" && typeof module !== "function")) {
    return {};
  }

  const mod = module as any;

  if (typeof mod === "function") {
    return { parseFn: mod as PdfParseFn };
  }

  if (typeof mod.default === "function") {
    return { parseFn: mod.default as PdfParseFn };
  }

  if (typeof mod.default?.default === "function") {
    return { parseFn: mod.default.default as PdfParseFn };
  }

  if (typeof mod.PDFParse === "function") {
    return { parseClass: mod.PDFParse as PdfParseClass };
  }

  if (typeof mod.default?.PDFParse === "function") {
    return { parseClass: mod.default.PDFParse as PdfParseClass };
  }

  if (typeof mod.pdf === "function") {
    return { parseFn: mod.pdf as PdfParseFn };
  }

  return {};
}

async function loadPdfParseModule(): Promise<unknown> {
  // Prefer require() for CJS compatibility; fall back to dynamic import for ESM.
  try {
    const require = createRequire(import.meta.url);
    return require("pdf-parse");
  } catch {
    return loadPdfParse();
  }
}

async function loadChokidar(): Promise<typeof import("chokidar")> {
  // File watcher is loaded on demand for CLI flows that only call ingestFile().
  if (!chokidarPromise) {
    chokidarPromise = import("chokidar").catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(
        "chokidar dependency not installed. Run `npm install chokidar` and retry.\n" +
          message
      );
    });
  }
  return chokidarPromise;
}

async function loadTesseract(): Promise<unknown> {
  // OCR dependency is optional and loaded only for image inputs.
  if (!tesseractPromise) {
    tesseractPromise = import("tesseract.js").catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(
        "tesseract.js dependency not installed. Run `npm install tesseract.js` and retry.\n" +
          message
      );
    });
  }
  return tesseractPromise;
}

function resolveTesseractExports(module: unknown): {
  createWorker?: (options?: any) => Promise<any> | any;
} {
  // Match both named and default exports across tesseract.js builds.
  if (!module || (typeof module !== "object" && typeof module !== "function")) {
    return {};
  }

  const mod = module as any;

  if (typeof mod.createWorker === "function") {
    return { createWorker: mod.createWorker };
  }

  if (typeof mod.default?.createWorker === "function") {
    return { createWorker: mod.default.createWorker };
  }

  return {};
}

async function loadTesseractModule(): Promise<unknown> {
  try {
    const require = createRequire(import.meta.url);
    return require("tesseract.js");
  } catch {
    return loadTesseract();
  }
}

export function isSupportedIngestionFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

function getManifestPath(): string {
  // Manifest stores file mtime/size to skip unchanged content on re-ingest.
  return process.env.INGEST_MANIFEST_PATH ?? DEFAULT_MANIFEST_PATH;
}

async function loadIngestionManifest(): Promise<IngestionManifest> {
  // Load and memoize manifest once; process lifetime cache is sufficient here.
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const manifestPath = getManifestPath();
      try {
        const content = await readFile(manifestPath, "utf-8");
        const parsed = JSON.parse(content) as IngestionManifest;
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    })();
  }
  return manifestPromise;
}

export async function getIngestionManifestSnapshot(): Promise<IngestionManifest> {
  // Return a defensive copy so callers cannot mutate the in-memory manifest cache directly.
  const manifest = await loadIngestionManifest();
  return { ...manifest };
}

async function persistIngestionManifest(manifest: IngestionManifest): Promise<void> {
  // Persist manifest atomically from memory snapshot to disk.
  const manifestPath = getManifestPath();
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

function queueManifestWrite(manifest: IngestionManifest): Promise<void> {
  // Serialize writes to prevent concurrent file truncation/race conditions.
  manifestWritePromise = manifestWritePromise
    .then(() => persistIngestionManifest(manifest))
    .catch((error) => {
      log("Failed to persist ingestion manifest", error);
    });
  return manifestWritePromise;
}

export async function removeIngestionManifestEntry(filePath: string): Promise<boolean> {
  // Remove one tracked file from manifest and persist through the serialized write queue.
  const manifest = await loadIngestionManifest();
  const absolutePath = path.resolve(filePath);
  if (!Object.prototype.hasOwnProperty.call(manifest, absolutePath)) {
    return false;
  }

  delete manifest[absolutePath];
  await queueManifestWrite(manifest);
  return true;
}

export async function clearIngestionManifest(): Promise<number> {
  // Clear all tracked entries while preserving the same in-memory object reference.
  const manifest = await loadIngestionManifest();
  const keys = Object.keys(manifest);
  for (const key of keys) {
    delete manifest[key];
  }
  await queueManifestWrite(manifest);
  return keys.length;
}

export function chunkText(text: string, maxTokens = DEFAULT_CHUNK_SIZE): string[] {
  // Token-based chunking keeps embeddings bounded and retrieval stable.
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const tokenLimit =
    Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.floor(maxTokens)
      : DEFAULT_CHUNK_SIZE;
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  const chunks: string[] = [];

  for (let start = 0; start < tokens.length; start += tokenLimit) {
    const chunk = tokens.slice(start, start + tokenLimit).join(" ").trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

export async function extractTextFromFile(filePath: string): Promise<string> {
  // Supports PDF and image OCR; falls back to plain text for .txt/.md.
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    // Try parser function first; fallback to class-based API when needed.
    const buffer = await readFile(filePath);
    const module = await loadPdfParseModule();
    const { parseFn, parseClass } = resolvePdfParseExports(module);

    if (parseFn) {
      const result = await parseFn(buffer);
      return result.text ?? "";
    }

    if (parseClass) {
      const parser = new parseClass({ data: buffer });
      const result = await parser.getText();
      await parser.destroy?.();
      return result.text ?? "";
    }

    throw new Error(
      "pdf-parse export mismatch. Please reinstall pdf-parse or check module format."
    );
  }

  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
    // Local OCR via tesseract.js (no cloud upload).
    const module = await loadTesseractModule();
    const { createWorker } = resolveTesseractExports(module);

    if (!createWorker) {
      throw new Error(
        "tesseract.js export mismatch. Please reinstall tesseract.js or check module format."
      );
    }

    const language = process.env.OCR_LANGUAGE ?? "eng";
    const worker = await createWorker(language);

    try {
      const result = await worker.recognize(filePath);
      return result?.data?.text ?? "";
    } finally {
      await worker.terminate?.();
    }
  }

  return readFile(filePath, "utf-8");
}

export async function ingestFile(
  filePath: string,
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<number> {
  // Extract -> chunk -> save each chunk to memory.
  if (!isSupportedIngestionFile(filePath)) {
    log("Skipped unsupported file", filePath);
    return 0;
  }

  const text = await extractTextFromFile(filePath);
  const chunks = chunkText(text, chunkSize);

  if (chunks.length === 0) {
    log("No text extracted", filePath);
    return 0;
  }

  const sourceFile = path.basename(filePath);
  // Persist each chunk individually to improve retrieval granularity.
  for (const chunk of chunks) {
    await saveDocument(chunk, sourceFile);
  }

  publishEvent("ingest_success", {
    filePath,
    sourceFile,
    chunks: chunks.length,
  });
  logger.info("ingestion_completed", {
    filePath,
    sourceFile,
    chunks: chunks.length,
  });
  log("Ingested file", { filePath, chunks: chunks.length });
  return chunks.length;
}

async function ingestFileIfChanged(
  filePath: string,
  chunkSize: number
): Promise<number> {
  // Skip file if both size and mtime are unchanged since last ingest.
  const absolutePath = path.resolve(filePath);
  const manifest = await loadIngestionManifest();
  const fileInfo = await stat(filePath);
  const previous = manifest[absolutePath];

  if (
    previous &&
    previous.mtimeMs === fileInfo.mtimeMs &&
    previous.size === fileInfo.size
  ) {
    log("Skipped unchanged file", filePath);
    return 0;
  }

  const ingestedChunks = await ingestFile(filePath, chunkSize);
  manifest[absolutePath] = {
    mtimeMs: fileInfo.mtimeMs,
    size: fileInfo.size,
  };
  await queueManifestWrite(manifest);
  return ingestedChunks;
}

export async function ingestFileWithManifest(
  filePath: string,
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<number> {
  // Shared entrypoint for API-triggered ingestion with change tracking.
  return ingestFileIfChanged(filePath, chunkSize);
}

type Watcher = {
  on(event: "add" | "change" | "error" | "ready", handler: (...args: any[]) => void): Watcher;
  close(): Promise<void> | void;
};

export async function startIngestionWorker(options: {
  watchDir: string;
  chunkSize?: number;
}): Promise<Watcher> {
  // Watch a folder and ingest on add/change events.
  const { watchDir, chunkSize = DEFAULT_CHUNK_SIZE } = options;
  const chokidar = await loadChokidar();
  const inFlight = new Map<string, Promise<void>>();

  log("Watching directory", watchDir);

  const watcher = chokidar.watch(watchDir, {
    ignoreInitial: false,
    persistent: true,
  }) as unknown as Watcher;

  const handle = async (filePath: string) => {
    if (!isSupportedIngestionFile(filePath)) {
      return;
    }
    const key = path.resolve(filePath);
    // De-duplicate concurrent events for the same file.
    if (inFlight.has(key)) {
      return;
    }

    const task = (async () => {
      try {
        await ingestFileIfChanged(filePath, chunkSize);
      } catch (error) {
        publishEvent("ingest_error", {
          filePath,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        log("Failed to ingest", { filePath, error });
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, task);

    await task;
  };

  watcher
    .on("add", handle)
    .on("change", handle)
    .on("error", (error) => log("Watcher error", error))
    .on("ready", () => log("Watcher ready"));

  return watcher;
}
