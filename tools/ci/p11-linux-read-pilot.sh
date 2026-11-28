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

# Upload only closed values from the bounded receipt. The receipt never supplies summary keys or free-form text.
receipt_diagnosis() {
  jq -cs --arg branch "$2" '
    def field($path): try getpath($path) catch null;
    def array: if type == "array" then . else [] end;
    def closed($values): . as $value | first($values[] | select(. == $value)) // null;
    def state: closed(["ok", "configured", "observed", "observing", "passed", "failed", "accepted", "running",
      "cancelling", "ready", "cancelled", "stale", "timeout", "unavailable", "unsupported", "conflict",
      "invalid-request", "budget-exceeded", "unknown"]);
    def compact: with_entries(select(.value != null));
    def asset_refusal:
      . as $message | first(
        ["missing-asset", "missing-manifest", "non-canonical-path", "no-reviewed-pin", "unsafe-asset", "pin-mismatch",
          "pin-mismatch: manifest-binary", "pin-mismatch: manifest-executable", "pin-mismatch: file-digest",
          "pin-mismatch: tree-entries", "pin-mismatch: tree-git-entry", "pin-mismatch: tree-bytes",
          "pin-mismatch: tree-digest"][] | select($message == "Native TypeScript session unavailable [\(.)]")
      ) // (if $message == "Native TypeScript session unavailable [group-writable-ancestor]; remove group write from the asset directory and its parents (chmod g-w <dir>)"
            then "group-writable-ancestor" else null end);
    if length != 1 or field([0, "schemaVersion"]) != 1 or field([0, "kind"]) != "candidate-transport-branch" then null else
      .[0] | (field(["status"]) | closed(["started", "failed", "passed"])) as $status |
      {
        receiptStatus: $status,
        failureCode: (field(["failureEvidence", "code"]) | closed(["protocol", "write", "exit", "closing",
          "capacity", "timeout", "rejected", "prerequisite"])),
        provision: (if $status != "failed" or $branch == "provider-free" then null
          elif (field(["candidate"]) | type) != "object" then "candidate-verification"
          elif field(["provider", "artifact"]) == null then "provider-input-verification"
          elif field(["providerChecks"]) == null then "provider-setup"
          else null end),
        assetRefusal: (if $status == "failed" and $branch != "provider-free" and field(["provider", "artifact"]) == null
          then field(["failure"]) | asset_refusal else null end),
        lastCli: (last((field(["operations"]) | array)[] |
          select(field(["args", 0]) == "semantic" or field(["args", 0]) == "graph") |
          (field(["args", 1]) | closed(["setup", "readiness", "query", "view", "change", "index"])) as $command |
          select($command != null) | {
            command: $command,
            operation: (field(["request", "operation"]) | closed(["definition", "references", "symbols", "rename", "context"])),
            result: ((field(["canonical", "status"]) // field(["canonical", "state"])) | state)
          } | compact) // null),
        lastStage: (last((field(["providerChecks", "navigation", "branches"]) | array)[] |
          (field(["operation"]) | closed(["explicit-saved-disk-readiness", "explicit-owned-buffer-readiness",
            "definition", "references", "owned-buffer-open", "owned-buffer-symbols", "owned-buffer-unapplied-preview",
            "owned-buffer-version-update", "stale-buffer-version-refusal", "owned-buffer-failure",
            "owned-buffer-close-failure", "complete-rename-preview", "proposal-status-parity", "unapplied-preflight",
            "read-capability-cannot-authorize-write", "semantic-context-graph-memory-join"])) as $operation |
          select($operation != null) | {
            operation: $operation,
            stage: ((field(["stage"]) // field(["observations", -1, "progress", "stage"])) |
              closed(["queued", "verifying-inputs", "preparing-project", "acquiring-provider", "initializing",
                "synchronizing", "checking-ready", "finalizing", "symbols", "preview", "disk-conservation",
                "version-update", "stale-version"])),
            result: ((field(["canonical", "status"]) // field(["result", "status"]) //
              field(["observations", -1, "progress", "state"]) // field(["observations", -1, "status"]) //
              field(["cleanup"]) // field(["status"])) | state),
            mcpResult: (field(["mcp", "canonical", "status"]) | state)
          } | compact) // null),
        cleanup: ({
          mcpCloseCompleted: field(["cleanup", "mcpCloseCompleted"]),
          mcpCloseObserved: field(["cleanup", "mcpCloseObserved"]),
          ownedProcessesGone: field(["cleanup", "ownedProcessesGone"]),
          fixtureRemoved: field(["cleanup", "fixtureRemoved"]),
          semanticDrained: field(["cleanup", "semantic", "drained"]),
          admissionResolved: field(["cleanup", "semantic", "admission", "resolved"]),
          endpointsReleased: field(["cleanup", "semantic", "endpointsReleased"])
        } | with_entries(select(.value | type == "boolean"))),
        cleanupState: (if field(["cleanup", "semantic", "drained"]) == false then "provider-drain-unconfirmed"
          elif (field(["cleanup", "closeFailure"]) | type) == "string" then "close-failed"
          elif (field(["cleanup", "fixtureRetained"]) | type) == "string" then "fixture-retained"
          else null end)
      } | compact
    end' "$1" 2>/dev/null || printf 'null\n'
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
  diagnosis=null
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
    diagnosis=$(receipt_diagnosis "$receipt" "$branch")
  fi
  jq -nc --arg branch "$branch" --arg status "$outcome" --argjson exitCode "$code" \
    --arg providerManifestSha256 "$input_sha" --arg receiptSha256 "$receipt_sha" \
    --argjson diagnosis "$diagnosis" '$ARGS.named' >> "$attempts"
  if [[ "$outcome" != partial-pass ]]; then failed=1; fi
done

stage=final-source
exact_checkout
[[ "$(file_sha "$binary")" == "$binary_sha" && "$(file_sha "$release")" == "$release_sha" &&
  "$(file_sha "$asset/manifest.json")" == "$asset_sha" && "$(file_sha "$manifest")" == "$manifest_sha" ]]
stage=complete
exit "$failed"
