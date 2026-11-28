#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
classifier="$script_dir/classify-changes.sh"

assert_classification() {
  local expected="$1"
  shift
  local actual
  actual="$(printf '%s\0' "$@" | "$classifier")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'classification mismatch for %q\nexpected:\n%s\nactual:\n%s\n' "$*" "$expected" "$actual" >&2
    exit 1
  fi
}

validation_only=$'validate=true\ndeploy=false\nsupersede=false'
production=$'validate=true\ndeploy=true\nsupersede=true'
irrelevant=$'validate=false\ndeploy=false\nsupersede=false'

assert_classification "$production" infra/telemetry-gateway/gateway.go
assert_classification "$production" infra/telemetry-gateway/internal/budget/budget.go
assert_classification "$production" infra/telemetry-gateway/internal/runtime/new.go
assert_classification "$production" infra/telemetry-gateway/telemetry-schema-v2.json
assert_classification "$production" infra/telemetry-gateway/telemetry-schema-v3.json
assert_classification "$production" infra/telemetry-gateway/telemetry-schema-v4.json
assert_classification "$production" infra/telemetry-gateway/telemetry-schema-v5.json
assert_classification "$production" infra/telemetry-gateway/telemetry-schema-v6.json
assert_classification "$production" infra/telemetry-gateway/telemetry-schema-v7.json
assert_classification "$production" .dockerignore
assert_classification "$production" docs/telemetry.md infra/telemetry-gateway/schema.go
# `git diff --no-renames` presents a move as the old deletion plus new addition;
# the removed runtime path must keep the pair deployable.
assert_classification "$production" infra/telemetry-gateway/gateway.go docs/moved-gateway-example.go

assert_classification "$validation_only" infra/telemetry-gateway/gateway_test.go
assert_classification "$validation_only" infra/telemetry-gateway/internal/budget/budget_test.go
assert_classification "$validation_only" infra/telemetry-gateway/cmd/canary/main.go
assert_classification "$validation_only" infra/telemetry-gateway/threadnote-anonymous-telemetry-dashboard.json
assert_classification "$validation_only" .github/workflows/telemetry-gateway.yml
assert_classification "$validation_only" docs/operations/telemetry-production.md
assert_classification "$validation_only" infra/telemetry-gateway/scripts/classify-changes.sh

assert_classification "$irrelevant" README.md packages/graph/src/indexer.ts

printf 'telemetry gateway change classification verified\n'
