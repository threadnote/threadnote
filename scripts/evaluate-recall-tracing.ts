import {Context, Effect, Exit, Option, Tracer} from 'effect';

export const RECALL_EVALUATION_SPAN_NAMES = [
  'recall.prepareSections',
  'recall.prepareSectionsAttempt',
  'recall.loadSemanticScoresResult',
  'recall.loadFeedback',
  'recall.loadIndexDataBatch',
  'recall.executeIndexQuery',
  'recall.initializeDatabase',
  'recall.ensureDatabaseFresh',
  'recall.selectIndexData',
  'recall.applySelectedNativeReranker',
  'recall.refreshDatabase',
  'recall.recoverIndex',
] as const;

type SpanName = (typeof RECALL_EVALUATION_SPAN_NAMES)[number];
const MAX_COUNT = 1_000_000;
const MAX_MILLISECONDS = 86_400_000;

export interface RecallEvaluationSpanSummary {
  readonly count: number;
  readonly wallTotalMilliseconds: number;
  readonly wallMaximumMilliseconds: number;
  readonly successCount: number;
  readonly failureCount: number;
}

export type RecallEvaluationSpans = Readonly<Partial<Record<SpanName, RecallEvaluationSpanSummary>>>;

export interface RecallEvaluationTracing {
  readonly tracer: Tracer.Tracer;
  readonly snapshot: () => RecallEvaluationSpans;
}

class RecallEvaluationSpan extends Tracer.NativeSpan {
  constructor(
    private readonly summaries: Map<SpanName, RecallEvaluationSpanSummary>,
    private readonly selectedName: SpanName | undefined,
    startTime: bigint,
  ) {
    super({
      name: selectedName ?? 'ignored',
      startTime,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      kind: 'internal',
      sampled: true,
    });
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    if (this.status._tag === 'Ended') return;
    let success = false;
    try {
      success = exit._tag === 'Success';
      if (this.selectedName && typeof endTime === 'bigint' && endTime >= this.startTime) {
        const wall = Number(endTime - this.startTime) / 1_000_000;
        const previous = this.summaries.get(this.selectedName);
        if (Number.isFinite(wall) && (previous?.count ?? 0) < MAX_COUNT) {
          this.summaries.set(this.selectedName, {
            count: (previous?.count ?? 0) + 1,
            wallTotalMilliseconds: Math.min(MAX_MILLISECONDS, (previous?.wallTotalMilliseconds ?? 0) + wall),
            wallMaximumMilliseconds: Math.min(MAX_MILLISECONDS, Math.max(previous?.wallMaximumMilliseconds ?? 0, wall)),
            successCount: (previous?.successCount ?? 0) + Number(success),
            failureCount: (previous?.failureCount ?? 0) + Number(!success),
          });
        }
      }
    } catch {
      // Drop invalid diagnostic inputs; never retain the Exit or its payload.
    }
    // Only the lifecycle tag stays on the span; the original Effect carries its own unmodified Exit.
    super.end(typeof endTime === 'bigint' ? endTime : this.startTime, success ? Exit.void : Exit.fail(undefined));
  }

  override attribute() {}
  override event() {}
  override addLinks() {}
}

/** Inclusive existing-span times overlap; they are not an exclusive phase breakdown. */
export function createRecallEvaluationTracing(): RecallEvaluationTracing {
  const summaries = new Map<SpanName, RecallEvaluationSpanSummary>();
  const tracer = Tracer.make({
    span(options) {
      let name: SpanName | undefined;
      let startTime = 0n;
      try {
        const candidate = options.name;
        const started = options.startTime;
        if (typeof started === 'bigint' && started >= 0n) {
          name = RECALL_EVALUATION_SPAN_NAMES.find(value => value === candidate);
          startTime = started;
        }
      } catch {
        // A diagnostic must not turn an otherwise successful operation into a defect.
      }
      const selectedName = name;
      return new RecallEvaluationSpan(summaries, selectedName, startTime);
    },
  });
  return {
    tracer,
    snapshot: () => Object.fromEntries([...summaries].map(([name, summary]) => [name, {...summary}])),
  };
}

export function withRecallEvaluationTracing<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  tracing?: RecallEvaluationTracing,
): Effect.Effect<A, E, R> {
  try {
    return tracing ? Effect.withTracer(effect, tracing.tracer) : effect;
  } catch {
    return effect;
  }
}

export function snapshotRecallEvaluationTracing(tracing?: RecallEvaluationTracing): RecallEvaluationSpans | undefined {
  try {
    return tracing?.snapshot();
  } catch {
    return undefined;
  }
}
