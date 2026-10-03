import {DateTime, Effect, FileSystem, Path} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {
  createCodeGraphSourceSpanCanonicalizer,
  type CodeGraphEffectiveFileHashMatches,
  type CodeGraphEffectiveFilePathObservation,
  type CodeGraphEffectiveSnapshotCitationEvidence,
  type CodeGraphEffectiveSymbolLocatorMatches,
  type CodeGraphSymbolSemanticLocatorV1,
} from '@threadnote/graph/citation/primitives';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '@threadnote/graph/citation/source';
import {
  resolveCodeGraphCitationRepositoryRoutes,
  makeCodeGraphCitationRepositoryRouteObservation,
  revalidateCodeGraphCitationRecoveryRoute,
  type CodeGraphCitationRecoveryRouteV1,
} from '@threadnote/graph/citation/recovery';
import {
  readRetainedCodeGraphCitationEvidence,
  retainCodeGraphCitationEvidence,
  type CodeGraphCitationEvidenceSourceV1,
} from '@threadnote/graph/citation/capsule';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {worktreeOverlayState} from '@threadnote/graph/inventory';
import {decodeUtf8} from '@threadnote/graph/inventory/content';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {codeGraphSnapshotRuntimeCurrent} from '@threadnote/graph/query/snapshot_runtime';
import {
  observeCleanRepositoryWorktree,
  resolvePublishedRepositoryReadFence,
  revalidateRepositoryIdentityFence,
} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {
  CodeGraphSnapshot,
  CodeGraphStatus,
  CodeGraphSymbol,
  RepositoryIdentity,
  RepositoryIdentityExpectation,
} from '@threadnote/graph/types';
import {readPublishedCodeGraphWorksetCatalogGeneration} from '@threadnote/graph/workset_catalog/store';
import type {
  CodeGraphWorksetCatalogPublishedGenerationV1,
  CodeGraphWorksetCatalogPublishedMemberV1,
} from '@threadnote/graph/workset_catalog/types';
import {codeGraphWorksetManifestDigest} from '@threadnote/graph/workset_catalog/workset';
import {sha256Hex} from '@threadnote/platform/digest';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {requireWorkset} from '@threadnote/workspace/manifest';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {ResolvedWorkset, RuntimeConfig} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import type {
  ContextBriefCitationValidationFenceV2,
  ContextBriefCitationValidationReceiptV2,
  ContextBriefMemoryCandidateV1,
  ContextBriefMemoryCitationValidationV2,
  ContextBriefScopeV1,
} from './types.js';

export const CONTEXT_BRIEF_MAXIMUM_CITATION_VALIDATIONS = 96 as const;
export const CONTEXT_BRIEF_MAXIMUM_CITED_REPOSITORIES = 32 as const;
export type {ContextHealthCitationSourceExcerptV1} from './citation/evidence_excerpt.js';
import {
  citationSourceExcerpt,
  historicalCitationBytesMatch,
  historicalSnapshotCitationMatches,
  type ContextHealthCitationSourceExcerptV1,
} from './citation/evidence_excerpt.js';

const RELOCATION_MATCH_LIMIT = 2;
const VALIDATION_CONCURRENCY = 4;
const VALIDATION_CACHE_LIMIT = 512;
const validationReceiptCache = new Map<string, ContextBriefCitationValidationReceiptV2>();

/** Bounded read overlay for a verified namespace change in this exact caller checkout. */
export const validateContextBriefMemoryCitations = Effect.fn('contextBrief.validateMemoryCitations')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  candidates: readonly ContextBriefMemoryCandidateV1[],
  fence?: ContextBriefCitationValidationFenceV2,
) {
  const direct = yield* validateBoundedMemoryCitations(config, scope, candidates, fence);
  if (scope.kind !== 'repository' || fence?.kind === 'workset') return direct;
  const eligible = direct.flatMap(validation => {
    const receipts = validation.receipts.filter(
      receipt =>
        receipt.status === 'unknown' &&
        (receipt.reason === 'repository-unavailable' ||
          (receipt.reason === 'graph-stale' && receipt.repositoryRouteUnavailable === true)),
    );
    return receipts.length === 0 ? [] : [{...validation, receipts}];
  });
  if (eligible.length === 0) return direct;
  const eligibleByUri = new Map(
    eligible.map(validation => [validation.uri, new Set(validation.receipts.map(receipt => receipt.citationId))]),
  );
  const selected = candidates.flatMap(candidate => {
    const ids = eligibleByUri.get(candidate.uri);
    return ids === undefined
      ? []
      : [{...candidate, codeCitations: candidate.codeCitations.filter(citation => ids.has(citation.id))}];
  });
  const recovered = yield* recoverContextHealthCitationEvidence(config, scope, selected, eligible, 'brief', fence);
  const byUri = new Map(
    recovered.map(validation => [
      validation.uri,
      new Map(validation.receipts.map(receipt => [receipt.citationId, receipt])),
    ]),
  );
  return direct.map(validation => ({
    ...validation,
    receipts: validation.receipts.map(receipt => byUri.get(validation.uri)?.get(receipt.citationId) ?? receipt),
  }));
});

export interface ContextHealthCitationCheckpointV1 {
  readonly after?: {readonly uri: string; readonly citationId: string};
  readonly complete: boolean;
}

export interface ContextHealthCitationBatchOptionsV1 {
  readonly after?: ContextHealthCitationCheckpointV1['after'];
  readonly batchSize?: number;
}

/** A stable identity cursor survives deletions; new entries before it belong to the next scan generation. */
export function planContextHealthCitationBatch(
  candidates: readonly ContextBriefMemoryCandidateV1[],
  options: ContextHealthCitationBatchOptionsV1 = {},
): {
  readonly candidates: readonly ContextBriefMemoryCandidateV1[];
  readonly checkpoint: ContextHealthCitationCheckpointV1;
  readonly eligible: number;
  readonly checked: number;
} {
  const requested = options.batchSize ?? CONTEXT_BRIEF_MAXIMUM_CITATION_VALIDATIONS;
  if (!Number.isSafeInteger(requested) || requested < 1)
    throw new Error('Citation batch size must be a positive integer.');
  const maximum = Math.min(requested, CONTEXT_BRIEF_MAXIMUM_CITATION_VALIDATIONS);
  const key = (identity: {readonly uri: string; readonly citationId: string}) =>
    `${identity.uri}\0${identity.citationId}`;
  const tasks = candidates
    .flatMap(candidate =>
      candidate.codeCitations.map(citation => ({
        candidate,
        citation,
        identity: {uri: candidate.uri, citationId: citation.id},
      })),
    )
    .sort((left, right) =>
      key(left.identity) < key(right.identity) ? -1 : key(left.identity) > key(right.identity) ? 1 : 0,
    );
  const remaining =
    options.after === undefined ? tasks : tasks.filter(task => key(task.identity) > key(options.after!));
  const selected: typeof tasks = [];
  const repositories = new Set<string>();
  for (const task of remaining) {
    if (
      selected.length === maximum ||
      (!repositories.has(task.citation.repositoryId) && repositories.size === CONTEXT_BRIEF_MAXIMUM_CITED_REPOSITORIES)
    )
      break;
    repositories.add(task.citation.repositoryId);
    selected.push(task);
  }
  const grouped = new Map<string, ContextBriefMemoryCandidateV1>();
  for (const task of selected) {
    const existing = grouped.get(task.candidate.uri);
    grouped.set(task.candidate.uri, {
      ...task.candidate,
      codeCitations: [...(existing?.codeCitations ?? []), task.citation],
    });
  }
  const after = selected.at(-1)?.identity ?? options.after;
  return {
    candidates: [...grouped.values()],
    checkpoint: {...(after === undefined ? {} : {after}), complete: selected.length === remaining.length},
    checked: selected.length,
    eligible: tasks.length,
  };
}

export const validateContextHealthCitationBatch = Effect.fn('contextHealth.validateCitationBatch')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  candidates: readonly ContextBriefMemoryCandidateV1[],
  options: ContextHealthCitationBatchOptionsV1 = {},
) {
  const batch = planContextHealthCitationBatch(candidates, options);
  const direct = yield* validateBoundedMemoryCitations(
    config,
    scope,
    batch.candidates,
    undefined,
    config.agentContextHome,
  );
  const validations = yield* recoverContextHealthCitationEvidence(config, scope, batch.candidates, direct);
  return {...batch, validations};
});

