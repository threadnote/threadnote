import {Clock, Crypto, DateTime, Effect, FileSystem, Path, Schema} from 'effect';
import {CODE_GRAPH_CITATION_CAPSULE_RETENTION} from '@threadnote/graph/citation/capsule';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {codeGraphQueryScopeReceipt} from '@threadnote/graph/query/scope';
import {observeCleanRepositoryWorktree} from '@threadnote/graph/repository';
import {codeGraphScopeAdmitsPath} from '@threadnote/graph/scope/applicability';
import type {CodeGraphQueryResult, CodeGraphStatus} from '@threadnote/graph/types';
import {captureMemoryCodeCitations, memoryCodeCitationProjectScopeReceipt} from '@threadnote/context/citation/capture';
import {canonicalMemoryDocumentContent, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {isMemoryId, memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {
  loadCandidateReviewOptional,
  listCandidateReviews,
  saveCandidateReview,
  withCandidateReviewLock,
  type CandidateReview,
} from '@threadnote/memory/candidate';
import {
  isCodeTopicMaintenanceManifest,
  topicMaintenanceAcceptedCitation,
  validateTopicMaintenanceManifest,
} from '@threadnote/memory/topic-maintenance';
import {
  prepareTopicDependencyExpansion,
  restartTopicDependencyExpansionPreview,
  topicDependencyExpansionChoices,
  topicExpansionDigest,
  validateTopicDependencyExpansionInput,
  validateTopicDependencyExpansionPreview,
  type TopicDependencyExpansionPreview,
  type TopicDependencyExpansionOperation,
  type TopicDependencyExpansionProof,
  type TopicDependencyExpansionRequest,
  type TopicDependencyExpansionAddition,
} from '@threadnote/memory/topic-maintenance-expansion';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readMemoryRecordsByUri, writeApprovedTopicDependencyExpansion} from '../../mcp/server/memory.js';
import {resolveLocalMemoryReplacementTarget} from '../replacement_target.js';

export class TopicExpansionError extends Schema.TaggedError<TopicExpansionError>()('TopicExpansionError', {
  message: Schema.String,
}) {}
const fail = (message: string) => TopicExpansionError.make({message});
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: cause => fail(cause instanceof Error ? cause.message : 'Expansion proof is unavailable.'),
  });
export interface TopicDependencyExpansionOptions {
  readonly uri: string;
  readonly callerCwd: string;
  readonly input: unknown;
}

const targetRecord = Effect.fn('topicExpansion.target')(function* (config: RuntimeConfig, uri: string) {
  const target = yield* resolveLocalMemoryReplacementTarget(config, isMemoryId(uri) ? memoryIdentityAlias(uri) : uri);
  const record = target.record;
  if (!record || !record.metadata.topicMaintenance || record.metadata.topicMaintenanceError)
    return yield* fail('Select an enrolled private code topic.');
  const manifest = yield* checked(() => validateTopicMaintenanceManifest(record.metadata.topicMaintenance, record));
  if (
    !isCodeTopicMaintenanceManifest(manifest) ||
    record.metadata.obsidianEvidence ||
    record.metadata.sourceEvidence ||
    record.metadata.visibility === 'shared' ||
    !record.uri.startsWith(`threadnote://user/${config.user}/memories/durable/`)
  )
    return yield* fail('Dependency expansion is available only for private code topics.');
  return record;
});

