import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {ResourceStore} from '@threadnote/store/resource-store';
import {readMemoryRecordsByUri} from '@threadnote/threadnote/memory/commands';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, type MemoryMetadata, type MemoryRelation} from '@threadnote/memory/document';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {recordMemoryRelocation} from '@threadnote/memory/relocation';
import {
  classifyRecallMemoryPremiseState,
  parseRecallMemoryConnectionInput,
  retrieveRecallMemoryConnections,
} from '@threadnote/recall/memory/connections';
import {loadRecallIndexData, loadRecallMemoryLinks} from '@threadnote/recall/index';
import {rankRecallCandidates, type RecallCandidate} from '@threadnote/recall/rank';
import {prepareRecallSections} from '@threadnote/recall/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CURRENT = new Date('2026-08-31T12:00:00.000Z');

describe('recall memory connections', () => {
  it('normalizes bounded memory references and the closed relation vocabulary', () => {
    expect(
      parseRecallMemoryConnectionInput({
        memoryRefs: [
          'tn_target',
          'threadnote://memory/tn_target',
          'threadnote://user/test/memories/durable/projects/threadnote/source.md',
          'threadnote://memory/tn_target',
        ],
        relationTypes: ['supersedes', 'depends_on', 'supersedes'],
      }),
    ).toEqual({
      memoryRefs: [
        'threadnote://memory/tn_target',
        'threadnote://user/test/memories/durable/projects/threadnote/source.md',
      ],
      relationTypes: ['depends_on', 'supersedes'],
    });

    expect(() =>
      parseRecallMemoryConnectionInput({
        memoryRefs: Array.from({length: 9}, (_, index) => `threadnote://memory/tn_${index}`),
      }),
    ).toThrow('at most 8');
    expect(() =>
      parseRecallMemoryConnectionInput({memoryRefs: ['threadnote://resources/repos/threadnote/README.md']}),
    ).toThrow('managed memory');
    expect(() => parseRecallMemoryConnectionInput({memoryRefs: ['tn:not-a-memory-id']})).toThrow(
      'Invalid memory reference',
    );
    expect(() =>
      parseRecallMemoryConnectionInput({
        memoryRefs: ['threadnote://user/test/memories/durable/projects/threadnote/source.md#decision'],
      }),
    ).toThrow('whole managed memory');
    expect(() =>
      parseRecallMemoryConnectionInput({
        memoryRefs: ['threadnote://memory/tn_target'],
        relationTypes: ['causes'],
      }),
    ).toThrow('Unknown memory relation type');
  });

  it('derives currentness before recency and abstains on unresolved or conflicting evidence', () => {
    expect(classifyRecallMemoryPremiseState({resolved: false}, CURRENT)).toBe('unresolved');
    expect(classifyRecallMemoryPremiseState({identityConflict: true, resolved: true}, CURRENT)).toBe('conflicted');
    expect(classifyRecallMemoryPremiseState({resolved: true, status: 'archived'}, CURRENT)).toBe('historical');
    expect(
      classifyRecallMemoryPremiseState(
        {resolved: true, status: 'active', validTo: '2026-08-30T00:00:00.000Z'},
        CURRENT,
      ),
    ).toBe('historical');
    expect(
      classifyRecallMemoryPremiseState({activeSupersederCount: 1, resolved: true, status: 'active'}, CURRENT),
    ).toBe('historical');
    expect(
      classifyRecallMemoryPremiseState({activeSupersederCount: 2, resolved: true, status: 'active'}, CURRENT),
    ).toBe('conflicted');
    expect(classifyRecallMemoryPremiseState({resolved: true, status: 'active'}, CURRENT)).toBe('current');
  });

  it('keeps direct one-hop candidates ahead of topical backfill without making the relation an entailment', () => {
    const direct = candidate('threadnote://memory/tn_direct', 'unrelated dependency body');
    const topical = candidate('threadnote://memory/tn_topical', 'allocator regression recovery procedure', {
      semantic: 1,
    });
    const ranked = rankRecallCandidates('allocator regression recovery', [topical, direct], {
      minimumScore: 0.3,
      now: CURRENT,
      protectedUris: [direct.uri],
      seedUris: ['threadnote://memory/tn_seed'],
    });

    expect(EffectArray.map(ranked.results, result => result.candidate.uri)).toEqual([direct.uri, topical.uri]);
    expect(ranked.results[0]?.passedRelevanceGate).toBe(false);
  });

  effectIt.effect('selects verified incoming and outgoing edges and stops after one hop', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connections-'});
      const config = runtimeConfig(home, 'connection-user');
      const seed = yield* writeMemory(fs, path, config, 'seed', 'tn_seed', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_target'},
      ]);
      yield* writeMemory(fs, path, config, 'target', 'tn_target', [
        {type: 'related_to', uri: 'threadnote://memory/tn_second_hop'},
      ]);
      yield* writeMemory(fs, path, config, 'second-hop', 'tn_second_hop');
      yield* writeMemory(fs, path, config, 'incoming', 'tn_incoming', [
        {type: 'evidence_for', uri: 'threadnote://memory/tn_seed'},
      ]);

      const selected = yield* loadRecallMemoryLinks(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        forceRefresh: true,
        includeInactive: true,
        memorySeeds: [{memoryId: 'tn_seed', requestedOrdinal: 0}],
      });
      expect(
        EffectArray.map(selected, link => [
          link.direction,
          link.relationType,
          link.sourceMemoryId,
          link.targetMemoryId,
        ]),
      ).toEqual([
        ['incoming', 'evidence_for', 'tn_incoming', 'tn_seed'],
        ['outgoing', 'depends_on', 'tn_seed', 'tn_target'],
      ]);
      const sharedOrdinal = yield* loadRecallMemoryLinks(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        includeInactive: true,
        limit: 8,
        memorySeeds: [
          {memoryId: 'tn_seed', requestedOrdinal: 0},
          {memoryId: 'tn_target', requestedOrdinal: 0},
        ],
      });
      expect(
        EffectArray.map(sharedOrdinal, link => [
          link.direction,
          link.relationType,
          link.sourceMemoryId,
          link.targetMemoryId,
        ]),
      ).toEqual([
        ['incoming', 'depends_on', 'tn_seed', 'tn_target'],
        ['incoming', 'evidence_for', 'tn_incoming', 'tn_seed'],
        ['outgoing', 'depends_on', 'tn_seed', 'tn_target'],
        ['outgoing', 'related_to', 'tn_target', 'tn_second_hop'],
      ]);

      const result = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed, 'tn_seed'],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
      });
      expect(result.premises).toEqual([
        expect.objectContaining({memoryId: 'tn_seed', requestedOrdinal: 0, state: 'current'}),
      ]);
      expect(EffectArray.map(result.candidates, candidate => candidate.memoryId)).toEqual(['tn_incoming', 'tn_target']);
      expect(
        EffectArray.map(result.connections, connection => [connection.direction, connection.relationType]),
      ).toEqual([
        ['incoming', 'evidence_for'],
        ['outgoing', 'depends_on'],
      ]);
      expect(result.diagnostics).toMatchObject({canonicalRereads: 4, rawLinkRows: 2});
      expect(EffectArray.map(result.candidates, candidate => candidate.memoryId)).not.toContain('tn_second_hop');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses one relocation witness for stable, current, and former explicit premise references', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* ResourceStore;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connections-relocation-'});
        const config = runtimeConfig(home, 'relocation-user');
        const location = {account: config.account, home, user: config.user};
        const memoryId = 'tn_relocated_connection_seed';
        const neighborMemoryId = 'tn_relocation_neighbor';
        const alias = memoryIdentityAlias(memoryId);
        const formerUri = `${memoryRoot(config.user)}/durable/projects/threadnote/former.md`;
        const currentUri = `${memoryRoot(config.user)}/shared/default/durable/projects/threadnote/current.md`;
        const content = formatMemoryDocument(
          'MEMORY',
          {
            kind: 'durable',
            memoryId,
            project: 'threadnote',
            relations: [{type: 'depends_on', uri: memoryIdentityAlias(neighborMemoryId)}],
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            status: 'active',
            timestamp: '2026-08-31T00:00:00.000Z',
            topic: 'relocated-connection-seed',
            visibility: 'shared',
          },
          'Relocated connection seed.',
        );
        yield* store.write(location, formerUri, content, {mode: 'create'});
        yield* store.write(location, currentUri, content, {mode: 'create'});
        yield* recordMemoryRelocation(config, {
          fromContent: content,
          fromUri: formerUri,
          toContent: content,
          toUri: currentUri,
        });
        yield* store.remove(location, formerUri);
        yield* store.write(
          location,
          currentUri,
          Effect2.pipe(content, EffectString.replace(`memory_id: ${memoryId}\n`, '')),
          {mode: 'upsert'},
        );
        yield* writeMemory(fs, path, config, 'relocation-neighbor', neighborMemoryId, [
          {type: 'related_to', uri: alias},
        ]);
        yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: true});

        for (const memoryRef of [alias, currentUri, formerUri]) {
          const result = yield* retrieveRecallMemoryConnections(config, {
            allowedUriScopes: [memoryRoot(config.user)],
            memoryRefs: [memoryRef],
            readRecords: uris => readMemoryRecordsByUri(config, uris),
          });
          expect(result.premises).toEqual([
            expect.objectContaining({memoryId, requestedRef: memoryRef, state: 'current', uri: currentUri}),
          ]);
          expect(EffectArray.map(result.candidates, candidate => candidate.memoryId)).toEqual([neighborMemoryId]);
          expect(result.connections).toHaveLength(2);
          expect(result.connections).toEqual(
            expect.arrayContaining([
              expect.objectContaining({direction: 'incoming', neighborMemoryId}),
              expect.objectContaining({direction: 'outgoing', neighborMemoryId}),
            ]),
          );
        }

        const deduplicated = yield* retrieveRecallMemoryConnections(config, {
          allowedUriScopes: [memoryRoot(config.user)],
          memoryRefs: [alias, currentUri, formerUri],
          readRecords: uris => readMemoryRecordsByUri(config, uris),
        });
        expect(deduplicated.premises).toEqual([
          expect.objectContaining({memoryId, requestedOrdinal: 0, requestedRef: alias, state: 'current'}),
        ]);

        const superseding = Effect2.pipe(
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              memoryId,
              project: 'threadnote',
              relations: [
                {type: 'related_to', uri: memoryIdentityAlias(neighborMemoryId)},
                {type: 'supersedes', uri: memoryIdentityAlias(neighborMemoryId)},
              ],
              schemaVersion: MEMORY_SCHEMA_VERSION,
              sourceAgentClient: 'codex',
              status: 'active',
              timestamp: '2026-08-31T00:00:00.000Z',
              topic: 'relocated-connection-seed',
              visibility: 'shared',
            },
            'Relocated connection seed.',
          ),
          EffectString.replace(`memory_id: ${memoryId}\n`, ''),
        );
        yield* store.write(location, currentUri, superseding, {mode: 'upsert'});
        yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: true});
        for (const memoryRef of [alias, currentUri, formerUri]) {
          const historical = yield* retrieveRecallMemoryConnections(config, {
            allowedUriScopes: [memoryRoot(config.user)],
            includeHistorical: true,
            memoryRefs: [memoryRef],
            readRecords: uris => readMemoryRecordsByUri(config, uris),
            relationTypes: ['related_to'],
          });
          expect(EffectArray.map(historical.candidates, candidate => candidate.memoryId)).toEqual([neighborMemoryId]);
          expect(historical.connections).not.toHaveLength(0);
          expect(historical.connections).toEqual(
            EffectArray.map(historical.connections, () =>
              expect.objectContaining({currentness: 'historical', relationType: 'related_to'}),
            ),
          );

          const omitted = yield* retrieveRecallMemoryConnections(config, {
            allowedUriScopes: [memoryRoot(config.user)],
            memoryRefs: [memoryRef],
            readRecords: uris => readMemoryRecordsByUri(config, uris),
            relationTypes: ['related_to'],
          });
          expect(omitted.candidates).toEqual([]);
          expect(omitted.connections).toEqual([]);
        }

        const conflicting = Effect2.pipe(
          content,
          EffectString.replace(`memory_id: ${memoryId}\n`, 'memory_id: tn_other_live_identity\n'),
        );
        yield* store.write(location, currentUri, conflicting, {mode: 'upsert'});
        yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: true});
        const rejected = yield* retrieveRecallMemoryConnections(config, {
          allowedUriScopes: [memoryRoot(config.user)],
          memoryRefs: [alias],
          readRecords: uris => readMemoryRecordsByUri(config, uris),
        });
        expect(rejected.premises).toEqual([expect.objectContaining({memoryId, state: 'unresolved'})]);
        expect(rejected.connections).toEqual([]);
        expect(rejected.candidates).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('counts every bounded selector reread across the repair pass', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connection-diagnostics-'});
      const config = runtimeConfig(home, 'diagnostic-user');
      yield* writeMemory(fs, path, config, 'target-a', 'tn_diagnostic_target_a');
      yield* writeMemory(fs, path, config, 'target-b', 'tn_diagnostic_target_b');
      yield* writeMemory(fs, path, config, 'seed', 'tn_diagnostic_seed', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_diagnostic_target_a'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_diagnostic_target_b'},
      ]);
      yield* loadRecallMemoryLinks(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        forceRefresh: true,
        includeInactive: true,
        memorySeeds: [{memoryId: 'tn_diagnostic_seed', requestedOrdinal: 0}],
      });
      yield* writeMemory(fs, path, config, 'seed', 'tn_diagnostic_seed', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_diagnostic_target_b'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_diagnostic_target_a'},
      ]);

      let canonicalMismatches = 0;
      let canonicalRereads = 0;
      let rawLinkRows = 0;
      let refreshRepairs = 0;
      let truncatedSeedOrdinals: readonly number[] = [];
      const selected = yield* loadRecallMemoryLinks(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        includeInactive: true,
        limit: 1,
        memorySeeds: [{memoryId: 'tn_diagnostic_seed', requestedOrdinal: 0}],
        onCanonicalMismatch: count => {
          canonicalMismatches += count;
        },
        onCanonicalReread: count => {
          canonicalRereads += count;
        },
        onRawRows: count => {
          rawLinkRows += count;
        },
        onRefreshRepair: () => {
          refreshRepairs += 1;
        },
        onSearchTruncated: ordinals => {
          truncatedSeedOrdinals = ordinals;
        },
      });

      expect(selected).toHaveLength(1);
      expect(canonicalMismatches).toBe(2);
      expect(canonicalRereads).toBe(2);
      expect(rawLinkRows).toBe(4);
      expect(refreshRepairs).toBe(1);
      expect(truncatedSeedOrdinals).toEqual([0]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('labels explicit supersession before freshness and hides unauthorized targets', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-currentness-'});
      const config = runtimeConfig(home, 'scope-user');
      const seed = yield* writeMemory(fs, path, config, 'seed', 'tn_old', [
        {type: 'references', uri: 'threadnote://memory/tn_foreign'},
      ]);
      yield* writeMemory(fs, path, config, 'new', 'tn_new', [], {supersedes: 'threadnote://memory/tn_old'});
      yield* writeMemory(fs, path, runtimeConfig(home, 'foreign-user'), 'foreign', 'tn_foreign');

      const result = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
      });
      expect(result.premises[0]?.state).toBe('historical');
      expect(EffectArray.map(result.candidates, candidate => candidate.memoryId)).toEqual(['tn_new']);
      expect(JSON.stringify(result)).not.toContain('tn_foreign');
      expect(result.connections).toEqual([
        expect.objectContaining({
          currentness: 'current',
          direction: 'incoming',
          relationType: 'supersedes',
          resolution: 'resolved',
        }),
      ]);
      const filtered = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        relationTypes: ['references'],
      });
      expect(filtered.premises[0]?.state).toBe('historical');
      expect(filtered.candidates).toEqual([]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps premise currentness invariant when navigation relation filters change', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-currentness-abstention-'});
      const config = runtimeConfig(home, 'currentness-abstention-user');
      const seed = yield* writeMemory(fs, path, config, 'seed', 'tn_currentness_abstention_seed');
      yield* writeMemory(fs, path, config, 'superseder-0', 'tn_currentness_abstention_0', [], {
        status: 'archived',
        supersedes: 'threadnote://memory/tn_currentness_abstention_seed',
      });
      yield* writeMemory(fs, path, config, 'superseder-1', 'tn_currentness_abstention_1', [], {
        supersedes: 'threadnote://memory/tn_currentness_abstention_seed',
      });
      yield* writeMemory(fs, path, config, 'superseder-2', 'tn_currentness_abstention_2', [], {
        supersedes: 'threadnote://memory/tn_currentness_abstention_seed',
      });

      const result = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
      });

      expect(result.premises[0]?.state).toBe('conflicted');
      expect(result.coverage.truncated).toBe(true);
      expect(result.diagnostics.currentnessTruncatedMemoryIds).toBeUndefined();

      const filtered = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        relationTypes: ['related_to'],
      });
      expect(filtered.premises[0]?.state).toBe('conflicted');
      expect(filtered.diagnostics.currentnessTruncatedMemoryIds).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('canonical-validates stable inactive and sub-second superseder windows without repair', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-currentness-milliseconds-'});
      const config = runtimeConfig(home, 'currentness-milliseconds-user');
      const seed = yield* writeMemory(fs, path, config, 'seed', 'tn_currentness_milliseconds_seed');
      yield* writeMemory(fs, path, config, 'superseder-0', 'tn_currentness_future', [], {
        supersedes: 'threadnote://memory/tn_currentness_milliseconds_seed',
        validFrom: '2026-08-31T12:00:00.500Z',
      });
      yield* writeMemory(fs, path, config, 'superseder-1', 'tn_currentness_expired', [], {
        supersedes: 'threadnote://memory/tn_currentness_milliseconds_seed',
        validTo: '2026-08-31T11:59:59.500Z',
      });
      yield* writeMemory(fs, path, config, 'superseder-2', 'tn_currentness_current', [], {
        supersedes: 'threadnote://memory/tn_currentness_milliseconds_seed',
      });
      yield* writeMemory(fs, path, config, 'superseder-3', 'tn_currentness_archived', [], {
        status: 'archived',
        supersedes: 'threadnote://memory/tn_currentness_milliseconds_seed',
      });

      const result = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        now: CURRENT,
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        relationTypes: ['related_to'],
      });

      expect(result.premises[0]?.state).toBe('historical');
      expect(result.diagnostics).toMatchObject({canonicalMismatches: 0, refreshRepairs: 0});
      expect(result.diagnostics.currentnessTruncatedMemoryIds).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs stale indexed lifecycle before deciding a premise is current', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-currentness-stale-lifecycle-'});
      const config = runtimeConfig(home, 'currentness-stale-lifecycle-user');
      const seed = yield* writeMemory(fs, path, config, 'seed', 'tn_currentness_stale_seed');
      yield* writeMemory(fs, path, config, 'superseder', 'tn_currentness_stale_superseder', [], {
        supersedes: 'threadnote://memory/tn_currentness_stale_seed',
        validFrom: '2027-08-31T12:00:00.000Z',
      });

      const beforeMutation = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        now: CURRENT,
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        relationTypes: ['related_to'],
      });
      expect(beforeMutation.premises[0]?.state).toBe('current');
      expect(beforeMutation.diagnostics).toMatchObject({canonicalMismatches: 0, refreshRepairs: 0});

      const supersederPath = path.join(
        config.agentContextHome,
        'data',
        config.account,
        'user',
        config.user,
        'memories',
        'durable',
        'projects',
        'threadnote',
        'superseder.md',
      );
      const indexedInfo = yield* fs.stat(supersederPath);
      const indexedMtime = Option.getOrUndefined(indexedInfo.mtime);
      if (indexedMtime === undefined) throw new Error('Expected the indexed superseder to have an mtime.');
      yield* writeMemory(fs, path, config, 'superseder', 'tn_currentness_stale_superseder', [], {
        supersedes: 'threadnote://memory/tn_currentness_stale_seed',
        validFrom: '2025-08-31T12:00:00.000Z',
      });
      const rewrittenInfo = yield* fs.stat(supersederPath);
      expect(rewrittenInfo.size).toBe(indexedInfo.size);
      yield* fs.utimes(supersederPath, indexedMtime, indexedMtime);

      const afterMutation = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        now: CURRENT,
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        relationTypes: ['related_to'],
      });

      expect(afterMutation.premises[0]?.state).toBe('historical');
      expect(afterMutation.diagnostics).toMatchObject({canonicalMismatches: 1, refreshRepairs: 1});
      expect(afterMutation.diagnostics.currentnessTruncatedMemoryIds).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not let a historical prefix starve current neighbors from bounded backfill', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-current-backfill-'});
      const config = runtimeConfig(home, 'backfill-user');
      const seed = yield* writeMemory(fs, path, config, 'seed', 'tn_backfill_seed');
      yield* Effect.forEach(
        Array.from({length: 40}, (_, index) => index),
        index =>
          writeMemory(
            fs,
            path,
            config,
            `incoming-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
            `tn_backfill_${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
            [{type: 'related_to', uri: 'threadnote://memory/tn_backfill_seed'}],
            index < 32 ? {status: 'archived'} : {},
          ),
        {concurrency: 8},
      );

      const result = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        limit: 8,
        memoryRefs: [seed],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
      });

      expect(EffectArray.map(result.candidates, candidate => candidate.memoryId)).toEqual(
        Array.from({length: 8}, (_, index) => `tn_backfill_${index + 32}`),
      );
      expect(result.coverage.truncated).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('marks every multi-premise lane truncated when the global bound hides later current neighbors', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-multi-lane-backfill-'});
      const config = runtimeConfig(home, 'multi-lane-user');
      const seeds = yield* Effect.forEach(
        Array.from({length: 8}, (_, index) => index),
        index => writeMemory(fs, path, config, `seed-${index}`, `tn_multi_seed_${index}`),
        {concurrency: 8},
      );
      yield* Effect.forEach(
        Array.from({length: 72}, (_, index) => index),
        index => {
          const seedIndex = Math.floor(index / 9);
          const laneIndex = index % 9;
          return writeMemory(
            fs,
            path,
            config,
            `incoming-${seedIndex}-${Effect2.pipe(String(laneIndex), EffectString.padStart(2, '0'))}`,
            `tn_multi_incoming_${seedIndex}_${laneIndex}`,
            [{type: 'related_to', uri: `threadnote://memory/tn_multi_seed_${seedIndex}`}],
            laneIndex < 8 ? {status: 'archived'} : {},
          );
        },
        {concurrency: 8},
      );

      const result = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        limit: 8,
        memoryRefs: seeds,
        readRecords: uris => readMemoryRecordsByUri(config, uris),
      });

      expect(result.candidates).toEqual([]);
      expect(result.coverage).toMatchObject({
        truncated: true,
        truncatedSeedOrdinals: Array.from({length: 8}, (_, index) => index),
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('proves incoming superseders beyond the old global currentness slice', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-currentness-bound-'});
      const config = runtimeConfig(home, 'currentness-bound-user');
      const targetIds = Array.from({length: 64}, (_, index) => `tn_currentness_target_${index}`);
      const seed = yield* writeMemory(
        fs,
        path,
        config,
        'seed',
        'tn_currentness_seed',
        EffectArray.map(targetIds, memoryId => ({type: 'related_to' as const, uri: `threadnote://memory/${memoryId}`})),
      );
      yield* Effect.forEach(
        targetIds,
        (memoryId, index) => writeMemory(fs, path, config, `target-${index}`, memoryId),
        {concurrency: 8},
      );
      const supersededIds = ['tn_currentness_seed', ...targetIds];
      yield* Effect.forEach(
        supersededIds,
        (memoryId, index) =>
          writeMemory(fs, path, config, `superseder-${index}`, `tn_currentness_superseder_${index}`, [], {
            supersedes: `threadnote://memory/${memoryId}`,
          }),
        {concurrency: 8},
      );

      const result = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        limit: 8,
        memoryRefs: [seed],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        relationTypes: ['related_to'],
      });

      expect(result.premises[0]?.state).toBe('historical');
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics.currentnessTruncatedMemoryIds).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not traverse random or out-of-scope identity aliases', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-unresolved-premise-'});
      const config = runtimeConfig(home, 'premise-user');
      yield* writeMemory(fs, path, config, 'random-incoming', 'tn_random_incoming', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_missing_premise'},
      ]);
      yield* writeMemory(fs, path, config, 'foreign-incoming', 'tn_foreign_incoming', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_foreign_premise'},
      ]);
      yield* writeMemory(fs, path, runtimeConfig(home, 'foreign-user'), 'foreign-premise', 'tn_foreign_premise');

      for (const memoryRef of ['threadnote://memory/tn_missing_premise', 'threadnote://memory/tn_foreign_premise']) {
        const result = yield* retrieveRecallMemoryConnections(config, {
          allowedUriScopes: [memoryRoot(config.user)],
          memoryRefs: [memoryRef],
          readRecords: uris => readMemoryRecordsByUri(config, uris),
        });
        expect(result.premises).toEqual([expect.objectContaining({requestedRef: memoryRef, state: 'unresolved'})]);
        expect(result.connections).toEqual([]);
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics.rawLinkRows).toBe(0);
        expect(result.diagnostics.canonicalRereads).toBe(0);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps preferred scopes soft for explicit cross-project premises', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-preferred-scope-'});
      const config = runtimeConfig(home, 'preferred-scope-user');
      const target = yield* writeMemory(fs, path, config, 'target', 'tn_cross_project_target', [], {
        project: 'project-b',
      });
      const seed = yield* writeMemory(
        fs,
        path,
        config,
        'seed',
        'tn_cross_project_seed',
        [{type: 'depends_on', uri: 'threadnote://memory/tn_cross_project_target'}],
        {project: 'project-b'},
      );

      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: false,
        exactMatches: [],
        feedbackQuery: 'explicit cross project premise',
        includeInactive: false,
        limit: 5,
        memoryRefs: [seed],
        passes: [],
        preferredUriScopes: [`${memoryRoot(config.user)}/durable/projects/project-a`],
        query: 'explicit cross project premise',
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        semanticResult: Option.none(),
      });

      expect(prepared.memoryConnections?.premises).toEqual([
        expect.objectContaining({memoryId: 'tn_cross_project_seed', state: 'current'}),
      ]);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(prepared.memoryConnections?.candidates), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, candidate => candidate.uri),
          ),
        ),
      ).toEqual([target]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function candidate(uri: string, text: string, overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    fields: {project: 'threadnote', topic: Effect2.pipe(uri, EffectString.split('/')).at(-1)},
    kind: 'durable',
    status: 'active',
    text,
    timestamp: '2026-08-31T00:00:00.000Z',
    trust: 'approved',
    uri,
    ...overrides,
  };
}

function runtimeConfig(home: string, user: string) {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'codex',
    manifestPath: `${home}/manifest.json`,
    user,
  } as const;
}

function memoryRoot(user: string): string {
  return `threadnote://user/${user}/memories`;
}

function writeMemory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: ReturnType<typeof runtimeConfig>,
  topic: string,
  memoryId: string,
  relations: readonly MemoryRelation[] = [],
  overrides: Partial<MemoryMetadata> = {},
) {
  return Effect.gen(function* () {
    const project = overrides.project ?? 'threadnote';
    const filePath = path.join(
      config.agentContextHome,
      'data',
      config.account,
      'user',
      config.user,
      'memories',
      'durable',
      'projects',
      project,
      `${topic}.md`,
    );
    const uri = `${memoryRoot(config.user)}/durable/projects/${project}/${topic}.md`;
    yield* fs.makeDirectory(path.dirname(filePath), {recursive: true});
    yield* fs.writeFileString(
      filePath,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          memoryId,
          project,
          relations,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-31T00:00:00.000Z',
          topic,
          ...overrides,
        },
        `Body for ${topic}.`,
      ),
    );
    return uri;
  });
}
