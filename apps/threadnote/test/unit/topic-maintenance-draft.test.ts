import * as candidateGenerationModule from '@threadnote/memory/candidate-generation';
import * as maintenanceModule from '../../src/memory/context/maintenance.js';
import * as memoryModule from '../../src/mcp/server/memory.js';
import * as modelModule from '../../src/manager/consolidation_models.js';
import * as selectedModule from '../../src/effect/ai/selected_generation.js';
import * as schemaModule from '../../src/manager/topic_draft_schema.js';
import * as inventoryModule from '../../src/memory/context/maintenance_inventory.js';
import {loadTopicGenerationReceipt, readTopicGenerationSummary} from '@threadnote/memory/candidate-generation';
import {maintenanceSnapshotFailure} from '../../src/memory/context/maintenance_snapshot.js';
import {InvalidModelOutput} from '@threadnote/inference/engine/errors';
import {
  TopicDraftProviderOutputError,
  DraftProviderUnavailableBeforeDispatch,
  localDraftGenerationSettings,
  serializeDraftGenerationSettings,
} from '../../src/effect/ai/consolidator.js';
import {TopicDraftError} from '../../src/memory/context/maintenance_draft.js';
import {readDraftQueueTarget} from '../../src/memory/context/maintenance_draft_queue.js';
import {makeTopicDraftControllerPacket, makeTopicDraftWireFixture} from '../helpers/topic-draft-wire.js';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {Deferred, Effect, Fiber, FileSystem, Path, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {proposeTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {
  retainedTopicGenerationOutput,
  validateTopicMaintenanceDraftBasis,
  type TopicMaintenanceDraftBasisV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {
  candidateReviewWithState,
  listCandidateReviews,
  loadCandidateReviewOptional,
  saveCandidateReview,
} from '@threadnote/memory/candidate';
import {applyMemoryCandidate} from '../../src/mcp/server/recall.js';
import {
  readContextMaintenancePacket,
  readContextMaintenanceStatus,
  recordTopicMaintenanceReviewDecision,
  runContextMaintenance,
} from '../../src/memory/context/maintenance.js';
import {
  basisFromPacket,
  readTopicMaintenanceDraft,
  readyEvidence,
  reviewEvidenceFromPacket,
  requestTopicMaintenanceDraft,
  topicMaintenanceDraftPrompt,
} from '../../src/memory/context/maintenance_draft.js';
import {verifyTopicMaintenanceReviewSource} from '../../src/memory/context/maintenance_review_source.js';
import {decideTopicMaintenanceReview} from '../../src/memory/context/maintenance_review.js';
import {runSelectedDraft, selectedTopicDraftIdentity} from '../../src/manager/selected_draft.js';
import {
  topicDraftGenerationEligible,
  topicDraftGenerationScopeSupported,
  topicDraftModelSchema,
  topicDraftNativeJsonSchema,
} from '../../src/manager/topic_draft_schema.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const modelId = 'gemma-4-e4b-it-q4';

describe('topic maintenance private draft generation', () => {
  it('selects direct descriptive paragraphs in accepted order without changing the basis', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            role: fc.constantFrom('descriptive', 'normative', 'historical' as const),
            support: fc.constantFrom('direct', 'contextual', 'unresolved' as const),
          }),
          {minLength: 1, maxLength: 8},
        ),
        combinations => {
          const paragraphs = combinations.map((item, ordinal) => ({
            ...item,
            ordinal,
            hash: ordinal.toString(16).padStart(64, '0'),
            citationIds: item.support === 'unresolved' ? [] : [`tncc_${ordinal.toString(16).padStart(40, '0')}`],
          }));
          const before = JSON.stringify(paragraphs);
          expect(paragraphs.filter(topicDraftGenerationEligible).map(item => item.ordinal)).toEqual(
            combinations.flatMap((item, ordinal) =>
              item.role === 'descriptive' && item.support === 'direct' ? [ordinal] : [],
            ),
          );
          const ids = paragraphs.flatMap(paragraph => paragraph.citationIds);
          const basis: TopicMaintenanceDraftBasisV1 = {
            version: 1,
            targetUri: 'threadnote://user/tester/memories/durable/projects/fixture/topic.md',
            targetHash: 'a'.repeat(64),
            observationRevision: 'b'.repeat(64),
            packetDigest: 'c'.repeat(64),
            body: paragraphs.map(paragraph => `Claim ${paragraph.ordinal}.`).join('\n\n'),
            paragraphs,
            additionalDependencies: [],
            handles: ids.map(id => ({id: `current:${id}`, citationId: id, variant: 'current' as const})),
          };
          const expected = paragraphs.filter(
            paragraph => paragraph.role === 'descriptive' && paragraph.support === 'direct',
          );
          expect(topicDraftGenerationScopeSupported(basis, false)).toBe(true);
          expect(topicDraftGenerationScopeSupported(basis, true)).toBe(
            expected.length > 0 || combinations.every(paragraph => paragraph.role !== 'descriptive'),
          );
          if (!ids.length) {
            expect(() => topicDraftModelSchema(basis)).toThrow('Topic generation requires current evidence.');
            expect(JSON.stringify(paragraphs)).toBe(before);
            return;
          }
          const branches = topicDraftNativeJsonSchema(topicDraftModelSchema(basis)).properties.decision.oneOf;
          expect(branches.some(branch => branch.properties.policyAssessment.enum[0] === 'no-conflict-observed')).toBe(
            expected.length > 0,
          );
          if (expected.length)
            expect(
              topicDraftNativeJsonSchema(topicDraftModelSchema(basis))
                .properties.facts.properties.entries.items.oneOf.filter(
                  (variant: {properties: {disposition: {enum: string[]}}}) =>
                    variant.properties.disposition.enum[0] === 'update',
                )
                .map((variant: {properties: {ordinal: {enum: number[]}}}) => variant.properties.ordinal.enum[0]),
            ).toEqual(expected.map(paragraph => paragraph.ordinal));
          expect(JSON.stringify(paragraphs)).toBe(before);
        },
      ),
      {numRuns: 40},
    );
  });

  it('keeps non-editable bases in source-only or undetermined assessment branches', () => {
    const basis: TopicMaintenanceDraftBasisV1 = {
      version: 1,
      targetUri: 'threadnote://user/tester/memories/durable/projects/fixture/topic.md',
      targetHash: 'a'.repeat(64),
      observationRevision: 'b'.repeat(64),
      packetDigest: 'c'.repeat(64),
      body: 'A contextual paragraph.',
      paragraphs: [
        {
          ordinal: 0,
          hash: 'd'.repeat(64),
          role: 'descriptive',
          support: 'contextual',
          citationIds: ['tncc_' + '0'.repeat(40)],
        },
      ],
      additionalDependencies: [],
      handles: [{id: 'current:tncc_' + '0'.repeat(40), citationId: 'tncc_' + '0'.repeat(40), variant: 'current'}],
    };
    const branches = topicDraftNativeJsonSchema(topicDraftModelSchema(basis)).properties.decision.oneOf;
    expect(topicDraftGenerationScopeSupported(basis, true)).toBe(false);
    expect(topicDraftGenerationScopeSupported(basis, false)).toBe(true);
    expect(
      topicDraftGenerationScopeSupported(
        {...basis, paragraphs: basis.paragraphs.map(paragraph => ({...paragraph, role: 'normative' as const}))},
        true,
      ),
    ).toBe(true);
    expect(branches.map(branch => branch.properties.policyAssessment.enum[0])).toEqual(['source-review']);
  });

  it('keeps assessment branches exclusive with updates only after no observed conflict', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 8}), count => {
        const ids = Array.from({length: count}, (_, index) => `tncc_${index.toString(16).padStart(40, '0')}`);
        const basis: TopicMaintenanceDraftBasisV1 = {
          version: 1,
          targetUri: 'threadnote://user/tester/memories/durable/projects/fixture/topic.md',
          targetHash: 'a'.repeat(64),
          observationRevision: 'b'.repeat(64),
          packetDigest: 'c'.repeat(64),
          body: ids.map((_, index) => `Claim ${index}.`).join('\n\n'),
          paragraphs: ids.map((id, index) => ({
            ordinal: index,
            hash: index.toString(16).padStart(64, '0'),
            role: 'descriptive',
            support: 'direct',
            citationIds: [id],
          })),
          additionalDependencies: [],
          handles: ids.flatMap(id => [
            {id: `historical:${id}`, citationId: id, variant: 'historical' as const},
            {id: `current:${id}`, citationId: id, variant: 'current' as const},
          ]),
        };
        const schema = topicDraftNativeJsonSchema(topicDraftModelSchema(basis));
        const branches = schema.properties.decision.oneOf;
        expect((schema as Record<string, unknown>).type).toBe('object');
        expect(branches.map(branch => branch.properties.policyAssessment.enum[0])).toEqual(['no-conflict-observed']);
        for (const branch of branches) {
          expect(branch.properties).not.toHaveProperty('operations');
          expect(branch.properties).not.toHaveProperty('reviewedHandles');
          expect(schema.properties.facts.properties.entries).toMatchObject({
            minItems: count,
            maxItems: count,
          });
          expect(schema.required).toContain('facts');
          const variants = schema.properties.facts.properties.entries.items.oneOf;
          const updates = variants.filter(
            (variant: {properties: {disposition: {enum: string[]}}}) =>
              variant.properties.disposition.enum[0] === 'update',
          );
          expect(
            updates.map((variant: {properties: {ordinal: {enum: number[]}}}) => variant.properties.ordinal.enum[0]),
          ).toEqual(
            branch.properties.policyAssessment.enum[0] === 'no-conflict-observed'
              ? basis.paragraphs.map(p => p.ordinal)
              : [],
          );
          for (const variant of variants) {
            const update = variant.properties.disposition.enum[0] === 'update';
            expect(variant.required.includes('text')).toBe(update);
            expect(Object.hasOwn(variant.properties, 'text')).toBe(update);
            expect(variant.properties).not.toHaveProperty('beforeHash');
            expect(variant.properties).not.toHaveProperty('supportHandles');
          }
        }
        expect(JSON.stringify(schema)).not.toContain('"anyOf"');
      }),
      {numRuns: 16},
    );
  });

  effectIt.effect('rejects tool-capable providers and oversized prompt without executing a model', () =>
    Effect.gen(function* () {
      const config = {
        account: 'local',
        agentContextHome: '/unused',
        agentId: 'test',
        manifestPath: '/unused',
        user: 'tester',
      };
      const denied = yield* runSelectedDraft(config, 'codex', undefined, 'prompt', 'topic-maintenance').pipe(
        Effect.result,
      );
      expect(Result.isFailure(denied)).toBe(true);
      const oversized = yield* runSelectedDraft(
        config,
        'local-ai',
        {id: modelId, label: modelId, isDefault: true},
        'x'.repeat(80 * 1024 + 1),
        'topic-maintenance',
      ).pipe(Effect.result);
      expect(Result.isFailure(oversized)).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'stores one strict private review, repairs once, caches across reads, and leaves accepted bytes untouched',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'topic-maintenance-draft-'});
          const repository = path.join(home, 'repository');
          yield* fs.makeDirectory(repository);
          const source = path.join(repository, 'source.ts');
          yield* fs.writeFileString(source, 'export const requestTimeoutSeconds = 30;\n');
          yield* fs.writeFileString(path.join(repository, 'unrelated.ts'), 'export const cacheSize = 8;\n');
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
            'initial',
          ]);
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
          yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: home, ensureVectors: false});
          const citations = yield* captureMemoryCodeCitations(config, {callerCwd: repository, refs: ['source.ts']});
          const [unrelatedCitation] = yield* captureMemoryCodeCitations(config, {
            callerCwd: repository,
            refs: ['unrelated.ts'],
          });
          expect(citations).toHaveLength(1);
          expect(unrelatedCitation).toBeDefined();
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
                timestamp: '2026-10-16T00:00:00.000Z',
                codeCitations: [...citations, unrelatedCitation],
              },
              'Request timeout is 30 seconds.\n\nThis topic describes runtime configuration.',
            ),
          )!;
          const enrolled = proposeTopicMaintenanceEnrollment(base, {
            paragraphs: [
              {role: 'descriptive', support: 'direct', citationIds: [citations[0].id]},
              {role: 'descriptive', support: 'contextual', citationIds: [citations[0].id]},
            ],
            additionalDependencies: [{kind: 'configuration', citationId: unrelatedCitation.id}],
          });
          const memory = path.join(home, 'data/local/user/tester/memories/durable/projects/fixture/source-topic.md');
          yield* fs.makeDirectory(path.dirname(memory), {recursive: true});
          yield* fs.writeFileString(memory, enrolled.content);
          const accepted = yield* fs.readFileString(memory);
          yield* fs.writeFileString(source, 'export const requestTimeoutSeconds = 60;\n');
          yield* git(['add', '.']);
          yield* git([
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '--quiet',
            '-m',
            'changed',
          ]);
          yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: home, ensureVectors: false});
          const stateFile = path.join(home, 'context-maintenance/state-v2.json');
          let caseId = '';
          for (let tick = 0; tick < 12; tick++) {
            yield* runContextMaintenance(config, {cwd: repository});
            const state = JSON.parse(yield* fs.readFileString(stateFile));
            const item = state.cases.find((entry: {family: string}) => entry.family === 'topic-maintenance');
            if (item?.disposition === 'needs-decision') {
              caseId = item.caseId;
              break;
            }
          }
          expect(caseId).not.toBe('');
          const packet = yield* readContextMaintenancePacket(config, caseId);
          expect('topicEvidence' in packet && packet.topicEvidence.outcome).toBe('ready');
          const ready = readyEvidence(packet);
          if (ready.version !== 1) throw new Error('Expected code packet fixture.');
          const longClaim = 'Request timeout is 30 seconds. ' + 'x'.repeat(28 * 1024);
          const longBasis = validateTopicMaintenanceDraftBasis({
            ...basisFromPacket(ready),
            body: longClaim + '\n\nThis topic describes runtime configuration.',
            paragraphs: ready.paragraphs.map((paragraph, ordinal) =>
              ordinal === 0 ? {...paragraph, hash: sha256HexSync(longClaim)} : paragraph,
            ),
          });
          for (const previousError of [undefined, 'The prior draft outcome does not match its operations.']) {
            const prompt = topicMaintenanceDraftPrompt(ready, longBasis, previousError, '{invalid');
            expect(prompt.split(longClaim)).toHaveLength(2);
            expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(80 * 1024);
          }
          const competing = path.join(path.dirname(memory), 'competing-topic.md');
          yield* fs.writeFileString(
            competing,
            formatMemoryDocument(
              'MEMORY',
              {
                kind: 'durable',
                status: 'active',
                schemaVersion: 8,
                memoryId: 'tn_competing_topic',
                project: 'fixture',
                topic: 'competing-topic',
                sourceAgentClient: 'test',
                timestamp: '2026-10-16T00:00:00.000Z',
              },
              'Request timeout is 60 seconds.',
            ),
          );
          const otherProject = path.join(home, 'data/local/user/tester/memories/durable/projects/other/unrelated.md');
          yield* fs.makeDirectory(path.dirname(otherProject), {recursive: true});
          yield* fs.writeFileString(
            otherProject,
            formatMemoryDocument(
              'MEMORY',
              {
                kind: 'durable',
                status: 'active',
                schemaVersion: 8,
                memoryId: 'tn_other_project',
                project: 'other',
                topic: 'unrelated',
                sourceAgentClient: 'test',
                timestamp: '2026-10-16T00:00:00.000Z',
              },
              'Request timeout is 90 seconds.',
            ),
          );
          const catalog = yield* LocalModelCatalog;
          const manifest = yield* catalog.get(modelId);
          const originalStore = yield* LocalModelStore;
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
          const validJson = (prompt: string) => {
            const identity = JSON.parse(/^Identity: (.+)$/mu.exec(prompt)![1]);
            const packet = JSON.parse(/^Packet: (.+)$/mu.exec(prompt)![1]);
            return JSON.stringify({
              version: 8,
              ...identity,
              facts: {
                version: 1,
                entries: packet.paragraphs
                  .filter(
                    (item: {role: string; support: string}) => item.role === 'descriptive' && item.support === 'direct',
                  )
                  .map((item: {ordinal: number; sourceIndices: number[]}) => ({
                    ordinal: item.ordinal,
                    currentBehavior: 'Current supported behavior.',
                    rationale: 'Checked unchanged against current evidence.',
                    disposition: 'unchanged',
                    sourceIndices: item.sourceIndices,
                  })),
              },
              normativeComparisons: packet.paragraphs
                .filter((item: {role: string}) => item.role === 'normative')
                .map((item: {ordinal: number}) => ({
                  ordinal: item.ordinal,
                  rationale: 'Checked current applicable behavior.',
                })),
              decision: {
                policyAssessment: 'no-conflict-observed',
                removedClaims: [],
              },
            });
          };
          const validUpdateJson = (prompt: string) => {
            const wire = JSON.parse(validJson(prompt));
            const evidence = JSON.parse(/^Packet: (.+)$/mu.exec(prompt)![1]);
            const paragraph = evidence.paragraphs[0];
            expect(paragraph.text).toBe('Request timeout is 30 seconds.');
            expect(evidence.paragraphs[1].text).toBe('This topic describes runtime configuration.');
            expect(prompt).toContain('still-stale facts from earlier events');
            wire.facts.entries = wire.facts.entries.map((item: {ordinal: number}) =>
              item.ordinal === paragraph.ordinal
                ? {
                    ...item,
                    disposition: 'update',
                    text: 'Request timeout is 60 seconds.',
                  }
                : item,
            );
            wire.facts.entries.find((item: {ordinal: number}) => item.ordinal === paragraph.ordinal).rationale =
              'The current source states 60 seconds.';
            return JSON.stringify(wire);
          };
          const invalidApplicationJson = (prompt: string) => {
            const wire = JSON.parse(validUpdateJson(prompt));
            wire.facts.entries[0].rationale = 'é'.repeat(513);
            return JSON.stringify(wire);
          };
          const modelResult = (text: string) => ({
            text,
            backendIdentity: 'local-ai',
            modelIdentity: modelId,
            modelVersion: `${manifest.revision}:${manifest.sha256}`,
            usage: {status: 'unavailable' as const},
            settings: localDraftGenerationSettings(modelId, 'topic-maintenance'),
          });
          let calls = 0;
          const generator: typeof runSelectedDraft = (_config, _agent, _model, prompt) =>
            Effect.sync(() => {
              calls += 1;
              return modelResult(calls === 1 ? invalidApplicationJson(prompt) : validUpdateJson(prompt));
            });
          const request = (regenerate = false) =>
            requestTopicMaintenanceDraft(config, {caseId, backend: 'local-ai', modelId, regenerate}, generator).pipe(
              Effect.provideService(LocalModelStore, store),
            );
          expect(yield* loadCandidateReviewOptional(home, 'review-' + '0'.repeat(24))).toBeUndefined();
          const stateBeforeFailure = yield* fs.readFileString(stateFile);
          const invalidOutput: typeof runSelectedDraft = () => Effect.succeed(modelResult('{invalid'));
          const invalid = yield* requestTopicMaintenanceDraft(
            config,
            {caseId, backend: 'local-ai', modelId},
            invalidOutput,
          ).pipe(Effect.provideService(LocalModelStore, store), Effect.result);
          expect(Result.isFailure(invalid)).toBe(true);
          const oversizedOutput: typeof runSelectedDraft = () => Effect.succeed(modelResult('x'.repeat(32 * 1024 + 1)));
          const oversized = yield* requestTopicMaintenanceDraft(
            config,
            {caseId, backend: 'local-ai', modelId},
            oversizedOutput,
          ).pipe(Effect.provideService(LocalModelStore, store), Effect.result);
          expect(Result.isFailure(oversized)).toBe(true);
          const wrongModel: typeof runSelectedDraft = (_config, _agent, _model, prompt) =>
            Effect.succeed({...modelResult(validJson(prompt)), modelIdentity: 'unselected-model'});
          const mismatched = yield* requestTopicMaintenanceDraft(
            config,
            {caseId, backend: 'local-ai', modelId},
            wrongModel,
          ).pipe(Effect.provideService(LocalModelStore, store), Effect.result);
          expect(Result.isFailure(mismatched)).toBe(true);
          const contextualOperation: typeof runSelectedDraft = (_config, _agent, _model, prompt) => {
            const draft = JSON.parse(validJson(prompt));
            const paragraph = JSON.parse(/^Packet: (.+)$/mu.exec(prompt)![1]).paragraphs[1];
            draft.facts.entries[0] = {
              ordinal: paragraph.ordinal,
              currentBehavior: 'Changed behavior.',
              rationale: 'Current configuration changed.',
              disposition: 'update',
              text: 'This topic now describes changed runtime configuration.',
              sourceIndices: [0],
            };
            return Effect.succeed(modelResult(JSON.stringify(draft)));
          };
          const contextual = yield* requestTopicMaintenanceDraft(
            config,
            {caseId, backend: 'local-ai', modelId},
            contextualOperation,
          ).pipe(Effect.provideService(LocalModelStore, store), Effect.result);
          expect(Result.isFailure(contextual)).toBe(true);
          expect(yield* fs.readFileString(stateFile)).toBe(stateBeforeFailure);
          expect(yield* fs.readFileString(memory)).toBe(accepted);
          expect(yield* listCandidateReviews(home)).toEqual([]);
          const review = yield* request();
          const acceptedRecord = parseMemoryDocument(uri, yield* fs.readFileString(memory))!;
          expect(
            (yield* verifyTopicMaintenanceReviewSource(config, acceptedRecord, review.maintenance!, repository))
              .outcome,
          ).toBe('ready');
          expect(review.maintenance).toMatchObject({
            version: 1,
            generation: {attempts: 2, agent: 'local-ai', model: modelId},
          });
          expect(review.maintenance?.proposal.changedOrdinals).toEqual([0]);
          expect(review.maintenance?.proposal.body).toBe(
            'Request timeout is 60 seconds.\n\nThis topic describes runtime configuration.',
          );
          expect(review.candidates[0].evidence).toContainEqual(
            expect.stringContaining('Advisory bounded semantic comparison'),
          );
          expect(calls).toBe(2);
          expect((yield* request()).revision).toBe(review.revision);
          expect(calls).toBe(2);
          const conflicted = candidateReviewWithState(review, review.candidates[0].candidateId, 'conflict');
          yield* saveCandidateReview(home, conflicted);
          const blockedConflict = yield* request(true).pipe(Effect.result);
          expect(Result.isFailure(blockedConflict) && blockedConflict.failure).toMatchObject({
            reason: 'review-conflict',
            recovery: {reviewId: review.reviewId, state: 'conflict'},
          });
          expect(calls).toBe(2);
          yield* saveCandidateReview(home, review);
          if (review.maintenance?.version !== 1) throw new Error('Expected code review fixture.');
          const codeReview = review.maintenance;
          const tampered = {
            ...review,
            maintenance: {
              ...codeReview,
              reviewEvidence: codeReview.reviewEvidence.map(item =>
                item.handleId === `current:${citations[0].id}`
                  ? {
                      ...item,
                      citation: unrelatedCitation,
                      source: {
                        extractorSet: unrelatedCitation.extractorSet,
                        fileContentHash: unrelatedCitation.fileContentHash.value,
                        path: unrelatedCitation.path,
                        repositoryId: unrelatedCitation.repositoryId,
                        sourceCommit: unrelatedCitation.sourceCommit,
                        sourceDirty: unrelatedCitation.sourceDirty,
                        sourceSnapshotId: unrelatedCitation.sourceSnapshotId,
                      },
                    }
                  : item,
              ),
            },
          };
          yield* saveCandidateReview(home, tampered);
          expect(Result.isFailure(yield* request().pipe(Effect.result))).toBe(true);
          expect(calls).toBe(2);
          yield* saveCandidateReview(home, review);
          expect((yield* readTopicMaintenanceDraft(config, review.reviewId)).maintenance).toEqual(review.maintenance);
          expect(yield* fs.readFileString(memory)).toBe(accepted);
          const denied = yield* applyMemoryCandidate(config, {
            action: 'defer',
            reviewId: review.reviewId,
            candidateId: review.candidates[0].candidateId,
            revision: review.revision,
          }).pipe(Effect.result);
          expect(Result.isSuccess(denied) && denied.success.isError).toBe(true);
          const deferred = candidateReviewWithState(review, review.candidates[0].candidateId, 'deferred', {
            action: 'defer',
            at: '2026-10-16T00:00:01.000Z',
          });
          yield* saveCandidateReview(home, deferred);
          expect(Result.isFailure(yield* request().pipe(Effect.result))).toBe(true);
          expect(Result.isFailure(yield* request(true).pipe(Effect.result))).toBe(true);
          expect(calls).toBe(2);
          const resumed = yield* decideTopicMaintenanceReview(config, {
            reviewId: deferred.reviewId,
            revision: deferred.revision,
            action: 'resume',
            caseId,
          });
          expect(resumed.candidates[0].state).toBe('pending');
          const restored = yield* request(true);
          expect(restored.revision).toBeGreaterThan(resumed.revision);
          expect(restored.candidates[0].state).toBe('pending');
          const system = yield* SystemInfo;
          const remoteUrl = 'https://example.invalid/v1';
          const remoteModel = 'test-remote-model';
          const remoteSystem = SystemInfo.of({
            ...system,
            environment: () => ({
              ...system.environment(),
              THREADNOTE_EFFECT_AI: 'true',
              THREADNOTE_EFFECT_AI_API_URL: remoteUrl,
              THREADNOTE_EFFECT_AI_MODEL: remoteModel,
            }),
          });
          const remoteIdentity = yield* selectedTopicDraftIdentity(config, 'effect-ai', {
            id: remoteModel,
            label: remoteModel,
            isDefault: true,
          }).pipe(Effect.provideService(SystemInfo, remoteSystem));
          const blocked = yield* requestTopicMaintenanceDraft(
            config,
            {caseId, backend: 'effect-ai', modelId: remoteModel},
            () => Effect.die('Pending review must block a different model before execution.'),
          ).pipe(Effect.provideService(SystemInfo, remoteSystem), Effect.result);
          expect(Result.isFailure(blocked)).toBe(true);
          // Simulate a completed local review so a different selected provider may start a new proposal.
          const resolved = candidateReviewWithState(restored, restored.candidates[0].candidateId, 'applied');
          yield* saveCandidateReview(home, resolved);
          let remoteCalls = 0;
          const remoteResult = (text: string) => ({
            text,
            backendIdentity: remoteUrl,
            modelIdentity: remoteModel,
            modelVersion: remoteIdentity.modelVersion,
            usage: {status: 'unavailable' as const},
            settings: {maxOutputTokens: 4000 as const},
          });
          const remoteGenerator: typeof runSelectedDraft = (_config, _agent, _model, prompt) =>
            Effect.sync(() => {
              remoteCalls += 1;
              return remoteResult(validJson(prompt));
            });
          const remoteRequest = (generate: typeof runSelectedDraft) =>
            requestTopicMaintenanceDraft(
              config,
              {caseId, backend: 'effect-ai', modelId: remoteModel, regenerate: true},
              generate,
            ).pipe(Effect.provideService(SystemInfo, remoteSystem));
          const remoteReview = yield* remoteRequest(remoteGenerator);
          expect(remoteReview.maintenance?.generation).toMatchObject({
            agent: 'effect-ai',
            model: remoteModel,
            attempts: 1,
          });
          expect(remoteCalls).toBe(1);
          expect(remoteReview.revision).toBeGreaterThan(resolved.revision);
          const deferredRemote = candidateReviewWithState(
            remoteReview,
            remoteReview.candidates[0].candidateId,
            'deferred',
          );
          yield* saveCandidateReview(home, deferredRemote);
          yield* decideTopicMaintenanceReview(config, {
            reviewId: deferredRemote.reviewId,
            revision: deferredRemote.revision,
            action: 'resume',
            caseId,
          });
          let abstentionCalls = 0;
          const abstentionGenerator: typeof runSelectedDraft = (_config, _agent, _model, prompt) =>
            Effect.sync(() => {
              abstentionCalls += 1;
              const draft = JSON.parse(validJson(prompt));
              if (abstentionCalls === 1) draft.facts.entries[0].rationale = 'é'.repeat(513);
              draft.facts.entries = draft.facts.entries.map((item: {ordinal: number}) => ({
                ...item,
                disposition: 'unresolved',
                sourceIndices: [],
              }));
              return remoteResult(JSON.stringify(draft));
            });
          const abstentionReview = yield* remoteRequest(abstentionGenerator);
          expect(abstentionCalls).toBe(2);
          expect(abstentionReview.maintenance?.proposal.draft.outcome).toBe('insufficient-evidence');
          expect(abstentionReview.maintenance?.generation.attempts).toBe(2);
          yield* git([
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '--quiet',
            '--allow-empty',
            '-m',
            'unrelated-head',
          ]);
          yield* (yield* CodeGraphIndexer).index({cwd: repository, threadnoteHome: home, ensureVectors: false});
          const cachedAfterUnrelatedHead = yield* requestTopicMaintenanceDraft(
            config,
            {caseId, backend: 'effect-ai', modelId: remoteModel},
            remoteGenerator,
          ).pipe(Effect.provideService(SystemInfo, remoteSystem));
          expect(cachedAfterUnrelatedHead.revision).toBe(abstentionReview.revision);
          expect(
            (yield* verifyTopicMaintenanceReviewSource(
              config,
              acceptedRecord,
              abstentionReview.maintenance!,
              repository,
            )).outcome,
          ).toBe('ready');
          expect(remoteCalls).toBe(1);
          const deferredAbstention = candidateReviewWithState(
            abstentionReview,
            abstentionReview.candidates[0].candidateId,
            'deferred',
          );
          yield* saveCandidateReview(home, deferredAbstention);
          yield* decideTopicMaintenanceReview(config, {
            reviewId: deferredAbstention.reviewId,
            revision: deferredAbstention.revision,
            action: 'resume',
            caseId,
          });
          const indexer = yield* CodeGraphIndexer;
          const inFlightUnrelatedHead: typeof runSelectedDraft = (_config, _agent, _model, prompt) =>
            Effect.gen(function* () {
              yield* git([
                '-c',
                'user.name=Test',
                '-c',
                'user.email=test@example.invalid',
                'commit',
                '--quiet',
                '--allow-empty',
                '-m',
                'in-flight-unrelated-head',
              ]);
              yield* indexer.index({cwd: repository, threadnoteHome: home, ensureVectors: false});
              return remoteResult(validJson(prompt));
            }).pipe(Effect.orDie);
          const afterUnrelatedHead = yield* remoteRequest(inFlightUnrelatedHead);
          expect(afterUnrelatedHead.maintenance?.reviewEvidence).toHaveLength(4);
          expect(afterUnrelatedHead.revision).toBeGreaterThan(abstentionReview.revision);
          const raceGenerator: typeof runSelectedDraft = (_config, _agent, _model, prompt) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(source, 'export const requestTimeoutSeconds = 90;\n');
              yield* git(['add', '.']);
              yield* git([
                '-c',
                'user.name=Test',
                '-c',
                'user.email=test@example.invalid',
                'commit',
                '--quiet',
                '-m',
                'raced',
              ]);
              return remoteResult(validJson(prompt));
            }).pipe(Effect.orDie);
          const raced = yield* remoteRequest(raceGenerator).pipe(Effect.result);
          expect(Result.isFailure(raced)).toBe(true);
          expect((yield* readTopicMaintenanceDraft(config, restored.reviewId)).revision).toBe(
            afterUnrelatedHead.revision,
          );
          yield* indexer.index({cwd: repository, threadnoteHome: home, ensureVectors: false});
          let changedCase = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
          for (
            let tick = 0;
            tick < 12 && changedCase?.evidenceRevision === afterUnrelatedHead.maintenance?.basis.observationRevision;
            tick++
          ) {
            yield* runContextMaintenance(config, {cwd: repository});
            changedCase = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
          }
          expect(changedCase?.disposition).toBe('needs-decision');
          expect(changedCase?.evidenceRevision).not.toBe(afterUnrelatedHead.maintenance?.basis.observationRevision);
          const rejectedStale = yield* decideTopicMaintenanceReview(config, {
            reviewId: afterUnrelatedHead.reviewId,
            revision: afterUnrelatedHead.revision,
            action: 'reject',
            caseId,
          });
          expect(rejectedStale.candidates[0].state).toBe('rejected');
          const retriedRejection = yield* decideTopicMaintenanceReview(config, {
            reviewId: afterUnrelatedHead.reviewId,
            revision: afterUnrelatedHead.revision,
            action: 'reject',
            caseId,
          });
          expect(retriedRejection.revision).toBe(rejectedStale.revision);
          expect((yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0]).toMatchObject({
            disposition: 'needs-decision',
            evidenceRevision: changedCase?.evidenceRevision,
          });
          const freshAfterRejection = yield* remoteRequest(remoteGenerator);
          expect(freshAfterRejection.revision).toBeGreaterThan(rejectedStale.revision);
          expect(freshAfterRejection.maintenance?.basis.observationRevision).toBe(changedCase?.evidenceRevision);
          const deferredFresh = yield* decideTopicMaintenanceReview(config, {
            reviewId: freshAfterRejection.reviewId,
            revision: freshAfterRejection.revision,
            action: 'defer',
            caseId,
          });
          expect(Result.isFailure(yield* remoteRequest(remoteGenerator).pipe(Effect.result))).toBe(true);
          yield* fs.writeFileString(source, 'export const requestTimeoutSeconds = 120;\n');
          yield* git(['add', '.']);
          yield* git([
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '--quiet',
            '-m',
            'changed-again',
          ]);
          yield* indexer.index({cwd: repository, threadnoteHome: home, ensureVectors: false});
          let nextCase = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
          for (let tick = 0; tick < 12 && nextCase?.evidenceRevision === changedCase?.evidenceRevision; tick++) {
            yield* runContextMaintenance(config, {cwd: repository});
            nextCase = (yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0];
          }
          expect(nextCase?.evidenceRevision).not.toBe(changedCase?.evidenceRevision);
          expect(nextCase?.disposition).toBe('needs-decision');
          const staleResume = yield* decideTopicMaintenanceReview(config, {
            reviewId: deferredFresh.reviewId,
            revision: deferredFresh.revision,
            action: 'resume',
            caseId,
          }).pipe(Effect.result);
          expect(Result.isFailure(staleResume)).toBe(true);
          expect((yield* loadCandidateReviewOptional(home, deferredFresh.reviewId))?.candidates[0].state).toBe(
            'deferred',
          );
          const retriedDeferral = yield* decideTopicMaintenanceReview(config, {
            reviewId: freshAfterRejection.reviewId,
            revision: freshAfterRejection.revision,
            action: 'defer',
            caseId,
          });
          expect(retriedDeferral.revision).toBe(deferredFresh.revision);
          expect((yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0]?.disposition).toBe(
            'needs-decision',
          );
          const freshAfterDeferral = yield* remoteRequest(remoteGenerator);
          expect(freshAfterDeferral.revision).toBeGreaterThan(deferredFresh.revision);
          expect(freshAfterDeferral.maintenance?.basis.observationRevision).toBe(nextCase?.evidenceRevision);
          expect(freshAfterDeferral.candidates[0].state).toBe('pending');
          const binary = system.environment().THREADNOTE_E2E_BINARY;
          const executable = binary ?? system.executablePath;
          const prefix = binary ? [] : [path.join(system.currentDirectory(), 'apps/threadnote/src/standalone.ts')];
          const cli = yield* runCommandEffect(
            executable,
            [...prefix, 'context', 'maintain', '--action', 'draft-view', '--review-id', review.reviewId, '--json'],
            {
              cwd: repository,
              env: {
                ...system.environment(),
                THREADNOTE_HOME: home,
                THREADNOTE_USER: config.user,
                THREADNOTE_MANIFEST: config.manifestPath,
                NO_COLOR: '1',
              },
              timeoutMs: 60_000,
            },
          );
          expect(JSON.parse(cli.stdout).maintenance).toEqual(freshAfterDeferral.maintenance);
          const deferredSaved = yield* Deferred.make<void>();
          const releaseReconcile = yield* Deferred.make<void>();
          const delayedReconcile: typeof recordTopicMaintenanceReviewDecision = (selected, input) =>
            input.action === 'defer'
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(deferredSaved, undefined);
                  yield* Deferred.await(releaseReconcile);
                  return yield* recordTopicMaintenanceReviewDecision(selected, input);
                })
              : recordTopicMaintenanceReviewDecision(selected, input);
          const deferFiber = yield* Effect.forkScoped(
            decideTopicMaintenanceReview(
              config,
              {reviewId: freshAfterDeferral.reviewId, revision: freshAfterDeferral.revision, action: 'defer', caseId},
              delayedReconcile,
            ),
          );
          yield* Deferred.await(deferredSaved);
          expect((yield* loadCandidateReviewOptional(home, freshAfterDeferral.reviewId))?.candidates[0].state).toBe(
            'deferred',
          );
          const resumeFiber = yield* Effect.forkScoped(
            decideTopicMaintenanceReview(config, {
              reviewId: freshAfterDeferral.reviewId,
              revision: freshAfterDeferral.revision + 1,
              action: 'resume',
              caseId,
            }),
          );
          yield* Effect.sleep('150 millis');
          expect((yield* loadCandidateReviewOptional(home, freshAfterDeferral.reviewId))?.candidates[0].state).toBe(
            'deferred',
          );
          yield* Deferred.succeed(releaseReconcile, undefined);
          yield* Fiber.join(deferFiber);
          const resumedAfterConcurrentDefer = yield* Fiber.join(resumeFiber);
          expect(resumedAfterConcurrentDefer.candidates[0].state).toBe('pending');
          expect((yield* readContextMaintenanceStatus(config, 'fixture', {caseId})).cases[0]?.disposition).toBe(
            'needs-decision',
          );
          const reviewPath = path.join(home, 'threadnote/candidates/v1/reviews', `${review.reviewId}.json`);
          yield* fs.writeFileString(reviewPath, '{malformed');
          expect(Result.isFailure(yield* loadCandidateReviewOptional(home, review.reviewId).pipe(Effect.result))).toBe(
            true,
          );
          expect(yield* fs.readFileString(memory)).toBe(accepted);
        }),
      ).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
    90_000,
  );
});

