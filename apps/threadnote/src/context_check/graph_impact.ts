import {Array as EffectArray} from 'effect';
import type {CodeGraphQueryResult} from '@threadnote/graph/types';
import {UNAVAILABLE_IMPACT_BASE_WARNING} from '@threadnote/graph/query/impact_base';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {MemoryRecord} from '@threadnote/memory/document';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

export const MAXIMUM_CONTEXT_CHECK_CAPTURE_ADVISORIES = 8 as const;

export type ContextCheckGraphImpactEvidenceV1 =
  | {
      readonly reason: 'graph-impact-evidence-incomplete' | 'graph-impact-evidence-unavailable';
      readonly status: 'unknown';
    }
  | {
      readonly captureAdvisoryIds: readonly string[];
      readonly impactedMemoryUris: readonly string[];
      readonly status: 'complete';
    };

export function selectContextCheckGraphImpact(
  result: CodeGraphQueryResult | undefined,
  records: readonly MemoryRecord[],
  repositoryId: string,
  changedPaths: readonly string[],
  directlyAffectedMemoryUris: readonly string[],
): ContextCheckGraphImpactEvidenceV1 {
  if (result === undefined || result.operation !== 'impact' || result.repository.repositoryId !== repositoryId) {
    return {reason: 'graph-impact-evidence-unavailable', status: 'unknown'};
  }
  if (!completeImpactResult(result, changedPaths)) {
    return {reason: 'graph-impact-evidence-incomplete', status: 'unknown'};
  }

  const changed = new Set(changedPaths);
  const indirectlyImpactedNodes = EffectArray.filter(result.nodes, node => !changed.has(node.path));
  const impactedNodeIds = new Set(EffectArray.map(indirectlyImpactedNodes, node => node.id));
  const impactedPaths = new Set(EffectArray.map(indirectlyImpactedNodes, node => node.path));
  const directUris = new Set(directlyAffectedMemoryUris);
  const impactedRecords = EffectArray.filter(
    records,
    record =>
      !directUris.has(record.uri) &&
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(record.metadata.codeCitations), __effectArrayReceiver =>
          EffectArray.some(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(citation =>
                citation.repositoryId === repositoryId &&
                (impactedPaths.has(citation.path) ||
                  (citation.target.kind === 'symbol' && impactedNodeIds.has(citation.target.nodeId))))(
                __effectArrayValue,
              ),
          ),
        ),
      ) === true,
  );
  const citedNodeIds = new Set<string>();
  const citedPaths = new Set<string>();
  const coveredRecords = EffectArray.filter(
    records,
    (record, __effectArrayIndex2) =>
      __effectArrayIndex2 in records && (directUris.has(record.uri) || impactedRecords.includes(record)),
  );
  for (const record of coveredRecords) {
    for (const citation of record.metadata.codeCitations ?? []) {
      if (citation.repositoryId !== repositoryId) continue;
      citedPaths.add(citation.path);
      if (citation.target.kind === 'symbol') citedNodeIds.add(citation.target.nodeId);
    }
  }
  const uncitedImpactKeys = [
    ...new Set(
      EffectArray.flatMap(result.nodes, node =>
        citedPaths.has(node.path) || citedNodeIds.has(node.id) ? [] : [`${node.path}\u0000${node.id}`],
      ),
    ),
  ].sort(compareText);

  return {
    captureAdvisoryIds: EffectArray.map(uncitedImpactKeys.slice(0, MAXIMUM_CONTEXT_CHECK_CAPTURE_ADVISORIES), value =>
      sha256HexSync(`threadnote-context-check-capture-v1\u0000${value}`),
    ),
    impactedMemoryUris: [...new Set(EffectArray.map(impactedRecords, record => record.uri))].sort(compareText),
    status: 'complete',
  };
}

export function citedDocumentCitationUris(
  records: readonly MemoryRecord[],
  repositoryId: string,
  affectedMemoryUris: readonly string[],
): readonly string[] {
  const affected = new Set(affectedMemoryUris);
  return EffectArray.flatMap(
    EffectArray.filter(
      records,
      (record: (typeof records)[number], __effectArrayIndex) =>
        __effectArrayIndex in records && affected.has(record.uri),
    ),
    (record: (typeof records)[number]) =>
      EffectArray.flatMap(record.metadata.codeCitations ?? [], citation =>
        citation.repositoryId === repositoryId && documentationPath(citation.path)
          ? [`${record.uri}#${citation.id}`]
          : [],
      ),
  ).sort(compareText);
}

function completeImpactResult(result: CodeGraphQueryResult, changedPaths: readonly string[]): boolean {
  if (result.freshness !== 'current') return false;
  const warnings = EffectArray.filter(result.warnings, warning => warning !== UNAVAILABLE_IMPACT_BASE_WARNING);
  if (warnings.length > 0) return false;
  if (
    result.warnings.includes(UNAVAILABLE_IMPACT_BASE_WARNING) &&
    !EffectArray.every(changedPaths, path => EffectArray.some(result.nodes, node => node.path === path))
  ) {
    return false;
  }
  const coverage = result.searchCoverage;
  return (
    coverage === undefined ||
    ((coverage.status === 'found' || coverage.status === 'exhaustive') && coverage.limitsReached.length === 0)
  );
}

function documentationPath(path: string): boolean {
  const normalized = Effect.pipe(path, EffectString.toLowerCase);
  return (
    Effect.pipe(normalized, EffectString.startsWith('docs/')) ||
    /(?:^|\/)(?:agents|claude|readme)\.md$/u.test(normalized) ||
    /\.(?:adoc|md|mdx|rst|txt)$/u.test(normalized)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
