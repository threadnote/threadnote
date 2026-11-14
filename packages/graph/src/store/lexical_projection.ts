import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as EffectArray from 'effect/Array';
import {closeBodyDiscovery, discoveryTerms, validateBodyDiscovery} from '../languages/body_discovery.js';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphBodyDiscovery, CodeGraphSymbol} from '../types.js';
import {CodeGraphStoreError} from '../types.js';
import {Context, Effect, Option} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';

/** Logical checkpoint/source ABI and physical storage evolve independently. */
export const CODE_GRAPH_LEXICAL_LOGICAL_VERSION = 1 as const;
export const CODE_GRAPH_LEXICAL_V2_FORMAT_VERSION = 2 as const;
export const CODE_GRAPH_LEXICAL_V2_ORDER_REVISION = 1 as const;

export const CODE_GRAPH_SNAPSHOT_ID_PATTERN = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16}|-lx2)?$/u;
export const isLexicalV2Snapshot = (snapshotId: string): boolean => /^cgsn_[0-9a-f]{40}-lx2$/u.test(snapshotId);

export interface LexicalViewBinding {
  readonly logicalSnapshotId: string;
  readonly mode: 'full' | 'direct' | 'overlay' | 'alias';
  readonly baseSnapshotId?: string;
  readonly forceGeneration?: string;
  readonly orderRevision: typeof CODE_GRAPH_LEXICAL_V2_ORDER_REVISION;
}

// Request-local capability only; never serialized into graph or checkpoint payloads.
const observedLayouts = new WeakMap<object, LexicalViewBinding>();
export function bindLexicalSnapshotLayout<A extends object>(snapshot: A, binding: LexicalViewBinding): A {
  observedLayouts.set(snapshot, binding);
  return snapshot;
}
export const lexicalSnapshotLayoutMode = (snapshot: object): LexicalViewBinding['mode'] | undefined =>
  observedLayouts.get(snapshot)?.mode;

export const lexicalSnapshotLogicalIdentity = (snapshot: object): string | undefined =>
  observedLayouts.get(snapshot)?.logicalSnapshotId;

/** The suffix selects a decoder; only a matching persisted receipt grants capability. */
export function lexicalPhysicalSnapshotIdentity(
  logicalId: string,
  mode: 'full' | 'direct' | 'overlay' | 'alias',
  baseSnapshotId?: string,
  forceGeneration?: string,
): string {
  return `cgsn_${EffectString.slice(
    0,
    40,
  )(
    sha256HexSync(
      JSON.stringify([
        'lexical-physical-view',
        CODE_GRAPH_LEXICAL_V2_FORMAT_VERSION,
        CODE_GRAPH_LEXICAL_V2_ORDER_REVISION,
        logicalId,
        mode,
        baseSnapshotId ?? null,
        forceGeneration ?? null,
      ]),
    ),
  )}-lx2`;
}

export function lexicalViewBindingMatches(
  snapshotId: string,
  logicalSnapshotId: string,
  binding: LexicalViewBinding | undefined,
): boolean {
  return (
    binding !== undefined &&
    /^cgsn_[0-9a-f]{40}$/u.test(logicalSnapshotId) &&
    binding.logicalSnapshotId === logicalSnapshotId &&
    binding.orderRevision === CODE_GRAPH_LEXICAL_V2_ORDER_REVISION &&
    ['full', 'direct', 'overlay', 'alias'].includes(binding.mode) &&
    (binding.baseSnapshotId === undefined || isLexicalV2Snapshot(binding.baseSnapshotId)) &&
    (binding.forceGeneration === undefined || /^[0-9a-f]{16}$/u.test(binding.forceGeneration)) &&
    (binding.mode === 'overlay' || binding.mode === 'alias') === (binding.baseSnapshotId !== undefined) &&
    snapshotId ===
      lexicalPhysicalSnapshotIdentity(logicalSnapshotId, binding.mode, binding.baseSnapshotId, binding.forceGeneration)
  );
}

export function parseLexicalViewBinding(value: unknown): LexicalViewBinding | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) return undefined;
  try {
    const raw: unknown = JSON.parse(value);
    if (raw === null || typeof raw !== 'object' || EffectArray.isArray(raw)) return undefined;
    const fields = new Set(['logicalSnapshotId', 'mode', 'baseSnapshotId', 'forceGeneration', 'orderRevision']);
    for (const key of EffectRecord.keys(raw)) if (!fields.has(key)) return undefined;
    if (
      !('logicalSnapshotId' in raw) ||
      typeof raw.logicalSnapshotId !== 'string' ||
      !('mode' in raw) ||
      typeof raw.mode !== 'string' ||
      !('orderRevision' in raw) ||
      raw.orderRevision !== CODE_GRAPH_LEXICAL_V2_ORDER_REVISION
    )
      return undefined;
    const base = 'baseSnapshotId' in raw ? raw.baseSnapshotId : undefined;
    const generation = 'forceGeneration' in raw ? raw.forceGeneration : undefined;
    if (base !== null && base !== undefined && typeof base !== 'string') return undefined;
    if (generation !== null && generation !== undefined && typeof generation !== 'string') return undefined;
    const mode = raw.mode;
    if (mode !== 'full' && mode !== 'direct' && mode !== 'overlay' && mode !== 'alias') return undefined;
    const binding: LexicalViewBinding = {
      logicalSnapshotId: raw.logicalSnapshotId,
      mode,
      ...(typeof base === 'string' ? {baseSnapshotId: base} : {}),
      ...(typeof generation === 'string' ? {forceGeneration: generation} : {}),
      orderRevision: CODE_GRAPH_LEXICAL_V2_ORDER_REVISION,
    };
    return binding;
  } catch {
    return undefined;
  }
}

