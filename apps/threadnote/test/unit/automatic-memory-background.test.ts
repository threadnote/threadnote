import {it as effectIt} from '@effect/vitest';
import {Cause, Clock, Deferred, Effect, Fiber, FileSystem, Path, Result, Schema} from 'effect';
import {AiError} from 'effect/ai';
import {TestClock} from 'effect/testing';
import {SystemInfo} from '@threadnote/platform/system';
import {runCommandEffect} from '@threadnote/platform/command';
import {FileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {describe, expect, vi} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {
  candidateReviewWithState,
  loadCandidateReview,
  saveCandidateReview,
  withCandidateReviewLock,
} from '@threadnote/memory/candidate';
import {loadTopicGenerationReceipt} from '@threadnote/memory/candidate-generation';
import type {AutomaticMaintenanceDraftV2} from '@threadnote/memory/topic-maintenance-draft';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync as hash} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {localDraftGenerationSettings} from '../../src/effect/ai/consolidator.js';
import * as consolidatorModule from '../../src/effect/ai/consolidator.js';
import {topicDraftModelSchema, topicDraftNativeJsonSchema} from '../../src/manager/topic_draft_schema.js';
import {
  selectedTopicDraftIdentity,
  runSelectedDraft,
  AUTOMATIC_DRAFT_PROMPT_VERSION,
} from '../../src/effect/ai/selected_generation.js';
import {registerStoreTool} from '../../src/mcp/server/store.js';
import {registerReadTool} from '../../src/mcp/server/recall.js';
import {registerContextMaintenanceTools} from '../../src/mcp/server/context/maintenance.js';
import {
  runContextMaintenance,
  setContextMaintenancePaused,
  withMaintenancePauseFence,
} from '../../src/memory/context/maintenance.js';
import {
  automaticReviewPacket,
  readAutomaticDraftBackgroundStatus,
  requestAutomaticMemoryDraft,
  requestAutomaticMemoryReview,
  runAutomaticMemoryBackground,
  setAutomaticDraftBackgroundPolicy,
} from '../../src/memory/context/maintenance_draft.js';
import {readPreparedMemory} from '../../src/memory/context/maintenance_preparation_state.js';
import {readDraftQueueStatus, readDraftQueueTarget} from '../../src/memory/context/maintenance_draft_queue.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

function object(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}
const fixture = Effect.fn('automaticBackground.publicFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'ordinary-background-'});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const server = new EffectMcpServerAdapter('automatic-background-test', '1.0.0', '');
  registerStoreTool(server, config, 'remember_context', 'Store memory.');
  registerReadTool(server, config, 'read_context', 'Read memory.');
  registerContextMaintenanceTools(server, config);
  const authored = yield* server.invokeTool('remember_context', {
    kind: 'durable',
    project: 'fixture',
    topic: 'z-source',
    text: 'The timeout is 60 seconds.',
  });
  expect(authored.isError).not.toBe(true);
  const sourceUri = String(object(authored.structuredContent).memoryUri);
  const target = yield* server.invokeTool('remember_context', {
    kind: 'durable',
    project: 'fixture',
    topic: 'a-target',
    text: 'The timeout is 30 seconds.',
    relations: [{type: 'references', uri: sourceUri}],
  });
  expect(target.isError).not.toBe(true);
  const uri = String(object(target.structuredContent).memoryUri);
  const root = path.join(home, 'data/local/user/tester/memories/durable/projects/fixture');
  const targetPath = path.join(root, 'a-target.md');
  const sourcePath = path.join(root, 'z-source.md');
  const content = yield* fs.readFileString(targetPath);
  const source = yield* fs.readFileString(sourcePath);
  const sourceId = parseMemoryDocument(sourceUri, source)!.metadata.memoryId!;
  expect(parseMemoryDocument(uri, content)!.metadata.relations).toEqual([
    {type: 'references', uri: `threadnote://memory/${sourceId}`},
  ]);
  const catalog = yield* LocalModelCatalog;
  const modelId = 'gemma-4-e4b-it-q4';
  const manifest = yield* catalog.get(modelId);
  yield* selectLocalModel(home, catalog, 'generation', modelId);
  const store = yield* LocalModelStore;
  const installed = LocalModelStore.of({
    ...store,
    status: (_home, selected) =>
      Effect.succeed({
        bytes: selected.size,
        installed: true,
        modelId: selected.id,
        partialBytes: 0,
        path: '/synthetic/model.gguf',
        verified: true,
      }),
  });
  const reviewId = `review-${hash(`topic-maintenance\0${uri}`).slice(0, 24)}`;
  const generate = (...args: Parameters<typeof runSelectedDraft>) =>
    Effect.sync(() => {
      const prompt = args[3];
      const basis = args[5];
      expect(basis?.version).toBe(3);
      const packet = JSON.parse(prompt.split('\n').at(-1)!) as ReturnType<typeof automaticReviewPacket>;
      const handle = packet.reviewEvidence.find(entry => entry.descriptor.source.kind === 'memory');
      const text = handle?.content ?? packet.basis.body;
      return {
        text: JSON.stringify({
          version: 2,
          kind: 'automatic',
          purpose: 'automatic',
          targetHash: packet.basis.targetHash,
          observationRevision: packet.basis.observationRevision,
          packetDigest: packet.basis.packetDigest,
          outcome: handle ? 'propose-update' : 'insufficient-evidence',
          paragraphDecisions: [
            {
              ordinal: 0,
              beforeHash: packet.basis.paragraphs[0].hash,
              role: handle ? 'descriptive' : 'unknown',
              support: handle ? 'direct' : 'unresolved',
              evidenceIds: handle ? [handle.descriptor.id] : [],
            },
          ],
          operations: handle
            ? [
                {
                  ordinal: 0,
                  beforeHash: packet.basis.paragraphs[0].hash,
                  supportHandles: [handle.handleId],
                  rationale: 'Use the full current related paragraph.',
                  text,
                },
              ]
            : [],
          reviewedHandles: packet.reviewEvidence.map(entry => entry.handleId),
          rationale: 'Explicit provisional factual paragraph review.',
          unresolvedQuestions: [],
          removedClaims: [],
        }),
        backendIdentity: 'local-ai',
        modelIdentity: modelId,
        modelVersion: `${manifest.revision}:${manifest.sha256}`,
        usage: {status: 'unavailable' as const},
        settings: localDraftGenerationSettings(modelId, 'topic-maintenance'),
      };
    });
  const prepare = Effect.gen(function* () {
    // Preparation advances one eligible record per turn; this fixture has exactly two.
    for (let turn = 0; turn < 2; turn++) {
      yield* runContextMaintenance(config, {cwd: home, project: 'fixture', maxRecords: 16});
      if (yield* readPreparedMemory(config, uri)) return;
    }
    expect(yield* readPreparedMemory(config, uri)).toBeDefined();
  });
  return {
    fs,
    path,
    home,
    config,
    server,
    uri,
    sourceUri,
    targetPath,
    sourcePath,
    content,
    source,
    sourceId,
    installed,
    modelId,
    generate,
    reviewId,
    prepare,
  };
});

