import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import {OpenAiClient, OpenAiLanguageModel} from '@effect/ai-openai-compat';
import {Context, Effect, Layer, Redacted, Schema} from 'effect';
import {LanguageModel} from 'effect/ai';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {generateWithSelectedLocalModel} from '@threadnote/inference/models/inference';

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

export class AiConsolidationFailed extends Schema.TaggedError<AiConsolidationFailed>()('AiConsolidationFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

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
  if (!['1', 'true', 'yes'].includes(env[EFFECT_AI_ENABLED_ENV]?.trim().toLowerCase() ?? '')) {
    return undefined;
  }
  const model = env[EFFECT_AI_MODEL_ENV]?.trim();
  if (!model) {
    return undefined;
  }
  const apiKey = env[EFFECT_AI_API_KEY_ENV]?.trim();
  const apiUrl = env[EFFECT_AI_API_URL_ENV]?.trim();
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

export function aiConsolidatorLayer(config: EffectAiConfiguration): Layer.Layer<AiConsolidator> {
  const languageModelLayer = effectAiLanguageModelLayer(config, 4000);

  return Layer.effect(
    AiConsolidator,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      return AiConsolidator.of({
        consolidate: prompt =>
          model
            .generateObject({
              objectName: 'threadnote_consolidation',
              prompt,
              schema: ConsolidationDraft,
            })
            .pipe(
              Effect.map(response => response.value.draft.trim()),
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

export function runEffectAiConsolidation(prompt: string, config: EffectAiConfiguration) {
  return Effect.scoped(
    Layer.build(aiConsolidatorLayer(config)).pipe(
      Effect.flatMap(context => consolidateWithAiEffect(prompt).pipe(Effect.provide(context))),
    ),
  );
}

export const runNativeAiConsolidation = Effect.fn('AiConsolidator.consolidateNative')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  prompt: string,
) {
  const output = yield* generateWithSelectedLocalModel(config.agentContextHome, {
    jsonSchema: Schema.toJsonSchemaDocument(ConsolidationDraft).schema,
    maxTokens: 4000,
    prompt,
    seed: 0,
    system: 'Return only the requested Threadnote consolidation object.',
  });
  if (output === undefined) return undefined;
  const draft = yield* Schema.decodeUnknownEffect(ConsolidationDraft)(output).pipe(
    Effect.mapError(cause =>
      AiConsolidationFailed.make({
        cause,
        message: 'Native AI returned an invalid consolidation draft.',
      }),
    ),
  );
  const value = draft.draft.trim();
  if (!value) {
    return yield* AiConsolidationFailed.make({
      cause: output,
      message: 'Native AI returned an empty consolidation draft.',
    });
  }
  return value;
});
