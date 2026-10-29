import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  assertApprovedMemoryConnectionsBenchFixture,
  MEMORY_CONNECTIONS_BENCH_ABILITIES,
  MEMORY_CONNECTIONS_BENCH_APPROVED_FIXTURE_HASH,
  memoryConnectionsBenchFixtureHash,
  parseMemoryConnectionsBenchFixtureV1,
  type MemoryConnectionsBenchDocumentV1,
  type MemoryConnectionsExpectedProjectionRowV1,
  type MemoryConnectionsProjectionTraceV1,
} from '@threadnote/threadnote/evaluation/memory-connections-bench-contract';
import {formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {resolveAuthoredMemoryRelations} from '@threadnote/threadnote/memory/relations';
import {clearRecallIndexMemoryCache, loadRecallIndexData, recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {parseResourceId} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const FIXTURE_URL = new URL('../evaluation/fixtures/memory-connections-bench-v1/fixture.json', import.meta.url);

interface StoredProjectionRow {
  readonly relation_ordinal: number;
  readonly relation_origin: string;
  readonly relation_type: string;
  readonly source_memory_id: string;
  readonly target_locator_digest: string;
  readonly target_memory_id: string;
}

describe('MemoryConnectionsBench A+B', () => {
  effectIt.effect('freezes exact authoring-projection truth for all five memory abilities', () =>
    Effect.gen(function* () {
      const fixture = yield* readFixture;
      expect(fixture.productScope).toBe('authoring-projection');
      expect(fixture.abilities).toEqual(MEMORY_CONNECTIONS_BENCH_ABILITIES);
      expect(memoryConnectionsBenchFixtureHash(fixture)).toBe(MEMORY_CONNECTIONS_BENCH_APPROVED_FIXTURE_HASH);
      expect(() => assertApprovedMemoryConnectionsBenchFixture(fixture)).not.toThrow();

      const withUnknownField = {...fixture, retrievalClaims: []};
      expect(() => parseMemoryConnectionsBenchFixtureV1(withUnknownField)).toThrow(
        'object has unsupported or missing fields',
      );
      const missingTraceOperation = {
        ...fixture,
        projectionTraces: EffectArray.map(fixture.projectionTraces, trace => ({
          ...trace,
          operations: EffectArray.filter(trace.operations, operation => operation.kind !== 'target-id-change'),
        })),
      };
      expect(() => parseMemoryConnectionsBenchFixtureV1(missingTraceOperation)).toThrow(
        'missing reviewed projection operation target-id-change',
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('executes authoring cases and projection traces against the application runtime', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* readFixture;

      const authoringHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connections-authoring-'});
      const authoringConfig = yield* makeConfig(fs, path, authoringHome, 'memory-connections-bench');
      yield* Effect.forEach(fixture.authoring.documents, document => writeDocument(fs, path, authoringHome, document), {
        concurrency: 1,
      });
      for (const testCase of fixture.authoring.cases) {
        const program = resolveAuthoredMemoryRelations(authoringConfig, testCase.relations, {
          allowedUriScopes: testCase.allowedScopes,
          ...(testCase.sourceMemoryId === null ? {} : {sourceMemoryId: testCase.sourceMemoryId}),
        });
        if (testCase.expected.kind === 'success') {
          const result = yield* program;
          expect(result.relations, testCase.id).toEqual(testCase.expected.relations);
          expect(result.targets, testCase.id).toHaveLength(1);
        } else {
          const error = yield* Effect.flip(program);
          const message = error instanceof Error ? error.message : String(error);
          expect(message, testCase.id).toContain(testCase.expected.messageIncludes);
        }
      }

      yield* Effect.forEach(fixture.projectionTraces, trace => executeProjectionTrace(fs, path, trace), {
        concurrency: 1,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const readFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = JSON.parse(yield* fs.readFileString(yield* path.fromFileUrl(FIXTURE_URL))) as unknown;
  return parseMemoryConnectionsBenchFixtureV1(raw);
});

const executeProjectionTrace = Effect.fn('test.executeMemoryConnectionsProjectionTrace')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  trace: MemoryConnectionsProjectionTraceV1,
) {
  const home = yield* fs.makeTempDirectoryScoped({prefix: `threadnote-memory-connections-${trace.id}-`});
  const config = yield* makeConfig(fs, path, home, trace.user);
  yield* Effect.forEach(trace.initialDocuments, document => writeDocument(fs, path, home, document), {
    concurrency: 1,
  });

  let schemaChecked = false;
  for (const operation of trace.operations) {
    if (
      operation.kind === 'target-add' ||
      operation.kind === 'target-id-change' ||
      operation.kind === 'source-replace'
    ) {
      yield* writeDocument(fs, path, home, operation.document);
    } else if (operation.kind === 'target-delete' || operation.kind === 'source-delete') {
      yield* fs.remove(activeDocumentPath(path, home, operation.user, operation.topic));
    } else if (operation.kind === 'target-move') {
      yield* fs.rename(
        activeDocumentPath(path, home, operation.user, operation.fromTopic),
        activeDocumentPath(path, home, operation.user, operation.toTopic),
      );
    }

    const beforeClean = operation.kind === 'clean-rebuild' ? readProjectionRows(home) : undefined;
    if (operation.kind === 'clean-rebuild') {
      yield* fs.remove(path.join(home, 'indexes', 'lexical'), {force: true, recursive: true});
      yield* clearRecallIndexMemoryCache();
    }
    yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
    const actual = readProjectionRows(home);
    const expected = oracleRows(operation.expectedRows);
    expect(actual, `${trace.id}:${operation.kind}`).toEqual(expected);
    if (beforeClean !== undefined) expect(actual, `${trace.id}:clean-rebuild-parity`).toEqual(beforeClean);

    if (!schemaChecked) {
      expect(memoryLinksColumns(home)).toEqual([
        'source_document_id',
        'source_uri',
        'source_memory_id',
        'target_memory_id',
        'target_locator_digest',
        'relation_type',
        'relation_origin',
        'relation_ordinal',
      ]);
      schemaChecked = true;
    }
  }
});

const makeConfig = Effect.fn('test.makeMemoryConnectionsBenchConfig')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  user: string,
) {
  const manifestPath = path.join(home, 'seed-manifest.yaml');
  yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath,
    user,
  } satisfies RuntimeConfig;
});

const writeDocument = Effect.fn('test.writeMemoryConnectionsBenchDocument')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  document: MemoryConnectionsBenchDocumentV1,
) {
  const target = documentPath(path, home, document);
  yield* fs.makeDirectory(path.dirname(target), {recursive: true});
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: document.memoryId,
    project: 'threadnote',
    relations: document.relations,
    sourceAgentClient: 'memory-connections-bench',
    status: document.status,
    timestamp: '2026-08-31T00:00:00.000Z',
    topic: document.topic,
  };
  yield* fs.writeFileString(target, formatMemoryDocument('MEMORY', metadata, `${document.topic} benchmark body`));
});

function documentPath(path: Path.Path, home: string, document: MemoryConnectionsBenchDocumentV1): string {
  return document.status === 'active'
    ? activeDocumentPath(path, home, document.user, document.topic)
    : path.join(
        home,
        'data',
        'local',
        'user',
        document.user,
        'memories',
        'durable',
        'archived',
        'threadnote',
        `${document.topic}.md`,
      );
}

function activeDocumentPath(path: Path.Path, home: string, user: string, topic: string): string {
  return path.join(home, 'data', 'local', 'user', user, 'memories', 'durable', 'projects', 'threadnote', `${topic}.md`);
}

/** Independent semantic oracle: fixture target refs define selectors without calling projection code. */
function oracleRows(rows: readonly MemoryConnectionsExpectedProjectionRowV1[]): readonly StoredProjectionRow[] {
  return EffectArray.map(rows, row => ({
    relation_ordinal: row.relationOrdinal,
    relation_origin: row.relationOrigin,
    relation_type: row.relationType,
    source_memory_id: row.sourceMemoryId,
    target_locator_digest: Effect2.pipe(row.targetRef, EffectString.startsWith('threadnote://memory/'))
      ? ''
      : oracleLocatorDigest(row.targetRef),
    target_memory_id: row.targetMemoryId ?? '',
  })).sort(compareStoredRows);
}

function oracleLocatorDigest(uri: string): string {
  return sha256HexSync(
    JSON.stringify({kind: 'memory-link-locator', uri: parseResourceId(uri).canonicalUri, version: 1}),
  );
}

function readProjectionRows(home: string): readonly StoredProjectionRow[] {
  const database = openRecallDatabase(home);
  try {
    return database
      .query<StoredProjectionRow, []>(
        `SELECT
          source_memory_id,
          target_memory_id,
          target_locator_digest,
          relation_type,
          relation_origin,
          relation_ordinal
        FROM memory_links
        ORDER BY source_memory_id, relation_origin, relation_ordinal, relation_type, target_memory_id, target_locator_digest`,
      )
      .all();
  } finally {
    database.close();
  }
}

function memoryLinksColumns(home: string): readonly string[] {
  const database = openRecallDatabase(home);
  try {
    return EffectArray.map(
      database.query<{readonly name: string}, []>('PRAGMA table_info(memory_links)').all(),
      row => row.name,
    );
  } finally {
    database.close();
  }
}

function openRecallDatabase(home: string): Database {
  return new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(false)}`, {readonly: true});
}

function compareStoredRows(left: StoredProjectionRow, right: StoredProjectionRow): number {
  const leftKey = `${left.source_memory_id}\n${left.relation_origin}\n${left.relation_ordinal}\n${left.relation_type}\n${left.target_memory_id}\n${left.target_locator_digest}`;
  const rightKey = `${right.source_memory_id}\n${right.relation_origin}\n${right.relation_ordinal}\n${right.relation_type}\n${right.target_memory_id}\n${right.target_locator_digest}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
