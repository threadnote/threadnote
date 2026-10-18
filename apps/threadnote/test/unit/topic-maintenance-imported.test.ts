import {ResourceStore} from '@threadnote/store/resource-store';
import {runExportPack} from '../../src/memory/commands.js';
import {runObsidianProjectionAdd, runObsidianProjectionSync} from '@threadnote/integration-obsidian/projection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {runSelectedDraft} from '../../src/manager/selected_draft.js';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {managerImportedTopicFixture} from '../helpers/manager-imported-topic.js';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {loadCandidateReview, saveCandidateReview} from '@threadnote/memory/candidate';
import {parseTopicMaintenanceDraft, validateTopicMaintenanceReview} from '@threadnote/memory/topic-maintenance-draft';
import {memoryCodeCitationContentSharingBlocker} from '@threadnote/memory/code/citation-policy';
import {projectKnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {
  captureTopicObsidianEvidence,
  topicObsidianReviewId,
  inspectTopicObsidianState,
  readTopicObsidianPacket,
} from '../../src/memory/context/maintenance_obsidian.js';
import {readContextMaintenancePacket} from '../../src/memory/context/maintenance.js';
import {
  basisFromPacket,
  privateReview,
  readyEvidence,
  reviewEvidenceFromPacket,
  readTopicMaintenanceDraft,
  requestTopicMaintenanceDraft,
} from '../../src/memory/context/maintenance_draft.js';
import {
  prepareTopicMaintenanceReview,
  applyTopicMaintenanceReview,
} from '../../src/memory/context/maintenance_review.js';
import {runObsidianSourceRemove} from '@threadnote/integration-obsidian/source';

const reviewedFixture = Effect.gen(function* () {
  const f = yield* managerImportedTopicFixture();
  yield* captureTopicObsidianEvidence(f.config, f.captureInput);
  const packet = readyEvidence(yield* readContextMaintenancePacket(f.config, f.caseId));
  const basis = basisFromPacket(packet);
  const prior = yield* loadCandidateReview(f.home, topicObsidianReviewId(f.uri));
  const handles = basis.handles.filter(handle => handle.variant === 'current').map(handle => handle.id);
  const draft = {
    version: 1,
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    packetDigest: basis.packetDigest,
    outcome: 'propose-update',
    operations: [
      {
        ordinal: 0,
        beforeHash: basis.paragraphs[0].hash,
        text: 'Current descriptive claim.',
        supportHandles: handles,
        rationale: 'Reviewed exact current fragment.',
      },
    ],
    reviewedHandles: handles,
    rationale: 'Reviewed source.',
    unresolvedQuestions: [],
    removedClaims: [],
    paragraphDispositions: {
      version: 1,
      entries: [
        {
          ordinal: 0,
          beforeHash: basis.paragraphs[0].hash,
          disposition: 'update',
          supportHandles: handles,
          rationale: 'Current fragment supports the update.',
        },
      ],
    },
  };
  const proposal = parseTopicMaintenanceDraft(basis, JSON.stringify(draft), {requireParagraphDispositions: true});
  const payload = validateTopicMaintenanceReview({
    version: 2,
    sourceKind: 'obsidian',
    basis,
    proposal,
    reviewEvidence: reviewEvidenceFromPacket(packet),
    generation: {
      origin: 'manual',
      agent: 'manual',
      model: 'none',
      promptVersion: 'manual-topic-v1',
      attempts: 0,
      usage: {status: 'unavailable'},
    },
  });
  const review = privateReview(prior, basis, payload, 'notes', 'imported-topic', [], '2026-10-18T00:00:00.000Z');
  yield* saveCandidateReview(f.home, review);
  return {...f, review, basis, draft};
});

effectIt.effect(
  'applies an edited exact imported preview once, preserves origin and protected bytes, and recovers after canonical write',
  () =>
    Effect.gen(function* () {
      const f = yield* reviewedFixture;
      const edited = {
        ...f.draft,
        operations: f.draft.operations.map(operation => ({...operation, text: 'Edited current descriptive claim.'})),
      };
      const previewed = yield* prepareTopicMaintenanceReview(f.config, {
        reviewId: f.review.reviewId,
        revision: f.review.revision,
        editedDraftJson: JSON.stringify(edited),
      });
      const preview = previewed.maintenanceApproval!.preview;
      expect(preview.content).toContain('Historical constraint.');
      expect(preview.content).toContain('Edited current descriptive claim.');
      expect(preview.content.split('\n').find(line => line.startsWith('obsidian_evidence:'))).toBe(
        f.record.content.split('\n').find(line => line.startsWith('obsidian_evidence:')),
      );
      expect(memoryCodeCitationContentSharingBlocker(f.uri, preview.content)).toBe('private-obsidian-evidence');
      expect(() => projectKnowledgeDeltaV1(previewed)).toThrow('Private imported');
      const args = {
        reviewId: previewed.reviewId,
        revision: previewed.revision,
        approvalDigest: preview.approvalDigest,
        approved: true,
      };
      const applied = yield* applyTopicMaintenanceReview(f.config, args);
      expect(applied.maintenanceApproval?.stage).toBe('written');
      expect((yield* applyTopicMaintenanceReview(f.config, args)).revision).toBe(applied.revision);
      const accepted = parseMemoryDocument(f.uri, yield* f.store.read(f.location, f.uri))!;
      expect(accepted.metadata.obsidianEvidence).toEqual(f.origin);
      expect(accepted.metadata.topicMaintenance).toMatchObject({
        version: 3,
        sourceKind: 'obsidian',
        activeEvidence: f.review.maintenanceCapture?.citation,
      });
      // Recreate the precise write-before-final-receipt crash window without rewriting accepted bytes.
      yield* saveCandidateReview(f.home, {
        ...previewed,
        revision: previewed.revision + 1,
        candidates: previewed.candidates.map(candidate => ({...candidate, state: 'applying'})),
        maintenanceApproval: {...previewed.maintenanceApproval!, stage: 'prepared'},
      });
      const recovered = yield* applyTopicMaintenanceReview(f.config, args);
      expect(recovered.maintenanceApproval?.stage).toBe('written');
      expect(yield* f.store.read(f.location, f.uri)).toBe(preview.content);
      expect(yield* f.fs.readDirectory(f.path.join(f.home, 'threadnote/sources/obsidian/notes/evidence'))).toHaveLength(
        2,
      );
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect(
  'withholds persisted review text and refuses preview/apply after source removal without changing accepted bytes',
  () =>
    Effect.gen(function* () {
      const f = yield* reviewedFixture;
      const previewed = yield* prepareTopicMaintenanceReview(f.config, {
        reviewId: f.review.reviewId,
        revision: f.review.revision,
      });
      const before = yield* f.store.read(f.location, f.uri);
      yield* runObsidianSourceRemove(f.config, {apply: true, id: 'notes'});
      expect(Result.isFailure(yield* readTopicMaintenanceDraft(f.config, f.review.reviewId).pipe(Effect.result))).toBe(
        true,
      );
      expect(
        Result.isFailure(
          yield* prepareTopicMaintenanceReview(f.config, {
            reviewId: f.review.reviewId,
            revision: previewed.revision,
          }).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* applyTopicMaintenanceReview(f.config, {
            reviewId: f.review.reviewId,
            revision: previewed.revision,
            approvalDigest: previewed.maintenanceApproval!.preview.approvalDigest,
            approved: true,
          }).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(yield* f.store.read(f.location, f.uri)).toBe(before);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect('reconciles capture-after-rename with the original fixed reservation and no second pin', () =>
  Effect.gen(function* () {
    const f = yield* managerImportedTopicFixture();
    const captured = yield* captureTopicObsidianEvidence(f.config, f.captureInput);
    const intent = captured.maintenanceCapture!;
    const {citation: _citation, ...reserved} = intent;
    yield* saveCandidateReview(f.home, {
      ...captured,
      revision: captured.revision + 1,
      maintenanceCapture: {...reserved, stage: 'reserved'},
    });
    const directory = f.path.join(f.home, 'threadnote/sources/obsidian/notes/evidence');
    const before = yield* Effect.forEach(yield* f.fs.readDirectory(directory), file =>
      f.fs.readFileString(f.path.join(directory, file)),
    );
    const recovered = yield* captureTopicObsidianEvidence(f.config, f.captureInput);
    expect(recovered.maintenanceCapture).toEqual(intent);
    expect(
      yield* Effect.forEach(yield* f.fs.readDirectory(directory), file =>
        f.fs.readFileString(f.path.join(directory, file)),
      ),
    ).toEqual(before);
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect(
  'draft generation uses real note handles, caches without another pin, and never supplies code source fields',
  () =>
    Effect.gen(function* () {
      const f = yield* managerImportedTopicFixture();
      yield* captureTopicObsidianEvidence(f.config, f.captureInput);
      const originalStore = yield* LocalModelStore;
      const modelId = 'gemma-4-e4b-it-q4';
      const manifest = yield* (yield* LocalModelCatalog).get(modelId);
      const store = LocalModelStore.of({
        ...originalStore,
        status: (_home, selected) =>
          Effect.succeed({
            bytes: selected.size,
            installed: true,
            modelId: selected.id,
            partialBytes: 0,
            path: '/fake/model.gguf',
            verified: true,
          }),
      });
      let calls = 0;
      const generate: typeof runSelectedDraft = (_config, _agent, _model, prompt, _purpose, basis) =>
        Effect.sync(() => {
          calls++;
          if (!basis || basis.version !== 2) throw new Error('Expected imported generation basis.');
          expect(prompt).toContain('current:tnob_');
          expect(prompt).not.toContain('sourceCommit');
          const current = basis.handles.filter(handle => handle.variant === 'current').map(handle => handle.id);
          return {
            text: JSON.stringify({
              version: 1,
              targetHash: basis.targetHash,
              observationRevision: basis.observationRevision,
              packetDigest: basis.packetDigest,
              outcome: 'propose-revalidation',
              operations: [],
              reviewedHandles: current,
              rationale: 'Checked exact current note fragment.',
              unresolvedQuestions: [],
              removedClaims: [],
              paragraphDispositions: {
                version: 1,
                entries: basis.paragraphs
                  .filter(paragraph => paragraph.role === 'descriptive' && paragraph.support === 'direct')
                  .map(paragraph => ({
                    ordinal: paragraph.ordinal,
                    beforeHash: paragraph.hash,
                    disposition: 'revalidate',
                    supportHandles: current,
                    rationale: 'Reviewed unchanged.',
                  })),
              },
            }),
            backendIdentity: 'local-ai',
            modelIdentity: modelId,
            modelVersion: `${manifest.revision}:${manifest.sha256}`,
            usage: {status: 'unavailable' as const},
            settings: {maxOutputTokens: 4000 as const, seed: 0 as const},
          };
        });
      const request = () =>
        requestTopicMaintenanceDraft(f.config, {caseId: f.caseId, backend: 'local-ai', modelId}, generate).pipe(
          Effect.provideService(LocalModelStore, store),
        );
      const first = yield* request();
      const retry = yield* request();
      expect(calls).toBe(1);
      expect(retry).toEqual(first);
      expect(first.maintenance).toMatchObject({version: 2, sourceKind: 'obsidian', proposal: {changedOrdinals: []}});
      expect(yield* f.fs.readDirectory(f.path.join(f.home, 'threadnote/sources/obsidian/notes/evidence'))).toHaveLength(
        2,
      );
      expect(yield* f.store.read(f.location, f.uri)).toBe(f.record.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect('origin expiry blocks a new draft despite an unexpired current capture and preserves both pins', () =>
  Effect.gen(function* () {
    const f = yield* managerImportedTopicFixture().pipe(TestClock.withLive);
    yield* TestClock.setTime(yield* Clock.currentTimeMillis.pipe(TestClock.withLive));
    yield* captureTopicObsidianEvidence(f.config, {...f.captureInput, retentionDays: 365});
    const directory = f.path.join(f.home, 'threadnote/sources/obsidian/notes/evidence');
    const before = (yield* f.fs.readDirectory(directory)).sort();
    yield* TestClock.setTime(Date.parse(f.origin.expiresAt) + 1);
    const state = yield* inspectTopicObsidianState(f.config, f.record);
    expect(state.observation.outcome).toBe('unavailable');
    expect(state.original.historical).toBe('expired');
    const packet = yield* readTopicObsidianPacket(f.config, f.record);
    expect(packet).toMatchObject({outcome: 'unavailable', canDraft: false, obsidian: {}});
    expect((yield* f.fs.readDirectory(directory)).sort()).toEqual(before);
    expect(
      Result.isFailure(
        yield* captureTopicObsidianEvidence(f.config, {...f.captureInput, retentionDays: 365}).pipe(Effect.result),
      ),
    ).toBe(true);
    expect((yield* f.fs.readDirectory(directory)).sort()).toEqual(before);
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect.prop(
  'approved capture retries preserve journal reservation and pin bytes for bounded exact selections',
  {
    length: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 16})),
    days: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 365})),
  },
  ({length, days}) =>
    Effect.gen(function* () {
      const f = yield* managerImportedTopicFixture();
      const input = {...f.captureInput, fragmentEnd: length, retentionDays: days};
      const first = yield* captureTopicObsidianEvidence(f.config, input);
      const directory = f.path.join(f.home, 'threadnote/sources/obsidian/notes/evidence');
      const files = (yield* f.fs.readDirectory(directory)).sort();
      const bytes = yield* Effect.forEach(files, file => f.fs.readFileString(f.path.join(directory, file)));
      const repeated = yield* captureTopicObsidianEvidence(f.config, input);
      expect(repeated).toEqual(first);
      expect((yield* f.fs.readDirectory(directory)).sort()).toEqual(files);
      expect(yield* Effect.forEach(files, file => f.fs.readFileString(f.path.join(directory, file)))).toEqual(bytes);
      expect(
        Result.isFailure(
          yield* captureTopicObsidianEvidence(f.config, {...input, approved: false}).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(yield* loadCandidateReview(f.home, first.reviewId)).toEqual(first);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  {arbitrary: {runs: 8}},
);

effectIt.effect('refuses pack export and Obsidian projection for imported root and nested provenance', () =>
  Effect.gen(function* () {
    const f = yield* managerImportedTopicFixture();
    const output = f.path.join(f.home, 'private-export.json');
    expect(Result.isFailure(yield* runExportPack(f.config, {uri: f.uri, path: output}).pipe(Effect.result))).toBe(true);
    expect(yield* f.fs.exists(output)).toBe(false);
    const vault = f.path.join(f.home, 'projection-vault');
    yield* f.fs.makeDirectory(vault);
    yield* runObsidianProjectionAdd(f.config, {
      id: 'private-test',
      vault,
      folder: 'Threadnote',
      selectedUris: [f.uri],
      apply: true,
    });
    const projection = yield* runObsidianProjectionSync(f.config, {id: 'private-test', apply: true});
    expect(projection.some(entry => entry.uri === f.uri && entry.action === 'add')).toBe(false);
    const malformed = f.record.content
      .split('\n')
      .filter(line => !line.startsWith('obsidian_evidence:'))
      .join('\n');
    yield* f.store.write(f.location, f.uri, malformed, {mode: 'replace'});
    expect(Result.isFailure(yield* runExportPack(f.config, {uri: f.uri, path: output}).pipe(Effect.result))).toBe(true);
    expect(yield* f.fs.exists(output)).toBe(false);
    const nested = yield* runObsidianProjectionSync(f.config, {id: 'private-test', apply: true});
    expect(nested.some(entry => entry.uri === f.uri && entry.action === 'add')).toBe(false);
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

for (const race of ['source-before-write', 'target-before-write', 'source-after-write'] as const) {
  effectIt.effect(`fails closed on imported ${race} without deleting retained evidence`, () =>
    Effect.gen(function* () {
      const f = yield* reviewedFixture;
      const previewed = yield* prepareTopicMaintenanceReview(f.config, {
        reviewId: f.review.reviewId,
        revision: f.review.revision,
      });
      const preview = previewed.maintenanceApproval!.preview;
      const args = {
        reviewId: previewed.reviewId,
        revision: previewed.revision,
        approvalDigest: preview.approvalDigest,
        approved: true,
      };
      let fired = false;
      const racedContent = f.record.content + '\n\nA concurrent target edit.';
      const wrapped = ResourceStore.of({
        ...f.store,
        writeChecked: (location, uri, content, options, check) => {
          if (fired || uri !== f.uri) return f.store.writeChecked(location, uri, content, options, check);
          fired = true;
          const before = Effect.gen(function* () {
            if (race === 'source-before-write')
              yield* f.fs.writeFileString(f.notePath, 'Unsynced raced source.').pipe(Effect.orDie);
            if (race === 'target-before-write')
              yield* f.fs
                .writeFileString(
                  f.path.join(f.home, 'data/local/user/tester/memories/durable/projects/notes/imported-topic.md'),
                  racedContent,
                )
                .pipe(Effect.orDie);
            yield* check;
          });
          return f.store
            .writeChecked(location, uri, content, options, before)
            .pipe(
              Effect.tap(() =>
                race === 'source-after-write'
                  ? f.fs.writeFileString(f.notePath, 'Unsynced closing source.').pipe(Effect.orDie)
                  : Effect.void,
              ),
            );
        },
      });
      expect(
        Result.isFailure(
          yield* applyTopicMaintenanceReview(f.config, args).pipe(
            Effect.provideService(ResourceStore, wrapped),
            Effect.result,
          ),
        ),
      ).toBe(true);
      expect(fired).toBe(true);
      expect(yield* f.store.read(f.location, f.uri)).toBe(
        race === 'source-after-write'
          ? preview.content
          : race === 'target-before-write'
            ? racedContent
            : f.record.content,
      );
      const receipt = yield* loadCandidateReview(f.home, f.review.reviewId);
      expect(receipt.maintenanceApproval?.stage).toBe(race === 'source-before-write' ? 'prepared' : 'conflict');
      expect(yield* f.fs.readDirectory(f.path.join(f.home, 'threadnote/sources/obsidian/notes/evidence'))).toHaveLength(
        2,
      );
      if (race === 'source-before-write') {
        yield* f.fs.writeFileString(f.notePath, f.currentText);
        expect((yield* applyTopicMaintenanceReview(f.config, args)).maintenanceApproval?.stage).toBe('written');
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
}
