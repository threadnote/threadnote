#!/usr/bin/env bash
set -euo pipefail

proof_root="$RUNNER_TEMP/dev-install-proof"
evidence="$proof_root/evidence"
recall_commit=1d8e57c0ca3278c9a2e96cf8c54057703895f9fb
preflight_commit=1286e561ecdc1b359a3b8395fe21fa0e80cec2a3
release_commit=51ae33d45f4f5e07a4aff2eb40188280d49c0243
mkdir -p "$evidence" "$proof_root/repo"

if command -v codex >/dev/null || command -v claude >/dev/null; then
  printf '%s\n' 'The disposable runner unexpectedly has a supported MCP host installed.'
  exit 1
fi

git -C "$proof_root/repo" init -q -b main
printf '%s\n' 'export const graphSmokeSentinel = 21;' > "$proof_root/repo/fixture.ts"
git -C "$proof_root/repo" add fixture.ts
git -C "$proof_root/repo" -c user.name=ThreadnoteFixture -c user.email=fixture@example.invalid commit -qm 'Seed private graph fixture'

select_roots() {
  local scenario="$1"
  export THREADNOTE_HOME="$proof_root/$scenario/data"
  export THREADNOTE_INSTALL_ROOT="$proof_root/$scenario/install"
  export THREADNOTE_BIN_DIR="$proof_root/$scenario/bin"
  mkdir -p "$THREADNOTE_HOME" "$THREADNOTE_INSTALL_ROOT" "$THREADNOTE_BIN_DIR"
}

install_candidate() {
  local source="$1" commit="$2" receipt="$3"
  shift 3
  (
    cd "$GITHUB_WORKSPACE/$source"
    test "$(git rev-parse HEAD)" = "$commit"
    bun install --frozen-lockfile >&2
    bun run dev:install-global -- --json --terminate-superseded "$@"
  ) > "$receipt"
  jq -e --arg commit "$commit" '.sourceCommit == $commit and .active and .doctorVerified and .launchersVerified' "$receipt"
  test "$("$THREADNOTE_BIN_DIR/threadnote" --version)" = "threadnote v$(jq -r .version "$receipt")"
}

graph_path() {
  find "$THREADNOTE_HOME/indexes/code-graph/repositories" -type f -name 'graph-v*.sqlite' -print -quit
}

graph_revision() {
  TN_INSTALL_PROBE_DB="$(graph_path)" bun -e '
    import {Database} from "bun:sqlite";
    const db = new Database(process.env.TN_INSTALL_PROBE_DB, {readonly: true});
    try {
      console.log(db.query("SELECT value FROM schema_metadata WHERE key = ?")
        .get("persistent_extension_schema_revision").value);
    } finally {
      db.close();
    }
  '
}

select_roots compatible
install_candidate recall-source "$recall_commit" "$evidence/recall-install.json"
"$THREADNOTE_BIN_DIR/threadnote" graph index --cwd "$proof_root/repo" --no-vectors
test "$(graph_revision)" = 19
"$THREADNOTE_BIN_DIR/threadnote" doctor --dry-run --strict > "$evidence/compatible-doctor.txt"
"$THREADNOTE_BIN_DIR/threadnote" remember --kind durable --project install-smoke --topic smoke-sentinel \
  --keyword 'installed smoke sentinel' --text 'Synthetic installer smoke sentinel.'
"$THREADNOTE_BIN_DIR/threadnote" recall --query 'installed smoke sentinel' --project install-smoke \
  --no-infer-scope --caller-cwd "$proof_root/repo" --node-limit 2 > "$evidence/recall-cli.txt"
