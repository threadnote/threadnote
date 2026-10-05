import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Path, PlatformError, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  readContextMaintenanceStatus,
  runContextMaintenance,
  safeRelationRemoval,
  resolveMaintenanceRelationPolicy,
  selectFairMaintenanceWork,
  setContextMaintenancePaused,
  undoContextMaintenance,
  updateMaintenanceCase,
  duplicateArchiveSafe,
  migrateMaintenanceCases,
  readContextMaintenancePacket,
  retireContextMaintenanceAnchor,
  reconcileRepositoryRecoveryCases,
  maintenanceAnchorChunksComplete,
  planMaintenanceWorkerBatches,
  maintenanceWorkerRecordValidations,
  renderContextMaintenanceStatus,
} from '@threadnote/threadnote/memory/context/maintenance';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {contextHealthCitationCaseSlotV2} from '@threadnote/context/health_maintenance';
import {readMaintenanceMemoryRecords} from '@threadnote/threadnote/memory/maintenance/records';
import {collectContextHealth} from '@threadnote/threadnote/memory/context/health_commands';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  prepareContextMaintenanceInventory,
  pruneAbsentMaintenanceCheckpoints,
} from '@threadnote/threadnote/memory/context/maintenance_inventory';
import {buildCandidateReview, candidateReviewWithState, saveCandidateReview} from '@threadnote/memory/candidate';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  maintenanceSemanticWindowCount,
  selectMaintenanceSemanticPairBatch,
  selectMaintenanceWorkPhase,
} from '@threadnote/threadnote/memory/context/maintenance_decisions';
import {captureCitationReplacements} from '@threadnote/threadnote/memory/context/health_repair_commands';
import {buildContextHealthReport} from '@threadnote/context/health';
import {
  advanceContextMaintenanceEvidenceRequestDiscovery,
  advanceContextMaintenanceEvidenceRequestExecution,
  contextMaintenanceEvidenceDiscoveryPending,
  contextMaintenanceEvidenceRequestFileName,
  contextMaintenanceEvidenceRequestKey,
  readContextMaintenanceEvidenceRequests,
} from '@threadnote/threadnote/memory/context/maintenance_evidence';
import {ResourceStore} from '@threadnote/store/resource-store';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {
  mergeMaintenanceWorkerEvidence,
  invalidateMaintenanceWorkerBatch,
  prepareMaintenanceWorkerBatches,
  collectMaintenanceWorkerBatch,
  runRequestedMaintenanceProjection,
  selectRelationBoundedMaintenanceWindow,
  selectRequestedMaintenanceUris,
} from '../../src/memory/context/maintenance_batch.js';
import {
  hasAbsentMaintenanceAnchors,
  reconcileAbsentMaintenanceAnchors,
} from '../../src/memory/context/maintenance_policy.js';

const NOW = '2026-10-03T15:00:00.000Z';
const URI = 'threadnote://user/tester/memories/durable/projects/threadnote/source.md';
function record(topic: string, metadata: Partial<MemoryMetadata> = {}, body = 'Keep useful context.') {
  const uri = URI.replace('source.md', `${topic}.md`);
  return parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        schemaVersion: 2,
        memoryId: `tn_${topic}`,
        project: 'threadnote',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: NOW,
        topic,
        ...metadata,
      },
      body,
    ),
  )!;
}

function legacyBatchSubject(index: number, project: string, selectors: readonly number[]) {
  const uri = `threadnote://user/tester/memories/durable/projects/${project}/subject-${index}.md`;
  const original = parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        project,
        topic: `subject-${index}`,
        sourceAgentClient: 'test',
        timestamp: NOW,
      },
      'Synthetic legacy subject.',
    ),
  )!;
  return {
    ...original,
    metadata: {
      ...original.metadata,
      codeCitations: selectors.map((selector, anchor) =>
        createMemoryCodeCitation({
          version: 1,
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'local',
          sourceCommit: selector.toString(16).padStart(40, '0'),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          extractorSet: 'test',
          path: `source-${index}-${anchor}.ts`,
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          target: {kind: 'file'},
        }),
      ),
    },
  };
}

