import {normalizeReferenceUris} from '@threadnote/memory/references';
import {Console, Crypto, DateTime, Effect, FileSystem, Option, Path, Predicate, Result, Schema} from 'effect';
import {
  expandWeakRecallQueryEffect,
  limitRecallRewritesForConfidence,
  mergeRecallRewritesForConfidence,
  recallHybridMinimumScore,
  recallRewriteLimitForConfidence,
  selectConfiguredRecallCandidatesEffect,
  shouldExpandRecall,
} from '../effect/ai/recall.js';
import {resolveEffectAiConfiguration} from '../effect/ai/consolidator.js';
import {enrichMemoryMetadataWithConfiguredLocalAi} from '../effect/ai/enrichment.js';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import {syncSharedReposBeforeAgentRead} from '../effect/share.js';
import {withSharedRepositoryLock} from '../effect/share/lock.js';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore, type ResourceStoreMutation} from '@threadnote/store/resource-store';
import {withAnonymousTelemetryPhase} from '../effect/telemetry.js';
import {withCodeAnchorFinalizationAnonymousTelemetry} from '../telemetry/code_anchor_finalization.js';
import {syncSourcesBeforeRecall} from '../sources/source.js';
import {
  canonicalResourceUri,
  parseResourceId,
  resourceIdIsManagedMemoryNamespace,
  resourceIdWithoutAnchor,
} from '@threadnote/store/resource-id';
import {inferProjectFromQuery, inferWorksetFromQuery, requireWorkset, uriSegment} from '@threadnote/workspace/manifest';
import {
  activePersonalMemoryUrisFromText,
  buildCompactPlan,
  type CompactableMemoryKind,
  DEFAULT_HANDOFF_NEXT_STEP,
  existingReferencedUris,
  formatCompactPlan,
  formatReferencedContextPointers,
  handoffTopicForBranch,
  parseMemoryDocument,
  recallHygieneNudges,
  referencedUrisFromRecords,
  topicForRecord,
  type MemoryRecord,
} from '@threadnote/memory/hygiene';
import {applyCliCompactKeepUpdates} from './hygiene/apply.js';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import {captureMemoryCodeCitations, MemoryCodeCitationCaptureError} from '@threadnote/context/citation/capture';
import {logKeywordReplaceReceipt, resolveReplaceKeywordPlan, shouldEnrichForKeywordPlan} from './keywords.js';
import {deferredCodeAnchorStoredMessage} from './code/citation_messages.js';
import {
  discardDeferredCodeAnchorIntent,
  discardDeferredCodeAnchorIntentsWithin,
  discardOtherDeferredCodeAnchorIntents,
  stageDeferredCodeAnchorIntent,
  type DeferredCodeAnchorWriteRequest,
  withDeferredCodeAnchorMutationLocks,
} from './deferred/code_anchor.js';
import {finalizeDeferredCodeAnchorsWithDerivedIndexes} from './deferred/code_anchor_finalization.js';
import {
  assertCurrentReplacementRawContent,
  assertCurrentReplacementWritable,
  assertPersonalMemoryDestinationWritable,
} from './destination_guard.js';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  memoryCodeCitationSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {
  memoryIdentityWriteLockKeys,
  parseMemoryRelationOption,
  resolveAuthoredMemoryRelations,
  verifyAuthoredMemoryRelationTargetIdentities,
} from './relations.js';
import {
  discardMemoryRelocation,
  isMemoryRelocationUri,
  readMemoryWithRelocations,
  recordMemoryRelocation,
} from '@threadnote/memory/relocation';
import {memoryReadRecoveryForError, memoryReadRecoveryText} from '@threadnote/memory/read/recovery';
import {resolveLocalMemoryReplacementTarget, resolveStoreMemoryReplacementOptions} from './replacement_target.js';
import type {StoreMemoryOptions} from './store_contract.js';
import {
  attemptSync,
  ensureMemoryDirectory,
  localMemoryPathForUri,
  localUserMemoriesRoot,
  memoryDirectoryUri,
  MemoryOperationError,
  NATIVE_RESOURCE_BACKEND,
  normalizeOptionalMetadata,
  readTextIfExists,
  removeResourceWithRetry,
  resourceExists,
  resourceStoreLocation,
} from './migrations.js';
import {
  buildRecallIndexSelectionCandidates,
  buildRecallSelectionCandidates,
  createRecallRerankerCache,
  emptyRecallSemanticScoresResult,
  loadRecallExpansionVocabulary,
  loadRecallSemanticScoresResult,
  prepareRecallSections,
  recallSelectionQueries,
  recallSelectionAnchorIds,
  selectedRecallCandidateUris,
  type RecallSemanticScoresResult,
} from '@threadnote/recall/runtime';
import {loadRecallExactMatches} from '@threadnote/recall/index';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';
import {resolveMemoryIdentityAliases, verifyResolvedMemoryIdentity} from '@threadnote/recall/memory/identity';
import {deriveRecallEligibilityPolicy, type RecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {
  lexicalIndexUnavailableWarning,
  mergeRecallOperationalWarnings,
  renderRecallOperationalWarning,
  type RecallOperationalWarning,
} from '@threadnote/recall/warning';
import type {RecallConfidence} from '@threadnote/recall/rank';
import {parseRecallCliInput, projectRecallCliResponse} from '../recall/cli_response.js';
import type {RecallMemoryConnectionsResult} from '@threadnote/recall/memory/connections';
import type {
  ArchiveOptions,
  CompactOptions,
  FinalizeCodeRefsOptions,
  ForgetOptions,
  HandoffOptions,
  ListOptions,
  PackOptions,
  ReadOptions,
  RecallOptions,
  RememberOptions,
} from '../types.js';
import type {MemoryKind} from '@threadnote/memory/types';
import type {ProjectManifest, ResolvedWorkset, RuntimeConfig} from '@threadnote/workspace/config';
export {parseCompactKind, parseMemoryStatus} from './parse.js';
import {
  assertResourceUri,
  enrichRecallQueryWithWorkspaceProjectContext,
  getInputText,
  gitValue,
  parsePositiveInteger,
  recallQueryRequestsBranchContext,
  resolveRepoName,
  resolveWorkspaceComponentContext,
  resolveWorkspaceBranch,
  resolveWorkspaceRepoName,
  safeTimestamp,
  sha256,
  trimTrailingSlash,
} from '../utils.js';
import {
  InvalidRecallScoreThreshold,
  recallScoreThresholdPolicy,
  validatedRecallScoreThreshold,
} from '@threadnote/recall/threshold';
import {errorMessage} from '@threadnote/platform/errors';
import {
  exactMemoryScopeUris,
  exactRecallScopeIntents,
  exactRecallTerms,
  type RecallHit,
} from '@threadnote/recall/results';
import {expandPath, getInvocationCwd} from '@threadnote/platform/paths';
import {
  applyScrubber,
  assertSharedWorktreeFileReady,
  ensureSharedDirectoryChain,
  isInSharedNamespace,
  publishShareGitChange,
  resolveTeam,
  sharedMemoryUriParts,
  sharedTeamNameForUri,
  stripPersonalProvenanceForSharedPublication,
  resourceUriToWorktreeRelative,
  writeMemoryFileChecked,
  writeSharedWorktreeFile,
} from '../share/index.js';

export {
  hasLegacyLifecycleHandoffCandidates,
  hasProjectNameMigrationCandidates,
  runMigrateLifecycle,
  runMigrateMemories,
  runMigrateProjectNames,
} from './migrations.js';

export {runEnrichMemories} from './enrichment.js';

/** Stable ranked recall data for product surfaces that should not parse CLI rendering. */
export interface RecallResult {
  readonly confidence?: RecallConfidence;
  readonly memoryConnections?: RecallMemoryConnectionsResult;
  readonly project?: string;
  readonly queryExpansions: readonly string[];
  readonly ranked: readonly RecallHit[];
  readonly totalRanked: number;
  readonly warnings: readonly RecallOperationalWarning[];
}

export function parseMemoryKind(value: string): MemoryKind {
  if (isMemoryKind(value)) return value;
  throw MemoryOperationError.make({
    message: `Unsupported memory kind "${value}". Expected durable, handoff, incident, preference, or smoke.`,
  });
}

const requireValue = <A>(value: A | undefined, message: string): Effect.Effect<A, Error> =>
  value === undefined ? Effect.fail(MemoryOperationError.make({message: message})) : Effect.succeed(value);

export const runRemember = Effect.fn('runRemember')(function* (config: RuntimeConfig, options: RememberOptions) {
  const text = yield* getInputText(options.text, options.stdin === true);
  if (!text.trim()) {
    return yield* MemoryOperationError.make({message: 'Provide memory text with --text or --stdin.'});
  }
  const timestamp = DateTime.formatIso(yield* DateTime.now);
  const memoryStatus = options.status ?? 'active';
  if (options.deferCodeRefs === true && memoryStatus !== 'active') {
    return yield* MemoryOperationError.make({
      message: '--defer-code-refs can be used only when storing an active memory.',
    });
  }
  const replacement = options.replace ? yield* resolveLocalMemoryReplacementTarget(config, options.replace) : undefined;
  const {canonicalUri: replaceUri, record: replaced} = replacement ?? {};
  if (replaced) yield* attemptSync(() => assertMemoryDocumentSchemaWritable(replaced.content));
  const callerCwd = yield* getInvocationCwd();
  const sharedTarget = replaceUri !== undefined && isInSharedNamespace(config, replaceUri);
  const keywordPlan = yield* attemptSync(() => resolveReplaceKeywordPlan(options, replaced, sharedTarget));
  const citationCapture = yield* captureMemoryCodeCitationsForWrite(config, {
    callerCwd,
    project: options.project,
    defer: yield* attemptSync(() =>
      resolveCliCodeCitationDeferPolicy(options, !sharedTarget && memoryStatus === 'active'),
    ),
    refs: options.codeRefs,
  });
  if (citationCapture.deferred && sharedTarget) {
    return yield* MemoryOperationError.make({
      message: 'Deferred code anchors are private-local and cannot replace shared memory.',
    });
  }
  const codeCitations = citationCapture.citations;
  const citationSourceCommit = commonMemoryCodeCitationCommit(codeCitations);
  const workspaceComponent = yield* resolveWorkspaceComponentContext({includeProcessCwd: true});
  const crypto = yield* Crypto.Crypto;
  const memoryId = replacement?.memoryId ?? `tn_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`;
  const sharedTeam = replaceUri ? sharedTeamNameForUri(config, replaceUri) : undefined;
  const relationScope = sharedTeam
    ? `threadnote://user/${uriSegment(config.user)}/memories/shared/${uriSegment(sharedTeam)}`
    : `threadnote://user/${uriSegment(config.user)}/memories`;
  const relationInputs = yield* attemptSync(() => (options.relations ?? []).map(parseMemoryRelationOption));
  const authoredRelations = yield* resolveAuthoredMemoryRelations(config, relationInputs, {
    allowedUriScopes: [relationScope],
    sourceMemoryId: memoryId,
    sourceUri: replaceUri,
  });
  // Projection computes source_hash from canonical content. Keeping the
  // high-entropy digest out of Threadnote's indexed memory preserves semantic
  // retrieval quality while the stable identity and lifecycle fields remain
  // part of the authoritative record.
  const baseMetadata: MemoryMetadata = {
    createdAt: replaced?.metadata.createdAt ?? replaced?.metadata.timestamp ?? timestamp,
    ...(codeCitations.length === 0 ? {} : {codeCitations}),
    kind: options.kind ?? 'durable',
    ...('keywords' in keywordPlan ? {keywords: keywordPlan.keywords} : {}),
    memoryId,
    project: normalizeOptionalMetadata(options.project),
    relations: authoredRelations.relations,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: options.sourceAgentClient ?? 'codex',
    ...(citationSourceCommit === undefined ? {} : {sourceCommit: citationSourceCommit, sourceObservedAt: timestamp}),
    status: memoryStatus,
    timestamp,
    topic: normalizeOptionalMetadata(options.topic),
    updatedAt: timestamp,
    visibility: replaceUri && isInSharedNamespace(config, replaceUri) ? 'shared' : 'personal',
    // Replacement updates preserve the memory's established engineering
    // scope. The caller's cwd is context for a new memory, not authorization
    // to silently migrate an existing repo-wide/package-local contract.
    workspaceScope: replaced ? replaced.metadata.workspaceScope : workspaceComponent?.scope,
  };
  const metadata =
    options.dryRun === true || sharedTarget || !shouldEnrichForKeywordPlan(keywordPlan)
      ? baseMetadata
      : yield* enrichMemoryMetadataWithConfiguredLocalAi(config, baseMetadata, text.trim()).pipe(
          Effect.catch(error =>
            Console.log(
              `Local AI memory enrichment skipped: ${error instanceof Error ? error.message : String(error)}`,
            ).pipe(Effect.as(baseMetadata)),
          ),
        );
  const memoryUri = yield* storeMemory(config, {
    bodyText: text.trim(),
    deferredCodeAnchor: citationCapture.deferred,
    dryRun: options.dryRun === true,
    expectedReplaceContent: replaced?.content,
    expectedReplaceMemoryId: replacement?.memoryId,
    expectedSourceContent: authoredRelations.targets,
    metadata,
    replaceUri,
    title: 'MEMORY',
  });
  if (citationCapture.deferred && options.dryRun !== true) {
    yield* Console.log(deferredCodeAnchorStoredMessage(memoryUri, citationCapture.deferred));
  }
  if (replaced?.metadata.codeCitations?.length && codeCitations.length === 0 && !citationCapture.deferred) {
    yield* Console.log(
      `Cleared ${replaced.metadata.codeCitations.length} prior code citation(s); pass --code-ref to recapture them.`,
    );
  }
  if (
    options.dryRun !== true &&
    replaced?.metadata.relations?.length &&
    (authoredRelations.relations?.length ?? 0) === 0
  ) {
    yield* Console.log(
      `Cleared ${replaced.metadata.relations.length} prior memory relation(s); pass --relation to author the replacement edges.`,
    );
  }
  yield* logKeywordReplaceReceipt(keywordPlan, replaced?.metadata.keywords, {dryRun: options.dryRun});
});

function commonMemoryCodeCitationCommit(citations: readonly {readonly sourceCommit: string}[]): string | undefined {
  const commits = new Set(citations.map(citation => citation.sourceCommit));
  return commits.size === 1 ? citations[0]?.sourceCommit : undefined;
}

const captureMemoryCodeCitationsForWrite = Effect.fn('memory.captureCodeCitationsForWrite')(function* (
  config: RuntimeConfig,
  input: {
    readonly callerCwd: string;
    readonly project?: string;
    readonly defer: boolean;
    readonly refs?: readonly string[];
  },
) {
  if (input.defer && (input.refs?.length ?? 0) === 0) {
    return yield* MemoryOperationError.make({message: '--defer-code-refs requires at least one --code-ref.'});
  }
  const captured = yield* captureMemoryCodeCitations(config, {
    callerCwd: input.callerCwd,
    project: input.project,
    refs: input.refs,
  }).pipe(Effect.result);
  if (Result.isSuccess(captured)) {
    return {citations: captured.success, deferred: undefined};
  }
  if (
    input.defer &&
    Schema.is(MemoryCodeCitationCaptureError)(captured.failure) &&
    captured.failure.recovery !== undefined
  ) {
    return {
      citations: [] as const,
      deferred: {
        callerCwd: input.callerCwd,
        codeRefs: input.refs ?? [],
        ...(input.project === undefined ? {} : {project: input.project}),
        recovery: captured.failure.recovery,
      } satisfies DeferredCodeAnchorWriteRequest,
    };
  }
  return yield* captured.failure;
});

function resolveCliCodeCitationDeferPolicy(
  options: Pick<RememberOptions | HandoffOptions, 'codeRefs' | 'deferCodeRefs' | 'requireCurrentCodeRefs'>,
  privateTarget: boolean,
): boolean {
  if (options.deferCodeRefs === true && options.requireCurrentCodeRefs === true) {
    throw MemoryOperationError.make({message: 'Choose only one of --defer-code-refs or --require-current-code-refs.'});
  }
  if (options.deferCodeRefs === true) return true;
  return options.requireCurrentCodeRefs !== true && privateTarget && (options.codeRefs?.length ?? 0) > 0;
}

export const runRecall = Effect.fn('runRecall')(function* (config: RuntimeConfig, options: RecallOptions) {
  const {memoryConnections, query} = yield* attemptSync(() => parseRecallCliInput(options));
  const navigationOnly = query.length === 0;
  if (options.dryRun !== true) {
    yield* withAnonymousTelemetryPhase('recall.shared-sync', syncSharedReposAndLog(config));
    yield* withAnonymousTelemetryPhase('recall.obsidian-sync', syncSourcesAndLog(config));
  }
  const includeWorkspaceComponent = !navigationOnly && !options.uri && !options.workset;
  const workspaceOptions = options.callerCwd
    ? {cwd: options.callerCwd, includeProcessCwd: false}
    : {includeProcessCwd: true};
  const workspaceComponent = includeWorkspaceComponent
    ? yield* resolveWorkspaceComponentContext(workspaceOptions)
    : undefined;
  const workspaceBranch =
    includeWorkspaceComponent && recallQueryRequestsBranchContext(query)
      ? yield* resolveWorkspaceBranch(workspaceOptions)
      : undefined;
  const projectQuery = navigationOnly
    ? ''
    : yield* enrichRecallQueryWithWorkspaceProjectContext(query, workspaceOptions);
  const dryRun = options.dryRun === true;
  const explicitUri = options.uri ? parseResourceId(options.uri).canonicalUri : undefined;
  const inferredUri =
    explicitUri ??
    (navigationOnly || options.inferScope === false ? undefined : yield* inferRecallUri(config, projectQuery));
  const explicitProjectName = explicitUri ? undefined : normalizeOptionalMetadata(options.project);
  const queryProject =
    !explicitUri && (!navigationOnly || explicitProjectName)
      ? yield* inferProjectFromQuery(config.manifestPath, explicitProjectName ?? query)
      : undefined;
  const project =
    queryProject ??
    (!navigationOnly && !explicitUri && !explicitProjectName
      ? yield* inferProjectFromQuery(config.manifestPath, projectQuery)
      : undefined);
  const recallProjectName =
    explicitProjectName ??
    project?.name ??
    (explicitUri || navigationOnly ? undefined : yield* resolveWorkspaceRepoName(workspaceOptions));
  const nodeLimit = options.nodeLimit
    ? yield* attemptSync(() => parsePositiveInteger(options.nodeLimit!, 'node limit'))
    : undefined;
  const explicitWorkset = options.workset ? yield* requireWorkset(config.manifestPath, options.workset) : undefined;
  const explicitThreshold = options.threshold;
  const thresholdPolicy =
    explicitThreshold === undefined
      ? yield* recallScoreThresholdPolicy()
      : {
          source: 'call' as const,
          value: yield* Effect.try({
            try: () => validatedRecallScoreThreshold(explicitThreshold, '--threshold'),
            catch: error =>
              Schema.is(InvalidRecallScoreThreshold)(error)
                ? error
                : InvalidRecallScoreThreshold.make({
                    message: '--threshold must be a number from 0 to 1.',
                    cause: error,
                  }),
          }),
        };
  const recallThreshold = thresholdPolicy.value;
  const thresholdConfigured = thresholdPolicy.source !== 'default';
  // Scope selection feeds the native postings/vector indexes directly. The
  // passes array remains as a compatibility input to the existing explainable
  // ranker; no background process or HTTP service is queried.
  if (inferredUri) {
    yield* Console.log(`Recall scope: ${inferredUri}`);
  }
  const includeArchived = options.includeArchived === true;
  const passes: Array<readonly RecallHit[]> = [];
  if (dryRun) {
    yield* Console.log(
      navigationOnly
        ? `Would expand ${memoryConnections?.memoryRefs.length ?? 0} explicit memory premise(s) by one hop.`
        : `Would search native recall index for ${JSON.stringify(query)}${inferredUri ? ` under ${inferredUri}` : ''}.`,
    );
  }
  const scopedRecallUris = new Set([inferredUri].filter((uri): uri is string => uri !== undefined));
  if (options.project && project) {
    const projectMemoryUri = `threadnote://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(project.name)}`;
    if (!scopedRecallUris.has(projectMemoryUri)) {
      scopedRecallUris.add(projectMemoryUri);
    }
  }
  for (const scope of projectMemoryScopeUris(config, recallProjectName, includeArchived)) {
    if (!scopedRecallUris.has(scope)) {
      scopedRecallUris.add(scope);
    }
  }
  const seededUri = project ? trimTrailingSlash(project.uri) : undefined;
  if (
    seededUri?.startsWith('threadnote://') &&
    seededUri !== inferredUri &&
    !options.uri &&
    options.inferScope !== false
  ) {
    scopedRecallUris.add(seededUri);
  }

  // Workset expansion: a named set of manifest projects recalled as one working
  // set. Push a durable + seeded scope pass per member; the merge dedupes hits,
  // and the scope list is deduped/capped so overlap only costs bounded searches.
  const workset =
    !options.uri && explicitWorkset
      ? explicitWorkset
      : !navigationOnly && !options.uri && options.inferScope !== false
        ? yield* inferWorksetFromQuery(config.manifestPath, projectQuery)
        : undefined;
  if (workset && workset.projects.length > 0) {
    yield* Console.log(`Workset scope: ${workset.name} (${workset.projects.map(member => member.name).join(', ')})`);
    const alreadyScoped = new Set(
      [inferredUri, seededUri, ...scopedRecallUris].filter((uri): uri is string => uri !== undefined),
    );
    const worksetScopes = worksetScopeUris(config, workset)
      .filter(uri => !alreadyScoped.has(uri))
      .slice(0, MAX_WORKSET_PASSES);
    for (const scope of worksetScopes) {
      scopedRecallUris.add(scope);
    }
  }
  if (dryRun) {
    for (const scope of scopedRecallUris) {
      yield* Console.log(`Would search native recall index --uri ${scope}`);
    }
  }

  const eligibility = deriveRecallEligibilityPolicy({
    explicitProject: options.project?.trim() || undefined,
    originalQuery: query,
    pinnedHardUri: explicitUri !== undefined,
    workspaceProject: workset ? undefined : recallProjectName,
    worksetProjectNames: workset?.projects.map(member => member.name),
  });

  const exactLookup =
    dryRun || navigationOnly
      ? {matches: [], operationalWarnings: []}
      : yield* collectNativeExactMemoryMatches(config, query, {
          includeArchived,
          eligibility,
          project,
        });
  const exactMatches = exactLookup.matches;
  let operationalWarnings: readonly RecallOperationalWarning[] = exactLookup.operationalWarnings;
  const effectAi =
    dryRun || navigationOnly
      ? undefined
      : yield* resolveEffectAiConfiguration(config, (yield* SystemInfo).environment());
  let hybridMinimumScore = recallHybridMinimumScore(Number(recallThreshold));
  const expansionQueries: string[] = [];
  const recallLimit = nodeLimit ?? 12;
  let semanticResult =
    dryRun || navigationOnly
      ? Option.some(emptyRecallSemanticScoresResult())
      : Option.some(
          yield* withAnonymousTelemetryPhase(
            'recall.semantic-retrieval',
            loadRecallSemanticScoresResult(
              config,
              query,
              recallLimit,
              eligibility,
              explicitUri ? [explicitUri] : undefined,
            ),
            result =>
              Option.isSome(result.warning) ? 'failure' : Option.isSome(result.scores) ? 'success' : 'unavailable',
          ),
        );
  const surfacedSemanticWarnings = new Set<string>();
  const surfacedOperationalWarningCodes = new Set<RecallOperationalWarning['code']>();
  const surfaceOperationalWarnings = (warnings: readonly RecallOperationalWarning[]) =>
    Effect.forEach(
      warnings.filter(warning => !surfacedOperationalWarningCodes.has(warning.code)),
      warning =>
        Effect.sync(() => surfacedOperationalWarningCodes.add(warning.code)).pipe(
          Effect.andThen(Console.warn(renderRecallOperationalWarning(warning))),
        ),
      {discard: true},
    );
  const surfaceSemanticWarning = (result: RecallSemanticScoresResult) =>
    Option.match(result.warning, {
      onNone: () => Effect.void,
      onSome: warning =>
        surfacedSemanticWarnings.has(warning)
          ? Effect.void
          : Effect.sync(() => surfacedSemanticWarnings.add(warning)).pipe(Effect.andThen(Console.warn(warning))),
    });
  yield* surfaceOperationalWarnings(exactLookup.operationalWarnings);
  if (Option.isSome(semanticResult)) yield* surfaceSemanticWarning(semanticResult.value);
  const rerankerCache = createRecallRerankerCache();
  const prepareSections = (candidateUris?: readonly string[]) =>
    withAnonymousTelemetryPhase(
      'recall.lexical-ranking',
      Effect.gen(function* () {
        const prepared = yield* prepareRecallSections(config, {
          allowExactRescue: !thresholdConfigured,
          allowSemanticRescue: !thresholdConfigured,
          allowedUriScopes: explicitUri ? [explicitUri] : undefined,
          candidateUris,
          exactMatches,
          eligibility,
          feedbackQuery: query,
          includeInactive: includeArchived,
          limit: recallLimit,
          memoryRefs: memoryConnections?.memoryRefs,
          minimumScore: hybridMinimumScore,
          passes,
          preferredUriScopes: explicitUri ? undefined : [...scopedRecallUris],
          project: recallProjectName,
          query,
          queryVariants: expansionQueries,
          readRecords: uris => readMemoryRecordsByUri(config, uris),
          relationTypes: memoryConnections?.relationTypes,
          rerankerCache,
          seedUris: [inferredUri, seededUri].filter((uri): uri is string => uri !== undefined),
          semanticResult,
          workspaceBranch,
          workspaceScope: workspaceComponent?.scope,
        });
        semanticResult = Option.some(prepared.semanticResult);
        operationalWarnings = mergeRecallOperationalWarnings(operationalWarnings, prepared.operationalWarnings);
        yield* surfaceOperationalWarnings(prepared.operationalWarnings);
        yield* surfaceSemanticWarning(prepared.semanticResult);
        return prepared;
      }),
    );
  let recallSections = yield* prepareSections();
  const shouldAttemptAiExpansion = !dryRun && !navigationOnly && shouldExpandRecall(recallSections.confidence);
  const indexSelectionCandidates = shouldAttemptAiExpansion
    ? buildRecallIndexSelectionCandidates(recallSections.expansionCandidates, recallProjectName, 24)
    : [];
  const indexSelectionIds =
    indexSelectionCandidates.length > 0
      ? yield* withAnonymousTelemetryPhase(
          'model.inference',
          selectConfiguredRecallCandidatesEffect({candidates: indexSelectionCandidates, query}, config, effectAi),
        )
      : undefined;
  const groundedExpansionQueries =
    indexSelectionIds && indexSelectionIds.length > 0
      ? limitRecallRewritesForConfidence(
          recallSections.confidence,
          recallSelectionQueries(
            indexSelectionCandidates,
            recallSections.expansionCandidates,
            indexSelectionIds,
            query,
            2,
          ),
        )
      : [];
  const needsFallbackExpansion =
    shouldAttemptAiExpansion &&
    groundedExpansionQueries.length < recallRewriteLimitForConfidence(recallSections.confidence);
  const expansionVocabulary =
    needsFallbackExpansion && shouldExpandRecall(recallSections.confidence)
      ? yield* loadRecallExpansionVocabulary(config, {
          allowedUriScopes: explicitUri ? [explicitUri] : [...scopedRecallUris],
          eligibility,
          includeInactive: includeArchived,
          project: recallProjectName,
          rankedCandidates: recallSections.expansionCandidates,
        }).pipe(Effect.orElseSucceed(() => []))
      : [];
  const fallbackExpansionQueries =
    dryRun || !needsFallbackExpansion
      ? []
      : yield* withAnonymousTelemetryPhase(
          'model.inference',
          expandWeakRecallQueryEffect(
            {
              confidence: recallSections.confidence,
              project: recallProjectName,
              query,
              vocabulary: expansionVocabulary,
            },
            config,
            effectAi,
          ),
        );
  const proposedExpansionQueries = mergeRecallRewritesForConfidence(
    recallSections.confidence,
    groundedExpansionQueries,
    fallbackExpansionQueries,
  );
  for (const expansionQuery of proposedExpansionQueries) {
    expansionQueries.push(expansionQuery);
    hybridMinimumScore = recallHybridMinimumScore(Number(recallThreshold));
    recallSections = yield* prepareSections();
  }
  if (expansionQueries.length > 0) {
    yield* Console.log(`Recall query expansion: evaluated ${expansionQueries.length} model rewrite(s).`);
    const selectionCandidates = buildRecallSelectionCandidates(
      recallSections.ranked,
      recallSections.expansionCandidates,
      Math.max(nodeLimit ?? 12, 12) * 2,
    );
    const selectedIds = yield* withAnonymousTelemetryPhase(
      'model.inference',
      selectConfiguredRecallCandidatesEffect({candidates: selectionCandidates, query}, config, effectAi),
    );
    if (selectedIds !== undefined) {
      const selectedUris = selectedRecallCandidateUris(
        selectionCandidates,
        selectedIds,
        recallSelectionAnchorIds(selectionCandidates, recallSections.ranked),
      );
      recallSections = yield* prepareSections(selectedUris);
      yield* Console.log(
        `Recall local AI post-filter: kept ${selectedUris.length} of ${selectionCandidates.length} candidate(s).`,
      );
    }
  }
  const cliProjection = projectRecallCliResponse(recallSections, navigationOnly);
  for (const section of cliProjection.sections) {
    yield* Console.log(`\n${section}`);
  }
  const referencedSection = yield* referencedContextSection(config, cliProjection.rankedContext);
  if (referencedSection) {
    yield* Console.log(`\n${referencedSection}`);
  }
  yield* printRecallHygieneNudges(config, cliProjection.rankedContext);
  return {
    ...(cliProjection.confidence === undefined ? {} : {confidence: cliProjection.confidence}),
    ...(recallSections.memoryConnections ? {memoryConnections: recallSections.memoryConnections} : {}),
    ...(recallProjectName === undefined ? {} : {project: recallProjectName}),
    queryExpansions: expansionQueries,
    ranked: recallSections.ranked.slice(0, recallLimit),
    totalRanked: recallSections.ranked.length,
    warnings: operationalWarnings,
  } satisfies RecallResult;
});

const MAX_REFERENCED_CONTEXT = 5;

/**
 * Resolves the one-way `references:` pointers carried by the personal memories
 * recall just surfaced and appends bounded URI-only pointers. The caller can
 * explicitly read a relevant pointer without recall inlining unrelated text.
 */
const referencedContextSection = Effect.fn('memory.referencedContextSection')(function* (
  config: RuntimeConfig,
  recallOutput: string,
) {
  const surfacedUris = activePersonalMemoryUrisFromText(recallOutput, config.user);
  if (surfacedUris.length === 0) {
    return undefined;
  }
  const surfaced = yield* readMemoryRecordsByUri(config, surfacedUris);
  const referenced = referencedUrisFromRecords(surfaced, recallOutput);
  if (referenced.length === 0) {
    return undefined;
  }
  const candidates = referenced.slice(0, MAX_REFERENCED_CONTEXT);
  const existingRecords = yield* readMemoryRecordsByUri(config, candidates);
  return formatReferencedContextPointers(existingReferencedUris(candidates, existingRecords), MAX_REFERENCED_CONTEXT);
});

export function stripAdvancedSearchFlags(args: readonly string[]): readonly string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--threshold' || args[index] === '--level') {
      index += 1;
      continue;
    }
    stripped.push(args[index]);
  }
  return stripped;
}