export function lexicalViewBindingFor(
  snapshotId: string,
  logicalSnapshotId: string,
  baseSnapshotId?: string,
  forceGeneration?: string,
): LexicalViewBinding | undefined {
  if (!isLexicalV2Snapshot(snapshotId)) return undefined;
  for (const mode of ['full', 'direct', 'overlay', 'alias'] as const) {
    const binding = {
      logicalSnapshotId,
      mode,
      baseSnapshotId,
      forceGeneration,
      orderRevision: CODE_GRAPH_LEXICAL_V2_ORDER_REVISION,
    };
    if (lexicalViewBindingMatches(snapshotId, logicalSnapshotId, binding)) return binding;
  }
  // A resumed force build uses its already persisted original generation.
  return undefined;
}

export class LexicalViewBindingContext extends Context.Service<LexicalViewBindingContext, LexicalViewBinding>()(
  '@threadnote/graph/store/lexical_projection/LexicalViewBindingContext',
) {}

export const loadLexicalViewBinding = Effect.fn('codeGraph.loadLexicalViewBinding')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  const rows = yield* sql<{
    readonly logical_snapshot_id: string;
    readonly layout_mode: LexicalViewBinding['mode'];
    readonly base_snapshot_id: string | null;
    readonly force_generation: string | null;
    readonly order_revision: number;
    readonly row_valid: number;
  }>`SELECT
    CASE WHEN typeof(logical_snapshot_id)='text' AND octet_length(logical_snapshot_id)<=128 THEN logical_snapshot_id ELSE NULL END AS logical_snapshot_id,
    CASE WHEN typeof(layout_mode)='text' AND octet_length(layout_mode)<=16 THEN layout_mode ELSE NULL END AS layout_mode,
    CASE WHEN typeof(base_snapshot_id)='text' AND octet_length(base_snapshot_id)<=128 THEN base_snapshot_id ELSE NULL END AS base_snapshot_id,
    CASE WHEN typeof(force_generation)='text' AND octet_length(force_generation)<=16 THEN force_generation ELSE NULL END AS force_generation,
    order_revision,
    CASE WHEN (base_snapshot_id IS NULL OR (typeof(base_snapshot_id)='text' AND octet_length(base_snapshot_id)<=128))
      AND (force_generation IS NULL OR (typeof(force_generation)='text' AND octet_length(force_generation)=16))
      THEN 1 ELSE 0 END AS row_valid
    FROM lexical_v2_views WHERE snapshot_id=${snapshotId} LIMIT 1`;
  const row = rows[0];
  if (!row || row.row_valid !== 1 || row.order_revision !== CODE_GRAPH_LEXICAL_V2_ORDER_REVISION) return undefined;
  const binding: LexicalViewBinding = {
    logicalSnapshotId: row.logical_snapshot_id,
    mode: row.layout_mode,
    ...(row.base_snapshot_id === null ? {} : {baseSnapshotId: row.base_snapshot_id}),
    ...(row.force_generation === null ? {} : {forceGeneration: row.force_generation}),
    orderRevision: CODE_GRAPH_LEXICAL_V2_ORDER_REVISION,
  };
  return lexicalViewBindingMatches(snapshotId, binding.logicalSnapshotId, binding) ? binding : undefined;
});

export const recordLexicalViewBinding = Effect.fn('codeGraph.recordLexicalViewBinding')(function* (
  sql: SqlClient.SqlClient,
  snapshot: {readonly id: string; readonly baseSnapshotId?: string; readonly dirty: boolean},
  logicalSnapshotId: string,
  proposed?: LexicalViewBinding,
) {
  if (!isLexicalV2Snapshot(snapshot.id)) return;
  const prior = yield* loadLexicalViewBinding(sql, snapshot.id);
  const binding = proposed ?? prior;
  if (
    !lexicalViewBindingMatches(snapshot.id, logicalSnapshotId, binding) ||
    binding?.baseSnapshotId !== snapshot.baseSnapshotId ||
    (binding?.mode === 'alias' && snapshot.dirty) ||
    (binding?.mode === 'direct' && !snapshot.dirty) ||
    (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(binding))
  ) {
    return yield* CodeGraphStoreError.of('Factored lexical actual/logical layout binding is invalid.');
  }
  yield* sql`INSERT INTO lexical_v2_views
    (snapshot_id,logical_snapshot_id,layout_mode,base_snapshot_id,force_generation,order_revision)
    VALUES (${snapshot.id},${logicalSnapshotId},${binding!.mode},${binding!.baseSnapshotId ?? null},
      ${binding!.forceGeneration ?? null},${binding!.orderRevision})
    ON CONFLICT(snapshot_id) DO NOTHING`;
});

export const ensureLexicalViewBinding = Effect.fn('codeGraph.ensureLexicalViewBinding')(function* (
  sql: SqlClient.SqlClient,
  snapshot: {readonly id: string; readonly baseSnapshotId?: string; readonly dirty: boolean},
) {
  if (!isLexicalV2Snapshot(snapshot.id)) return;
  const provided = Option.getOrUndefined(yield* Effect.serviceOption(LexicalViewBindingContext));
  const binding = provided ?? (yield* loadLexicalViewBinding(sql, snapshot.id));
  if (!binding) return yield* CodeGraphStoreError.of('V2 publication lacks its immutable logical layout binding.');
  yield* recordLexicalViewBinding(sql, snapshot, binding.logicalSnapshotId, binding);
});

export interface LexicalScope {
  readonly scopeOrdinal: number;
  readonly path: string;
  readonly contentHash: string;
  readonly packageName: string | null;
}

export interface LexicalMember {
  readonly scopeOrdinal: number;
  readonly memberOrdinal: number;
  readonly symbolId: string;
}

export interface LexicalOwnerPosting {
  readonly termOrdinal: number;
  readonly originMask: 1 | 2 | 3;
  readonly scopeOrdinal: number;
  readonly memberOrdinal: number;
  /** Zero only for a body-only posting. Body weight is always one. */
  readonly metadataWeight: number;
}

export interface LexicalSharedPosting {
  readonly termOrdinal: number;
  readonly scopeOrdinal: number;
}

