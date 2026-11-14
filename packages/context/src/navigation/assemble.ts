import {Array as EffectArray} from 'effect';
import {
  NAVIGATION_INPUT_LIMITS,
  NAVIGATION_ROLES,
  type NavigationAnswerV1,
  type NavigationCandidate,
  type NavigationInput,
  type NavigationLink,
  type NavigationNode,
  type NavigationRole,
  type NavigationRoleResult,
  type NavigationScope,
  type NavigationSource,
} from './model.js';

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const strings = <Value extends string>(values: readonly Value[]) => [...new Set(values)].sort(compareText);
const scopeKey = (scope: NavigationScope) =>
  JSON.stringify([
    scope.repository,
    scope.worktree,
    scope.project,
    scope.view.kind,
    scope.view.id,
    scope.view.owner,
    scope.view.epoch,
  ]);
const locatorKey = (candidate: NavigationCandidate, source: NavigationSource, scope: string) =>
  JSON.stringify([scope, source.path, source.contentHash, candidate.startLine, candidate.endLine]);
const sameSource = (left: NavigationSource, right: NavigationSource, keyFor: (scope: NavigationScope) => string) =>
  keyFor(left) === keyFor(right) &&
  left.path === right.path &&
  left.contentHash === right.contentHash &&
  left.freshness === right.freshness &&
  left.snapshot === right.snapshot &&
  left.semantic?.observationKey === right.semantic?.observationKey &&
  left.semantic?.observationJson === right.semantic?.observationJson;