grep -F '/smoke-sentinel.md' "$evidence/recall-cli.txt"
(
  cd "$GITHUB_WORKSPACE/recall-source"
  TN_INSTALL_PROBE_CWD="$proof_root/repo" bun - <<'TS'
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: process.env.THREADNOTE_BIN_DIR + "/threadnote",
  args: ["mcp-server", "--home", process.env.THREADNOTE_HOME],
  env: {
    THREADNOTE_HOME: process.env.THREADNOTE_HOME,
    THREADNOTE_INSTALL_ROOT: process.env.THREADNOTE_INSTALL_ROOT,
    THREADNOTE_BIN_DIR: process.env.THREADNOTE_BIN_DIR,
  },
  cwd: process.env.TN_INSTALL_PROBE_CWD,
  stderr: "pipe",
});
transport.stderr?.on("data", () => undefined);
const client = new Client({name: "disposable-install-recall-smoke", version: "1"});
try {
  await client.connect(transport, {timeout: 15000});
  const result = await client.callTool({
    name: "recall_context",
    arguments: {
      callerCwd: process.env.TN_INSTALL_PROBE_CWD,
      query: "installed smoke sentinel",
      project: "install-smoke",
      inferScope: false,
      nodeLimit: 2,
      responseFormat: "dual",
    },
  }, undefined, {timeout: 15000});
  if (result.isError || !JSON.stringify(result).includes("/smoke-sentinel.md")) {
    throw new Error("Installed MCP did not recall the synthetic sentinel.");
  }
  console.log(JSON.stringify({sentinelMatched: true}));
} finally {
  await client.close();
}
TS
) > "$evidence/recall-mcp.json"

install_candidate preflight-source "$preflight_commit" "$evidence/preflight-install.json" --take-over-global-runtime
test "$(graph_revision)" = 19
compatible_install="$THREADNOTE_INSTALL_ROOT"
preflight_version="$(jq -r .version "$evidence/preflight-install.json")"

select_roots future
install_candidate release-source "$release_commit" "$evidence/release-install.json"
"$THREADNOTE_BIN_DIR/threadnote" graph index --cwd "$proof_root/repo" --no-vectors
test "$(graph_revision)" = 21
"$THREADNOTE_BIN_DIR/threadnote" doctor --dry-run --strict > "$evidence/future-before-doctor.txt"
future_graph="$(graph_path)"

# Reuse the exact package from the successful install. The installer revalidates the complete receipt.
test ! -e "$THREADNOTE_INSTALL_ROOT/versions/$preflight_version"
cp -pR "$compatible_install/versions/$preflight_version" "$THREADNOTE_INSTALL_ROOT/versions/"

snapshot_future() {
  shasum -a 256 "$THREADNOTE_INSTALL_ROOT/active-release.json" \
    "$THREADNOTE_INSTALL_ROOT/development-runtime-owner.json" \
    "$THREADNOTE_BIN_DIR/threadnote" "$THREADNOTE_BIN_DIR/threadnote-mcp-server" "$future_graph"
}

snapshot_future > "$evidence/future-before.sha256"
if (
  cd "$GITHUB_WORKSPACE/preflight-source"
  test "$(git rev-parse HEAD)" = "$preflight_commit"
  bun run dev:install-global -- --json --take-over-global-runtime --terminate-superseded
) > "$evidence/future-attempt.txt" 2>&1; then
  printf '%s\n' 'The older installer unexpectedly succeeded against revision 21.'
  exit 1
fi
grep -F 'The code graph requires a newer Threadnote runtime' "$evidence/future-attempt.txt"
snapshot_future > "$evidence/future-after.sha256"
cmp "$evidence/future-before.sha256" "$evidence/future-after.sha256"
test "$(graph_revision)" = 21
test "$("$THREADNOTE_BIN_DIR/threadnote" --version)" = "threadnote v$(jq -r .version "$evidence/release-install.json")"
"$THREADNOTE_BIN_DIR/threadnote" doctor --dry-run --strict > "$evidence/future-after-doctor.txt"

jq -n --arg recall "$recall_commit" --arg preflight "$preflight_commit" --arg release "$release_commit" \
  '{recallCommit: $recall,preflightCommit: $preflight,releaseCommit: $release,compatibleRevision:19,futureRevision:21,strictDoctorPassed:true,installedCliAndMcpPassed:true,preActivationRefusalPreservedState:true}' \
  | tee "$evidence/result.json"
