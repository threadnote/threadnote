#!/usr/bin/env bash
set -euo pipefail
workspace="$(pwd -P)"
baseline_root="$workspace/.context/frozen-ts66"
control_root="$workspace/.context/rust-control"
output_dir="$workspace/.context/native-vector-capture"
model_file="$workspace/apps/threadnote/embedded/models/bge-small-en-v1.5-q8/f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804.gguf"
candidate=924f22749399cd8665299be99615426acc2fe3f0
control=e0a458cf1c0565e2bda310ebe0297f1083a04f89
baseline=66f4c1d8baed033ec484f4db2895ea2252b4e2d0

test "$(uname -m)" = aarch64
test "$THREADNOTE_BUILD_TARGET" = bun-linux-arm64-musl
test "$(git rev-parse HEAD)" = "$candidate"
test -f "$model_file"
test -z "$(git status --porcelain=v1 --untracked-files=normal)"
{
  printf 'mode=same-host-and-fixture-diagnostic\ncandidate=%s\ncontrol=%s\nbaseline=%s\n' "$candidate" "$control" "$baseline"
  printf 'candidate_tree=%s\n' "$(git rev-parse 'HEAD^{tree}')"
  printf 'baseline_tree=%s\n' "$(git rev-parse "$baseline^{tree}")"
  printf 'control_tree=%s\n' "$(git rev-parse "$control^{tree}")"
  printf 'image=%s\nsysroot=%s\n' "$THREADNOTE_NATIVE_BUILD_IMAGE" "$THREADNOTE_NATIVE_SYSROOT_IDENTITY"
  uname -m
  bun --version
  (ldd --version 2>&1 || true)
  sha256sum "$model_file"
} | tee "$output_dir/input-identities.txt"

git -c core.autocrlf=false -c core.eol=lf worktree add --detach "$baseline_root" "$baseline"
(
  cd "$baseline_root"
  bun install --frozen-lockfile --ignore-scripts --libc=glibc
  bun -e 'const fs=require("node:fs"),path=require("node:path");const root=fs.realpathSync(".")+path.sep;for(const name of fs.readdirSync("node_modules/@threadnote")){if(!fs.realpathSync(path.join("node_modules/@threadnote",name)).startsWith(root))throw Error("Baseline workspace link escaped its frozen checkout");}'
  THREADNOTE_DEVELOPMENT_BUILD_VERSION=5.3.6-local.g66f4c1d8baed033ec484f4db2895ea2252b4e2d0 bun run build
  test "$(git rev-parse HEAD)" = "$baseline"
  test -z "$(git status --porcelain=v1 --untracked-files=normal)"
)
bun scripts/benchmark-recall-vectors.ts --write-baseline-provenance \
  --baseline-source-root "$baseline_root" --baseline-distribution-root "$baseline_root/dist" \
  --baseline-install-command 'bun install --frozen-lockfile --ignore-scripts --libc=glibc'
bun run build:release
bun scripts/verify-native-vector-reader.ts --required
test -z "$(git status --porcelain=v1 --untracked-files=normal)"
bun scripts/assemble-native-inference.ts --stage-overlay "$workspace/dist" --distribution-root "$baseline_root/dist"

git worktree add --detach "$control_root" "$control"
(
  cd "$control_root"
  bun -e '
    const {MUSL_BUILD_DEPENDENCY_INSTALL} = await import(process.argv[1]);
    const child = Bun.spawn(["sh", "-ec", MUSL_BUILD_DEPENDENCY_INSTALL], {
      stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    if (await child.exited) throw Error("Pinned musl dependency preparation failed.");
  ' "$workspace/scripts/assemble-native-inference.ts"
  test "$(git rev-parse HEAD)" = "$control"
  test -z "$(git status --porcelain=v1 --untracked-files=normal)"
  bun run build:release
  bun scripts/verify-native-vector-reader.ts --required
  test -z "$(git status --porcelain=v1 --untracked-files=normal)"
)
export THREADNOTE_RECALL_AB_CONTROL_DIST="$control_root/dist"

# Keep both exact native builds intact. Restore the released dual-index fixture and add one diagnostic control arm.
git apply .context/native-vector-capture/frozen-lexical.patch
git apply .context/native-vector-capture/control-arm.patch
test "$(git diff --name-only)" = scripts/benchmark-recall-vectors.ts
git diff --binary -- scripts/benchmark-recall-vectors.ts > "$output_dir/diagnostic-harness.patch"
sha256sum scripts/benchmark-recall-vectors.ts >> "$output_dir/input-identities.txt"

capture() {
  local documents="$1" distribution="$2" pairs="$3" samples="$4" stem="$5"
  bun scripts/benchmark-recall-vectors.ts --production-path --pairs "$pairs" --samples "$samples" \
    --documents "$documents" --distribution "$distribution" --model-file "$model_file" \
    --distribution-root "$workspace/dist" --baseline-distribution-root "$baseline_root/dist" \
    --baseline-source-root "$baseline_root" --output "$output_dir/$stem.json" \
    2>&1 | tee "$output_dir/$stem.log"
}
capture 2 dense 1 1 setup-smoke
capture 10000 tied 4 30 tied-10000
capture 100000 dense 4 12 dense-100000
