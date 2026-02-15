#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { runApp } from "./runtime/application-bootstrap.js";

function getPackageVersion(): string {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const raw = readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp(): void {
  const helpText = `pmg - Personal Memory Gateway CLI
  
  Usage:
  pmg                  Start MCP server
  pmg init             Create interactive .env from package .env.example
  pmg init --yes       Create .env with defaults (non-interactive)
  pmg init --force     Overwrite existing .env
  pmg --help           Show this help
  pmg --version        Show CLI version

  Quick Start:
  1) npm i -g pmg
  2) mkdir my-pmg && cd my-pmg
  3) pmg init
  4) pmg

  Archestra Setup:
  - Gateway: http://localhost:3099
  - Tool Config:
    {
      "pmg": {
        "command": "npx",
        "args": ["-y", "pmg"]
      }
    }
  
  Developer Tips:
  1) Use 'pmg init' to set up your ingestion directory
  2) Keep pmg running on your machine
  3) Use Archestra Dashboard to monitor privacy blocks
  `;
  process.stdout.write(helpText);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function printRunHints(): void {
  const isInteractiveShell = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractiveShell) {
    return;
  }

  const dashboardEnabled = parseBoolean(process.env.DASHBOARD_ENABLE, false);
  const dashboardPort = process.env.DASHBOARD_PORT ?? "8787";
  const mcpHttpEnabled = parseBoolean(process.env.MCP_HTTP_ENABLE, true);
  const mcpPort = process.env.MCP_HTTP_PORT ?? dashboardPort ?? "8787";

  process.stdout.write("\n[pmg] Starting Personal Memory Gateway...\n");
  if (dashboardEnabled) {
    process.stdout.write(`[pmg] Dashboard: http://127.0.0.1:${dashboardPort}/dashboard\n`);
  }
  if (mcpHttpEnabled) {
    process.stdout.write(`[pmg] MCP HTTP: http://127.0.0.1:${mcpPort}/mcp\n`);
    process.stdout.write(`[pmg] MCP SSE : http://127.0.0.1:${mcpPort}/sse\n`);
    process.stdout.write(
      `[pmg] Archestra Remote MCP URL: http://host.docker.internal:${mcpPort}/mcp\n\n`
    );
  }
}

function setEnvValue(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, `${key}=${value}`);
  }
  return `${content.trimEnd()}\n${key}=${value}\n`;
}

type InitMode = "local" | "gemini" | "openai";

type InitAnswers = {
  mode: InitMode;
  dashboardEnabled: boolean;
  dashboardPort: string;
  ingestDir: string;
};

async function askInitQuestions(): Promise<InitAnswers> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, resolve);
    });

  try {
    process.stdout.write("\n[pmg] Interactive setup\n");

    const rawMode = (
      await ask(
        "Mode [1=Local (recommended), 2=Archestra+Gemini, 3=Archestra+OpenAI] (default 1): "
      )
    ).trim();
    const mode: InitMode =
      rawMode === "2" ? "gemini" : rawMode === "3" ? "openai" : "local";

    const rawDashboard = (
      await ask("Enable dashboard? [Y/n] (default Y): ")
    ).trim().toLowerCase();
    const dashboardEnabled = rawDashboard === "" || rawDashboard === "y" || rawDashboard === "yes";

    const rawPort = (
      await ask("Dashboard + MCP HTTP port (default 8787): ")
    ).trim();
    const dashboardPort = rawPort || "8787";

    const rawIngestDir = (
      await ask("Ingestion directory (default my_data): ")
    ).trim();
    const ingestDir = rawIngestDir || "my_data";

    return {
      mode,
      dashboardEnabled,
      dashboardPort,
      ingestDir,
    };
  } finally {
    rl.close();
  }
}

function applyInitAnswers(envContent: string, answers: InitAnswers): string {
  let content = envContent;

  content = setEnvValue(content, "INGEST_DIR", answers.ingestDir);
  content = setEnvValue(content, "DASHBOARD_ENABLE", answers.dashboardEnabled ? "1" : "0");
  content = setEnvValue(content, "DASHBOARD_PORT", answers.dashboardPort);
  content = setEnvValue(content, "MCP_HTTP_ENABLE", "1");
  content = setEnvValue(content, "MCP_HTTP_PORT", answers.dashboardPort);
  content = setEnvValue(content, "MCP_STDIO_ENABLE", "0");

  if (answers.mode === "local") {
    content = setEnvValue(content, "ARCHESTRA_ENABLE", "0");
    content = setEnvValue(content, "EMBEDDING_PROVIDER", "local");
  } else if (answers.mode === "gemini") {
    content = setEnvValue(content, "ARCHESTRA_ENABLE", "1");
    content = setEnvValue(content, "ARCHESTRA_PROVIDER", "gemini");
    content = setEnvValue(content, "EMBEDDING_PROVIDER", "gemini");
  } else {
    content = setEnvValue(content, "ARCHESTRA_ENABLE", "1");
    content = setEnvValue(content, "ARCHESTRA_PROVIDER", "openai");
    content = setEnvValue(content, "EMBEDDING_PROVIDER", "openai");
  }

  return content;
}

async function initEnvironment(force = false, nonInteractive = false): Promise<void> {
  const sourcePath = fileURLToPath(new URL("../.env.example", import.meta.url));
  const targetPath = path.resolve(process.cwd(), ".env");

  if (!existsSync(sourcePath)) {
    process.stderr.write("ERROR: .env.example not found in package.\n");
    process.exitCode = 1;
    return;
  }

  if (existsSync(targetPath) && !force) {
    process.stderr.write(
      "ERROR: .env already exists. Use 'pmg init --force' to overwrite.\n"
    );
    process.exitCode = 1;
    return;
  }

  const isInteractiveShell = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (nonInteractive || !isInteractiveShell) {
    copyFileSync(sourcePath, targetPath);
    process.stdout.write(
      `Created ${targetPath} (default config${nonInteractive ? "" : ", non-interactive shell"})\n`
    );
    return;
  }

  const template = readFileSync(sourcePath, "utf-8");
  const answers = await askInitQuestions();
  const generated = applyInitAnswers(template, answers);
  await writeFile(targetPath, generated, "utf-8");

  process.stdout.write(`Created ${targetPath}\n`);
  process.stdout.write("[pmg] Setup complete. Run: pmg --help\n");
}

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${getPackageVersion()}\n`);
    return;
  }

  if (command === "init") {
    await initEnvironment(args.includes("--force"), args.includes("--yes"));
    return;
  }

  // Default behavior: run MCP server for MCP clients.
  printRunHints();
  await runApp();
}

await main();