const currentScope = Effect.fn('topicExpansion.currentScope')(function* (
  config: RuntimeConfig,
  callerCwd: string,
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(callerCwd)) return yield* fail('Select an absolute repository checkout.');
  const query = yield* CodeGraphQueryService;
  const status = yield* query.status(config.agentContextHome, callerCwd, {
    project,
    manifestPath: config.manifestPath,
    observeWorktree: true,
    requestMaintenance: false,
  });
  const observed = observationFromCodeGraphStatus(status);
  const snapshot = status.readySnapshot;
  if (
    !snapshot ||
    snapshot.state !== 'ready' ||
    snapshot.dirty ||
    status.stale ||
    status.freshness !== 'current' ||
    // Scoped status proves its selected inputs; the full checkout is checked below.
    (observed?.overlay?.dirty !== false &&
      (observed?.projectScope?.scope === undefined || observed?.overlay !== undefined)) ||
    !observed.projectScopeObserved ||
    status.projectCoverage?.completeness === 'partial' ||
    (observed.projectScope?.scope &&
      (!observed.projectScope.evidence || observed.projectScope.scope.completeness !== 'complete')) ||
    !(yield* observeCleanRepositoryWorktree(callerCwd))
  )
    return yield* fail(
      'Prepare a complete current ready project graph and a clean checkout. Expansion never starts indexing.',
    );
  const root = yield* fs.realPath(status.identity.repoRoot);
  const scope = codeGraphQueryScopeReceipt(observed.projectScope);
  const scopeReceiptJson = JSON.stringify(scope ?? {kind: 'full-repository', project});
  const profileDigest = topicExpansionDigest({
    extractorSet: snapshot.extractorSet,
    languagePacks: status.languagePacks,
    policy: observed.projectScope?.evidence?.policyFingerprint ?? null,
  });
  const manifestBytes = yield* fs.readFileString(config.manifestPath);
  const scopeDigest = topicExpansionDigest({
    project: observed.projectScope?.project ?? project,
    scopeReceiptJson,
    coverage: status.projectCoverage ?? null,
  });
  const configDigest = topicExpansionDigest({manifestBytes, scopeDigest, profileDigest});
  return {status, root, scopeDigest, scopeReceiptJson, profileDigest, configDigest};
});

function inspectOptions(config: RuntimeConfig, callerCwd: string, project: string) {
  return {
    threadnoteHome: config.agentContextHome,
    cwd: callerCwd,
    project,
    manifestPath: config.manifestPath,
    refresh: false,
    strictFreshness: true,
    baseCommitPolicy: 'ready-only' as const,
  };
}
function sameResult(status: CodeGraphStatus, result: CodeGraphQueryResult) {
  return (
    result.freshness === 'current' &&
    !result.snapshot.dirty &&
    result.repository.repositoryId === status.identity.repositoryId &&
    result.snapshot.id === status.readySnapshot?.id &&
    result.snapshot.commit === status.readySnapshot?.commit &&
    result.projectCoverage?.completeness !== 'partial' &&
    !result.outsideProjectGraph
  );
}

