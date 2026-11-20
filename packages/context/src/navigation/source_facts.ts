import * as EffectString from 'effect/String';
import {Array as EffectArray, Effect} from 'effect';
import {readDeadlineRemaining, withinReadDeadline, type ReadDeadline} from '@threadnote/platform/read_deadline';
import {readCodeGraphNavigationFacts, type NavigationFactSelector} from '@threadnote/graph/query/navigation_facts';
import type {
  CodeGraphNavigationProof,
  CodeGraphQueryResult,
  CodeGraphSpan,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {retrieveContextBriefSourceEvidence, type ContextBriefSourceRangeCandidateV1} from '../graph/source_evidence.js';
import type {ContextBriefSourceExcerptV1} from '../types.js';
interface NavigationSourceProofInput {
  readonly databasePath: string;
  readonly result: CodeGraphQueryResult;
  readonly selectors: readonly NavigationFactSelector[];
  readonly identity: RepositoryIdentity;
  readonly repositoryKey: string;
  readonly maximumContentBytes: number;
  readonly acquireRead: Effect.Effect<boolean>;
  readonly deadline?: ReadDeadline;
}

/**
 * The caller owns admission across graph reads, both fact stages, and this single
 * source batch. Supply its existing absolute deadline; no allowance is created
 * here. Expiry fails with ReadDeadlineExceeded and interruption propagates, so an
 * optional enrichment caller can retain its already acquired structural route.
 * Synchronous native reads cannot be preempted by this orchestration boundary.
 */
export const retrieveNavigationSourceProofs = Effect.fn('navigation.retrieveSourceProofs')(function* (
  input: NavigationSourceProofInput,
) {
  const deadline = input.deadline;
  if (deadline === undefined) return yield* retrieveNavigationSourceProofsWithinBudget(input);
  const acquireRead = Effect.gen(function* () {
    if ((yield* readDeadlineRemaining(deadline)) <= 0) return false;
    const admitted = yield* input.acquireRead;
    return admitted && (yield* readDeadlineRemaining(deadline)) > 0;
  });
  return yield* withinReadDeadline(deadline, retrieveNavigationSourceProofsWithinBudget({...input, acquireRead}));
});

const retrieveNavigationSourceProofsWithinBudget = Effect.fn('navigation.retrieveSourceProofsWithinBudget')(function* (
  input: NavigationSourceProofInput,
) {
  if (
    input.identity.repositoryId !== input.result.repository.repositoryId ||
    input.identity.worktreeId !== input.result.snapshot.worktreeId
  ) {
    const gaps = ['navigation-source-observation-conflict'];
    return {
      facts: {
        observation: {
          repository: input.result.repository,
          snapshot: input.result.snapshot,
          freshness: input.result.freshness,
        },
        files: [],
        gaps,
        counters: {
          metadataReads: 0,
          payloadReads: 0,
          payloadRows: 0,
          storedBytes: 0,
          declaredRawBytes: 0,
          decodedBytes: 0,
        },
      },
      source: {excerpts: [], gaps},
      proofs: [],
      gaps,
    };
  }
  const facts = yield* readCodeGraphNavigationFacts(input);
  const admissionGaps = [
    ...facts.gaps,
    ...EffectArray.flatMap(facts.files, file => (file.gap === 'navigation-read-budget-exhausted' ? [file.gap] : [])),
  ];
  if (admissionGaps.length > 0)
    return {facts, source: {excerpts: [], gaps: admissionGaps}, proofs: [], gaps: admissionGaps};
  const additionalRanges: ContextBriefSourceRangeCandidateV1[] = [];
  for (const file of facts.files) {
    for (const proof of file.facts?.proofs ?? []) {
      for (const span of [proof.importSpan, proof.ownerSpan])
        additionalRanges.push({
          path: file.path,
          contentHash: file.contentHash,
          startLine: span.line,
          endLine: span.endLine,
          rank: 0,
          coveredGraphRefs: [proof.ownerId],
        });
    }
  }
  if (!(yield* input.acquireRead))
    return {
      facts,
      source: {excerpts: [], gaps: ['navigation-read-budget-exhausted']},
      proofs: [],
      gaps: ['navigation-read-budget-exhausted'],
    };
  const source = yield* retrieveContextBriefSourceEvidence({...input, additionalRanges});
  const proofs = EffectArray.flatMap(facts.files, file =>
    EffectArray.flatMap(file.facts?.proofs ?? [], proof => {
      const inspected = navigationProofSpansInspected(
        proof,
        EffectArray.filter(source.excerpts, excerpt => excerpt.path === file.path),
      );
      return inspected &&
        input.identity.repositoryId === facts.observation.repository.repositoryId &&
        input.identity.worktreeId === facts.observation.snapshot.worktreeId
        ? [{path: file.path, contentHash: file.contentHash, proof, basis: 'source-syntactic' as const}]
        : [];
    }),
  );
  const gaps = [
    ...new Set([
      ...facts.gaps,
      ...EffectArray.flatMap(facts.files, file => (file.gap === undefined ? [] : [file.gap])),
      ...source.gaps,
      ...(proofs.length ===
      EffectArray.reduce(facts.files, 0, (count, file) => count + (file.facts?.proofs.length ?? 0))
        ? []
        : ['navigation-proof-source-incomplete']),
    ]),
  ];
  return {facts, source, proofs, gaps};
});
export function navigationProofSpansInspected(
  proof: CodeGraphNavigationProof,
  excerpts: readonly ContextBriefSourceExcerptV1[],
): boolean {
  return EffectArray.every(
    [proof.importSpan, proof.callSpan, proof.calleeSpan, proof.targetSpan, proof.guard.span],
    span => EffectArray.some(excerpts, excerpt => containsSpan(excerpt, span)),
  );
}
function containsSpan(excerpt: ContextBriefSourceExcerptV1, span: CodeGraphSpan): boolean {
  if (span.line < excerpt.startLine || span.endLine > excerpt.endLine) return false;
  const lines = EffectString.split('\n')(excerpt.content);
  const first = lines[span.line - excerpt.startLine];
  const last = lines[span.endLine - excerpt.startLine];
  return (
    first !== undefined && last !== undefined && span.column <= first.length + 1 && span.endColumn <= last.length + 1
  );
}
