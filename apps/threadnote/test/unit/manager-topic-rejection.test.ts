import {it as effectIt} from '@effect/vitest';
import {Effect, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import fc from 'fast-check';
import {ResourceStore} from '@threadnote/store/resource-store';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {loadCandidateReview} from '@threadnote/memory/candidate';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {obsidianSourceWork, runObsidianSourceRemove} from '@threadnote/integration-obsidian/source';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {managerImportedTopicFixture} from '../helpers/manager-imported-topic.js';
import {requestTopicMaintenanceDraft} from '../../src/memory/context/maintenance_draft.js';
import {readContextMaintenancePacket, runContextMaintenance} from '../../src/memory/context/maintenance.js';
import {runSelectedDraft} from '../../src/manager/selected_draft.js';
import type {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerContextMaintenanceTools} from '../../src/mcp/server/context/maintenance.js';
import {runContextMaintainCommand} from '../../src/memory/context/maintenance_commands.js';
import {captureConsole} from '../../src/effect/console.js';
import {projectTopicReviewRecovery} from '../../src/memory/context/maintenance_review_projection.js';
import {makeTopicDraftWireFixture, topicDraftEvidenceFromPrompt} from '../helpers/topic-draft-wire.js';

const modelReviewedFixture = Effect.gen(function* () {
  const f = yield* managerImportedTopicFixture();
  expect((yield* f.request('POST', '/api/attention/topic-review', f.captureInput))?.status).toBe(200);
  const modelId = 'gemma-4-e4b-it-q4';
  const model = yield* (yield* LocalModelCatalog).get(modelId);
  const original = yield* LocalModelStore;
  const store = LocalModelStore.of({
    ...original,
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
  const generate: typeof runSelectedDraft = (_config, _agent, _model, prompt, _purpose, basis) =>
    Effect.sync(() => {
      if (basis?.version !== 2) throw new Error('Expected imported model basis.');
      const draft = makeTopicDraftWireFixture(basis, 'update', topicDraftEvidenceFromPrompt(prompt, basis));
      const first = draft.facts.entries.find(entry => entry.ordinal === 0);
      if (!first || first.disposition !== 'update') throw new Error('Expected editable imported claim.');
      first.text = 'Model proposed current claim.';
      return {
        text: JSON.stringify(draft),
        backendIdentity: 'local-ai',
        modelIdentity: modelId,
        modelVersion: `${model.revision}:${model.sha256}`,
        usage: {status: 'unavailable' as const},
        settings: {maxOutputTokens: 4000 as const, seed: 0 as const},
      };
    });
  const review = yield* requestTopicMaintenanceDraft(
    f.config,
    {caseId: f.caseId, backend: 'local-ai', modelId},
    generate,
  ).pipe(Effect.provideService(LocalModelStore, store));
  expect(review.maintenance?.generation.origin).not.toBe('manual');
  const prepared = yield* f.request('POST', '/api/attention/topic-review', {
    action: 'preview',
    project: 'notes',
    reviewId: review.reviewId,
    revision: review.revision,
  });
  expect(prepared?.status).toBe(200);
  const previewed = yield* loadCandidateReview(f.home, review.reviewId);
  const approval = previewed.maintenanceApproval!.preview;
  const reject = {
    action: 'reject',
    project: 'notes',
    reviewId: review.reviewId,
    revision: previewed.revision,
    caseId: f.caseId,
  };
  return {...f, review: previewed, approval, reject};
});
type Reviewed = Effect.Success<typeof modelReviewedFixture>;
function expectRedacted(body: unknown, f: Reviewed, state: string) {
  expect(body).toMatchObject({
    kind: 'topic-maintenance-recovery',
    project: 'notes',
    reviewId: f.review.reviewId,
    caseId: f.caseId,
    state,
  });
  expect(Object.keys(body as object).sort()).toEqual(
    state === 'rejected'
      ? ['caseId', 'kind', 'project', 'reviewId', 'revision', 'state', 'version']
      : ['caseId', 'kind', 'project', 'recovery', 'reviewId', 'revision', 'state', 'version'],
  );
  expect(JSON.stringify(body)).not.toMatch(
    /Original note fact|Current note fact|Old descriptive claim|Historical constraint|Model proposed current claim|obsidian_evidence|fragment|proposal|approvalDigest/u,
  );
}
const refreshCase = (f: Reviewed) =>
  Effect.gen(function* () {
    for (let tick = 0; tick < 12; tick += 1) {
      const status = yield* runContextMaintenance(f.config, {cwd: f.home, project: 'notes', maxRecords: 4});
      if (
        status.cases.some(
          item => item.caseId === f.caseId && item.evidenceRevision !== f.review.maintenance!.basis.observationRevision,
        )
      )
        return;
    }
    throw new Error('Expected refreshed topic observation.');
  });
const captureNext = (f: Reviewed) =>
  Effect.gen(function* () {
    yield* obsidianSourceWork.run(f.config, 'notes', {
      mode: 'automatic',
      requestId: 'next-cycle-source',
      credentialEnvironment: {},
    });
    yield* refreshCase(f);
    const packet = yield* readContextMaintenancePacket(f.config, f.caseId);
    if (!('topicEvidence' in packet) || packet.topicEvidence.version !== 2 || !packet.topicEvidence.obsidian.current)
      throw new Error('Expected current imported packet.');
    return yield* f.request('POST', '/api/attention/topic-review', {
      ...f.captureInput,
      expectedContentHash: packet.expectedContentHash,
      observationRevision: packet.topicEvidence.observationRevision,
      inspectionDigest: packet.topicEvidence.obsidian.current.inspectionDigest,
      fragmentEnd: packet.topicEvidence.obsidian.current.content.length,
    });
  });

effectIt.effect('rejects a stale model-created imported preview through Manager and allows the next capture', () =>
  Effect.gen(function* () {
    const f = yield* modelReviewedFixture;
    const before = yield* f.store.read(f.location, f.uri);
    yield* f.fs.writeFileString(f.notePath, 'Later authorized note fact.');
    yield* obsidianSourceWork.run(f.config, 'notes', {
      mode: 'automatic',
      requestId: 'later-note',
      credentialEnvironment: {},
    });
    yield* refreshCase(f);
    const read = yield* f.request('GET', `/api/attention/topic-review?project=notes&reviewId=${f.review.reviewId}`);
    expect(read?.status).toBe(200);
    expectRedacted(read?.body, f, 'pending');
    expect(read?.body).toMatchObject({recovery: {action: 'reject'}, revision: f.review.revision});
    for (const wrong of [
      {...f.reject, project: 'other'},
      {...f.reject, caseId: `health-case-${'0'.repeat(40)}`},
      {...f.reject, revision: f.review.revision + 9},
    ]) {
      expect((yield* f.request('POST', '/api/attention/topic-review', wrong))?.status).not.toBe(200);
      expect((yield* loadCandidateReview(f.home, f.review.reviewId)).revision).toBe(f.review.revision);
      expect(yield* f.store.read(f.location, f.uri)).toBe(before);
    }
    for (const action of ['preview', 'apply']) {
      const result = yield* f.request('POST', '/api/attention/topic-review', {
        action,
        project: 'notes',
        reviewId: f.review.reviewId,
        revision: f.review.revision,
        ...(action === 'apply' ? {approvalDigest: f.approval.approvalDigest, approved: true} : {}),
      });
      expect(result?.status).not.toBe(200);
    }
    const rejected = yield* f.request('POST', '/api/attention/topic-review', f.reject);
    expect(rejected?.status).toBe(200);
    expectRedacted(rejected?.body, f, 'rejected');
    expect((yield* loadCandidateReview(f.home, f.review.reviewId)).maintenanceApproval).toBeUndefined();
    expect((yield* f.request('POST', '/api/attention/topic-review', f.reject))?.body).toEqual(rejected?.body);
    expect(yield* f.store.read(f.location, f.uri)).toBe(before);
    expect((yield* captureNext(f))?.status).toBe(200);
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect('closes a real source-after-write conflict without rewriting accepted bytes or immutable origin', () =>
  Effect.gen(function* () {
    const f = yield* modelReviewedFixture;
    let fired = false;
    const wrapped = ResourceStore.of({
      ...f.store,
      writeChecked: (location, uri, content, options, check) => {
        if (fired || uri !== f.uri) return f.store.writeChecked(location, uri, content, options, check);
        fired = true;
        return f.store
          .writeChecked(location, uri, content, options, check)
          .pipe(
            Effect.tap(() =>
              f.fs.writeFileString(f.notePath, 'Source changed after canonical write.').pipe(Effect.orDie),
            ),
          );
      },
    });
    const applying = {
      action: 'apply',
      project: 'notes',
      reviewId: f.review.reviewId,
      revision: f.review.revision,
      approvalDigest: f.approval.approvalDigest,
      approved: true,
    };
    expect(
      (yield* f
        .request('POST', '/api/attention/topic-review', applying)
        .pipe(Effect.provideService(ResourceStore, wrapped)))?.status,
    ).toBe(409);
    expect(fired).toBe(true);
    const conflicted = yield* loadCandidateReview(f.home, f.review.reviewId);
    expect(conflicted.candidates[0].state).toBe('conflict');
    expect(conflicted.maintenanceApproval?.stage).toBe('conflict');
    expect(yield* f.store.read(f.location, f.uri)).toBe(f.approval.content);
    const read = yield* f.request('GET', `/api/attention/topic-review?project=notes&reviewId=${f.review.reviewId}`);
    expect(read?.status).toBe(200);
    expectRedacted(read?.body, f, 'conflict');
    const rejected = yield* f.request('POST', '/api/attention/topic-review', {
      ...f.reject,
      revision: conflicted.revision,
    });
    expect(rejected?.status).toBe(200);
    expectRedacted(rejected?.body, f, 'rejected');
    expect(
      (yield* f.request('POST', '/api/attention/topic-review', {...f.reject, revision: conflicted.revision}))?.body,
    ).toEqual(rejected?.body);
    const closedConflict = (yield* loadCandidateReview(f.home, f.review.reviewId)).maintenanceClosedConflict;
    expect(closedConflict).toBeDefined();
    const accepted = yield* f.store.read(f.location, f.uri);
    expect(accepted).toBe(f.approval.content);
    expect(parseMemoryDocument(f.uri, accepted)?.metadata.obsidianEvidence).toEqual(f.origin);
    expect((yield* captureNext(f))?.status).toBe(200);
    expect((yield* loadCandidateReview(f.home, f.review.reviewId)).maintenanceClosedConflict).toEqual(closedConflict);
    expect(yield* f.store.read(f.location, f.uri)).toBe(accepted);
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect(
  'returns only exact recovery metadata and a successful rejection acknowledgement after source revocation',
  () =>
    Effect.gen(function* () {
      const f = yield* modelReviewedFixture;
      const before = yield* f.store.read(f.location, f.uri);
      yield* runObsidianSourceRemove(f.config, {apply: true, id: 'notes'});
      const read = yield* f.request('GET', `/api/attention/topic-review?project=notes&reviewId=${f.review.reviewId}`);
      expect(read?.status).toBe(200);
      expectRedacted(read?.body, f, 'pending');
      yield* Effect.sync(() =>
        fc.assert(
          fc.property(fc.string({maxLength: 200}), text => {
            const altered = {
              ...f.review,
              topic: text,
              task: text,
              outcome: text,
              candidates: f.review.candidates.map(candidate => ({
                ...candidate,
                proposedText: text,
                reason: text,
                evidence: [text],
              })),
            };
            expect(projectTopicReviewRecovery(altered, f.caseId)).toEqual(
              projectTopicReviewRecovery(f.review, f.caseId),
            );
          }),
          {numRuns: 25},
        ),
      );
      const rejected = yield* f.request('POST', '/api/attention/topic-review', f.reject);
      expect(rejected?.status).toBe(200);
      expectRedacted(rejected?.body, f, 'rejected');
      expect(yield* f.store.read(f.location, f.uri)).toBe(before);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect('MCP acknowledges a revoked imported rejection without a private projection after mutation', () =>
  Effect.gen(function* () {
    const f = yield* modelReviewedFixture;
    const before = yield* f.store.read(f.location, f.uri);
    yield* runObsidianSourceRemove(f.config, {apply: true, id: 'notes'});
    type ToolResult = {readonly isError?: boolean; readonly structuredContent?: unknown};
    const handlers = new Map<string, (input: Record<string, unknown>) => Effect.Effect<ToolResult>>();
    const server = {
      registerTool: (name: string, _definition: unknown, handler: unknown) => {
        handlers.set(name, handler as (input: Record<string, unknown>) => Effect.Effect<ToolResult>);
      },
    } as unknown as EffectMcpServerAdapter;
    registerContextMaintenanceTools(server, f.config);
    const {project: _project, ...selection} = f.reject;
    const result = yield* handlers.get('context_maintenance_review')!(selection);
    expect(result.isError).not.toBe(true);
    expectRedacted(result.structuredContent, f, 'rejected');
    expect((yield* loadCandidateReview(f.home, f.review.reviewId)).candidates[0].state).toBe('rejected');
    expect(yield* f.store.read(f.location, f.uri)).toBe(before);
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect(
  'CLI acknowledges a revoked imported rejection and refuses a different selected project before mutation',
  () =>
    Effect.gen(function* () {
      const f = yield* modelReviewedFixture;
      const before = yield* f.store.read(f.location, f.uri);
      yield* runObsidianSourceRemove(f.config, {apply: true, id: 'notes'});
      const options = {
        action: 'draft-reject',
        project: 'notes',
        reviewId: f.review.reviewId,
        revision: f.review.revision,
        caseId: f.caseId,
        json: true,
      };
      expect(
        Result.isFailure(
          yield* runContextMaintainCommand(f.config, {...options, project: 'other'}).pipe(Effect.result),
        ),
      ).toBe(true);
      expect((yield* loadCandidateReview(f.home, f.review.reviewId)).revision).toBe(f.review.revision);
      const result = yield* runContextMaintainCommand(f.config, options).pipe(captureConsole);
      expectRedacted(JSON.parse(result.output), f, 'rejected');
      expect((yield* loadCandidateReview(f.home, f.review.reviewId)).candidates[0].state).toBe('rejected');
      expect(yield* f.store.read(f.location, f.uri)).toBe(before);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);
