import {automaticReviewPacket} from '../../src/memory/context/maintenance_draft.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {canonicalResourceUri} from '@threadnote/store/resource-id';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {
  captureConsolidationSource,
  reviewConsolidation,
  buildConsolidationProvenanceV2,
} from '@threadnote/memory/consolidation';
import {buildTopicMaintenanceManifest} from '@threadnote/memory/topic-maintenance';
import {createMemoryCodeCitation, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {automaticMaintenanceEvidenceId} from '@threadnote/memory/automatic-maintenance';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {resolveMemoryIdentityAliases, verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';
import {memoryMaintenanceFragmentSource} from '@threadnote/context/memory_maintenance';
import {createReviewedSupportSnapshot} from '@threadnote/memory/reviewed-support';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import type {ContextHealthCitationSourceExcerptV1} from '@threadnote/context/citation_validation';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  prepareContextMaintenanceInventory,
  readContextMaintenanceCanonicalRecord,
} from '@threadnote/threadnote/memory/context/maintenance_inventory';
import {
  advanceAutomaticPreparation,
  prepareAutomaticMemory,
  readAutomaticCodeEvidence,
  readLiveAutomaticPreparation,
  automaticMemorySourceUriScopes,
} from '@threadnote/threadnote/memory/context/maintenance_preparation';
import {
  readPreparedMemory,
  writePreparedMemory,
  selectAutomaticPreparationUris,
} from '@threadnote/threadnote/memory/context/maintenance_preparation_state';
import {writeDurableMemory} from '@threadnote/threadnote/mcp/server/memory';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {runCommandEffect} from '@threadnote/platform/command';
import {runContextMaintenance} from '@threadnote/threadnote/memory/context/maintenance';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'preparation-test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: e => ({...e}), sanitizeExternal: e => ({...e})}),
    ),
  ),
);
const dependencies = Layer.mergeAll(
  BunServices.layer,
  system,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const layer = Layer.merge(dependencies, ResourceStore.layer.pipe(Layer.provide(dependencies)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const ROOT = 'threadnote://user/tester/memories/';
const NOW = '2026-10-21T12:00:00.000Z';
const scopeRevision = sha256HexSync('configured-scope');
function record(name: string, body = 'Exact current statement.', metadata: Partial<MemoryMetadata> = {}): MemoryRecord {
  const uri = `${ROOT}durable/projects/selected/${name}.md`;
  const content = formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      schemaVersion: 10,
      memoryId: `tn_${name.toLowerCase()}`,
      project: 'selected',
      status: 'active',
      timestamp: NOW,
      sourceAgentClient: 'test',
      topic: name,
      ...metadata,
    },
    body,
  );
  return parseMemoryDocument(uri, content)!;
}
const fixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* ResourceStore;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'automatic-preparation-'});
    const config = {
      account: 'local',
      user: 'tester',
      agentId: 'test',
      agentContextHome: home,
      manifestPath: path.join(home, 'manifest.yaml'),
    };
    yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
    const location = {account: 'local', user: 'tester', home};
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    const write = (r: MemoryRecord) => store.write(location, r.uri, r.content, {mode: 'upsert'});
    return {fs, path, store, home, config, location, root, write};
  });
const settle = (f: Effect.Success<ReturnType<typeof fixture>>, ticks = 25, budget = 4) =>
  Effect.gen(function* () {
    for (let i = 0; i < ticks; i++) {
      const snapshot = yield* prepareContextMaintenanceInventory(f.config, undefined, budget);
      yield* advanceAutomaticPreparation(
        f.config,
        snapshot,
        new Map(),
        () =>
          Effect.succeed({
            evidence: [],
            candidates: [],
            reads: [],
            omissions: ['code-project-unbound'],
            searchedScopes: [],
          }),
        {maxRecords: 4},
      );
    }
  });

