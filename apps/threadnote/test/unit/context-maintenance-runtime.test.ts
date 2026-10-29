import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

import {CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION} from '@threadnote/context/types';
import {
  selectedMaintenanceCitations,
  maintenanceCoverageCurrent,
  refreshContextMaintenanceCase,
} from '../../src/memory/context/maintenance_refresh.js';
import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Path, PlatformError, Result, Schema} from 'effect';
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
  maintenanceSemanticRecordPairAt,
  selectMaintenanceSemanticPairBatch,
  selectMaintenanceWorkPhase,
} from '@threadnote/threadnote/memory/context/maintenance_decisions';
import {captureCitationReplacements} from '@threadnote/threadnote/memory/context/health_repair_commands';
import {buildContextHealthReport} from '@threadnote/context/health';
import {
  compareContextHealthSemanticClaims,
  extractContextHealthSemanticClaims,
  findContextHealthSemanticContradiction,
} from '@threadnote/context/health_semantic';
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
  maintenanceWorkerBatchCurrent,
  runRequestedMaintenanceProjection,
  selectRelationBoundedMaintenanceWindow,
  selectRequestedMaintenanceUris,
} from '../../src/memory/context/maintenance_batch.js';
import {
  hasAbsentMaintenanceAnchors,
  reconcileAbsentMaintenanceAnchors,
  selectMaintenanceCitationCaseTask,
} from '../../src/memory/context/maintenance_policy.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const CheckpointProbeSchema = Schema.StructWithRest(
  Schema.Struct({
    checkedCitations: Schema.optionalKey(Schema.Finite),
    attemptedCitations: Schema.optionalKey(Schema.Finite),
  }),
  [JsonRecordSchema],
);
const MaintenanceCaseProbeSchema = Schema.StructWithRest(
  Schema.Struct({
    attemptCount: Schema.Finite,
    caseId: Schema.String,
    disposition: Schema.String,
    evidenceRevision: Schema.String,
    family: Schema.String,
    project: Schema.String,
    slot: Schema.String,
  }),
  [JsonRecordSchema],
);
const CasesProbeSchema = Schema.StructWithRest(
  Schema.Struct({
    cases: Schema.Array(MaintenanceCaseProbeSchema),
  }),
  [JsonRecordSchema],
);
const MaintenanceStateProbeSchema = Schema.StructWithRest(
  Schema.Struct({
    cases: Schema.Array(MaintenanceCaseProbeSchema),
    checkpoints: Schema.Record(Schema.String, CheckpointProbeSchema),
    receipts: Schema.Array(Schema.Unknown),
    workSchedule: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({nextPhase: Schema.optionalKey(Schema.Unknown)}), [JsonRecordSchema]),
    ),
    lastTaskByProject: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    policyOverrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    semanticProgress: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.StructWithRest(
          Schema.Struct({
            omissionPairsOverflow: Schema.Boolean,
            omissionPairs: Schema.Array(Schema.Unknown),
          }),
          [JsonRecordSchema],
        ),
      ),
    ),
    topicCheckpoints: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  [JsonRecordSchema],
);
type MaintenanceStateProbe = typeof MaintenanceStateProbeSchema.Type;
function decodeJson<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S['Type'] {
  return Schema.decodeUnknownSync(schema)(value);
}