const recoverContextHealthCitationEvidence = Effect.fn('contextHealth.recoverCitationEvidence')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  candidates: readonly ContextBriefMemoryCandidateV1[],
  direct: readonly ContextBriefMemoryCitationValidationV2[],
  policy: 'health' | 'brief' = 'health',
  fence?: ContextBriefCitationValidationFenceV2,
) {
  const query = yield* CodeGraphQueryService;
  const byUri = new Map(candidates.map(candidate => [candidate.uri, candidate]));
  const resolve = yield* makeCodeGraphCitationRepositoryRouteObservation({
    threadnoteHome: config.agentContextHome,
    ...(scope.kind === 'repository' ? {callerCwd: scope.callerCwd} : {}),
  });
  const routesBySource = new Map<string, Effect.Success<ReturnType<typeof resolveCodeGraphCitationRepositoryRoutes>>>();
  const statuses = new Map<string, CodeGraphStatus | undefined>();
  const routeReceipts = new Map<string, ReadonlyMap<string, ContextBriefCitationValidationReceiptV2>>();
  const validations = yield* Effect.forEach(
    direct,
    validation =>
      Effect.gen(function* () {
        const candidate = byUri.get(validation.uri)!;
        const citations = new Map(candidate.codeCitations.map(citation => [citation.id, citation]));
        const receipts: ContextBriefCitationValidationReceiptV2[] = [];
        for (const original of validation.receipts) {
          if (original.status !== 'unknown' || !['repository-unavailable', 'graph-stale'].includes(original.reason)) {
            const current = {
              ...original,
              provenance:
                original.status === 'exact' || original.status === 'relocated'
                  ? ('current-verified' as const)
                  : ('unverified' as const),
            };
            receipts.push(current);
            continue;
          }
          const citation = citations.get(original.citationId)!;
          const sourceKey = `${citation.repositoryId}\0${citation.sourceCommit}`;
          let resolution = routesBySource.get(sourceKey);
          if (resolution === undefined) {
            resolution = yield* resolve({
              callerOnly: policy === 'brief',
              repositoryId: citation.repositoryId,
              sourceCommit: citation.sourceCommit,
            }).pipe(
              Effect.orElseSucceed(() => ({
                ambiguous: false,
                complete: false,
                checkoutIds: [],
                generation: 'unavailable',
                routes: [],
              })),
            );
            routesBySource.set(sourceKey, resolution);
          }
          if (resolution.ambiguous) {
            receipts.push({...original, provenance: 'unverified', reason: 'repository-ambiguous'});
            continue;
          }
          let recovered: ContextBriefCitationValidationReceiptV2 | undefined;
          for (const route of resolution.routes) {
            if (policy === 'brief' && route.aliasProof === undefined) continue;
            recovered = yield* Effect.gen(function* () {
              if (!statuses.has(route.identity.repoRoot))
                statuses.set(
                  route.identity.repoRoot,
                  yield* query
                    .status(config.agentContextHome, route.identity.repoRoot, {
                      manifestPath: config.manifestPath,
                      ...(scope.project === undefined ? {} : {project: scope.project}),
                      observeWorktree: true,
                      requestMaintenance: false,
                    })
                    .pipe(Effect.orElseSucceed(() => undefined)),
                );
              const status = statuses.get(route.identity.repoRoot);
              if (
                status !== undefined &&
                (status.identity.repositoryId !== route.identity.repositoryId ||
                  status.identity.worktreeId !== route.identity.worktreeId ||
                  status.databasePath !== route.databasePath)
              )
                return undefined;
              if (
                policy === 'brief' &&
                fence?.kind === 'repository' &&
                (status?.identity.repositoryId !== fence.repositoryId || status?.readySnapshot?.id !== fence.snapshotId)
              )
                return undefined;
              const recovery = {
                callerCwd: route.identity.repoRoot,
                repositoryId: route.identity.repositoryId,
                ...(route.aliasProof === undefined ? {} : {aliasProof: route.aliasProof}),
              };
              if (
                status !== undefined &&
                status.readySnapshot !== undefined &&
                !status.stale &&
                status.freshness === 'current' &&
                (original.reason !== 'graph-stale' || original.repositoryRouteUnavailable === true)
              ) {
                const routeKey = `${route.identity.repoRoot}\0${citation.repositoryId}\0${status.readySnapshot.id}`;
                let checkedById = routeReceipts.get(routeKey);
                if (checkedById === undefined) {
                  const repositoryTasks = candidates.flatMap(value =>
                    value.codeCitations
                      .filter(anchor => anchor.repositoryId === citation.repositoryId)
                      .map((anchor, index) => ({citation: anchor, index, uri: value.uri})),
                  );
                  const checked = yield* validateRepositoryTasks(
                    {
                      databasePath: status.databasePath,
                      finalFence: Effect.all(
                        [
                          statusRepositoryFinalFence(config, {cwd: route.identity.repoRoot, status}),
                          revalidateCodeGraphCitationRecoveryRoute(config.agentContextHome, route),
                        ],
                        {concurrency: 2},
                      ).pipe(Effect.map(results => results.every(Boolean))),
                      objectFormat: status.identity.objectFormat,
                      repositoryId: status.identity.repositoryId,
                      ...(policy === 'health'
                        ? {retention: {checkoutId: status.identity.checkoutId, threadnoteHome: config.agentContextHome}}
                        : {}),
                      snapshot: status.readySnapshot,
                      sourceRoot: status.identity.repoRoot,
                      worktreeId: status.identity.worktreeId,
                    },
                    repositoryTasks,
                    original.observedAt,
                  );
                  checkedById = new Map(checked.map(value => [value.receipt.citationId, value.receipt]));
                  routeReceipts.set(routeKey, checkedById);
                }
                const checked = checkedById.get(citation.id)!;
                if (checked.status !== 'unknown') {
                  const current = {
                    ...checked,
                    provenance:
                      checked.status === 'exact' || checked.status === 'relocated'
                        ? ('current-verified' as const)
                        : ('unverified' as const),
                    recovery,
                  };
                  return current;
                }
              }
              if (policy === 'brief') return undefined;
              const historical = yield* recoverHistoricalCitationEvidence(config, route, citation, original);
              return historical === undefined ? undefined : {...historical, recovery};
            }).pipe(Effect.orElseSucceed(() => undefined));
            if (recovered !== undefined) break;
          }
          const retained =
            policy === 'health' && recovered === undefined
              ? yield* recoverCapsuleCitationEvidence(config, resolution.checkoutIds, citation, original)
              : undefined;
          receipts.push(recovered ?? retained ?? {...original, provenance: 'unverified'});
        }
        return {...validation, receipts};
      }),
    {concurrency: 1},
  );
  return validations;
});

function citationEvidenceSource(citation: MemoryCodeCitationV1): CodeGraphCitationEvidenceSourceV1 {
  return {
    extractorSet: citation.extractorSet,
    fileContentHash: citation.fileContentHash.value,
    path: citation.path,
    repositoryId: citation.repositoryId,
    sourceCommit: citation.sourceCommit,
    sourceDirty: citation.sourceDirty,
    sourceSnapshotId: citation.sourceSnapshotId,
  };
}

const retainCitationEvidenceUnderLease = Effect.fn('contextHealth.retainCitationEvidenceUnderLease')(function* (
  repository: RepositoryValidationInput & {readonly retention: NonNullable<RepositoryValidationInput['retention']>},
  tasks: readonly CitationTask[],
) {
  const captures = new Map<string, CitationTask[]>();
  for (const task of tasks) {
    const key = `${task.citation.sourceCommit}\0${task.citation.sourceDirty}`;
    captures.set(key, [...(captures.get(key) ?? []), task]);
  }
  const retainedSources = yield* Effect.forEach(
    captures.values(),
    capturedTasks =>
      Effect.gen(function* () {
        const sources = capturedTasks.map(task => ({
          expectedContentHash: task.citation.fileContentHash.value,
          repositoryPath: task.citation.path,
          requireBytes: true,
        }));
        const bytes = yield* readCodeGraphCitationSources({
          allowCommitFallback: !capturedTasks[0].citation.sourceDirty,
          objectFormat: repository.objectFormat,
          repositoryRoot: repository.sourceRoot,
          sourceCommit: capturedTasks[0].citation.sourceCommit,
          sources,
        });
        return capturedTasks.flatMap((task, index) => {
          const retained = bytes.get(codeGraphCitationSourceKey(sources[index]));
          return retained === undefined ? [] : [{bytes: retained, task}];
        });
      }).pipe(Effect.orElseSucceed(() => [])),
    {concurrency: 2},
  );
  for (const {bytes, task} of retainedSources.flat()) {
    yield* retainCodeGraphCitationEvidence({
      bytes,
      checkoutId: repository.retention.checkoutId,
      objectFormat: repository.objectFormat,
      referenceId: sha256HexSync(`${task.uri}\0${task.citation.id}`),
      source: citationEvidenceSource(task.citation),
      threadnoteHome: repository.retention.threadnoteHome,
    });
  }
});

const recoverCapsuleCitationEvidence = Effect.fn('contextHealth.recoverCapsuleCitationEvidence')(function* (
  config: RuntimeConfig,
  checkoutIds: readonly string[],
  citation: MemoryCodeCitationV1,
  original: ContextBriefCitationValidationReceiptV2,
) {
  for (const checkoutId of checkoutIds) {
    const retained = yield* readRetainedCodeGraphCitationEvidence(
      config.agentContextHome,
      checkoutId,
      citationEvidenceSource(citation),
    );
    if (retained === undefined) continue;
    if (!(yield* historicalCitationBytesMatch(citation, retained.capsule.objectFormat, retained.bytes))) continue;
    return {
      ...original,
      provenance: 'historical-verified' as const,
      snapshotCommit: citation.sourceCommit,
      snapshotId: citation.sourceSnapshotId,
    };
  }
  return undefined;
});

const readHistoricalGitCitationBytes = Effect.fn('contextHealth.readHistoricalGitCitationBytes')(function* (
  config: RuntimeConfig,
  route: CodeGraphCitationRecoveryRouteV1,
  citation: MemoryCodeCitationV1,
) {
  if (citation.sourceDirty || !(yield* revalidateCodeGraphCitationRecoveryRoute(config.agentContextHome, route)))
    return undefined;
  const request = {
    expectedContentHash: citation.fileContentHash.value,
    repositoryPath: citation.path,
    requireBytes: true,
  };
  const sources = yield* readCodeGraphCitationSources({
    commitOnly: true,
    objectFormat: route.identity.objectFormat,
    repositoryRoot: route.identity.repoRoot,
    retainedBytesLimit: 4 * 1_048_576,
    sourceCommit: citation.sourceCommit,
    sources: [request],
  });
  const bytes = sources.get(codeGraphCitationSourceKey(request));
  if (bytes === undefined || !(yield* historicalCitationBytesMatch(citation, route.identity.objectFormat, bytes)))
    return undefined;
  if (!(yield* revalidateCodeGraphCitationRecoveryRoute(config.agentContextHome, route))) return undefined;
  return bytes;
});

