import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Effect, Option, Schema} from 'effect';
import {readDeadlineRemaining, type ReadDeadline} from '@threadnote/platform/read_deadline';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {FileUri, Position, observationKey, Capability, type Observation} from '@threadnote/semantic/contracts';
import {
  NAVIGATION_INPUT_LIMITS,
  navigationScopeKey,
  navigationSourceId,
  type NavigationAcquisition,
  type NavigationCandidate,
  type NavigationInput,
  type NavigationLink,
  type NavigationRole,
  type NavigationScope,
  type NavigationSource,
} from '@threadnote/context/navigation/model';
import type {SemanticContextSourceBindingV1} from '@threadnote/context/types';
import type {SemanticAgentQueryResult} from '../semantic/agent_query_protocol.js';

type CapabilityStatus = (typeof Capability.Type)['status'];

/** Navigation consumes only these read operations; every other operation stays outside this adapter. */
export type SemanticNavigationOperation = 'definition' | 'references' | 'call-hierarchy';

/** One observed document. Its disk binding comes only from the LSP-owned semantic-to-graph join. */
export interface SemanticNavigationDocument {
  /** Repository-relative POSIX path of the observed document. */
  readonly path: string;
  readonly observation: Observation;
  /** Result of retrieveSemanticContextSourceEvidence for this document; null when the join refused it. */
  readonly binding: SemanticContextSourceBindingV1 | null;
  /** Set when the join refused the document because LSP and graph line numbering can differ. */
  readonly refusal?: 'line-convention-unsupported';
  /** Key observed again after all queries; any difference (content, generation, epoch, view) is drift. */
  readonly closingObservationKey: string | null;
}

export interface SemanticNavigationQuery {
  readonly operation: SemanticNavigationOperation;
  /** Repository-relative path of the queried document. */
  readonly path: string;
  /** The structural candidate whose position was queried. */
  readonly anchorCandidateId: string;
  readonly capability: CapabilityStatus;
  readonly result: SemanticAgentQueryResult;
}

export interface SemanticNavigationEvidence {
  /** Canonical file URI of the repository root used by the semantic observations. */
  readonly worktreeUri: string;
  readonly documents: readonly SemanticNavigationDocument[];
  readonly queries: readonly SemanticNavigationQuery[];
  /** Gaps from acquisition itself, for example an exhausted parent deadline. */
  readonly gaps?: readonly string[];
}

const SemanticRangeJson = Schema.Struct({start: Position, end: Position});
type SemanticRangeJson = typeof SemanticRangeJson.Type;
const LocationJson = Schema.Union([
  Schema.Struct({uri: FileUri, range: SemanticRangeJson}),
  Schema.Struct({targetUri: FileUri, targetRange: SemanticRangeJson, targetSelectionRange: SemanticRangeJson}),
]);
const HierarchyItemJson = Schema.Struct({uri: FileUri, range: SemanticRangeJson, selectionRange: SemanticRangeJson});
const CallHierarchyJson = Schema.Struct({
  root: HierarchyItemJson,
  incoming: Schema.Array(Schema.Struct({from: HierarchyItemJson})),
  outgoing: Schema.Array(Schema.Struct({to: HierarchyItemJson})),
});
const decodeLocation = Schema.decodeUnknownOption(LocationJson);
const decodeCallHierarchy = Schema.decodeUnknownOption(CallHierarchyJson);

type UsableQuery = SemanticNavigationQuery & {
  readonly result: Extract<SemanticAgentQueryResult, {readonly status: 'ok'}>;
};
interface SemanticTarget {
  /** incoming: a caller of the anchor; outgoing: a callee; location: a definition or reference. */
  readonly direction: 'incoming' | 'outgoing' | 'location';
  readonly uri: string;
  readonly range: SemanticRangeJson;
}

