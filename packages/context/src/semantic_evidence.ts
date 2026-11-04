import {Array as EffectArray, Effect, Path, String as EffectString} from 'effect';
import {canonicalFileUri, observationKey, type Evidence} from '@threadnote/semantic/contracts';
import * as SqlClient from 'effect/sql/SqlClient';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {withCodeGraphDeferredTransaction} from '@threadnote/graph/store/session';
import {createCodeGraphSourceSpanCanonicalizer} from '@threadnote/graph/citation/primitives';
import type {CodeGraphQueryNode} from '@threadnote/graph/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '@threadnote/graph/citation/source';
import {retrieveContextBriefSourceEvidence, type ContextBriefSourceEvidenceRequest} from './graph/source_evidence.js';
import {projectContextBriefAgentView} from './projector.js';
import type {
  ProjectedContextBriefV1,
  SemanticContextKnowledgeV1,
  SemanticContextSourceBindingV1,
  SemanticContextSymbolTarget,
  ContextBriefMemoryRetrievalV1,
} from './types.js';

/** Human-readable text is a presentation channel; compose from the validated structured evidence. */
export function projectSemanticContextKnowledge(
  projected: ProjectedContextBriefV1,
  binding: SemanticContextSourceBindingV1 | null,
): SemanticContextKnowledgeV1 {
  return binding === null
    ? {scope: 'document', binding: null, brief: null, gaps: ['semantic-graph-source-unbound']}
    : {scope: 'document', binding, brief: projectContextBriefAgentView(projected.structuredContent, true), gaps: []};
}

/** Preserve complete validated guidance before optional graph detail or follow-up actions. */
export function compactSemanticContextKnowledge(
  knowledge: SemanticContextKnowledgeV1,
  options: {readonly omitFollowUps?: boolean} = {},
): SemanticContextKnowledgeV1 {
  const brief = knowledge.brief;
  const graph = brief?.graph;
  const omitGraph =
    graph !== undefined &&
    ((graph.cards?.length ?? 0) > 0 ||
      (graph.contracts?.length ?? 0) > 0 ||
      (graph.sources?.length ?? 0) > 0 ||
      graph.continuation !== undefined);
  const followUps = options.omitFollowUps ? brief?.recommendedFollowUps : undefined;
  const omitFollowUps = (followUps?.length ?? 0) > 0;
  if (
    !brief ||
    ((brief.activeHandoffs?.length ?? 0) === 0 && (brief.durableDecisions?.length ?? 0) === 0) ||
    (!omitGraph && !omitFollowUps)
  )
    return knowledge;
  const {answer: _answer, ...withoutDerivedAnswer} = brief;
  const omissions = brief.output?.omissions;
  return {
    ...knowledge,
    brief: {
      ...withoutDerivedAnswer,
      // These omitted optional bundles are counted below, not reported as absent evidence.
      ...(omitGraph ? {graph: {}} : {}),
      ...(omitFollowUps ? {recommendedFollowUps: []} : {}),
      evidenceState: brief.evidenceState === 'sufficient' ? 'partial' : brief.evidenceState,
      output: {
        truncated: true,
        omissions: {
          ...omissions,
          ...(omitGraph
            ? {
                graphCards: (omissions?.graphCards ?? 0) + (graph?.cards?.length ?? 0),
                graphContracts: (omissions?.graphContracts ?? 0) + (graph?.contracts?.length ?? 0),
                sourceExcerpts: (omissions?.sourceExcerpts ?? 0) + (graph?.sources?.length ?? 0),
              }
            : {}),
          ...(omitFollowUps
            ? {recommendedFollowUps: (omissions?.recommendedFollowUps ?? 0) + (followUps?.length ?? 0)}
            : {}),
        },
      },
    },
    gaps: [...new Set([...knowledge.gaps, 'knowledge-output-budget-exhausted'])],
  };
}

