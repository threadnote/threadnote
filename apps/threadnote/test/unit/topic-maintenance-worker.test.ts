import {handleManagerAttentionAction} from '../../src/manager/attention_actions.js';
import {refreshContextMaintenanceCase} from '../../src/memory/context/maintenance_refresh.js';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Fiber, Layer, Option, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import * as BunServices from '@effect/platform-bun/BunServices';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {runCommandEffect} from '@threadnote/platform/command';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {proposeTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {parseTopicMaintenanceDraft} from '@threadnote/memory/topic-maintenance-draft';
import {
  selectMaintenanceWorkPhase,
  type MaintenanceWorkSchedule,
} from '../../src/memory/context/maintenance_decisions.js';
import {
  readContextMaintenancePacket,
  readContextMaintenanceStatus,
  reconcileAcceptedTopicMaintenanceCase,
  recordTopicMaintenanceReviewDecision,
  runContextMaintenance,
  type ContextMaintenanceCaseV2,
  type MaintenanceState,
} from '../../src/memory/context/maintenance.js';
import {publicStatus} from '../../src/memory/context/maintenance_projection.js';
import {memoryContentWithCitationReplacementsV1} from '../../src/memory/context/health_repair.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  advanceTopicMaintenanceCursor,
  boundedTopicMaintenanceCheckpoint,
  deferTopicMaintenanceCase,
  enrolledTopicRecord,
  pruneAbsentTopicCheckpoints,
  selectRetainedMaintenanceCases,
  selectTopicMaintenanceRecord,
  stateWithAcceptedTopicObservation,
  reconcileAcceptedTopicMaintenanceState,
  topicMaintenanceCaseId,
  validTopicMaintenanceCheckpoints,
} from '../../src/memory/context/maintenance_topic.js';
import {basisFromPacket, readyEvidence, reviewEvidenceFromPacket} from '../../src/memory/context/maintenance_draft.js';
import {privateReview} from '../../src/memory/context/maintenance_draft.js';
import {
  applyTopicMaintenanceReview,
  prepareTopicMaintenanceReview,
} from '../../src/memory/context/maintenance_review.js';
import {saveCandidateReview} from '@threadnote/memory/candidate';

const at = '2026-10-16T00:00:00.000Z';
function topicCase(id: number, disposition: ContextMaintenanceCaseV2['disposition']): ContextMaintenanceCaseV2 {
  return {
    caseId: topicMaintenanceCaseId(topic(id)),
    project: 'fixture',
    memoryId: `tn_topic_${id}`,
    family: 'topic-maintenance',
    slot: 'declared-support',
    evidenceRevision: 'a'.repeat(64),
    disposition,
    reason: 'topic-unchanged',
    firstSeen: at,
    lastSeen: at,
    lastChecked: at,
    attemptCount: 0,
    events: [],
  };
}

const citation = createMemoryCodeCitation({
  version: 1,
  repositoryId: '1'.repeat(64),
  repositoryIdentityKind: 'remote',
  sourceCommit: '2'.repeat(40),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
  extractorSet: 'native-code-graph-13',
  path: 'source.ts',
  fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
  target: {kind: 'file'},
  evidenceRetention: 'capsule-retained',
});

function topic(id: number) {
  const uri = `threadnote://user/tester/memories/durable/projects/fixture/topic-${id}.md`;
  const record = parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        schemaVersion: 8,
        memoryId: `tn_topic_${id}`,
        project: 'fixture',
        topic: `topic-${id}`,
        sourceAgentClient: 'test',
        timestamp: '2026-10-16T00:00:00.000Z',
        codeCitations: [citation],
      },
      'This topic cites source code.',
    ),
  )!;
  const enrolled = proposeTopicMaintenanceEnrollment(record, {
    paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [citation.id]}],
  });
  return parseMemoryDocument(uri, enrolled.content)!;
}

const codeTopicFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'topic-acceptance-'});
  const repository = path.join(home, 'repository');
  yield* fs.makeDirectory(repository);
  const source = path.join(repository, 'source.ts');
  yield* fs.writeFileString(source, 'export const retryLimit = 3;\n');
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
  const commit = (message: string) =>
    Effect.gen(function* () {
      yield* git(['add', '.']);
      yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', message]);
    });
  yield* git(['init', '--quiet']);
  yield* commit('initial');
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    manifestPath: path.join(home, 'manifest.yaml'),
    user: 'tester',
  };
  yield* fs.writeFileString(
    config.manifestPath,
    `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
  );
  const index = () =>
    CodeGraphIndexer.pipe(
      Effect.flatMap(indexer => indexer.index({cwd: repository, threadnoteHome: home, ensureVectors: false})),
    );
  yield* index();
  const [citation] = yield* captureMemoryCodeCitations(config, {callerCwd: repository, refs: ['source.ts']});
  const uri = 'threadnote://user/tester/memories/durable/projects/fixture/source-topic.md';
  const base = parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        schemaVersion: 8,
        memoryId: 'tn_source_topic',
        project: 'fixture',
        topic: 'source-topic',
        sourceAgentClient: 'test',
        timestamp: at,
        codeCitations: [citation],
      },
      'The retry limit is three.',
    ),
  )!;
  const enrolled = proposeTopicMaintenanceEnrollment(base, {
    paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [citation.id]}],
  });
  const memory = path.join(home, 'data/local/user/tester/memories/durable/projects/fixture/source-topic.md');
  yield* fs.makeDirectory(path.dirname(memory), {recursive: true});
  yield* fs.writeFileString(memory, enrolled.content);
  const accepted = yield* fs.readFileString(memory);
  const original = parseMemoryDocument(uri, accepted)!;
  const caseId = topicMaintenanceCaseId(original);
  const stateFile = path.join(home, 'context-maintenance/state-v2.json');
  for (let tick = 0; tick < 8; tick++) yield* runContextMaintenance(config, {cwd: repository});
  return {
    fs,
    path,
    home,
    repository,
    source,
    git,
    commit,
    config,
    index,
    citation,
    uri,
    memory,
    accepted,
    original,
    caseId,
    stateFile,
  };
});

const noTextReviewFixture = Effect.gen(function* () {
  const fixture = yield* codeTopicFixture;
  const {fs, source, commit, index, config, repository, caseId} = fixture;
  yield* fs.writeFileString(source, 'export const retryLimit = 3; // unchanged value\n');
  yield* commit('source metadata changed');
  yield* index();
  let current = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
  for (let tick = 0; tick < 12 && current?.disposition !== 'needs-decision'; tick++) {
    yield* runContextMaintenance(config, {cwd: repository});
    current = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
  }
  expect(current?.disposition).toBe('needs-decision');
  const packet = readyEvidence(yield* readContextMaintenancePacket(config, caseId));
  if (packet.version !== 1) throw new Error('Expected code topic packet.');
  const basis = basisFromPacket(packet);
  const proposal = parseTopicMaintenanceDraft(
    basis,
    JSON.stringify({
      version: 1,
      targetHash: basis.targetHash,
      observationRevision: basis.observationRevision,
      packetDigest: basis.packetDigest,
      outcome: 'propose-revalidation',
      operations: [],
      reviewedHandles: [`current:${fixture.citation.id}`],
      rationale: 'The cited value remains three.',
      unresolvedQuestions: [],
      removedClaims: [],
      paragraphDispositions: {
        version: 1,
        entries: basis.paragraphs
          .filter(item => item.role === 'descriptive' && item.support === 'direct')
          .map(item => ({
            ordinal: item.ordinal,
            beforeHash: item.hash,
            disposition: 'revalidate',
            supportHandles: [`current:${fixture.citation.id}`],
            rationale: 'The cited value remains three.',
          })),
      },
    }),
  );
  const payload = {
    version: 1 as const,
    basis,
    proposal,
    reviewEvidence: reviewEvidenceFromPacket(packet),
    generation: {
      origin: 'manual' as const,
      agent: 'manual' as const,
      model: 'none' as const,
      promptVersion: 'manual-topic-v1' as const,
      attempts: 0 as const,
      usage: {status: 'unavailable' as const},
    },
  };
  const review = privateReview(undefined, basis, payload, 'fixture', 'source-topic', [], at);
  yield* saveCandidateReview(fixture.home, review);
  const prepared = yield* prepareTopicMaintenanceReview(config, {
    reviewId: review.reviewId,
    revision: review.revision,
    sourceCwd: repository,
  });
  return {...fixture, basis, payload, review, prepared, preview: prepared.maintenanceApproval!.preview};
});

describe('topic maintenance worker scheduling', () => {
  it('gives topic work a bounded turn amid perpetual record, semantic, and requested work', () => {
    let schedule: Parameters<typeof selectMaintenanceWorkPhase>[0];
    const phases = [];
    for (let index = 0; index < 12; index++) {
      const work = selectMaintenanceWorkPhase(schedule, ['fixture'], true, ['fixture\0/repo'], true);
      phases.push(work.phase);
      schedule = work.next;
    }
    expect(phases).toEqual([
      'records',
      'semantic',
      'requested',
      'topic',
      'records',
      'semantic',
      'requested',
      'topic',
      'records',
      'semantic',
      'requested',
      'topic',
    ]);
  });

  it('rotates stable IDs fairly without mutating inventory order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 24}), {minLength: 1, maxLength: 12}), ids => {
        const records = ids.map(topic);
        const order = records.map(record => record.uri);
        let last: string | undefined;
        const seen = new Set<string>();
        for (let tick = 0; tick < records.length; tick++) {
          const selected = selectTopicMaintenanceRecord(records, last)!;
          expect(enrolledTopicRecord(selected)).toBe(true);
          seen.add(selected.metadata.memoryId!);
          last = selected.metadata.memoryId;
        }
        expect(seen.size).toBe(records.length);
        expect(records.map(record => record.uri)).toEqual(order);
      }),
      {numRuns: 25},
    );
  });

  it('reconciles only the selected case and checkpoint, with material replay idempotence', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({min: 0, max: 24}), {minLength: 1, maxLength: 10}),
        fc.nat(),
        fc.array(fc.constantFrom('needs-decision' as const, 'waiting-evidence' as const, 'resolved' as const), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.constantFrom(
          'idle' as const,
          'running' as const,
          'waiting-evidence' as const,
          'needs-decision' as const,
          'failed' as const,
        ),
        (ids, choice, dispositions, initialState) => {
          const selected = ids[choice % ids.length];
          const beforeCases = ids.map((id, index) => topicCase(id, dispositions[index % dispositions.length]));
          const prior = {
            targetHash: 'a'.repeat(64),
            revision: 'a'.repeat(64),
            outcome: 'review-required' as const,
            checkedAt: at,
            coverage: 'declared-only' as const,
          };
          const checkpoints = Object.fromEntries(beforeCases.map(item => [item.caseId, prior]));
          const state: MaintenanceState = {
            version: 2,
            paused: false,
            state: initialState,
            generation: 'test',
            projects: [],
            cases: beforeCases,
            receipts: [],
            checkpoints: {},
            topicCheckpoints: checkpoints,
          };
          const original = JSON.stringify(state);
          const chosen = beforeCases.find(item => item.memoryId === `tn_topic_${selected}`)!;
          const accepted = {...chosen, disposition: 'resolved' as const, evidenceRevision: 'b'.repeat(64)};
          const checkpoint = {
            ...prior,
            targetHash: 'b'.repeat(64),
            revision: 'b'.repeat(64),
            outcome: 'unchanged' as const,
          };
          const observed = {caseId: chosen.caseId, item: accepted, checkpoint};
          const once = stateWithAcceptedTopicObservation(state, observed);
          const twice = stateWithAcceptedTopicObservation(once, observed);
          expect(twice).toEqual(once);
          expect(JSON.stringify(state)).toBe(original);
          expect(once.cases.map(item => item.caseId)).toEqual(beforeCases.map(item => item.caseId));
          expect(once.cases.filter(item => item.caseId !== chosen.caseId)).toEqual(
            beforeCases.filter(item => item.caseId !== chosen.caseId),
          );
          expect(Object.entries(once.topicCheckpoints ?? {}).filter(([id]) => id !== chosen.caseId)).toEqual(
            Object.entries(checkpoints).filter(([id]) => id !== chosen.caseId),
          );
          expect(once.cases.find(item => item.caseId === chosen.caseId)).toEqual(accepted);
          expect(once.topicCheckpoints?.[chosen.caseId]).toEqual(checkpoint);
          const remainingDispositions = new Set(
            beforeCases.filter(item => item.caseId !== chosen.caseId).map(item => item.disposition),
          );
          const expectedState = remainingDispositions.has('needs-decision')
            ? 'needs-decision'
            : remainingDispositions.has('waiting-evidence')
              ? 'waiting-evidence'
              : initialState === 'needs-decision' || initialState === 'waiting-evidence'
                ? 'idle'
                : initialState;
          expect(once.state).toBe(expectedState);
        },
      ),
      {
        numRuns: 50,
        verbose: true,
        examples: [
          [[0], 0, ['waiting-evidence'], 'waiting-evidence'],
          [[0, 1], 0, ['needs-decision', 'waiting-evidence'], 'needs-decision'],
          [[0], 0, ['resolved'], 'failed'],
          [[0], 0, ['resolved'], 'running'],
        ],
      },
    );
  });

  it('advances the fair cursor after a raced observation without changing its case evidence', () => {
    const records = [topic(1), topic(2)];
    let schedule: MaintenanceWorkSchedule = {nextPhase: 'topic'};
    const raced = selectTopicMaintenanceRecord(records, schedule.lastTopicMemoryId);
    expect(raced?.metadata.memoryId).toBe('tn_topic_1');
    const evidence = new Map([[topicMaintenanceCaseId(raced!), topicCase(1, 'resolved')]]);
    const before = evidence.get(topicMaintenanceCaseId(raced!));
    schedule = advanceTopicMaintenanceCursor(schedule, raced!);
    expect(evidence.get(topicMaintenanceCaseId(raced!))).toBe(before);
    expect(selectTopicMaintenanceRecord(records, schedule.lastTopicMemoryId)?.metadata.memoryId).toBe('tn_topic_2');
  });

  it('caps inactive terminal topic history while retaining active pending and incomplete inventory', () => {
    const inactive = Array.from({length: 205}, (_, id) => topicCase(id, 'resolved'));
    const active = topicCase(999, 'needs-decision');
    const cases = [...inactive, active];
    const activeIds = new Set([active.memoryId]);
    const retained = selectRetainedMaintenanceCases(cases, activeIds, true, false);
    expect(retained).toHaveLength(201);
    expect(retained).toContain(active);
    expect(retained.filter(item => item.disposition === 'resolved')).toHaveLength(200);
    expect(selectRetainedMaintenanceCases(cases, activeIds, false, false)).toHaveLength(206);
  });

  it('omits private topic checkpoints from scoped and paginated public status', () => {
    const selected = topicCase(1, 'needs-decision');
    const next = topicCase(2, 'resolved');
    const other = {...topicCase(3, 'needs-decision'), project: 'other'};
    const state: MaintenanceState = {
      version: 2,
      paused: false,
      state: 'needs-decision',
      generation: 'test',
      projects: [],
      cases: [selected, next, other],
      receipts: [],
      checkpoints: {},
      topicCheckpoints: {
        [selected.caseId]: {
          targetHash: 'a'.repeat(64),
          revision: 'b'.repeat(64),
          outcome: 'unavailable',
          checkedAt: at,
          coverage: 'declared-only',
          deferredAt: at,
        },
        [other.caseId]: {
          targetHash: 'a'.repeat(64),
          revision: 'b'.repeat(64),
          outcome: 'unavailable',
          checkedAt: at,
          coverage: 'declared-only',
          deferredAt: at,
        },
      },
    };
    const first = publicStatus(state, 'fixture', {limit: 1});
    expect(first.cases).toHaveLength(1);
    expect(first.cases[0]?.project).toBe('fixture');
    expect(first).not.toHaveProperty('topicCheckpoints');
    const second = publicStatus(state, 'fixture', {limit: 1, caseCursor: first.page?.caseNextCursor});
    expect(second.cases).toHaveLength(1);
    expect(second.cases[0]?.project).toBe('fixture');
    expect(JSON.stringify([first, second])).not.toContain(other.caseId);
    expect(JSON.stringify([first, second])).not.toContain('topicCheckpoints');
  });

  it('keeps topic checkpoints on incomplete inventory and rejects malformed recovery state', () => {
    const id = topicMaintenanceCaseId(topic(1));
    const checkpoint = {
      targetHash: 'a'.repeat(64),
      revision: 'b'.repeat(64),
      outcome: 'review-required' as const,
      checkedAt: '2026-10-16T00:00:00.000Z',
      coverage: 'declared-only' as const,
      observation: {
        version: 1 as const,
        targetHash: 'a'.repeat(64),
        revision: 'b'.repeat(64),
        coverage: 'declared-only' as const,
        outcome: 'review-required' as const,
        canDraft: true,
        sources: [],
      },
    };
    const previous = {[id]: checkpoint};
    expect(validTopicMaintenanceCheckpoints(previous)).toBe(true);
    expect(pruneAbsentTopicCheckpoints(previous, new Set(), false)).toEqual(previous);
    expect(pruneAbsentTopicCheckpoints(previous, new Set(), true)).toEqual({});
    expect(validTopicMaintenanceCheckpoints({[id]: {...checkpoint, body: 'unbounded'}})).toBe(false);
  });

  effectIt.effect(
    'persists exact-revision rejection, deferral and explicit resume without changing accepted content',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'topic-review-decisions-'});
          const config = {
            account: 'local',
            agentContextHome: home,
            agentId: 'test',
            manifestPath: path.join(home, 'manifest.yaml'),
            user: 'tester',
          };
          const selected = {...topicCase(1, 'needs-decision'), reason: 'topic-review-required'};
          const other = topicCase(2, 'needs-decision');
          const observation = {
            version: 1 as const,
            targetHash: 'b'.repeat(64),
            revision: selected.evidenceRevision,
            outcome: 'review-required' as const,
            coverage: 'declared-only' as const,
            canDraft: true,
            sources: [],
          };
          const checkpoint = boundedTopicMaintenanceCheckpoint(observation, at);
          const state: MaintenanceState = {
            version: 2,
            paused: false,
            state: 'needs-decision',
            generation: 'fixture',
            projects: [],
            cases: [selected, other],
            receipts: [],
            checkpoints: {},
            topicCheckpoints: {[selected.caseId]: checkpoint},
          };
          const file = path.join(home, 'context-maintenance/state-v2.json');
          yield* fs.makeDirectory(path.dirname(file), {recursive: true});
          yield* fs.writeFileString(file, JSON.stringify(state));
          const decide = (action: 'reject' | 'defer' | 'resume', observationRevision = selected.evidenceRevision) =>
            recordTopicMaintenanceReviewDecision(config, {caseId: selected.caseId, observationRevision, action});
          expect((yield* Effect.result(decide('reject', 'f'.repeat(64))))._tag).toBe('Failure');
          expect(
            yield* recordTopicMaintenanceReviewDecision(config, {
              caseId: selected.caseId,
              observationRevision: 'f'.repeat(64),
              action: 'reject',
              onStale: 'ignore',
            }),
          ).toBeUndefined();
          expect(JSON.parse(yield* fs.readFileString(file))).toEqual(state);
          yield* decide('defer');
          const deferred = JSON.parse(yield* fs.readFileString(file));
          expect(deferred.topicCheckpoints[selected.caseId]).toMatchObject({
            suppressedRevision: selected.evidenceRevision,
            suppressedDecision: 'defer',
          });
          expect(
            deferred.cases.find((item: ContextMaintenanceCaseV2) => item.caseId === selected.caseId),
          ).toMatchObject({disposition: 'deferred-policy', reason: 'topic-review-deferred'});
          yield* decide('resume');
          yield* decide('resume');
          const resumed = JSON.parse(yield* fs.readFileString(file));
          expect(resumed.topicCheckpoints[selected.caseId].suppressedRevision).toBeUndefined();
          expect(resumed.cases.find((item: ContextMaintenanceCaseV2) => item.caseId === selected.caseId)).toMatchObject(
            {disposition: 'needs-decision', reason: 'topic-review-required'},
          );
          yield* decide('reject');
          const rejectedBytes = yield* fs.readFileString(file);
          yield* decide('reject');
          expect(yield* fs.readFileString(file)).toBe(rejectedBytes);
          const rejected = JSON.parse(rejectedBytes);
          expect(rejected.topicCheckpoints[selected.caseId]).toMatchObject({
            suppressedRevision: selected.evidenceRevision,
            suppressedDecision: 'reject',
          });
          expect(rejected.cases.find((item: ContextMaintenanceCaseV2) => item.caseId === other.caseId)).toEqual(other);
          const afterMaterialChange = boundedTopicMaintenanceCheckpoint(
            {...observation, revision: 'c'.repeat(64)},
            at,
            rejected.topicCheckpoints[selected.caseId],
          );
          expect(afterMaterialChange.suppressedRevision).toBeUndefined();
          expect(
            validTopicMaintenanceCheckpoints({[selected.caseId]: rejected.topicCheckpoints[selected.caseId]}),
          ).toBe(true);
        }),
      ).pipe(
        provideTestLayer(
          Layer.merge(
            BunServices.layer,
            SystemInfo.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ChildEnvironmentPolicy, {
                    preserveIntendedChild: environment => environment,
                    sanitizeExternal: environment => environment,
                  }),
                  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: '/test/threadnote.ts'}),
                ),
              ),
            ),
          ),
        ),
      ),
  );

  it('records a bounded budget deferral and preserves prior observation on retry', () => {
    const record = topic(2);
    const pending = deferTopicMaintenanceCase(record, 'a'.repeat(64), at, undefined, undefined);
    expect(pending.item).toMatchObject({disposition: 'waiting-evidence', reason: 'topic-observation-budget-deferred'});
    expect(pending.checkpoint).toMatchObject({deferredAt: at, coverage: 'declared-only'});
    expect(validTopicMaintenanceCheckpoints({[pending.caseId]: pending.checkpoint})).toBe(true);
    const retained = deferTopicMaintenanceCase(
      record,
      'a'.repeat(64),
      at,
      {
        ...pending.checkpoint,
        observation: {
          version: 1,
          targetHash: pending.checkpoint.targetHash,
          revision: pending.checkpoint.revision,
          coverage: 'declared-only',
          outcome: 'unavailable',
          canDraft: false,
          sources: [],
        },
      },
      {...pending.item, disposition: 'resolved', reason: 'topic-unchanged'},
    );
    expect(retained.item).toMatchObject({disposition: 'waiting-evidence', reason: 'topic-observation-budget-deferred'});
    expect(retained.checkpoint.observation).toBeDefined();
    expect(retained.checkpoint.outcome).toBe('unavailable');
    expect(
      publicStatus({
        version: 2,
        paused: false,
        state: 'waiting-evidence',
        generation: 'test',
        projects: [],
        cases: [retained.item],
        receipts: [],
        checkpoints: {},
        topicCheckpoints: {[retained.caseId]: retained.checkpoint},
      }).cases[0],
    ).toMatchObject({disposition: 'waiting-evidence', reason: 'topic-observation-budget-deferred'});
    const recovered = boundedTopicMaintenanceCheckpoint(retained.checkpoint.observation!, at, retained.checkpoint);
    expect(recovered.deferredAt).toBeUndefined();
    expect(recovered.outcome).toBe('unavailable');
  });

  effectIt.effect('compacts worst-case valid observations and can read the resulting state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'topic-maintenance-boundary-'});
        const config = {
          account: 'local',
          agentContextHome: home,
          agentId: 'test',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        const id = topicMaintenanceCaseId(topic(1));
        const sources = Array.from({length: 8}, (_, index) => {
          const current = createMemoryCodeCitation({
            version: 1,
            repositoryId: '1'.repeat(64),
            repositoryIdentityKind: 'remote',
            sourceCommit: '2'.repeat(40),
            sourceDirty: false,
            sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
            extractorSet: 'native-code-graph-13',
            path: `source-${index}/${'part/'.repeat(790)}file.ts`,
            fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
            target: {kind: 'file'},
            evidenceRetention: 'capsule-retained',
          });
          return {
            citationId: current.id,
            status: 'changed' as const,
            reason: 'changed',
            historicalAvailable: true,
            current,
            observedPath: current.path,
            currentFileBytesHash: 'b'.repeat(64),
          };
        });
        const previousObservation = {
          version: 1 as const,
          targetHash: 'a'.repeat(64),
          revision: 'b'.repeat(64),
          outcome: 'unchanged' as const,
          coverage: 'declared-only' as const,
          canDraft: false,
          sources: [],
        };
        const previous = boundedTopicMaintenanceCheckpoint(previousObservation, at);
        const observation = {
          ...previousObservation,
          revision: 'c'.repeat(64),
          outcome: 'review-required' as const,
          canDraft: true,
          sources,
        };
        expect(new TextEncoder().encode(JSON.stringify(observation)).byteLength).toBeGreaterThan(32 * 1024);
        const checkpoint = boundedTopicMaintenanceCheckpoint(observation, at, previous);
        expect(checkpoint).toMatchObject({outcome: 'unavailable', overflowReason: 'topic-observation-overflow'});
        expect(checkpoint.recoveryObservation).toEqual(previousObservation);
        expect(validTopicMaintenanceCheckpoints({[id]: checkpoint})).toBe(true);
        const state: MaintenanceState = {
          version: 2,
          paused: false,
          state: 'waiting-evidence',
          generation: 'test',
          projects: [],
          cases: [],
          receipts: [],
          checkpoints: {},
          topicCheckpoints: {[id]: checkpoint},
        };
        const file = path.join(home, 'context-maintenance/state-v2.json');
        yield* fs.makeDirectory(path.dirname(file), {recursive: true});
        yield* fs.writeFileString(file, JSON.stringify(state));
        const result = yield* readContextMaintenanceStatus(config);
        expect(result.state).toBe('waiting-evidence');
        expect(result).not.toHaveProperty('topicCheckpoints');
      }),
    ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  it('keeps generic citation replacement off enrolled support', () => {
    const record = topic(3);
    expect(
      memoryContentWithCitationReplacementsV1(record, [{citationId: citation.id, replacement: citation}]),
    ).toBeUndefined();
  });

  effectIt.effect('keeps one topic case through normal record reconciliation and repeated wakes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'topic-maintenance-worker-'});
        const config = {
          account: 'local',
          agentContextHome: home,
          agentId: 'test',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        const record = topic(1);
        const file = path.join(home, 'data/local/user/tester/memories/durable/projects/fixture/topic-1.md');
        yield* fs.makeDirectory(path.dirname(file), {recursive: true});
        yield* fs.writeFileString(file, record.content);
        const caseId = topicMaintenanceCaseId(record);
        for (let tick = 0; tick < 4; tick++) yield* runContextMaintenance(config, {cwd: home});
        const stateFile = path.join(home, 'context-maintenance/state-v2.json');
        const first = JSON.parse(yield* fs.readFileString(stateFile));
        const selected = first.cases.find((item: {caseId: string}) => item.caseId === caseId);
        expect(selected).toMatchObject({
          family: 'topic-maintenance',
          slot: 'declared-support',
          disposition: 'waiting-evidence',
        });
        expect(first.topicCheckpoints[caseId]).toMatchObject({coverage: 'declared-only', outcome: 'unavailable'});
        const packet = yield* readContextMaintenancePacket(config, caseId);
        expect('topicEvidence' in packet && packet.topicEvidence).toMatchObject({
          outcome: 'unavailable',
          coverage: 'declared-only',
        });
        const system = yield* SystemInfo;
        const binary = system.environment().THREADNOTE_E2E_BINARY;
        const executable = binary ?? system.executablePath;
        const prefix = binary ? [] : [path.join(system.currentDirectory(), 'apps/threadnote/src/standalone.ts')];
        const cli = (args: readonly string[]) =>
          runCommandEffect(executable, [...prefix, 'context', 'maintain', ...args], {
            cwd: home,
            env: {
              ...system.environment(),
              THREADNOTE_HOME: home,
              THREADNOTE_USER: config.user,
              THREADNOTE_MANIFEST: config.manifestPath,
              NO_COLOR: '1',
            },
            timeoutMs: 60_000,
          });
        const publicPacket = JSON.parse((yield* cli(['--action', 'packet', '--case-id', caseId, '--json'])).stdout);
        expect(publicPacket.topicEvidence).toMatchObject({outcome: 'unavailable', coverage: 'declared-only'});
        expect(JSON.parse((yield* cli(['--action', 'run', '--json'])).stdout).version).toBe(2);
        for (let tick = 0; tick < 4; tick++) yield* runContextMaintenance(config, {cwd: home});
        const after = JSON.parse(yield* fs.readFileString(stateFile));
        const cases = after.cases.filter((item: {caseId: string}) => item.caseId === caseId);
        expect(cases).toHaveLength(1);
        expect(cases[0].evidenceRevision).toBe(selected.evidenceRevision);
        expect(cases[0].attemptCount).toBe(selected.attemptCount);
        expect(cases[0].disposition).toBe('waiting-evidence');
      }),
    ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'routes changed declared source through the public maintenance packet without changing accepted text',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const {fs, path, home, repository, source, git, config, uri, memory, accepted, caseId, stateFile} =
            yield* codeTopicFixture;
          const currentCase = Effect.gen(function* () {
            const state = JSON.parse(yield* fs.readFileString(stateFile));
            return state.cases.find((item: {caseId: string}) => item.caseId === caseId);
          });
          const before = yield* currentCase;
          expect(before).toBeDefined();
          const priorState = JSON.parse(yield* fs.readFileString(stateFile));
          const deferred = deferTopicMaintenanceCase(
            parseMemoryDocument(uri, accepted)!,
            before.subjectContentHashes?.[0]?.hash ?? 'a'.repeat(64),
            at,
            priorState.topicCheckpoints[caseId],
            {...before, disposition: 'resolved', reason: 'topic-unchanged'},
          );
          priorState.cases = priorState.cases.map((item: {caseId: string}) =>
            item.caseId === caseId ? deferred.item : item,
          );
          priorState.topicCheckpoints[caseId] = deferred.checkpoint;
          priorState.state = 'waiting-evidence';
          yield* fs.writeFileString(stateFile, JSON.stringify(priorState));
          expect((yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0]).toMatchObject({
            disposition: 'waiting-evidence',
            reason: 'topic-observation-budget-deferred',
          });
          for (let tick = 0; tick < 4; tick++) yield* runContextMaintenance(config, {cwd: repository});
          const recovered = yield* currentCase;
          expect(recovered.reason).not.toBe('topic-observation-budget-deferred');
          expect(recovered.disposition).toBe(before.disposition);
          yield* fs.writeFileString(source, 'export const retryLimit = 4;\n');
          yield* git(['add', '.']);
          yield* git([
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '--quiet',
            '-m',
            'change declared support',
          ]);
          yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: home, ensureVectors: false});
          let after = before;
          for (let tick = 0; tick < 12 && after.evidenceRevision === before.evidenceRevision; tick++) {
            yield* runContextMaintenance(config, {cwd: repository});
            after = yield* currentCase;
          }
          expect(after.evidenceRevision).not.toBe(before.evidenceRevision);
          expect(after.disposition).toBe('needs-decision');
          const system = yield* SystemInfo;
          const binary = system.environment().THREADNOTE_E2E_BINARY;
          const executable = binary ?? system.executablePath;
          const prefix = binary ? [] : [path.join(system.currentDirectory(), 'apps/threadnote/src/standalone.ts')];
          const cli = (args: readonly string[]) =>
            runCommandEffect(executable, [...prefix, 'context', 'maintain', ...args], {
              cwd: repository,
              env: {
                ...system.environment(),
                THREADNOTE_HOME: home,
                THREADNOTE_USER: config.user,
                THREADNOTE_MANIFEST: config.manifestPath,
                NO_COLOR: '1',
              },
              timeoutMs: 60_000,
            });
          const beforePacketState = yield* fs.readFileString(stateFile);
          const packet = JSON.parse((yield* cli(['--action', 'packet', '--case-id', caseId, '--json'])).stdout);
          const repeatedPacket = JSON.parse((yield* cli(['--action', 'packet', '--case-id', caseId, '--json'])).stdout);
          expect(repeatedPacket).toEqual(packet);
          expect(yield* fs.readFileString(stateFile)).toBe(beforePacketState);
          expect(packet.topicEvidence).toMatchObject({outcome: 'ready', coverage: 'declared-only'});
          expect(packet.topicEvidence.sources).toHaveLength(1);
          expect(packet.evidenceCounts).toMatchObject({declared: 1, unavailable: 0});
          yield* recordTopicMaintenanceReviewDecision(config, {
            caseId,
            observationRevision: after.evidenceRevision,
            action: 'reject',
          });
          for (let tick = 0; tick < 4; tick++) yield* runContextMaintenance(config, {cwd: repository});
          const suppressed = yield* currentCase;
          expect(suppressed.evidenceRevision).toBe(after.evidenceRevision);
          expect(suppressed).toMatchObject({disposition: 'deferred-policy', reason: 'topic-review-rejected'});
          yield* fs.writeFileString(source, 'export const retryLimit = 5;\n');
          yield* git(['add', '.']);
          yield* git([
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '--quiet',
            '-m',
            'new evidence after rejection',
          ]);
          yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: home, ensureVectors: false});
          let reopened = suppressed;
          for (let tick = 0; tick < 12 && reopened.evidenceRevision === suppressed.evidenceRevision; tick++) {
            yield* runContextMaintenance(config, {cwd: repository});
            reopened = yield* currentCase;
          }
          expect(reopened.disposition).toBe('needs-decision');
          expect(reopened.evidenceRevision).not.toBe(suppressed.evidenceRevision);
          expect(yield* fs.readFileString(memory)).toBe(accepted);
        }),
      ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('revalidates unchanged text and persists the fresh observed case before written completion', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* noTextReviewFixture;
        const {config, repository, review, prepared, preview, fs, memory, caseId, accepted} = fixture;
        expect(preview.content).toContain('The retry limit is three.');
        expect(preview.content).not.toBe(accepted);
        const applied = yield* applyTopicMaintenanceReview(config, {
          reviewId: review.reviewId,
          revision: prepared.revision,
          sourceCwd: repository,
          approvalDigest: preview.approvalDigest,
          approved: true,
        });
        expect(applied.maintenanceApproval?.stage).toBe('written');
        expect(yield* fs.readFileString(memory)).toBe(preview.content);
        expect((yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0]?.disposition).toBe(
          'resolved',
        );
      }),
    ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('holds the state lock across the fresh observation and cache write', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* noTextReviewFixture;
        const {fs, config, stateFile, memory, preview, original, payload, repository, caseId, basis} = fixture;
        yield* fs.writeFileString(memory, preview.content);
        const writing = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const pausedFs = {
          ...fs,
          rename: (from: string, to: string) =>
            to === stateFile
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(writing, undefined);
                  yield* Deferred.await(resume);
                  yield* fs.rename(from, to);
                })
              : fs.rename(from, to),
        };
        const completing = yield* reconcileAcceptedTopicMaintenanceCase(
          config,
          original,
          preview.content,
          payload,
          repository,
          Effect.succeed('completed'),
        ).pipe(Effect.provideService(FileSystem.FileSystem, pausedFs), Effect.forkScoped);
        yield* Deferred.await(writing);
        const deciding = yield* recordTopicMaintenanceReviewDecision(config, {
          caseId,
          observationRevision: basis.observationRevision,
          action: 'defer',
        }).pipe(Effect.forkScoped);
        expect(Option.isNone(yield* Fiber.await(deciding).pipe(Effect.timeoutOption(25)))).toBe(true);
        yield* Deferred.succeed(resume, undefined);
        expect(yield* Fiber.join(completing)).toBe('completed');
        const decision = yield* Fiber.join(deciding).pipe(Effect.result);
        const state: MaintenanceState = JSON.parse(yield* fs.readFileString(stateFile));
        expect(state.cases.find(item => item.caseId === caseId)?.evidenceRevision).toBe(
          state.topicCheckpoints?.[caseId]?.revision,
        );
        if (Result.isFailure(decision))
          expect(state.cases.find(item => item.caseId === caseId)?.disposition).toBe('resolved');
        else expect(state.cases.find(item => item.caseId === caseId)?.disposition).toBe('deferred-policy');
      }),
    ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect.each(['source', 'target'] as const)(
    'keeps a raced %s actionable when it changes during persisted verification',
    drift =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* noTextReviewFixture;
          const {fs, config, stateFile, memory, preview, original, payload, repository, source, commit, index, caseId} =
            fixture;
          yield* fs.writeFileString(memory, preview.content);
          const state: MaintenanceState = JSON.parse(yield* fs.readFileString(stateFile));
          const persisted = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const reconcile = reconcileAcceptedTopicMaintenanceState(
            config,
            state,
            original,
            preview.content,
            payload,
            repository,
            next =>
              Effect.gen(function* () {
                yield* fs.writeFileString(stateFile, JSON.stringify(next));
                yield* Deferred.succeed(persisted, undefined);
                yield* Deferred.await(resume);
              }),
            Effect.succeed('completed'),
          );
          const fiber = yield* Effect.forkScoped(reconcile);
          yield* Deferred.await(persisted);
          if (drift === 'source') {
            yield* fs.writeFileString(source, 'export const retryLimit = 4;\n');
            yield* commit('newer source during state persistence');
            yield* index();
          } else {
            yield* fs.writeFileString(
              memory,
              preview.content.replace('The retry limit is three.', 'The retry limit is four.'),
            );
          }
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(fiber).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          const after: MaintenanceState = JSON.parse(yield* fs.readFileString(stateFile));
          expect(after.cases.find(item => item.caseId === caseId)?.disposition).toBe('needs-decision');
          expect(after.topicCheckpoints?.[caseId]).toEqual(state.topicCheckpoints?.[caseId]);
          if (drift === 'source') {
            const priorRevision = after.cases.find(item => item.caseId === caseId)?.evidenceRevision;
            let reopened = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
            for (let tick = 0; tick < 12 && reopened?.evidenceRevision === priorRevision; tick++) {
              yield* runContextMaintenance(config, {cwd: repository});
              reopened = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
            }
            expect(reopened?.evidenceRevision).not.toBe(priorRevision);
            expect(reopened?.disposition).toBe('needs-decision');
          }
        }),
      ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});

effectIt.effect('refreshes a selected stale topic observation without changing its canonical document', () =>
  Effect.gen(function* () {
    const fixture = yield* codeTopicFixture;
    const {fs, source, commit, index, config, repository, caseId, memory, accepted, stateFile} = fixture;
    const before = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
    yield* fs.writeFileString(source, 'export const retryLimit = 9;\n');
    yield* commit('change selected source');
    yield* index();
    expect(Result.isFailure(yield* readContextMaintenancePacket(config, caseId).pipe(Effect.result))).toBe(true);
    const route = yield* handleManagerAttentionAction({
      config,
      method: 'POST',
      url: new URL('http://manager.test/api/attention/context-maintenance'),
      body: Effect.succeed({action: 'refresh-case', project: 'fixture', caseId, memoryUri: fixture.uri}),
    });
    expect(route?.status).toBe(200);
    const refreshed = route?.body as Effect.Success<ReturnType<typeof refreshContextMaintenanceCase>>;
    expect(refreshed.outcome).toBe('ready');
    if (refreshed.outcome !== 'ready') throw new Error(JSON.stringify(refreshed));
    expect(refreshed.item.caseId).toBe(caseId);
    expect(refreshed.item.evidenceRevision).not.toBe(before.evidenceRevision);
    expect('topicEvidence' in refreshed.packet && refreshed.packet.topicEvidence.outcome).toBe('ready');
    expect(yield* fs.readFileString(memory)).toBe(accepted);
    const observedState = yield* fs.readFileString(stateFile);
    const foreign = yield* handleManagerAttentionAction({
      config,
      method: 'POST',
      url: new URL('http://manager.test/api/attention/context-maintenance'),
      body: Effect.succeed({action: 'refresh-case', project: 'fixture', caseId, memoryUri: 'threadnote://foreign'}),
    });
    expect(foreign?.body).toMatchObject({outcome: 'unavailable'});
    expect(yield* fs.readFileString(stateFile)).toBe(observedState);
    expect((yield* refreshContextMaintenanceCase(config, {project: 'fixture', caseId, cwd: repository})).outcome).toBe(
      'ready',
    );
    expect(yield* fs.readFileString(stateFile)).toBe(observedState);
    expect(yield* fs.readFileString(memory)).toBe(accepted);
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);