const NOW = '2026-10-03T15:00:00.000Z';
const URI = 'threadnote://user/tester/memories/durable/projects/threadnote/source.md';
function record(topic: string, metadata: Partial<MemoryMetadata> = {}, body = 'Keep useful context.') {
  const uri = Effect2.pipe(URI, EffectString.replace('source.md', `${topic}.md`));
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
      codeCitations: EffectArray.map(selectors, (selector, anchor) =>
        createMemoryCodeCitation({
          version: 1,
          repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
          repositoryIdentityKind: 'local',
          sourceCommit: Effect2.pipe(selector.toString(16), EffectString.padStart(40, '0')),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
          extractorSet: 'test',
          path: `source-${index}-${anchor}.ts`,
          fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
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
          const before = EffectRecord.fromEntries(EffectArray.map(names, (name, index) => [name, index]));
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
    expect(EffectArray.map(groups, group => group[0].citationIds?.length)).toEqual([16, 16, 16, 16]);
    expect(EffectArray.flatMap(groups, group => EffectArray.flatMap(group, part => part.citationIds ?? []))).toEqual(
      EffectArray.map(record.metadata.codeCitations, citation => citation.id),
    );
    expect(EffectArray.every(groups.flat(), part => part.key === task.key && part.chunk === 0)).toBe(true);
    expect(task).toEqual(before);
  });

  it('keeps all cited memory kinds in the same bounded citation scope', () => {
    const records = EffectArray.map(
      [
        legacyBatchSubject(0, 'one', [0, 0, 0, 0]),
        legacyBatchSubject(1, 'one', [0, 0, 0, 0]),
        legacyBatchSubject(2, 'one', [1]),
      ],
      (item, index) => ({
        ...item,
        metadata: {...item.metadata, kind: index === 2 ? ('incident' as const) : ('handoff' as const)},
      }),
    );
    const tasks = EffectArray.map(records, (value, index) => ({
      record: value,
      project: 'one',
      chunk: 0,
      key: `${index}:0`,
    }));
    const groups = planMaintenanceWorkerBatches(tasks);
    expect(EffectArray.map(groups, group => EffectArray.map(group, task => task.key))).toEqual([['0:0', '1:0', '2:0']]);
    expect(
      EffectArray.flatMap(groups, group =>
        EffectArray.flatMap(
          group,
          task =>
            task.citationIds ??
            EffectOption.getOrElse(
              EffectOption.map(EffectOption.fromNullishOr(task.record.metadata.codeCitations), citations =>
                EffectArray.map(citations, citation => citation.id),
              ),
              () => [],
            ),
        ),
      ),
    ).toEqual(
      EffectArray.flatMap(records, record =>
        EffectOption.getOrElse(
          EffectOption.map(EffectOption.fromNullishOr(record.metadata.codeCitations), citations =>
            EffectArray.map(citations, citation => citation.id),
          ),
          () => [],
        ),
      ),
    );
  });

  it('keeps worker association scopes invariant when cited memory kinds change', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('durable', 'handoff', 'incident', 'preference', 'smoke'), {maxLength: 40}),
        kinds => {
          const baseline = EffectArray.map(kinds, (_, index) => ({
            record: legacyBatchSubject(index, 'one', [index % 12]),
            project: 'one',
            chunk: 0,
            key: String(index),
          }));
          const varied = EffectArray.map(baseline, (task, index) => ({
            ...task,
            record: {...task.record, metadata: {...task.record.metadata, kind: kinds[index]}},
          }));
          const scopes = (tasks: typeof baseline) =>
            EffectArray.map(planMaintenanceWorkerBatches(tasks), group => ({
              keys: EffectArray.map(group, task => task.key),
              selectors: [
                ...new Set(
                  EffectArray.flatMap(group, task =>
                    EffectArray.map(
                      task.record.metadata.codeCitations,
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
          const tasks = EffectArray.flatMap(inputs, (input, index) => {
            const original = legacyBatchSubject(index, input.project, input.selectors);
            const record = {...original, metadata: {...original.metadata, kind: input.kind}};
            return Array.from({length: Math.max(1, Math.ceil(input.selectors.length / 64))}, (_, chunk) => ({
              record,
              project: input.project,
              chunk,
              key: `${index}:${chunk}`,
              citationIds: input.selectedOnly
                ? EffectArray.map(
                    EffectArray.filter(
                      record.metadata.codeCitations.slice(chunk * 64, (chunk + 1) * 64),
                      (_, anchor) => anchor % 2 === input.parity,
                    ),
                    citation => citation.id,
                  )
                : undefined,
            }));
          });
          const before = structuredClone(tasks);
          const expected = EffectArray.map(tasks, task => ({
            ...task,
            ids: EffectArray.map(
              EffectArray.filter(
                EffectArray.filter(
                  task.record.metadata.codeCitations,
                  (_, index) => Math.floor(index / 64) === task.chunk,
                ),
                citation => task.citationIds === undefined || task.citationIds.includes(citation.id),
              ),
              citation => citation.id,
            ),
          }));
          const groups = planMaintenanceWorkerBatches(tasks);
          for (const group of groups) {
            expect(new Set(EffectArray.map(group, task => task.project)).size).toBe(1);
            const anchors = EffectArray.flatMap(group, task =>
              EffectArray.filter(
                EffectArray.filter(
                  task.record.metadata.codeCitations,
                  (_, index) => Math.floor(index / 64) === task.chunk,
                ),
                citation => task.citationIds === undefined || task.citationIds.includes(citation.id),
              ),
            );
            expect(anchors.length).toBeGreaterThan(0);
            expect(anchors.length).toBeLessThanOrEqual(16);
            expect(
              new Set(EffectArray.map(anchors, citation => `${citation.repositoryId}:${citation.sourceCommit}`)).size,
            ).toBeLessThanOrEqual(8);
          }
          for (const task of expected) {
            const actual = EffectArray.filter(groups.flat(), part => part.key === task.key);
            const ids = EffectArray.flatMap(actual, part =>
              EffectArray.map(
                EffectArray.filter(
                  EffectArray.filter(
                    part.record.metadata.codeCitations,
                    (_, index) => Math.floor(index / 64) === part.chunk,
                  ),
                  citation => part.citationIds === undefined || part.citationIds.includes(citation.id),
                ),
                citation => citation.id,
              ),
            );
            expect(ids).toEqual(task.ids);
          }
          for (const project of ['one', 'two', 'three']) {
            const actualKeys = EffectArray.map(
              EffectArray.filter(groups.flat(), task => task.project === project),
              task => task.key,
            );
            const consecutiveKeys = EffectArray.filter(
              actualKeys,
              (key, index) => index === 0 || key !== actualKeys[index - 1],
            );
            expect(consecutiveKeys).toEqual(
              EffectArray.map(
                EffectArray.filter(expected, task => task.project === project && task.ids.length > 0),
                task => task.key,
              ),
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
        const subject = record(`window-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`);
        yield* fixture.fs.writeFileString(
          fixture.path.join(
            fixture.directory,
            `window-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}.md`,
          ),
          subject.content,
        );
      }
      let checked = 0;
      for (let tick = 0; tick < 17 && checked < 17; tick++) {
        const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100});
        const current =
          EffectOption.getOrUndefined(
            EffectArray.findFirst(result.projects, project => project.project === 'threadnote'),
          )?.checked ?? 0;
        expect(current - checked).toBeGreaterThanOrEqual(0);
        expect(current - checked).toBeLessThanOrEqual(4);
        checked = current;
      }
      expect(checked).toBe(17);
      const replay = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 100});
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(replay.projects, project => project.project === 'threadnote'),
        ),
      ).toMatchObject({
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
        const source = record('source', {}, 'Agents must retain deterministic evidence.');
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
      repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
      repositoryIdentityKind: 'local',
      sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
      extractorSet: 'test',
      path: 'source.ts',
      fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
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
          const tasks = EffectArray.map(inputs, (input, index) => ({
            project: input.project,
            record: record(`subject-${index}`, {
              schemaVersion: 5,
              project: input.project,
              codeCitations: Array.from({length: input.anchors}, (_, anchor) =>
                createMemoryCodeCitation({
                  ...citation,
                  path: `path-${anchor}.ts`,
                  sourceCommit: Effect2.pipe(input.commit.toString(16), EffectString.padStart(40, '0')),
                }),
              ),
            }),
            chunk: 0,
            key: String(index),
          }));
          const groups = planMaintenanceWorkerBatches(tasks);
          expect(EffectArray.map(groups.flat(), task => task.key).sort()).toEqual(
            EffectArray.map(tasks, task => task.key).sort(),
          );
          for (const group of groups) {
            expect(new Set(EffectArray.map(group, task => task.project)).size).toBe(1);
            const citations = EffectArray.flatMap(group, task => task.record.metadata.codeCitations!);
            expect(citations.length).toBeLessThanOrEqual(16);
            expect(
              new Set(EffectArray.map(citations, item => `${item.repositoryId}:${item.sourceCommit}`)).size,
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
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryIdentityKind: 'local',
        sourceCommit: Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
        extractorSet: 'test',
        path: `source-${index}.ts`,
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
        target: {kind: 'file'},
      }),
    );
    const original = record('source');
    const subject = {...original, metadata: {...original.metadata, codeCitations: citations}};
    const groups = planMaintenanceWorkerBatches([{record: subject, project: 'threadnote', chunk: 0, key: 'logical:0'}]);
    expect(groups).toHaveLength(8);
    expect(EffectArray.map(groups.flat(), task => [task.key, task.chunk])).toEqual(
      Array.from({length: 8}, () => ['logical:0', 0]),
    );
    expect(EffectArray.flatMap(groups, group => EffectArray.flatMap(group, task => task.citationIds ?? []))).toEqual(
      EffectArray.map(citations, item => item.id),
    );
    const parts = EffectArray.map(groups, group => {
      const selected = EffectArray.filter(
        citations,
        (citation, index) => index in citations && Boolean(group[0].citationIds?.includes(citation.id)),
      );
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
            bySelector: EffectRecord.fromEntries(
              EffectArray.map(selected, citation => [
                `${citation.repositoryId}:${citation.sourceCommit}`,
                'association',
              ]),
            ),
          },
        },
      };
    });
    const merged = EffectArray.reduce(parts.slice(1), parts[0], mergeMaintenanceWorkerEvidence);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(merged.records[0].metadata.codeCitations), citations =>
          EffectArray.map(citations, item => item.id),
        ),
      ),
    ).toEqual(EffectArray.map(citations, item => item.id));
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
      const tasks = EffectArray.map(subjects, (record, index) => ({
        record,
        project: 'threadnote',
        chunk: 0,
        key: String(index),
      }));
      const oversized = yield* collectMaintenanceWorkerBatch(fixture.config, tasks, repository);
      expect(oversized.observation).toBeUndefined();
      expect(oversized.validations).toEqual([]);
      const groups = planMaintenanceWorkerBatches(tasks);
      expect(EffectArray.map(groups, group => group.length)).toEqual([16, 1]);
      const evidence = yield* Effect.forEach(groups, group =>
        collectMaintenanceWorkerBatch(fixture.config, group, repository),
      );
      expect(EffectArray.every(evidence, batch => batch.observation !== undefined)).toBe(true);
      expect(
        EffectArray.map(
          EffectArray.flatMap(evidence, batch => batch.records),
          record => record.uri,
        ),
      ).toEqual(EffectArray.map(subjects, record => record.uri));
      expect(
        EffectArray.map(
          EffectArray.flatMap(evidence, batch => batch.validations),
          validation => validation.uri,
        ).sort(),
      ).toEqual(EffectArray.map(subjects, record => record.uri).sort());
      expect(
        EffectArray.flatMap<
          (typeof evidence)[number]['validations'][number],
          (typeof evidence)[number]['validations'][number]['receipts'][number]
        >(
          EffectArray.flatMap<(typeof evidence)[number], (typeof evidence)[number]['validations'][number]>(
            evidence,
            batch => batch.validations,
          ),
          validation => validation.receipts,
        ),
      ).toHaveLength(17);
      for (const subject of subjects) {
        const file = fixture.path.join(fixture.directory, Effect2.pipe(subject.uri, EffectString.split('/')).at(-1)!);
        expect(yield* fixture.fs.readFileString(file)).toBe(subject.content);
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('validates an incident citation alongside a durable citation in bounded worker batches', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, source} = yield* makeCitationRepository(fixture);
      const {incident, file: incidentFile} = yield* makeIncidentCitationSubject(fixture, source);
      const tasks = EffectArray.map([source, incident], (record, index) => ({
        record,
        project: 'threadnote',
        chunk: 0,
        key: String(index),
      }));
      const groups = planMaintenanceWorkerBatches(tasks);
      const evidence = yield* Effect.forEach(groups, group =>
        collectMaintenanceWorkerBatch(fixture.config, group, repository),
      );
      expect(EffectArray.every(evidence, batch => batch.observation !== undefined)).toBe(true);
      const validations = EffectArray.flatMap(evidence, batch => batch.validations);
      expect(EffectArray.map(validations, validation => validation.uri).sort()).toEqual(
        [source.uri, incident.uri].sort(),
      );
      expect(EffectArray.flatMap(validations, validation => validation.receipts)).toHaveLength(2);
      expect(EffectArray.every(validations, validation => validation.receipts[0]?.status === 'exact')).toBe(true);
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
      let initial = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            checkpoints: Schema.optionalKey(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
          }),
          [JsonRecordSchema],
        ),
        {},
      );
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
      const request = EffectOption.getOrUndefined(
        EffectArray.findFirst(yield* readContextMaintenanceEvidenceRequests(fixture.config), value =>
          value.uris.includes(incident.uri),
        ),
      );
      expect(request).toBeDefined();
      yield* runRequestedMaintenanceProjection(fixture.config, request!, [incident], [incident], true);
      let upgraded = yield* readContextMaintenanceStatus(fixture.config, 'threadnote');
      for (let tick = 0; tick < 6; tick++) {
        upgraded = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
        if (
          EffectOption.getOrUndefined(EffectArray.findFirst(upgraded.cases, item => item.caseId === oldCase.caseId))
            ?.disposition === 'resolved'
        )
          break;
      }
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(upgraded.cases, item => item.caseId === oldCase.caseId)),
      ).toMatchObject({
        disposition: 'resolved',
        reason: 'postcondition-verified',
      });
      expect(upgraded.projects[0]?.checkedCitations).toBe(1);
      const saved = JSON.parse(yield* fixture.fs.readFileString(stateFile));
      expect(saved.checkpoints['tn_incident:0'].checkedCitations).toBe(1);
      const replay = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(replay.cases, item => item.caseId === oldCase.caseId))
          ?.attemptCount,
      ).toBe(
        EffectOption.getOrUndefined(EffectArray.findFirst(upgraded.cases, item => item.caseId === oldCase.caseId))
          ?.attemptCount,
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
        if (
          EffectOption.getOrUndefined(EffectArray.findFirst(later.cases, item => item.caseId === oldCase.caseId))
            ?.disposition === 'resolved'
        )
          break;
      }
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(later.cases, item => item.caseId === oldCase.caseId))
          ?.disposition,
      ).toBe('resolved');
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
          validations: EffectArray.map(checked.validations, validation => ({
            ...validation,
            receipts: EffectArray.map(validation.receipts, receipt => ({
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
                ? createMemoryCodeCitation({
                    ...original,
                    sourceCommit: Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
                  })
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
          const tasks = EffectArray.map(subjects, (record, index) => ({
            record,
            project: 'threadnote',
            chunk: 0,
            key: String(index),
          }));
          const oversized = yield* collectMaintenanceWorkerBatch(fixture.config, tasks, repository);
          expect(oversized.observation, `${kind}:${boundary}`).toBeUndefined();
          expect(oversized.validations).toEqual([]);
          expect(EffectArray.map(oversized.records, record => record.uri).sort()).toEqual(
            EffectArray.map(subjects, record => record.uri).sort(),
          );
          for (const subject of subjects)
            expect(
              yield* fixture.fs.readFileString(
                fixture.path.join(fixture.directory, Effect2.pipe(subject.uri, EffectString.split('/')).at(-1)!),
              ),
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
        EffectArray.map(
          EffectArray.flatMap(evidence.validations, validation => validation.receipts),
          receipt => receipt.citationId,
        ),
      ).toEqual(EffectArray.map(source.metadata.codeCitations!, anchor => anchor.id));
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('consumes prepared work without spending its application budget on slow observations', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, source} = yield* makeCitationRepository(fixture);
      const relation = record('zz-relation', {
        relations: [{type: 'references', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))}],
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
      const changed = EffectOption.getOrUndefined(
        EffectArray.findFirst(before.cases, item => item.family === 'citation'),
      )!;
      expect(changed.disposition).toBe('needs-decision');
      yield* retireContextMaintenanceAnchor(fixture.config, {
        caseId: changed.caseId,
        evidenceRevision: changed.evidenceRevision,
        expectedContentHash: changed.subjectContentHashes![0].hash,
      });
      const retired = yield* readContextMaintenanceStatus(fixture.config, 'threadnote');
      const originalCase = EffectOption.getOrUndefined(
        EffectArray.findFirst(retired.cases, item => item.caseId === changed.caseId),
      )!;
      const originalSupport = EffectOption.getOrUndefined(
        EffectArray.findFirst(retired.cases, item => item.family === 'current-support'),
      )!;
      expect(originalCase.disposition).toBe('retired');
      expect(originalSupport.disposition).toBe('needs-decision');
      yield* fixture.fs.writeFileString(file, 'export const supported = true;\n');
      yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      // The resumed semantic phase advances separately before the next citation phase.
      yield* runContextMaintenance(fixture.config, {cwd: repository});
      const evidence = yield* collectMaintenanceWorkerBatch(
        fixture.config,
        [{record: source, project: 'threadnote', chunk: 0, key: 'tn_source:0'}],
        repository,
      );
      expect(
        EffectArray.some(
          EffectArray.flatMap(evidence.validations, item => item.receipts),
          receipt => receipt.status === 'exact' && receipt.provenance !== 'historical-verified',
        ),
      ).toBe(true);
      expect(yield* maintenanceWorkerBatchCurrent(fixture.config, evidence)).toBe(true);
      yield* fixture.fs.writeFileString(file, 'export const supported = false;\n');
      expect(yield* maintenanceWorkerBatchCurrent(fixture.config, evidence)).toBe(false);
      yield* fixture.fs.writeFileString(file, 'export const supported = true;\n');
      yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const evidenceFile = fixture.path.join(
        fixture.home,
        'context-maintenance',
        'evidence',
        `${sha256HexSync(`threadnote\0${repository}`)}.json`,
      );
      yield* fixture.fs.remove(evidenceFile);
      const prior = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
      const taskKey = `${source.metadata.memoryId}:0`;
      let injected: MaintenanceStateProbe | undefined;
      const racing = FileSystem.FileSystem.of({
        ...fixture.fs,
        rename: (from, to) =>
          fixture.fs.rename(from, to).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (to !== stateFile || injected !== undefined) return;
                const tentative = decodeJson(
                  MaintenanceStateProbeSchema,
                  JSON.parse(yield* fixture.fs.readFileString(stateFile)),
                );
                if (
                  tentative.checkpoints[taskKey]?.checkedCitations !== 1 ||
                  EffectOption.getOrUndefined(
                    EffectArray.findFirst(tentative.cases, item => item.caseId === originalSupport.caseId),
                  )?.disposition !== 'resolved'
                )
                  return;
                const projection = decodeJson(
                  Schema.StructWithRest(
                    Schema.Struct({
                      entries: Schema.Array(
                        Schema.StructWithRest(
                          Schema.Struct({
                            receipts: Schema.Array(
                              Schema.StructWithRest(
                                Schema.Struct({
                                  citationId: Schema.String,
                                  status: Schema.String,
                                  provenance: Schema.String,
                                }),
                                [JsonRecordSchema],
                              ),
                            ),
                          }),
                          [JsonRecordSchema],
                        ),
                      ),
                    }),
                    [JsonRecordSchema],
                  ),
                  JSON.parse(yield* fixture.fs.readFileString(evidenceFile)),
                );
                expect(
                  EffectArray.some(projection.entries, entry =>
                    EffectArray.some(
                      entry.receipts,
                      receipt =>
                        receipt.citationId === source.metadata.codeCitations![0].id &&
                        receipt.status === 'exact' &&
                        receipt.provenance !== 'historical-verified',
                    ),
                  ),
                ).toBe(true);
                expect(yield* fixture.fs.readFileString(file)).toBe('export const supported = true;\n');
                injected = tentative;
                yield* fixture.fs.writeFileString(file, 'export const supported = false;\n');
              }),
            ),
          ),
      });
      const result = yield* runContextMaintenance(fixture.config, {cwd: repository}).pipe(
        Effect.provideService(FileSystem.FileSystem, racing),
      );
      expect(injected).toBeDefined();
      expect(injected!.checkpoints[taskKey].checkedCitations).toBe(1);
      expect(result.projects[0].checked).toBe(0);
      expect(result.projects[0].checkedCitations).toBe(0);
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(result.cases, item => item.caseId === originalCase.caseId)),
      ).toEqual(originalCase);
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(result.cases, item => item.caseId === originalSupport.caseId),
        ),
      ).toEqual(originalSupport);
      const persisted = decodeJson(
        MaintenanceStateProbeSchema,
        JSON.parse(yield* fixture.fs.readFileString(stateFile)),
      );
      const expectedCheckpoints = {...prior.checkpoints};
      delete expectedCheckpoints[taskKey];
      expect(persisted.checkpoints).toEqual(expectedCheckpoints);
      expect(persisted.cases).toEqual(prior.cases);
      expect(result.receipts).toEqual(prior.receipts);
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
      yield* fixture.fs.makeDirectory(fixture.path.dirname(stateFile), {recursive: true});
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
      expect(new Set(EffectArray.map(foundCases, item => item.caseId)).size).toBe(73);
      expect(new Set(EffectArray.map(foundReceipts, item => item.receiptId)).size).toBe(100);
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
    }).pipe(provideTestLayer(Layer.mergeAll(BunFileSystem.layer, BunPath.layer, Layer.mock(ResourceStore, {})))),
  );

  effectIt.effect('bounds a scoped one-record tick independently of two thousand unrelated cited records', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const unrelated = fixture.path.join(fixture.directory, '..', 'unrelated');
      yield* fixture.fs.makeDirectory(unrelated, {recursive: true});
      const citation = createMemoryCodeCitation({
        version: 1,
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryIdentityKind: 'local',
        sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
        extractorSet: 'typescript-v1',
        path: 'unrelated.ts',
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
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
          if (Effect2.pipe(file, EffectString.startsWith(unrelated))) unrelatedReads++;
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
      const changed = EffectOption.getOrUndefined(
        EffectArray.findFirst(first.cases, item => item.family === 'citation' && item.disposition === 'needs-decision'),
      );
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
            memoryUri: Effect2.pipe(source.uri, EffectString.replace('source.md', 'outside.md')),
          }).pipe(Effect.result),
        ),
      ).toBe(true);
      const second = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      expect(second.projects[0]).toEqual(first.projects[0]);
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(second.cases, item => item.caseId === changed!.caseId))
          ?.attemptCount,
      ).toBe(changed!.attemptCount);
      expect(second.lastProgressAt).toBe(first.lastProgressAt);
      expect((yield* readContextMaintenancePacket(fixture.config, changed!.caseId)).caseId).toBe(changed!.caseId);
      yield* fixture.fs.remove(file);
      yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const deletedStatus = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      const unavailable = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          deletedStatus.cases,
          item => item.family === 'citation' && item.citationId === citations[0].id,
        ),
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
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(retired.cases, item => item.caseId === deleted.caseId))
          ?.disposition,
      ).toBe('retired');
      expect(
        EffectArray.filter(
          retired.cases,
          item => item.family === 'current-support' && item.disposition === 'needs-decision',
        ),
      ).toHaveLength(1);
      expect(yield* retireContextMaintenanceAnchor(fixture.config, input)).toMatchObject({status: 'already-retired'});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'refreshes one stale selected citation after an unrelated source revision without canonical writes',
    () =>
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
        const changed = EffectOption.getOrUndefined(
          EffectArray.findFirst(
            first.cases,
            item => item.family === 'citation' && item.disposition === 'needs-decision',
          ),
        );
        expect(changed, JSON.stringify(first)).toBeDefined();
        yield* fixture.fs.writeFileString(
          fixture.path.join(repository, 'independent.ts'),
          'export const independent = false;\n',
        );
        yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
        expect(
          Result.isFailure(yield* readContextMaintenancePacket(fixture.config, changed!.caseId).pipe(Effect.result)),
        ).toBe(true);
        const fresh = yield* refreshContextMaintenanceCase(fixture.config, {
          project: 'threadnote',
          caseId: changed!.caseId,
          cwd: repository,
        });
        expect(fresh.outcome).toBe('ready');
        if (fresh.outcome !== 'ready') throw new Error(JSON.stringify(fresh));
        expect(fresh.item.caseId).toBe(changed!.caseId);
        expect(
          'evidence' in fresh.packet &&
            EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(fresh.packet.evidence), evidence =>
                EffectArray.some(
                  evidence.excerpts,
                  excerpt => excerpt.provenance === 'current-verified' && !excerpt.supportsCitation,
                ),
              ),
            ),
        ).toBe(true);
        expect(yield* fixture.fs.readFileString(fixture.source)).toBe(raw);
        const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
        const stateBefore = yield* fixture.fs.readFileString(stateFile);
        expect(
          (yield* refreshContextMaintenanceCase(fixture.config, {
            project: 'threadnote',
            caseId: changed!.caseId,
            cwd: repository,
          })).outcome,
        ).toBe('ready');
        expect(yield* fixture.fs.readFileString(stateFile)).toBe(stateBefore);
        expect(
          (yield* refreshContextMaintenanceCase(fixture.config, {
            project: 'another-project',
            caseId: changed!.caseId,
            cwd: repository,
          })).outcome,
        ).toBe('unavailable');
        expect(yield* fixture.fs.readFileString(stateFile)).toBe(stateBefore);
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
        record('source', {schemaVersion: 5, codeCitations: citations}, 'Agents must retain deterministic evidence.')
          .content,
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
      const projection = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            entries: Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  uri: Schema.String,
                  receipts: Schema.Array(
                    Schema.StructWithRest(Schema.Struct({citationId: Schema.String}), [JsonRecordSchema]),
                  ),
                }),
                [JsonRecordSchema],
              ),
            ),
          }),
          [JsonRecordSchema],
        ),
        JSON.parse(yield* fixture.fs.readFileString(requestedFile)),
      );
      expect(yield* requested()).toEqual([]);
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(
            EffectOption.fromNullishOr(
              EffectOption.getOrUndefined(EffectArray.findFirst(projection.entries, entry => entry.uri === source.uri))
                ?.receipts,
            ),
            receipts => EffectArray.map(receipts, receipt => receipt.citationId),
          ),
        ),
      ).toEqual(EffectArray.map(citations, citation => citation.id));
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains and defers an unprovable requested URI after completing its sibling', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* TestClock.setTime(Date.parse(NOW));
      const citation = createMemoryCodeCitation({
        extractorSet: 'typescript-v1',
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
        path: 'source.ts',
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryIdentityKind: 'local',
        sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
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
      const pending = decodeJson(
        Schema.StructWithRest(Schema.Struct({uris: Schema.Array(Schema.String)}), [JsonRecordSchema]),
        JSON.parse(yield* fixture.fs.readFileString(pendingFile)),
      );
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
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
        path: 'source.ts',
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryIdentityKind: 'local',
        sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
        target: {kind: 'file'},
        version: 1,
      });
      const requested = Array.from({length: 101}, (_, index) =>
        record(`requested-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}`, {
          schemaVersion: 5,
          codeCitations: [citation],
        }),
      );
      const last = requested.at(-1)!;
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, `${last.metadata.topic}.md`),
        last.content,
      );
      yield* collectContextHealth(fixture.config, 'threadnote', requested, fixture.home);
      const pages = yield* readContextMaintenanceEvidenceRequests(fixture.config);
      expect(EffectArray.flatMap(pages, page => page.uris)).toHaveLength(101);
      const laterPage = EffectOption.getOrUndefined(
        EffectArray.findFirst(pages, page => page.uris.includes(last.uri)),
      )!;
      expect(laterPage.page).toBe(1);
      for (let tick = 0; tick < 8; tick++) yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const pending = yield* readContextMaintenanceEvidenceRequests(fixture.config);
      expect(EffectArray.flatMap(pending, page => page.uris)).not.toContain(last.uri);
      const projectionFile = fixture.path.join(
        fixture.home,
        'context-maintenance',
        'evidence',
        `${sha256HexSync(`threadnote\0${fixture.home}`)}.json`,
      );
      const projection = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            entries: Schema.Array(Schema.StructWithRest(Schema.Struct({uri: Schema.String}), [JsonRecordSchema])),
          }),
          [JsonRecordSchema],
        ),
        JSON.parse(yield* fixture.fs.readFileString(projectionFile)),
      );
      expect(EffectArray.some(projection.entries, entry => entry.uri === last.uri)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('discovers a scoped request beyond 64 other-project files without claiming idle', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.fs.writeFileString(
        fixture.source,
        record('source', {}, 'Agents must retain deterministic evidence.').content,
      );
      const directory = fixture.path.join(fixture.home, 'context-maintenance', 'evidence');
      yield* fixture.fs.makeDirectory(directory, {recursive: true});
      const target = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          Array.from({length: 256}, (_, index) => fixture.path.join(fixture.home, `target-${index}`)),
          cwd => Effect2.pipe(sha256HexSync(`threadnote\0${cwd}`), EffectString.startsWith('f')),
        ),
      );
      if (target === undefined) return yield* Effect.die(new Error('Missing bounded target root.'));
      const targetHash = sha256HexSync(`threadnote\0${target}`);
      const others = EffectArray.filter(
        Array.from({length: 512}, (_, index) => fixture.path.join(fixture.home, `other-${index}`)),
        cwd => sha256HexSync(`other\0${cwd}`) < targetHash,
      ).slice(0, 64);
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
      const discovered = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          yield* readContextMaintenanceEvidenceRequests(fixture.config),
          request => request.cwd === target,
        ),
      );
      // The public reader itself is bounded to the first 64 files.
      expect(discovered).toBeUndefined();
      const targetFile = fixture.path.join(directory, `${targetHash}.json.pending`);
      const pending = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({deferredUntil: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))}),
          [JsonRecordSchema],
        ),
        JSON.parse(yield* fixture.fs.readFileString(targetFile)),
      );
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
      const roots = EffectArray.map(
        Array.from({length: 128}, (_, index) => fixture.path.join(fixture.home, `root-${index}`)),
        cwd => ({cwd, file: `${sha256HexSync(`threadnote\0${cwd}`)}.json.pending`}),
      ).sort((left, right) => Effect2.pipe(left.file, EffectString.localeCompare(right.file)));
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
        const pending = decodeJson(
          Schema.StructWithRest(
            Schema.Struct({deferredUntil: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))}),
            [JsonRecordSchema],
          ),
          JSON.parse(yield* fixture.fs.readFileString(fixture.path.join(directory, root.file))),
        );
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
          fixture.path.join(
            directory,
            `${hash}.${Effect2.pipe(String(page), EffectString.padStart(6, '0'))}.json.pending`,
          ),
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
      const last = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({deferredUntil: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))}),
          [JsonRecordSchema],
        ),
        JSON.parse(yield* fixture.fs.readFileString(fixture.path.join(directory, `${hash}.000065.json.pending`))),
      );
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
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(overdue.cases, item => item.family === 'review-overdue'))
          ?.disposition,
        JSON.stringify(overdue),
      ).toBe('needs-decision');
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
          candidateId: `${Effect2.pipe(review.candidates[0].candidateId, EffectString.slice(0, -1))}a`,
          comparison: 'possible_duplicate' as const,
          recommendation: 'manual_review' as const,
        },
      ];
      const pending = {...review, candidates};
      yield* saveCandidateReview(fixture.home, pending);
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const cases = EffectArray.filter(first.cases, item => item.family === 'candidate');
      expect(cases).toHaveLength(2);
      expect(EffectArray.every(cases, item => item.disposition === 'needs-decision')).toBe(true);
      for (const item of cases) {
        const packet = yield* readContextMaintenancePacket(fixture.config, item.caseId);
        expect('reviewInbox' in packet && packet.reviewInbox?.reviewId).toBe(review.reviewId);
      }
      const resolved = candidateReviewWithState(pending, candidates[0].candidateId, 'rejected');
      yield* saveCandidateReview(fixture.home, resolved);
      const stale = yield* readContextMaintenancePacket(fixture.config, cases[0].caseId).pipe(Effect.result);
      expect(Result.isFailure(stale)).toBe(true);
      const second = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(second.cases, item => item.slot === candidates[0].candidateId),
        )?.disposition,
      ).toBe('resolved');
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(second.cases, item => item.slot === candidates[1].candidateId),
        )?.disposition,
      ).toBe('needs-decision');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves exact duplicates targeted by active URI or identity dependencies', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source');
      const copyUri = Effect2.pipe(URI, EffectString.replace('source.md', 'copy.md'));
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
            if (
              !injected &&
              Effect2.pipe(args[0], EffectString.includes('context-health-repairs')) &&
              Effect2.pipe(args[0], EffectString.endsWith('.tmp'))
            ) {
              injected = true;
              const journal = decodeJson(
                Schema.StructWithRest(
                  Schema.Struct({
                    proposal: Schema.StructWithRest(
                      Schema.Struct({
                        mutation: Schema.StructWithRest(Schema.Struct({subjectUri: Schema.String}), [JsonRecordSchema]),
                      }),
                      [JsonRecordSchema],
                    ),
                  }),
                  [JsonRecordSchema],
                ),
                JSON.parse(args[1]),
              );
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
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryIdentityKind: 'local',
        sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
        extractorSet: 'typescript-v1',
        path: 'source.ts',
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
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
        expect(EffectArray.every(windows, window => window.length <= 128)).toBe(true);
        for (const left of records)
          for (const right of records)
            expect(EffectArray.some(windows, window => window.includes(left) && window.includes(right))).toBe(true);
        expect(records).toEqual(original);
      }),
      {numRuns: 20},
    );
  });

  it('enumerates each record comparison once with a lazy stable pair cursor', () => {
    fc.assert(
      fc.property(fc.integer({min: 2, max: 80}), size => {
        const pairs = Array.from({length: (size * (size - 1)) / 2}, (_, cursor) =>
          maintenanceSemanticRecordPairAt(cursor, size),
        );
        expect(new Set(EffectArray.map(pairs, ([left, right]) => `${left}:${right}`)).size).toBe(pairs.length);
        expect(EffectArray.every(pairs, ([left, right]) => left >= 0 && left < right && right < size)).toBe(true);
        expect(pairs[0]).toEqual([0, size - 1]);
      }),
      {numRuns: 30},
    );
  });

  it('finds the exhaustive polarity conflicts independent of comparison subdivision and restart cursor', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), {minLength: 2, maxLength: 12}),
        fc.integer({min: 1, max: 7}),
        (denied, batchSize) => {
          const subjects = EffectArray.map(denied, (value, index) =>
            record(`polarity-${index}`, {}, `Agents must ${value ? 'not ' : ''}load verified context.`),
          );
          const original = EffectArray.map(subjects, subject => subject.content);
          const claims = EffectArray.map(subjects, subject => extractContextHealthSemanticClaims(subject).claims[0]);
          const expected = new Set<string>();
          for (let left = 0; left < denied.length; left++)
            for (let right = left + 1; right < denied.length; right++)
              if (denied[left] !== denied[right]) expected.add(`${left}:${right}`);
          const actual = new Set<string>();
          const total = (denied.length * (denied.length - 1)) / 2;
          for (let restartCursor = 0; restartCursor < total; restartCursor += batchSize) {
            for (let cursor = restartCursor; cursor < Math.min(total, restartCursor + batchSize); cursor++) {
              const [left, right] = maintenanceSemanticRecordPairAt(cursor, denied.length);
              if (compareContextHealthSemanticClaims(claims[left], claims[right])) actual.add(`${left}:${right}`);
            }
          }
          expect(actual).toEqual(expected);
          expect(EffectArray.map(subjects, subject => subject.content)).toEqual(original);
        },
      ),
      {numRuns: 35},
    );
  });

  it('alternates record and semantic phases and visits every pending project without mutating inputs', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 7}), {minLength: 1, maxLength: 8}), ids => {
        const projects = EffectArray.map(ids, id => `project-${id}`);
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
        const roots = EffectArray.map(ids, id => `project-${id}\0/worktree-${id}`);
        const uris = EffectArray.map(ids, id => `threadnote://memory/${id}`);
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
          EffectArray.forEach(selected, uri => visitedUris.add(uri));
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
        }).sort((left, right) => Effect2.pipe(left.file, EffectString.localeCompare(right.file)));
        const eligible = new Set([files[0].root, files[Math.floor(total / 2)].root, files.at(-1)!.root]);
        const visited = new Set<string>();
        let discovery: ReturnType<typeof advanceContextMaintenanceEvidenceRequestDiscovery> | undefined;
        for (let tick = 0; tick < total * 4 && visited.size < eligible.size; tick++) {
          const start =
            discovery?.lastFile === undefined
              ? 0
              : EffectOption.getOrElse(
                  EffectArray.findFirstIndex(files, item => item.file > discovery!.lastFile!),
                  () => -1,
                );
          const rotated = [...files.slice(Math.max(0, start)), ...files.slice(0, Math.max(0, start))].slice(0, 64);
          const next = EffectOption.getOrUndefined(EffectArray.findFirst(rotated, item => eligible.has(item.root)));
          const executed = tick % 2 === 1 ? next?.root : undefined;
          if (executed !== undefined) visited.add(executed);
          discovery = advanceContextMaintenanceEvidenceRequestExecution(
            discovery,
            {
              requests: EffectArray.map(rotated, item => item.request),
              files: EffectArray.map(rotated, item => item.file),
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
        const tasks = EffectArray.map(flags, (hasRelation, index) => ({
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
          if (EffectArray.some(selected, task => (task.record.metadata.relations?.length ?? 0) > 0))
            expect(selected).toHaveLength(1);
          visited.push(...EffectArray.map(selected, task => task.index));
          remaining = remaining.slice(selected.length);
        }
        expect(visited).toEqual(EffectArray.map(tasks, task => task.index));
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
        record('a-relation', {
          relations: [
            {type: 'references', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'z-independent.md'))},
          ],
        }).content,
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
      const after = record('a-first', {
        relations: [{type: 'references', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'z-later.md'))}],
      });
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
      yield* fixture.fs.writeFileString(
        fixture.source,
        record('source', {}, 'Agents must retain deterministic evidence.').content,
      );
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(first.semanticCoverage?.[0]).toMatchObject({state: 'partial', checkedBatches: 0, totalBatches: 1});
      expect(first.state).not.toBe('idle');

      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const oldState = {...decodeJson(JsonRecordSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)))};
      delete oldState.workSchedule;
      yield* fixture.fs.writeFileString(stateFile, JSON.stringify(oldState));
      const resumedRecords = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(resumedRecords.semanticCoverage?.[0].checkedBatches).toBe(0);
      const resumedSemantic = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(resumedSemantic.semanticCoverage?.[0]).toMatchObject({state: 'complete', checkedBatches: 1});

      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, 'new-subject.md'),
        record('new-subject', {}, 'Reviewers must retain verified evidence.').content,
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
    const archived = record('archive', {
      status: 'archived',
      archivedFrom: Effect2.pipe(URI, EffectString.replace('source.md', 'old.md')),
    });
    const source = record('source', {
      relations: [
        {type: 'depends_on', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))},
        {type: 'references', uri: archived.uri},
        {type: 'supersedes', uri: 'threadnote://memory/tn_unavailable'},
        {
          type: 'depends_on',
          uri: 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/unavailable.md',
        },
      ],
    });
    expect(safeRelationRemoval(source, [source, archived])).toEqual([
      {type: 'depends_on', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))},
    ]);
  });

  it('prunes every proven missing private relation type while preserving inactive historical links', () => {
    fc.assert(
      fc.property(fc.constantFrom('depends_on', 'references', 'related_to', 'evidence_for', 'supersedes'), type => {
        const relation = {
          type,
          uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md')),
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
          {type: 'references', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))},
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
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(result.cases, item => Effect2.pipe(item.slot, EffectString.endsWith('missing.md'))),
        )?.disposition,
      ).toBe('retired');
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
      expect(EffectArray.some(result.cases, item => item.reason === 'relation-repair-conflict')).toBe(true);
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
          repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
          repositoryIdentityKind: 'local',
          sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
          extractorSet: 'typescript-v1',
          path: 'source.ts',
          fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
          target: {kind: 'file'},
        });
        const chunked = {
          ...subject,
          metadata: {...subject.metadata, codeCitations: Array.from({length: anchors}, () => citation)},
        };
        const chunks = Math.ceil(anchors / 64);
        const checks = EffectRecord.fromEntries(
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
          const citations = EffectArray.map(indexes, index =>
            createMemoryCodeCitation({
              version: 1,
              repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
              repositoryIdentityKind: 'local',
              sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
              sourceDirty: false,
              sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
              extractorSet: 'typescript-v1',
              path: `file-${index}.ts`,
              fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
              target: {kind: 'file'},
            }),
          );
          const subject = record('source', {schemaVersion: 5, codeCitations: citations});
          const cases = new Map(
            EffectArray.map(inputs, (input, index) => {
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
          repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
          repositoryIdentityKind: 'local',
          sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
          extractorSet: 'typescript-v1',
          path: `file-${index}.ts`,
          fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
          target: {kind: 'file'},
        }),
      );
      const original = record('source', {schemaVersion: 5, codeCitations: citations});
      const current = record('source', {
        schemaVersion: 5,
        codeCitations: EffectArray.filter(citations, (_, index) => index !== 0 && index !== 7),
      });
      const removed = EffectArray.map([citations[0], citations[7]], citation => ({
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
      yield* fixture.fs.makeDirectory(fixture.path.dirname(stateFile), {recursive: true});
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
      expect(EffectArray.filter(final.cases, item => item.reason === 'canonical-anchor-removed')).toHaveLength(3);
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(final.cases, item =>
            Effect2.pipe(item.slot, EffectString.startsWith('legacy-unresolved:')),
          ),
        ),
      ).toMatchObject({
        disposition: 'resolved',
        reason: 'legacy-anchor-lineage-unprovable',
        firstSeen: NOW,
        attemptCount: 3,
      });
      const attention = (status: typeof final) =>
        EffectArray.map(
          EffectArrayPipe(status.cases, __effectArrayValues =>
            EffectArray.filter(
              __effectArrayValues,
              (item, __effectArrayIndex) =>
                __effectArrayIndex in __effectArrayValues &&
                ['needs-decision', 'waiting-evidence'].includes(item.disposition),
            ),
          ),
          item => [item.family, item.slot, item.reason],
        ).sort();
      expect(attention(final)).toEqual(attention(fresh));
      expect(
        parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.codeCitations,
      ).toEqual(current.metadata.codeCitations);
      expect(
        EffectArray.every(
          EffectArray.filter(final.cases, item => item.reason === 'canonical-anchor-removed'),
          item => item.firstSeen === NOW && EffectArray.some(item.events, event => event.reason === 'citation-changed'),
        ),
      ).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not reread complete canonical subjects whose anchor cases cannot change', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citation = createMemoryCodeCitation({
        version: 1,
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryIdentityKind: 'local',
        sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
        extractorSet: 'typescript-v1',
        path: 'source.ts',
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
        target: {kind: 'file'},
      });
      const subjects = Array.from({length: 64}, (_, index) =>
        record(`complete-${index}`, {schemaVersion: 5, codeCitations: [citation]}, `Unique body ${index}.`),
      );
      const cases = EffectArray.map(subjects, subject =>
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
      const checkpoints = EffectRecord.fromEntries(
        EffectArray.map(subjects, subject => [
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
        new Map(EffectArray.map(subjects, subject => [subject.uri, sha256HexSync(subject.content)])),
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
          if (
            Effect2.pipe(file, EffectString.startsWith(fixture.directory)) &&
            Effect2.pipe(file, EffectString.endsWith('.md'))
          ) {
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
            {type: 'depends_on', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))},
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
        const cases = new Map(EffectArray.map(shuffled, item => [item.caseId, item]));
        reconcileRepositoryRecoveryCases(cases, NOW);
        const decisions = EffectArray.filter([...cases.values()], item => item.disposition === 'needs-decision');
        expect(decisions).toHaveLength(1);
        expect(decisions[0].subjectContentHashes).toHaveLength(12);
        expect(EffectArray.filter([...cases.values()], item => item.family === 'citation')).toHaveLength(12);
        const before = structuredClone([...cases]);
        reconcileRepositoryRecoveryCases(cases, NOW);
        expect([...cases]).toEqual(before);
        expect(EffectArray.every(anchors, item => item.nextAttemptAt === undefined && item.wake !== undefined)).toBe(
          true,
        );
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
        const work = EffectArray.map(ids, (id, index) => ({project: `project-${id}`, index}));
        const original = structuredClone(work);
        const projects = new Set(EffectArray.map(work, item => item.project));
        const selected = selectFairMaintenanceWork(work, undefined, projects.size);
        expect(new Set(EffectArray.map(selected, item => item.project)).size).toBe(projects.size);
        expect(work).toEqual(original);
        expect(
          new Set(EffectArray.map(selectFairMaintenanceWork(work, undefined, work.length), item => item.index)).size,
        ).toBe(work.length);
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
    const citations = EffectArray.map(['first.ts', 'second.ts'], path =>
      createMemoryCodeCitation({
        version: 1,
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryIdentityKind: 'local',
        sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
        extractorSet: 'typescript-v1',
        path,
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
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

  it('exact citation selection is order-independent, chunk-bounded, and fails closed on ambiguous subjects', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 130}), fc.nat(), fc.boolean(), (count, offset, reverse) => {
        const source = legacyBatchSubject(
          0,
          'threadnote',
          Array.from({length: count}, () => 0),
        );
        const selectedIndex = offset % count;
        const selected = updateMaintenanceCase(
          undefined,
          {
            project: 'threadnote',
            memoryId: source.uri,
            family: 'citation',
            slot: contextHealthCitationCaseSlotV2(source.metadata.codeCitations[selectedIndex]),
            evidenceRevision: 'revision',
            disposition: 'waiting-evidence',
            reason: 'not-ready',
          },
          NOW,
        );
        const tasks = Array.from({length: Math.ceil(count / 64)}, (_, chunk) => ({
          record: source,
          project: 'threadnote',
          chunk,
        }));
        tasks.push({record: legacyBatchSubject(1, 'threadnote', [0]), project: 'threadnote', chunk: 0});
        if (reverse) tasks.reverse();
        const before = structuredClone(tasks);
        const task = selectMaintenanceCitationCaseTask(tasks, selected)!;
        expect(task.record.uri).toBe(source.uri);
        expect(task.chunk).toBe(Math.floor(selectedIndex / 64));
        expect(selectMaintenanceCitationCaseTask([...tasks, task], selected)).toBeUndefined();
        expect(selectMaintenanceCitationCaseTask(tasks, {...selected, project: 'other'})).toBeUndefined();
        expect(tasks).toEqual(before);
      }),
      {numRuns: 50},
    );
  });

  effectIt.effect('refreshes an exact stale citation case without sweeping or mutating other memories', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const {repository, file, source} = yield* makeCitationRepository(fixture);
      yield* fixture.fs.writeFileString(file, 'export const supported = false;\n');
      yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const first = yield* runContextMaintenance(fixture.config, {cwd: repository});
      const selected = EffectOption.getOrUndefined(
        EffectArray.findFirst(first.cases, item => item.family === 'citation'),
      )!;
      expect(selected).toBeDefined();
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const before = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
      const terminalHistory = Array.from({length: 200}, (_, index) =>
        updateMaintenanceCase(
          undefined,
          {
            project: 'other',
            memoryId: `tn_history_${index}`,
            family: 'review-overdue',
            slot: 'record',
            evidenceRevision: 'historical',
            disposition: 'resolved',
            reason: 'postcondition-verified',
          },
          NOW,
        ),
      );
      yield* fixture.fs.writeFileString(
        stateFile,
        JSON.stringify({...before, cases: [...before.cases, ...terminalHistory]}),
      );
      const unrelated = record('unrelated', {validTo: '2000-01-01T00:00:00.000Z'});
      const unrelatedFile = fixture.path.join(fixture.directory, 'unrelated.md');
      yield* fixture.fs.writeFileString(unrelatedFile, unrelated.content);
      yield* fixture.fs.writeFileString(file, 'export const supported = "changed again";\n');
      yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const stale = yield* readContextMaintenancePacket(fixture.config, selected.caseId).pipe(Effect.result);
      expect(Result.isFailure(stale) && stale.failure.message).toContain('case is stale');
      const refresh = {cwd: repository, project: 'threadnote', caseId: selected.caseId};
      const result = yield* runContextMaintenance(fixture.config, refresh);
      const packet = yield* readContextMaintenancePacket(fixture.config, selected.caseId);
      expect(packet).toMatchObject({memoryUri: source.uri});
      expect(result.cases).toHaveLength(1);
      expect(result.cases[0].caseId).toBe(selected.caseId);
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
      expect(yield* fixture.fs.readFileString(unrelatedFile)).toBe(unrelated.content);
      const after = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
      expect(after.checkpoints['tn_unrelated:0']).toBeUndefined();
      expect(after.checkpoints).toEqual(before.checkpoints);
      expect(after.workSchedule).toEqual(before.workSchedule);
      expect(after.lastTaskByProject).toEqual(before.lastTaskByProject);
      expect(after.receipts).toEqual(before.receipts);
      const replay = yield* runContextMaintenance(fixture.config, refresh);
      expect(replay.cases[0].attemptCount).toBe(result.cases[0].attemptCount + 1);
      const invalid = yield* runContextMaintenance(fixture.config, {...refresh, project: 'other'}).pipe(Effect.result);
      expect(Result.isFailure(invalid)).toBe(true);
      const {id: _citationId, anchorId: _anchorId, ...baseCitation} = source.metadata.codeCitations![0];
      const multiselector = record(
        'source',
        {
          schemaVersion: 5,
          codeCitations: [
            ...Array.from({length: 1}, (_, index) =>
              createMemoryCodeCitation({
                ...baseCitation,
                path: `unavailable-${index}.ts`,
                sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
              }),
            ),
            ...source.metadata.codeCitations!,
          ],
        },
        source.body,
      );
      yield* fixture.fs.writeFileString(fixture.source, multiselector.content);
      yield* runContextMaintenance(fixture.config, refresh);
      expect(yield* readContextMaintenancePacket(fixture.config, selected.caseId)).toMatchObject({
        memoryUri: source.uri,
      });
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(multiselector.content);
      yield* fixture.fs.writeFileString(file, 'export const supported = true;\n');
      yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const resolved = yield* runContextMaintenance(fixture.config, refresh);
      expect(resolved.cases[0].disposition).toBe('resolved');
      expect(yield* readContextMaintenancePacket(fixture.config, selected.caseId)).toMatchObject({
        memoryUri: source.uri,
      });
      const final = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
      expect(EffectArray.filter(final.cases, item => item.project === 'other')).toEqual(terminalHistory);
      expect(final.checkpoints).toEqual(before.checkpoints);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('stores one unavailable anchor case matching core identity and a bounded packet', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citation = createMemoryCodeCitation({
        extractorSet: 'typescript-v1',
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
        path: 'source.ts',
        repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
        repositoryIdentityKind: 'local',
        sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
        target: {kind: 'file'},
        version: 1,
      });
      const source = record('source', {schemaVersion: 5, codeCitations: [citation]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const waiting = EffectArray.filter(first.cases, item => item.disposition === 'waiting-evidence');
      expect(waiting).toHaveLength(1);
      expect(waiting[0].repositoryId).toBe(citation.repositoryId);
      expect(waiting[0].reason).toBe('repository-unavailable');
      const report = yield* collectContextHealth(fixture.config, 'threadnote', [source], fixture.home, {
        includeCitationCoverageFindings: true,
      });
      expect(waiting[0].caseId).toBe(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(report.findings, item => item.category === 'citation-unknown'),
        )?.caseId,
      );
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
          fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
          path: 'source.ts',
          repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
          repositoryIdentityKind: 'local',
          sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
          target: {kind: 'file'},
          version: 1,
        });
        const source = record('source', {schemaVersion: 5, codeCitations: [citation]});
        yield* fixture.fs.writeFileString(fixture.source, source.content);
        const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        const waiting = EffectOption.getOrUndefined(
          EffectArray.findFirst(first.cases, item => item.disposition === 'waiting-evidence'),
        )!;
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
          EffectArray.flatMap(yield* readContextMaintenanceEvidenceRequests(fixture.config), request => request.uris),
        ).toContain(source.uri);
        const beforeDeadline = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(beforeDeadline.cases, item => item.caseId === waiting.caseId),
          ),
        ).toMatchObject({
          disposition: 'waiting-evidence',
          attemptCount: waiting.attemptCount,
          nextAttemptAt: waiting.nextAttemptAt,
        });
        expect(beforeDeadline.lastProgressAt).toBe(first.lastProgressAt);
        expect(yield* fixture.fs.readFileString(projectionFile)).toBe(projection);
        expect(
          EffectArray.flatMap(yield* readContextMaintenanceEvidenceRequests(fixture.config), request => request.uris),
        ).toContain(source.uri);
        yield* TestClock.adjust('59 seconds');
        const requestedAttempt = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(requestedAttempt.cases, item => item.caseId === waiting.caseId),
          )?.attemptCount,
        ).toBe(waiting.attemptCount);
        expect(yield* fixture.fs.readFileString(projectionFile)).not.toBe(projection);
        expect(
          EffectArray.flatMap(yield* readContextMaintenanceEvidenceRequests(fixture.config), request => request.uris),
        ).not.toContain(source.uri);
        const atDeadline = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(atDeadline.cases, item => item.caseId === waiting.caseId))
            ?.attemptCount,
        ).toBe(waiting.attemptCount + 1);
        yield* TestClock.adjust('4 minutes');
        let exhausted = atDeadline;
        for (
          let tick = 0;
          tick < 4 &&
          EffectOption.getOrUndefined(EffectArray.findFirst(exhausted.cases, item => item.caseId === waiting.caseId))
            ?.attemptCount !== 3;
          tick++
        )
          exhausted = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
        const terminalWait = EffectOption.getOrUndefined(
          EffectArray.findFirst(exhausted.cases, item => item.caseId === waiting.caseId),
        )!;
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
        relations: [{type: 'references', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'target.md'))}],
      });
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, 'target.md'),
        record('target', {}, 'Independent target claim.').content,
      );
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(yield* fixture.fs.exists(fixture.source)).toBe(false);
      const archive = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          yield* readMaintenanceMemoryRecords(fixture.config),
          item => item.metadata.archivedFrom === source.uri,
        ),
      )!;
      expect(archive.metadata.memoryId).toBe(source.metadata.memoryId);
      expect(archive.metadata.relations).toEqual(source.metadata.relations);
      const receipt = EffectOption.getOrUndefined(
        EffectArray.findFirst(first.receipts, item => item.subjectUri === source.uri),
      )!;
      expect(yield* undoContextMaintenance(fixture.config, receipt.receiptId)).toMatchObject({
        status: 'conflict',
        reason: 'validity-policy-still-expired',
      });
      expect(
        EffectArray.filter(
          (yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).receipts,
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
        relations: [{type: 'depends_on', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))}],
      });
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, '000-source.md'), source.content);
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(result.projects[0].checked).toBe(1);
      expect(result.receipts).toHaveLength(0);
      expect(result.preparation?.complete).toBe(false);
      expect(result.preparation?.incompleteReason).toBe('inventory-discovery-incomplete');
      expect(EffectArray.some(result.cases, item => item.reason === 'inventory-preparation-incomplete')).toBe(true);
      for (let index = 0; index < 10; index++)
        yield* prepareContextMaintenanceInventory(fixture.config, undefined, 256);
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      const prepared = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(result.cases, item => item.family === 'review-overdue'))
          ?.disposition,
      ).toBe('needs-decision');
      let failurePacket: string | undefined;
      if (prepared.receipts.length !== 1) {
        const state = decodeJson(
          MaintenanceStateProbeSchema,
          JSON.parse(
            yield* fixture.fs.readFileString(fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json')),
          ),
        );
        const sourceKey = `${source.metadata.memoryId}:0`;
        const checkpoint = state.checkpoints[sourceKey];
        failurePacket = JSON.stringify({
          preparation: {
            complete: prepared.preparation?.complete,
            reason: prepared.preparation?.incompleteReason,
            admittedRecords: prepared.preparation?.admittedRecords,
            omittedRecords: prepared.preparation?.omittedRecords,
          },
          phase: state.workSchedule?.nextPhase,
          cursorIsSource: state.lastTaskByProject?.threadnote === sourceKey,
          checked: prepared.projects[0]?.checked,
          eligible: prepared.projects[0]?.eligible,
          sourceCheckpoint: checkpoint
            ? {
                inventoryComplete: checkpoint.inventoryComplete,
                hasRetry: checkpoint.retryAt !== undefined,
                hasMemoryHash: checkpoint.memoryHash !== undefined,
              }
            : null,
          sourceCases: EffectArray.map(
            EffectArray.take(
              EffectArray.filter(prepared.cases, item => item.memoryId === source.metadata.memoryId),
              8,
            ),
            item => ({family: item.family, disposition: item.disposition, reason: item.reason}),
          ),
          receipts: {
            total: prepared.receipts.length,
            source: EffectArray.filter(prepared.receipts, item => item.subjectUri === source.uri).length,
          },
        });
      }
      expect(prepared.receipts, failurePacket).toHaveLength(1);
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(result.cases, item => item.family === 'review-overdue'))
          ?.disposition,
      ).toBe('needs-decision');
      expect(result.counts?.decisionMemories).toBe(1);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps anchor identities and rechecks unchanged memory after source events', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citations = Array.from({length: 8}, (_, index) =>
        createMemoryCodeCitation({
          extractorSet: 'typescript-v1',
          fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
          path: `source-${index}.ts`,
          repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
          repositoryIdentityKind: 'local',
          sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
          target: {kind: 'file'},
          version: 1,
        }),
      );
      const source = record('source', {schemaVersion: 5, codeCitations: citations});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 2});
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const before = decodeJson(
        Schema.StructWithRest(
          Schema.Struct({
            cases: Schema.Array(
              Schema.StructWithRest(
                Schema.Struct({
                  caseId: Schema.String,
                  slot: Schema.String,
                  attemptCount: Schema.Finite,
                  evidenceRevision: Schema.String,
                }),
                [JsonRecordSchema],
              ),
            ),
          }),
          [JsonRecordSchema],
        ),
        JSON.parse(yield* fixture.fs.readFileString(stateFile)),
      );
      const anchors = EffectArray.filter(
        before.cases,
        (item, index) => index in before.cases && Effect2.pipe(item.slot, EffectString.startsWith('anchor:')),
      );
      expect(anchors).toHaveLength(8);
      expect(new Set(EffectArray.map(anchors, item => item.caseId)).size).toBe(8);
      expect(EffectArray.some(anchors, item => item.slot === `anchor:${citations[7].id}`)).toBe(true);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.home, 'source-7.ts'), 'Source event.');
      const staleSourcePacket = yield* readContextMaintenancePacket(
        fixture.config,
        EffectOption.getOrUndefined(EffectArray.findFirst(anchors, item => item.slot === `anchor:${citations[7].id}`))!
          .caseId,
      ).pipe(Effect.result);
      expect(Result.isFailure(staleSourcePacket) && staleSourcePacket.failure.message).toContain(
        'Source evidence changed',
      );
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 2});
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 2});
      const after = decodeJson(CasesProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(after.cases, item => item.slot === `anchor:${citations[7].id}`),
        ),
      ).toMatchObject({
        caseId: EffectOption.getOrUndefined(
          EffectArray.findFirst(anchors, item => item.slot === `anchor:${citations[7].id}`),
        )!.caseId,
        attemptCount: 1,
      });
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(after.cases, item => item.slot === `anchor:${citations[7].id}`),
        )!.evidenceRevision,
      ).not.toBe(
        EffectOption.getOrUndefined(EffectArray.findFirst(anchors, item => item.slot === `anchor:${citations[7].id}`))!
          .evidenceRevision,
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
        const restoredFile = fixture.path.join(
          fixture.directory,
          Effect2.pipe(receipt.subjectUri, EffectString.split('/')).at(-1)!,
        );
        expect(yield* fixture.fs.exists(restoredFile)).toBe(false);
        const journalFile = fixture.path.join(
          fixture.home,
          'context-maintenance',
          'receipts',
          `${receipt.receiptId}.json`,
        );
        const journal = decodeJson(
          Schema.StructWithRest(Schema.Struct({state: Schema.String}), [JsonRecordSchema]),
          JSON.parse(yield* fixture.fs.readFileString(journalFile)),
        );
        yield* fixture.fs.writeFileString(journalFile, JSON.stringify({...journal, state: 'applying'}));
        const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
        const state = decodeJson(
          Schema.StructWithRest(Schema.Struct({receipts: Schema.Array(Schema.Unknown)}), [JsonRecordSchema]),
          JSON.parse(yield* fixture.fs.readFileString(stateFile)),
        );
        yield* fixture.fs.writeFileString(stateFile, JSON.stringify({...state, receipts: []}));
        const recovered = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(recovered.receipts, item => item.receiptId === receipt.receiptId),
          )?.state,
        ).toBe('applied');
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
      const semantic = EffectOption.getOrUndefined(
        EffectArray.findFirst(health.findings, item => item.category === 'semantic-contradiction'),
      )!;
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const maintained = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(maintained.cases, item => item.caseId === semantic.caseId))
          ?.disposition,
      ).toBe('needs-decision');
      expect(maintained.counts?.decisionMemories).toBe(2);
      const packet = yield* readContextMaintenancePacket(fixture.config, semantic.caseId!);
      expect('relatedMemories' in packet && packet.relatedMemories).toHaveLength(2);
      yield* fixture.fs.writeFileString(targetFile, record('target', {status: 'archived'}, target.body).content);
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            (yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).cases,
            item => item.caseId === semantic.caseId,
          ),
        ),
      ).toMatchObject({
        disposition: 'historical',
        reason: 'semantic-analyzer-v2-evidence-superseded',
      });
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'supersedes obsolete analyzer cases under partial extraction while preserving memory and review history',
    () =>
      Effect.gen(function* () {
        for (const disjoint of [false, true]) {
          const fixture = yield* makeFixture();
          const source = record(
            'source',
            {},
            `${disjoint ? 'Production deployments must use signed artifacts.' : 'Agents must retain deterministic evidence.'}\nIndependent unsupported prose.`,
          );
          const target = record(
            'target',
            {},
            disjoint
              ? 'Local deployments must not use signed artifacts.'
              : 'Agents must not retain deterministic evidence.',
          );
          yield* fixture.fs.writeFileString(fixture.source, source.content);
          const targetFile = fixture.path.join(fixture.directory, 'target.md');
          yield* fixture.fs.writeFileString(targetFile, target.content);
          yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
          const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
          const state = JSON.parse(yield* fixture.fs.readFileString(stateFile));
          const now = '2026-01-01T00:00:00.000Z';
          const legacy = {
            ...updateMaintenanceCase(
              undefined,
              {
                project: 'threadnote',
                memoryId: 'tn_source:tn_target',
                family: 'semantic-contradiction',
                slot: `${Effect2.pipe('a', EffectString.repeat(64))}:${Effect2.pipe('b', EffectString.repeat(64))}`,
                evidenceRevision: 'legacy-v1-generation',
                disposition: 'needs-decision',
                reason: 'opposing-canonical-claims',
              },
              now,
            ),
            subjectContentHashes: EffectArray.map([source, target], record => ({
              uri: record.uri,
              hash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
            })),
          };
          state.cases = [legacy];
          state.semanticProgress = {
            threadnote: {
              generation: 'legacy-v1-generation',
              cursor: 1,
              totalBatches: 1,
              eligibleRecords: 2,
              partial: false,
            },
          };
          state.workSchedule = {nextPhase: 'semantic'};
          yield* fixture.fs.writeFileString(stateFile, JSON.stringify(state));
          const current = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
          expect(current.semanticCoverage?.[0].state).toBe('partial');
          const retained = EffectOption.getOrUndefined(
            EffectArray.findFirst(current.cases, item => item.caseId === legacy.caseId),
          )!;
          expect(retained).toMatchObject({
            disposition: 'historical',
            reason: 'semantic-analyzer-v2-evidence-superseded',
            firstSeen: legacy.firstSeen,
            evidenceRevision: legacy.evidenceRevision,
            subjectContentHashes: legacy.subjectContentHashes,
          });
          expect(retained.events).toEqual(expect.arrayContaining([...legacy.events]));
          expect(retained.events.at(-1)?.reason).toBe('semantic-analyzer-v2-evidence-superseded');
          const decisions = EffectArray.filter(
            current.cases,
            item => item.family === 'semantic-contradiction' && item.disposition === 'needs-decision',
          );
          expect(decisions).toHaveLength(disjoint ? 0 : 1);
          if (!disjoint) {
            const packet = yield* readContextMaintenancePacket(fixture.config, decisions[0].caseId);
            expect('semanticEvidence' in packet && packet.semanticEvidence?.left.text).toBe(
              'Agents must retain deterministic evidence.',
            );
            expect('semanticEvidence' in packet && packet.semanticEvidence?.right.text).toBe(
              'Agents must not retain deterministic evidence.',
            );
          }
          expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
          expect(yield* fixture.fs.readFileString(targetFile)).toBe(target.content);
        }
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
      const caseId = EffectOption.getOrUndefined(
        EffectArray.findFirst(health.findings, item => item.category === 'semantic-contradiction'),
      )!.caseId!;
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const maintained = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const semantic = EffectOption.getOrUndefined(
        EffectArray.findFirst(maintained.cases, item => item.caseId === caseId),
      )!;
      expect(semantic.disposition).toBe('needs-decision');
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(semantic.subjectContentHashes), hashes =>
            EffectArray.map(hashes, subject => subject.uri).sort(),
          ),
        ),
      ).toEqual([source.uri, target.uri].sort());
      expect(maintained.counts?.decisionMemories).toBe(2);
      const packet = yield* readContextMaintenancePacket(fixture.config, caseId);
      expect('relatedMemories' in packet && packet.relatedMemories).toHaveLength(2);
      const replay = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(replay.cases, item => item.caseId === caseId))?.disposition,
      ).toBe('needs-decision');
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
            record(
              `m-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}`,
              {},
              'Independent historical context.',
            ),
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
      const caseId = EffectOption.getOrUndefined(
        EffectArray.findFirst(health.findings, item => item.category === 'semantic-contradiction'),
      )!.caseId!;
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(first.semanticCoverage?.[0].state).toBe('partial');
      expect(EffectArray.some(first.cases, item => item.caseId === caseId)).toBe(false);
      for (let tick = 0; tick < 5; tick++)
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      const status = yield* readContextMaintenanceStatus(fixture.config);
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(status.cases, item => item.caseId === caseId))?.disposition,
      ).toBe('needs-decision');
      const packet = yield* readContextMaintenancePacket(fixture.config, caseId);
      expect('relatedMemories' in packet && packet.relatedMemories).toHaveLength(2);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'resumes full claim comparisons across persisted ticks and retains unaffected progress after an edit',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const filler = EffectArray.join(
          Array.from(
            {length: 16},
            (_, index) => `Worker token${String.fromCharCode(97 + index)} must retain verified context.`,
          ),
          '\n',
        );
        const subject = EffectOption.getOrUndefined(
          EffectArray.findFirst(
            Array.from(
              {length: 100},
              (_, index) =>
                `Deployment policy${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
            ),
            candidate =>
              EffectOption.getOrElse(
                EffectArray.findFirstIndex(
                  extractContextHealthSemanticClaims(
                    record('a-source', {}, `${filler}\n${candidate} must use signed artifacts.`),
                  ).claims,
                  claim => Effect2.pipe(claim.text, EffectString.startsWith(candidate)),
                ),
                () => -1,
              ) >= 16,
          ),
        )!;
        const subjects = [
          record('a-source', {}, `${filler}\n${subject} must use signed artifacts.`),
          ...Array.from({length: 16}, (_, index) =>
            record(`m-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`, {}, filler),
          ),
          record('z-target', {}, `${filler}\n${subject} must not use signed artifacts.`),
        ];
        for (const subject of subjects)
          yield* fixture.fs.writeFileString(
            fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
            subject.content,
          );
        const contradiction = findContextHealthSemanticContradiction([subjects[0], subjects.at(-1)!])!;
        expect(contradiction).toBeDefined();
        for (let page = 0; page < 3; page++) yield* prepareContextMaintenanceInventory(fixture.config, undefined, 256);
        let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 4});
        for (let tick = 0; tick < 32 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
          status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 4});
        expect(status.semanticCoverage?.[0]).toMatchObject({
          extractionComplete: true,
          comparisonComplete: true,
          totalRecords: 18,
          unsupportedClaims: 0,
          outputOmittedFindings: 0,
        });
        const retained = EffectOption.getOrUndefined(
          EffectArray.findFirst(
            status.cases,
            item =>
              item.family === 'semantic-contradiction' &&
              item.slot ===
                EffectArray.join(
                  [contradiction.left.claimFingerprint, contradiction.right.claimFingerprint].sort(),
                  ':',
                ) &&
              item.disposition === 'needs-decision',
          ),
        );
        expect(retained).toBeDefined();
        const packet = yield* readContextMaintenancePacket(fixture.config, retained!.caseId);
        expect('semanticEvidence' in packet && packet.semanticEvidence?.contradictionId).toBe(
          contradiction.contradictionId,
        );
        const completed = status.semanticCoverage![0].checkedBatches;
        const edited = {
          ...subjects[1],
          content: `${subjects[1].content}\nWorker tokensafe must retain verified context.`,
        };
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${subjects[1].metadata.topic}.md`),
          edited.content,
        );
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 4});
        expect(status.semanticCoverage?.[0].checkedBatches).toBe(completed);
        expect(status.semanticCoverage?.[0].state).toBe('partial');
        for (let tick = 0; tick < 32 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
          status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 4});
        expect(status.semanticCoverage?.[0].comparisonComplete).toBe(true);
        expect(
          EffectArray.filter(
            status.cases,
            item =>
              item.family === 'semantic-contradiction' &&
              item.disposition === 'needs-decision' &&
              item.slot === retained!.slot,
          ),
        ).toHaveLength(1);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains findings beyond the direct output cap across maintenance pages', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const subjects = Array.from({length: 22}, (_, index) =>
        record(
          `output-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
          {},
          `Agents must ${index >= 11 ? 'not ' : ''}load verified context.`,
        ),
      );
      for (const subject of subjects)
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
          subject.content,
        );
      for (let page = 0; page < 3; page++) yield* prepareContextMaintenanceInventory(fixture.config, undefined, 256);
      let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 4});
      for (let tick = 0; tick < 40 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 4});
      expect(status.semanticCoverage?.[0]).toMatchObject({comparisonComplete: true, outputOmittedFindings: 0});
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const persisted = decodeJson(
        MaintenanceStateProbeSchema,
        JSON.parse(yield* fixture.fs.readFileString(stateFile)),
      );
      expect(
        EffectArray.filter(
          persisted.cases,
          item => item.family === 'semantic-contradiction' && item.disposition === 'needs-decision',
        ),
      ).toHaveLength(121);
      expect(status.omittedCases).toBeGreaterThan(0);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps another project semantic decision current during a scoped scan', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const subjects = [
        record('a', {project: 'project-a'}, 'Agents must retain verified context.'),
        record('b-positive', {project: 'project-b'}, 'Deployments must use signed artifacts.'),
        record('b-negative', {project: 'project-b'}, 'Deployments must not use signed artifacts.'),
      ];
      for (const subject of subjects) {
        const directory = fixture.path.join(fixture.path.dirname(fixture.directory), subject.metadata.project!);
        yield* fixture.fs.makeDirectory(directory, {recursive: true});
        yield* fixture.fs.writeFileString(
          fixture.path.join(directory, `${subject.metadata.topic}.md`),
          subject.content,
        );
      }
      let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      for (let tick = 0; tick < 12 && !EffectArray.some(status.cases, item => item.project === 'project-b'); tick++)
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const decision = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          status.cases,
          item => item.project === 'project-b' && item.family === 'semantic-contradiction',
        ),
      )!;
      expect(decision?.disposition).toBe('needs-decision');
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, project: 'project-a'});
      const retained = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, project: 'project-b'});
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(retained.cases, item => item.caseId === decision.caseId))
          ?.disposition,
      ).toBe('needs-decision');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('supersedes prior analyzer cases and restarts completed extraction on unchanged sources', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      for (const subject of [
        record('version-positive', {}, 'Agents must load verified context.'),
        record('version-negative', {}, 'Agents must not load verified context.'),
      ])
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
          subject.content,
        );
      let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      for (let tick = 0; tick < 8 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const decision = EffectOption.getOrUndefined(
        EffectArray.findFirst(status.cases, item => item.family === 'semantic-contradiction'),
      )!;
      expect(decision.disposition).toBe('needs-decision');
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const saved = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
      yield* fixture.fs.writeFileString(
        stateFile,
        JSON.stringify({
          ...saved,
          semanticProgress: {
            ...saved.semanticProgress,
            threadnote: {...saved.semanticProgress!.threadnote, analyzerVersion: 1},
          },
          workSchedule: {nextPhase: 'records'},
        }),
      );
      status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(status.cases, item => item.caseId === decision.caseId)),
      ).toMatchObject({
        disposition: 'historical',
        reason: 'semantic-analyzer-v2-evidence-superseded',
      });
      expect(status.semanticCoverage?.[0]).toMatchObject({comparisonComplete: false, extractionComplete: false});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'finishes dense supported comparisons with explicit output omissions and recovers after an edit',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const sentence = 'Agents must load verified context.';
        const opposite = 'Agents must not load verified context.';
        const positive = record('dense-positive', {}, EffectArray.join(Array<string>(512).fill(sentence), '\n'));
        const negative = record('dense-negative', {}, EffectArray.join(Array<string>(512).fill(opposite), '\n'));
        const neutral = record('dense-neutral', {}, 'Worker tokenneutral must retain verified context.');
        const handoff = record('dense-handoff', {kind: 'handoff'}, 'A temporary task handoff.');
        for (const subject of [positive, negative, neutral, handoff])
          yield* fixture.fs.writeFileString(
            fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
            subject.content,
          );
        let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        for (let tick = 0; tick < 80 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
          status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(status.semanticCoverage?.[0]).toMatchObject({
          comparisonComplete: true,
          outputOmittedFindings: 512 * 512 - 512,
          state: 'partial',
        });
        const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
        const saved = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
        expect(EffectArray.filter(saved.cases, item => item.family === 'semantic-contradiction')).toHaveLength(512);
        expect((yield* fixture.fs.stat(stateFile)).size).toBeLessThan(16 * 1_024 * 1_024);
        const completedPairs = status.semanticCoverage![0].checkedBatches;
        const churn = status.semanticCoverage![0].churnCount;
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, 'dense-handoff.md'),
          record('dense-handoff', {kind: 'handoff'}, 'An updated temporary task handoff.').content,
        );
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(status.semanticCoverage?.[0]).toMatchObject({
          checkedBatches: completedPairs,
          churnCount: churn,
          outputOmittedFindings: 512 * 512 - 512,
        });
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, 'dense-neutral.md'),
          record('dense-neutral', {}, 'Worker tokenupdated must retain verified context.').content,
        );
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(status.semanticCoverage?.[0]).toMatchObject({
          checkedBatches: completedPairs,
          outputOmittedFindings: 512 * 512 - 512,
        });
        for (let tick = 0; tick < 8 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
          status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(status.semanticCoverage?.[0].outputOmittedFindings).toBe(512 * 512 - 512);
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, 'dense-negative.md'),
          record('dense-negative', {}, 'Agents must not load verified context.').content,
        );
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        for (let tick = 0; tick < 8 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
          status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(status.semanticCoverage?.[0]).toMatchObject({comparisonComplete: true, outputOmittedFindings: 0});
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps cumulative comparisons monotonic when an edited pair shrinks below its cursor', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      for (const [name, negated] of [
        ['many-positive', false],
        ['many-negative', true],
      ] as const)
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${name}.md`),
          record(
            name,
            {},
            EffectArray.join(
              Array<string>(128).fill(`Agents must ${negated ? 'not ' : ''}load verified context.`),
              '\n',
            ),
          ).content,
        );
      let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      for (let tick = 0; tick < 8 && (status.semanticCoverage?.[0]?.comparedClaimPairs ?? 0) < 8_192; tick++)
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const before = status.semanticCoverage![0].comparedClaimPairs;
      expect(before).toBeGreaterThanOrEqual(8_192);
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, 'many-negative.md'),
        record('many-negative', {}, 'Agents must not load verified context.').content,
      );
      for (let tick = 0; tick < 5; tick++) {
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(status.semanticCoverage![0].comparedClaimPairs).toBeGreaterThanOrEqual(before);
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('bounds output ledgers across projects when UTF-8 state headroom is exhausted', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      for (const project of ['project-a', 'project-b']) {
        const directory = fixture.path.join(fixture.path.dirname(fixture.directory), project);
        yield* fixture.fs.makeDirectory(directory, {recursive: true});
        for (const [name, negated] of [
          ['positive', false],
          ['negative', true],
        ] as const)
          yield* fixture.fs.writeFileString(
            fixture.path.join(directory, `${project}-${name}.md`),
            record(`${project}-${name}`, {project}, `Agents must ${negated ? 'not ' : ''}load verified context.`)
              .content,
          );
      }
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const saved = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
      const base = new TextEncoder().encode(JSON.stringify(saved)).length;
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
      const padding = '🚀'.repeat(Math.floor((16 * 1_024 * 1_024 - 128 * 1_024 - base) / 4));
      yield* fixture.fs.writeFileString(
        stateFile,
        JSON.stringify({...saved, policyOverrides: {padding}, workSchedule: {nextPhase: 'semantic'}}),
      );
      let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      for (
        let tick = 0;
        tick < 12 &&
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(status.semanticCoverage), findArray =>
            EffectArray.some(findArray, item => !item.comparisonComplete),
          ),
        );
        tick++
      )
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(status.semanticCoverage).toHaveLength(2);
      for (const coverage of status.semanticCoverage!)
        expect(coverage).toMatchObject({comparisonComplete: true, outputOmittedFindings: 1, state: 'partial'});
      const persisted = decodeJson(
        MaintenanceStateProbeSchema,
        JSON.parse(yield* fixture.fs.readFileString(stateFile)),
      );
      for (const progress of EffectRecord.values(persisted.semanticProgress ?? {})) {
        expect(progress.omissionPairsOverflow).toBe(true);
        expect(progress.omissionPairs).toEqual([]);
      }
      expect(Number((yield* fixture.fs.stat(stateFile)).size)).toBeLessThan(16 * 1_024 * 1_024);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recounts an overflowing pair once across overlapping dirty and main passes', () =>
    Effect.gen(function* () {
      for (const completedMainScan of [true, false]) {
        const fixture = yield* makeFixture();
        for (const subject of [
          record('overlap-a', {}, 'Workers must retain verified context.'),
          record('overlap-b', {}, 'Deployments must use signed artifacts.'),
        ])
          yield* fixture.fs.writeFileString(
            fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
            subject.content,
          );
        let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        if (completedMainScan)
          for (let tick = 0; tick < 8 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
            status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
        const saved = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
        const base = new TextEncoder().encode(JSON.stringify(saved)).length;
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        const padding = '🚀'.repeat(Math.floor((16 * 1_024 * 1_024 - 128 * 1_024 - base) / 4));
        yield* fixture.fs.writeFileString(
          stateFile,
          JSON.stringify({...saved, policyOverrides: {padding}, workSchedule: {nextPhase: 'semantic'}}),
        );
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, 'overlap-a.md'),
          record('overlap-a', {}, 'Agents must load verified context.').content,
        );
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, 'overlap-b.md'),
          record('overlap-b', {}, 'Agents must not load verified context.').content,
        );
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(status.semanticCoverage?.[0]?.comparisonComplete).toBe(false);
        for (let tick = 0; tick < 12 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
          status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(status.semanticCoverage?.[0]).toMatchObject({
          comparisonComplete: true,
          outputOmittedFindings: 1,
          state: 'partial',
        });
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(status.semanticCoverage?.[0]).toMatchObject({comparisonComplete: true, outputOmittedFindings: 1});
        expect(Number((yield* fixture.fs.stat(stateFile)).size)).toBeLessThan(16 * 1_024 * 1_024);
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves the project output cap when historical findings reappear', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const positive = record('a-positive', {}, 'Agents must load verified context.');
      const negative = record(
        'b-negative',
        {},
        EffectArray.join(Array<string>(512).fill('Agents must not load verified context.'), '\n'),
      );
      for (const subject of [positive, negative])
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
          subject.content,
        );
      let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      for (let tick = 0; tick < 10 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const first = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
      expect(EffectArray.filter(first.cases, item => item.family === 'semantic-contradiction')).toHaveLength(512);
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, 'a-positive.md'),
        record('a-positive', {}, 'Worker tokenneutral must retain verified context.').content,
      );
      status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      for (let tick = 0; tick < 8 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const third = record('c-positive', {}, 'Agents must load verified context.');
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'c-positive.md'), third.content);
      status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      for (let tick = 0; tick < 40 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'a-positive.md'), positive.content);
      status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      for (let tick = 0; tick < 40 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const saved = decodeJson(MaintenanceStateProbeSchema, JSON.parse(yield* fixture.fs.readFileString(stateFile)));
      const semantic = EffectArray.filter(saved.cases, item => item.family === 'semantic-contradiction');
      expect(EffectArray.filter(semantic, item => item.disposition === 'needs-decision')).toHaveLength(512);
      expect(EffectArray.filter(semantic, item => item.disposition === 'historical')).toHaveLength(512);
      expect(status.semanticCoverage?.[0]).toMatchObject({comparisonComplete: true, outputOmittedFindings: 512});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retires removed source evidence while finishing surviving extraction', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('a-source', {}, 'Agents must load verified context.');
      const target = record('z-target', {}, 'Agents must not load verified context.');
      for (const subject of [source, target])
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
          subject.content,
        );
      let status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      for (let tick = 0; tick < 6 && !status.semanticCoverage?.[0]?.comparisonComplete; tick++)
        status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const decision = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          status.cases,
          item => item.family === 'semantic-contradiction' && item.disposition === 'needs-decision',
        ),
      )!;
      expect(decision).toBeDefined();
      yield* fixture.fs.remove(fixture.path.join(fixture.directory, 'z-target.md'));
      for (let tick = 0; tick < 8; tick++) status = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(
        EffectOption.getOrUndefined(EffectArray.findFirst(status.cases, item => item.caseId === decision.caseId))
          ?.disposition,
      ).toBe('historical');
      expect(status.semanticCoverage?.[0]).toMatchObject({
        extractionComplete: true,
        comparisonComplete: true,
        totalRecords: 1,
      });
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs proven dangling relations once, persists pause/restart, and rejects unsafe undo', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {
        relations: [{type: 'depends_on', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))}],
      });
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(first.receipts).toHaveLength(1);
      expect(EffectArray.some(first.cases, item => item.disposition === 'retired')).toBe(true);
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
        const artifacts = EffectArray.map(relatives, (relative, index) => ({
          file: fixture.path.join(root, relative),
          uri: `threadnote://user/tester/memories/${relative}`,
          // A reserved artifact remains tooling even if its text resembles a memory header.
          content: index === 3 ? record('artifact').content : `---\nname: synthetic-tool\n---\n${body}`,
        }));
        for (const artifact of artifacts) {
          yield* fixture.fs.makeDirectory(fixture.path.dirname(artifact.file), {recursive: true});
          yield* fixture.fs.writeFileString(artifact.file, artifact.content);
        }
        const relations = EffectArray.map(artifacts, artifact => ({type: 'depends_on' as const, uri: artifact.uri}));
        const source = record('source', {
          relations: [
            ...relations,
            {type: 'depends_on', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))},
          ],
        });
        yield* fixture.fs.writeFileString(fixture.source, source.content);
        const inventory = yield* prepareContextMaintenanceInventory(fixture.config, undefined, 100);
        expect(inventory.complete).toBe(true);
        expect(EffectArray.map(inventory.records, record => record.uri)).toEqual([URI]);
        expect(
          EffectArray.map(
            yield* readMaintenanceMemoryRecords(fixture.config, {requireReadable: true}),
            record => record.uri,
          ),
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
        expect(result.error).toBeUndefined();
        expect(result.preparation).toMatchObject({
          complete: false,
          omittedRecords: 1,
          incompleteReason: 'inventory-records-omitted',
          diagnostics: [{category: 'invalid-header', stage: 'record-read', retryable: false}],
        });
        expect(result.preparation?.diagnostics?.[0].memoryUri).toContain(relative);
        expect(result.receipts).toHaveLength(0);
        expect(yield* fixture.fs.readFileString(file)).toBe(content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    );

  effectIt.effect('preserves unreadable corpus records and never turns them into target absence', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {
        relations: [{type: 'depends_on', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))}],
      });
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'missing.md'), 'Malformed but present.');
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(result.error).toBeUndefined();
      expect(result.preparation).toMatchObject({
        complete: false,
        admittedRecords: 1,
        omittedRecords: 1,
        incompleteReason: 'inventory-records-omitted',
        diagnostics: [
          {
            version: 1,
            category: 'invalid-header',
            stage: 'record-read',
            memoryUri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md')),
            retryable: false,
          },
        ],
      });
      expect(result.cases).toContainEqual(
        expect.objectContaining({disposition: 'waiting-evidence', reason: 'inventory-preparation-incomplete'}),
      );
      expect(JSON.stringify(result.preparation)).not.toContain('Malformed but present.');
      expect(renderContextMaintenanceStatus(result)).toContain('missing.md');
      expect(renderContextMaintenanceStatus(result)).toContain('backup');
      expect((yield* readContextMaintenanceStatus(fixture.config)).preparation).toEqual(result.preparation);
      expect(result.receipts).toHaveLength(0);
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
      const target = record('missing');
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'missing.md'), target.content);
      const recovered = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(recovered.error).toBeUndefined();
      expect(recovered.preparation?.complete).toBe(true);
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
          expect(result.preparation).toMatchObject({
            complete: false,
            admittedRecords: 0,
            omittedRecords: 1,
            incompleteReason: 'inventory-records-omitted',
            diagnostics: [{category: 'record-changed', stage: 'record-read', retryable: true, memoryUri: URI}],
          });
          expect((yield* readContextMaintenanceStatus(fixture.config)).preparation).toEqual(result.preparation);
          expect(JSON.stringify(result.preparation)).not.toContain('Synthetic private');
          expect(JSON.stringify(result.preparation)).not.toContain('/synthetic/private/path');
        } else {
          expect(opens).toBeGreaterThanOrEqual(2);
          expect(result.state).not.toBe('failed');
          expect(result.error).toBeUndefined();
        }
        expect(result.error).toBeUndefined();
        expect(result.receipts).toHaveLength(0);
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
          {type: 'depends_on', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))},
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
      expect(yield* fixture.fs.readFileString(fixture.path.join(shared, 'guide.md'))).toBe(
        '---\ntitle: Guide\n---\nAncillary docs.',
      );
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('undo requires the exact post-repair CAS even after the target becomes readable', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {
        relations: [{type: 'depends_on', uri: Effect2.pipe(URI, EffectString.replace('source.md', 'missing.md'))}],
      });
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
    yield* fs.makeDirectory(path.join(home, 'context-maintenance'), {recursive: true});
    yield* fs.writeFileString(
      path.join(home, 'context-maintenance/control-v1.json'),
      JSON.stringify({version: 1, paused: false}),
    );
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