export interface LexicalProjection {
  readonly terms: readonly string[];
  readonly scopes: readonly LexicalScope[];
  readonly members: readonly LexicalMember[];
  readonly owners: readonly LexicalOwnerPosting[];
  readonly shared: readonly LexicalSharedPosting[];
  readonly logicalPostingCount: number;
  /** Every persistent physical category, including membership/dictionaries. */
  readonly physicalRowCount: number;
}

function weightedTerms(values: readonly (readonly [string, number])[]): Map<string, number> {
  const terms = new Map<string, number>();
  for (const [text, weight] of values) {
    for (const term of discoveryTerms(text)) terms.set(term, Math.max(terms.get(term) ?? 0, weight));
  }
  return terms;
}

function scopeOrder(left: LexicalScope, right: LexicalScope): number {
  return (
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.contentHash, right.contentHash) ||
    (left.packageName === null
      ? right.packageName === null
        ? 0
        : -1
      : right.packageName === null
        ? 1
        : compareCodeUnits(left.packageName, right.packageName))
  );
}

/** SQLite BLOB ordering of this transient key matches JavaScript UTF-16 ordering. */
export function lexicalUtf16SortKey(value: string): Uint8Array {
  return Buffer.from(value, 'utf16le').swap16();
}

/**
 * Factor only identical, actual metadata contributions. Scope membership never
 * grants body membership. Whole-file facts are projected before persistence is
 * chunked, so ordinal allocation does not depend on insertion or parser order.
 */
export function projectLexicalSymbols(
  symbols: readonly CodeGraphSymbol[],
  bodies: readonly CodeGraphBodyDiscovery[] = [],
  fileOrdinals?: ReadonlyMap<string, number>,
): LexicalProjection {
  const byId = new Map<string, CodeGraphSymbol>();
  for (const symbol of symbols) {
    if (byId.has(symbol.id)) throw new Error('Duplicate lexical owner identity.');
    byId.set(symbol.id, symbol);
  }
  const bodyTerms = new Map<string, readonly string[]>();
  for (const input of bodies) {
    const body = validateBodyDiscovery(closeBodyDiscovery(input, symbols, byId), input.path, symbols, byId);
    for (const record of body.records) {
      if (bodyTerms.has(record.ownerId)) throw new Error('Duplicate private body owner contribution.');
      bodyTerms.set(record.ownerId, record.terms);
    }
  }
  const logical = new Map<CodeGraphSymbol, readonly (readonly [string, number])[]>();
  for (const symbol of symbols) {
    const metadata = weightedTerms([
      [symbol.name, 5],
      [symbol.qualifiedName, 4],
      [symbol.path, 3],
      [symbol.packageName ?? '', 3],
      [symbol.signature ?? '', 2],
      [symbol.documentation ?? '', 1],
    ]);
    logical.set(symbol, [
      ...metadata,
      ...EffectArray.map(bodyTerms.get(symbol.id) ?? [], term => ['~body:v1:' + term, 1] as const),
    ]);
  }
  return projectLexicalTermRelation(symbols, logical, fileOrdinals);
}

/** Representation transform of an already source-bound logical posting relation. */
export function projectLexicalTermRelation(
  symbols: readonly CodeGraphSymbol[],
  logical: ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]>,
  fileOrdinals?: ReadonlyMap<string, number>,
): LexicalProjection {
  const grouped = new Map<string, {scope: LexicalScope; symbols: CodeGraphSymbol[]}>();
  const metadataById = new Map<string, Map<string, number>>();
  const bodyById = new Map<string, Set<string>>();
  for (const symbol of symbols) {
    if (metadataById.has(symbol.id)) throw new Error('Duplicate lexical owner identity.');
    const metadata = new Map<string, number>();
    const body = new Set<string>();
    for (const [term, weight] of logical.get(symbol) ?? []) {
      if (!Number.isInteger(weight) || weight < 1 || weight > 5) throw new Error('Invalid logical lexical weight.');
      if (EffectString.startsWith('~body:v1:')(term)) {
        const privateTerm = EffectString.slice(9)(term);
        if (weight !== 1 || body.has(privateTerm)) throw new Error('Invalid logical body posting.');
        body.add(privateTerm);
      } else {
        if (metadata.has(term)) throw new Error('Duplicate logical metadata posting.');
        metadata.set(term, weight);
      }
    }
    metadataById.set(symbol.id, metadata);
    bodyById.set(symbol.id, body);
    const packageName = symbol.packageName ?? null;
    const key = JSON.stringify([symbol.path, symbol.contentHash, packageName]);
    let group = grouped.get(key);
    if (!group) {
      group = {scope: {scopeOrdinal: 0, path: symbol.path, contentHash: symbol.contentHash, packageName}, symbols: []};
      grouped.set(key, group);
    }
    group.symbols.push(symbol);
  }
  const scopes: LexicalScope[] = [];
  const members: LexicalMember[] = [];
  const pendingOwners: Array<Omit<LexicalOwnerPosting, 'termOrdinal'> & {readonly term: string}> = [];
  const pendingShared: Array<{readonly term: string; readonly scopeOrdinal: number}> = [];
  const vocabulary = new Set<string>();
  let logicalPostingCount = 0;
  const groups = [...grouped.values()].sort((a, b) => scopeOrder(a.scope, b.scope));
  const perPathScopes = new Map<string, number>();
  for (const [denseOrdinal, group] of groups.entries()) {
    const fileOrdinal = fileOrdinals?.get(group.scope.path);
    const subOrdinal = perPathScopes.get(group.scope.path) ?? 0;
    perPathScopes.set(group.scope.path, subOrdinal + 1);
    // Existing per-file fact byte bounds make 65536 distinct package/hash
    // scopes impossible. Keep the representation bound explicit and checked.
    const scopeOrdinal = fileOrdinals ? (fileOrdinal ?? Number.NaN) * 65_536 + subOrdinal : denseOrdinal;
    if (!Number.isSafeInteger(scopeOrdinal) || scopeOrdinal < 0 || subOrdinal >= 65_536) {
      throw new Error('Lexical scope allocation exceeds its immutable file plan.');
    }
    scopes.push({...group.scope, scopeOrdinal});
    // Preserve the two independent original 32-token normalization boundaries.
    const shared = weightedTerms([
      [group.scope.path, 3],
      [group.scope.packageName ?? '', 3],
    ]);
    for (const term of shared.keys()) {
      if (!EffectArray.every(group.symbols, symbol => (metadataById.get(symbol.id)!.get(term) ?? 0) >= 3))
        shared.delete(term);
    }
    for (const term of shared.keys()) {
      vocabulary.add(term);
      pendingShared.push({term, scopeOrdinal});
    }
    const ordered = [...group.symbols].sort((a, b) => compareCodeUnits(a.id, b.id));
    for (const [memberOrdinal, symbol] of ordered.entries()) {
      members.push({scopeOrdinal, memberOrdinal, symbolId: symbol.id});
      const original = metadataById.get(symbol.id)!;
      // The shared relation already supplies metadata weight three. Retain an
      // owner metadata row only when its original maximum is greater.
      const metadata = new Map(EffectArray.filter([...original], ([term, weight]) => !shared.has(term) || weight > 3));
      const body = bodyById.get(symbol.id)!;
      logicalPostingCount += original.size + body.size;
      for (const term of new Set([...metadata.keys(), ...body])) {
        const metadataWeight = metadata.get(term) ?? 0;
        const originMask = metadataWeight === 0 ? 2 : body.has(term) ? 3 : 1;
        vocabulary.add(term);
        pendingOwners.push({term, originMask, scopeOrdinal, memberOrdinal, metadataWeight});
      }
    }
  }
  const terms = [...vocabulary].sort(compareCodeUnits);
  const ordinals = new Map(EffectArray.map(terms, (term, ordinal) => [term, ordinal]));
  const owners = EffectArray.map(pendingOwners, ({term, ...posting}) => ({
    ...posting,
    termOrdinal: ordinals.get(term)!,
  })).sort(
    (a, b) =>
      a.termOrdinal - b.termOrdinal ||
      a.originMask - b.originMask ||
      a.scopeOrdinal - b.scopeOrdinal ||
      a.memberOrdinal - b.memberOrdinal,
  );
  const shared = EffectArray.map(pendingShared, ({term, scopeOrdinal}) => ({
    termOrdinal: ordinals.get(term)!,
    scopeOrdinal,
  })).sort((a, b) => a.termOrdinal - b.termOrdinal || a.scopeOrdinal - b.scopeOrdinal);
  return {
    terms,
    scopes,
    members,
    owners,
    shared,
    logicalPostingCount,
    physicalRowCount: terms.length + scopes.length + members.length + owners.length + shared.length,
  };
}

