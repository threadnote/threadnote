import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  contextHealthCaseIdV2,
  contextHealthCitationCaseSlotV2,
  resolveContextHealthRelationTargetV2,
} from '@threadnote/context/health_maintenance';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {automaticMaintenanceEvidenceId} from '@threadnote/memory/automatic-maintenance';
import {createReviewedSupportSnapshot, type ReviewedMemorySupportV1} from '@threadnote/memory/reviewed-support';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRelation,
} from '@threadnote/memory/document';
import type {ContextMaintenanceCaseV2, MaintenanceState} from '../../src/memory/context/maintenance_contracts.js';
import {maintenanceContentHash} from '../../src/memory/context/maintenance_policy.js';
import {sharedMaintenanceOwnerProposal} from '../../src/memory/context/maintenance_packet.js';
import {
  observeSelectedMaintenanceCase,
  readSelectedMaintenanceRelationResource,
  refreshContextMaintenanceCase,
  relationMaintenanceEvidenceCurrent,
  validRelationMaintenanceEvidence,
} from '../../src/memory/context/maintenance_refresh.js';
import {readContextMaintenancePacket, readState, writeState} from '../../src/memory/context/maintenance.js';
import {readMemoryRecordsByUri} from '../../src/mcp/server/memory.js';
import {collectContextHealth} from '../../src/memory/context/health_commands.js';
import {
  applyContextHealthRepair,
  previewContextHealthRepairs,
  renderContextHealthRepairPlan,
} from '../../src/memory/context/health_repair_commands.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const NOW = '2026-10-03T15:00:00.000Z';
const PREFIX = 'threadnote://user/tester/memories/';
const TEST_LAYER = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));

function memory(uri: string, relations: readonly MemoryRelation[] = [], metadata: Partial<MemoryMetadata> = {}) {
  return parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        schemaVersion: 2,
        kind: 'durable',
        memoryId: 'tn_subject',
        status: 'active',
        project: 'fixture',
        topic: 'subject',
        timestamp: NOW,
        sourceAgentClient: 'test',
        relations,
        ...metadata,
      },
      'Synthetic relation evidence.',
    ),
  )!;
}

function fixture(
  shared = false,
  relations: readonly MemoryRelation[] = [{type: 'references', uri: `${PREFIX}durable/projects/fixture/target.md`}],
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'maintenance-refresh-'});
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'test',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'tester',
    };
    const root = path.join(home, 'data', 'local', 'user', 'tester', 'memories');
    const uri = `${PREFIX}${shared ? 'shared/default/' : ''}durable/projects/fixture/subject.md`;
    const record = memory(uri, relations);
    const fileFor = (uri: string) => path.join(root, Effect2.pipe(uri, EffectString.slice(PREFIX.length)));
    const write = (record: ReturnType<typeof memory>) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(fileFor(record.uri)), {recursive: true});
        yield* fs.writeFileString(fileFor(record.uri), record.content);
      });
    yield* write(record);
    const item: ContextMaintenanceCaseV2 = {
      caseId: contextHealthCaseIdV2({
        project: 'fixture',
        memoryId: 'tn_subject',
        family: shared ? 'shared-owner-proposal' : 'relation',
        slot: shared ? 'relations' : (relations[0]?.uri ?? 'removed'),
      }),
      project: 'fixture',
      memoryId: 'tn_subject',
      family: shared ? 'shared-owner-proposal' : 'relation',
      slot: shared ? 'relations' : (relations[0]?.uri ?? 'removed'),
      evidenceRevision: 'old-evidence',
      disposition: 'needs-decision',
      reason: 'old-evidence',
      subjectContentHashes: [{uri, hash: maintenanceContentHash(record.content)}],
      firstSeen: NOW,
      lastSeen: NOW,
      lastChecked: NOW,
      attemptCount: 0,
      events: [],
    };
    const state: MaintenanceState = {
      version: 2,
      paused: false,
      state: 'idle',
      generation: 'fixture',
      projects: [],
      cases: [item],
      receipts: [],
      checkpoints: {},
    };
    return {fs, path, home, config, record, uri, item, state, fileFor, write};
  });
}

