import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray} from 'effect';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import {OpenAiClient, OpenAiLanguageModel} from '@effect/ai-openai-compat';
import {Context, Effect, Layer, Redacted, Schema} from 'effect';
import {AiError, LanguageModel} from 'effect/ai';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {generateWithSelectedLocalModel} from '@threadnote/inference/models/inference';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import type {GenerationSampling} from '@threadnote/inference/engine/llama-cpp-engine';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {
  MAX_TOPIC_MAINTENANCE_DRAFT_BYTES,
  RetainedTopicGenerationOutput,
  TopicGenerationUsage,
  retainedTopicGenerationOutput,
  type TopicGenerationUsageV1,
  type TopicMaintenanceDraftBasis,
} from '@threadnote/memory/topic-maintenance-draft';
import {
  decodeTopicDraftProviderWire,
  topicDraftModelSchema,
  topicDraftNativeJsonSchema,
} from '../../manager/topic_draft_schema.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface DraftGenerationSettings {
  readonly maxOutputTokens: 4000;
  readonly seed?: 0;
  readonly sampling?: GenerationSampling & {readonly profileId: string};
}

const topicGemmaSampling = Object.freeze({
  profileId: 'gemma4-e4b-v1',
  temperature: 1,
  topP: 0.95,
  topK: 64,
});

export function localDraftGenerationSettings(
  modelId: string,
  purpose: 'consolidation' | 'topic-maintenance',
): DraftGenerationSettings {
  return {
    maxOutputTokens: 4000,
    seed: 0,
    ...(purpose === 'topic-maintenance' && modelId === CORE_GENERATION_MODEL_ID ? {sampling: topicGemmaSampling} : {}),
  };
}

export function serializeDraftGenerationSettings(settings: DraftGenerationSettings): string {
  return EffectArray.join(
    [
      ...(settings.seed === undefined ? [] : [`seed=${settings.seed}`]),
      `maxTokens=${settings.maxOutputTokens}`,
      ...(settings.sampling
        ? [
            `profile=${settings.sampling.profileId}`,
            `temperature=${settings.sampling.temperature}`,
            `topP=${settings.sampling.topP}`,
            `topK=${settings.sampling.topK}`,
          ]
        : []),
    ],
    ';',
  );
}

export const EFFECT_AI_ENABLED_ENV = 'THREADNOTE_EFFECT_AI';
export const EFFECT_AI_API_KEY_ENV = 'THREADNOTE_EFFECT_AI_API_KEY';
export const EFFECT_AI_API_URL_ENV = 'THREADNOTE_EFFECT_AI_API_URL';
export const EFFECT_AI_MODEL_ENV = 'THREADNOTE_EFFECT_AI_MODEL';

export interface EffectAiConfiguration {
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly model: string;
}

export interface ResolvedEffectAiConfiguration {
  readonly configuration: EffectAiConfiguration;
}

