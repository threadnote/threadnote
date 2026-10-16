#!/usr/bin/env bun

/* oxlint-disable effecttsgo/strict-effect-provide -- Evaluation entry point uses the pinned application inference layer. */

import {Effect, Schema} from 'effect';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {topicStudyHash} from '@threadnote/threadnote/evaluation/topic-maintenance-longitudinal';
import {
  assertTopicStudyModel,
  assertTopicStudyRuntime,
  type TopicStudyVerifiedModel,
  type TopicStudyRuntimeFingerprint,
} from './topic-maintenance-longitudinal-runtime.js';

interface Request {
  readonly home: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly verifiedModel: TopicStudyVerifiedModel;
  readonly runtime: TopicStudyRuntimeFingerprint;
}
const request = JSON.parse(await Bun.stdin.text()) as Request;
if (request.prompt.length > 24_000 || !request.modelId || !request.home || request.modelId !== request.verifiedModel.id)
  throw new Error('Invalid local model request.');
await assertTopicStudyRuntime(request.runtime);
await assertTopicStudyModel(request.verifiedModel);
const system = 'Return only a JSON object with one string property named draft.';
const generation = {
  prompt: request.prompt,
  system,
  maxTokens: 4000,
  seed: 0,
  jsonSchema: Schema.toJsonSchemaDocument(Schema.Struct({draft: Schema.String})).schema,
};
const started = performance.now();
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const catalog = yield* LocalModelCatalog;
    const manifest = yield* catalog.get(request.modelId);
    const store = yield* LocalModelStore;
    const installed = yield* store.verify(request.home, manifest);
    if (
      !installed.verified ||
      manifest.sha256 !== request.verifiedModel.sha256 ||
      manifest.size !== request.verifiedModel.size
    )
      return yield* Effect.die(new Error('The actual loaded model did not verify against the run pin.'));
    const runtime = yield* LocalModelRuntime;
    const generated = yield* runtime.generate({...generation, manifest, modelPath: installed.path});
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({draft: Schema.String}))(generated);
    return {
      draft: decoded.draft.trim(),
      model: {
        backend: 'local-ai',
        id: manifest.id,
        digest: manifest.sha256,
        modelVersion: `${manifest.id};sha256=${manifest.sha256};dependencies=${request.runtime.dependencyHash};bun=${request.runtime.bunHash}`,
        settingsHash: topicStudyHash('topic-study-local-settings-v1', {
          system,
          maxTokens: generation.maxTokens,
          seed: generation.seed,
          jsonSchema: generation.jsonSchema,
        }),
        promptVersion: 'topic-study-local-request-v1',
        attempts: 1,
      },
      // Hash the actual structured-generator request, including system/schema, not selection arguments.
      promptHash: topicStudyHash('topic-study-local-prompt-v1', generation),
    };
  }).pipe(Effect.provide(ApplicationLayer)),
);
await assertTopicStudyRuntime(request.runtime);
await assertTopicStudyModel(request.verifiedModel);
process.stdout.write(
  JSON.stringify({
    ...result,
    elapsedMilliseconds: Math.round(performance.now() - started),
    providerInputTokens: null,
    providerOutputTokens: null,
    providerChargeMicros: 0,
    settings: generation,
  }),
);