const withControllerFixture = <A, E, R>(
  use: (fixture: {
    config: {account: string; agentContextHome: string; agentId: string; manifestPath: string; user: string};
    caseId: string;
    basis: TopicMaintenanceDraftBasisV1;
    valid: ReturnType<typeof makeTopicDraftWireFixture>;
    invalid: ReturnType<typeof makeTopicDraftWireFixture>;
    modelResult: (text: string, call?: number) => selectedModule.SelectedDraftResult;
    request: (generate: typeof runSelectedDraft) => ReturnType<typeof requestTopicMaintenanceDraft>;
    record: ReturnType<typeof makeTopicDraftControllerPacket>['record'];
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const {record, packet} = makeTopicDraftControllerPacket();
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'test',
      manifestPath: home + '/manifest.yaml',
      user: 'tester',
    };
    const basis = basisFromPacket(packet.topicEvidence);
    const valid = makeTopicDraftWireFixture(
      basis,
      'unchanged',
      schemaModule.topicDraftCurrentEvidence(basis, reviewEvidenceFromPacket(packet.topicEvidence)),
    );
    valid.facts.entries.forEach((entry, index) => {
      entry.disposition = 'update';
      entry.text = index === 0 ? 'Current first fact.' : 'Current second fact.';
      entry.sourceIndices = [index];
    });
    const invalid = structuredClone(valid);
    invalid.facts.entries[1].ordinal = invalid.facts.entries[0].ordinal;
    const modelResult = (text: string, call = 1): selectedModule.SelectedDraftResult => ({
      text,
      backendIdentity: 'local-ai',
      modelIdentity: modelId,
      modelVersion: 'fixture-v1',
      outputRepresentation: 'decoded-json',
      usage: {status: 'measured', inputTokens: call * 12, outputTokens: call * 3},
      settings: localDraftGenerationSettings(modelId, 'topic-maintenance'),
    });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => [
        vi.spyOn(maintenanceModule, 'readContextMaintenancePacket').mockReturnValue(Effect.succeed(packet)),
        vi.spyOn(memoryModule, 'readMemoryRecordsByUri').mockReturnValue(Effect.succeed([record])),
        vi
          .spyOn(modelModule, 'availableConsolidationModels')
          .mockReturnValue(Effect.succeed([{id: modelId, label: modelId, isDefault: true}])),
        vi.spyOn(selectedModule, 'selectedTopicDraftIdentity').mockReturnValue(
          Effect.succeed({
            agent: 'local-ai',
            model: modelId,
            modelVersion: 'fixture-v1',
            backendIdentity: 'local-ai',
            settings: serializeDraftGenerationSettings(localDraftGenerationSettings(modelId, 'topic-maintenance')),
          }),
        ),
        vi
          .spyOn(inventoryModule, 'prepareContextMaintenanceInventory')
          .mockReturnValue(Effect.fail(maintenanceSnapshotFailure('io-error', 'inventory-cache'))),
      ]),
      () =>
        use({
          config,
          caseId: packet.caseId,
          basis,
          valid,
          invalid,
          modelResult,
          record,
          request: generate =>
            requestTopicMaintenanceDraft(config, {caseId: packet.caseId, backend: 'local-ai', modelId}, generate),
        }),
      spies =>
        Effect.sync(() => {
          for (const spy of spies) spy.mockRestore();
        }),
    );
  });

