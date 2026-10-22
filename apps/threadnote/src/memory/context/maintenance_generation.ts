import {InvalidModelOutput, InferenceInterrupted} from '@threadnote/inference/engine/errors';
import {Cause, Clock, Crypto, Effect, Exit, Option, Schema} from 'effect';
import {AiError} from 'effect/ai';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {saveTopicGenerationReceipt} from '@threadnote/memory/candidate-generation';
import {
  TopicGenerationSummary,
  projectTopicGenerationSummary,
  retainedTopicGenerationOutput,
  type TopicGenerationReceiptV1,
  type TopicGenerationSummaryV1,
  type TopicGenerationUsageV1,
} from '@threadnote/memory/topic-maintenance-draft';
import {SelectedDraftError} from '../../effect/ai/selected_generation.js';
import {DraftProviderUnavailableBeforeDispatch, TopicDraftProviderOutputError} from '../../effect/ai/consolidator.js';

export class TopicGenerationRequestError extends Schema.TaggedError<TopicGenerationRequestError>()(
  'TopicGenerationRequestError',
  {
    message: Schema.String,
    diagnostics: Schema.optionalKey(TopicGenerationSummary),
    failureKind: Schema.optionalKey(Schema.Literals(['transient', 'terminal'])),
  },
) {}
const failed = (diagnostics?: TopicGenerationSummaryV1, failureKind: 'transient' | 'terminal' = 'terminal') =>
  TopicGenerationRequestError.make({
    message: 'Topic generation failed. Inspect the saved local diagnostics when available.',
    ...(diagnostics ? {diagnostics} : {}),
    failureKind,
  });

type Identity = Pick<
  TopicGenerationReceiptV1,
  | 'caseId'
  | 'reviewId'
  | 'targetHash'
  | 'observationRevision'
  | 'packetDigest'
  | 'agent'
  | 'model'
  | 'modelVersion'
  | 'promptVersion'
>;
interface Output {
  readonly text: string;
  readonly usage: TopicGenerationUsageV1;
  readonly outputRepresentation?: 'provider-text' | 'decoded-json';
}

export function withTopicGenerationObservation<A, E, R>(
  home: string,
  identity: Identity,
  use: (observation: TopicGenerationObservation) => Effect.Effect<A, E, R>,
  persist: typeof saveTopicGenerationReceipt = saveTopicGenerationReceipt,
  deadline?: number,
) {
  return Effect.uninterruptibleMask(restore =>
    Effect.gen(function* () {
      const id = (yield* (yield* Crypto.Crypto).randomUUIDv4()).replaceAll('-', '');
      const observation = new TopicGenerationObservation(
        home,
        {
          ...identity,
          version: 1,
          receiptId: `topic-generation-${id}`,
          createdAtMilliseconds: yield* Clock.currentTimeMillis,
          state: 'started',
          phase: 'generation',
          elapsedMilliseconds: 0,
          promptScope: 'user-prompt-utf8-sha256',
          attempts: [],
        },
        persist,
      );
      yield* observation.save().pipe(Effect.mapError(() => failed()));
      const program = restore(use(observation));
      // The claim's absolute deadline owns the whole unit. Keeping cancellation
      // inside this observation preserves its original receipt and attempt timing.
      const remaining = deadline === undefined ? undefined : Math.max(0, deadline - (yield* Clock.currentTimeMillis));
      const exit = yield* Effect.exit(
        remaining === undefined
          ? program
          : program.pipe(
              Effect.timeoutOrElse({
                duration: remaining,
                orElse: () =>
                  Effect.sync(() => observation.deadline()).pipe(
                    Effect.andThen(
                      Effect.fail(
                        SelectedDraftError.make({
                          message: 'Topic maintenance generation exceeded the 120-second deadline.',
                          reason: 'deadline',
                        }),
                      ),
                    ),
                  ),
              }),
            ),
      );

      observation.close(
        Exit.isSuccess(exit) ? 'completed' : Cause.hasInterrupts(exit.cause) ? 'interrupted' : 'failed',
      );
      const saved = yield* observation.save().pipe(Effect.result);
      if (saved._tag === 'Failure') return yield* failed();
      if (Exit.isFailure(exit)) {
        if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause);
        const original = Cause.findErrorOption(exit.cause);
        const transient =
          Option.isSome(original) &&
          AiError.isAiError(original.value) &&
          original.value.isRetryable &&
          ['NetworkError', 'RateLimitError', 'InternalProviderError'].includes(original.value.reason._tag);
        // Unknown/provider-output failures are not evidence that redispatch is safe.
        return yield* failed(observation.summary(), transient ? 'transient' : 'terminal');
      }
      return exit.value;
    }),
  );
}

