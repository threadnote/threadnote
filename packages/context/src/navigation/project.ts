import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import {
  AgentResponseBudgetTooSmallError,
  AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN,
} from '@threadnote/protocol/agent-response';
import type {CodeGraphSpan} from '@threadnote/graph/types';
import {NAVIGATION_PROJECTION_LANES} from '../projection_lanes.js';
import {compactProjectedMemory} from '../projector/compaction.js';
import {projectAgentViewMemory} from '../projection_view.js';
import {
  type ProjectionItem,
  laneStableOptionalProjectionItems,
  projectionOmissionCount,
  renderProjectionChannels,
  selectedProjectionIds,
  selectProjectionDictionary,
  selectFiniteProjection,
  uniqueProjectionItems,
} from '../projector/selection.js';
import type {ContextBriefLogicalMemoryEvidenceV1} from '../types.js';
import {type NavigationAcquisition, type NavigationAnswerV1, type NavigationScope} from './model.js';
import type {assembleStructuralNavigationAnswer, NavigationProofLocator} from './structural.js';
type Item = ProjectionItem<(typeof NAVIGATION_PROJECTION_LANES)[number]>;
/** The row dictionaries retain exact locators and evidence qualifiers without repeating scope. */
type NodeRow = readonly [
  id: string,
  source: number,
  start: number,
  end: number,
  support: string,
  basis: readonly string[],
  freshness: string,
];
type SourceRow = readonly [path: string, hash: string, freshness: string, snapshot?: string, scope?: NavigationScope];
type RoleRow = readonly [
  role: string,
  status: string,
  nodes: readonly number[],
  candidates: readonly number[],
  proof?: readonly [source: number, start: number, end: number],
];
type ProofRow = readonly [
  owner: number,
  target: string,
  condition: string,
  call: SpanRow,
  targetSpan: SpanRow,
  guard: SpanRow,
  branch: 'then' | 'else',
  callEdgeId: string,
];
type SpanRow = readonly [line: number, column: number, endLine: number, endColumn: number];
export interface NavigationProjection {
  readonly version: 1;
  readonly scope: NavigationScope;
  readonly target: NavigationAnswerV1['target'];
  readonly outcome: NavigationAnswerV1['outcome'];
  readonly coverage: NavigationAnswerV1['coverage']['status'];
  readonly nodes: readonly NodeRow[];
  readonly sources: readonly SourceRow[];
  readonly roles: readonly RoleRow[];
  readonly links: readonly (readonly [
    from: number,
    to: number,
    relation: string,
    basis: string,
    compatibility: string,
  ])[];
  readonly effects: readonly ProofRow[];
  readonly possibleEffects: readonly (readonly [owner: number, kind: string, target: string, condition?: string])[];
  readonly gaps: readonly string[];
  readonly warnings: readonly string[];
  readonly omissions: Readonly<Record<string, number>>;
  readonly followUps: readonly NavigationAcquisition[];
  readonly memory: readonly ReturnType<typeof projectAgentViewMemory>[];
}
/** Pure policy and rendering only. The caller owns all acquisition and proof admission. */
export function projectNavigationAnswer(
  input: Pick<ReturnType<typeof assembleStructuralNavigationAnswer>, 'answer' | 'proofLocators'>,
  maximumEstimatedTokens = 1250,
  responseFormat: 'agent' | 'dual' = 'agent',
  reviewedMemory: readonly ContextBriefLogicalMemoryEvidenceV1[] = [],
) {
  if (!Number.isSafeInteger(maximumEstimatedTokens) || maximumEstimatedTokens < 800 || maximumEstimatedTokens > 1500)
    throw new Error('Navigation budget must be an integer from 800 to 1500.');
  const {answer} = input;
  if (
    answer.nodes.length > 24 ||
    answer.links.length > 64 ||
    answer.sources.length > 32 ||
    input.proofLocators.length > 96 ||
    reviewedMemory.length > 24
  )
    throw new RangeError('Navigation projection exceeds admitted evidence limits.');
  const {proofs, rejected} = compatibleProofs(answer, input.proofLocators);
  const items: Item[] = [
    ...EffectArray.map(proofs, (_, index) => item('proof', String(index), index)),
    ...EffectArray.map(answer.nodes, (node, index) => item('node', node.id, index)),
    ...EffectArray.map(answer.gaps, (gap, index) => item('gap', gap, index)),
    ...EffectArray.map(reviewedMemory, (memory, index) => item('memory', memory.uri, index)),
  ];
  const coreIds = requiredRouteNodes(answer);
  const required = uniqueProjectionItems(
    EffectArray.filter(items, candidate => candidate.lane === 'node' && coreIds.has(candidate.id)),
  );
  const requiredKeys = new Set(EffectArray.map(required, candidate => candidate.id));
  const optional = laneStableOptionalProjectionItems(
    EffectArray.filter(items, candidate => candidate.lane !== 'node' || !requiredKeys.has(candidate.id)),
    NAVIGATION_PROJECTION_LANES,
  );
  const maximumBytes = maximumEstimatedTokens * AGENT_RESPONSE_ESTIMATED_BYTES_PER_TOKEN;
  const selection = selectFiniteProjection({
    required,
    optional,
    maximumBytes,
    format: responseFormat,
    render: selected => renderSelected(answer, proofs, rejected, reviewedMemory, selected),
    renderText: value => renderText(value, responseFormat),
  });
  if (selection === undefined) {
    // If the complete route cannot fit, admit its best honest prefix through the same core.
    const primaryId = primaryNodeId(answer);
    const fallbackItems = uniqueProjectionItems([
      ...EffectArray.filter(required, candidate => candidate.id === primaryId),
      ...EffectArray.filter(optional, candidate => candidate.lane === 'proof'),
      ...EffectArray.filter(required, candidate => candidate.id !== primaryId),
      ...EffectArray.filter(optional, candidate => candidate.lane !== 'proof'),
    ]);
    const fallback = selectFiniteProjection({
      required: [],
      optional: fallbackItems,
      maximumBytes,
      format: responseFormat,
      render: selected => renderSelected(answer, proofs, rejected, reviewedMemory, selected),
      renderText: value => renderText(value, responseFormat),
    });
    if (fallback === undefined) {
      const minimum = renderProjectionChannels(
        renderSelected(answer, proofs, rejected, reviewedMemory, []),
        responseFormat,
        value => renderText(value, responseFormat),
      );
      throw AgentResponseBudgetTooSmallError.of(maximumBytes, minimum.measurement.totalBytes);
    }
    return {maximumBytes, ...fallback};
  }
  return {maximumBytes, ...selection};
}
function renderSelected(
  answer: NavigationAnswerV1,
  proofs: readonly NavigationProofLocator[],
  rejectedProofs: number,
  memory: readonly ContextBriefLogicalMemoryEvidenceV1[],
  selected: readonly Item[],
): NavigationProjection {
  const ids = selectedProjectionIds(selected);
  const nodes = selectProjectionDictionary(answer.nodes, ids.get('node'), node => node.id);
  const sourceIds = new Set(EffectArray.map(nodes, node => node.sourceId));
  for (const role of answer.roles) if (role.sourceProof !== undefined) sourceIds.add(role.sourceProof.sourceId);
  const sources = selectProjectionDictionary(answer.sources, sourceIds, source => source.id);
  const nodeIndex = new Map(EffectArray.map(nodes, (node, index) => [node.id, index]));
  const sourceIndex = new Map(EffectArray.map(sources, (source, index) => [source.id, index]));
  const selectedProofs = EffectArray.filter(
    proofs,
    (proof, index) => ids.get('proof')?.has(String(index)) === true && nodeIndex.has(proof.accepted.proof.ownerId),
  );
  const gaps = selectProjectionDictionary(answer.gaps, ids.get('gap'), gap => gap);
  const selectedMemory = selectProjectionDictionary(memory, ids.get('memory'), entry => entry.uri);
  const omittedProofs = proofs.length - selectedProofs.length;
  const missingProofOwners = EffectArray.filter(
    answer.nodes,
    node =>
      node.roles.includes('effects') &&
      node.support === 'evidenced' &&
      node.possibleEffect === undefined &&
      !EffectArray.some(proofs, locator => locator.accepted.proof.ownerId === node.id),
  ).length;
  const roles = EffectArray.map(answer.roles, role => {
    const supported = EffectArray.flatMap(role.nodeIds, id => (nodeIndex.has(id) ? [nodeIndex.get(id)!] : []));
    const candidates = EffectArray.flatMap(role.candidateIds, id => (nodeIndex.has(id) ? [nodeIndex.get(id)!] : []));
    // Missing optional breadth does not erase a retained, connected role witness.
    const primaryId = primaryNodeId(answer);
    const retainedIds = new Set(EffectArray.map(nodes, node => node.id));
    const missing =
      role.status === 'supported'
        ? !EffectArray.some(
            role.nodeIds,
            id => retainedIds.has(id) && routePath(answer, id, primaryId, retainedIds) !== undefined,
          )
        : role.candidateIds.length > 0 && candidates.length === 0;
    const partialEffects =
      role.role === 'effects' &&
      (omittedProofs > 0 ||
        rejectedProofs > 0 ||
        (supported.length > 0 &&
          selectedProofs.length === 0 &&
          EffectArray.some(
            role.nodeIds,
            id =>
              EffectOption.getOrUndefined(EffectArray.findFirst(answer.nodes, node => node.id === id))
                ?.possibleEffect === undefined,
          )));
    const status = missing || partialEffects ? 'omitted' : role.status;
    return role.sourceProof === undefined
      ? ([role.role, status, supported, candidates] as const)
      : ([
          role.role,
          status,
          supported,
          candidates,
          [
            sourceIndex.get(role.sourceProof.sourceId)!,
            role.sourceProof.span.startLine,
            role.sourceProof.span.endLine,
          ] as const,
        ] as const);
  });
  const links = EffectArray.filter(answer.links, link => nodeIndex.has(link.from) && nodeIndex.has(link.to));
  const omissions = {
    nodes: answer.nodes.length - nodes.length,
    links: answer.links.length - links.length,
    proofs: omittedProofs + rejectedProofs,
    effectDetails: missingProofOwners,
    gaps: answer.gaps.length - gaps.length,
    memory: memory.length - selectedMemory.length,
  };
  const omitted = projectionOmissionCount(omissions) > 0;
  const warnings = [
    'Possible code behavior; no runtime execution is claimed.',
    ...(omittedProofs + rejectedProofs > 0
      ? ['Effect proof/branch details omitted; effects coverage is incomplete.']
      : []),
    ...(EffectArray.some(answer.nodes, node => node.roles.includes('effects') && node.possibleEffect === undefined) &&
    proofs.length === 0
      ? ['Effect details require the paired source-proof sidecar.']
      : []),
  ];
  const followUps = exactAcquisitions(answer, nodes, omittedProofs + rejectedProofs + missingProofOwners > 0);
  return {
    version: 1,
    scope: answer.scope,
    target: answer.target,
    outcome: omitted && answer.outcome === 'ok' ? 'partial' : answer.outcome,
    coverage: omitted && answer.coverage.status === 'complete' ? 'partial' : answer.coverage.status,
    nodes: EffectArray.map(nodes, node => [
      node.id,
      sourceIndex.get(node.sourceId)!,
      node.startLine,
      node.endLine,
      node.support,
      node.basis,
      node.freshness,
    ]),
    sources: EffectArray.map(sources, source =>
      !sameScope(source, answer.scope)
        ? [
            source.path,
            source.contentHash,
            source.freshness,
            source.snapshot,
            {
              repository: source.repository,
              worktree: source.worktree,
              project: source.project,
              view: source.view,
            },
          ]
        : source.snapshot === undefined
          ? [source.path, source.contentHash, source.freshness]
          : [source.path, source.contentHash, source.freshness, source.snapshot],
    ),
    roles,
    links: EffectArray.map(links, link => [
      nodeIndex.get(link.from)!,
      nodeIndex.get(link.to)!,
      link.relation,
      link.basis,
      link.compatibility,
    ]),
    possibleEffects: EffectArray.flatMap(nodes, (node, index) =>
      node.possibleEffect === undefined ||
      EffectArray.some(selectedProofs, locator => locator.accepted.proof.ownerId === node.id)
        ? []
        : [
            node.possibleEffect.condition === undefined
              ? ([index, node.possibleEffect.kind, node.possibleEffect.target] as const)
              : ([index, node.possibleEffect.kind, node.possibleEffect.target, node.possibleEffect.condition] as const),
          ],
    ),
    effects: EffectArray.map(selectedProofs, locator => {
      const proof = locator.accepted.proof;
      return [
        nodeIndex.get(proof.ownerId)!,
        locator.target,
        locator.condition,
        span(proof.callSpan),
        span(proof.targetSpan),
        span(proof.guard.span),
        proof.guard.branch,
        proof.callEdgeId,
      ];
    }),
    gaps,
    warnings,
    omissions,
    followUps,
    memory: EffectArray.map(selectedMemory, entry => projectAgentViewMemory(compactProjectedMemory(entry))),
  };
}
function compatibleProofs(answer: NavigationAnswerV1, locators: readonly NavigationProofLocator[]) {
  let rejected = 0;
  const seen = new Set<string>();
  const proofs = EffectArray.filter(locators, locator => {
    const {accepted} = locator;
    const proof = accepted.proof;
    const owner = EffectOption.getOrUndefined(
      EffectArray.findFirst(answer.nodes, node => node.id === proof.ownerId && node.sourceId === locator.sourceId),
    );
    const source = EffectOption.getOrUndefined(
      EffectArray.findFirst(answer.sources, source => source.id === locator.sourceId),
    );
    if (
      owner === undefined ||
      source === undefined ||
      source.freshness !== 'verified-current' ||
      accepted.basis !== 'source-syntactic' ||
      !owner.roles.includes('effects') ||
      owner.support !== 'evidenced' ||
      !sameScope(locator.scope, answer.scope) ||
      source.repository !== locator.scope.repository ||
      source.worktree !== locator.scope.worktree ||
      source.project !== locator.scope.project ||
      !sameScope(source, locator.scope) ||
      source.path !== accepted.path ||
      source.contentHash !== accepted.contentHash ||
      source.snapshot !== locator.snapshot.id ||
      locator.snapshot.worktreeId !== source.worktree ||
      proof.ownerSpan.line !== owner.startLine ||
      proof.ownerSpan.endLine !== owner.endLine
    ) {
      rejected += 1;
      return false;
    }
    const key = JSON.stringify([
      locator.sourceId,
      accepted.path,
      accepted.contentHash,
      proof,
      locator.target,
      locator.condition,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {proofs, rejected};
}
function exactAcquisitions(
  answer: NavigationAnswerV1,
  selected: NavigationAnswerV1['nodes'],
  effectsOmitted: boolean,
): readonly NavigationAcquisition[] {
  const missing = EffectArray.filter(
    answer.nodes,
    node => !selected.includes(node) || (effectsOmitted && node.roles.includes('effects')),
  );
  const bySource = new Map<string, {path: string; start: number; end: number}>();
  for (const node of missing) {
    const source = EffectOption.getOrUndefined(
      EffectArray.findFirst(answer.sources, candidate => candidate.id === node.sourceId),
    );
    if (source === undefined) continue;
    const range = bySource.get(source.id);
    bySource.set(source.id, {
      path: source.path,
      start: Math.min(range?.start ?? node.startLine, node.startLine),
      end: Math.max(range?.end ?? node.endLine, node.endLine),
    });
  }
  const generated: NavigationAcquisition[] = EffectArray.map([...bySource.values()], range => ({
    kind: 'read-source',
    selector: `${range.path}:${range.start}-${range.end}`,
    reason: 'Recover omitted navigation evidence.',
  }));
  const seen = new Set<string>();
  return EffectArray.filter([...generated, ...answer.followUps], acquisition => {
    const key = `${acquisition.kind}:${acquisition.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 2);
}
function renderText(value: NavigationProjection, format: 'agent' | 'dual'): string {
  if (format === 'agent') return JSON.stringify(value);
  return EffectArray.join(
    [
      `NAVIGATION/1 ${value.outcome} (${value.coverage})`,
      ...EffectArray.map(
        value.roles,
        ([role, status, nodes, candidates]) =>
          `${role}: ${status} ${EffectArray.join(
            EffectArray.map(nodes, index => `n${index}`),
            ',',
          )}${
            candidates.length === 0
              ? ''
              : ` candidates:${EffectArray.join(
                  EffectArray.map(candidates, index => `n${index}`),
                  ',',
                )}`
          }`,
      ),
      ...EffectArray.map(
        value.effects,
        ([owner, target, condition]) => `n${owner}: possible write ${target}; ${condition}`,
      ),
      ...EffectArray.map(
        value.possibleEffects,
        ([owner, kind, target, condition]) =>
          `n${owner}: possible ${kind} ${target}${condition === undefined ? '' : `; ${condition}`}`,
      ),
      ...EffectArray.map(value.gaps, gap => `Gap: ${gap}`),
      ...value.warnings,
      `Omitted: ${projectionOmissionCount(value.omissions)}`,
      ...EffectArray.map(value.followUps, next => `${next.kind}: ${next.selector}`),
    ],
    '\n',
  );
}
function item(lane: Item['lane'], id: string, rank: number): Item {
  return {id, lane, laneRank: rank, priority: NAVIGATION_PROJECTION_LANES.indexOf(lane)};
}
function span(value: CodeGraphSpan): SpanRow {
  return [value.line, value.column, value.endLine, value.endColumn];
}

function sameScope(left: NavigationScope, right: NavigationScope): boolean {
  return (
    left.repository === right.repository &&
    left.worktree === right.worktree &&
    left.project === right.project &&
    left.view.kind === right.view.kind &&
    left.view.id === right.view.id &&
    left.view.owner === right.view.owner &&
    left.view.epoch === right.view.epoch
  );
}

/** Only paths needed to join the best role witnesses are mandatory; neighbors remain optional. */
function requiredRouteNodes(answer: NavigationAnswerV1): ReadonlySet<string> {
  const primaryId = primaryNodeId(answer);
  const selected = new Set<string>();
  if (primaryId !== undefined) selected.add(primaryId);
  for (const role of answer.roles) {
    const id = role.nodeIds[0] ?? role.candidateIds[0];
    if (id === undefined) continue;
    selected.add(id);
    for (const nodeId of routePath(answer, id, primaryId) ?? []) selected.add(nodeId);
  }
  return selected;
}
function primaryNodeId(answer: NavigationAnswerV1): string | undefined {
  const ids = new Set(EffectArray.map(answer.nodes, node => node.id));
  return (
    (answer.target.kind === 'task'
      ? undefined
      : EffectOption.getOrUndefined(EffectArray.findFirst(answer.target.candidateIds, id => ids.has(id)))) ??
    EffectOption.getOrUndefined(EffectArray.findFirst(answer.roles, role => role.role === 'implementation'))
      ?.nodeIds[0] ??
    answer.nodes[0]?.id
  );
}
/** Bounded BFS over real compatible relations, retaining intermediary declarations. */
function routePath(
  answer: NavigationAnswerV1,
  from: string,
  to: string | undefined,
  allowed: ReadonlySet<string> = new Set(EffectArray.map(answer.nodes, node => node.id)),
): readonly string[] | undefined {
  if (to === undefined || !allowed.has(from) || !allowed.has(to)) return undefined;
  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index];
    const current = path[path.length - 1];
    if (current === to) return path;
    for (const link of answer.links) {
      if (link.compatibility !== 'verified') continue;
      const next = link.from === current ? link.to : link.to === current ? link.from : undefined;
      if (next === undefined || seen.has(next) || !allowed.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return undefined;
}
