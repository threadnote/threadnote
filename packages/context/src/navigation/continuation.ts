import {Array as EffectArray, Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphQueryResult} from '@threadnote/graph/types';
import {
  NAVIGATION_INPUT_LIMITS,
  navigationScopeKey,
  type NavigationAnswerV1,
  type NavigationNode,
  type NavigationSource,
} from './model.js';

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const sourceKey = (source: NavigationSource) =>
  JSON.stringify([
    navigationScopeKey(source),
    source.id,
    source.path,
    source.contentHash,
    source.freshness,
    source.snapshot ?? null,
    source.semantic?.observationKey ?? null,
  ]);

/**
 * Opaque binding of an answer to its requested scope and every retained source observation. Any change to the
 * scope, a content hash, graph snapshot, view or semantic observation key (including provider generation and
 * project epoch) changes the binding, so a continuation can never splice pages from different observations.
 */
export function navigationAnswerBinding(answer: NavigationAnswerV1): string {
  return sha256HexSync(
    JSON.stringify([
      'navigation-answer-binding-v1',
      navigationScopeKey(answer.scope),
      EffectArray.map(answer.sources, sourceKey).sort(compareText),
    ]),
  );
}

/** Revalidate a retained continuation against a fresh answer; a stale result requires a rebound new query. */
export function revalidateNavigationContinuation(
  binding: string,
  current: NavigationAnswerV1,
): {readonly status: 'current'} | {readonly status: 'stale'; readonly reason: 'navigation-binding-changed'} {
  return navigationAnswerBinding(current) === binding
    ? {status: 'current'}
    : {status: 'stale', reason: 'navigation-binding-changed'};
}

/** The write-boundary role of an answer: its status, nodes and the sources those nodes come from. */
export function navigationEffects(answer: NavigationAnswerV1) {
  const role = Option.getOrUndefined(EffectArray.findFirst(answer.roles, item => item.role === 'effects'));
  const ids = new Set(role?.nodeIds ?? []);
  const nodes = EffectArray.filter(answer.nodes, node => ids.has(node.id));
  const sourceIds = new Set(EffectArray.map(nodes, node => node.sourceId));
  return {
    status: role?.status ?? 'unknown',
    nodes,
    sources: EffectArray.filter(answer.sources, source => sourceIds.has(source.id)),
  };
}

/**
 * Anchors for a warm write-boundary follow-up: only the previous effect nodes found again in the caller's bounded
 * graph result, with the edges between them. Undefined when none is found, which invalidates the follow-up.
 */
export function navigationEffectsFollowUpAnchors(
  previous: NavigationAnswerV1,
  result: CodeGraphQueryResult,
): CodeGraphQueryResult | undefined {
  const ids = new Set(EffectArray.map(navigationEffects(previous).nodes, node => node.id));
  const nodes = EffectArray.filter(result.nodes, node => ids.has(node.id) && node.kind !== 'module').slice(
    0,
    NAVIGATION_INPUT_LIMITS.anchors,
  );
  if (nodes.length === 0) return undefined;
  const kept = new Set(EffectArray.map(nodes, node => node.id));
  return {
    ...result,
    nodes,
    edges: EffectArray.filter(
      result.edges,
      edge =>
        edge.sourceId !== undefined &&
        edge.targetId !== undefined &&
        kept.has(edge.sourceId) &&
        kept.has(edge.targetId),
    ),
  };
}

export interface NavigationEffectsDelta {
  readonly status: 'unchanged' | 'changed' | 'invalidated';
  readonly reason: string;
  /** Only the current write-boundary nodes and their sources; unchanged routes are not repeated. */
  readonly effects: readonly NavigationNode[];
  readonly sources: readonly NavigationSource[];
}

export const invalidatedNavigationEffects = (reason: string): NavigationEffectsDelta => ({
  status: 'invalidated',
  reason,
  effects: [],
  sources: [],
});

function effectKeys(effects: ReturnType<typeof navigationEffects>): readonly string[] {
  const sources = new Map(EffectArray.map(effects.sources, source => [source.id, source] as const));
  return EffectArray.map(effects.nodes, node =>
    JSON.stringify([
      sources.get(node.sourceId)?.path ?? null,
      sources.get(node.sourceId)?.contentHash ?? null,
      node.startLine,
      node.endLine,
      node.support,
      node.freshness,
      node.possibleEffect?.kind ?? null,
      node.possibleEffect?.target ?? null,
      node.possibleEffect?.condition ?? null,
    ]),
  ).sort(compareText);
}

/**
 * Compare only the write-boundary role of a warm follow-up with the previous answer. The caller acquires only
 * the previous effect files; this pure step reports the needed delta or a truthful invalidation.
 */
export function navigationEffectsDelta(
  previous: NavigationAnswerV1,
  current: NavigationAnswerV1,
): NavigationEffectsDelta {
  if (navigationScopeKey(previous.scope) !== navigationScopeKey(current.scope))
    return invalidatedNavigationEffects('navigation-scope-changed');
  if (
    current.outcome === 'conflict' ||
    current.outcome === 'unavailable' ||
    current.outcome === 'timeout' ||
    current.outcome === 'unresolved'
  )
    return invalidatedNavigationEffects(`navigation-follow-up-${current.outcome}`);
  const before = navigationEffects(previous);
  const after = navigationEffects(current);
  const beforeKeys = effectKeys(before);
  const afterKeys = effectKeys(after);
  if (
    before.status === after.status &&
    beforeKeys.length === afterKeys.length &&
    EffectArray.every(beforeKeys, (key, index) => key === afterKeys[index])
  )
    return {status: 'unchanged', reason: 'navigation-effects-unchanged', effects: [], sources: []};
  // An unsupported role after the follow-up may only mean the evidence was not read again (deadline, budget or
  // omitted facts). Only an affirmative not-applicable result says the write boundary is gone.
  if (after.nodes.length === 0)
    return after.status === 'not-applicable'
      ? {status: 'changed', reason: 'navigation-effects-not-applicable', effects: [], sources: []}
      : invalidatedNavigationEffects('navigation-effects-not-reacquired');
  return {status: 'changed', reason: 'navigation-effects-changed', effects: after.nodes, sources: after.sources};
}
