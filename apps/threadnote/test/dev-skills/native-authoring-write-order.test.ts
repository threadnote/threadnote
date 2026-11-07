import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {loadRecallMemoryIdentities, readRecallMemoryIdentities, recallIndexStatus} from '@threadnote/recall/index';
import {withWorkflowRecallRefreshBatch} from '../../src/workflow_memory/recall_refresh.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const artifact = Schema.decodeUnknownEffect(
  Schema.Struct({
    artifact: Schema.Struct({uri: Schema.String, memoryId: Schema.String, revision: Schema.String}),
  }),
);

fcEffectProp(
  effectIt,
  'prepares batched child identities before a dependent native write while ordinary readers abstain',
  {
    count: fc.integer({min: 1, max: 4}),
    aliases: fc.boolean(),
  },
  ({count, aliases}) =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      yield* loadRecallMemoryIdentities(f.config, {allowedUriScopes: [], memoryIds: []});
      const children: {uri: string; memoryId: string; content: string}[] = [];
      let consumerUri = '';
      yield* withWorkflowRecallRefreshBatch(
        f.config,
        Effect.gen(function* () {
          for (let i = 0; i < count; i++) {
            const result = yield* f
              .call(
                f.write({
                  operationId: `child-${i}`,
                  artifactKey: `child-${i}`,
                  role: 'authoring-child',
                  body: `Canonical child ${i}.`,
                }),
              )
              .pipe(Effect.flatMap(artifact));
            children.push({...result.artifact, content: yield* f.store.read(f.location, result.artifact.uri)});
          }
          const beforeRead = yield* recallIndexStatus(f.config);
          expect(beforeRead.ready).toBe(false);
          const ordinary = yield* readRecallMemoryIdentities(f.config, {
            allowedUriScopes: [`threadnote://user/${f.config.user}/memories`],
            memoryIds: EffectArray.map(children, child => child.memoryId),
          }).pipe(Effect.result);
          expect(ordinary._tag).toBe('Failure');
          expect(yield* recallIndexStatus(f.config)).toEqual(beforeRead);
          const result = yield* f
            .call(
              f.write({
                operationId: 'consumer',
                artifactKey: 'consumer',
                role: 'authoring-child',
                body: 'Consumer of the preceding canonical children.',
                relations: EffectArray.map(children, child => ({
                  type: 'references',
                  uri: aliases ? memoryIdentityAlias(child.memoryId) : child.uri,
                })),
              }),
            )
            .pipe(Effect.flatMap(artifact));
          consumerUri = result.artifact.uri;
        }),
      );
      expect((yield* recallIndexStatus(f.config)).ready).toBe(true);
      const content = yield* f.store.read(f.location, consumerUri);
      const consumer = parseMemoryDocument(consumerUri, content);
      expect(consumer?.metadata.relations).toEqual(
        EffectArray.map(children, child => ({
          type: 'references',
          uri: memoryIdentityAlias(child.memoryId),
        })).sort((left, right) => (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0)),
      );
      for (const child of children) expect(yield* f.store.read(f.location, child.uri)).toBe(child.content);
    }).pipe(TestClock.withLive, provideNative),
  {fastCheck: {numRuns: 6}},
);
