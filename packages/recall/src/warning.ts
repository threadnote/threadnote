import {Array as EffectArray, Predicate} from 'effect';
export const RECALL_OPERATIONAL_WARNING_LIMIT = 4;

export interface RecallOperationalWarning {
  readonly code:
    | 'lexical_index_unavailable'
    | 'lexical_index_stale'
    | 'lexical_maintenance_unavailable'
    | 'lexical_read_budget_exhausted'
    | 'lexical_read_failed';
  readonly message: string;
  readonly remediation: string;
}

const LEXICAL_INDEX_UNAVAILABLE_WARNING = {
  code: 'lexical_index_unavailable',
  message: 'The lexical memory index has no readable ready snapshot; recall results may be incomplete.',
  remediation: 'Retry after background maintenance, or run `threadnote repair` for explicit maintenance.',
} as const satisfies RecallOperationalWarning;

export function lexicalIndexUnavailableWarning(reason?: 'budget-exhausted'): RecallOperationalWarning {
  return reason === 'budget-exhausted'
    ? {
        code: 'lexical_read_budget_exhausted',
        message: 'The ready lexical read reached its time budget; completed evidence is retained.',
        remediation: 'Retry the bounded read when workstation capacity is available.',
      }
    : LEXICAL_INDEX_UNAVAILABLE_WARNING;
}

/** Missing readiness, elapsed budget and unexpected operational failure stay distinct. */
export function lexicalReadFailureWarning(error: unknown): RecallOperationalWarning {
  if (Predicate.isObject(error) && error._tag === 'RecallReadyReadUnavailable')
    return lexicalIndexUnavailableWarning(error.reason === 'budget-exhausted' ? 'budget-exhausted' : undefined);
  return {
    code: 'lexical_read_failed',
    message: 'The ready lexical read failed; results may be incomplete.',
    remediation: 'Run `threadnote doctor --dry-run` to inspect the operational failure.',
  };
}

/** Closed operational classification; result payloads never enter phase diagnostics. */
export function recallReadPhaseOutcome(
  warnings: readonly RecallOperationalWarning[],
): 'success' | 'timed-out' | 'unavailable' | 'failure' {
  if (EffectArray.some(warnings, warning => warning.code === 'lexical_read_failed')) return 'failure';
  if (EffectArray.some(warnings, warning => warning.code === 'lexical_read_budget_exhausted')) return 'timed-out';
  return EffectArray.some(warnings, warning => warning.code === 'lexical_index_unavailable')
    ? 'unavailable'
    : 'success';
}

export function recallReadStateWarnings(
  state: import('./index.js').RecallReadyReadState | undefined,
): readonly RecallOperationalWarning[] {
  if (state?.freshness !== 'stale') return [];
  return [
    {
      code: 'lexical_index_stale',
      message: 'Recall used the last ready lexical snapshot; recent changes may be absent.',
      remediation:
        state.maintenance === 'queued'
          ? 'Lexical maintenance is queued in the background.'
          : 'Background maintenance enqueue was not confirmed.',
    },
    ...(state.maintenance === 'unavailable'
      ? [
          {
            code: 'lexical_maintenance_unavailable' as const,
            message: 'Background lexical maintenance could not be queued.',
            remediation: 'Run `threadnote repair` and retry recall.',
          },
        ]
      : []),
  ];
}

export function mergeRecallOperationalWarnings(
  ...warningSets: readonly (readonly RecallOperationalWarning[])[]
): readonly RecallOperationalWarning[] {
  const byCode = new Map<RecallOperationalWarning['code'], RecallOperationalWarning>();
  for (const warning of warningSets.flat()) {
    if (!byCode.has(warning.code)) byCode.set(warning.code, warning);
  }
  return [...byCode.values()].slice(0, RECALL_OPERATIONAL_WARNING_LIMIT);
}

export function renderRecallOperationalWarning(warning: RecallOperationalWarning): string {
  return `Recall index warning: ${warning.message} ${warning.remediation}`;
}
