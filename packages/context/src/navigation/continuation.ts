import {Array as EffectArray, Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {NavigationAnswerV1, NavigationNode, NavigationScope, NavigationSource} from './model.js';

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
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
const sourceKey = (source: NavigationSource) =>
  JSON.stringify([
    scopeKey(source),
    source.id,
    source.path,
    source.contentHash,
    source.freshness,
    source.snapshot ?? null,
    source.semantic?.observationKey ?? null,
  ]);

/**
 * Opaque binding of an answer to its requested scope and every retained source observation. Any change to a
 * content hash, graph snapshot, view or semantic observation key (including provider generation and project
 * epoch) changes the binding, so a continuation can never splice pages from different observations.
 */
export function navigationAnswerBinding(answer: NavigationAnswerV1): string {
  return sha256HexSync(
    JSON.stringify([
      'navigation-answer-binding-v1',
      scopeKey(answer.scope),
      EffectArray.map(answer.sources, sourceKey).sort(compareText),
    ]),
  );
}

export type NavigationContinuationCheck =
  | {readonly status: 'current'}
  | {readonly status: 'stale'; readonly reason: 'navigation-scope-changed' | 'navigation-observation-changed'};

/** Revalidate a retained continuation against a fresh answer; a stale result requires a rebound new query. */
export function revalidateNavigationContinuation(
  binding: string,
  retainedScope: NavigationScope,
  current: NavigationAnswerV1,
): NavigationContinuationCheck {
  if (scopeKey(retainedScope) !== scopeKey(current.scope)) return {status: 'stale', reason: 'navigation-scope-changed'};
  return navigationAnswerBinding(current) === binding
    ? {status: 'current'}
    : {status: 'stale', reason: 'navigation-observation-changed'};
}

export interface NavigationEffectsDelta {
  readonly status: 'unchanged' | 'changed' | 'invalidated';
  readonly reason: string;
  /** Only the current write-boundary nodes and their sources; unchanged routes are not repeated. */
  readonly effects: readonly NavigationNode[];
  readonly sources: readonly NavigationSource[];
}

const effectKey = (node: NavigationNode, sources: ReadonlyMap<string, NavigationSource>) =>
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
  ]);

function effectsOf(answer: NavigationAnswerV1) {
  const sources = new Map(EffectArray.map(answer.sources, source => [source.id, source] as const));
  const role = Option.getOrUndefined(EffectArray.findFirst(answer.roles, item => item.role === 'effects'));
  const ids = new Set(role?.nodeIds ?? []);
  const nodes = EffectArray.filter(answer.nodes, node => ids.has(node.id));
  return {
    status: role?.status ?? 'unknown',
    nodes,
    sources,
    keys: EffectArray.map(nodes, node => effectKey(node, sources)).sort(compareText),
  };
}

/**
 * Compare only the write-boundary role of a warm follow-up with the previous answer. The caller acquires only
 * the previous effect files; this pure step reports the needed delta or a truthful invalidation.
 */
export function navigationEffectsDelta(
  previous: NavigationAnswerV1,
  current: NavigationAnswerV1,
): NavigationEffectsDelta {
  const invalidated = (reason: string): NavigationEffectsDelta => ({
    status: 'invalidated',
    reason,
    effects: [],
    sources: [],
  });
  if (scopeKey(previous.scope) !== scopeKey(current.scope)) return invalidated('navigation-scope-changed');
  if (
    current.outcome === 'conflict' ||
    current.outcome === 'unavailable' ||
    current.outcome === 'timeout' ||
    current.outcome === 'unresolved'
  )
    return invalidated(`navigation-follow-up-${current.outcome}`);
  const before = effectsOf(previous);
  const after = effectsOf(current);
  const same =
    before.status === after.status &&
    before.keys.length === after.keys.length &&
    EffectArray.every(before.keys, (key, index) => key === after.keys[index]);
  if (same) return {status: 'unchanged', reason: 'navigation-effects-unchanged', effects: [], sources: []};
  const sourceIds = new Set(EffectArray.map(after.nodes, node => node.sourceId));
  return {
    status: 'changed',
    reason: after.nodes.length === 0 ? 'navigation-effects-no-longer-supported' : 'navigation-effects-changed',
    effects: after.nodes,
    sources: EffectArray.filter(current.sources, source => sourceIds.has(source.id)),
  };
}