describe('complete wire controller repair boundary', () => {
  for (const state of ['conflict', 'deferred', 'rejected'] as const)
    for (const sameMaterial of [true, false])
      effectIt.effect(`refuses ${state} review before source reconstruction: same material ${sameMaterial}`, () =>
        withControllerFixture(f =>
          Effect.gen(function* () {
            const review = yield* f.request(() => Effect.succeed(f.modelResult(JSON.stringify(f.valid))));
            const decided = candidateReviewWithState(review, review.candidates[0].candidateId, state);
            yield* saveCandidateReview(f.config.agentContextHome, decided);
            const queueBefore = yield* readDraftQueueTarget(f.config, sha256HexSync(f.basis.targetUri));
            const status = yield* readContextMaintenanceStatus(f.config);
            const packet = vi.mocked(maintenanceModule.readContextMaintenancePacket);
            packet.mockClear();
            packet.mockReturnValue(
              Effect.fail(maintenanceModule.ContextMaintenanceError.make({message: 'Source reconstruction required.'})),
            );
            const caseStatus = {
              ...status,
              cases: [
                {
                  caseId: f.caseId,
                  project: 'fixture',
                  memoryId: f.record.metadata.memoryId!,
                  family: 'topic-maintenance',
                  slot: 'declared-support',
                  evidenceRevision: sameMaterial ? f.basis.observationRevision : 'changed-material',
                  disposition: 'needs-decision' as const,
                  reason: 'topic-review-required',
                  firstSeen: '2026-10-16T00:00:00.000Z',
                  lastSeen: '2026-10-16T00:00:00.000Z',
                  lastChecked: '2026-10-16T00:00:00.000Z',
                  attemptCount: 0,
                  subjectContentHashes: [{uri: f.basis.targetUri, hash: f.basis.targetHash}],
                  events: [],
                },
              ],
            };
            yield* Effect.acquireUseRelease(
              Effect.sync(() =>
                vi.spyOn(maintenanceModule, 'readContextMaintenanceStatus').mockReturnValue(Effect.succeed(caseStatus)),
              ),
              () =>
                Effect.gen(function* () {
                  const failure = yield* f
                    .request(() => Effect.die('A blocked review must not dispatch.'))
                    .pipe(Effect.flip);
                  const refused = state === 'conflict' || sameMaterial;
                  expect(failure).toMatchObject(
                    refused ? {reason: `review-${state}`} : {message: 'Source reconstruction required.'},
                  );
                  expect(packet).toHaveBeenCalledTimes(refused ? 0 : 1);
                  expect(yield* loadCandidateReviewOptional(f.config.agentContextHome, review.reviewId)).toEqual(
                    decided,
                  );
                  expect(yield* readDraftQueueTarget(f.config, sha256HexSync(f.basis.targetUri))).toEqual(queueBefore);
                }),
              spy => Effect.sync(() => spy.mockRestore()),
            );
          }),
        ).pipe(provideTestLayer(ApplicationLayer)),
      );

  effectIt.effect(
    'does not turn a consumed first attempt into availability waiting when repair loses its provider',
    () =>
      withControllerFixture(f =>
        Effect.gen(function* () {
          let calls = 0;
          const generate: typeof runSelectedDraft = () =>
            Effect.gen(function* () {
              calls++;
              if (calls === 1) return f.modelResult(JSON.stringify(f.invalid));
              return yield* DraftProviderUnavailableBeforeDispatch.make({
                backend: 'local-ai',
                modelId,
                message: 'Final repair preflight has no installed model.',
              });
            });
          const failure = yield* f.request(generate).pipe(Effect.flip);
          expect(calls).toBe(2);
          expect(yield* readDraftQueueTarget(f.config, sha256HexSync(f.basis.targetUri))).toMatchObject({
            state: 'failed',
          });
          if (!Schema.is(TopicDraftError)(failure) || !failure.diagnostics)
            throw new Error('Expected observed failure.');
          const receipt = yield* loadTopicGenerationReceipt(f.config.agentContextHome, failure.diagnostics.receiptId);
          expect(receipt.attempts.map(attempt => attempt.status)).toEqual(['draft-invalid', 'not-dispatched']);
          expect(receipt.firstFailedOutput?.text).toBe(JSON.stringify(f.invalid));
          expect(yield* listCandidateReviews(f.config.agentContextHome)).toEqual([]);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const violation of ['duplicate', 'utf8', 'action-duplicate'] as const)
    effectIt.effect(
      'repairs complete ' + violation + ' assessment without losing either factual update or protected bytes',
      () =>
        withControllerFixture(f =>
          Effect.gen(function* () {
            const firstWire = structuredClone(violation === 'duplicate' ? f.invalid : f.valid);
            if (violation === 'utf8') firstWire.facts.entries[0].rationale = 'é'.repeat(513);
            if (violation === 'action-duplicate')
              firstWire.facts.entries[1].ordinal = firstWire.facts.entries[0].ordinal;
            const invalidText = JSON.stringify(schemaModule.decodeTopicDraftWire(f.basis, firstWire));
            const original = JSON.stringify({basis: f.basis, invalid: f.invalid, valid: f.valid});
            let calls = 0;
            const generate: typeof runSelectedDraft = (_config, _agent, _model, prompt) =>
              Effect.sync(() => {
                calls++;
                if (calls === 2) {
                  expect(prompt).toContain(
                    violation === 'duplicate'
                      ? 'Invalid or duplicate topic fact ordinal.'
                      : violation === 'utf8'
                        ? 'Topic fact rationale exceeds its UTF-8 scalar or byte bound.'
                        : 'Invalid or duplicate topic fact ordinal.',
                  );
                  expect(prompt).toContain('Prior invalid JSON data:');
                }
                return f.modelResult(calls === 1 ? invalidText : JSON.stringify(f.valid), calls);
              });
            const review = yield* f.request(generate);
            expect(calls).toBe(2);
            const payload = review.maintenance;
            if (payload?.version !== 1) throw new Error('Expected the frozen legacy code draft.');
            const proposal = payload.proposal;
            expect(proposal.body).toBe('Current first fact.\n\nCurrent second fact.\n\nProtected requirement.');
            expect(proposal.changedOrdinals).toEqual([0, 1]);
            expect(proposal.draft.operations.map(operation => operation.supportHandles)).toEqual([
              [f.basis.handles.filter(handle => handle.variant === 'current')[0].id],
              [f.basis.handles.filter(handle => handle.variant === 'current')[1].id],
            ]);
            expect(proposal.draft.paragraphDispositions!.entries.map(entry => entry.supportHandles)).toEqual(
              proposal.draft.operations.map(operation => operation.supportHandles),
            );
            expect(review.maintenance!.generation.usage).toEqual({
              status: 'measured',
              inputTokens: 36,
              outputTokens: 9,
            });
            const generation = review.maintenance!.generation;
            if (generation.origin === 'manual') throw new Error('Expected generated review.');
            const observation = generation.observation!;
            const receipt = yield* loadTopicGenerationReceipt(f.config.agentContextHome, observation.receiptId);
            expect(receipt.attempts.map(attempt => attempt.status)).toEqual(['draft-invalid', 'accepted']);
            expect(receipt.attempts.map(attempt => attempt.usage)).toEqual([
              f.modelResult('', 1).usage,
              f.modelResult('', 2).usage,
            ]);
            expect(receipt.firstFailedOutput).toMatchObject({
              text: invalidText,
              hash: sha256HexSync(invalidText),
              bytes: new TextEncoder().encode(invalidText).byteLength,
              representation: 'decoded-json',
              truncated: false,
            });
            expect(receipt.attempts[1].output).toMatchObject({hash: sha256HexSync(JSON.stringify(f.valid))});
            expect(
              JSON.stringify(yield* readTopicGenerationSummary(f.config.agentContextHome, observation.receiptId)),
            ).not.toContain(invalidText);
            expect(JSON.stringify({basis: f.basis, invalid: f.invalid, valid: f.valid})).toBe(original);
            expect(f.record.body).toBe(f.basis.body);
            expect((yield* f.request(generate)).revision).toBe(review.revision);
            expect(calls).toBe(2);
          }),
        ).pipe(provideTestLayer(ApplicationLayer)),
    );

  for (const scenario of [
    'two-invalid',
    'provider-failure',
    'provider-output-invalid',
    'utf8',
    'canonical-invalid',
  ] as const) {
    effectIt.effect('allows only the existing second attempt: ' + scenario, () =>
      withControllerFixture(f =>
        Effect.gen(function* () {
          let calls = 0;
          let firstText = '';
          const generate: typeof runSelectedDraft = () =>
            Effect.gen(function* () {
              calls++;
              if (scenario === 'provider-failure' && calls === 2)
                return yield* selectedModule.SelectedDraftError.make({message: 'Provider transport failed.'});
              if (scenario === 'provider-output-invalid' && calls === 2)
                return yield* TopicDraftProviderOutputError.make({
                  message: 'Repair provider schema failed.',
                  output: retainedTopicGenerationOutput(2, '{}', 'decoded-json'),
                  usage: f.modelResult('', 2).usage,
                });
              const wire = structuredClone(
                scenario === 'utf8' || scenario === 'canonical-invalid' ? f.valid : f.invalid,
              );
              if (scenario === 'utf8') wire.facts.entries[0].rationale = 'é'.repeat(513);
              if (scenario === 'canonical-invalid') wire.facts.entries[0].text = 'Old first fact.';
              const text = JSON.stringify(wire);
              if (calls === 1) firstText = text;
              return f.modelResult(text, calls);
            });
          const failure = yield* f.request(generate).pipe(Effect.flip);
          expect(calls).toBe(2);
          expect(failure).toBeInstanceOf(TopicDraftError);
          if (!Schema.is(TopicDraftError)(failure) || !failure.diagnostics)
            throw new Error('Expected observed failure.');
          const receipt = yield* loadTopicGenerationReceipt(f.config.agentContextHome, failure.diagnostics.receiptId);
          expect(receipt.attempts.map(attempt => attempt.status)).toEqual([
            'draft-invalid',
            scenario === 'provider-failure'
              ? 'provider-failed'
              : scenario === 'provider-output-invalid'
                ? 'provider-output-invalid'
                : 'draft-invalid',
          ]);
          expect(receipt.firstFailedOutput?.text).toBe(firstText);
          expect(receipt.attempts[1].usage).toEqual(
            scenario === 'provider-failure' ? {status: 'unavailable'} : f.modelResult('', 2).usage,
          );
          expect(receipt.attempts[0].usage).toEqual(f.modelResult('', 1).usage);
          expect(yield* listCandidateReviews(f.config.agentContextHome)).toEqual([]);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    );
  }

  for (const scenario of [
    'malformed',
    'partial',
    'legacy3',
    'legacy4',
    'legacy1',
    'legacy2',
    'missing-comparisons',
    'wrong-role-comparison',
    'schema',
    'identity',
    'oversized',
    'model',
    'settings',
    'sampling-absent',
    'sampling-profileId',
    'sampling-temperature',
    'sampling-topP',
    'sampling-topK',
    'provider-parse',
    'provider-schema',
    'unsupported',
    'deadline',
    'unexpected-defect',
    'prefix-defect',
  ] as const) {
    effectIt.effect('refuses repair of terminal output: ' + scenario, () =>
      withControllerFixture(f =>
        Effect.gen(function* () {
          let calls = 0;
          const projection =
            scenario === 'unexpected-defect' || scenario === 'prefix-defect'
              ? vi.spyOn(schemaModule, 'projectTopicDraftWire').mockImplementationOnce(() => {
                  throw new Error(
                    scenario === 'prefix-defect'
                      ? 'Topic maintenance draft: unexpected projection defect.'
                      : 'UNEXPECTED DEFECT',
                  );
                })
              : undefined;
          const wire = {
            ...f.valid,
            ...(scenario === 'identity' ? {packetDigest: 'f'.repeat(64)} : {}),
            ...(scenario === 'legacy1'
              ? {version: 1}
              : scenario === 'legacy2'
                ? {version: 2}
                : scenario === 'legacy3'
                  ? {version: 3}
                  : scenario === 'legacy4'
                    ? {version: 4}
                    : {}),
            ...(scenario === 'schema' ? {unexpected: true} : {}),
          };
          if (scenario === 'missing-comparisons') wire.facts.entries.pop();
          if (scenario === 'wrong-role-comparison') wire.facts.entries[0].ordinal = 77;
          const text =
            scenario === 'malformed'
              ? '{invalid'
              : scenario === 'partial'
                ? '{}'
                : scenario === 'oversized'
                  ? 'x'.repeat(32 * 1024 + 1)
                  : JSON.stringify(wire);
          const generate: typeof runSelectedDraft = () =>
            Effect.gen(function* () {
              calls++;
              if (scenario === 'provider-parse')
                return yield* InvalidModelOutput.make({message: 'Provider parse failed.', modelId});
              if (scenario === 'provider-schema')
                return yield* TopicDraftProviderOutputError.make({
                  message: 'Provider schema failed.',
                  output: retainedTopicGenerationOutput(1, '{}', 'decoded-json'),
                  usage: f.modelResult('').usage,
                });
              if (scenario === 'deadline')
                return yield* selectedModule.SelectedDraftError.make({
                  message: 'Provider deadline.',
                  reason: 'deadline',
                });
              if (scenario === 'unsupported')
                return yield* selectedModule.SelectedDraftError.make({message: 'Unsupported provider.'});
              return {
                ...f.modelResult(text),
                ...(scenario === 'model' ? {modelIdentity: 'wrong'} : {}),
                ...(scenario === 'settings' ? {settings: {maxOutputTokens: 4000 as const}} : {}),
                ...(scenario === 'sampling-absent'
                  ? {settings: {maxOutputTokens: 4000 as const, seed: 0 as const}}
                  : {}),
                ...(scenario.startsWith('sampling-') && scenario !== 'sampling-absent'
                  ? {
                      settings: {
                        ...f.modelResult('').settings,
                        sampling: {
                          ...f.modelResult('').settings.sampling!,
                          [scenario.slice('sampling-'.length)]:
                            scenario === 'sampling-profileId' ? 'different-profile' : -1,
                        },
                      },
                    }
                  : {}),
              };
            });
          const failure = yield* f
            .request(generate)
            .pipe(Effect.ensuring(Effect.sync(() => projection?.mockRestore())), Effect.flip);
          expect(calls).toBe(1);
          if (!Schema.is(TopicDraftError)(failure) || !failure.diagnostics)
            throw new Error('Expected observed failure.');
          const receipt = yield* loadTopicGenerationReceipt(f.config.agentContextHome, failure.diagnostics.receiptId);
          expect(receipt.attempts).toHaveLength(1);
          expect(receipt.attempts[0].status).not.toBe('draft-invalid');
          expect(yield* listCandidateReviews(f.config.agentContextHome)).toEqual([]);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    );
  }
  effectIt.effect('treats missing trusted lookup context as terminal before provider dispatch', () =>
    withControllerFixture(f =>
      Effect.gen(function* () {
        let calls = 0;
        const spy = vi.spyOn(schemaModule, 'topicDraftCurrentEvidence').mockImplementationOnce(() => {
          throw new Error('Verified current topic evidence is unavailable.');
        });
        const generate: typeof runSelectedDraft = () =>
          Effect.sync(() => {
            calls++;
            return f.modelResult(JSON.stringify(f.valid));
          });
        const failure = yield* f
          .request(generate)
          .pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())), Effect.flip);
        expect(calls).toBe(0);
        expect(Schema.is(TopicDraftError)(failure) && failure.message).toBe(
          'Verified current topic evidence is unavailable.',
        );
        expect(yield* listCandidateReviews(f.config.agentContextHome)).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('shares the original deadline after a nonzero first attempt', () =>
    withControllerFixture(f =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const repairStarted = yield* Deferred.make<void>();
        let calls = 0;
        let completed = false;
        const generate: typeof runSelectedDraft = () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Effect.sleep(40_000);
              return f.modelResult(JSON.stringify(f.invalid));
            }
            yield* Deferred.succeed(repairStarted, undefined);
            return yield* Effect.never;
          });
        const fiber = yield* f.request(generate).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              completed = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(firstStarted);
        yield* TestClock.adjust(40_000);
        yield* Deferred.await(repairStarted);
        yield* TestClock.adjust(79_999);
        expect(completed).toBe(false);
        yield* TestClock.adjust(1);
        const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(calls).toBe(2);
        if (!Schema.is(TopicDraftError)(failure) || !failure.diagnostics)
          throw new Error('Expected observed deadline.');
        const receipt = yield* loadTopicGenerationReceipt(f.config.agentContextHome, failure.diagnostics.receiptId);
        expect(receipt.attempts.map(attempt => attempt.status)).toEqual(['draft-invalid', 'deadline']);
        expect(receipt.attempts.map(attempt => attempt.elapsedMilliseconds)).toEqual([40_000, 80_000]);
        expect(receipt.elapsedMilliseconds).toBe(120_000);
        expect(receipt.firstFailedOutput?.text).toBe(JSON.stringify(f.invalid));
        expect(receipt.attempts[0].usage).toEqual(f.modelResult('').usage);
        expect(receipt.attempts[1].usage).toEqual({status: 'unavailable'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const failSave of [2, 4]) {
    effectIt.effect('does not dispatch repair after a required observation save fails: ' + failSave, () =>
      withControllerFixture(f =>
        Effect.gen(function* () {
          const persist = candidateGenerationModule.saveTopicGenerationReceipt;
          let saves = 0;
          let calls = 0;
          const spy = vi
            .spyOn(candidateGenerationModule, 'saveTopicGenerationReceipt')
            .mockImplementation((...args) => {
              saves++;
              return saves === failSave ? Effect.die('Fixture persistence failure.') : persist(...args);
            });
          const generate: typeof runSelectedDraft = () =>
            Effect.sync(() => {
              calls++;
              return f.modelResult(JSON.stringify(f.invalid));
            });
          yield* f.request(generate).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())), Effect.flip);
          expect(calls).toBe(failSave === 2 ? 0 : 1);
          expect(yield* listCandidateReviews(f.config.agentContextHome)).toEqual([]);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    );
  }
});
