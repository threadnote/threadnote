import {Array as EffectArray, DateTime, Effect, Schema} from 'effect';
import {
  isReadCleanupUnconfirmed,
  makeReadDeadline,
  ReadDeadlineExceeded,
  readDeadlineRemaining,
  withinReadDeadline,
  type ReadDeadline,
} from '@threadnote/platform/read_deadline';
import type {RecallEligibilityPolicy} from '@threadnote/recall/eligibility';
import {validateContextBriefMemoryCitations} from '@threadnote/context/citation_validation';
import {contextBriefMemoryUriScope} from '@threadnote/context/memory-evidence';
import {CONTEXT_BRIEF_MAXIMUM_CODE_REFS} from '@threadnote/context/types';
import {
  readNavigationEvidence,
  type NavigationMemoryReadV1,
  type NavigationReadEvidenceV1,
  type NavigationReadRequestV1,
} from '@threadnote/context/navigation/read';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {contextBriefMemoryEligibility, retrieveContextBriefCodeLinkedMemoryEvidence} from './memory_evidence.js';

/** The memory step ends this long after it starts, or earlier with the read; the semantic step comes after it. */
const NAVIGATION_MEMORY_MILLISECONDS = 750;
/** The memories one answer can carry. */
const NAVIGATION_MEMORY_CANDIDATES = 4;
/** Time the worker keeps after the memory step to reply inside its own deadline. */
const REPLY_RESERVE_MILLISECONDS = 250;

const unavailable = (gap: string): NavigationMemoryReadV1 => ({status: 'unavailable', gaps: [gap]});

/**
 * The structural read, then the code-linked memory of its route candidates in the same read. A follow-up reads no
 * memory. The native worker and the in-process fallback both call this function.
 */
export const readNavigationEvidenceWithMemory = Effect.fn('navigation.readEvidenceWithMemory')(function* (
  config: RuntimeConfig,
  request: NavigationReadRequestV1,
  deadline: ReadDeadline,
) {
  const evidence = yield* readNavigationEvidence(config, request, deadline);
  if (evidence.status !== 'ok' || request.followUp !== undefined) return evidence;
  return {...evidence, memory: yield* readNavigationMemory(config, request, evidence, deadline)};
});

/**
 * Read-only: the URI scope is explicit, so no recall maintenance is requested, and nothing is indexed or written.
 * Citations are validated against the navigation snapshot, so memory and route describe one graph generation.
 * Every failure except unconfirmed cleanup becomes a gap; the structural answer never depends on memory.
 */
const readNavigationMemory = Effect.fn('navigation.readMemory')(function* (
  config: RuntimeConfig,
  request: NavigationReadRequestV1,
  evidence: NavigationReadEvidenceV1,
  parent: ReadDeadline,
) {
  // The first route candidates, in answer order: the anchors come first.
  const codeRefs = EffectArray.take(
    EffectArray.map(evidence.input.candidates, candidate => candidate.id),
    CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
  );
  if (codeRefs.length === 0) return unavailable('navigation-memory-no-route-candidates');
  const deadline = yield* makeReadDeadline(
    Math.min(NAVIGATION_MEMORY_MILLISECONDS, yield* readDeadlineRemaining(parent, REPLY_RESERVE_MILLISECONDS)),
  );
  const scope = request.scope;
  const read = Effect.gen(function* () {
    const eligibility = yield* contextBriefMemoryEligibility(config, scope, request.task);
    const linked = yield* retrieveContextBriefCodeLinkedMemoryEvidence(
      config,
      {candidateLimit: NAVIGATION_MEMORY_CANDIDATES, codeRefs, query: request.task, scope},
      {allowedUriScopes: [contextBriefMemoryUriScope(config.user)], eligibility, planOnly: true},
    );
    const citationValidations = EffectArray.every(linked.candidates, candidate => candidate.codeCitations.length === 0)
      ? []
      : yield* validateContextBriefMemoryCitations(config, scope, linked.candidates, {
          kind: 'repository',
          repositoryId: evidence.observation.repository.repositoryId,
          snapshotId: evidence.observation.snapshot.id,
        });
    const memoryProjects = navigationMemoryProjects(eligibility.policy);
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    return {
      status: 'ok',
      memory: {...linked, citationValidations},
      ...(memoryProjects === undefined ? {} : {memoryProjects}),
      observedAt,
    } satisfies NavigationMemoryReadV1;
  });
  return yield* withinReadDeadline(deadline, read).pipe(
    Effect.catchIf(Schema.is(ReadDeadlineExceeded), () =>
      Effect.succeed(unavailable('navigation-memory-budget-exhausted')),
    ),
    Effect.catchIf(
      error => !isReadCleanupUnconfirmed(error),
      () => Effect.succeed(unavailable('navigation-memory-unavailable')),
    ),
  );
});

/** The project boundary the read applied, for the navigation selector in the parent. */
function navigationMemoryProjects(policy: RecallEligibilityPolicy) {
  return policy.kind === 'candidate-policy' && policy.projects.mode !== 'unrestricted' ? policy.projects : undefined;
}
