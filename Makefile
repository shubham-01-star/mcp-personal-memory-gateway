.PHONY: devlog check prod-ready test-module-2-3 test-module-4-mcp test-module-5 test-backend test-one-command reset-memory run run-build

check:
	npm run check

run:
	npm run run

run-build:
	npm run run:build

prod-ready: check test-backend

devlog:
	./scripts/new-devlog.sh

test-module-2-3:
	npm run build
	node scripts/module-2-3-integration-smoke.mjs

test-module-4-mcp:
	npm run build
	node scripts/module-4-mcp-integration-smoke.mjs

test-module-5:
	npm run build
	ARCHESTRA_ENABLE=1 node scripts/module-5-smoke.mjs

test-backend:
	npm run build
	node scripts/module-1-smoke.mjs
	node scripts/module-2-smoke.mjs
	node scripts/module-2-3-integration-smoke.mjs
	node scripts/module-3-smoke.mjs
	node scripts/module-4-smoke.mjs
	node scripts/module-4-mcp-integration-smoke.mjs
	ARCHESTRA_ENABLE=1 node scripts/module-5-smoke.mjs

test-one-command:
	npm run build
	node scripts/one-command-flow.mjs "profile" "my_data/profile.txt"

reset-memory:
	rm -rf data/lancedb data/lancedb-onecommand-*