/** Bind a document, without treating graph edges or memory as compiler facts. No commit fallback is permitted. */
export const retrieveSemanticContextSourceEvidence = Effect.fn('context.semanticSourceEvidence')(function* (
  request: ContextBriefSourceEvidenceRequest,
  evidence: Evidence,
) {
  const path = yield* Path.Path;
  const observed = evidence.observation;
  const worktree = canonicalFileUri((yield* path.toFileUrl(request.identity.repoRoot)).href);
  const target = yield* path.fromFileUrl(new URL(observed.uri));
  const project = yield* path.fromFileUrl(new URL(observed.project));
  const relative = EffectArray.join(
    EffectString.split(path.sep)(path.relative(request.identity.repoRoot, target)),
    '/',
  );
  const nodes = EffectArray.filter(request.result.nodes, node => node.path === relative);
  const hashes = [...new Set(EffectArray.map(nodes, node => node.contentHash))];
  let binding: SemanticContextSourceBindingV1 | null = null;
  if (
    evidence.basis === 'semantic' &&
    observed.view.kind === 'disk' &&
    observed.worktree === worktree &&
    request.result.repository.repositoryId === request.identity.repositoryId &&
    request.result.snapshot.worktreeId === request.identity.worktreeId &&
    request.result.snapshot.commit === request.identity.headCommit &&
    request.result.freshness === 'current' &&
    (project === request.identity.repoRoot || EffectString.startsWith(request.identity.repoRoot + path.sep)(project)) &&
    EffectString.startsWith(project + path.sep)(target) &&
    hashes.length === 1 &&
    relative !== '' &&
    !EffectString.startsWith('../')(relative) &&
    !path.isAbsolute(relative)
  ) {
    const source = {repositoryPath: relative, expectedContentHash: hashes[0], requireBytes: true};
    const resolved = yield* readCodeGraphCitationSources({
      allowCommitFallback: false,
      objectFormat: request.identity.objectFormat,
      repositoryRoot: request.identity.repoRoot,
      sourceCommit: request.result.snapshot.commit,
      retainedBytesLimit: 4 * 1024 * 1024,
      sources: [source],
    });
    const bytes = resolved.get(codeGraphCitationSourceKey(source));
    if (bytes !== undefined && sha256HexSync(bytes) === observed.content) {
      binding = {
        version: 1,
        scope: 'document',
        observation: sha256HexSync(observationKey(observed)),
        semanticContent: observed.content,
        graph: {
          repositoryId: request.identity.repositoryId,
          snapshotId: request.result.snapshot.id,
          path: relative,
          contentHash: hashes[0],
        },
      };
    }
  }
  return {
    binding,
    source:
      binding === null
        ? {excerpts: [], gaps: ['semantic-graph-source-unbound']}
        : yield* retrieveContextBriefSourceEvidence(request),
  };
});

/** @internal Only complete effective-path SQL rows may enter this exact-range join. */
export function selectSemanticContextSymbol(
  bytes: Uint8Array,
  evidence: Evidence,
  target: SemanticContextSymbolTarget,
  nodes: readonly CodeGraphQueryNode[],
  binding: SemanticContextSourceBindingV1,
): {readonly nodeId: string | null; readonly gap?: string} {
  const fail = (gap: string) => ({nodeId: null, gap});
  if (
    target.evidence.basis !== 'semantic' ||
    evidence.basis !== 'semantic' ||
    observationKey(target.evidence.observation) !== observationKey(evidence.observation) ||
    binding.observation !== sha256HexSync(observationKey(evidence.observation)) ||
    target.uri !== evidence.observation.uri ||
    sha256HexSync(bytes) !== evidence.observation.content
  )
    return fail('semantic-symbol-observation-unbound');
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {
    return fail('semantic-symbol-range-invalid');
  }
  if (/[\u2028\u2029]/u.test(text)) return fail('semantic-symbol-line-separator-unsupported');
  const span = (range: SemanticContextSymbolTarget['range']) => ({
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  });
  const canonicalizer = createCodeGraphSourceSpanCanonicalizer(text);
  const full = canonicalizer.fragment(span(target.range));
  const selection = canonicalizer.fragment(span(target.selectionRange ?? target.range));
  if (
    !full.ok ||
    !selection.ok ||
    full.fragment.startOffset === full.fragment.endOffset ||
    selection.fragment.startOffset < full.fragment.startOffset ||
    selection.fragment.endOffset > full.fragment.endOffset
  )
    return fail('semantic-symbol-range-invalid');
  // selectSymbolsByPaths has exactly one ROW_NUMBER <= min(500, limit) bound
  // after the effective current/base UNION (override/deletion handling), and no
  // later filtering. For one requested path, <500 proves that SQL set exhausted;
  // at 500 it cannot prove exhaustion and must abstain. This is not valid for
  // task-search, traversal cards or a caller-truncated node list.
  if (nodes.length >= 500) return fail('semantic-symbol-lookup-incomplete');
  if (
    EffectArray.some(nodes, node => node.path !== binding.graph.path || node.contentHash !== binding.graph.contentHash)
  )
    return fail('semantic-symbol-source-unbound');
  if (EffectArray.some(nodes, node => !canonicalizer.fragment(node.span).ok))
    return fail('semantic-symbol-lookup-incomplete');
  const matches = EffectArray.filter(nodes, node => {
    const fragment = canonicalizer.fragment(node.span);
    return (
      fragment.ok &&
      fragment.fragment.startOffset === full.fragment.startOffset &&
      fragment.fragment.endOffset === full.fragment.endOffset
    );
  });
  if (matches.length !== 1)
    return fail(matches.length > 1 ? 'semantic-symbol-target-ambiguous' : 'semantic-symbol-target-unresolved');
  return /^cgs_[0-9a-f]{32}$/u.test(matches[0].id)
    ? {nodeId: matches[0].id}
    : fail('semantic-symbol-target-unresolved');
}

