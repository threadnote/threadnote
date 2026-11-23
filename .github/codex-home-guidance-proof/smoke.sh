#!/bin/bash
set -euo pipefail

workspace="$(pwd -P)"
candidate_commit="$(cat "$workspace/.github/codex-home-guidance-proof/source-commit")"
output_dir="${RUNNER_TEMP:?}/codex-home-guidance-output"
runner_state="$(mktemp -d "$RUNNER_TEMP/threadnote-codex-guidance.XXXXXX")"
mkdir -p "$output_dir"
export THREADNOTE_HOME="$runner_state/data"
export THREADNOTE_INSTALL_ROOT="$runner_state/install"
export THREADNOTE_BIN_DIR="$runner_state/bin"
export THREADNOTE_USER=codex-guidance-smoke
export THREADNOTE_TELEMETRY=off
export THREADNOTE_AUTO_UPDATE=off
export CODEX_HOME="$runner_state/codex"
mkdir -p "$CODEX_HOME"
[[ "$CODEX_HOME" == /home/* ]]

candidate="$runner_state/source"
git worktree add --detach "$candidate" "$candidate_commit"
cd "$candidate"
test "$(git rev-parse HEAD)" = "$candidate_commit"
test -z "$(git status --porcelain=v1)"
bun install --frozen-lockfile
bun run dev:runtime-status -- --json > "$runner_state/runtime-before.json"
bun run dev:install-global -- --terminate-superseded --json > "$runner_state/install.json"
bun run dev:runtime-status -- --json > "$runner_state/runtime-after.json"

export PATH="$THREADNOTE_BIN_DIR:$PATH"
test "$(command -v threadnote)" = "$THREADNOTE_BIN_DIR/threadnote"
threadnote --version | tee "$output_dir/version.txt"
threadnote install --no-model-setup --no-start
# Codex is required for setup discovery. The smoke tests Threadnote's CLI and
# local configuration ownership without a Codex broker or account.
cat > "$THREADNOTE_BIN_DIR/codex" <<'CODEX'
#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = --version ] || exit 1
echo "codex fixture"
CODEX
chmod +x "$THREADNOTE_BIN_DIR/codex"
threadnote mcp-install codex --name threadnote > "$runner_state/preview.log"
# shellcheck disable=SC2016 # Backticks appear literally in the diagnostic.
grep -F 'Set CODEX_HOME to the intended Codex home, then run `threadnote mcp-install codex --apply --name threadnote`' "$runner_state/preview.log" > "$output_dir/install-preview-guidance.txt"
test ! -e "$CODEX_HOME/config.toml"
threadnote mcp-install codex --apply --name threadnote
test -s "$CODEX_HOME/config.toml"
rm "$CODEX_HOME/config.toml"
threadnote doctor --dry-run > "$runner_state/doctor.log"
# shellcheck disable=SC2016 # Backticks appear literally in the diagnostic.
grep -F 'Set CODEX_HOME to the recorded Codex home, then run `threadnote mcp-install codex --apply --name threadnote`' "$runner_state/doctor.log" > "$output_dir/doctor-guidance.txt"
if grep -Fq 'Set CODEX_HOME to <local-path>' "$runner_state/doctor.log" ||
   grep -Fq "$CODEX_HOME" "$output_dir/doctor-guidance.txt"; then
  exit 1
fi
test ! -e "$CODEX_HOME/config.toml"

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
