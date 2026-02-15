import { rm } from "node:fs/promises";

// Keep release artifacts deterministic by removing stale compiled files before build.
await rm("dist", { recursive: true, force: true });
