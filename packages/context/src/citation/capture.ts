import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {
  CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1,
  createCodeGraphSourceSpanCanonicalizer,
} from '@threadnote/graph/citation/primitives';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '@threadnote/graph/citation/source';
import {retainCodeGraphCitationEvidence} from '@threadnote/graph/citation/capsule';
import {decodeUtf8} from '@threadnote/graph/inventory/content';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {codeGraphScopeAdmitsPath} from '@threadnote/graph/scope/applicability';
import {resolveCodeGraphScopeRoute} from '@threadnote/graph/scope/routing';
import {CodeGraphStore} from '@threadnote/graph/store';
import {type CodeGraphStatus, type CodeGraphSymbol, isCodeGraphStoreError} from '@threadnote/graph/types';
import {
  resolveCodeGraphQualifiedRefTargets,
  type ResolvedCodeGraphQualifiedRefTargetV1,
} from '@threadnote/graph/workset/query_v2';
import {sha256Hex} from '@threadnote/platform/digest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {
  assertMemoryCodeCitation,
  createMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_CODE_CITATION_VERSION,
  type MemoryCodeCitationV1,
} from '@threadnote/memory/code/citation';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const LOCAL_SYMBOL_REF = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
const QUALIFIED_SYMBOL_REF = /^cgr_[0-9a-f]{40}$/u;

export const MEMORY_CODE_CITATION_GRAPH_PREPARATION_COMMAND = 'threadnote graph index --no-vectors' as const;
export const MEMORY_CODE_CITATION_WORKSET_PREPARATION_COMMAND = 'threadnote workset prepare' as const;

export type MemoryCodeCitationCaptureRecoveryCode = 'exact-current-evidence-unavailable' | 'ready-graph-unavailable';
export type MemoryCodeCitationCaptureFailureCode = 'code-reference-unresolved' | 'outside-project-graph';

export type MemoryCodeCitationGraphPreparationV1 =
  | {
      readonly action: 'index-current-graph';
      readonly arguments: readonly [];
      readonly command: typeof MEMORY_CODE_CITATION_GRAPH_PREPARATION_COMMAND;
      readonly target: 'callerCwd';
    }
  | {
      readonly action: 'prepare-workset';
      readonly arguments: readonly [worksetName: string];
      readonly command: typeof MEMORY_CODE_CITATION_WORKSET_PREPARATION_COMMAND;
      readonly target: 'workset';
    };

export interface MemoryCodeCitationCaptureRecoveryV1 {
  readonly code: MemoryCodeCitationCaptureRecoveryCode;
  readonly indexingStarted: false;
  readonly observedGraph: {
    readonly freshness: CodeGraphStatus['freshness'];
    readonly readySnapshot: 'absent' | 'available';
    readonly stale: boolean;
  };
  readonly preparation: MemoryCodeCitationGraphPreparationV1;
  readonly recovery: 'prepare-current-graph';
  readonly retryCondition: 'after-current-graph-ready';
  readonly retryable: true;
  readonly type: 'memory-code-citation-capture-recovery';
  readonly version: 1;
}

export interface ExpectedMemoryCodeCitationCallerIdentity {
  readonly repositoryId: string;
  readonly worktreeId: string;
}

/** Private proof that a deferred capture still targets its original project graph. */
export interface MemoryCodeCitationProjectScopeReceiptV1 {
  readonly closureDigest: string;
  readonly definitionDigest: string;
  readonly project: string;
  readonly scopeKey: string;
}

export type MemoryCodeCitationProjectScopeExpectationV1 =
  MemoryCodeCitationProjectScopeReceiptV1 | {readonly kind: 'full'};

export function memoryCodeCitationProjectScopeReceipt(
  status: CodeGraphStatus,
): MemoryCodeCitationProjectScopeReceiptV1 | undefined {
  const selection = observationFromCodeGraphStatus(status)?.projectScope;
  if (selection?.scope === undefined) return undefined;
  return {
    closureDigest: selection.scope.closureDigest,
    definitionDigest: selection.scope.definitionDigest,
    project: selection.project.name,
    scopeKey: selection.scope.scopeKey,
  };
}