/** Existing source inventory order is canonical; preserve it before batching. */
export function lexicalFileOrdinals(paths: readonly string[]): ReadonlyMap<string, number> {
  return new Map(EffectArray.map([...new Set(paths)].sort(compareCodeUnits), (path, ordinal) => [path, ordinal]));
}

type SqlValue = string | number | null;

function insertRows(sql: SqlClient.SqlClient, table: string, columns: string, rows: readonly (readonly SqlValue[])[]) {
  return Effect.gen(function* () {
    for (let offset = 0; offset < rows.length; offset += 500) {
      const page = rows.slice(offset, offset + 500);
      const marks =
        '(' +
        EffectArray.join(
          EffectArray.map(page[0], () => '?'),
          ',',
        ) +
        ')';
      yield* sql.unsafe(
        `INSERT INTO ${table} (${columns}) VALUES ${EffectArray.join(
          EffectArray.map(page, () => marks),
          ',',
        )}`,
        page.flat(),
      );
    }
  });
}

/** Called inside the existing owned materialization transaction. */
export const stageLexicalV2 = Effect.fn('codeGraph.stageLexicalV2')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  projection: LexicalProjection,
) {
  yield* sql`INSERT INTO lexical_compact_snapshots (snapshot_id) VALUES (${snapshotId})
    ON CONFLICT(snapshot_id) DO NOTHING`;
  const header = yield* sql<{readonly snapshot_key: number}>`
    SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ${snapshotId} LIMIT 1
  `;
  const snapshotKey = Number(header[0]?.snapshot_key);
  if (!Number.isSafeInteger(snapshotKey) || snapshotKey < 1) {
    return yield* CodeGraphStoreError.of('Factored lexical snapshot allocation is invalid.');
  }
  const termKeys = new Map<string, number>();
  let addedTerms = 0;
  for (let offset = 0; offset < projection.terms.length; offset += 500) {
    const page = projection.terms.slice(offset, offset + 500);
    yield* sql.unsafe(
      `INSERT OR IGNORE INTO lexical_compact_terms (snapshot_key,term)
      VALUES ${EffectArray.join(
        EffectArray.map(page, () => '(?,?)'),
        ',',
      )}`,
      EffectArray.flatMap(page, term => [snapshotKey, term]),
    );
    const changes = yield* sql<{readonly count: number}>`SELECT changes() AS count`;
    addedTerms += Number(changes[0]?.count ?? 0);
    const dictionary = yield* sql.unsafe<{readonly term: string; readonly term_key: number}>(
      `SELECT term,term_key FROM lexical_compact_terms WHERE snapshot_key=? AND term IN (${EffectArray.join(
        EffectArray.map(page, () => '?'),
        ',',
      )})`,
      [snapshotKey, ...page],
    );
    for (const row of dictionary) termKeys.set(row.term, Number(row.term_key));
  }
  const key = (ordinal: number) => {
    const value = termKeys.get(projection.terms[ordinal]);
    if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
      throw new Error('Factored lexical term dictionary lost a row.');
    }
    return value;
  };
  yield* insertRows(
    sql,
    'lexical_v2_scopes',
    'snapshot_key,scope_ordinal,path,content_hash,package_name',
    EffectArray.map(projection.scopes, row => [
      snapshotKey,
      row.scopeOrdinal,
      row.path,
      row.contentHash,
      row.packageName,
    ]),
  );
  yield* insertRows(
    sql,
    'lexical_v2_members',
    'snapshot_key,scope_ordinal,member_ordinal,symbol_id',
    EffectArray.map(projection.members, row => [snapshotKey, row.scopeOrdinal, row.memberOrdinal, row.symbolId]),
  );
  yield* insertRows(
    sql,
    'lexical_v2_owners',
    'snapshot_key,term_key,origin_mask,scope_ordinal,member_ordinal,metadata_weight',
    EffectArray.map(projection.owners, row => [
      snapshotKey,
      key(row.termOrdinal),
      row.originMask,
      row.scopeOrdinal,
      row.memberOrdinal,
      row.metadataWeight,
    ]),
  );
  yield* insertRows(
    sql,
    'lexical_v2_shared',
    'snapshot_key,term_key,scope_ordinal',
    EffectArray.map(projection.shared, row => [snapshotKey, key(row.termOrdinal), row.scopeOrdinal]),
  );
  const existing = yield* sql<{readonly snapshot_id: string}>`
    SELECT snapshot_id FROM lexical_v2_formats WHERE snapshot_id=${snapshotId} LIMIT 1
  `;
  const physicalRows =
    projection.scopes.length +
    projection.members.length +
    projection.owners.length +
    projection.shared.length +
    addedTerms +
    (existing.length === 0 ? 3 : 0);
  yield* sql`INSERT INTO lexical_v2_formats (
    snapshot_id,format_version,posting_count,logical_posting_count,symbol_count,term_count,scope_count,owner_count,shared_count
  ) VALUES (${snapshotId},2,${physicalRows},${projection.logicalPostingCount},${projection.members.length},
    ${addedTerms},${projection.scopes.length},${projection.owners.length},${projection.shared.length})
  ON CONFLICT(snapshot_id) DO UPDATE SET
    posting_count=posting_count+excluded.posting_count,
    logical_posting_count=logical_posting_count+excluded.logical_posting_count,
    symbol_count=symbol_count+excluded.symbol_count,term_count=term_count+excluded.term_count,
    scope_count=scope_count+excluded.scope_count,owner_count=owner_count+excluded.owner_count,
    shared_count=shared_count+excluded.shared_count`;
  return {postingCount: physicalRows, symbolCount: projection.members.length, termCount: addedTerms};
});

