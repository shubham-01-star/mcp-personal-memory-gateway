import process from "node:process";

// Small CLI wrapper to run folder watcher against built ingestion module.
const watchDir = process.argv[2] ?? "my_data";
const chunkSize = Number(process.env.CHUNK_SIZE ?? 1000);

try {
  const { startIngestionWorker } = await import("../dist/ingestion/file-ingestion-worker.js");
  await startIngestionWorker({ watchDir, chunkSize });
  console.log(`Watching ${watchDir} (chunkSize=${chunkSize})`);
} catch (error) {
  console.error("Failed to start ingestion worker.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