export const runRead = Effect.fn('runRead')(function* (config: RuntimeConfig, uri: string, options: ReadOptions) {
  yield* attemptSync(() => assertResourceUri(uri));
  if (options.dryRun !== true) {
    yield* syncSharedReposAndLog(config);
  }
  if (options.dryRun === true) {
    yield* Console.log(`Would read native resource: ${uri}`);
    return;
  }
  const store = yield* ResourceStore;
  const [identity] = yield* resolveMemoryIdentityAliases(
    config,
    [uri],
    [`threadnote://user/${uriSegment(config.user)}/memories`],
  );
  const canonicalUri = identity.canonicalUri;
  if (isMemoryRelocationUri(config, canonicalUri)) {
    const resolved = yield* readMemoryWithRelocations(config, canonicalUri).pipe(
      Effect.tapError(error => {
        const recovery = memoryReadRecoveryForError(config, error);
        return recovery === undefined ? Effect.void : Console.error(memoryReadRecoveryText(recovery));
      }),
    );
    yield* verifyResolvedMemoryIdentity(identity, resolved.canonicalUri, resolved.content);
    if (identity.requestedUri !== resolved.canonicalUri) {
      yield* Console.error(`Resolved memory: ${identity.requestedUri} -> ${resolved.canonicalUri}`);
    }
    yield* writeFinalCliOutput(resolved.content);
    return;
  }
  const content = yield* store.read(resourceStoreLocation(config), canonicalUri);
  yield* verifyResolvedMemoryIdentity(identity, canonicalUri, content);
  yield* writeFinalCliOutput(content);
});

