import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {makeTopicDraftWireBasis, makeTopicDraftWireFixture} from '../helpers/topic-draft-wire.js';
import {decodeTopicDraftWire} from '../../src/manager/topic_draft_schema.js';
import {InvalidModelOutput} from '@threadnote/inference/engine/errors';
import {TopicDraftProviderOutputError} from '../../src/effect/ai/consolidator.js';
import {retainedTopicGenerationOutput} from '@threadnote/memory/topic-maintenance-draft';
import {CliOutput} from '../../src/effect/cli/output.js';
import {
  readTopicGenerationReceiptCommand,
  projectTopicDraftFailure,
} from '../../src/memory/context/maintenance_commands.js';
import {TopicDraftError} from '../../src/memory/context/maintenance_draft.js';
import {TestError} from '@threadnote/testing/test-error';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {loadTopicGenerationReceipt, readTopicGenerationSummary} from '@threadnote/memory/candidate-generation';
import {
  TopicGenerationRequestError,
  withTopicGenerationObservation,
} from '../../src/memory/context/maintenance_generation.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const identity = {
  caseId: 'health-case-' + Effect2.pipe('a', EffectString.repeat(40)),
  reviewId: 'review-' + Effect2.pipe('b', EffectString.repeat(24)),
  targetHash: Effect2.pipe('c', EffectString.repeat(64)),
  observationRevision: Effect2.pipe('d', EffectString.repeat(64)),
  packetDigest: Effect2.pipe('e', EffectString.repeat(64)),
  agent: 'local-ai' as const,
  model: 'fixture',
  promptVersion: 'v5',
};
const result = (text: string) => ({text, usage: {status: 'unavailable' as const}});
const layer = Layer.merge(BunServices.layer, TestSystemInfoLayer);

