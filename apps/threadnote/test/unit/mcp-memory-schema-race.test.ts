import {expect, it} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {preparePersonalMemoryWrite, writeDurableMemory} from '@threadnote/threadnote/mcp/server/memory';
import {MEMORY_SCHEMA_VERSION, MAX_SUPPORTED_MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {recordMemoryRelocation} from '@threadnote/memory/relocation';
import {resolveAuthoredMemoryRelations} from '@threadnote/threadnote/memory/relations';
import {loadRecallIndex} from '@threadnote/recall/index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('MCP personal-memory schema rewrite guard', () => {
  it.effect('preserves a receipt-witnessed identity when replacing an id-less destination by alias', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-receipt-replace-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/mcp-receipt-source.md';
        const targetUri = 'threadnote://user/tester/memories/durable/projects/threadnote/mcp-receipt-target.md';
        const memoryId = 'tn_mcp_receipt_replace';
        const metadata: MemoryMetadata = {
          kind: 'durable',
          memoryId,
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'mcp',
          status: 'active',
          timestamp: '2026-09-18T00:00:00.000Z',
          topic: 'mcp-receipt-target',
        };
        const original = formatMemoryDocument('MEMORY', metadata, 'MCP receipt replacement source.');
        const missingIdentity = original.replace(`memory_id: ${memoryId}\n`, '');
        const store = yield* ResourceStore;
        const location = {account: config.account, home, user: config.user};
        yield* store.write(location, sourceUri, original, {mode: 'create'});
        yield* store.write(location, targetUri, original, {mode: 'create'});
        yield* recordMemoryRelocation(config, {
          fromContent: original,
          fromUri: sourceUri,
          toContent: original,
          toUri: targetUri,
        });
        yield* store.remove(location, sourceUri);
        yield* store.write(location, targetUri, missingIdentity, {mode: 'upsert'});
        yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});

        const result = yield* writeDurableMemory(config, {
          bodyText: 'MCP receipt replacement keeps its stable identity.',
          metadata: {...metadata, memoryId: undefined},
          replaceUri: memoryIdentityAlias(memoryId),
        });

        expect(result.isError).not.toBe(true);
        const updated = yield* store.read(location, targetUri);
        expect(updated).toContain(`memory_id: ${memoryId}`);
        expect(updated).toContain('MCP receipt replacement keeps its stable identity.');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('preserves the initial alias identity across path-reuse ABA during preparation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-alias-race-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/alias-race.md';
        const metadata: MemoryMetadata = {
          createdAt: '2026-09-17T00:00:00.000Z',
          kind: 'durable',
          memoryId: 'tn_alias_race_original',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'mcp',
          status: 'active',
          supersedes: 'threadnote://user/tester/memories/durable/projects/threadnote/alias-race-original.md',
          timestamp: '2026-09-18T00:00:00.000Z',
          topic: 'alias-race',
        };
        const original = formatMemoryDocument('MEMORY', metadata, 'Original alias target.');
        const reused = formatMemoryDocument(
          'MEMORY',
          {
            ...metadata,
            createdAt: '2026-09-19T00:00:00.000Z',
            memoryId: 'tn_alias_race_reused',
            supersedes: 'threadnote://user/tester/memories/durable/projects/threadnote/alias-race-reused.md',
            timestamp: '2026-09-20T00:00:00.000Z',
          },
          'A different identity reused the canonical path.',
        );
        const store = yield* ResourceStore;
        const location = {account: config.account, home, user: config.user};
        yield* store.write(location, uri, original, {mode: 'create'});
        const params = {
          bodyText: 'The alias-authorized replacement must retain its original identity.',
          expectedReplaceContent: original,
          expectedReplaceMemoryId: metadata.memoryId,
          metadata: {...metadata, memoryId: undefined},
          replaceUri: uri,
        } as const;
        yield* store.write(location, uri, reused, {mode: 'replace'});
        const prepared = yield* preparePersonalMemoryWrite(config, params);
        expect(prepared.finalMetadata.memoryId).toBe(metadata.memoryId);

        yield* store.write(location, uri, original, {mode: 'replace'});
        const result = yield* writeDurableMemory(config, {...params, prepared});

        expect(result.isError).not.toBe(true);
        const stored = yield* store.read(location, uri);
        expect(stored).toContain(`memory_id: ${metadata.memoryId}`);
        expect(stored).toContain(`created_at: ${metadata.createdAt}`);
        expect(stored).toContain(`supersedes: ${metadata.supersedes}`);
        expect(stored).toContain(`timestamp: ${metadata.timestamp}`);
        expect(stored).toContain('The alias-authorized replacement must retain its original identity.');
        expect(stored).not.toContain('tn_alias_race_reused');
        expect(stored).not.toContain('alias-race-reused.md');
        expect(stored).not.toContain('2026-09-19T00:00:00.000Z');
        expect(stored).not.toContain('2026-09-20T00:00:00.000Z');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a second writer that upgrades the replace target after preparation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-schema-race-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/schema-race.md';
        const metadata: MemoryMetadata = {
          kind: 'durable',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-26T20:00:00.000Z',
          topic: 'schema-race',
        };
        const original = formatMemoryDocument('MEMORY', metadata, 'Writer A observed schema v4.');
        const future = original
          .replace(
            `schema_version: ${MEMORY_SCHEMA_VERSION}`,
            `schema_version: ${MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1}`,
          )
          .replace('\n\n', '\nfuture_writer_field: preserve-me\n\n');
        const store = yield* ResourceStore;
        const location = {account: config.account, home: config.agentContextHome, user: config.user};
        yield* store.write(location, uri, original, {mode: 'create'});
        const params = {
          bodyText: 'Writer A replacement must not overwrite writer B.',
          metadata,
          replaceUri: uri,
        } as const;
        const prepared = yield* preparePersonalMemoryWrite(config, params);

        yield* store.write(location, uri, future, {mode: 'replace'});
        const result = yield* writeDurableMemory(config, {...params, prepared});
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBe(true);
        expect(text).toContain('newer than supported');
        expect(yield* store.read(location, uri)).toBe(future);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('leaves the source untouched when a validated relation target changes before commit', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-relation-race-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const targetUri = 'threadnote://user/tester/memories/durable/projects/threadnote/relation-target.md';
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/relation-source.md';
        const targetMetadata: MemoryMetadata = {
          kind: 'durable',
          memoryId: 'tn_relation_race_target',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-31T00:00:00.000Z',
          topic: 'relation-target',
        };
        const original = formatMemoryDocument('MEMORY', targetMetadata, 'Original relation target.');
        const changed = formatMemoryDocument('MEMORY', targetMetadata, 'Changed relation target.');
        const sourceMetadata: MemoryMetadata = {
          ...targetMetadata,
          memoryId: 'tn_relation_race_source',
          relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_relation_race_target'}],
          topic: 'relation-source',
        };
        const store = yield* ResourceStore;
        const location = {account: config.account, home: config.agentContextHome, user: config.user};
        yield* store.write(location, targetUri, original, {mode: 'create'});
        const params = {
          bodyText: 'Source must not commit against stale target bytes.',
          expectedSourceContent: [{content: original, uri: targetUri}],
          metadata: sourceMetadata,
        } as const;
        const prepared = yield* preparePersonalMemoryWrite(config, params);

        yield* store.write(location, targetUri, changed, {mode: 'replace'});
        const result = yield* writeDurableMemory(config, {...params, prepared});
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBe(true);
        expect(text).toContain('changed after this mutation was planned');
        expect(yield* store.read(location, targetUri)).toBe(changed);
        expect(Exit.isFailure(yield* Effect.exit(store.read(location, sourceUri)))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects a relation commit when the target identity becomes conflicted after validation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-relation-identity-race-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const scope = 'threadnote://user/tester/memories';
        const targetUri = 'threadnote://user/tester/memories/durable/projects/threadnote/identity-target.md';
        const conflictUri = 'threadnote://user/tester/memories/durable/projects/threadnote/identity-conflict.md';
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/identity-source.md';
        const targetMetadata: MemoryMetadata = {
          kind: 'durable',
          memoryId: 'tn_relation_identity_race_target',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-31T00:00:00.000Z',
          topic: 'identity-target',
        };
        const target = formatMemoryDocument('MEMORY', targetMetadata, 'Original identity target.');
        const store = yield* ResourceStore;
        const location = {account: config.account, home: config.agentContextHome, user: config.user};
        yield* store.write(location, targetUri, target, {mode: 'create'});
        const authored = yield* resolveAuthoredMemoryRelations(config, [{type: 'depends_on', uri: targetUri}], {
          allowedUriScopes: [scope],
          sourceMemoryId: 'tn_relation_identity_race_source',
        });
        const sourceMetadata: MemoryMetadata = {
          ...targetMetadata,
          memoryId: 'tn_relation_identity_race_source',
          relations: authored.relations,
          topic: 'identity-source',
        };
        const conflict = formatMemoryDocument(
          'MEMORY',
          {...targetMetadata, topic: 'identity-conflict'},
          'Divergent content introduces an identity conflict.',
        );

        // A serialized writer advances the durable canonical generation. The
        // identity recheck must reconcile that generation before committing.
        yield* store.write(location, conflictUri, conflict, {mode: 'create'});
        const result = yield* writeDurableMemory(config, {
          bodyText: 'The source must not commit against an ambiguous identity.',
          expectedSourceContent: authored.targets,
          metadata: sourceMetadata,
        });
        const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');

        expect(result.isError).toBe(true);
        expect(text).toContain('identity became ambiguous or moved during the write');
        expect(yield* store.read(location, targetUri)).toBe(target);
        expect(yield* store.read(location, conflictUri)).toBe(conflict);
        expect(Exit.isFailure(yield* Effect.exit(store.read(location, sourceUri)))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
