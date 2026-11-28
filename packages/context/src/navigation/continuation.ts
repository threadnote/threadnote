import {Array as EffectArray, Option, Schema} from 'effect';
import * as EffectString from 'effect/String';
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
/** Acquisition gaps after which absent evidence was possibly not read, not proven absent. */
const INCOMPLETE_ACQUISITION =
  /^(?:task-source-|navigation-(?:read-budget|anchor-budget|selector-budget|fact-|facts-|proof-source-incomplete|ready-closure-))/u;
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

/** What a follow-up compares: the scope, the effects status and a digest of every effect key. */
export interface NavigationEffectsSummary {
  readonly scope: string;
  readonly status: string;
  readonly digest: string;
}

/** A previous effect node the follow-up re-reads. Client input: the reader re-resolves it through the graph. */
export interface NavigationEffectsLocator {
  readonly nodeId: string;
  readonly path: string;
}

export interface NavigationContinuationV1 {
  readonly summary: NavigationEffectsSummary;
  readonly locators: readonly NavigationEffectsLocator[];
}

/** At most this many effect nodes are re-read; a larger write boundary gets no continuation. */
export const NAVIGATION_CONTINUATION_LOCATORS = 2;
/** Continuation text is client input; this bound applies before any decoding. */
export const NAVIGATION_CONTINUATION_BYTES = 1024;
/** Change detection only, not a security binding: scope and binding are re-derived from the request. */
const DIGEST = /^[0-9a-f]{16}$/u;
const digest16 = (text: string) => EffectString.slice(0, 16)(sha256HexSync(text));
/** Same graph symbol id forms as citation capture: 32, 40 or 64 lowercase hex digits. */
const NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export function navigationEffectsSummary(answer: NavigationAnswerV1): NavigationEffectsSummary {
  const effects = navigationEffects(answer);
  return {
    scope: digest16(navigationScopeKey(answer.scope)),
    status: effects.status,
    digest: digest16(JSON.stringify(effectKeys(effects))),
  };
}

const ContinuationWire = Schema.Tuple([
  Schema.Literal(1),
  Schema.String.check(Schema.isPattern(DIGEST)),
  Schema.Literals(['supported', 'unknown', 'unavailable', 'omitted', 'not-applicable']),
  Schema.String.check(Schema.isPattern(DIGEST)),
  Schema.Array(
    Schema.Tuple([
      Schema.String.check(Schema.isPattern(NODE_ID)),
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    ]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(NAVIGATION_CONTINUATION_LOCATORS)),
]);

/**
 * Opaque, stateless continuation for the warm write-boundary follow-up. It carries no source text, secret or
 * handle, and it is undefined when the effects cannot be re-read within its bounds.
 */
export function encodeNavigationContinuation(answer: NavigationAnswerV1): string | undefined {
  const effects = navigationEffects(answer);
  const nodes = EffectArray.filter(effects.nodes, node => NODE_ID.test(node.id));
  if (nodes.length === 0 || nodes.length !== effects.nodes.length || nodes.length > NAVIGATION_CONTINUATION_LOCATORS)
    return undefined;
  const sources = new Map(EffectArray.map(effects.sources, source => [source.id, source] as const));
  const locators = EffectArray.flatMap(nodes, node => {
    const source = sources.get(node.sourceId);
    return source === undefined ? [] : [[node.id, source.path] as const];
  });
  if (locators.length !== nodes.length) return undefined;
  const summary = navigationEffectsSummary(answer);
  const token = Buffer.from(
    JSON.stringify([1, summary.scope, summary.status, summary.digest, locators]),
    'utf8',
  ).toString('base64url');
  return token.length > NAVIGATION_CONTINUATION_BYTES ? undefined : token;
}

/** Strict decode of untrusted continuation text. Any violation is undefined, which invalidates the follow-up. */
export function decodeNavigationContinuation(token: string): NavigationContinuationV1 | undefined {
  if (token.length === 0 || token.length > NAVIGATION_CONTINUATION_BYTES || !BASE64URL.test(token)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const decoded = Schema.decodeUnknownOption(ContinuationWire)(json, {onExcessProperty: 'error'});
  if (Option.isNone(decoded)) return undefined;
  const [, scope, status, digest, locators] = decoded.value;
  if (!EffectArray.every(locators, ([, path]) => navigationRelativePath(path))) return undefined;
  if (new Set(EffectArray.map(locators, ([nodeId]) => nodeId)).size !== locators.length) return undefined;
  return {
    summary: {scope, status, digest},
    locators: EffectArray.map(locators, ([nodeId, path]) => ({nodeId, path})),
  };
}

/** Repository-relative POSIX path with no empty, `.` or `..` segment, no backslash and no control character. */
export function navigationRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    EffectString.startsWith('/')(path) ||
    /^[A-Za-z]:/u.test(path) ||
    EffectString.includes('\\')(path)
  )
    return false;
  // oxlint-disable-next-line no-control-regex -- Control characters are rejected in client paths.
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  return EffectArray.every(
    EffectString.split('/')(path),
    segment => segment !== '' && segment !== '.' && segment !== '..',
  );
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
  previous: NavigationAnswerV1 | NavigationEffectsSummary,
  current: NavigationAnswerV1,
): NavigationEffectsDelta {
  const before = 'digest' in previous ? previous : navigationEffectsSummary(previous);
  const now = navigationEffectsSummary(current);
  if (before.scope !== now.scope) return invalidatedNavigationEffects('navigation-scope-changed');
  if (
    current.outcome === 'conflict' ||
    current.outcome === 'unavailable' ||
    current.outcome === 'timeout' ||
    current.outcome === 'unresolved'
  )
    return invalidatedNavigationEffects(`navigation-follow-up-${current.outcome}`);
  const after = navigationEffects(current);
  if (before.status === now.status && before.digest === now.digest)
    return {status: 'unchanged', reason: 'navigation-effects-unchanged', effects: [], sources: []};
  // An unsupported role after the follow-up may only mean the evidence was not read again (deadline, budget or
  // omitted facts). Only an affirmative not-applicable result says the write boundary is gone.
  if (after.nodes.length === 0)
    return after.status === 'not-applicable'
      ? {status: 'changed', reason: 'navigation-effects-not-applicable', effects: [], sources: []}
      : invalidatedNavigationEffects('navigation-effects-not-reacquired');
  // Fewer effects after an incomplete acquisition may only mean some were not read again.
  if (EffectArray.some(current.gaps, gap => INCOMPLETE_ACQUISITION.test(gap)))
    return invalidatedNavigationEffects('navigation-effects-not-reacquired');
  return {status: 'changed', reason: 'navigation-effects-changed', effects: after.nodes, sources: after.sources};
}
