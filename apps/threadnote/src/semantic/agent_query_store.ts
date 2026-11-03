import {SecureRandom} from 'effect/crypto';
import {semanticHostSelection} from './host_catalog.js';
import {Array as EffectArray, Clock, Effect, FileSystem, Path, Schema, String as EffectString} from 'effect';
import {Evidence, Observation, observationKey, type QueryOutcome} from '@threadnote/semantic/contracts';
import {createQuerySnapshot, queryPage, type Continuation, type QuerySnapshot} from '@threadnote/semantic/views';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  semanticAgentQueryKey,
  type SemanticAgentEndpointQuery,
  type SemanticAgentQueryResult,
} from './agent_query_protocol.js';
import type {makeSemanticCoordinator} from './coordinator.js';
import {readBounded} from './fingerprint.js';
import {LspFault} from './lsp_transport.js';
import {SemanticSessionFault} from './provider.js';

interface RetainedQuery {
  readonly binding: string;
  readonly snapshot: QuerySnapshot;
  readonly bytes: number;
  readonly createdAt: number;
  lastUsed: number;
}

/** Saved-disk sessions are host-owned and remain in the existing coordinator between CLI invocations. */
export const makeSemanticAgentDiskQueries = Effect.fn('semantic.agentDiskQueries')(function* (
  coordinator: Pick<Effect.Success<ReturnType<typeof makeSemanticCoordinator>>, 'observe' | 'attach' | 'use'>,
  worktree: string,
  runtimeIdentity: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const namespace = sha256HexSync(yield* crypto.randomBytes(32));
  const store = makeSemanticAgentQueryStore(namespace, (observation, milliseconds) =>
    coordinator.observe(observation, milliseconds),
  );
  const root = yield* path.fromFileUrl(new URL(worktree));
  const query = Effect.fn('semantic.agentDiskQuery')(function* (request: SemanticAgentEndpointQuery) {
    if (
      request.worktree !== worktree ||
      request.query !== semanticAgentQueryKey(runtimeIdentity, request.profile, request)
    )
      return {
        version: 1 as const,
        status: 'invalid-request' as const,
        reason: 'Query does not match this authenticated coordinator scope',
        evidence: null,
      };
    const budget = {maxItems: request.maxItems, maxBytes: request.maxBytes};
    if (request.cursor)
      return yield* store.page(request.query, request.cursor.snapshot, budget, request.milliseconds, request.cursor);
    const project = yield* path.fromFileUrl(new URL(request.project));
    const file = yield* path.fromFileUrl(new URL(request.uri));
    if (
      !(project === root || EffectString.startsWith(root + path.sep)(project)) ||
      !EffectString.startsWith(project + path.sep)(file) ||
      EffectString.split(path.sep)(file).includes('.git') ||
      (yield* fs.realPath(project)) !== project ||
      (yield* fs.realPath(file)) !== file
    )
      return {
        version: 1 as const,
        status: 'invalid-request' as const,
        reason: 'Source is outside this canonical project or uses an unsupported link',
        evidence: null,
      };
    const bytes = yield* readBounded(file, 4 * 1024 * 1024);
    const text = yield* Effect.try({
      try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
      catch: () => LspFault.make({code: 'protocol'}),
    });
    const provider = semanticHostSelection[request.language].provider;
    const seed: Observation = {
      version: 1,
      repository: sha256HexSync(worktree),
      worktree,
      project: request.project,
      configuration: EffectString.repeat(64)('0'),
      toolchain: EffectString.repeat(64)('0'),
      provider: {id: provider, version: 'host-unbound', generation: 0},
      view: {
        kind: 'disk',
        id: sha256HexSync(JSON.stringify([request.project, request.language, request.environment ?? null])),
        owner: 'agent-disk:' + sha256HexSync(namespace),
        epoch: 0,
      },
      uri: request.uri,
      content: sha256HexSync(bytes),
      documentVersion: null,
      projectEpoch: 0,
    };
    const attached = yield* coordinator.attach(seed, text, request.language, request.environment);
    const outcome = yield* coordinator.use(attached.observation, request.milliseconds, api =>
      request.operation === 'diagnostics'
        ? Effect.gen(function* () {
            const snapshot = yield* api.diagnostics(attached.observation, request.milliseconds);
            if (snapshot.evidence === undefined)
              return {
                version: 1 as const,
                status: 'unsupported' as const,
                reason: 'Provider does not publish observation-bound diagnostic coverage',
                evidence: null,
              };
            const observed = yield* Schema.decodeEffect(Observation)(snapshot.observation).pipe(
              Effect.mapError(() => SemanticSessionFault.make({reason: 'provider'})),
            );
            const evidence = yield* Schema.decodeEffect(Evidence)(snapshot.evidence).pipe(
              Effect.mapError(() => SemanticSessionFault.make({reason: 'provider'})),
            );
            if (evidence.basis !== 'semantic') return yield* SemanticSessionFault.make({reason: 'provider'});
            if (
              observationKey(observed) !== observationKey(attached.observation) ||
              observationKey(evidence.observation) !== observationKey(observed)
            )
              return yield* SemanticSessionFault.make({reason: 'stale'});
            return {
              version: 1 as const,
              status: 'ok' as const,
              evidence: {...evidence, scope: 'document:' + sha256HexSync(observed.uri)},
              // Public reads retain the full current set, independently of delivery deltas.
              items: EffectArray.map(snapshot.items, item => ({
                id: item.id,
                range: {
                  start: {line: item.range.start.line, character: item.range.start.character},
                  end: {line: item.range.end.line, character: item.range.end.character},
                },
                code: item.code,
                category: item.category,
                message: item.message,
              })),
            };
          })
        : api.query(request.operation, attached.observation, request.position, request.milliseconds),
    );
    if (outcome.status !== 'ok') return outcome;
    const now = yield* Clock.currentTimeMillis;
    const snapshot = yield* Effect.try({
      try: () => store.retain(request.query, outcome, now),
      catch: () => LspFault.make({code: 'capacity'}),
    });
    if (!snapshot)
      return {
        version: 1 as const,
        status: 'budget-exceeded' as const,
        reason: 'Complete provider result exceeds the bounded retained-query capacity; no partial set was substituted',
        evidence: null,
      };
    return yield* store.page(request.query, snapshot.id, budget, request.milliseconds);
  });
  return {
    query: (request: SemanticAgentEndpointQuery) =>
      query(request).pipe(
        Effect.timeoutOption(request.milliseconds),
        Effect.map(result =>
          result._tag === 'Some'
            ? result.value
            : {
                version: 1 as const,
                status: 'timeout' as const,
                reason: 'Semantic query deadline expired',
                evidence: null,
              },
        ),
      ),
    prune: store.prune,
    status: store.status,
  };
});
export const semanticAgentQueryLimits = {
  maxSnapshots: 32,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxRetainedBytes: 16 * 1024 * 1024,
  ttlMilliseconds: 600000,
} as const;
const stale = (): SemanticAgentQueryResult => ({
  version: 1,
  status: 'stale',
  reason: 'Query snapshot expired, changed or is unavailable in this scope',
  evidence: null,
});