export class AiConsolidationFailed extends Schema.TaggedError<AiConsolidationFailed, {readonly brand: unique symbol}>()(
  'AiConsolidationFailed',
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Only final preflights that prove no provider/runtime call can return this outcome. */
export class DraftProviderUnavailableBeforeDispatch extends Schema.TaggedError<
  DraftProviderUnavailableBeforeDispatch,
  {readonly brand: unique symbol}
>()('DraftProviderUnavailableBeforeDispatch', {
  backend: Schema.Literals(['local-ai', 'effect-ai']),
  modelId: Schema.String,
  message: Schema.String,
}) {}

export class TopicDraftProviderOutputError extends Schema.TaggedError<
  TopicDraftProviderOutputError,
  {readonly brand: unique symbol}
>()('TopicDraftProviderOutputError', {
  message: Schema.String,
  output: RetainedTopicGenerationOutput,
  usage: Schema.optionalKey(TopicGenerationUsage),
}) {}

function decodeTopicDraftProviderOutput(
  basis: TopicMaintenanceDraftBasis,
  output: unknown,
  usage: TopicGenerationUsageV1 = {status: 'unavailable'},
) {
  let text: string | undefined;
  try {
    const decoded = decodeTopicDraftProviderWire(basis, output);
    text = JSON.stringify(basis.version === 3 ? output : decoded);
    if (new TextEncoder().encode(text).byteLength > MAX_TOPIC_MAINTENANCE_DRAFT_BYTES)
      throw new Error('Topic wire exceeds the output boundary.');
    return text;
  } catch {
    throw TopicDraftProviderOutputError.make({
      message: 'AI returned a malformed topic maintenance object.',
      output: retainedTopicGenerationOutput(1, text ?? JSON.stringify(output), 'decoded-json'),
      usage,
    });
  }
}

export function topicDraftProviderUsage(inputTokens: unknown, outputTokens: unknown): TopicGenerationUsageV1 {
  return checkedIsSafeInteger(inputTokens) &&
    inputTokens >= 0 &&
    checkedIsSafeInteger(outputTokens) &&
    outputTokens >= 0
    ? {status: 'measured', inputTokens: inputTokens, outputTokens: outputTokens}
    : {status: 'unavailable'};
}

const ConsolidationDraft = Schema.Struct({draft: Schema.String});

export class AiConsolidator extends Context.Service<
  AiConsolidator,
  {
    readonly consolidate: (prompt: string) => Effect.Effect<string, AiConsolidationFailed>;
  }
>()('@threadnote/threadnote/effect/ai/consolidator/AiConsolidator') {}

export const consolidateWithAiEffect = Effect.fn('AiConsolidator.consolidate')(function* (prompt: string) {
  const consolidator = yield* AiConsolidator;
  return yield* consolidator.consolidate(prompt);
});

export function effectAiConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): EffectAiConfiguration | undefined {
  if (
    !['1', 'true', 'yes'].includes(
      Effect2.pipe(
        env[EFFECT_AI_ENABLED_ENV],
        effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
      ) ?? '',
    )
  ) {
    return undefined;
  }
  const model = Effect2.pipe(env[EFFECT_AI_MODEL_ENV], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (!model) {
    return undefined;
  }
  const apiKey = Effect2.pipe(env[EFFECT_AI_API_KEY_ENV], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  const apiUrl = Effect2.pipe(env[EFFECT_AI_API_URL_ENV], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  return {
    apiKey: apiKey || undefined,
    apiUrl: apiUrl || undefined,
    model,
  };
}

export const resolveEffectAiConfiguration = Effect.fn('EffectAi.resolveConfiguration')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  env: Readonly<Record<string, string | undefined>>,
) {
  yield* Effect.void;
  void config;
  const explicit = effectAiConfiguration(env);
  if (explicit) return {configuration: explicit} satisfies ResolvedEffectAiConfiguration;
  return undefined;
});

export const ensureEffectAiReady = Effect.fn('EffectAi.ensureReady')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  resolved: ResolvedEffectAiConfiguration,
) {
  yield* Effect.void;
  void config;
  void resolved;
});

export function aiConsolidatorLayer(
  config: EffectAiConfiguration,
  objectName = 'threadnote_consolidation',
): Layer.Layer<AiConsolidator> {
  const languageModelLayer = effectAiLanguageModelLayer(config, 4000);

  return Layer.effect(
    AiConsolidator,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      return AiConsolidator.of({
        consolidate: prompt =>
          model
            .generateObject({
              objectName,
              prompt,
              schema: ConsolidationDraft,
            })
            .pipe(
              Effect.map(response => Effect2.pipe(response.value.draft, EffectString.trim)),
              Effect.filterOrFail(
                draft => draft.length > 0,
                () =>
                  AiConsolidationFailed.make({
                    cause: new Error('The model returned an empty consolidation draft.'),
                    message: 'Effect AI returned an empty consolidation draft.',
                  }),
              ),
              Effect.mapError(cause =>
                Schema.is(AiConsolidationFailed)(cause)
                  ? cause
                  : AiConsolidationFailed.make({cause, message: 'Effect AI consolidation failed.'}),
              ),
            ),
      });
    }),
  ).pipe(Layer.provide(languageModelLayer));
}

export function effectAiLanguageModelLayer(
  config: EffectAiConfiguration,
  maxOutputTokens: number,
  generationConfig: {readonly seed?: number; readonly temperature?: number} = {},
) {
  const clientLayer = OpenAiClient.layer({
    apiKey: config.apiKey ? Redacted.make(config.apiKey) : undefined,
    apiUrl: config.apiUrl,
  }).pipe(Layer.provide(BunHttpClient.layer));
  return OpenAiLanguageModel.layer({
    config: {max_output_tokens: maxOutputTokens, strictJsonSchema: true, ...generationConfig},
    model: config.model,
  }).pipe(Layer.provide(clientLayer));
}

export function runEffectAiConsolidation(prompt: string, config: EffectAiConfiguration, objectName?: string) {
  return Effect.scoped(
    Layer.build(aiConsolidatorLayer(config, objectName)).pipe(
      Effect.flatMap(context => consolidateWithAiEffect(prompt).pipe(Effect.provide(context))),
    ),
  );
}