describe('automatic ordinary-memory background controls', () => {
  effectIt.effect('binds automatic generation literals, namespaces and field ordering under bounded permutations', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.prepare.pipe(Effect.provideService(LocalModelStore, f.installed));
      const packet = yield* requestAutomaticMemoryReview(f.config, {uri: f.uri, expectedContentHash: hash(f.content)});
      if ('reviewId' in packet) return yield* Effect.die('Expected a source packet.');
      const result = yield* f.generate(
        f.config,
        'local-ai',
        {id: f.modelId, label: f.modelId, isDefault: true},
        JSON.stringify(packet),
        'topic-maintenance',
        packet.basis,
      );
      const original = JSON.parse(result.text) as AutomaticMaintenanceDraftV2;
      const provisional = packet.basis.paragraphs[0];
      if (provisional.roleAuthority === 'reviewed') return yield* Effect.die('Expected the provisional fixture.');
      yield* Effect.sync(() =>
        fc.assert(
          fc.property(fc.integer({min: 1, max: 6}), fc.boolean(), (count, reverse) => {
            // Generation-grammar binding property only; final coverage/order remains preflight-owned.
            const paragraphs = Array.from({length: count}, (_, ordinal) => ({
              ...provisional,
              ordinal,
              hash: hash(`paragraph-${ordinal}`),
            }));
            const basis = {...packet.basis, paragraphs: reverse ? [...paragraphs].reverse() : paragraphs};
            const schema = topicDraftModelSchema(basis);
            const decode = Schema.decodeUnknownSync(schema, {onExcessProperty: 'error'});
            const wire = {
              ...original,
              paragraphDecisions: paragraphs.map(paragraph => ({
                ...original.paragraphDecisions[0],
                ordinal: paragraph.ordinal,
                beforeHash: paragraph.hash,
              })),
              operations: [{...original.operations[0], ordinal: count - 1, beforeHash: paragraphs[count - 1].hash}],
            };
            const before = JSON.stringify({basis, wire});
            expect(() => decode(wire)).not.toThrow();
            // A singleton reference universe cannot admit the observed NV004 duplicate.
            expect(() =>
              decode({
                ...wire,
                paragraphDecisions: wire.paragraphDecisions.map(decision => ({
                  ...decision,
                  evidenceIds: [...decision.evidenceIds, ...decision.evidenceIds],
                })),
              }),
            ).toThrow();
            expect(() =>
              decode({
                ...wire,
                operations: wire.operations.map(operation => ({
                  ...operation,
                  supportHandles: [...operation.supportHandles, ...operation.supportHandles],
                })),
              }),
            ).toThrow();
            expect(() =>
              decode({
                ...wire,
                paragraphDecisions: wire.paragraphDecisions.map(decision => ({
                  ...decision,
                  evidenceIds: original.operations[0].supportHandles,
                })),
              }),
            ).toThrow();
            expect(() =>
              decode({
                ...wire,
                operations: [{...wire.operations[0], supportHandles: original.paragraphDecisions[0].evidenceIds}],
              }),
            ).toThrow();
            expect(() => decode({...wire, reviewedHandles: original.paragraphDecisions[0].evidenceIds})).toThrow();
            expect(() =>
              decode({...wire, operations: [{...wire.operations[0], beforeHash: hash('unbound-hash')}]}),
            ).toThrow();
            if (count > 1)
              expect(() =>
                decode({...wire, operations: [{...wire.operations[0], beforeHash: paragraphs[0].hash}]}),
              ).toThrow();
            const native = topicDraftNativeJsonSchema(schema, basis);
            const fields = object(native.properties);
            expect(Object.keys(fields).indexOf('paragraphDecisions')).toBeLessThan(
              Object.keys(fields).indexOf('operations'),
            );
            const item = object(object(fields.operations).items);
            const variants = 'oneOf' in item ? (item.oneOf as readonly Record<string, unknown>[]) : [item];
            for (const variant of variants) {
              const keys = Object.keys(object(variant.properties));
              expect(keys.indexOf('supportHandles')).toBeLessThan(keys.indexOf('text'));
              expect(keys.indexOf('rationale')).toBeLessThan(keys.indexOf('text'));
            }
            expect(JSON.stringify({basis, wire})).toBe(before);
          }),
          {numRuns: 12, seed: 30303},
        ),
      );
      const noEvidence = {...packet.basis, handles: [], assessment: {...packet.basis.assessment, evidence: []}};
      const emptySchema = topicDraftModelSchema(noEvidence);
      const emptyWire = {
        ...original,
        operations: [],
        reviewedHandles: [],
        paragraphDecisions: original.paragraphDecisions.map(decision => ({
          ...decision,
          support: 'unresolved',
          evidenceIds: [],
        })),
      };
      const decodeEmpty = Schema.decodeUnknownEffect(emptySchema, {onExcessProperty: 'error'});
      expect(Result.isSuccess(yield* decodeEmpty(emptyWire).pipe(Effect.result))).toBe(true);
      expect(
        Result.isFailure(
          yield* decodeEmpty({...emptyWire, reviewedHandles: original.reviewedHandles}).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* decodeEmpty({...emptyWire, paragraphDecisions: original.paragraphDecisions}).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(() => topicDraftNativeJsonSchema(emptySchema, noEvidence)).not.toThrow();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  for (const state of ['pending', 'rejected', 'deferred', 'conflict', 'applying'] as const) {
    effectIt.effect(`preserves an earlier prompt contract review across the version bump: ${state}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* f.prepare;
          const input = {
            uri: f.uri,
            expectedContentHash: hash(f.content),
            backend: 'local-ai' as const,
            modelId: f.modelId,
          };
          const packet = yield* requestAutomaticMemoryReview(f.config, input);
          if ('reviewId' in packet) return yield* Effect.die('Expected a source packet.');
          const result = yield* f.generate(
            f.config,
            'local-ai',
            {id: f.modelId, label: f.modelId, isDefault: true},
            JSON.stringify(packet),
            'topic-maintenance',
            packet.basis,
          );
          const review = yield* requestAutomaticMemoryReview(
            f.config,
            {...input, draftJson: result.text},
            {
              origin: 'model',
              agent: 'local-ai',
              model: f.modelId,
              promptVersion: 'automatic-memory-v1',
              attempts: 1,
              usage: {status: 'unavailable'},
            },
          );
          if (!('reviewId' in review)) return yield* Effect.die('Expected a private review.');
          const prior = candidateReviewWithState(review, review.candidates[0].candidateId, state);
          yield* saveCandidateReview(f.home, prior);
          const blocked = yield* requestAutomaticMemoryDraft(f.config, input, () =>
            Effect.die('An earlier review must block dispatch.'),
          ).pipe(Effect.result);
          expect(Result.isFailure(blocked)).toBe(true);
          expect(yield* loadCandidateReview(f.home, f.reviewId)).toEqual(prior);
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(0);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }
  const nativeWireCases = [
    'repair',
    'invalid-second',
    'repair-provider-unavailable',
    'repair-manifest-drift',
    'no-change',
    'target-identity',
    'excess-field',
    'missing-coverage',
    'duplicate-coverage',
    'wrong-ordinal',
    'decision-ordinal',
    'duplicate-operation',
    'split-paragraph',
    'before-hash',
    'unknown-handle',
    'unknown-support-handle',
    'unknown-evidence-id',
    'nv003-prefixed-decision-id',
    'nv004-duplicate-decision-id',
    'rationale-bound',
    'receipt-save',
  ] as const;
  for (const scenario of nativeWireCases) {
    effectIt.effect(`validates actual selected native automatic output: ${scenario}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const catalog = yield* LocalModelCatalog;
        let manifestDrift = false;
        const currentCatalog = LocalModelCatalog.of({
          ...catalog,
          get: id =>
            catalog
              .get(id)
              .pipe(
                Effect.map(manifest =>
                  manifestDrift ? {...manifest, revision: hash('changed-manifest').slice(0, 40)} : manifest,
                ),
              ),
        });
        yield* Effect.gen(function* () {
          yield* f.prepare;
          const runtime = yield* LocalModelRuntime;
          let calls = 0;
          let firstText: string | undefined;
          let saveFailed = false;
          const receiptRoot = f.path.join(f.home, 'threadnote/candidates/v1/topic-generation');
          const fs = FileSystem.FileSystem.of({
            ...f.fs,
            rename: (from, to) => {
              if (!['receipt-save', 'repair-manifest-drift'].includes(scenario) || !to.startsWith(receiptRoot))
                return f.fs.rename(from, to);
              return f.fs.readFileString(from).pipe(
                Effect.flatMap(text => {
                  if (scenario === 'repair-manifest-drift')
                    return f.fs.rename(from, to).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          if (text.includes('"status":"draft-invalid"')) manifestDrift = true;
                        }),
                      ),
                    );
                  if (!saveFailed && text.includes('"status":"draft-invalid"')) {
                    saveFailed = true;
                    return f.fs.rename(from, f.path.join(f.home, 'absent-directory', 'receipt.json'));
                  }
                  return f.fs.rename(from, to);
                }),
              );
            },
          });
          const stub = LocalModelRuntime.of({
            ...runtime,
            generate: request =>
              Effect.gen(function* () {
                calls++;
                expect(request.prompt).toContain('You are instructed to propose supported corrections');
                const packet = JSON.parse(request.prompt.split('\n').at(-1)!) as ReturnType<
                  typeof automaticReviewPacket
                >;
                const result = yield* f.generate(
                  f.config,
                  'local-ai',
                  {id: f.modelId, label: f.modelId, isDefault: true},
                  request.prompt,
                  'topic-maintenance',
                  packet.basis,
                );
                let wire = JSON.parse(result.text) as AutomaticMaintenanceDraftV2;
                if (calls === 2) {
                  expect(request.prompt).toContain('invalid automatic paragraph replacement');
                  expect(request.prompt).toContain(
                    JSON.stringify({
                      validationError: 'Topic maintenance draft: invalid automatic paragraph replacement.',
                      previousDraft: firstText,
                    }),
                  );
                }
                if (calls === 1 || scenario === 'invalid-second') {
                  if (
                    [
                      'repair',
                      'invalid-second',
                      'repair-provider-unavailable',
                      'repair-manifest-drift',
                      'receipt-save',
                      'no-change',
                    ].includes(scenario)
                  ) {
                    wire = {
                      ...wire,
                      outcome: 'insufficient-evidence',
                      operations:
                        scenario === 'no-change'
                          ? []
                          : wire.operations.map(operation => ({
                              ...operation,
                              text: packet.basis.body,
                              supportHandles: [],
                              rationale:
                                'The source contradicts the memory, but there is no instruction to update the memory. The operation is not performed.',
                            })),
                      rationale: 'The memory is retained as is, but the conflict is noted.',
                      paragraphDecisions: wire.paragraphDecisions.map(decision => ({
                        ...decision,
                        role: 'unknown',
                        support: 'unresolved',
                        evidenceIds: [],
                      })),
                    };
                  }
                  if (scenario === 'target-identity') wire = {...wire, targetHash: hash('stale')};
                  if (scenario === 'missing-coverage') wire = {...wire, paragraphDecisions: []};
                  if (scenario === 'duplicate-coverage')
                    wire = {...wire, paragraphDecisions: [...wire.paragraphDecisions, ...wire.paragraphDecisions]};
                  if (scenario === 'wrong-ordinal')
                    wire = {...wire, operations: wire.operations.map(operation => ({...operation, ordinal: -1}))};
                  if (scenario === 'decision-ordinal')
                    wire = {
                      ...wire,
                      paragraphDecisions: wire.paragraphDecisions.map(decision => ({...decision, ordinal: -1})),
                    };
                  if (scenario === 'duplicate-operation')
                    wire = {...wire, operations: [...wire.operations, ...wire.operations]};
                  if (scenario === 'split-paragraph')
                    wire = {
                      ...wire,
                      operations: wire.operations.map(operation => ({
                        ...operation,
                        text: operation.text + '\n\nAnother paragraph.',
                      })),
                    };
                  if (scenario === 'before-hash')
                    wire = {
                      ...wire,
                      operations: wire.operations.map(operation => ({...operation, beforeHash: hash('stale')})),
                    };
                  if (scenario === 'unknown-handle')
                    wire = {...wire, reviewedHandles: [`current:ame_${hash('unknown')}`]};
                  if (scenario === 'unknown-support-handle')
                    wire = {
                      ...wire,
                      operations: wire.operations.map(operation => ({
                        ...operation,
                        supportHandles: [`current:ame_${hash('unknown')}`],
                      })),
                    };
                  if (scenario === 'unknown-evidence-id')
                    wire = {
                      ...wire,
                      paragraphDecisions: wire.paragraphDecisions.map(decision => ({
                        ...decision,
                        evidenceIds: [`ame_${hash('unknown')}`],
                      })),
                    };
                  if (scenario === 'nv003-prefixed-decision-id')
                    wire = {
                      ...wire,
                      operations: wire.operations.map(operation => ({...operation, text: packet.basis.body})),
                      paragraphDecisions: wire.paragraphDecisions.map(decision => ({
                        ...decision,
                        evidenceIds: wire.operations[0].supportHandles,
                      })),
                    };
                  if (scenario === 'nv004-duplicate-decision-id')
                    wire = {
                      ...wire,
                      paragraphDecisions: wire.paragraphDecisions.map(decision => ({
                        ...decision,
                        evidenceIds: [...decision.evidenceIds, ...decision.evidenceIds],
                      })),
                    };
                  if (scenario === 'rationale-bound') wire = {...wire, rationale: 'x'.repeat(2049)};
                }
                const output = scenario === 'excess-field' ? {...wire, invented: true} : wire;
                if (calls === 1) firstText = JSON.stringify(output);
                return output;
              }).pipe(Effect.orDie),
          });
          const finalStore = LocalModelStore.of({
            ...f.installed,
            status: (home, manifest) =>
              f.installed.status(home, manifest).pipe(
                Effect.map(status => ({
                  ...status,
                  installed: scenario !== 'repair-provider-unavailable' || calls === 0,
                })),
              ),
          });
          const generate: typeof runSelectedDraft = (...args) =>
            runSelectedDraft(...args).pipe(
              Effect.provideService(LocalModelRuntime, stub),
              Effect.provideService(LocalModelStore, finalStore),
            );
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          );
          const success = scenario === 'repair' || scenario === 'no-change';
          expect(calls).toBe(scenario === 'repair' || scenario === 'invalid-second' ? 2 : 1);
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
          expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.state).toBe(success ? 'completed' : 'failed');
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          const files = yield* f.fs.readDirectory(receiptRoot);
          expect(files).toHaveLength(1);
          const receipt = yield* loadTopicGenerationReceipt(f.home, files[0].replace(/\.json$/u, ''));
          expect(receipt.promptVersion).toBe(AUTOMATIC_DRAFT_PROMPT_VERSION);
          expect(receipt.attempts.map(attempt => attempt.status)).toEqual(
            scenario === 'repair'
              ? ['draft-invalid', 'accepted']
              : scenario === 'invalid-second'
                ? ['draft-invalid', 'draft-invalid']
                : scenario === 'no-change'
                  ? ['accepted']
                  : scenario === 'repair-provider-unavailable'
                    ? ['draft-invalid', 'not-dispatched']
                    : scenario === 'repair-manifest-drift'
                      ? ['draft-invalid']
                      : scenario === 'receipt-save'
                        ? ['draft-invalid']
                        : ['provider-output-invalid'],
          );
          if (scenario !== 'no-change') {
            expect(receipt.firstFailedOutput).toMatchObject({
              text: firstText,
              hash: hash(firstText!),
              bytes: new TextEncoder().encode(firstText).byteLength,
              representation: 'decoded-json',
            });
          }
          if (success) {
            const review = yield* loadCandidateReview(f.home, f.reviewId);
            expect(review.maintenance?.generation).toMatchObject({
              promptVersion: AUTOMATIC_DRAFT_PROMPT_VERSION,
              attempts: calls,
            });
            expect(review.maintenance?.proposal.body).toBe(
              scenario === 'repair' ? 'The timeout is 60 seconds.' : 'The timeout is 30 seconds.',
            );
          } else {
            expect(yield* f.fs.exists(f.path.join(f.home, `threadnote/candidates/v1/reviews/${f.reviewId}.json`))).toBe(
              false,
            );
            if (scenario === 'repair-manifest-drift') manifestDrift = false;
            yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
            expect(calls).toBe(scenario === 'invalid-second' ? 2 : 1);
          }
          if (scenario === 'receipt-save') expect(saveFailed).toBe(true);
        }).pipe(
          Effect.provideService(LocalModelStore, f.installed),
          Effect.provideService(LocalModelCatalog, currentCatalog),
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }
  for (const failure of ['configuration-missing', 'authentication-after-dispatch'] as const) {
    effectIt.effect(`keeps real remote ${failure} distinct from an unused same-identity recovery`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const system = yield* SystemInfo;
        const modelId = 'preflight-remote-model';
        const environment = {
          ...system.environment(),
          THREADNOTE_EFFECT_AI: 'true',
          THREADNOTE_EFFECT_AI_MODEL: modelId,
          THREADNOTE_EFFECT_AI_API_URL: 'https://preflight.invalid/v1',
        };
        const configured = SystemInfo.of({...system, environment: () => environment});
        let available = failure !== 'configuration-missing';
        const finalSystem = SystemInfo.of({
          ...system,
          environment: () => ({...environment, THREADNOTE_EFFECT_AI: available ? 'true' : 'false'}),
        });
        yield* Effect.gen(function* () {
          yield* f.prepare;
          expect(
            (yield* f.server.invokeTool('context_maintain', {
              action: 'background-budget',
              backend: 'effect-ai',
              modelId,
              unitsPerHour: 1,
            })).isError,
          ).not.toBe(true);
          let httpBoundaryCalls = 0;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi
                .spyOn(consolidatorModule, 'runEffectAiTopicDraft')
                .mockImplementation((prompt, configuration, _schema, basis) =>
                  Effect.gen(function* () {
                    httpBoundaryCalls++;
                    expect(configuration.model).toBe(modelId);
                    if (failure === 'authentication-after-dispatch')
                      return yield* AiError.AiError.make({
                        module: 'synthetic',
                        method: 'generate',
                        reason: AiError.AuthenticationError.make({kind: 'InvalidKey'}),
                      });
                    const result = yield* f
                      .generate(
                        f.config,
                        'effect-ai',
                        {id: modelId, label: modelId, isDefault: true},
                        prompt,
                        'topic-maintenance',
                        basis,
                      )
                      .pipe(Effect.orDie);
                    return {text: result.text, usage: result.usage, outputRepresentation: 'decoded-json' as const};
                  }),
                ),
            ),
            spy => Effect.sync(() => spy.mockRestore()),
          );
          const generate: typeof runSelectedDraft = (...args) =>
            runSelectedDraft(...args).pipe(Effect.provideService(SystemInfo, finalSystem));
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          const missing = failure === 'configuration-missing';
          expect(httpBoundaryCalls).toBe(missing ? 0 : 1);
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(missing ? 0 : 1);
          const first = yield* readDraftQueueTarget(f.config, hash(f.uri));
          expect(first?.state).toBe(missing ? 'waiting' : 'failed');
          available = true;
          yield* TestClock.adjust(300_000);
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(httpBoundaryCalls).toBe(1);
          const restored = yield* readDraftQueueTarget(f.config, hash(f.uri));
          expect(restored?.identity).toBe(first?.identity);
          expect(restored?.materialRevision).toBe(first?.materialRevision);
          expect(restored?.state).toBe(missing ? 'completed' : 'failed');
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
        }).pipe(Effect.provideService(SystemInfo, configured), Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }

  for (const invalidation of [
    'background-pause',
    'remote-revoke',
    'provider-change',
    'all-maintenance-pause',
  ] as const) {
    effectIt.effect(`serializes ${invalidation} with the actual private review rename and completion`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const system = yield* SystemInfo;
        const modelId = 'closing-remote-model';
        const remoteSystem = SystemInfo.of({
          ...system,
          environment: () => ({
            ...system.environment(),
            THREADNOTE_EFFECT_AI: 'true',
            THREADNOTE_EFFECT_AI_MODEL: modelId,
            THREADNOTE_EFFECT_AI_API_URL: 'https://closing.invalid/v1',
          }),
        });
        yield* Effect.gen(function* () {
          yield* f.prepare;
          expect(
            (yield* f.server.invokeTool('context_maintain', {
              action: 'background-budget',
              backend: 'effect-ai',
              modelId,
              unitsPerHour: 1,
            })).isError,
          ).not.toBe(true);
          const identity = yield* selectedTopicDraftIdentity(f.config, 'effect-ai', {
            id: modelId,
            label: modelId,
            isDefault: true,
          });
          const beforeRename = yield* Deferred.make<void>();
          const releaseRename = yield* Deferred.make<void>();
          const beforeCleanup = yield* Deferred.make<void>();
          const releaseCleanup = yield* Deferred.make<void>();
          const policyBoundary = yield* Deferred.make<'contended' | 'completed'>();
          const reviewPath = f.path.join(f.home, `threadnote/candidates/v1/reviews/${f.reviewId}.json`);
          const gated = FileSystem.FileSystem.of({
            ...f.fs,
            rename: (from, to) =>
              Effect.gen(function* () {
                if (to === reviewPath) {
                  yield* Deferred.succeed(beforeRename, undefined);
                  yield* Deferred.await(releaseRename);
                }
                return yield* f.fs.rename(from, to);
              }),
            writeFileString: (file, text, options) =>
              Effect.gen(function* () {
                if (file.includes('/topic-generation/') && JSON.parse(text).state === 'completed') {
                  yield* Deferred.succeed(beforeCleanup, undefined);
                  yield* Deferred.await(releaseCleanup);
                }
                return yield* f.fs.writeFileString(file, text, options);
              }),
          });
          const policyFileSystem = FileSystem.FileSystem.of({
            ...f.fs,
            writeFileString: (file, text, options) =>
              f.fs
                .writeFileString(file, text, options)
                .pipe(
                  Effect.tapError(() =>
                    file.endsWith(invalidation === 'all-maintenance-pause' ? 'state-v2.json.lock' : 'queue.lock')
                      ? Deferred.succeed(policyBoundary, 'contended').pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
          });
          const generate: typeof runSelectedDraft = (...args) =>
            f.generate(...args).pipe(
              Effect.map(result => ({
                ...result,
                backendIdentity: identity.backendIdentity,
                modelIdentity: modelId,
                modelVersion: identity.modelVersion,
                settings: {maxOutputTokens: 4000 as const},
              })),
            );
          yield* Effect.gen(function* () {
            const worker = yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate).pipe(
              Effect.provideService(FileSystem.FileSystem, gated),
              Effect.forkChild(),
            );
            yield* Deferred.await(beforeRename);
            expect(yield* f.fs.exists(reviewPath)).toBe(false);
            const action =
              invalidation === 'all-maintenance-pause'
                ? {action: 'pause', callerCwd: f.home}
                : invalidation === 'remote-revoke'
                  ? {action: 'background-budget', backend: 'effect-ai', unitsPerHour: 0}
                  : invalidation === 'provider-change'
                    ? {action: 'background-provider', backend: 'local-ai'}
                    : {action: 'background-pause'};
            const policy = yield* f.server.invokeTool('context_maintain', action).pipe(
              Effect.provideService(FileSystem.FileSystem, policyFileSystem),
              Effect.tap(() => Deferred.succeed(policyBoundary, 'completed')),
              Effect.forkChild(),
            );
            // A completed invalidation cannot be followed by this pending rename.
            expect(yield* Deferred.await(policyBoundary)).toBe('contended');
            expect(yield* f.fs.exists(reviewPath)).toBe(false);
            yield* Deferred.succeed(releaseRename, undefined);
            yield* Deferred.await(beforeCleanup);
            expect((yield* loadCandidateReview(f.home, f.reviewId)).candidates[0].state).toBe('pending');
            yield* TestClock.adjust(100);
            expect((yield* Fiber.join(policy)).isError).not.toBe(true);
            yield* Deferred.succeed(releaseCleanup, undefined);
            yield* Fiber.join(worker);
            expect(yield* readDraftQueueTarget(f.config, hash(f.uri))).toMatchObject({state: 'completed'});
            expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
            expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(releaseRename, undefined).pipe(
                Effect.andThen(Deferred.succeed(releaseCleanup, undefined)),
              ),
            ),
          );
        }).pipe(Effect.provideService(LocalModelStore, f.installed), Effect.provideService(SystemInfo, remoteSystem));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }

  const contentionCases = [
    'release',
    'background-pause',
    'all-maintenance-pause',
    'provider-change',
    'remote-revoke',
    'endpoint-drift',
    'source-change',
    'user-reject',
    'lease-expiry',
  ] as const;
  const contendedPublication = (change: (typeof contentionCases)[number], holdMilliseconds = 75) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const system = yield* SystemInfo;
      const remote = change === 'remote-revoke' || change === 'endpoint-drift';
      const remoteModel = 'waiting-remote-model';
      let endpoint = 'https://waiting.invalid/v1';
      const configured = remote
        ? SystemInfo.of({
            ...system,
            environment: () => ({
              ...system.environment(),
              THREADNOTE_EFFECT_AI: 'true',
              THREADNOTE_EFFECT_AI_MODEL: remoteModel,
              THREADNOTE_EFFECT_AI_API_URL: endpoint,
            }),
          })
        : system;
      yield* Effect.gen(function* () {
        yield* f.prepare;
        if (remote)
          expect(
            (yield* f.server.invokeTool('context_maintain', {
              action: 'background-budget',
              backend: 'effect-ai',
              modelId: remoteModel,
              unitsPerHour: 1,
            })).isError,
          ).not.toBe(true);
        const identity = remote
          ? yield* selectedTopicDraftIdentity(f.config, 'effect-ai', {
              id: remoteModel,
              label: remoteModel,
              isDefault: true,
            })
          : undefined;
        const held = yield* Deferred.make<void>();
        const releaseState = yield* Deferred.make<void>();
        const contended = yield* Deferred.make<void>();
        const closingReleased = yield* Deferred.make<void>();
        const resumeClosing = yield* Deferred.make<void>();
        const stateLock = f.path.join(f.home, 'context-maintenance/state-v2.json.lock');
        const reviewLock = f.path.join(f.home, `threadnote/candidates/v1/locks/${f.reviewId}.lock`);
        const reviewPath = f.path.join(f.home, `threadnote/candidates/v1/reviews/${f.reviewId}.json`);
        let firstRelease = true;
        let calls = 0;
        const closingFs = FileSystem.FileSystem.of({
          ...f.fs,
          writeFileString: (file, text, options) =>
            f.fs
              .writeFileString(file, text, options)
              .pipe(
                Effect.tapError(() =>
                  file === stateLock ? Deferred.succeed(contended, undefined).pipe(Effect.asVoid) : Effect.void,
                ),
              ),
          remove: (file, options) =>
            Effect.gen(function* () {
              yield* f.fs.remove(file, options);
              if (file === reviewLock && firstRelease) {
                firstRelease = false;
                yield* Deferred.succeed(closingReleased, undefined);
                // The real review lock is already released; stop before any retry.
                yield* Deferred.await(resumeClosing);
              }
            }),
        });
        const owner = yield* withExclusiveFileLock(
          f.fs,
          stateLock,
          {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 60_000, waitTimeoutMilliseconds: 50},
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(releaseState))),
        ).pipe(Effect.forkChild());
        yield* Deferred.await(held);
        yield* Effect.gen(function* () {
          const generate: typeof runSelectedDraft = (...args) => {
            calls++;
            return f.generate(...args).pipe(
              Effect.map(result =>
                identity
                  ? {
                      ...result,
                      backendIdentity: identity.backendIdentity,
                      modelIdentity: remoteModel,
                      modelVersion: identity.modelVersion,
                      settings: {maxOutputTokens: 4000 as const},
                    }
                  : result,
              ),
            );
          };
          const worker = yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate).pipe(
            Effect.provideService(FileSystem.FileSystem, closingFs),
            Effect.forkChild(),
          );
          yield* Deferred.await(contended);
          yield* TestClock.adjust(holdMilliseconds);
          yield* Deferred.await(closingReleased);
          expect(calls).toBe(1);
          expect(yield* f.fs.exists(reviewPath)).toBe(false);
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
          // Interactive review is free while the maintenance scan still owns state.
          yield* withCandidateReviewLock(f.home, f.reviewId, Effect.void);
          yield* Deferred.succeed(releaseState, undefined);
          yield* Fiber.join(owner);
          if (change === 'background-pause')
            yield* setAutomaticDraftBackgroundPolicy(f.config, {action: 'background-pause'});
          if (change === 'all-maintenance-pause') yield* setContextMaintenancePaused(f.config, true);
          if (change === 'provider-change')
            yield* setAutomaticDraftBackgroundPolicy(f.config, {action: 'background-provider', backend: 'effect-ai'});
          if (change === 'remote-revoke')
            yield* setAutomaticDraftBackgroundPolicy(f.config, {
              action: 'background-budget',
              backend: 'effect-ai',
              unitsPerHour: 0,
            });
          if (change === 'endpoint-drift') endpoint = 'https://changed.invalid/v1';
          if (change === 'source-change') {
            expect(
              (yield* f.server.invokeTool('remember_context', {
                kind: 'durable',
                project: 'fixture',
                topic: 'z-source',
                replaceUri: f.sourceUri,
                text: 'The timeout is now 90 seconds.',
              })).isError,
            ).not.toBe(true);
          }
          if (change === 'user-reject') {
            const packetResult = yield* f.server.invokeTool('context_maintenance_review', {
              action: 'automatic-preview',
              uri: f.uri,
              expectedContentHash: hash(f.content),
            });
            expect(packetResult.isError).not.toBe(true);
            const packet = packetResult.structuredContent as unknown as ReturnType<typeof automaticReviewPacket>;
            const authored = yield* f.generate(
              f.config,
              'local-ai',
              {id: f.modelId, label: f.modelId, isDefault: true},
              JSON.stringify(packet),
              'topic-maintenance',
              packet.basis,
            );
            const manual = yield* f.server.invokeTool('context_maintenance_review', {
              action: 'automatic-preview',
              uri: f.uri,
              expectedContentHash: hash(f.content),
              draftJson: authored.text,
            });
            expect(manual.isError).not.toBe(true);
            expect(
              (yield* f.server.invokeTool('context_maintenance_review', {
                action: 'reject',
                reviewId: f.reviewId,
                revision: Number(object(manual.structuredContent).revision),
              })).isError,
            ).not.toBe(true);
          }
          if (change === 'lease-expiry') yield* TestClock.adjust(120_000);
          yield* Deferred.succeed(resumeClosing, undefined);
          // The publication-only retry has its own short delay, never a new lease.
          yield* TestClock.adjust(25);
          yield* Fiber.join(worker);
          expect(calls).toBe(1);
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
          if (change === 'release') {
            const review = yield* loadCandidateReview(f.home, f.reviewId);
            expect(review.candidates[0].state).toBe('pending');
            expect(review.maintenance?.generation).toMatchObject({attempts: 1});
            const generation = review.maintenance?.generation;
            expect(generation?.origin === 'model' ? generation.observation?.attempts : undefined).toHaveLength(1);
            expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.state).toBe('completed');
          } else if (change === 'user-reject') {
            expect((yield* loadCandidateReview(f.home, f.reviewId)).candidates[0].state).toBe('rejected');
            expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.decision).toBe('reject');
          } else {
            expect(yield* f.fs.exists(reviewPath)).toBe(false);
            expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.state).toBe('failed');
          }
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(releaseState, undefined).pipe(Effect.andThen(Deferred.succeed(resumeClosing, undefined))),
          ),
        );
      }).pipe(Effect.provideService(LocalModelStore, f.installed), Effect.provideService(SystemInfo, configured));
    }).pipe(provideTestLayer(ApplicationLayer));
  for (const change of contentionCases) {
    effectIt.effect(`retries only closing the same output after state-lock contention: ${change}`, () =>
      contendedPublication(change),
    );
  }
  fcEffectProp(
    effectIt,
    'conserves one inference and reservation across bounded pre-publication waiting durations',
    {holdMilliseconds: fc.integer({min: 76, max: 500})},
    ({holdMilliseconds}) => contendedPublication('release', holdMilliseconds),
    {fastCheck: {numRuns: 4, seed: 30719}},
  );

  effectIt.effect('preserves typed lock failures from an already-entered pause-fence callback', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const failure = FileLockTimeout.of(f.path.join(f.home, 'context-maintenance/state-v2.json.lock'));
      const result = yield* withMaintenancePauseFence(f.config, Effect.fail(failure)).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBe(failure);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not retry a private writer failure after publication entered', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        yield* f.prepare;
        let calls = 0;
        let renames = 0;
        const reviewPath = f.path.join(f.home, `threadnote/candidates/v1/reviews/${f.reviewId}.json`);
        const faulty = FileSystem.FileSystem.of({
          ...f.fs,
          rename: (from, to) => {
            if (to !== reviewPath) return f.fs.rename(from, to);
            renames++;
            return f.fs.rename(from, f.path.join(f.home, 'absent-directory', 'review.json'));
          },
        });
        const generate: typeof runSelectedDraft = (...args) => {
          calls++;
          return f.generate(...args);
        };
        yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate).pipe(
          Effect.provideService(FileSystem.FileSystem, faulty),
        );
        expect(calls).toBe(1);
        expect(renames).toBe(1);
        expect(yield* f.fs.exists(reviewPath)).toBe(false);
        expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
        expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.state).toBe('failed');
      }).pipe(Effect.provideService(LocalModelStore, f.installed));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  for (const preflight of ['missing-installation', 'invalid-role'] as const) {
    effectIt.effect(`keeps final real-provider ${preflight} truth through unchanged automatic recovery`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* f.prepare;
          const catalog = yield* LocalModelCatalog;
          const runtime = yield* LocalModelRuntime;
          let unavailable = true;
          let runtimeCalls = 0;
          let providerFailure: unknown;
          let providerCause: string | undefined;
          const finalStore = LocalModelStore.of({
            ...f.installed,
            status: (home, manifest) =>
              f.installed
                .status(home, manifest)
                .pipe(
                  Effect.map(status => ({...status, installed: preflight !== 'missing-installation' || !unavailable})),
                ),
          });
          const finalCatalog = LocalModelCatalog.of({
            ...catalog,
            get: id =>
              catalog
                .get(id)
                .pipe(
                  Effect.map(manifest =>
                    preflight === 'invalid-role' && unavailable ? {...manifest, role: 'embedding' as const} : manifest,
                  ),
                ),
          });
          const stub = LocalModelRuntime.of({
            ...runtime,
            generate: request =>
              Effect.gen(function* () {
                runtimeCalls++;
                expect(request.jsonSchema).toMatchObject({
                  properties: {version: {enum: [2]}, kind: {enum: ['automatic']}},
                });
                expect(request.jsonSchema.properties).not.toHaveProperty('decision');
                const packet = JSON.parse(request.prompt.split('\n').at(-1)!) as ReturnType<
                  typeof automaticReviewPacket
                >;
                const result = yield* f.generate(
                  f.config,
                  'local-ai',
                  {id: f.modelId, label: f.modelId, isDefault: true},
                  request.prompt,
                  'topic-maintenance',
                  packet.basis,
                );
                return JSON.parse(result.text) as unknown;
              }).pipe(Effect.orDie),
          });
          const generate: typeof runSelectedDraft = (...args) =>
            runSelectedDraft(...args).pipe(
              Effect.provideService(LocalModelStore, finalStore),
              Effect.provideService(LocalModelCatalog, finalCatalog),
              Effect.provideService(LocalModelRuntime, stub),
              Effect.tapError(error =>
                Effect.sync(() => {
                  providerFailure = error;
                }),
              ),
              Effect.tapCause(cause =>
                Effect.sync(() => {
                  providerCause = Cause.pretty(cause);
                }),
              ),
            );
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(runtimeCalls).toBe(0);
          const first = yield* readDraftQueueTarget(f.config, hash(f.uri));
          const missing = preflight === 'missing-installation';
          expect(providerFailure, providerCause).toMatchObject({
            _tag: missing ? 'DraftProviderUnavailableBeforeDispatch' : 'AiConsolidationFailed',
          });
          expect(first?.state).toBe(missing ? 'waiting' : 'failed');
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(missing ? 0 : 1);
          expect(yield* f.fs.exists(f.path.join(f.home, `threadnote/candidates/v1/reviews/${f.reviewId}.json`))).toBe(
            false,
          );
          unavailable = false;
          yield* TestClock.adjust(300_000);
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(runtimeCalls).toBe(missing ? 1 : 0);
          const restored = yield* readDraftQueueTarget(f.config, hash(f.uri));
          expect(restored?.identity).toBe(first?.identity);
          expect(restored?.materialRevision).toBe(first?.materialRevision);
          expect(restored?.state).toBe(missing ? 'completed' : 'failed');
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
          if (missing) expect((yield* loadCandidateReview(f.home, f.reviewId)).candidates[0].state).toBe('pending');
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          expect(yield* f.fs.readFileString(f.sourcePath)).toBe(f.source);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect(
    'uses public normalized relations to save the original bounded draft without changing canonical bytes',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* f.prepare;
          let calls = 0;
          const generate: typeof runSelectedDraft = (...args) => {
            if (args[5]?.targetUri === f.uri) calls++;
            return f.generate(...args);
          };
          const status = yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(calls, JSON.stringify(status)).toBe(1);
          const review = yield* loadCandidateReview(f.home, f.reviewId);
          expect(review.maintenance?.version).toBe(3);
          expect(review.maintenance?.generation).toMatchObject({origin: 'model', attempts: 1});
          expect(review.candidates[0].proposedText).toBe('The timeout is 60 seconds.');
          expect(status.background.reserved).toBe(1);
          expect(status.active).toBeUndefined();
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          expect(yield* f.fs.readFileString(f.sourcePath)).toBe(f.source);
          const checkpoint = yield* readDraftQueueTarget(f.config, hash(f.uri));
          expect(checkpoint).toMatchObject({
            state: 'completed',
            materialRevision: review.maintenance!.basis.observationRevision,
          });
          yield* f.fs.remove(f.path.join(f.home, 'context-maintenance/automatic'), {recursive: true, force: true});
          yield* f.fs.remove(f.path.join(f.home, `threadnote/candidates/v1/reviews/${f.reviewId}.json`), {
            recursive: true,
            force: true,
          });
          yield* f.prepare;
          yield* runAutomaticMemoryBackground({...f.config}, {project: 'fixture'}, generate);
          expect(calls).toBe(1);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'keeps public reject/defer checkpoints through review and preparation loss while exact resume clears only defer',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const input = {
            uri: f.uri,
            expectedContentHash: hash(f.content),
            backend: 'local-ai' as const,
            modelId: f.modelId,
          };
          const draft = yield* requestAutomaticMemoryDraft(f.config, input, f.generate);
          const deferred = yield* f.server.invokeTool('context_maintenance_review', {
            action: 'defer',
            reviewId: draft.reviewId,
            revision: draft.revision,
          });
          expect(deferred.isError).not.toBe(true);
          expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.decision).toBe('defer');
          const deferredRevision = Number(object(deferred.structuredContent).revision);
          const resumed = yield* f.server.invokeTool('context_maintenance_review', {
            action: 'resume',
            reviewId: draft.reviewId,
            revision: deferredRevision,
          });
          expect(resumed.isError).not.toBe(true);
          expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.decision).toBeUndefined();
          const rejected = yield* f.server.invokeTool('context_maintenance_review', {
            action: 'reject',
            reviewId: draft.reviewId,
            revision: Number(object(resumed.structuredContent).revision),
          });
          expect(rejected.isError).not.toBe(true);
          const before = yield* readDraftQueueTarget(f.config, hash(f.uri));
          expect(before?.decision).toBe('reject');
          yield* f.fs.remove(f.path.join(f.home, 'context-maintenance/automatic'), {recursive: true, force: true});
          yield* f.fs.remove(f.path.join(f.home, `threadnote/candidates/v1/reviews/${f.reviewId}.json`), {
            recursive: true,
            force: true,
          });
          yield* setAutomaticDraftBackgroundPolicy(f.config, {action: 'background-pause'});
          yield* setAutomaticDraftBackgroundPolicy(f.config, {action: 'background-resume'});
          yield* f.prepare;
          let calls = 0;
          const generate: typeof runSelectedDraft = (...args) => {
            if (args[5]?.targetUri === f.uri) calls++;
            return f.generate(...args);
          };
          yield* runAutomaticMemoryBackground({...f.config}, {project: 'fixture'}, generate);
          expect(calls).toBe(0);
          expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.decision).toBe('reject');
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'releases assessment and review locks during a blocked provider and preserves a concurrent user decision',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* f.prepare;
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const generate: typeof runSelectedDraft = (...args) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return yield* f.generate(...args);
            });
          const worker = yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate).pipe(
            Effect.forkChild(),
          );
          yield* Deferred.await(started);
          expect((yield* readAutomaticDraftBackgroundStatus(f.config)).active?.targetUri).toBe(f.uri);
          const assessment = yield* runContextMaintenance(f.config, {cwd: f.home, project: 'fixture', maxRecords: 16});
          expect(assessment.paused).toBe(false);
          const manual = yield* f.server.invokeTool('context_maintenance_review', {
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: hash(f.content),
          });
          expect(manual.isError).not.toBe(true);
          const packet = manual.structuredContent as unknown as ReturnType<typeof automaticReviewPacket>;
          const proposal = yield* f.generate(
            f.config,
            'local-ai',
            {id: f.modelId, label: f.modelId, isDefault: true},
            JSON.stringify(packet),
            'topic-maintenance',
            packet.basis,
          );
          const preview = yield* f.server.invokeTool('context_maintenance_review', {
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: hash(f.content),
            draftJson: proposal.text,
          });
          expect(preview.isError).not.toBe(true);
          const rejected = yield* f.server.invokeTool('context_maintenance_review', {
            action: 'reject',
            reviewId: f.reviewId,
            revision: Number(object(preview.structuredContent).revision),
          });
          expect(rejected.isError).not.toBe(true);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(worker);
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
          expect((yield* loadCandidateReview(f.home, f.reviewId)).candidates[0].state).toBe('rejected');
          expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.decision).toBe('reject');
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'exposes existing MCP controls and leaves assessment and explicit drafting available under background-only pause',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const paused = yield* f.server.invokeTool('context_maintain', {action: 'background-pause'});
          expect(paused.isError).not.toBe(true);
          expect(object(paused.structuredContent).policy).toMatchObject({paused: true});
          yield* f.prepare;
          let calls = 0;
          const generate: typeof runSelectedDraft = (...args) => {
            if (args[5]?.targetUri === f.uri) calls++;
            return f.generate(...args);
          };
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(calls).toBe(0);
          expect((yield* readAutomaticDraftBackgroundStatus(f.config)).background.reserved).toBe(0);
          const draft = yield* requestAutomaticMemoryDraft(
            f.config,
            {uri: f.uri, expectedContentHash: hash(f.content), backend: 'local-ai', modelId: f.modelId},
            generate,
          );
          expect(draft.candidates[0].state).toBe('pending');
          expect(calls).toBe(1);
          expect((yield* readAutomaticDraftBackgroundStatus(f.config)).background.reserved).toBe(0);
          yield* setContextMaintenancePaused(f.config, true);
          yield* setAutomaticDraftBackgroundPolicy(f.config, {action: 'background-resume'});
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect((yield* readAutomaticDraftBackgroundStatus(f.config)).allMaintenancePaused).toBe(true);
          expect(calls).toBe(1);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect(
    'retries only a typed transient background failure once after five minutes with a new reservation',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* f.prepare;
          let calls = 0;
          const generate: typeof runSelectedDraft = (...args) => {
            if (args[5]?.targetUri !== f.uri) return f.generate(...args);
            calls++;
            return Effect.fail(
              AiError.AiError.make({module: 'synthetic', method: 'generate', reason: AiError.RateLimitError.make({})}),
            );
          };
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(calls).toBe(1);
          const next = (yield* Clock.currentTimeMillis) + 300_000;
          expect(yield* readDraftQueueTarget(f.config, hash(f.uri))).toMatchObject({
            state: 'waiting',
            retryCount: 1,
            nextEligibleAt: next,
          });
          expect((yield* readAutomaticDraftBackgroundStatus(f.config)).nextEligibleAt).toBe(next);
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(calls).toBe(1);
          yield* TestClock.adjust(299_999);
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(calls).toBe(1);
          yield* TestClock.adjust(1);
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(calls).toBe(2);
          expect(yield* readDraftQueueTarget(f.config, hash(f.uri))).toMatchObject({state: 'failed', retryCount: 1});
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(2);
          yield* TestClock.adjust(3_600_000);
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(calls).toBe(2);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'requires a finite endpoint-bound remote grant beyond environment credentials or manual provider selection',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const system = yield* SystemInfo;
        const environment = {
          ...system.environment(),
          THREADNOTE_EFFECT_AI: '1',
          THREADNOTE_EFFECT_AI_MODEL: 'synthetic-model',
          THREADNOTE_EFFECT_AI_API_URL: 'https://synthetic.invalid/v1',
          THREADNOTE_EFFECT_AI_API_KEY: 'synthetic-not-a-secret',
        };
        const configured = SystemInfo.of({...system, environment: () => environment});
        yield* Effect.gen(function* () {
          const initial = yield* readAutomaticDraftBackgroundStatus(f.config);
          expect(initial.policy.provider).toBe('local-ai');
          const manualSelection = yield* setAutomaticDraftBackgroundPolicy(f.config, {
            action: 'background-provider',
            backend: 'effect-ai',
          });
          expect(manualSelection.waitingReason).toBe('remote-provider-grant-required');
          expect(manualSelection.policy.remoteGrant).toBeUndefined();
          const denied = yield* f.server
            .invokeTool('context_maintain', {
              action: 'background-budget',
              backend: 'effect-ai',
              modelId: 'synthetic-model',
              unitsPerHour: 5,
            })
            .pipe(Effect.result);
          expect(Result.isFailure(denied)).toBe(true);
          const granted = yield* f.server.invokeTool('context_maintain', {
            action: 'background-budget',
            backend: 'effect-ai',
            modelId: 'synthetic-model',
            unitsPerHour: 2,
          });
          expect(granted.isError).not.toBe(true);
          expect(object(granted.structuredContent).policy).toMatchObject({
            provider: 'effect-ai',
            remoteGrant: {unitsPerHour: 2},
          });
          const fingerprint = (yield* readAutomaticDraftBackgroundStatus(f.config)).policy.remoteGrant!
            .providerIdentity;
          expect(JSON.stringify(granted.structuredContent)).not.toContain('synthetic-not-a-secret');
          expect(JSON.stringify(granted.structuredContent)).not.toContain('https://synthetic.invalid');
          const changed = SystemInfo.of({
            ...system,
            environment: () => ({...environment, THREADNOTE_EFFECT_AI_API_URL: 'https://other.invalid/v1'}),
          });
          const drift = yield* readAutomaticDraftBackgroundStatus(f.config).pipe(
            Effect.provideService(SystemInfo, changed),
          );
          expect(drift.waitingReason).toBe('remote-provider-grant-required');
          expect(drift.provider).not.toMatchObject({providerIdentity: fingerprint});
          const revoked = yield* setAutomaticDraftBackgroundPolicy(f.config, {
            action: 'background-budget',
            backend: 'effect-ai',
            unitsPerHour: 0,
          });
          expect(revoked.policy).toEqual({paused: false, provider: 'effect-ai'});
          const local = yield* setAutomaticDraftBackgroundPolicy(f.config, {
            action: 'background-provider',
            backend: 'local-ai',
          });
          expect(local.policy.remoteGrant).toBeUndefined();
        }).pipe(Effect.provideService(SystemInfo, configured), Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
  for (const denial of ['absent', 'revoked', 'endpoint-drift'] as const) {
    effectIt.effect(`public remote grant admits actual background work after ${denial} blocks an eligible target`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const system = yield* SystemInfo;
        const modelId = 'synthetic-model';
        let endpoint = 'https://synthetic.invalid/v1';
        const configured = SystemInfo.of({
          ...system,
          environment: () => ({
            ...system.environment(),
            THREADNOTE_EFFECT_AI: '1',
            THREADNOTE_EFFECT_AI_MODEL: modelId,
            THREADNOTE_EFFECT_AI_API_URL: endpoint,
            THREADNOTE_EFFECT_AI_API_KEY: 'synthetic-not-a-secret',
          }),
        });
        yield* Effect.gen(function* () {
          yield* f.prepare;
          const inspected = yield* f.server.invokeTool('context_maintenance_review', {
            action: 'automatic-preview',
            uri: f.uri,
            expectedContentHash: hash(f.content),
          });
          expect(inspected.isError).not.toBe(true);
          const packet = inspected.structuredContent as unknown as ReturnType<typeof automaticReviewPacket>;
          expect(packet.draftRequest.available).toBe(true);
          expect(packet.reviewEvidence).toHaveLength(1);
          expect(yield* readPreparedMemory(f.config, f.uri)).toBeDefined();
          const selected = yield* f.server.invokeTool('context_maintain', {
            action: 'background-provider',
            backend: 'effect-ai',
          });
          expect(selected.isError).not.toBe(true);
          const grant = () =>
            f.server.invokeTool('context_maintain', {
              action: 'background-budget',
              backend: 'effect-ai',
              modelId,
              unitsPerHour: 2,
            });
          if (denial !== 'absent') expect((yield* grant()).isError).not.toBe(true);
          if (denial === 'revoked') {
            const revoked = yield* f.server.invokeTool('context_maintain', {
              action: 'background-budget',
              backend: 'effect-ai',
              unitsPerHour: 0,
            });
            expect(revoked.isError).not.toBe(true);
          } else if (denial === 'endpoint-drift') endpoint = 'https://other.invalid/v1';
          const identity = yield* selectedTopicDraftIdentity(f.config, 'effect-ai', {
            id: modelId,
            label: modelId,
            isDefault: true,
          });
          const calls: {backend: string; modelId: string | undefined}[] = [];
          const generate: typeof runSelectedDraft = (...args) =>
            Effect.gen(function* () {
              calls.push({backend: args[1], modelId: args[2]?.id});
              expect(args[1]).toBe('effect-ai');
              expect(args[2]?.id).toBe(modelId);
              expect(args[5]?.targetUri).toBe(f.uri);
              const wire = yield* f.generate(...args);
              return {
                ...wire,
                backendIdentity: identity.backendIdentity,
                modelIdentity: identity.model,
                modelVersion: identity.modelVersion,
                settings: {maxOutputTokens: 4000 as const},
              };
            });
          const blocked = yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(blocked.waitingReason).toBe('remote-provider-grant-required');
          expect(blocked.policy.provider).toBe('effect-ai');
          expect(calls).toEqual([]);
          const unused = yield* readDraftQueueStatus(f.config);
          expect(unused.backgroundReservations).toEqual([]);
          expect(unused.active).toBeUndefined();
          expect(Result.isFailure(yield* loadCandidateReview(f.home, f.reviewId).pipe(Effect.result))).toBe(true);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          // The exact same eligible target succeeds after a public grant for the CURRENT endpoint.
          expect((yield* grant()).isError).not.toBe(true);
          const admitted = yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(calls).toEqual([{backend: 'effect-ai', modelId}]);
          expect(admitted.background.reserved).toBe(1);
          expect(admitted.active).toBeUndefined();
          const review = yield* loadCandidateReview(f.home, f.reviewId);
          expect(review.candidates[0].state).toBe('pending');
          expect(review.candidates[0].proposedText).toBe('The timeout is 60 seconds.');
          expect(review.maintenance?.generation).toMatchObject({
            origin: 'model',
            agent: 'effect-ai',
            model: modelId,
            attempts: 1,
          });
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
          expect(yield* f.fs.readFileString(f.sourcePath)).toBe(f.source);
          const privateRoot = f.path.join(f.home, 'threadnote/draft-queue/v1', hash(f.config.account));
          for (const name of ['queue.json', `target-${hash(f.uri)}.json`]) {
            const persisted = yield* f.fs.readFileString(f.path.join(privateRoot, name));
            expect(persisted).not.toContain('synthetic-not-a-secret');
            expect(persisted).not.toContain('https://synthetic.invalid');
            expect(persisted).not.toContain('https://other.invalid');
          }
        }).pipe(Effect.provideService(SystemInfo, configured), Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
    );
  }

  effectIt.effect(
    'ordinary CLI use with Manager closed wakes the production detached command and saves its original draft',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const system = yield* SystemInfo;
        const module = (relative: string) => JSON.stringify(f.path.resolve(relative));
        const harness = f.path.join(f.home, 'background-process.mjs');
        const completed = f.path.join(f.home, 'background-child-completed');
        // Only the provider boundary is stubbed. The ordinary CLI, durable wake,
        // detached OS spawn, assessment, admission, generation and review save are production code.
        yield* f.fs.writeFileString(
          harness,
          `
import {Effect} from ${module('node_modules/effect/dist/index.js')};
import {ApplicationLayer} from ${module('apps/threadnote/src/effect/runtime.ts')};
import {provideTestLayer} from ${module('apps/threadnote/test/helpers/effect-layer.ts')};
import {LocalModelStore} from ${module('packages/inference/src/models/store.ts')};
import {LocalModelCatalog} from ${module('packages/inference/src/models/catalog.ts')};
import {cliEffect} from ${module('apps/threadnote/src/threadnote.ts')};
import {runContextMaintainCommand} from ${module('apps/threadnote/src/memory/context/maintenance_commands.ts')};
import {localDraftGenerationSettings} from ${module('apps/threadnote/src/effect/ai/consolidator.ts')};
import {writeFile} from 'node:fs/promises';
const config = ${JSON.stringify(f.config)};
const args = process.argv.slice(2);
const child = args.includes('maintain');
const program = Effect.gen(function* () {
  const original = yield* LocalModelStore;
  const manifest = yield* (yield* LocalModelCatalog).get(${JSON.stringify(f.modelId)});
  const installed = LocalModelStore.of({...original, status: (_home, selected) => Effect.succeed({
    installed: true, bytes: selected.size, modelId: selected.id, partialBytes: 0, path: '/synthetic/model.gguf', verified: true,
  })});
  const generate = (_config, _backend, _model, prompt) => Effect.sync(() => {
    const packet = JSON.parse(prompt.split('\\n').at(-1));
    const handle = packet.reviewEvidence.find(entry => entry.descriptor.source.kind === 'memory');
    return {backendIdentity: 'local-ai', modelIdentity: manifest.id,
      modelVersion: manifest.revision + ':' + manifest.sha256, usage: {status: 'unavailable'},
      settings: localDraftGenerationSettings(manifest.id, 'topic-maintenance'),
      text: JSON.stringify({version: 2, kind: 'automatic', purpose: 'automatic',
        targetHash: packet.basis.targetHash, observationRevision: packet.basis.observationRevision,
        packetDigest: packet.basis.packetDigest, outcome: handle ? 'propose-update' : 'insufficient-evidence',
        operations: handle ? [{ordinal: 0, beforeHash: packet.basis.paragraphs[0].hash, text: handle.content,
          supportHandles: [handle.handleId], rationale: 'Use the exact current related paragraph.'}] : [],
        reviewedHandles: packet.reviewEvidence.map(entry => entry.handleId), rationale: 'Bounded synthetic provider.',
        unresolvedQuestions: [], removedClaims: [], paragraphDecisions: [{ordinal: 0,
          beforeHash: packet.basis.paragraphs[0].hash, role: handle ? 'descriptive' : 'unknown',
          support: handle ? 'direct' : 'unresolved', evidenceIds: handle ? [handle.descriptor.id] : []}],
      }),
    };
  });
  yield* (child ? runContextMaintainCommand(config, {sourceCwd: config.agentContextHome, maxRecords: 16, json: true}, generate)
    : cliEffect(args)).pipe(Effect.provideService(LocalModelStore, installed));
});
try {
  await Effect.runPromise(program.pipe(provideTestLayer(ApplicationLayer)));
  if (child) await writeFile(${JSON.stringify(completed)}, 'completed');
} catch (error) {
  if (child) await writeFile(${JSON.stringify(completed)}, String(error));
  throw error;
}
`,
        );
        const result = yield* runCommandEffect(
          system.executablePath,
          [
            harness,
            '--home',
            f.home,
            '--manifest',
            f.config.manifestPath,
            'context',
            'brief',
            '--cwd',
            f.home,
            '--task',
            'Find current timeout guidance',
            '--project',
            'fixture',
            '--json',
          ],
          {
            allowFailure: true,
            timeoutMs: 15_000,
            env: {
              ...system.environment(),
              THREADNOTE_HOME: f.home,
              THREADNOTE_ACCOUNT: f.config.account,
              THREADNOTE_USER: f.config.user,
              THREADNOTE_AGENT_ID: f.config.agentId,
              THREADNOTE_MODEL_SETUP: 'off',
              THREADNOTE_TELEMETRY: 'off',
            },
          },
        );
        expect(result.exitCode, result.stdout + result.stderr).toBe(0);
        const deadline = (yield* Clock.currentTimeMillis) + 15_000;
        while (!(yield* f.fs.exists(completed)) && (yield* Clock.currentTimeMillis) < deadline) yield* Effect.sleep(50);
        expect(yield* f.fs.exists(completed)).toBe(true);
        expect(yield* f.fs.readFileString(completed)).toBe('completed');
        const review = yield* loadCandidateReview(f.home, f.reviewId);
        expect(review.maintenance?.generation).toMatchObject({origin: 'model', attempts: 1});
        expect(review.candidates[0].state).toBe('pending');
        expect(review.candidates[0].proposedText).toBe('The timeout is 60 seconds.');
        expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
        expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect(
    'persists a public V3 decision before a failed review save and reconciles its exact replay once',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const draft = yield* requestAutomaticMemoryDraft(
            f.config,
            {uri: f.uri, expectedContentHash: hash(f.content), backend: 'local-ai', modelId: f.modelId},
            f.generate,
          );
          const input = {action: 'reject', reviewId: draft.reviewId, revision: draft.revision};
          let injected = false;
          const faulty = FileSystem.FileSystem.of({
            ...f.fs,
            rename: (from, to) =>
              Effect.gen(function* () {
                if (!injected && to.endsWith(`${draft.reviewId}.json`)) {
                  injected = true;
                  return yield* f.fs.rename(`${from}.missing`, to);
                }
                return yield* f.fs.rename(from, to);
              }),
          });
          const failed = yield* f.server
            .invokeTool('context_maintenance_review', input)
            .pipe(Effect.provideService(FileSystem.FileSystem, faulty));
          expect(injected).toBe(true);
          expect(failed.isError).toBe(true);
          expect((yield* loadCandidateReview(f.home, draft.reviewId)).candidates[0].state).toBe('pending');
          expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.decision).toBe('reject');
          for (let replay = 0; replay < 2; replay++) {
            const recovered = yield* f.server.invokeTool('context_maintenance_review', input);
            expect(recovered.isError).not.toBe(true);
            expect(object(recovered.structuredContent).state).toBe('rejected');
          }
          const current = yield* loadCandidateReview(f.home, draft.reviewId);
          expect(current.auditEvents.filter(event => event.action === 'reject')).toHaveLength(1);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect(
    'leaves an uncited note without current evidence assessed and waiting without model dispatch or enrollment',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          // Two production turns prepare the target and its independent uncited source note.
          yield* f.prepare;
          yield* f.prepare;
          let calls = 0;
          const generate: typeof runSelectedDraft = (...args) => {
            calls++;
            return f.generate(...args);
          };
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate);
          expect(calls).toBe(1);
          const read = yield* f.server.invokeTool('context_maintenance_review', {
            action: 'automatic-preview',
            uri: f.sourceUri,
            expectedContentHash: hash(f.source),
          });
          expect(read.isError).not.toBe(true);
          const packet = read.structuredContent as unknown as ReturnType<typeof automaticReviewPacket>;
          expect(packet.reviewEvidence).toEqual([]);
          expect(packet.draftRequest.available).toBe(false);
          expect((yield* readDraftQueueStatus(f.config)).backgroundReservations).toHaveLength(1);
          expect(yield* f.fs.readFileString(f.sourcePath)).toBe(f.source);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('fences all-maintenance pause and the existing 120-second unit deadline during model work', () =>
    Effect.gen(function* () {
      for (const pause of [true, false]) {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* f.prepare;
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const generate: typeof runSelectedDraft = (...args) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return yield* f.generate(...args);
            });
          const worker = yield* runAutomaticMemoryBackground(f.config, {project: 'fixture'}, generate).pipe(
            Effect.forkChild(),
          );
          yield* Deferred.await(started);
          if (pause) {
            yield* setContextMaintenancePaused(f.config, true);
            yield* Deferred.succeed(release, undefined);
          } else yield* TestClock.adjust(120_000);
          yield* Fiber.join(worker);
          const queue = yield* readDraftQueueStatus(f.config);
          expect(queue.active).toBeUndefined();
          expect(queue.backgroundReservations).toHaveLength(1);
          expect((yield* readDraftQueueTarget(f.config, hash(f.uri)))?.state).toBe('failed');
          expect(Result.isFailure(yield* loadCandidateReview(f.home, f.reviewId).pipe(Effect.result))).toBe(true);
          expect(yield* f.fs.readFileString(f.targetPath)).toBe(f.content);
        }).pipe(Effect.provideService(LocalModelStore, f.installed));
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