export function memoryCodeCitationProjectScopeMatches(
  status: CodeGraphStatus,
  expected: MemoryCodeCitationProjectScopeExpectationV1,
): boolean {
  const actual = memoryCodeCitationProjectScopeReceipt(status);
  return 'kind' in expected
    ? actual === undefined
    : actual !== undefined &&
        actual.project === expected.project &&
        actual.scopeKey === expected.scopeKey &&
        actual.definitionDigest === expected.definitionDigest &&
        actual.closureDigest === expected.closureDigest;
}

const resolveCodeGraphProjectForCaller = Effect.fn('memoryCodeCitation.resolveGraphProject')(function* (
  config: RuntimeConfig,
  callerCwd: string,
  requestedProject?: string,
) {
  if (requestedProject === undefined || config.manifestSource === 'bundled-example') return requestedProject;
  const route = yield* resolveCodeGraphScopeRoute(config.manifestPath, callerCwd, requestedProject).pipe(Effect.option);
  return Option.isSome(route) && route.value.state === 'selected' ? route.value.project.name : requestedProject;
});

export class MemoryCodeCitationCaptureError extends Schema.TaggedError<MemoryCodeCitationCaptureError>()(
  'MemoryCodeCitationCaptureError',
  {
    failureCode: Schema.optionalKey(Schema.Literals(['code-reference-unresolved', 'outside-project-graph'])),
    message: Schema.String,
    recovery: Schema.optionalKey(Schema.Any),
    retryable: Schema.Boolean,
  },
) {
  static of(
    message: string,
    recovery?: MemoryCodeCitationCaptureRecoveryV1,
    failureCode?: MemoryCodeCitationCaptureFailureCode,
    retryable = false,
  ): MemoryCodeCitationCaptureError {
    return MemoryCodeCitationCaptureError.make({
      message,
      retryable,
      ...(failureCode === undefined ? {} : {failureCode}),
      ...(recovery === undefined ? {} : {recovery}),
    });
  }
}

interface CaptureTarget {
  readonly project?: string;
  readonly cwd: string;
  readonly index: number;
  readonly preparation: MemoryCodeCitationGraphPreparationV1;
  readonly ref: string;
  readonly target: {readonly kind: 'file'; readonly path: string} | {readonly kind: 'symbol'; readonly nodeId: string};
}

/**
 * Capture immutable code evidence only from an already-published, exact-current
 * graph. This path never attaches, indexes, refreshes, or requests maintenance.
 */
