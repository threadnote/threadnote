import {Array as EffectArray} from 'effect';
import {Effect, Schema} from 'effect';
import {
  codeGraphEvidenceCardId,
  type CodeGraphEvidenceCardV1,
  type CompactEvidenceRelationshipV1,
} from '../workset/evidence.js';
import type {
  CodeGraphWorksetCatalogPublishedGenerationV1,
  CodeGraphWorksetCatalogPublishedMemberV1,
} from '../workset_catalog/types.js';
import type {CodeGraphWorksetRouterRepositoryCandidateV1, CodeGraphWorksetRouterResultV1} from '../workset/router.js';
import type {CodeGraphCrossRepositoryBridgeV1} from './resolver.js';
import {
  readCodeGraphWorksetCatalogRepositoryBridgePage,
  readPublishedCodeGraphWorksetCatalogBridgeSetSummary,
  type CodeGraphCrossRepositoryBridgeCursorV1,
} from './store.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class CodeGraphQueryExpansionError extends Schema.TaggedError<
  CodeGraphQueryExpansionError,
  {readonly brand: unique symbol}
>()('CodeGraphQueryExpansionError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const DEFAULT_SEED_REPOSITORIES = 16;
const MAXIMUM_BRIDGES_PER_SEED_DIRECTION = 64;
const BRIDGE_PAGE_SIZE = 64;
const MAXIMUM_EXPANSION_BRIDGES = DEFAULT_SEED_REPOSITORIES * MAXIMUM_BRIDGES_PER_SEED_DIRECTION * 2;
const MAXIMUM_RELATIONSHIPS_PER_CARD = 32;

export interface CodeGraphWorksetQueryBridgeExpansionV1 {
  readonly bridgeSet?: {
    readonly digest: string;
    readonly generationId: string;
    readonly totalBridges: number;
  };
  readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly complete: boolean;
  readonly seededRepositories: number;
  readonly warnings: readonly string[];
}

/**
 * Read one-hop bridge adjacency for the strongest routed repositories. Reads
 * stay on repository/snapshot index prefixes and are fenced to one complete
 * published bridge-set receipt; no generation-wide bridge scan is performed.
 */
export const readCodeGraphWorksetQueryBridgeExpansion = Effect.fn(
  'codeGraphCrossRepository.readWorksetQueryBridgeExpansion',
)(function* (
  threadnoteHome: string,
  published: CodeGraphWorksetCatalogPublishedGenerationV1,
  router: CodeGraphWorksetRouterResultV1,
) {
  const summary = yield* readPublishedCodeGraphWorksetCatalogBridgeSetSummary(threadnoteHome, published.id);
  const seeds = router.repositories.slice(0, DEFAULT_SEED_REPOSITORIES);
  if (summary === undefined) {
    return {
      bridges: [],
      complete: false,
      seededRepositories: seeds.length,
      warnings: ['The published generation has no readable cross-repository bridge receipt.'],
    } satisfies CodeGraphWorksetQueryBridgeExpansionV1;
  }
  const bridgeSet = {digest: summary.digest, generationId: published.id, totalBridges: summary.bridgeCount};
  if (summary.coverage.state !== 'complete') {
    return {
      bridgeSet,
      bridges: [],
      complete: false,
      seededRepositories: seeds.length,
      warnings: ['Cross-repository bridge coverage is incomplete; contract-neighbor expansion was withheld.'],
    } satisfies CodeGraphWorksetQueryBridgeExpansionV1;
  }
  const memberByKey = new Map(EffectArray.map(published.members, member => [member.repositoryKey, member] as const));
  const reads = yield* Effect.forEach(
    seeds,
    seed => {
      const member = memberByKey.get(seed.repositoryKey);
      if (member === undefined || member.repositoryId !== seed.repositoryId || member.snapshotId !== seed.snapshotId) {
        return Effect.fail(
          CodeGraphQueryExpansionError.make({message: 'A routed bridge seed does not match the published generation.'}),
        );
      }
      return Effect.forEach(
        ['outgoing', 'incoming'] as const,
        direction =>
          readSeedDirection(threadnoteHome, published, member, direction, bridgeSet).pipe(
            Effect.mapError(cause =>
              CodeGraphQueryExpansionError.make({cause, message: 'Could not read the published bridge expansion.'}),
            ),
          ),
        {concurrency: 2},
      );
    },
    {concurrency: 4},
  );
  const byId = new Map<string, CodeGraphCrossRepositoryBridgeV1>();
  let truncated = false;
  for (const repositoryReads of reads) {
    for (const read of repositoryReads) {
      truncated ||= read.truncated;
      for (const bridge of read.bridges) byId.set(bridge.id, bridge);
    }
  }
  const bridges = [...byId.values()].sort(compareBridge);
  if (bridges.length > MAXIMUM_EXPANSION_BRIDGES) {
    throw CodeGraphQueryExpansionError.make({
      message: 'Workset query bridge expansion exceeded its deterministic bound.',
    });
  }
  return {
    bridgeSet,
    bridges,
    complete: !truncated,
    seededRepositories: seeds.length,
    warnings: [
      ...(truncated
        ? ['Cross-repository contract-neighbor expansion reached its bounded per-repository edge limit.']
        : []),
      ...(summary.coverage.rejectionCount > 0
        ? [
            `${summary.coverage.rejectionCount} cross-repository import${summary.coverage.rejectionCount === 1 ? ' was' : 's were'} rejected as ambiguous or version-incompatible.`,
          ]
        : []),
    ],
  } satisfies CodeGraphWorksetQueryBridgeExpansionV1;
});

/** Add deterministic one-hop contract neighbors without changing catalog symbol ranks. */
export function expandCodeGraphWorksetRouterWithBridges(
  router: CodeGraphWorksetRouterResultV1,
  published: CodeGraphWorksetCatalogPublishedGenerationV1,
  expansion: CodeGraphWorksetQueryBridgeExpansionV1,
): CodeGraphWorksetRouterResultV1 {
  validateExpansion(router, published, expansion);
  const originalByKey = new Map(
    EffectArray.map(router.repositories, repository => [repository.repositoryKey, repository] as const),
  );
  const publishedByKey = new Map(EffectArray.map(published.members, member => [member.repositoryKey, member] as const));
  const additions = new Map<string, BridgeCandidate>();
  for (const bridge of expansion.bridges) {
    const sourceSeed = originalByKey.get(bridge.source.repositoryKey);
    const targetSeed = originalByKey.get(bridge.target.repositoryKey);
    if (sourceSeed !== undefined) {
      registerBridgeCandidate(additions, publishedByKey, bridge.target.repositoryKey, sourceSeed, bridge);
    }
    if (targetSeed !== undefined) {
      registerBridgeCandidate(additions, publishedByKey, bridge.source.repositoryKey, targetSeed, bridge);
    }
  }
  const ordered = [
    ...EffectArray.map(router.repositories, repository => {
      const bridge = additions.get(repository.repositoryKey);
      return {
        kind: 'catalog' as const,
        priority: Math.min(
          repository.rank * 2,
          bridge === undefined ? Number.MAX_SAFE_INTEGER : bridge.seedRank * 2 + 1,
        ),
        repository,
      };
    }),
    ...EffectArray.map(
      EffectArray.filter([...additions.values()], addition => !originalByKey.has(addition.member.repositoryKey)),
      addition => ({kind: 'bridge' as const, priority: addition.seedRank * 2 + 1, addition}),
    ),
  ].sort((left, right) => {
    const priority = left.priority - right.priority;
    if (priority !== 0) return priority;
    const leftKey = left.kind === 'catalog' ? left.repository.repositoryKey : left.addition.member.repositoryKey;
    const rightKey = right.kind === 'catalog' ? right.repository.repositoryKey : right.addition.member.repositoryKey;
    return compareText(leftKey, rightKey);
  });
  const repositories = EffectArray.map(ordered, (entry, index): CodeGraphWorksetRouterRepositoryCandidateV1 => {
    if (entry.kind === 'catalog') return {...entry.repository, rank: index + 1};
    const score = Math.max(1, Math.floor(entry.addition.seedScore * 0.75));
    return {
      bestSymbolKey: `bridge:${entry.addition.bridgeId}`,
      exactSymbolCount: 0,
      matchingSymbolCount: entry.addition.bridgeCount,
      projectionDigest: entry.addition.member.projectionDigest,
      rank: index + 1,
      repositoryId: entry.addition.member.repositoryId,
      repositoryKey: entry.addition.member.repositoryKey,
      score,
      scoreReceipt: {
        bestSymbolContribution: score,
        exactMatchContribution: 0,
        supportingSymbolContribution: 0,
        total: score,
        version: router.version,
      },
      snapshotId: entry.addition.member.snapshotId,
    };
  });
  return {
    ...router,
    expansion: {
      exhausted: repositories.length <= router.expansion.requestedBatchSize,
      repositories: repositories.slice(0, router.expansion.requestedBatchSize),
      requestedBatchSize: router.expansion.requestedBatchSize,
    },
    repositories,
  };
}

/** Attach exact protobuf bridges to adjacent cards; package components remain topology/path endpoints. */
export function attachCodeGraphWorksetBridgeRelationships(
  cards: readonly CodeGraphEvidenceCardV1[],
  bridges: readonly CodeGraphCrossRepositoryBridgeV1[],
  usableRepositoryKeys: ReadonlySet<string>,
): readonly CodeGraphEvidenceCardV1[] {
  const byRef = new Map<string, CompactEvidenceRelationshipV1[]>();
  const cardRefs = new Set(EffectArray.map(cards, card => card.ref));
  for (const bridge of bridges) {
    if (
      bridge.source.reference.kind !== 'qualified-ref' ||
      bridge.target.reference.kind !== 'qualified-ref' ||
      !usableRepositoryKeys.has(bridge.source.repositoryKey) ||
      !usableRepositoryKeys.has(bridge.target.repositoryKey)
    ) {
      continue;
    }
    const relationship: CompactEvidenceRelationshipV1 = {
      authority: 'authoritative',
      confidence: 1,
      evidence: {
        path: bridge.source.evidence.path,
        repositoryKey: bridge.source.repositoryKey,
        span: bridge.source.evidence.span,
      },
      provenance: 'declared',
      relation: bridge.relation,
      source: {ref: bridge.source.reference.ref, repositoryKey: bridge.source.repositoryKey},
      target: {ref: bridge.target.reference.ref, repositoryKey: bridge.target.repositoryKey},
    };
    // Emit one copy on the consumer/import card only. Ownership must not move
    // when a larger result budget later admits the producer endpoint.
    const adjacentRef = cardRefs.has(relationship.source.ref) ? relationship.source.ref : undefined;
    if (adjacentRef === undefined) continue;
    const values = byRef.get(adjacentRef) ?? [];
    values.push(relationship);
    byRef.set(adjacentRef, values);
  }
  return EffectArray.map(cards, card => {
    const related = byRef.get(card.ref);
    if (related === undefined || related.length === 0) return card;
    const unique = new Map<string, CompactEvidenceRelationshipV1>();
    for (const relationship of [...card.relationships, ...related]) {
      unique.set(relationshipKey(relationship), relationship);
    }
    return {
      ...card,
      relationships: [...unique.values()].sort(compareRelationship).slice(0, MAXIMUM_RELATIONSHIPS_PER_CARD),
    };
  });
}

/**
 * Materialize exact protobuf moniker endpoints as compact cards when the
 * original query does not independently rank that endpoint symbol. The cards
 * contain declaration metadata only—never source bodies or guessed names.
 */
export function materializeCodeGraphWorksetBridgeEndpointCards(
  published: CodeGraphWorksetCatalogPublishedGenerationV1,
  bridges: readonly CodeGraphCrossRepositoryBridgeV1[],
  usableRepositoryKeys: ReadonlySet<string>,
  maximumCards = 4,
): readonly CodeGraphEvidenceCardV1[] {
  if (!Number.isSafeInteger(maximumCards) || maximumCards < 0 || maximumCards > 32) {
    throw CodeGraphQueryExpansionError.make({message: 'Workset bridge endpoint card limit is invalid.'});
  }
  if (maximumCards === 0) return [];
  const members = new Map(EffectArray.map(published.members, member => [member.repositoryKey, member] as const));
  const byRef = new Map<string, CodeGraphEvidenceCardV1>();
  for (const bridge of [...bridges].sort(compareBridge)) {
    for (const endpoint of [bridge.source, bridge.target]) {
      if (endpoint.reference.kind !== 'qualified-ref' || !usableRepositoryKeys.has(endpoint.repositoryKey)) continue;
      const member = members.get(endpoint.repositoryKey);
      if (
        member === undefined ||
        member.repositoryId !== endpoint.repositoryId ||
        member.snapshotId !== endpoint.snapshotId
      ) {
        throw CodeGraphQueryExpansionError.make({
          message: 'A bridge endpoint card is outside its published generation.',
        });
      }
      if (byRef.has(endpoint.reference.ref)) continue;
      const qualifiedName = Effect2.pipe(bridge.identity, EffectString.replace(/^protobuf:[^:]+:/u, ''));
      const name =
        bridge.kind === 'file'
          ? (Effect2.pipe(qualifiedName, EffectString.split('/')).at(-1) ?? qualifiedName)
          : (Effect2.pipe(qualifiedName, EffectString.split(/[./]/u)).at(-1) ?? qualifiedName);
      byRef.set(endpoint.reference.ref, {
        id: codeGraphEvidenceCardId(endpoint.reference.ref, member.snapshotId, member.worktreeId),
        reason: {
          score: 0.6,
          signals: ['cross-repository-bridge', `bridge-role:${endpoint.role}`, `resolver-v${bridge.resolver.version}`],
          summary: 'Exact cross-repository protobuf moniker validated in the published generation.',
        },
        ref: endpoint.reference.ref,
        relationships: [],
        repositoryKey: endpoint.repositoryKey,
        symbol: {
          kind: bridge.kind,
          language: 'protobuf',
          name,
          path: endpoint.evidence.path,
          qualifiedName,
          span: endpoint.evidence.span,
        },
      });
      if (byRef.size >= maximumCards) return [...byRef.values()];
    }
  }
  return [...byRef.values()];
}

/** Keep the strongest local hit first, then reserve bounded room for exact bridge endpoints. */
export function mergeCodeGraphWorksetBridgeEndpointCards(
  localCards: readonly CodeGraphEvidenceCardV1[],
  bridgeCards: readonly CodeGraphEvidenceCardV1[],
  maximumCards: number,
): readonly CodeGraphEvidenceCardV1[] {
  if (!Number.isSafeInteger(maximumCards) || maximumCards < 1 || maximumCards > 512) {
    throw CodeGraphQueryExpansionError.make({message: 'Workset evidence card limit is invalid.'});
  }
  const output: CodeGraphEvidenceCardV1[] = [];
  const refs = new Set<string>();
  const localByRef = new Map(EffectArray.map(localCards, card => [card.ref, card] as const));
  const bridgeByRef = new Map(EffectArray.map(bridgeCards, card => [card.ref, card] as const));
  const canonicalLocalCard = (card: CodeGraphEvidenceCardV1): CodeGraphEvidenceCardV1 => {
    const bridge = bridgeByRef.get(card.ref);
    return bridge === undefined ? card : {...card, symbol: bridge.symbol};
  };
  const add = (card: CodeGraphEvidenceCardV1) => {
    if (output.length >= maximumCards || refs.has(card.ref)) return;
    output.push(card);
    refs.add(card.ref);
  };
  if (localCards[0] !== undefined) add(canonicalLocalCard(localCards[0]));
  for (const card of bridgeCards) {
    const local = localByRef.get(card.ref);
    add(local === undefined ? card : canonicalLocalCard(local));
  }
  for (const card of localCards.slice(1)) add(canonicalLocalCard(card));
  return output;
}

function readSeedDirection(
  threadnoteHome: string,
  published: CodeGraphWorksetCatalogPublishedGenerationV1,
  member: CodeGraphWorksetCatalogPublishedMemberV1,
  direction: 'incoming' | 'outgoing',
  bridgeSet: NonNullable<CodeGraphWorksetQueryBridgeExpansionV1['bridgeSet']>,
) {
  return Effect.gen(function* () {
    const bridges: CodeGraphCrossRepositoryBridgeV1[] = [];
    let after: CodeGraphCrossRepositoryBridgeCursorV1 | undefined;
    do {
      const remaining = MAXIMUM_BRIDGES_PER_SEED_DIRECTION - bridges.length;
      if (remaining <= 0) return {bridges, truncated: true};
      const page = yield* readCodeGraphWorksetCatalogRepositoryBridgePage(threadnoteHome, {
        ...(after === undefined ? {} : {after}),
        direction,
        generationId: published.id,
        limit: Math.min(BRIDGE_PAGE_SIZE, remaining),
        repository: {repositoryId: member.repositoryId, snapshotId: member.snapshotId},
      });
      if (
        page === undefined ||
        page.generationId !== published.id ||
        page.bridgeSetDigest !== bridgeSet.digest ||
        page.totalBridges !== bridgeSet.totalBridges ||
        page.coverage.state !== 'complete'
      ) {
        throw CodeGraphQueryExpansionError.make({
          message: 'The published bridge set changed or became incomplete during query expansion.',
        });
      }
      bridges.push(...page.bridges);
      after = page.next;
    } while (after !== undefined);
    return {bridges, truncated: false};
  });
}

interface BridgeCandidate {
  bridgeCount: number;
  bridgeId: string;
  readonly member: CodeGraphWorksetCatalogPublishedMemberV1;
  seedRank: number;
  seedScore: number;
}

function registerBridgeCandidate(
  additions: Map<string, BridgeCandidate>,
  publishedByKey: ReadonlyMap<string, CodeGraphWorksetCatalogPublishedMemberV1>,
  repositoryKey: string,
  seed: CodeGraphWorksetRouterRepositoryCandidateV1,
  bridge: CodeGraphCrossRepositoryBridgeV1,
): void {
  const member = publishedByKey.get(repositoryKey);
  if (member === undefined)
    throw CodeGraphQueryExpansionError.make({message: 'A bridge neighbor is absent from its published generation.'});
  const existing = additions.get(repositoryKey);
  if (existing === undefined) {
    additions.set(repositoryKey, {
      bridgeCount: 1,
      bridgeId: bridge.id,
      member,
      seedRank: seed.rank,
      seedScore: seed.score,
    });
    return;
  }
  existing.bridgeCount += 1;
  if (
    seed.rank < existing.seedRank ||
    (seed.rank === existing.seedRank && compareText(bridge.id, existing.bridgeId) < 0)
  ) {
    existing.bridgeId = bridge.id;
    existing.seedRank = seed.rank;
    existing.seedScore = seed.score;
  }
}

function validateExpansion(
  router: CodeGraphWorksetRouterResultV1,
  published: CodeGraphWorksetCatalogPublishedGenerationV1,
  expansion: CodeGraphWorksetQueryBridgeExpansionV1,
): void {
  if (!EffectArray.isArray(expansion.bridges) || expansion.bridges.length > MAXIMUM_EXPANSION_BRIDGES) {
    throw CodeGraphQueryExpansionError.make({message: 'Workset query bridge expansion exceeds its supported bound.'});
  }
  if (
    !Number.isSafeInteger(expansion.seededRepositories) ||
    expansion.seededRepositories < 0 ||
    expansion.seededRepositories > Math.min(DEFAULT_SEED_REPOSITORIES, router.repositories.length)
  ) {
    throw CodeGraphQueryExpansionError.make({message: 'Workset query bridge seed coverage is invalid.'});
  }
  if (expansion.bridges.length > 0 && expansion.bridgeSet === undefined) {
    throw CodeGraphQueryExpansionError.make({message: 'Workset query bridges have no generation receipt.'});
  }
  if (expansion.bridgeSet !== undefined && expansion.bridgeSet.generationId !== published.id) {
    throw CodeGraphQueryExpansionError.make({message: 'Workset query bridges belong to another generation.'});
  }
  const members = new Map(
    EffectArray.map(published.members, member => [`${member.repositoryId}\0${member.snapshotId}`, member] as const),
  );
  const seeds = new Set(EffectArray.map(router.repositories, repository => repository.repositoryKey));
  const seen = new Set<string>();
  for (const bridge of expansion.bridges) {
    if (seen.has(bridge.id))
      throw CodeGraphQueryExpansionError.make({message: 'Workset query bridge expansion contains a duplicate edge.'});
    seen.add(bridge.id);
    for (const endpoint of [bridge.source, bridge.target]) {
      const member = members.get(`${endpoint.repositoryId}\0${endpoint.snapshotId}`);
      if (member === undefined || member.repositoryKey !== endpoint.repositoryKey) {
        throw CodeGraphQueryExpansionError.make({
          message: 'Workset query bridge endpoint is outside the published generation.',
        });
      }
    }
    if (!seeds.has(bridge.source.repositoryKey) && !seeds.has(bridge.target.repositoryKey)) {
      throw CodeGraphQueryExpansionError.make({
        message: 'Workset query bridge is not adjacent to a routed repository.',
      });
    }
  }
}

function relationshipKey(relationship: CompactEvidenceRelationshipV1): string {
  return EffectArray.join(
    EffectArray.map(
      [
        relationship.source.repositoryKey,
        relationship.source.ref,
        relationship.relation,
        relationship.target.repositoryKey,
        relationship.target.ref,
        relationship.provenance,
        relationship.evidence.repositoryKey,
        relationship.evidence.path,
        relationship.evidence.span.line,
        relationship.evidence.span.column,
      ],
      item => (item === null || item === undefined ? '' : String(item)),
    ),
    '\0',
  );
}

function compareRelationship(left: CompactEvidenceRelationshipV1, right: CompactEvidenceRelationshipV1): number {
  return (
    (left.authority === 'authoritative' ? 0 : 1) - (right.authority === 'authoritative' ? 0 : 1) ||
    compareText(left.source.repositoryKey, right.source.repositoryKey) ||
    compareText(left.source.ref, right.source.ref) ||
    compareText(left.relation, right.relation) ||
    compareText(left.target.repositoryKey, right.target.repositoryKey) ||
    compareText(left.target.ref, right.target.ref) ||
    compareText(left.evidence.path, right.evidence.path) ||
    left.evidence.span.line - right.evidence.span.line ||
    left.evidence.span.column - right.evidence.span.column
  );
}

function compareBridge(left: CodeGraphCrossRepositoryBridgeV1, right: CodeGraphCrossRepositoryBridgeV1): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
