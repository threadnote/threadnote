import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '@threadnote/graph/citation/source';
import type {CodeGraphQueryResult, RepositoryIdentity} from '@threadnote/graph/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CONTEXT_BRIEF_SOURCE_MAXIMUM_COVERED_REFS, type ContextBriefSourceExcerptV1} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CONTEXT_BRIEF_SOURCE_MAXIMUM_FILES = 3 as const;
export const CONTEXT_BRIEF_SOURCE_MAXIMUM_RANGES_PER_FILE = 2 as const;
export const CONTEXT_BRIEF_SOURCE_MAXIMUM_LINES_PER_RANGE = 24 as const;
const CONTEXT_BRIEF_SOURCE_MAXIMUM_RETAINED_FILE_BYTES = 512 * 1_024;

export interface ContextBriefSourceRangeCandidateV1 {
  readonly contentHash: string;
  readonly coveredGraphRefs: readonly string[];
  readonly endLine: number;
  readonly path: string;
  readonly rank: number;
  readonly startLine: number;
  readonly truncated?: boolean;
}

export interface ContextBriefSelectedSourceRangeV1 extends ContextBriefSourceRangeCandidateV1 {
  readonly truncated: boolean;
}

export function contextBriefSourceRangeCandidates(
  result: CodeGraphQueryResult,
): readonly ContextBriefSourceRangeCandidateV1[] {
  const nodeRank = new Map(EffectArray.map(result.nodes, (node, rank) => [node.id, rank] as const));
  const byPath = new Map<string, (typeof result.nodes)[number]>();
  for (const node of result.nodes) {
    const existing = byPath.get(node.path);
    if (existing === undefined || (nodeRank.get(node.id) ?? 0) < (nodeRank.get(existing.id) ?? 0)) {
      byPath.set(node.path, node);
    }
  }
  const relationshipFirst = result.operation === 'impact' || result.operation === 'neighbors';
  const relationships = EffectArray.flatMap(result.edges, (edge, rank): ContextBriefSourceRangeCandidateV1[] => {
    if (edge.sourceId === undefined || edge.targetId === undefined) return [];
    const source = byPath.get(edge.evidencePath);
    if (source === undefined) return [];
    return [
      {
        contentHash: source.contentHash,
        coveredGraphRefs: [edge.sourceId, edge.targetId],
        endLine: edge.evidenceSpan.endLine,
        path: edge.evidencePath,
        rank: relationshipFirst ? rank * 2 : result.nodes.length * 2 + rank,
        startLine: edge.evidenceSpan.line,
      },
    ];
  });
  const declarations = EffectArray.map(result.nodes, (node, rank): ContextBriefSourceRangeCandidateV1 => ({
    contentHash: node.contentHash,
    coveredGraphRefs: [node.id],
    endLine: node.span.endLine,
    path: node.path,
    rank: relationshipFirst ? rank * 2 + 1 : rank * 2,
    startLine: node.span.line,
  }));
  return [...relationships, ...declarations];
}

export function selectContextBriefSourceRanges(
  candidates: readonly ContextBriefSourceRangeCandidateV1[],
): readonly ContextBriefSelectedSourceRangeV1[] {
  const normalized = EffectArray.map(
    EffectArray.filter(
      candidates,
      (candidate, __effectArrayIndex) => __effectArrayIndex in candidates && validCandidate(candidate),
    ),
    candidate => {
      const endLine = Math.min(
        candidate.endLine,
        candidate.startLine + CONTEXT_BRIEF_SOURCE_MAXIMUM_LINES_PER_RANGE - 1,
      );
      return {...candidate, endLine, truncated: candidate.truncated === true || endLine < candidate.endLine};
    },
  ).sort(compareCandidates);
  const hashesByPath = new Map<string, Set<string>>();
  for (const candidate of normalized) {
    const hashes = hashesByPath.get(candidate.path) ?? new Set<string>();
    hashes.add(candidate.contentHash);
    hashesByPath.set(candidate.path, hashes);
  }
  const safe = EffectArray.filter(normalized, candidate => hashesByPath.get(candidate.path)?.size === 1);
  const files = EffectArray.map([...new Set(EffectArray.map(safe, candidate => candidate.path))], path => ({
    path,
    rank: Math.min(
      ...EffectArray.map(
        EffectArray.filter(safe, candidate => candidate.path === path),
        candidate => candidate.rank,
      ),
    ),
  }))
    .sort((left, right) => left.rank - right.rank || compareText(left.path, right.path))
    .slice(0, CONTEXT_BRIEF_SOURCE_MAXIMUM_FILES);
  return EffectArray.flatMap(files, ({path}) => {
    const ranges = EffectArray.filter(safe, candidate => candidate.path === path).sort(compareSourceRanges);
    const merged: ContextBriefSelectedSourceRangeV1[] = [];
    for (const range of ranges) {
      const current = merged.at(-1);
      if (current === undefined || range.startLine > current.endLine) {
        merged.push(range);
        continue;
      }
      const naturalEnd = Math.max(current.endLine, range.endLine);
      const endLine = Math.min(naturalEnd, current.startLine + CONTEXT_BRIEF_SOURCE_MAXIMUM_LINES_PER_RANGE - 1);
      merged[merged.length - 1] = {
        ...current,
        coveredGraphRefs: stableStrings([...current.coveredGraphRefs, ...range.coveredGraphRefs]),
        endLine,
        rank: Math.min(current.rank, range.rank),
        truncated: current.truncated || range.truncated || endLine < naturalEnd,
      };
    }
    return merged.sort(compareCandidates).slice(0, CONTEXT_BRIEF_SOURCE_MAXIMUM_RANGES_PER_FILE);
  });
}