describe('private topic generation lifecycle', () => {
  effectIt.layer(layer)(it => {
    it.effect('keeps invalid then accepted attempts and private first output', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        const basis = makeTopicDraftWireBasis(2);
        const wire = makeTopicDraftWireFixture(basis);
        wire.facts.entries[1].ordinal = 0;
        const firstWire = JSON.stringify(decodeTopicDraftWire(basis, wire));
        const before = JSON.stringify(wire);
        const summary = yield* withTopicGenerationObservation(home, identity, observation =>
          Effect.gen(function* () {
            yield* observation.dispatch(
              'é🙂',
              Effect.succeed({
                ...result(firstWire),
                outputRepresentation: 'decoded-json' as const,
                usage: {status: 'measured' as const, inputTokens: 12, outputTokens: 3},
              }),
            );
            yield* observation.finishAttempt('draft-invalid');
            yield* observation.dispatch('repair', Effect.succeed(result('{}')));
            yield* observation.finishAttempt('accepted');
            return observation.summary();
          }),
        );
        expect(EffectArray.map(summary.attempts, a => a.status)).toEqual(['draft-invalid', 'accepted']);
        expect(summary.attempts[0].promptBytes).toBe(6);
        const receipt = yield* loadTopicGenerationReceipt(home, summary.receiptId);
        expect(receipt.firstFailedOutput).toMatchObject({
          text: firstWire,
          representation: 'decoded-json',
          hash: sha256HexSync(firstWire),
          bytes: new TextEncoder().encode(firstWire).byteLength,
          truncated: false,
        });
        expect(receipt.attempts[0].usage).toEqual({status: 'measured', inputTokens: 12, outputTokens: 3});
        expect(JSON.stringify(wire)).toBe(before);
        expect(JSON.stringify(yield* readTopicGenerationSummary(home, summary.receiptId))).not.toContain(firstWire);
        const output: string[] = [];
        yield* readTopicGenerationReceiptCommand(home, summary.receiptId, true).pipe(
          Effect.provideService(CliOutput, {
            drain: Effect.void,
            flush: Effect.void,
            enqueueError: () => {},
            enqueueOutput: () => {},
            writeError: () => Effect.void,
            writeFinal: text =>
              Effect.sync(() => {
                output.push(text);
              }),
          }),
        );
        expect(JSON.parse(output[0]).receiptId).toBe(summary.receiptId);
        expect(output[0]).not.toContain(firstWire);
        const path = yield* Path.Path;
        expect(
          (yield* fs.stat(path.join(home, 'threadnote/candidates/v1/topic-generation', summary.receiptId + '.json')))
            .mode & 0o777,
        ).toBe(0o600);
        expect((yield* fs.stat(path.join(home, 'threadnote/candidates/v1/topic-generation'))).mode & 0o777).toBe(0o700);
      }),
    );
    for (const scenario of ['provider-failed', 'closing-fence', 'all-invalid'] as const) {
      it.effect('retains complete failure: ' + scenario, () =>
        Effect.gen(function* () {
          const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
          const outcome = yield* withTopicGenerationObservation(home, identity, observation =>
            Effect.gen(function* () {
              yield* observation.dispatch('first', Effect.succeed(result('first invalid')));
              yield* observation.finishAttempt('draft-invalid');
              if (scenario === 'provider-failed')
                return yield* observation.dispatch(
                  'second',
                  Effect.fail(TestError.make({message: 'secret URL and credentials'})),
                );
              if (scenario === 'all-invalid') {
                yield* observation.dispatch('second', Effect.succeed(result('second invalid')));
                yield* observation.finishAttempt('draft-invalid');
              }
              if (scenario === 'closing-fence') {
                yield* observation.dispatch('second', Effect.succeed(result('{}')));
                yield* observation.finishAttempt('accepted');
                observation.phase('closing-fence');
              }
              return yield* TestError.make({message: 'private raw exception'});
            }),
          ).pipe(Effect.result);
          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome)) {
            if (!Schema.is(TopicGenerationRequestError)(outcome.failure))
              throw new Error('Expected safe generation error');
            const diagnostics = outcome.failure.diagnostics!;
            expect(diagnostics.state).toBe('failed');
            const receipt = yield* loadTopicGenerationReceipt(home, diagnostics.receiptId);
            expect(receipt.firstFailedOutput?.text).toBe('first invalid');
            expect(receipt.attempts).toHaveLength(2);
            expect(JSON.stringify(receipt)).not.toContain('secret URL');
            expect(JSON.stringify(outcome.failure)).not.toContain('private raw exception');
            const projected = projectTopicDraftFailure(
              TopicDraftError.make({message: 'private raw exception', diagnostics}),
            );
            expect(projected.diagnostics?.receiptId).toBe(diagnostics.receiptId);
            expect(JSON.stringify(projected)).not.toContain('private raw exception');
            expect(JSON.stringify(projected)).not.toContain('first invalid');
          }
        }),
      );
    }
    it.effect('refuses inference when the initial receipt cannot be saved', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const home = path.join(root, 'not-a-directory');
        yield* fs.writeFileString(home, 'occupied');
        let called = false;
        const failure = yield* withTopicGenerationObservation(home, identity, () =>
          Effect.sync(() => {
            called = true;
          }),
        ).pipe(Effect.flip);
        expect(called).toBe(false);
        expect(failure).toBeInstanceOf(TopicGenerationRequestError);
        if (Schema.is(TopicGenerationRequestError)(failure)) expect(failure.diagnostics).toBeUndefined();
      }),
    );

    it.effect('retains first invalid output when the repair reaches its deadline', () =>
      Effect.gen(function* () {
        const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const started = yield* Deferred.make<void>();
        const firstStarted = yield* Deferred.make<void>();
        const fiber = yield* withTopicGenerationObservation(home, identity, observation =>
          Effect.gen(function* () {
            yield* observation.dispatch(
              'first',
              Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Effect.sleep(20_000)),
                Effect.as(result('first invalid')),
              ),
            );
            yield* observation.finishAttempt('draft-invalid');
            return yield* observation.dispatch(
              'repair',
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            );
          }).pipe(
            Effect.timeoutOrElse({
              duration: 120_000,
              orElse: () => Effect.sync(() => observation.deadline()).pipe(Effect.andThen(Effect.fail('deadline'))),
            }),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* TestClock.adjust(20_000);
        yield* Deferred.await(started);
        yield* TestClock.adjust(100_000);
        const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(TopicGenerationRequestError);
        if (Schema.is(TopicGenerationRequestError)(failure)) {
          const receipt = yield* loadTopicGenerationReceipt(home, failure.diagnostics!.receiptId);
          expect(EffectArray.map(receipt.attempts, attempt => attempt.status)).toEqual(['draft-invalid', 'deadline']);
          expect(receipt.firstFailedOutput?.text).toBe('first invalid');
          expect(receipt.elapsedMilliseconds).toBe(120_000);
          expect(EffectArray.map(receipt.attempts, attempt => attempt.elapsedMilliseconds)).toEqual([20_000, 100_000]);
        }
      }),
    );
    it.effect('retains a total provider failure with no fabricated output or usage', () =>
      Effect.gen(function* () {
        const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const failure = yield* withTopicGenerationObservation(home, identity, observation =>
          observation.dispatch('first', Effect.fail('private provider exception')),
        ).pipe(Effect.flip);
        if (!Schema.is(TopicGenerationRequestError)(failure)) throw new Error('Expected safe generation error');
        const receipt = yield* loadTopicGenerationReceipt(home, failure.diagnostics!.receiptId);
        expect(EffectArray.map(receipt.attempts, attempt => attempt.status)).toEqual(['provider-failed']);
        expect(receipt.attempts[0].usage).toEqual({status: 'unavailable'});
        expect(receipt.firstFailedOutput).toBeUndefined();
      }),
    );
    it.effect('keeps decoded native validation output and labels unavailable raw grammar output honestly', () =>
      Effect.gen(function* () {
        const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        const decoded = yield* withTopicGenerationObservation(home, identity, observation =>
          observation.dispatch(
            'prompt',
            Effect.fail(
              TopicDraftProviderOutputError.make({
                message: 'Invalid native object.',
                output: retainedTopicGenerationOutput(1, '{"invalid":true}', 'decoded-json'),
              }),
            ),
          ),
        ).pipe(Effect.flip);
        if (!Schema.is(TopicGenerationRequestError)(decoded)) throw new Error('Expected safe generation error');
        const receipt = yield* loadTopicGenerationReceipt(home, decoded.diagnostics!.receiptId);
        expect(receipt.firstFailedOutput).toMatchObject({representation: 'decoded-json', text: '{"invalid":true}'});
        const raw = yield* withTopicGenerationObservation(home, identity, observation =>
          observation.dispatch(
            'prompt',
            Effect.fail(InvalidModelOutput.make({message: 'Invalid grammar output.', modelId: 'fixture'})),
          ),
        ).pipe(Effect.flip);
        if (!Schema.is(TopicGenerationRequestError)(raw)) throw new Error('Expected safe generation error');
        const unavailable = yield* loadTopicGenerationReceipt(home, raw.diagnostics!.receiptId);
        expect(unavailable.attempts[0]).toMatchObject({
          status: 'provider-output-invalid',
          output: {status: 'unavailable', reason: 'provider-decode-failed'},
        });
        expect(unavailable.firstFailedOutput).toBeUndefined();
      }),
    );
  });
});
