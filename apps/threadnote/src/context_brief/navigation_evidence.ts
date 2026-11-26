import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Effect, Option, Schema} from 'effect';
import {readDeadlineRemaining, type ReadDeadline} from '@threadnote/platform/read_deadline';
import {FileUri, Position, observationKey, Capability, type Observation} from '@threadnote/semantic/contracts';
import {
  NAVIGATION_INPUT_LIMITS,
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
  const usable = EffectArray.filter(
    evidence.queries,
    query => query.result.status === 'ok' && query.capability === 'qualified',
  );
  if (usable.length === 0) return finish(input, gaps, followUps, [], [], []);

  const documents = new Map<string, SemanticNavigationDocument>();
  for (const document of evidence.documents) {
    if (documents.has(document.path)) {
      gaps.add('semantic-observation-conflict');
      return finish(input, gaps, followUps, [], [], []);
    }
    documents.set(document.path, document);
  }
  const projects = new Set(
    EffectArray.map(evidence.documents, document => projectObservationKey(document.observation)),
  );
  if (projects.size > 1) {
    gaps.add('semantic-observation-conflict');
    return finish(input, gaps, followUps, [], [], []);
  }

  const structuralSources = new Map(EffectArray.map(input.sources, source => [source.id, source] as const));
  const requestedPathHash = new Map<string, string>();
  for (const source of input.sources)
    if (sameScope(source, input.scope)) requestedPathHash.set(source.path, source.contentHash);

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
    const graphHash = requestedPathHash.get(document.path);
    if (
      document.binding === null ||
      document.binding.graph.path !== document.path ||
      document.binding.semanticContent !== document.observation.content ||
      graphHash === undefined ||
      document.binding.graph.contentHash !== graphHash
    ) {
      gaps.add('semantic-graph-source-unbound');
      continue;
    }
    semanticSources.set(document.path, {
      ...input.scope,
      id: semanticSourceId(input.scope, document.path, graphHash, key),
      path: document.path,
      contentHash: graphHash,
      freshness: 'verified-current',
      semantic: {observationKey: key, observationJson: json},
    });
  }

  const candidates: NavigationCandidate[] = [];
  const links: NavigationLink[] = [];
  const semanticCandidates = new Map<string, NavigationCandidate>();
  const inScopeCandidates = EffectArray.filter(input.candidates, candidate => {
    const source = structuralSources.get(candidate.sourceId);
    return source !== undefined && sameScope(source, input.scope);
  });
  const sourcePath = new Map(EffectArray.map(input.sources, source => [source.id, source.path] as const));
  const locate = (located: Located, role: NavigationRole, reason: string): NavigationCandidate | undefined => {
    const containing = EffectArray.filter(
      inScopeCandidates,
      candidate =>
        sourcePath.get(candidate.sourceId) === located.path &&
        candidate.startLine <= located.startLine &&
        candidate.endLine >= located.endLine,
    ).sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) || compareText(left.id, right.id),
    );
    if (containing.length) return containing[0];
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
    if (query.result.status !== 'ok') continue;
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
    for (const item of query.result.items) {
      if (query.operation === 'call-hierarchy') {
        const hierarchy = decodeCallHierarchy(item);
        if (Option.isNone(hierarchy)) {
          gaps.add('semantic-result-unrecognized');
          continue;
        }
        for (const call of hierarchy.value.incoming) {
          const at = located(call.from.uri, call.from.selectionRange);
          const caller =
            at && locate(at, 'entrypoint', 'Qualified semantic incoming caller; runtime invocation is unknown.');
          if (at && caller) connect(caller, anchor.value, 'calls', at.path);
        }
        for (const call of hierarchy.value.outgoing) {
          const at = located(call.to.uri, call.to.selectionRange);
          const callee =
            at && locate(at, 'implementation', 'Qualified semantic outgoing callee; runtime invocation is unknown.');
          if (at && callee) connect(anchor.value, callee, 'calls', at.path);
        }
        continue;
      }
      const location = decodeLocation(item);
      if (Option.isNone(location)) {
        gaps.add('semantic-result-unrecognized');
        continue;
      }
      const value = location.value;
      const at =
        'uri' in value ? located(value.uri, value.range) : located(value.targetUri, value.targetSelectionRange);
      if (!at) continue;
      if (query.operation === 'definition') {
        const definition = locate(at, 'implementation', 'Qualified semantic definition of the queried symbol.');
        if (definition) connect(anchor.value, definition, 'references', at.path);
      } else {
        const referrer = locate(at, 'entrypoint', 'Qualified semantic reference to the queried symbol.');
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
  return finish(
    input,
    gaps,
    followUps,
    [...semanticSources.values()],
    candidates,
    EffectArray.filter(links, link => link.from !== link.to),
  );
}

function finish(
  input: NavigationInput,
  gaps: ReadonlySet<string>,
  followUps: readonly NavigationAcquisition[],
  sources: readonly NavigationSource[],
  candidates: readonly NavigationCandidate[],
  links: readonly NavigationLink[],
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

function sameScope(source: NavigationScope, scope: NavigationScope): boolean {
  return (
    source.repository === scope.repository &&
    source.worktree === scope.worktree &&
    source.project === scope.project &&
    source.view.kind === scope.view.kind &&
    source.view.id === scope.view.id &&
    source.view.owner === scope.view.owner &&
    source.view.epoch === scope.view.epoch
  );
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
  readonly capability: (operation: SemanticNavigationOperation) => Effect.Effect<CapabilityStatus, never, R>;
  readonly query: (request: {
    readonly path: string;
    readonly operation: SemanticNavigationOperation;
    readonly position: {readonly line: number; readonly character: number};
    readonly milliseconds: number;
  }) => Effect.Effect<SemanticAgentQueryResult, never, R>;
  /** Observe one saved document; null when it is not observable. */
  readonly observe: (path: string, milliseconds: number) => Effect.Effect<Observation | null, never, R>;
  /** The LSP-owned disk join for one observed document; null when it refuses the binding. */
  readonly bind: (
    path: string,
    observation: Observation,
  ) => Effect.Effect<SemanticContextSourceBindingV1 | null, never, R>;
}

export interface SemanticNavigationAnchor {
  readonly candidateId: string;
  readonly path: string;
  /** Zero-based LSP position of the anchor symbol. */
  readonly position: {readonly line: number; readonly character: number};
}

/** Below this remaining time no semantic request starts; the parent route is returned as is. */
const MINIMUM_QUERY_MILLISECONDS = 50;
/** Queried plus far-end documents observed for one answer. */
const MAXIMUM_DOCUMENTS = 3;

/**
 * Acquire semantic navigation evidence inside the parent's remaining deadline. Optional semantic work never
 * extends the parent budget: when time is short it stops with a gap, and the structural route stays useful.
 * Each document is observed, bound and observed again after all queries, so drift during the request is visible.
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
  const startable = Effect.map(readDeadlineRemaining(input.deadline), left =>
    left < MINIMUM_QUERY_MILLISECONDS ? undefined : left,
  );
  outer: for (const anchor of input.anchors.slice(0, 2))
    for (const operation of input.operations) {
      const left = yield* startable;
      if (left === undefined) {
        gaps.add('semantic-deadline-exhausted');
        break outer;
      }
      const capability = yield* input.ports.capability(operation);
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
    const left = yield* startable;
    if (left === undefined) {
      gaps.add('semantic-deadline-exhausted');
      break;
    }
    const observation = yield* input.ports.observe(path, left);
    if (observation !== null) opening.set(path, observation);
  }
  const documents: SemanticNavigationDocument[] = [];
  for (const [path, observation] of opening) {
    const left = yield* startable;
    if (left === undefined) {
      gaps.add('semantic-deadline-exhausted');
      break;
    }
    const binding = observation.view.kind === 'disk' ? yield* input.ports.bind(path, observation) : null;
    documents.push({path, observation, binding, closingObservationKey: null});
  }
  // The closing observations run last, after every query and join, so any drift in between is detected.
  const closed: SemanticNavigationDocument[] = [];
  for (const document of documents) {
    const left = yield* startable;
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
  const add = (uri: string) => {
    const path = relativePath(worktreeUri, uri);
    if (path !== undefined) paths.add(path);
  };
  for (const query of queries) {
    if (query.result.status !== 'ok') continue;
    for (const item of query.result.items) {
      if (query.operation === 'call-hierarchy') {
        const hierarchy = decodeCallHierarchy(item);
        if (Option.isNone(hierarchy)) continue;
        for (const call of hierarchy.value.incoming) add(call.from.uri);
        for (const call of hierarchy.value.outgoing) add(call.to.uri);
        continue;
      }
      const location = decodeLocation(item);
      if (Option.isSome(location)) add('uri' in location.value ? location.value.uri : location.value.targetUri);
    }
  }
  return [...paths].sort(compareText);
}
