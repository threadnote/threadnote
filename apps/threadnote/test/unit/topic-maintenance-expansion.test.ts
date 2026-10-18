import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {loadCandidateReview, saveCandidateReview} from '@threadnote/memory/candidate';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {
  observeTopicMaintenanceEvidence,
  buildTopicMaintenanceEvidencePacket,
} from '@threadnote/context/topic_maintenance';
import {parseTopicMaintenanceDraft} from '@threadnote/memory/topic-maintenance-draft';
import {
  basisFromPacket,
  privateReview,
  readyEvidence,
  reviewEvidenceFromPacket,
} from '../../src/memory/context/maintenance_draft.js';
import {
  prepareTopicMaintenanceReview,
  applyTopicMaintenanceReview,
} from '../../src/memory/context/maintenance_review.js';
import {
  previewTopicDependencyExpansion,
  applyTopicDependencyExpansion,
  restartTopicDependencyExpansion,
  loadTopicDependencyExpansionPreview,
  inspectTopicDependencyExpansionRecovery,
} from '../../src/memory/maintenance/topic_expansion.js';
import {makeTopicExpansionFixture} from '../helpers/topic-expansion.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const approval = (f: Effect.Success<ReturnType<typeof makeTopicExpansionFixture>>) => ({
  preview: f.preview,
  revision: f.preview.revision,
  approvalDigest: f.preview.approvalDigest,
  approved: true,
});
const reviewId = (revision: string) => `review-${revision.slice(0, 24)}`;
const capsuleBytes = Effect.fn('test.expansionCapsuleBytes')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const values: Record<string, string> = {};
  const visit = (directory: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      for (const name of yield* fs.readDirectory(directory)) {
        const file = path.join(directory, name);
        const stat = yield* fs.stat(file);
        if (stat.type === 'Directory') yield* visit(file);
        else if (file.includes(`${path.sep}citation-evidence${path.sep}`) && file.endsWith('.json'))
          values[path.relative(home, file)] = yield* fs.readFileString(file);
      }
    });
  yield* visit(path.join(home, 'indexes', 'code-graph', 'repositories'));
  return values;
});

