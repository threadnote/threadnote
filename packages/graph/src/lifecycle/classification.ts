import {Array as EffectArray2} from 'effect';
import {compareCodeUnits} from '../ordering.js';

export const CODE_GRAPH_LIFECYCLE_STATES = [
  'missing-view',
  'abandoned-build',
  'unreadable-store',
  'corrupt-store',
  'orphaned-sidecar',
  'retired-generation',
  'required-clean-base',
] as const;

export type CodeGraphLifecycleState = (typeof CODE_GRAPH_LIFECYCLE_STATES)[number];

export const CODE_GRAPH_LIFECYCLE_PROTECTIONS = [
  'active-writer',
  'active-lease',
  'active-pin',
  'required-base',
  'live-sibling-consumer',
  'active-maintenance',
] as const;

export type CodeGraphLifecycleProtection = (typeof CODE_GRAPH_LIFECYCLE_PROTECTIONS)[number];

export interface CodeGraphLifecycleClassificationInput {
  /** Destructive authority must be positive and current; age is never authority. */
  readonly authority: 'not-applicable' | 'proven-disposable' | 'unproven';
  readonly protections?: readonly CodeGraphLifecycleProtection[];
  readonly state: CodeGraphLifecycleState;
}

export type CodeGraphLifecycleClassification =
  | {
      readonly action: 'cleanup-sidecar' | 'reclaim-generation' | 'remove-view-pointer' | 'retire-abandoned-build';
      readonly disposition: 'reclaim';
      readonly protections: readonly [];
      readonly reason: 'authority-proven';
      readonly state: Exclude<CodeGraphLifecycleState, 'corrupt-store' | 'required-clean-base' | 'unreadable-store'>;
    }
  | {
      readonly action: 'preserve';
      readonly disposition: 'preserve';
      readonly protections: readonly CodeGraphLifecycleProtection[];
      readonly reason: 'protected' | 'required-clean-base';
      readonly state: CodeGraphLifecycleState;
    }
  | {
      readonly action: 'manual-rebuild' | 'retry-observation' | 'verify-authority';
      readonly disposition: 'observe';
      readonly protections: readonly CodeGraphLifecycleProtection[];
      readonly reason: 'confirmed-corruption' | 'insufficient-authority' | 'unreadable';
      readonly state: CodeGraphLifecycleState;
    };

/**
 * One path-free lifecycle admission policy shared by diagnostics and every
 * automatic destructive boundary. Corruption and unreadability remain
 * non-destructive; only an exact, current authority proof can select reclaim.
 */
export function classifyCodeGraphLifecycle(
  input: CodeGraphLifecycleClassificationInput,
): CodeGraphLifecycleClassification {
  const protections = normalizeProtections(input.protections ?? []);
  if (input.state === 'required-clean-base') {
    return {
      action: 'preserve',
      disposition: 'preserve',
      protections,
      reason: 'required-clean-base',
      state: input.state,
    };
  }
  if (input.state === 'corrupt-store') {
    return {
      action: 'manual-rebuild',
      disposition: 'observe',
      protections,
      reason: 'confirmed-corruption',
      state: input.state,
    };
  }
  if (input.state === 'unreadable-store') {
    return {
      action: 'retry-observation',
      disposition: 'observe',
      protections,
      reason: 'unreadable',
      state: input.state,
    };
  }
  if (protections.length > 0) {
    return {
      action: 'preserve',
      disposition: 'preserve',
      protections,
      reason: 'protected',
      state: input.state,
    };
  }
  if (input.authority !== 'proven-disposable') {
    return {
      action: 'verify-authority',
      disposition: 'observe',
      protections,
      reason: 'insufficient-authority',
      state: input.state,
    };
  }
  return {
    action: reclaimAction(input.state),
    disposition: 'reclaim',
    protections: [],
    reason: 'authority-proven',
    state: input.state,
  };
}

export interface CodeGraphLifecycleCandidate {
  readonly id: string;
  readonly lifecycle: CodeGraphLifecycleClassificationInput;
}

/** Deterministically selects one bounded reclaim page without mutating input. */
export function planCodeGraphLifecycleReclamation(
  candidates: readonly CodeGraphLifecycleCandidate[],
  limit: number,
): readonly CodeGraphLifecycleCandidate[] {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(64, limit)) : 0;
  if (boundedLimit === 0) return [];
  const unique = new Map<string, CodeGraphLifecycleCandidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.id) && classifyCodeGraphLifecycle(candidate.lifecycle).disposition === 'reclaim') {
      unique.set(candidate.id, candidate);
    }
  }
  return [...unique.values()].sort((left, right) => compareCodeUnits(left.id, right.id)).slice(0, boundedLimit);
}

function normalizeProtections(
  protections: readonly CodeGraphLifecycleProtection[],
): readonly CodeGraphLifecycleProtection[] {
  const known = new Set<CodeGraphLifecycleProtection>(CODE_GRAPH_LIFECYCLE_PROTECTIONS);
  return [
    ...new Set(
      EffectArray2.filter(
        protections,
        (protection, __effectArrayIndex) => __effectArrayIndex in protections && known.has(protection),
      ),
    ),
  ].sort(compareCodeUnits);
}

function reclaimAction(
  state: Exclude<CodeGraphLifecycleState, 'corrupt-store' | 'required-clean-base' | 'unreadable-store'>,
): Extract<CodeGraphLifecycleClassification, {readonly disposition: 'reclaim'}>['action'] {
  switch (state) {
    case 'missing-view':
      return 'remove-view-pointer';
    case 'abandoned-build':
      return 'retire-abandoned-build';
    case 'orphaned-sidecar':
      return 'cleanup-sidecar';
    case 'retired-generation':
      return 'reclaim-generation';
  }
}
