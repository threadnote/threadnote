import {codeGraphUtf8ByteLength} from '../disk/capacity.js';
import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM, type MeasuredCodeGraphFact} from '../fact/budget.js';
import {symbolTerms} from '../store/utilities.js';
import {
  PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES,
  PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES,
} from '../store/resolution/candidate_closure.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../types.js';

export const CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES = 128;
export const CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES = 16 * 1_048_576;
/** Matches one governed persistent materialization transaction while retaining 8 MiB per-file batches. */
export const CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES = 32 * 1_048_576;
export const CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES = 4;
export const CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS = 250_000;
/** Persisted rows may be carried without decoding, but remain independently bounded. */
export const CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES = 256;
export const CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES = 16 * 1_048_576;
export const CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS = CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS;

export interface CodeGraphIncrementalFoldForwardPathPlan {
  readonly carriedPaths: readonly string[];
  readonly cumulativePaths: readonly string[];
}

export type CodeGraphIncrementalFactBytesAssessment =
  | {readonly mode: 'eligible'}
  | {readonly mode: 'invalid'}
  | {
      readonly limit: number;
      readonly mode: 'exceeded';
      readonly observedAtDecision: number;
    };

/**
 * Keeps the persisted per-file fact fence independent from the larger aggregate
 * incremental rewrite envelope. Metadata callers use the same exact assessment
 * as final fact-batch admission, so a corrupt oversized cache row still fails
 * closed even when the overall rewrite would fit.
 */
export function assessCodeGraphIncrementalFactBytes(input: {
  readonly aggregateBytes: number;
  readonly factBytes: Iterable<number>;
}): CodeGraphIncrementalFactBytesAssessment {
  let measuredAggregateBytes = 0;
  for (const bytes of input.factBytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return {mode: 'invalid'};
    if (bytes > CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) {
      return {
        limit: CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM,
        mode: 'exceeded',
        observedAtDecision: bytes,
      };
    }
    if (bytes > Number.MAX_SAFE_INTEGER - measuredAggregateBytes) return {mode: 'invalid'};
    measuredAggregateBytes += bytes;
  }
  if (
    !Number.isSafeInteger(input.aggregateBytes) ||
    input.aggregateBytes < 0 ||
    input.aggregateBytes !== measuredAggregateBytes
  ) {
    return {mode: 'invalid'};
  }
  return input.aggregateBytes > CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES
    ? {
        limit: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
        mode: 'exceeded',
        observedAtDecision: input.aggregateBytes,
      }
    : {mode: 'eligible'};
}

/** Exact bounded admission for the default per-file fact batches used by incremental staging. */
export function codeGraphIncrementalFactBatchesFitBudget(
  batches: readonly (readonly Pick<MeasuredCodeGraphFact, 'bytes'>[])[],
): boolean {
  if (batches.length < 1 || batches.length > CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BATCHES) return false;
  let aggregateBytes = 0;
  const factBytes: number[] = [];
  for (const batch of batches) {
    if (batch.length === 0) return false;
    let batchBytes = 0;
    for (const fact of batch) {
      if (!Number.isSafeInteger(fact.bytes) || fact.bytes <= 0) return false;
      if (fact.bytes > Number.MAX_SAFE_INTEGER - batchBytes) return false;
      batchBytes += fact.bytes;
      factBytes.push(fact.bytes);
    }
    if (batchBytes > CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM) return false;
    if (batchBytes > Number.MAX_SAFE_INTEGER - aggregateBytes) return false;
    aggregateBytes += batchBytes;
  }
  return assessCodeGraphIncrementalFactBytes({aggregateBytes, factBytes}).mode === 'eligible';
}

/** Pure bounded set plan shared by admission and truthful materialization reporting. */
export function planCodeGraphIncrementalFoldForwardPaths(
  priorPaths: readonly string[],
  freshPaths: readonly string[],
): CodeGraphIncrementalFoldForwardPathPlan | undefined {
  const prior = new Set(priorPaths);
  const fresh = new Set(freshPaths);
  if (prior.size !== priorPaths.length || fresh.size !== freshPaths.length) return undefined;
  const cumulative = new Set(prior);
  for (const path of fresh) cumulative.add(path);
  if (cumulative.size > CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_FILES) return undefined;
  return {
    carriedPaths: [...prior].filter(path => !fresh.has(path)).sort(),
    cumulativePaths: [...cumulative].sort(),
  };
}

export interface CodeGraphMembershipCandidateWork {
  readonly metadataFiles: number;
  readonly metadataFactBytes: number;
  readonly omittedFiles: number;
  readonly omittedFactBytes: number;
  readonly rawBaseFiles: number;
  readonly rawCurrentFiles: number;
  readonly rawBaseBytes: number;
  readonly rawCurrentBytes: number;
  readonly selectedReloadFiles: number;
  readonly selectedReloadBytes: number;
  readonly projectionObservations: number;
  readonly projectionObservedKeyBytes: number;
}

