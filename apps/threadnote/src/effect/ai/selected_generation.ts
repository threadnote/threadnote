import {Effect, Schema} from 'effect';
import {AiError} from 'effect/ai';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {SystemInfo} from '@threadnote/platform/system';
import {errorMessage} from '@threadnote/platform/errors';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  retainedTopicGenerationOutput,
  type TopicGenerationUsageV1,
  type TopicMaintenanceDraftBasis,
} from '@threadnote/memory/topic-maintenance-draft';
import {findExecutable} from '../../utils.js';
import type {ConsolidationAgent} from '../../types.js';
import type {ConsolidationModel} from '../../manager/consolidation_models.js';
import {ConsolidationModelsError} from '../../manager/consolidation_models.js';
import {ManagerOperationError} from '../../manager/operation_error.js';
import {runConsolidationAgentCommand} from '../../manager/consolidation_agent.js';
import {
  ensureEffectAiReady,
  localDraftGenerationSettings,
  serializeDraftGenerationSettings,
  type DraftGenerationSettings,
  resolveEffectAiConfiguration,
  runEffectAiConsolidation,
  runEffectAiTopicDraft,
  runNativeAiConsolidation,
  runNativeAiTopicDraft,
  TopicDraftProviderOutputError,
  DraftProviderUnavailableBeforeDispatch,
} from './consolidator.js';
import {topicDraftModelSchema} from '../../manager/topic_draft_schema.js';

export const TOPIC_DRAFT_PROMPT_VERSION = 'topic-maintenance-draft-v24';
export const AUTOMATIC_DRAFT_PROMPT_VERSION = 'automatic-memory-v8';
export const TOPIC_DRAFT_MAX_PROMPT_BYTES = 80 * 1024;
export const TOPIC_DRAFT_MAX_OUTPUT_BYTES = 32 * 1024;
export const TOPIC_DRAFT_MAX_DURATION_MS = 120_000;

export interface SelectedDraftResult {
  readonly text: string;
  readonly backendIdentity: string;
  readonly modelIdentity: string;
  readonly modelVersion?: string;
  readonly usage: TopicGenerationUsageV1;
  readonly outputRepresentation?: 'provider-text' | 'decoded-json';
  readonly settings: DraftGenerationSettings;
}

export class SelectedDraftError extends Schema.TaggedError<SelectedDraftError>()('SelectedDraftError', {
  message: Schema.String,
  reason: Schema.optionalKey(Schema.Literal('deadline')),
}) {}
const fail = (message: string) => SelectedDraftError.make({message});
export const isTransientDraftProviderFailure = (error: unknown) =>
  AiError.isAiError(error) &&
  error.isRetryable &&
  ['NetworkError', 'RateLimitError', 'InternalProviderError'].includes(error.reason._tag);
function remoteModelVersion(apiUrl: string | undefined): string {
  let host = 'default';
  if (apiUrl) {
    try {
      host = new URL(apiUrl).host.slice(0, 64) || 'custom';
    } catch {
      host = 'custom';
    }
  }
  return `${host}:${sha256HexSync(apiUrl ?? 'effect-ai-default')}`;
}

export const selectedTopicDraftIdentity = Effect.fn('topicMaintenance.selectedDraftIdentity')(function* (
  config: RuntimeConfig,
  agent: ConsolidationAgent,
  model: ConsolidationModel,
) {
  if (agent === 'local-ai') {
    const manifest = yield* (yield* LocalModelCatalog).get(model.id);
    if (manifest.role !== 'generation') return yield* fail('Select an installed generation model.');
    return {
      agent,
      model: model.id,
      modelVersion: `${manifest.revision}:${manifest.sha256}`,
      backendIdentity: 'local-ai',
      settings: serializeDraftGenerationSettings(localDraftGenerationSettings(model.id, 'topic-maintenance')),
    };
  }
  if (agent === 'effect-ai') {
    const resolved = yield* resolveEffectAiConfiguration(config, (yield* SystemInfo).environment());
    if (!resolved || resolved.configuration.model !== model.id)
      return yield* fail('Configure and select the exact Effect AI model before drafting.');
    return {
      agent,
      model: model.id,
      modelVersion: remoteModelVersion(resolved.configuration.apiUrl),
      backendIdentity: resolved.configuration.apiUrl ?? 'effect-ai',
      settings: serializeDraftGenerationSettings({maxOutputTokens: 4000}),
    };
  }
  return yield* fail('Topic maintenance requires a text-only local-ai or explicitly configured effect-ai model.');
});

