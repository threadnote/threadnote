import {parseLexicalViewBinding, lexicalViewBindingMatches, isLexicalV2Snapshot} from '../store/lexical_projection.js';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Clock, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {readDeadlineRemaining, withinReadDeadline, type ReadDeadline} from '@threadnote/platform/read_deadline';
import {BODY_DISCOVERY_PREFIX, discoveryTerms} from '../languages/body_discovery.js';
import {withFreshCodeGraphReadTransaction} from '../store/session.js';
import {
  taskExpansionStatement,
  taskPostingStatement,
  taskPostingV2Statement,
  taskHeaderStatement,
  taskNodeStatement,
} from '../store/query/core.js';
import {edgeFromRow, symbolFromRow} from '../store/rows.js';
import type {EdgeRow, SymbolRow} from '../store/internal_models.js';
import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphQueryResult} from '../types.js';

/** Mutable request-owned allowances. Reuse this exact object for subsequent source/fact acquisition. */
export interface TaskDiscoveryBudget {
  remainingReads: number;
  remainingBytes: number;
  remainingNodes: number;
  remainingEdges: number;
  readonly deadline: ReadDeadline;
}
export interface TaskDiscoveryRequest {
  readonly databasePath: string;
  readonly observation: Pick<CodeGraphQueryResult, 'repository' | 'snapshot' | 'freshness' | 'projectCoverage'>;
  readonly task: string;
  readonly budget: TaskDiscoveryBudget;
  readonly packageName?: string;
  readonly paths?: readonly string[];
  readonly depth?: 0 | 1 | 2;
}
export interface TaskPosting {
  readonly id: string;
  readonly term: string;
  readonly weight: number;
  readonly path: string | null;
  readonly package_name: string | null;
  readonly content_hash: string | null;
  readonly eligible: number;
  readonly transfer_valid?: number;
  readonly row_valid?: number;
}
export interface TaskCandidate {
  readonly id: string;
  readonly score: number;
  readonly origin: 'metadata' | 'body';
}
const POSTING_BYTES = 32_768;
const NODE_BYTES = 32_768;
const EDGE_BYTES = 32_768;
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^cgs_[a-f0-9]{32}$/u;

/** Eligibility is applied to an already finite batch, before either origin's candidate cut. */
export function rankTaskPostings(
  rows: readonly TaskPosting[],
  origin: TaskCandidate['origin'],
  scope: Pick<TaskDiscoveryRequest, 'packageName' | 'paths'>,
): readonly TaskCandidate[] {
  const scores = new Map<string, number>();
  for (const row of rows) {
    if (
      row.row_valid === 0 ||
      row.eligible !== 1 ||
      !ID.test(row.id) ||
      row.path === null ||
      row.path.length > 4_096 ||
      row.content_hash === null ||
      !HASH.test(row.content_hash) ||
      (scope.packageName !== undefined &&
        (row.package_name == null ? undefined : EffectString.toLowerCase(row.package_name)) !==
          EffectString.toLowerCase(scope.packageName)) ||
      (scope.paths !== undefined &&
        !EffectArray.some(
          scope.paths,
          path => row.path === path || (row.path !== null && EffectString.startsWith(path + '/')(row.path)),
        ))
    )
      continue;
    if (
      !Number.isFinite(row.weight) ||
      row.weight <= 0 ||
      row.weight > 5 ||
      EffectString.startsWith(BODY_DISCOVERY_PREFIX)(row.term) !== (origin === 'body')
    )
      continue;
    scores.set(row.id, (scores.get(row.id) ?? 0) + row.weight);
  }
  return EffectArray.map([...scores], ([id, score]) => ({id, score, origin})).sort(
    (a, b) => b.score - a.score || EffectString.localeCompare(b.id)(a.id),
  );
}

