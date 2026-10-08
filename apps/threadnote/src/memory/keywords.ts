import {Console, Effect} from 'effect';
import {isMemoryKeywordEnrichmentEligible, normalizeManualMemoryKeywords} from '../effect/ai/enrichment.js';
import {MemoryOperationError} from './migrations.js';
import type {MemoryKind} from '@threadnote/memory/types';

export type MemoryKeywordPlan =
  | {readonly mode: 'explicit'; readonly keywords: readonly string[]}
  | {readonly mode: 'cleared'}
  | {readonly mode: 'regenerate'}
  | {readonly mode: 'preserved'; readonly keywords: readonly string[]}
  | {readonly mode: 'automatic'};

export interface MemoryKeywordPlanInput {
  readonly keywords?: readonly string[];
  readonly clearKeywords?: boolean;
  readonly regenerateKeywords?: boolean;
  readonly replacedKeywords?: readonly string[];
  readonly shared?: boolean;
  readonly kind?: MemoryKind;
  readonly surface?: 'cli' | 'mcp';
}

/**
 * Replacement keeps the established retrieval contract unless the caller says
 * otherwise. Explicit keywords win, clearing is explicit, regeneration is
 * explicit, personal, and limited to enrichment-eligible kinds; anything else
 * preserves prior keywords, and a replace without usable prior keywords falls
 * through to automatic enrichment.
 */
export function resolveMemoryKeywordPlan(input: MemoryKeywordPlanInput): MemoryKeywordPlan {
  const names =
    input.surface === 'mcp'
      ? 'keywords, clearKeywords, or regenerateKeywords'
      : '--keyword, --clear-keywords, or --regenerate-keywords';
  const explicit = input.keywords !== undefined;
  const clear = input.clearKeywords === true;
  const regenerate = input.regenerateKeywords === true;
  if ([explicit, clear, regenerate].filter(Boolean).length > 1) {
    throw MemoryOperationError.make({message: `Choose only one of ${names}.`});
  }
  const hasPriorKeywords = (input.replacedKeywords?.length ?? 0) > 0;
  if (explicit && input.kind === 'smoke') {
    throw MemoryOperationError.make({message: 'Keyword authoring is not supported for smoke memories.'});
  }
  // Explicit handoff keywords are caller-authored retrieval evidence. Generated
  // phrases can invert precise continuation status, so generation stays gated.
  if (regenerate && input.kind !== undefined && !isMemoryKeywordEnrichmentEligible(input.kind)) {
    throw MemoryOperationError.make({message: `Keyword regeneration is not supported for ${input.kind} memories.`});
  }
  if (explicit) {
    const normalized = normalizeManualMemoryKeywords(input.keywords ?? []);
    if (normalized.length === 0) {
      throw MemoryOperationError.make({message: 'Provide at least one non-empty keyword.'});
    }
    return {mode: 'explicit', keywords: normalized};
  }
  if (clear) {
    return hasPriorKeywords ? {mode: 'cleared'} : {mode: 'automatic'};
  }
  if (regenerate) {
    if (input.shared === true) {
      throw MemoryOperationError.make({
        message:
          'Keyword regeneration is not supported for shared memory; set keywords explicitly or omit keyword flags to preserve them.',
      });
    }
    return {mode: 'regenerate'};
  }
  if (hasPriorKeywords) {
    const preserved = normalizeManualMemoryKeywords(input.replacedKeywords ?? []);
    return preserved.length > 0 ? {mode: 'preserved', keywords: preserved} : {mode: 'automatic'};
  }
  return {mode: 'automatic'};
}

export function tryResolveMemoryKeywordPlan(
  input: MemoryKeywordPlanInput,
): {readonly plan: MemoryKeywordPlan} | {readonly message: string} {
  try {
    return {plan: resolveMemoryKeywordPlan(input)};
  } catch (cause) {
    return {message: cause instanceof Error ? cause.message : String(cause)};
  }
}

export function resolveReplaceKeywordPlan(
  options: {
    readonly keywords?: readonly string[];
    readonly clearKeywords?: boolean;
    readonly regenerateKeywords?: boolean;
    readonly kind?: MemoryKind;
  },
  replaced: {readonly metadata: {readonly keywords?: readonly string[]}} | undefined,
  shared: boolean,
): MemoryKeywordPlan {
  return resolveMemoryKeywordPlan({
    keywords: options.keywords,
    clearKeywords: options.clearKeywords,
    regenerateKeywords: options.regenerateKeywords,
    replacedKeywords: replaced?.metadata.keywords,
    shared,
    kind: options.kind,
  });
}

export function shouldEnrichForKeywordPlan(plan: MemoryKeywordPlan): boolean {
  return plan.mode === 'regenerate' || plan.mode === 'automatic';
}

export const logKeywordReplaceReceipt = Effect.fn('memory.logKeywordReplaceReceipt')(function* (
  plan: MemoryKeywordPlan,
  replacedKeywords: readonly string[] | undefined,
  options: {readonly dryRun?: boolean},
) {
  if (options.dryRun === true) return;
  if (plan.mode === 'preserved') {
    yield* Console.log(`Preserved ${plan.keywords.length} prior keyword(s).`);
  } else if (plan.mode === 'cleared' && (replacedKeywords?.length ?? 0) > 0) {
    yield* Console.log(
      `Cleared ${replacedKeywords?.length} prior keyword(s); this cannot be undone. Re-add them explicitly if needed.`,
    );
  }
});
