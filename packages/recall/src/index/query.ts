import {indexTerms} from './lexical.js';
import {Array as EffectArray} from 'effect';

const LOGICAL_RESULT_OVERFETCH_MULTIPLIER = 8;
const MINIMUM_LOGICAL_RESULT_OVERFETCH = 256;
const MAXIMUM_LOGICAL_RESULT_OVERFETCH = 4_096;

/** Independent newest-topical candidates admitted before the final rank window. */
export const RECALL_RECENCY_CANDIDATE_RESERVE = 10;
/** Slight overfetch lets the normal topical ranker reject weak timestamp-only matches. */
export const RECALL_RECENCY_RETRIEVAL_LIMIT = 64;

type RecallStatisticRequest =
  | {readonly query?: string}
  | {readonly selections: readonly {readonly query?: string}[]}
  | {readonly terms: readonly string[]};

export function boundedRecallPhysicalCandidateLimit(logicalLimit: number): number {
  return Math.min(
    MAXIMUM_LOGICAL_RESULT_OVERFETCH,
    Math.max(MINIMUM_LOGICAL_RESULT_OVERFETCH, logicalLimit * LOGICAL_RESULT_OVERFETCH_MULTIPLIER),
  );
}

export function recallStatisticTerms(options: RecallStatisticRequest): readonly string[] {
  if ('terms' in options) return [];
  const queries =
    'selections' in options
      ? EffectArray.flatMap(options.selections, selection => (selection.query === undefined ? [] : [selection.query]))
      : options.query === undefined
        ? []
        : [options.query];
  return [...new Set(EffectArray.flatMap(queries, indexTerms))];
}