export const captureMemoryCodeCitations = Effect.fn('memoryCodeCitation.capture')(function* (
  config: RuntimeConfig,
  input: {
    readonly callerCwd: string;
    readonly project?: string;
    readonly expectedCallerIdentity?: ExpectedMemoryCodeCitationCallerIdentity;
    readonly expectedProjectScope?: MemoryCodeCitationProjectScopeExpectationV1;
    readonly omitUnresolved?: boolean;
    readonly refs?: readonly string[];
  },
) {
  const refs = yield* Effect.try({
    try: () => normalizeMemoryCodeRefs(input.refs ?? []),
    catch: cause => captureError('code references', cause),
  });
  if (refs.length === 0) return [] as readonly MemoryCodeCitationV1[];
  // The bundled example manifest is instructional fallback metadata, not a
  // configured graph catalog. Preserve the historical full-repository route
  // when callers supply the memory project name against that fallback.
  const project =
    config.manifestSource === 'bundled-example'
      ? undefined
      : yield* resolveCodeGraphProjectForCaller(config, input.callerCwd, input.project);
  const path = yield* Path.Path;
  if (!path.isAbsolute(input.callerCwd)) {
    return yield* MemoryCodeCitationCaptureError.of('Code citation callerCwd must be absolute.');
  }

  const invalidQualifiedRef = refs.find(ref => ref.startsWith('cgr_') && !QUALIFIED_SYMBOL_REF.test(ref));
  if (invalidQualifiedRef !== undefined) {
    return yield* MemoryCodeCitationCaptureError.of(`Invalid qualified code graph reference: ${invalidQualifiedRef}.`);
  }
  const qualifiedRefs = refs.filter(ref => QUALIFIED_SYMBOL_REF.test(ref));
  // Local groups already fence the caller before and after capture. Qualified
  // references can target another checkout, so they need a separate caller fence.
  const fenceCallerSeparately =
    qualifiedRefs.length > 0 &&
    (input.expectedCallerIdentity !== undefined || input.expectedProjectScope !== undefined);
  const query = yield* CodeGraphQueryService;
  if (fenceCallerSeparately) {
    const callerBefore = yield* query
      .status(config.agentContextHome, input.callerCwd, {
        project,
        manifestPath: config.manifestPath,
        observeWorktree: true,
        requestMaintenance: false,
      })
      .pipe(Effect.mapError(error => captureError('caller repository identity', error)));
    if (input.expectedCallerIdentity) yield* requireExpectedCallerIdentity(callerBefore, input.expectedCallerIdentity);
    if (input.expectedProjectScope) yield* requireExpectedProjectScope(callerBefore, input.expectedProjectScope);
  }

  const qualifiedTargets = yield* resolveCodeGraphQualifiedRefTargets(
    config,
    qualifiedRefs,
    input.callerCwd,
    project,
  ).pipe(Effect.mapError(error => captureError('qualified code references', error)));
  const qualifiedByRef = new Map(qualifiedTargets.map(target => [target.ref, target]));
  const targets = yield* Effect.forEach(refs, (ref, index) =>
    resolveCaptureTarget(input.callerCwd, ref, index, qualifiedByRef, project),
  );
  const groups = new Map<string, CaptureTarget[]>();
  for (const target of targets) {
    const key = `${target.cwd}\0${target.project ?? ''}`;
    const group = groups.get(key) ?? [];
    group.push(target);
    groups.set(key, group);
  }
  const capturedGroups = yield* Effect.forEach(
    [...groups.entries()],
    ([, group]) =>
      captureRepositoryGroup(
        config,
        group[0].cwd,
        group,
        group[0].cwd === input.callerCwd ? input.expectedCallerIdentity : undefined,
        group[0].cwd === input.callerCwd ? input.expectedProjectScope : undefined,
        input.omitUnresolved === true,
        group[0].project,
      ),
    {concurrency: 4},
  );
  if (fenceCallerSeparately) {
    const callerAfter = yield* query
      .status(config.agentContextHome, input.callerCwd, {
        project,
        manifestPath: config.manifestPath,
        observeWorktree: true,
        requestMaintenance: false,
      })
      .pipe(Effect.mapError(error => captureError('caller repository identity', error)));
    if (input.expectedCallerIdentity) yield* requireExpectedCallerIdentity(callerAfter, input.expectedCallerIdentity);
    if (input.expectedProjectScope) yield* requireExpectedProjectScope(callerAfter, input.expectedProjectScope);
  }
  const ordered = capturedGroups.flat().sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  const citations: MemoryCodeCitationV1[] = [];
  for (const item of ordered) {
    if (seen.has(item.citation.id)) continue;
    seen.add(item.citation.id);
    citations.push(item.citation);
  }
  return citations;
});

function resolveCaptureTarget(
  callerCwd: string,
  ref: string,
  index: number,
  qualifiedByRef: ReadonlyMap<string, ResolvedCodeGraphQualifiedRefTargetV1>,
  project?: string,
) {
  return Effect.gen(function* () {
    if (QUALIFIED_SYMBOL_REF.test(ref)) {
      const target = qualifiedByRef.get(ref);
      if (target === undefined) {
        return yield* MemoryCodeCitationCaptureError.of(
          `Qualified code graph reference is unresolved: ${ref}.`,
          undefined,
          'code-reference-unresolved',
        );
      }
      return {
        project: target.project,
        cwd: target.cwd,
        index,
        preparation:
          target.route.kind === 'caller' ? callerGraphPreparation() : worksetGraphPreparation(target.route.name),
        ref,
        target: {kind: 'symbol', nodeId: target.nodeId},
      } satisfies CaptureTarget;
    }
    if (LOCAL_SYMBOL_REF.test(ref)) {
      return {
        project,
        cwd: callerCwd,
        index,
        preparation: callerGraphPreparation(),
        ref,
        target: {kind: 'symbol', nodeId: ref},
      } satisfies CaptureTarget;
    }
    if (ref.startsWith('cgs_')) {
      return yield* MemoryCodeCitationCaptureError.of(`Invalid local code graph reference: ${ref}.`);
    }
    return {
      project,
      cwd: callerCwd,
      index,
      preparation: callerGraphPreparation(),
      ref,
      target: {kind: 'file', path: ref},
    } satisfies CaptureTarget;
  });
}

