import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import {describe} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {ArchiveAction} from '@threadnote/memory/hygiene';
import {archiveMemoryForCompact, resourceStoreLocation} from '@threadnote/threadnote/mcp/server/memory';
import {
  createMemoryCodeCitation,
  MEMORY_SCHEMA_VERSION,
  MAX_SUPPORTED_MEMORY_SCHEMA_VERSION,
} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('MCP compact archive citation persistence', () => {
  it.effect('retains valid schema-v4 citation and source provenance as archive metadata', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config, location, store} = yield* compactArchiveFixture();
        const sourceUri = compactSourceUri('valid-citation');
        const citation = compactArchiveCitation();
        const original = formatMemoryDocument(
          'MEMORY',
          {
            createdAt: '2026-08-25T20:00:00.000Z',
            codeCitations: [citation],
            evidence: ['threadnote://memory/tn_compact_evidence'],
            kind: 'handoff',
            memoryId: 'tn_compact_source',
            project: 'threadnote',
            references: ['threadnote://memory/tn_compact_reference'],
            relations: [{type: 'evidence_for', uri: 'threadnote://memory/tn_compact_target'}],
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            sourceCommit: citation.sourceCommit,
            sourceObservedAt: '2026-08-26T20:00:00.000Z',
            status: 'active',
            supersedes: 'threadnote://memory/tn_compact_history',
            timestamp: '2026-08-26T20:00:00.000Z',
            topic: 'valid-citation',
          },
          'Compact must retain the precise evidence when archiving this handoff.',
        );
        yield* store.write(location, sourceUri, original, {mode: 'create'});

        const result = yield* archiveMemoryForCompact(config, compactArchiveAction(sourceUri, original));

        expect(result.isError).not.toBe(true);
        expect(Option.isNone(yield* Effect.option(store.stat(location, sourceUri)))).toBe(true);
        const entries = yield* store.list(location, 'threadnote://user/tester/memories/handoffs/archived/threadnote', {
          recursive: true,
        });
        expect(entries).toHaveLength(1);
        const archivedContent = yield* store.read(location, entries[0].uri);
        const archived = parseMemoryDocument(entries[0].uri, archivedContent);
        expect(archived?.metadata).toMatchObject({
          archivedFrom: sourceUri,
          codeCitations: [citation],
          createdAt: '2026-08-25T20:00:00.000Z',
          evidence: ['threadnote://memory/tn_compact_evidence'],
          memoryId: 'tn_compact_source',
          references: ['threadnote://memory/tn_compact_reference'],
          relations: [{type: 'evidence_for', uri: 'threadnote://memory/tn_compact_target'}],
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceCommit: citation.sourceCommit,
          sourceObservedAt: '2026-08-26T20:00:00.000Z',
          status: 'archived',
          supersedes: 'threadnote://memory/tn_compact_history',
          visibility: 'personal',
        });
        expect(archived?.metadata.citationErrors).toBeUndefined();
        expect(archived?.body).toBe(
          [
            'Archived original Threadnote memory.',
            '',
            'Compact must retain the precise evidence when archiving this handoff.',
          ].join('\n'),
        );
        expect(archived?.body).not.toContain(citation.id);
        expect(archived?.body).not.toContain(citation.fileContentHash.value);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('keeps canonical and indented future-schema sources intact', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config, location, store} = yield* compactArchiveFixture();
        const futureSchemaLines = [
          `schema_version: ${MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1}`,
          `  schema_version: ${MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1}`,
        ];

        for (const [index, schemaLine] of futureSchemaLines.entries()) {
          const sourceUri = compactSourceUri(`future-schema-${index}`);
          const original = compactRawMemory(`future-schema-${index}`, schemaLine);
          yield* store.write(location, sourceUri, original, {mode: 'create'});

          const result = yield* archiveMemoryForCompact(config, compactArchiveAction(sourceUri, original));
          const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

          expect(result.isError).toBe(true);
          expect(text).toContain('newer than supported');
          expect(yield* store.read(location, sourceUri)).toBe(original);
        }

        const archived = yield* store
          .list(location, 'threadnote://user/tester/memories/handoffs/archived/threadnote', {recursive: true})
          .pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed([])));
        expect(archived).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('keeps a malformed-citation source intact instead of demoting its citation to prose', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config, location, store} = yield* compactArchiveFixture();
        const sourceUri = compactSourceUri('malformed-citation');
        const original = compactRawMemory(
          'malformed-citation',
          `schema_version: ${MEMORY_SCHEMA_VERSION}`,
          'code_citation: {not-json}',
        );
        yield* store.write(location, sourceUri, original, {mode: 'create'});

        const result = yield* archiveMemoryForCompact(config, compactArchiveAction(sourceUri, original));
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBe(true);
        expect(text).toContain('malformed code citation metadata (invalid-json)');
        expect(yield* store.read(location, sourceUri)).toBe(original);
        const archived = yield* store
          .list(location, 'threadnote://user/tester/memories/handoffs/archived/threadnote', {recursive: true})
          .pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed([])));
        expect(archived).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const compactArchiveFixture = Effect.fn('test.compactArchiveFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-compact-archive-'});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'seed-manifest.yaml'),
    user: 'tester',
  };
  return {config, location: resourceStoreLocation(config), store: yield* ResourceStore};
});

function compactArchiveAction(uri: string, expectedContent: string): ArchiveAction {
  return {
    expectedContent,
    kind: 'handoff',
    project: 'threadnote',
    reason: 'older handoff for threadnote',
    sourceUris: [uri],
    topic: uri.split('/').at(-1)?.replace(/\.md$/u, ''),
    uri,
  };
}

function compactSourceUri(topic: string): string {
  return `threadnote://user/tester/memories/handoffs/active/threadnote/${topic}.md`;
}

function compactRawMemory(topic: string, ...extraHeaderLines: readonly string[]): string {
  return [
    'MEMORY',
    'kind: handoff',
    'status: active',
    'project: threadnote',
    `topic: ${topic}`,
    'source_agent_client: codex',
    'timestamp: 2026-08-26T20:00:00.000Z',
    ...extraHeaderLines,
    '',
    'This source must remain byte-for-byte intact when compact refuses to archive it.',
  ].join('\n');
}

function compactArchiveCitation() {
  return createMemoryCodeCitation({
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
    path: 'src/mcp_server_memory.ts',
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: 'c'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  });
}
