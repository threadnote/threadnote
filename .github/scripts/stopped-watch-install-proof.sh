#!/usr/bin/env bash
set -euo pipefail

proof_root="$RUNNER_TEMP/stopped-watch-install-proof"
evidence="$proof_root/evidence"
export WATCH_PROOF_SOURCE="$GITHUB_WORKSPACE/candidate-source"
export WATCH_PROOF_REPO="$proof_root/repo"
export THREADNOTE_HOME="$proof_root/data"
export THREADNOTE_INSTALL_ROOT="$proof_root/install"
export THREADNOTE_BIN_DIR="$proof_root/bin"
mkdir -p "$evidence" "$WATCH_PROOF_REPO" "$THREADNOTE_HOME" "$THREADNOTE_INSTALL_ROOT" "$THREADNOTE_BIN_DIR"

if command -v codex >/dev/null || command -v claude >/dev/null; then
  printf '%s\n' 'The disposable runner unexpectedly has a supported MCP host installed.'
  exit 1
fi

git -C "$WATCH_PROOF_REPO" init -q -b main
git -C "$WATCH_PROOF_REPO" remote add origin https://github.com/example/private-watch-fixture.git
(
  cd "$WATCH_PROOF_SOURCE"
  test "$(git rev-parse HEAD)" = "$WATCH_PROOF_COMMIT"
  bun install --frozen-lockfile >&2
  bun run dev:install-global -- --json --terminate-superseded
) > "$evidence/install.json"
jq -e --arg expected "$WATCH_PROOF_COMMIT" '.sourceCommit == $expected and .active and .doctorVerified and .launchersVerified' "$evidence/install.json"
binary="$THREADNOTE_BIN_DIR/threadnote"
test "$("$binary" --version)" = "threadnote v$(jq -r .version "$evidence/install.json")"

watch_ref="$(bun "$GITHUB_WORKSPACE/.github/scripts/stopped-watch-fixture.ts")"
watch_command() {
  "$binary" workflow-automation watch-pr --caller-cwd "$WATCH_PROOF_REPO" --watch-ref "$watch_ref" "$@"
}
watch_command --operation inspect > "$proof_root/before.json"
jq -e '.result | .stopRequested and .pending == 1 and .consumer.live == false and .collector.status == "stopped"' "$proof_root/before.json"
notice_ref="$(jq -er '.noticeRef' "$proof_root/before.json")"
watch_command --operation relay --notice-ref "$notice_ref" > "$proof_root/delivery.json"
delivery_ref="$(jq -er '.watchDeliveryRef' "$proof_root/delivery.json")"
event_ref="$(jq -er '.eventRefs[0]' "$proof_root/delivery.json")"
if watch_command --operation ack --watch-delivery-ref "$delivery_ref" > "$proof_root/early-ack.log" 2>&1; then
  printf '%s\n' 'ACK bypassed the durable disposition gate.'
  exit 1
fi
grep -F 'durable disposition' "$proof_root/early-ack.log"
watch_command --operation disposition --watch-delivery-ref "$delivery_ref" --disposition-event-ref "$event_ref" \
  --disposition-status open --disposition-reason 'Needs a repair' --disposition-evidence 'Isolated installed smoke'
watch_command --operation ack --watch-delivery-ref "$delivery_ref"
watch_command --operation inspect > "$proof_root/after.json"
jq -e '.result | .stopRequested and .pending == 0 and .deliveryId == null and .consumer.live == false and .collector.status == "stopped" and .work.open == 1' "$proof_root/after.json"
jq -ne --slurpfile before "$proof_root/before.json" --slurpfile after "$proof_root/after.json" \
  '$before[0].result.consumer == $after[0].result.consumer and $before[0].result.collector == $after[0].result.collector'
jq -n --arg commit "$WATCH_PROOF_COMMIT" '{sourceCommit:$commit,strictDoctorPassed:true,installedWatchDrainPassed:true,unresolvedWorkRetained:true}' > "$evidence/result.json"