const captureRepositoryGroup = Effect.fn('memoryCodeCitation.captureRepositoryGroup')(function* (
  config: RuntimeConfig,
  cwd: string,
  targets: readonly CaptureTarget[],
  expectedCallerIdentity?: ExpectedMemoryCodeCitationCallerIdentity,
  expectedProjectScope?: MemoryCodeCitationProjectScopeExpectationV1,
  omitUnresolved = false,
  project?: string,
) {
  const query = yield* CodeGraphQueryService;
  const store = yield* CodeGraphStore;
  const fs = yield* FileSystem.FileSystem;
  const before = yield* query
    .status(config.agentContextHome, cwd, {
      project,
      manifestPath: config.manifestPath,
      observeWorktree: true,
      requestMaintenance: false,
    })
    .pipe(Effect.mapError(error => captureError(cwd, error)));
  if (expectedCallerIdentity) yield* requireExpectedCallerIdentity(before, expectedCallerIdentity);
  if (expectedProjectScope) yield* requireExpectedProjectScope(before, expectedProjectScope);
  const snapshot = yield* Effect.try({
    try: () => requireExactCurrentSnapshot(before, captureGroupPreparation(targets)),
    catch: cause => captureError(cwd, cause),
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(store.acquireSnapshotLease(before.databasePath, snapshot.id, 60_000), token =>
        store.releaseSnapshotLease(before.databasePath, token).pipe(Effect.ignore),
      );
      const repositoryRoot = yield* fs
        .realPath(before.identity.repoRoot)
        .pipe(Effect.mapError(error => captureError(before.identity.repoRoot, error)));

      const fileTargets = targets.filter(
        (target): target is CaptureTarget & {readonly target: {readonly kind: 'file'; readonly path: string}} =>
          target.target.kind === 'file',
      );
      const symbolTargets = targets.filter(
        (target): target is CaptureTarget & {readonly target: {readonly kind: 'symbol'; readonly nodeId: string}} =>
          target.target.kind === 'symbol',
      );
      const evidence = yield* store
        .effectiveSnapshotCitationEvidence(before.databasePath, snapshot.id, {
          paths: fileTargets.map(target => target.target.path),
          symbolIds: symbolTargets.map(target => target.target.nodeId),
        })
        .pipe(Effect.mapError(error => captureError(cwd, error)));
      const files = evidence.filesByPaths;
      const symbols = evidence.symbolsByIds;
      const fileByPath = new Map(
        files.flatMap(observation => (observation.file ? [[observation.path, observation.file]] : [])),
      );
      const symbolById = new Map(symbols.map(symbol => [symbol.id, symbol]));
      const sourceBytes = yield* readCodeGraphCitationSources({
        objectFormat: before.identity.objectFormat,
        repositoryRoot,
        sourceCommit: snapshot.commit,
        sources: [
          ...fileTargets.flatMap(target => {
            const file = fileByPath.get(target.target.path);
            return file === undefined
              ? []
              : [{expectedContentHash: file.contentHash, repositoryPath: file.path, requireBytes: true}];
          }),
          ...symbolTargets.flatMap(target => {
            const symbol = symbolById.get(target.target.nodeId);
            return symbol === undefined
              ? []
              : [{expectedContentHash: symbol.contentHash, repositoryPath: symbol.path, requireBytes: true}];
          }),
        ],
      });
      const sourceCache = new Map<
        string,
        {
          readonly bytes: Uint8Array;
          readonly canonicalizer?: ReturnType<typeof createCodeGraphSourceSpanCanonicalizer>;
        }
      >();
      const readSource = (repositoryPath: string, expectedContentHash: string, needsText: boolean) =>
        Effect.gen(function* () {
          const cacheKey = `${repositoryPath}\0${expectedContentHash}`;
          const cached = sourceCache.get(cacheKey);
          if (cached && (!needsText || cached.canonicalizer !== undefined)) return cached;
          const bytes =
            cached?.bytes ?? sourceBytes.get(codeGraphCitationSourceKey({expectedContentHash, repositoryPath}));
          if (bytes === undefined) {
            return yield* MemoryCodeCitationCaptureError.of(
              `Code citation source changed during capture: ${repositoryPath}.`,
            );
          }
          const source = needsText ? decodeUtf8(bytes) : undefined;
          if (needsText && source === undefined) {
            return yield* MemoryCodeCitationCaptureError.of(
              `Cited symbol source is not valid UTF-8: ${repositoryPath}.`,
            );
          }
          const loaded = {
            ...(source === undefined ? {} : {canonicalizer: createCodeGraphSourceSpanCanonicalizer(source)}),
            bytes,
          };
          sourceCache.set(cacheKey, loaded);
          return loaded;
        });
      const captureFileCitation = Effect.fn('memoryCodeCitation.captureFile')(function* (
        repositoryPath: string,
        contentHash: string,
        index: number,
      ) {
        yield* readSource(repositoryPath, contentHash, false);
        return {
          citation: yield* createCitation({
            extractorSet: snapshot.extractorSet,
            fileContentHash: {algorithm: 'sha256', value: contentHash},
            path: repositoryPath,
            repositoryId: before.identity.repositoryId,
            repositoryIdentityKind: before.identity.remoteIdentity ? 'remote' : 'local',
            sourceCommit: snapshot.commit,
            sourceDirty: snapshot.dirty,
            ...(snapshot.graphContentId === undefined ? {} : {sourceGraphContentId: snapshot.graphContentId}),
            sourceSnapshotId: snapshot.id,
            target: {kind: 'file'},
            version: MEMORY_CODE_CITATION_VERSION,
          }),
          index,
        };
      });

      const results = yield* Effect.forEach(
        targets,
        target =>
          Effect.gen(function* () {
            if (target.target.kind === 'file') {
              const file = fileByPath.get(target.target.path);
              if (!file) {
                if (
                  !codeGraphScopeAdmitsPath(
                    observationFromCodeGraphStatus(before)?.projectScope?.scope,
                    target.target.path,
                  )
                ) {
                  return yield* MemoryCodeCitationCaptureError.of(
                    `Code citation path is outside the selected project graph: ${target.target.path}. Select a project that includes this path or a full-repository graph.`,
                    undefined,
                    'outside-project-graph',
                  );
                }
                if (omitUnresolved) return undefined;
                return yield* MemoryCodeCitationCaptureError.of(
                  `Code citation path is not present in the exact current graph: ${target.target.path}. Use a graph-indexed repository-relative path.`,
                  undefined,
                  'code-reference-unresolved',
                );
              }
              return yield* captureFileCitation(file.path, file.contentHash, target.index);
            }
            const symbol = symbolById.get(target.target.nodeId);
            if (!symbol) {
              if (omitUnresolved) return undefined;
              return yield* MemoryCodeCitationCaptureError.of(
                `Code graph symbol is absent from the exact current graph: ${target.target.nodeId}.`,
                undefined,
                'code-reference-unresolved',
              );
            }
            if (isFileRootSymbol(symbol)) {
              return yield* captureFileCitation(symbol.path, symbol.contentHash, target.index);
            }
            return yield* captureSymbolCitation(before, snapshot, symbol, target.index, readSource);
          }).pipe(Effect.mapError(error => captureError(target.ref, error))),
        {concurrency: 4},
      );
      const capturedTargets = results.filter(
        (result): result is NonNullable<(typeof results)[number]> => result !== undefined,
      );

      // Complete preservation before releasing the snapshot lease or returning
      // anchors: dirty source has no clean-Git recovery after worktree removal.
      const retainedTargets: typeof capturedTargets = [];
      for (const captured of capturedTargets) {
        const {citation} = captured;
        const bytes = sourceBytes.get(
          codeGraphCitationSourceKey({
            expectedContentHash: citation.fileContentHash.value,
            repositoryPath: citation.path,
          }),
        );
        const retained =
          bytes !== undefined &&
          (yield* retainCodeGraphCitationEvidence({
            bytes,
            checkoutId: before.identity.checkoutId,
            objectFormat: before.identity.objectFormat,
            referenceId: sha256HexSync(citation.id),
            source: {
              extractorSet: citation.extractorSet,
              fileContentHash: citation.fileContentHash.value,
              path: citation.path,
              repositoryId: citation.repositoryId,
              sourceCommit: citation.sourceCommit,
              sourceDirty: citation.sourceDirty,
              sourceSnapshotId: citation.sourceSnapshotId,
            },
            threadnoteHome: config.agentContextHome,
          }));
        retainedTargets.push({
          ...captured,
          citation: assertMemoryCodeCitation({
            ...citation,
            evidenceRetention: retained ? 'capsule-retained' : 'unavailable',
          }),
        });
      }

      const after = yield* query
        .status(config.agentContextHome, cwd, {
          project,
          manifestPath: config.manifestPath,
          observeWorktree: true,
          requestMaintenance: false,
        })
        .pipe(Effect.mapError(error => captureError(cwd, error)));
      if (!sameExactSnapshot(before, after)) {
        return yield* MemoryCodeCitationCaptureError.of(
          'Repository graph or worktree changed while code citations were captured.',
        );
      }
      if (expectedCallerIdentity) yield* requireExpectedCallerIdentity(after, expectedCallerIdentity);
      if (expectedProjectScope) yield* requireExpectedProjectScope(after, expectedProjectScope);
      return retainedTargets;
    }),
  );
});

