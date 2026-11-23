#!/bin/bash
set -euo pipefail

workspace="$(pwd -P)"
probe="$workspace/.github/ready-startup-probe"
output_dir="$workspace/.context/ready-startup-output"
work_root="$workspace/.context/ready-startup-work"
stock="$work_root/stock"
candidate="$work_root/candidate"
stock_trace="$work_root/stock-trace"
candidate_trace="$work_root/candidate-trace"
mkdir -p "$output_dir" "$work_root"
source "$probe/inputs.env"

exec > >(tee "$output_dir/run.log") 2>&1
test "$(uname -s)/$(uname -m)" = Darwin/arm64
uname -a
sw_vers
sysctl hw.ncpu hw.memsize
bun --version
rustc +1.89.0 --version
git rev-parse HEAD
git worktree add --detach "$stock" "$STOCK_COMMIT"
git worktree add --detach "$candidate" "$CANDIDATE_COMMIT"

build_arm() (
  cd "$1"
  test "$(git rev-parse HEAD)" = "$2"
  test -z "$(git status --porcelain=v1)"
  git rev-parse HEAD 'HEAD^{tree}'
  bun install --frozen-lockfile
  bun run build:release
  bun scripts/verify-native-vector-reader.ts --required
  test -z "$(git status --porcelain=v1)"
  test "$(git rev-parse HEAD)" = "$2"
)
build_arm "$stock" "$STOCK_COMMIT"
if [[ "$CANDIDATE_COMMIT" = "$STOCK_COMMIT" ]]; then
  cp -cR "$stock/dist" "$candidate/dist"
else
  build_arm "$candidate" "$CANDIDATE_COMMIT"
fi
cp -cR "$stock/dist" "$stock_trace"
cp -cR "$candidate/dist" "$candidate_trace"
(cd "$stock" && bun "$probe/build-trace.ts" "$stock_trace")
if [[ "$CANDIDATE_COMMIT" = "$STOCK_COMMIT" ]]; then
  cp -p "$stock_trace/threadnote" "$stock_trace/threadnote.map" "$candidate_trace/"
else
  (cd "$candidate" && bun "$probe/build-trace.ts" "$candidate_trace" "$CANDIDATE_WORKER")
fi

model_file="$stock/apps/threadnote/embedded/models/bge-small-en-v1.5-q8/f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804.gguf"
cd "$stock"
python3 "$probe/prepare.py"
export THREADNOTE_STARTUP_STOCK_COMMIT="$STOCK_COMMIT"
export THREADNOTE_STARTUP_CANDIDATE_COMMIT="$CANDIDATE_COMMIT"
export THREADNOTE_STARTUP_STOCK_TRACE="$stock_trace"
export THREADNOTE_STARTUP_CANDIDATE_TRACE="$candidate_trace"
shasum -a 256 "$stock/dist/threadnote" "$candidate/dist/threadnote" \
  "$stock_trace/threadnote" "$candidate_trace/threadnote" \
  "$probe/stage-markers.ts" "$probe/build-trace.ts" "$probe/prepare.py" \
  "$model_file" scripts/ready-startup-observe.ts > "$output_dir/inputs.sha256"
run_case() {
  local capture="$output_dir/$4.json"
  bun scripts/ready-startup-observe.ts --production-path --documents "$1" --distribution dense --pairs "$2" --samples "$3" \
    --model-file "$model_file" --distribution-root "$candidate/dist" --baseline-distribution-root "$stock/dist" \
    --output "$capture"
  python3 "$probe/summarize.py" "$capture" > "$output_dir/$4-summary.json"
}
run_case 2 1 1 smoke
if [[ "$SMOKE_ONLY" = 0 ]]; then
  run_case 10000 8 30 dense-10000
fi
shasum -a 256 -c "$output_dir/inputs.sha256"
