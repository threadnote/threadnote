import {Array as EffectArray, Effect, Path, String as EffectString} from 'effect';
import {canonicalFileUri, observationKey, type Evidence} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '@threadnote/graph/citation/source';
import {retrieveContextBriefSourceEvidence, type ContextBriefSourceEvidenceRequest} from './graph/source_evidence.js';
import {projectContextBriefAgentView} from './projector.js';
import type {ProjectedContextBriefV1, SemanticContextKnowledgeV1, SemanticContextSourceBindingV1} from './types.js';

/** Human-readable text is a presentation channel; compose from the validated structured evidence. */
export function projectSemanticContextKnowledge(
  projected: ProjectedContextBriefV1,
  binding: SemanticContextSourceBindingV1 | null,
): SemanticContextKnowledgeV1 {
  return binding === null
    ? {scope: 'document', binding: null, brief: null, gaps: ['semantic-graph-source-unbound']}
    : {scope: 'document', binding, brief: projectContextBriefAgentView(projected.structuredContent, true), gaps: []};
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
