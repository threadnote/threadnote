import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path, Result, Schema, Stream} from 'effect';
import {AiError, LanguageModel, Response} from 'effect/ai';
import {OpenAiLanguageModel} from '@effect/ai-openai-compat';
import {beforeEach, describe, expect, vi} from 'vitest';
import {TestError} from '@threadnote/testing/test-error';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime, type LocalGenerationRequest} from '@threadnote/inference/engine/local-model-runtime';
import {
  parseTopicMaintenanceDraft,
  type TopicMaintenanceDraftBasisV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {loadTopicGenerationReceipt} from '@threadnote/memory/candidate-generation';
import {
  TopicGenerationRequestError,
  withTopicGenerationObservation,
} from '../../src/memory/context/maintenance_generation.js';
import {
  runEffectAiTopicDraft,
  runNativeAiTopicDraft,
  TopicDraftProviderOutputError,
} from '../../src/effect/ai/consolidator.js';
import {topicDraftModelSchema} from '../../src/manager/topic_draft_schema.js';
import {makeTopicDraftWireBasis, makeTopicDraftWireFixture} from '../helpers/topic-draft-wire.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

vi.mock('@effect/ai-openai-compat', async importOriginal => {
  const actual = await importOriginal<typeof import('@effect/ai-openai-compat')>();
  return {...actual, OpenAiLanguageModel: {...actual.OpenAiLanguageModel, layer: vi.fn()}};
});

const manifest = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'generation')!;
const unexpected = () => Effect.die(TestError.make({message: 'Unexpected fixture service call'}));
function nativeLayer(output: unknown, capture: (request: LocalGenerationRequest) => void = () => {}) {
  return Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    LocalModelCatalog.layer([manifest]),
    Layer.succeed(LocalModelStore, {
      install: unexpected,
      path: () => '/fixture/model.gguf',
      remove: unexpected,
      verify: unexpected,
      status: () =>
        Effect.succeed({
          bytes: 1,
          installed: true,
          modelId: manifest.id,
          partialBytes: 0,
          path: '/fixture/model.gguf',
          verified: true,
        }),
    }),
    Layer.succeed(LocalModelRuntime, {
      diagnostics: unexpected(),
      embedMany: unexpected,
      rerank: unexpected,
      generate: request =>
        Effect.sync(() => {
          capture(request);
          return output;
        }),
    }),
  );
}

function provideNativeOutput(output: unknown, capture?: (request: LocalGenerationRequest) => void) {
  return <A, E, R>(program: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Layer.build(nativeLayer(output, capture)).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))),
    );
}

function observationIdentity(basis: TopicMaintenanceDraftBasisV1) {
  return {
    caseId: 'health-case-' + 'a'.repeat(40),
    reviewId: 'review-' + 'b'.repeat(24),
    targetHash: basis.targetHash,
    observationRevision: basis.observationRevision,
    packetDigest: basis.packetDigest,
    agent: 'effect-ai' as const,
    model: 'fixture',
    promptVersion: 'topic-maintenance-draft-v6',
  };
}