/** Decode the provider items of one successful query once into target locations. */
function resultTargets(query: UsableQuery): {
  readonly targets: readonly SemanticTarget[];
  readonly unrecognized: boolean;
} {
  const targets: SemanticTarget[] = [];
  let unrecognized = false;
  for (const item of query.result.items) {
    if (query.operation === 'call-hierarchy') {
      const hierarchy = decodeCallHierarchy(item);
      if (Option.isNone(hierarchy)) unrecognized = true;
      else {
        for (const call of hierarchy.value.incoming)
          targets.push({direction: 'incoming', uri: call.from.uri, range: call.from.selectionRange});
        for (const call of hierarchy.value.outgoing)
          targets.push({direction: 'outgoing', uri: call.to.uri, range: call.to.selectionRange});
      }
      continue;
    }
    const location = decodeLocation(item);
    if (Option.isNone(location)) unrecognized = true;
    else if ('uri' in location.value)
      targets.push({direction: 'location', uri: location.value.uri, range: location.value.range});
    else
      targets.push({
        direction: 'location',
        uri: location.value.targetUri,
        range: location.value.targetSelectionRange,
      });
  }
  return {targets, unrecognized};
}
const usableQuery = (query: SemanticNavigationQuery): query is UsableQuery =>
  query.result.status === 'ok' && query.capability === 'qualified';

/** Observations that may be combined must share one project, configuration, provider generation and epoch. */
const projectObservationKey = (observation: Observation) =>
  JSON.stringify([
    observation.repository,
    observation.worktree,
    observation.project,
    observation.configuration,
    observation.toolchain,
    observation.provider.id,
    observation.provider.version,
    observation.provider.generation,
    observation.projectEpoch,
  ]);

