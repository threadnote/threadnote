#!/bin/bash
set -euo pipefail
workspace="$(pwd -P)"
probe="$workspace/.context/darwin-recall-probe"
output_dir="$workspace/.context/native-vector-capture"
model_file="$workspace/apps/threadnote/embedded/models/bge-small-en-v1.5-q8/f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804.gguf"
baseline_root="$workspace/.context/frozen-ts66"
mkdir -p "$output_dir"
git -c core.autocrlf=false worktree add --detach "$baseline_root" 66f4c1d8baed033ec484f4db2895ea2252b4e2d0
baseline_install=(bun install --frozen-lockfile --ignore-scripts)
if [[ "$THREADNOTE_BUILD_TARGET" == *-musl ]]; then baseline_install+=(--libc=glibc); fi
baseline_install_command="${baseline_install[*]}"
(
  cd "$baseline_root"
  "${baseline_install[@]}"
  bun -e 'const fs=require("node:fs"),path=require("node:path");const root=fs.realpathSync(".")+path.sep;for(const name of fs.readdirSync("node_modules/@threadnote")){if(!fs.realpathSync(path.join("node_modules/@threadnote",name)).startsWith(root))throw Error("Baseline workspace link escaped its frozen checkout");}'
  THREADNOTE_DEVELOPMENT_BUILD_VERSION=5.3.6-local.g66f4c1d8baed033ec484f4db2895ea2252b4e2d0 bun run build
  baseline_status="$(git status --porcelain=v1 --untracked-files=normal)"
  if [[ -n "$baseline_status" ]]; then
    printf 'Frozen TS66 checkout changed during build:\n%s\n' "$baseline_status" >&2
    exit 1
  fi
)
bun scripts/benchmark-recall-vectors.ts --write-baseline-provenance \
  --baseline-source-root "$baseline_root" --baseline-distribution-root "$baseline_root/dist" \
  --baseline-install-command "$baseline_install_command"
bun run build:release
bun scripts/verify-native-vector-reader.ts --required
bun scripts/assemble-native-inference.ts --stage-overlay "$workspace/dist" --distribution-root "$baseline_root/dist"

cp -cR dist "$probe/trace-dist"
bun "$probe/build-trace.ts"
python3 "$probe/prepare.py"
shasum -a 256 dist/threadnote "$probe/trace-dist/threadnote" "$baseline_root/dist/threadnote" \
  dist/runtime/vector-reader/threadnote-vector-reader.node "$probe/trace-dist/runtime/vector-reader/threadnote-vector-reader.node" \
  scripts/r5-darwin-tail-observe.ts "$probe/build-trace.ts" "$probe/stage-markers.ts" > "$output_dir/inputs.sha256"
run_case() {
  bun scripts/r5-darwin-tail-observe.ts --production-path --documents "$1" --distribution dense --pairs "$2" --samples "$3" \
    --model-file "$model_file" --distribution-root "$workspace/dist" --baseline-source-root "$baseline_root" \
    --baseline-distribution-root "$baseline_root/dist" --output "$output_dir/$4.json" 2>&1 | tee "$output_dir/$4.log"
}
run_case 2 1 1 smoke
test -s "$output_dir/smoke.json.stages.jsonl"
run_case 10000 6 30 dense-10000
shasum -a 256 -c "$output_dir/inputs.sha256"
