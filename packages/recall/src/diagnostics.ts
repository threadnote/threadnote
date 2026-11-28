import {Clock, Context, Effect} from 'effect';

export const RECALL_DIAGNOSTIC_SCOPES = ['active', 'with-inactive'] as const;
export const RECALL_LEXICAL_REFRESH_DECISIONS = ['skipped', 'incremental', 'full', 'forced'] as const;
/** Why a refresh could not stay incremental, or why it reindexed every source. */
export const RECALL_LEXICAL_REFRESH_REASONS = [
  'requested',
  'integrity',
  'inventory-policy',
  'recovery',
  'logical-scope',
  'source-policy',
  'external-resources',
  'no-invalidations',
  'invalidations-overflow',
  'marker-forced',
  'canonical-discontinuity',
  'touched-fallback',
] as const;
export const RECALL_LEXICAL_REFRESH_FAILURE_STAGES = [
  'worker',
  'worker-repair',
  'read-maintenance',
  'mutation-hook',
] as const;
export const RECALL_INVALIDATION_FAILURE_STAGES = ['store-expire', 'refresh-expire', 'marker-clear'] as const;

type RecallDiagnosticScope = (typeof RECALL_DIAGNOSTIC_SCOPES)[number];
export type RecallLexicalRefreshReason = (typeof RECALL_LEXICAL_REFRESH_REASONS)[number];

export interface RecallLexicalRefreshOutcome {
  readonly decision: (typeof RECALL_LEXICAL_REFRESH_DECISIONS)[number];
  readonly reasons: readonly RecallLexicalRefreshReason[];
  readonly invalidatedUriCount: number;
  readonly changedSourceCount?: number;
  readonly removedSourceCount?: number;
  readonly documentCount?: number;
}

export const RECALL_VECTOR_BUILD_KINDS = ['delta', 'full'] as const;

/** One published vector generation: copied chunks came from the base, prepared ones were reused or embedded. */
export interface RecallVectorBuildOutcome {
  readonly kind: (typeof RECALL_VECTOR_BUILD_KINDS)[number];
  readonly changedCount: number;
  readonly copiedChunkCount: number;
  readonly reusedChunkCount: number;
  readonly embeddedChunkCount: number;
}

/** Counts, closed reasons and error values only; the log writer reduces `error` to a safe type label. */
export type RecallDiagnostic =
  | (RecallLexicalRefreshOutcome & {
      readonly event: 'recall.lexical-refresh';
      readonly scope: RecallDiagnosticScope;
      readonly durationMilliseconds: number;
    })
  | (RecallVectorBuildOutcome & {
      readonly event: 'recall.vector-build';
      readonly scope: RecallDiagnosticScope;
      /** From target creation to activation; a build can span many steps and processes. */
      readonly durationMilliseconds: number;
    })
  | {
      readonly event: 'recall.lexical-refresh-failed';
      readonly scope: RecallDiagnosticScope;
      readonly stage: (typeof RECALL_LEXICAL_REFRESH_FAILURE_STAGES)[number];
      readonly error?: unknown;
    }
  | {
      readonly event: 'recall.invalidation-failed';
      readonly scope: RecallDiagnosticScope;
      readonly stage: (typeof RECALL_INVALIDATION_FAILURE_STAGES)[number];
      readonly invalidatedUriCount: number;
      readonly error: unknown;
    };

/** The application routes diagnostics to its production log. Without it, emission is a no-op. */
export const RecallDiagnosticsPort = Context.Reference<
  ((home: string, diagnostic: RecallDiagnostic) => Effect.Effect<void>) | undefined
>('@threadnote/recall/diagnostics/RecallDiagnosticsPort', {defaultValue: () => undefined});

export const recallDiagnosticScope = (includeInactive: boolean): RecallDiagnosticScope =>
  includeInactive ? 'with-inactive' : 'active';

export const emitRecallDiagnostic = (home: string, diagnostic: RecallDiagnostic) =>
  Effect.gen(function* () {
    const port = yield* RecallDiagnosticsPort;
    if (port) yield* port(home, diagnostic);
  });

export const emitRecallLexicalRefresh = (
  home: string,
  includeInactive: boolean,
  startedAt: number,
  outcome: RecallLexicalRefreshOutcome,
) =>
  Effect.gen(function* () {
    yield* emitRecallDiagnostic(home, {
      ...outcome,
      event: 'recall.lexical-refresh',
      scope: recallDiagnosticScope(includeInactive),
      durationMilliseconds: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
    });
  });