const requireExpectedCallerIdentity = Effect.fn('memoryCodeCitation.requireExpectedCallerIdentity')(function* (
  status: CodeGraphStatus,
  expected: ExpectedMemoryCodeCitationCallerIdentity,
) {
  if (status.identity.repositoryId !== expected.repositoryId || status.identity.worktreeId !== expected.worktreeId) {
    return yield* MemoryCodeCitationCaptureError.of('Code citation caller repository identity changed during capture.');
  }
});

const requireExpectedProjectScope = Effect.fn('memoryCodeCitation.requireExpectedProjectScope')(function* (
  status: CodeGraphStatus,
  expected: MemoryCodeCitationProjectScopeExpectationV1,
) {
  if (!memoryCodeCitationProjectScopeMatches(status, expected)) {
    return yield* MemoryCodeCitationCaptureError.of(
      'The selected project graph changed since deferred code citation capture; replace the memory with current code references.',
    );
  }
});

function isFileRootSymbol(symbol: CodeGraphSymbol): boolean {
  return ['asset', 'document', 'file', 'module', 'resource'].includes(symbol.kind);
}

const captureSymbolCitation = Effect.fn('memoryCodeCitation.captureSymbol')(function* (
  status: CodeGraphStatus,
  snapshot: NonNullable<CodeGraphStatus['readySnapshot']>,
  symbol: CodeGraphSymbol,
  index: number,
  readSource: (
    path: string,
    expectedContentHash: string,
    needsText: boolean,
  ) => Effect.Effect<
    {
      readonly bytes: Uint8Array;
      readonly canonicalizer?: ReturnType<typeof createCodeGraphSourceSpanCanonicalizer>;
    },
    unknown,
    SystemInfo
  >,
) {
  const loaded = yield* readSource(symbol.path, symbol.contentHash, true);
  const fragment = loaded.canonicalizer!.fragment(symbol.span);
  if (!fragment.ok) {
    return yield* MemoryCodeCitationCaptureError.of(
      `Code graph returned an invalid source span for ${symbol.id}: ${fragment.reason}.`,
    );
  }
  const signatureHash = symbol.signature === undefined ? undefined : yield* sha256Hex(symbol.signature);
  return {
    citation: yield* createCitation({
      extractorSet: snapshot.extractorSet,
      fileContentHash: {algorithm: 'sha256', value: symbol.contentHash},
      path: symbol.path,
      repositoryId: status.identity.repositoryId,
      repositoryIdentityKind: status.identity.remoteIdentity ? 'remote' : 'local',
      sourceCommit: snapshot.commit,
      sourceDirty: snapshot.dirty,
      ...(snapshot.graphContentId === undefined ? {} : {sourceGraphContentId: snapshot.graphContentId}),
      sourceSnapshotId: snapshot.id,
      target: {
        fragmentCanonicalization: CODE_GRAPH_SOURCE_SPAN_CANONICALIZATION_V1,
        fragmentHash: {algorithm: 'sha256', value: fragment.fragment.sha256},
        kind: 'symbol',
        language: symbol.language,
        name: symbol.name,
        nodeId: symbol.id,
        qualifiedName: symbol.qualifiedName,
        ...(signatureHash === undefined ? {} : {signatureHash: {algorithm: 'sha256' as const, value: signatureHash}}),
        span: symbol.span,
        symbolKind: symbol.kind,
      },
      version: MEMORY_CODE_CITATION_VERSION,
    }),
    index,
  };
});