function repository(data: Effect.Success<ReturnType<typeof fixture>>) {
  return Effect.gen(function* () {
    const directory = data.path.join(data.home, 'repository');
    yield* data.fs.makeDirectory(directory);
    const root = yield* data.fs.realPath(directory);
    const source = data.path.join(root, 'source.ts');
    yield* data.fs.writeFileString(source, 'export const supported = true;\n');
    const git = (args: readonly string[]) => runCommandEffect('git', ['-C', root, ...args]);
    yield* git(['init', '--quiet']);
    yield* git(['add', '.']);
    yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    return {root, source, git};
  });
}

function repositoryGroup() {
  return Effect.gen(function* () {
    const data = yield* fixture();
    const records = [
      data.record,
      memory(`${PREFIX}durable/projects/fixture/second.md`, [], {memoryId: 'tn_second'}),
      memory(`${PREFIX}durable/projects/fixture/third.md`, [], {memoryId: 'tn_third'}),
    ];
    yield* Effect.forEach(records, data.write);
    const identity = {project: 'fixture', memoryId: 'repo_fixture', family: 'repository-recovery', slot: 'repository'};
    const item: ContextMaintenanceCaseV2 = {
      ...data.item,
      ...identity,
      caseId: contextHealthCaseIdV2(identity),
      repositoryId: identity.memoryId,
      reason: 'repository-ambiguous',
      subjectContentHashes: EffectArray.map(records, record => ({
        uri: record.uri,
        hash: maintenanceContentHash(record.content),
      })),
      sourceSnapshots: EffectArray.map(records, record => ({
        uri: record.uri,
        cwd: data.home,
        generation: 'retained-source-generation',
        revision: 'retained-source-revision',
      })),
    };
    const state = {...data.state, cases: [item]};
    yield* writeState(data.config, state);
    return {...data, records, item, state};
  });
}

