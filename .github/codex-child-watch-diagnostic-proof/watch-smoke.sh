#!/bin/bash
set -euo pipefail
state="${1:?scratch state}"
output="${2:?scratch output}"
mkdir -p "$state/fixture-bin" "$state/repo" "$output"
git -C "$state/repo" init -q
git -C "$state/repo" remote add origin https://github.com/threadnote-fixture/watch-smoke.git
repo="$(cd "$state/repo" && pwd -P)"
export WATCH_FIXTURE_CALLS="$state/codex-calls"
export PATH="$state/fixture-bin:$PATH"
cat > "$state/fixture-bin/codex" <<'CODEX'
#!/bin/sh
case "$*" in
  'queue --help')
    cat <<'HELP'
Queue a message for an existing session
Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>
Options:
      --thread <THREAD>  Session UUID or exact session name
      --message <TEXT>   Message text to queue
HELP
    ;;
  'queue --thread '*)
    printf '%s\n' refusal >> "$WATCH_FIXTURE_CALLS"
    printf '%s\n' 'Error: failed to queue session message: thread/queue/add failed: direct app-server input is not allowed for unloaded spawned sub-agents (code -32600)' >&2
    exit 1
    ;;
  *) exit 2 ;;
esac
CODEX
cat > "$state/fixture-bin/gh" <<'GITHUB'
#!/bin/sh
case "$*" in
  'api --hostname github.com --method GET repos/threadnote-fixture/watch-smoke/pulls/42 --jq '*)
    printf '%s\n' '{"number":42,"url":"https://github.com/threadnote-fixture/watch-smoke/pull/42","baseRepository":"threadnote-fixture/watch-smoke","baseBranch":"main","headBranch":"feature","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"open","merged":false}'
    ;;
  'api --hostname github.com --include --method GET repos/threadnote-fixture/watch-smoke/pulls/42'*)
    sleep 2
    printf 'HTTP/2.0 401 Unauthorized\r\n\r\n{}\n'
    ;;
  *) exit 2 ;;
esac
GITHUB
chmod +x "$state/fixture-bin/codex" "$state/fixture-bin/gh"
watch() {
  threadnote workflow-automation watch-pr --caller-cwd "$repo" "$@"
}
watch --operation start --pr-url https://github.com/threadnote-fixture/watch-smoke/pull/42 \
  --host codex --host-executable "$state/fixture-bin/codex" \
  --host-reference 00000000-0000-4000-8000-000000000042 > "$state/start.json"
ref="$(jq -er .watchRef "$state/start.json")"
trap 'watch --operation stop --watch-ref "$ref" >/dev/null 2>&1 || true' EXIT
for _attempt in {1..20}; do
  watch --operation inspect --watch-ref "$ref" > "$state/inspect.json"
  if jq -e '.result.notification.error == "host-codex-spawned-subagent"' "$state/inspect.json" >/dev/null; then
    break
  fi
  sleep 1
done
jq -e '
  .result |
  .notification.status == "failed" and
  .notification.error == "host-codex-spawned-subagent" and
  (.notification.guidance | contains("owning top-level Codex conversation")) and
  .notification.attempts == 1 and .notification.receipt == null and
  .pending > 0 and .deliveryId == null
' "$state/inspect.json" >/dev/null
test "$(wc -l < "$WATCH_FIXTURE_CALLS" | tr -d ' ')" = 1
if grep -Fq 'direct app-server input is not allowed' "$state/inspect.json"; then
  exit 1
fi
jq '.result | {pending, deliveryId, notification: (.notification | {status, error, guidance, attempts, receipt})}' "$state/inspect.json" > "$output/watch-diagnostic.json"