describe('persistent context maintenance', () => {
  it('prunes absent checkpoints only after a complete unscoped inventory', () => {
    const keys = new Set(['selected:0']);
    const scoped = {'selected:0': 1, 'other:0': 2};
    pruneAbsentMaintenanceCheckpoints(scoped, keys, {project: 'selected', complete: true});
    expect(scoped).toEqual({'selected:0': 1, 'other:0': 2});
    pruneAbsentMaintenanceCheckpoints(scoped, keys, {complete: false});
    expect(scoped).toEqual({'selected:0': 1, 'other:0': 2});
    pruneAbsentMaintenanceCheckpoints(scoped, keys, {complete: true});
    expect(scoped).toEqual({'selected:0': 1});
  });

  it('preserves every checkpoint outside a scoped or incomplete inventory', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({minLength: 1, maxLength: 20}), {maxLength: 30}),
        fc.boolean(),
        (names, complete) => {
          const before = Object.fromEntries(names.map((name, index) => [name, index]));
          const checkpoints = {...before};
          pruneAbsentMaintenanceCheckpoints(checkpoints, new Set(names.slice(0, names.length / 2)), {
            project: complete ? 'selected' : undefined,
            complete,
          });
          expect(checkpoints).toEqual(before);
        },
      ),
      {numRuns: 50},
    );
  });

  it('splits a legacy 64-anchor single-selector task into four complete bounded parts', () => {
    const record = legacyBatchSubject(
      0,
      'one',
      Array.from({length: 64}, () => 0),
    );
    const task = {record, project: 'one', chunk: 0, key: 'legacy:0'};
    const before = structuredClone(task);
    const groups = planMaintenanceWorkerBatches([task]);
    expect(groups).toHaveLength(4);
    expect(groups.map(group => group[0].citationIds?.length)).toEqual([16, 16, 16, 16]);
    expect(groups.flatMap(group => group.flatMap(part => part.citationIds ?? []))).toEqual(
      record.metadata.codeCitations.map(citation => citation.id),
    );
    expect(groups.flat().every(part => part.key === task.key && part.chunk === 0)).toBe(true);
    expect(task).toEqual(before);
  });

  it('keeps all cited memory kinds in the same bounded citation scope', () => {
    const records = [
      legacyBatchSubject(0, 'one', [0, 0, 0, 0]),
      legacyBatchSubject(1, 'one', [0, 0, 0, 0]),
      legacyBatchSubject(2, 'one', [1]),
    ].map((item, index) => ({
      ...item,
      metadata: {...item.metadata, kind: index === 2 ? ('incident' as const) : ('handoff' as const)},
    }));
    const tasks = records.map((value, index) => ({record: value, project: 'one', chunk: 0, key: `${index}:0`}));
    const groups = planMaintenanceWorkerBatches(tasks);
    expect(groups.map(group => group.map(task => task.key))).toEqual([['0:0', '1:0', '2:0']]);
    expect(
      groups.flatMap(group =>
        group.flatMap(
          task => task.citationIds ?? task.record.metadata.codeCitations?.map(citation => citation.id) ?? [],
        ),
      ),
    ).toEqual(records.flatMap(record => record.metadata.codeCitations?.map(citation => citation.id) ?? []));
  });

  it('keeps worker association scopes invariant when cited memory kinds change', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('durable', 'handoff', 'incident', 'preference', 'smoke'), {maxLength: 40}),
        kinds => {
          const baseline = kinds.map((_, index) => ({
            record: legacyBatchSubject(index, 'one', [index % 12]),
            project: 'one',
            chunk: 0,
            key: String(index),
          }));
          const varied = baseline.map((task, index) => ({
            ...task,
            record: {...task.record, metadata: {...task.record.metadata, kind: kinds[index]}},
          }));
          const scopes = (tasks: typeof baseline) =>
            planMaintenanceWorkerBatches(tasks).map(group => ({
              keys: group.map(task => task.key),
              selectors: [
                ...new Set(
                  group.flatMap(task =>
                    task.record.metadata.codeCitations.map(
                      citation => `${citation.repositoryId}:${citation.sourceCommit}`,
                    ),
                  ),
                ),
              ].sort(),
            }));
          expect(scopes(varied)).toEqual(scopes(baseline));
        },
      ),
      {numRuns: 50},
    );
  });

  it('preserves every selected legacy anchor and per-project task order under independent batch bounds', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            project: fc.constantFrom('one', 'two', 'three'),
            kind: fc.constantFrom('durable', 'handoff', 'incident'),
            selectors: fc.array(fc.integer({min: 0, max: 20}), {maxLength: 130}),
            selectedOnly: fc.boolean(),
            parity: fc.integer({min: 0, max: 1}),
          }),
          {minLength: 1, maxLength: 8},
        ),
        inputs => {
          const tasks = inputs.flatMap((input, index) => {
            const original = legacyBatchSubject(index, input.project, input.selectors);
            const record = {...original, metadata: {...original.metadata, kind: input.kind}};
            return Array.from({length: Math.max(1, Math.ceil(input.selectors.length / 64))}, (_, chunk) => ({
              record,
              project: input.project,
              chunk,
              key: `${index}:${chunk}`,
              citationIds: input.selectedOnly
                ? record.metadata.codeCitations
                    .slice(chunk * 64, (chunk + 1) * 64)
                    .filter((_, anchor) => anchor % 2 === input.parity)
                    .map(citation => citation.id)
                : undefined,
            }));
          });
          const before = structuredClone(tasks);
          const expected = tasks.map(task => ({
            ...task,
            ids: task.record.metadata.codeCitations
              .filter((_, index) => Math.floor(index / 64) === task.chunk)
              .filter(citation => task.citationIds === undefined || task.citationIds.includes(citation.id))
              .map(citation => citation.id),
          }));
          const groups = planMaintenanceWorkerBatches(tasks);
          for (const group of groups) {
            expect(new Set(group.map(task => task.project)).size).toBe(1);
            const anchors = group.flatMap(task =>
              task.record.metadata.codeCitations
                .filter((_, index) => Math.floor(index / 64) === task.chunk)
                .filter(citation => task.citationIds === undefined || task.citationIds.includes(citation.id)),
            );
            expect(anchors.length).toBeGreaterThan(0);
            expect(anchors.length).toBeLessThanOrEqual(16);
            expect(
              new Set(anchors.map(citation => `${citation.repositoryId}:${citation.sourceCommit}`)).size,
            ).toBeLessThanOrEqual(8);
          }
          for (const task of expected) {
            const actual = groups.flat().filter(part => part.key === task.key);
            const ids = actual.flatMap(part =>
              part.record.metadata.codeCitations
                .filter((_, index) => Math.floor(index / 64) === part.chunk)
                .filter(citation => part.citationIds === undefined || part.citationIds.includes(citation.id))
                .map(citation => citation.id),
            );
            expect(ids).toEqual(task.ids);
          }
          for (const project of ['one', 'two', 'three']) {
            const actualKeys = groups
              .flat()
              .filter(task => task.project === project)
              .map(task => task.key);
            const consecutiveKeys = actualKeys.filter((key, index) => index === 0 || key !== actualKeys[index - 1]);
            expect(consecutiveKeys).toEqual(
              expected.filter(task => task.project === project && task.ids.length > 0).map(task => task.key),
            );
          }
          expect(tasks).toEqual(before);
          expect(planMaintenanceWorkerBatches(tasks)).toEqual(groups);
        },
      ),
      {numRuns: 40, seed: 120416},
    );
  });

  effectIt.effect('visits every record with a four-task window even when the caller requests 100', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      for (let index = 0; index < 17; index++) {
        const subject = record(`window-${String(index).padStart(2, '0')}`);
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `window-${String(index).padStart(2, '0')}.md`),
          subject.content,
        );
      }
      let checked = 0;
      for (let tick = 0; tick < 17 && checked < 17; tick++) {
        const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100});
        const current = result.projects.find(project => project.project === 'threadnote')?.checked ?? 0;
        expect(current - checked).toBeGreaterThanOrEqual(0);
        expect(current - checked).toBeLessThanOrEqual(4);
        checked = current;
      }
      expect(checked).toBe(17);
      const replay = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100});
      expect(replay.projects.find(project => project.project === 'threadnote')).toMatchObject({
        eligible: 17,
        checked: 17,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'keeps an unrelated completed checkpoint across scoped ticks, then prunes proven absence globally',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const foreignDirectory = fixture.path.join(fixture.directory, '..', 'foreign');
        yield* fixture.fs.makeDirectory(foreignDirectory, {recursive: true});
        yield* fixture.fs.writeFileString(fixture.source, record('source').content);
        const foreign = fixture.path.join(foreignDirectory, 'foreign.md');
        yield* fixture.fs.writeFileString(foreign, record('foreign', {project: 'foreign'}).content);
        const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
        let checkpoints: Record<string, unknown> = {};
        for (let tick = 0; tick < 8 && checkpoints['tn_foreign:0'] === undefined; tick++) {
          yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
          checkpoints = JSON.parse(yield* fixture.fs.readFileString(stateFile)).checkpoints;
        }
        expect(checkpoints['tn_foreign:0']).toBeDefined();
        yield* fixture.fs.remove(foreign);
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home, project: 'threadnote'});
        checkpoints = JSON.parse(yield* fixture.fs.readFileString(stateFile)).checkpoints;
        expect(checkpoints['tn_foreign:0']).toBeDefined();
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        checkpoints = JSON.parse(yield* fixture.fs.readFileString(stateFile)).checkpoints;
        expect(checkpoints['tn_foreign:0']).toBeUndefined();
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('logical checkpoint coverage converges with trailing newlines and managed legacy footers', () =>
    Effect.gen(function* () {
      for (const envelope of ['\n', '\n\n<!-- MEMORY_FIELDS\nversion: 1\n-->']) {
        const fixture = yield* makeFixture();
        const source = record('source');
        const raw = `${source.content}${envelope}`;
        yield* fixture.fs.writeFileString(fixture.source, raw);
        const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
        const checkpoint = JSON.parse(yield* fixture.fs.readFileString(stateFile)).checkpoints['tn_source:0'];
        expect(checkpoint).toBeDefined();
        expect(checkpoint.memoryHash).toBe(sha256HexSync(source.content));
        const inventory = yield* prepareContextMaintenanceInventory(fixture.config, 'threadnote', 256);
        expect(inventory.complete).toBe(true);
        expect(inventory.hashes.get(URI)).toBe(sha256HexSync(raw));
        expect(first.projects[0]).toMatchObject({eligible: 1, checked: 1, checkedCitations: 0});
        expect(first.state).toBe('running');
        for (let replay = 0; replay < 2; replay++) {
          const again = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
          expect(again.projects[0]).toMatchObject({eligible: 1, checked: 1, checkedCitations: 0});
          expect(again.state).toBe('idle');
          expect(again.cases).toEqual(first.cases);
          expect(again.receipts).toEqual(first.receipts);
          expect(JSON.parse(yield* fixture.fs.readFileString(stateFile)).checkpoints['tn_source:0']).toEqual(
            checkpoint,
          );
          expect(yield* fixture.fs.readFileString(fixture.source)).toBe(raw);
          expect(parseMemoryDocument(URI, raw)?.body).toBe(source.body);
        }
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('bounds batches across interleaved projects and binds shared receipts to each exact canonical subject', () => {
    const citation = {
      version: 1,
      repositoryId: 'b'.repeat(64),
      repositoryIdentityKind: 'local',
      sourceCommit: 'c'.repeat(40),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
      extractorSet: 'test',
      path: 'source.ts',
      fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
      target: {kind: 'file'},
    } as const;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            project: fc.constantFrom('one', 'two', 'three'),
            commit: fc.integer({min: 0, max: 40}),
            anchors: fc.integer({min: 1, max: 8}),
          }),
          {minLength: 1, maxLength: 100},
        ),
        inputs => {
          const tasks = inputs.map((input, index) => ({
            project: input.project,
            record: record(`subject-${index}`, {
              schemaVersion: 5,
              project: input.project,
              codeCitations: Array.from({length: input.anchors}, (_, anchor) =>
                createMemoryCodeCitation({
                  ...citation,
                  path: `path-${anchor}.ts`,
                  sourceCommit: input.commit.toString(16).padStart(40, '0'),
                }),
              ),
            }),
            chunk: 0,
            key: String(index),
          }));
          const groups = planMaintenanceWorkerBatches(tasks);
          expect(
            groups
              .flat()
              .map(task => task.key)
              .sort(),
          ).toEqual(tasks.map(task => task.key).sort());
          for (const group of groups) {
            expect(new Set(group.map(task => task.project)).size).toBe(1);
            const citations = group.flatMap(task => task.record.metadata.codeCitations!);
            expect(citations.length).toBeLessThanOrEqual(16);
            expect(
              new Set(citations.map(item => `${item.repositoryId}:${item.sourceCommit}`)).size,
            ).toBeLessThanOrEqual(8);
          }
          const subject = tasks[0].record;
          const evidence = {
            project: tasks[0].project,
            cwd: '/repo',
            records: [subject],
            observation: {
              association: {epoch: 'epoch', roots: [], bySelector: {}, sourceEpochs: {}},
              memoryGeneration: 'generation',
            },
            validations: [{uri: subject.uri, receipts: [], cacheHits: 0}],
          };
          expect(maintenanceWorkerRecordValidations(evidence, subject)).toHaveLength(1);
          expect(
            maintenanceWorkerRecordValidations(evidence, {...subject, content: `${subject.content}\nChanged prose.`}),
          ).toEqual([]);
          expect(maintenanceWorkerRecordValidations(evidence, {...subject, uri: `${subject.uri}-other`})).toEqual([]);
          expect(maintenanceWorkerRecordValidations({...evidence, project: 'other'}, subject)).toEqual([]);
          expect(maintenanceWorkerRecordValidations({...evidence, observation: undefined}, subject)).toEqual([]);
        },
      ),
      {numRuns: 30},
    );
  });

  it('slices one logical anchor chunk across bounded selectors and refuses incompatible aggregate observations', () => {
    const citations = Array.from({length: 64}, (_, index) =>
      createMemoryCodeCitation({
        version: 1,
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: index.toString(16).padStart(40, '0'),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        extractorSet: 'test',
        path: `source-${index}.ts`,
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        target: {kind: 'file'},
      }),
    );
    const original = record('source');
    const subject = {...original, metadata: {...original.metadata, codeCitations: citations}};
    const groups = planMaintenanceWorkerBatches([{record: subject, project: 'threadnote', chunk: 0, key: 'logical:0'}]);
    expect(groups).toHaveLength(8);
    expect(groups.flat().map(task => [task.key, task.chunk])).toEqual(Array.from({length: 8}, () => ['logical:0', 0]));
    expect(groups.flatMap(group => group.flatMap(task => task.citationIds ?? []))).toEqual(
      citations.map(item => item.id),
    );
    const parts = groups.map(group => {
      const selected = citations.filter(citation => group[0].citationIds?.includes(citation.id));
      return {
        project: 'threadnote',
        cwd: '/repo',
        records: [{...subject, metadata: {...subject.metadata, codeCitations: selected}}],
        validations: [{uri: subject.uri, receipts: []}],
        observation: {
          sourceEpoch: 'source',
          memoryGeneration: 'memory',
          association: {
            epoch: 'part',
            roots: ['/repo'],
            sourceEpochs: {'/repo': 'source'},
            bySelector: Object.fromEntries(
              selected.map(citation => [`${citation.repositoryId}:${citation.sourceCommit}`, 'association']),
            ),
          },
        },
      };
    });
    const merged = parts.slice(1).reduce(mergeMaintenanceWorkerEvidence, parts[0]);
    expect(merged.records[0].metadata.codeCitations?.map(item => item.id)).toEqual(citations.map(item => item.id));
    expect(maintenanceWorkerRecordValidations(merged, subject)).toHaveLength(1);
    const advanced = {...parts[1], observation: {...parts[1].observation, memoryGeneration: 'unrelated-write'}};
    expect(
      maintenanceWorkerRecordValidations(mergeMaintenanceWorkerEvidence(parts[0], advanced), subject),
    ).toHaveLength(1);
    expect(
      mergeMaintenanceWorkerEvidence(parts[0], {...parts[1], records: [{...parts[1].records[0], content: 'changed'}]})
        .observation,
    ).toBeUndefined();
    expect(
      mergeMaintenanceWorkerEvidence(parts[0], {
        ...parts[1],
        observation: {
          ...parts[1].observation,
          association: {...parts[1].observation.association, sourceEpochs: {'/repo': 'changed'}},
        },
      }).observation,
    ).toBeUndefined();
  });

  it('restores prior support transitions and defers new ones without changing unrelated cases', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('citation', 'citation-coverage', 'current-support'),
        fc.constantFrom('needs-decision', 'retired', 'resolved', 'historical'),
        fc.boolean(),
        (family, disposition, retained) => {
          const subject = record('source');
          const original = updateMaintenanceCase(
            undefined,
            {
              project: 'threadnote',
              memoryId: 'tn_source',
              family,
              slot: 'anchor:original',
              evidenceRevision: 'prior',
              disposition,
              reason: 'prior-proof',
            },
            NOW,
          );
          const tentative = {...original, disposition: 'resolved' as const, reason: 'tentative-proof'};
          const unrelated = {...original, caseId: 'unrelated', memoryId: 'tn_unrelated'};
          const cases = new Map<string, typeof original>([
            [original.caseId, tentative],
            [unrelated.caseId, unrelated],
          ]);
          const checkpoints = {'tn_source:0': 'changed', 'tn_unrelated:0': 'retained'};
          invalidateMaintenanceWorkerBatch(
            {project: 'threadnote', cwd: '/repo', records: [subject], validations: []},
            cases,
            new Map<string, typeof original>(retained ? [[original.caseId, original]] : []),
            checkpoints,
          );
          if (retained) expect(cases.get(original.caseId)).toEqual(original);
          else
            expect(cases.get(original.caseId)).toMatchObject({
              disposition: 'waiting-evidence',
              reason: 'worker-evidence-changed',
            });
          expect(cases.get(unrelated.caseId)).toEqual(unrelated);
          expect(checkpoints).toEqual({'tn_unrelated:0': 'retained'});
        },
      ),
      {numRuns: 24},
    );
  });

  effectIt.effect('collects all fresh subjects in bounded groups and refuses oversized direct collection', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, source} = yield* makeCitationRepository(fixture);
      const subjects = [source];
      for (let index = 1; index < 17; index++) {
        const next = record(`subject-${index}`, {schemaVersion: 5, codeCitations: source.metadata.codeCitations});
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, `subject-${index}.md`), next.content);
        subjects.push(next);
      }
      const tasks = subjects.map((record, index) => ({record, project: 'threadnote', chunk: 0, key: String(index)}));
      const oversized = yield* collectMaintenanceWorkerBatch(fixture.config, tasks, repository);
      expect(oversized.observation).toBeUndefined();
      expect(oversized.validations).toEqual([]);
      const groups = planMaintenanceWorkerBatches(tasks);
      expect(groups.map(group => group.length)).toEqual([16, 1]);
      const evidence = yield* Effect.forEach(groups, group =>
        collectMaintenanceWorkerBatch(fixture.config, group, repository),
      );
      expect(evidence.every(batch => batch.observation !== undefined)).toBe(true);
      expect(evidence.flatMap(batch => batch.records).map(record => record.uri)).toEqual(
        subjects.map(record => record.uri),
      );
      expect(
        evidence
          .flatMap(batch => batch.validations)
          .map(validation => validation.uri)
          .sort(),
      ).toEqual(subjects.map(record => record.uri).sort());
      expect(evidence.flatMap(batch => batch.validations).flatMap(validation => validation.receipts)).toHaveLength(17);
      for (const subject of subjects) {
        const file = fixture.path.join(fixture.directory, subject.uri.split('/').at(-1)!);
        expect(yield* fixture.fs.readFileString(file)).toBe(subject.content);
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('validates an incident citation alongside a durable citation in bounded worker batches', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, source} = yield* makeCitationRepository(fixture);
      const {incident, file: incidentFile} = yield* makeIncidentCitationSubject(fixture, source);
      const tasks = [source, incident].map((record, index) => ({
        record,
        project: 'threadnote',
        chunk: 0,
        key: String(index),
      }));
      const groups = planMaintenanceWorkerBatches(tasks);
      const evidence = yield* Effect.forEach(groups, group =>
        collectMaintenanceWorkerBatch(fixture.config, group, repository),
      );
      expect(evidence.every(batch => batch.observation !== undefined)).toBe(true);
      const validations = evidence.flatMap(batch => batch.validations);
      expect(validations.map(validation => validation.uri).sort()).toEqual([source.uri, incident.uri].sort());
      expect(validations.flatMap(validation => validation.receipts)).toHaveLength(2);
      expect(validations.every(validation => validation.receipts[0]?.status === 'exact')).toBe(true);
      const health = yield* collectContextHealth(fixture.config, 'threadnote', [source, incident], repository, {
        includeCitationCoverageFindings: true,
      });
      expect(health.maintenance?.citationCoverage.eligible).toBe(2);
      expect(health.maintenance?.citationCoverage.currentVerified).toBe(2);
      expect(yield* fixture.fs.readFileString(incidentFile)).toBe(incident.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('upgrades an old incident checkpoint only after a requested receipt is consumed', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, source} = yield* makeCitationRepository(fixture);
      const {incident} = yield* makeIncidentCitationSubject(fixture, source);
      yield* fixture.fs.remove(fixture.source);
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      let initial = {} as {checkpoints?: Record<string, Record<string, unknown>>};
      for (let tick = 0; tick < 6; tick++) {
        yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
        initial = JSON.parse(yield* fixture.fs.readFileString(stateFile));
        if (initial.checkpoints?.['tn_incident:0'] !== undefined) break;
      }
      const previous = initial.checkpoints?.['tn_incident:0'];
      expect(previous?.checkedCitations).toBe(1);
      const {citationAdmissionVersion: _version, ...oldCheckpoint} = previous!;
      const caseInput = {
        project: 'threadnote',
        memoryId: 'tn_incident',
        family: 'citation-coverage',
        slot: '0',
        evidenceRevision: String(oldCheckpoint.revision),
        disposition: 'waiting-evidence' as const,
        reason: 'not-checked',
      };
      let oldCase = updateMaintenanceCase(undefined, caseInput, NOW);
      oldCase = updateMaintenanceCase(oldCase, caseInput, NOW);
      oldCase = updateMaintenanceCase(oldCase, caseInput, NOW);
      expect(oldCase).toMatchObject({attemptCount: 3, wake: {revision: oldCheckpoint.revision}});
      yield* fixture.fs.writeFileString(
        stateFile,
        JSON.stringify({
          ...initial,
          cases: [
            {
              ...oldCase,
              subjectUri: incident.uri,
              subjectContentHashes: [{uri: incident.uri, hash: sha256HexSync(incident.content)}],
            },
          ],
          checkpoints: {
            ...initial.checkpoints,
            'tn_incident:0': {...oldCheckpoint, checkedCitations: 0, retryAt: undefined},
          },
        }),
      );
      const evidenceFile = fixture.path.join(
        fixture.home,
        'context-maintenance',
        'evidence',
        `${sha256HexSync(`threadnote\0${repository}`)}.json`,
      );
      yield* fixture.fs.remove(evidenceFile);
      const foreground = yield* collectContextHealth(fixture.config, 'threadnote', [incident], repository);
      expect(foreground.maintenance?.citationCoverage.currentVerified).toBe(0);
      const request = (yield* readContextMaintenanceEvidenceRequests(fixture.config)).find(value =>
        value.uris.includes(incident.uri),
      );
      expect(request).toBeDefined();
      yield* runRequestedMaintenanceProjection(fixture.config, request!, [incident], [incident], true);
      let upgraded = yield* readContextMaintenanceStatus(fixture.config, 'threadnote');
      for (let tick = 0; tick < 6; tick++) {
        upgraded = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
        if (upgraded.cases.find(item => item.caseId === oldCase.caseId)?.disposition === 'resolved') break;
      }
      expect(upgraded.cases.find(item => item.caseId === oldCase.caseId)).toMatchObject({
        disposition: 'resolved',
        reason: 'postcondition-verified',
      });
      expect(upgraded.projects[0]?.checkedCitations).toBe(1);
      const saved = JSON.parse(yield* fixture.fs.readFileString(stateFile));
      expect(saved.checkpoints['tn_incident:0'].checkedCitations).toBe(1);
      const replay = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      expect(replay.cases.find(item => item.caseId === oldCase.caseId)?.attemptCount).toBe(
        upgraded.cases.find(item => item.caseId === oldCase.caseId)?.attemptCount,
      );
      expect(replay.projects[0]?.checkedCitations).toBe(1);
      expect(replay.generation).toBe(upgraded.generation);
      expect(JSON.parse(yield* fixture.fs.readFileString(stateFile)).checkpoints['tn_incident:0']).toEqual(
        saved.checkpoints['tn_incident:0'],
      );
      yield* fixture.fs.writeFileString(
        stateFile,
        JSON.stringify({
          ...saved,
          cases: [oldCase],
          checkpoints: {
            ...saved.checkpoints,
            'tn_incident:0': {...saved.checkpoints['tn_incident:0'], checkedCitations: 0, retryAt: undefined},
          },
        }),
      );
      yield* fixture.fs.remove(evidenceFile);
      const laterEvidence = yield* collectMaintenanceWorkerBatch(
        fixture.config,
        [{record: incident, project: 'threadnote', chunk: 0, key: 'tn_incident:0'}],
        repository,
      );
      expect(laterEvidence.validations[0]?.receipts[0]?.status).toBe('exact');
      let later = yield* readContextMaintenanceStatus(fixture.config, 'threadnote');
      for (let tick = 0; tick < 6; tick++) {
        later = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
        if (later.cases.find(item => item.caseId === oldCase.caseId)?.disposition === 'resolved') break;
      }
      expect(later.cases.find(item => item.caseId === oldCase.caseId)?.disposition).toBe('resolved');
      expect(later.projects[0]?.checkedCitations).toBe(1);
      const checked = yield* collectMaintenanceWorkerBatch(
        fixture.config,
        [{record: incident, project: 'threadnote', chunk: 0, key: 'tn_incident:0'}],
        repository,
      );
      const historical = yield* collectContextHealth(fixture.config, 'threadnote', [incident], repository, {
        evidenceMode: 'worker',
        workerEvidence: {
          ...checked,
          validations: checked.validations.map(validation => ({
            ...validation,
            receipts: validation.receipts.map(receipt => ({
              ...receipt,
              status: 'unknown' as const,
              coverage: 'incomplete' as const,
              provenance: 'historical-verified' as const,
              reason: 'repository-unavailable' as const,
            })),
          })),
        },
      });
      expect(historical.maintenance?.citationCoverage).toMatchObject({
        eligible: 1,
        checked: 0,
        historicalVerified: 1,
        currentVerified: 0,
      });
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('bounds every fresh anchor before unsupported or mixed subject association discovery', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, source} = yield* makeCitationRepository(fixture);
      const {id: _id, ...original} = source.metadata.codeCitations![0];
      for (const kind of ['incident', 'preference', 'mixed'] as const) {
        for (const boundary of ['anchors', 'selectors'] as const) {
          const count = boundary === 'anchors' ? 17 : 9;
          const subjects = [];
          for (let index = 0; index < count; index++) {
            const citation =
              boundary === 'selectors' && index > 0
                ? createMemoryCodeCitation({...original, sourceCommit: index.toString(16).padStart(40, '0')})
                : source.metadata.codeCitations![0];
            const topic = `admission-${kind}-${boundary}-${index}`;
            const next = record(topic, {
              kind: kind === 'mixed' ? (index === 0 ? 'durable' : 'incident') : kind,
              schemaVersion: 5,
              codeCitations: [citation],
            });
            yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, `${topic}.md`), next.content);
            subjects.push(next);
          }
          const tasks = subjects.map((record, index) => ({
            record,
            project: 'threadnote',
            chunk: 0,
            key: String(index),
          }));
          const oversized = yield* collectMaintenanceWorkerBatch(fixture.config, tasks, repository);
          expect(oversized.observation, `${kind}:${boundary}`).toBeUndefined();
          expect(oversized.validations).toEqual([]);
          expect(oversized.records.map(record => record.uri).sort()).toEqual(subjects.map(record => record.uri).sort());
          for (const subject of subjects)
            expect(
              yield* fixture.fs.readFileString(fixture.path.join(fixture.directory, subject.uri.split('/').at(-1)!)),
            ).toBe(subject.content);
        }
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('finishes every bounded part of the first legacy task before yielding its time budget', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, source} = yield* makeCitationRepository(fixture);
      const {id: _id, ...citation} = source.metadata.codeCitations![0];
      const legacy = {
        ...source,
        metadata: {
          ...source.metadata,
          codeCitations: [
            source.metadata.codeCitations![0],
            ...Array.from({length: 63}, (_, index) =>
              createMemoryCodeCitation({...citation, path: `legacy-${index}.ts`}),
            ),
          ],
        },
      };
      const clock = yield* Clock.Clock;
      let offset = 0;
      const slowClock: Clock.Clock = {
        ...clock,
        currentTimeMillis: Effect.map(clock.currentTimeMillis, time => time + offset),
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + offset,
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        sleep: duration => clock.sleep(duration),
      };
      const query = yield* CodeGraphQueryService;
      const slow = CodeGraphQueryService.of({
        ...query,
        status: (home, cwd, options) =>
          Effect.gen(function* () {
            const result = yield* query.status(home, cwd, options);
            offset = 6_000;
            return result;
          }),
      });
      const started = yield* Clock.currentTimeMillis;
      const prepared = yield* prepareMaintenanceWorkerBatches(
        fixture.config,
        [
          {record: legacy, project: 'threadnote', chunk: 0, key: 'first'},
          {record: source, project: 'threadnote', chunk: 0, key: 'tail'},
        ],
        new Map([['threadnote', repository]]),
        repository,
        started,
        NOW,
        {},
        new Map(),
      ).pipe(Effect.provideService(CodeGraphQueryService, slow), Effect.provideService(Clock.Clock, slowClock));
      expect(offset).toBe(6_000);
      expect(prepared.batches).toHaveLength(4);
      expect([...prepared.batchByTask.keys()]).toEqual(['first']);
      const evidence = prepared.batchByTask.get('first')!;
      expect(evidence.observation).toBeUndefined();
      // A fresh canonical read retains the authored citation cap; the synthetic
      // legacy planner metadata must not invent aggregate authority for its other anchors.
      expect(evidence.records[0].metadata.codeCitations).toEqual(source.metadata.codeCitations);
      expect(
        evidence.validations.flatMap(validation => validation.receipts).map(receipt => receipt.citationId),
      ).toEqual(source.metadata.codeCitations!.map(anchor => anchor.id));
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('consumes prepared work without spending its application budget on slow observations', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, source} = yield* makeCitationRepository(fixture);
      const relation = record('zz-relation', {
        relations: [{type: 'references', uri: URI.replace('source.md', 'missing.md')}],
      });
      const relationFile = fixture.path.join(fixture.directory, 'zz-relation.md');
      yield* fixture.fs.writeFileString(relationFile, relation.content);
      const clock = yield* Clock.Clock;
      let offset = 0;
      const slowClock: Clock.Clock = {
        ...clock,
        currentTimeMillis: Effect.map(clock.currentTimeMillis, time => time + offset),
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + offset,
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        sleep: duration => clock.sleep(duration),
      };
      const query = yield* CodeGraphQueryService;
      let observations = 0;
      const slow = CodeGraphQueryService.of({
        ...query,
        status: (home, cwd, options) =>
          Effect.gen(function* () {
            const result = yield* query.status(home, cwd, options);
            if (++observations === 1) offset += 6_000;
            return result;
          }),
      });
      const first = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 2}).pipe(
        Effect.provideService(CodeGraphQueryService, slow),
        Effect.provideService(Clock.Clock, slowClock),
      );
      expect(observations).toBeGreaterThan(0);
      expect(offset).toBe(6_000);
      expect(first.projects[0].checked).toBe(1);
      expect(first.projects[0].cursor).toBe(1);
      expect(first.receipts).toHaveLength(0);
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
      yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      const relationPass = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      expect(relationPass.receipts).toHaveLength(1);
      expect(
        parseMemoryDocument(relation.uri, yield* fixture.fs.readFileString(relationFile))!.metadata.relations ?? [],
      ).toEqual([]);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a source change after shared validation with a fresh final batch fence', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, file, source} = yield* makeCitationRepository(fixture);
      yield* fixture.fs.writeFileString(file, 'export const supported = false;\n');
      yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const before = yield* runContextMaintenance(fixture.config, {cwd: repository});
      const changed = before.cases.find(item => item.family === 'citation')!;
      expect(changed.disposition).toBe('needs-decision');
      yield* retireContextMaintenanceAnchor(fixture.config, {
        caseId: changed.caseId,
        evidenceRevision: changed.evidenceRevision,
        expectedContentHash: changed.subjectContentHashes![0].hash,
      });
      const retired = yield* readContextMaintenanceStatus(fixture.config, 'threadnote');
      const originalCase = retired.cases.find(item => item.caseId === changed.caseId)!;
      const originalSupport = retired.cases.find(item => item.family === 'current-support')!;
      expect(originalCase.disposition).toBe('retired');
      expect(originalSupport.disposition).toBe('needs-decision');
      yield* fixture.fs.writeFileString(file, 'export const supported = true;\n');
      yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      // The resumed semantic phase advances separately before the next citation phase.
      yield* runContextMaintenance(fixture.config, {cwd: repository});
      const query = yield* CodeGraphQueryService;
      let statusCalls = 0;
      const racing = CodeGraphQueryService.of({
        ...query,
        status: (home, cwd, options) =>
          Effect.gen(function* () {
            if (++statusCalls === 3) yield* fixture.fs.writeFileString(file, 'export const supported = false;\n');
            return yield* query.status(home, cwd, options);
          }),
      });
      const result = yield* runContextMaintenance(fixture.config, {cwd: repository}).pipe(
        Effect.provideService(CodeGraphQueryService, racing),
      );
      expect(statusCalls).toBeGreaterThanOrEqual(3);
      expect(result.projects[0].checked).toBe(0);
      expect(result.cases.find(item => item.caseId === originalCase.caseId)).toEqual(originalCase);
      expect(result.cases.find(item => item.caseId === originalSupport.caseId)).toEqual(originalSupport);
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
      const health = yield* collectContextHealth(fixture.config, 'threadnote', [source], repository);
      expect(health.maintenance?.citationCoverage.currentVerified).toBe(0);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('pages all retained cases and receipts with exact project-safe selectors and stale cursors', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const cases = Array.from({length: 73}, (_, index) =>
        updateMaintenanceCase(
          undefined,
          {
            project: 'threadnote',
            memoryId: `tn_${index}`,
            family: 'citation',
            slot: `anchor:${index}`,
            evidenceRevision: 'revision',
            disposition: 'historical',
            reason: 'preserved',
          },
          NOW,
        ),
      );
      const receipts = Array.from({length: 100}, (_, index) => ({
        receiptId: `receipt-${index}`,
        project: 'threadnote',
        subjectUri: URI,
        postHash: 'hash',
        timestamp: NOW,
        state: 'applied',
      }));
      const state = {
        version: 2,
        paused: false,
        state: 'idle',
        generation: 'corpus',
        projects: [],
        cases,
        receipts,
        checkpoints: {},
      };
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      yield* fixture.fs.makeDirectory(fixture.path.dirname(stateFile));
      yield* fixture.fs.writeFileString(stateFile, JSON.stringify(state));
      const initial = yield* readContextMaintenanceStatus(fixture.config, 'threadnote');
      expect(initial.cases).toHaveLength(30);
      expect(initial.receipts).toHaveLength(10);
      const foundCases = [...initial.cases];
      const foundReceipts = [...initial.receipts];
      let page = initial;
      while (page.page?.caseNextCursor !== undefined || page.page?.receiptNextCursor !== undefined) {
        const next = yield* readContextMaintenanceStatus(fixture.config, 'threadnote', {
          caseCursor: page.page.caseNextCursor,
          receiptCursor: page.page.receiptNextCursor,
        });
        if (page.page.caseNextCursor !== undefined) foundCases.push(...next.cases);
        if (page.page.receiptNextCursor !== undefined) foundReceipts.push(...next.receipts);
        page = {
          ...next,
          page: {
            ...next.page!,
            caseNextCursor: page.page.caseNextCursor === undefined ? undefined : next.page?.caseNextCursor,
            receiptNextCursor: page.page.receiptNextCursor === undefined ? undefined : next.page?.receiptNextCursor,
          },
        };
      }
      expect(new Set(foundCases.map(item => item.caseId)).size).toBe(73);
      expect(new Set(foundReceipts.map(item => item.receiptId)).size).toBe(100);
      expect(
        (yield* readContextMaintenanceStatus(fixture.config, 'threadnote', {
          caseId: cases[72].caseId,
          receiptId: 'receipt-0',
        })).receipts[0].receiptId,
      ).toBe('receipt-0');
      expect(
        Result.isFailure(
          yield* readContextMaintenanceStatus(fixture.config, 'other', {caseId: cases[0].caseId}).pipe(Effect.result),
        ),
      ).toBe(true);
      yield* fixture.fs.writeFileString(stateFile, JSON.stringify({...state, cases: cases.slice(1)}));
      expect(
        Result.isFailure(
          yield* readContextMaintenanceStatus(fixture.config, 'threadnote', {
            caseCursor: initial.page!.caseNextCursor,
          }).pipe(Effect.result),
        ),
      ).toBe(true);
    }).pipe(provideTestLayer(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );

  effectIt.effect('bounds a scoped one-record tick independently of two thousand unrelated cited records', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const unrelated = fixture.path.join(fixture.directory, '..', 'unrelated');
      yield* fixture.fs.makeDirectory(unrelated, {recursive: true});
      const citation = createMemoryCodeCitation({
        version: 1,
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        extractorSet: 'typescript-v1',
        path: 'unrelated.ts',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        target: {kind: 'file'},
      });
      yield* Effect.forEach(
        Array.from({length: 2_000}, (_, index) => `unrelated-${index}`),
        topic =>
          fixture.fs.writeFileString(
            fixture.path.join(unrelated, `${topic}.md`),
            record(topic, {project: 'unrelated', schemaVersion: 5, codeCitations: [citation]}).content,
          ),
        {concurrency: 64, discard: true},
      );
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      let reads = 0;
      let unrelatedReads = 0;
      const recording = FileSystem.FileSystem.of({
        ...fixture.fs,
        readFileString: (file, encoding) => {
          reads++;
          if (file.startsWith(unrelated)) unrelatedReads++;
          return fixture.fs.readFileString(file, encoding);
        },
      });
      const result = yield* runContextMaintenance(fixture.config, {
        cwd: fixture.home,
        project: 'threadnote',
        maxRecords: 1,
      }).pipe(Effect.provideService(FileSystem.FileSystem, recording));
      expect(result.projects[0].checked).toBe(1);
      expect(unrelatedReads).toBe(0);
      expect(reads).toBeLessThan(20);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rebuilds a malformed persisted inventory without treating it as authoritative absence', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      yield* prepareContextMaintenanceInventory(fixture.config, undefined, 256);
      const cache = fixture.path.join(fixture.home, 'context-maintenance', 'inventory', `${sha256HexSync('*')}.json`);
      yield* fixture.fs.writeFileString(
        cache,
        JSON.stringify({
          version: 1,
          complete: true,
          entries: null,
          queue: [],
          mutationGeneration: '',
          refreshCursor: 0,
        }),
      );
      const rebuilt = yield* prepareContextMaintenanceInventory(fixture.config, undefined, 1);
      expect(rebuilt.complete).toBe(false);
      expect(rebuilt.records).toHaveLength(0);
      expect(yield* fixture.fs.exists(fixture.source)).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps fresh changed-citation packets and no-op progress against a real ready graph', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const repository = fixture.path.join(fixture.home, 'repository');
      yield* fixture.fs.makeDirectory(repository);
      const file = fixture.path.join(repository, 'source.ts');
      yield* fixture.fs.writeFileString(file, 'export const supported = true;\n');
      yield* fixture.fs.writeFileString(
        fixture.path.join(repository, 'independent.ts'),
        'export const independent = true;\n',
      );
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
      yield* fixture.fs.writeFileString(
        fixture.config.manifestPath,
        `version: 1\nprojects:\n  - name: threadnote\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/threadnote\n    seed: []\n`,
      );
      const indexer = yield* CodeGraphIndexer;
      yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const citations = yield* captureMemoryCodeCitations(fixture.config, {
        callerCwd: repository,
        project: 'threadnote',
        refs: ['source.ts', 'independent.ts'],
      });
      const source = record('source', {schemaVersion: 5, codeCitations: citations});
      const raw = `${source.content}\n\n<!-- MEMORY_FIELDS\nversion: 1\n-->`;
      yield* fixture.fs.writeFileString(fixture.source, raw);
      yield* fixture.fs.writeFileString(file, 'export const supported = false;\n');
      yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const first = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      expect(first.projects[0]).toMatchObject({eligible: 1, checked: 1});
      expect(first.projects[0].checkedCitations).toBeGreaterThan(0);
      const changed = first.cases.find(item => item.family === 'citation' && item.disposition === 'needs-decision');
      expect(changed, JSON.stringify(first)).toBeDefined();
      const selectedPacket = yield* readContextMaintenancePacket(fixture.config, changed!.caseId, {
        citationId: citations[1].id,
        memoryUri: source.uri,
        startLine: 1,
        maximumLines: 1,
      });
      expect('evidence' in selectedPacket && selectedPacket.evidence?.citationId).toBe(citations[1].id);
      expect(
        Result.isFailure(
          yield* readContextMaintenancePacket(fixture.config, changed!.caseId, {
            citationId: 'tncc_unscoped',
            memoryUri: source.uri,
          }).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* readContextMaintenancePacket(fixture.config, changed!.caseId, {
            citationId: citations[1].id,
            memoryUri: source.uri.replace('source.md', 'outside.md'),
          }).pipe(Effect.result),
        ),
      ).toBe(true);
      const second = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      expect(second.projects[0]).toEqual(first.projects[0]);
      expect(second.cases.find(item => item.caseId === changed!.caseId)?.attemptCount).toBe(changed!.attemptCount);
      expect(second.lastProgressAt).toBe(first.lastProgressAt);
      expect((yield* readContextMaintenancePacket(fixture.config, changed!.caseId)).caseId).toBe(changed!.caseId);
      yield* fixture.fs.remove(file);
      yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const deletedStatus = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      const unavailable = deletedStatus.cases.find(
        item => item.family === 'citation' && item.citationId === citations[0].id,
      )!;
      expect(unavailable.reason).toBe('graph-incomplete');
      const input = {
        caseId: unavailable.caseId,
        evidenceRevision: unavailable.evidenceRevision,
        expectedContentHash: unavailable.subjectContentHashes![0].hash,
      };
      expect(
        Result.isFailure(
          yield* retireContextMaintenanceAnchor(fixture.config, {...input, expectedContentHash: 'stale'}).pipe(
            Effect.result,
          ),
        ),
      ).toBe(true);
      const deleted = unavailable;
      expect(yield* retireContextMaintenanceAnchor(fixture.config, input)).toMatchObject({
        status: 'retired',
        currentSupportRequired: true,
        canonicalProvenancePreserved: true,
        permanentLossProven: false,
      });
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(raw);
      expect(
        parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.codeCitations,
      ).toHaveLength(2);
      const retired = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      expect(retired.cases.find(item => item.caseId === deleted.caseId)?.disposition).toBe('retired');
      expect(
        retired.cases.filter(item => item.family === 'current-support' && item.disposition === 'needs-decision'),
      ).toHaveLength(1);
      expect(yield* retireContextMaintenanceAnchor(fixture.config, input)).toMatchObject({status: 'already-retired'});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not count an E0 citation checkpoint as current on an E1 semantic tick', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const repository = fixture.path.join(fixture.home, 'repository');
      yield* fixture.fs.makeDirectory(repository);
      yield* fixture.fs.writeFileString(fixture.path.join(repository, 'source.ts'), 'export const value = 1;\n');
      const independent = fixture.path.join(repository, 'independent.ts');
      yield* fixture.fs.writeFileString(independent, 'export const other = 1;\n');
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
      yield* fixture.fs.writeFileString(
        fixture.config.manifestPath,
        `version: 1\nprojects:\n  - name: threadnote\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/threadnote\n    seed: []\n`,
      );
      const indexer = yield* CodeGraphIndexer;
      yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const citations = yield* captureMemoryCodeCitations(fixture.config, {
        callerCwd: repository,
        project: 'threadnote',
        refs: ['source.ts'],
      });
      yield* fixture.fs.writeFileString(
        fixture.source,
        record('source', {schemaVersion: 5, codeCitations: citations}).content,
      );
      const first = yield* runContextMaintenance(fixture.config, {cwd: repository});
      expect(first.projects[0]).toMatchObject({checked: 1, checkedCitations: 1});
      expect(first.semanticCoverage?.[0].state).toBe('partial');
      yield* fixture.fs.writeFileString(independent, 'export const other = 2;\n');
      yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const semantic = yield* runContextMaintenance(fixture.config, {cwd: repository});
      expect(semantic.semanticCoverage?.[0].state).toBe('complete');
      expect(semantic.projects[0]).toMatchObject({checked: 0, checkedCitations: 0});
      expect(semantic.state).not.toBe('idle');
      const reconciled = yield* runContextMaintenance(fixture.config, {cwd: repository});
      expect(reconciled.projects[0]).toMatchObject({checked: 1, checkedCitations: 1});
      expect(reconciled.state).toBe('idle');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('projects requested evidence in the caller worktree and retires a proven deleted URI', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const repository = fixture.path.join(fixture.home, 'repository');
      const linked = fixture.path.join(fixture.home, 'linked');
      yield* fixture.fs.makeDirectory(repository);
      yield* fixture.fs.writeFileString(fixture.path.join(repository, 'source.ts'), 'export const value = 1;\n');
      yield* fixture.fs.writeFileString(fixture.path.join(repository, 'independent.ts'), 'export const other = 1;\n');
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
      yield* git(['worktree', 'add', '--quiet', '--detach', linked]);
      yield* fixture.fs.writeFileString(fixture.path.join(linked, 'independent.ts'), 'export const other = 2;\n');
      yield* fixture.fs.writeFileString(
        fixture.config.manifestPath,
        `version: 1\nprojects:\n  - name: threadnote\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/threadnote\n    seed: []\n`,
      );
      const indexer = yield* CodeGraphIndexer;
      yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      yield* indexer.index({cwd: linked, threadnoteHome: fixture.home, ensureVectors: false});
      const citations = yield* captureMemoryCodeCitations(fixture.config, {
        callerCwd: repository,
        project: 'threadnote',
        refs: ['source.ts'],
      });
      const source = record('source', {schemaVersion: 5, codeCitations: citations}, 'Source claim.');
      const missing = record('missing', {schemaVersion: 5, codeCitations: citations}, 'Other claim.');
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const missingFile = fixture.path.join(fixture.directory, 'missing.md');
      yield* fixture.fs.writeFileString(missingFile, missing.content);
      yield* collectContextHealth(fixture.config, 'threadnote', [source, missing], linked);
      const requested = () => readContextMaintenanceEvidenceRequests(fixture.config);
      expect((yield* requested())[0]).toMatchObject({
        project: 'threadnote',
        cwd: linked,
        uris: [source.uri, missing.uri],
      });
      yield* fixture.fs.remove(missingFile);
      yield* runContextMaintenance(fixture.config, {cwd: repository});
      expect((yield* requested())[0]?.uris).toContain(source.uri);
      yield* runContextMaintenance(fixture.config, {cwd: repository});
      yield* runContextMaintenance(fixture.config, {cwd: repository});
      const requestedFile = fixture.path.join(
        fixture.home,
        'context-maintenance',
        'evidence',
        `${sha256HexSync(`threadnote\0${linked}`)}.json`,
      );
      const projection = JSON.parse(yield* fixture.fs.readFileString(requestedFile)) as {
        entries: Array<{uri: string; receipts: Array<{citationId: string}>}>;
      };
      expect(yield* requested()).toEqual([]);
      expect(
        projection.entries.find(entry => entry.uri === source.uri)?.receipts.map(receipt => receipt.citationId),
      ).toEqual(citations.map(citation => citation.id));
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains and defers an unprovable requested URI after completing its sibling', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* TestClock.setTime(Date.parse(NOW));
      const citation = createMemoryCodeCitation({
        extractorSet: 'typescript-v1',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        path: 'source.ts',
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        target: {kind: 'file'},
        version: 1,
      });
      const source = record('source', {schemaVersion: 5, codeCitations: [citation]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* collectContextHealth(fixture.config, 'threadnote', [source], fixture.home);
      const pendingFile = fixture.path.join(
        fixture.home,
        'context-maintenance',
        'evidence',
        `${sha256HexSync(`threadnote\0${fixture.home}`)}.json.pending`,
      );
      const pending = JSON.parse(yield* fixture.fs.readFileString(pendingFile)) as {uris: string[]};
      const unprovable = 'threadnote://unreadable/subject';
      yield* fixture.fs.writeFileString(pendingFile, JSON.stringify({...pending, uris: [...pending.uris, unprovable]}));
      for (let tick = 0; tick < 3; tick++) yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const retained = (yield* readContextMaintenanceEvidenceRequests(fixture.config))[0];
      expect(retained.uris).toEqual([unprovable]);
      expect(Date.parse(retained.deferredUntil?.[unprovable] ?? '')).toBeGreaterThan(Date.parse(NOW));
      for (let tick = 0; tick < 3; tick++) yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect((yield* readContextMaintenanceEvidenceRequests(fixture.config))[0]).toEqual(retained);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('reaches the last foreground-requested page without another foreground call', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citation = createMemoryCodeCitation({
        extractorSet: 'typescript-v1',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        path: 'source.ts',
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        target: {kind: 'file'},
        version: 1,
      });
      const requested = Array.from({length: 101}, (_, index) =>
        record(`requested-${String(index).padStart(3, '0')}`, {schemaVersion: 5, codeCitations: [citation]}),
      );
      const last = requested.at(-1)!;
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, `${last.metadata.topic}.md`),
        last.content,
      );
      yield* collectContextHealth(fixture.config, 'threadnote', requested, fixture.home);
      const pages = yield* readContextMaintenanceEvidenceRequests(fixture.config);
      expect(pages.flatMap(page => page.uris)).toHaveLength(101);
      const laterPage = pages.find(page => page.uris.includes(last.uri))!;
      expect(laterPage.page).toBe(1);
      for (let tick = 0; tick < 8; tick++) yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const pending = yield* readContextMaintenanceEvidenceRequests(fixture.config);
      expect(pending.flatMap(page => page.uris)).not.toContain(last.uri);
      const projectionFile = fixture.path.join(
        fixture.home,
        'context-maintenance',
        'evidence',
        `${sha256HexSync(`threadnote\0${fixture.home}`)}.json`,
      );
      const projection = JSON.parse(yield* fixture.fs.readFileString(projectionFile)) as {
        entries: Array<{uri: string}>;
      };
      expect(projection.entries.some(entry => entry.uri === last.uri)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('discovers a scoped request beyond 64 other-project files without claiming idle', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      const directory = fixture.path.join(fixture.home, 'context-maintenance', 'evidence');
      yield* fixture.fs.makeDirectory(directory, {recursive: true});
      const target = Array.from({length: 256}, (_, index) => fixture.path.join(fixture.home, `target-${index}`)).find(
        cwd => sha256HexSync(`threadnote\0${cwd}`).startsWith('f'),
      );
      if (target === undefined) return yield* Effect.die(new Error('Missing bounded target root.'));
      const targetHash = sha256HexSync(`threadnote\0${target}`);
      const others = Array.from({length: 512}, (_, index) => fixture.path.join(fixture.home, `other-${index}`))
        .filter(cwd => sha256HexSync(`other\0${cwd}`) < targetHash)
        .slice(0, 64);
      expect(others).toHaveLength(64);
      const uri = 'threadnote://unreadable/subject';
      const writeRequest = (project: string, cwd: string) =>
        fixture.fs.writeFileString(
          fixture.path.join(directory, `${sha256HexSync(`${project}\0${cwd}`)}.json.pending`),
          JSON.stringify({project, cwd, uris: [uri], policy: 'health-receipts-v1:validator-1'}),
        );
      for (const cwd of others) yield* writeRequest('other', cwd);
      yield* writeRequest('threadnote', target);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, project: 'threadnote'});
      expect(first.state).not.toBe('idle');
      let second = first;
      for (let tick = 0; tick < 4; tick++)
        second = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, project: 'threadnote'});
      expect(second.state).not.toBe('idle');
      const discovered = (yield* readContextMaintenanceEvidenceRequests(fixture.config)).find(
        request => request.cwd === target,
      );
      // The public reader itself is bounded to the first 64 files.
      expect(discovered).toBeUndefined();
      const targetFile = fixture.path.join(directory, `${targetHash}.json.pending`);
      const pending = JSON.parse(yield* fixture.fs.readFileString(targetFile)) as {
        deferredUntil?: Record<string, string>;
      };
      expect(pending.deferredUntil?.[uri]).toBeDefined();
      yield* fixture.fs.remove(targetFile);
      let settled = second;
      for (let tick = 0; tick < 4 && settled.state !== 'idle'; tick++)
        settled = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, project: 'threadnote'});
      expect(settled.state).toBe('idle');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('executes eligible roots on both sides of a 128-file page boundary despite expiring backoff', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* TestClock.setTime(Date.parse(NOW));
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      const directory = fixture.path.join(fixture.home, 'context-maintenance', 'evidence');
      yield* fixture.fs.makeDirectory(directory, {recursive: true});
      const roots = Array.from({length: 128}, (_, index) => fixture.path.join(fixture.home, `root-${index}`))
        .map(cwd => ({cwd, file: `${sha256HexSync(`threadnote\0${cwd}`)}.json.pending`}))
        .sort((left, right) => left.file.localeCompare(right.file));
      const uri = 'threadnote://unreadable/subject';
      const eligible = [roots[0], roots[64], roots[65]];
      for (const [index, root] of roots.entries())
        yield* fixture.fs.writeFileString(
          fixture.path.join(directory, root.file),
          JSON.stringify({
            project: 'threadnote',
            cwd: root.cwd,
            uris: [uri],
            policy: 'health-receipts-v1:validator-1',
            ...(index === 0 || index === 64 || index === 65
              ? {}
              : {deferredUntil: {[uri]: '2099-01-01T00:00:00.000Z'}}),
          }),
        );
      for (let tick = 0; tick < 10; tick++) {
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home, project: 'threadnote'});
        yield* TestClock.adjust('121 seconds');
      }
      for (const root of eligible) {
        const pending = JSON.parse(yield* fixture.fs.readFileString(fixture.path.join(directory, root.file))) as {
          deferredUntil?: Record<string, string>;
        };
        expect(Date.parse(pending.deferredUntil?.[uri] ?? '')).toBeGreaterThan(Date.parse(NOW));
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('discovers the eligible page beyond 64 deferred pages of the same requested root', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* TestClock.setTime(Date.parse(NOW));
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      const directory = fixture.path.join(fixture.home, 'context-maintenance', 'evidence');
      yield* fixture.fs.makeDirectory(directory, {recursive: true});
      const cwd = fixture.path.join(fixture.home, 'requested-root');
      const hash = sha256HexSync(`threadnote\0${cwd}`);
      const uri = 'threadnote://unreadable/subject';
      for (let page = 1; page <= 65; page++)
        yield* fixture.fs.writeFileString(
          fixture.path.join(directory, `${hash}.${String(page).padStart(6, '0')}.json.pending`),
          JSON.stringify({
            project: 'threadnote',
            cwd,
            page,
            uris: [uri],
            policy: 'health-receipts-v1:validator-1',
            ...(page < 65 ? {deferredUntil: {[uri]: '2099-01-01T00:00:00.000Z'}} : {}),
          }),
        );
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, project: 'threadnote'});
      expect(first.state).not.toBe('idle');
      for (let tick = 0; tick < 5; tick++)
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home, project: 'threadnote'});
      const last = JSON.parse(
        yield* fixture.fs.readFileString(fixture.path.join(directory, `${hash}.000065.json.pending`)),
      ) as {deferredUntil?: Record<string, string>};
      expect(Date.parse(last.deferredUntil?.[uri] ?? '')).toBeGreaterThan(Date.parse(NOW));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('revisits unchanged records at future review and validity deadlines', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* TestClock.setTime(Date.parse('2040-01-01T00:00:00.000Z'));
      const source = record('source', {reviewAfter: '2040-01-02T00:00:00.000Z', validTo: '2040-01-04T00:00:00.000Z'});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      expect((yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).counts?.decisionMemories).toBe(0);
      yield* TestClock.adjust('2 days');
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const overdue = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(overdue.cases.find(item => item.family === 'review-overdue')?.disposition, JSON.stringify(overdue)).toBe(
        'needs-decision',
      );
      yield* TestClock.adjust('2 days');
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect((yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).receipts).toHaveLength(1);
      expect(yield* fixture.fs.exists(fixture.source)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains revision-bound candidate decisions with and without canonical target records', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const review = yield* buildCandidateReview(
        {
          project: 'threadnote',
          topic: 'candidate-work',
          sourceAgentClient: 'test',
          task: 'Review current claim',
          outcome: 'Pending review',
          evidence: ['apps/threadnote/src/memory/context/maintenance.ts'],
          decisions: ['Use explicit reviewed evidence.'],
        },
        [],
        DateTime.toDateUtc(DateTime.makeUnsafe(NOW)),
      );
      const candidates = [
        {
          ...review.candidates[0],
          comparison: 'contradiction' as const,
          recommendation: 'manual_review' as const,
          targetUri: URI,
        },
        {
          ...review.candidates[0],
          candidateId: `${review.candidates[0].candidateId.slice(0, -1)}a`,
          comparison: 'possible_duplicate' as const,
          recommendation: 'manual_review' as const,
        },
      ];
      const pending = {...review, candidates};
      yield* saveCandidateReview(fixture.home, pending);
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const cases = first.cases.filter(item => item.family === 'candidate');
      expect(cases).toHaveLength(2);
      expect(cases.every(item => item.disposition === 'needs-decision')).toBe(true);
      for (const item of cases) {
        const packet = yield* readContextMaintenancePacket(fixture.config, item.caseId);
        expect('reviewInbox' in packet && packet.reviewInbox?.reviewId).toBe(review.reviewId);
      }
      const resolved = candidateReviewWithState(pending, candidates[0].candidateId, 'rejected');
      yield* saveCandidateReview(fixture.home, resolved);
      const stale = yield* readContextMaintenancePacket(fixture.config, cases[0].caseId).pipe(Effect.result);
      expect(Result.isFailure(stale)).toBe(true);
      const second = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(second.cases.find(item => item.slot === candidates[0].candidateId)?.disposition).toBe('resolved');
      expect(second.cases.find(item => item.slot === candidates[1].candidateId)?.disposition).toBe('needs-decision');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves exact duplicates targeted by active URI or identity dependencies', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source');
      const copyUri = URI.replace('source.md', 'copy.md');
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'copy.md'), source.content);
      for (const [topic, uri] of [
        ['uri-dependent', copyUri],
        ['alias-dependent', 'threadnote://memory/tn_source'],
      ] as const)
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${topic}.md`),
          record(topic, {relations: [{type: 'depends_on', uri}]}, `${topic} claim.`).content,
        );
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(result.receipts).toHaveLength(0);
      expect(yield* fixture.fs.exists(fixture.path.join(fixture.directory, 'copy.md'))).toBe(true);
      expect(yield* fixture.fs.exists(fixture.source)).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('rejects a duplicate dependency introduced after preparation before the locked archive', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source');
      const copyFile = fixture.path.join(fixture.directory, 'copy.md');
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(copyFile, source.content);
      let injected = false;
      const racedFs = {
        ...fixture.fs,
        writeFileString: (...args: Parameters<typeof fixture.fs.writeFileString>) =>
          Effect.gen(function* () {
            if (!injected && args[0].includes('context-health-repairs') && args[0].endsWith('.tmp')) {
              injected = true;
              const journal = JSON.parse(args[1]) as {proposal: {mutation: {subjectUri: string}}};
              yield* fixture.fs.writeFileString(
                fixture.path.join(fixture.directory, 'raced-dependent.md'),
                record(
                  'raced-dependent',
                  {relations: [{type: 'depends_on', uri: journal.proposal.mutation.subjectUri}]},
                  'New incoming dependency.',
                ).content,
              );
            }
            return yield* fixture.fs.writeFileString(...args);
          }),
      };
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1}).pipe(
        Effect.provideService(FileSystem.FileSystem, racedFs),
      );
      expect(injected).toBe(true);
      expect(result.receipts).toHaveLength(0);
      expect(yield* fixture.fs.exists(copyFile)).toBe(true);
      expect(yield* fixture.fs.exists(fixture.source)).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('skips all citation recovery I/O when repair preview has no citation candidates', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citation = createMemoryCodeCitation({
        version: 1,
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        extractorSet: 'typescript-v1',
        path: 'source.ts',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        target: {kind: 'file'},
      });
      const subjects = Array.from({length: 100}, (_, index) =>
        record(`cited-${index}`, {schemaVersion: 5, codeCitations: [citation]}),
      );
      const report = {
        ...buildContextHealthReport({
          project: 'threadnote',
          records: [],
          now: DateTime.toDateUtc(DateTime.makeUnsafe(NOW)),
        }),
        findings: [],
      };
      let reads = 0;
      const countedFs = {
        ...fixture.fs,
        readFileString: (...args: Parameters<typeof fixture.fs.readFileString>) => {
          reads += 1;
          return fixture.fs.readFileString(...args);
        },
      };
      const replacements = yield* captureCitationReplacements(
        fixture.config,
        'threadnote',
        fixture.home,
        subjects,
        report,
      ).pipe(Effect.provideService(FileSystem.FileSystem, countedFs));
      expect(replacements.size).toBe(0);
      expect(reads).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('admits every semantic subject pair in bounded windows without mutating the index', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 256}), size => {
        const records = Array.from({length: size}, (_, index) => index);
        const original = [...records];
        const first = selectMaintenanceSemanticPairBatch(records, 0);
        expect(first.totalBatches).toBe(maintenanceSemanticWindowCount(size));
        const windows = Array.from(
          {length: first.totalBatches},
          (_, cursor) => selectMaintenanceSemanticPairBatch(records, cursor).records,
        );
        expect(windows.every(window => window.length <= 128)).toBe(true);
        for (const left of records)
          for (const right of records)
            expect(windows.some(window => window.includes(left) && window.includes(right))).toBe(true);
        expect(records).toEqual(original);
      }),
      {numRuns: 20},
    );
  });

  it('alternates record and semantic phases and visits every pending project without mutating inputs', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 7}), {minLength: 1, maxLength: 8}), ids => {
        const projects = ids.map(id => `project-${id}`);
        const original = [...projects];
        let schedule: Parameters<typeof selectMaintenanceWorkPhase>[0];
        const selected: string[] = [];
        for (let tick = 0; tick < projects.length * 2; tick++) {
          const work = selectMaintenanceWorkPhase(schedule, projects, true);
          expect(work.phase).toBe(tick % 2 === 0 ? 'records' : 'semantic');
          if (work.project !== undefined) selected.push(work.project);
          schedule = work.next;
        }
        expect(new Set(selected)).toEqual(new Set(projects));
        expect(projects).toEqual(original);
      }),
      {numRuns: 50},
    );
  });

  it('fairly rotates bounded requested roots and URIs without changing caller lists', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 15}), {minLength: 1, maxLength: 12}), ids => {
        const roots = ids.map(id => `project-${id}\0/worktree-${id}`);
        const uris = ids.map(id => `threadnote://memory/${id}`);
        const rootInput = [...roots];
        const uriInput = [...uris];
        let schedule: Parameters<typeof selectMaintenanceWorkPhase>[0];
        let uriCursor: string | undefined;
        const visitedRoots = new Set<string>();
        const visitedUris = new Set<string>();
        for (let tick = 0; tick < roots.length * 3; tick++) {
          const work = selectMaintenanceWorkPhase(schedule, ['semantic'], true, roots);
          expect(work.phase).toBe(['records', 'semantic', 'requested'][tick % 3]);
          if (work.root !== undefined) visitedRoots.add(work.root);
          schedule = work.next;
          const selected = selectRequestedMaintenanceUris(uris, uriCursor, 4);
          expect(selected.length).toBeLessThanOrEqual(4);
          selected.forEach(uri => visitedUris.add(uri));
          uriCursor = selected.at(-1);
        }
        expect(visitedRoots).toEqual(new Set(roots));
        expect(visitedUris).toEqual(new Set(uris));
        expect(roots).toEqual(rootInput);
        expect(uris).toEqual(uriInput);
      }),
      {numRuns: 50},
    );
  });

  it('advances request discovery through every bounded page, including empty eligible pages', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 256}), total => {
        let discovery: ReturnType<typeof advanceContextMaintenanceEvidenceRequestDiscovery> | undefined;
        for (let offset = 0; offset < total; offset += 64) {
          const scanned = Math.min(64, total - offset);
          discovery = advanceContextMaintenanceEvidenceRequestDiscovery(
            discovery,
            {
              requests: [],
              files: [`file-${offset + scanned - 1}`],
              namesHash: 'unchanged',
              total,
              scanned,
              lastFile: `file-${offset + scanned - 1}`,
              unreadable: false,
            },
            'selected',
          );
          expect(discovery.scanned).toBe(Math.min(total, offset + scanned));
          expect(discovery.scopedPending).toBe(false);
        }
        expect(discovery?.scanned).toBe(total);
      }),
      {numRuns: 50},
    );
  });

  it('invalidates absence authority when a pinned request page changes scope', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.option(fc.constantFrom('A', 'B'), {nil: undefined}),
            fc.option(fc.constantFrom('A', 'B'), {nil: undefined}),
          )
          .filter(([before, after]) => before !== after),
        ([before, after]) => {
          const previous = {namesHash: 'same-files', scope: before, scanned: 1, lastFile: 'file', scopedPending: false};
          const page = {
            requests: [{project: after ?? 'B', cwd: '/worktree', uris: ['subject']}],
            files: ['file'],
            namesHash: 'same-files',
            total: 1,
            scanned: 1,
            lastFile: 'file',
            unreadable: false,
          };
          const pinned = advanceContextMaintenanceEvidenceRequestExecution(previous, page, after, true);
          expect(pinned?.scope).toBe(after);
          expect(pinned?.scanned).toBe(0);
          expect(pinned?.scopedPending).toBe(true);
          expect(pinned?.lastFile).toBe(previous.lastFile);
          expect(previous.scope).toBe(before);
        },
      ),
      {numRuns: 30},
    );
  });

  effectIt.effect('rejects a complete absence certificate from another project at the closing fence', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const previous = {namesHash: sha256HexSync(''), scope: 'A', scanned: 0, scopedPending: false};
      expect(yield* contextMaintenanceEvidenceDiscoveryPending(fixture.config, previous, 0, 'A')).toBe(false);
      expect(yield* contextMaintenanceEvidenceDiscoveryPending(fixture.config, previous, 0, 'B')).toBe(true);
      expect(yield* contextMaintenanceEvidenceDiscoveryPending(fixture.config, previous, 0)).toBe(true);
    }).pipe(provideTestLayer(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );

  it('visits eligible roots across rotating pages when record phases intervene', () => {
    fc.assert(
      fc.property(fc.integer({min: 65, max: 192}), total => {
        const files = Array.from({length: total}, (_, index) => {
          const request = {project: 'project', cwd: `/root-${index}`, uris: ['subject']};
          return {
            request,
            root: contextMaintenanceEvidenceRequestKey(request),
            file: contextMaintenanceEvidenceRequestFileName(request),
          };
        }).sort((left, right) => left.file.localeCompare(right.file));
        const eligible = new Set([files[0].root, files[Math.floor(total / 2)].root, files.at(-1)!.root]);
        const visited = new Set<string>();
        let discovery: ReturnType<typeof advanceContextMaintenanceEvidenceRequestDiscovery> | undefined;
        for (let tick = 0; tick < total * 4 && visited.size < eligible.size; tick++) {
          const start =
            discovery?.lastFile === undefined ? 0 : files.findIndex(item => item.file > discovery!.lastFile!);
          const rotated = [...files.slice(Math.max(0, start)), ...files.slice(0, Math.max(0, start))].slice(0, 64);
          const next = rotated.find(item => eligible.has(item.root));
          const executed = tick % 2 === 1 ? next?.root : undefined;
          if (executed !== undefined) visited.add(executed);
          discovery = advanceContextMaintenanceEvidenceRequestExecution(
            discovery,
            {
              requests: rotated.map(item => item.request),
              files: rotated.map(item => item.file),
              namesHash: 'stable',
              total,
              scanned: rotated.length,
              lastFile: rotated.at(-1)?.file,
              unreadable: false,
            },
            'project',
            next !== undefined,
            executed,
          );
        }
        expect(visited).toEqual(eligible);
      }),
      {numRuns: 40},
    );
  });

  it('consumes relation-bearing work alone through nonempty ordered prefixes', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), {minLength: 1, maxLength: 20}), flags => {
        const tasks = flags.map((hasRelation, index) => ({
          record: record(`relation-${index}`, hasRelation ? {relations: [{type: 'references', uri: URI}]} : {}),
          index,
        }));
        const original = [...tasks];
        let remaining = tasks;
        const visited: number[] = [];
        while (remaining.length > 0) {
          const selected = selectRelationBoundedMaintenanceWindow(remaining.slice(0, 4));
          expect(selected.length).toBeGreaterThan(0);
          expect(selected.length).toBeLessThanOrEqual(4);
          expect(selected).toEqual(remaining.slice(0, selected.length));
          if (selected.some(task => (task.record.metadata.relations?.length ?? 0) > 0))
            expect(selected).toHaveLength(1);
          visited.push(...selected.map(task => task.index));
          remaining = remaining.slice(selected.length);
        }
        expect(visited).toEqual(tasks.map(task => task.index));
        expect(tasks).toEqual(original);
      }),
      {numRuns: 50},
    );
  });

  effectIt.effect('schedules an inventoried relation-bearing record alone', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, 'a-relation.md'),
        record('a-relation', {relations: [{type: 'references', uri: URI.replace('source.md', 'z-independent.md')}]})
          .content,
      );
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, 'z-independent.md'),
        record('z-independent').content,
      );
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100});
      expect(first.projects[0]).toMatchObject({eligible: 2, checked: 1});
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100});
      const later = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100});
      expect(later.projects[0].checked).toBe(2);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('defers a newly added relation before admitting later selected records', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const firstFile = fixture.path.join(fixture.directory, 'a-first.md');
      const before = record('a-first');
      const after = record('a-first', {relations: [{type: 'references', uri: URI.replace('source.md', 'z-later.md')}]});
      yield* fixture.fs.writeFileString(firstFile, before.content);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'z-later.md'), record('z-later').content);
      let changed = false;
      const racingFs = FileSystem.FileSystem.of({
        ...fixture.fs,
        readFileString: (file, encoding) =>
          file !== firstFile || changed
            ? fixture.fs.readFileString(file, encoding)
            : Effect.gen(function* () {
                changed = true;
                yield* fixture.fs.writeFileString(firstFile, after.content);
                return yield* fixture.fs.readFileString(file, encoding);
              }),
      });
      const raced = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100}).pipe(
        Effect.provideService(FileSystem.FileSystem, racingFs),
      );
      expect(changed).toBe(true);
      expect(raced.projects[0]).toMatchObject({eligible: 2, checked: 0});
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100});
      const alone = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100});
      expect(alone.projects[0].checked).toBe(1);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('resumes old state and reopens semantic coverage when the durable corpus changes', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(first.semanticCoverage?.[0]).toMatchObject({state: 'partial', checkedBatches: 0, totalBatches: 1});
      expect(first.state).not.toBe('idle');

      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const oldState = JSON.parse(yield* fixture.fs.readFileString(stateFile)) as Record<string, unknown>;
      delete oldState.workSchedule;
      yield* fixture.fs.writeFileString(stateFile, JSON.stringify(oldState));
      const resumedRecords = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(resumedRecords.semanticCoverage?.[0].checkedBatches).toBe(0);
      const resumedSemantic = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(resumedSemantic.semanticCoverage?.[0]).toMatchObject({state: 'complete', checkedBatches: 1});

      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, 'new-subject.md'),
        record('new-subject').content,
      );
      const changed = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(changed.semanticCoverage?.[0]).toMatchObject({state: 'partial', checkedBatches: 0, totalBatches: 1});
      expect(changed.state).not.toBe('idle');
      const covered = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(covered.semanticCoverage?.[0]).toMatchObject({state: 'complete', checkedBatches: 1});
      expect('workSchedule' in covered).toBe(false);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it('requires personal target authority and preserves inactive historical relations', () => {
    const archived = record('archive', {status: 'archived', archivedFrom: URI.replace('source.md', 'old.md')});
    const source = record('source', {
      relations: [
        {type: 'depends_on', uri: URI.replace('source.md', 'missing.md')},
        {type: 'references', uri: archived.uri},
        {type: 'supersedes', uri: 'threadnote://memory/tn_unavailable'},
        {
          type: 'depends_on',
          uri: 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/unavailable.md',
        },
      ],
    });
    expect(safeRelationRemoval(source, [source, archived])).toEqual([
      {type: 'depends_on', uri: URI.replace('source.md', 'missing.md')},
    ]);
  });

  it('prunes every proven missing private relation type while preserving inactive historical links', () => {
    fc.assert(
      fc.property(fc.constantFrom('depends_on', 'references', 'related_to', 'evidence_for', 'supersedes'), type => {
        const relation = {
          type,
          uri: URI.replace('source.md', 'missing.md'),
        };
        const source = record('source', {relations: [relation]});
        expect(safeRelationRemoval(source, [source])).toEqual([relation]);
        expect(resolveMaintenanceRelationPolicy(source, relation, [source], false).state).toBe('unknown');
        expect(
          resolveMaintenanceRelationPolicy(source, {...relation, uri: 'threadnote://memory/tn_missing'}, [source])
            .state,
        ).toBe('unknown');
        const inactive = record('missing', {status: 'archived'});
        if (type !== 'depends_on') {
          expect(resolveMaintenanceRelationPolicy(source, relation, [source, inactive]).state).toBe('historical');
          expect(safeRelationRemoval(source, [source, inactive])).toEqual([]);
        }
      }),
      {numRuns: 25},
    );
  });

  effectIt.effect('prunes missing references while preserving existing inactive references', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const archived = record('archive', {status: 'archived'});
      const source = record('source', {
        relations: [
          {type: 'references', uri: URI.replace('source.md', 'missing.md')},
          {type: 'references', uri: archived.uri},
        ],
      });
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'archive.md'), archived.content);
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(result.receipts).toHaveLength(1);
      expect(parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.relations).toEqual([
        source.metadata.relations![1],
      ]);
      expect(result.cases.find(item => item.slot.endsWith('missing.md'))?.disposition).toBe('retired');
      expect(yield* fixture.fs.readFileString(fixture.path.join(fixture.directory, 'archive.md'))).toBe(
        archived.content,
      );
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses a rival successor committed by an ordinary writer before the account lock', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const old = record('old', {status: 'superseded'});
      const successor = record('successor', {relations: [{type: 'supersedes', uri: old.uri}]});
      const rival = record('rival', {relations: [{type: 'supersedes', uri: old.uri}]});
      const source = record('source', {relations: [{type: 'depends_on', uri: old.uri}]});
      for (const item of [source, old, successor])
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${item.metadata.topic}.md`),
          item.content,
        );
      const reachedWrite = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      const store = yield* ResourceStore;
      const pause = (uri: string) =>
        uri === source.uri
          ? Deferred.succeed(reachedWrite, undefined).pipe(Effect.andThen(Deferred.await(releaseWrite)))
          : Effect.void;
      const guarded = ResourceStore.of({
        ...store,
        write: (location, uri, content, options) =>
          pause(uri).pipe(Effect.andThen(store.write(location, uri, content, options))),
        writeChecked: (location, uri, content, options, check) =>
          pause(uri).pipe(Effect.andThen(store.writeChecked(location, uri, content, options, check))),
      });
      const worker = yield* runContextMaintenance(fixture.config, {cwd: fixture.home}).pipe(
        Effect.provideService(ResourceStore, guarded),
        Effect.forkChild({startImmediately: true}),
      );
      yield* Deferred.await(reachedWrite);
      yield* store.write({account: 'local', home: fixture.home, user: 'tester'}, rival.uri, rival.content, {
        mode: 'create',
      });
      yield* Deferred.succeed(releaseWrite, undefined);
      const result = yield* Fiber.join(worker);
      expect(result.receipts).toHaveLength(0);
      expect(result.cases.some(item => item.reason === 'relation-repair-conflict')).toBe(true);
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
      expect(yield* store.read({account: 'local', home: fixture.home, user: 'tester'}, rival.uri)).toBe(rival.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('undo refuses a target retired by an ordinary writer before the account lock', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const target = record('target');
      const source = record('source', {relations: [{type: 'references', uri: target.uri}]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const store = yield* ResourceStore;
      const location = {account: 'local', home: fixture.home, user: 'tester'};
      yield* store.write(location, target.uri, target.content, {mode: 'create'});
      const reachedWrite = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      const guarded = ResourceStore.of({
        ...store,
        writeChecked: (account, uri, content, options, check) =>
          Deferred.succeed(reachedWrite, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWrite)),
            Effect.andThen(store.writeChecked(account, uri, content, options, check)),
          ),
      });
      const undo = yield* undoContextMaintenance(fixture.config, first.receipts[0].receiptId).pipe(
        Effect.provideService(ResourceStore, guarded),
        Effect.forkChild({startImmediately: true}),
      );
      yield* Deferred.await(reachedWrite);
      yield* store.write(location, target.uri, record('target', {status: 'archived'}).content, {mode: 'upsert'});
      yield* Deferred.succeed(releaseWrite, undefined);
      expect(yield* Fiber.join(undo)).toMatchObject({status: 'conflict', reason: 'restored-proof-changed'});
      expect(
        parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.relations ?? [],
      ).toEqual([]);
      expect((yield* readContextMaintenanceStatus(fixture.config)).receipts[0].state).toBe('applied');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it('requires every bounded anchor chunk to prove the same complete canonical generation', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 130}), fc.integer({min: 0, max: 2}), (anchors, omitted) => {
        const subject = record('source');
        const citation = createMemoryCodeCitation({
          version: 1,
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'local',
          sourceCommit: 'c'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          extractorSet: 'typescript-v1',
          path: 'source.ts',
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          target: {kind: 'file'},
        });
        const chunked = {
          ...subject,
          metadata: {...subject.metadata, codeCitations: Array.from({length: anchors}, () => citation)},
        };
        const chunks = Math.ceil(anchors / 64);
        const checks = Object.fromEntries(
          Array.from({length: chunks}, (_, index) => [
            `tn_source:${index}`,
            {inventoryComplete: true, memoryHash: 'same-generation'},
          ]),
        );
        expect(maintenanceAnchorChunksComplete(chunked, checks, 'same-generation')).toBe(true);
        delete checks[`tn_source:${omitted % chunks}`];
        expect(maintenanceAnchorChunksComplete(chunked, checks, 'same-generation')).toBe(false);
        checks[`tn_source:${omitted % chunks}`] = {inventoryComplete: true, memoryHash: 'old-generation'};
        expect(maintenanceAnchorChunksComplete(chunked, checks, 'same-generation')).toBe(false);
        checks[`tn_source:${omitted % chunks}`] = {inventoryComplete: false, memoryHash: 'same-generation'};
        expect(maintenanceAnchorChunksComplete(chunked, checks, 'same-generation')).toBe(false);
      }),
      {numRuns: 30},
    );
  });

  it('prefilters exactly the cases that absent-anchor reconciliation would change', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({min: 0, max: 7}), {maxLength: 8}),
        fc.array(
          fc.record({
            family: fc.constantFrom('citation', 'current-support', 'citation-coverage', 'relation'),
            project: fc.constantFrom('threadnote', 'other'),
            memoryId: fc.constantFrom('tn_source', 'tn_other'),
            disposition: fc.constantFrom('waiting-evidence', 'needs-decision', 'resolved', 'retired'),
            slot: fc.constantFrom('present', 'missing', 'legacy-unresolved:0', '0', '1', '3', '-1', 'other'),
          }),
          {maxLength: 12},
        ),
        (indexes, inputs) => {
          const citations = indexes.map(index =>
            createMemoryCodeCitation({
              version: 1,
              repositoryId: 'b'.repeat(64),
              repositoryIdentityKind: 'local',
              sourceCommit: 'c'.repeat(40),
              sourceDirty: false,
              sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
              extractorSet: 'typescript-v1',
              path: `file-${index}.ts`,
              fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
              target: {kind: 'file'},
            }),
          );
          const subject = record('source', {schemaVersion: 5, codeCitations: citations});
          const cases = new Map(
            inputs.map((input, index) => {
              const slot =
                input.slot === 'present' && citations[0] ? contextHealthCitationCaseSlotV2(citations[0]) : input.slot;
              const item = updateMaintenanceCase(
                undefined,
                {
                  ...input,
                  slot,
                  citationId: undefined,
                  evidenceRevision: String(index),
                  reason: 'fixture',
                },
                NOW,
              );
              return [item.caseId, item] as const;
            }),
          );
          const before = JSON.stringify([...cases]);
          const predicted = hasAbsentMaintenanceAnchors(cases.values(), subject);
          expect(JSON.stringify([...cases])).toBe(before);
          reconcileAbsentMaintenanceAnchors(cases, subject, NOW);
          expect(predicted).toBe(JSON.stringify([...cases]) !== before);
        },
      ),
      {numRuns: 80},
    );
  });

  effectIt.effect('reconciles removed anchors, removed chunks and unprovable ordinals to match clean attention', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const clean = yield* makeFixture();
      const citations = Array.from({length: 8}, (_, index) =>
        createMemoryCodeCitation({
          version: 1,
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'local',
          sourceCommit: 'c'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          extractorSet: 'typescript-v1',
          path: `file-${index}.ts`,
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          target: {kind: 'file'},
        }),
      );
      const original = record('source', {schemaVersion: 5, codeCitations: citations});
      const current = record('source', {
        schemaVersion: 5,
        codeCitations: citations.filter((_, index) => index !== 0 && index !== 7),
      });
      const removed = [citations[0], citations[7]].map(citation => ({
        ...updateMaintenanceCase(
          undefined,
          {
            project: 'threadnote',
            memoryId: 'tn_source',
            family: 'citation',
            slot: contextHealthCitationCaseSlotV2(citation),
            citationId: citation.id,
            evidenceRevision: 'old',
            disposition: 'needs-decision',
            reason: 'citation-changed',
          },
          NOW,
        ),
        subjectContentHashes: [{uri: URI, hash: sha256HexSync(original.content)}],
      }));
      const legacy = {...removed[0], caseId: 'legacy-case', slot: 'anchor:1', citationId: undefined, attemptCount: 3};
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      yield* fixture.fs.makeDirectory(fixture.path.dirname(stateFile));
      yield* fixture.fs.writeFileString(
        stateFile,
        JSON.stringify({
          version: 2,
          paused: false,
          state: 'needs-decision',
          generation: '',
          projects: [],
          cases: [...removed, legacy, {...legacy, caseId: 'coverage-old', family: 'citation-coverage', slot: '1'}],
          receipts: [],
          checkpoints: {},
        }),
      );
      yield* fixture.fs.writeFileString(fixture.source, current.content);
      yield* clean.fs.writeFileString(clean.source, current.content);
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      for (let tick = 0; tick < 3; tick++) {
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        yield* runContextMaintenance(clean.config, {cwd: clean.home, maxRecords: 1});
      }
      const final = yield* readContextMaintenanceStatus(fixture.config, 'threadnote', {limit: 100});
      const fresh = yield* readContextMaintenanceStatus(clean.config, 'threadnote', {limit: 100});
      expect(final.cases.filter(item => item.reason === 'canonical-anchor-removed')).toHaveLength(3);
      expect(final.cases.find(item => item.slot.startsWith('legacy-unresolved:'))).toMatchObject({
        disposition: 'resolved',
        reason: 'legacy-anchor-lineage-unprovable',
        firstSeen: NOW,
        attemptCount: 3,
      });
      const attention = (status: typeof final) =>
        status.cases
          .filter(item => ['needs-decision', 'waiting-evidence'].includes(item.disposition))
          .map(item => [item.family, item.slot, item.reason])
          .sort();
      expect(attention(final)).toEqual(attention(fresh));
      expect(
        parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.codeCitations,
      ).toEqual(current.metadata.codeCitations);
      expect(
        final.cases
          .filter(item => item.reason === 'canonical-anchor-removed')
          .every(item => item.firstSeen === NOW && item.events.some(event => event.reason === 'citation-changed')),
      ).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not reread complete canonical subjects whose anchor cases cannot change', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citation = createMemoryCodeCitation({
        version: 1,
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        extractorSet: 'typescript-v1',
        path: 'source.ts',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        target: {kind: 'file'},
      });
      const subjects = Array.from({length: 64}, (_, index) =>
        record(`complete-${index}`, {schemaVersion: 5, codeCitations: [citation]}, `Unique body ${index}.`),
      );
      const cases = subjects.map(subject =>
        updateMaintenanceCase(
          undefined,
          {
            project: 'threadnote',
            memoryId: subject.metadata.memoryId!,
            family: 'citation',
            slot: contextHealthCitationCaseSlotV2(citation),
            citationId: citation.id,
            evidenceRevision: 'current',
            disposition: 'waiting-evidence',
            reason: 'repository-unavailable',
          },
          NOW,
        ),
      );
      const checkpoints = Object.fromEntries(
        subjects.map(subject => [
          `${subject.metadata.memoryId}:0`,
          {
            revision: 'current',
            memoryHash: sha256HexSync(canonicalMemoryDocumentContent(subject.content)),
            inventoryComplete: true,
            checkedAt: NOW,
            retryAt: '2099-01-01T00:00:00.000Z',
          },
        ]),
      );
      for (const subject of subjects) expect(hasAbsentMaintenanceAnchors(cases, subject)).toBe(false);
      const migrated = migrateMaintenanceCases(
        cases,
        subjects,
        new Map(subjects.map(subject => [subject.uri, sha256HexSync(subject.content)])),
      );
      for (const subject of subjects) expect(hasAbsentMaintenanceAnchors(migrated, subject)).toBe(false);
      for (const subject of subjects)
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
          subject.content,
        );
      const prepared = yield* prepareContextMaintenanceInventory(fixture.config, undefined, 1600);
      expect(prepared.records).toHaveLength(64);
      for (const subject of prepared.records) expect(hasAbsentMaintenanceAnchors(migrated, subject)).toBe(false);
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      yield* fixture.fs.makeDirectory(fixture.path.dirname(stateFile), {recursive: true});
      yield* fixture.fs.writeFileString(
        stateFile,
        JSON.stringify({
          version: 2,
          paused: false,
          state: 'running',
          generation: '',
          projects: [],
          cases,
          receipts: [],
          checkpoints,
        }),
      );
      let canonicalRereads = 0;
      const countedFs = FileSystem.FileSystem.of({
        ...fixture.fs,
        readFileString: (file, encoding) => {
          if (file.startsWith(fixture.directory) && file.endsWith('.md')) {
            canonicalRereads++;
          }
          return fixture.fs.readFileString(file, encoding);
        },
      });
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100}).pipe(
        Effect.provideService(FileSystem.FileSystem, countedFs),
      );
      expect(canonicalRereads).toBeLessThan(20);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'groups successor redirect and unusable dependency pruning under one journal while preserving references',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const old = record('old', {status: 'superseded'}, 'Historical claim.');
        const middle = record(
          'middle',
          {status: 'superseded', relations: [{type: 'supersedes', uri: old.uri}]},
          'Intermediate historical replacement.',
        );
        const successor = record(
          'successor',
          {relations: [{type: 'supersedes', uri: middle.uri}]},
          'Current replacement.',
        );
        const source = record('source', {
          relations: [
            {type: 'depends_on', uri: 'threadnote://memory/tn_old'},
            {type: 'references', uri: 'threadnote://memory/tn_old'},
            {type: 'depends_on', uri: URI.replace('source.md', 'missing.md')},
          ],
        });
        for (const item of [old, middle, successor, source])
          yield* fixture.fs.writeFileString(
            fixture.path.join(fixture.directory, `${item.metadata.topic}.md`),
            item.content,
          );
        const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(first.receipts).toHaveLength(1);
        const repaired = parseMemoryDocument(source.uri, yield* fixture.fs.readFileString(fixture.source))!;
        expect(repaired.body).toBe(source.body);
        expect(repaired.metadata.relations).toEqual([
          {type: 'depends_on', uri: 'threadnote://memory/tn_successor'},
          {type: 'references', uri: 'threadnote://memory/tn_old'},
        ]);
        expect(yield* undoContextMaintenance(fixture.config, first.receipts[0].receiptId)).toMatchObject({
          status: 'conflict',
          reason: 'restored-target-not-active',
        });
        expect((yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).receipts).toHaveLength(1);
        expect(yield* fixture.fs.readFileString(fixture.source)).toBe(repaired.content);
        yield* fixture.fs.writeFileString(fixture.source, source.content);
        let reintroduced = first;
        for (let tick = 0; tick < 6 && (yield* fixture.fs.readFileString(fixture.source)) !== repaired.content; tick++)
          reintroduced = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(yield* fixture.fs.readFileString(fixture.source)).toBe(repaired.content);
        expect(reintroduced.receipts).toHaveLength(1);
        expect(reintroduced.receipts[0].receiptId).toBe(first.receipts[0].receiptId);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it('redirects only a unique explicit active personal successor and preserves historical links', () => {
    const old = record('old', {status: 'superseded'});
    const dependency = {type: 'depends_on' as const, uri: 'threadnote://memory/tn_old'};
    const source = record('source', {relations: [dependency]});
    const successor = record('new', {relations: [{type: 'supersedes', uri: old.uri}]});
    expect(resolveMaintenanceRelationPolicy(source, dependency, [source, old, successor]).state).toBe('redirectable');
    expect(resolveMaintenanceRelationPolicy(source, dependency, [source, old]).state).toBe('prunable');
    expect(resolveMaintenanceRelationPolicy(source, {...dependency, type: 'references'}, [source, old]).state).toBe(
      'historical',
    );
    const rival = record('rival', {relations: [{type: 'supersedes', uri: old.uri}]});
    expect(resolveMaintenanceRelationPolicy(source, dependency, [source, old, successor, rival]).state).toBe(
      'ambiguous',
    );
    expect(resolveMaintenanceRelationPolicy(source, dependency, [source]).state).toBe('unknown');
    const intermediate = record('middle', {status: 'superseded', relations: [{type: 'supersedes', uri: old.uri}]});
    const final = record('final', {relations: [{type: 'supersedes', uri: intermediate.uri}]});
    expect(
      resolveMaintenanceRelationPolicy(source, dependency, [source, old, intermediate, final]).successor?.uri,
    ).toBe(final.uri);
    const cycle = record('old', {status: 'superseded', relations: [{type: 'supersedes', uri: intermediate.uri}]});
    expect(resolveMaintenanceRelationPolicy(source, dependency, [source, cycle, intermediate]).state).toBe('ambiguous');

    fc.assert(
      fc.property(fc.shuffledSubarray([source, old, successor], {minLength: 3, maxLength: 3}), corpus => {
        expect(resolveMaintenanceRelationPolicy(source, dependency, corpus).successor?.uri).toBe(successor.uri);
      }),
      {numRuns: 30},
    );
  });

  it('coalesces repository ambiguity into one stable decision while retaining every anchor', () => {
    const anchors = Array.from({length: 12}, (_, index) => ({
      ...updateMaintenanceCase(
        undefined,
        {
          project: 'threadnote',
          memoryId: `tn_subject${index}`,
          family: 'citation',
          slot: `anchor:${index}`,
          evidenceRevision: `revision${index}`,
          disposition: 'waiting-evidence',
          reason: 'repository-ambiguous',
        },
        NOW,
      ),
      repositoryId: 'repo',
      subjectContentHashes: [{uri: `${URI}${index}`, hash: `hash${index}`}],
    }));
    fc.assert(
      fc.property(fc.shuffledSubarray(anchors, {minLength: 12, maxLength: 12}), shuffled => {
        const cases = new Map(shuffled.map(item => [item.caseId, item]));
        reconcileRepositoryRecoveryCases(cases, NOW);
        const decisions = [...cases.values()].filter(item => item.disposition === 'needs-decision');
        expect(decisions).toHaveLength(1);
        expect(decisions[0].subjectContentHashes).toHaveLength(12);
        expect([...cases.values()].filter(item => item.family === 'citation')).toHaveLength(12);
        const before = structuredClone([...cases]);
        reconcileRepositoryRecoveryCases(cases, NOW);
        expect([...cases]).toEqual(before);
        expect(anchors.every(item => item.nextAttemptAt === undefined && item.wake !== undefined)).toBe(true);
      }),
      {numRuns: 30},
    );
  });

  it('keeps one logical case and bounded attempt history when reasons change', () => {
    let current = updateMaintenanceCase(
      undefined,
      {
        project: 'threadnote',
        memoryId: 'tn_subject',
        family: 'citation',
        slot: '0',
        evidenceRevision: 'revision',
        disposition: 'waiting-evidence',
        reason: 'not-ready',
      },
      NOW,
    );
    const id = current.caseId;
    for (let index = 0; index < 50; index++)
      current = updateMaintenanceCase(current, {...current, reason: `reason-${index}`}, NOW);
    expect(current.caseId).toBe(id);
    expect(current.events).toHaveLength(8);
    expect(current.attemptCount).toBe(51);
    expect(current.nextAttemptAt).toBeUndefined();
    expect(current.wake).toEqual({kind: 'evidence-generation', revision: 'revision'});
    expect(
      updateMaintenanceCase(current, {...current, evidenceRevision: 'new-revision'}, NOW).nextAttemptAt,
    ).toBeDefined();
  });

  it('preserves every useful relation and anchor before collapsing exact duplicates', () => {
    const subject = record('source', {relations: [{type: 'references', uri: 'threadnote://memory/tn_dependency'}]});
    expect(duplicateArchiveSafe(subject, record('copy'))).toBe(false);
    expect(duplicateArchiveSafe(subject, record('copy', {relations: subject.metadata.relations}))).toBe(true);
    expect(
      duplicateArchiveSafe(subject, record('copy', {relations: subject.metadata.relations}, 'Different claim.')),
    ).toBe(false);
  });

  it('round-robin work never starves a project and does not mutate the input', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: 0, max: 5}), {minLength: 1, maxLength: 100}), ids => {
        const work = ids.map((id, index) => ({project: `project-${id}`, index}));
        const original = structuredClone(work);
        const projects = new Set(work.map(item => item.project));
        const selected = selectFairMaintenanceWork(work, undefined, projects.size);
        expect(new Set(selected.map(item => item.project)).size).toBe(projects.size);
        expect(work).toEqual(original);
        expect(new Set(selectFairMaintenanceWork(work, undefined, work.length).map(item => item.index)).size).toBe(
          work.length,
        );
      }),
      {numRuns: 100},
    );
  });

  it('migrates early case identities idempotently and removes duplicate coverage cases', () => {
    const original = updateMaintenanceCase(
      undefined,
      {
        project: 'threadnote',
        memoryId: 'tn_source',
        family: 'citation',
        slot: '0',
        evidenceRevision: 'v1',
        disposition: 'waiting-evidence',
        reason: 'repository-unavailable',
      },
      NOW,
    );
    const coverage = {...original, family: 'citation-coverage', slot: '0', caseId: 'legacy-coverage'};
    const migrated = migrateMaintenanceCases([original, coverage]);
    expect(migrated).toHaveLength(2);
    expect(migrated[0].slot).toBe('0');
    expect(migrateMaintenanceCases(migrated)).toEqual(migrated);
    expect(
      migrateMaintenanceCases([
        {...original, family: 'review-overdue', slot: 'record', disposition: 'deferred-policy'},
      ])[0].disposition,
    ).toBe('needs-decision');
  });

  it('migrates an ordinal only with exact unchanged subject proof and never after a citation permutation', () => {
    const citations = ['first.ts', 'second.ts'].map(path =>
      createMemoryCodeCitation({
        version: 1,
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        extractorSet: 'typescript-v1',
        path,
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        target: {kind: 'file'},
      }),
    );
    const original = record('source', {schemaVersion: 5, codeCitations: citations});
    const legacy = {
      ...updateMaintenanceCase(
        undefined,
        {
          project: 'threadnote',
          memoryId: 'tn_source',
          family: 'citation',
          slot: 'anchor:0',
          evidenceRevision: 'legacy',
          disposition: 'waiting-evidence',
          reason: 'repository-unavailable',
        },
        NOW,
      ),
      subjectContentHashes: [{uri: original.uri, hash: sha256HexSync(original.content)}],
    };
    const migrated = migrateMaintenanceCases([legacy], [original]);
    expect(migrated[0].slot).toBe(`anchor:${citations[0].id}`);
    expect(migrated[0].firstSeen).toBe(legacy.firstSeen);
    expect(migrated[0].attemptCount).toBe(legacy.attemptCount);
    const newer = {
      ...migrated[0],
      firstSeen: '2026-10-03T15:01:00.000Z',
      lastChecked: '2026-10-03T15:02:00.000Z',
      attemptCount: 5,
    };
    const merged = migrateMaintenanceCases([legacy, newer], [original]);
    expect(merged).toHaveLength(1);
    expect(merged[0].firstSeen).toBe(legacy.firstSeen);
    expect(merged[0].attemptCount).toBe(5);

    const reordered = record('source', {schemaVersion: 5, codeCitations: [...citations].reverse()});
    expect(migrateMaintenanceCases([legacy], [reordered])[0].slot).toBe(`legacy-unresolved:${legacy.caseId}`);
    expect(migrateMaintenanceCases(migrated, [reordered])[0].slot).toBe(migrated[0].slot);
  });

  effectIt.effect('stores one unavailable anchor case matching core identity and a bounded packet', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citation = createMemoryCodeCitation({
        extractorSet: 'typescript-v1',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        path: 'source.ts',
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        target: {kind: 'file'},
        version: 1,
      });
      const source = record('source', {schemaVersion: 5, codeCitations: [citation]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const waiting = first.cases.filter(item => item.disposition === 'waiting-evidence');
      expect(waiting).toHaveLength(1);
      expect(waiting[0].repositoryId).toBe(citation.repositoryId);
      expect(waiting[0].reason).toBe('repository-unavailable');
      const report = yield* collectContextHealth(fixture.config, 'threadnote', [source], fixture.home, {
        includeCitationCoverageFindings: true,
      });
      expect(waiting[0].caseId).toBe(report.findings.find(item => item.category === 'citation-unknown')?.caseId);
      const packet = yield* readContextMaintenancePacket(fixture.config, waiting[0].caseId);
      expect(packet).toMatchObject({memoryUri: source.uri, evidenceRevision: waiting[0].evidenceRevision});
      const replay = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(replay.cases[0].attemptCount).toBe(waiting[0].attemptCount);
      expect(replay.projects[0].checkedCitations).toBe(0);
      yield* fixture.fs.writeFileString(fixture.source, `${source.content}\nChanged claim.`);
      const stalePacket = yield* readContextMaintenancePacket(fixture.config, waiting[0].caseId).pipe(Effect.result);
      expect(Result.isFailure(stalePacket) && stalePacket.failure.message).toContain('case is stale');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'acknowledges an unavailable requested projection without advancing the canonical retry deadline',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* TestClock.setTime(Date.parse(NOW));
        const citation = createMemoryCodeCitation({
          extractorSet: 'typescript-v1',
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          path: 'source.ts',
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'local',
          sourceCommit: 'c'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        });
        const source = record('source', {schemaVersion: 5, codeCitations: [citation]});
        yield* fixture.fs.writeFileString(fixture.source, source.content);
        const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        const waiting = first.cases.find(item => item.disposition === 'waiting-evidence')!;
        expect(waiting.nextAttemptAt).toBe('2026-10-03T15:02:00.000Z');
        const projectionFile = fixture.path.join(
          fixture.home,
          'context-maintenance',
          'evidence',
          `${sha256HexSync(`threadnote\0${fixture.home}`)}.json`,
        );
        const projection = yield* fixture.fs.readFileString(projectionFile);
        yield* TestClock.adjust('61 seconds');
        const foreground = yield* collectContextHealth(fixture.config, 'threadnote', [source], fixture.home);
        expect(foreground.maintenance?.citationCoverage.state).toBe('unavailable');
        expect(
          (yield* readContextMaintenanceEvidenceRequests(fixture.config)).flatMap(request => request.uris),
        ).toContain(source.uri);
        const beforeDeadline = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        expect(beforeDeadline.cases.find(item => item.caseId === waiting.caseId)).toMatchObject({
          disposition: 'waiting-evidence',
          attemptCount: waiting.attemptCount,
          nextAttemptAt: waiting.nextAttemptAt,
        });
        expect(beforeDeadline.lastProgressAt).toBe(first.lastProgressAt);
        expect(yield* fixture.fs.readFileString(projectionFile)).toBe(projection);
        expect(
          (yield* readContextMaintenanceEvidenceRequests(fixture.config)).flatMap(request => request.uris),
        ).toContain(source.uri);
        yield* TestClock.adjust('59 seconds');
        const requestedAttempt = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        expect(requestedAttempt.cases.find(item => item.caseId === waiting.caseId)?.attemptCount).toBe(
          waiting.attemptCount,
        );
        expect(yield* fixture.fs.readFileString(projectionFile)).not.toBe(projection);
        expect(
          (yield* readContextMaintenanceEvidenceRequests(fixture.config)).flatMap(request => request.uris),
        ).not.toContain(source.uri);
        const atDeadline = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        expect(atDeadline.cases.find(item => item.caseId === waiting.caseId)?.attemptCount).toBe(
          waiting.attemptCount + 1,
        );
        yield* TestClock.adjust('4 minutes');
        let exhausted = atDeadline;
        for (
          let tick = 0;
          tick < 4 && exhausted.cases.find(item => item.caseId === waiting.caseId)?.attemptCount !== 3;
          tick++
        )
          exhausted = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        const terminalWait = exhausted.cases.find(item => item.caseId === waiting.caseId)!;
        expect(terminalWait.attemptCount).toBe(3);
        expect(terminalWait.nextAttemptAt).toBeUndefined();
        expect(terminalWait.wake).toMatchObject({kind: 'evidence-generation'});
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('archives only explicit expiry and retains memory identity and historical edges', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {
        validTo: '2000-01-01T00:00:00.000Z',
        relations: [{type: 'references', uri: URI.replace('source.md', 'target.md')}],
      });
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, 'target.md'),
        record('target', {}, 'Independent target claim.').content,
      );
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(yield* fixture.fs.exists(fixture.source)).toBe(false);
      const archive = (yield* readMaintenanceMemoryRecords(fixture.config)).find(
        item => item.metadata.archivedFrom === source.uri,
      )!;
      expect(archive.metadata.memoryId).toBe(source.metadata.memoryId);
      expect(archive.metadata.relations).toEqual(source.metadata.relations);
      const receipt = first.receipts.find(item => item.subjectUri === source.uri)!;
      expect(yield* undoContextMaintenance(fixture.config, receipt.receiptId)).toMatchObject({
        status: 'conflict',
        reason: 'validity-policy-still-expired',
      });
      expect(
        (yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).receipts.filter(
          item => item.subjectUri === source.uri,
        ),
      ).toHaveLength(1);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('makes bounded progress through a 2k corpus and classifies overdue review as one decision', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.forEach(
        Array.from({length: 2_000}, (_, index) => `scale-${index}`),
        topic => fixture.fs.writeFileString(fixture.path.join(fixture.directory, `${topic}.md`), record(topic).content),
        {concurrency: 64, discard: true},
      );
      const source = record('000-source', {
        reviewAfter: '2000-01-01T00:00:00.000Z',
        relations: [{type: 'depends_on', uri: URI.replace('source.md', 'missing.md')}],
      });
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, '000-source.md'), source.content);
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(result.projects[0].checked).toBe(1);
      expect(result.receipts).toHaveLength(0);
      expect(result.preparation?.complete).toBe(false);
      expect(result.preparation?.incompleteReason).toBe('inventory-discovery-incomplete');
      expect(result.cases.some(item => item.reason === 'inventory-preparation-incomplete')).toBe(true);
      for (let index = 0; index < 10; index++)
        yield* prepareContextMaintenanceInventory(fixture.config, undefined, 256);
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      const prepared = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(prepared.receipts).toHaveLength(1);
      expect(result.cases.find(item => item.family === 'review-overdue')?.disposition).toBe('needs-decision');
      expect(result.counts?.decisionMemories).toBe(1);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps anchor identities and rechecks unchanged memory after source events', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citations = Array.from({length: 8}, (_, index) =>
        createMemoryCodeCitation({
          extractorSet: 'typescript-v1',
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          path: `source-${index}.ts`,
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'local',
          sourceCommit: 'c'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        }),
      );
      const source = record('source', {schemaVersion: 5, codeCitations: citations});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 2});
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const before = JSON.parse(yield* fixture.fs.readFileString(stateFile)) as {
        cases: Array<{caseId: string; slot: string; attemptCount: number; evidenceRevision: string}>;
      };
      const anchors = before.cases.filter(item => item.slot.startsWith('anchor:'));
      expect(anchors).toHaveLength(8);
      expect(new Set(anchors.map(item => item.caseId)).size).toBe(8);
      expect(anchors.some(item => item.slot === `anchor:${citations[7].id}`)).toBe(true);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.home, 'source-7.ts'), 'Source event.');
      const staleSourcePacket = yield* readContextMaintenancePacket(
        fixture.config,
        anchors.find(item => item.slot === `anchor:${citations[7].id}`)!.caseId,
      ).pipe(Effect.result);
      expect(Result.isFailure(staleSourcePacket) && staleSourcePacket.failure.message).toContain(
        'Source evidence changed',
      );
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 2});
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 2});
      const after = JSON.parse(yield* fixture.fs.readFileString(stateFile)) as typeof before;
      expect(after.cases.find(item => item.slot === `anchor:${citations[7].id}`)).toMatchObject({
        caseId: anchors.find(item => item.slot === `anchor:${citations[7].id}`)!.caseId,
        attemptCount: 1,
      });
      expect(after.cases.find(item => item.slot === `anchor:${citations[7].id}`)!.evidenceRevision).not.toBe(
        anchors.find(item => item.slot === `anchor:${citations[7].id}`)!.evidenceRevision,
      );
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'recovers an interrupted receipt and keeps successful undo from reapplying unchanged duplicate policy',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const source = record('source');
        yield* fixture.fs.writeFileString(fixture.source, source.content);
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'copy.md'), source.content);
        const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        const receipt = first.receipts[0];
        expect(receipt, JSON.stringify(first)).toBeDefined();
        const restoredFile = fixture.path.join(fixture.directory, receipt.subjectUri.split('/').at(-1)!);
        expect(yield* fixture.fs.exists(restoredFile)).toBe(false);
        const journalFile = fixture.path.join(
          fixture.home,
          'context-maintenance',
          'receipts',
          `${receipt.receiptId}.json`,
        );
        const journal = JSON.parse(yield* fixture.fs.readFileString(journalFile)) as {state: string};
        yield* fixture.fs.writeFileString(journalFile, JSON.stringify({...journal, state: 'applying'}));
        const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
        const state = JSON.parse(yield* fixture.fs.readFileString(stateFile)) as {receipts: unknown[]};
        yield* fixture.fs.writeFileString(stateFile, JSON.stringify({...state, receipts: []}));
        const recovered = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(recovered.receipts.find(item => item.receiptId === receipt.receiptId)?.state).toBe('applied');
        expect(yield* undoContextMaintenance(fixture.config, receipt.receiptId)).toMatchObject({status: 'undone'});
        expect(yield* undoContextMaintenance(fixture.config, receipt.receiptId)).toMatchObject({
          status: 'already-undone',
        });
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(yield* fixture.fs.exists(restoredFile)).toBe(true);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('discovers real paired semantic decisions matching Health and returns a current packet', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {}, '- Agents must load verified context before implementation.');
      const target = record('target', {}, '- Agents must not load verified context before implementation.');
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const targetFile = fixture.path.join(fixture.directory, 'target.md');
      yield* fixture.fs.writeFileString(targetFile, target.content);
      const health = yield* collectContextHealth(fixture.config, 'threadnote', [source, target], fixture.home);
      const semantic = health.findings.find(item => item.category === 'semantic-contradiction')!;
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const maintained = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(maintained.cases.find(item => item.caseId === semantic.caseId)?.disposition).toBe('needs-decision');
      expect(maintained.counts?.decisionMemories).toBe(2);
      const packet = yield* readContextMaintenancePacket(fixture.config, semantic.caseId!);
      expect('relatedMemories' in packet && packet.relatedMemories).toHaveLength(2);
      yield* fixture.fs.writeFileString(targetFile, record('target', {status: 'archived'}, target.body).content);
      expect(
        (yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).cases.find(
          item => item.caseId === semantic.caseId,
        )?.disposition,
      ).toBe('resolved');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps legacy URI semantic subjects active and rejects packets after either canonical edit', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record(
        'source',
        {schemaVersion: 1, memoryId: undefined},
        '- Agents must load verified context before implementation.',
      );
      const target = record(
        'target',
        {schemaVersion: 1, memoryId: undefined},
        '- Agents must not load verified context before implementation.',
      );
      const targetFile = fixture.path.join(fixture.directory, 'target.md');
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(targetFile, target.content);
      const health = yield* collectContextHealth(fixture.config, 'threadnote', [source, target], fixture.home);
      const caseId = health.findings.find(item => item.category === 'semantic-contradiction')!.caseId!;
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const maintained = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const semantic = maintained.cases.find(item => item.caseId === caseId)!;
      expect(semantic.disposition).toBe('needs-decision');
      expect(semantic.subjectContentHashes?.map(subject => subject.uri).sort()).toEqual(
        [source.uri, target.uri].sort(),
      );
      expect(maintained.counts?.decisionMemories).toBe(2);
      const packet = yield* readContextMaintenancePacket(fixture.config, caseId);
      expect('relatedMemories' in packet && packet.relatedMemories).toHaveLength(2);
      const replay = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(replay.cases.find(item => item.caseId === caseId)?.disposition).toBe('needs-decision');
      for (const [file, subject] of [
        [fixture.source, source],
        [targetFile, target],
      ] as const) {
        yield* fixture.fs.writeFileString(file, `${subject.content}\nIndependent edited prose.`);
        const stale = yield* readContextMaintenancePacket(fixture.config, caseId).pipe(Effect.result);
        expect(Result.isFailure(stale) && stale.failure.message).toContain('case is stale');
        yield* fixture.fs.writeFileString(file, subject.content);
        expect((yield* readContextMaintenancePacket(fixture.config, caseId)).caseId).toBe(caseId);
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('eventually discovers a semantic pair beyond the first 128 records with partial coverage', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('a-source', {}, '- Agents must load verified context before implementation.');
      const target = record('z-target', {}, '- Agents must not load verified context before implementation.');
      yield* Effect.forEach(
        [
          source,
          target,
          ...Array.from({length: 129}, (_, index) =>
            record(`m-${String(index).padStart(3, '0')}`, {}, 'Independent historical context.'),
          ),
        ],
        subject =>
          fixture.fs.writeFileString(
            fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
            subject.content,
          ),
      );
      for (let page = 0; page < 4; page++) yield* prepareContextMaintenanceInventory(fixture.config, undefined, 256);
      const health = yield* collectContextHealth(fixture.config, 'threadnote', [source, target], fixture.home);
      const caseId = health.findings.find(item => item.category === 'semantic-contradiction')!.caseId!;
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(first.semanticCoverage?.[0].state).toBe('partial');
      expect(first.cases.some(item => item.caseId === caseId)).toBe(false);
      for (let tick = 0; tick < 5; tick++)
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      const status = yield* readContextMaintenanceStatus(fixture.config);
      expect(status.cases.find(item => item.caseId === caseId)?.disposition).toBe('needs-decision');
      const packet = yield* readContextMaintenancePacket(fixture.config, caseId);
      expect('relatedMemories' in packet && packet.relatedMemories).toHaveLength(2);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs proven dangling relations once, persists pause/restart, and rejects unsafe undo', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {relations: [{type: 'depends_on', uri: URI.replace('source.md', 'missing.md')}]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(first.receipts).toHaveLength(1);
      expect(first.cases.some(item => item.disposition === 'retired')).toBe(true);
      expect(
        parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.relations ?? [],
      ).toEqual([]);
      const second = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(second.receipts).toHaveLength(1);
      const receipt = first.receipts[0];
      expect(yield* undoContextMaintenance(fixture.config, receipt.receiptId)).toMatchObject({
        status: 'conflict',
        reason: 'restored-target-not-active',
      });
      yield* setContextMaintenancePaused(fixture.config, true);
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      expect((yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).paused).toBe(true);
      expect((yield* readContextMaintenanceStatus(fixture.config)).paused).toBe(true);
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'reserved artifact bundles are not memories and maintenance preserves their bytes and incoming links',
    {body: fc.string({maxLength: 96})},
    ({body}) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const root = fixture.path.join(fixture.home, 'data', 'local', 'user', 'tester', 'memories');
        const relatives = [
          'agent-artifacts/skills/claude/review-pr/SKILL.md',
          'agent-artifacts/skills/claude/review-pr/references/guide.md',
          'agent-artifacts/commands/review.md',
          'agent-artifacts/packs/team/README.md',
          'agent-artifacts/procedures/check/PROCEDURE.md',
          'shared/default/agent-artifacts/skills/review/SKILL.md',
        ];
        const artifacts = relatives.map((relative, index) => ({
          file: fixture.path.join(root, relative),
          uri: `threadnote://user/tester/memories/${relative}`,
          // A reserved artifact remains tooling even if its text resembles a memory header.
          content: index === 3 ? record('artifact').content : `---\nname: synthetic-tool\n---\n${body}`,
        }));
        for (const artifact of artifacts) {
          yield* fixture.fs.makeDirectory(fixture.path.dirname(artifact.file), {recursive: true});
          yield* fixture.fs.writeFileString(artifact.file, artifact.content);
        }
        const relations = artifacts.map(artifact => ({type: 'depends_on' as const, uri: artifact.uri}));
        const source = record('source', {
          relations: [...relations, {type: 'depends_on', uri: URI.replace('source.md', 'missing.md')}],
        });
        yield* fixture.fs.writeFileString(fixture.source, source.content);
        const inventory = yield* prepareContextMaintenanceInventory(fixture.config, undefined, 100);
        expect(inventory.complete).toBe(true);
        expect(inventory.records.map(record => record.uri)).toEqual([URI]);
        expect(
          (yield* readMaintenanceMemoryRecords(fixture.config, {requireReadable: true})).map(record => record.uri),
        ).toEqual([URI]);
        const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(result.error).toBeUndefined();
        expect(result.receipts).toHaveLength(1);
        expect(parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.relations).toEqual(
          relations,
        );
        for (const artifact of artifacts)
          expect(yield* fixture.fs.readFileString(artifact.file)).toBe(artifact.content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 8, seed: 80511}},
  );

  for (const relative of ['durable/projects/threadnote/SKILL.md', 'durable/projects/threadnote/agent-artifacts/bad.md'])
    effectIt.effect(`an artifact-like name outside the reserved namespace still fails closed (${relative})`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.writeFileString(fixture.source, record('source').content);
        const file = fixture.path.join(fixture.home, 'data', 'local', 'user', 'tester', 'memories', relative);
        yield* fixture.fs.makeDirectory(fixture.path.dirname(file), {recursive: true});
        const content = '---\nname: synthetic-tool\n---\nNot a memory.';
        yield* fixture.fs.writeFileString(file, content);
        const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(result.error?.diagnostic?.category).toBe('invalid-header');
        expect(result.receipts).toHaveLength(0);
        expect(yield* fixture.fs.readFileString(file)).toBe(content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );

  effectIt.effect('preserves unreadable corpus records and never turns them into target absence', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {relations: [{type: 'depends_on', uri: URI.replace('source.md', 'missing.md')}]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'missing.md'), 'Malformed but present.');
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(result).toMatchObject({
        state: 'failed',
        error: {
          reason: 'memory-snapshot-unreadable',
          diagnostic: {
            version: 1,
            category: 'invalid-header',
            stage: 'record-read',
            memoryUri: URI.replace('source.md', 'missing.md'),
            retryable: false,
          },
        },
      });
      expect(JSON.stringify(result.error)).not.toContain('Malformed but present.');
      expect(renderContextMaintenanceStatus(result)).toContain('missing.md');
      expect(renderContextMaintenanceStatus(result)).toContain('backup');
      expect((yield* readContextMaintenanceStatus(fixture.config)).error).toEqual(result.error);
      expect(result.receipts).toHaveLength(0);
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
      const target = record('missing');
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'missing.md'), target.content);
      const recovered = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(recovered.error).toBeUndefined();
      expect(recovered.receipts).toHaveLength(0);
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  for (const persistent of [false, true])
    effectIt.effect(`retries a confirmed file race once and preserves authority (persistent=${persistent})`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const source = record('source');
        yield* fixture.fs.writeFileString(fixture.source, source.content);
        let opens = 0;
        const wrapped = FileSystem.FileSystem.of({
          ...fixture.fs,
          open: (file, options) => {
            if (file === fixture.source && (++opens === 1 || persistent))
              return Effect.fail(
                PlatformError.systemError({
                  _tag: 'NotFound',
                  module: 'FileSystem',
                  method: 'open',
                  description: 'Synthetic private error details must not be copied.',
                  pathOrDescriptor: '/synthetic/private/path',
                }),
              );
            return fixture.fs.open(file, options);
          },
        });
        const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home}).pipe(
          Effect.provideService(FileSystem.FileSystem, wrapped),
        );
        if (persistent) {
          expect(opens).toBe(2);
          expect(result).toMatchObject({
            state: 'failed',
            error: {diagnostic: {category: 'record-changed', retryable: true, memoryUri: URI}},
          });
          expect(JSON.stringify(result.error)).not.toContain('Synthetic private');
          expect(JSON.stringify(result.error)).not.toContain('/synthetic/private/path');
        } else {
          expect(opens).toBeGreaterThanOrEqual(2);
          expect(result.state).not.toBe('failed');
          expect(result.error).toBeUndefined();
        }
        expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );

  effectIt.effect('ignores ancillary shared documents while preserving their existence and personal authority', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const shared = fixture.path.join(
        fixture.home,
        'data',
        'local',
        'user',
        'tester',
        'memories',
        'shared',
        'default',
      );
      yield* fixture.fs.makeDirectory(shared, {recursive: true});
      yield* fixture.fs.writeFileString(
        fixture.path.join(shared, 'guide.md'),
        '---\ntitle: Guide\n---\nAncillary docs.',
      );
      const source = record('source', {
        relations: [
          {type: 'references', uri: 'threadnote://user/tester/memories/shared/default/guide.md'},
          {type: 'references', uri: 'threadnote://memory/tn_unknown_authority'},
          {type: 'depends_on', uri: URI.replace('source.md', 'missing.md')},
        ],
      });
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(result.state).toBe('needs-decision');
      expect(result.receipts).toHaveLength(1);
      expect(parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.relations).toEqual(
        source.metadata.relations!.slice(0, 2),
      );
      expect(yield* fixture.fs.exists(fixture.path.join(shared, 'guide.md'))).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('undo requires the exact post-repair CAS even after the target becomes readable', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {relations: [{type: 'depends_on', uri: URI.replace('source.md', 'missing.md')}]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'missing.md'), record('missing').content);
      yield* fixture.fs.writeFileString(fixture.source, record('source', {}, 'Changed after repair.').content);
      expect(yield* undoContextMaintenance(fixture.config, result.receipts[0].receiptId)).toMatchObject({
        status: 'conflict',
        reason: 'memory-changed',
      });
      const bad = yield* undoContextMaintenance(fixture.config, '../../invalid').pipe(Effect.result);
      expect(Result.isFailure(bad)).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});

function makeFixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'context-maintenance-'});
    const directory = path.join(
      home,
      'data',
      'local',
      'user',
      'tester',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    yield* fs.makeDirectory(directory, {recursive: true});
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: path.join(home, 'threadnote.json'),
      user: 'tester',
    };
    return {fs, path, home, directory, source: path.join(directory, 'source.md'), config};
  });
}

function makeCitationRepository(fixture: Effect.Success<ReturnType<typeof makeFixture>>) {
  return Effect.gen(function* () {
    const repositoryPath = fixture.path.join(fixture.home, 'repository');
    yield* fixture.fs.makeDirectory(repositoryPath);
    const repository = yield* fixture.fs.realPath(repositoryPath);
    const file = fixture.path.join(repository, 'source.ts');
    yield* fixture.fs.writeFileString(file, 'export const supported = true;\n');
    const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
    yield* git(['init', '--quiet']);
    yield* git(['add', '.']);
    yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'source']);
    yield* fixture.fs.writeFileString(
      fixture.config.manifestPath,
      `version: 1\nprojects:\n  - name: threadnote\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/threadnote\n    seed: []\n`,
    );
    yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
    const citations = yield* captureMemoryCodeCitations(fixture.config, {
      callerCwd: repository,
      project: 'threadnote',
      refs: ['source.ts'],
    });
    const source = record('source', {schemaVersion: 5, codeCitations: citations});
    yield* fixture.fs.writeFileString(fixture.source, source.content);
    return {repository, file, source};
  });
}

function makeIncidentCitationSubject(
  fixture: Effect.Success<ReturnType<typeof makeFixture>>,
  source: ReturnType<typeof record>,
) {
  return Effect.gen(function* () {
    const uri = 'threadnote://user/tester/memories/incidents/active/threadnote/incident.md';
    const incident = parseMemoryDocument(
      uri,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'incident',
          schemaVersion: 5,
          memoryId: 'tn_incident',
          project: 'threadnote',
          sourceAgentClient: 'test',
          status: 'active',
          timestamp: NOW,
          topic: 'incident',
          codeCitations: source.metadata.codeCitations,
        },
        'Incident with an explicit code citation.',
      ),
    )!;
    const file = fixture.path.join(
      fixture.home,
      'data',
      'local',
      'user',
      'tester',
      'memories',
      'incidents',
      'active',
      'threadnote',
      'incident.md',
    );
    yield* fixture.fs.makeDirectory(fixture.path.dirname(file), {recursive: true});
    yield* fixture.fs.writeFileString(file, incident.content);
    return {incident, file};
  });
}
