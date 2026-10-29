import {Array as EffectArray} from 'effect';
import {DateTime, Effect, Option} from 'effect';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {MEMORY_SCHEMA_VERSION, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {sha256Hex} from '@threadnote/platform/digest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {stableJson, type WorkflowBinding, type WorkflowOperation} from './protocol.js';

// Retention is a capture-time diagnostic, not source evidence. Capsules can be
// evicted or become available independently of the immutable citation fields.
const citationEvidence = (citations: readonly MemoryCodeCitationV1[]) =>
  EffectArray.map(citations, citation => {
    const {evidenceRetention: _retention, ...evidence} = citation;
    return evidence;
  });

/**
 * Recognize only the existing native deferred-finalizer transition. The caller
 * holds its run/native mutation locks and persists the adopted operation and
 * manifest together before acknowledging recovery. This helper never writes.
 */
export const reconcileWorkflowCitationEnrichment = Effect.fn('workflowMemory.reconcileCitationEnrichment')(function* (
  config: RuntimeConfig,
  binding: WorkflowBinding,
  operation: WorkflowOperation,
  currentContent: string | undefined,
) {
  const deferred = operation.deferredCodeAnchor;
  if (
    !deferred ||
    currentContent === undefined ||
    currentContent === operation.desired ||
    !['create', 'replace'].includes(operation.request.action) ||
    deferred.callerCwd !== binding.repo ||
    deferred.project !== binding.project ||
    stableJson(deferred.codeRefs) !== stableJson(operation.request.codeRefs ?? [])
  )
    return undefined;
  const original = parseMemoryDocument(operation.artifact.canonicalUri, operation.desired);
  const current = parseMemoryDocument(operation.artifact.canonicalUri, currentContent);
  if (
    !original ||
    !current ||
    original.headerTitle !== current.headerTitle ||
    original.body !== current.body ||
    original.metadata.status !== 'active' ||
    original.metadata.memoryId !== operation.artifact.memoryId ||
    original.metadata.memoryId !== current.metadata.memoryId ||
    (original.metadata.codeCitations?.length ?? 0) !== 0 ||
    (original.metadata.citationErrors?.length ?? 0) > 0 ||
    (current.metadata.citationErrors?.length ?? 0) > 0 ||
    !current.metadata.codeCitations?.length
  )
    return undefined;
  const observedAt = current.metadata.sourceObservedAt;
  if (!observedAt) return undefined;
  const observedDate = DateTime.make(observedAt);
  if (Option.isNone(observedDate) || DateTime.formatIso(observedDate.value) !== observedAt) return undefined;
  const commits = [...new Set(EffectArray.map(current.metadata.codeCitations, citation => citation.sourceCommit))];
  const sourceCommit = commits.length === 1 ? commits[0] : undefined;
  const nativePostimage = formatMemoryDocument(
    original.headerTitle,
    {
      ...original.metadata,
      codeCitations: current.metadata.codeCitations,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      ...(sourceCommit === undefined ? {} : {sourceCommit}),
      sourceObservedAt: observedAt,
    },
    original.body,
  );
  // Exact reconstruction rejects unknown headers as well as changes to native
  // lifecycle, identity, relation, source, timestamp or body fields.
  if (nativePostimage !== currentContent) return undefined;
  const verified = yield* captureMemoryCodeCitations(config, {
    callerCwd: binding.repo,
    project: binding.project,
    omitUnresolved: true,
    refs: deferred.codeRefs,
    planOnly: true,
  });
  if (stableJson(citationEvidence(verified)) !== stableJson(citationEvidence(current.metadata.codeCitations)))
    return undefined;
  return {
    ...operation,
    desired: currentContent,
    artifact: {
      ...operation.artifact,
      revision: yield* sha256Hex(currentContent),
    },
  } satisfies WorkflowOperation;
});
