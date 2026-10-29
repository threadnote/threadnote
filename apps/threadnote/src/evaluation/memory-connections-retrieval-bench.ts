import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {readMemoryRecordsByUri} from '../memory/commands.js';
import {formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {retrieveRecallMemoryConnections} from '@threadnote/recall/memory/connections';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  assertApprovedMemoryConnectionsRetrievalBenchFixture,
  evaluateMemoryConnectionsRetrievalBench,
  parseMemoryConnectionsRetrievalBenchFixtureV1,
  type MemoryConnectionsRetrievalBenchDocumentV1,
} from './memory-connections-retrieval-bench-contract.js';

const FIXTURE_URL = new URL(
  '../../test/evaluation/fixtures/memory-connections-retrieval-bench-v1/fixture.json',
  import.meta.url,
);
const FIXED_NOW = new Date('2026-08-31T12:00:00.000Z');
const encoder = new TextEncoder();

/** Execute reviewed C retrieval truth against canonical files and the production SQLite selector. */
export const runMemoryConnectionsRetrievalBench = Effect.fn('evaluation.memoryConnectionsRetrieval')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = JSON.parse(yield* fs.readFileString(yield* path.fromFileUrl(FIXTURE_URL))) as unknown;
  const fixture = parseMemoryConnectionsRetrievalBenchFixtureV1(raw);
  assertApprovedMemoryConnectionsRetrievalBenchFixture(fixture);
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connections-retrieval-'});
  const config = runtimeConfig(home);
  yield* Effect.forEach(fixture.documents, document => writeDocument(fs, path, home, document), {concurrency: 8});
  yield* loadRecallIndexData(config, {
    allowedUriScopes: [memoryRoot(config.user)],
    forceRefresh: true,
    includeInactive: true,
  });

  const observations = yield* Effect.forEach(
    fixture.cases,
    testCase =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeNanos;
        const result = yield* retrieveRecallMemoryConnections(config, {
          allowedUriScopes: [memoryRoot(config.user)],
          ...(testCase.includeHistorical === undefined ? {} : {includeHistorical: testCase.includeHistorical}),
          ...(testCase.limit === undefined ? {} : {limit: testCase.limit}),
          memoryRefs: testCase.memoryRefs,
          now: FIXED_NOW,
          readRecords: uris => readMemoryRecordsByUri(config, uris),
          ...(testCase.relationTypes === undefined ? {} : {relationTypes: testCase.relationTypes}),
        });
        const finished = yield* Clock.currentTimeNanos;
        const serializedResult = `${JSON.stringify({
          connections: result.connections,
          coverage: result.coverage,
          memories: EffectArray.map(result.candidates, candidate => ({
            memoryId: candidate.memoryId,
            uri: candidate.uri,
          })),
          premises: result.premises,
        })}\n`;
        const responseBytes = encoder.encode(serializedResult).byteLength;
        return {
          connectionCount: result.connections.length,
          connectionStates: EffectArray.map(result.connections, connection => ({
            currentness: connection.currentness,
            resolution: connection.resolution,
          })),
          elapsedMilliseconds: Number(finished - started) / 1_000_000,
          estimatedTokens: Math.ceil(responseBytes / 3),
          memoryIds: EffectArray.flatMap(result.candidates, candidate =>
            candidate.memoryId ? [candidate.memoryId] : [],
          ),
          premiseStates: EffectArray.map(result.premises, premise => premise.state),
          queryId: testCase.id,
          responseBytes,
          serializedResult,
        };
      }),
    {concurrency: 1},
  );
  return evaluateMemoryConnectionsRetrievalBench({fixture, observations});
});

function runtimeConfig(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'memory-connections-retrieval-bench',
    manifestPath: `${home}/manifest.yaml`,
    user: 'mc-retrieval',
  };
}

const writeDocument = Effect.fn('evaluation.memoryConnectionsRetrieval.writeDocument')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  document: MemoryConnectionsRetrievalBenchDocumentV1,
) {
  const filePath = path.join(
    home,
    'data',
    'local',
    'user',
    document.user,
    'memories',
    'durable',
    document.status === 'active' ? 'projects' : 'archived',
    'threadnote',
    `${document.topic}.md`,
  );
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: document.memoryId,
    project: 'threadnote',
    relations: document.relations,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: 'memory-connections-retrieval-bench',
    status: document.status,
    ...(document.supersedes === undefined ? {} : {supersedes: document.supersedes}),
    timestamp: '2026-08-31T00:00:00.000Z',
    topic: document.topic,
    ...(document.validFrom === undefined ? {} : {validFrom: document.validFrom}),
    ...(document.validTo === undefined ? {} : {validTo: document.validTo}),
  };
  yield* fs.makeDirectory(path.dirname(filePath), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(filePath, formatMemoryDocument('MEMORY', metadata, document.body));
});

function memoryRoot(user: string): string {
  return `threadnote://user/${user}/memories`;
}