const syncSharedReposAndLog = Effect.fn('memory.syncSharedReposAndLog')(function* (config: RuntimeConfig) {
  const syncResult = yield* syncSharedReposBeforeAgentRead(config).pipe(
    Effect.catch(error =>
      Effect.succeed({
        syncedTeams: [] as readonly string[],
        warnings: [error instanceof Error ? error.message : String(error)] as readonly string[],
      }),
    ),
  );
  if (syncResult.syncedTeams.length > 0) {
    yield* Console.error(`Auto-synced shared memories: ${syncResult.syncedTeams.join(', ')}`);
  }
  for (const warning of syncResult.warnings) {
    yield* Console.error(`Auto-sync warning: ${warning}`);
  }
  return syncResult;
});

function formatSharedCompactAudit(audit: {
  readonly syncedTeams: readonly string[];
  readonly warnings: readonly string[];
}): string {
  return [
    'Shared audit source:',
    '- bounded auto-sync attempted before scanning local canonical mirrors',
    audit.syncedTeams.length > 0 ? `- refreshed teams: ${audit.syncedTeams.join(', ')}` : '- refreshed teams: none',
    '- freshness note: repository contention may defer refresh; hygiene actions never mutate shared memories',
    ...audit.warnings.map(warning => `- warning: ${warning}`),
  ].join('\n');
}