export interface ContextBriefSourceEvidenceRequest {
  readonly identity: RepositoryIdentity;
  readonly maximumContentBytes: number;
  readonly repositoryKey: string;
  readonly result: CodeGraphQueryResult;
}

export interface ContextBriefSourceEvidenceResult {
  readonly excerpts: readonly ContextBriefSourceExcerptV1[];
  readonly gaps: readonly string[];
}

export const retrieveContextBriefSourceEvidence = Effect.fn('contextBrief.retrieveSourceEvidence')(function* (
  input: ContextBriefSourceEvidenceRequest,
) {
  const ranges = selectContextBriefSourceRanges(contextBriefSourceRangeCandidates(input.result));
  if (ranges.length === 0) return {excerpts: [], gaps: ['graph-source-selection-empty']} as const;
  const sources = uniqueSources(ranges);
  const resolved = yield* readCodeGraphCitationSources({
    allowCommitFallback: false,
    objectFormat: input.identity.objectFormat,
    repositoryRoot: input.identity.repoRoot,
    retainedBytesLimit: CONTEXT_BRIEF_SOURCE_MAXIMUM_RETAINED_FILE_BYTES * CONTEXT_BRIEF_SOURCE_MAXIMUM_FILES,
    sourceCommit: input.result.snapshot.commit,
    sources: EffectArray.map(sources, source => ({...source, requireBytes: true})),
  });
  const materialized = materializeContextBriefSourceExcerpts({
    dirty: input.result.snapshot.dirty,
    maximumContentBytes: input.maximumContentBytes,
    ranges,
    repositoryId: input.result.repository.repositoryId,
    repositoryKey: input.repositoryKey,
    resolved,
  });
  return materialized.gaps.includes('graph-source-resolution-incomplete')
    ? {
        ...materialized,
        gaps: stableStrings([...materialized.gaps, 'graph-source-snapshot-not-current']),
      }
    : materialized;
});