export function assembleNavigationAnswer(input: NavigationInput): NavigationAnswerV1 {
  admit(input);
  const gaps = new Set(input.gaps);
  const scopeKeys = new Map<NavigationScope, string>();
  const keyFor = (scope: NavigationScope): string => {
    const existing = scopeKeys.get(scope);
    if (existing !== undefined) return existing;
    const key = scopeKey(scope);
    scopeKeys.set(scope, key);
    return key;
  };
  const requestedScope = keyFor(input.scope);
  const sources = new Map<string, NavigationSource>();
  const files = new Map<string, NavigationSource[]>();
  const rejectedSources = new Set<string>();
  for (const source of input.sources) {
    const previous = sources.get(source.id);
    if (previous && !sameSource(previous, source, keyFor)) rejectedSources.add(source.id);
    else sources.set(source.id, source);
    const key = JSON.stringify([keyFor(source), source.path]);
    const observations = files.get(key) ?? [];
    observations.push(source);
    files.set(key, observations);
  }
  for (const observations of files.values()) {
    if (EffectArray.some(observations, source => source.contentHash !== observations[0].contentHash))
      for (const source of observations) rejectedSources.add(source.id);
  }
  for (const id of rejectedSources) sources.delete(id);
  const scopedRejectedIds = new Set(
    EffectArray.map(
      EffectArray.filter(input.sources, source => rejectedSources.has(source.id) && keyFor(source) === requestedScope),
      source => source.id,
    ),
  );
  const rejectedObservations = EffectArray.filter(input.sources, source => scopedRejectedIds.has(source.id));
  const eligible = EffectArray.filter(input.candidates, candidate => {
    const source = sources.get(candidate.sourceId);
    return source !== undefined && (input.target.kind === 'ambiguous' || keyFor(source) === requestedScope);
  });
  const byId = new Map<string, NavigationCandidate>();
  const rejectedIds = new Set<string>();
  for (const candidate of eligible) {
    const previous = byId.get(candidate.id);
    if (previous && candidateKey(previous) !== candidateKey(candidate)) rejectedIds.add(candidate.id);
    else byId.set(candidate.id, candidate);
  }
  for (const id of rejectedIds) byId.delete(id);
  if (scopedRejectedIds.size) gaps.add('source-identity-conflict');
  if (rejectedIds.size) gaps.add('candidate-identity-conflict');

  const groups = new Map<string, NavigationCandidate[]>();
  for (const candidate of byId.values()) {
    const source = sources.get(candidate.sourceId);
    if (!source) continue;
    const key = locatorKey(candidate, source, keyFor(source));
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const aliases = new Map<string, string>();
  const nodes = new Map<string, NavigationNode>();
  for (const group of groups.values()) {
    group.sort((left, right) => compareText(left.id, right.id));
    const first = group[0];
    if (EffectArray.some(group, item => !compatibleFacts(first, item))) {
      gaps.add('locator-evidence-conflict');
      continue;
    }
    const source = sources.get(first.sourceId);
    if (!source) continue;
    const node: NavigationNode = {
      ...first,
      roles: EffectArray.filter(NAVIGATION_ROLES, role => EffectArray.some(group, item => item.roles.includes(role))),
      basis: strings(EffectArray.flatMap(group, item => item.basis)),
      reason: strings(EffectArray.map(group, item => item.reason))[0],
      relevance: Math.max(...EffectArray.map(group, item => item.relevance)),
      freshness: source.freshness,
    };
    nodes.set(node.id, node);
    for (const candidate of group) aliases.set(candidate.id, node.id);
  }
  const compareNodes = (left: NavigationNode, right: NavigationNode) =>
    Number(right.support === 'evidenced') - Number(left.support === 'evidenced') ||
    Number(right.testAssociation === 'source-supported') - Number(left.testAssociation === 'source-supported') ||
    right.relevance - left.relevance ||
    compareText(left.id, right.id);
  const ordered = [...nodes.values()].sort(compareNodes);
  const anchors =
    input.target.kind === 'task'
      ? []
      : strings(
          EffectArray.flatMap(input.target.candidateIds, id => {
            const alias = aliases.get(id);
            return alias === undefined ? [] : [alias];
          }),
        );
  const compareTaskNodes = (left: NavigationNode, right: NavigationNode) =>
    Number(right.support === 'evidenced') - Number(left.support === 'evidenced') ||
    right.relevance - left.relevance ||
    compareNodes(left, right);
  let taskSeed: NavigationNode | undefined;
  if (input.target.kind === 'task') {
    for (const candidate of ordered) {
      if (!taskSeed || compareTaskNodes(candidate, taskSeed) < 0) taskSeed = candidate;
    }
  }
  const seeds = input.target.kind === 'task' ? (taskSeed ? [taskSeed.id] : []) : anchors;
  const selected = new Set(seeds);
  const links = new Map<string, NavigationLink>();
  const adjacency = new Map<string, string[]>();
  const blocked = new Set<string>();
  const inputCandidateSources = new Map<string, Set<string>>();
  for (const candidate of input.candidates) {
    const ids = inputCandidateSources.get(candidate.id) ?? new Set<string>();
    ids.add(candidate.sourceId);
    inputCandidateSources.set(candidate.id, ids);
  }
  const separatedSources = new Map<string, Set<string>>();
  if (input.target.kind !== 'ambiguous') {
    for (const link of input.links) {
      const from = aliases.get(link.from);
      const to = aliases.get(link.to);
      if (!from || !to) {
        const attached = from ?? to;
        const counterpartSources = inputCandidateSources.get(from === undefined ? link.from : link.to);
        if (attached) {
          const separated = separatedSources.get(attached) ?? new Set<string>();
          for (const sourceId of counterpartSources ?? []) {
            const source = sources.get(sourceId);
            if (source && keyFor(source) !== requestedScope) separated.add(source.id);
          }
          if (separated.size) separatedSources.set(attached, separated);
        }
        continue;
      }
      if (from === to) continue;
      if (link.compatibility !== 'verified') {
        blocked.add(from);
        blocked.add(to);
        continue;
      }
      const normalized = {...link, from, to};
      links.set(linkKey(normalized), normalized);
      const forward = adjacency.get(from) ?? [];
      const backward = adjacency.get(to) ?? [];
      forward.push(to);
      backward.push(from);
      adjacency.set(from, forward);
      adjacency.set(to, backward);
    }
    const queue = [...seeds];
    for (let index = 0; index < queue.length; index++) {
      for (const neighbor of adjacency.get(queue[index]) ?? []) {
        if (selected.has(neighbor)) continue;
        selected.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  if (EffectArray.some([...selected], id => blocked.has(id))) gaps.add('relationship-view-unverified');
  if (input.target.kind !== 'task' && EffectArray.some(input.target.candidateIds, id => !aliases.has(id)))
    gaps.add('target-unresolved');
  const retainedNodes = EffectArray.filter(ordered, node => selected.has(node.id));
  const retainedSources = new Set(EffectArray.map(retainedNodes, node => node.sourceId));
  for (const [attached, sourceIds] of separatedSources) {
    if (selected.has(attached)) {
      for (const sourceId of sourceIds) retainedSources.add(sourceId);
      gaps.add('source-view-conflict');
    }
  }
  const roleResults = EffectArray.map(NAVIGATION_ROLES, role =>
    roleResult(role, retainedNodes, input, sources, keyFor),
  );
  for (const role of roleResults) if (role.sourceProof) retainedSources.add(role.sourceProof.sourceId);
  const allSupported = EffectArray.every(
    roleResults,
    role => role.status === 'supported' || role.status === 'not-applicable',
  );
  const current = EffectArray.every(retainedNodes, node => node.freshness === 'verified-current');
  const outcome =
    input.target.kind === 'ambiguous'
      ? 'ambiguous'
      : gaps.has('target-unresolved')
        ? 'unresolved'
        : gaps.has('source-view-conflict') ||
            gaps.has('source-identity-conflict') ||
            gaps.has('candidate-identity-conflict') ||
            gaps.has('locator-evidence-conflict')
          ? 'conflict'
          : retainedNodes.length === 0
            ? input.coverage.status === 'unavailable' || input.coverage.status === 'timeout'
              ? input.coverage.status
              : 'empty'
            : allSupported && current && input.coverage.status === 'complete' && gaps.size === 0
              ? 'ok'
              : 'partial';
  return {
    version: 1,
    scope: input.scope,
    target: input.target,
    outcome,
    nodes: retainedNodes,
    links: EffectArray.filter([...links.values()], link => selected.has(link.from) && selected.has(link.to)).sort(
      (left, right) => compareText(linkKey(left), linkKey(right)),
    ),
    sources: EffectArray.dedupeAdjacentWith(
      [
        ...EffectArray.filter([...sources.values()], source => retainedSources.has(source.id)),
        ...rejectedObservations,
      ].sort((left, right) => compareSources(left, right, keyFor)),
      (left, right) => left.id === right.id && sameSource(left, right, keyFor),
    ),
    roles: roleResults,
    coverage: input.coverage,
    gaps: strings([...gaps]),
    followUps: [...(input.followUps ?? [])].sort((left, right) => compareText(left.selector, right.selector)),
  };
}

function compareSources(
  left: NavigationSource,
  right: NavigationSource,
  keyFor: (scope: NavigationScope) => string,
): number {
  return (
    compareText(left.id, right.id) ||
    compareText(keyFor(left), keyFor(right)) ||
    compareText(left.path, right.path) ||
    compareText(left.contentHash, right.contentHash) ||
    compareText(left.freshness, right.freshness) ||
    compareText(left.snapshot ?? '', right.snapshot ?? '') ||
    compareText(left.semantic?.observationKey ?? '', right.semantic?.observationKey ?? '') ||
    compareText(left.semantic?.observationJson ?? '', right.semantic?.observationJson ?? '')
  );
}

function candidateKey(candidate: NavigationCandidate): string {
  return JSON.stringify([
    candidate.sourceId,
    candidate.startLine,
    candidate.endLine,
    strings(candidate.roles),
    strings(candidate.basis),
    candidate.support,
    candidate.relevance,
    candidate.reason,
    effectKey(candidate),
    candidate.testAssociation,
  ]);
}

function compatibleFacts(left: NavigationCandidate, right: NavigationCandidate): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.support === right.support &&
    left.testAssociation === right.testAssociation &&
    effectKey(left) === effectKey(right)
  );
}

function effectKey(candidate: NavigationCandidate): string {
  const effect = candidate.possibleEffect;
  return effect ? JSON.stringify([effect.kind, effect.target, effect.condition]) : '';
}

function linkKey(link: NavigationLink): string {
  return JSON.stringify([link.from, link.to, link.relation, link.basis, link.compatibility, link.reason]);
}

function roleResult(
  role: NavigationRole,
  nodes: readonly NavigationNode[],
  input: NavigationInput,
  sources: ReadonlyMap<string, NavigationSource>,
  keyFor: (scope: NavigationScope) => string,
): NavigationRoleResult {
  const matches = EffectArray.filter(nodes, node => node.roles.includes(role));
  if (input.target.kind === 'ambiguous')
    return {role, status: 'unknown', nodeIds: [], candidateIds: EffectArray.map(matches, node => node.id)};
  const supported = EffectArray.filter(matches, node => node.support === 'evidenced');
  if (supported.length)
    return {role, status: 'supported', nodeIds: EffectArray.map(supported, node => node.id), candidateIds: []};
  const gaps = EffectArray.filter(input.roleGaps ?? [], gap => gap.role === role);
  const gap = gaps.length === 1 ? gaps[0] : undefined;
  const proof = gap?.sourceProof && sources.get(gap.sourceProof.sourceId);
  const applicableProof = proof && keyFor(proof) === keyFor(input.scope) && proof.freshness === 'verified-current';
  const status = gap?.status === 'not-applicable' && !applicableProof ? 'unknown' : (gap?.status ?? 'unknown');
  return {
    role,
    status,
    nodeIds: [],
    candidateIds: EffectArray.map(matches, node => node.id),
    ...(gap ? {reason: gap.reason} : {}),
    ...(status === 'not-applicable' && gap?.sourceProof ? {sourceProof: gap.sourceProof} : {}),
  };
}

function admit(input: NavigationInput): void {
  const limits = NAVIGATION_INPUT_LIMITS;
  if (
    input.candidates.length > limits.candidates ||
    input.links.length > limits.links ||
    input.sources.length > limits.sources ||
    (input.target.kind !== 'task' &&
      (input.target.candidateIds.length === 0 || input.target.candidateIds.length > limits.anchors)) ||
    (input.roleGaps?.length ?? 0) > NAVIGATION_ROLES.length ||
    (input.gaps?.length ?? 0) > limits.gaps ||
    (input.followUps?.length ?? 0) > limits.followUps
  )
    throw new RangeError('Navigation input exceeds item limits.');
  const encoder = new TextEncoder();
  let bytes = 0;
  const text = (value: string) => {
    if (value.length === 0 || value.length > limits.stringBytes)
      throw new RangeError('Navigation input exceeds string limits.');
    const length = encoder.encode(value).byteLength;
    bytes += length;
    if (length > limits.stringBytes || bytes > limits.totalStringBytes)
      throw new RangeError('Navigation input exceeds string limits.');
  };
  const scope = (value: NavigationScope) => {
    for (const item of [value.repository, value.worktree, value.project, value.view.id, value.view.owner]) text(item);
    if (!Number.isSafeInteger(value.view.epoch) || value.view.epoch < 0)
      throw new RangeError('Invalid navigation view epoch.');
  };
  scope(input.scope);
  text(input.coverage.description);
  const semanticSources = new Set<string>();
  for (const source of input.sources) {
    scope(source);
    for (const item of [source.id, source.path, source.contentHash]) text(item);
    if (source.snapshot !== undefined) text(source.snapshot);
    if (source.semantic) {
      text(source.semantic.observationKey);
      text(source.semantic.observationJson);
      semanticSources.add(source.id);
    }
  }
  for (const candidate of input.candidates) {
    for (const item of [candidate.id, candidate.sourceId, candidate.reason]) text(item);
    if (
      candidate.roles.length === 0 ||
      candidate.basis.length === 0 ||
      candidate.roles.length > NAVIGATION_ROLES.length ||
      candidate.basis.length > 5
    )
      throw new RangeError('Navigation input exceeds role or basis limits.');
    if (candidate.basis.includes('qualified-semantic') && !semanticSources.has(candidate.sourceId))
      throw new RangeError('Qualified semantic evidence requires its complete observation.');
    if (
      !Number.isSafeInteger(candidate.startLine) ||
      !Number.isSafeInteger(candidate.endLine) ||
      candidate.startLine < 1 ||
      candidate.endLine < candidate.startLine ||
      !Number.isFinite(candidate.relevance)
    )
      throw new RangeError('Invalid navigation candidate.');
    if (candidate.possibleEffect) {
      text(candidate.possibleEffect.target);
      if (candidate.possibleEffect.condition !== undefined) text(candidate.possibleEffect.condition);
    }
  }
  if (input.target.kind !== 'task') for (const id of input.target.candidateIds) text(id);
  for (const link of input.links) for (const item of [link.from, link.to, link.reason]) text(item);
  for (const gap of input.roleGaps ?? []) {
    text(gap.reason);
    if (gap.sourceProof) {
      text(gap.sourceProof.sourceId);
      if (
        !Number.isSafeInteger(gap.sourceProof.span.startLine) ||
        !Number.isSafeInteger(gap.sourceProof.span.endLine) ||
        gap.sourceProof.span.startLine < 1 ||
        gap.sourceProof.span.endLine < gap.sourceProof.span.startLine
      )
        throw new RangeError('Invalid navigation proof span.');
    }
  }
  for (const gap of input.gaps ?? []) text(gap);
  for (const followUp of input.followUps ?? []) {
    text(followUp.selector);
    text(followUp.reason);
  }
}
