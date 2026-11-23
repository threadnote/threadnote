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
threadnote remember --kind durable --project ready-smoke --topic ready-embedding-fixture \
  --text 'The QZ9 botanical project uses a passive irrigation system to water its rooftop garden.' \
  | tee "$output_dir/remember.txt"
threadnote index rebuild | tee "$output_dir/rebuild.txt"
threadnote index verify | tee "$output_dir/verify.txt"
threadnote index status | tee "$output_dir/index-status.txt"
threadnote doctor --dry-run --strict | tee "$output_dir/doctor.txt"
threadnote recall --project ready-smoke --query 'QZ9 botanical project rooftop garden irrigation' \
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
assert "ready-embedding-fixture.md" in (output / "recall.txt").read_text()
with logs.open("rb") as file:
    file.seek(max(0, logs.stat().st_size - 64 * 1024))
    lines = file.read().splitlines()
events = [json.loads(line) for line in lines[1:][-64:]]
event = next(event for event in reversed(events) if (
    event.get("component"), event.get("operation"), event.get("event")
) == ("cli", "recall", "invocation.finished"))
stages = [{
    "phase": stage["phase"], "outcome": stage["outcome"], "durationMilliseconds": stage["durationMilliseconds"]
} for stage in event["phaseTimings"] if stage["phase"] == "recall.semantic-retrieval"]
summary = {
    "sourceCommit": source,
    "version": install["version"],
    "doctorVerified": install["doctorVerified"],
    "executableSha256": install["executableSha256"],
    "recallOutcome": event["outcome"],
    "readySemanticPhases": stages,
}
(output / "semantic-proof.json").write_text(json.dumps(summary, indent=2) + "\n")
assert event["outcome"] == "success" and any(stage["outcome"] == "success" for stage in stages)
PY