it('selects the exact legacy coverage batch and requires every selected current receipt', () => {
  const subject = legacyBatchSubject(
    0,
    'threadnote',
    Array.from({length: 67}, () => 0),
  );
  const first = selectedMaintenanceCitations(subject, {family: 'citation-coverage', slot: '0'});
  const later = selectedMaintenanceCitations(subject, {family: 'citation-coverage', slot: '1'});
  expect(EffectArray.map(first, value => value.id)).toEqual(
    EffectArray.map(subject.metadata.codeCitations.slice(0, 64), value => value.id),
  );
  expect(EffectArray.map(later, value => value.id)).toEqual(
    EffectArray.map(subject.metadata.codeCitations.slice(64, 128), value => value.id),
  );
  expect(later).toHaveLength(3);
  const exact = (citationId: string) => ({
    citationId,
    strategy: 'content-hash' as const,
    validatorVersion: CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
    status: 'exact' as const,
    coverage: 'current-complete' as const,
    provenance: 'current-verified' as const,
    reason: 'exact' as const,
    kind: 'file' as const,
    candidateCount: 1,
    observedAt: NOW,
  });
  const full = EffectArray.map(later, value => exact(value.id));
  expect(maintenanceCoverageCurrent(subject.uri, later, [{uri: subject.uri, receipts: full}])).toBe(true);
  expect(
    maintenanceCoverageCurrent(subject.uri, later, [
      {uri: subject.uri, receipts: EffectArray.map(first, value => exact(value.id))},
    ]),
  ).toBe(false);
  expect(maintenanceCoverageCurrent(subject.uri, later, [{uri: subject.uri, receipts: full.slice(0, 1)}])).toBe(false);
  expect(
    maintenanceCoverageCurrent(subject.uri, later, [
      {
        uri: subject.uri,
        receipts: [
          full[0],
          {...full[1], status: 'unknown', reason: 'graph-incomplete', coverage: 'incomplete'},
          full[2],
        ],
      },
    ]),
  ).toBe(false);
  expect(
    maintenanceCoverageCurrent(subject.uri, later, [
      {uri: subject.uri, receipts: EffectArray.map(full, value => ({...value, provenance: 'historical-verified'}))},
    ]),
  ).toBe(false);
  expect(maintenanceCoverageCurrent(subject.uri, later, [{uri: 'threadnote://other', receipts: full}])).toBe(false);
});