export function normalizeMemoryCodeRefs(refs: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) throw MemoryCodeCitationCaptureError.of('Code references must not be empty.');
    if (
      !LOCAL_SYMBOL_REF.test(ref) &&
      !QUALIFIED_SYMBOL_REF.test(ref) &&
      (ref.startsWith('/') ||
        ref.includes('\\') ||
        ref.split('/').some(segment => !segment || segment === '.' || segment === '..'))
    ) {
      throw MemoryCodeCitationCaptureError.of(`Code reference must be a safe repository-relative path: ${ref}.`);
    }
    if (!seen.has(ref)) {
      seen.add(ref);
      normalized.push(ref);
    }
  }
  if (normalized.length > MAX_MEMORY_CODE_CITATIONS) {
    throw MemoryCodeCitationCaptureError.of(`A memory may cite at most ${MAX_MEMORY_CODE_CITATIONS} code references.`);
  }
  return normalized;
}

function createCitation(input: Parameters<typeof createMemoryCodeCitation>[0]) {
  return Effect.try({
    try: () => createMemoryCodeCitation(input),
    catch: cause => captureError('canonical citation metadata', cause),
  });
}

function requireExactCurrentSnapshot(
  status: CodeGraphStatus,
  preparation: MemoryCodeCitationGraphPreparationV1,
): NonNullable<CodeGraphStatus['readySnapshot']> {
  if (status.readySnapshot === undefined) {
    throw MemoryCodeCitationCaptureError.of(
      `Code citations require an already-published ready graph; ${captureRecoveryMessage(preparation)} No indexing was started.`,
      captureRecovery(status, 'ready-graph-unavailable', preparation),
    );
  }
  if (status.stale || status.freshness !== 'current') {
    throw MemoryCodeCitationCaptureError.of(
      `Code citations require exact current graph evidence; ${captureRecoveryMessage(preparation)} No indexing was started.`,
      captureRecovery(status, 'exact-current-evidence-unavailable', preparation),
    );
  }
  return status.readySnapshot;
}