/** V2 uses its own receipt; the immutable V1 CHECK(format_version=1) is retained. */
export const finalizeLexicalV2 = Effect.fn('codeGraph.finalizeLexicalV2')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  receipt: {readonly postingCount: number; readonly symbolCount: number; readonly termCount: number},
) {
  const rows = yield* sql<{
    readonly posting_count: number;
    readonly symbol_count: number;
    readonly term_count: number;
  }>`SELECT posting_count,symbol_count,term_count FROM lexical_v2_formats
    WHERE snapshot_id=${snapshotId} AND format_version=2 LIMIT 1`;
  if (!rows[0]) return false;
  if (
    Number(rows[0].posting_count) !== receipt.postingCount ||
    Number(rows[0].symbol_count) !== receipt.symbolCount ||
    Number(rows[0].term_count) !== receipt.termCount
  ) {
    return yield* CodeGraphStoreError.of('Factored lexical publication receipt is inconsistent.');
  }
  return true;
});

/** One checkpoint row: decode origin before three exact dictionary/member/owner seeks. */
export function lexicalV2RecordLookupStatement(snapshotId: string, term: string, symbolId: string) {
  const body = EffectString.startsWith('~body:v1:')(term);
  const raw = body ? EffectString.slice(9)(term) : term;
  const owner = (mask: string) => `SELECT p.metadata_weight FROM lexical_v2_owners p
    WHERE p.snapshot_key=c.snapshot_key AND p.term_key=t.term_key AND p.origin_mask=${mask}
      AND p.scope_ordinal=m.scope_ordinal AND p.member_ordinal=m.member_ordinal`;
  const weight = body
    ? `CASE WHEN EXISTS(${owner('2')} UNION ALL ${owner('3')}) THEN 1 END`
    : `max(COALESCE((${owner('1')}),0),COALESCE((${owner('3')}),0),
      CASE WHEN EXISTS(SELECT 1 FROM lexical_v2_shared p WHERE p.snapshot_key=c.snapshot_key
        AND p.term_key=t.term_key AND p.scope_ordinal=m.scope_ordinal) THEN 3 ELSE 0 END)`;
  return {
    parameters: [raw, symbolId, snapshotId],
    text: `SELECT weight FROM (SELECT ${weight} AS weight FROM lexical_compact_snapshots c
      JOIN lexical_v2_formats f ON f.snapshot_id=c.snapshot_id AND f.format_version=2
      JOIN lexical_compact_terms t ON t.snapshot_key=c.snapshot_key AND t.term=?
      JOIN lexical_v2_members m ON m.snapshot_key=c.snapshot_key AND m.symbol_id=?
      WHERE c.snapshot_id=?) WHERE weight>0`,
  };
}

