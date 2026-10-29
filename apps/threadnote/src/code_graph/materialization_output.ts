import {Array as EffectArray} from 'effect';
import {materializationStorageShortfalls} from '@threadnote/graph/indexer/materialization';
import type {
  CodeGraphOverlayFallbackAssessment,
  CodeGraphOverlayFallbackBoundary,
  CodeGraphProgress,
} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function renderFallbackAssessment(
  assessment: CodeGraphOverlayFallbackAssessment | undefined,
): string | undefined {
  if (assessment === undefined) return undefined;
  return `assessment: ${Effect2.pipe(assessment.detail, EffectString.replaceAll('-', ' '))} (${assessment.changedFiles.toLocaleString()} changed)`;
}

export function renderFallbackBoundary(boundary: CodeGraphOverlayFallbackBoundary | undefined): string | undefined {
  if (boundary === undefined) return undefined;
  return (
    `boundary: ${Effect2.pipe(boundary.metric, EffectString.replaceAll('-', ' '))} ` +
    `${boundary.observedAtDecision.toLocaleString()} > ${boundary.limit.toLocaleString()} ` +
    `(${boundary.changedFiles.toLocaleString()} changed)`
  );
}

export function materializationDiskWarning(
  storage:
    | NonNullable<NonNullable<Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['metrics']>['storage']>
    | undefined,
): string | undefined {
  if (!storage) return undefined;
  const shortfalls = materializationStorageShortfalls(storage);
  if (shortfalls.length === 0) return undefined;
  if (shortfalls[0] === 'shared') {
    return (
      `low disk: ${formatBytes(storage.availableBytes)} available is below the ` +
      `${formatBytes(storage.estimatedRequiredBytes)} conservative combined estimate; ` +
      'indexing continues with live telemetry'
    );
  }
  const scopes = EffectArray.map(shortfalls, scope => {
    const available = scope === 'temporary' ? storage.temporaryAvailableBytes : storage.durableAvailableBytes;
    const required =
      scope === 'temporary'
        ? storage.estimatedTemporaryFilesystemRequiredBytes
        : storage.estimatedDurableFilesystemRequiredBytes;
    return `${scope} filesystem (${formatBytes(available)} available, ${formatBytes(required)} estimated)`;
  });
  return `low disk on ${EffectArray.join(scopes, ' and ')}; indexing continues with live telemetry`;
}

export function activeBatchNumber(completed: number, total: number): number {
  return total === 0 ? 0 : Math.min(total, completed + 1);
}

export function materializationStageLabel(
  stage: NonNullable<Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['activity']>['stage'],
): string {
  switch (stage) {
    case 'loading-cache':
      return 'loading cached facts';
    case 'attributing':
      return 'attributing facts';
    case 'preparing-rows':
      return 'preparing rows';
    case 'restoring-indexes':
      return 'restoring query indexes';
    case 'writing-analysis':
      return 'writing analysis summary';
    case 'writing-symbols':
      return 'writing symbols';
    case 'writing-lookups':
      return 'writing lookup keys';
    case 'writing-terms':
      return 'writing lexical terms';
    case 'writing-edges':
      return 'writing relationships';
    case 'writing-references':
      return 'writing references';
    case 'writing-receipt':
      return 'recording resumable batch';
    case 'writing-candidates':
      return 'writing reference candidates';
    case 'writing-facts':
      return 'writing graph facts';
    case 'committing':
      return 'committing batch';
  }
}

export function renderMaterializationRows(
  rows:
    | {
        readonly edges?: number;
        readonly deduplicatedEdges?: number;
        readonly deduplicatedReferences?: number;
        readonly lookupKeys?: number;
        readonly referenceCandidates?: number;
        readonly references?: number;
        readonly reexports?: number;
        readonly symbols?: number;
        readonly terms?: number;
      }
    | undefined,
): string | undefined {
  if (!rows) return undefined;
  const values = EffectArray.filter(
    [
      rows.symbols === undefined ? undefined : `${rows.symbols.toLocaleString()} symbols`,
      rows.lookupKeys === undefined ? undefined : `${rows.lookupKeys.toLocaleString()} lookup keys`,
      rows.terms === undefined ? undefined : `${rows.terms.toLocaleString()} terms`,
      rows.edges === undefined ? undefined : `${rows.edges.toLocaleString()} relationships`,
      rows.references === undefined ? undefined : `${rows.references.toLocaleString()} references`,
      rows.referenceCandidates === undefined ? undefined : `${rows.referenceCandidates.toLocaleString()} candidates`,
      rows.reexports === undefined ? undefined : `${rows.reexports.toLocaleString()} re-exports`,
      rows.deduplicatedEdges === undefined || rows.deduplicatedEdges === 0
        ? undefined
        : `${rows.deduplicatedEdges.toLocaleString()} repeated relationships collapsed`,
      rows.deduplicatedReferences === undefined || rows.deduplicatedReferences === 0
        ? undefined
        : `${rows.deduplicatedReferences.toLocaleString()} repeated resolution records collapsed`,
    ],
    (value): value is string => value !== undefined,
  );
  return values.length > 0 ? EffectArray.join(values, ', ') : undefined;
}

export function formatMilliseconds(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  if (milliseconds < 1) return '<1ms';
  if (milliseconds < 1_000) return `${milliseconds.toFixed(milliseconds >= 100 ? 0 : 1)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 1 : 2)}s`;
}
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}