/** One coordinator owns this bounded, volatile cache. Cursors never contain or supply result items. */
export function makeSemanticAgentQueryStore<R>(
  namespace: string,
  observe: (observation: Observation, milliseconds: number) => Effect.Effect<Observation | undefined, unknown, R>,
) {
  const entries = new Map<string, RetainedQuery>();
  let sequence = 0;
  let retainedBytes = 0;
  const drop = (id: string) => {
    const entry = entries.get(id);
    if (entry) {
      entries.delete(id);
      retainedBytes -= entry.bytes;
    }
  };
  const prune = (now: number) => {
    for (const [id, entry] of entries) {
      if (now - entry.createdAt >= semanticAgentQueryLimits.ttlMilliseconds || now < entry.createdAt) drop(id);
    }
  };
  const retain = (binding: string, outcome: Extract<QueryOutcome, {status: 'ok'}>, now: number) => {
    prune(now);
    if (sequence >= Number.MAX_SAFE_INTEGER) return undefined;
    const snapshot = createQuerySnapshot({
      id: sha256HexSync(JSON.stringify([namespace, sequence + 1])),
      query: binding,
      evidence: outcome.evidence,
      items: outcome.items,
    });
    // Bounds describe serialized retained data; the finite entry count also bounds per-object bookkeeping.
    const entry = {binding, snapshot, createdAt: now, lastUsed: now};
    const bytes =
      new TextEncoder().encode(
        JSON.stringify({
          ...entry,
          createdAt: Number.MAX_SAFE_INTEGER,
          lastUsed: Number.MAX_SAFE_INTEGER,
          bytes: Number.MAX_SAFE_INTEGER,
        }),
      ).length + snapshot.id.length;
    if (bytes > semanticAgentQueryLimits.maxSnapshotBytes) return undefined;
    while (
      entries.size >= semanticAgentQueryLimits.maxSnapshots ||
      retainedBytes + bytes > semanticAgentQueryLimits.maxRetainedBytes
    ) {
      let oldest: readonly [string, RetainedQuery] | undefined;
      for (const entry of entries) if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry;
      if (!oldest) return undefined;
      drop(oldest[0]);
    }
    sequence++;
    entries.set(snapshot.id, {...entry, bytes});
    retainedBytes += bytes;
    return snapshot;
  };
  const page = Effect.fn('semantic.agentQueryPage')(function* (
    binding: string,
    snapshotId: string,
    budget: {readonly maxItems: number; readonly maxBytes: number},
    milliseconds: number,
    cursor?: Continuation,
  ) {
    let now = yield* Clock.currentTimeMillis;
    prune(now);
    const entry = entries.get(snapshotId);
    if (!entry || entry.binding !== binding) return stale();
    const current = yield* observe(entry.snapshot.evidence.observation, milliseconds);
    now = yield* Clock.currentTimeMillis;
    prune(now);
    if (!current || entries.get(snapshotId) !== entry) {
      drop(snapshotId);
      return stale();
    }
    const result = queryPage(entry.snapshot, current, binding, budget, cursor);
    if (result.status === 'page') {
      entry.lastUsed = now;
      return result.page;
    }
    if (result.status === 'stale') {
      drop(snapshotId);
      return stale();
    }
    return {
      version: 1 as const,
      status: result.status === 'invalid-cursor' ? ('invalid-cursor' as const) : ('budget-exceeded' as const),
      reason:
        result.status === 'invalid-cursor'
          ? 'Continuation does not identify this immutable query'
          : 'Requested page cannot fit its mandatory metadata and items',
      evidence: null,
    };
  });
  return {
    retain,
    page,
    prune,
    clear: () => {
      entries.clear();
      retainedBytes = 0;
    },
    status: () => ({snapshots: entries.size, retainedBytes}),
  };
}