/** Exact local evidence for one canonical citation; excerpts are data, never instructions. */
export const readContextHealthCitationEvidence = Effect.fn('contextHealth.readCitationEvidence')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  citation: MemoryCodeCitationV1,
  options: {readonly maximumBytes?: number; readonly maximumLines?: number; readonly startLine?: number} = {},
) {
  const attemptedSteps: string[] = ['verified-repository-routes'];
  const resolution = yield* resolveCodeGraphCitationRepositoryRoutes({
    ...(scope.kind === 'repository' ? {callerCwd: scope.callerCwd} : {}),
    repositoryId: citation.repositoryId,
    sourceCommit: citation.sourceCommit,
    threadnoteHome: config.agentContextHome,
  });
  const excerpts: ContextHealthCitationSourceExcerptV1[] = [];
  const query = yield* CodeGraphQueryService;
  const store = yield* CodeGraphStore;
  if (!resolution.ambiguous)
    for (const route of resolution.routes) {
      attemptedSteps.push('current-source');
      const current = yield* Effect.gen(function* () {
        const status = yield* query.status(config.agentContextHome, route.identity.repoRoot, {
          manifestPath: config.manifestPath,
          ...(scope.project === undefined ? {} : {project: scope.project}),
          observeWorktree: true,
          requestMaintenance: false,
        });
        if (
          status.stale ||
          status.freshness !== 'current' ||
          status.readySnapshot === undefined ||
          status.databasePath !== route.databasePath ||
          status.identity.repositoryId !== route.identity.repositoryId
        )
          return undefined;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const snapshot = status.readySnapshot!;
            yield* Effect.acquireRelease(store.acquireSnapshotLease(status.databasePath, snapshot.id, 60_000), token =>
              store.releaseSnapshotLease(status.databasePath, token).pipe(Effect.ignore),
            );
            const [checked] = yield* validateRepositoryTasks(
              {
                databasePath: status.databasePath,
                finalFence: revalidateCodeGraphCitationRecoveryRoute(config.agentContextHome, route),
                objectFormat: status.identity.objectFormat,
                repositoryId: status.identity.repositoryId,
                snapshot,
                sourceRoot: route.identity.repoRoot,
                worktreeId: status.identity.worktreeId,
              },
              [{citation, index: 0, uri: ''}],
              DateTime.formatIso(yield* DateTime.now),
            );
            const observedPath = checked.receipt.observedPath ?? citation.path;
            const evidence = yield* store.effectiveSnapshotCitationEvidence(status.databasePath, snapshot.id, {
              paths: [observedPath],
            });
            const file = evidence.filesByPaths.find(value => value.path === observedPath)?.file;
            if (file === undefined) return undefined;
            const request = {expectedContentHash: file.contentHash, repositoryPath: file.path, requireBytes: true};
            const sources = yield* readCodeGraphCitationSources({
              allowCommitFallback: false,
              objectFormat: status.identity.objectFormat,
              repositoryRoot: route.identity.repoRoot,
              retainedBytesLimit: 4 * 1_048_576,
              sourceCommit: snapshot.commit,
              sources: [request],
            });
            const bytes = sources.get(codeGraphCitationSourceKey(request));
            if (
              bytes === undefined ||
              !(yield* revalidateCodeGraphCitationRecoveryRoute(config.agentContextHome, route))
            )
              return undefined;
            const after = yield* query.status(config.agentContextHome, route.identity.repoRoot, {
              manifestPath: config.manifestPath,
              ...(scope.project === undefined ? {} : {project: scope.project}),
              observeWorktree: true,
              requestMaintenance: false,
            });
            if (!sameExactSnapshot(status, after)) return undefined;
            return citationSourceExcerpt(
              bytes,
              {
                extractorSet: snapshot.extractorSet,
                fileContentHash: file.contentHash,
                path: file.path,
                repositoryId: status.identity.repositoryId,
                sourceCommit: snapshot.commit,
                sourceDirty: snapshot.dirty,
                sourceSnapshotId: snapshot.id,
              },
              'current-verified',
              checked.receipt.status === 'exact' || checked.receipt.status === 'relocated',
              {
                ...options,
                startLine:
                  options.startLine ??
                  checked.receipt.observedSpan?.line ??
                  (citation.target.kind === 'symbol' ? citation.target.span.line : 1),
              },
            );
          }),
        );
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (current !== undefined) {
        excerpts.push(current);
        break;
      }
    }
  attemptedSteps.push('retained-capsule');
  let historical: Uint8Array | undefined;
  for (const checkoutId of resolution.checkoutIds) {
    const retained = yield* readRetainedCodeGraphCitationEvidence(
      config.agentContextHome,
      checkoutId,
      citationEvidenceSource(citation),
    );
    if (
      retained !== undefined &&
      (yield* historicalCitationBytesMatch(citation, retained.capsule.objectFormat, retained.bytes))
    ) {
      historical = retained.bytes;
      break;
    }
  }
  if (historical === undefined && !resolution.ambiguous)
    for (const route of resolution.routes) {
      attemptedSteps.push('exact-snapshot');
      historical = yield* Effect.gen(function* () {
        const snapshot = yield* store.readySnapshotById(route.databasePath, citation.sourceSnapshotId);
        if (
          snapshot === undefined ||
          snapshot.repositoryId !== citation.repositoryId ||
          snapshot.commit !== citation.sourceCommit ||
          snapshot.dirty !== citation.sourceDirty ||
          snapshot.extractorSet !== citation.extractorSet
        )
          return undefined;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(store.acquireSnapshotLease(route.databasePath, snapshot.id, 60_000), token =>
              store.releaseSnapshotLease(route.databasePath, token).pipe(Effect.ignore),
            );
            const evidence = yield* store.effectiveSnapshotCitationEvidence(route.databasePath, snapshot.id, {
              paths: [citation.path],
              symbolIds: citation.target.kind === 'symbol' ? [citation.target.nodeId] : [],
            });
            if (!historicalSnapshotCitationMatches(citation, evidence)) return undefined;
            const request = {
              expectedContentHash: citation.fileContentHash.value,
              repositoryPath: citation.path,
              requireBytes: true,
            };
            const sources = yield* readCodeGraphCitationSources({
              allowCommitFallback: !snapshot.dirty,
              commitOnly: !snapshot.dirty,
              objectFormat: route.identity.objectFormat,
              repositoryRoot: route.identity.repoRoot,
              sourceCommit: snapshot.commit,
              sources: [request],
              retainedBytesLimit: 4 * 1_048_576,
            });
            const bytes = sources.get(codeGraphCitationSourceKey(request));
            return bytes !== undefined &&
              (yield* historicalCitationBytesMatch(citation, route.identity.objectFormat, bytes)) &&
              (yield* revalidateCodeGraphCitationRecoveryRoute(config.agentContextHome, route))
              ? bytes
              : undefined;
          }),
        );
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (historical === undefined) {
        attemptedSteps.push('exact-clean-git');
        historical = yield* readHistoricalGitCitationBytes(config, route, citation).pipe(
          Effect.orElseSucceed(() => undefined),
        );
      }
      if (historical !== undefined) break;
    }
  if (historical !== undefined) {
    const excerpt = citationSourceExcerpt(historical, citationEvidenceSource(citation), 'historical-verified', true, {
      ...options,
      startLine: options.startLine ?? (citation.target.kind === 'symbol' ? citation.target.span.line : 1),
    });
    if (excerpt !== undefined) excerpts.push(excerpt);
  }
  return {
    attemptedSteps: [...new Set(attemptedSteps)],
    citationId: citation.id,
    coverage:
      excerpts.length > 0
        ? ('available' as const)
        : resolution.ambiguous
          ? ('ambiguous' as const)
          : ('unavailable' as const),
    excerpts,
    generation: resolution.generation,
    routesComplete: resolution.complete,
  };
});

const recoverHistoricalCitationEvidence = Effect.fn('contextHealth.recoverHistoricalCitationEvidence')(function* (
  config: RuntimeConfig,
  route: CodeGraphCitationRecoveryRouteV1,
  citation: MemoryCodeCitationV1,
  original: ContextBriefCitationValidationReceiptV2,
) {
  const store = yield* CodeGraphStore;
  const exact = yield* store
    .readySnapshotById(route.databasePath, citation.sourceSnapshotId)
    .pipe(Effect.orElseSucceed(() => undefined));
  const snapshot =
    exact ??
    (citation.sourceDirty
      ? undefined
      : yield* store
          .readySnapshotForCommit(
            route.databasePath,
            citation.repositoryId,
            citation.sourceCommit,
            citation.extractorSet,
          )
          .pipe(Effect.orElseSucceed(() => undefined)));
  if (
    snapshot === undefined ||
    snapshot.repositoryId !== citation.repositoryId ||
    snapshot.commit !== citation.sourceCommit ||
    snapshot.dirty !== citation.sourceDirty ||
    snapshot.extractorSet !== citation.extractorSet
  ) {
    const bytes = yield* readHistoricalGitCitationBytes(config, route, citation);
    if (bytes === undefined) return undefined;
    yield* retainCodeGraphCitationEvidence({
      bytes,
      checkoutId: route.identity.checkoutId,
      objectFormat: route.identity.objectFormat,
      referenceId: sha256HexSync(citation.id),
      source: citationEvidenceSource(citation),
      threadnoteHome: config.agentContextHome,
    });
    if (!(yield* revalidateCodeGraphCitationRecoveryRoute(config.agentContextHome, route))) return undefined;
    return {
      ...original,
      coverage: 'incomplete' as const,
      provenance: 'historical-verified' as const,
      snapshotCommit: citation.sourceCommit,
      snapshotId: citation.sourceSnapshotId,
    };
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(store.acquireSnapshotLease(route.databasePath, snapshot.id, 60_000), token =>
        store.releaseSnapshotLease(route.databasePath, token).pipe(Effect.ignore),
      );
      const bytes = yield* readCodeGraphCitationSources({
        allowCommitFallback: !snapshot.dirty,
        objectFormat: route.identity.objectFormat,
        repositoryRoot: route.identity.repoRoot,
        sourceCommit: snapshot.commit,
        sources: [
          {expectedContentHash: citation.fileContentHash.value, repositoryPath: citation.path, requireBytes: true},
        ],
      });
      if (
        !bytes.has(
          codeGraphCitationSourceKey({
            expectedContentHash: citation.fileContentHash.value,
            repositoryPath: citation.path,
          }),
        )
      )
        return undefined;
      const [checked] = yield* validateRepositoryTasks(
        {
          databasePath: route.databasePath,
          finalFence: revalidateCodeGraphCitationRecoveryRoute(config.agentContextHome, route),
          objectFormat: route.identity.objectFormat,
          repositoryId: snapshot.repositoryId,
          snapshot,
          sourceRoot: route.identity.repoRoot,
          worktreeId: snapshot.worktreeId,
        },
        [{citation, index: 0, uri: ''}],
        original.observedAt,
      );
      if (checked.receipt.status !== 'exact' && checked.receipt.status !== 'relocated') return undefined;
      yield* retainCodeGraphCitationEvidence({
        bytes: bytes.get(
          codeGraphCitationSourceKey({
            expectedContentHash: citation.fileContentHash.value,
            repositoryPath: citation.path,
          }),
        )!,
        checkoutId: route.identity.checkoutId,
        objectFormat: route.identity.objectFormat,
        referenceId: sha256HexSync(citation.id),
        source: citationEvidenceSource(citation),
        threadnoteHome: config.agentContextHome,
      });
      return {
        ...checked.receipt,
        coverage: 'incomplete' as const,
        provenance: 'historical-verified' as const,
        reason: original.reason,
        status: 'unknown' as const,
      };
    }),
  );
});

