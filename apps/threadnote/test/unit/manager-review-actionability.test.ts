import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, Fiber, FileSystem, Path, Scope, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {automaticMaintenanceEvidenceId} from '@threadnote/memory/automatic-maintenance';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {
  parseAutomaticMaintenanceDraft,
  validateAutomaticMaintenanceReview,
} from '@threadnote/memory/topic-maintenance-draft';
import {sha256HexSync as hash} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {advanceCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {prepareAutomaticMemory} from '../../src/memory/context/maintenance_preparation.js';
import {automaticReviewPacket, privateReview} from '../../src/memory/context/maintenance_draft.js';
import * as evidence from '../../src/memory/context/maintenance_evidence.js';
import * as health from '../../src/manager/live_health_sources.js';
import {makeManagerProjectLiveObservation} from '../../src/manager/live_project_observation.js';
import {ManagerHealthObservationHints} from '../../src/manager/live_health_sources.js';
import * as draftController from '../../src/memory/context/maintenance_draft.js';
import {
  automaticReviewCanConverge,
  untouchedAutomaticReview,
} from '../../src/memory/context/maintenance_review_classification.js';
import {
  ManagerReviewVerificationScope,
  ManagerReviewSourceReadiness,
  projectManagerReviewEligibility,
  readManagerReviewEligibility,
  reviewReadinessReason,
  type ReviewReadiness,
} from '../../src/manager/review_actionability.js';
import {handleManagerAttentionRequest} from '../../src/manager/attention.js';
import {handleManagerHomeRequest} from '../../src/manager/home.js';
import {loadCandidateReview, saveCandidateReview} from '@threadnote/memory/candidate';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function fixture(
  index = 0,
  outcome = 'propose-update',
  citation?: ReturnType<typeof createMemoryCodeCitation>,
  root: string | null = null,
) {
  const uri = `threadnote://user/tester/memories/durable/projects/alpha/target-${index}.md`;
  const sourceUri = 'threadnote://user/tester/memories/durable/projects/alpha/source.md';
  const metadata = {
    kind: 'durable' as const,
    status: 'active' as const,
    schemaVersion: 10,
    memoryId: `tn_target${index}`,
    project: 'alpha',
    topic: 'Fixture',
    sourceAgentClient: 'test',
    timestamp: '2026-10-25T00:00:00.000Z',
  };
  const content = formatMemoryDocument('MEMORY', metadata, 'The timeout is 30 seconds.');
  const source = formatMemoryDocument('MEMORY', {...metadata, memoryId: 'tn_source'}, 'The timeout is 60 seconds.');
  const target = parseMemoryDocument(uri, content)!;
  const sourceRecord = parseMemoryDocument(sourceUri, source)!;
  const prepared = prepareAutomaticMemory(target, {
    sources: [sourceRecord],
    evidence: citation
      ? [
          {
            id: automaticMaintenanceEvidenceId({kind: 'code', citation}),
            source: {kind: 'code', citation},
            scope: 'repository',
            authority: 'provisional',
            availability: 'unknown',
          },
        ]
      : [],
    reads: [
      {uri, hash: hash(content)},
      {uri: sourceUri, hash: hash(source)},
      ...(citation ? [{uri: `code:${citation.repositoryId}:${citation.id}`, hash: hash('unchanged-code-proof')}] : []),
    ],
    scopeRevision: hash(
      JSON.stringify({
        project: 'alpha',
        root,
        sourcePolicy: 'same-project-and-shared-team-v1',
        mapper: 'exact-canonical-paragraph-v1',
      }),
    ),
  });
  const packet = automaticReviewPacket(target, prepared);
  const handle = packet.reviewEvidence[0];
  const supported = ['propose-update', 'propose-revalidation'].includes(outcome);
  const proposal = parseAutomaticMaintenanceDraft(
    packet.basis,
    JSON.stringify({
      version: 2,
      kind: 'automatic',
      purpose: 'automatic',
      targetHash: packet.basis.targetHash,
      observationRevision: packet.basis.observationRevision,
      packetDigest: packet.basis.packetDigest,
      outcome,
      operations:
        outcome === 'propose-update'
          ? [
              {
                ordinal: 0,
                beforeHash: packet.basis.paragraphs[0].hash,
                text: sourceRecord.body,
                supportHandles: [handle.handleId],
                rationale: 'Current fixture source.',
              },
            ]
          : [],
      paragraphDecisions: [
        {
          ordinal: 0,
          beforeHash: packet.basis.paragraphs[0].hash,
          role: 'descriptive',
          support: supported ? 'direct' : 'unresolved',
          evidenceIds: supported ? [handle.descriptor.id] : [],
        },
      ],
      reviewedHandles: supported ? [handle.handleId] : [],
      rationale: 'Fixture assessment.',
      unresolvedQuestions: [],
      removedClaims: [],
    }),
  );
  const payload = validateAutomaticMaintenanceReview({
    version: 3,
    kind: 'automatic',
    basis: packet.basis,
    proposal,
    reviewEvidence: packet.reviewEvidence,
    generation: {
      origin: 'model',
      agent: 'local-ai',
      model: 'fixture',
      promptVersion: 'fixture',
      attempts: 1,
      usage: {status: 'unavailable'},
    },
  });
  return {
    review: privateReview(undefined, packet.basis, payload, 'alpha', 'Fixture', [], metadata.timestamp),
    content,
    source,
    uri,
    sourceUri,
    prepared,
  };
}

const storedFixture = Effect.fn('reviewEligibility.fixture')(function* () {
  const f = fixture();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'review-eligibility-'});
  const config: RuntimeConfig = {
    account: 'local',
    user: 'tester',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const root = path.join(home, 'data/local/user/tester/memories/durable/projects/alpha');
  yield* fs.makeDirectory(root, {recursive: true});
  yield* fs.writeFileString(path.join(root, 'target-0.md'), f.content);
  yield* fs.writeFileString(path.join(root, 'source.md'), f.source);
  yield* saveCandidateReview(home, f.review);
  return {...f, fs, path, home, root, config};
});