/** Public/checkpoint logical relation; task discovery uses its bounded key lane. */
/** Metadata-only candidate lookup enters through exact wanted dictionary terms, never a snapshot posting scan. */
export function lexicalV2CandidateRelationSql(): string {
  const common = `FROM input
    JOIN lexical_compact_snapshots compact ON compact.snapshot_id=input.snapshot_id
    JOIN lexical_v2_formats format ON format.snapshot_id=input.snapshot_id AND format.format_version=2
    CROSS JOIN json_each(input.terms_json) wanted
    CROSS JOIN lexical_compact_terms term INDEXED BY sqlite_autoindex_lexical_compact_terms_1`;
  const wanted = `term.snapshot_key=compact.snapshot_key AND term.term=wanted.value`;
  return `SELECT term.term,member.symbol_id,posting.metadata_weight AS weight ${common}
    CROSS JOIN lexical_v2_owners posting
    CROSS JOIN lexical_v2_members member
    WHERE ${wanted} AND posting.snapshot_key=compact.snapshot_key AND posting.term_key=term.term_key
      AND posting.origin_mask IN (1,3) AND member.snapshot_key=posting.snapshot_key
      AND member.scope_ordinal=posting.scope_ordinal AND member.member_ordinal=posting.member_ordinal
    UNION ALL
    SELECT term.term,member.symbol_id,3 AS weight ${common}
    CROSS JOIN lexical_v2_shared shared
    CROSS JOIN lexical_v2_members member
    WHERE ${wanted} AND shared.snapshot_key=compact.snapshot_key AND shared.term_key=term.term_key
      AND member.snapshot_key=shared.snapshot_key AND member.scope_ordinal=shared.scope_ordinal
      AND NOT EXISTS (
        SELECT 1 FROM lexical_v2_owners own WHERE own.snapshot_key=shared.snapshot_key
        AND own.term_key=shared.term_key AND own.origin_mask IN (1,3)
        AND own.scope_ordinal=member.scope_ordinal AND own.member_ordinal=member.member_ordinal)`;
}

export function lexicalV2RelationSql(includeBody: boolean, paged = false): string {
  const wanted = `(input.terms_json IS NULL OR input.terms_json='null' OR term.term IN (SELECT value FROM json_each(input.terms_json)))`;
  const common = `FROM input JOIN lexical_compact_snapshots compact ON compact.snapshot_id=input.snapshot_id
    JOIN lexical_v2_formats format ON format.snapshot_id=input.snapshot_id AND format.format_version=2
    JOIN lexical_compact_terms term ON term.snapshot_key=compact.snapshot_key`;
  const member = `JOIN lexical_v2_members member ON member.snapshot_key=posting.snapshot_key
    AND member.scope_ordinal=posting.scope_ordinal AND member.member_ordinal=posting.member_ordinal`;
  const after = paged
    ? ` AND term.term>=input.cursor_term AND (term.term,member.symbol_id)>(input.cursor_term,input.cursor_id)`
    : '';
  const bodyAfter = paged
    ? ` AND input.body_enabled=1 AND term.term>=input.body_lower
    AND ('~body:v1:'||term.term,member.symbol_id)>(input.cursor_term,input.cursor_id)`
    : '';
  const branches = [
    `SELECT term.term,member.symbol_id,posting.metadata_weight AS weight ${common}
      JOIN lexical_v2_owners posting ON posting.snapshot_key=compact.snapshot_key AND posting.term_key=term.term_key
        AND posting.origin_mask IN (1,3) ${member} WHERE ${wanted}${after}`,
    `SELECT term.term,member.symbol_id,3 AS weight ${common}
      JOIN lexical_v2_shared shared ON shared.snapshot_key=compact.snapshot_key AND shared.term_key=term.term_key
      JOIN lexical_v2_members member ON member.snapshot_key=shared.snapshot_key AND member.scope_ordinal=shared.scope_ordinal
      WHERE ${wanted}${after} AND NOT EXISTS (
        SELECT 1 FROM lexical_v2_owners own WHERE own.snapshot_key=shared.snapshot_key
        AND own.term_key=shared.term_key AND own.origin_mask IN (1,3)
        AND own.scope_ordinal=member.scope_ordinal AND own.member_ordinal=member.member_ordinal)`,
  ];
  if (includeBody)
    branches.push(`SELECT '~body:v1:'||term.term AS term,member.symbol_id,1 AS weight ${common}
      JOIN lexical_v2_owners posting ON posting.snapshot_key=compact.snapshot_key AND posting.term_key=term.term_key
        AND posting.origin_mask IN (2,3) ${member} WHERE ${wanted}${bodyAfter}`);
  return EffectArray.join(
    EffectArray.map(branches, branch =>
      paged
        ? `SELECT * FROM (${branch}
    ORDER BY term.term COLLATE BINARY,member.symbol_id COLLATE BINARY
    LIMIT (SELECT page_size FROM input))`
        : branch,
    ),
    ' UNION ALL ',
  );
}

export function lexicalV2PageStatement(
  snapshotId: string,
  cursor: readonly [string, string] | undefined,
  pageSize: number,
) {
  const prefix = '~body:v1:';
  const cursorTerm = cursor?.[0] ?? '';
  const withinBody = EffectString.startsWith(prefix)(cursorTerm);
  const bodyEnabled = withinBody || Buffer.compare(Buffer.from(cursorTerm), Buffer.from(prefix)) < 0;
  return {
    parameters: [
      snapshotId,
      cursorTerm,
      cursor?.[1] ?? '',
      bodyEnabled ? 1 : 0,
      withinBody ? EffectString.slice(9)(cursorTerm) : '',
      pageSize,
      pageSize,
    ],
    text: `WITH input(snapshot_id,terms_json,cursor_term,cursor_id,body_enabled,body_lower,page_size) AS
      (VALUES (?,'null',?,?,?,?,?)), logical AS (${lexicalV2RelationSql(true, true)})
      SELECT term,symbol_id,weight FROM logical ORDER BY term COLLATE BINARY,symbol_id COLLATE BINARY LIMIT ?`,
  };
}