/** Ordinary health admits one batch; explicit diagnostic/worker traversal can drain bounded batches. */
export const validateContextHealthMemoryCitations = Effect.fn('contextHealth.validateMemoryCitations')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  candidates: readonly ContextBriefMemoryCandidateV1[],
  options: {readonly fullScan?: boolean} = {},
) {
  if (!options.fullScan) return (yield* validateContextHealthCitationBatch(config, scope, candidates)).validations;
  const byUri = new Map<string, ContextBriefMemoryCitationValidationV2>();
  let after: ContextHealthCitationCheckpointV1['after'];
  while (true) {
    const batch = yield* validateContextHealthCitationBatch(config, scope, candidates, {after});
    for (const validation of batch.validations) {
      const previous = byUri.get(validation.uri);
      byUri.set(validation.uri, {
        uri: validation.uri,
        receipts: [...(previous?.receipts ?? []), ...validation.receipts],
        cacheHits: (previous?.cacheHits ?? 0) + (validation.cacheHits ?? 0),
      });
    }
    if (batch.checkpoint.complete) break;
    after = batch.checkpoint.after;
  }
  return [...byUri.values()];
});

interface CitationTask {
  readonly citation: MemoryCodeCitationV1;
  readonly index: number;
  readonly uri: string;
}

interface RepositoryValidationInput {
  readonly databasePath: string;
  readonly finalFence: Effect.Effect<boolean, unknown, RepositoryValidationFenceRequirements>;
  readonly objectFormat: RepositoryIdentity['objectFormat'];
  readonly repositoryId: string;
  readonly retention?: {readonly checkoutId: string; readonly threadnoteHome: string};
  readonly snapshot: CodeGraphSnapshot;
  readonly sourceRoot: string;
  readonly worktreeId: string;
}

type RepositoryValidationFenceRequirements =
  CodeGraphQueryService | CodeGraphStore | CommandExecutor | FileSystem.FileSystem | Path.Path | SystemInfo;

interface StatusReadyRepository {
  readonly cwd: string;
  readonly expected?: RepositoryIdentityExpectation;
  readonly status: CodeGraphStatus;
}

interface ValidationRepositoryTarget {
  readonly cwd: string;
  readonly expected?: RepositoryIdentityExpectation;
  readonly published?: CodeGraphWorksetCatalogPublishedMemberV1;
}

interface ValidationScopeResolution {
  readonly ambiguousRepositoryIds: ReadonlySet<string>;
  readonly requiredSnapshot?: Extract<ContextBriefCitationValidationFenceV2, {readonly kind: 'repository'}>;
  readonly targets: readonly ValidationRepositoryTarget[];
  readonly unavailableReason: 'graph-stale' | 'repository-unavailable';
  readonly worksetGeneration?: {readonly digest: string; readonly id: string; readonly workset: string};
}

export interface ContextBriefWorksetValidationRoute {
  readonly ambiguousRepositoryIds: ReadonlySet<string>;
  readonly members: readonly {
    readonly projectPath: string;
    readonly published: CodeGraphWorksetCatalogPublishedMemberV1;
  }[];
  readonly generation?: {readonly digest: string; readonly id: string};
  readonly stale: boolean;
}

interface ValidatedCitation {
  readonly cacheHit: boolean;
  readonly receipt: ContextBriefCitationValidationReceiptV2;
}

/** Validate selected-memory citations against exact-current, already-ready graph snapshots. */
const validateBoundedMemoryCitations = Effect.fn('contextBrief.validateBoundedMemoryCitations')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  candidates: readonly ContextBriefMemoryCandidateV1[],
  fence?: ContextBriefCitationValidationFenceV2,
  retentionHome?: string,
) {
  const allTasks = candidates.flatMap(candidate =>
    candidate.codeCitations.map((citation, index) => ({citation, index, uri: candidate.uri})),
  );
  if (allTasks.length === 0) return [] as readonly ContextBriefMemoryCitationValidationV2[];
  const observedAt = DateTime.formatIso(yield* DateTime.now);
  const unknown = (
    citation: MemoryCodeCitationV1,
    reason: Parameters<typeof unknownReceipt>[1],
  ): ContextBriefCitationValidationReceiptV2 => unknownReceipt(citation, reason, observedAt);
  const admitted = allTasks.slice(0, CONTEXT_BRIEF_MAXIMUM_CITATION_VALIDATIONS);
  const deferred = allTasks.slice(CONTEXT_BRIEF_MAXIMUM_CITATION_VALIDATIONS);
  const repositoryIds = [...new Set(admitted.map(task => task.citation.repositoryId))];
  const admittedRepositoryIds = new Set(repositoryIds.slice(0, CONTEXT_BRIEF_MAXIMUM_CITED_REPOSITORIES));
  const overflowRepositoryIds = new Set(repositoryIds.slice(CONTEXT_BRIEF_MAXIMUM_CITED_REPOSITORIES));
  const resolution: ValidationScopeResolution = yield* validationScopeTargets(
    config,
    scope,
    admittedRepositoryIds,
    fence,
  );
  const byRepository = new Map<string, CitationTask[]>();
  for (const task of admitted) {
    const group = byRepository.get(task.citation.repositoryId) ?? [];
    group.push(task);
    byRepository.set(task.citation.repositoryId, group);
  }
  type ValidationTuple = readonly [CitationTask, ContextBriefCitationValidationReceiptV2, boolean];
  const validated: ValidationTuple[] = [];
  const eligibleByRepository = new Map<string, CitationTask[]>();
  for (const [repositoryId, tasks] of byRepository) {
    if (overflowRepositoryIds.has(repositoryId)) {
      validated.push(...tasks.map(task => [task, unknown(task.citation, 'citation-limit'), false] as const));
    } else if (resolution.ambiguousRepositoryIds.has(repositoryId)) {
      validated.push(...tasks.map(task => [task, unknown(task.citation, 'repository-ambiguous'), false] as const));
    } else {
      eligibleByRepository.set(repositoryId, tasks);
    }
  }
  const query = yield* CodeGraphQueryService;
  const statusOptions = {observeWorktree: true, requestMaintenance: false} as const;
  const observations = yield* Effect.forEach(
    resolution.targets,
    target => {
      const use = (status: CodeGraphStatus) => {
        const repositoryId = status.identity.repositoryId;
        const tasks = eligibleByRepository.get(repositoryId);
        if (tasks === undefined) return succeedUndefined;
        if (
          resolution.requiredSnapshot !== undefined &&
          (repositoryId !== resolution.requiredSnapshot.repositoryId ||
            status.readySnapshot?.id !== resolution.requiredSnapshot.snapshotId)
        ) {
          return succeedUndefined;
        }
        const repository = {...target, status} satisfies StatusReadyRepository;
        if (status.readySnapshot === undefined || status.stale || status.freshness !== 'current') {
          return Effect.succeed({
            repositoryId,
            tuples: tasks.map(task => [task, unknown(task.citation, 'graph-stale'), false] as const),
          });
        }
        return validateRepositoryTasks(
          {
            databasePath: status.databasePath,
            finalFence: statusRepositoryFinalFence(config, repository),
            objectFormat: status.identity.objectFormat,
            repositoryId,
            ...(retentionHome === undefined
              ? {}
              : {retention: {checkoutId: status.identity.checkoutId, threadnoteHome: retentionHome}}),
            snapshot: status.readySnapshot,
            sourceRoot: status.identity.repoRoot,
            worktreeId: status.identity.worktreeId,
          },
          tasks,
          observedAt,
        ).pipe(
          Effect.map(results => ({
            repositoryId,
            tuples: tasks.map((task, index) => [task, results[index].receipt, results[index].cacheHit] as const),
          })),
          Effect.orElseSucceed(() => ({
            repositoryId,
            tuples: tasks.map(task => [task, unknown(task.citation, 'validation-error'), false] as const),
          })),
        );
      };
      const statusAndValidate = query.withStatusSession
        ? query.withStatusSession(config.agentContextHome, target.cwd, target.expected, statusOptions, use)
        : (target.expected === undefined
            ? query.status(config.agentContextHome, target.cwd, statusOptions)
            : query.statusForPublishedIdentity(config.agentContextHome, target.cwd, target.expected, statusOptions)
          ).pipe(Effect.flatMap(use));
      if (target.published !== undefined) {
        const repositoryId = target.published.repositoryId;
        const tasks = eligibleByRepository.get(repositoryId);
        if (tasks === undefined) return Effect.succeedNone;
        if (retentionHome !== undefined || !tasks.every(task => task.citation.target.kind === 'file'))
          return statusAndValidate.pipe(Effect.option);
        return validatePublishedRepositoryTasks(config, target.cwd, target.published, tasks, observedAt).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap(results =>
            results === undefined
              ? statusAndValidate
              : Effect.succeed({
                  repositoryId,
                  tuples: tasks.map((task, index) => [task, results[index].receipt, results[index].cacheHit] as const),
                }),
          ),
          Effect.option,
        );
      }
      return statusAndValidate.pipe(Effect.option);
    },
    {concurrency: VALIDATION_CONCURRENCY},
  );
  const matchedRepositoryIds = new Set<string>();
  for (const observation of observations) {
    if (observation._tag === 'None' || observation.value === undefined) continue;
    matchedRepositoryIds.add(observation.value.repositoryId);
    validated.push(...observation.value.tuples);
  }
  for (const [repositoryId, tasks] of eligibleByRepository) {
    if (matchedRepositoryIds.has(repositoryId)) continue;
    validated.push(
      ...tasks.map(
        task =>
          [
            task,
            {...unknown(task.citation, resolution.unavailableReason), repositoryRouteUnavailable: true as const},
            false,
          ] as const,
      ),
    );
  }

  const receiptsByUri = new Map<string, ContextBriefCitationValidationReceiptV2[]>();
  const cacheHitsByUri = new Map<string, number>();
  for (const [task, receipt, cacheHit] of validated) {
    const receipts = receiptsByUri.get(task.uri) ?? [];
    receipts.push(receipt);
    receiptsByUri.set(task.uri, receipts);
    if (cacheHit) cacheHitsByUri.set(task.uri, (cacheHitsByUri.get(task.uri) ?? 0) + 1);
  }
  for (const task of deferred) {
    const receipts = receiptsByUri.get(task.uri) ?? [];
    receipts.push(unknown(task.citation, 'citation-limit'));
    receiptsByUri.set(task.uri, receipts);
  }
  if (
    resolution.worksetGeneration !== undefined &&
    !(yield* worksetGenerationIsStillPublished(config, resolution.worksetGeneration))
  ) {
    const staleValidations: readonly ContextBriefMemoryCitationValidationV2[] = candidates.flatMap(candidate =>
      candidate.codeCitations.length === 0
        ? []
        : [
            {
              receipts: candidate.codeCitations.map(citation => unknown(citation, 'graph-stale')),
              uri: candidate.uri,
            },
          ],
    );
    return staleValidations;
  }
  const validations: readonly ContextBriefMemoryCitationValidationV2[] = candidates.flatMap(candidate => {
    const receipts = receiptsByUri.get(candidate.uri);
    if (!receipts) return [];
    const byId = new Map(receipts.map(receipt => [receipt.citationId, receipt]));
    return [
      {
        ...(cacheHitsByUri.has(candidate.uri) ? {cacheHits: cacheHitsByUri.get(candidate.uri)!} : {}),
        receipts: candidate.codeCitations.flatMap(citation => {
          const receipt = byId.get(citation.id);
          return receipt ? [receipt] : [];
        }),
        uri: candidate.uri,
      },
    ];
  });
  return validations;
});

