#!/usr/bin/env bash
set -euo pipefail
umask 077

private_root=$(mktemp -d /tmp/threadnote-p11-linux.XXXXXX)
summary="${RUNNER_TEMP:?}/threadnote-p11-linux-read.json"
attempts="$private_root/attempts.jsonl"
: > "$attempts"
stage=source
source_commit=
source_tree=
manifest_sha=
binary_sha=
release_sha=
harness_sha=
asset_sha=

# The EXIT trap calls this function.
# shellcheck disable=SC2329
write_summary() {
  local code=$?
  if [[ "$stage" != complete && "$code" == 0 ]]; then code=1; fi
  jq -n --slurpfile attempts "$attempts" --argjson exitCode "$code" --arg stage "$stage" \
    --arg sourceCommit "$source_commit" --arg sourceTree "$source_tree" \
    --arg candidateManifestSha256 "$manifest_sha" --arg binarySha256 "$binary_sha" \
    --arg releaseSha256 "$release_sha" --arg harnessSha256 "$harness_sha" --arg assetManifestSha256 "$asset_sha" '
    $ARGS.named | del(.exitCode) + {
      version: 1, platform: "ubuntu-24.04-linux-x64-baseline", scope: "partial-read-fixtures",
      status: (if $exitCode == 0 then "partial-pass" else "failed" end),
      productionQualified: false, attempts: $attempts
    }' > "$summary" || exit 1
  exit "$code"
}
trap write_summary EXIT

file_sha() { sha256sum < "$1" | cut -d ' ' -f 1; }
exact_checkout() {
  local head tree status
  head=$(git rev-parse HEAD) && tree=$(git rev-parse 'HEAD^{tree}') &&
    status=$(git status --porcelain=v1 --untracked-files=all) &&
    [[ "$head" == "$source_commit" && "$tree" == "$source_tree" && -z "$status" ]]
}

[[ "${EXPECTED_HEAD:?}" =~ ^[a-f0-9]{40}$ ]]
source_commit=$EXPECTED_HEAD
[[ "${ASSET_HEAD:?}" == "$source_commit" ]]
source_tree=$(git rev-parse 'HEAD^{tree}')
exact_checkout
stage=host
[[ "${RUNNER_OS:?}" == Linux && "${RUNNER_ARCH:?}" == X64 ]]
# Use a private directory on an admitted host filesystem for the fixture homes and retained private receipts.
TMPDIR=$private_root bun --eval '
  import {runtimeNativePlatformTarget,runtimeOpenPrivateWriterDirectory,runtimeClosePrivateWriterDirectory} from "@threadnote/platform/system";
  if (runtimeNativePlatformTarget() !== "linux-x64-baseline") process.exit(1);
  runtimeClosePrivateWriterDirectory(runtimeOpenPrivateWriterDirectory(Bun.env.TMPDIR));
' > "$private_root/host.log" 2>&1

stage=build
test -d "${THREADNOTE_TYPESCRIPT_NATIVE_ASSET_DIR:?}"
target=bun-linux-x64-baseline
version="$(jq -er '.version' package.json)-local.g$source_commit"
THREADNOTE_BUILD_TARGET=$target THREADNOTE_DEVELOPMENT_BUILD_VERSION=$version \
  bun run build > "$private_root/build.log" 2>&1
exact_checkout
binary="$(pwd -P)/dist/threadnote"
release="$(dirname "$binary")/release.json"
asset="$(dirname "$binary")/runtime/typescript"
jq -e --arg commit "$source_commit" --arg tree "$source_tree" --arg target "$target" --arg version "$version" '
  .sourceIdentity.commit == $commit and .sourceIdentity.tree == $tree and
  .sourceIdentity.target == $target and .target == $target and .version == $version and
  .typescriptNativeAsset.manifest == "runtime/typescript/manifest.json"
' "$release" > /dev/null
provider_version=$(jq -er '.typescriptNativeAsset.version' "$release")
binary_sha=$(file_sha "$binary")
release_sha=$(file_sha "$release")
harness_sha=$(file_sha apps/threadnote/test/evaluation/semantic-qualification/candidate.ts)
asset_sha=$(file_sha "$asset/manifest.json")
manifest="$private_root/candidate.json"
jq -n --arg binary "$binary" --arg binarySha256 "$binary_sha" --arg releaseSha256 "$release_sha" \
  --arg sourceCommit "$source_commit" --arg sourceTree "$source_tree" '$ARGS.named' > "$manifest"