function captureRecovery(
  status: CodeGraphStatus,
  code: MemoryCodeCitationCaptureRecoveryCode,
  preparation: MemoryCodeCitationGraphPreparationV1,
): MemoryCodeCitationCaptureRecoveryV1 {
  return {
    code,
    indexingStarted: false,
    observedGraph: {
      freshness: status.freshness,
      readySnapshot: status.readySnapshot === undefined ? 'absent' : 'available',
      stale: status.stale,
    },
    preparation,
    recovery: 'prepare-current-graph',
    retryCondition: 'after-current-graph-ready',
    retryable: true,
    type: 'memory-code-citation-capture-recovery',
    version: 1,
  };
}

function callerGraphPreparation(): MemoryCodeCitationGraphPreparationV1 {
  return {
    action: 'index-current-graph',
    arguments: [],
    command: MEMORY_CODE_CITATION_GRAPH_PREPARATION_COMMAND,
    target: 'callerCwd',
  };
}

function worksetGraphPreparation(worksetName: string): MemoryCodeCitationGraphPreparationV1 {
  return {
    action: 'prepare-workset',
    arguments: [worksetName],
    command: MEMORY_CODE_CITATION_WORKSET_PREPARATION_COMMAND,
    target: 'workset',
  };
}

function captureGroupPreparation(targets: readonly CaptureTarget[]): MemoryCodeCitationGraphPreparationV1 {
  return targets.find(target => target.preparation.target === 'callerCwd')?.preparation ?? targets[0].preparation;
}

function captureRecoveryMessage(preparation: MemoryCodeCitationGraphPreparationV1): string {
  return preparation.target === 'callerCwd'
    ? `run \`${preparation.command}\` from callerCwd, then retry.`
    : `prepare the routed Workset ${JSON.stringify(preparation.arguments[0])} with \`${preparation.command} <workset>\`, then retry.`;
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

function captureError(target: string, cause: unknown): MemoryCodeCitationCaptureError {
  return Schema.is(MemoryCodeCitationCaptureError)(cause)
    ? cause
    : MemoryCodeCitationCaptureError.of(
        `Could not capture code citation ${target}: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        undefined,
        isCodeGraphStoreError(cause) && cause.retryable,
      );
}
