import {Array as EffectArray, type Effect} from 'effect';
import * as EffectString from 'effect/String';
import type {CodeGraphQueryNode, CodeGraphQueryResult, CodeGraphSpan} from '@threadnote/graph/types';
import type {ContextBriefSourceExcerptV1} from '../types.js';
import {assembleNavigationAnswer} from './assemble.js';
import {
  NAVIGATION_INPUT_LIMITS,
  type NavigationCandidate,
  type NavigationInput,
  type NavigationScope,
} from './model.js';
import {navigationProofSpansInspected, type retrieveNavigationSourceProofs} from './source_facts.js';

type AcquiredSourceProofs = Effect.Success<ReturnType<typeof retrieveNavigationSourceProofs>>;
export interface NavigationSourceProofs {
  readonly facts: Pick<AcquiredSourceProofs['facts'], 'observation' | 'files'>;
  readonly source: AcquiredSourceProofs['source'];
  readonly proofs: AcquiredSourceProofs['proofs'];
  readonly gaps: AcquiredSourceProofs['gaps'];
}
export interface StructuralNavigationRequest {
  /** Already admitted bounded graph result, never a query or acquisition callback. */
  readonly result: CodeGraphQueryResult;
  readonly acquired: NavigationSourceProofs;
  readonly scope: NavigationScope;
  readonly target: NavigationInput['target'];
}
export interface NavigationProofLocator {
  readonly scope: NavigationScope;
  readonly snapshot: CodeGraphQueryResult['snapshot'];
  readonly sourceId: string;
  readonly accepted: NavigationSourceProofs['proofs'][number];
  readonly target: string;
  /** Explicit polarity avoids interpreting or simplifying the source condition. */
  readonly condition: string;
}

/** Pure projection of one acquired observation. The NAV01 assembler owns route traversal and admission. */
export function assembleStructuralNavigationAnswer(request: StructuralNavigationRequest) {
  const {input, proofLocators} = structuralNavigationInput(request);
  return {input, answer: assembleNavigationAnswer(input), proofLocators, source: request.acquired.source};
}