export const prepareActivationLexicalV2 = Effect.fn('codeGraph.prepareActivationLexicalV2')(function* (
  sql: SqlClient.SqlClient,
) {
  const statements = `CREATE TEMP TABLE IF NOT EXISTS activation_v2_scopes (
    scope_ordinal INTEGER PRIMARY KEY,path TEXT NOT NULL,content_hash TEXT NOT NULL,package_name TEXT);
    CREATE TEMP TABLE IF NOT EXISTS activation_v2_members (
      scope_ordinal INTEGER NOT NULL,member_ordinal INTEGER NOT NULL,symbol_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(scope_ordinal,member_ordinal)) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS activation_v2_owners (
      term TEXT NOT NULL,origin_mask INTEGER NOT NULL,scope_ordinal INTEGER NOT NULL,member_ordinal INTEGER NOT NULL,
      metadata_weight INTEGER NOT NULL,PRIMARY KEY(scope_ordinal,member_ordinal,term,origin_mask)) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS activation_v2_shared (
      term TEXT NOT NULL,scope_ordinal INTEGER NOT NULL,PRIMARY KEY(scope_ordinal,term)) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS activation_v2_counts (path TEXT PRIMARY KEY,logical_posting_count INTEGER NOT NULL) WITHOUT ROWID;
    DELETE FROM activation_v2_owners;DELETE FROM activation_v2_shared;DELETE FROM activation_v2_members;
    DELETE FROM activation_v2_scopes;DELETE FROM activation_v2_counts;`;
  for (const statement of EffectArray.filter(
    EffectArray.map(EffectString.split(';')(statements), value => EffectString.trim(value)),
    Boolean,
  ))
    yield* sql.unsafe(statement);
});

export const clearActivationLexicalV2Paths = Effect.fn('codeGraph.clearActivationLexicalV2Paths')(function* (
  sql: SqlClient.SqlClient,
  paths: readonly string[],
) {
  const encoded = JSON.stringify(paths);
  for (const table of ['activation_v2_owners', 'activation_v2_shared', 'activation_v2_members']) {
    yield* sql.unsafe(
      `DELETE FROM ${table} WHERE scope_ordinal IN (
      SELECT scope_ordinal FROM activation_v2_scopes WHERE path IN (SELECT value FROM json_each(?)))`,
      [encoded],
    );
  }
  yield* sql.unsafe('DELETE FROM activation_v2_scopes WHERE path IN (SELECT value FROM json_each(?))', [encoded]);
  yield* sql.unsafe('DELETE FROM activation_v2_counts WHERE path IN (SELECT value FROM json_each(?))', [encoded]);
});

export const stageActivationLexicalV2 = Effect.fn('codeGraph.stageActivationLexicalV2')(function* (
  sql: SqlClient.SqlClient,
  symbols: readonly CodeGraphSymbol[],
  logical: ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]>,
  replacePaths = false,
) {
  if (replacePaths)
    yield* clearActivationLexicalV2Paths(sql, [...new Set(EffectArray.map(symbols, symbol => symbol.path))]);
  const files = yield* sql<{readonly path: string}>`SELECT path FROM activation_files`;
  const ordinals = lexicalFileOrdinals([
    ...EffectArray.map(files, file => file.path),
    ...EffectArray.map(symbols, symbol => symbol.path),
  ]);
  const projection = projectLexicalTermRelation(symbols, logical, ordinals);
  yield* insertRows(
    sql,
    'activation_v2_scopes',
    'scope_ordinal,path,content_hash,package_name',
    EffectArray.map(projection.scopes, scope => [scope.scopeOrdinal, scope.path, scope.contentHash, scope.packageName]),
  );
  yield* insertRows(
    sql,
    'activation_v2_members',
    'scope_ordinal,member_ordinal,symbol_id',
    EffectArray.map(projection.members, member => [member.scopeOrdinal, member.memberOrdinal, member.symbolId]),
  );
  yield* insertRows(
    sql,
    'activation_v2_owners',
    'term,origin_mask,scope_ordinal,member_ordinal,metadata_weight',
    EffectArray.map(projection.owners, owner => [
      projection.terms[owner.termOrdinal],
      owner.originMask,
      owner.scopeOrdinal,
      owner.memberOrdinal,
      owner.metadataWeight,
    ]),
  );
  yield* insertRows(
    sql,
    'activation_v2_shared',
    'term,scope_ordinal',
    EffectArray.map(projection.shared, shared => [projection.terms[shared.termOrdinal], shared.scopeOrdinal]),
  );
  const logicalByPath = new Map<string, number>();
  for (const symbol of symbols)
    logicalByPath.set(symbol.path, (logicalByPath.get(symbol.path) ?? 0) + (logical.get(symbol)?.length ?? 0));
  yield* insertRows(sql, 'activation_v2_counts', 'path,logical_posting_count', [...logicalByPath]);
  return (
    projection.scopes.length +
    projection.members.length +
    projection.owners.length +
    projection.shared.length +
    logicalByPath.size
  );
});

export const ACTIVATION_V2_PHYSICAL_COUNT_SQL = `(
  (SELECT COUNT(*) FROM activation_v2_scopes)+(SELECT COUNT(*) FROM activation_v2_members)+
  (SELECT COUNT(*) FROM activation_v2_owners)+(SELECT COUNT(*) FROM activation_v2_shared)+
  (SELECT COUNT(*) FROM (SELECT term FROM activation_v2_owners UNION SELECT term FROM activation_v2_shared))+3
)`;

