import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Clock, Effect} from 'effect';
import {
  emitAnonymousTelemetryEvent,
  recordAnonymousTelemetryFields,
  type AnonymousTelemetryFields,
} from '../../effect/telemetry.js';
import {anonymousTelemetryDiagnosticFromError, type AnonymousTelemetryDiagnostic} from '../../telemetry/diagnostic.js';
import type {CodeGraphStoreFailureCode} from '@threadnote/graph/types';
import type {
  CodeGraphWorksetPrepareFailureDetailV1,
  CodeGraphWorksetPrepareProgressV1,
  CodeGraphWorksetPrepareResultV1,
} from '@threadnote/graph/workset_catalog/workset';

const WORKSET_TELEMETRY_CHECKPOINT_INTERVAL_MILLISECONDS = 60_000;
const STORE_FAILURE_CODES = new Set<CodeGraphStoreFailureCode>([
  'busy',
  'confirmed-corruption',
  'incompatible-schema',
  'no-space',
  'permission',
  'schema-additive',
  'transient-io',
  'unknown',
]);

export const makeCodeGraphWorksetTelemetryReporter = Effect.fn('codeGraph.makeWorksetTelemetryReporter')(() =>
  Effect.sync(() => {
    let lastEmittedAt = Number.NEGATIVE_INFINITY;
    let lastPhase: CodeGraphWorksetPrepareProgressV1['phase'] | undefined;
    let terminalEmitted = false;

    const progress = (current: CodeGraphWorksetPrepareProgressV1) =>
      Effect.gen(function* () {
        const fields = codeGraphWorksetTelemetryFields(current);
        yield* recordAnonymousTelemetryFields(fields);
        const now = yield* Clock.currentTimeMillis;
        if (
          current.phase === lastPhase &&
          current.phase !== 'completed' &&
          current.phase !== 'failed' &&
          now - lastEmittedAt < WORKSET_TELEMETRY_CHECKPOINT_INTERVAL_MILLISECONDS
        )
          return;
        lastPhase = current.phase;
        lastEmittedAt = now;
        yield* emitAnonymousTelemetryEvent({
          component: 'cli',
          event: 'checkpoint',
          fields,
          operation: 'workset.prepare',
          ...(current.phase === 'failed' ? {errorType: 'CodeGraphWorksetCatalogError', outcome: 'failure'} : {}),
        });
      }).pipe(Effect.ignoreCause);

    const terminal = (result: CodeGraphWorksetPrepareResultV1) =>
      Effect.suspend(() => {
        if (terminalEmitted) return Effect.void;
        terminalEmitted = true;
        const failure = EffectOption.getOrUndefined(
          EffectArray.findFirst(result.members, member => member.state === 'failed'),
        );
        const diagnostic = failure === undefined ? undefined : worksetFailureDiagnostic(failure.detail);
        const outcome = result.state === 'failed' ? 'failure' : result.coverage.complete ? 'success' : 'unavailable';
        return emitAnonymousTelemetryEvent({
          component: 'cli',
          ...(diagnostic === undefined ? {} : {diagnostic}),
          ...(outcome === 'success' ? {} : {errorType: diagnostic?.errorType ?? 'ReportedError'}),
          event: 'lifecycle',
          fields: {
            phase: 'storage.writing',
            phaseOutcome: outcome,
            stage: 'committing',
            workUnitsCompleted: result.coverage.ready,
            workUnitsTotal: result.coverage.requested,
          },
          operation: 'workset.prepare',
          outcome,
        }).pipe(Effect.ignoreCause);
      });

    const failure = (error: unknown, completed: number, total: number) =>
      Effect.suspend(() => {
        if (terminalEmitted) return Effect.void;
        terminalEmitted = true;
        const diagnostic = anonymousTelemetryDiagnosticFromError(error);
        return emitAnonymousTelemetryEvent({
          component: 'cli',
          ...(diagnostic === undefined ? {} : {diagnostic}),
          errorType: diagnostic?.errorType ?? 'UnknownError',
          event: 'lifecycle',
          fields: {
            phase: 'storage.writing',
            phaseOutcome: 'failure',
            stage: 'committing',
            workUnitsCompleted: completed,
            workUnitsTotal: total,
          },
          operation: 'workset.prepare',
          outcome: 'failure',
        }).pipe(Effect.ignoreCause);
      });

    return {failure, progress, terminal};
  }),
);

export function codeGraphWorksetTelemetryFields(progress: CodeGraphWorksetPrepareProgressV1): AnonymousTelemetryFields {
  return {
    ...worksetTelemetryPhaseFields(progress),
    ...(progress.phase === 'completed'
      ? {phaseOutcome: progress.resultState === 'ready' ? ('success' as const) : ('failure' as const)}
      : progress.phase === 'failed'
        ? {phaseOutcome: 'failure' as const}
        : {}),
    workUnitsCompleted: progress.completed,
    workUnitsTotal: progress.total,
  };
}

function worksetTelemetryPhaseFields(progress: CodeGraphWorksetPrepareProgressV1): AnonymousTelemetryFields {
  switch (progress.phase) {
    case 'starting':
      return {phase: 'storage.reading', stage: 'validating-input'};
    case 'waiting':
      return {phase: 'graph.waiting', waitingReason: 'database-writer'};
    case 'indexing': {
      const phase = `graph.${progress.activity?.phase ?? 'registering'}` as NonNullable<
        AnonymousTelemetryFields['phase']
      >;
      return {
        phase,
        ...(progress.activity?.phase === 'waiting' && progress.activity.reason !== undefined
          ? {waitingReason: progress.activity.reason}
          : {}),
      };
    }
    case 'projecting':
      return {phase: 'storage.writing', stage: 'writing-symbols'};
    case 'cataloging':
      return {phase: 'storage.writing', stage: 'writing-receipt'};
    case 'bridging':
      return {phase: 'storage.writing', stage: 'writing-edges'};
    case 'publishing':
    case 'completed':
    case 'failed':
      return {phase: 'storage.writing', stage: 'committing'};
  }
}

function worksetFailureDiagnostic(detail: CodeGraphWorksetPrepareFailureDetailV1): AnonymousTelemetryDiagnostic {
  const storageCode = EffectOption.getOrUndefined(
    EffectArray.findFirst([...STORE_FAILURE_CODES], code => code === detail.code),
  );
  return {
    ...(storageCode === undefined ? {} : {code: storageCode, domain: 'code-graph-storage' as const}),
    errorType: detail.errorType,
    ...(detail.recovery === undefined ? {} : {recovery: detail.recovery}),
    retryable: detail.retryable,
  };
}