interface Located {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Add reviewed semantic evidence to one structural navigation input without merging bases or views.
 *
 * - Only a 'qualified' capability creates qualified-semantic links; every other status is a limitation.
 * - A disk document joins the requested scope only through its LSP-owned binding to the same graph bytes.
 * - An unsaved-buffer document keeps its own view, so any route through it is a view conflict.
 * - Drift or mixed project observations discard the semantic facts and keep the structural route.
 * Imports and reads_or_writes stay structural; semantic links never add a possible effect.
 */
export function withSemanticNavigationEvidence(
  input: NavigationInput,
  evidence: SemanticNavigationEvidence,
): NavigationInput {
  const gaps = new Set([...(input.gaps ?? []), ...(evidence.gaps ?? [])]);
  const followUps: NavigationAcquisition[] = [...(input.followUps ?? [])];
  for (const query of evidence.queries) {
    if (query.result.status !== 'ok') gaps.add(`semantic-${query.result.status}`);
    else if (query.capability !== 'qualified') gaps.add('semantic-provider-unqualified');
  }
  const usable = EffectArray.filter(evidence.queries, usableQuery);
  if (usable.length === 0) return finish(input, gaps, followUps);

  const documents = new Map<string, SemanticNavigationDocument>();
  for (const document of evidence.documents) {
    if (documents.has(document.path)) {
      gaps.add('semantic-observation-conflict');
      return finish(input, gaps, followUps);
    }
    documents.set(document.path, document);
  }
  const projects = new Set(
    EffectArray.map(evidence.documents, document => projectObservationKey(document.observation)),
  );
  if (projects.size > 1) {
    gaps.add('semantic-observation-conflict');
    return finish(input, gaps, followUps);
  }

  const requestedScope = navigationScopeKey(input.scope);
  const structuralSources = new Map(EffectArray.map(input.sources, source => [source.id, source] as const));
  const requestedPathSource = new Map<string, NavigationSource>();
  for (const source of input.sources)
    if (navigationScopeKey(source) === requestedScope) requestedPathSource.set(source.path, source);

  // One semantic source per usable document, in the requested scope only when the disk join proved it.
  const semanticSources = new Map<string, NavigationSource>();
  const drifted = new Set<string>();
  for (const document of evidence.documents) {
    const key = observationKey(document.observation);
    if (document.closingObservationKey !== key) {
      drifted.add(document.path);
      gaps.add('semantic-observation-drift');
      continue;
    }
    const json = JSON.stringify(document.observation);
    if (document.observation.view.kind !== 'disk') {
      const scope: NavigationScope = {...input.scope, view: document.observation.view};
      semanticSources.set(document.path, {
        ...scope,
        id: semanticSourceId(scope, document.path, document.observation.content, key),
        path: document.path,
        contentHash: document.observation.content,
        freshness: 'unverified',
        semantic: {observationKey: key, observationJson: json},
      });
      gaps.add('semantic-buffer-view-unbound');
      continue;
    }
    if (document.refusal === 'line-convention-unsupported') {
      gaps.add('semantic-line-convention-unsupported');
      continue;
    }
    const graph = requestedPathSource.get(document.path);
    // The join must name this exact observation and the same graph repository, snapshot, path and bytes.
    if (
      document.binding === null ||
      document.binding.observation !== sha256HexSync(key) ||
      document.binding.semanticContent !== document.observation.content ||
      graph === undefined ||
      document.binding.graph.path !== document.path ||
      document.binding.graph.contentHash !== graph.contentHash ||
      document.binding.graph.repositoryId !== input.scope.repository ||
      document.binding.graph.snapshotId !== graph.snapshot
    ) {
      gaps.add('semantic-graph-source-unbound');
      continue;
    }
    semanticSources.set(document.path, {
      ...input.scope,
      id: semanticSourceId(input.scope, document.path, graph.contentHash, key),
      path: document.path,
      contentHash: graph.contentHash,
      freshness: 'verified-current',
      semantic: {observationKey: key, observationJson: json},
    });
  }

  const candidates: NavigationCandidate[] = [];
  const links: NavigationLink[] = [];
  const semanticCandidates = new Map<string, NavigationCandidate>();
  const inScopeCandidates = EffectArray.filter(input.candidates, candidate => {
    const source = structuralSources.get(candidate.sourceId);
    return source !== undefined && navigationScopeKey(source) === requestedScope;
  });
  const sourcePath = new Map(EffectArray.map(input.sources, source => [source.id, source.path] as const));
  /**
   * Attach a semantic location to one structural candidate in the same bound document.
   * - 'enclosing': the smallest candidate that contains the location (the referrer or incoming caller).
   * - 'declaration': only a candidate that starts on the location's line (a definition or outgoing callee);
   *   an enclosing class or module is not the defined symbol.
   * Two equal best candidates are ambiguous and the location is not attached.
   */
  const locate = (
    located: Located,
    match: 'enclosing' | 'declaration',
    role: NavigationRole,
    reason: string,
  ): NavigationCandidate | undefined => {
    const matching = EffectArray.filter(
      inScopeCandidates,
      candidate =>
        sourcePath.get(candidate.sourceId) === located.path &&
        (match === 'declaration'
          ? candidate.startLine === located.startLine
          : candidate.startLine <= located.startLine && candidate.endLine >= located.endLine),
    );
    const width = (candidate: NavigationCandidate) => candidate.endLine - candidate.startLine;
    const smallest = Math.min(...EffectArray.map(matching, width));
    const best = EffectArray.filter(matching, candidate => width(candidate) === smallest);
    if (best.length > 1) {
      gaps.add('semantic-attachment-ambiguous');
      return undefined;
    }
    if (best.length === 1) return best[0];
    const source = semanticSources.get(located.path);
    if (source === undefined) return undefined;
    const id = JSON.stringify(['semantic', source.id, located.startLine, located.endLine]);
    const existing = semanticCandidates.get(id);
    if (existing) return existing;
    if (input.candidates.length + candidates.length >= NAVIGATION_INPUT_LIMITS.candidates) {
      gaps.add('semantic-evidence-omitted');
      return undefined;
    }
    const candidate: NavigationCandidate = {
      id,
      sourceId: source.id,
      startLine: located.startLine,
      endLine: located.endLine,
      roles: [role],
      reason,
      relevance: 0,
      basis: ['qualified-semantic'],
      support: 'evidenced',
    };
    semanticCandidates.set(id, candidate);
    candidates.push(candidate);
    return candidate;
  };

  for (const query of usable) {
    const queried = documents.get(query.path);
    const proving = semanticSources.get(query.path);
    const anchor = EffectArray.findFirst(inScopeCandidates, candidate => candidate.id === query.anchorCandidateId);
    if (!queried || !proving || drifted.has(query.path) || Option.isNone(anchor)) {
      if (!queried || !proving) gaps.add('semantic-graph-source-unbound');
      if (Option.isNone(anchor)) gaps.add('semantic-anchor-unresolved');
      continue;
    }
    if (observationKey(query.result.evidence.observation) !== observationKey(queried.observation)) {
      gaps.add('semantic-observation-drift');
      continue;
    }
    if (query.result.next !== null || query.result.remaining > 0) gaps.add('semantic-results-truncated');
    const connect = (
      from: NavigationCandidate,
      to: NavigationCandidate,
      relation: NavigationLink['relation'],
      far: string,
    ) => {
      if (from.id === to.id) return;
      if (links.length + input.links.length >= NAVIGATION_INPUT_LIMITS.links) {
        gaps.add('semantic-evidence-omitted');
        return;
      }
      const farSource = semanticSources.get(far);
      // A far document without its own disk join may name a location, but it cannot verify a route.
      const verified =
        far === query.path || (farSource !== undefined && farSource.view.kind === 'disk' && !drifted.has(far));
      if (!verified) gaps.add('semantic-target-source-unbound');
      links.push({
        from: from.id,
        to: to.id,
        relation,
        basis: 'qualified-semantic',
        compatibility: verified ? 'verified' : 'unknown',
        reason: `Qualified semantic ${query.operation} result; this is a compiler relation, not an observed execution.`,
        observationSourceIds:
          farSource === undefined || farSource.id === proving.id ? [proving.id] : [proving.id, farSource.id],
      });
    };
    const located = (uri: string, range: SemanticRangeJson): Located | undefined => {
      const path = relativePath(evidence.worktreeUri, uri);
      if (path === undefined) {
        gaps.add('semantic-target-outside-worktree');
        return undefined;
      }
      return {path, startLine: range.start.line + 1, endLine: range.end.line + 1};
    };
    const {targets, unrecognized} = resultTargets(query);
    if (unrecognized) gaps.add('semantic-result-unrecognized');
    for (const target of targets) {
      const at = located(target.uri, target.range);
      if (!at) continue;
      if (target.direction === 'incoming') {
        const caller = locate(
          at,
          'enclosing',
          'entrypoint',
          'Qualified semantic incoming caller; runtime invocation is unknown.',
        );
        if (caller) connect(caller, anchor.value, 'calls', at.path);
      } else if (target.direction === 'outgoing') {
        const callee = locate(
          at,
          'declaration',
          'implementation',
          'Qualified semantic outgoing callee; runtime invocation is unknown.',
        );
        if (callee) connect(anchor.value, callee, 'calls', at.path);
      } else if (query.operation === 'definition') {
        const definition = locate(
          at,
          'declaration',
          'implementation',
          'Qualified semantic definition of the queried symbol.',
        );
        if (definition) connect(anchor.value, definition, 'references', at.path);
      } else {
        const referrer = locate(at, 'enclosing', 'entrypoint', 'Qualified semantic reference to the queried symbol.');
        if (referrer) connect(referrer, anchor.value, 'references', at.path);
      }
    }
  }

  for (const source of semanticSources.values())
    if (source.view.kind !== 'disk')
      followUps.push({
        kind: 'query',
        selector: `semantic disk ${source.path}`,
        reason:
          'Query the saved disk view so semantic and graph evidence can join; the buffer observation stays separate.',
      });
  return finish(input, gaps, followUps, [...semanticSources.values()], candidates, links);
}

function finish(
  input: NavigationInput,
  gaps: ReadonlySet<string>,
  followUps: readonly NavigationAcquisition[],
  sources: readonly NavigationSource[] = [],
  candidates: readonly NavigationCandidate[] = [],
  links: readonly NavigationLink[] = [],
): NavigationInput {
  const allSources = [...input.sources, ...sources];
  const limited = allSources.length > NAVIGATION_INPUT_LIMITS.sources;
  const keptSources = allSources.slice(0, NAVIGATION_INPUT_LIMITS.sources);
  const keptIds = new Set(EffectArray.map(keptSources, source => source.id));
  const keptCandidates = EffectArray.filter(candidates, candidate => keptIds.has(candidate.sourceId));
  const candidateIds = new Set(EffectArray.map([...input.candidates, ...keptCandidates], candidate => candidate.id));
  const keptLinks = EffectArray.filter(
    links,
    link =>
      candidateIds.has(link.from) &&
      candidateIds.has(link.to) &&
      EffectArray.every(link.observationSourceIds ?? [], id => keptIds.has(id)),
  );
  const allGaps = [...gaps, ...(limited ? ['semantic-evidence-omitted'] : [])];
  return {
    ...input,
    sources: keptSources,
    candidates: [...input.candidates, ...keptCandidates],
    links: [...input.links, ...keptLinks],
    gaps: [...new Set(allGaps)].sort(compareText).slice(0, NAVIGATION_INPUT_LIMITS.gaps),
    followUps: followUps.slice(0, NAVIGATION_INPUT_LIMITS.followUps),
  };
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function semanticSourceId(scope: NavigationScope, path: string, contentHash: string, key: string): string {
  return JSON.stringify(['semantic', navigationSourceId(scope, path, contentHash), key]);
}

/** Repository-relative POSIX path of a canonical file URI, or undefined outside the worktree. */
function relativePath(worktreeUri: string, uri: string): string | undefined {
  const root = EffectString.endsWith('/')(worktreeUri) ? worktreeUri : `${worktreeUri}/`;
  if (!EffectString.startsWith(root)(uri)) return undefined;
  const relative = decodeURIComponent(EffectString.slice(root.length)(uri));
  return relative === '' || EffectArray.contains(EffectString.split('/')(relative), '..') ? undefined : relative;
}

/** Narrow ports: the LSP owner's agent-query handler, disk join and document observation. */
export interface SemanticNavigationPorts<R> {
  /** Capability comes from the provider for the document's language, not from the operation alone. */
  readonly capability: (
    operation: SemanticNavigationOperation,
    path: string,
  ) => Effect.Effect<CapabilityStatus, never, R>;
  readonly query: (request: {
    readonly path: string;
    readonly operation: SemanticNavigationOperation;
    readonly position: {readonly line: number; readonly character: number};
    readonly milliseconds: number;
  }) => Effect.Effect<SemanticAgentQueryResult, never, R>;
  /** Observe one saved document; null when it is not observable. */
  readonly observe: (path: string, milliseconds: number) => Effect.Effect<Observation | null, never, R>;
  /**
   * The LSP-owned disk join for one observed document. A null binding is a refusal; `refusal` names the
   * line-convention case (a lone CR, U+2028 or U+2029), where LSP and graph line numbers can differ.
   */
  readonly bind: (
    path: string,
    observation: Observation,
  ) => Effect.Effect<
    {readonly binding: SemanticContextSourceBindingV1 | null; readonly refusal?: 'line-convention-unsupported'},
    never,
    R
  >;
}

export interface SemanticNavigationAnchor {
  readonly candidateId: string;
  readonly path: string;
  /** Zero-based LSP position of the anchor symbol. */
  readonly position: {readonly line: number; readonly character: number};
}

/**
 * Minimum time for one coordinator request or observation. Each request has host overhead (configuration check
 * and candidate fence, about 0.2-0.3 s) before the provider sees it; a shorter request only spends budget.
 */
const MINIMUM_REQUEST_MILLISECONDS = 500;
/** Queried plus far-end documents observed for one answer. */
const MAXIMUM_DOCUMENTS = 3;
/** Anchors queried for one answer; the rest of the document budget is for far-end documents. */
const MAXIMUM_ANCHORS = 2;

/**
 * Acquire semantic navigation evidence inside the parent's remaining deadline. Optional semantic work never
 * extends the parent budget: when time is short it stops with a gap, and the structural route stays useful.
 * Each document is observed, bound and observed again after all queries, so drift during the request is visible.
 * Time for the closing observations is reserved before any query starts, so a slow query cannot consume it.
 */
export const acquireSemanticNavigationEvidence = Effect.fn('navigation.acquireSemanticEvidence')(function* <R>(input: {
  readonly worktreeUri: string;
  readonly anchors: readonly SemanticNavigationAnchor[];
  readonly operations: readonly SemanticNavigationOperation[];
  readonly deadline: ReadDeadline;
  readonly ports: SemanticNavigationPorts<R>;
}) {
  const gaps = new Set<string>();
  const queries: SemanticNavigationQuery[] = [];
  const opening = new Map<string, Observation>();
  /** Remaining time after reserving `reserved` closing observations, or undefined below one request floor. */
  const available = (reserved: number) =>
    Effect.map(readDeadlineRemaining(input.deadline), left => {
      const usable = left - reserved * MINIMUM_REQUEST_MILLISECONDS;
      return usable < MINIMUM_REQUEST_MILLISECONDS ? undefined : usable;
    });
  const capabilities = new Map<string, CapabilityStatus>();
  outer: for (const anchor of input.anchors.slice(0, MAXIMUM_ANCHORS))
    for (const operation of input.operations) {
      const left = yield* available(MAXIMUM_DOCUMENTS);
      if (left === undefined) {
        gaps.add('semantic-deadline-exhausted');
        break outer;
      }
      const capabilityKey = JSON.stringify([operation, anchor.path]);
      const capability = capabilities.get(capabilityKey) ?? (yield* input.ports.capability(operation, anchor.path));
      capabilities.set(capabilityKey, capability);
      if (capability === 'unsupported' || capability === 'deferred' || capability === 'prerequisite-blocked') {
        gaps.add(`semantic-capability-${capability}`);
        continue;
      }
      const result = yield* input.ports.query({
        path: anchor.path,
        operation,
        position: anchor.position,
        milliseconds: left,
      });
      queries.push({operation, path: anchor.path, anchorCandidateId: anchor.candidateId, capability, result});
      if (result.status === 'ok' && !opening.has(anchor.path)) opening.set(anchor.path, result.evidence.observation);
    }
  // Far-end documents need their own observation and disk join before a cross-file route can be verified.
  for (const path of farPaths(input.worktreeUri, queries)) {
    if (opening.size >= MAXIMUM_DOCUMENTS || opening.has(path)) continue;
    // Keep one closing observation for every document opened so far and for this one.
    const left = yield* available(opening.size + 1);
    if (left === undefined) {
      gaps.add('semantic-deadline-exhausted');
      break;
    }
    const observation = yield* input.ports.observe(path, left);
    if (observation !== null) opening.set(path, observation);
  }
  const documents: SemanticNavigationDocument[] = [];
  for (const [path, observation] of opening) {
    if (observation.view.kind !== 'disk') {
      documents.push({path, observation, binding: null, closingObservationKey: null});
      continue;
    }
    const joined = yield* input.ports.bind(path, observation);
    documents.push({
      path,
      observation,
      binding: joined.binding,
      ...(joined.refusal === undefined ? {} : {refusal: joined.refusal}),
      closingObservationKey: null,
    });
  }
  // The closing observations run last, after every query and join, so any drift in between is detected.
  const closed: SemanticNavigationDocument[] = [];
  for (const [index, document] of documents.entries()) {
    const left = yield* available(documents.length - index - 1);
    const closing = left === undefined ? null : yield* input.ports.observe(document.path, left);
    if (left === undefined) gaps.add('semantic-deadline-exhausted');
    closed.push({...document, closingObservationKey: closing === null ? null : observationKey(closing)});
  }
  return {
    worktreeUri: input.worktreeUri,
    documents: closed,
    queries,
    gaps: [...gaps],
  } satisfies SemanticNavigationEvidence;
});

function farPaths(worktreeUri: string, queries: readonly SemanticNavigationQuery[]): readonly string[] {
  const paths = new Set<string>();
  for (const query of EffectArray.filter(queries, usableQuery))
    for (const target of resultTargets(query).targets) {
      const path = relativePath(worktreeUri, target.uri);
      if (path !== undefined) paths.add(path);
    }
  return [...paths].sort(compareText);
}