const validatePublishedRepositoryTasks = Effect.fn('contextBrief.validatePublishedRepositoryCitationTasks')(function* (
  config: RuntimeConfig,
  cwd: string,
  published: CodeGraphWorksetCatalogPublishedMemberV1,
  tasks: readonly CitationTask[],
  observedAt: string,
) {
  const path = yield* Path.Path;
  const query = yield* CodeGraphQueryService;
  const store = yield* CodeGraphStore;
  const languagePacks = yield* CodeGraphLanguagePackRegistry;
  const layout = codeGraphLayout(path, config.agentContextHome, published.checkoutId, published.worktreeId);
  return yield* store.withSession(
    layout.databasePath,
    Effect.gen(function* () {
      const snapshot = yield* store.readySnapshotById(layout.databasePath, published.snapshotId);
      if (snapshot?.dirty === true) return undefined;
      const runtimeCurrent =
        snapshot !== undefined && cleanPublishedCatalogSnapshotMatches(published, snapshot)
          ? yield* codeGraphSnapshotRuntimeCurrent(store, layout.databasePath, snapshot, languagePacks)
          : false;
      if (snapshot === undefined || !cleanPublishedCatalogSnapshotMatches(published, snapshot) || !runtimeCurrent) {
        return tasks.map(task => ({
          cacheHit: false,
          receipt: unknownReceipt(task.citation, 'graph-stale', observedAt),
        })) satisfies readonly ValidatedCitation[];
      }
      return yield* validateRepositoryTasks(
        {
          databasePath: layout.databasePath,
          finalFence: Effect.gen(function* () {
            const beforeActive = yield* store.loadActiveViewFence(layout.databasePath, published.worktreeId);
            if (
              !cleanPublishedCatalogSnapshotMatches(published, snapshot) ||
              beforeActive?.snapshotId !== snapshot.id
            ) {
              return false;
            }
            const policyAwareFence = query
              .statusForPublishedIdentity(config.agentContextHome, cwd, published, {
                observeWorktree: true,
                requestMaintenance: false,
              })
              .pipe(
                Effect.map(
                  status =>
                    status.freshness === 'current' &&
                    !status.stale &&
                    cleanPublishedCatalogFenceMatches(published, snapshot, status.identity, status.readySnapshot),
                ),
              );
            const observation = yield* resolvePublishedRepositoryReadFence(cwd, published).pipe(Effect.option);
            const repositoryCurrent =
              observation._tag === 'None' || observation.value.worktreeChanged
                ? yield* policyAwareFence
                : cleanPublishedCatalogFenceMatches(published, snapshot, observation.value, snapshot);
            if (!repositoryCurrent) return false;
            const afterActive = yield* store.loadActiveViewFence(layout.databasePath, published.worktreeId);
            return sameActiveViewFence(beforeActive, afterActive);
          }),
          objectFormat: snapshot.commit.length === 64 ? 'sha256' : 'sha1',
          repositoryId: published.repositoryId,
          snapshot,
          sourceRoot: cwd,
          worktreeId: published.worktreeId,
        },
        tasks,
        observedAt,
      );
    }),
    {existingOnly: true},
  );
});

function sameActiveViewFence(
  before: {readonly activatedAt: string; readonly snapshotId: string; readonly worktreeId: string},
  after: {readonly activatedAt: string; readonly snapshotId: string; readonly worktreeId: string} | undefined,
): boolean {
  return (
    after !== undefined &&
    before.activatedAt === after.activatedAt &&
    before.snapshotId === after.snapshotId &&
    before.worktreeId === after.worktreeId
  );
}

const statusRepositoryFinalFence = (
  config: RuntimeConfig,
  repository: StatusReadyRepository,
): Effect.Effect<boolean, unknown, RepositoryValidationFenceRequirements> =>
  Effect.gen(function* () {
    const query = yield* CodeGraphQueryService;
    const store = yield* CodeGraphStore;
    const snapshot = repository.status.readySnapshot!;
    if (repository.expected !== undefined && snapshot.dirty === false) {
      return yield* Effect.all(
        [
          revalidateRepositoryIdentityFence(repository.cwd, repository.status.identity),
          observeCleanRepositoryWorktree(repository.status.identity.repoRoot),
          store.readySnapshot(repository.status.databasePath, repository.status.identity.worktreeId),
        ],
        {concurrency: 3},
      ).pipe(
        Effect.flatMap(([identity, cleanOverlay, activeSnapshot]) =>
          resolveContextBriefFinalFenceOverlay(identity, cleanOverlay).pipe(
            Effect.map(overlay =>
              cleanPublishedCitationFenceMatches(repository.status, identity, overlay, activeSnapshot),
            ),
          ),
        ),
      );
    }
    // A locally discovered identity also supplies the expected routing IDs. Reobserve
    // identity, policy, runtime and worktree state without recording its association twice.
    // Keep legacy custom query services on their full status path.
    const after = yield* repository.expected === undefined && typeof query.statusForPublishedIdentity !== 'function'
      ? query.status(config.agentContextHome, repository.cwd, {
          observeWorktree: true,
          requestMaintenance: false,
        })
      : query.statusForPublishedIdentity(
          config.agentContextHome,
          repository.cwd,
          repository.expected ?? repository.status.identity,
          {observeWorktree: true, requestMaintenance: false},
        );
    return sameExactSnapshot(repository.status, after);
  });

