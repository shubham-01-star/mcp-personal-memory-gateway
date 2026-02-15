import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const distEntry = path.join(repositoryRoot, "dist", "index.js");

process.chdir(repositoryRoot);

const args = new Set(process.argv.slice(2));
const forceBuild = args.has("--build");

if (args.has("--help") || args.has("-h")) {
  process.stdout.write(`run-local - start Personal Memory Gateway from source

Usage:
  node scripts/run-local.mjs
  node scripts/run-local.mjs --build

Options:
  --build   Always run npm build before start
`);
  process.exit(0);
}

function runCommand(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code ?? 0);
    });
  });
}

if (forceBuild || !existsSync(distEntry)) {
  process.stdout.write("[run-local] Building dist...\n");
  const buildExitCode = await runCommand("npm", ["run", "build"]);
  if (buildExitCode !== 0) {
    process.exit(buildExitCode);
  }
}

process.stdout.write(`[run-local] Starting from ${repositoryRoot}\n`);
const app = spawn("node", [distEntry], {
  stdio: "inherit",
  env: process.env,
});

const forwardSignal = (signal) => {
  if (!app.killed) {
    app.kill(signal);
  }
};

process.on("SIGINT", () => {
  forwardSignal("SIGINT");
});
process.on("SIGTERM", () => {
  forwardSignal("SIGTERM");
});

app.on("exit", (code) => {
  process.exit(code ?? 0);
});

