import {Array as EffectArray} from 'effect';
import {
  codeGraphEvidenceCardId,
  codeGraphQualifiedRefHandle,
  type CodeGraphEvidenceCardV1,
  type CompactEvidenceRelationshipV1,
} from './evidence.js';
import type {
  CodeGraphWorksetRouterRankedSymbolV1,
  CodeGraphWorksetRouterRepositoryCandidateV1,
  CodeGraphWorksetRouterResultV1,
} from './router.js';
import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphQueryResult} from '../types.js';
import {Option as EffectOption} from 'effect';

export const CODE_GRAPH_WORKSET_GLOBAL_RANK_VERSION = 1 as const;
const CODE_GRAPH_WORKSET_DIVERSITY_PREFIX_REPOSITORIES = 4;

export interface CodeGraphWorksetDeepQueryResultV1 {
  readonly graph: CodeGraphQueryResult;
  readonly repositoryKey: string;
}

export interface RankCodeGraphWorksetEvidenceInputV1 {
  readonly maximumCards?: number;
  readonly repositories: readonly CodeGraphWorksetDeepQueryResultV1[];
  readonly router: Pick<CodeGraphWorksetRouterResultV1, 'repositories' | 'symbols'>;
}

/**
 * Deterministically merge repository-local graph results into snapshot-bound
 * evidence cards. Repository completion order is deliberately absent from all
 * score features and tie-breaks.
 */
export function rankCodeGraphWorksetEvidenceCards(
  input: RankCodeGraphWorksetEvidenceInputV1,
): readonly CodeGraphEvidenceCardV1[] {
  const maximumCards = boundedCards(input.maximumCards);
  const routerRepositories = new Map(
    EffectArray.map(input.router.repositories, repository => [repository.repositoryKey, repository]),
  );
  const routerSymbols = new Map(
    EffectArray.map(input.router.symbols, symbol => [
      symbolKey(symbol.symbol.repositoryKey, symbol.symbol.nodeId),
      symbol,
    ]),
  );
  const seenRepositories = new Set<string>();
  const candidates: RankedCardCandidate[] = [];

  for (const deep of input.repositories) {
    if (seenRepositories.has(deep.repositoryKey)) {
      throw new Error(`Workset deep query repository ${deep.repositoryKey} is duplicated.`);
    }
    seenRepositories.add(deep.repositoryKey);
    const repository = routerRepositories.get(deep.repositoryKey);
    if (repository === undefined) {
      throw new Error(`Workset deep query repository ${deep.repositoryKey} was not admitted by the router.`);
    }
    validateDeepQueryProvenance(deep, repository);
    const nodes = deduplicateAndRankLocalNodes(deep.graph.nodes);
    for (let localIndex = 0; localIndex < nodes.length; localIndex += 1) {
      const node = nodes[localIndex];
      const routed = routerSymbols.get(symbolKey(deep.repositoryKey, node.id));
      const score = globalScore(repository, routed, localIndex + 1, node.exported);
      const ref = codeGraphQualifiedRefHandle({nodeId: node.id, repositoryId: deep.graph.repository.repositoryId});
      const signals = scoreSignals(repository, routed, localIndex + 1, node.exported);
      const relationships = relationshipsForNode(deep, node.id);
      const card: CodeGraphEvidenceCardV1 = {
        id: codeGraphEvidenceCardId(ref, deep.graph.snapshot.id, deep.graph.snapshot.worktreeId),
        reason: {
          score,
          signals,
          summary:
            routed?.exactMatches.length === 0 || routed === undefined
              ? 'Globally ranked repository and local graph match.'
              : 'Globally ranked exact catalog identity validated against its ready snapshot.',
        },
        ref,
        relationships,
        repositoryKey: deep.repositoryKey,
        symbol: {
          kind: node.kind,
          language: node.language,
          name: node.name,
          ...(node.packageName === undefined ? {} : {packageName: node.packageName}),
          path: node.path,
          qualifiedName: node.qualifiedName,
          span: node.span,
        },
      };
      candidates.push({
        card,
        nodeId: node.id,
        repositoryId: deep.graph.repository.repositoryId,
        repositoryRank: repository.rank,
        score,
      });
    }
  }

  return EffectArray.map(diversityFirstRanking(candidates).slice(0, maximumCards), candidate => candidate.card);
}

