import {Array as EffectArray, Schema} from 'effect';

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.StructWithRest.Objects>(schema: S) =>
  Schema.StructWithRest(schema, [JsonRecordSchema]);

const RecallPhaseDiagnosticSchema = withRest(
  Schema.Struct({
    phase: Schema.Literals([
      'recall.shared-sync',
      'recall.obsidian-sync',
      'recall.workspace-context',
      'recall.semantic-retrieval',
      'recall.lexical-ranking',
    ]),
    outcome: Schema.Literals(['success', 'unavailable', 'timed-out', 'interrupted', 'failure']),
    durationMilliseconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

const InvocationBaseSchema = {
  component: Schema.Literal('mcp'),
  invocationId: Schema.String.check(Schema.isMinLength(1)),
  operation: Schema.Literal('recall_context'),
  processId: Schema.Int.check(Schema.isGreaterThan(0)),
};

const RecallInvocationSchema = Schema.Union([
  withRest(Schema.Struct({...InvocationBaseSchema, event: Schema.Literal('invocation.started')})),
  withRest(
    Schema.Struct({
      ...InvocationBaseSchema,
      event: Schema.Literal('invocation.finished'),
      outcome: Schema.Literals(['success', 'interrupted', 'failure']),
      phaseTimings: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    }),
  ),
]);

export interface InstalledRecallDiagnostic {
  readonly outcome: 'success' | 'interrupted' | 'failure';
  readonly phaseTimings: readonly {
    readonly durationMilliseconds: number;
    readonly outcome: 'success' | 'unavailable' | 'timed-out' | 'interrupted' | 'failure';
    readonly phase:
      | 'recall.shared-sync'
      | 'recall.obsidian-sync'
      | 'recall.workspace-context'
      | 'recall.semantic-retrieval'
      | 'recall.lexical-ranking';
  }[];
}

/**
 * Correlates one installed MCP recall after an observed completion boundary.
 * Multiple later starts are ambiguous, even when one has a completion.
 */
export function installedRecallDiagnostic(
  entries: readonly unknown[],
  processId: number,
  completedBeforeInvocationId: string,
): InstalledRecallDiagnostic | undefined {
  const invocations = EffectArray.filter(entries, Schema.is(RecallInvocationSchema));
  const boundaries = EffectArray.filter(
    invocations,
    entry =>
      entry.event === 'invocation.finished' &&
      entry.processId === processId &&
      entry.invocationId === completedBeforeInvocationId,
  );
  if (boundaries.length !== 1) return undefined;

  const boundaryIndex = invocations.indexOf(boundaries[0]);
  const later = EffectArray.drop(invocations, boundaryIndex + 1);
  const starts = EffectArray.filter(
    later,
    entry => entry.event === 'invocation.started' && entry.processId === processId,
  );
  if (starts.length !== 1) return undefined;

  const started = starts[0];
  const startIndex = later.indexOf(started);
  const completions = EffectArray.filter(
    EffectArray.drop(later, startIndex + 1),
    entry =>
      entry.event === 'invocation.finished' &&
      entry.processId === processId &&
      entry.invocationId === started.invocationId,
  );
  if (completions.length !== 1) return undefined;

  const completed = completions[0];
  if (completed.event !== 'invocation.finished') return undefined;
  return {
    outcome: completed.outcome,
    phaseTimings: EffectArray.map(
      EffectArray.take(EffectArray.filter(completed.phaseTimings ?? [], Schema.is(RecallPhaseDiagnosticSchema)), 32),
      timing => ({
        durationMilliseconds: timing.durationMilliseconds,
        outcome: timing.outcome,
        phase: timing.phase,
      }),
    ),
  };
}