/** Decode only owned bounded activation state, never repository source text. */
export const activationLexicalProjection = Effect.fn('codeGraph.activationLexicalProjection')(function* (
  sql: SqlClient.SqlClient,
  changedOnly: boolean,
) {
  const selected = changedOnly ? 'JOIN activation_changed_symbol_ids changed ON changed.id=member.symbol_id' : '';
  const members = yield* sql.unsafe<LexicalMember>(`SELECT member.scope_ordinal AS scopeOrdinal,
    member.member_ordinal AS memberOrdinal,member.symbol_id AS symbolId FROM activation_v2_members member
    ${selected} ORDER BY member.scope_ordinal,member.member_ordinal`);
  const memberKeys = new Set(EffectArray.map(members, member => `${member.scopeOrdinal}:${member.memberOrdinal}`));
  const scopeKeys = new Set(EffectArray.map(members, member => member.scopeOrdinal));
  const allScopes = yield* sql<LexicalScope>`SELECT scope_ordinal AS scopeOrdinal,path,
    content_hash AS contentHash,package_name AS packageName FROM activation_v2_scopes ORDER BY scope_ordinal`;
  const ownerRows = yield* sql<{
    readonly term: string;
    readonly originMask: 1 | 2 | 3;
    readonly scopeOrdinal: number;
    readonly memberOrdinal: number;
    readonly metadataWeight: number;
  }>`SELECT term,origin_mask AS originMask,scope_ordinal AS scopeOrdinal,
    member_ordinal AS memberOrdinal,metadata_weight AS metadataWeight FROM activation_v2_owners`;
  const sharedRows = yield* sql<{readonly term: string; readonly scopeOrdinal: number}>`
    SELECT term,scope_ordinal AS scopeOrdinal FROM activation_v2_shared`;
  const owners = EffectArray.filter(ownerRows, owner => memberKeys.has(`${owner.scopeOrdinal}:${owner.memberOrdinal}`));
  const shared = EffectArray.filter(sharedRows, row => scopeKeys.has(row.scopeOrdinal));
  const terms = [
    ...new Set([...EffectArray.map(owners, owner => owner.term), ...EffectArray.map(shared, row => row.term)]),
  ].sort(compareCodeUnits);
  const termKeys = new Map(EffectArray.map(terms, (term, ordinal) => [term, ordinal]));
  // Count expanded logical rows separately. Shared/owner overlap is one metadata row.
  const sharedByScope = new Map<number, Set<string>>();
  const memberCounts = new Map<number, number>();
  for (const member of members) memberCounts.set(member.scopeOrdinal, (memberCounts.get(member.scopeOrdinal) ?? 0) + 1);
  let logicalPostingCount = 0;
  for (const row of shared) {
    let terms = sharedByScope.get(row.scopeOrdinal);
    if (!terms) {
      terms = new Set();
      sharedByScope.set(row.scopeOrdinal, terms);
    }
    terms.add(row.term);
    logicalPostingCount += memberCounts.get(row.scopeOrdinal) ?? 0;
  }
  for (const owner of owners) {
    if (owner.originMask !== 1) logicalPostingCount += 1;
    if (owner.originMask !== 2 && !sharedByScope.get(owner.scopeOrdinal)?.has(owner.term)) logicalPostingCount += 1;
  }
  const scopes = EffectArray.filter(allScopes, scope => scopeKeys.has(scope.scopeOrdinal));
  return {
    terms,
    scopes,
    members,
    owners: EffectArray.map(owners, ({term, ...owner}) => ({...owner, termOrdinal: termKeys.get(term)!})),
    shared: EffectArray.map(shared, ({term, scopeOrdinal}) => ({scopeOrdinal, termOrdinal: termKeys.get(term)!})),
    logicalPostingCount,
    physicalRowCount: terms.length + scopes.length + members.length + owners.length + shared.length,
  } satisfies LexicalProjection;
});

export function lexicalProjectionTermMap(
  symbols: readonly CodeGraphSymbol[],
  projection: LexicalProjection,
): ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]> {
  const byId = new Map(EffectArray.map(symbols, symbol => [symbol.id, new Map<string, number>()]));
  const byKey = new Map(
    EffectArray.map(projection.members, member => [`${member.scopeOrdinal}:${member.memberOrdinal}`, member.symbolId]),
  );
  const membersByScope = new Map<number, LexicalMember[]>();
  for (const member of projection.members) {
    const group = membersByScope.get(member.scopeOrdinal);
    if (group) group.push(member);
    else membersByScope.set(member.scopeOrdinal, [member]);
  }
  for (const shared of projection.shared)
    for (const member of membersByScope.get(shared.scopeOrdinal) ?? []) {
      byId.get(member.symbolId)?.set(projection.terms[shared.termOrdinal], 3);
    }
  for (const owner of projection.owners) {
    const target = byId.get(byKey.get(`${owner.scopeOrdinal}:${owner.memberOrdinal}`)!);
    const term = projection.terms[owner.termOrdinal];
    if (owner.originMask !== 2) target?.set(term, owner.metadataWeight);
    if (owner.originMask !== 1) target?.set('~body:v1:' + term, 1);
  }
  return new Map(EffectArray.map(symbols, symbol => [symbol, [...byId.get(symbol.id)!]]));
}

export function lexicalV2PhysicalCountStatement(snapshotId: string) {
  return {
    parameters: [snapshotId],
    text: `SELECT
      (SELECT COUNT(*) FROM lexical_v2_owners p WHERE p.snapshot_key=c.snapshot_key) AS owner_count,
      (SELECT COUNT(*) FROM lexical_v2_shared p WHERE p.snapshot_key=c.snapshot_key) AS shared_count,
      (SELECT COUNT(*) FROM lexical_v2_members p WHERE p.snapshot_key=c.snapshot_key) AS symbol_count,
      (SELECT COUNT(*) FROM lexical_v2_scopes p WHERE p.snapshot_key=c.snapshot_key) AS scope_count,
      (SELECT COUNT(*) FROM lexical_compact_terms p WHERE p.snapshot_key=c.snapshot_key) AS term_count,
      (SELECT COUNT(*) FROM lexical_v2_formats p WHERE p.snapshot_id=c.snapshot_id) AS format_count,
      (SELECT COUNT(*) FROM lexical_v2_views p WHERE p.snapshot_id=c.snapshot_id) AS view_count,
      (SELECT COUNT(*) FROM lexical_compact_symbols p WHERE p.snapshot_key=c.snapshot_key)+
        (SELECT COUNT(*) FROM lexical_compact_postings p WHERE p.snapshot_key=c.snapshot_key)+
        (SELECT COUNT(*) FROM lexical_storage_formats p WHERE p.snapshot_id=c.snapshot_id) AS obsolete_count
      FROM lexical_compact_snapshots c WHERE c.snapshot_id=? LIMIT 1`,
  };
}