export function materializeContextBriefSourceExcerpts(input: {
  readonly dirty: boolean;
  readonly maximumContentBytes: number;
  readonly ranges: readonly ContextBriefSelectedSourceRangeV1[];
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly resolved: ReadonlyMap<string, Uint8Array>;
}): {readonly excerpts: readonly ContextBriefSourceExcerptV1[]; readonly gaps: readonly string[]} {
  let remaining = Math.max(0, input.maximumContentBytes);
  let unresolved = 0;
  const excerpts: ContextBriefSourceExcerptV1[] = [];
  for (const range of input.ranges) {
    if (remaining === 0) break;
    const bytes = input.resolved.get(
      codeGraphCitationSourceKey({expectedContentHash: range.contentHash, repositoryPath: range.path}),
    );
    if (bytes === undefined) {
      unresolved += 1;
      continue;
    }
    const content = decodeSource(bytes);
    if (content === undefined) {
      unresolved += 1;
      continue;
    }
    const selected = selectSourceLines(content, range, remaining);
    if (selected === undefined) continue;
    const coveredGraphRefs = range.coveredGraphRefs.slice(0, CONTEXT_BRIEF_SOURCE_MAXIMUM_COVERED_REFS);
    remaining -= new TextEncoder().encode(selected.content).byteLength;
    excerpts.push({
      content: selected.content,
      coveredGraphRefs,
      endLine: selected.endLine,
      evidenceKind: input.dirty ? 'current-dirty-overlay' : 'graph-snapshot',
      freshness: 'fresh',
      id: `cbsx_${Effect2.pipe(
        sha256HexSync(
          EffectArray.join(
            EffectArray.map(
              [input.repositoryId, range.path, range.startLine, selected.endLine, ...coveredGraphRefs],
              item => (item === null || item === undefined ? '' : String(item)),
            ),
            '\u0000',
          ),
        ),
        EffectString.slice(0, 24),
      )}`,
      path: range.path,
      repositoryKey: input.repositoryKey,
      snapshotIdentity: input.dirty ? 'current-dirty-overlay' : 'current-clean',
      startLine: range.startLine,
      truncated: range.truncated || selected.truncated,
    });
  }
  return {
    excerpts,
    gaps: stableStrings([
      ...(unresolved === 0 ? [] : ['graph-source-resolution-incomplete']),
      ...(excerpts.length === 0 ? ['graph-source-evidence-unavailable'] : []),
      ...(excerpts.length < input.ranges.length - unresolved ? ['graph-source-budget-truncated'] : []),
    ]),
  };
}

function selectSourceLines(
  content: string,
  range: ContextBriefSelectedSourceRangeV1,
  maximumBytes: number,
): {readonly content: string; readonly endLine: number; readonly truncated: boolean} | undefined {
  const lines = Effect2.pipe(content, EffectString.split(/\r?\n/u));
  if (range.startLine > lines.length) return undefined;
  const requested = lines.slice(range.startLine - 1, Math.min(range.endLine, lines.length));
  if (requested.length === 0) return undefined;
  const selected: string[] = [];
  let used = 0;
  for (const line of requested) {
    const separator = selected.length === 0 ? '' : '\n';
    const available = maximumBytes - used - new TextEncoder().encode(separator).byteLength;
    if (available <= 0) break;
    if (new TextEncoder().encode(line).byteLength > available) break;
    selected.push(line);
    used += new TextEncoder().encode(`${separator}${line}`).byteLength;
  }
  if (selected.length === 0) return undefined;
  return {
    content: EffectArray.join(selected, '\n'),
    endLine: range.startLine + selected.length - 1,
    truncated: selected.length < requested.length || range.endLine > lines.length,
  };
}

function uniqueSources(ranges: readonly ContextBriefSelectedSourceRangeV1[]) {
  const sources = new Map<string, {readonly expectedContentHash: string; readonly repositoryPath: string}>();
  for (const range of ranges) {
    const source = {expectedContentHash: range.contentHash, repositoryPath: range.path};
    sources.set(codeGraphCitationSourceKey(source), source);
  }
  return [...sources.values()];
}

function decodeSource(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
}

function validCandidate(candidate: ContextBriefSourceRangeCandidateV1): boolean {
  return (
    candidate.path.length > 0 &&
    Number.isSafeInteger(candidate.rank) &&
    candidate.rank >= 0 &&
    Number.isSafeInteger(candidate.startLine) &&
    candidate.startLine >= 1 &&
    Number.isSafeInteger(candidate.endLine) &&
    candidate.endLine >= candidate.startLine &&
    candidate.contentHash.length > 0 &&
    candidate.coveredGraphRefs.length > 0
  );
}

function compareCandidates(
  left: ContextBriefSourceRangeCandidateV1,
  right: ContextBriefSourceRangeCandidateV1,
): number {
  return (
    left.rank - right.rank ||
    compareText(left.path, right.path) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    compareText(EffectArray.join(left.coveredGraphRefs, '\u0000'), EffectArray.join(right.coveredGraphRefs, '\u0000'))
  );
}

function compareSourceRanges(
  left: ContextBriefSourceRangeCandidateV1,
  right: ContextBriefSourceRangeCandidateV1,
): number {
  return (
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    left.rank - right.rank ||
    compareText(EffectArray.join(left.coveredGraphRefs, '\u0000'), EffectArray.join(right.coveredGraphRefs, '\u0000'))
  );
}

function stableStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