export function runEffectAiTopicDraft(
  prompt: string,
  config: EffectAiConfiguration,
  schema: ReturnType<typeof topicDraftModelSchema>,
  basis: TopicMaintenanceDraftBasis,
) {
  return Effect.scoped(
    Layer.build(effectAiLanguageModelLayer(config, 4000)).pipe(
      Effect.flatMap(context =>
        Effect.gen(function* () {
          const model = yield* LanguageModel.LanguageModel;
          const response = yield* model
            .generateObject({objectName: 'threadnote_topic_maintenance', prompt, schema})
            .pipe(
              Effect.mapError(error =>
                AiError.isAiError(error) && Schema.is(AiError.StructuredOutputError)(error.reason)
                  ? TopicDraftProviderOutputError.make({
                      message: 'AI returned malformed topic maintenance output.',
                      output: retainedTopicGenerationOutput(1, error.reason.responseText, 'provider-text'),
                      usage: topicDraftProviderUsage(
                        error.reason.usage?.promptTokens,
                        error.reason.usage?.completionTokens,
                      ),
                    })
                  : error,
              ),
            );
          const usage = topicDraftProviderUsage(response.usage.inputTokens.total, response.usage.outputTokens.total);
          const text = yield* Effect.try({
            // generateObject may strip excess keys while decoding response.value. Validate
            // the original returned JSON so the automatic provider boundary stays closed.
            try: () =>
              decodeTopicDraftProviderOutput(
                basis,
                basis.version === 3 ? JSON.parse(response.text) : response.value,
                usage,
              ),
            catch: error =>
              Schema.is(TopicDraftProviderOutputError)(error)
                ? error
                : AiConsolidationFailed.make({
                    cause: error,
                    message: 'Could not decode topic maintenance provider output.',
                  }),
          });
          return {
            text,
            usage,
            outputRepresentation: 'decoded-json' as const,
          };
        }).pipe(Effect.provide(context)),
      ),
    ),
  );
}

const runNativeAiObject = Effect.fn('AiConsolidator.generateNativeObject')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  prompt: string,
  modelId: string | undefined,
  system: string,
  jsonSchema: Readonly<Record<string, unknown>>,
  settings: DraftGenerationSettings,
) {
  const request = {
    jsonSchema,
    maxTokens: settings.maxOutputTokens,
    prompt,
    seed: settings.seed,
    ...(settings.sampling ? {sampling: settings.sampling} : {}),
    system,
  };
  const output = yield* modelId === undefined
    ? generateWithSelectedLocalModel(config.agentContextHome, request)
    : Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        const manifest = yield* catalog.get(modelId);
        const store = yield* LocalModelStore;
        const status = yield* store.status(config.agentContextHome, manifest);
        if (manifest.role !== 'generation') {
          return yield* AiConsolidationFailed.make({
            cause: modelId,
            message: 'Select a generation-role model.',
          });
        }
        if (!status.installed)
          return yield* DraftProviderUnavailableBeforeDispatch.make({
            backend: 'local-ai',
            modelId,
            message:
              'This generation model is no longer installed. Install one with `threadnote models` and reload model choices.',
          });
        const runtime = yield* LocalModelRuntime;
        return yield* runtime.generate({...request, manifest, modelPath: status.path});
      });
  return output;
});

export const runNativeAiConsolidation = Effect.fn('AiConsolidator.consolidateNative')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  prompt: string,
  modelId?: string,
  system = 'Return only the requested Threadnote consolidation object.',
) {
  const output = yield* runNativeAiObject(
    config,
    prompt,
    modelId,
    system,
    Schema.toJsonSchemaDocument(ConsolidationDraft).schema,
    localDraftGenerationSettings(modelId ?? '', 'consolidation'),
  );
  if (output === undefined) return undefined;
  const draft = yield* Schema.decodeUnknownEffect(ConsolidationDraft)(output).pipe(
    Effect.mapError(cause =>
      AiConsolidationFailed.make({
        cause,
        message: 'Native AI returned an invalid consolidation draft.',
      }),
    ),
  );
  const value = Effect2.pipe(draft.draft, EffectString.trim);
  if (!value) {
    return yield* AiConsolidationFailed.make({
      cause: output,
      message: 'Native AI returned an empty consolidation draft.',
    });
  }
  return value;
});

export const runNativeAiTopicDraft = Effect.fn('AiConsolidator.generateNativeTopicDraft')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  prompt: string,
  modelId: string,
  schema: ReturnType<typeof topicDraftModelSchema>,
  basis: TopicMaintenanceDraftBasis,
) {
  const output = yield* runNativeAiObject(
    config,
    prompt,
    modelId,
    'Return one complete topic maintenance JSON object matching the supplied schema.',
    topicDraftNativeJsonSchema(schema, basis),
    localDraftGenerationSettings(modelId, 'topic-maintenance'),
  );
  if (output === undefined)
    return yield* AiConsolidationFailed.make({
      cause: modelId,
      message: 'No local topic generation model is installed.',
    });
  const text = yield* Effect.try({
    try: () => decodeTopicDraftProviderOutput(basis, output),
    catch: error =>
      Schema.is(TopicDraftProviderOutputError)(error)
        ? error
        : AiConsolidationFailed.make({cause: error, message: 'Could not decode topic maintenance provider output.'}),
  });
  return {
    text,
    usage: {status: 'unavailable' as const},
    outputRepresentation: 'decoded-json' as const,
  };
});