/** One provider-policy switch serves consolidation and the text-only topic pilot. */
export function runSelectedDraft(
  config: RuntimeConfig,
  agent: ConsolidationAgent,
  model: ConsolidationModel | undefined,
  prompt: string,
  purpose: 'consolidation' | 'topic-maintenance',
  topicBasis?: TopicMaintenanceDraftBasis,
) {
  const topic = purpose === 'topic-maintenance';
  if (topic && new TextEncoder().encode(prompt).byteLength > TOPIC_DRAFT_MAX_PROMPT_BYTES)
    return Effect.fail(fail('Topic maintenance prompt exceeds the 80 KiB input boundary.'));
  if (topic && agent !== 'local-ai' && agent !== 'effect-ai')
    return Effect.fail(
      fail('Topic maintenance requires a text-only local-ai or explicitly configured effect-ai model.'),
    );
  if (topic && !topicBasis) return Effect.fail(fail('Topic maintenance requires a validated draft basis.'));
  const topicSchema = topicBasis ? topicDraftModelSchema(topicBasis) : undefined;
  const run = Effect.gen(function* () {
    if (agent === 'local-ai') {
      if (!model)
        return yield* ConsolidationModelsError.make({
          message: 'Choose a model before generating a consolidation draft.',
        });
      const manifest = topic ? yield* (yield* LocalModelCatalog).get(model.id) : undefined;
      const native = yield* topicSchema && topicBasis
        ? runNativeAiTopicDraft(config, prompt, model.id, topicSchema, topicBasis)
        : runNativeAiConsolidation(config, prompt, model.id);
      if (native === undefined)
        return yield* ManagerOperationError.make({
          message: 'No generation model is installed. Install one with `threadnote models` and reload model choices.',
        });
      return {
        ...(typeof native === 'string' ? {text: native, usage: {status: 'unavailable' as const}} : native),
        backendIdentity: 'local-ai',
        modelIdentity: model.id,
        ...(manifest ? {modelVersion: `${manifest.revision}:${manifest.sha256}`} : {}),
        settings: localDraftGenerationSettings(model.id, purpose),
      };
    }
    if (agent === 'effect-ai') {
      const resolved = yield* resolveEffectAiConfiguration(config, (yield* SystemInfo).environment());
      if (!resolved && topic && model)
        return yield* DraftProviderUnavailableBeforeDispatch.make({
          backend: 'effect-ai',
          modelId: model.id,
          message: 'The explicit Effect AI configuration is unavailable before dispatch.',
        });
      if (!resolved)
        return yield* ManagerOperationError.make({
          message: 'Configure an explicit remote Effect AI provider and reload model choices.',
        });
      if (!model || model.id !== resolved.configuration.model)
        return yield* ConsolidationModelsError.make({
          message: 'This model is no longer available. Reload model choices and select a model again.',
        });
      yield* ensureEffectAiReady(config, resolved);
      const text = yield* topicSchema && topicBasis
        ? runEffectAiTopicDraft(prompt, resolved.configuration, topicSchema, topicBasis)
        : runEffectAiConsolidation(prompt, resolved.configuration);
      return {
        ...(typeof text === 'string' ? {text, usage: {status: 'unavailable' as const}} : text),
        backendIdentity: resolved.configuration.apiUrl ?? 'effect-ai',
        modelIdentity: resolved.configuration.model,
        modelVersion: remoteModelVersion(resolved.configuration.apiUrl),
        settings: {maxOutputTokens: 4000 as const},
      };
    }
    if (agent !== 'codex' && agent !== 'claude')
      return yield* ManagerOperationError.make({
        message: `${agent} does not expose a supported non-interactive consolidation mode.`,
      });
    const executable = yield* findExecutable([agent]);
    if (!executable) return yield* ManagerOperationError.make({message: `${agent} executable was not found.`});
    const text = yield* runConsolidationAgentCommand(agent, executable, prompt, model).pipe(
      Effect.catch(error => ManagerOperationError.make({message: errorMessage(error)})),
    );
    return {
      text,
      backendIdentity: agent,
      modelIdentity: model?.id ?? agent,
      usage: {status: 'unavailable' as const},
      settings: {maxOutputTokens: 4000 as const},
    };
  });
  return (
    topic
      ? run.pipe(
          Effect.timeoutOrElse({
            duration: TOPIC_DRAFT_MAX_DURATION_MS,
            orElse: () =>
              Effect.fail(
                SelectedDraftError.make({
                  message: 'Topic maintenance generation exceeded the 120-second deadline.',
                  reason: 'deadline',
                }),
              ),
          }),
        )
      : run
  ).pipe(
    Effect.map((result): SelectedDraftResult => result),
    Effect.tap(result =>
      topic && new TextEncoder().encode(result.text).byteLength > TOPIC_DRAFT_MAX_OUTPUT_BYTES
        ? Effect.fail(
            TopicDraftProviderOutputError.make({
              message: 'Topic maintenance draft exceeds the 32 KiB output boundary.',
              output: retainedTopicGenerationOutput(1, result.text, result.outputRepresentation ?? 'provider-text'),
              usage: result.usage,
            }),
          )
        : Effect.void,
    ),
  );
}