describe('reviewed bounded dependency expansion runtime', () => {
  effectIt.effect(
    'restarts an expired pre-capture intent with a fresh separately approved operation and immutable physical history',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const f = yield* makeTopicExpansionFixture();
        const original = yield* fs.readFileString(f.memoryPath);
        const originalCapsules = yield* capsuleBytes(f.home);
        const live = yield* Clock.Clock;
        let offset = 0;
        const shifted: Clock.Clock = {
          currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe() + BigInt(offset) * 1000000n,
          currentTimeNanos: live.currentTimeNanos.pipe(Effect.map(time => time + BigInt(offset) * 1000000n)),
          monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: live.monotonicTimeNanos,
          sleep: duration => live.sleep(duration),
          currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe() + offset,
          currentTimeMillis: live.currentTimeMillis.pipe(Effect.map(time => time + offset)),
        };
        yield* Effect.gen(function* () {
          const interrupted = yield* applyTopicDependencyExpansion(f.config, approval(f), {
            afterIntentSaved: () => Effect.fail('crash-before-capture'),
          }).pipe(Effect.result);
          expect(interrupted._tag).toBe('Failure');
          const prior = yield* loadCandidateReview(f.home, reviewId(f.preview.revision));
          expect(yield* capsuleBytes(f.home)).toEqual(originalCapsules);
          offset += 91 * 86400000;
          expect((yield* applyTopicDependencyExpansion(f.config, approval(f)).pipe(Effect.result))._tag).toBe(
            'Failure',
          );
          expect(
            (yield* previewTopicDependencyExpansion(f.config, {
              uri: f.uri,
              callerCwd: f.repository,
              input: f.selectedInput,
            })).preview,
          ).toEqual(f.preview);
          expect(yield* capsuleBytes(f.home)).toEqual(originalCapsules);
          expect(yield* inspectTopicDependencyExpansionRecovery(f.config, approval(f))).toEqual({canRestart: true});
          yield* fs.writeFileString(f.memoryPath, original + 'changed');
          expect((yield* restartTopicDependencyExpansion(f.config, approval(f)).pipe(Effect.result))._tag).toBe(
            'Failure',
          );
          yield* fs.writeFileString(f.memoryPath, original);
          const manifest = yield* fs.readFileString(f.config.manifestPath);
          yield* fs.writeFileString(f.config.manifestPath, manifest + '\n');
          expect((yield* restartTopicDependencyExpansion(f.config, approval(f)).pipe(Effect.result))._tag).toBe(
            'Failure',
          );
          yield* fs.writeFileString(f.config.manifestPath, manifest);
          const wrong = {...approval(f), approvalDigest: '0'.repeat(64)};
          expect((yield* restartTopicDependencyExpansion(f.config, wrong).pipe(Effect.result))._tag).toBe('Failure');
          expect(
            (yield* restartTopicDependencyExpansion(f.config, approval(f), {
              afterSupersessionSaved: () => Effect.fail('crash-before-successor-save'),
            }).pipe(Effect.result))._tag,
          ).toBe('Failure');
          const interruptedSuccessor = (yield* loadCandidateReview(f.home, prior.reviewId)).dependencyExpansion!
            .successor!;
          const freshRead = yield* loadTopicDependencyExpansionPreview(f.config, interruptedSuccessor);
          expect(freshRead?.revision).toBe(interruptedSuccessor.revision);
          expect(
            yield* fs.exists(
              path.join(f.home, 'threadnote/candidates/v1/reviews', `${reviewId(interruptedSuccessor.revision)}.json`),
            ),
          ).toBe(false);
          const first = yield* restartTopicDependencyExpansion(f.config, approval(f));
          expect(first.preview.revision).not.toBe(f.preview.revision);
          expect(first.preview.beforeContent).toBe(f.preview.beforeContent);
          expect(first.preview.operation?.generation).toBe(1);
          expect(yield* fs.readFileString(f.memoryPath)).toBe(original);
          expect(yield* capsuleBytes(f.home)).toEqual(originalCapsules);
          const closed = yield* loadCandidateReview(f.home, prior.reviewId);
          expect(closed.createdAt).toBe(prior.createdAt);
          expect(closed.dependencyExpansion?.preview).toEqual(prior.dependencyExpansion?.preview);
          expect(closed.dependencyExpansion?.stage).toBe('superseded');
          const same = yield* Effect.all(
            [
              restartTopicDependencyExpansion(f.config, approval(f)),
              restartTopicDependencyExpansion(f.config, approval(f)),
            ],
            {concurrency: 2},
          );
          expect(same.map(value => value.preview)).toEqual([first.preview, first.preview]);
          expect((yield* applyTopicDependencyExpansion(f.config, approval(f)).pipe(Effect.result))._tag).toBe(
            'Failure',
          );
          // A successor preview can itself expire before approval; the next explicit restart is a bounded new operation.
          offset += 91 * 86400000;
          const nextApproval = {
            preview: first.preview,
            revision: first.preview.revision,
            approvalDigest: first.preview.approvalDigest,
            approved: true,
          };
          const second = yield* restartTopicDependencyExpansion(f.config, nextApproval);
          expect(second.preview.operation?.generation).toBe(2);
          expect((yield* applyTopicDependencyExpansion(f.config, nextApproval).pipe(Effect.result))._tag).toBe(
            'Failure',
          );
          const exact = {
            preview: second.preview,
            revision: second.preview.revision,
            approvalDigest: second.preview.approvalDigest,
            approved: true,
          };
          expect(
            (yield* applyTopicDependencyExpansion(f.config, {...exact, approved: false}).pipe(Effect.result))._tag,
          ).toBe('Failure');
          expect(yield* loadTopicDependencyExpansionPreview(f.config, exact)).toEqual(second.preview);
          const written = yield* applyTopicDependencyExpansion(f.config, exact, {
            afterCanonicalWrite: () => Effect.fail('crash-after-write'),
          }).pipe(Effect.result);
          expect(written._tag).toBe('Failure');
          expect(yield* fs.readFileString(f.memoryPath)).toBe(second.preview.content);
          expect((yield* restartTopicDependencyExpansion(f.config, exact).pipe(Effect.result))._tag).toBe('Failure');
          const reserved = yield* loadCandidateReview(f.home, reviewId(second.preview.revision));
          const writtenCapsules = yield* capsuleBytes(f.home);
          for (const [name, bytes] of Object.entries(originalCapsules)) expect(writtenCapsules[name]).toBe(bytes);
          const added = Object.entries(writtenCapsules).filter(([name]) => !(name in originalCapsules));
          expect(added.length).toBeGreaterThan(0);
          for (const [, bytes] of added) expect(JSON.parse(bytes).retainedAt).toBe(reserved.createdAt);
          expect((yield* applyTopicDependencyExpansion(f.config, exact)).status).toBe('already-expanded');
          expect(yield* capsuleBytes(f.home)).toEqual(writtenCapsules);
          expect((yield* loadCandidateReview(f.home, prior.reviewId)).dependencyExpansion).toEqual(
            closed.dependencyExpansion,
          );
          expect(parseMemoryDocument(f.uri, yield* fs.readFileString(f.memoryPath))!.body).toBe(f.body);
        }).pipe(Effect.provideService(Clock.Clock, shifted));
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 60000},
  );
  effectIt.effect(
    'maintains code V3 normally on the next source update without rediscovering or losing expansion history',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const f = yield* makeTopicExpansionFixture();
        yield* applyTopicDependencyExpansion(f.config, approval(f));
        const expanded = parseMemoryDocument(f.uri, yield* fs.readFileString(f.memoryPath))!;
        const history = expanded.metadata.topicMaintenance;
        if (history?.version !== 3 || history.sourceKind !== 'code') throw new Error('Expected expanded code topic.');
        yield* fs.writeFileString(path.join(f.repository, 'src/dependency.ts'), 'export const dependency = 48;\n');
        yield* f.commit('update dependency');
        yield* f.index();
        const observation = yield* observeTopicMaintenanceEvidence(f.config, expanded, f.repository);
        expect(observation.canDraft).toBe(true);
        const packet = readyEvidence(
          yield* buildTopicMaintenanceEvidencePacket(f.config, expanded, f.repository, observation),
        );
        if (packet.version !== 1) throw new Error('Expected code packet.');
        const basis = basisFromPacket(packet);
        const dependency = history.additionalDependencies[0].citationId;
        const handle = `current:${dependency}`;
        const draft = parseTopicMaintenanceDraft(
          basis,
          JSON.stringify({
            version: 1,
            targetHash: basis.targetHash,
            observationRevision: basis.observationRevision,
            packetDigest: basis.packetDigest,
            outcome: 'propose-update',
            operations: [
              {
                ordinal: 0,
                beforeHash: basis.paragraphs[0].hash,
                text: 'The implementation uses the reviewed 48 limit.',
                supportHandles: [handle],
                rationale: 'Explicit dependency changed.',
              },
            ],
            paragraphDispositions: {
              version: 1,
              entries: [
                {
                  ordinal: 0,
                  beforeHash: basis.paragraphs[0].hash,
                  disposition: 'update',
                  supportHandles: [handle],
                  rationale: 'Current explicit dependency.',
                },
              ],
            },
            reviewedHandles: [handle],
            rationale: 'Update descriptive claim.',
            unresolvedQuestions: [],
            removedClaims: [basis.body.split('\n\n')[0]],
          }),
        );
        const review = privateReview(
          undefined,
          basis,
          {
            version: 1,
            basis,
            proposal: draft,
            reviewEvidence: reviewEvidenceFromPacket(packet),
            generation: {
              origin: 'manual',
              agent: 'manual',
              model: 'none',
              promptVersion: 'manual-topic-v1',
              attempts: 0,
              usage: {status: 'unavailable'},
            },
          },
          'fixture',
          'limit',
          [],
          '2026-10-18T00:00:00.000Z',
        );
        yield* saveCandidateReview(f.home, review);
        const prepared = yield* prepareTopicMaintenanceReview(f.config, {
          reviewId: review.reviewId,
          revision: review.revision,
          sourceCwd: f.repository,
        });
        yield* applyTopicMaintenanceReview(f.config, {
          reviewId: review.reviewId,
          revision: prepared.maintenanceApproval!.reviewRevision,
          approvalDigest: prepared.maintenanceApproval!.preview.approvalDigest,
          approved: true,
          sourceCwd: f.repository,
        });
        const accepted = parseMemoryDocument(f.uri, yield* fs.readFileString(f.memoryPath))!;
        expect(accepted.metadata.topicMaintenanceError).toBeUndefined();
        expect(accepted.body).toBe(
          'The implementation uses the reviewed 48 limit.\n\n' + f.body.split('\n\n').slice(1).join('\n\n'),
        );
        expect(accepted.metadata.topicMaintenance).toMatchObject({
          version: 3,
          sourceKind: 'code',
          dependencyExpansions: history.dependencyExpansions,
        });
        expect(accepted.metadata.codeCitations).toContainEqual(f.origin);
        expect(
          (yield* observeTopicMaintenanceEvidence(f.config, accepted, f.repository, undefined, {allowCapture: false}))
            .outcome,
        ).toBe('unchanged');
        yield* fs.writeFileString(path.join(f.repository, 'src/dependency.ts'), 'export const dependency = 64;\n');
        yield* f.commit('fresh active drift');
        yield* f.index();
        expect((yield* observeTopicMaintenanceEvidence(f.config, accepted, f.repository)).outcome).toBe(
          'review-required',
        );
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 60000},
  );
  effectIt.effect(
    'previews without retaining evidence and applies exact metadata once with crash-safe receipt recovery',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeTopicExpansionFixture();
        const before = yield* fs.readFileString(f.memoryPath);
        const priorObservation = yield* observeTopicMaintenanceEvidence(f.config, f.record, f.repository);
        const priorPacket = readyEvidence(
          yield* buildTopicMaintenanceEvidencePacket(f.config, f.record, f.repository, priorObservation),
        );
        if (priorPacket.version !== 1) throw new Error('Expected code packet');
        const priorBasis = basisFromPacket(priorPacket);
        const priorHandle = `current:${f.origin.id}`;
        const priorProposal = parseTopicMaintenanceDraft(
          priorBasis,
          JSON.stringify({
            version: 1,
            targetHash: priorBasis.targetHash,
            observationRevision: priorBasis.observationRevision,
            packetDigest: priorBasis.packetDigest,
            outcome: 'propose-revalidation',
            operations: [],
            paragraphDispositions: {
              version: 1,
              entries: [
                {
                  ordinal: 0,
                  beforeHash: priorBasis.paragraphs[0].hash,
                  disposition: 'revalidate',
                  supportHandles: [priorHandle],
                  rationale: 'Explicit manual review.',
                },
              ],
            },
            reviewedHandles: [priorHandle],
            rationale: 'Review existing scope.',
            unresolvedQuestions: [],
            removedClaims: [],
          }),
        );
        const pending = privateReview(
          undefined,
          priorBasis,
          {
            version: 1,
            basis: priorBasis,
            proposal: priorProposal,
            reviewEvidence: reviewEvidenceFromPacket(priorPacket),
            generation: {
              origin: 'manual',
              agent: 'manual',
              model: 'none',
              promptVersion: 'manual-topic-v1',
              attempts: 0,
              usage: {status: 'unavailable'},
            },
          },
          'fixture',
          'limit',
          [],
          '2026-10-18T00:00:00.000Z',
        );
        yield* saveCandidateReview(f.home, pending);
        const pins = yield* capsuleBytes(f.home);
        const another = yield* previewTopicDependencyExpansion(f.config, {
          uri: f.uri,
          callerCwd: f.repository,
          input: f.selectedInput,
        });
        expect(another.preview).toEqual(f.preview);
        expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
        expect(yield* capsuleBytes(f.home)).toEqual(pins);
        const result = yield* applyTopicDependencyExpansion(f.config, approval(f));
        expect(result.status).toBe('expanded');
        const accepted = yield* fs.readFileString(f.memoryPath);
        const record = parseMemoryDocument(f.uri, accepted)!;
        expect(record.body).toBe(f.body);
        expect(record.metadata.topicMaintenance).toMatchObject({version: 3, sourceKind: 'code'});
        expect(record.metadata.codeCitations).toContainEqual(f.origin);
        expect(
          (yield* prepareTopicMaintenanceReview(f.config, {
            reviewId: pending.reviewId,
            revision: pending.revision,
            sourceCwd: f.repository,
          }).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(yield* fs.readFileString(f.memoryPath)).toBe(accepted);
        const mtime = (yield* fs.stat(f.memoryPath)).mtime;
        const retained = yield* capsuleBytes(f.home);
        expect((yield* applyTopicDependencyExpansion(f.config, approval(f))).status).toBe('already-expanded');
        expect((yield* fs.stat(f.memoryPath)).mtime).toEqual(mtime);
        expect(yield* capsuleBytes(f.home)).toEqual(retained);
        const journal = yield* loadCandidateReview(f.home, reviewId(f.preview.revision));
        yield* saveCandidateReview(f.home, {
          ...journal,
          dependencyExpansion: {...journal.dependencyExpansion!, stage: 'prepared'},
        });
        expect((yield* applyTopicDependencyExpansion(f.config, approval(f))).status).toBe('already-expanded');
        expect(yield* fs.readFileString(f.memoryPath)).toBe(accepted);
        expect((yield* fs.stat(f.memoryPath)).mtime).toEqual(mtime);
        expect((yield* loadCandidateReview(f.home, journal.reviewId)).dependencyExpansion?.stage).toBe('written');
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 60000},
  );

  effectIt.effect(
    'journals the exact identity before capture and retries both prewrite crash windows without renewed capsules',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeTopicExpansionFixture();
        const before = yield* fs.readFileString(f.memoryPath);
        const first = yield* applyTopicDependencyExpansion(f.config, approval(f), {
          afterIntentSaved: () => Effect.fail('simulated capture-before-dispatch crash'),
        }).pipe(Effect.result);
        expect(first._tag).toBe('Failure');
        const intent = yield* loadCandidateReview(f.home, reviewId(f.preview.revision));
        expect(intent.dependencyExpansion?.stage).toBe('prepared');
        expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
        const captured = yield* applyTopicDependencyExpansion(f.config, approval(f), {
          afterEvidenceRetained: () => Effect.fail('simulated capture-after-write crash'),
        }).pipe(Effect.result);
        expect(captured._tag).toBe('Failure');
        const retained = yield* capsuleBytes(f.home);
        const selectedCapsule = Object.values(retained).find(content => content.includes('"path":"src/dependency.ts"'));
        expect(selectedCapsule).toBeDefined();
        expect(JSON.parse(selectedCapsule ?? 'null')).toMatchObject({retainedAt: intent.createdAt});
        expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
        expect((yield* applyTopicDependencyExpansion(f.config, approval(f))).status).toBe('expanded');
        expect(yield* capsuleBytes(f.home)).toEqual(retained);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 60000},
  );

  effectIt.effect(
    'recovers canonical-write-before-final-receipt failure without double-writing',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeTopicExpansionFixture();
        const failed = yield* applyTopicDependencyExpansion(f.config, approval(f), {
          afterCanonicalWrite: () => Effect.fail('simulated write-before-receipt crash'),
        }).pipe(Effect.result);
        expect(failed._tag).toBe('Failure');
        expect(yield* fs.readFileString(f.memoryPath)).toBe(f.preview.content);
        const mtime = (yield* fs.stat(f.memoryPath)).mtime;
        expect((yield* loadCandidateReview(f.home, reviewId(f.preview.revision))).dependencyExpansion?.stage).toBe(
          'prepared',
        );
        expect((yield* applyTopicDependencyExpansion(f.config, approval(f))).status).toBe('already-expanded');
        expect((yield* fs.stat(f.memoryPath)).mtime).toEqual(mtime);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 60000},
  );

  effectIt.effect(
    'keeps prewrite target/source/config races from changing accepted bytes',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const f = yield* makeTopicExpansionFixture();
        const before = yield* fs.readFileString(f.memoryPath);
        yield* fs.writeFileString(
          f.config.manifestPath,
          (yield* fs.readFileString(f.config.manifestPath)) + '# configuration changed at the same commit\n',
        );
        expect((yield* applyTopicDependencyExpansion(f.config, approval(f)).pipe(Effect.result))._tag).toBe('Failure');
        expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
        yield* fs.writeFileString(
          f.config.manifestPath,
          (yield* fs.readFileString(f.config.manifestPath)).replace('# configuration changed at the same commit\n', ''),
        );
        const sourceRace = yield* applyTopicDependencyExpansion(f.config, approval(f), {
          afterEvidenceRetained: () =>
            fs.writeFileString(path.join(f.repository, 'src/dependency.ts'), 'export const dependency = 48;\n'),
        }).pipe(Effect.result);
        expect(sourceRace._tag).toBe('Failure');
        expect(yield* fs.readFileString(f.memoryPath)).toBe(before);
        yield* fs.writeFileString(path.join(f.repository, 'src/dependency.ts'), 'export const dependency = 32;\n');
        const concurrent = before + '\n\nA concurrent author edit.';
        const targetRace = yield* applyTopicDependencyExpansion(f.config, approval(f), {
          afterEvidenceRetained: () => fs.writeFileString(f.memoryPath, concurrent),
        }).pipe(Effect.result);
        expect(targetRace._tag).toBe('Failure');
        expect(yield* fs.readFileString(f.memoryPath)).toBe(concurrent);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 60000},
  );

  effectIt.effect(
    'records a true postwrite closing conflict and retains exact written provenance without rollback',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const f = yield* makeTopicExpansionFixture();
        const result = yield* applyTopicDependencyExpansion(f.config, approval(f), {
          afterCanonicalWrite: () =>
            fs.writeFileString(path.join(f.repository, 'src/dependency.ts'), 'export const dependency = 48;\n'),
        }).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        expect(yield* fs.readFileString(f.memoryPath)).toBe(f.preview.content);
        expect(parseMemoryDocument(f.uri, f.preview.content)!.metadata.codeCitations).toContainEqual(f.origin);
        expect((yield* loadCandidateReview(f.home, reviewId(f.preview.revision))).dependencyExpansion?.stage).toBe(
          'conflict',
        );
        expect((yield* applyTopicDependencyExpansion(f.config, approval(f)).pipe(Effect.result))._tag).toBe('Failure');
        expect(yield* fs.readFileString(f.memoryPath)).toBe(f.preview.content);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 60000},
  );
});