export function structuralNavigationInput(request: StructuralNavigationRequest): {
  readonly input: NavigationInput;
  readonly proofLocators: readonly NavigationProofLocator[];
} {
  const {result, acquired, scope, target} = request;
  // Refuse before enumeration; the adapter never expands the acquisition's finite caps.
  if (
    result.nodes.length > NAVIGATION_INPUT_LIMITS.candidates ||
    result.edges.length > NAVIGATION_INPUT_LIMITS.links ||
    acquired.proofs.length > 96 ||
    acquired.source.excerpts.length > 6 ||
    acquired.facts.files.length > 3
  )
    throw new RangeError('Structural navigation exceeds acquisition limits.');
  const gaps = new Set(acquired.gaps);
  const observation = acquired.facts.observation;
  const compatible =
    scope.repository === result.repository.repositoryId &&
    scope.worktree === result.snapshot.worktreeId &&
    scope.view.kind === 'disk' &&
    observation.repository.repositoryId === result.repository.repositoryId &&
    observation.snapshot.id === result.snapshot.id &&
    observation.snapshot.worktreeId === result.snapshot.worktreeId &&
    observation.snapshot.commit === result.snapshot.commit &&
    observation.snapshot.dirty === result.snapshot.dirty &&
    observation.freshness === result.freshness;
  if (!compatible) gaps.add('navigation-source-observation-conflict');
  for (const limit of result.searchCoverage?.limitsReached ?? []) gaps.add(`graph-search-${limit}`);
  if (result.outsideProjectGraph) gaps.add('outside-project-graph');
  // Module containment does not make every declaration in a file part of a behavioral route.
  const symbols = compatible ? EffectArray.filter(result.nodes, node => node.kind !== 'module') : [];
  const byId = new Map(EffectArray.map(symbols, node => [node.id, node] as const));
  const sourceId = (node: CodeGraphQueryNode) => JSON.stringify([node.path, node.contentHash]);
  const sources = new Map<string, NavigationInput['sources'][number]>();
  for (const node of symbols) {
    const inspected =
      sources.get(sourceId(node))?.freshness === 'verified-current' ||
      EffectArray.some(
        acquired.source.excerpts,
        excerpt => excerpt.path === node.path && excerpt.coveredGraphRefs.includes(node.id),
      );
    sources.set(sourceId(node), {
      ...scope,
      id: sourceId(node),
      path: node.path,
      contentHash: node.contentHash,
      snapshot: result.snapshot.id,
      freshness:
        result.freshness === 'stale'
          ? 'stale'
          : result.freshness === 'deferred'
            ? 'deferred'
            : inspected
              ? 'verified-current'
              : 'unverified',
    });
  }
  const proofLocators: NavigationProofLocator[] = [];
  for (const accepted of compatible && result.freshness === 'current' ? acquired.proofs : []) {
    const owner = byId.get(accepted.proof.ownerId);
    if (
      !owner ||
      owner.path !== accepted.path ||
      owner.contentHash !== accepted.contentHash ||
      !sameSpan(owner.span, accepted.proof.ownerSpan)
    ) {
      gaps.add('navigation-proof-owner-conflict');
      continue;
    }
    const excerpts = EffectArray.filter(acquired.source.excerpts, excerpt => excerpt.path === accepted.path);
    const targetText = inspectedSpan(excerpts, accepted.proof.targetSpan);
    const guardText = inspectedSpan(excerpts, accepted.proof.guard.span);
    if (!navigationProofSpansInspected(accepted.proof, excerpts) || !targetText || !guardText) {
      gaps.add('navigation-proof-source-incomplete');
      continue;
    }
    proofLocators.push({
      scope,
      snapshot: result.snapshot,
      sourceId: sourceId(owner),
      accepted,
      target: targetText,
      condition: `${accepted.proof.guard.branch} branch of (${guardText})`,
    });
  }
  const edges = EffectArray.filter(
    result.edges,
    edge =>
      edge.sourceId !== undefined &&
      edge.targetId !== undefined &&
      byId.has(edge.sourceId) &&
      byId.has(edge.targetId) &&
      edge.provenance !== 'heuristic' &&
      edge.provenance !== 'model' &&
      (edge.relation === 'calls' || edge.relation === 'contains'),
  );
  const focus = new Set([
    ...(target.kind === 'task' ? [] : target.candidateIds),
    ...EffectArray.map(proofLocators, locator => locator.accepted.proof.ownerId),
  ]);
  const candidates: NavigationCandidate[] = EffectArray.map(symbols, node => {
    const testFile = isTestPath(node.path);
    const testFunction = testFile && (node.kind === 'function' || node.kind === 'method' || node.arity !== undefined);
    const direct = EffectArray.some(
      edges,
      edge => edge.relation === 'calls' && edge.sourceId === node.id && !isTestPath(byId.get(edge.targetId!)!.path),
    );
    const containedCall = EffectArray.some(
      edges,
      edge =>
        edge.relation === 'contains' &&
        edge.sourceId === node.id &&
        EffectArray.some(
          edges,
          call =>
            call.relation === 'calls' && call.sourceId === edge.targetId && !isTestPath(byId.get(call.targetId!)!.path),
        ),
    );
    const relatedTest = testFunction && (direct || containedCall);
    const incomingRoute =
      !testFile &&
      !focus.has(node.id) &&
      EffectArray.some(
        edges,
        edge => edge.relation === 'calls' && edge.sourceId === node.id && focus.has(edge.targetId!),
      );
    const writes = EffectArray.filter(proofLocators, locator => locator.accepted.proof.ownerId === node.id);
    const inspected = inspectedSpan(
      EffectArray.filter(acquired.source.excerpts, excerpt => excerpt.path === node.path),
      node.span,
    );
    return {
      id: node.id,
      sourceId: sourceId(node),
      startLine: node.span.line,
      endLine: node.span.endLine,
      roles: testFunction
        ? ['tests']
        : incomingRoute
          ? ['entrypoint']
          : writes.length
            ? ['implementation', 'effects']
            : ['implementation'],
      reason: relatedTest
        ? 'Test source has a structural call route to implementation; execution and assertion outcomes are unknown.'
        : testFunction
          ? 'Test-file declaration is only a candidate; no behavioral call association is established.'
          : incomingRoute
            ? 'Incoming structural caller of the target implementation; runtime invocation is unknown.'
            : writes.length
              ? 'Implementation contains inspected conditional possible durable write call sites; paired details are retained in source proofs.'
              : 'Structural implementation location in the bounded graph.',
      relevance: node.score,
      basis: inspected || writes.length ? ['structural', 'inspected-source'] : ['structural'],
      support: testFunction && !relatedTest ? 'candidate' : 'evidenced',
      ...(testFunction ? {testAssociation: relatedTest ? ('source-supported' as const) : ('name-only' as const)} : {}),
      ...(writes.length === 1
        ? {possibleEffect: {kind: 'durable-write' as const, target: writes[0].target, condition: writes[0].condition}}
        : {}),
    };
  });
  if (EffectArray.some(acquired.facts.files, file => file.facts?.omitted === true))
    gaps.add('navigation-facts-omitted');
  return {
    proofLocators,
    input: {
      scope,
      target,
      candidates,
      sources: [...sources.values()],
      links: EffectArray.map(edges, edge => ({
        from: edge.sourceId!,
        to: edge.targetId!,
        relation: edge.relation,
        basis: 'structural',
        compatibility: 'verified',
        reason: `Structural ${edge.relation} relation (${edge.provenance}); no runtime execution claim.`,
      })),
      coverage: {
        status: result.searchCoverage?.status === 'timed-out' ? 'timeout' : symbols.length === 0 ? 'empty' : 'partial',
        description:
          'Bounded structural graph and one inspected source batch; no repository-wide completeness or test execution claim.',
      },
      roleGaps: EffectArray.map(['entrypoint', 'implementation', 'effects', 'tests'] as const, role => ({
        role,
        status: 'unknown',
        reason: 'No supported role in the acquired bounded observation; absence proves no negative behavior.',
      })),
      gaps: [...gaps].sort(),
    },
  };
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)__tests__\/|(?:^|\/)tests?\/|\.(?:test|spec)\.[^/]+$/u.test(path);
}
function sameSpan(left: CodeGraphSpan, right: CodeGraphSpan): boolean {
  return (
    left.line === right.line &&
    left.endLine === right.endLine &&
    left.column === right.column &&
    left.endColumn === right.endColumn
  );
}
/** Slice accepted source coordinates only: one-based UTF-16, exclusive end, no parser or name inference. */
function inspectedSpan(excerpts: readonly ContextBriefSourceExcerptV1[], span: CodeGraphSpan): string | undefined {
  for (const excerpt of excerpts) {
    if (span.line < excerpt.startLine || span.endLine > excerpt.endLine) continue;
    const lines = EffectString.split('\n')(excerpt.content);
    const first = span.line - excerpt.startLine;
    const last = span.endLine - excerpt.startLine;
    if (
      !lines[first] ||
      lines[last] === undefined ||
      span.column > lines[first].length + 1 ||
      span.endColumn > lines[last].length + 1
    )
      continue;
    return EffectArray.join(
      EffectArray.map(lines.slice(first, last + 1), (line, index) =>
        EffectString.slice(
          index === 0 ? span.column - 1 : 0,
          index === last - first ? span.endColumn - 1 : line.length,
        )(line),
      ),
      '\n',
    );
  }
  return undefined;
}