interface RankedCardCandidate {
  readonly card: CodeGraphEvidenceCardV1;
  readonly nodeId: string;
  readonly repositoryId: string;
  readonly repositoryRank: number;
  readonly score: number;
}

/**
 * Put the strongest card from each repository in the initial routing batch
 * before repeated cards from one repository. Later expansion batches do not
 * reserve equal result slots: after this bounded prefix, deterministic global
 * score order decides the sequence.
 */
function diversityFirstRanking(candidates: readonly RankedCardCandidate[]): readonly RankedCardCandidate[] {
  const globallyRanked = [...candidates].sort(compareCardCandidate);
  const firstByRepository = new Map<string, RankedCardCandidate>();
  for (const candidate of globallyRanked) {
    if (
      candidate.repositoryRank <= CODE_GRAPH_WORKSET_DIVERSITY_PREFIX_REPOSITORIES &&
      !firstByRepository.has(candidate.card.repositoryKey)
    ) {
      firstByRepository.set(candidate.card.repositoryKey, candidate);
    }
  }
  const prefix = [...firstByRepository.values()].sort(
    (left, right) => left.repositoryRank - right.repositoryRank || compareCardCandidate(left, right),
  );
  const selected = new Set(prefix);
  return [...prefix, ...EffectArray.filter(globallyRanked, candidate => !selected.has(candidate))];
}

function validateDeepQueryProvenance(
  deep: CodeGraphWorksetDeepQueryResultV1,
  repository: CodeGraphWorksetRouterRepositoryCandidateV1,
): void {
  if (
    deep.graph.repository.repositoryId !== repository.repositoryId ||
    deep.graph.snapshot.id !== repository.snapshotId
  ) {
    throw new Error(`Workset deep query repository ${deep.repositoryKey} does not match its routed snapshot.`);
  }
}

function deduplicateAndRankLocalNodes(nodes: readonly CodeGraphQueryNode[]): readonly CodeGraphQueryNode[] {
  const byId = new Map<string, CodeGraphQueryNode>();
  for (const node of nodes) {
    const existing = byId.get(node.id);
    if (existing === undefined || compareLocalNode(node, existing) < 0) byId.set(node.id, node);
  }
  return [...byId.values()].sort(compareLocalNode);
}

function globalScore(
  repository: CodeGraphWorksetRouterRepositoryCandidateV1,
  symbol: CodeGraphWorksetRouterRankedSymbolV1 | undefined,
  localRank: number,
  exported: boolean,
): number {
  const repositoryContribution = reciprocalRank(repository.rank, 250);
  const catalogContribution = symbol === undefined ? 0 : reciprocalRank(symbol.globalRank, 350);
  const localContribution = reciprocalRank(localRank, 300);
  const exactContribution = symbol !== undefined && symbol.exactMatches.length > 0 ? 80 : 0;
  const exportedContribution = exported ? 20 : 0;
  return Math.min(
    1,
    (repositoryContribution + catalogContribution + localContribution + exactContribution + exportedContribution) /
      1_000,
  );
}

function scoreSignals(
  repository: CodeGraphWorksetRouterRepositoryCandidateV1,
  symbol: CodeGraphWorksetRouterRankedSymbolV1 | undefined,
  localRank: number,
  exported: boolean,
): readonly string[] {
  return [
    `global-rank-v${CODE_GRAPH_WORKSET_GLOBAL_RANK_VERSION}`,
    `repository-rank:${repository.rank}`,
    ...(symbol === undefined ? [] : [`catalog-rank:${symbol.globalRank}`]),
    `local-rank:${localRank}`,
    ...(EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(symbol?.exactMatches), __effectArrayReceiver =>
        EffectArray.map(__effectArrayReceiver, match => `exact:${match}`),
      ),
    ) ?? []),
    ...(exported ? ['exported'] : []),
  ];
}