describe('Manager review eligibility', () => {
  it('partitions the actual 100 assessments + four updates + one revalidation without 105 review chores', () => {
    const reviews = Array.from(
      {length: 105},
      (_, i) =>
        fixture(i, i < 100 ? 'insufficient-evidence' : i === 104 ? 'propose-revalidation' : 'propose-update').review,
    );
    const before = JSON.stringify(reviews);
    const ready = new Map(
      EffectArray.map(reviews.slice(100), r => [`${r.reviewId}:${r.revision}`, {state: 'actionable'} as const]),
    );
    const result = projectManagerReviewEligibility(reviews, ready);
    expect(result.pendingCount).toBe(5);
    expect(result.background).toMatchObject({assessments: 100, awaitingSources: 0, obsolete: 0});
    expect(projectManagerReviewEligibility(reviews).pendingCount).toBe(0);
    expect(projectManagerReviewEligibility(reviews).background.awaitingSources).toBe(5);
    expect(JSON.stringify(reviews)).toBe(before);
  });

  it('partitions deterministically without mutation or lost counts across order and project scope', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('assessment', 'ready', 'waiting', 'obsolete', 'manual', 'deferred', 'applying'), {
          maxLength: 24,
        }),
        kinds => {
          const readiness = new Map<string, ReviewReadiness>();
          const reviews = EffectArray.map(kinds, (kind, i) => {
            let review = fixture(i, kind === 'assessment' ? 'insufficient-evidence' : 'propose-update').review;
            if (kind === 'manual')
              review = {
                ...review,
                maintenance: {
                  ...review.maintenance!,
                  generation: {
                    origin: 'manual',
                    agent: 'manual',
                    model: 'none',
                    promptVersion: 'manual-topic-v1',
                    attempts: 0,
                    usage: {status: 'unavailable'},
                  },
                },
              };
            if (kind === 'deferred' || kind === 'applying')
              review = {
                ...review,
                candidates: EffectArray.map(review.candidates, candidate => ({...candidate, state: kind})),
              };
            if (kind === 'ready' || kind === 'waiting' || kind === 'obsolete')
              readiness.set(`${review.reviewId}:${review.revision}`, {state: kind === 'ready' ? 'actionable' : kind});
            return review;
          });
          const before = JSON.stringify(reviews);
          const result = projectManagerReviewEligibility(reviews, readiness);
          const reversed = projectManagerReviewEligibility([...reviews].reverse(), readiness);
          expect(result.pendingCount).toBe(
            EffectArray.filter(kinds, kind => ['ready', 'manual', 'deferred', 'applying'].includes(kind)).length,
          );
          expect(
            result.pendingCount +
              result.background.assessments +
              result.background.awaitingSources +
              result.background.obsolete,
          ).toBe(reviews.length);
          expect(reversed.pendingCount).toBe(result.pendingCount);
          expect(reversed.background).toEqual(result.background);
          expect(JSON.stringify(reviews)).toBe(before);
        },
      ),
      {numRuns: 40},
    );
  });

  it('never makes authored, decided or writer-owned work automatically replaceable', () => {
    const f = fixture();
    for (const state of ['deferred', 'rejected', 'applying', 'conflict', 'applied'] as const)
      expect(
        untouchedAutomaticReview({
          ...f.review,
          candidates: EffectArray.map(f.review.candidates, candidate => ({...candidate, state})),
        }),
      ).toBe(false);
    for (const action of ['defer', 'reject', 'resume', 'begin_apply'] as const)
      expect(
        untouchedAutomaticReview({
          ...f.review,
          auditEvents: [{action, at: f.review.createdAt, reviewId: f.review.reviewId, revision: 1}],
        }),
      ).toBe(false);
    expect(
      automaticReviewCanConverge(f.review, {
        ...f.prepared,
        relevantRevision: hash('new'),
        omissions: ['code-evidence-time-boundary'],
      }),
    ).toBe(false);
    expect(automaticReviewCanConverge(f.review, {...f.prepared, relevantRevision: hash('new')})).toBe(true);
    expect(reviewReadinessReason(new Error('Graph stale'))).toBe('verification-unavailable');
    expect(reviewReadinessReason({reason: 'source-unavailable'})).toBe('source-unavailable');
  });

  effectIt.effect(
    'uses the same bounded verified population in All, project Reviews and Home for 105 saved journals',
    () =>
      Effect.gen(function* () {
        const f = yield* storedFixture();
        const reviews = Array.from({length: 105}, (_, i) =>
          fixture(i, i < 100 ? 'insufficient-evidence' : i === 104 ? 'propose-revalidation' : 'propose-update'),
        );
        yield* f.fs.remove(f.path.join(f.home, 'threadnote/candidates/v1/reviews', `${f.review.reviewId}.json`));
        for (const [i, item] of reviews.entries()) {
          yield* saveCandidateReview(f.home, item.review);
          if (i >= 100) yield* f.fs.writeFileString(f.path.join(f.root, `target-${i}.md`), item.content);
        }
        const original = draftController.readTopicMaintenanceDraft;
        let calls = 0;
        const checked: string[] = [];
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(draftController, 'readTopicMaintenanceDraft').mockImplementation((...args) => {
              calls++;
              checked.push(args[1]);
              return original(...args);
            }),
          ),
          () =>
            Effect.gen(function* () {
              for (let pass = 0; pass < 5; pass++) {
                // Narrower subsequent views must still drain the principal's already admitted queue fairly.
                const visible =
                  pass === 0
                    ? EffectArray.map(reviews, item => item.review)
                    : EffectArray.map(
                        EffectArray.filter(reviews, item => item.review.reviewId === checked[0]),
                        item => item.review,
                      );
                yield* readManagerReviewEligibility(f.config, visible);
                expect(calls).toBe(pass + 1);
              }
              const request = (project: string) =>
                handleManagerAttentionRequest({
                  config: f.config,
                  method: 'GET',
                  url: new URL(`http://manager.test/api/reviews?project=${project}&view=pending`),
                });
              for (const project of ['', 'alpha']) {
                const inbox = yield* request(project);
                expect(inbox?.body).toHaveProperty('pendingCount', 5);
                expect(inbox?.body).toHaveProperty('background.assessments', 100);
                expect(inbox?.body).toHaveProperty('background.awaitingSources', 0);
                if (!inbox || !('items' in inbox.body)) throw new Error('Expected review inbox');
                expect(inbox.body.items).toHaveLength(5);
                const home = yield* handleManagerHomeRequest({
                  config: f.config,
                  method: 'GET',
                  url: new URL(`http://manager.test/api/home?project=${project}`),
                });
                expect(home?.body).toHaveProperty('stats.pending', 5);
              }
              expect(calls).toBe(5);
              for (let turn = 0; turn < 5; turn++) {
                yield* advanceCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
                yield* readManagerReviewEligibility(
                  f.config,
                  EffectArray.map(reviews, item => item.review),
                );
              }
              expect(new Set(checked.slice(5)).size).toBe(5);
            }),
          spy => Effect.sync(() => spy.mockRestore()),
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'restores an authorized proposal after actual source loss without generation or canonical mutation',
    () =>
      Effect.gen(function* () {
        const f = yield* storedFixture();
        const initial = yield* readManagerReviewEligibility(f.config, [f.review]);
        expect(initial.pendingCount).toBe(1);
        yield* f.fs.remove(f.path.join(f.root, 'source.md'));
        const missing = yield* readManagerReviewEligibility(f.config, [f.review]);
        expect(missing.pendingCount).toBe(0);
        expect(missing.background.awaitingSources).toBe(1);
        yield* f.fs.writeFileString(f.path.join(f.root, 'source.md'), f.source);
        const restored = yield* readManagerReviewEligibility(f.config, [f.review]);
        expect(restored.pendingCount).toBe(1);
        expect(yield* f.fs.readFileString(f.path.join(f.root, 'target-0.md'))).toBe(f.content);
        const inbox = yield* handleManagerAttentionRequest({
          config: f.config,
          method: 'GET',
          url: new URL('http://manager.test/api/reviews?project=alpha&view=pending'),
        });
        const home = yield* handleManagerHomeRequest({
          config: f.config,
          method: 'GET',
          url: new URL('http://manager.test/api/home?project=alpha'),
        });
        expect(inbox?.body).toHaveProperty('pendingCount', 1);
        expect(home?.body).toHaveProperty('stats.pending', 1);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'returns grouped checking immediately, coalesces an owned job and cancels it before lifecycle release',
    () =>
      Effect.gen(function* () {
        const f = yield* storedFixture();
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        let calls = 0;
        yield* Effect.acquireUseRelease(
          Scope.make(),
          owner =>
            Effect.acquireUseRelease(
              Effect.sync(() =>
                vi.spyOn(draftController, 'readTopicMaintenanceDraft').mockImplementation(() =>
                  Effect.sync(() => {
                    calls++;
                  }).pipe(
                    Effect.andThen(Deferred.succeed(started, undefined)),
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(f.review),
                    Effect.ensuring(Deferred.succeed(interrupted, undefined)),
                  ),
                ),
              ),
              () =>
                Effect.gen(function* () {
                  const read = () =>
                    readManagerReviewEligibility(f.config, [f.review]).pipe(
                      Effect.provideService(ManagerReviewVerificationScope, owner),
                    );
                  const checking = yield* read();
                  expect(checking.pendingCount).toBe(0);
                  expect(checking.background.awaitingSources).toBe(1);
                  yield* Deferred.await(started);
                  expect((yield* read()).pendingCount).toBe(0);
                  expect(calls).toBe(1);
                  yield* Scope.close(owner, Exit.void);
                  yield* Deferred.await(interrupted);
                  yield* Deferred.succeed(release, undefined);
                }),
              spy => Effect.sync(() => spy.mockRestore()),
            ),
          owner => Scope.close(owner, Exit.void),
        );
        expect((yield* readManagerReviewEligibility(f.config, [f.review])).pendingCount).toBe(1);
        expect(yield* f.fs.readFileString(f.path.join(f.root, 'target-0.md'))).toBe(f.content);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not reauthorize unchanged polls and cannot upgrade a replaced asynchronous revision', () =>
    Effect.gen(function* () {
      const f = yield* storedFixture();
      const original = draftController.readTopicMaintenanceDraft;
      let calls = 0;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(draftController, 'readTopicMaintenanceDraft').mockImplementation((...args) => {
            calls++;
            return original(...args);
          }),
        ),
        () =>
          Effect.gen(function* () {
            expect((yield* readManagerReviewEligibility(f.config, [f.review])).pendingCount).toBe(1);
            expect((yield* readManagerReviewEligibility(f.config, [f.review])).pendingCount).toBe(1);
            expect(calls).toBe(1);
          }),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      yield* advanceCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi
            .spyOn(draftController, 'readTopicMaintenanceDraft')
            .mockImplementation(() =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({...f.review, revision: 2}),
              ),
            ),
        ),
        () =>
          Effect.gen(function* () {
            const fiber = yield* readManagerReviewEligibility(f.config, [f.review]).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(fiber);
            expect(result.pendingCount).toBe(0);
            expect(result.background.awaitingSources).toBe(1);
          }),
        spy => Effect.sync(() => spy.mockRestore()),
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses a successful asynchronous read when the canonical source epoch changes before closing', () =>
    Effect.gen(function* () {
      const f = yield* storedFixture();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi
            .spyOn(draftController, 'readTopicMaintenanceDraft')
            .mockImplementation(() =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(f.review)),
            ),
        ),
        () =>
          Effect.gen(function* () {
            const fiber = yield* readManagerReviewEligibility(f.config, [f.review]).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* advanceCanonicalMutationGeneration(f.fs, f.path, f.home, 'local');
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(fiber);
            expect(result.pendingCount).toBe(0);
            expect(result.background.awaitingSources).toBe(1);
          }),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      expect((yield* readManagerReviewEligibility(f.config, [f.review])).pendingCount).toBe(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('groups a timed-out source check and retries only after its finite readiness boundary', () =>
    Effect.gen(function* () {
      const f = yield* storedFixture();
      const started = yield* Deferred.make<void>();
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi
            .spyOn(draftController, 'readTopicMaintenanceDraft')
            .mockImplementation(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
        ),
        () =>
          Effect.gen(function* () {
            const fiber = yield* readManagerReviewEligibility(f.config, [f.review]).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* TestClock.adjust('30 seconds');
            const result = yield* Fiber.join(fiber);
            expect(result.pendingCount).toBe(0);
            expect(result.background).toMatchObject({awaitingSources: 1, reasons: {'verification-unavailable': 1}});
          }),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      expect((yield* readManagerReviewEligibility(f.config, [f.review])).pendingCount).toBe(0);
      yield* TestClock.adjust('61 seconds');
      expect((yield* readManagerReviewEligibility(f.config, [f.review])).pendingCount).toBe(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

// Actual registry/project callbacks and admission; the source authorization oracle is deliberately controlled.
for (const differentCommit of [false, true]) {
  effectIt.effect(
    `settles retained A→B→A reviews without registration self-invalidation (${differentCommit ? 'two selectors' : 'one selector with different citation metadata'})`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'f010-registry-admission-'});
        const root = path.join(home, 'repository');
        const memoryRoot = path.join(home, 'data/local/user/tester/memories/durable/projects/alpha');
        yield* fs.makeDirectory(root);
        yield* fs.makeDirectory(memoryRoot, {recursive: true});
        const config = {
          account: 'local',
          user: 'tester',
          agentId: 'test',
          agentContextHome: home,
          manifestPath: path.join(home, 'manifest.yaml'),
        };
        yield* fs.writeFileString(
          config.manifestPath,
          `version: 1
projects:
  - name: alpha
    path: ${root}
    uri: threadnote://resources/repos/alpha
    seed: []
`,
        );
        for (const name of ['a.ts', 'b.ts'])
          yield* fs.writeFileString(path.join(root, name), 'export const fixture = 1;\n');
        const code = (name: string, commit: string) =>
          createMemoryCodeCitation({
            version: 1,
            evidenceRetention: 'capsule-retained',
            extractorSet: 'native-code-graph-13',
            fileContentHash: {algorithm: 'sha256', value: hash('export const fixture = 1;\n')},
            path: name,
            repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
            repositoryIdentityKind: 'remote',
            sourceCommit: commit,
            sourceDirty: false,
            sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
            target: {kind: 'file'},
          });
        const a = fixture(0, 'propose-update', code('a.ts', Effect2.pipe('a', EffectString.repeat(40))), root);
        const b = fixture(
          1,
          'propose-update',
          code(
            'b.ts',
            differentCommit ? Effect2.pipe('c', EffectString.repeat(40)) : Effect2.pipe('a', EffectString.repeat(40)),
          ),
          root,
        );
        for (const [index, item] of [a, b].entries()) {
          yield* fs.writeFileString(path.join(memoryRoot, `target-${index}.md`), item.content);
          yield* saveCandidateReview(home, item.review);
        }
        yield* fs.writeFileString(path.join(memoryRoot, 'source.md'), a.source);
        let sourceSuccesses = 0,
          unavailableEvents = 0;
        let available = yield* Deferred.make<void>();
        const observations: number[] = [];
        const spies = yield* Effect.acquireRelease(
          Effect.sync(() => [
            // The actual registry state machine and actual project callbacks are exercised. Only its source oracle is stable/controlled.
            vi.spyOn(health, 'makeManagerHealthLiveSources').mockImplementation((_config, callbacks) =>
              health.makeManagerHealthLiveRegistry({
                observe: (_project, input) =>
                  Effect.sync(() => {
                    observations.push(input.citations.length);
                    return {revision: 'unchanged-authorized-source', directories: []};
                  }),
                onInvalidate: callbacks.onInvalidate,
                onAvailability: (project, ready) =>
                  callbacks.onAvailability(project, ready).pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        if (!ready) unavailableEvents++;
                        else yield* Deferred.succeed(available, undefined);
                      }),
                    ),
                  ),
              }),
            ),
            // Full source authorization is a declared deterministic test seam; this test does not claim real graph freshness.
            vi
              .spyOn(evidence, 'readContextMaintenanceSourceEpoch')
              .mockImplementation(() => Effect.succeed('stable-source-epoch')),
            vi
              .spyOn(evidence, 'readContextMaintenanceCitationAssociation')
              .mockImplementation(() =>
                Effect.succeed({epoch: 'stable-route-epoch', roots: [root], bySelector: {}, sourceEpochs: {}}),
              ),
            vi.spyOn(draftController, 'readTopicMaintenanceDraft').mockImplementation((config, id) =>
              Effect.sync(() => {
                sourceSuccesses++;
              }).pipe(Effect.andThen(loadCandidateReview(config.agentContextHome, id))),
            ),
          ]),
          handles => Effect.sync(() => EffectArray.forEach(handles, handle => handle.mockRestore())),
        );
        void spies;
        const observer = yield* makeManagerProjectLiveObservation(config, {
          onInvalidate: () => Effect.void,
          onAvailability: () => Effect.void,
        }).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
        yield* observer.subscribe('all-reviews', [{topic: 'home', scope: 'account'}]);
        const warm = (item: typeof a) =>
          Effect.gen(function* () {
            const payload = item.review.maintenance;
            if (payload?.version !== 3) throw new Error('Expected an automatic fixture review.');
            available = yield* Deferred.make<void>();
            yield* observer.healthHints.register('alpha', {
              cwd: root,
              citations: EffectArray.flatMap(payload.basis.assessment.evidence, e =>
                e.source.kind === 'code' ? [e.source.citation] : [],
              ),
            });
            if (observer.reviewReadiness('alpha') !== true) yield* Deferred.await(available);
          });
        const admit = (item: typeof a) =>
          readManagerReviewEligibility(config, [item.review]).pipe(
            Effect.provideService(ManagerHealthObservationHints, observer.healthHints),
            Effect.provideService(ManagerReviewSourceReadiness, {current: observer.reviewReadiness}),
          );
        yield* warm(a);
        const stableControl = yield* admit(a);
        expect(stableControl.pendingCount).toBe(1);
        // Both vectors have been requested/retained before the A→B→A sequence. Physical sources never change.
        yield* warm(b);
        const stableUnavailable = unavailableEvents;
        const unchangedReviews = JSON.stringify([a.review, b.review]);
        const results = [];
        for (const item of [a, b, a]) {
          available = yield* Deferred.make<void>();
          const result = yield* admit(item);
          results.push({
            review: item === a ? 'A' : 'B',
            pendingCount: result.pendingCount,
            awaiting: result.background.awaitingSources,
            reasonCounts: result.background.reasons,
          });
          if (observer.reviewReadiness('alpha') !== true) yield* Deferred.await(available);
        }
        expect(sourceSuccesses).toBe(differentCommit ? 3 : 2);
        expect(unavailableEvents).toBe(stableUnavailable);
        expect(observations.at(-1)).toBe(differentCommit ? 2 : 1);
        expect(JSON.stringify([a.review, b.review])).toBe(unchangedReviews);
        yield* observer.release('all-reviews');
        // Expected product contract. Frozen4b17 fails here although every controlled source verification succeeded.
        expect(EffectArray.map(results, result => result.pendingCount)).toEqual([1, 1, 1]);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
}