/** Join only the exact current same-document definition; never a lexical container. */
export const retrieveSemanticContextSymbol = Effect.fn('context.semanticSymbol')(function* (
  config: RuntimeConfig,
  request: ContextBriefSourceEvidenceRequest,
  evidence: Evidence,
  target: SemanticContextSymbolTarget | null,
  binding: SemanticContextSourceBindingV1 | null,
) {
  if (!binding || !target) return {nodeId: null, gap: 'semantic-symbol-target-unavailable'} as const;
  const query = yield* CodeGraphQueryService;
  const store = yield* CodeGraphStore;
  const status = yield* query.status(config.agentContextHome, request.identity.repoRoot, {
    manifestPath: config.manifestPath,
    requestMaintenance: false,
  });
  if (
    status.freshness !== 'current' ||
    status.stale ||
    status.identity.repositoryId !== request.identity.repositoryId ||
    status.identity.worktreeId !== request.identity.worktreeId ||
    status.readySnapshot?.id !== binding.graph.snapshotId
  )
    return {nodeId: null, gap: 'semantic-symbol-snapshot-unbound'} as const;
  const source = {
    repositoryPath: binding.graph.path,
    expectedContentHash: binding.graph.contentHash,
    requireBytes: true,
  };
  const resolved = yield* readCodeGraphCitationSources({
    allowCommitFallback: false,
    objectFormat: request.identity.objectFormat,
    repositoryRoot: request.identity.repoRoot,
    sourceCommit: request.result.snapshot.commit,
    retainedBytesLimit: 4 * 1024 * 1024,
    sources: [source],
  });
  const bytes = resolved.get(codeGraphCitationSourceKey(source));
  if (!bytes) return {nodeId: null, gap: 'semantic-symbol-source-unbound'} as const;
  const groups = yield* store.withSession(
    status.databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Existing-only sessions use a writable client fenced by query_only. Its
      // default BEGIN IMMEDIATE would request a forbidden write transaction.
      // Keep base identity and effective rows in one deferred read view.
      return yield* withCodeGraphDeferredTransaction(
        sql,
        store.searchSymbolsByPaths(status.databasePath, binding.graph.snapshotId, [binding.graph.path], 500),
      );
    }),
    {existingOnly: true, readOnly: true},
  );
  const closing = yield* query.status(config.agentContextHome, request.identity.repoRoot, {
    manifestPath: config.manifestPath,
    requestMaintenance: false,
  });
  if (
    closing.freshness !== 'current' ||
    closing.stale ||
    closing.identity.repositoryId !== request.identity.repositoryId ||
    closing.identity.worktreeId !== request.identity.worktreeId ||
    closing.readySnapshot?.id !== binding.graph.snapshotId
  )
    return {nodeId: null, gap: 'semantic-symbol-snapshot-unbound'} as const;
  if (groups.length !== 1) return {nodeId: null, gap: 'semantic-symbol-lookup-incomplete'} as const;
  return selectSemanticContextSymbol(bytes, evidence, target, groups[0], binding);
});

/** Bound canonical citation kinds keep true file constraints without admitting other symbols. */
export function filterSemanticContextMemory(
  memory: ContextBriefMemoryRetrievalV1,
  nodeId: string,
  graph: SemanticContextSourceBindingV1['graph'],
  repositoryIdentityKind: 'local' | 'remote',
): ContextBriefMemoryRetrievalV1 {
  const candidates = EffectArray.flatMap(memory.candidates, candidate => {
    const matches = EffectArray.filter(
      candidate.codeLinkMatches ?? [],
      match =>
        match.anchorNodeId === nodeId &&
        match.anchorPath === graph.path &&
        EffectArray.some(
          candidate.codeCitations,
          citation =>
            citation.id === match.citationId &&
            citation.path === graph.path &&
            citation.repositoryId === graph.repositoryId &&
            citation.repositoryIdentityKind === repositoryIdentityKind &&
            (citation.target.kind === 'file' || citation.target.nodeId === nodeId),
        ),
    );
    return matches.length === 0 ? [] : [{...candidate, codeLinkMatches: matches}];
  });
  return {
    ...memory,
    candidates,
    ...(memory.codeAnchorCoverage
      ? {
          codeAnchorCoverage: {...memory.codeAnchorCoverage, matchedMemories: candidates.length},
        }
      : {}),
    // The existing recall API has bounded shared selector lanes. Filtering cannot
    // prove that an applicable file citation was not crowded out by other symbols.
    gaps: [
      ...new Set([
        ...EffectArray.filter(memory.gaps, gap => gap !== 'code-anchor-recall-no-active-memory'),
        'semantic-symbol-memory-coverage-incomplete',
      ]),
    ],
  };
}