function codeCitation(kind: 'file' | 'symbol' = 'file', path = 'src/current.ts') {
  return createMemoryCodeCitation({
    version: 1,
    repositoryId: '1'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: '2'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'3'.repeat(40)}`,
    extractorSet: 'native-code-graph-13',
    path,
    fileContentHash: {algorithm: 'sha256', value: '4'.repeat(64)},
    target:
      kind === 'file'
        ? {kind}
        : {
            kind,
            fragmentCanonicalization: 'utf8-source-span-v1',
            fragmentHash: {algorithm: 'sha256', value: '7'.repeat(64)},
            language: 'typescript',
            name: 'automaticBoundary',
            qualifiedName: 'automaticBoundary',
            nodeId: `cgs_${'8'.repeat(32)}`,
            span: {line: 1, column: 1, endLine: 2, endColumn: 2},
            symbolKind: 'function',
          },
  });
}

function codeExcerpt(
  citation: MemoryCodeCitationV1,
  content: string,
  file: string,
  overrides: Partial<ContextHealthCitationSourceExcerptV1> = {},
): ContextHealthCitationSourceExcerptV1 {
  return {
    content,
    startLine: 1,
    endLine: content.split('\n').length,
    excerptHash: sha256HexSync(content),
    fileBytesHash: sha256HexSync(file),
    provenance: 'current-verified',
    source: {
      extractorSet: citation.extractorSet,
      fileContentHash: sha256HexSync(file),
      path: citation.path,
      repositoryId: citation.repositoryId,
      sourceCommit: citation.sourceCommit,
      sourceDirty: false,
      sourceSnapshotId: citation.sourceSnapshotId,
    },
    supportsCitation: true,
    truncated: content !== file,
    ...overrides,
  };
}

function prepareCode(citation: MemoryCodeCitationV1, excerpts: readonly ContextHealthCitationSourceExcerptV1[]) {
  const evidenceId = automaticMaintenanceEvidenceId({kind: 'code', citation});
  return prepareAutomaticMemory(record('code', undefined, {codeCitations: [citation]}), {
    scopeRevision,
    evidence: [
      {
        id: evidenceId,
        source: {kind: 'code', citation},
        scope: 'repository',
        authority: 'recorded',
        availability: 'available',
      },
    ],
    candidates: excerpts.map(excerpt => ({evidenceId, text: excerpt.content, excerpt})),
    reads: [{uri: `code:${citation.id}`, hash: sha256HexSync(JSON.stringify(excerpts))}],
  });
}

function reviewedCodeRecord(roots: readonly MemoryCodeCitationV1[], active: readonly MemoryCodeCitationV1[]) {
  const body = 'Current approved code behavior.';
  const sources = active.map(citation => {
    const source = {kind: 'code' as const, citation};
    return {id: automaticMaintenanceEvidenceId(source), source, scope: 'repository' as const};
  });
  const reviewedSupport = {
    type: 'reviewed-memory-support' as const,
    version: 1 as const,
    active: createReviewedSupportSnapshot({
      bodyHash: sha256HexSync(body),
      paragraphs: [
        {
          ordinal: 0,
          hash: sha256HexSync(body),
          role: 'descriptive',
          support: 'direct',
          evidenceIds: sources.map(source => source.id),
        },
      ],
      sources,
      acceptance: {
        reviewId: 'review-preparation-boundary',
        approvedAt: NOW,
        targetBeforeHash: '1'.repeat(64),
        preparationDigest: '2'.repeat(64),
        sourceVectorDigest: '3'.repeat(64),
      },
    }),
  };
  return record('reviewed_code', body, {schemaVersion: 11, codeCitations: roots, reviewedSupport});
}

const checkRelatedSourceBudget = Effect.fn('test.relatedSourceBudget')(function* (
  aliases: readonly number[],
  overflow: boolean,
  batch = false,
) {
  const f = yield* fixture();
  const body = 'This exact current statement has eight approved sources.';
  const sources = Array.from({length: 9}, (_, index) => record(`budget_source_${index}`, body));
  for (const source of sources) yield* f.write(source);
  const descriptors = sources.slice(0, 8).map(source => {
    const fragment = memoryMaintenanceFragmentSource(source, 0);
    return {id: automaticMaintenanceEvidenceId(fragment), source: fragment, scope: 'personal' as const};
  });
  const active = createReviewedSupportSnapshot({
    bodyHash: sha256HexSync(body),
    paragraphs: [
      {
        ordinal: 0,
        hash: sha256HexSync(body),
        role: 'descriptive',
        support: 'direct',
        evidenceIds: descriptors.map(descriptor => descriptor.id),
      },
    ],
    sources: descriptors,
    acceptance: {
      reviewId: 'review-related-budget',
      approvedAt: NOW,
      targetBeforeHash: '1'.repeat(64),
      preparationDigest: '2'.repeat(64),
      sourceVectorDigest: '3'.repeat(64),
    },
  });
  const target = record('budget_target', body, {
    schemaVersion: 11,
    reviewedSupport: {type: 'reviewed-memory-support', version: 1, active},
    relations: [...aliases, ...(overflow ? [8] : [])].map(index => ({
      type: 'references',
      uri: memoryIdentityAlias(sources[index].metadata.memoryId!),
    })),
  });
  yield* f.write(target);
  const live = yield* readLiveAutomaticPreparation(f.config, target.uri);
  expect(live.prepared.reads).toHaveLength(9);
  expect(new Set(live.prepared.reads.map(read => read.uri)).size).toBe(9);
  expect(live.prepared.assessment.evidence).toHaveLength(8);
  expect(live.prepared.assessment.coverage.omittedSources).toBe(Number(overflow));
  expect(live.prepared.omissions.includes('related-source-budget')).toBe(overflow);
  expect(live.prepared.reads.some(read => read.uri === sources[8].uri)).toBe(false);
  if (batch) {
    yield* settle(f, 6, 100);
    const cached = (yield* readPreparedMemory(f.config, target.uri))!;
    expect(cached.reads).toHaveLength(9);
    expect(new Set(cached.reads.map(read => read.uri)).size).toBe(9);
    expect(cached.assessment.coverage.omittedSources).toBe(Number(overflow));
    expect(cached.omissions.includes('related-source-budget')).toBe(overflow);
    expect(cached.relevantRevision).toBe(live.prepared.relevantRevision);
  }
  expect(yield* f.store.read(f.location, target.uri)).toBe(target.content);
});

describe('automatic private preparation', () => {
  effectIt.effect('retains legacy-origin ambiguity, partial inventory, successor and access fences after dedupe', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const body = 'Exact legacy-origin claim.';
      const origin = record('origin_control', body);
      const ambiguous = [
        record('ambiguous_one', body, {memoryId: 'tn_ambiguous_control'}),
        record('ambiguous_two', body, {memoryId: 'tn_ambiguous_control'}),
      ];
      const archived = record('old_control', body, {status: 'archived'});
      const successor = record('successor_control', body, {relations: [{type: 'supersedes', uri: archived.uri}]});
      const blocked = record('blocked_control', body, {trust: 'untrusted'});
      const carrier = record('carrier_control', body, {
        relations: [
          {type: 'references', uri: memoryIdentityAlias(origin.metadata.memoryId!)},
          {type: 'references', uri: memoryIdentityAlias('tn_missing_control')},
          {type: 'references', uri: memoryIdentityAlias('tn_ambiguous_control')},
          {type: 'depends_on', uri: archived.uri},
          {type: 'references', uri: blocked.uri},
        ],
      });
      const reviewed = reviewConsolidation(
        body,
        [origin, carrier].map(captureConsolidationSource),
        [
          {
            section: body,
            disposition: 'direct',
            supports: [
              {sourceUri: origin.uri, fragment: 0, citationIds: [], relationIndexes: []},
              {sourceUri: carrier.uri, fragment: 0, citationIds: [], relationIndexes: [0, 1, 2, 3, 4]},
            ],
          },
        ],
        {
          operationId: 'legacy-dedupe-control',
          cleanup: 'keep',
          cleanupShared: false,
          target: {
            kind: 'durable',
            status: 'active',
            project: 'selected',
            topic: 'legacy_control',
            sourceAgentClient: 'test',
          },
        },
      );
      const target = record('legacy_control', body, {
        consolidation: reviewed.provenance,
        relations: reviewed.relations,
      });
      for (const source of [origin, carrier, ...ambiguous, archived, successor, blocked, target])
        yield* f.write(source);
      const snapshot = yield* prepareContextMaintenanceInventory(f.config, undefined, 100);
      const advance = (complete: boolean, records = snapshot.records) =>
        Effect.gen(function* () {
          for (let tick = 0; tick < 3; tick++)
            yield* advanceAutomaticPreparation(
              f.config,
              {...snapshot, records, complete},
              new Map(),
              () => Effect.succeed({evidence: [], candidates: [], reads: [], omissions: [], searchedScopes: []}),
              {maxRecords: 4},
            );
        });
      yield* advance(false);
      const partial = (yield* readPreparedMemory(f.config, target.uri))!;
      expect(partial.omissions).toContain('related-source-unknown');
      expect(partial.omissions).toContain('related-source-ambiguous');
      expect(partial.omissions).toContain('related-source-inactive');
      expect(partial.omissions).toContain('related-source-policy');
      expect(partial.reads).toHaveLength(3);
      expect(new Set(partial.reads.map(read => read.uri))).toEqual(new Set([target.uri, carrier.uri, origin.uri]));
      yield* advance(true);
      const complete = (yield* readPreparedMemory(f.config, target.uri))!;
      expect(complete.omissions).toContain('related-source-unavailable');
      expect(complete.omissions).toContain('related-source-ambiguous');
      expect(complete.omissions).toContain('related-successor-candidate');
      expect(complete.omissions).toContain('related-source-policy');
      expect(new Set(complete.reads.map(read => read.uri))).toEqual(
        new Set([target.uri, carrier.uri, origin.uri, successor.uri]),
      );
      expect(complete.origin?.receipt).toEqual(reviewed.provenance);
      const timestampOnly = record('origin_control', body, {...origin.metadata, timestamp: '2026-10-22T00:00:00.000Z'});
      yield* f.write(timestampOnly);
      yield* advance(
        true,
        snapshot.records.map(record => (record.uri === origin.uri ? timestampOnly : record)),
      );
      const refreshed = (yield* readPreparedMemory(f.config, target.uri))!;
      expect(refreshed.reads).not.toEqual(complete.reads);
      expect(refreshed.relevantRevision).toBe(complete.relevantRevision);
      expect(refreshed.origin?.receipt).toEqual(reviewed.provenance);
      expect(yield* f.store.read(f.location, target.uri)).toBe(target.content);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('deduplicates all eight active paths and authored aliases before source budgeting', () =>
    Effect.gen(function* () {
      yield* checkRelatedSourceBudget(
        Array.from({length: 8}, (_, index) => index),
        false,
        true,
      );
      yield* checkRelatedSourceBudget(
        Array.from({length: 8}, (_, index) => index),
        true,
        true,
      );
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'canonical read budgets ignore redundant alias subsets and ordering',
    {
      aliases: fc.shuffledSubarray(Array.from({length: 8}, (_, index) => index)),
      overflow: fc.boolean(),
    },
    ({aliases, overflow}) =>
      checkRelatedSourceBudget(aliases, overflow).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 4, seed: 756301}, timeout: 30000},
  );

  effectIt.effect(
    'resolves shared identities within the eligible team despite retained private and other-team copies',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const personal = record('scope');
        const shared = record('scope', personal.body, {
          visibility: 'shared',
          authority: 'reviewed_shared',
          trust: 'approved',
        });
        const teamA = {...shared, uri: shared.uri.replace('/memories/', '/memories/shared/team-a/')};
        const teamB = {...shared, uri: shared.uri.replace('/memories/', '/memories/shared/team-b/')};
        const privateOnly = record('private_only');
        for (const source of [personal, teamA, teamB, privateOnly]) yield* f.write(source);
        const scopes = automaticMemorySourceUriScopes(f.config, teamA);
        const [resolved] = yield* resolveMemoryIdentityAliases(
          f.config,
          [memoryIdentityAlias(personal.metadata.memoryId!)],
          scopes,
          {validateNow: true},
        );
        expect(resolved.canonicalUri).toBe(teamA.uri);
        const live = yield* readContextMaintenanceCanonicalRecord(f.config, resolved.canonicalUri);
        yield* verifyResolvedMemoryIdentity(resolved, live.record.uri, live.record.content);
        expect(
          yield* resolveMemoryIdentityAliases(f.config, [memoryIdentityAlias(privateOnly.metadata.memoryId!)], scopes, {
            validateNow: true,
          }).pipe(Effect.flip),
        ).toMatchObject({reason: 'not-found'});
        const conflict = {
          ...record('conflict', 'Conflicting shared projection.', teamA.metadata),
          uri: teamA.uri.replace('/scope.md', '/conflict.md'),
        };
        yield* f.write(conflict);
        expect(
          yield* resolveMemoryIdentityAliases(f.config, [memoryIdentityAlias(personal.metadata.memoryId!)], scopes, {
            validateNow: true,
          }).pipe(Effect.flip),
        ).toMatchObject({reason: 'ambiguous'});
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect(
    'roundtrips V2 preparation with sixteen roots/active descriptors and thirty-two exact candidates',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const roots = Array.from({length: 8}, (_, index) => codeCitation('file', `root-${index}.ts`));
        const active = Array.from({length: 8}, (_, index) => codeCitation('file', `active-${index}.ts`));
        const target = reviewedCodeRecord(roots, active);
        const evidence = [...roots, ...active].map(citation => ({
          id: automaticMaintenanceEvidenceId({kind: 'code', citation}),
          source: {kind: 'code' as const, citation},
          scope: 'repository' as const,
          authority: 'recorded' as const,
          availability: 'available' as const,
        }));
        const candidates = evidence.flatMap(entry =>
          ['current-verified', 'historical-verified'].map(provenance => {
            const text = 'x'.repeat(4096);
            return {
              evidenceId: entry.id,
              text,
              excerpt: codeExcerpt(entry.source.citation, text, text, {
                provenance: provenance as 'current-verified' | 'historical-verified',
              }),
            };
          }),
        );
        const reads = Array.from({length: 25}, (_, index) => ({
          uri: `code:read-${index}`,
          hash: sha256HexSync(String(index)),
        }));
        const prepared = prepareAutomaticMemory(target, {scopeRevision, evidence, candidates, reads});
        expect(prepared.assessment.version).toBe(2);
        expect(prepared.candidates).toHaveLength(32);
        yield* writePreparedMemory(f.config, prepared);
        expect(yield* readPreparedMemory(f.config, target.uri)).toEqual(prepared);
        expect(target.metadata.codeCitations).toEqual(roots);
        expect(target.metadata.reviewedSupport!.active.sources).toHaveLength(8);
      }).pipe(provide),
  );

  effectIt.effect(
    'reads all eight historical roots and eight active current code pins through the actual producer',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const repository = f.path.join(f.home, 'repository');
        yield* f.fs.makeDirectory(repository);
        const refs = Array.from({length: 8}, (_, index) => `source-${index}.ts`);
        const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
        const commit = (message: string) =>
          Effect.gen(function* () {
            yield* git(['add', '.']);
            yield* git([
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@example.invalid',
              'commit',
              '--quiet',
              '-m',
              message,
            ]);
          });
        const index = () =>
          CodeGraphIndexer.pipe(
            Effect.flatMap(indexer => indexer.index({cwd: repository, threadnoteHome: f.home, ensureVectors: false})),
          );
        yield* git(['init', '--quiet']);
        for (const ref of refs) yield* f.fs.writeFileString(f.path.join(repository, ref), 'export const value = 30;\n');
        yield* commit('original');
        yield* index();
        const roots = yield* captureMemoryCodeCitations(f.config, {callerCwd: repository, refs});
        for (const ref of refs) yield* f.fs.writeFileString(f.path.join(repository, ref), 'export const value = 60;\n');
        yield* commit('current');
        yield* index();
        const active = yield* captureMemoryCodeCitations(f.config, {callerCwd: repository, refs});
        expect(roots).toHaveLength(8);
        expect(active).toHaveLength(8);
        const target = reviewedCodeRecord(roots, active);
        const code = yield* readAutomaticCodeEvidence(f.config, target, repository);
        expect(code.evidence).toHaveLength(16);
        expect(code.reads).toHaveLength(16);
        expect(code.candidates.filter(candidate => candidate.excerpt?.provenance === 'current-verified')).toHaveLength(
          16,
        );
        expect(code.omissions).not.toContain('code-source-budget');
        expect(code.omissions).not.toContain('code-evidence-budget');
        const prepared = prepareAutomaticMemory(target, {scopeRevision, ...code});
        expect(prepared.assessment.paragraphs[0].currentEvidenceIds).toEqual(
          target.metadata.reviewedSupport!.active.paragraphs[0].evidenceIds,
        );
        yield* writePreparedMemory(f.config, prepared);
        expect(yield* readPreparedMemory(f.config, target.uri)).toEqual(prepared);
        expect(target.metadata.codeCitations).toEqual(roots);

        const legacy = yield* readAutomaticCodeEvidence(
          f.config,
          record('legacy_budget', target.body, {codeCitations: roots}),
          repository,
        );
        expect(legacy.evidence).toHaveLength(4);
        expect(legacy.omissions).toContain('code-evidence-budget');
        // The producer also bounds raw inventory input before canonical admission.
        const {id: originalId, ...rootInput} = roots[0];
        const extra = createMemoryCodeCitation({...rootInput, sourceCommit: 'f'.repeat(40)});
        expect(extra.id).not.toBe(originalId);
        const overflow = yield* readAutomaticCodeEvidence(
          f.config,
          {...target, metadata: {...target.metadata, codeCitations: [...roots, extra]}},
          repository,
        );
        expect(overflow.evidence).toHaveLength(16);
        expect(overflow.omissions).toContain('code-source-budget');
        expect(overflow.omissions).toContain('code-evidence-budget');
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('backfills distinct encoded resource names through inventory and canonical cache lookup', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const originals = ['a b.md', 'a%20b.md', 'café.md', '100%.md'].map((name, index) => {
        const original = record(`encoded${index}`, `Distinct accepted content ${index}: ${name}`);
        return {
          ...original,
          uri: canonicalResourceUri('user', ['tester', 'memories', 'durable', 'projects', 'selected', name]),
        };
      });
      for (const original of originals) yield* f.write(original);
      yield* settle(f, 6, 100);
      for (const original of originals) {
        const prepared = yield* readPreparedMemory(f.config, original.uri);
        expect(prepared?.assessment.target.uri).toBe(original.uri);
        expect(prepared?.assessment.target.memoryId).toBe(original.metadata.memoryId);
        expect(prepared?.assessment.target.bodyHash).toBe(sha256HexSync(original.body));
        expect(prepared?.assessment.target.canonicalHash).toBe(sha256HexSync(original.content.trim()));
        expect(yield* f.store.read(f.location, original.uri)).toBe(original.content);
      }
    }).pipe(provide),
  );

  it('invalidates cited file tails beyond the bounded current excerpt without binding incidental snapshots', () => {
    const citation = codeCitation();
    const prefix = Array.from({length: 24}, (_, i) => `const prefix${i} = true;`).join('\n');
    const before = codeExcerpt(citation, prefix, `${prefix}\nconst relevantTail = true;`);
    const after = codeExcerpt(citation, prefix, `${prefix}\nconst relevantTail = false;`);
    const historical = codeExcerpt(citation, 'Historical statement.', 'Historical statement.', {
      provenance: 'historical-verified',
    });
    const first = prepareCode(citation, [historical, before]);
    const second = prepareCode(citation, [historical, after]);
    expect(after.excerptHash).toBe(before.excerptHash);
    expect(second.reads).not.toEqual(first.reads);
    expect(second.relevantRevision).not.toBe(first.relevantRevision);
    expect(first.omissions).toContain('current-code-excerpt-truncated');
    expect(first.assessment.coverage.outcome).toBe('partial');
    const unrelatedCommit = {
      ...after,
      source: {...after.source, sourceCommit: '5'.repeat(40), sourceSnapshotId: `cgsn_${'6'.repeat(40)}`},
    };
    const third = prepareCode(citation, [historical, unrelatedCommit]);
    expect(third.reads).not.toEqual(second.reads);
    expect(third.relevantRevision).toBe(second.relevantRevision);
    const dirty = {...unrelatedCommit, source: {...unrelatedCommit.source, sourceDirty: true}};
    expect(prepareCode(citation, [historical, dirty]).relevantRevision).not.toBe(third.relevantRevision);
  });

  it('uses complete supported symbol spans and includes manual truncation and citation support status', () => {
    const citation = codeCitation('symbol');
    const content = 'export function automaticBoundary() {\n  return true;\n}';
    const first = codeExcerpt(citation, content, `${content}\nconst unrelated = true;`, {truncated: false});
    const unrelated = codeExcerpt(citation, content, `${content}\nconst unrelated = false;`, {truncated: false});
    expect(prepareCode(citation, [unrelated]).relevantRevision).toBe(prepareCode(citation, [first]).relevantRevision);
    const changedContent = content.replace('true', 'false');
    const changed = codeExcerpt(citation, changedContent, `${changedContent}\nconst unrelated = false;`, {
      truncated: false,
    });
    expect(prepareCode(citation, [changed]).relevantRevision).not.toBe(prepareCode(citation, [first]).relevantRevision);
    const truncated = prepareCode(citation, [{...first, truncated: true}]);
    expect(truncated.relevantRevision).not.toBe(prepareCode(citation, [first]).relevantRevision);
    expect(truncated.omissions).toContain('current-code-excerpt-truncated');
    expect(truncated.assessment.coverage.outcome).toBe('partial');
    const unsupported = prepareCode(citation, [{...first, supportsCitation: false}]);
    expect(unsupported.relevantRevision).not.toBe(prepareCode(citation, [first]).relevantRevision);
    expect(unsupported.omissions).toContain('current-code-citation-unsupported');
    expect(unsupported.assessment.coverage.outcome).toBe('partial');
  });

  it('review current pins bind actual new bytes even when preparation reused the original private evidence ID', () => {
    const citation = codeCitation('symbol');
    const excerpt = codeExcerpt(citation, 'export const value = 60;', 'export const value = 60;');
    const id = automaticMaintenanceEvidenceId({kind: 'code', citation});
    const target = record('current_code', 'Old behavior.', {codeCitations: [citation]});
    const prepared = prepareAutomaticMemory(target, {
      scopeRevision,
      evidence: [
        {id, source: {kind: 'code', citation}, scope: 'repository', authority: 'recorded', availability: 'available'},
      ],
      candidates: [{evidenceId: id, text: excerpt.content, excerpt}],
    });
    const packet = automaticReviewPacket(target, prepared);
    const pin = packet.reviewEvidence[0].descriptor;
    if (pin.source.kind !== 'code') throw new Error('Expected code source.');
    expect(pin.source.citation.id).not.toBe(citation.id);
    expect(pin.id).not.toBe(id);
    expect(pin.source.citation.fileContentHash.value).toBe(sha256HexSync(excerpt.content));
    expect(pin.source.citation.fileContentHash.value).not.toBe(citation.fileContentHash.value);
    expect(packet.basis.assessment.evidence.find(item => item.id === id)!.source).toEqual({kind: 'code', citation});
    const local = automaticReviewPacket(target, prepared, undefined, {
      repositoryId: excerpt.source.repositoryId,
      kind: 'local',
    });
    expect(local.reviewEvidence[0].descriptor.source).toMatchObject({
      kind: 'code',
      citation: {repositoryIdentityKind: 'local'},
    });
  });

  it('binds every current-verified code candidate independently of historical candidates and ordering', () => {
    const citation = codeCitation();
    const historical = codeExcerpt(citation, 'Historical.', 'Historical.', {provenance: 'historical-verified'});
    const first = codeExcerpt(citation, 'Current prefix.', 'Current prefix.\nFirst current tail.');
    const second = codeExcerpt(citation, 'Other prefix.', 'Other prefix.\nOther current tail.');
    const before = prepareCode(citation, [historical, first, second]);
    expect(prepareCode(citation, [second, first, historical]).relevantRevision).toBe(before.relevantRevision);
    const changed = codeExcerpt(citation, second.content, `${second.content}\nChanged current tail.`);
    expect(prepareCode(citation, [historical, first, changed]).relevantRevision).not.toBe(before.relevantRevision);
    const oldChanged = {...historical, fileBytesHash: sha256HexSync('Changed historical cache.')};
    expect(prepareCode(citation, [oldChanged, first, second]).relevantRevision).toBe(before.relevantRevision);
  });

  it('invalidates bounded current code tails while ignoring incidental commit and snapshot identities', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('file' as const, 'symbol' as const),
        fc.uniqueArray(fc.string({maxLength: 40}), {minLength: 2, maxLength: 2}),
        (kind, [beforeTail, afterTail]) => {
          const citation = codeCitation(kind);
          const prefix = 'export const prefix = true;';
          const before = codeExcerpt(citation, prefix, `${prefix}\n${JSON.stringify(beforeTail)}`);
          const after = codeExcerpt(citation, prefix, `${prefix}\n${JSON.stringify(afterTail)}`);
          const unchanged = {
            ...after,
            source: {...after.source, sourceCommit: 'a'.repeat(40), sourceSnapshotId: `cgsn_${'b'.repeat(40)}`},
          };
          const inputs = JSON.stringify([citation, before, after, unchanged]);
          const original = prepareCode(citation, [before]);
          const changed = prepareCode(citation, [after]);
          expect(changed.relevantRevision).not.toBe(original.relevantRevision);
          expect(prepareCode(citation, [unchanged]).relevantRevision).toBe(changed.relevantRevision);
          const dirty = {...unchanged, source: {...unchanged.source, sourceDirty: true}};
          expect(prepareCode(citation, [dirty]).relevantRevision).not.toBe(changed.relevantRevision);
          expect(changed.assessment.coverage.outcome).toBe('partial');
          expect(JSON.stringify([citation, before, after, unchanged])).toBe(inputs);
        },
      ),
      {numRuns: 30, seed: 756001},
    );
  });

  effectIt.effect('bounds unavailable code preparation with a deterministic clock and records partial coverage', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const target = record('bounded');
      yield* f.write(target);
      const snapshot = yield* prepareContextMaintenanceInventory(f.config, undefined, 100);
      const started = yield* Deferred.make<void>();
      const pending = yield* advanceAutomaticPreparation(f.config, snapshot, new Map(), () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(2_000);
      expect((yield* Fiber.join(pending)).prepared).toBe(1);
      const prepared = yield* readPreparedMemory(f.config, target.uri);
      expect(prepared?.omissions).toContain('code-evidence-time-boundary');
      expect(prepared?.assessment.coverage.outcome).toBe('partial');
    }).pipe(provide),
  );
  effectIt.effect(
    'backfills all active kinds and shared/idless records without changing accepted bytes or mtimes',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const records = (['durable', 'handoff', 'incident', 'preference', 'smoke'] as const).map(kind =>
          record(kind, undefined, {kind}),
        );
        const idless = record('idless', undefined, {memoryId: undefined});
        const shared = {...record('shared'), uri: `${ROOT}shared/default/durable/projects/selected/shared.md`};
        const inactive = record('inactive', undefined, {status: 'archived'});
        for (const r of [...records, idless, shared, inactive]) yield* f.write(r);
        const observations = yield* Effect.forEach([...records, idless, shared], r =>
          Effect.gen(function* () {
            const file = f.path.join(f.root, r.uri.slice(ROOT.length));
            return {r, file, info: yield* f.fs.stat(file)};
          }),
        );
        yield* settle(f);
        for (const {r, file, info} of observations) {
          const prepared = yield* readPreparedMemory(f.config, r.uri);
          expect(prepared?.assessment.target.kind).toBe(r.metadata.kind);
          expect(prepared?.assessment.preparation.kind).toBe('derived');
          expect(prepared?.assessment.capabilities.apply).toBe(false);
          expect(prepared?.assessment.capabilities.publish).toBe(false);
          expect(yield* f.fs.readFileString(file)).toBe(r.content);
          expect((yield* f.fs.stat(file)).mtime).toEqual(info.mtime);
          expect(r.content).not.toContain('topic_maintenance:');
        }
        expect((yield* readPreparedMemory(f.config, idless.uri))?.assessment.capabilities.reasons).toContain(
          'missing-id',
        );
        expect((yield* readPreparedMemory(f.config, shared.uri))?.assessment.target.readOnly).toBe(true);
        expect(yield* readPreparedMemory(f.config, inactive.uri)).toBeUndefined();
        expect(yield* f.fs.exists(f.path.join(f.home, 'context-maintenance', 'drafts'))).toBe(false);
      }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect(
    'discovers public writes and replacements without enrollment; preparation preserves writer identity and provenance',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const original = record('public');
        for (const bodyText of ['Public ordinary memory.', 'Public replacement.']) {
          const result = yield* writeDurableMemory(f.config, {
            bodyText,
            metadata: original.metadata,
            ...(bodyText === 'Public replacement.' ? {replaceUri: original.uri} : {}),
            deferRecallIndexRefresh: true,
          });
          expect(result.isError).not.toBe(true);
          const accepted = yield* readContextMaintenanceCanonicalRecord(f.config, original.uri);
          const file = f.path.join(f.root, original.uri.slice(ROOT.length));
          const info = yield* f.fs.stat(file);
          yield* runContextMaintenance(f.config, {cwd: f.home, maxRecords: 1});
          const prepared = yield* readPreparedMemory(f.config, original.uri);
          expect(prepared?.assessment.target.bodyHash).toBe(sha256HexSync(accepted.record.body));
          expect(prepared?.assessment.target.memoryId).toBe('tn_public');
          expect(yield* f.fs.readFileString(file)).toBe(accepted.record.content);
          expect((yield* f.fs.stat(file)).mtime).toEqual(info.mtime);
          expect(accepted.record.content).not.toContain('topic_maintenance:');
        }
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'keeps one-hop cycles finite and excludes private shared support, cross-project and untrusted sources',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const a = record('a', undefined, {
          relations: [{type: 'references', uri: `${ROOT}durable/projects/selected/b.md`}],
        });
        const b = record('b', undefined, {relations: [{type: 'references', uri: a.uri}]});
        yield* f.write(a);
        yield* f.write(b);
        yield* settle(f, 8, 100);
        const first = (yield* readPreparedMemory(f.config, a.uri))!;
        expect(first.assessment.paragraphs[0].currentSupport).toBe('direct');
        expect(first.assessment.paragraphs[0].role).toBe('unknown');
        expect(first.assessment.evidence.filter(e => e.source.kind === 'memory')).toHaveLength(1);
        yield* f.write(record('b', undefined, {...b.metadata, timestamp: '2026-10-22T12:00:00.000Z'}));
        yield* settle(f, 4, 100);
        const second = (yield* readPreparedMemory(f.config, a.uri))!;
        expect(second.reads).not.toEqual(first.reads);
        expect(second.relevantRevision).toBe(first.relevantRevision);
        yield* f.write(record('b', undefined, {...b.metadata, trust: 'untrusted'}));
        yield* settle(f, 4, 100);
        expect((yield* readPreparedMemory(f.config, a.uri))?.omissions).toContain('related-source-policy');
        yield* f.write(record('b', undefined, {...b.metadata, project: 'other'}));
        yield* settle(f, 4, 100);
        expect((yield* readPreparedMemory(f.config, a.uri))?.assessment.evidence).toHaveLength(0);
        const shared = {...a, uri: a.uri.replace('/memories/', '/memories/shared/default/')};
        yield* f.write(shared);
        yield* settle(f, 4, 100);
        expect((yield* readPreparedMemory(f.config, shared.uri))?.omissions).toContain('related-source-policy');
        yield* f.store.remove(f.location, b.uri);
        yield* settle(f, 4, 100);
        expect((yield* readPreparedMemory(f.config, a.uri))?.omissions).toContain('related-source-unavailable');
      }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect(
    'reconstructs only current bounded code candidates from the configured project and keeps missing scope unknown',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const repository = f.path.join(f.home, 'repository');
        yield* f.fs.makeDirectory(repository);
        yield* f.fs.writeFileString(f.path.join(repository, 'source.ts'), 'export const automaticBoundary = true;\n');
        const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
        yield* git(['init', '--quiet']);
        yield* git(['add', '.']);
        yield* git([
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'source',
        ]);
        yield* f.fs.writeFileString(
          f.config.manifestPath,
          `version: 1\nprojects:\n  - name: selected\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/selected\n    seed: []\n`,
        );
        yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: f.home, ensureVectors: false});
        const target = record('automaticBoundary', 'The automaticBoundary is true.');
        const embedding = yield* CodeGraphEmbeddingIndex;
        const searchSpy = vi.spyOn(embedding, 'search');
        yield* Effect.gen(function* () {
          const unbound = yield* readAutomaticCodeEvidence(f.config, target, undefined);
          expect(unbound.omissions).toContain('code-project-unbound');
          expect(unbound.evidence).toHaveLength(0);
          const discovered = yield* readAutomaticCodeEvidence(f.config, target, repository);
          expect(discovered.candidates.length).toBeGreaterThan(0);
          expect(discovered.candidates.every(candidate => candidate.excerpt?.provenance === 'current-verified')).toBe(
            true,
          );
          const assessment = prepareAutomaticMemory(target, {
            scopeRevision,
            evidence: discovered.evidence,
            candidates: discovered.candidates,
          });
          expect(assessment.assessment.paragraphs[0].historicalEvidenceIds).toEqual([]);
          expect(assessment.assessment.paragraphs[0].currentSupport).toBe('unresolved');
          const packet = automaticReviewPacket(target, assessment);
          const current = packet.reviewEvidence.find(entry => entry.descriptor.source.kind === 'code')!;
          const actual = discovered.candidates.find(
            entry => entry.excerpt?.provenance === 'current-verified',
          )!.excerpt!;
          if (current.descriptor.source.kind !== 'code') throw new Error('Expected current code pin.');
          expect(current.descriptor.source.citation.fileContentHash.value).toBe(actual.source.fileContentHash);
          expect(current.codeExcerpt).toEqual({
            startLine: actual.startLine,
            endLine: actual.endLine,
            fileBytesHash: actual.fileBytesHash,
          });
          expect(current.descriptor.source.citation.target.kind).toBe('file');
          expect(packet.reviewEvidence.some(entry => entry.handleId.startsWith('historical:'))).toBe(false);

          yield* f.write(target);
          const snapshot = yield* prepareContextMaintenanceInventory(f.config, undefined, 100);
          // Real graph discovery is verified above; cache wiring must not promise a wall-clock IO latency.
          yield* advanceAutomaticPreparation(f.config, snapshot, new Map([['selected', repository]]), () =>
            Effect.succeed(discovered),
          );
          expect((yield* readPreparedMemory(f.config, target.uri))?.candidates.length).toBeGreaterThan(0);
          expect(searchSpy).not.toHaveBeenCalled();
        }).pipe(Effect.ensuring(Effect.sync(() => searchSpy.mockRestore())));
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it('preserves validated V1/V2 reviewed consolidation origin outside provisional current evidence', () => {
    const code = createMemoryCodeCitation({
      version: 1,
      repositoryId: '1'.repeat(64),
      repositoryIdentityKind: 'remote',
      sourceCommit: '2'.repeat(40),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${'3'.repeat(40)}`,
      extractorSet: 'native-code-graph-13',
      evidenceRetention: 'capsule-retained',
      path: 'src/current.ts',
      fileContentHash: {algorithm: 'sha256', value: '4'.repeat(64)},
      target: {kind: 'file'},
    });
    const source = record('original', undefined, {codeCitations: [code]});
    const captured = captureConsolidationSource(source);
    const body = 'Exact current statement.';
    const reviewed = reviewConsolidation(
      body,
      [captured],
      [
        {
          section: body,
          disposition: 'direct',
          supports: [{sourceUri: source.uri, fragment: 0, citationIds: [code.id], relationIndexes: []}],
        },
      ],
      {
        operationId: 'automatic-origin',
        cleanup: 'keep',
        cleanupShared: false,
        target: {kind: 'durable', status: 'active', project: 'selected', topic: 'output', sourceAgentClient: 'test'},
      },
    );
    const v1 = record('output', body, {consolidation: reviewed.provenance, codeCitations: reviewed.codeCitations});
    const origin = prepareAutomaticMemory(v1, {sources: [source], scopeRevision});
    expect(origin.origin?.receipt).toEqual(reviewed.provenance);
    expect(origin.assessment.preparation.kind).toBe('derived');
    expect(origin.assessment.paragraphs[0].historicalEvidenceIds).toEqual([]);
    expect(origin.assessment.evidence.some(e => e.source.kind === 'memory')).toBe(true);
    const updatedBody = 'Updated current statement.';
    const legacy = buildTopicMaintenanceManifest(record('output', updatedBody, {codeCitations: [code]}), {
      paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [code.id]}],
    });
    const manifest = {
      ...legacy,
      version: 2 as const,
      originCitationIds: [code.id],
      acceptedSources: [{citationId: code.id, acceptedCitationId: code.id}],
    };
    const v2 = buildConsolidationProvenanceV2(reviewed.provenance, body, updatedBody, manifest, {
      reviewId: 'review-automatic-origin',
      targetBeforeHash: sha256HexSync(v1.content),
      packetDigest: '5'.repeat(64),
      observationRevision: '6'.repeat(64),
    });
    const maintained = record('output', updatedBody, {
      consolidation: v2,
      codeCitations: [code],
      topicMaintenance: manifest,
    });
    const current = prepareAutomaticMemory(maintained, {scopeRevision});
    expect(current.origin?.receipt.version).toBe(2);
    expect(current.origin?.receipt).toMatchObject({
      origin: reviewed.provenance,
      originBody: body,
      acceptance: {paragraphs: [{evidence: 'reviewed-current'}]},
    });
  });

  effectIt.effect(
    'prioritizes reviewed origin source and fragment 50 ahead of unrelated relations and source prefixes',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const unrelated = Array.from({length: 9}, (_, i) => record(`a${i}`));
        const source = record('zz_origin', Array.from({length: 51}, (_, i) => `Origin paragraph ${i}.`).join('\n\n'), {
          relations: unrelated.map(r => ({type: 'related_to', uri: r.uri})),
        });
        const body = 'Origin paragraph 50.';
        const captured = captureConsolidationSource(source);
        const reviewed = reviewConsolidation(
          body,
          [captured],
          [
            {
              section: body,
              disposition: 'direct',
              supports: [
                {
                  sourceUri: source.uri,
                  fragment: 50,
                  citationIds: [],
                  relationIndexes: unrelated.map((_, i) => i),
                },
              ],
            },
          ],
          {
            operationId: 'reviewed-fragment-fifty',
            cleanup: 'keep',
            cleanupShared: false,
            target: {
              kind: 'durable',
              status: 'active',
              project: 'selected',
              topic: 'output',
              sourceAgentClient: 'test',
            },
          },
        );
        const target = record('output', body, {consolidation: reviewed.provenance, relations: reviewed.relations});
        yield* f.write(source);
        yield* f.write(target);
        for (const r of unrelated) yield* f.write(r);
        const snapshot = yield* prepareContextMaintenanceInventory(f.config, undefined, 100);
        const prepared = prepareAutomaticMemory(target, {sources: [...unrelated, source], scopeRevision});
        const memory = prepared.assessment.evidence.find(e => e.source.kind === 'memory');
        expect(memory?.source).toMatchObject({
          kind: 'memory',
          uri: source.uri,
          fragment: {ordinal: 50, hash: sha256HexSync(body)},
        });
        expect(prepared.origin?.receipt).toEqual(reviewed.provenance);
        yield* advanceAutomaticPreparation(
          f.config,
          snapshot,
          new Map(),
          () => Effect.succeed({evidence: [], candidates: [], reads: [], omissions: [], searchedScopes: []}),
          {maxRecords: 4},
        );
        yield* settle(f, 8, 100);
        const cached = yield* readPreparedMemory(f.config, target.uri);
        expect(
          cached?.assessment.evidence.some(e => e.source.kind === 'memory' && e.source.fragment.ordinal === 50),
        ).toBe(true);
      }).pipe(TestClock.withLive, provide),
  );

  it('keeps relevant source fragment identities independent of incidental metadata and input order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({minLength: 1, maxLength: 20}).filter(s => !/[\r\n]/u.test(s)),
          {minLength: 1, maxLength: 4},
        ),
        paragraphs => {
          const target = record('target', paragraphs.join('\n\n'));
          const source = record('source', paragraphs.join('\n\n'));
          const untouched = JSON.stringify([target, source]);
          const first = prepareAutomaticMemory(target, {sources: [source], scopeRevision});
          const timestampOnly = record('source', source.body, {
            ...source.metadata,
            timestamp: '2026-10-22T01:00:00.000Z',
          });
          const second = prepareAutomaticMemory(target, {sources: [timestampOnly], scopeRevision});
          expect(second.relevantRevision).toBe(first.relevantRevision);
          expect(second.assessment.evidence.map(e => e.id)).not.toEqual(first.assessment.evidence.map(e => e.id));
          expect(JSON.stringify([target, source])).toBe(untouched);
          expect(
            prepareAutomaticMemory(target, {
              sources: [record('source', source.body, {...source.metadata, validTo: '2027-01-01'})],
              scopeRevision,
            }).relevantRevision,
          ).not.toBe(first.relevantRevision);
        },
      ),
      {numRuns: 25, seed: 210756},
    );
  });

  it('separator-only source changes refresh exact spans while retaining relevant support', () => {
    fc.assert(
      fc.property(fc.integer({min: 3, max: 8}), separators => {
        const body = 'First paragraph.\n\nSecond paragraph.';
        const target = record('target', body);
        const source = record('source', body);
        const shifted = record('source', `First paragraph.${'\n'.repeat(separators)}Second paragraph.`);
        const first = prepareAutomaticMemory(target, {sources: [source], scopeRevision});
        const second = prepareAutomaticMemory(target, {sources: [shifted], scopeRevision});
        const oldFragments = first.assessment.evidence.flatMap(e =>
          e.source.kind === 'memory' ? [e.source.fragment] : [],
        );
        const newFragments = second.assessment.evidence.flatMap(e =>
          e.source.kind === 'memory' ? [e.source.fragment] : [],
        );
        expect(newFragments.map(f => [f.ordinal, f.hash])).toEqual(oldFragments.map(f => [f.ordinal, f.hash]));
        expect(newFragments[1].startOffset).not.toBe(oldFragments[1].startOffset);
        expect(second.assessment.evidence.map(e => e.id)).not.toEqual(first.assessment.evidence.map(e => e.id));
        expect(second.relevantRevision).toBe(first.relevantRevision);
      }),
      {numRuns: 12, seed: 75622},
    );
  });

  it('successor rotation converges independently of discovery order and attempted failures', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({min: 0, max: 30}), {minLength: 1, maxLength: 12}),
        fc.integer({min: 1, max: 4}),
        (ids, budget) => {
          const uris = ids.map(id => `memory:${String(id).padStart(2, '0')}`);
          const expected = new Set(uris);
          const seen = new Set<string>();
          let cursor: string | undefined;
          for (let tick = 0; tick < uris.length + 1; tick++) {
            const selected = selectAutomaticPreparationUris(tick % 2 ? uris : [...uris].reverse(), cursor, budget);
            for (const uri of selected) {
              seen.add(uri);
              cursor = uri;
            }
          }
          expect(seen).toEqual(expected);
        },
      ),
      {numRuns: 50, seed: 756210},
    );
  });

  fcEffectProp(
    effectIt,
    'bounded paging, restart and cache loss converge without canonical mutation',
    {
      ids: fc.uniqueArray(fc.integer({min: 0, max: 8}), {minLength: 1, maxLength: 5}),
      budget: fc.integer({min: 1, max: 5}),
    },
    ({ids, budget}) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const records = ids.map(id => record(`p${id}`));
        for (const r of records) yield* f.write(r);
        yield* settle(f, 25, budget);
        const before = yield* Effect.forEach(records, r => readPreparedMemory(f.config, r.uri));
        expect(before.every(Boolean)).toBe(true);
        yield* f.fs.remove(f.path.join(f.home, 'context-maintenance', 'automatic'), {recursive: true});
        yield* f.fs.remove(f.path.join(f.home, 'context-maintenance', 'inventory'), {recursive: true});
        yield* settle(f, 25, budget);
        const after = yield* Effect.forEach(records, r => readPreparedMemory(f.config, r.uri));
        expect(after.map(x => x?.relevantRevision)).toEqual(before.map(x => x?.relevantRevision));
        for (const r of records) expect(yield* f.store.read(f.location, r.uri)).toBe(r.content);
      }).pipe(TestClock.withLive, provide),
    {fastCheck: {numRuns: 6, seed: 7562026}, timeout: 30000},
  );
});
