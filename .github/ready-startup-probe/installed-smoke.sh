#!/bin/bash
set -euo pipefail

workspace="$(pwd -P)"
probe="$workspace/.github/ready-startup-probe"
output_dir="$workspace/.context/ready-startup-installed-output"
mkdir -p "$output_dir"
source "$probe/inputs.env"

runner_state="$(mktemp -d "${RUNNER_TEMP:?}/threadnote-ready.XXXXXX")"
export THREADNOTE_HOME="$runner_state/data"
export THREADNOTE_INSTALL_ROOT="$runner_state/install"
export THREADNOTE_BIN_DIR="$runner_state/bin"
export THREADNOTE_USER=ready-startup-smoke
export THREADNOTE_TELEMETRY=off
export THREADNOTE_AUTO_UPDATE=off

candidate="$workspace/.context/ready-startup-installed-source"
git worktree add --detach "$candidate" "$CANDIDATE_COMMIT"
cd "$candidate"
test "$(git rev-parse HEAD)" = "$CANDIDATE_COMMIT"
test -z "$(git status --porcelain=v1)"
bun install --frozen-lockfile
bun run dev:runtime-status -- --json | tee "$output_dir/runtime-before.json"
bun run dev:install-global -- --terminate-superseded --json | tee "$output_dir/install.json"
bun run dev:runtime-status -- --json | tee "$output_dir/runtime-after.json"

export PATH="$THREADNOTE_BIN_DIR:$PATH"
test "$(command -v threadnote)" = "$THREADNOTE_BIN_DIR/threadnote"
threadnote --version | tee "$output_dir/version.txt"
threadnote install --no-model-setup --no-start | tee "$output_dir/initialized.txt"
threadnote remember --kind durable --project threadnote --topic qz9-native-recall-background-service \
  --text 'QZ9 native recall survives without a background service.' \
  | tee "$output_dir/remember.txt"
threadnote index rebuild | tee "$output_dir/rebuild.txt"
threadnote index verify | tee "$output_dir/verify.txt"
threadnote index status | tee "$output_dir/index-status.txt"
threadnote doctor --dry-run --strict | tee "$output_dir/doctor.txt"
fixture_uri='threadnote://user/ready-startup-smoke/memories/durable/projects/threadnote/qz9-native-recall-background-service.md'
threadnote read "$fixture_uri" | tee "$output_dir/read.txt"
threadnote recall --uri "$fixture_uri" --query 'QZ9 native recall background service' --threshold 0 \
  | tee "$output_dir/recall.txt"

python3 - "$output_dir" "$THREADNOTE_HOME/logs/threadnote.log" "$CANDIDATE_COMMIT" <<'PY'
import json
import re
import sys
from pathlib import Path

output, logs, source = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
install, before, after = [
    json.loads((output / path).read_text())
    for path in ("install.json", "runtime-before.json", "runtime-after.json")
]
assert install["sourceCommit"] == source and install["doctorVerified"] and install["launchersVerified"]
assert install["active"] and not before["checkout"]["dirty"] and not after["checkout"]["dirty"]
assert before["checkout"]["head"] == after["checkout"]["head"] == source
assert after["runtime"]["ownedByThisCheckout"] and after["runtime"]["activeVersion"] == install["version"]
assert (output / "version.txt").read_text().strip() == f"threadnote v{install['version']}"
assert re.search(r"Activated vector generation .*: [1-9]\d* chunk\(s\)", (output / "rebuild.txt").read_text())
assert "Verified vector generation" in (output / "verify.txt").read_text()
assert re.search(r"bge-small-en-v1\.5-q8\s+ready\s+[1-9]\d* chunks", (output / "index-status.txt").read_text())
# Keep only bounded typed phase evidence from the runner logs.
with logs.open("rb") as file:
    start = max(0, logs.stat().st_size - 64 * 1024)
    file.seek(start)
    lines = file.read().splitlines()
events = [json.loads(line) for line in lines[bool(start):][-64:]]
event = next(event for event in reversed(events) if (
    event.get("component"), event.get("operation"), event.get("event")
) == ("cli", "recall", "invocation.finished"))
stages = [{
    "phase": stage["phase"], "outcome": stage["outcome"], "durationMilliseconds": stage["durationMilliseconds"]
} for stage in event.get("phaseTimings", []) if stage["phase"].startswith("recall.")]
summary = {
    "sourceCommit": source,
    "version": install["version"],
    "doctorVerified": install["doctorVerified"],
    "executableSha256": install["executableSha256"],
    "recallOutcome": event["outcome"],
    "returnedFixture": "qz9-native-recall-background-service.md" in (output / "recall.txt").read_text(),
    "recallPhases": stages,
}
(output / "semantic-proof.json").write_text(json.dumps(summary, indent=2) + "\n")
assert "QZ9 native recall survives without a background service." in (output / "read.txt").read_text()
assert event["outcome"] == "success"
assert any(stage["phase"] == "recall.semantic-retrieval" and stage["outcome"] == "success" for stage in stages)
PY
