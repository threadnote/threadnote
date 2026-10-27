export interface RecallIndexForegroundFreshness {
  readonly observedCanonicalMutationGeneration: string;
  readonly forceRefresh: boolean;
  readonly initialized: boolean;
  readonly sourceValidationRequired?: boolean;
  readonly integrityCurrent: boolean;
  readonly observedStaleGeneration: string;
  readonly persistedCanonicalMutationGeneration: string;
  readonly persistedStaleGeneration: string;
}

export interface RecallIndexCanonicalMutationContinuity {
  readonly markerCurrentGeneration?: string;
  readonly markerPreviousGeneration?: string;
  readonly observedGeneration: string;
  readonly persistedGeneration: string;
}

export interface RecallIndexCanonicalMutationTransition {
  readonly currentGeneration: string;
  readonly previousGeneration: string;
}

export interface RecallIndexPendingCanonicalMutationContinuity {
  readonly currentGeneration?: string;
  readonly pending: boolean;
  readonly previousGeneration?: string;
}

export interface RecallIndexMergedCanonicalMutationContinuity {
  readonly continuous: boolean;
  readonly currentGeneration?: string;
  readonly previousGeneration?: string;
}

/**
 * Keep ordinary recall reads independent of corpus size. Threadnote-managed
 * writes publish a new stale generation, while explicit maintenance can force
 * a source validation. Wall-clock age alone is not a foreground refresh
 * signal: re-walking every canonical source would otherwise create periodic
 * latency cliffs for unchanged large corpora.
 */
export function recallIndexForegroundRefreshRequired(input: RecallIndexForegroundFreshness): boolean {
  return (
    input.forceRefresh ||
    input.sourceValidationRequired === true ||
    !input.initialized ||
    !input.integrityCurrent ||
    input.persistedCanonicalMutationGeneration !== input.observedCanonicalMutationGeneration ||
    input.persistedStaleGeneration !== input.observedStaleGeneration
  );
}

/**
 * A targeted marker may cover canonical changes only when it proves one
 * unbroken transition from the generation indexed by SQLite to the current
 * durable generation. Missing legacy endpoints and skipped mutations fail
 * closed into a full reconciliation.
 */
export function recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh(
  input: RecallIndexCanonicalMutationContinuity,
): boolean {
  return (
    input.persistedGeneration === input.observedGeneration ||
    (input.markerPreviousGeneration === input.persistedGeneration &&
      input.markerCurrentGeneration === input.observedGeneration)
  );
}

/** Merge consecutive per-URI invalidations without hiding a missing mutation. */
export function mergeRecallIndexCanonicalMutationContinuity(
  previous: RecallIndexPendingCanonicalMutationContinuity | undefined,
  transition: RecallIndexCanonicalMutationTransition | undefined,
): RecallIndexMergedCanonicalMutationContinuity {
  if (transition === undefined) {
    return {
      continuous: true,
      ...(previous?.currentGeneration === undefined ? {} : {currentGeneration: previous.currentGeneration}),
      ...(previous?.previousGeneration === undefined ? {} : {previousGeneration: previous.previousGeneration}),
    };
  }
  if (previous?.pending !== true) {
    return {
      continuous: true,
      currentGeneration: transition.currentGeneration,
      previousGeneration: transition.previousGeneration,
    };
  }
  const continuous =
    previous.currentGeneration !== undefined &&
    previous.previousGeneration !== undefined &&
    previous.currentGeneration === transition.previousGeneration;
  return {
    continuous,
    currentGeneration: transition.currentGeneration,
    previousGeneration: continuous ? previous.previousGeneration : transition.previousGeneration,
  };
}