describe('compact topic provider boundary', () => {
  beforeEach(() => vi.mocked(OpenAiLanguageModel.layer).mockReset());
  effectIt.layer(Layer.merge(BunServices.layer, TestSystemInfoLayer))(it => {
    for (const responseText of ['{"private":"invalid-é🙂"', '{"private":"wrong-schema-é🙂"}']) {
      it.effect('retains failed Effect structured output privately: ' + responseText, () =>
        Effect.gen(function* () {
          const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
          const basis = makeTopicDraftWireBasis(1);
          const model = Layer.effect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () => Effect.succeed([Response.makePart('text', {text: responseText})]),
              streamText: () => Stream.empty,
            }),
          );
          vi.mocked(OpenAiLanguageModel.layer).mockReturnValueOnce(model);
          const failure = yield* withTopicGenerationObservation(home, observationIdentity(basis), observation =>
            observation.dispatch(
              'prompt',
              runEffectAiTopicDraft('prompt', {model: 'fixture'}, topicDraftModelSchema(basis), basis),
            ),
          ).pipe(Effect.flip);
          if (!Schema.is(TopicGenerationRequestError)(failure)) throw new Error('Expected safe generation error');
          const receipt = yield* loadTopicGenerationReceipt(home, failure.diagnostics!.receiptId);
          expect(receipt.attempts[0]).toMatchObject({
            status: 'provider-output-invalid',
            usage: {status: 'unavailable'},
            output: {status: 'observed', representation: 'provider-text'},
          });
          expect(receipt.firstFailedOutput).toMatchObject({representation: 'provider-text', text: responseText});
          expect(receipt.firstFailedOutput?.bytes).toBe(new TextEncoder().encode(responseText).byteLength);
          expect(JSON.stringify(failure)).not.toContain(responseText);
          expect(JSON.stringify(failure.diagnostics)).not.toContain('private');
        }),
      );
    }
    it.effect('preserves only available structured-failure usage and excludes provider metadata', () =>
      Effect.gen(function* () {
        const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const basis = makeTopicDraftWireBasis(1);
        const error = AiError.AiError.make({
          module: 'LanguageModel',
          method: 'generateObject',
          reason: AiError.StructuredOutputError.make({
            description: 'private validation details',
            responseText: 'private invalid response',
            usage: {promptTokens: 12, completionTokens: 3},
            metadata: {privateEndpoint: 'private credentials'},
          }),
        });
        const model = Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.fail(error),
            streamText: () => Stream.empty,
          }),
        );
        vi.mocked(OpenAiLanguageModel.layer).mockReturnValueOnce(model);
        const failure = yield* withTopicGenerationObservation(home, observationIdentity(basis), observation =>
          observation.dispatch(
            'prompt',
            runEffectAiTopicDraft('prompt', {model: 'fixture'}, topicDraftModelSchema(basis), basis),
          ),
        ).pipe(Effect.flip);
        if (!Schema.is(TopicGenerationRequestError)(failure)) throw new Error('Expected safe generation error');
        const receipt = yield* loadTopicGenerationReceipt(home, failure.diagnostics!.receiptId);
        expect(receipt.attempts[0].usage).toEqual({status: 'measured', inputTokens: 12, outputTokens: 3});
        expect(receipt.firstFailedOutput?.text).toBe('private invalid response');
        expect(JSON.stringify(receipt)).not.toContain('private credentials');
        expect(JSON.stringify(receipt)).not.toContain('private validation details');
        expect(JSON.stringify(failure)).not.toContain('private invalid response');
      }),
    );
  });
  effectIt.effect('hydrates native decoded objects with explicit basis and unchanged generation settings', () =>
    Effect.gen(function* () {
      const basis = makeTopicDraftWireBasis(64, {sourceCount: 8});
      const wire = makeTopicDraftWireFixture(basis);
      let request: LocalGenerationRequest | undefined;
      const result = yield* runNativeAiTopicDraft(
        {agentContextHome: '/fixture'},
        'exact prompt',
        manifest.id,
        topicDraftModelSchema(basis),
        basis,
      ).pipe(
        provideNativeOutput(wire, value => {
          request = value;
        }),
      );
      const canonical = parseTopicMaintenanceDraft(basis, result.text, {requireParagraphDispositions: true});
      expect(canonical.draft.paragraphDispositions?.entries).toHaveLength(64);
      expect(JSON.parse(result.text).paragraphDispositions.entries[0]).toEqual({
        ordinal: 0,
        beforeHash: basis.paragraphs[0].hash,
        disposition: 'revalidate',
        supportHandles: [basis.handles[1].id],
        rationale: 'Checked.',
      });
      expect(request).toMatchObject({prompt: 'exact prompt', maxTokens: 4000, seed: 0});
      expect(result.usage).toEqual({status: 'unavailable'});
      expect(result.outputRepresentation).toBe('decoded-json');
      expect(result.text).not.toContain('sourceIndices');
    }),
  );

  effectIt.effect(
    'retains malformed native decoded wire as normalized JSON, and leaves semantic failures repairable',
    () =>
      Effect.gen(function* () {
        const basis = makeTopicDraftWireBasis(2);
        const wire = makeTopicDraftWireFixture(basis);
        wire.decision.paragraphDispositions.entries[0].sourceIndices = [99];
        const invalid = yield* runNativeAiTopicDraft(
          {agentContextHome: '/fixture'},
          'prompt',
          manifest.id,
          topicDraftModelSchema(basis),
          basis,
        ).pipe(provideNativeOutput(wire), Effect.result);
        expect(Result.isFailure(invalid)).toBe(true);
        if (Result.isFailure(invalid)) {
          expect(invalid.failure).toBeInstanceOf(TopicDraftProviderOutputError);
          if (Schema.is(TopicDraftProviderOutputError)(invalid.failure)) {
            expect(invalid.failure.output.text).toBe(JSON.stringify(wire));
            expect(invalid.failure.output.representation).toBe('decoded-json');
          }
        }
        wire.decision.paragraphDispositions.entries[0].sourceIndices = [0];
        wire.decision.paragraphDispositions.entries[1].ordinal = 0;
        const semanticInvalid = yield* runNativeAiTopicDraft(
          {agentContextHome: '/fixture'},
          'prompt',
          manifest.id,
          topicDraftModelSchema(basis),
          basis,
        ).pipe(provideNativeOutput(wire));
        expect(() =>
          parseTopicMaintenanceDraft(basis, semanticInvalid.text, {requireParagraphDispositions: true}),
        ).toThrow();
      }),
  );

  effectIt.effect('hydrates Effect objects through the same explicit basis and preserves measured usage', () =>
    Effect.gen(function* () {
      const basis = makeTopicDraftWireBasis(64, {sourceCount: 8});
      const wire = makeTopicDraftWireFixture(basis);
      const model = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () =>
            Effect.succeed([
              Response.makePart('text', {text: JSON.stringify(wire)}),
              Response.makePart('finish', {
                reason: 'stop',
                usage: Response.Usage.make({
                  inputTokens: {total: 12, uncached: undefined, cacheRead: undefined, cacheWrite: undefined},
                  outputTokens: {total: 3, text: undefined, reasoning: undefined},
                }),
              }),
            ]),
          streamText: () => Stream.empty,
        }),
      );
      const spy = vi.mocked(OpenAiLanguageModel.layer).mockReturnValueOnce(model);
      const result = yield* runEffectAiTopicDraft('prompt', {model: 'fixture'}, topicDraftModelSchema(basis), basis);
      expect(
        parseTopicMaintenanceDraft(basis, result.text, {requireParagraphDispositions: true}).draft.paragraphDispositions
          ?.entries,
      ).toHaveLength(64);
      expect(result.usage).toEqual({status: 'measured', inputTokens: 12, outputTokens: 3});
      expect(result.outputRepresentation).toBe('decoded-json');
      expect(result.text).not.toContain('sourceIndices');
      expect(spy).toHaveBeenCalledWith({config: {max_output_tokens: 4000, strictJsonSchema: true}, model: 'fixture'});
    }),
  );
});