const syncSourcesAndLog = Effect.fn('memory.syncSourcesAndLog')(function* (config: RuntimeConfig) {
  const syncResult = yield* syncSourcesBeforeRecall(config).pipe(
    Effect.catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      return Console.error(`Auto-sync warning: Source refresh failed: ${message}`).pipe(Effect.as(undefined));
    }),
  );
  if (!syncResult) {
    return;
  }
  if (syncResult.syncedSources.length > 0) {
    yield* Console.error(`Auto-synced sources: ${syncResult.syncedSources.join(', ')}`);
  }
  for (const warning of syncResult.warnings) {
    yield* Console.error(`Auto-sync warning: ${warning}`);
  }
});

const printRecallHygieneNudges = Effect.fn('memory.printRecallHygieneNudges')(function* (
  config: RuntimeConfig,
  recallOutput: string,
) {
  const uris = activePersonalMemoryUrisFromText(recallOutput, config.user);
  if (uris.length === 0) {
    return;
  }
  const records = yield* readMemoryRecordsByUri(config, uris);
  const nudges = recallHygieneNudges(recallOutput, {records, user: config.user});
  if (nudges.length === 0) {
    return;
  }
  yield* Console.log('\nMemory hygiene hints:');
  for (const nudge of nudges) {
    yield* Console.log(`- ${nudge}`);
  }
});

export const runCompact = Effect.fn('runCompact')(function* (config: RuntimeConfig, options: CompactOptions) {
  const project = yield* requireValue(
    normalizeOptionalMetadata(options.project),
    'Provide --project for scoped memory hygiene.',
  );
  if (options.apply === true && options.dryRun === true) {
    return yield* MemoryOperationError.make({message: 'Cannot combine --apply with --dry-run.'});
  }
  const apply = options.apply === true;
  const sharedAudit = yield* syncSharedReposAndLog(config);
  const records = yield* scopedCompactRecords(config, {
    kind: options.kind,
    project,
  });
  const plan = buildCompactPlan(records, {
    kind: options.kind,
    project,
    topic: normalizeOptionalMetadata(options.topic),
  });
  yield* Console.log([formatCompactPlan(plan, {apply}), '', formatSharedCompactAudit(sharedAudit)].join('\n'));
  if (!apply) {
    return;
  }

  const plannedActions = [...plan.keepUpdates, ...plan.archives, ...plan.forgets];
  const currentByUri = new Map(
    (yield* readMemoryRecordsByUri(
      config,
      plannedActions.map(action => action.uri),
    )).map(record => [record.uri, record.content]),
  );
  for (const action of plannedActions) {
    if (currentByUri.get(action.uri) !== action.expectedContent) {
      return yield* MemoryOperationError.make({
        message: `Memory ${action.uri} changed after the hygiene plan. Re-run compact before apply.`,
      });
    }
  }

  const invalidatedUris = plannedActions.map(action => action.uri);
  yield* Effect.gen(function* () {
    yield* applyCliCompactKeepUpdates(config, plan, records);
    for (const action of plan.archives) {
      yield* runArchive(config, action.uri, {
        deferRecallIndexRefresh: true,
        dryRun: false,
        expectedContent: action.expectedContent,
        invalidatedUris,
        kind: action.kind,
        project: action.project,
        topic: action.topic,
      });
    }
  }).pipe(
    Effect.ensuring(refreshRecallDerivedIndexesAfterCanonicalMutation(config, invalidatedUris).pipe(Effect.asVoid)),
  );
});

