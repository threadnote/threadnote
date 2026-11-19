import {Array as EffectArray, Option, Predicate} from 'effect';
export const RECALL_OPERATIONAL_WARNING_LIMIT = 4;

/** Closed read failure causes; any failure without a transport reason is `worker-failed`. */
export const RECALL_LEXICAL_READ_FAILURE_REASONS = [
  'output-limit',
  'input-limit',
  'invalid-protocol',
  'worker-failed',
] as const;
export type RecallLexicalReadFailureReason = (typeof RECALL_LEXICAL_READ_FAILURE_REASONS)[number];

interface RecallOperationalWarningText {
  readonly message: string;
  readonly remediation: string;
}
export type RecallOperationalWarning =
  | (RecallOperationalWarningText & {
      readonly code:
        | 'lexical_index_unavailable'
        | 'lexical_index_stale'
        | 'lexical_maintenance_unavailable'
        | 'lexical_read_budget_exhausted';
    })
  | (RecallOperationalWarningText & {
      readonly code: 'lexical_read_failed';
      readonly reason: RecallLexicalReadFailureReason;
    });

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

const isLexicalReadFailureReason = (value: unknown): value is RecallLexicalReadFailureReason =>
  EffectArray.some(RECALL_LEXICAL_READ_FAILURE_REASONS, reason => reason === value);

/** Doctor cannot find a size-limit failure, so a limit names the request and a defect report instead. */
const SIZE_LIMIT_REMEDIATION =
  'Narrow the query or lower the result limit, then retry. If the failure continues, report a defect with `threadnote report-issue`.';
const OPERATIONAL_REMEDIATION = 'Run `threadnote doctor --dry-run` to inspect the operational failure.';
const LEXICAL_READ_FAILURE_REMEDIATIONS = {
  'output-limit': SIZE_LIMIT_REMEDIATION,
  'input-limit': SIZE_LIMIT_REMEDIATION,
  'invalid-protocol': OPERATIONAL_REMEDIATION,
  'worker-failed': OPERATIONAL_REMEDIATION,
} as const satisfies Record<RecallLexicalReadFailureReason, string>;

/** Missing readiness, elapsed budget and unexpected operational failure stay distinct. */
export function lexicalReadFailureWarning(error: unknown): RecallOperationalWarning {
  if (Predicate.isObject(error) && error._tag === 'RecallReadyReadUnavailable')
    return lexicalIndexUnavailableWarning(error.reason === 'budget-exhausted' ? 'budget-exhausted' : undefined);
  const reason =
    Predicate.isObject(error) &&
    (error._tag === 'RecallReadyReadBoundaryError' || error._tag === 'RecallIndexOperationError') &&
    isLexicalReadFailureReason(error.reason)
      ? error.reason
      : 'worker-failed';
  return {
    code: 'lexical_read_failed',
    reason,
    message: `The ready lexical read failed (${reason}); results may be incomplete.`,
    remediation: LEXICAL_READ_FAILURE_REMEDIATIONS[reason],
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

export function recallReadFailureReason(
  warnings: readonly RecallOperationalWarning[],
): RecallLexicalReadFailureReason | undefined {
  return Option.getOrUndefined(
    EffectArray.findFirst(warnings, warning =>
      warning.code === 'lexical_read_failed' ? Option.some(warning.reason) : Option.none(),
    ),
  );
}

/** Phase-log classification: a failed read also names its closed reason, never payload text. */
export function recallReadPhaseClassification(warnings: readonly RecallOperationalWarning[]): {
  readonly outcome: ReturnType<typeof recallReadPhaseOutcome>;
  readonly errorType?: `lexical_read_failed.${RecallLexicalReadFailureReason}`;
} {
  const outcome = recallReadPhaseOutcome(warnings);
  const reason = recallReadFailureReason(warnings);
  return reason === undefined ? {outcome} : {outcome, errorType: `lexical_read_failed.${reason}`};
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