function relationshipsForNode(
  deep: CodeGraphWorksetDeepQueryResultV1,
  nodeId: string,
): readonly CompactEvidenceRelationshipV1[] {
  const relationships = EffectArray.flatMap(deep.graph.edges, edge => {
    if (edge.sourceId === undefined || edge.targetId === undefined) return [];
    if (edge.sourceId !== nodeId && edge.targetId !== nodeId) return [];
    try {
      return [relationshipFromEdge(deep, {...edge, sourceId: edge.sourceId, targetId: edge.targetId})];
    } catch {
      return [];
    }
  });
  const unique = new Map<string, CompactEvidenceRelationshipV1>();
  for (const relationship of relationships) unique.set(relationshipKey(relationship), relationship);
  return [...unique.values()].sort(compareRelationship).slice(0, 8);
}

function relationshipFromEdge(
  deep: CodeGraphWorksetDeepQueryResultV1,
  edge: CodeGraphEdge & {readonly sourceId: string; readonly targetId: string},
): CompactEvidenceRelationshipV1 {
  const repositoryId = deep.graph.repository.repositoryId;
  return {
    authority: edge.provenance === 'declared' || edge.provenance === 'resolved' ? 'authoritative' : 'supporting',
    confidence: Math.max(0, Math.min(1, edge.confidence)),
    evidence: {path: edge.evidencePath, repositoryKey: deep.repositoryKey, span: edge.evidenceSpan},
    provenance: edge.provenance,
    relation: edge.relation,
    source: {
      ref: codeGraphQualifiedRefHandle({nodeId: edge.sourceId, repositoryId}),
      repositoryKey: deep.repositoryKey,
    },
    target: {
      ref: codeGraphQualifiedRefHandle({nodeId: edge.targetId, repositoryId}),
      repositoryKey: deep.repositoryKey,
    },
  };
}

function compareCardCandidate(left: RankedCardCandidate, right: RankedCardCandidate): number {
  return (
    right.score - left.score ||
    compareText(left.repositoryId, right.repositoryId) ||
    compareText(left.card.symbol.path, right.card.symbol.path) ||
    left.card.symbol.span.line - right.card.symbol.span.line ||
    left.card.symbol.span.column - right.card.symbol.span.column ||
    compareText(left.nodeId, right.nodeId) ||
    compareText(left.card.repositoryKey, right.card.repositoryKey)
  );
}

function compareLocalNode(left: CodeGraphQueryNode, right: CodeGraphQueryNode): number {
  return (
    right.score - left.score ||
    compareText(left.path, right.path) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    compareText(left.id, right.id)
  );
}

function compareRelationship(left: CompactEvidenceRelationshipV1, right: CompactEvidenceRelationshipV1): number {
  return (
    authorityRank(left.authority) - authorityRank(right.authority) ||
    right.confidence - left.confidence ||
    compareText(left.relation, right.relation) ||
    compareText(left.source.ref, right.source.ref) ||
    compareText(left.target.ref, right.target.ref) ||
    compareText(left.evidence.path, right.evidence.path) ||
    left.evidence.span.line - right.evidence.span.line ||
    left.evidence.span.column - right.evidence.span.column
  );
}

function relationshipKey(relationship: CompactEvidenceRelationshipV1): string {
  return EffectArray.join(
    EffectArray.map(
      [
        relationship.source.ref,
        relationship.relation,
        relationship.target.ref,
        relationship.provenance,
        relationship.evidence.path,
        relationship.evidence.span.line,
        relationship.evidence.span.column,
      ],
      item => (item === null || item === undefined ? '' : String(item)),
    ),
    '\0',
  );
}

function reciprocalRank(rank: number, weight: number): number {
  if (!Number.isSafeInteger(rank) || rank < 1) throw new Error('Workset evidence rank is invalid.');
  return Math.floor(weight / rank);
}

function boundedCards(value: number | undefined): number {
  const cards = value ?? 64;
  if (!Number.isSafeInteger(cards) || cards < 1 || cards > 512) {
    throw new Error('Workset evidence card limit must be an integer from 1 through 512.');
  }
  return cards;
}

function authorityRank(authority: CompactEvidenceRelationshipV1['authority']): number {
  return authority === 'authoritative' ? 0 : 1;
}

function symbolKey(repositoryKey: string, nodeId: string): string {
  return `${repositoryKey}\0${nodeId}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