export const runCompactDiagnostics = Effect.fn('memory.runCompactDiagnostics')(function* (
  config: RuntimeConfig,
  options: CompactOptions,
) {
  const project = normalizeOptionalMetadata(options.project);
  if (!project) {
    return yield* MemoryOperationError.make({message: 'Provide --project for scoped memory hygiene.'});
  }
  const topic = normalizeOptionalMetadata(options.topic);
  yield* syncSharedReposAndLog(config);
  const records = yield* scopedCompactRecords(config, {
    kind: options.kind,
    project,
  });
  const activeRecords = records.filter(record => record.metadata.status === 'active');
  const matchingRecords = activeRecords.filter(record => topic === undefined || topicForRecord(record) === topic);
  const counts = new Map<CompactableMemoryKind, number>();
  for (const record of matchingRecords) {
    const kind = record.metadata.kind;
    if (kind === 'durable' || kind === 'handoff' || kind === 'incident') {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  yield* Console.log(
    [
      'Scope summary:',
      `- project: ${project}`,
      `- topic: ${topic ?? '(all)'}`,
      `- kind: ${options.kind ?? '(handoff, durable, incident)'}`,
      `- stable records read: ${records.length}`,
      `- active records in project: ${activeRecords.length}`,
      `- active records matching topic: ${matchingRecords.length}`,
      `- matching by kind: ${formatKindCounts(counts)}`,
      '- shared memories: audited read-only for conflicts/merge review; never mutated by compact',
      '- skipped by design: archived memories, preferences, smoke records, seeded resources, and non-stable timestamped/global paths',
      '',
    ].join('\n'),
  );
});

const scopedCompactRecords = Effect.fn('memory.scopedCompactRecords')(function* (
  config: RuntimeConfig,
  options: {readonly kind?: CompactableMemoryKind; readonly project: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kinds: readonly CompactableMemoryKind[] = options.kind ? [options.kind] : ['handoff', 'durable', 'incident'];
  const records: MemoryRecord[] = [];
  for (const kind of kinds) {
    const directories = [
      {
        directory: yield* localMemoryDirectoryForCompact(config, kind, options.project),
        uriDirectory: memoryUriDirectoryForCompact(config, kind, options.project),
      },
      ...(yield* sharedMemoryDirectoriesForCompact(config, kind, options.project)),
    ];
    for (const {directory, uriDirectory} of directories) {
      const entries = yield* fs.readDirectory(directory).pipe(Effect.option);
      if (entries._tag === 'None') {
        continue;
      }
      for (const entry of entries.value) {
        if (entry.startsWith('.') || !entry.endsWith('.md')) {
          continue;
        }
        const entryPath = path.join(directory, entry);
        const info = yield* fs.stat(entryPath).pipe(Effect.option);
        if (info._tag === 'None' || info.value.type !== 'File') {
          continue;
        }
        const content = yield* readTextIfExists(entryPath);
        if (!content) {
          continue;
        }
        const record = parseMemoryDocument(`${uriDirectory}/${entry}`, content);
        if (record) {
          records.push(record);
        }
      }
    }
  }
  return records;
});

const sharedMemoryDirectoriesForCompact = Effect.fn('memory.sharedMemoryDirectoriesForCompact')(function* (
  config: RuntimeConfig,
  kind: CompactableMemoryKind,
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sharedRoot = path.join(yield* localUserMemoriesRoot(config), 'shared');
  const teamEntries = yield* fs.readDirectory(sharedRoot).pipe(Effect.option);
  if (teamEntries._tag === 'None') return [];
  const projectSegment = uriSegment(project);
  const relativeParts = compactMemoryDirectoryParts(kind, projectSegment);
  const baseUri = `threadnote://user/${uriSegment(config.user)}/memories/shared`;
  const directories: Array<{readonly directory: string; readonly uriDirectory: string}> = [];
  for (const team of [...teamEntries.value].sort()) {
    if (team.startsWith('.')) continue;
    const teamRoot = path.join(sharedRoot, team);
    const teamInfo = yield* fs.stat(teamRoot).pipe(Effect.option);
    if (teamInfo._tag === 'None' || teamInfo.value.type !== 'Directory') continue;
    directories.push({
      directory: path.join(teamRoot, ...relativeParts),
      uriDirectory: `${baseUri}/${team}/${relativeParts.join('/')}`,
    });
  }
  return directories;
});

function formatKindCounts(counts: ReadonlyMap<CompactableMemoryKind, number>): string {
  return (['handoff', 'durable', 'incident'] as const).map(kind => `${kind} ${counts.get(kind) ?? 0}`).join(', ');
}

export const readMemoryRecordsByUri = Effect.fn('memory.readMemoryRecordsByUri')(function* (
  config: RuntimeConfig,
  uris: readonly string[],
) {
  const records = yield* Effect.forEach(
    uris,
    uri =>
      Effect.gen(function* () {
        const localPath = yield* localMemoryPathForUri(config, uri);
        if (!localPath) return undefined;
        const content = yield* readTextIfExists(localPath);
        if (!content) return undefined;
        return parseMemoryDocument(uri, content);
      }),
    {concurrency: 16},
  );
  return records.filter((record): record is MemoryRecord => record !== undefined);
});

const localMemoryDirectoryForCompact = Effect.fn('memory.localMemoryDirectoryForCompact')(function* (
  config: RuntimeConfig,
  kind: CompactableMemoryKind,
  project: string,
) {
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const projectSegment = uriSegment(project);
  return path.join(root, ...compactMemoryDirectoryParts(kind, projectSegment));
});

function memoryUriDirectoryForCompact(config: RuntimeConfig, kind: CompactableMemoryKind, project: string): string {
  const base = `threadnote://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(project);
  return `${base}/${compactMemoryDirectoryParts(kind, projectSegment).join('/')}`;
}

function compactMemoryDirectoryParts(kind: CompactableMemoryKind, projectSegment: string): readonly string[] {
  switch (kind) {
    case 'durable':
      return ['durable', 'projects', projectSegment];
    case 'handoff':
      return ['handoffs', 'active', projectSegment];
    case 'incident':
      return ['incidents', 'active', projectSegment];
  }
}

export const runList = Effect.fn('runList')(function* (config: RuntimeConfig, uri: string, options: ListOptions) {
  yield* attemptSync(() => assertResourceUri(uri));
  const nodeLimit = options.nodeLimit
    ? yield* attemptSync(() => parsePositiveInteger(options.nodeLimit!, 'node limit'))
    : undefined;
  if (options.dryRun === true) {
    yield* Console.log(`Would list native resource: ${uri}${options.recursive ? ' recursively' : ''}`);
    return;
  }
  const store = yield* ResourceStore;
  const allEntries = yield* store.list(resourceStoreLocation(config), uri, {
    recursive: options.recursive === true,
  });
  const entries = nodeLimit === undefined ? allEntries : allEntries.slice(0, nodeLimit);
  if (options.simple === true) {
    yield* writeFinalCliOutput(entries.map(entry => entry.uri).join('\n'));
    return;
  }
  yield* writeFinalCliOutput(JSON.stringify(entries, null, 2));
});

export const runHandoff = Effect.fn('runHandoff')(function* (config: RuntimeConfig, options: HandoffOptions) {
  const replacement = options.replace ? yield* resolveLocalMemoryReplacementTarget(config, options.replace) : undefined;
  const {canonicalUri: replaceUri, record: replaced} = replacement ?? {};
  if (replaced) yield* attemptSync(() => assertMemoryDocumentSchemaWritable(replaced.content));
  const {bodyText, metadata: baseMetadata} = yield* buildHandoff(options, replacement?.memoryId);
  const sharedTarget = replaceUri !== undefined && isInSharedNamespace(config, replaceUri);
  const keywordPlan = yield* attemptSync(() =>
    resolveReplaceKeywordPlan({...options, kind: 'handoff' as const}, replaced, sharedTarget),
  );
  const citationCapture = yield* captureMemoryCodeCitationsForWrite(config, {
    callerCwd: yield* getInvocationCwd(),
    project: options.project,
    defer: yield* attemptSync(() => resolveCliCodeCitationDeferPolicy(options, !sharedTarget)),
    refs: options.codeRefs,
  });
  if (citationCapture.deferred && sharedTarget) {
    return yield* MemoryOperationError.make({
      message: 'Deferred code anchors are private-local and cannot replace shared memory.',
    });
  }
  const codeCitations = citationCapture.citations;
  const citationMetadata: MemoryMetadata = {
    ...baseMetadata,
    ...(codeCitations.length === 0 ? {} : {codeCitations}),
    ...('keywords' in keywordPlan ? {keywords: keywordPlan.keywords} : {}),
  };
  const metadata =
    options.dryRun === true || sharedTarget || !shouldEnrichForKeywordPlan(keywordPlan)
      ? citationMetadata
      : yield* enrichMemoryMetadataWithConfiguredLocalAi(config, citationMetadata, bodyText).pipe(
          Effect.catch(error =>
            Console.log(
              `Local AI memory enrichment skipped: ${error instanceof Error ? error.message : String(error)}`,
            ).pipe(Effect.as(citationMetadata)),
          ),
        );
  const memoryUri = yield* storeMemory(config, {
    bodyText,
    deferredCodeAnchor: citationCapture.deferred,
    dryRun: options.dryRun === true,
    expectedReplaceContent: replaced?.content,
    expectedReplaceMemoryId: replacement?.memoryId,
    metadata,
    replaceUri,
    title: 'HANDOFF',
  });
  if (citationCapture.deferred && options.dryRun !== true) {
    yield* Console.log(deferredCodeAnchorStoredMessage(memoryUri, citationCapture.deferred));
  }
  if (replaced?.metadata.codeCitations?.length && codeCitations.length === 0 && !citationCapture.deferred) {
    yield* Console.log(
      `Cleared ${replaced.metadata.codeCitations.length} prior code citation(s); pass --code-ref to recapture them.`,
    );
  }
  yield* logKeywordReplaceReceipt(keywordPlan, replaced?.metadata.keywords, {dryRun: options.dryRun});
});

export const runArchive = Effect.fn('runArchive')(function* (
  config: RuntimeConfig,
  uri: string,
  options: ArchiveOptions,
) {
  yield* attemptSync(() => assertResourceUri(uri));
  const ov = NATIVE_RESOURCE_BACKEND;
  const store = yield* ResourceStore;
  if (options.dryRun === true) {
    const fallbackMetadata: MemoryMetadata = {
      archivedFrom: uri,
      kind: options.kind ?? 'handoff',
      project: normalizeOptionalMetadata(options.project),
      sourceAgentClient: 'threadnote',
      status: 'archived',
      timestamp: DateTime.formatIso(yield* DateTime.now),
      topic: normalizeOptionalMetadata(options.topic),
    };
    yield* storeMemory(config, {
      bodyText: ['Archived original Threadnote memory.', '', '<original memory content would be read here>'].join('\n'),
      dryRun: true,
      metadata: fallbackMetadata,
      title: 'MEMORY',
    });
    yield* Console.log(`Would remove archived native resource: ${uri}`);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const invalidatedUris = options.invalidatedUris ?? [uri];
  yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [uri],
    Effect.gen(function* () {
      const originalMemory = (yield* store.read(resourceStoreLocation(config), uri)).trim();
      if (options.expectedContent !== undefined && originalMemory !== options.expectedContent.trim()) {
        return yield* MemoryOperationError.make({
          message: `Memory ${uri} changed after the hygiene plan. Re-run compact before archiving.`,
        });
      }
      yield* attemptSync(() => assertMemoryDocumentSchemaWritable(originalMemory));
      const sourceRecord = parseMemoryDocument(uri, originalMemory);
      if (!sourceRecord) return yield* MemoryOperationError.make({message: `Cannot archive invalid memory ${uri}.`});
      const inferredMetadata = sourceRecord.metadata;
      if (inferredMetadata.citationErrors && inferredMetadata.citationErrors.length > 0) {
        const reasons = [...new Set(inferredMetadata.citationErrors.map(error => error.reason))].sort().join(', ');
        return yield* MemoryOperationError.make({
          message: `Cannot archive ${uri}: malformed code citation metadata (${reasons}) must be repaired or recaptured first.`,
        });
      }
      const metadata = memoryArchiveMetadata(inferredMetadata, {
        archivedFrom: uri,
        kind: options.kind ?? inferredMetadata.kind ?? 'handoff',
        project: normalizeOptionalMetadata(options.project),
        sourceAgentClient: 'threadnote',
        timestamp: DateTime.formatIso(yield* DateTime.now),
        topic: normalizeOptionalMetadata(options.topic),
      });
      const archiveUri = yield* storeMemory(config, {
        bodyText: memoryArchiveBody(sourceRecord.body),
        deferRecallIndexRefresh: true,
        dryRun: false,
        metadata,
        skipMemoryIdentityLock: true,
        title: 'MEMORY',
      });
      invalidatedUris.push(archiveUri);
      const currentSource = yield* store.read(resourceStoreLocation(config), uri).pipe(Effect.option);
      if (Option.isNone(currentSource) || currentSource.value.trim() !== originalMemory) {
        const rolledBack = yield* removeResourceWithRetry(ov, config, archiveUri);
        return yield* MemoryOperationError.make({
          message: rolledBack
            ? `Memory ${uri} changed while its archive was being stored. The archived copy was rolled back; re-run the operation.`
            : `Memory ${uri} changed while its archive was being stored. The source was preserved, but cleanup of ${archiveUri} needs review.`,
        });
      }
      const removedOriginal = yield* removeResourceWithRetry(ov, config, uri, {
        alreadyLocked: true,
      });
      if (removedOriginal) {
        yield* discardDeferredCodeAnchorIntent(config, uri);
        yield* Console.log(`Archived original memory: ${uri}`);
      } else {
        yield* Console.error(`Archive stored and the original is no longer present: ${uri}`);
      }
    }),
  ).pipe(
    Effect.ensuring(
      options.deferRecallIndexRefresh
        ? Effect.void
        : refreshRecallDerivedIndexesAfterCanonicalMutation(config, invalidatedUris).pipe(Effect.asVoid),
    ),
  );
});

export const runForget = Effect.fn('runForget')(function* (config: RuntimeConfig, uri: string, options: ForgetOptions) {
  const id = yield* attemptSync(() => {
    assertResourceUri(uri);
    const parsed = parseResourceId(uri);
    assertSafeForgetTarget(parsed);
    return parsed;
  });
  const canonicalUri = id.canonicalUri;
  if (options.dryRun === true) {
    const store = yield* ResourceStore;
    const entry = yield* store.stat(resourceStoreLocation(config), canonicalUri);
    yield* Console.log(
      entry.type === 'directory'
        ? `Would remove native resource subtree: ${canonicalUri}`
        : `Would remove native resource: ${canonicalUri}`,
    );
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* withDeferredCodeAnchorMutationLocks(
    fs,
    config,
    [canonicalUri],
    Effect.gen(function* () {
      const store = yield* ResourceStore;
      const entry = yield* store.stat(resourceStoreLocation(config), canonicalUri);
      const removed = yield* removeResourceWithRetry(NATIVE_RESOURCE_BACKEND, config, canonicalUri, {
        alreadyLocked: true,
        recursive: entry.type === 'directory',
      });
      if (!removed) {
        return yield* MemoryOperationError.make({message: `Resource does not exist: ${canonicalUri}`});
      }
      yield* discardDeferredCodeAnchorIntentsWithin(config, canonicalUri);
    }),
  );
});

export const runFinalizeCodeRefs = Effect.fn('runFinalizeCodeRefs')(function* (
  config: RuntimeConfig,
  options: FinalizeCodeRefsOptions,
) {
  const limit = options.limit
    ? parsePositiveInteger(options.limit, 'deferred code-anchor finalization limit')
    : undefined;
  const receipt = yield* withCodeAnchorFinalizationAnonymousTelemetry(
    'explicit',
    finalizeDeferredCodeAnchorsWithDerivedIndexes(config, {limit, uris: options.uris}),
  );
  yield* writeFinalCliOutput(JSON.stringify(receipt, undefined, 2));
});

function assertSafeForgetTarget(id: ReturnType<typeof parseResourceId>): void {
  if (id.anchor) {
    throw MemoryOperationError.make({
      message: 'Refusing to forget an anchored resource; address the containing resource URI instead.',
    });
  }
  if (id.namespace === 'resources' && id.segments.length < 2) {
    throw MemoryOperationError.make({
      message: 'Refusing to forget a resources collection root. Address a narrower resource subtree.',
    });
  }
  if (id.namespace === 'user' && id.segments.length <= 3) {
    throw MemoryOperationError.make({
      message: 'Refusing to forget a user or memory collection root. Address a narrower resource subtree.',
    });
  }
}

export const runExportPack = Effect.fn('runExportPack')(function* (config: RuntimeConfig, options: PackOptions) {
  const path = yield* Path.Path;
  const defaultPath = path.join(config.agentContextHome, `threadnote-${safeTimestamp()}.threadnote-pack.json`);
  const outputPath = yield* expandPath(options.path ?? defaultPath);
  const sourceUri = canonicalPackRoot(options.uri ?? `threadnote://user/${uriSegment(config.user)}/memories`);
  if (options.dryRun === true) {
    yield* Console.log(`Would export native resources under ${sourceUri} to ${outputPath}.`);
    return;
  }
  const store = yield* ResourceStore;
  const entries = yield* store.list(resourceStoreLocation(config), sourceUri, {recursive: true});
  const resources = yield* Effect.forEach(
    entries.filter(entry => entry.type === 'file'),
    entry =>
      store.read(resourceStoreLocation(config), entry.uri).pipe(
        Effect.map(content => ({
          content,
          relativeUri: entry.uri.slice(sourceUri.replace(/\/+$/, '').length).replace(/^\/+/, ''),
        })),
      ),
    {concurrency: 8},
  );
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${outputPath}.${(yield* SystemInfo).processId}.tmp`;
  yield* fs.makeDirectory(path.dirname(outputPath), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(temporary, `${JSON.stringify({resources, sourceUri, version: 1}, undefined, 2)}\n`, {
    mode: 0o600,
  });
  yield* fs.rename(temporary, outputPath);
  yield* Console.log(`Exported ${resources.length} resource(s) to ${outputPath}.`);
});

export const runImportPack = Effect.fn('runImportPack')(function* (config: RuntimeConfig, options: PackOptions) {
  if (!options.path) {
    return yield* MemoryOperationError.make({message: 'Provide --path for import-pack.'});
  }
  const inputPath = yield* expandPath(options.path);
  const fs = yield* FileSystem.FileSystem;
  const rawPack = yield* fs.readFileString(inputPath);
  const pack = yield* Effect.try({
    try: () => parseThreadnotePack(rawPack),
    catch: cause =>
      MemoryOperationError.make({message: `Invalid Threadnote pack ${inputPath}: ${errorMessage(cause)}`, cause}),
  });
  const targetUri = options.targetUri
    ? canonicalPackRoot(options.targetUri)
    : packTargetForCurrentUser(pack.sourceUri, config.user);
  const planned = pack.resources.map(resource => ({
    content: resource.content,
    uri: canonicalPackRoot(`${targetUri.replace(/\/+$/, '')}/${resource.relativeUri}`),
  }));
  const destinations = new Set<string>();
  for (const resource of planned) {
    const collisionKey = resource.uri.normalize('NFC').toLocaleLowerCase();
    if (destinations.has(collisionKey)) {
      return yield* MemoryOperationError.make({
        message: `Threadnote pack contains colliding destination URIs: ${resource.uri}.`,
      });
    }
    destinations.add(collisionKey);
  }
  const store = yield* ResourceStore;
  const mutations: ResourceStoreMutation[] = [];
  for (const resource of planned) {
    if (options.dryRun === true) {
      yield* Console.log(`Would import native resource: ${resource.uri}`);
      continue;
    }
    mutations.push({
      content: resource.content,
      options: {mode: 'upsert'},
      type: 'write',
      uri: resource.uri,
    });
  }
  if (options.dryRun !== true) {
    const mutation = store.mutate(resourceStoreLocation(config), mutations);
    const managedMemoryUris = planned.map(resource => resource.uri).filter(resourceIdIsManagedMemoryNamespace);
    if (managedMemoryUris.length === 0) {
      yield* mutation;
    } else {
      yield* withMemoryUriLocks(
        fs,
        config.agentContextHome,
        managedMemoryUris,
        mutation.pipe(
          Effect.andThen(
            Effect.forEach(
              managedMemoryUris,
              uri =>
                discardDeferredCodeAnchorIntent(config, uri).pipe(Effect.andThen(discardMemoryRelocation(config, uri))),
              {concurrency: 4},
            ),
          ),
        ),
      );
    }
  }
  yield* Console.log(
    `${options.dryRun === true ? 'Would import' : 'Imported'} ${pack.resources.length} resource(s) from ${inputPath}.`,
  );
});

function parseThreadnotePack(raw: string): {
  readonly resources: readonly {readonly content: string; readonly relativeUri: string}[];
  readonly sourceUri: string;
  readonly version: 1;
} {
  const value = JSON.parse(raw) as unknown;
  if (!Predicate.isObject(value)) throw MemoryOperationError.make({message: 'Pack root must be an object.'});
  const pack = value;
  if (pack.version !== 1 || typeof pack.sourceUri !== 'string' || !Array.isArray(pack.resources)) {
    throw MemoryOperationError.make({message: 'Unsupported Threadnote pack version or shape.'});
  }
  const resources = pack.resources.map(resource => {
    if (
      !Predicate.isObject(resource) ||
      typeof resource.content !== 'string' ||
      typeof resource.relativeUri !== 'string'
    ) {
      throw MemoryOperationError.make({message: 'Pack resource entry is invalid.'});
    }
    const entry = {content: resource.content, relativeUri: resource.relativeUri};
    if (
      !entry.relativeUri ||
      entry.relativeUri.startsWith('/') ||
      entry.relativeUri.split('/').some(segment => !segment || segment === '.' || segment === '..')
    ) {
      throw MemoryOperationError.make({message: `Unsafe pack relative URI: ${entry.relativeUri}.`});
    }
    return entry;
  });
  return {resources, sourceUri: pack.sourceUri, version: 1};
}

function canonicalPackRoot(input: string): string {
  const id = parseResourceId(input);
  if (id.anchor) throw MemoryOperationError.make({message: `Pack resource roots cannot contain anchors: ${input}.`});
  return resourceIdWithoutAnchor(id).canonicalUri;
}

function packTargetForCurrentUser(sourceUri: string, user: string): string {
  const source = resourceIdWithoutAnchor(parseResourceId(sourceUri));
  if (source.namespace === 'resources') {
    return source.canonicalUri;
  }
  if (source.namespace === 'user' && source.segments.length > 0) {
    return canonicalResourceUri('user', [uriSegment(user), ...source.segments.slice(1)]);
  }
  throw MemoryOperationError.make({message: `Unsupported Threadnote pack source URI: ${sourceUri}.`});
}

const inferRecallUri = Effect.fn('memory.inferRecallUri')(function* (config: RuntimeConfig, query: string) {
  // Only scope the base search when the query has an explicit "skills" intent —
  // that narrowing matches user expectation ("find me a skill for X"). For
  // general project-name matches we no longer scope the base search, because
  // doing so used to exclude personal memories whenever the project name
  // appeared in the query. Seeded resources are now surfaced via a parallel
  // scoped pass in `augmentRecallWithSeededResources` so memories and seeded
  // guidance both appear.
  if (!hasAgentSkillCatalogIntent(query)) {
    return undefined;
  }
  const project = yield* inferProjectFromQuery(config.manifestPath, query);
  return project
    ? `threadnote://resources/agent-skills/repo-local-${uriSegment(project.name)}`
    : 'threadnote://resources/agent-skills';
});

export function hasAgentSkillCatalogIntent(query: string): boolean {
  const normalized = query.toLowerCase();
  if (!/\bskills?\b/.test(normalized)) {
    return false;
  }
  if (/\bseed[- ]skills?\b/.test(normalized) || /\bskills?\s+seed(?:ing)?\b/.test(normalized)) {
    return false;
  }
  if (/^\s*skills?\s*$/.test(normalized)) {
    return true;
  }
  return (
    /\b(find|list|show|search|recall|use|choose|select)\b.{0,48}\bskills?\b/.test(normalized) ||
    /\bskills?\b.{0,48}\b(for|to|that|which|about)\b/.test(normalized)
  );
}

const collectNativeExactMemoryMatches = Effect.fn('memory.collectNativeExactMemoryMatches')(function* (
  config: RuntimeConfig,
  query: string,
  options: {
    readonly eligibility: RecallEligibilityPolicy;
    readonly includeArchived: boolean;
    readonly project: ProjectManifest | undefined;
  },
) {
  const terms = exactRecallTerms(query);
  if (terms.length === 0) return {matches: [], operationalWarnings: []};
  const result = yield* loadRecallExactMatches(config, {
    eligibility: options.eligibility,
    includeInactive: options.includeArchived,
    limitPerTerm: 25,
    terms,
    uriScopes: exactMemoryScopes(config, options.includeArchived, query, options.project),
  }).pipe(Effect.result);
  return Result.isSuccess(result)
    ? {matches: result.success, operationalWarnings: []}
    : {matches: [], operationalWarnings: [lexicalIndexUnavailableWarning()]};
});

export const storeMemory = Effect.fn('storeMemory')(function* (config: RuntimeConfig, input: StoreMemoryOptions) {
  if (input.replaceUri) {
    yield* attemptSync(() => assertResourceUri(input.replaceUri!));
  }
  const options = yield* resolveStoreMemoryReplacementOptions(config, input);
  const replaceUri = options.replaceUri;
  const ov = NATIVE_RESOURCE_BACKEND;
  if (replaceUri && isInSharedNamespace(config, replaceUri)) {
    if (options.deferredCodeAnchor) {
      return yield* MemoryOperationError.make({
        message: 'Deferred code anchors are private-local and cannot update shared memory.',
      });
    }
    if (options.dryRun) {
      yield* storeSharedMemoryReplacement(config, ov, options, replaceUri);
      return replaceUri;
    }
    const fs = yield* FileSystem.FileSystem;
    const sharedWrite = verifyAuthoredMemoryRelationTargetIdentities(config, options.expectedSourceContent ?? []).pipe(
      Effect.andThen(storeSharedMemoryReplacement(config, ov, options, replaceUri)),
    );
    yield* withSharedRepositoryLock(
      config,
      withMemoryUriLocks(
        fs,
        config.agentContextHome,
        [
          replaceUri,
          ...(options.expectedSourceContent ?? []).map(source => source.uri),
          ...(options.skipMemoryIdentityLock === true
            ? []
            : memoryIdentityWriteLockKeys(options.metadata.memoryId, options.expectedSourceContent ?? [])),
        ],
        sharedWrite,
      ),
    );
    if (!options.deferRecallIndexRefresh) {
      yield* refreshRecallDerivedIndexesAfterCanonicalMutation(config, [replaceUri]);
    }
    return replaceUri;
  }
  // Two-pass formatting: assume the caller's replaceUri is a true supersede,
  // compute the destination URI, then drop the supersedes line if it points
  // at the URI we are about to write to (an in-place update). Without this,
  // `--replace <self>` would bake a self-supersedes line into the body that
  // also leaks to teammates when the memory is later published.
  const candidateMetadata: MemoryMetadata =
    replaceUri === undefined ? options.metadata : {...options.metadata, supersedes: replaceUri};
  const candidateMemory = formatMemoryDocument(options.title, candidateMetadata, options.bodyText);
  const memoryUri = yield* memoryUriFor(config, candidateMemory, candidateMetadata);
  const isInPlaceUpdate = replaceUri !== undefined && replaceUri === memoryUri;
  const finalMetadata: MemoryMetadata = isInPlaceUpdate
    ? {...options.metadata, supersedes: undefined}
    : candidateMetadata;
  const memory = isInPlaceUpdate
    ? formatMemoryDocument(options.title, finalMetadata, options.bodyText)
    : candidateMemory;
  if (options.dryRun) {
    yield* assertPersonalMemoryDestinationWritable(config, memoryUri, replaceUri);
    const writeMode = yield* memoryWriteMode(ov, config, memoryUri, finalMetadata);
    yield* Console.log(memory);
    yield* Console.log(`\nWould ${writeMode} native resource: ${memoryUri}`);
    if (replaceUri && !isInPlaceUpdate) {
      yield* Console.log(`Would remove superseded native resource: ${replaceUri}`);
    }
    if (options.deferredCodeAnchor) {
      yield* Console.log(
        `Would stage ${options.deferredCodeAnchor.codeRefs.length} code reference(s) in the private deferred-anchor outbox.`,
      );
    }
    return memoryUri;
  }
  const fs = yield* FileSystem.FileSystem;
  const write = Effect.gen(function* () {
    const store = yield* ResourceStore;
    const destination = yield* assertPersonalMemoryDestinationWritable(config, memoryUri, replaceUri);
    yield* verifyAuthoredMemoryRelationTargetIdentities(config, options.expectedSourceContent ?? []);
    if (replaceUri) {
      if (options.expectedReplaceRawContent !== undefined) {
        yield* assertCurrentReplacementRawContent(config, replaceUri, options.expectedReplaceRawContent);
      }
      yield* assertCurrentReplacementWritable(
        config,
        replaceUri,
        options.expectedReplaceContent,
        replaceUri === memoryUri ? destination : undefined,
      );
    }
    const relocationSourceContent =
      replaceUri && !isInPlaceUpdate ? yield* store.read(resourceStoreLocation(config), replaceUri) : undefined;
    const writeMode = yield* memoryWriteMode(ov, config, memoryUri, finalMetadata);
    yield* ensureMemoryDirectory(ov, config, memoryDirectoryUri(config, finalMetadata));
    const stagedDeferredCodeAnchor = options.deferredCodeAnchor
      ? yield* stageDeferredCodeAnchorIntent(config, {
          memoryContent: memory,
          memoryMetadata: finalMetadata,
          memoryUri,
          request: options.deferredCodeAnchor,
        })
      : undefined;
    const relationCheck = verifyAuthoredMemoryRelationTargetIdentities(config, options.expectedSourceContent ?? []);
    yield* writeMemoryFileChecked(config, ov, memoryUri, memory, writeMode, false, relationCheck);
    if (replaceUri && relocationSourceContent !== undefined && !isInPlaceUpdate) {
      yield* recordMemoryRelocation(config, {
        fromContent: relocationSourceContent,
        fromUri: replaceUri,
        toContent: memory,
        toUri: memoryUri,
      });
    }
    yield* Console.log(`Stored memory: ${memoryUri}`);
    if (stagedDeferredCodeAnchor) {
      yield* discardOtherDeferredCodeAnchorIntents(config, memoryUri, stagedDeferredCodeAnchor.intentId);
      if (replaceUri && replaceUri !== memoryUri) {
        yield* discardDeferredCodeAnchorIntent(config, replaceUri);
      }
    } else {
      yield* discardDeferredCodeAnchorIntent(config, memoryUri);
      if (replaceUri && replaceUri !== memoryUri) {
        yield* discardDeferredCodeAnchorIntent(config, replaceUri);
      }
    }
    if (replaceUri && !isInPlaceUpdate) {
      const removedReplacedMemory = yield* removeResourceWithRetry(ov, config, replaceUri, {
        alreadyLocked: true,
      });
      if (removedReplacedMemory) {
        yield* Console.log(`Forgot replaced memory: ${replaceUri}`);
      } else {
        yield* Console.error(
          `Replacement stored, but the superseded memory is still processing. Retry later: threadnote forget ${replaceUri}`,
        );
      }
    } else if (isInPlaceUpdate) {
      yield* Console.log(`Updated existing memory in place: ${memoryUri}`);
    }
  });
  yield* options.deferredCodeAnchor
    ? withDeferredCodeAnchorMutationLocks(
        fs,
        config,
        [
          replaceUri,
          memoryUri,
          ...(options.expectedSourceContent ?? []).map(source => source.uri),
          ...(options.skipMemoryIdentityLock === true
            ? []
            : memoryIdentityWriteLockKeys(finalMetadata.memoryId, options.expectedSourceContent ?? [])),
        ],
        write,
      )
    : withMemoryUriLocks(
        fs,
        config.agentContextHome,
        [
          replaceUri,
          memoryUri,
          ...(options.expectedSourceContent ?? []).map(source => source.uri),
          ...(options.skipMemoryIdentityLock === true
            ? []
            : memoryIdentityWriteLockKeys(finalMetadata.memoryId, options.expectedSourceContent ?? [])),
        ],
        write,
      );
  if (!options.deferRecallIndexRefresh) {
    yield* refreshRecallDerivedIndexesAfterCanonicalMutation(config, [memoryUri, ...(replaceUri ? [replaceUri] : [])]);
  }
  return memoryUri;
});

function isMemoryKind(value: string): value is MemoryKind {
  return (
    value === 'durable' || value === 'handoff' || value === 'incident' || value === 'preference' || value === 'smoke'
  );
}

/**
 * Warn when an in-place shared replacement was asked to change the memory's
 * project — that is fixed by the storage path, so the request is ignored to keep
 * frontmatter and path consistent (the divergence the doctor check flags). The
 * caller's value is normalized via `uriSegment` to match how the path segment
 * was produced. Topic is left to the existing caller-wins behavior: it is not a
 * consistency-checked field and the path-derived topic can be a raw multi-segment
 * value (`a/b`) that must not be slugged into or persisted from here.
 */
const warnOnSharedProjectDrift = Effect.fn('memory.warnOnSharedProjectDrift')(function* (
  metadata: MemoryMetadata,
  inferred: {readonly project?: string} | undefined,
) {
  if (inferred?.project && metadata.project && uriSegment(metadata.project) !== inferred.project) {
    yield* Console.log(
      `WARN keeping shared memory project "${inferred.project}" from its storage path; ignoring requested "${metadata.project}". ` +
        `To change a shared memory's project, forget it and store a new one under the new project.`,
    );
  }
});

const storeSharedMemoryReplacement = Effect.fn('memory.storeSharedMemoryReplacement')(function* (
  config: RuntimeConfig,
  ov: string,
  options: StoreMemoryOptions,
  targetUri: string,
) {
  if (options.metadata.kind !== 'durable') {
    return yield* MemoryOperationError.make({message: 'Shared memory replacement only supports durable memories.'});
  }
  const teamName = sharedTeamNameForUri(config, targetUri);
  if (!teamName) {
    return yield* MemoryOperationError.make({message: `Memory ${targetUri} is not in the shared namespace.`});
  }
  const team = yield* resolveTeam(config, teamName);
  const inferred = sharedMemoryUriParts(config, targetUri);
  // The file is updated in place at targetUri, so its frontmatter project must
  // match the path it lives under; otherwise recall's project scoping and the
  // doctor consistency check disagree with the file's real location. Prefer the
  // path's project over a differing caller value and warn — changing a shared
  // memory's project means relocating it (forget + store anew), not editing the
  // frontmatter of the file at the old path. Topic keeps caller-wins semantics.
  yield* warnOnSharedProjectDrift(options.metadata, inferred);
  const metadata: MemoryMetadata = {
    ...options.metadata,
    project: inferred?.project ?? options.metadata.project,
    topic: options.metadata.topic ?? inferred?.topic,
  };
  const rawMemory = formatMemoryDocument(options.title, metadata, options.bodyText);
  const citationBlocker = memoryCodeCitationSharingBlocker(metadata);
  if (citationBlocker) {
    return yield* MemoryOperationError.make({
      message: `Refusing to update shared memory ${targetUri}: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
    });
  }
  const scrub = applyScrubber(stripPersonalProvenanceForSharedPublication(rawMemory), {
    redact: false,
  });
  if (scrub.blocker) {
    return yield* MemoryOperationError.make({
      message: `Refusing to update shared memory ${targetUri}: possible ${scrub.blocker}. Strip the sensitive value first.`,
    });
  }
  const memory = scrub.cleaned;
  const relativePath = resourceUriToWorktreeRelative(config, targetUri, team.name);

  if (options.dryRun) {
    yield* Console.log(memory);
    yield* Console.log('\nWould run:');
  }
  const [existingTarget] = options.dryRun ? [] : yield* readMemoryRecordsByUri(config, [targetUri]);
  if (!options.dryRun && !existingTarget) {
    return yield* MemoryOperationError.make({message: `Shared memory ${targetUri} no longer exists.`});
  }
  if (!options.dryRun) {
    yield* assertCurrentReplacementWritable(config, targetUri, options.expectedReplaceContent, existingTarget);
  }
  const previousContent = existingTarget?.content;
  yield* assertSharedWorktreeFileReady(team.config.worktree, relativePath, previousContent, options.dryRun);
  yield* ensureSharedDirectoryChain(config, ov, targetUri, options.dryRun);
  const relationCheck = verifyAuthoredMemoryRelationTargetIdentities(config, options.expectedSourceContent ?? []);
  yield* writeMemoryFileChecked(config, ov, targetUri, memory, 'replace', options.dryRun, relationCheck);
  yield* writeSharedWorktreeFile(team.config.worktree, relativePath, memory, options.dryRun);

  const gitMessages = yield* publishShareGitChange(
    team.config.worktree,
    relativePath,
    `share: update ${relativePath}`,
    {
      dryRun: options.dryRun,
    },
  );
  for (const message of gitMessages) {
    yield* Console.log(message);
  }

  for (const redaction of scrub.redactions) {
    yield* Console.log(`Redacted ${redaction.count}× ${redaction.name} before shared update.`);
  }
  yield* Console.log(`Updated shared memory: ${targetUri}`);
});

const MAX_WORKSET_PASSES = 12;

/**
 * Durable + seeded recall scopes for every member of a workset, in member
 * order. Callers dedupe against the already-scoped passes and cap the result;
 * the recall merge dedupes any overlapping hits.
 */
function worksetScopeUris(config: RuntimeConfig, workset: ResolvedWorkset): readonly string[] {
  const scopes: string[] = [];
  for (const member of workset.projects) {
    scopes.push(`threadnote://user/${uriSegment(config.user)}/memories/durable/projects/${uriSegment(member.name)}`);
    const seeded = trimTrailingSlash(member.uri);
    if (seeded.startsWith('threadnote://')) {
      scopes.push(seeded);
    }
  }
  return [...new Set(scopes)];
}

function projectMemoryScopeUris(
  config: RuntimeConfig,
  projectName: string | undefined,
  includeArchived: boolean,
): readonly string[] {
  if (!projectName) {
    return [];
  }
  const base = `threadnote://user/${uriSegment(config.user)}/memories`;
  const projectSegment = uriSegment(projectName);
  const scopes = [
    `${base}/durable/projects/${projectSegment}`,
    `${base}/handoffs/active/${projectSegment}`,
    `${base}/incidents/active/${projectSegment}`,
  ];
  return includeArchived
    ? [
        ...scopes,
        `${base}/durable/archived/${projectSegment}`,
        `${base}/handoffs/archived/${projectSegment}`,
        `${base}/incidents/archived/${projectSegment}`,
      ]
    : scopes;
}

function exactMemoryScopes(
  config: RuntimeConfig,
  includeArchived: boolean,
  query: string,
  project: ProjectManifest | undefined,
): readonly string[] {
  return exactMemoryScopeUris({
    agentMemoriesUri: `threadnote://agent/${uriSegment(config.agentId)}/memories`,
    includeArchived,
    intents: exactRecallScopeIntents(query),
    projectName: project ? uriSegment(project.name) : undefined,
    projectResourceUri: project ? trimTrailingSlash(project.uri) : undefined,
    userBase: `threadnote://user/${uriSegment(config.user)}/memories`,
  });
}

const memoryUriFor = Effect.fn('memory.memoryUriFor')(function* (
  config: RuntimeConfig,
  memory: string,
  metadata: MemoryMetadata,
) {
  const filename = shouldUseStableMemoryUri(metadata)
    ? `${uriSegment(metadata.topic ?? 'current')}.md`
    : `threadnote-${safeTimestamp()}-${(yield* sha256(memory)).slice(0, 12)}.md`;
  return `${memoryDirectoryUri(config, metadata)}/${filename}`;
});

function shouldUseStableMemoryUri(metadata: MemoryMetadata): boolean {
  return metadata.status === 'active' && metadata.topic !== undefined && metadata.kind !== 'smoke';
}

const memoryWriteMode = Effect.fn('memory.memoryWriteMode')(function* (
  _ov: string,
  config: RuntimeConfig,
  memoryUri: string,
  metadata: MemoryMetadata,
) {
  if (!shouldUseStableMemoryUri(metadata)) {
    return 'create';
  }
  return (yield* resourceExists(NATIVE_RESOURCE_BACKEND, config, memoryUri)) ? 'replace' : 'create';
});

const buildHandoff = Effect.fn('memory.buildHandoff')(function* (options: HandoffOptions, existingMemoryId?: string) {
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const repoRoot = (yield* gitValue(['rev-parse', '--show-toplevel'])) ?? (yield* getInvocationCwd());
  const branch = (yield* gitValue(['branch', '--show-current'], repoRoot)) ?? 'unknown';
  const commit = (yield* gitValue(['rev-parse', 'HEAD'], repoRoot)) ?? 'unknown';
  const status = (yield* gitValue(['status', '--short'], repoRoot)) ?? '';
  const diffStat = (yield* gitValue(['diff', '--stat', 'HEAD'], repoRoot)) ?? '';
  const touchedFiles = yield* gitTouchedFiles(repoRoot);
  const repoName = (yield* resolveRepoName(repoRoot)) ?? path.basename(repoRoot);
  const topicBranch = branch && branch !== 'unknown' ? branch : 'current';
  const workspaceComponent = yield* resolveWorkspaceComponentContext({includeProcessCwd: true});
  const metadata: MemoryMetadata = {
    kind: 'handoff',
    memoryId: existingMemoryId ?? `tn_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`,
    project: normalizeOptionalMetadata(options.project) ?? repoName,
    references: normalizeReferenceUris(options.references),
    sourceAgentClient: options.sourceAgentClient ?? 'codex',
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...(commit === 'unknown' ? {} : {sourceCommit: commit}),
    sourceObservedAt: DateTime.formatIso(yield* DateTime.now),
    status: 'active',
    timestamp: DateTime.formatIso(yield* DateTime.now),
    topic: handoffTopicForBranch(topicBranch, {timestamped: options.timestamped, topic: options.topic}),
    workspaceScope: workspaceComponent?.scope,
  };
  // Caller-supplied review-state snapshot (pr/issue/ci). Threadnote has no
  // GitHub client, so these are captured strings paired with the exact commit,
  // never a live status board.
  const reviewState = [
    options.pr ? `pr: ${options.pr}` : undefined,
    options.issue ? `issue: ${options.issue}` : undefined,
    options.ci ? `ci: ${options.ci}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const bodyText = [
    `repo: ${repoName}`,
    `repo_path: ${repoRoot}`,
    `branch: ${branch || 'unknown'}`,
    `commit: ${commit}`,
    `task: ${options.task ?? 'unspecified'}`,
    ...reviewState,
    '',
    'files_touched:',
    formatBlock(touchedFiles, '- none'),
    '',
    'git_status:',
    formatBlock(status, '- clean'),
    '',
    'diff_stat:',
    formatBlock(diffStat, '- none'),
    '',
    'tests:',
    options.tests ?? '- not recorded',
    '',
    'blockers:',
    options.blockers ?? '- none recorded',
    '',
    'next_step:',
    options.nextStep ?? `- ${DEFAULT_HANDOFF_NEXT_STEP}`,
    ...(options.sessionId ? ['', `session_id: ${options.sessionId}`] : []),
    ...(options.trace ? ['', 'trace (auto-captured, heuristic):', options.trace] : []),
  ].join('\n');
  return {bodyText, metadata};
});

const gitTouchedFiles = Effect.fn('memory.gitTouchedFiles')(function* (cwd: string) {
  const changedFiles = yield* gitValue(['diff', '--name-only', 'HEAD'], cwd);
  const untrackedFiles = yield* gitValue(['ls-files', '--others', '--exclude-standard'], cwd);
  const files = new Set<string>();
  for (const value of [changedFiles, untrackedFiles]) {
    for (const line of (value ?? '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        files.add(trimmed);
      }
    }
  }
  return [...files].sort().join('\n');
});

function formatBlock(value: string, emptyValue: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return emptyValue;
  }
  return trimmed
    .split('\n')
    .map(line => `- ${line}`)
    .join('\n');
}
