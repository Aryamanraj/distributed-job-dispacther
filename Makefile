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
	@echo "  make check     Biome lint + format check"
	@echo "  make format    Biome format (write)"
	@echo "  make test      Run tests"
	@echo "  make clean     Remove dist/ and node_modules/"
	@echo "  make commit    Interactive conventional commit"

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
	$(RUN) test

.PHONY: clean
clean:
	@rm -rf dist node_modules

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