/** Body admission is independent of metadata saturation, with deterministic scoped deduplication. */
export function selectTaskSeeds(
  metadata: readonly TaskCandidate[],
  body: readonly TaskCandidate[],
  limit: number,
): readonly TaskCandidate[] {
  const selected = new Map<string, TaskCandidate>();
  const add = (candidate: TaskCandidate) => {
    if (!selected.has(candidate.id) && selected.size < limit) selected.set(candidate.id, candidate);
  };
  for (const candidate of body.slice(0, Math.max(1, Math.ceil(limit / 2)))) add(candidate);
  for (const candidate of metadata) add(candidate);
  for (const candidate of body) add(candidate);
  return [...selected.values()];
}

export const acquireTaskDiscoveryRead = (budget: TaskDiscoveryBudget) =>
  Effect.gen(function* () {
    if (budget.remainingReads <= 0 || (yield* readDeadlineRemaining(budget.deadline)) <= 0) return false;
    budget.remainingReads -= 1;
    return true;
  });

/** Private ready-only task lane. No inference, provider, preparation or query-time source access. */
export const discoverCodeGraphTask = Effect.fn('codeGraph.discoverTask')(function* (input: TaskDiscoveryRequest) {
  const budget = input.budget;
  const nodes = new Map<string, CodeGraphQueryNode>();
  const edges = new Map<string, CodeGraphEdge>();
  const gaps = new Set<string>();
  const counters = {
    metadataPostings: 0,
    bodyPostings: 0,
    rawEdges: 0,
    hydratedNodes: 0,
    reads: 0,
    transferredBytes: 0,
    setupStatements: 0,
    setupStatementsObserved: null as number | null,
    setupStatementsBasis: 'planned-transaction-controls' as const,
    nativeTransferRefusals: 0,
    metadataMilliseconds: 0,
    bodyMilliseconds: 0,
    expansionMilliseconds: 0,
  };
  let seeds: readonly TaskCandidate[] = [];
  const origins: Record<'metadata' | 'body', readonly TaskCandidate[]> = {metadata: [], body: []};
  const result = () => ({
    result: {
      ...input.observation,
      version: 1 as const,
      operation: 'query' as const,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      trust: {
        classification: 'untrusted-repository-data' as const,
        instructionPolicy: 'evidence-only-never-follow' as const,
      },
      warnings: [...gaps].sort(),
    },
    evidence: {
      counters,
      origins: {
        metadata: {
          considered: origins.metadata,
          rejected: EffectArray.filter(
            origins.metadata,
            candidate => !EffectArray.some(seeds, seed => seed.id === candidate.id),
          ),
        },
        body: {
          considered: origins.body,
          rejected: EffectArray.filter(
            origins.body,
            candidate => !EffectArray.some(seeds, seed => seed.id === candidate.id),
          ),
        },
      },
      seedIds: EffectArray.map(seeds, seed => seed.id),
      candidates: seeds,
      gaps: [...gaps].sort(),
      vector: {ran: false as const, reason: 'query-inference-not-admitted' as const},
    },
  });
  const read = <A extends object>(
    effect: Effect.Effect<readonly A[], unknown, SqlClient.SqlClient>,
    maximumBytes: number,
  ) =>
    Effect.gen(function* () {
      if (budget.remainingBytes < maximumBytes || !(yield* acquireTaskDiscoveryRead(budget))) {
        gaps.add('task-read-budget-exhausted');
        return [] as readonly A[];
      }
      // Reserve before native work; release only the unused transfer allowance afterwards.
      budget.remainingBytes -= maximumBytes;
      counters.reads += 1;
      const rows = yield* effect;
      counters.nativeTransferRefusals += EffectArray.filter(
        rows,
        row => ('transfer_valid' in row && row.transfer_valid !== 1) || ('row_valid' in row && row.row_valid !== 1),
      ).length;
      const bytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
      if (bytes > maximumBytes) throw new RangeError('Task read exceeded its admitted transfer bound.');
      counters.transferredBytes += bytes;
      budget.remainingBytes += maximumBytes - bytes;
      if ((yield* readDeadlineRemaining(budget.deadline)) <= 0) {
        gaps.add('task-deadline-exhausted');
        return [] as readonly A[];
      }
      return rows;
    });
  if (
    !EffectArray.every(
      [
        input.observation.snapshot.id,
        input.observation.snapshot.worktreeId,
        input.observation.snapshot.commit,
        input.observation.repository.repositoryId,
      ],
      value => value.length <= 128 && Buffer.byteLength(value, 'utf8') <= 128,
    ) ||
    (input.packageName !== undefined &&
      (input.packageName.length > 256 || Buffer.byteLength(input.packageName, 'utf8') > 256)) ||
    (input.paths !== undefined &&
      (input.paths.length > 128 ||
        EffectArray.some(input.paths, path => path.length > 4096 || Buffer.byteLength(path, 'utf8') > 4096))) ||
    (input.depth !== undefined && (!Number.isSafeInteger(input.depth) || input.depth < 0 || input.depth > 2)) ||
    !EffectArray.every(
      [budget.remainingReads, budget.remainingBytes, budget.remainingNodes, budget.remainingEdges],
      value => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    gaps.add('task-invalid-admission');
    return result();
  }
  if (
    budget.remainingNodes < 1 ||
    budget.remainingReads < 1 ||
    budget.remainingBytes < NODE_BYTES ||
    (yield* readDeadlineRemaining(budget.deadline)) <= 0
  ) {
    gaps.add('task-budget-exhausted');
    return result();
  }
  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    counters.setupStatements = 2; // BEGIN and COMMIT; fresh acquisition uses a read-only connection.
    const snapshotId = input.observation.snapshot.id;
    const headerQuery = taskHeaderStatement(snapshotId);
    const header = (yield* read(
      sql.unsafe<{
        readonly repository_id: string;
        readonly worktree_id: string;
        readonly commit_id: string;
        readonly dirty: number;
        readonly base_snapshot_id: string | null;
        readonly compact_current: number;
        readonly compact_base: number;
        readonly row_valid: number;
        readonly transfer_valid: number;
        readonly layout_current?: string | null;
        readonly layout_base?: string | null;
      }>(headerQuery.text, headerQuery.parameters),
      4096,
    ))[0];
    if (
      !header ||
      header.row_valid !== 1 ||
      header.transfer_valid !== 1 ||
      header.repository_id !== input.observation.repository.repositoryId ||
      header.worktree_id !== input.observation.snapshot.worktreeId ||
      header.commit_id !== input.observation.snapshot.commit ||
      (header.dirty === 1) !== input.observation.snapshot.dirty
    ) {
      gaps.add('task-observation-conflict');
      return;
    }
    const base = header.base_snapshot_id ?? undefined;
    if (isLexicalV2Snapshot(snapshotId)) {
      const layout = parseLexicalViewBinding(header.layout_current);
      const baseLayout = base === undefined ? undefined : parseLexicalViewBinding(header.layout_base);
      if (
        !layout ||
        !lexicalViewBindingMatches(snapshotId, layout.logicalSnapshotId, layout) ||
        layout.baseSnapshotId !== base ||
        (base !== undefined &&
          (!baseLayout || !lexicalViewBindingMatches(base, baseLayout.logicalSnapshotId, baseLayout)))
      ) {
        gaps.add('task-observation-layout-conflict');
        return;
      }
    }
    if (header.compact_current !== 1 && header.compact_current !== 2)
      gaps.add('task-current-lexical-format-unsupported');
    if (base !== undefined && header.compact_base !== 1 && header.compact_base !== 2)
      gaps.add('task-base-lexical-format-unsupported');
    if (![1, 2].includes(header.compact_current) || (base !== undefined && ![1, 2].includes(header.compact_base)))
      gaps.add('task-lexical-coverage-partial');
    // No unsafe legacy weight read, invented unit score, or absence claim. Keep any
    // compatible compact contributor, and stop after this charged header if neither fits.
    if (![1, 2].includes(header.compact_current) && (base === undefined || ![1, 2].includes(header.compact_base)))
      return;
    if (
      base !== undefined &&
      [1, 2].includes(header.compact_current) &&
      [1, 2].includes(header.compact_base) &&
      header.compact_current !== header.compact_base
    ) {
      gaps.add('task-mixed-lexical-format-unsupported');
      return;
    }
    const terms = EffectArray.filter(
      discoveryTerms(EffectString.slice(0, 4_096)(input.task)),
      term => Buffer.byteLength(term, 'utf8') <= 128,
    );
    if (terms.length === 0) {
      gaps.add('task-no-terms');
      return;
    }
    const depth = input.depth ?? 1;
    const reserveNodes =
      depth > 0 && budget.remainingEdges > 0 ? Math.max(1, Math.min(12, Math.floor(budget.remainingNodes / 2))) : 0;
    const seedLimit = Math.min(12, Math.max(1, budget.remainingNodes - reserveNodes));
    // Both origins share the remaining byte/read envelope. Body receives the same reservation first.
    const postingLimit = Math.max(
      0,
      Math.min(
        128,
        seedLimit * 16,
        Math.floor(
          Math.max(0, budget.remainingBytes - (seedLimit + reserveNodes) * NODE_BYTES - EDGE_BYTES) /
            (2 * POSTING_BYTES),
        ),
      ),
    );
    if (postingLimit === 0 || budget.remainingReads < (depth > 0 ? 5 : 3)) {
      gaps.add('task-discovery-admission-denied');
      return;
    }
    for (const origin of ['body', 'metadata'] as const) {
      const started = yield* Clock.monotonicTimeNanos;
      const statement = (header.compact_current === 2 ? taskPostingV2Statement : taskPostingStatement)(
        snapshotId,
        base,
        origin === 'body' ? EffectArray.map(terms, term => BODY_DISCOVERY_PREFIX + term) : terms,
        postingLimit,
      );
      const postings = yield* read(
        sql.unsafe<TaskPosting>(statement.text, statement.parameters),
        postingLimit * POSTING_BYTES,
      );
      if (EffectArray.some(postings, row => row.transfer_valid !== 1 || row.row_valid !== 1))
        gaps.add('task-posting-metadata-omitted');
      counters[origin === 'body' ? 'bodyPostings' : 'metadataPostings'] += postings.length;
      counters[origin === 'body' ? 'bodyMilliseconds' : 'metadataMilliseconds'] +=
        Number((yield* Clock.monotonicTimeNanos) - started) / 1e6;
      if (postings.length === postingLimit) gaps.add(`task-${origin}-posting-cap-reached`);
      origins[origin] = rankTaskPostings(postings, origin, input);
    }
    seeds = selectTaskSeeds(origins.metadata, origins.body, seedLimit);
    const hydrate = (ids: readonly string[], scores: ReadonlyMap<string, number>) =>
      Effect.gen(function* () {
        const admitted = EffectArray.filter([...new Set(ids)], id => !nodes.has(id)).slice(0, budget.remainingNodes);
        if (admitted.length === 0) return;
        const statement = taskNodeStatement(snapshotId, base, admitted);
        const rows = yield* read(
          sql.unsafe<SymbolRow & {readonly row_valid: number; readonly transfer_valid: number}>(
            statement.text,
            statement.parameters,
          ),
          admitted.length * NODE_BYTES,
        );
        budget.remainingNodes -= rows.length;
        counters.hydratedNodes += rows.length;
        if (EffectArray.some(rows, row => row.row_valid !== 1 || row.transfer_valid !== 1))
          gaps.add('task-node-metadata-omitted');
        const byId = new Map(EffectArray.map(rows, row => [row.id, row]));
        for (const id of admitted) {
          const row = byId.get(id);
          if (row === undefined) continue;
          if (
            row.row_valid !== 1 ||
            row.transfer_valid !== 1 ||
            row.kind === null ||
            row.language === null ||
            row.name === null ||
            row.path === null ||
            row.qualified_name === null ||
            row.span_json === null ||
            row.id.length > 256 ||
            row.kind.length > 128 ||
            row.language.length > 128 ||
            !HASH.test(row.content_hash)
          ) {
            gaps.add('task-node-metadata-omitted');
            continue;
          }
          const decoded = yield* Effect.try(() => symbolFromRow(row)).pipe(Effect.option);
          if (decoded._tag === 'None') {
            gaps.add('task-node-metadata-omitted');
            continue;
          }
          const symbol = decoded.value;
          if (
            (input.paths !== undefined &&
              !EffectArray.some(
                input.paths,
                path => symbol.path === path || EffectString.startsWith(path + '/')(symbol.path),
              )) ||
            (input.packageName !== undefined &&
              (symbol.packageName == null ? undefined : EffectString.toLowerCase(symbol.packageName)) !==
                EffectString.toLowerCase(input.packageName))
          ) {
            gaps.add('task-neighbor-scope-omitted');
            continue;
          }
          nodes.set(symbol.id, {...symbol, score: scores.get(symbol.id) ?? 0.5});
        }
      });
    yield* hydrate(
      EffectArray.map(seeds, seed => seed.id),
      new Map(EffectArray.map(seeds, seed => [seed.id, seed.origin === 'body' ? 100 + seed.score : seed.score])),
    );
    let frontier = [...nodes.keys()];
    for (let step = 0; step < depth && frontier.length > 0; step += 1) {
      if (budget.remainingEdges <= 0 || budget.remainingNodes <= 0) {
        gaps.add('task-critical-expansion-omitted');
        break;
      }
      const started = yield* Clock.monotonicTimeNanos;
      const limit = Math.min(128, budget.remainingEdges, Math.floor(budget.remainingBytes / (EDGE_BYTES + NODE_BYTES)));
      if (limit < 1 || budget.remainingReads < 2) {
        gaps.add('task-critical-expansion-omitted');
        break;
      }
      if (frontier.length > 12) gaps.add('task-frontier-cap-reached');
      const statement = taskExpansionStatement(snapshotId, base, frontier.slice(0, 12), limit);
      const rows = yield* read(
        sql.unsafe<EdgeRow & {readonly eligible: number; readonly row_valid: number; readonly transfer_valid: number}>(
          statement.text,
          statement.parameters,
        ),
        limit * EDGE_BYTES,
      );
      if (EffectArray.some(rows, row => row.row_valid !== 1 || row.transfer_valid !== 1))
        gaps.add('task-edge-metadata-omitted');
      counters.rawEdges += rows.length;
      budget.remainingEdges -= rows.length;
      if (rows.length === limit) gaps.add('task-edge-cap-reached');
      const accepted: CodeGraphEdge[] = [];
      const eligible = EffectArray.filter(
        rows,
        row =>
          row.row_valid === 1 &&
          row.transfer_valid === 1 &&
          row.eligible === 1 &&
          row.source_id !== null &&
          row.target_id !== null &&
          (row.provenance === 'resolved' || row.provenance === 'syntactic' || row.provenance === 'declared'),
      );
      for (const row of eligible) {
        const decoded = yield* Effect.try(() => edgeFromRow(row)).pipe(Effect.option);
        if (decoded._tag === 'Some') accepted.push(decoded.value);
        else gaps.add('task-edge-metadata-omitted');
      }
      const adjacent = EffectArray.filter(
        [...new Set(EffectArray.flatMap(accepted, edge => [edge.sourceId!, edge.targetId!]))],
        id => !nodes.has(id),
      );
      const before = new Set(nodes.keys());
      yield* hydrate(adjacent, new Map());
      for (const edge of accepted) {
        if (nodes.has(edge.sourceId!) && nodes.has(edge.targetId!)) edges.set(edge.id, edge);
        else gaps.add('task-critical-expansion-omitted');
      }
      frontier = EffectArray.filter([...nodes.keys()], id => !before.has(id));
      counters.expansionMilliseconds += Number((yield* Clock.monotonicTimeNanos) - started) / 1e6;
    }
  });
  yield* withinReadDeadline(budget.deadline, withFreshCodeGraphReadTransaction(input.databasePath, program)).pipe(
    Effect.catchTag('ReadDeadlineExceeded', () =>
      Effect.sync(() => {
        gaps.add('task-deadline-exhausted');
      }),
    ),
  );
  return result();
});
