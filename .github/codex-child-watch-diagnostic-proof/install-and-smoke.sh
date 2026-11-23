#!/bin/bash
set -euo pipefail
workspace="$(pwd -P)"
proof="$workspace/.github/codex-child-watch-diagnostic-proof"
candidate_commit="$(cat "$proof/source-commit")"
output_dir="${RUNNER_TEMP:?}/codex-child-watch-diagnostic-output"
runner_state="$(mktemp -d "$RUNNER_TEMP/threadnote-codex-watch.XXXXXX")"
runner_state="$(cd "$runner_state" && pwd -P)"
mkdir -p "$output_dir"
export THREADNOTE_HOME="$runner_state/data"
export THREADNOTE_INSTALL_ROOT="$runner_state/install"
export THREADNOTE_BIN_DIR="$runner_state/bin"
export THREADNOTE_USER=codex-watch-smoke
export THREADNOTE_TELEMETRY=off
export THREADNOTE_AUTO_UPDATE=off
export CODEX_HOME="$runner_state/codex-home"

candidate="$runner_state/source"
git worktree add --detach "$candidate" "$candidate_commit"
cd "$candidate"
test "$(git rev-parse HEAD)" = "$candidate_commit"
test -z "$(git status --porcelain=v1)"
bun install --frozen-lockfile
bun run dev:runtime-status -- --json > "$runner_state/runtime-before.json"
if ! bun run dev:install-global -- --terminate-superseded --json > "$runner_state/install.json"; then
  tail -c 16384 "$runner_state/install.json" >&2
  exit 1
fi
bun run dev:runtime-status -- --json > "$runner_state/runtime-after.json"
export PATH="$THREADNOTE_BIN_DIR:$PATH"
test "$(command -v threadnote)" = "$THREADNOTE_BIN_DIR/threadnote"
threadnote --version | tee "$output_dir/version.txt"
bash "$proof/watch-smoke.sh" "$runner_state/watch" "$output_dir"
python3 - "$runner_state" "$output_dir" "$candidate_commit" <<'PY'
import json
import sys
from pathlib import Path

state, output, source = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
install, before, after = [
    json.loads((state / path).read_text())
    for path in ("install.json", "runtime-before.json", "runtime-after.json")
]
assert install["sourceCommit"] == source and install["doctorVerified"] and install["launchersVerified"]
assert install["active"] and not before["checkout"]["dirty"] and not after["checkout"]["dirty"]
assert before["checkout"]["head"] == after["checkout"]["head"] == source
assert after["runtime"]["ownedByThisCheckout"] and after["runtime"]["activeVersion"] == install["version"]
assert (output / "version.txt").read_text().strip() == f"threadnote v{install['version']}"
proof = {key: install[key] for key in ("sourceCommit", "version", "doctorVerified", "executableSha256")}
(output / "install-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
PY
