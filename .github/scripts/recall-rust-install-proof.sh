#!/usr/bin/env bash
set -euo pipefail
proof_root="$RUNNER_TEMP/recall-proof"
export THREADNOTE_HOME="$proof_root/data"
export THREADNOTE_INSTALL_ROOT="$proof_root/install"
export THREADNOTE_BIN_DIR="$proof_root/bin"
mkdir -p "$THREADNOTE_HOME" "$THREADNOTE_INSTALL_ROOT" "$THREADNOTE_BIN_DIR" "$proof_root/evidence"
cd "$GITHUB_WORKSPACE/candidate-source"
test "$(git rev-parse HEAD)" = "$PROOF_COMMIT"
bun install --frozen-lockfile
bun run dev:install-global -- --json --terminate-superseded > "$proof_root/evidence/install.json"
jq -e --arg sha "$PROOF_COMMIT" '.sourceCommit == $sha and .active and .doctorVerified and .launchersVerified' "$proof_root/evidence/install.json"
test "$("$THREADNOTE_BIN_DIR/threadnote" --version)" = "threadnote v$(jq -r .version "$proof_root/evidence/install.json")"
test_path="apps/threadnote/test/integration/installed-rust-proof.test.ts"
trap 'rm -f "$test_path"' EXIT
sed '/^const productionReadyWorker =/,$d' apps/threadnote/test/integration/vector-native-read-boundary.test.ts > "$test_path"
cat >> "$test_path" <<'TS'
effectIt.effect('installed launcher returns exact scoped and tied Rust scores', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const system = yield* SystemInfo;
    const launcher = f.path.join(process.env.THREADNOTE_BIN_DIR!, 'threadnote');
    const boundary = yield* makeReadyRecallReadBoundary(undefined).pipe(
      Effect.provideService(SystemInfo, {...system, executablePath: launcher}),
    );
    const opening = yield* boundary.read({operation: 'vector-state', config: f.config, options: {model}});
    const proof = yield* Schema.decodeUnknownEffect(recallVectorQueryStateSchema)(opening.value);
    if (proof.readiness !== 'current') return yield* Effect.die('The installed worker did not open the fixture.');
    const options = {model, state: proof.state, queryVector: vector, limit: 1};
    const scoped = yield* boundary.read({operation: 'vector-scores', config: f.config, options: {...options, eligibility: f.scope}});
    expect(scoped.outcome).toBe('success');
    expect(scoped.value).toEqual([[f.uris[0], 1]]);
    const db = new Database(f.database, {readonly: true});
    let expected: string;
    try {
      const rows = db.query<{chunk_id: string; uri: string}, []>('SELECT chunk_id, uri FROM vector_chunks').all();
      expect(rows).toHaveLength(2);
      rows.sort((a,b) => a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0);
      expected = rows[0]!.uri;
    } finally {
      db.close();
    }
    const tied = yield* boundary.read({operation: 'vector-scores', config: f.config, options});
    expect(tied.outcome).toBe('success');
    expect(tied.value).toEqual([[expected, 1]]);
  }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  {timeout: 30_000},
);
TS
bun --bun vitest run --maxWorkers=1 --no-file-parallelism "$test_path" 2>&1 | tee "$proof_root/evidence/installed-reader.log"
jq -n --arg commit "$PROOF_COMMIT" '{commit:$commit,installed:true,strictDoctor:true,scopedScores:true,tiedCutoff:true}' > "$proof_root/evidence/result.json"