export interface CodeGraphIncrementalWork {
  readonly membershipCandidate?: CodeGraphMembershipCandidateWork;
  /** Persisted attribution context decoded for this delta. */
  readonly attributionContextFiles: number;
  /** Base final facts decoded for compatibility checks. */
  readonly baseFactsLoaded: number;
  readonly changedFiles: number;
  readonly deletedFiles: number;
  /** Exact UTF-8 bytes of the final attributed facts entering incremental staging. */
  readonly factBytes: number;
  /** Exact rows presented to bounded staging, including changed-path markers. */
  readonly plannedRows: number;
  /** Exact repository-membership candidates batch-probed for attribution. */
  readonly probedDependencyPaths: number;
  readonly sourceBytes: number;
  readonly totalFiles: number;
  /** Inventory rows enumerated in JavaScript before staging. */
  readonly inventoryFilesInspected: number;
}

export type CodeGraphIncrementalWorkObservation = Pick<
  CodeGraphIncrementalWork,
  | 'attributionContextFiles'
  | 'baseFactsLoaded'
  | 'inventoryFilesInspected'
  | 'probedDependencyPaths'
  | 'membershipCandidate'
>;

export function measureCodeGraphIncrementalWork(input: {
  readonly deletedPaths?: readonly string[];
  readonly facts: readonly CodeGraphFileFacts[];
  readonly files: readonly CodeGraphInventoryFile[];
  readonly observation?: CodeGraphIncrementalWorkObservation;
  readonly totalFiles: number;
}): CodeGraphIncrementalWork {
  const deletedFiles = new Set(input.deletedPaths ?? []).size;
  const factBytes = input.facts.reduce((total, facts) => total + codeGraphUtf8ByteLength(JSON.stringify(facts)), 0);
  let factRows = 0;
  for (const facts of input.facts) {
    factRows += facts.symbols.length;
    factRows += facts.symbols.reduce((total, symbol) => total + (symbol.lookupKeys?.length ?? 0), 0);
    factRows += facts.symbols.reduce((total, symbol) => total + symbolTerms(symbol).length, 0);
    factRows += facts.edges.length;
    const references = facts.references ?? [];
    factRows += references.length;
    factRows += references.reduce(
      (total, reference) => total + reference.lookupTiers.reduce((tierTotal, tier) => tierTotal + tier.length, 0),
      0,
    );
  }
  return {
    ...(input.observation?.membershipCandidate ? {membershipCandidate: input.observation.membershipCandidate} : {}),
    attributionContextFiles: input.observation?.attributionContextFiles ?? 0,
    baseFactsLoaded: input.observation?.baseFactsLoaded ?? input.files.length,
    changedFiles: input.files.length,
    deletedFiles,
    factBytes,
    plannedRows: input.files.length + deletedFiles + factRows,
    probedDependencyPaths: input.observation?.probedDependencyPaths ?? 0,
    sourceBytes: input.files.reduce((total, file) => total + file.size, 0),
    totalFiles: input.totalFiles,
    inventoryFilesInspected: input.observation?.inventoryFilesInspected ?? input.totalFiles,
  };
}

export function codeGraphIncrementalWorkFitsBudget(work: CodeGraphIncrementalWork): boolean {
  const candidate = work.membershipCandidate;
  if (
    candidate &&
    (Object.values(candidate).some(value => !Number.isSafeInteger(value) || value < 0) ||
      candidate.metadataFiles > PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES ||
      candidate.metadataFactBytes > PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES ||
      candidate.omittedFiles + candidate.rawBaseFiles + candidate.rawCurrentFiles < candidate.metadataFiles ||
      candidate.omittedFactBytes + candidate.rawBaseBytes + candidate.rawCurrentBytes !== candidate.metadataFactBytes ||
      candidate.selectedReloadFiles !== work.changedFiles)
  )
    return false;
  return (
    Number.isSafeInteger(work.changedFiles) &&
    (work.changedFiles > 0 || work.deletedFiles > 0) &&
    work.changedFiles <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES &&
    Number.isSafeInteger(work.attributionContextFiles) &&
    work.attributionContextFiles >= 0 &&
    work.attributionContextFiles <= 10_000 &&
    Number.isSafeInteger(work.baseFactsLoaded) &&
    work.baseFactsLoaded >= 0 &&
    work.baseFactsLoaded <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES &&
    Number.isSafeInteger(work.deletedFiles) &&
    work.deletedFiles >= 0 &&
    Number.isSafeInteger(work.totalFiles) &&
    work.totalFiles >= work.changedFiles &&
    Number.isSafeInteger(work.inventoryFilesInspected) &&
    work.inventoryFilesInspected >= work.changedFiles &&
    work.inventoryFilesInspected <= work.totalFiles &&
    Number.isSafeInteger(work.probedDependencyPaths) &&
    work.probedDependencyPaths >= 0 &&
    work.probedDependencyPaths <= 4_096 &&
    Number.isSafeInteger(work.sourceBytes) &&
    work.sourceBytes >= 0 &&
    work.sourceBytes <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES &&
    Number.isSafeInteger(work.factBytes) &&
    work.factBytes >= 0 &&
    work.factBytes <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES &&
    Number.isSafeInteger(work.plannedRows) &&
    work.plannedRows > 0 &&
    work.plannedRows <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS
  );
}
