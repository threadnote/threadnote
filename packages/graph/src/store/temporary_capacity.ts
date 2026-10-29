import {Array as EffectArray} from 'effect';
import {
  codeGraphUtf8ByteLength,
  saturatingCapacityAdd,
  saturatingCapacityMultiply,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '../disk/capacity.js';
import {isCodeGraphReferenceWithinCandidateBudget} from '../fact/budget.js';
import {symbolTerms} from './utilities.js';
import {type CodeGraphWorkspace} from '../languages/types.js';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import {
  type CodeGraphEdge,
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphReference,
  type CodeGraphSymbol,
} from '../types.js';
import * as EffectRecord from 'effect/Record';

export interface CodeGraphTemporaryPublicationCounts {
  readonly edges: number;
  readonly files: number;
  readonly lookupKeys: number;
  readonly reexports: number;
  readonly symbols: number;
  readonly terms: number;
  readonly workspaceRows: number;
}

export function temporaryActivationInventoryCapacity(
  files: readonly CodeGraphInventoryFile[],
): CodeGraphDirectPersistentCapacityBoundary {
  return temporaryBoundary(
    'stage temporary code graph inventory',
    files.length,
    saturatingCapacityAdd(encodedBytes(files), maximumRetainedRawAliasBytes(files)),
  );
}

export function temporaryActivationWorkspaceCapacity(
  workspace: CodeGraphWorkspace,
): CodeGraphDirectPersistentCapacityBoundary {
  const dependencyRows = EffectArray.reduce(workspace.projects, 0, (total, project) =>
    saturatingCapacityAdd(
      total,
      project.dependencyDetails.length,
      project.externalDependencies?.length ?? 0,
      project.monikers?.length ?? 0,
    ),
  );
  return temporaryBoundary(
    'stage temporary code graph workspace',
    saturatingCapacityAdd(workspace.workspaces.length, workspace.projects.length, dependencyRows),
    encodedBytes(workspace),
  );
}

export function temporaryActivationFactsCapacity(
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
  monikers: readonly CodeGraphMonikerV1[] = [],
): CodeGraphDirectPersistentCapacityBoundary {
  const boundedReferences = EffectArray.filter(
    references,
    (__effectFilterValue: (typeof references)[number], __effectFilterIndex: number) =>
      __effectFilterIndex in references && isCodeGraphReferenceWithinCandidateBudget(__effectFilterValue),
  );
  const lookupRows = EffectArray.reduce(symbols, 0, (total, symbol) =>
    saturatingCapacityAdd(total, symbol.lookupKeys?.length ?? 0),
  );
  const termRows = EffectArray.reduce(symbols, 0, (total, symbol) =>
    saturatingCapacityAdd(total, symbolTerms(symbol).length),
  );
  const candidateRows = EffectArray.reduce(boundedReferences, 0, (total, reference) =>
    saturatingCapacityAdd(
      total,
      EffectArray.reduce(reference.lookupTiers, 0, (tierTotal, tier) => saturatingCapacityAdd(tierTotal, tier.length)),
    ),
  );
  const rowCount = saturatingCapacityAdd(
    symbols.length,
    lookupRows,
    termRows,
    edges.length,
    boundedReferences.length,
    candidateRows,
    monikers.length,
    // Every reference can contribute at most one bounded provenance row per
    // candidate. This intentionally over-reserves malformed duplicate input.
    candidateRows,
  );
  return temporaryBoundary(
    'stage temporary code graph facts',
    rowCount,
    encodedBytes([symbols, edges, boundedReferences, monikers]),
  );
}

export function temporaryIncrementalActivationCapacity(
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
  deletedPaths: readonly string[] = [],
  carried?: {readonly stagedPayloadBytes: number; readonly stagedRows: number},
): CodeGraphDirectPersistentCapacityBoundary {
  const factsCapacity = temporaryActivationFactsCapacity(
    EffectArray.flatMap(facts, fact => fact.symbols),
    EffectArray.flatMap(facts, fact => fact.edges),
    EffectArray.flatMap(facts, fact => fact.references ?? []),
    EffectArray.flatMap(facts, fact => fact.monikers ?? []),
  );
  return temporaryBoundary(
    'prepare temporary incremental code graph activation',
    saturatingCapacityAdd(
      files.length,
      deletedPaths.length,
      factsCapacity.rowCount,
      carried?.stagedRows ?? 0,
      // Replacement deletes and reinserts each staged row; reserve a second
      // copy so the preflight cannot rely on SQLite freeing pages immediately.
      factsCapacity.rowCount,
    ),
    saturatingCapacityAdd(
      encodedBytes([files, deletedPaths]),
      maximumRetainedRawAliasBytes(files),
      factsCapacity.finalFactBytes,
      carried?.stagedPayloadBytes ?? 0,
    ),
  );
}

export function temporaryActivationPublicationCapacity(
  counts: CodeGraphTemporaryPublicationCounts,
): CodeGraphDirectPersistentCapacityBoundary {
  const values = EffectRecord.values(counts);
  const valid = EffectArray.every(values, value => Number.isSafeInteger(value) && value >= 0);
  const sourceRows = valid
    ? EffectArray.reduce(values, 0, (total, value) => saturatingCapacityAdd(total, value))
    : Number.NaN;
  return {
    finalFactBytes: 0,
    operation: 'publish temporary code graph snapshot',
    // Copy rows plus compact lexical dictionaries, receipts, state, leases,
    // deletion markers, and analysis aggregates. The 2x source-row envelope
    // is conservative while row calibration supplies the byte floor.
    rowCount: valid ? saturatingCapacityAdd(saturatingCapacityMultiply(sourceRows, 2), 32) : Number.NaN,
    transientFilesystem: 'durable',
  };
}

function temporaryBoundary(
  operation: Extract<
    CodeGraphDirectPersistentCapacityBoundary['operation'],
    | 'prepare temporary incremental code graph activation'
    | 'stage temporary code graph facts'
    | 'stage temporary code graph inventory'
    | 'stage temporary code graph workspace'
  >,
  rowCount: number,
  finalFactBytes: number,
): CodeGraphDirectPersistentCapacityBoundary {
  return {
    finalFactBytes,
    mainFilesystem: 'temporary',
    operation,
    rowCount,
    transientFilesystem: 'temporary',
  };
}

function encodedBytes(value: unknown): number {
  try {
    return codeGraphUtf8ByteLength(JSON.stringify(value));
  } catch {
    return Number.NaN;
  }
}

function maximumRetainedRawAliasBytes(files: readonly CodeGraphInventoryFile[]): number {
  return saturatingCapacityMultiply(
    64,
    EffectArray.reduce(files, 0, (count, file) => count + (file.rawContentHash === undefined ? 1 : 0)),
  );
}
