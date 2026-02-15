# Personal Memory Gateway (MCP + Archestra)

Local-first backend that stores personal memory, redacts sensitive data, and serves context through MCP tools.

## What This Project Does

- Exposes MCP tools:
  - `query_personal_memory`
  - `save_memory`
- Ingests files from local disk and stores chunked vectors in LanceDB
- Applies privacy redaction and risk gating before returning context
- Optionally routes final answer generation through Archestra (Gemini/OpenAI-compatible)
- Provides optional telemetry dashboard and health endpoint

## Project Structure

```text
src/
  runtime/                  # app startup, shutdown, health wiring
  platform/                 # config validation, logger
  model-context-protocol/   # MCP server + tools
  memory/                   # embeddings + LanceDB repository
  ingestion/                # file watcher + extract/chunk/store
  privacy/                  # redaction pipeline
  security/                 # consent gate
  model-orchestration/      # Archestra/OpenAI/Gemini answer generation
  observability/            # event bus, stats collector, dashboard HTTP server
scripts/                    # smoke tests + helper scripts
dashboard/                  # telemetry UI assets
```

## Prerequisites

- Node.js 20+
- npm
- Optional: Archestra platform at `http://localhost:9000`

## Quickstart

```bash
npm install
cp .env.example .env
npm run build
```

After publish, users do not need your source code. They can run:

### 1-Minute Setup (Recommended)

```bash
npx -y pmg
```

### Manual Installation

```bash
npm i -g pmg
pmg init
pmg
```

### CLI Command Reference

- `pmg init`: Interactive environment setup
- `pmg init --yes`: Skip interactive prompts (uses defaults)
- `pmg --help`: Show all available commands
- `pmg --version`: Show current version
  Backward-compatible command also works:

```bash
personal-memory-gateway
```

The server runs as MCP over stdio, so users connect it from their MCP client config.

If `pmg` package name is already taken on npm, publish with a scope (example `@your-org/pmg`) and keep CLI command as `pmg` via `bin`.

## End User 3-Min Setup

1. Install:

```bash
npm i -g pmg
```

2. Create workspace:

```bash
mkdir my-pmg && cd my-pmg
```

3. Generate config:

```bash
pmg init
```

4. Start service:

```bash
pmg
```

5. Open dashboard:

```text
http://127.0.0.1:8787/dashboard
```

## What User Must Provide

1. Local folder path for memory files (`INGEST_DIR`, default `my_data`)
2. Optional model/API keys (only for Gemini/OpenAI modes)
3. Optional Archestra URL if they want Archestra chat integration

## MCP Client Setup (Any MCP App)

Use this MCP server config:

```json
{
  "mcpServers": {
    "pmg": {
      "command": "npx",
      "args": ["-y", "pmg"]
    }
  }
}
```

## Archestra Setup (Chat in `localhost:3000/chat`)

1. Start Archestra:

```bash
docker compose up -d
```

2. Keep `pmg` running in terminal:

```bash
pmg
```

3. In Archestra UI -> `MCP Registry` -> `Add MCP Server` -> `Remote`.
4. Server URL:

```text
http://host.docker.internal:8787/mcp
```

5. Auth: `No auth required` (for local testing).
6. Assign tools to your Gateway/Agent:
   `save_memory`, `query_personal_memory`.
7. Open `http://127.0.0.1:3000/chat` and chat normally.

## Environment Setup

Start from `.env.example`.

### Mode 1: Safe Local (No External Model Calls)

```env
ARCHESTRA_ENABLE=0
EMBEDDING_PROVIDER=local
MEMORY_QUERY_SCOPE=hybrid
MEMORY_STRICT_QUERY_MATCH=1
MEMORY_RETRIEVAL_TOP_K=3
MEMORY_RESULT_MAX_CHARS=320
```

### Mode 2: Archestra + Gemini

```env
ARCHESTRA_ENABLE=1
ARCHESTRA_PROVIDER=gemini
ARCHESTRA_GEMINI_BASE_URL=http://localhost:9000/v1/gemini/<profile_uuid>
ARCHESTRA_GEMINI_API_KEY=<your_gemini_provider_key>
```

### Mode 3: Archestra OpenAI-Compatible (ChatGPT/Claude Route)

```env
ARCHESTRA_ENABLE=1
ARCHESTRA_PROVIDER=chatgpt
ARCHESTRA_BASE_URL=http://localhost:9000/v1/openai/<profile_uuid>
ARCHESTRA_API_KEY=<archestra_or_provider_key_as_configured>
```

Notes:

- Gemini mode requires provider key (`AIza...`) in `ARCHESTRA_GEMINI_API_KEY`.
- `archestra_...` personal token is for Archestra MCP/A2A auth, not Gemini provider API calls.
- PRD-aligned default is bi-directional memory (`MEMORY_QUERY_SCOPE=hybrid`) so both documents and saved user facts participate in recall.
- If you want only explicit chat memories, set `MEMORY_QUERY_SCOPE=facts_only`.

## Run

Development:

```bash
npm run dev
```

Source run (no manual `node dist/index.js` needed):

```bash
npm run run
```

Build + run in one command:

```bash
npm run run:build
```

Compiled runtime:

```bash
npm run build
npm start
```

Production-style run:

```bash
NODE_ENV=production LOG_LEVEL=info npm start
```

## Optional Endpoints

MCP HTTP bridge (for Archestra/remote MCP clients):

```env
MCP_HTTP_ENABLE=1
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_PORT=8787
# Set 0 for Archestra-only HTTP mode (recommended for daemon/service run)
MCP_STDIO_ENABLE=0
```

Legacy SSE URL (Archestra-friendly):

```text
http://localhost:8787/sse
```

Streamable HTTP URL:

```text
http://localhost:8787/mcp
```

Health probe:

```env
HEALTH_HOST=0.0.0.0
HEALTH_PORT=8081
```

```bash
curl http://localhost:8081/healthz
```

Dashboard telemetry:

```env
DASHBOARD_ENABLE=1
DASHBOARD_PORT=8787
DASHBOARD_UPLOAD_MAX_BYTES=10485760
# Optional: require token for dashboard uploads
DASHBOARD_UPLOAD_TOKEN=
```

Open `http://localhost:8787/dashboard`.
Dashboard includes a file upload panel that writes to `INGEST_DIR` and indexes immediately.
Dashboard also includes per-file delete and "Clear All Uploaded Data" controls to remove uploaded files plus document chunks from LanceDB.
Use "Clear Uploaded + Saved Memory" when you also want to remove `save_memory` facts from the knowledge map.

## Testing

Full backend smoke suite:

```bash
make test-backend
```

One-command flow (ingest + MCP query):

```bash
npm run build
node scripts/one-command-flow.mjs "python" "my_data/profile.txt"
```

Pre-deploy gate:

```bash
npm run check
make test-backend
```

## MCP Usage

MCP server supports:

- stdio (`node dist/index.js`) for local MCP clients
- HTTP bridge on `http://localhost:8787` for Archestra/remote setups (`/sse`, `/mcp`)

Use template:

- `mcp-config.example.json`

NPM-based MCP client config example:

```json
{
  "mcpServers": {
    "personal-memory": {
      "command": "npx",
      "args": ["-y", "pmg"],
      "env": {
        "INGEST_DIR": "/absolute/path/to/my_data",
        "LANCE_DB_PATH": "/absolute/path/to/data/lancedb",
        "ARCHESTRA_ENABLE": "0",
        "EMBEDDING_PROVIDER": "local"
      }
    }
  }
}
```

For hosted Archestra gateway config, use:

- `http://localhost:9000/v1/mcp/<gateway_id>`
- `Authorization: Bearer <archestra_personal_token>`

## A2A Test (No UI Required)

```bash
curl -X POST "http://localhost:9000/v1/a2a/<agent_id>" \
  -H "Authorization: Bearer <archestra_personal_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "parts": [{"kind":"text","text":"What do I like?"}]
      }
    }
  }'
```

## Share With End Users

1. Publish package to npm.
2. Ask user to run with `npx -y pmg` (or `npm i -g pmg` then `pmg`).
3. User adds MCP client config (see `mcp-config.example.json`).
4. User sets env in MCP client config:
   - `INGEST_DIR`
   - `LANCE_DB_PATH`
   - provider/env keys as needed

If user wants to run from source instead:

```bash
npm install
npm run build
make test-backend
```

Then connect with `mcp-config.example.json`.

## Publish To NPM

Before first publish:

1. Ensure package name is available on npm:

```bash
npm view pmg name
```

2. Login:

```bash
npm login
```

3. Validate package contents:

```bash
npm pack --dry-run
```

4. Publish:

```bash
npm publish --access public
```

## Dashboard Upload API

Endpoint:

- `POST /ingestion/upload`

Body:

```json
{
  "fileName": "profile.txt",
  "contentBase64": "<base64-file-content>"
}
```

If `DASHBOARD_UPLOAD_TOKEN` is set, send:

- `x-dashboard-token: <token>` or `Authorization: Bearer <token>`

Other dashboard data management endpoints:

- `DELETE /ingestion/files?filePath=<absolute_path>` remove one indexed file + related document chunks
- `POST /ingestion/clear` clear uploaded files + document chunks (keeps saved user facts)
- `POST /memory/clear` clear uploaded files + document chunks + saved user facts