manifest_sha=$(file_sha "$manifest")

stage=fixtures
for notice in typescript-native:TYPESCRIPT_LICENSE.txt typescript-native-notice:TYPESCRIPT_NOTICE.txt \
  tsc:TSC_LICENSE.txt go-runtime:GO_LICENSE.txt bundled:BUNDLED_NOTICE.txt; do
  file="$asset/${notice#*:}"
  notice_sha=$(file_sha "$file")
  jq -nc --arg component "${notice%:*}" --arg file "$file" --arg sha256 "$notice_sha" '$ARGS.named'
done > "$private_root/notices.jsonl"

failed=0
for branch in provider-free typescript javascript; do
  exact_checkout
  input_sha=
  receipt="$private_root/$branch-receipt.json"
  args=(--candidate-manifest "$manifest" --output "$receipt")
  if [[ "$branch" != provider-free ]]; then
    inputs="$private_root/$branch-inputs.json"
    jq -n --arg language "$branch" --arg providerVersion "$provider_version" --arg assetDirectory "$asset" \
      --slurpfile notices "$private_root/notices.jsonl" '$ARGS.named + {version: 1, notices: $notices}' > "$inputs"
    input_sha=$(file_sha "$inputs")
    args+=(--provider-inputs "$inputs")
  fi
  code=0
  TMPDIR=$private_root bun scripts/qualify-semantic-providers.ts "${args[@]}" \
    > "$private_root/$branch.log" 2>&1 || code=$?
  receipt_sha=
  outcome=failed
  if [[ -f "$receipt" && ! -L "$receipt" ]] && [[ $(stat -c %s "$receipt") -le 2097152 ]]; then
    receipt_sha=$(file_sha "$receipt")
    if [[ "$code" == 2 ]] && jq -e --arg branch "$branch" --arg input "$input_sha" --arg manifest "$manifest_sha" \
      --arg commit "$source_commit" --arg tree "$source_tree" --arg binary "$binary_sha" --arg release "$release_sha" \
      --arg harness "$harness_sha" --arg version "$version" '
      .schemaVersion == 1 and .kind == "candidate-transport-branch" and .scenario == "S33" and .status == "passed" and
      .manifestSha256 == $manifest and .harnessSha256 == $harness and
      .candidate.sourceCommit == $commit and .candidate.sourceTree == $tree and
      .candidate.binarySha256 == $binary and .candidate.releaseSha256 == $release and
      .candidate.release.version == $version and .candidate.nativeHostTarget == "linux-x64-baseline" and
      .candidate.finalCombinedCandidate == false and .fullScenarioQualified == false and
      .releaseGate.status == "blocked" and .releaseGate.productionQualified == false and
      .releaseGate.counts.qualifiedCells == 0 and .writerRecords == [] and
      .cleanup.mcpCloseCompleted == true and .cleanup.mcpCloseObserved == true and
      .cleanup.ownedProcessesGone == true and .cleanup.fixtureRemoved == true and
      (if $branch == "provider-free" then
        .branch == "unavailable-provider" and .provider.started == false and .provider.artifact == null
      else
        .branch == "pinned-provider-read-fixture" and .provider.started == true and
        .provider.artifact.input.language == $branch and .provider.artifact.manifestSha256 == $input and
        .providerChecks.navigation.status == "passed" and .cleanup.semantic.drained == true and
        .cleanup.semantic.admission.resolved == true and .cleanup.semantic.endpointsReleased == true
      end)' "$receipt" > /dev/null 2>&1; then
      outcome=partial-pass
    fi
  fi
  jq -nc --arg branch "$branch" --arg status "$outcome" --argjson exitCode "$code" \
    --arg providerManifestSha256 "$input_sha" --arg receiptSha256 "$receipt_sha" '$ARGS.named' >> "$attempts"
  if [[ "$outcome" != partial-pass ]]; then failed=1; fi
done

stage=final-source
exact_checkout
[[ "$(file_sha "$binary")" == "$binary_sha" && "$(file_sha "$release")" == "$release_sha" &&
  "$(file_sha "$asset/manifest.json")" == "$asset_sha" && "$(file_sha "$manifest")" == "$manifest_sha" ]]
stage=complete
exit "$failed"