/** First read exposes only declared seed choices. Neighbors require an explicit bounded input. */
export const inspectTopicDependencyExpansion = Effect.fn('topicExpansion.inspect')(function* (
  config: RuntimeConfig,
  options: {readonly uri: string; readonly callerCwd: string; readonly project: string; readonly input?: unknown},
) {
  const record = yield* targetRecord(config, options.uri);
  const scope = yield* currentScope(config, options.callerCwd, options.project);
  const query = yield* CodeGraphQueryService;
  const manifest = record.metadata.topicMaintenance!;
  if (!isCodeTopicMaintenanceManifest(manifest) || manifest.repositoryId !== scope.status.identity.repositoryId)
    return yield* fail('The topic belongs to a different repository.');
  const declared = [
    ...new Set([
      ...manifest.paragraphs.flatMap(p => p.citationIds),
      ...manifest.additionalDependencies.map(d => d.citationId),
    ]),
  ];
  const seeds = [];
  for (const id of declared) {
    const citation = topicMaintenanceAcceptedCitation(record, id);
    const result = yield* query.inspect({
      ...inspectOptions(config, options.callerCwd, options.project),
      operation: citation.target.kind === 'symbol' ? 'node' : 'query',
      ...(citation.target.kind === 'symbol' ? {nodeId: citation.target.nodeId} : {query: citation.path}),
      nodeLimit: 64,
      edgeLimit: 1,
    });
    if (!sameResult(scope.status, result)) return yield* fail('Declared seed evidence is unavailable or changed.');
    for (const node of result.nodes.filter(
      node =>
        node.path === citation.path &&
        (citation.target.kind === 'symbol'
          ? node.id === citation.target.nodeId
          : ['asset', 'document', 'file', 'module', 'resource'].includes(node.kind)),
    ))
      seeds.push({id: node.id, label: node.name, path: node.path, kind: node.kind, citationId: id});
  }
  const unique = [...new Map(seeds.map(seed => [seed.id, seed])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const suggestions =
    options.input === undefined
      ? undefined
      : yield* readExpansionProof(
          config,
          record,
          options.callerCwd,
          validateTopicDependencyExpansionInput(options.input),
        );
  if ((yield* currentScope(config, options.callerCwd, options.project)).configDigest !== scope.configDigest)
    return yield* fail('Project configuration changed during inspection.');
  return {
    status: 'ready' as const,
    sourceKind: 'code' as const,
    targetUri: record.uri,
    body: record.body,
    currentScope: manifest.additionalDependencies,
    seeds: unique,
    project: options.project,
    root: scope.root,
    configDigest: scope.configDigest,
    warning:
      'Only the selected one-hop project neighborhood is evaluated. Suggestions do not expand paragraph authority.',
    ...(suggestions
      ? {
          choices: topicDependencyExpansionChoices(suggestions.request, suggestions.proof),
          coverage: suggestions.proof.reads.map(read => ({seedId: read.seedId, ...read.coverage})),
        }
      : {}),
  };
});

const readExpansionProof = Effect.fn('topicExpansion.proof')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  callerCwd: string,
  request: TopicDependencyExpansionRequest,
) {
  const scope = yield* currentScope(config, callerCwd, request.project);
  const status = scope.status;
  const snapshot = status.readySnapshot!;
  const query = yield* CodeGraphQueryService;
  const manifest = record.metadata.topicMaintenance!;
  if (
    !isCodeTopicMaintenanceManifest(manifest) ||
    manifest.repositoryId !== status.identity.repositoryId ||
    request.root !== scope.root ||
    request.configDigest !== scope.configDigest
  )
    return yield* fail('The selected repository or project configuration changed. Inspect it again.');
  const declared = [
    ...new Set([
      ...manifest.paragraphs.flatMap(p => p.citationIds),
      ...manifest.additionalDependencies.map(d => d.citationId),
    ]),
  ].map(id => topicMaintenanceAcceptedCitation(record, id));
  const reads: TopicDependencyExpansionProof['reads'][number][] = [];
  for (const seedId of request.seeds) {
    const result = yield* query.inspect({
      ...inspectOptions(config, callerCwd, request.project),
      operation: 'neighbors',
      nodeId: seedId,
      direction: request.direction,
      depth: 1,
      nodeLimit: request.nodeLimit,
      edgeLimit: request.edgeLimit,
      includeHeuristic: request.provenances.includes('heuristic'),
      includeModelAssociations: request.provenances.includes('model'),
    });
    if (
      !sameResult(status, result) ||
      result.searchCoverage?.status !== 'exhaustive' ||
      !result.searchCoverage.neighborScope ||
      result.searchCoverage.limitsReached.length ||
      result.searchCoverage.neighborScope.requestedDepth !== 1 ||
      result.searchCoverage.neighborScope.completedDepth !== 1 ||
      result.searchCoverage.neighborScope.omittedNodes !== 0 ||
      result.searchCoverage.neighborScope.missingNodes !== 0 ||
      result.searchCoverage.neighborScope.unresolvedEdges !== 0
    )
      return yield* fail(
        'The requested neighborhood is incomplete, bounded or unavailable. Choose a new explicit scope and preview.',
      );
    const seed = result.nodes.find(node => node.id === seedId);
    if (
      !seed ||
      !declared.some(
        citation =>
          citation.path === seed.path && (citation.target.kind === 'file' || citation.target.nodeId === seedId),
      )
    )
      return yield* fail('Every seed must identify an already declared code source.');
    const ids = new Set<string>();
    const paths = new Map<string, string>();
    for (const node of result.nodes) {
      if (
        ids.has(node.id) ||
        !codeGraphScopeAdmitsPath(observationFromCodeGraphStatus(status)?.projectScope?.scope, node.path)
      )
        return yield* fail('Graph endpoint is ambiguous or outside the chosen project.');
      ids.add(node.id);
      const key = status.identity.caseMode === 'insensitive' ? node.path.toLowerCase() : node.path;
      const prior = paths.get(key);
      if (prior && prior !== node.path) return yield* fail('Graph paths collide in this repository.');
      paths.set(key, node.path);
    }
    const coverage = result.searchCoverage;
    reads.push({
      seedId,
      nodes: result.nodes
        .map(node => ({id: node.id, path: node.path, contentHash: node.contentHash}))
        .sort((a, b) => a.id.localeCompare(b.id)),
      edges: result.edges
        .map(edge => ({
          id: edge.id,
          sourceId: edge.sourceId!,
          targetId: edge.targetId!,
          kind: edge.relation,
          provenance: edge.provenance,
          confidence: edge.confidence,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      coverage: {
        status: 'exhaustive',
        limitsReached: [],
        ...coverage.neighborScope!,
        requestedDepth: 1,
        completedDepth: 1,
        omittedNodes: 0,
        missingNodes: 0,
        unresolvedEdges: 0,
        visitedNodes: coverage.visitedNodes,
        inspectedEdges: coverage.inspectedEdges,
      },
    });
  }
  const proof: TopicDependencyExpansionProof = {
    version: 1,
    repositoryId: status.identity.repositoryId,
    worktreeId: status.identity.worktreeId,
    sourceCommit: status.identity.headCommit,
    sourceFenceDigest: topicExpansionDigest(status.identity),
    project: request.project,
    root: scope.root,
    configDigest: scope.configDigest,
    snapshot: {
      id: snapshot.id,
      commit: snapshot.commit,
      graphContentId: snapshot.graphContentId ?? '',
      extractorSet: snapshot.extractorSet,
    },
    profileDigest: scope.profileDigest,
    scopeDigest: scope.scopeDigest,
    scopeReceiptJson: scope.scopeReceiptJson,
    completeProject: true,
    reads,
  };
  yield* checked(() => topicDependencyExpansionChoices(request, proof));
  const after = yield* currentScope(config, callerCwd, request.project);
  if (
    after.status.readySnapshot?.id !== snapshot.id ||
    topicExpansionDigest(after.status.identity) !== proof.sourceFenceDigest ||
    after.configDigest !== scope.configDigest
  )
    return yield* fail('Source, graph or configuration changed during inspection.');
  return {request, proof, status};
});

const prepareExpansion = Effect.fn('topicExpansion.prepare')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  callerCwd: string,
  input: unknown,
  planOnly = true,
  retainedAt?: string,
  operation?: TopicDependencyExpansionOperation,
) {
  const request = yield* checked(() => validateTopicDependencyExpansionInput(input));
  const {proof, status} = yield* readExpansionProof(config, record, callerCwd, request);
  const refs = [...request.selectedNodeIds, ...request.configurationPaths];
  const citations = yield* captureMemoryCodeCitations(config, {
    callerCwd,
    project: request.project,
    refs,
    planOnly,
    ...(retainedAt === undefined ? {} : {retainedAt}),
    expectedCallerIdentity: {repositoryId: status.identity.repositoryId, worktreeId: status.identity.worktreeId},
    expectedProjectScope: memoryCodeCitationProjectScopeReceipt(status) ?? {kind: 'full'},
  });
  // Capture returns refs in requested order and deduplicates identities. A collision is rejected, never guessed.
  if (citations.length !== refs.length)
    return yield* fail('Selected references collide or cannot be captured exactly.');
  const additions = refs.map((ref, index): TopicDependencyExpansionAddition => ({
    kind: index < request.selectedNodeIds.length ? 'dependency' : 'configuration',
    ref,
    citation: citations[index],
  }));
  const closing = yield* readExpansionProof(config, record, callerCwd, request);
  if (topicExpansionDigest(proof) !== topicExpansionDigest(closing.proof))
    return yield* fail('The graph proof changed while preparing the selected evidence.');
  return yield* checked(() => prepareTopicDependencyExpansion(record, callerCwd, request, proof, additions, operation));
});

/** Read-only: no candidate journal, capsules or canonical bytes are allocated by preview. */
export const previewTopicDependencyExpansion = Effect.fn('topicExpansion.preview')(function* (
  config: RuntimeConfig,
  options: TopicDependencyExpansionOptions,
) {
  const record = yield* targetRecord(config, options.uri);
  const preview = yield* prepareExpansion(config, record, options.callerCwd, options.input);
  const [latest] = yield* readMemoryRecordsByUri(config, [record.uri]);
  if (!latest || canonicalMemoryDocumentContent(latest.content) !== preview.beforeContent)
    return yield* fail('The topic changed during preview.');
  return {status: 'preview' as const, preview};
});

const expansionReviewId = (revision: string) => `review-${revision.slice(0, 24)}`;
const expansionJournal = (
  preview: TopicDependencyExpansionPreview,
  createdAt: string,
  stage: 'preview' | 'prepared',
): CandidateReview => ({
  version: 4,
  reviewId: expansionReviewId(preview.revision),
  revision: 1,
  createdAt,
  project: preview.input.project,
  topic: parseMemoryDocument(preview.targetUri, preview.beforeContent)?.metadata.topic ?? 'dependency-expansion',
  task: 'Review explicit code dependencies.',
  outcome: 'Metadata-only private dependency approval.',
  sourceAgentClient: 'threadnote-topic-maintenance',
  auditEvents: [],
  candidates: [],
  codeCitations: [],
  dependencyExpansion: {version: 1, stage, preview},
});
interface ExpansionApproval {
  readonly preview: unknown;
  readonly revision: string;
  readonly approvalDigest: string;
  readonly approved: boolean;
}
const exactExpansionApproval = (config: RuntimeConfig, input: ExpansionApproval) =>
  checked(() => {
    const preview = validateTopicDependencyExpansionPreview(input.preview);
    if (
      input.approved !== true ||
      input.revision !== preview.revision ||
      input.approvalDigest !== preview.approvalDigest ||
      !preview.targetUri.startsWith(`threadnote://user/${config.user}/memories/durable/`)
    )
      throw new Error('Approve the exact selected additions, revision and full preview.');
    return preview;
  });
const withExpansionReviewLocks = <A, E, R>(
  config: RuntimeConfig,
  preview: TopicDependencyExpansionPreview,
  effect: Effect.Effect<A, E, R>,
) => {
  const current = withCandidateReviewLock(config.agentContextHome, expansionReviewId(preview.revision), effect);
  return preview.operation === undefined
    ? current
    : withCandidateReviewLock(
        config.agentContextHome,
        expansionReviewId(preview.operation.predecessorRevision),
        current,
      );
};
const expansionPredecessor = Effect.fn('topicExpansion.predecessor')(function* (
  config: RuntimeConfig,
  preview: TopicDependencyExpansionPreview,
) {
  if (!preview.operation) return undefined;
  const prior = yield* loadCandidateReviewOptional(
    config.agentContextHome,
    expansionReviewId(preview.operation.predecessorRevision),
  );
  const successor = prior?.dependencyExpansion?.successor;
  if (
    prior?.dependencyExpansion?.stage !== 'superseded' ||
    !successor ||
    prior.dependencyExpansion.preview.approvalDigest !== preview.operation.predecessorApprovalDigest ||
    successor.revision !== preview.revision ||
    successor.approvalDigest !== preview.approvalDigest ||
    topicExpansionDigest(successor.operation) !== topicExpansionDigest(preview.operation)
  )
    return yield* fail('This restart has no matching superseded approval receipt.');
  return successor;
});
/** Read-only recovery of an intent saved before its successor file was written. */
export const loadTopicDependencyExpansionPreview = Effect.fn('topicExpansion.loadPreview')(function* (
  config: RuntimeConfig,
  identity: {readonly revision: string; readonly approvalDigest: string},
) {
  if (!/^[a-f0-9]{64}$/u.test(identity.revision) || !/^[a-f0-9]{64}$/u.test(identity.approvalDigest)) return undefined;
  const existing = yield* loadCandidateReviewOptional(config.agentContextHome, expansionReviewId(identity.revision));
  if (existing?.dependencyExpansion?.preview.approvalDigest === identity.approvalDigest)
    return existing.dependencyExpansion.preview;
  if (existing) return undefined;
  for (const prior of yield* listCandidateReviews(config.agentContextHome)) {
    const successor = prior.dependencyExpansion?.successor;
    if (successor?.revision === identity.revision && successor.approvalDigest === identity.approvalDigest)
      return yield* checked(() =>
        restartTopicDependencyExpansionPreview(prior.dependencyExpansion!.preview, successor.operation),
      );
  }
  return undefined;
});
const restartableExpansion = Effect.fn('topicExpansion.restartable')(function* (
  config: RuntimeConfig,
  preview: TopicDependencyExpansionPreview,
) {
  const journal = yield* loadCandidateReviewOptional(config.agentContextHome, expansionReviewId(preview.revision));
  if (
    !journal?.dependencyExpansion ||
    journal.dependencyExpansion.preview.approvalDigest !== preview.approvalDigest ||
    !['preview', 'prepared', 'superseded'].includes(journal.dependencyExpansion.stage)
  )
    return yield* fail('Only an exact unwritten expansion reservation can be restarted.');
  if (
    journal.dependencyExpansion.stage !== 'superseded' &&
    (yield* Clock.currentTimeMillis) - Date.parse(journal.createdAt) <=
      CODE_GRAPH_CITATION_CAPSULE_RETENTION.maximumAgeMilliseconds
  )
    return yield* fail('The fixed reservation has not expired. Retry its existing approval.');
  const [current] = yield* readMemoryRecordsByUri(config, [preview.targetUri]);
  if (!current || canonicalMemoryDocumentContent(current.content) !== preview.beforeContent)
    return yield* fail('The topic changed or was already written. Its reservation cannot be restarted.');
  const baseline = parseMemoryDocument(preview.targetUri, preview.beforeContent)!;
  const fresh = yield* prepareExpansion(
    config,
    baseline,
    preview.callerCwd,
    preview.input,
    true,
    undefined,
    preview.operation,
  );
  if (fresh.approvalDigest !== preview.approvalDigest)
    return yield* fail('Source, graph, selection or configuration changed. Inspect a new preview.');
  return journal;
});
export const inspectTopicDependencyExpansionRecovery = Effect.fn('topicExpansion.recovery')(function* (
  config: RuntimeConfig,
  identity: {readonly revision: string; readonly approvalDigest: string},
) {
  const preview = yield* loadTopicDependencyExpansionPreview(config, identity);
  if (!preview || (preview.operation?.generation ?? 0) >= 8) return {canRestart: false};
  const result = yield* restartableExpansion(config, preview).pipe(Effect.result);
  return {canRestart: result._tag === 'Success'};
});
/** Explicitly supersede one expired unwritten approval. No evidence is captured; apply requires fresh approval. */
export const restartTopicDependencyExpansion = Effect.fn('topicExpansion.restart')(function* (
  config: RuntimeConfig,
  input: ExpansionApproval,
  interlock: {readonly afterSupersessionSaved?: () => Effect.Effect<void, unknown>} = {},
) {
  const preview = yield* exactExpansionApproval(config, input);
  const fs = yield* FileSystem.FileSystem;
  return yield* withExpansionReviewLocks(
    config,
    preview,
    withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [preview.targetUri],
      Effect.gen(function* () {
        yield* expansionPredecessor(config, preview);
        const prior = yield* restartableExpansion(config, preview);
        const previousSuccessor = prior.dependencyExpansion!.successor;
        const operation = previousSuccessor?.operation ?? {
          id: yield* (yield* Crypto.Crypto).randomUUIDv4(),
          generation: (preview.operation?.generation ?? 0) + 1,
          predecessorRevision: preview.revision,
          predecessorApprovalDigest: preview.approvalDigest,
        };
        const fresh = yield* checked(() => restartTopicDependencyExpansionPreview(preview, operation));
        const successor = previousSuccessor ?? {
          operation,
          revision: fresh.revision,
          approvalDigest: fresh.approvalDigest,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        // Persist the operation/time before provisioning its preview. Replays reproduce this exact successor.
        if (!previousSuccessor)
          yield* saveCandidateReview(config.agentContextHome, {
            ...prior,
            dependencyExpansion: {version: 1, stage: 'superseded', preview, successor},
          });
        yield* interlock.afterSupersessionSaved?.() ?? Effect.void;
        const existing = yield* loadCandidateReviewOptional(config.agentContextHome, expansionReviewId(fresh.revision));
        if (
          existing &&
          (existing.createdAt !== successor.createdAt ||
            existing.dependencyExpansion?.preview.approvalDigest !== fresh.approvalDigest)
        )
          return yield* fail('The successor review has a different reserved identity.');
        if (!existing)
          yield* saveCandidateReview(config.agentContextHome, expansionJournal(fresh, successor.createdAt, 'preview'));
        return {status: 'preview' as const, preview: fresh};
      }),
    ),
  );
});

/** One write-ahead intent, deterministic code identities, and the shared canonical writer close both crash windows. */
export interface TopicDependencyExpansionInterlock {
  /** @internal Deterministic crash/race barriers; never accepted from CLI/MCP/Manager input. */
  readonly afterIntentSaved?: () => Effect.Effect<void, unknown>;
  readonly afterEvidenceRetained?: () => Effect.Effect<void, unknown>;
  readonly afterCanonicalWrite?: () => Effect.Effect<void, unknown>;
}
export const applyTopicDependencyExpansion = Effect.fn('topicExpansion.apply')(function* (
  config: RuntimeConfig,
  input: {
    readonly preview: unknown;
    readonly revision: string;
    readonly approvalDigest: string;
    readonly approved: boolean;
  },
  interlock: TopicDependencyExpansionInterlock = {},
) {
  const preview = yield* exactExpansionApproval(config, input);
  const reviewId = expansionReviewId(preview.revision);
  const fs = yield* FileSystem.FileSystem;
  const result = yield* withExpansionReviewLocks(
    config,
    preview,
    withMemoryUriLocks(
      fs,
      config.agentContextHome,
      [preview.targetUri],
      Effect.gen(function* () {
        const existing = yield* loadCandidateReviewOptional(config.agentContextHome, reviewId);
        if (
          existing &&
          (!existing.dependencyExpansion ||
            existing.dependencyExpansion.preview.approvalDigest !== preview.approvalDigest)
        )
          return yield* fail('The reserved expansion journal has a different approved identity.');
        const predecessor = yield* expansionPredecessor(config, preview);
        if (existing?.dependencyExpansion?.stage === 'superseded')
          return yield* fail('This approval was superseded. Review and explicitly approve its fresh preview.');
        if (predecessor && existing && existing.createdAt !== predecessor.createdAt)
          return yield* fail('The successor reservation time differs from its recorded restart.');
        const [current] = yield* readMemoryRecordsByUri(config, [preview.targetUri]);
        if (!current) return yield* fail('The selected topic is unavailable.');
        const content = canonicalMemoryDocumentContent(current.content);
        if (content !== preview.beforeContent && content !== preview.content)
          return yield* fail('The topic changed after preview. No expansion was written.');
        if (content === preview.content && !existing)
          return yield* fail('Written expansion has no matching private approval receipt.');
        const baseline = parseMemoryDocument(preview.targetUri, preview.beforeContent)!;
        const sourceCheck = Effect.gen(function* () {
          const fresh = yield* prepareExpansion(
            config,
            baseline,
            preview.callerCwd,
            preview.input,
            true,
            undefined,
            preview.operation,
          );
          if (fresh.approvalDigest !== preview.approvalDigest)
            return yield* fail('Source, graph, selection or configuration changed after preview.');
        });
        let journal =
          existing ??
          expansionJournal(preview, predecessor?.createdAt ?? DateTime.formatIso(yield* DateTime.now), 'prepared');
        const conflict = () =>
          saveCandidateReview(config.agentContextHome, {
            ...journal,
            dependencyExpansion: {version: 1, stage: 'conflict', preview},
          });
        if (content === preview.content) {
          const checkedSource = yield* sourceCheck.pipe(Effect.result);
          if (checkedSource._tag === 'Failure') {
            yield* conflict();
            return yield* Effect.fail(checkedSource.failure);
          }
          if (journal.dependencyExpansion?.stage !== 'written')
            yield* saveCandidateReview(config.agentContextHome, {
              ...journal,
              dependencyExpansion: {version: 1, stage: 'written', preview},
            });
          return {
            status: 'already-expanded' as const,
            targetUri: preview.targetUri,
            reviewId,
            revision: preview.revision,
          };
        }
        if (existing?.dependencyExpansion?.stage === 'written' || existing?.dependencyExpansion?.stage === 'conflict')
          return yield* fail(
            'The expansion receipt conflicts with the current topic. Inspect and preview a new exact selection.',
          );
        yield* sourceCheck;
        if (!existing || existing.dependencyExpansion?.stage === 'preview') {
          journal = {...journal, dependencyExpansion: {version: 1, stage: 'prepared', preview}};
          yield* saveCandidateReview(config.agentContextHome, journal); // BEFORE any retained evidence write.
        }
        yield* interlock.afterIntentSaved?.() ?? Effect.void;
        const retained = yield* prepareExpansion(
          config,
          baseline,
          preview.callerCwd,
          preview.input,
          false,
          journal.createdAt,
          preview.operation,
        );
        if (retained.approvalDigest !== preview.approvalDigest)
          return yield* fail('Captured code identities differ from the approved reservation.');
        yield* interlock.afterEvidenceRetained?.() ?? Effect.void;
        yield* writeApprovedTopicDependencyExpansion(config, journal, sourceCheck);
        yield* interlock.afterCanonicalWrite?.() ?? Effect.void;
        const [written] = yield* readMemoryRecordsByUri(config, [preview.targetUri]);
        if (!written || canonicalMemoryDocumentContent(written.content) !== preview.content) {
          yield* conflict();
          return yield* fail('Canonical write readback differs from the approved expansion.');
        }
        const closing = yield* sourceCheck.pipe(Effect.result);
        if (closing._tag === 'Failure') {
          yield* conflict();
          return yield* fail(
            'The exact expansion was written, but source changed during closing verification. Its conflict receipt is retained.',
          );
        }
        journal = {...journal, dependencyExpansion: {version: 1, stage: 'written', preview}};
        yield* saveCandidateReview(config.agentContextHome, journal);
        return {status: 'expanded' as const, targetUri: preview.targetUri, reviewId, revision: preview.revision};
      }),
    ),
  ).pipe(
    Effect.onExit(() =>
      Effect.gen(function* () {
        const [stored] = yield* readMemoryRecordsByUri(config, [preview.targetUri]);
        if (stored && canonicalMemoryDocumentContent(stored.content) === preview.content)
          yield* refreshRecallDerivedIndexesAfterCanonicalMutation(config, [preview.targetUri]);
      }).pipe(Effect.ignore),
    ),
  );
  return result;
});