const validateRepositoryTasks = Effect.fn('contextBrief.validateRepositoryCitationTasks')(function* (
  repository: RepositoryValidationInput,
  tasks: readonly CitationTask[],
  observedAt: string,
) {
  const store = yield* CodeGraphStore;
  const fs = yield* FileSystem.FileSystem;
  const snapshot = repository.snapshot;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(store.acquireSnapshotLease(repository.databasePath, snapshot.id, 60_000), token =>
        store.releaseSnapshotLease(repository.databasePath, token).pipe(Effect.ignore),
      );
      const cacheKeys = tasks.map(task =>
        validationCacheKey(repository.repositoryId, repository.worktreeId, snapshot.id, task.citation.id),
      );
      const cached = cacheKeys.map(validationCacheGet);
      const uncachedTasks = tasks.filter((_, index) => cached[index] === undefined);
      const computed = new Map<CitationTask, ContextBriefCitationValidationReceiptV2>();

      if (uncachedTasks.length > 0) {
        const citations = uncachedTasks.map(task => task.citation);
        const symbolCitations = citations.filter(
          (
            citation,
          ): citation is MemoryCodeCitationV1 & {
            readonly target: Extract<MemoryCodeCitationV1['target'], {readonly kind: 'symbol'}>;
          } => citation.target.kind === 'symbol',
        );
        const locators = symbolCitations.map(symbolLocator);
        const evidence = yield* store.effectiveSnapshotCitationEvidence(repository.databasePath, snapshot.id, {
          fileRelocationFallbacks: citations.map(citation => ({
            contentHash: citation.fileContentHash.value,
            path: citation.path,
          })),
          limitPerContentHash: RELOCATION_MATCH_LIMIT,
          limitPerSemanticLocator: RELOCATION_MATCH_LIMIT,
          semanticLocators: locators,
          symbolIds: symbolCitations.flatMap(citation =>
            citation.target.kind === 'symbol' ? [citation.target.nodeId] : [],
          ),
        });
        const pathByPath = new Map(evidence.filesByPaths.map(observation => [observation.path, observation]));
        const hashesByHash = new Map(evidence.filesByContentHashes.map(matches => [matches.contentHash, matches]));
        const exactById = new Map(evidence.symbolsByIds.map(symbol => [symbol.id, symbol]));
        const locatorsByKey = new Map(
          evidence.symbolsBySemanticLocators.map(matches => [locatorKey(matches.locator), matches]),
        );
        // Validation is deliberately snapshot-local. Only the persisted receipt
        // may prove inventory completeness; a live preview would rescan the
        // worktree and turn recall into an unbounded cold-index path.
        const fileInventoryCoverage = evidence.fileInventoryCoverage;
        const sourceBytes =
          symbolCitations.length === 0
            ? new Map<string, Uint8Array>()
            : yield* fs.realPath(repository.sourceRoot).pipe(
                Effect.flatMap(repositoryRoot =>
                  readCodeGraphCitationSources({
                    allowCommitFallback: !snapshot.dirty,
                    objectFormat: repository.objectFormat,
                    repositoryRoot,
                    sourceCommit: snapshot.commit,
                    sources: symbolCitations.flatMap(citation =>
                      symbolCitationSourceCandidates(
                        citation,
                        exactById.get(citation.target.nodeId),
                        locatorsByKey.get(locatorKey(symbolLocator(citation))),
                        snapshot,
                      ).map(symbol => ({
                        expectedContentHash: symbol.contentHash,
                        repositoryPath: symbol.path,
                        requireBytes: true,
                      })),
                    ),
                  }),
                ),
              );
        type PreparedSource = ReturnType<typeof createCodeGraphSourceSpanCanonicalizer>;
        const sourceCache = new Map<string, PreparedSource>();
        const readSource = (repositoryPath: string, expectedHash: string) => {
          const key = `${repositoryPath}\u0000${expectedHash}`;
          const cachedSource = sourceCache.get(key);
          if (cachedSource) return Effect.succeed(cachedSource);
          return Effect.gen(function* () {
            const bytes = sourceBytes.get(
              codeGraphCitationSourceKey({expectedContentHash: expectedHash, repositoryPath}),
            );
            if (bytes === undefined) return yield* Effect.fail('source-drift' as const);
            const source = decodeUtf8(bytes);
            if (source === undefined) return yield* Effect.fail('source-not-utf8' as const);
            const prepared = createCodeGraphSourceSpanCanonicalizer(source);
            sourceCache.set(key, prepared);
            return prepared;
          });
        };

        const receipts = yield* Effect.forEach(
          uncachedTasks,
          task => {
            const citation = task.citation;
            if (citation.target.kind === 'file') {
              return Effect.succeed(
                validateContextBriefFileCitation(
                  citation,
                  pathByPath.get(citation.path),
                  hashesByHash.get(citation.fileContentHash.value),
                  snapshot,
                  observedAt,
                  fileInventoryCoverage,
                ),
              );
            }
            return validateContextBriefSymbolCitation(
              citation as MemoryCodeCitationV1 & {
                readonly target: Extract<MemoryCodeCitationV1['target'], {readonly kind: 'symbol'}>;
              },
              exactById.get(citation.target.nodeId),
              locatorsByKey.get(locatorKey(symbolLocator(citation))),
              pathByPath.get(citation.path),
              hashesByHash.get(citation.fileContentHash.value),
              snapshot,
              readSource,
              observedAt,
              fileInventoryCoverage,
            );
          },
          {concurrency: VALIDATION_CONCURRENCY},
        );
        for (const [index, task] of uncachedTasks.entries()) computed.set(task, receipts[index]);
      }

      const results = tasks.map((task, index) => {
        const cachedReceipt = cached[index];
        return cachedReceipt === undefined
          ? {cacheHit: false, receipt: computed.get(task)!}
          : {cacheHit: true, receipt: {...cachedReceipt, observedAt}};
      }) satisfies readonly ValidatedCitation[];
      if (repository.retention !== undefined) {
        yield* retainCitationEvidenceUnderLease(
          {...repository, retention: repository.retention},
          tasks.filter(
            (_, index) => results[index].receipt.status === 'exact' || results[index].receipt.status === 'relocated',
          ),
        ).pipe(Effect.ignore);
      }
      const fenceCurrent = yield* repository.finalFence.pipe(Effect.orElseSucceed(() => false));
      if (!fenceCurrent) {
        return tasks.map(task => ({
          cacheHit: false,
          receipt: unknownReceipt(task.citation, 'graph-stale', observedAt),
        })) satisfies readonly ValidatedCitation[];
      }

      for (const [index, result] of results.entries())
        if (!result.cacheHit && result.receipt.reason !== 'validation-error')
          validationCacheSet(cacheKeys[index], result.receipt);
      return results;
    }),
  );
});

