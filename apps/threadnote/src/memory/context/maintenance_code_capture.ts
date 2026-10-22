import {Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {CodeGraphSymbol} from '@threadnote/graph/types';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {captureMemoryCodeCitations, memoryCodeCitationProjectScopeReceipt} from '@threadnote/context/citation/capture';
import {
  readContextHealthCitationEvidence,
  type ContextHealthCitationSourceExcerptV1,
} from '@threadnote/context/citation_validation';

/** Select a new current observation, never validate or relocate the historical pin. */
export function exactAutomaticCurrentSymbol(
  citation: MemoryCodeCitationV1,
  repositoryId: string,
  symbols: readonly CodeGraphSymbol[],
  truncated: boolean,
) {
  const target = citation.target;
  if (target.kind !== 'symbol' || citation.repositoryId !== repositoryId || truncated) return undefined;
  const exact = symbols.filter(
    symbol =>
      symbol.path === citation.path &&
      symbol.language === target.language &&
      symbol.kind === target.symbolKind &&
      symbol.name === target.name &&
      symbol.qualifiedName === target.qualifiedName,
  );
  return exact.length === 1 ? exact[0] : undefined;
}

export function automaticSymbolSelectorKey(citation: MemoryCodeCitationV1) {
  const target = citation.target;
  return target.kind === 'symbol'
    ? JSON.stringify([
        citation.repositoryId,
        citation.path,
        target.language,
        target.symbolKind,
        target.name,
        target.qualifiedName,
      ])
    : undefined;
}

/** Normal current validation can retain the exact old descriptor when the symbol still matches. */
export function automaticSupportedSymbolMatchesExcerpt(
  citation: MemoryCodeCitationV1,
  excerpt: ContextHealthCitationSourceExcerptV1,
) {
  const target = citation.target;
  return (
    target.kind === 'symbol' &&
    excerpt.provenance === 'current-verified' &&
    excerpt.supportsCitation &&
    !excerpt.truncated &&
    citation.repositoryId === excerpt.source.repositoryId &&
    citation.path === excerpt.source.path &&
    citation.sourceDirty === excerpt.source.sourceDirty &&
    citation.extractorSet === excerpt.source.extractorSet
  );
}

/** Newly captured pins additionally match every current source identity; history is never relabelled. */
export function automaticCurrentSymbolMatchesExcerpt(
  citation: MemoryCodeCitationV1,
  excerpt: ContextHealthCitationSourceExcerptV1,
) {
  const target = citation.target;
  return (
    automaticSupportedSymbolMatchesExcerpt(citation, excerpt) &&
    target.kind === 'symbol' &&
    citation.sourceCommit === excerpt.source.sourceCommit &&
    citation.sourceSnapshotId === excerpt.source.sourceSnapshotId &&
    citation.fileContentHash.value === excerpt.source.fileContentHash &&
    target.span.line === excerpt.startLine &&
    target.span.endLine - (target.span.endColumn === 1 && target.span.endLine > target.span.line ? 1 : 0) ===
      excerpt.endLine
  );
}

/** Existing ready graph + exact declared selector -> separately fenced current typed citation. */
export const captureAutomaticCurrentSymbol = Effect.fn('automaticPreparation.captureCurrentSymbol')(function* (
  config: RuntimeConfig,
  root: string,
  citation: MemoryCodeCitationV1,
  project?: string,
) {
  if (citation.target.kind !== 'symbol') return undefined;
  const target = citation.target;
  const query = yield* CodeGraphQueryService;
  const status = yield* query.status(config.agentContextHome, root, {
    project,
    manifestPath: config.manifestPath,
    requestMaintenance: false,
    observeWorktree: true,
  });
  if (
    status.stale ||
    status.freshness !== 'current' ||
    !status.readySnapshot ||
    status.identity.repositoryId !== citation.repositoryId ||
    (status.identity.remoteIdentity ? 'remote' : 'local') !== citation.repositoryIdentityKind ||
    status.projectCoverage?.completeness !== 'complete' ||
    (project !== undefined && status.projectCoverage.project !== project)
  )
    return undefined;
  const store = yield* CodeGraphStore;
  const found = yield* store.withSession(
    status.databasePath,
    Effect.acquireUseRelease(
      store.acquireSnapshotLease(status.databasePath, status.readySnapshot.id, 60_000),
      () =>
        store.effectiveSnapshotCitationEvidence(status.databasePath, status.readySnapshot!.id, {
          semanticLocators: [
            {
              version: 1,
              kind: target.symbolKind,
              language: target.language,
              name: target.name,
              qualifiedName: target.qualifiedName,
            },
          ],
          limitPerSemanticLocator: 2,
        }),
      token => store.releaseSnapshotLease(status.databasePath, token).pipe(Effect.ignore),
    ),
  );
  const matches = found.symbolsBySemanticLocators;
  if (matches.length !== 1) return undefined;
  const symbol = exactAutomaticCurrentSymbol(
    citation,
    status.identity.repositoryId,
    matches[0].symbols,
    matches[0].truncated,
  );
  if (!symbol) return undefined;
  const captured = yield* captureMemoryCodeCitations(config, {
    callerCwd: root,
    project,
    expectedCallerIdentity: status.identity,
    expectedProjectScope: memoryCodeCitationProjectScopeReceipt(status) ?? {kind: 'full'},
    planOnly: true,
    refs: [symbol.id],
  });
  if (captured.length !== 1) return undefined;
  const current = captured[0];
  // A different ready snapshot after selection must be selected again by a later ordinary preparation tick.
  if (current.sourceSnapshotId !== status.readySnapshot.id || current.target.kind !== 'symbol') return undefined;
  const read = yield* readContextHealthCitationEvidence(config, {kind: 'repository', callerCwd: root}, current, {
    maximumBytes: 4096,
    maximumLines: 24,
    symbolSpanOnly: true,
  });
  const excerpt = read.excerpts.find(item => automaticCurrentSymbolMatchesExcerpt(current, item));
  return excerpt ? {citation: current, excerpt, generation: read.generation} : undefined;
});
