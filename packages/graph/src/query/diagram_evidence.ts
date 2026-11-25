import {Array as Arr, Clock, Effect, Option, Schema, String as Str} from 'effect';
import {codeGraphCitationSourceKey, readCodeGraphCitationSources} from '../citation/source.js';
import {compareCodeUnits} from '../ordering.js';
import {withCodeGraphReadTransaction} from '../store/session.js';
import type {CodeGraphStoreShape} from '../store.js';
import {TYPESCRIPT_FULL_TRAVERSAL_UTF8_BYTE_LIMIT} from '../typescript_runtime.js';
import type {
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphQueryNode,
  CodeGraphRelation,
  CodeGraphSnapshot,
  CodeGraphStatus,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '../types.js';
import {
  completeDiagramFact,
  completeDiagramSubject,
  describeCodeGraphDiagramQuestion,
  diagramClarificationCandidate,
  diagramEndpoint,
  diagramFileOverview,
  diagramTopicSearchTerms,
  DIAGRAM_ARCHITECTURE_RELATIONS,
  DIAGRAM_PROJECT_RETRY,
  hasDiagramSourceSpan,
  isDiagramComponentKind,
  isDiagramMemberKind,
  isDiagramOwnershipRelation,
  isDiagramTypeKind,
  rankCodeGraphDiagramSubject,
  rankCodeGraphDiagramTopicFallback,
  renderCompleteCodeGraphDiagram,
  selectDiagramPath,
  wantsSourceBackedSequence,
  type CodeGraphDiagramFact,
  type CodeGraphDiagramQuestion,
} from './diagram.js';
import {CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH} from './diagram_contract.js';
import type {
  CodeGraphDiagramCoverage,
  CodeGraphDiagramFreshness,
  CodeGraphDiagramResult,
  CodeGraphDiagramScope,
  CodeGraphDiagramType,
} from './diagram_contract.js';
import {isStableCodeGraphNodeId, parseCodeGraphEndpointSelector} from './selector.js';

export interface CodeGraphDiagramRequest {
  readonly question: string;
  readonly diagramType?: CodeGraphDiagramType;
  readonly packageName?: string;
  readonly timeoutMilliseconds?: number;
}

interface DiagramSnapshotRequest extends CodeGraphDiagramRequest {
  readonly scope: CodeGraphDiagramScope;
  readonly freshness: CodeGraphDiagramFreshness;
  readonly partialProject?: boolean;
  /** Identity verified for the caller's selected checkout. */
  readonly sourceIdentity?: RepositoryIdentity;
}

type DiagramStore = Pick<
  CodeGraphStoreShape,
  | 'withSession'
  | 'readySnapshotById'
  | 'diagramAdjacentCandidates'
  | 'diagramAdjacentPage'
  | 'diagramSubjectPage'
  | 'effectiveSnapshotFilesByPaths'
  | 'symbolsByIds'
>;
type Boundary = CodeGraphDiagramCoverage['boundaries'][number];
type Gap = CodeGraphDiagramCoverage['gaps'][number];
type Direction = 'incoming' | 'outgoing';
type BehaviorEvidence = 'resolved' | 'unresolved' | 'none';
type Rank = NonNullable<ReturnType<typeof rankCodeGraphDiagramSubject>>;
type RankedSubject = {readonly node: CodeGraphQueryNode; readonly rank: Rank};
type Work = {readonly node: CodeGraphQueryNode; readonly direction: Direction};
type EvidencePage = (
  work: Work,
  afterId: string,
  limit: number,
) => Effect.Effect<{readonly edges: readonly CodeGraphEdge[]; readonly nextCursor?: string}, unknown>;

const PAGE_SIZE = 128;
const READ_TIMEOUT_MILLISECONDS = 40_000;
const BEHAVIOR_INCOMING = ['calls', 'constructs'] as const;
const BEHAVIOR_OUTGOING = [...BEHAVIOR_INCOMING, 'contains', 'declares'] as const;
const TYPE_INCOMING = ['extends', 'implements', 'overrides'] as const;
const TYPE_OUTGOING = [...TYPE_INCOMING, 'contains', 'declares', 'references'] as const;
const ARCHITECTURE_FILE_RELATIONS = [...DIAGRAM_ARCHITECTURE_RELATIONS, 'contains', 'declares'] as const;
const FILE_OVERVIEW_RELATIONS = [...ARCHITECTURE_FILE_RELATIONS, ...BEHAVIOR_INCOMING] as const;
const CALLABLES = new Set([
  'function',
  'method',
  'constructor',
  'function_declaration',
  'function_definition',
  'method_declaration',
  'method_definition',
  'macro',
  'init',
  'initializer',
  'lambda',
  'callback',
  'closure',
]);
const BRIDGES = new Set(['assignment', 'callback', 'closure', 'initializer', 'lambda', 'variable']);
const EXTERNAL = /^(?:node:|npm:|https?:\/\/|@@?[^/\s]+\/\/)/u;

class DiagramReadExpired extends Schema.TaggedError<DiagramReadExpired, {readonly brand: unique symbol}>()(
  'DiagramReadExpired',
  {},
) {}

function isArchitectureFile(node: CodeGraphSymbol): boolean {
  return node.kind === 'module' || node.kind === 'file';
}

function directionsFor(question: CodeGraphDiagramQuestion): readonly Direction[] {
  if (question.incoming) {
    return question.domain === 'behavior' && !question.outgoingBehavior ? ['incoming'] : ['incoming', 'outgoing'];
  }
  return question.domain === 'types' && question.inheritance ? ['outgoing', 'incoming'] : ['outgoing'];
}

function relationsFor(question: CodeGraphDiagramQuestion, work: Work): readonly CodeGraphRelation[] {
  const {node, direction} = work;
  switch (question.domain) {
    case 'types':
      return direction === 'incoming' ? TYPE_INCOMING : TYPE_OUTGOING;
    case 'architecture':
      return direction === 'outgoing' && isArchitectureFile(node)
        ? ARCHITECTURE_FILE_RELATIONS
        : DIAGRAM_ARCHITECTURE_RELATIONS;
    case 'behavior':
      if (direction === 'incoming') {
        return BRIDGES.has(node.kind) || node.kind === 'constructor' ? BEHAVIOR_OUTGOING : BEHAVIOR_INCOMING;
      }
      return CALLABLES.has(node.kind) ||
        BRIDGES.has(node.kind) ||
        isDiagramComponentKind(node.kind) ||
        isDiagramTypeKind(node.kind)
        ? BEHAVIOR_OUTGOING
        : BEHAVIOR_INCOMING;
  }
}

function owns(parent: CodeGraphSymbol, child: CodeGraphSymbol): boolean {
  const a = parent.span;
  const b = child.span;
  return (
    parent.path === child.path &&
    (a.line < b.line || (a.line === b.line && a.column <= b.column)) &&
    (a.endLine > b.endLine || (a.endLine === b.endLine && a.endColumn >= b.endColumn))
  );
}

function allowsBridge(parent: CodeGraphSymbol, child: CodeGraphSymbol): boolean {
  if (!owns(parent, child)) return false;
  if (parent.kind === 'class' || parent.kind === 'struct') return child.kind === 'constructor';
  if (CALLABLES.has(parent.kind) || BRIDGES.has(parent.kind) || isDiagramComponentKind(parent.kind))
    return BRIDGES.has(child.kind);
  return false;
}

function followsOwnedBehavior(
  question: CodeGraphDiagramQuestion,
  subject: CodeGraphSymbol,
  parent: CodeGraphSymbol,
  child: CodeGraphSymbol,
): boolean {
  return (
    allowsBridge(parent, child) ||
    (question.path === undefined &&
      parent.id === subject.id &&
      (subject.kind === 'class' || subject.kind === 'struct') &&
      CALLABLES.has(child.kind))
  );
}

function eligible(
  question: CodeGraphDiagramQuestion,
  work: Work,
  edge: CodeGraphEdge,
  peer?: CodeGraphSymbol,
): boolean {
  const {node} = work;
  if (question.domain === 'behavior') {
    if (!isDiagramOwnershipRelation(edge.relation)) return true;
    if (!peer) return false;
    if (work.direction === 'incoming') return allowsBridge(peer, node);
    return owns(node, peer) && (allowsBridge(node, peer) || CALLABLES.has(peer.kind));
  }
  if (question.domain === 'types') {
    if (isDiagramOwnershipRelation(edge.relation))
      return peer !== undefined && owns(node, peer) && (isDiagramTypeKind(peer.kind) || isDiagramMemberKind(peer.kind));
    if (edge.relation === 'references')
      return (
        (!peer || isDiagramTypeKind(peer.kind)) && (isDiagramTypeKind(node.kind) || isDiagramMemberKind(node.kind))
      );
    return true;
  }
  if (isDiagramOwnershipRelation(edge.relation)) {
    return (
      isArchitectureFile(node) && peer?.kind === 'config' && peer.path === node.path && edge.evidencePath === node.path
    );
  }
  return (
    isDiagramComponentKind(node.kind) &&
    (!peer || isDiagramComponentKind(peer.kind) || boundaryKind('', peer) !== undefined)
  );
}

function boundaryKind(targetName: string, peer?: CodeGraphSymbol): Boundary['kind'] | undefined {
  if (peer?.kind === 'outside-scope' || peer?.kind === 'out_of_scope') return 'outside-scope';
  if (
    peer?.kind === 'external' ||
    (peer !== undefined && Str.startsWith('external_')(peer.kind)) ||
    peer?.kind === 'workspace-external-dependency'
  ) {
    return 'external';
  }
  return !peer && EXTERNAL.test(targetName) ? 'external' : undefined;
}

function endpointPlaceholder(
  edge: CodeGraphEdge,
  label: string,
  kind: Boundary['kind'] | 'unresolved',
): CodeGraphQueryNode {
  return {
    id: `${kind === 'unresolved' ? 'unresolved' : 'boundary'}:${edge.id}`,
    name: label,
    qualifiedName: label,
    kind,
    path: edge.evidencePath,
    span: edge.evidenceSpan,
    contentHash: '',
    exported: false,
    language: '',
    score: 0,
  };
}

function unresolvedCall(edge: CodeGraphEdge, work: Work) {
  if (
    work.direction !== 'outgoing' ||
    edge.targetId !== undefined ||
    (edge.relation !== 'calls' && edge.relation !== 'constructs')
  )
    return undefined;
  const placeholder = endpointPlaceholder(edge, edge.targetName, 'unresolved');
  const fact = completeDiagramFact(edge, work.node.id, placeholder.id);
  return fact ? {placeholder, fact: {...fact, provenance: 'syntactic' as const}} : undefined;
}

function site(edge: CodeGraphEdge, label: string) {
  return {
    label,
    edgeId: edge.id,
    ...(hasDiagramSourceSpan(edge.evidencePath, edge.evidenceSpan)
      ? {path: edge.evidencePath, span: edge.evidenceSpan}
      : {}),
  };
}

function compareRank(left: Rank, right: Rank): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function asNode(symbol: CodeGraphSymbol): CodeGraphQueryNode {
  return {...symbol, score: 0};
}

function coverage(
  completeness: CodeGraphDiagramCoverage['completeness'],
  boundaries: ReadonlyMap<string, Boundary>,
  gaps: ReadonlyMap<string, Gap>,
  subject?: CodeGraphQueryNode,
): CodeGraphDiagramCoverage {
  return {
    completeness,
    ...(subject ? {subject: completeDiagramSubject(subject)} : {}),
    boundaries: [...boundaries.values()],
    gaps: [...gaps.values()],
  };
}

function collectBridges(
  parentsByChild: ReadonlyMap<string, readonly CodeGraphDiagramFact[]>,
  contributing: Set<string>,
  facts: Map<string, CodeGraphDiagramFact>,
): void {
  for (const id of contributing) {
    for (const edge of parentsByChild.get(id) ?? []) {
      facts.set(edge.id, edge);
      contributing.add(edge.sourceId);
    }
  }
}

const readVerifiedSequenceSource = Effect.fn('codeGraph.readVerifiedSequenceSource')(function* (
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  file: CodeGraphInventoryFile,
) {
  const committed = file.source === 'commit';
  if (!committed && identity.worktreeId !== snapshot.worktreeId) return undefined;
  const request = {expectedContentHash: file.contentHash, repositoryPath: file.path, requireBytes: true};
  const verified = yield* readCodeGraphCitationSources({
    allowCommitFallback: committed,
    commitOnly: committed,
    objectFormat: identity.objectFormat,
    retainedBytesLimit: TYPESCRIPT_FULL_TRAVERSAL_UTF8_BYTE_LIMIT,
    repositoryRoot: identity.repoRoot,
    sourceCommit: snapshot.commit,
    sources: [request],
  });
  const bytes = verified.get(codeGraphCitationSourceKey(request));
  return bytes === undefined ? undefined : new Map([[file.path, bytes]]);
});

/** Read authorized graph facts in one transaction. The caller owns the lease through source reads. */
export const readCodeGraphDiagram = Effect.fn('codeGraph.readDiagram')(function* (
  store: DiagramStore,
  databasePath: string,
  input: DiagramSnapshotRequest,
) {
  const {scope, freshness} = input;
  const base = {scope, freshness, limits: freshness === 'current' ? [] : [`Snapshot freshness is ${freshness}.`]};
  const boundaries = new Map<string, Boundary>();
  const gaps = new Map<string, Gap>();
  const noEvidence = (message: string, nextAction: string): CodeGraphDiagramResult => ({
    ...base,
    status: 'unavailable',
    coverage: coverage('undetermined', boundaries, gaps),
    message,
    nextAction,
  });
  const questionText = Str.trim(input.question);
  if (!questionText || questionText.length > CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH) {
    return noEvidence(
      `The diagram question must contain between 1 and ${CODE_GRAPH_DIAGRAM_QUESTION_MAXIMUM_LENGTH} characters.`,
      'Name a subject in the selected graph.',
    );
  }
  const question = describeCodeGraphDiagramQuestion(questionText, input.diagramType);
  if (question.malformedPath) {
    return noEvidence(
      'The call path needs one source and one target.',
      'Ask for the call path from one indexed symbol to another.',
    );
  }
  if (!question.terms.length && !question.topic.length && question.path === undefined) {
    return noEvidence(
      'The diagram question has no named subject.',
      'Name a symbol, package, or path in the selected graph.',
    );
  }
  const deadline =
    (yield* Clock.currentTimeMillis) + Math.max(1, input.timeoutMilliseconds ?? READ_TIMEOUT_MILLISECONDS);
  const withinRead = <A, E, R>(read: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return yield* DiagramReadExpired.make({});
      return yield* read.pipe(Effect.timeout(remaining));
    });
  const readPage = (work: Work, relations: readonly CodeGraphRelation[], afterId: string, limit: number) =>
    withinRead(
      store.diagramAdjacentPage(
        databasePath,
        scope.snapshotId,
        work.node.id,
        work.direction,
        relations,
        afterId,
        limit,
      ),
    );
  const pageFor = (selection: CodeGraphDiagramQuestion, work: Work, afterId: string, limit: number) =>
    readPage(work, relationsFor(selection, work), afterId, limit);
  const page: EvidencePage = (work, afterId, limit) => pageFor(question, work, afterId, limit);
  const subjectQuery = question.topic.length ? {...question, domain: 'behavior' as const} : question;
  const initialDirections = directionsFor(question);
  const subjectDirections = directionsFor(subjectQuery);
  const behaviorEvidence = (candidate: CodeGraphQueryNode, direction: Direction) =>
    Effect.gen(function* () {
      if (!hasDiagramSourceSpan(candidate.path, candidate.span)) return 'none' as const;
      const pending = new Map([[candidate.id, candidate]]);
      let hasUnresolved = false;
      for (const node of pending.values()) {
        const work = {node, direction};
        let cursor = '';
        for (;;) {
          const {edges, nextCursor} = yield* pageFor(subjectQuery, work, cursor, PAGE_SIZE);
          const peerIds = Arr.flatMap(edges, edge => {
            const id = oppositeId(edge, work.direction);
            return id === undefined ? [] : [id];
          });
          const peers = peerIds.length
            ? yield* withinRead(store.symbolsByIds(databasePath, scope.snapshotId, peerIds))
            : [];
          const byId = new Map(Arr.map(peers, peer => [peer.id, peer] as const));
          for (const edge of edges) {
            const peerId = oppositeId(edge, work.direction);
            const peer = peerId ? byId.get(peerId) : undefined;
            if (!eligible(subjectQuery, work, edge, peer)) continue;
            const label = work.direction === 'outgoing' ? edge.targetName : edge.sourceName;
            const boundary = boundaryKind(label, peer);
            const visiblePeer =
              boundary && (!peer || boundary === 'outside-scope') ? endpointPlaceholder(edge, label, boundary) : peer;
            if (!visiblePeer) {
              hasUnresolved ||= unresolvedCall(edge, work) !== undefined;
              continue;
            }
            if (
              !hasDiagramSourceSpan(visiblePeer.path, visiblePeer.span) ||
              !completeDiagramFact(
                edge,
                work.direction === 'outgoing' ? node.id : visiblePeer.id,
                work.direction === 'outgoing' ? visiblePeer.id : node.id,
              )
            )
              continue;
            if (work.direction === 'incoming' || !isDiagramOwnershipRelation(edge.relation)) return 'resolved' as const;
            if (followsOwnedBehavior(subjectQuery, candidate, node, visiblePeer) && !pending.has(visiblePeer.id)) {
              pending.set(visiblePeer.id, asNode(visiblePeer));
            }
          }
          if (nextCursor === undefined) break;
          cursor = nextCursor;
        }
      }
      return hasUnresolved ? ('unresolved' as const) : ('none' as const);
    });
  const selectRelevantBehaviorSubjects = (ranked: RankedSubject[]) =>
    Effect.gen(function* () {
      ranked.sort((left, right) => compareRank(right.rank, left.rank) || compareCodeUnits(left.node.id, right.node.id));
      const first = ranked[0];
      if (!first) return [];
      const supported: CodeGraphQueryNode[] = [];
      const unresolved: CodeGraphQueryNode[] = [];
      let supportedRank: Rank | undefined;
      let unresolvedRank: Rank | undefined;
      for (const batch of Arr.chunksOf(ranked, PAGE_SIZE)) {
        if (supportedRank && compareRank(batch[0].rank, supportedRank) < 0) break;
        const nodeIds = Arr.map(batch, ({node}) => node.id);
        const anchorSets = yield* Effect.forEach(subjectDirections, direction =>
          withinRead(
            store.diagramAdjacentCandidates(databasePath, scope.snapshotId, nodeIds, direction, BEHAVIOR_OUTGOING),
          ).pipe(Effect.map(ids => ({direction, anchors: new Set(ids)}))),
        );
        for (const {node, rank} of batch) {
          if (supportedRank && compareRank(rank, supportedRank) < 0) break;
          let evidence: BehaviorEvidence = 'none';
          for (const {direction, anchors} of anchorSets) {
            if (!anchors.has(node.id)) continue;
            const found = yield* behaviorEvidence(node, direction);
            if (found === 'none') continue;
            evidence = found;
            if (evidence === 'resolved') break;
          }
          if (evidence === 'resolved') {
            supportedRank = rank;
            supported.push(node);
          } else if (evidence === 'unresolved' && (!unresolvedRank || compareRank(rank, unresolvedRank) === 0)) {
            unresolvedRank = rank;
            unresolved.push(node);
          }
        }
      }
      if (supported.length) return supported;
      if (unresolved.length) return unresolved;
      return Arr.map(
        Arr.takeWhile(ranked, ({rank}) => compareRank(rank, first.rank) === 0),
        ({node}) => node,
      );
    });
  const nodes = new Map<string, CodeGraphQueryNode>();
  const boundaryIds = new Set<string>();
  const facts = new Map<string, CodeGraphDiagramFact>();
  const unresolvedCalls = new Map<string, CodeGraphDiagramFact>();
  const parentsByChild = new Map<string, CodeGraphDiagramFact[]>();
  const contributing = new Set<string>();
  let subject: CodeGraphQueryNode | undefined;
  let pathTarget: CodeGraphQueryNode | undefined;
  let architectureAnchor: CodeGraphDiagramFact | undefined;
  const findContainingModule = (start: CodeGraphQueryNode) =>
    Effect.gen(function* () {
      const pending = [start];
      const visited = new Set([start.id]);
      let anchor: CodeGraphDiagramFact | undefined;
      for (const child of pending) {
        let cursor = '';
        for (;;) {
          const {edges, nextCursor} = yield* withinRead(
            store.diagramAdjacentPage(
              databasePath,
              scope.snapshotId,
              child.id,
              'incoming',
              ['contains', 'declares'],
              cursor,
              PAGE_SIZE,
            ),
          );
          const ownerIds = Arr.flatMap(edges, edge => (edge.sourceId ? [edge.sourceId] : []));
          const owners = yield* withinRead(store.symbolsByIds(databasePath, scope.snapshotId, ownerIds));
          const byId = new Map(Arr.map(owners, owner => [owner.id, owner] as const));
          for (const edge of edges) {
            const owner = edge.sourceId ? byId.get(edge.sourceId) : undefined;
            if (!owner || owner.path !== start.path || edge.evidencePath !== start.path) continue;
            const fact = completeDiagramFact(edge, owner.id, child.id);
            if (!fact) continue;
            if (isArchitectureFile(owner)) {
              if (anchor && anchor.sourceId !== owner.id) return undefined;
              anchor ??= fact;
              nodes.set(owner.id, asNode(owner));
            } else if (!visited.has(owner.id)) {
              visited.add(owner.id);
              pending.push(asNode(owner));
            }
          }
          if (nextCursor === undefined) break;
          cursor = nextCursor;
        }
      }
      return anchor;
    });
  const resolveSubjects = (selection: CodeGraphDiagramQuestion, allowFuzzy: boolean, packageName?: string) =>
    Effect.gen(function* () {
      const candidates: CodeGraphQueryNode[] = [];
      const topical: RankedSubject[] = [];
      const exactNames = new Set<string>();
      const namedCandidates: RankedSubject[] = [];
      const requestedNames = new Set(selection.unanchoredNames ? selection.terms : []);
      const stableIds = Arr.filter(Arr.map(selection.selectors, Str.toLowerCase), isStableCodeGraphNodeId);
      const topicTerms = diagramTopicSearchTerms(selection.topic);
      const terms = topicTerms.length
        ? topicTerms
        : selection.selectors.length
          ? Arr.flatMap(selection.selectors, term => {
              const path = parseCodeGraphEndpointSelector(term).path;
              return path === undefined ? [] : [path];
            })
          : selection.terms;
      const lookupTerms = [
        ...new Set(
          Arr.flatMap(terms, term => {
            const normalized = Str.replace(/^\.\//u, '')(term);
            return [normalized, Str.toLowerCase(normalized)];
          }),
        ),
      ];
      let topRank: Rank | undefined;
      const candidateIds = new Set<string>();
      const consider = (
        symbols: readonly CodeGraphSymbol[],
        exactOnly: boolean,
        rankSubject = rankCodeGraphDiagramSubject,
      ) => {
        for (const symbol of symbols) {
          const node = asNode(symbol);
          if (packageName !== undefined && node.packageName !== packageName) continue;
          if (boundaryKind('', node)) continue;
          const rank = rankSubject(node, selection);
          if (!rank || (exactOnly && rank[0] === 1)) continue;
          if (topicTerms.length && rank[0] === 1) {
            topical.push({node, rank});
            continue;
          }
          if (exactOnly && requestedNames.has(node.name)) {
            exactNames.add(node.name);
            namedCandidates.push({node, rank});
          }
          const comparison = topRank ? compareRank(rank, topRank) : 1;
          if (comparison < 0) continue;
          if (comparison > 0) {
            candidates.length = 0;
            candidateIds.clear();
          }
          if (candidateIds.has(node.id)) continue;
          candidateIds.add(node.id);
          topRank = rank;
          candidates.push(node);
        }
      };
      const readSubjects = (match: 'exact' | 'fuzzy', terms = lookupTerms, rankSubject = rankCodeGraphDiagramSubject) =>
        Effect.gen(function* () {
          let after = '';
          for (;;) {
            const {symbols, nextCursor} = yield* withinRead(
              store.diagramSubjectPage(databasePath, scope.snapshotId, terms, after, PAGE_SIZE, match, packageName),
            );
            consider(symbols, match === 'exact', rankSubject);
            if (nextCursor === undefined) break;
            after = nextCursor;
          }
        });
      if (stableIds.length) {
        consider(yield* withinRead(store.symbolsByIds(databasePath, scope.snapshotId, stableIds)), true);
      }
      if (lookupTerms.length) {
        if (!topicTerms.length) yield* readSubjects('exact');
        if (allowFuzzy && !candidates.length && !selection.selectors.length) yield* readSubjects('fuzzy');
      }
      if (exactNames.size > 1) return yield* selectRelevantBehaviorSubjects(namedCandidates);
      if (!candidates.length && topical.length) return yield* selectRelevantBehaviorSubjects(topical);
      if (topicTerms.length && !candidates.length && selection.named?.caseSensitive) {
        yield* readSubjects('exact', [selection.named.spelling], rankCodeGraphDiagramTopicFallback);
      }
      candidates.sort((left, right) => compareCodeUnits(left.id, right.id));
      return question.path || question.topic.length
        ? candidates
        : yield* supportedCandidates(candidates, initialDirections, page);
    });
  let sequenceEvidence: {readonly snapshot: CodeGraphSnapshot; readonly file: CodeGraphInventoryFile} | undefined;
  const read = Effect.gen(function* () {
    const snapshot = yield* withinRead(store.readySnapshotById(databasePath, scope.snapshotId));
    if (snapshot?.repositoryId !== scope.repositoryId) {
      return noEvidence(
        'The selected graph snapshot is unavailable.',
        'Refresh the graph view and retry the same question.',
      );
    }
    const candidates = yield* resolveSubjects(
      question.path ? diagramEndpoint(question, question.path.from) : subjectQuery,
      question.path === undefined,
      input.packageName,
    );
    if (!candidates.length) {
      if (input.partialProject) {
        gaps.set('scope', {kind: 'partial-project', label: scope.project ?? 'Selected graph project'});
        return noEvidence('The selected graph project has no source evidence for the subject.', DIAGRAM_PROJECT_RETRY);
      }
      return noEvidence(
        'The selected graph has no source evidence for the subject.',
        'Name an indexed symbol, package, or path in this graph.',
      );
    }
    if (question.path && candidates.length > 1) {
      return {
        ...base,
        status: 'clarification',
        coverage: coverage('undetermined', boundaries, gaps),
        message: 'More than one source location matches the start of this path.',
        candidates: Arr.map(candidates, candidate =>
          diagramClarificationCandidate(question, candidate, {role: 'from'}),
        ),
      } satisfies CodeGraphDiagramResult;
    }

    subject = candidates[0]!;
    if (!hasDiagramSourceSpan(subject.path, subject.span)) {
      gaps.set('subject', {kind: 'missing-evidence', label: subject.qualifiedName});
      return undefined;
    }
    if (question.path) {
      const targets = yield* resolveSubjects(diagramEndpoint(question, question.path.to), false);
      if (!targets.length) {
        return noEvidence(
          'The selected graph has no source evidence for the path endpoint.',
          'Name an indexed endpoint in the same graph.',
        );
      }
      if (targets.length > 1) {
        const source = subject;
        return {
          ...base,
          status: 'clarification',
          coverage: coverage('undetermined', boundaries, gaps, subject),
          message: 'More than one source location matches the target of this path.',
          candidates: Arr.map(targets, target => diagramClarificationCandidate(question, target, {role: 'to', source})),
        } satisfies CodeGraphDiagramResult;
      }
      pathTarget = targets[0];
      contributing.add(pathTarget.id);
    }
    if (question.domain === 'architecture' && (CALLABLES.has(subject.kind) || BRIDGES.has(subject.kind))) {
      architectureAnchor = yield* findContainingModule(subject);
      if (!architectureAnchor) {
        gaps.set('module', {kind: 'missing-evidence', label: 'The graph does not identify one containing module.'});
        return undefined;
      }
    }
    const fileOverview = diagramFileOverview(question, subject);
    const relationshipQuery = fileOverview ? {...question, domain: 'architecture' as const} : question;

    const pending: Work[] = [];
    const scheduled = new Set<string>();
    const schedule = (node: CodeGraphQueryNode, direction: Direction) => {
      const key = `${direction}:${node.id}`;
      if (!scheduled.has(key)) {
        scheduled.add(key);
        pending.push({node, direction});
      }
    };
    nodes.set(subject.id, subject);
    if (architectureAnchor) {
      schedule(nodes.get(architectureAnchor.sourceId)!, 'outgoing');
    } else {
      for (const direction of initialDirections) schedule(subject, direction);
    }
    for (const work of pending) {
      if (work.node.id === pathTarget?.id && work.node.id !== subject.id) continue;
      const overviewRoot = fileOverview && work.node.id === subject.id;
      let cursor = '';
      for (;;) {
        const {edges, nextCursor} = yield* readPage(
          work,
          overviewRoot ? FILE_OVERVIEW_RELATIONS : relationsFor(relationshipQuery, work),
          cursor,
          PAGE_SIZE,
        );
        const peerIds = [
          ...new Set(
            Arr.flatMap(edges, edge => {
              const id = oppositeId(edge, work.direction);
              return id && !nodes.has(id) ? [id] : [];
            }),
          ),
        ];
        if (peerIds.length) {
          const peers = yield* withinRead(store.symbolsByIds(databasePath, scope.snapshotId, peerIds));
          for (const peer of peers) nodes.set(peer.id, asNode(peer));
        }
        for (const edge of edges) {
          const peerId = oppositeId(edge, work.direction);
          let peer = peerId ? nodes.get(peerId) : undefined;
          if (
            architectureAnchor &&
            (isDiagramOwnershipRelation(edge.relation) ||
              ((edge.relation === 'imports' || edge.relation === 'reexports') &&
                Str.startsWith('import:')(edge.targetName)))
          )
            continue;
          const ownership = isDiagramOwnershipRelation(edge.relation) && work.direction === 'outgoing';
          const overviewDeclaration = overviewRoot && ownership && peer !== undefined && owns(work.node, peer);
          if (!(overviewRoot && !ownership) && !overviewDeclaration && !eligible(relationshipQuery, work, edge, peer))
            continue;
          const boundary = boundaryKind(work.direction === 'outgoing' ? edge.targetName : edge.sourceName, peer);
          const label = peer?.qualifiedName ?? (work.direction === 'outgoing' ? edge.targetName : edge.sourceName);
          if (boundary) {
            boundaries.set(edge.id, {...site(edge, label), kind: boundary});
            if (!peer || boundary === 'outside-scope') {
              peer = endpointPlaceholder(edge, label, boundary);
              nodes.set(peer.id, peer);
            }
            boundaryIds.add(peer.id);
          }
          if (!peer || !hasDiagramSourceSpan(peer.path, peer.span)) {
            gaps.set(edge.id, {...site(edge, label), kind: peerId ? 'missing-evidence' : 'unresolved-target'});
            contributing.add(work.node.id);
            if (question.path === undefined && (overviewRoot || relationshipQuery.domain === 'behavior')) {
              const call = unresolvedCall(edge, work);
              if (call) {
                nodes.set(call.placeholder.id, call.placeholder);
                unresolvedCalls.set(edge.id, call.fact);
              }
            }
            continue;
          }
          const fact = completeDiagramFact(
            edge,
            work.direction === 'outgoing' ? work.node.id : peer.id,
            work.direction === 'outgoing' ? peer.id : work.node.id,
          );
          if (!fact) {
            gaps.set(edge.id, {...site(edge, label), kind: 'missing-evidence'});
            contributing.add(work.node.id);
            continue;
          }
          if (relationshipQuery.domain !== 'types' && ownership && !overviewDeclaration) {
            const parents = parentsByChild.get(peer.id) ?? [];
            parents.push(fact);
            parentsByChild.set(peer.id, parents);
            if (relationshipQuery.domain === 'architecture' || followsOwnedBehavior(question, subject, work.node, peer))
              schedule(peer, work.direction);
            continue;
          }
          facts.set(fact.id, fact);
          contributing.add(fact.sourceId);
          contributing.add(fact.targetId);
          if (!boundary && !architectureAnchor && (!overviewRoot || isDiagramComponentKind(peer.kind)))
            schedule(peer, work.direction);
        }
        if (nextCursor === undefined) break;
        cursor = nextCursor;
      }
    }
    collectBridges(parentsByChild, contributing, facts);
    const subjectId = subject.id;
    const alternatives = Arr.filter(
      candidates,
      candidate => candidate.id !== subjectId && (question.topic.length > 0 || !contributing.has(candidate.id)),
    );
    if (alternatives.length) {
      return {
        ...base,
        status: 'clarification',
        coverage: coverage('undetermined', new Map(), new Map()),
        message: 'More than one source location matches the subject of this diagram.',
        candidates: Arr.map([subject, ...alternatives], candidate =>
          diagramClarificationCandidate(question, candidate),
        ),
      } satisfies CodeGraphDiagramResult;
    }
    if (!facts.size && !gaps.size) {
      gaps.set('relationships', {kind: 'missing-evidence', label: 'No source relationship supports the question.'});
    }
    if (
      facts.size &&
      wantsSourceBackedSequence(question) &&
      input.sourceIdentity?.repositoryId === snapshot.repositoryId
    ) {
      // Execution ordering is established within the selected subject's source.
      const rows = yield* withinRead(
        store.effectiveSnapshotFilesByPaths(databasePath, snapshot.id, [subject.path]),
      ).pipe(Effect.orElseSucceed(() => []));
      const file = rows[0]?.file;
      if (
        file &&
        file.size <= TYPESCRIPT_FULL_TRAVERSAL_UTF8_BYTE_LIMIT &&
        (file.language === 'typescript' || file.language === 'javascript') &&
        (file.mode === '100644' || file.mode === '100755')
      ) {
        sequenceEvidence = {snapshot, file};
      }
    }
    return undefined;
  });
  const result = yield* withCodeGraphReadTransaction(store, databasePath, read).pipe(
    Effect.catch(() => {
      gaps.set('read', {kind: 'interrupted', label: 'The graph read could not complete every evidence page.'});
      collectBridges(parentsByChild, contributing, facts);
      return Effect.void;
    }),
  );
  if (result) return result;
  const sequenceSources =
    input.sourceIdentity && sequenceEvidence
      ? yield* withinRead(
          readVerifiedSequenceSource(input.sourceIdentity, sequenceEvidence.snapshot, sequenceEvidence.file),
        ).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
  if (input.partialProject)
    gaps.set('scope', {kind: 'partial-project', label: scope.project ?? 'Selected graph project'});
  const acquired = [...facts.values()].sort((left, right) => compareCodeUnits(left.id, right.id));
  const selected = subject && pathTarget ? selectDiagramPath(acquired, subject.id, pathTarget.id) : acquired;
  if (pathTarget) {
    if (!selected.length)
      gaps.set('path', {kind: 'missing-evidence', label: 'No indexed call path connects the selected endpoints.'});
    const relevant = new Set(Arr.map(selected, fact => fact.id));
    for (const id of boundaries.keys()) {
      if (!relevant.has(id)) boundaries.delete(id);
    }
  }
  const complete = coverage(gaps.size ? 'incomplete' : 'complete', boundaries, gaps, subject);
  const hasSourceTime = sequenceSources !== undefined && (yield* Clock.currentTimeMillis) < deadline;
  return renderCompleteCodeGraphDiagram({
    question,
    scope,
    freshness,
    coverage: complete,
    nodes,
    boundaryIds,
    facts: selected,
    unresolvedCalls: [...unresolvedCalls.values()].sort((left, right) => compareCodeUnits(left.id, right.id)),
    ...(hasSourceTime ? {sequenceSources} : {}),
    ...(architectureAnchor === undefined ? {} : {architectureAnchor}),
    ...(pathTarget === undefined ? {} : {pathTarget}),
  });
});

function oppositeId(edge: CodeGraphEdge, direction: Direction): string | undefined {
  return direction === 'outgoing' ? edge.targetId : edge.sourceId;
}

const supportedCandidates = Effect.fn('codeGraph.diagramSupportedCandidates')(function* (
  candidates: readonly CodeGraphQueryNode[],
  directions: readonly Direction[],
  page: EvidencePage,
) {
  if (candidates.length === 1) return candidates;
  const supported: CodeGraphQueryNode[] = [];
  for (const node of candidates) {
    let hasEdge = false;
    for (const direction of directions) {
      let cursor = '';
      for (;;) {
        const {edges, nextCursor} = yield* page({node, direction}, cursor, PAGE_SIZE);
        hasEdge = edges.length > 0;
        if (hasEdge || nextCursor === undefined) break;
        cursor = nextCursor;
      }
      if (hasEdge) break;
    }
    if (hasEdge) supported.push(node);
  }
  return supported.length ? supported : candidates;
});

/** Use a status selected for the authorized caller checkout and project. */
export const readCodeGraphDiagramForStatus = Effect.fn('codeGraph.readDiagramForStatus')(function* (
  store: CodeGraphStoreShape,
  status: CodeGraphStatus,
  request: CodeGraphDiagramRequest,
) {
  const {databasePath, freshness, identity, readySnapshot, projectCoverage} = status;
  const scope = {
    repositoryId: identity.repositoryId,
    repositoryName: identity.displayName,
    snapshotId: readySnapshot?.id ?? '',
    ...(readySnapshot ? {commit: readySnapshot.commit} : {}),
    ...(projectCoverage?.kind === 'project' ? {project: projectCoverage.project} : {}),
  };
  if (!readySnapshot) {
    return {
      status: 'unavailable',
      scope,
      freshness,
      coverage: {completeness: 'undetermined', boundaries: [], gaps: []},
      limits: [],
      message: 'The selected graph has no ready snapshot.',
      nextAction: 'Prepare the selected graph and retry the question.',
    } satisfies CodeGraphDiagramResult;
  }
  const duration = Math.max(120_000, (request.timeoutMilliseconds ?? READ_TIMEOUT_MILLISECONDS) + 15_000);
  const leaseOptions = {waitTimeoutMilliseconds: 250};
  return yield* Effect.acquireUseRelease(
    store.acquireSnapshotLease(databasePath, readySnapshot.id, duration, leaseOptions).pipe(Effect.option),
    (lease): Effect.Effect<CodeGraphDiagramResult, never, Effect.Services<ReturnType<typeof readCodeGraphDiagram>>> =>
      Option.isSome(lease)
        ? readCodeGraphDiagram(store, databasePath, {
            ...request,
            scope,
            freshness,
            sourceIdentity: identity,
            partialProject: projectCoverage?.completeness === 'partial',
          })
        : Effect.succeed({
            status: 'incomplete',
            scope,
            freshness,
            coverage: {
              completeness: 'incomplete',
              boundaries: [],
              gaps: [{kind: 'interrupted', label: 'The reader could not retain the selected snapshot.'}],
            },
            limits: [],
            message: 'The graph read stopped before it could establish coverage.',
            nextAction: 'Retry the diagram for the same graph after the active writer completes.',
          } satisfies CodeGraphDiagramResult),
    lease =>
      Option.isSome(lease)
        ? store.releaseSnapshotLease(databasePath, lease.value, leaseOptions).pipe(Effect.ignore)
        : Effect.void,
  );
});