export function validateContextBriefFileCitation(
  citation: MemoryCodeCitationV1,
  pathObservation: CodeGraphEffectiveFilePathObservation | undefined,
  relocation: CodeGraphEffectiveFileHashMatches | undefined,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  observedAt: string,
  fileInventoryCoverage: CodeGraphEffectiveSnapshotCitationEvidence['fileInventoryCoverage'] = 'incomplete',
): ContextBriefCitationValidationReceiptV2 {
  const result = (
    status: ContextBriefCitationValidationReceiptV2['status'],
    reason: ContextBriefCitationValidationReceiptV2['reason'],
    observation: ReceiptObservation,
  ) => receipt(citation, snapshot, status, reason, observation, observedAt);
  const exactFile = pathObservation?.file;
  if (
    exactFile?.contentHash === citation.fileContentHash.value ||
    exactFile?.rawContentHash === citation.fileContentHash.value
  ) {
    return result('exact', 'exact', {
      candidateCount: 1,
      coverage: 'current-complete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  // An occupied original locator with different bytes is changed. A duplicate
  // elsewhere must never rescue it into a false-fresh relocation.
  if (exactFile) {
    return result('changed', 'source-changed', {
      candidateCount: 1,
      coverage: 'current-complete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  const matches = relocation?.files ?? [];
  if (relocation?.truncated || matches.length > 1) {
    return result('unknown', 'ambiguous-relocation', {
      candidateCount: matches.length,
      coverage: 'current-complete',
      strategy: 'content-hash',
    });
  }
  if (matches.length === 1) {
    return result(
      matches[0].path === citation.path ? 'exact' : 'relocated',
      matches[0].path === citation.path ? 'exact' : 'relocated',
      {
        candidateCount: 1,
        coverage: 'current-complete',
        observedPath: matches[0].path,
        strategy: 'content-hash',
      },
    );
  }
  if (fileInventoryCoverage === 'complete') {
    return result('deleted', 'source-deleted', {
      candidateCount: 0,
      coverage: 'current-complete',
      strategy: 'content-hash',
    });
  }
  // The graph intentionally excludes unsupported/ignored/generated paths, so
  // absence from its inventory is not repository-wide deletion proof.
  return result('unknown', 'graph-incomplete', {
    candidateCount: 0,
    coverage: 'incomplete',
    strategy: 'content-hash',
  });
}

export const validateContextBriefSymbolCitation = Effect.fn('contextBrief.validateSymbolCitation')(function* (
  citation: MemoryCodeCitationV1 & {
    readonly target: Extract<MemoryCodeCitationV1['target'], {readonly kind: 'symbol'}>;
  },
  exactSymbol: CodeGraphSymbol | undefined,
  locatorMatches: CodeGraphEffectiveSymbolLocatorMatches | undefined,
  pathObservation: CodeGraphEffectiveFilePathObservation | undefined,
  relocation: CodeGraphEffectiveFileHashMatches | undefined,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  readSource: (
    path: string,
    expectedHash: string,
  ) => Effect.Effect<ReturnType<typeof createCodeGraphSourceSpanCanonicalizer>, unknown, SystemInfo>,
  observedAt: string,
  fileInventoryCoverage: CodeGraphEffectiveSnapshotCitationEvidence['fileInventoryCoverage'] = 'incomplete',
) {
  const result = (
    status: ContextBriefCitationValidationReceiptV2['status'],
    reason: ContextBriefCitationValidationReceiptV2['reason'],
    observation: ReceiptObservation,
  ) => receipt(citation, snapshot, status, reason, observation, observedAt);
  if (snapshot.extractorSet !== citation.extractorSet) {
    return result('unknown', 'extractor-mismatch', {
      candidateCount: 0,
      coverage: 'incomplete',
      strategy: 'none',
    });
  }
  const citedLocator = symbolLocator(citation);
  const observe = Effect.fn('contextBrief.observeSymbolCitationCandidate')(function* (symbol: CodeGraphSymbol) {
    if (!sameSymbolLocator(citedLocator, symbolLocatorFromSymbol(symbol))) return undefined;
    const signatureMatches =
      citation.target.signatureHash === undefined
        ? true
        : symbol.signature !== undefined &&
          (yield* sha256Hex(symbol.signature)) === citation.target.signatureHash.value;
    const source = yield* readSource(symbol.path, symbol.contentHash).pipe(Effect.option);
    if (source._tag === 'None') return undefined;
    const fragment = source.value.fragment(symbol.span);
    if (!fragment.ok) return undefined;
    return {
      fragmentMatches: fragment.fragment.sha256 === citation.target.fragmentHash.value,
      signatureMatches,
      symbol,
    };
  });

  if (exactSymbol) {
    if (!sameSymbolLocator(citedLocator, symbolLocatorFromSymbol(exactSymbol))) {
      return result('unknown', 'validation-error', symbolObservation(exactSymbol, 1, 'incomplete', 'node-id'));
    }
    const exact = yield* observe(exactSymbol);
    if (exact === undefined) {
      return result('unknown', 'validation-error', symbolObservation(exactSymbol, 1, 'incomplete', 'node-id'));
    }
    if (!exact.fragmentMatches || !exact.signatureMatches) {
      return result('changed', 'source-changed', symbolObservation(exactSymbol, 1, 'current-complete', 'node-id'));
    }
    const stayed = exactSymbol.path === citation.path && sameSpan(exactSymbol.span, citation.target.span);
    return result(
      stayed ? 'exact' : 'relocated',
      stayed ? 'exact' : 'relocated',
      symbolObservation(exactSymbol, 1, 'current-complete', 'node-id'),
    );
  }

  const candidates = new Map<string, CodeGraphSymbol>();
  for (const symbol of locatorMatches?.symbols ?? []) candidates.set(symbol.id, symbol);
  const exactFile = pathObservation?.file;
  const originalLocatorCandidates = [...candidates.values()].filter(
    symbol => symbol.path === citation.path && sameSpan(symbol.span, citation.target.span),
  );
  if (originalLocatorCandidates.length === 1) {
    const original = yield* observe(originalLocatorCandidates[0]);
    if (original === undefined) {
      return result('unknown', 'validation-error', {
        candidateCount: candidates.size,
        coverage: 'incomplete',
        strategy: 'semantic-locator',
      });
    }
    if (!original.fragmentMatches || !original.signatureMatches) {
      return result(
        'changed',
        'source-changed',
        symbolObservation(original.symbol, candidates.size, 'current-complete', 'semantic-locator'),
      );
    }
    const exact = original.symbol.id === citation.target.nodeId;
    return result(
      exact ? 'exact' : 'relocated',
      exact ? 'exact' : 'relocated',
      symbolObservation(original.symbol, candidates.size, 'current-complete', 'semantic-locator'),
    );
  }
  if (originalLocatorCandidates.length > 1) {
    return result('unknown', 'ambiguous-relocation', {
      candidateCount: candidates.size,
      coverage: 'current-complete',
      strategy: 'semantic-locator',
    });
  }
  if (candidates.size > 1 || locatorMatches?.truncated) {
    return result('unknown', 'ambiguous-relocation', {
      candidateCount: candidates.size,
      coverage: 'current-complete',
      strategy: 'semantic-locator',
    });
  }
  const observed: {
    readonly fragmentMatches: boolean;
    readonly signatureMatches: boolean;
    readonly symbol: CodeGraphSymbol;
  }[] = [];
  let readFailed = false;
  for (const symbol of candidates.values()) {
    const observation = yield* observe(symbol);
    if (observation === undefined) readFailed = true;
    else observed.push(observation);
  }
  const matching = observed.filter(item => item.fragmentMatches && item.signatureMatches);
  if (readFailed) {
    return result('unknown', 'validation-error', {
      candidateCount: candidates.size,
      coverage: 'incomplete',
      strategy: 'semantic-locator',
    });
  }
  if (matching.length === 1) {
    const match = matching[0].symbol;
    const exact =
      match.id === citation.target.nodeId && match.path === citation.path && sameSpan(match.span, citation.target.span);
    return result(
      exact ? 'exact' : 'relocated',
      exact ? 'exact' : 'relocated',
      symbolObservation(match, 1, 'current-complete', 'semantic-locator'),
    );
  }
  if (observed.length === 1) {
    return result(
      'changed',
      'source-changed',
      symbolObservation(observed[0].symbol, 1, 'current-complete', 'semantic-locator'),
    );
  }
  if (exactFile?.contentHash === citation.fileContentHash.value) {
    return result('unknown', 'graph-incomplete', {
      candidateCount: candidates.size,
      coverage: 'incomplete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  if (exactFile) {
    return result('unknown', 'graph-incomplete', {
      candidateCount: 0,
      coverage: 'incomplete',
      observedPath: exactFile.path,
      strategy: 'file-path',
    });
  }
  if (relocation?.truncated || (relocation?.files.length ?? 0) > 0) {
    return result('unknown', 'graph-incomplete', {
      candidateCount: relocation?.files.length ?? 0,
      coverage: 'incomplete',
      strategy: 'content-hash',
    });
  }
  if (fileInventoryCoverage === 'complete') {
    return result('deleted', 'source-deleted', {
      candidateCount: 0,
      coverage: 'current-complete',
      strategy: 'content-hash',
    });
  }
  return result('unknown', 'graph-incomplete', {
    candidateCount: candidates.size,
    coverage: 'incomplete',
    strategy: 'none',
  });
});

function symbolCitationSourceCandidates(
  citation: MemoryCodeCitationV1 & {
    readonly target: Extract<MemoryCodeCitationV1['target'], {readonly kind: 'symbol'}>;
  },
  exactSymbol: CodeGraphSymbol | undefined,
  locatorMatches: CodeGraphEffectiveSymbolLocatorMatches | undefined,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
): readonly CodeGraphSymbol[] {
  if (snapshot.extractorSet !== citation.extractorSet) return [];
  const citedLocator = symbolLocator(citation);
  if (exactSymbol !== undefined) {
    return sameSymbolLocator(citedLocator, symbolLocatorFromSymbol(exactSymbol)) ? [exactSymbol] : [];
  }
  const candidates = new Map<string, CodeGraphSymbol>();
  for (const symbol of locatorMatches?.symbols ?? []) candidates.set(symbol.id, symbol);
  const originalLocatorCandidates = [...candidates.values()].filter(
    symbol => symbol.path === citation.path && sameSpan(symbol.span, citation.target.span),
  );
  if (originalLocatorCandidates.length === 1) return originalLocatorCandidates;
  if (originalLocatorCandidates.length > 1 || candidates.size > 1 || locatorMatches?.truncated) return [];
  return [...candidates.values()];
}

function sameSpan(left: CodeGraphSymbol['span'], right: CodeGraphSymbol['span']): boolean {
  return (
    left.line === right.line &&
    left.column === right.column &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}

function symbolLocator(citation: MemoryCodeCitationV1): CodeGraphSymbolSemanticLocatorV1 {
  if (citation.target.kind !== 'symbol') throw new Error('Symbol locator requires a symbol citation.');
  return {
    kind: citation.target.symbolKind,
    language: citation.target.language,
    name: citation.target.name,
    qualifiedName: citation.target.qualifiedName,
    version: 1,
  };
}

function symbolLocatorFromSymbol(symbol: CodeGraphSymbol): CodeGraphSymbolSemanticLocatorV1 {
  return {
    kind: symbol.kind,
    language: symbol.language,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    version: 1,
  };
}

function sameSymbolLocator(left: CodeGraphSymbolSemanticLocatorV1, right: CodeGraphSymbolSemanticLocatorV1): boolean {
  return locatorKey(left) === locatorKey(right);
}

function locatorKey(locator: CodeGraphSymbolSemanticLocatorV1): string {
  return JSON.stringify([locator.version, locator.language, locator.kind, locator.name, locator.qualifiedName]);
}

interface ReceiptObservation {
  readonly candidateCount: number;
  readonly coverage: ContextBriefCitationValidationReceiptV2['coverage'];
  readonly observedLocator?: ContextBriefCitationValidationReceiptV2['observedLocator'];
  readonly observedNodeId?: string;
  readonly observedPath?: string;
  readonly observedSpan?: CodeGraphSymbol['span'];
  readonly strategy: ContextBriefCitationValidationReceiptV2['strategy'];
}

function symbolObservation(
  symbol: CodeGraphSymbol,
  candidateCount: number,
  coverage: ReceiptObservation['coverage'],
  strategy: ReceiptObservation['strategy'],
): ReceiptObservation {
  return {
    candidateCount,
    coverage,
    observedLocator: symbolLocatorFromSymbol(symbol),
    observedNodeId: symbol.id,
    observedPath: symbol.path,
    observedSpan: symbol.span,
    strategy,
  };
}

function receipt(
  citation: MemoryCodeCitationV1,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  status: ContextBriefCitationValidationReceiptV2['status'],
  reason: ContextBriefCitationValidationReceiptV2['reason'],
  observation: ReceiptObservation,
  observedAt: string,
): ContextBriefCitationValidationReceiptV2 {
  return {
    candidateCount: observation.candidateCount,
    citationId: citation.id,
    coverage: observation.coverage,
    kind: citation.target.kind,
    observedAt,
    ...(observation.observedLocator === undefined ? {} : {observedLocator: observation.observedLocator}),
    ...(observation.observedNodeId === undefined ? {} : {observedNodeId: observation.observedNodeId}),
    ...(observation.observedPath === undefined ? {} : {observedPath: observation.observedPath}),
    ...(observation.observedSpan === undefined ? {} : {observedSpan: observation.observedSpan}),
    reason,
    repositoryId: citation.repositoryId,
    snapshotCommit: snapshot.commit,
    ...(snapshot.completedAt === undefined ? {} : {snapshotCompletedAt: snapshot.completedAt}),
    snapshotId: snapshot.id,
    sourcePath: citation.path,
    status,
    strategy: observation.strategy,
    validatorVersion: 1,
  };
}

function unknownReceipt(
  citation: MemoryCodeCitationV1,
  reason: Extract<
    ContextBriefCitationValidationReceiptV2['reason'],
    'citation-limit' | 'graph-stale' | 'repository-ambiguous' | 'repository-unavailable' | 'validation-error'
  >,
  observedAt: string,
): ContextBriefCitationValidationReceiptV2 {
  return {
    candidateCount: 0,
    citationId: citation.id,
    coverage: 'incomplete',
    kind: citation.target.kind,
    observedAt,
    reason,
    repositoryId: citation.repositoryId,
    sourcePath: citation.path,
    status: 'unknown',
    strategy: 'none',
    validatorVersion: 1,
  };
}

const validationScopeTargets = Effect.fn('contextBrief.validationScopeTargets')(function* (
  config: RuntimeConfig,
  scope: ContextBriefScopeV1,
  admittedRepositoryIds: ReadonlySet<string>,
  fence: ContextBriefCitationValidationFenceV2 | undefined,
) {
  if (scope.kind === 'repository') {
    if (fence?.kind === 'workset') {
      return {
        ambiguousRepositoryIds: new Set<string>(),
        targets: [],
        unavailableReason: 'graph-stale',
      } satisfies ValidationScopeResolution;
    }
    return {
      ambiguousRepositoryIds: new Set<string>(),
      ...(fence === undefined ? {} : {requiredSnapshot: fence}),
      targets: [{cwd: scope.callerCwd}],
      unavailableReason: fence === undefined ? 'repository-unavailable' : 'graph-stale',
    } satisfies ValidationScopeResolution;
  }
  const workset = yield* requireWorkset(config.manifestPath, scope.name);
  const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(config.agentContextHome, workset.name).pipe(
    Effect.option,
  );
  const expectedGeneration =
    fence === undefined
      ? undefined
      : fence.kind === 'workset' && fence.workset === workset.name
        ? fence.generation
        : {digest: '', id: ''};
  const route = routeContextBriefWorksetValidation(
    workset,
    published._tag === 'Some' ? published.value : undefined,
    admittedRepositoryIds,
    expectedGeneration,
  );
  const expanded = yield* Effect.forEach(
    route.members,
    member =>
      expandPath(member.projectPath).pipe(
        Effect.map(
          cwd => ({cwd, expected: member.published, published: member.published}) satisfies ValidationRepositoryTarget,
        ),
        Effect.option,
      ),
    {concurrency: VALIDATION_CONCURRENCY},
  );
  return {
    ambiguousRepositoryIds: route.ambiguousRepositoryIds,
    targets: expanded.flatMap(target => (target._tag === 'Some' ? [target.value] : [])),
    unavailableReason: route.stale ? 'graph-stale' : 'repository-unavailable',
    ...(route.generation === undefined ? {} : {worksetGeneration: {...route.generation, workset: workset.name}}),
  } satisfies ValidationScopeResolution;
});

/**
 * Route only cited repositories through one published workset generation.
 * Scanning manifest metadata is cheap; repository discovery/status is bounded
 * by the admitted citation IDs and never fans out across the entire workset.
 */
export function routeContextBriefWorksetValidation(
  workset: ResolvedWorkset,
  published: CodeGraphWorksetCatalogPublishedGenerationV1 | undefined,
  admittedRepositoryIds: ReadonlySet<string>,
  expectedGeneration?: {readonly digest: string; readonly id: string},
): ContextBriefWorksetValidationRoute {
  if (
    published === undefined ||
    published.worksetName !== workset.name ||
    published.manifestDigest !== codeGraphWorksetManifestDigest(workset) ||
    (expectedGeneration !== undefined &&
      (published.id !== expectedGeneration.id || published.digest !== expectedGeneration.digest))
  ) {
    return {ambiguousRepositoryIds: new Set<string>(), members: [], stale: true};
  }
  const projectsByKey = new Map(workset.projects.map(project => [worksetRepositoryKey(project.name), project]));
  const routedByRepository = new Map<
    string,
    {readonly projectPath: string; readonly published: CodeGraphWorksetCatalogPublishedMemberV1}[]
  >();
  for (const member of published.members) {
    if (!admittedRepositoryIds.has(member.repositoryId)) continue;
    const project = projectsByKey.get(member.repositoryKey);
    if (project === undefined) continue;
    const routes = routedByRepository.get(member.repositoryId) ?? [];
    routes.push({projectPath: project.path, published: member});
    routedByRepository.set(member.repositoryId, routes);
  }
  const ambiguousRepositoryIds = new Set<string>();
  const members: Array<{
    readonly projectPath: string;
    readonly published: CodeGraphWorksetCatalogPublishedMemberV1;
  }> = [];
  for (const repositoryId of admittedRepositoryIds) {
    const routes = routedByRepository.get(repositoryId) ?? [];
    if (routes.length > 1) ambiguousRepositoryIds.add(repositoryId);
    else if (routes.length === 1) members.push(routes[0]);
  }
  return {
    ambiguousRepositoryIds,
    generation: {digest: published.digest, id: published.id},
    members,
    stale: false,
  };
}

const worksetGenerationIsStillPublished = Effect.fn('contextBrief.worksetGenerationStillPublished')(function* (
  config: RuntimeConfig,
  expected: {readonly digest: string; readonly id: string; readonly workset: string},
) {
  const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(
    config.agentContextHome,
    expected.workset,
  ).pipe(Effect.option);
  return (
    published._tag === 'Some' && published.value?.id === expected.id && published.value?.digest === expected.digest
  );
});

function worksetRepositoryKey(value: string): string {
  const normalized = value.replace(/[\r\n\t\0]/gu, ' ').trim();
  return normalized.slice(0, 256) || 'unknown';
}

function sameExactSnapshot(before: CodeGraphStatus, after: CodeGraphStatus): boolean {
  return (
    !after.stale &&
    after.freshness === 'current' &&
    before.databasePath === after.databasePath &&
    before.identity.repositoryId === after.identity.repositoryId &&
    before.identity.worktreeId === after.identity.worktreeId &&
    before.readySnapshot?.id === after.readySnapshot?.id
  );
}

/** Immutable published-catalog receipt required before citation evidence reads. */
export function cleanPublishedCatalogSnapshotMatches(
  published: CodeGraphWorksetCatalogPublishedMemberV1,
  snapshot: CodeGraphSnapshot,
): boolean {
  return (
    snapshot.state === 'ready' &&
    snapshot.dirty === false &&
    snapshot.id === published.snapshotId &&
    snapshot.repositoryId === published.repositoryId &&
    snapshot.commit === published.commitId &&
    snapshot.symbolCount === published.symbolCount
  );
}

/** Final catalog-first fence after the complete live repository observation. */
export function cleanPublishedCatalogFenceMatches(
  published: CodeGraphWorksetCatalogPublishedMemberV1,
  selected: CodeGraphSnapshot,
  identity: Pick<RepositoryIdentity, 'checkoutId' | 'headCommit' | 'repositoryId' | 'worktreeId'>,
  active: CodeGraphSnapshot | undefined,
): boolean {
  return (
    cleanPublishedCatalogSnapshotMatches(published, selected) &&
    identity.checkoutId === published.checkoutId &&
    identity.repositoryId === published.repositoryId &&
    identity.worktreeId === published.worktreeId &&
    identity.headCommit === selected.commit &&
    active?.state === 'ready' &&
    active.dirty === false &&
    active.id === selected.id &&
    active.repositoryId === selected.repositoryId &&
    active.commit === selected.commit &&
    active.symbolCount === selected.symbolCount &&
    active.extractorSet === selected.extractorSet &&
    active.graphContentId === selected.graphContentId &&
    active.baseSnapshotId === selected.baseSnapshotId &&
    active.fileCount === selected.fileCount &&
    active.edgeCount === selected.edgeCount &&
    active.overlayFingerprint === selected.overlayFingerprint
  );
}

/** Exact final fence for a clean snapshot selected from a published Workset. */
export function cleanPublishedCitationFenceMatches(
  before: CodeGraphStatus,
  identity: RepositoryIdentity,
  overlay: {readonly dirty: boolean; readonly fingerprint?: string} | undefined,
  activeSnapshot: CodeGraphSnapshot | undefined,
): boolean {
  const selected = before.readySnapshot;
  return (
    selected !== undefined &&
    selected.dirty === false &&
    overlay?.dirty === false &&
    identity.checkoutId === before.identity.checkoutId &&
    identity.repositoryId === before.identity.repositoryId &&
    identity.worktreeId === before.identity.worktreeId &&
    identity.headCommit === selected.commit &&
    activeSnapshot?.id === selected.id &&
    activeSnapshot.commit === selected.commit &&
    activeSnapshot.repositoryId === selected.repositoryId &&
    activeSnapshot.worktreeId === selected.worktreeId
  );
}

/** Preserve policy-aware freshness when the raw clean probe observes changes. */
export const resolveContextBriefFinalFenceOverlay = Effect.fn('contextBrief.resolveFinalFenceOverlay')(function* (
  identity: RepositoryIdentity,
  cleanOverlay: {readonly dirty: false; readonly fingerprint?: undefined} | undefined,
) {
  return cleanOverlay ?? (yield* worktreeOverlayState(identity));
});

function validationCacheKey(repositoryId: string, worktreeId: string, snapshotId: string, citationId: string): string {
  return `${repositoryId}\u0000${worktreeId}\u0000${snapshotId}\u0000${citationId}`;
}

function validationCacheGet(key: string): ContextBriefCitationValidationReceiptV2 | undefined {
  const cached = validationReceiptCache.get(key);
  if (cached === undefined) return undefined;
  validationReceiptCache.delete(key);
  validationReceiptCache.set(key, cached);
  return cached;
}

function validationCacheSet(key: string, receipt: ContextBriefCitationValidationReceiptV2): void {
  validationReceiptCache.delete(key);
  validationReceiptCache.set(key, receipt);
  while (validationReceiptCache.size > VALIDATION_CACHE_LIMIT) {
    const oldest = validationReceiptCache.keys().next().value;
    if (oldest === undefined) break;
    validationReceiptCache.delete(oldest);
  }
}
