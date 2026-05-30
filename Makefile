# ==== Distributed Job Dispatcher Makefile ====
SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

RUN := npm run

green  = \033[32m
yellow = \033[33m
red    = \033[31m
gray   = \033[90m
reset  = \033[0m

.PHONY: help
help:
	@echo -e "$(green)Dev$(reset)"
	@echo "  make setup            Install dependencies"
	@echo "  make build            Compile TypeScript"
	@echo "  make coordinator-dev  Start coordinator in dev mode"
	@echo "  make migrate          Run pending DB migrations"
	@echo "  make check            Biome lint + format check"
	@echo "  make format           Biome format (write)"
	@echo "  make test             Run tests"
	@echo "  make test-integration Run integration tests (testcontainers Postgres)"
	@echo "  make clean            Remove dist/ and node_modules/"
	@echo "  make commit           Interactive conventional commit"
	@echo -e "$(green)Docker$(reset)"
	@echo "  make up               Build images and start full stack (detached)"
	@echo "  make down             Stop stack and remove volumes"
	@echo "  make logs             Tail logs for all services"
	@echo "  make chaos            Run chaos harness → chaos_report.txt"

.PHONY: setup
setup:
	npm install

.PHONY: build
build:
	$(RUN) build

.PHONY: coordinator-dev
coordinator-dev:
	$(RUN) coordinator:dev

.PHONY: migrate
migrate:
	$(RUN) migrate

.PHONY: check
check:
	$(RUN) check

.PHONY: format
format:
	$(RUN) format
	npx biome check --write .

.PHONY: test
test:
	@set -euo pipefail; \
	echo -e "$(gray)Smoke test: TypeScript compile$(reset)"; \
	npx --no-install tsc --noEmit; \
	echo -e "$(green)✓ Type-check passed$(reset)"; \
	echo -e "$(gray)Unit tests: vitest$(reset)"; \
	$(RUN) test; \
	echo -e "$(green)✓ Unit tests passed$(reset)"; \
	if command -v docker >/dev/null 2>&1; then \
	  echo -e "$(gray)Integration tests: vitest + testcontainers Postgres$(reset)"; \
	  $(RUN) test:integration; \
	  echo -e "$(green)✓ Integration tests passed$(reset)"; \
	else \
	  echo -e "$(yellow)docker not found — skipping integration tests (testcontainers requires docker)$(reset)"; \
	fi; \
	if docker compose ps --status=running --services 2>/dev/null | grep -q '^coordinator-1$$'; then \
	  echo -e "$(gray)Smoke test: stack endpoints$(reset)"; \
	  curl -fsS http://localhost:8080/health >/dev/null && echo -e "$(green)✓ /health$(reset)"; \
	  curl -fsS http://localhost:8080/stats  >/dev/null && echo -e "$(green)✓ /stats$(reset)"; \
	  KEY="smoke-$$(date +%s%N)"; \
	  R1=$$(curl -fsS -X POST http://localhost:8080/jobs -H 'content-type: application/json' \
	         -d "{\"idempotency_key\":\"$$KEY\",\"payload\":{\"durationMs\":50}}"); \
	  R2=$$(curl -fsS -X POST http://localhost:8080/jobs -H 'content-type: application/json' \
	         -d "{\"idempotency_key\":\"$$KEY\",\"payload\":{\"durationMs\":50}}"); \
	  echo "$$R1" | grep -q '"job_id"' || { echo -e "$(red)✗ submit failed$(reset)"; exit 1; }; \
	  ID1=$$(echo "$$R1" | python3 -c "import sys,json;print(json.load(sys.stdin)['job_id'])"); \
	  ID2=$$(echo "$$R2" | python3 -c "import sys,json;print(json.load(sys.stdin)['job_id'])"); \
	  [ "$$ID1" = "$$ID2" ] || { echo -e "$(red)✗ idempotency broken: $$ID1 != $$ID2$(reset)"; exit 1; }; \
	  echo -e "$(green)✓ idempotency dedupes same key$(reset)"; \
	  curl -fsS -X POST http://localhost:8080/chaos -H 'content-type: application/json' \
	    -d '{"fault":"pause_dispatch","params":{"ms":100}}' >/dev/null && echo -e "$(green)✓ /chaos accepts pause_dispatch$(reset)"; \
	  echo -e "$(green)✓ Smoke test passed$(reset)"; \
	else \
	  echo -e "$(yellow)Stack not running — skipping HTTP smoke. Run 'make up' first to test endpoints.$(reset)"; \
	fi

.PHONY: clean
clean:
	@rm -rf dist node_modules

.PHONY: test-integration
test-integration:
	@command -v docker >/dev/null 2>&1 || { echo -e "$(red)docker not found — required for testcontainers$(reset)"; exit 1; }
	@echo -e "$(gray)Integration tests: vitest + testcontainers Postgres$(reset)"
	$(RUN) test:integration
	@echo -e "$(green)✓ Integration tests passed$(reset)"

# Docker stack
.PHONY: up
up:
	docker compose up --build -d

.PHONY: down
down:
	docker compose down -v

.PHONY: logs
logs:
	docker compose logs -f --tail=100

.PHONY: setup_hosts
setup_hosts:
	@echo "Adding /etc/hosts entries so the chaos faulter can reach c1/c2/c3 directly…"
	@grep -qF "127.0.0.2 c1" /etc/hosts || echo "127.0.0.2 c1" | sudo tee -a /etc/hosts
	@grep -qF "127.0.0.3 c2" /etc/hosts || echo "127.0.0.3 c2" | sudo tee -a /etc/hosts
	@grep -qF "127.0.0.4 c3" /etc/hosts || echo "127.0.0.4 c3" | sudo tee -a /etc/hosts
	@echo "Done — c1→127.0.0.2  c2→127.0.0.3  c3→127.0.0.4"

.PHONY: chaos
chaos: setup_hosts
	@if [ ! -f chaos_harness.py ]; then echo "chaos_harness.py not found — place it in the repo root"; exit 1; fi
	@command -v python3 >/dev/null 2>&1 || { echo "python3 not found — install it (apt install python3 / brew install python)"; exit 1; }
	@command -v pip3 >/dev/null 2>&1 || command -v python3 -m pip >/dev/null 2>&1 || { echo "pip3 not found — install it (apt install python3-pip)"; exit 1; }
	@command -v docker >/dev/null 2>&1 || { echo "docker not found — the harness uses 'docker kill' directly"; exit 1; }
	@python3 -c "import aiohttp" 2>/dev/null || \
		pip3 install --quiet aiohttp --break-system-packages 2>/dev/null || \
		pip3 install --quiet aiohttp || \
		python3 -m pip install --quiet aiohttp
	python3 chaos_harness.py \
		--base http://localhost:8080 \
		--coords c1,c2,c3 \
		--workers w1,w2,w3,w4,w5 \
		--duration 600 \
		--rate 50 \
		--report chaos_report.txt

.PHONY: commit
commit: precommit-checks do-commit

.PHONY: precommit-checks
precommit-checks:
	@set -euo pipefail; \
	echo -e "$(gray)Running pre-commit checks...$(reset)"; \
	$(MAKE) check; \
	$(MAKE) build; \
	$(MAKE) test; \
	echo -e "$(green)✓ Pre-commit checks passed$(reset)"

.PHONY: do-commit
do-commit:
	@set -euo pipefail; \
	if ! git rev-parse --git-dir >/dev/null 2>&1; then echo -e "$(red)Not a git repo$(reset)"; exit 1; fi; \
	if [ -z "$${STAGE:-}" ]; then read -p "Stage all changes now? [Y/n] " STAGE; STAGE=$${STAGE:-Y}; fi; \
	case "$$STAGE" in y|Y|yes|YES) git add -A;; *) echo "Skipping auto-stage."; esac; \
	TYPES="feat fix chore docs refactor perf test build ci revert"; \
	if [ -z "$${TYPE:-}" ]; then \
	  echo "Select commit type:"; i=1; for t in $$TYPES; do echo "  $$i) $$t"; i=$$((i+1)); done; \
	  read -p "Choose number: " N; TYPE=$$(echo $$TYPES | awk -v n=$$N '{split($$0,a," "); print a[n]}'); \
	fi; \
	if [ -z "$$TYPE" ]; then echo -e "$(red)Commit type required$(reset)"; exit 1; fi; \
	if [ -z "$${SCOPE:-}" ]; then read -p "Optional scope (e.g., coordinator/worker/db): " SCOPE || true; fi; \
	if [ -z "$${MSG:-}" ]; then while true; do read -p "Short description (<=72 chars): " MSG; [ -n "$$MSG" ] && break; done; fi; \
	if [ -z "$${BODY:-}" ]; then read -p "Body (optional): " BODY || true; fi; \
	if [ -z "$${BREAKING:-}" ]; then \
	  read -p "Breaking change? [y/N]: " BR || true; BR=$${BR:-N}; \
	  if [[ "$$BR" =~ ^(y|Y)$$ ]]; then read -p "Describe breaking change: " BREAKING || true; else BREAKING=""; fi; \
	fi; \
	if [ -z "$${FOOTER:-}" ]; then read -p "Footer (e.g., Closes #123): " FOOTER || true; fi; \
	: "$${SCOPE:=}"; : "$${MSG:=}"; : "$${BODY:=}"; : "$${BREAKING:=}"; : "$${FOOTER:=}"; \
	HEADER="$$TYPE"; [ -n "$$SCOPE" ] && HEADER="$$HEADER($$SCOPE)"; [ -n "$$BREAKING" ] && HEADER="$$HEADER!"; HEADER="$$HEADER: $$MSG"; \
	MSGFILE=$$(mktemp); echo "$$HEADER" > $$MSGFILE; \
	[ -n "$$BODY" ] && { echo; echo "$$BODY"; } >> $$MSGFILE; \
	[ -n "$$BREAKING" ] && { echo; echo "BREAKING CHANGE: $$BREAKING"; } >> $$MSGFILE; \
	[ -n "$$FOOTER" ] && { echo; echo "$$FOOTER"; } >> $$MSGFILE; \
	echo -e "\n$(gray)--- Commit message preview ---$(reset)\n$$(cat $$MSGFILE)\n$(gray)-----------------------------$(reset)\n"; \
	if git commit -F $$MSGFILE; then echo -e "$(green)✓ Commit created$(reset)"; else echo -e "$(red)✗ Commit failed$(reset)"; fi; \
	rm -f $$MSGFILE