export class TopicGenerationObservation {
  private latestOutput: ReturnType<typeof retainedTopicGenerationOutput> | undefined;
  constructor(
    private readonly home: string,
    private receipt: TopicGenerationReceiptV1,
    private readonly persist: typeof saveTopicGenerationReceipt,
  ) {}
  private elapsedMilliseconds() {
    return this.receipt.attempts.some(attempt => attempt.elapsedMilliseconds === null)
      ? null
      : this.receipt.attempts.reduce((total, attempt) => total + (attempt.elapsedMilliseconds ?? 0), 0);
  }
  save() {
    this.receipt = {...this.receipt, elapsedMilliseconds: this.elapsedMilliseconds()};
    return this.persist(this.home, this.receipt);
  }
  summary(): TopicGenerationSummaryV1 {
    return projectTopicGenerationSummary({...this.receipt, elapsedMilliseconds: this.elapsedMilliseconds()});
  }
  completedSummary(): TopicGenerationSummaryV1 {
    return {...this.summary(), state: 'completed', phase: 'review-save'};
  }
  phase(phase: TopicGenerationReceiptV1['phase']) {
    this.receipt = {...this.receipt, phase};
  }
  private updateAttempt(changes: Partial<TopicGenerationReceiptV1['attempts'][number]>) {
    this.receipt = {
      ...this.receipt,
      attempts: this.receipt.attempts.map((attempt, index, all) =>
        index === all.length - 1 ? {...attempt, ...changes} : attempt,
      ),
    };
  }
  private retainFailure() {
    if (!this.receipt.firstFailedOutput && this.latestOutput)
      this.receipt = {...this.receipt, firstFailedOutput: this.latestOutput};
  }
  close(state: TopicGenerationReceiptV1['state']) {
    if (this.receipt.attempts.at(-1)?.status === 'started') {
      this.updateAttempt({
        status:
          this.receipt.attempts.at(-1)?.elapsedMilliseconds === null
            ? 'not-dispatched'
            : state === 'interrupted'
              ? 'interrupted'
              : 'provider-output-invalid',
      });
      this.retainFailure();
    }
    this.receipt = {
      ...this.receipt,
      state,
      elapsedMilliseconds: this.elapsedMilliseconds(),
    };
  }
  deadline() {
    this.updateAttempt({status: 'deadline'});
    this.retainFailure();
  }
  finishAttempt(status: 'accepted' | 'draft-invalid') {
    this.updateAttempt({status});
    if (status === 'draft-invalid') this.retainFailure();
    return this.save();
  }
  dispatch<A extends Output, E, R>(prompt: string, effect: Effect.Effect<A, E, R>) {
    return Effect.uninterruptibleMask(restore =>
      Effect.gen({self: this}, function* () {
        const ordinal = this.receipt.attempts.length + 1;
        if (ordinal !== 1 && ordinal !== 2) return yield* failed();
        this.latestOutput = undefined;
        this.receipt = {
          ...this.receipt,
          phase: 'generation',
          attempts: [
            ...this.receipt.attempts,
            {
              ordinal,
              promptHash: sha256HexSync(prompt),
              promptBytes: new TextEncoder().encode(prompt).byteLength,
              status: 'started',
              elapsedMilliseconds: null,
              usage: {status: 'unavailable'},
              output: {status: 'unavailable', reason: 'not-returned'},
            },
          ],
        };
        yield* this.save();
        const start = yield* Clock.currentTimeNanos;
        const exit = yield* Effect.exit(restore(effect));
        const elapsedMilliseconds = Math.max(
          0,
          Math.round(Number((yield* Clock.currentTimeNanos) - start) / 1_000_000),
        );
        this.updateAttempt({elapsedMilliseconds});
        if (Exit.isSuccess(exit)) {
          this.latestOutput = retainedTopicGenerationOutput(
            ordinal,
            exit.value.text,
            exit.value.outputRepresentation ?? 'provider-text',
          );
          const {hash, bytes, representation} = this.latestOutput;
          this.updateAttempt({usage: exit.value.usage, output: {status: 'observed', hash, bytes, representation}});
          this.phase('validation');
          yield* this.save();
          return exit.value;
        }
        const failure = Cause.findErrorOption(exit.cause);
        if (Option.isSome(failure) && Schema.is(DraftProviderUnavailableBeforeDispatch)(failure.value)) {
          this.updateAttempt({status: 'not-dispatched', elapsedMilliseconds: null});
        } else if (Option.isSome(failure) && Schema.is(TopicDraftProviderOutputError)(failure.value)) {
          this.latestOutput = {...failure.value.output, attempt: ordinal};
          const {hash, bytes, representation} = this.latestOutput;
          this.updateAttempt({
            status: 'provider-output-invalid',
            usage: failure.value.usage ?? {status: 'unavailable'},
            output: {status: 'observed', hash, bytes, representation},
          });
          this.retainFailure();
        } else {
          const interrupted =
            Cause.hasInterrupts(exit.cause) ||
            (Option.isSome(failure) && Schema.is(InferenceInterrupted)(failure.value));
          const invalidOutput = Option.isSome(failure) && Schema.is(InvalidModelOutput)(failure.value);
          const deadline =
            Option.isSome(failure) &&
            Schema.is(SelectedDraftError)(failure.value) &&
            failure.value.reason === 'deadline';
          this.updateAttempt({
            status: deadline
              ? 'deadline'
              : interrupted
                ? 'interrupted'
                : invalidOutput
                  ? 'provider-output-invalid'
                  : 'provider-failed',
            output: {
              status: 'unavailable',
              reason: interrupted ? 'interrupted' : invalidOutput ? 'provider-decode-failed' : 'not-returned',
            },
          });
        }
        yield* this.save();
        return yield* Effect.failCause(exit.cause);
      }),
    );
  }
}