describe('bounded selected repository recovery refresh', () => {
  effectIt.effect('reports the unsupported group prerequisite without rewriting subjects or retained evidence', () =>
    Effect.gen(function* () {
      const data = yield* repositoryGroup();
      const before = yield* readState(data.config);
      const result = yield* refreshContextMaintenanceCase(data.config, {
        project: data.item.project,
        caseId: data.item.caseId,
        cwd: data.home,
      });
      expect(result).toEqual({
        outcome: 'unavailable',
        reason:
          'Repository recovery does not support a grouped source refresh. Verify the repository association with authoritative repository evidence, then refresh the affected citation cases individually. Current source and route evidence have not been checked.',
      });
      expect(yield* readState(data.config)).toEqual(before);
      for (const record of data.records)
        expect(yield* data.fs.readFileString(data.fileFor(record.uri))).toBe(record.content);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses changed, replaced, unavailable and incompletely retained subjects', () =>
    Effect.gen(function* () {
      const data = yield* repositoryGroup();
      const selected = data.records[1];
      for (const changed of [
        {...selected, content: `${selected.content}\nChanged claim.`},
        memory(selected.uri, [], {memoryId: 'tn_replacement'}),
        memory(selected.uri, [], {status: 'archived'}),
        memory(selected.uri, [], {project: 'other'}),
      ]) {
        yield* data.write(changed);
        const result = yield* observeSelectedMaintenanceCase(data.config, data.state, data.item, data.home);
        expect(result.outcome).toBe('unavailable');
        expect('reason' in result && result.reason).not.toContain('does not support a grouped source refresh');
        expect('state' in result).toBe(false);
        expect(yield* data.fs.readFileString(data.fileFor(selected.uri))).toBe(changed.content);
      }
      yield* data.fs.remove(data.fileFor(selected.uri));
      const missing = yield* observeSelectedMaintenanceCase(data.config, data.state, data.item, data.home);
      expect(missing).toMatchObject({
        outcome: 'unavailable',
        reason: 'A selected memory is no longer available in this project.',
      });
      yield* data.write(selected);
      for (const item of [
        {...data.item, memoryId: 'repo_replaced'},
        {...data.item, repositoryId: undefined},
        {...data.item, slot: 'other'},
        {...data.item, subjectUri: selected.uri, subjectContentHashes: data.item.subjectContentHashes!.slice(0, 1)},
      ]) {
        const result = yield* observeSelectedMaintenanceCase(data.config, data.state, item, data.home);
        expect(result.outcome).toBe('unavailable');
        expect('reason' in result && result.reason).not.toContain('does not support a grouped source refresh');
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('detects a subject replacement during the closing read', () =>
    Effect.gen(function* () {
      const data = yield* repositoryGroup();
      const selected = data.records[1];
      const selectedFile = data.fileFor(selected.uri);
      let reads = 0;
      const racing = FileSystem.FileSystem.of({
        ...data.fs,
        readFileString: (file, ...options) =>
          Effect.gen(function* () {
            if (file === selectedFile && ++reads === 2)
              yield* data.write(memory(selected.uri, [], {memoryId: 'tn_replacement'}));
            return yield* data.fs.readFileString(file, ...options);
          }),
      });
      const result = yield* observeSelectedMaintenanceCase(data.config, data.state, data.item, data.home).pipe(
        Effect.provideService(FileSystem.FileSystem, racing),
      );
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(result.outcome).toBe('changing');
      expect(yield* readState(data.config)).toEqual(data.state);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.prop(
    'is deterministic and read-only under bounded subject ordering permutations',
    {rotation: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 2})), reverse: Schema.Boolean},
    ({rotation, reverse}) =>
      Effect.gen(function* () {
        const data = yield* repositoryGroup();
        const hashes = [...data.item.subjectContentHashes!];
        const ordered = [...hashes.slice(rotation), ...hashes.slice(0, rotation)];
        const item = {...data.item, subjectContentHashes: reverse ? ordered.reverse() : ordered};
        const first = yield* observeSelectedMaintenanceCase(data.config, data.state, item, data.home);
        const repeat = yield* observeSelectedMaintenanceCase(data.config, data.state, item, data.home);
        expect(first.outcome).toBe('unavailable');
        expect('reason' in first && first.reason).toContain('does not support a grouped source refresh');
        expect(repeat).toEqual(first);
        expect('state' in first).toBe(false);
        expect(yield* readState(data.config)).toEqual(data.state);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {arbitrary: {runs: 8, seed: 944}},
  );
});

describe('bounded selected relation maintenance refresh', () => {
  effectIt.effect.each([false, true])(
    'publishes exact refreshed citation evidence while paused (reviewed support: %s)',
    reviewed =>
      Effect.gen(function* () {
        const data = yield* fixture();
        const repo = yield* repository(data);
        yield* data.fs.writeFileString(
          data.config.manifestPath,
          `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(repo.root)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
        );
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: repo.root, threadnoteHome: data.home, ensureVectors: false});
        const roots = yield* captureMemoryCodeCitations(data.config, {
          callerCwd: repo.root,
          project: 'fixture',
          refs: ['source.ts'],
        });
        expect(roots).toHaveLength(1);
        let citations = roots;
        if (reviewed) {
          yield* data.fs.writeFileString(repo.source, 'export const supported = true; // reviewed support\n');
          yield* repo.git(['add', '.']);
          yield* repo.git([
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '--quiet',
            '-m',
            'reviewed',
          ]);
          yield* indexer.index({cwd: repo.root, threadnoteHome: data.home, ensureVectors: false});
          citations = yield* captureMemoryCodeCitations(data.config, {
            callerCwd: repo.root,
            project: 'fixture',
            refs: ['source.ts'],
          });
        }
        const source = {kind: 'code' as const, citation: citations[0]};
        const evidenceId = automaticMaintenanceEvidenceId(source);
        const bodyHash = sha256HexSync(data.record.body);
        const reviewedSupport: ReviewedMemorySupportV1 | undefined = reviewed
          ? {
              type: 'reviewed-memory-support',
              version: 1,
              active: createReviewedSupportSnapshot({
                bodyHash,
                paragraphs: [
                  {ordinal: 0, hash: bodyHash, role: 'descriptive', support: 'direct', evidenceIds: [evidenceId]},
                ],
                sources: [{id: evidenceId, source, scope: 'repository'}],
                acceptance: {
                  reviewId: 'review-citation-refresh',
                  approvedAt: NOW,
                  targetBeforeHash: bodyHash,
                  preparationDigest: bodyHash,
                  sourceVectorDigest: bodyHash,
                },
              }),
            }
          : undefined;
        const subject = memory(data.uri, data.record.metadata.relations, {
          schemaVersion: reviewed ? 11 : 5,
          codeCitations: roots,
          ...(reviewedSupport === undefined ? {} : {reviewedSupport}),
        });
        yield* data.write(subject);
        const target = memory(data.record.metadata.relations![0].uri, [], {memoryId: 'tn_target'});
        yield* data.write(
          parseMemoryDocument(target.uri, formatMemoryDocument('MEMORY', target.metadata, 'Independent target.'))!,
        );
        yield* data.fs.writeFileString(repo.source, 'export const supported = false;\n');
        yield* repo.git(['add', '.']);
        yield* repo.git([
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'changed',
        ]);
        yield* indexer.index({cwd: repo.root, threadnoteHome: data.home, ensureVectors: false});
        const identity = {
          project: 'fixture',
          memoryId: 'tn_subject',
          family: 'citation',
          slot: contextHealthCitationCaseSlotV2(citations[0]),
        };
        const item = {
          ...data.item,
          ...identity,
          caseId: contextHealthCaseIdV2(identity),
          citationId: citations[0].id,
          subjectContentHashes: [{uri: subject.uri, hash: maintenanceContentHash(subject.content)}],
        };
        yield* writeState(data.config, {...data.state, paused: true, cases: [item]});
        const selector = {kind: 'durable', topic: 'subject', findingCategory: 'citation-changed'};
        const deferred = yield* previewContextHealthRepairs(data.config, 'fixture', repo.root, selector);
        expect(deferred.proposals).toEqual([]);
        expect(deferred.citationCoverage).toMatchObject({eligible: 1, checked: 0, deferred: 1});
        expect(renderContextHealthRepairPlan(deferred)).toContain('Zero proposals does not establish');
        const refreshed = yield* refreshContextMaintenanceCase(data.config, {
          project: 'fixture',
          caseId: item.caseId,
          cwd: repo.root,
        });
        expect(refreshed.outcome).toBe('ready');
        if (refreshed.outcome !== 'ready') throw new Error('Expected exact retained citation packet.');
        expect(refreshed.item).toMatchObject({disposition: 'needs-decision', reason: 'source-changed'});
        expect(refreshed.packet.allowedOperations).toContain(
          reviewed ? 'context_maintenance_review' : 'context_health_repair_preview',
        );
        const state = yield* readState(data.config);
        const plan = yield* previewContextHealthRepairs(data.config, 'fixture', repo.root, selector);
        expect(plan.proposals).toHaveLength(1);
        expect(plan.proposals[0]).toMatchObject({
          category: 'citation-changed',
          mutation: {kind: 'review-only', subjectUri: subject.uri},
          preconditions: [{uri: subject.uri, expectedContentHash: maintenanceContentHash(subject.content)}],
        });
        expect(plan.citationCoverage).toMatchObject({eligible: 1, checked: 1, deferred: 0});
        expect(plan.knowledgeDelta.noAction).toBe(false);
        const report = yield* collectContextHealth(data.config, 'fixture', [subject], repo.root);
        expect(EffectArray.some(report.findings, finding => finding.category === 'citation-changed')).toBe(true);
        expect(
          yield* applyContextHealthRepair(data.config, {
            ...selector,
            project: 'fixture',
            cwd: repo.root,
            proposalId: plan.proposals[0].proposalId,
            revision: plan.proposals[0].revision,
            approved: true,
          }),
        ).toMatchObject({status: 'review-required'});
        expect(yield* data.fs.readFileString(data.fileFor(subject.uri))).toBe(subject.content);
        expect(yield* readState(data.config)).toEqual(state);
        // Dirty source cannot reuse the clean refreshed decision as current evidence.
        yield* data.fs.writeFileString(repo.source, 'export const supported = true;\n');
        const stale = yield* previewContextHealthRepairs(data.config, 'fixture', repo.root, selector);
        expect(stale.proposals).toEqual([]);
        expect(stale.citationCoverage?.deferred).toBe(1);
        expect(yield* data.fs.readFileString(data.fileFor(subject.uri))).toBe(subject.content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('observes the selected canonical target without repairing bytes and is idempotent', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const target = memory(data.record.metadata.relations![0].uri, [], {memoryId: 'tn_target'});
      yield* data.write(target);
      const selected = {...data.item, slot: 'tn_target'};
      const first = yield* observeSelectedMaintenanceCase(data.config, data.state, selected, data.home);
      expect(first.outcome).toBe('observed');
      if (first.outcome !== 'observed') return;
      expect(first.item.caseId).toBe(selected.caseId);
      expect(first.item.disposition).toBe('resolved');
      expect(first.item.relationEvidence?.observations).toEqual([
        expect.objectContaining({uri: target.uri, memoryId: 'tn_target', status: 'active'}),
      ]);
      expect(first.item.subjectContentHashes).toHaveLength(1);
      const repeat = yield* observeSelectedMaintenanceCase(data.config, first.state, first.item, data.home);
      expect(repeat.outcome).toBe('observed');
      if (repeat.outcome === 'observed') expect(repeat.item).toBe(first.item);
      expect(yield* data.fs.readFileString(data.fileFor(data.uri))).toBe(data.record.content);
      expect(yield* data.fs.readFileString(data.fileFor(target.uri))).toBe(target.content);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps readable alias and canonical relations out of a selected shared citation refresh', () =>
    Effect.gen(function* () {
      const alias = 'threadnote://memory/tn_alias_target';
      const canonical = `${PREFIX}shared/default/durable/projects/fixture/canonical-target.md`;
      const data = yield* fixture(true, [
        {type: 'references', uri: alias},
        {type: 'depends_on', uri: canonical},
      ]);
      const repo = yield* repository(data);
      yield* data.fs.writeFileString(
        data.config.manifestPath,
        `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(repo.root)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
      );
      yield* (yield* CodeGraphIndexer).index({cwd: repo.root, threadnoteHome: data.home, ensureVectors: false});
      const citations = yield* captureMemoryCodeCitations(data.config, {
        callerCwd: repo.root,
        project: 'fixture',
        refs: ['source.ts'],
      });
      const subject = memory(data.uri, data.record.metadata.relations, {schemaVersion: 5, codeCitations: citations});
      const aliasTarget = memory(`${PREFIX}shared/default/durable/projects/fixture/alias-target.md`, [], {
        memoryId: 'tn_alias_target',
      });
      const canonicalTarget = memory(canonical, [], {memoryId: 'tn_canonical_target'});
      for (const record of [subject, aliasTarget, canonicalTarget]) yield* data.write(record);
      const readable = yield* readMemoryRecordsByUri(data.config, [aliasTarget.uri, canonicalTarget.uri]);
      expect(readable).toHaveLength(2);
      expect(resolveContextHealthRelationTargetV2(readable, alias).record?.metadata.memoryId).toBe('tn_alias_target');
      expect(resolveContextHealthRelationTargetV2(readable, canonical).record?.uri).toBe(canonical);
      const item: ContextMaintenanceCaseV2 = {
        ...data.item,
        caseId: contextHealthCaseIdV2({
          project: 'fixture',
          memoryId: 'tn_subject',
          family: 'citation',
          slot: contextHealthCitationCaseSlotV2(citations[0]),
        }),
        family: 'citation',
        slot: contextHealthCitationCaseSlotV2(citations[0]),
        citationId: citations[0].id,
        subjectContentHashes: [{uri: subject.uri, hash: maintenanceContentHash(subject.content)}],
      };
      yield* writeState(data.config, {...data.state, cases: [item]});
      yield* data.fs.writeFileString(repo.source, 'export const supported = false;\n');
      const refreshed = yield* refreshContextMaintenanceCase(data.config, {
        project: 'fixture',
        caseId: item.caseId,
        cwd: repo.root,
      });
      expect(['ready', 'resolved']).toContain(refreshed.outcome);
      if (refreshed.outcome !== 'ready' && refreshed.outcome !== 'resolved')
        throw new Error('Expected citation packet.');
      expect(refreshed.item.subjectContentHashes).toHaveLength(1);
      expect(refreshed.item.relationEvidence).toBeUndefined();
      expect('ownerProposal' in refreshed.packet && refreshed.packet.ownerProposal).toMatchObject({
        readOnly: true,
        selectedEdits: [],
        evidence: {completeness: 'unknown', supportsAbsence: false},
      });
      for (const record of [subject, aliasTarget, canonicalTarget]) {
        expect(yield* data.fs.readFileString(data.fileFor(record.uri))).toBe(record.content);
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reads the actual shared canonical namespace and withholds partial-corpus removal suggestions', () =>
    Effect.gen(function* () {
      const data = yield* fixture(true);
      const result = yield* observeSelectedMaintenanceCase(data.config, data.state, data.item, data.home);
      expect(result.outcome).toBe('observed');
      if (result.outcome !== 'observed') return;
      expect(result.item.disposition).toBe('waiting-evidence');
      expect(result.item.relationEvidence?.subject.uri).toBe(data.uri);
      const proposal = sharedMaintenanceOwnerProposal(data.record, undefined, result.item.relationEvidence);
      expect(proposal.selectedEdits).toEqual([]);
      expect(proposal.evidence).toMatchObject({completeness: 'selected-only', supportsAbsence: false});
      expect(yield* data.fs.readFileString(data.fileFor(data.uri))).toBe(data.record.content);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps an unresolved selected identity alias inspectable as unknown, without retargeting it', () =>
    Effect.gen(function* () {
      const data = yield* fixture(false, [{type: 'depends_on', uri: 'threadnote://memory/tn_unresolved'}]);
      const result = yield* observeSelectedMaintenanceCase(
        data.config,
        data.state,
        {...data.item, slot: 'tn_unresolved'},
        data.home,
      );
      expect(result.outcome).toBe('observed');
      if (result.outcome !== 'observed') return;
      expect(result.item.slot).toBe('tn_unresolved');
      expect(result.item.disposition).toBe('waiting-evidence');
      expect(result.item.relationEvidence?.observations).toEqual([{uri: 'threadnote://memory/tn_unresolved'}]);
      expect(result.records).toEqual([data.record]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('never rebinds a retained slot when the canonical relation is removed or replaced', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const original = memory(data.record.metadata.relations![0].uri, [], {memoryId: 'tn_original'});
      const replacement = memory(`${PREFIX}durable/projects/fixture/replacement.md`, [], {memoryId: 'tn_replacement'});
      yield* data.write(original);
      yield* data.write(replacement);
      for (const relations of [[], [{type: 'references' as const, uri: replacement.uri}]]) {
        const changedSubject = memory(data.uri, relations);
        yield* data.write(changedSubject);
        const result = yield* observeSelectedMaintenanceCase(data.config, data.state, data.item, data.home);
        expect(result.outcome).toBe('incomplete');
        expect('state' in result).toBe(false);
        expect(data.item.slot).toBe(original.uri);
        expect(yield* data.fs.readFileString(data.fileFor(data.uri))).toBe(changedSubject.content);
        expect(yield* data.fs.readFileString(data.fileFor(original.uri))).toBe(original.content);
        expect(yield* data.fs.readFileString(data.fileFor(replacement.uri))).toBe(replacement.content);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses source-only drift during the closing relation check without changing canonical bytes', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const repo = yield* repository(data);
      yield* data.fs.writeFileString(
        data.config.manifestPath,
        `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(repo.root)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
      );
      yield* (yield* CodeGraphIndexer).index({cwd: repo.root, threadnoteHome: data.home, ensureVectors: false});
      const citations = yield* captureMemoryCodeCitations(data.config, {
        callerCwd: repo.root,
        project: 'fixture',
        refs: ['source.ts'],
      });
      const subject = memory(data.uri, data.record.metadata.relations, {schemaVersion: 5, codeCitations: citations});
      const target = memory(data.record.metadata.relations![0].uri, [], {memoryId: 'tn_target'});
      yield* data.write(subject);
      yield* data.write(target);
      const targetPath = yield* data.fs.realPath(data.fileFor(target.uri));
      let targetPaths = 0;
      const racing = FileSystem.FileSystem.of({
        ...data.fs,
        realPath: file =>
          Effect.gen(function* () {
            if (file === targetPath && ++targetPaths === 3)
              yield* data.fs.writeFileString(repo.source, 'export const supported = false;\n');
            return yield* data.fs.realPath(file);
          }),
      });
      const item = {
        ...data.item,
        subjectContentHashes: [{uri: subject.uri, hash: maintenanceContentHash(subject.content)}],
        sourceSnapshot: {cwd: repo.root, generation: 'historical-source', revision: 'historical-source'},
      };
      const result = yield* observeSelectedMaintenanceCase(
        data.config,
        {...data.state, cases: [item]},
        item,
        repo.root,
      ).pipe(Effect.provideService(FileSystem.FileSystem, racing));
      expect(targetPaths).toBeGreaterThanOrEqual(3);
      expect(result.outcome).toBe('changing');
      expect(yield* data.fs.readFileString(data.fileFor(subject.uri))).toBe(subject.content);
      expect(yield* data.fs.readFileString(data.fileFor(target.uri))).toBe(target.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('returns a full shared packet and rejects team base drift across packet construction', () =>
    Effect.gen(function* () {
      const data = yield* fixture(true);
      const repo = yield* repository(data);
      const teamsFile = data.path.join(data.home, 'share', 'teams.json');
      yield* data.fs.makeDirectory(data.path.dirname(teamsFile), {recursive: true});
      yield* data.fs.writeFileString(
        teamsFile,
        JSON.stringify({
          version: 1,
          teams: {default: {remote: 'https://example.invalid/team.git', worktree: repo.root}},
        }),
      );
      yield* writeState(data.config, data.state);
      const refreshed = yield* refreshContextMaintenanceCase(data.config, {
        project: 'fixture',
        caseId: data.item.caseId,
        cwd: repo.root,
      });
      expect(refreshed.outcome).toBe('ready');
      if (refreshed.outcome !== 'ready') throw new Error('Expected fresh inspection packet.');
      expect('ownerProposal' in refreshed.packet && refreshed.packet.ownerProposal).toMatchObject({
        sharedBase: {state: 'available'},
        selectedEdits: [],
        evidence: {supportsAbsence: false},
      });
      let reads = 0;
      const commands = yield* CommandExecutor;
      const racing = FileSystem.FileSystem.of({
        ...data.fs,
        readFileString: (file, encoding) =>
          Effect.gen(function* () {
            if (file === teamsFile && ++reads === 2)
              yield* repo
                .git([
                  '-c',
                  'user.name=Test',
                  '-c',
                  'user.email=test@example.invalid',
                  'commit',
                  '--quiet',
                  '--allow-empty',
                  '-m',
                  'changed base',
                ])
                .pipe(Effect.provideService(CommandExecutor, commands), Effect.orDie);
            return yield* data.fs.readFileString(file, encoding);
          }),
      });
      const result = yield* readContextMaintenancePacket(data.config, data.item.caseId).pipe(
        Effect.provideService(FileSystem.FileSystem, racing),
        Effect.result,
      );
      expect(reads).toBe(2);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(String(result.failure)).toContain('shared base changed');
      expect(yield* data.fs.readFileString(data.fileFor(data.uri))).toBe(data.record.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('detects target content, status and identity changes after observation', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const target = memory(data.record.metadata.relations![0].uri, [], {memoryId: 'tn_target'});
      yield* data.write(target);
      const observed = yield* observeSelectedMaintenanceCase(data.config, data.state, data.item, data.home);
      if (observed.outcome !== 'observed') throw new Error('Expected observed target.');
      expect(yield* relationMaintenanceEvidenceCurrent(data.config, observed.item.relationEvidence!)).toBe(true);
      for (const changed of [
        {...target, content: `${target.content}\nChanged target body.`},
        memory(target.uri, [], {memoryId: 'tn_target', status: 'archived'}),
        memory(target.uri, [], {memoryId: 'tn_replacement'}),
      ]) {
        yield* data.write(changed);
        expect(yield* relationMaintenanceEvidenceCurrent(data.config, observed.item.relationEvidence!)).toBe(false);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses a target change between opening and closing observations', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const target = memory(data.record.metadata.relations![0].uri, [], {memoryId: 'tn_target'});
      yield* data.write(target);
      const targetPath = yield* data.fs.realPath(data.fileFor(target.uri));
      let targetPaths = 0;
      const racing = FileSystem.FileSystem.of({
        ...data.fs,
        realPath: file =>
          Effect.gen(function* () {
            if (file === targetPath && ++targetPaths === 3)
              yield* data.write(memory(target.uri, [], {memoryId: 'tn_replacement'}));
            return yield* data.fs.realPath(file);
          }),
      });
      const result = yield* observeSelectedMaintenanceCase(data.config, data.state, data.item, data.home).pipe(
        Effect.provideService(FileSystem.FileSystem, racing),
      );
      expect(result.outcome).toBe('changing');
      expect(targetPaths).toBeGreaterThanOrEqual(3);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps unreadable, oversized and foreign target evidence unknown', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const targetUri = data.record.metadata.relations![0].uri;
      yield* data.fs.writeFileString(
        data.fileFor(targetUri),
        Effect2.pipe('x', EffectString.repeat(8 * 1_024 * 1_024 + 1)),
      );
      const oversized = yield* readSelectedMaintenanceRelationResource(data.config, targetUri);
      expect(oversized).toEqual({record: undefined, observation: {uri: targetUri}});
      const foreign = 'threadnote://user/other/memories/durable/projects/fixture/private.md';
      expect(yield* readSelectedMaintenanceRelationResource(data.config, foreign)).toEqual({
        record: undefined,
        observation: {uri: foreign},
      });
      const missing = `${PREFIX}durable/projects/fixture/missing.md`;
      expect(yield* readSelectedMaintenanceRelationResource(data.config, missing)).toEqual({
        record: undefined,
        observation: {uri: missing},
      });
      yield* data.fs.writeFile(data.fileFor(targetUri), new Uint8Array([0xff, 0xfe, 0x61]));
      expect(yield* readSelectedMaintenanceRelationResource(data.config, targetUri)).toEqual({
        record: undefined,
        observation: {uri: targetUri},
      });
    }).pipe(provideTestLayer(TEST_LAYER)),
  );

  effectIt.effect.prop(
    'counts failed target identities and preserves shared bytes across bounded selections and orderings',
    [Schema.Literals([0, 1, 2, 8, 30, 31, 32, 33]), Schema.Boolean],
    ([count, reverse]) =>
      Effect.gen(function* () {
        const targets = Array.from({length: count}, (_, index) => ({
          type: 'references' as const,
          uri: `${PREFIX}durable/projects/fixture/missing-${index}.md`,
        }));
        const data = yield* fixture(true, reverse ? targets.reverse() : targets);
        const result = yield* observeSelectedMaintenanceCase(data.config, data.state, data.item, data.home);
        expect(result.outcome).toBe(count + 1 <= 32 ? 'observed' : 'incomplete');
        if (result.outcome === 'observed') {
          expect(result.item.relationEvidence?.observations).toHaveLength(count);
          expect(
            sharedMaintenanceOwnerProposal(data.record, undefined, result.item.relationEvidence).selectedEdits,
          ).toEqual([]);
        }
        expect(yield* data.fs.readFileString(data.fileFor(data.uri))).toBe(data.record.content);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {arbitrary: {runs: 24}},
  );

  effectIt.effect('returns no current evidence for malformed persisted observations without reading targets', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const evidence = {
        completeness: 'selected-only',
        provenance: 'bounded-selected-resource-read',
        subject: {uri: data.uri},
        observations: Array.from({length: 32}, (_, index) => ({uri: `threadnote://memory/tn_${index}`})),
      } as const;
      expect(validRelationMaintenanceEvidence(evidence)).toBe(false);
      expect(yield* relationMaintenanceEvidenceCurrent(data.config, evidence)).toBe(false);
      expect(validRelationMaintenanceEvidence({...evidence, observations: [{uri: data.uri}]})).toBe(false);
      expect(
        validRelationMaintenanceEvidence({...evidence, observations: [{uri: 'valid', sourceHash: 'invalid'}]}),
      ).toBe(false);
      expect(validRelationMaintenanceEvidence({})).toBe(false);
    }).pipe(provideTestLayer(TEST_LAYER)),
  );

  effectIt.effect('persists a fresh selected packet without falling back to unrelated corpus reads', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const target = memory(data.record.metadata.relations![0].uri, [], {memoryId: 'tn_target'});
      yield* data.write(target);
      yield* writeState(data.config, data.state);
      const opened = new Map<string, number>();
      const counted = FileSystem.FileSystem.of({
        ...data.fs,
        open: (file, options) =>
          data.fs
            .open(file, options)
            .pipe(Effect.tap(() => Effect.sync(() => opened.set(file, (opened.get(file) ?? 0) + 1)))),
      });
      const refreshed = yield* refreshContextMaintenanceCase(data.config, {
        project: 'fixture',
        caseId: data.item.caseId,
        cwd: data.home,
      }).pipe(Effect.provideService(FileSystem.FileSystem, counted));
      expect(refreshed.outcome).toBe('resolved');
      expect(opened.get(yield* data.fs.realPath(data.fileFor(data.uri)))).toBe(4);
      expect(opened.get(yield* data.fs.realPath(data.fileFor(target.uri)))).toBe(4);
      const before = yield* readState(data.config);
      const fs = FileSystem.FileSystem.of({
        ...data.fs,
        readDirectory: () => Effect.die('Unexpected full-corpus scan.'),
      });
      const packet = yield* readContextMaintenancePacket(data.config, data.item.caseId).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      expect('relationEvidence' in packet && packet.relationEvidence).toMatchObject({completeness: 'selected-only'});
      expect(yield* readState(data.config)).toEqual(before);
      yield* data.write({...target, content: `${target.content}\nChanged after refresh.`});
      expect((yield* readContextMaintenancePacket(data.config, data.item.caseId).pipe(Effect.result))._tag).toBe(
        'Failure',
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
