import * as EffectString from 'effect/String';
import {mintCodeGraphCandidateReservation} from '../../disk/reservation.js';
import {CodeGraphStoreError} from '../../types.js';
import {Context, Effect} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import type {ResolutionCandidateIndexStage} from './candidate_index.js';
import type {CodeGraphDirectPersistentCapacityBoundary} from '../../disk/capacity.js';
import type {CodeGraphDiskReservationLease} from '../../disk/reservation.js';

/** No Map, Set, sort, encoding or serialized full-key copy precedes this original-source work estimate.
 * Duplicate occurrences remain charged, so this bounds canonical memberships and sort-vector ownership conservatively.
 * It is capacity evidence, never a new eligibility quota or a claim that disk bytes equal exact JS heap bytes.
 */
export function candidatePreparationWork(input: ResolutionCandidateIndexStage) {
  let rowCount = input.files.length;
  let originalBytes = 0;
  const snapshotBytes = Buffer.byteLength(input.snapshotId);
  for (const file of input.files)
    originalBytes += snapshotBytes + Buffer.byteLength(file.path) + Buffer.byteLength(file.contentHash);
  for (const ref of input.references) {
    rowCount += 1;
    const pathBytes = Buffer.byteLength(ref.evidencePath);
    const domainBytes = Buffer.byteLength(ref.resolutionDomain);
    originalBytes += pathBytes + domainBytes;
    for (const tier of ref.lookupTiers)
      for (const key of tier) {
        rowCount += 1;
        originalBytes += snapshotBytes + pathBytes + domainBytes + Buffer.byteLength(key);
      }
    for (const alias of ref.aliasLookupKeys ?? []) {
      rowCount += 1;
      originalBytes += Buffer.byteLength(alias);
    }
  }
  if (!Number.isSafeInteger(rowCount) || !Number.isSafeInteger(originalBytes))
    throw new Error('Candidate source work estimate is not representable.');
  return {rowCount, originalBytes};
}

export interface CandidateCapacityPlan {
  readonly version: 'candidate-stage-window-r1';
  readonly snapshotId: string;
  readonly sourceFingerprint: string;
  readonly preparationRows: number;
  readonly preparationBytes: number;
  readonly writeRows: number;
  readonly writeBytes: number;
  readonly codecBytes: number;
  readonly writeChildren: number;
  readonly children: number;
  readonly rows: number;
  readonly bytes: number;
  readonly counts: {
    readonly files: number;
    readonly references: number;
    readonly keys: number;
    readonly aliases: number;
    readonly reexports: number;
    readonly pages: number;
  };
}
const cap = 8 * 1048576;
const codecCap = cap - 557056;
const ceil = (n: number, d: number) => Math.ceil(n / d);
function exact(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Candidate capacity estimate is unknown or overflowed.');
  return n;
}
const jsonUpper = (s: string) => exact(6 * s.length + 2);

/** Constant-space walk: no Map/Set/sort, serialized source or encoded key array precedes admission. */
export function candidateCapacityPlan(input: ResolutionCandidateIndexStage): CandidateCapacityPlan {
  const hash = new Bun.CryptoHasher('sha256');
  const text = (s: string) => {
    hash.update(String(s.length));
    hash.update(':');
    for (let start = 0; start < s.length;) {
      let end = Math.min(start + 4096, s.length);
      if (end < s.length && s[end - 1] >= '\ud800' && s[end - 1] <= '\udbff') end--;
      hash.update(EffectString.slice(start, end)(s));
      start = end;
    }
  };
  let identity = 0,
    keys = 0,
    aliases = 0,
    reexports = 0,
    framed = 0,
    normalBytes = 0,
    normal = 0,
    literal = 0;
  let reexportBytes = 0,
    reexportIdentity = 0;
  text(input.snapshotId);
  text(String(input.files.length));
  text(String(input.references.length));
  for (const file of input.files) {
    text(file.path);
    text(file.contentHash);
    identity = exact(
      identity +
        Buffer.byteLength(input.snapshotId) +
        Buffer.byteLength(file.path) +
        Buffer.byteLength(file.contentHash),
    );
  }
  for (const ref of input.references) {
    text(String(ref.lookupTiers.length));
    text(String(ref.aliasLookupKeys?.length ?? 0));
    text(ref.evidencePath);
    text(ref.resolutionDomain);
    text(ref.edgeId);
    text(ref.relation);
    let edgeBytes = 64 + jsonUpper(ref.evidencePath) + jsonUpper(ref.edgeId) + jsonUpper(input.snapshotId);
    for (const tier of ref.lookupTiers) {
      text(String(tier.length));
      for (const key of tier) {
        text(key);
        keys = exact(keys + 1);
        const size = 8 + Buffer.byteLength(ref.resolutionDomain) + Buffer.byteLength(key);
        framed = exact(framed + size);
        if (size > 65528) literal = exact(literal + 1);
        else {
          normal = exact(normal + 1);
          normalBytes = exact(normalBytes + size);
        }
        edgeBytes = exact(edgeBytes + 32 + jsonUpper(key) + jsonUpper(ref.resolutionDomain));
      }
    }
    for (const alias of ref.aliasLookupKeys ?? []) {
      text(alias);
      aliases = exact(aliases + 1);
      edgeBytes = exact(edgeBytes + 32 + 2 * jsonUpper(alias) + jsonUpper(ref.resolutionDomain));
    }
    if (ref.relation === 'reexports' && (ref.aliasLookupKeys?.length ?? 0) > 0) {
      reexports = exact(reexports + 1);
      reexportBytes = exact(reexportBytes + edgeBytes);
      reexportIdentity = exact(
        reexportIdentity +
          Buffer.byteLength(input.snapshotId) +
          Buffer.byteLength(ref.evidencePath) +
          Buffer.byteLength(ref.edgeId),
      );
    }
  }
  const files = input.files.length;
  const pages =
    keys === 0
      ? 0
      : Math.min(keys, exact(literal + Math.min(files, keys) + ceil(normal, 64) + 2 * ceil(normalBytes, 65528)));
  const preparation = candidatePreparationWork(input);
  const writeRows = exact(6 * files + pages + keys + reexports + 2 * literal + 1);
  const writeBytes = exact(
    2 * identity +
      512 * files +
      preparation.originalBytes +
      framed +
      8 * pages +
      416 * pages +
      32 * keys +
      reexportBytes +
      reexportIdentity +
      128 * reexports +
      Buffer.byteLength(input.snapshotId) +
      256,
  );
  const codecBytes = exact(framed + 168 * pages);
  const operations = exact(1 + 2 * files + pages + reexports + 2 * literal);
  const writeChildren = candidateNextFitUpper(writeRows, writeBytes, codecBytes, operations);
  return Object.freeze({
    version: 'candidate-stage-window-r1',
    snapshotId: input.snapshotId,
    sourceFingerprint: hash.digest('hex'),
    preparationRows: preparation.rowCount,
    preparationBytes: preparation.originalBytes,
    writeRows,
    writeBytes,
    codecBytes,
    writeChildren,
    children: exact(1 + writeChildren),
    rows: exact(preparation.rowCount + 3 * writeRows + writeChildren),
    bytes: exact(preparation.originalBytes + writeBytes),
    counts: Object.freeze({files, references: input.references.length, keys, aliases, reexports, pages}),
  });
}

export interface CandidateWindowBinding {
  /** Actual connection identity; production stage/carry/finish bind their captured client. */
  readonly sql?: SqlClient.SqlClient;
  readonly databasePath: string;
  readonly snapshotId: string;
  readonly authority: string;
  readonly sourceFingerprint: string;
}
export interface CandidateCapacityWitness {
  readonly _candidateCapacityWitness: symbol;
}
interface WitnessState {
  readonly lease: CodeGraphDiskReservationLease;
  readonly plan: CandidateCapacityPlan;
  readonly binding: CandidateWindowBinding;
  readonly validate: Effect.Effect<void, CodeGraphStoreError>;
  readonly refresh: Effect.Effect<void, CodeGraphStoreError>;
  active: boolean;
  using: boolean;
  rows: number;
  bytes: number;
  children: number;
}
const witnesses = new WeakMap<object, WitnessState>();
const CurrentCandidateWitness = Context.Reference<CandidateCapacityWitness | undefined>(
  'graph/CurrentCandidateWitness',
  {defaultValue: () => undefined},
);
const sameBinding = (a: CandidateWindowBinding, b: CandidateWindowBinding) =>
  a.sql === b.sql &&
  a.databasePath === b.databasePath &&
  a.snapshotId === b.snapshotId &&
  a.authority === b.authority &&
  a.sourceFingerprint === b.sourceFingerprint;

/** Mint only from the actual successful lease callback, never from a projected demand or free-space observation. */
export function withCandidateCapacityWitness<A, E, R>(
  lease: CodeGraphDiskReservationLease,
  plan: CandidateCapacityPlan,
  binding: CandidateWindowBinding,
  use: (witness: CandidateCapacityWitness) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      // One private snapshot before ANY yield: receipt I/O must not reopen caller-owned budgets or binding.
      const ownedPlan: CandidateCapacityPlan = Object.freeze({...plan, counts: Object.freeze({...plan.counts})});
      const ownedBinding: CandidateWindowBinding = Object.freeze({...binding});
      if (
        ownedBinding.snapshotId !== ownedPlan.snapshotId ||
        ownedBinding.sourceFingerprint !== ownedPlan.sourceFingerprint
      )
        return yield* CodeGraphStoreError.of('Candidate capacity requires its exact source plan.');
      const {validate, refresh} = yield* mintCodeGraphCandidateReservation(
        lease,
        {
          ...ownedBinding,
          planCanonical: JSON.stringify(ownedPlan),
        },
        {children: ownedPlan.children, rows: ownedPlan.rows, bytes: ownedPlan.bytes},
      ).pipe(
        Effect.mapError(() =>
          CodeGraphStoreError.of('Candidate capacity requires an original issued candidate lease.'),
        ),
      );
      const witness = Object.freeze({_candidateCapacityWitness: Symbol('candidate-window')});
      witnesses.set(witness, {
        lease,
        plan: ownedPlan,
        binding: ownedBinding,
        validate: validate.pipe(Effect.mapError(() => CodeGraphStoreError.of('Candidate lease is no longer current.'))),
        refresh: refresh.pipe(
          Effect.mapError(() => CodeGraphStoreError.of('Candidate SQLite TEMP binding is no longer current.')),
        ),
        active: true,
        using: false,
        rows: 0,
        bytes: 0,
        children: 0,
      });
      return witness;
    }),
    witness => Effect.scoped(use(witness)).pipe(Effect.provideService(CurrentCandidateWitness, witness)),
    witness =>
      Effect.sync(() => {
        const state = witnesses.get(witness);
        if (state) state.active = false;
      }),
  );
}

/** Read only the current privately minted witness after an owned asynchronous SQL/writer continuation.
 * No receipt/filesystem/SQL/probe/admission work and no way to mint or replace authority.
 */
export const assertCurrentCandidateCapacity = Effect.fn('codeGraph.assertCurrentCandidateCapacity')(function* (
  sql: SqlClient.SqlClient,
) {
  const witness = yield* CurrentCandidateWitness;
  if (witness === undefined) return;
  const state = witnesses.get(witness);
  if (!state?.active || (state.binding.sql !== undefined && state.binding.sql !== sql))
    return yield* CodeGraphStoreError.of('Candidate SQL continuation lacks its original live witness.');
  yield* state.refresh;
});

/** Monotonic debit precedes every child, including failed/rolled-back children. No refunds or live enlargement. */
export function consumeCandidateCapacity<A, E, R>(
  witness: CandidateCapacityWitness,
  binding: CandidateWindowBinding,
  boundary: CodeGraphDirectPersistentCapacityBoundary,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.suspend(() => {
    const state = witnesses.get(witness);
    if (
      !state ||
      !state.active ||
      state.using ||
      !sameBinding(state.binding, binding) ||
      !Number.isSafeInteger(boundary.rowCount) ||
      boundary.rowCount < 0 ||
      !Number.isSafeInteger(boundary.finalFactBytes) ||
      boundary.finalFactBytes < 0 ||
      boundary.operation !== 'stage persistent code graph facts' ||
      state.children + 1 > state.plan.children ||
      state.rows + boundary.rowCount > state.plan.rows ||
      state.bytes + boundary.finalFactBytes > state.plan.bytes
    )
      return Effect.fail(
        CodeGraphStoreError.of('Candidate capacity witness is stale, foreign, concurrent or exhausted.'),
      );
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        state.using = true;
        state.children += 1;
        state.rows += boundary.rowCount;
        state.bytes += boundary.finalFactBytes;
      }),
      () => state.validate.pipe(Effect.andThen(effect)),
      () =>
        Effect.sync(() => {
          state.using = false;
        }),
    );
  });
}

/** Bounded carry metadata owns every original canonical tuple/hyperedge before payload hydration. */
export function candidateProjectionCapacityPlan(input: {
  readonly snapshotId: string;
  readonly sourceFingerprint: string;
  readonly files: number;
  readonly associations: number;
  readonly pages: number;
  readonly reexports: number;
  readonly literals: number;
  readonly identityBytes: number;
  readonly originalBytes: number;
  readonly rawBytes: number;
  readonly storedBytes: number;
  readonly reexportBytes: number;
}): CandidateCapacityPlan {
  for (const n of [
    input.files,
    input.associations,
    input.pages,
    input.reexports,
    input.literals,
    input.identityBytes,
    input.originalBytes,
    input.rawBytes,
    input.storedBytes,
    input.reexportBytes,
  ])
    exact(n);
  const q = exact(6 * input.files + input.pages + input.associations + input.reexports + 2 * input.literals + 1);
  // reexportBytes includes exact edge-id/source/snapshot identities and payload before this per-edge overhead.
  const writeBytes = exact(
    2 * input.identityBytes +
      512 * input.files +
      input.originalBytes +
      input.rawBytes +
      416 * input.pages +
      32 * input.associations +
      input.reexportBytes +
      128 * input.reexports +
      Buffer.byteLength(input.snapshotId) +
      256,
  );
  const codecBytes = exact(input.rawBytes + 160 * input.pages);
  const operations = exact(1 + 2 * input.files + input.pages + input.reexports + 2 * input.literals);
  const writes = candidateNextFitUpper(q, writeBytes, codecBytes, operations);
  const preparationRows = exact(input.files + input.associations + input.reexports);
  const preparationBytes = exact(input.rawBytes + input.storedBytes + input.originalBytes + input.reexportBytes);
  return Object.freeze({
    version: 'candidate-stage-window-r1',
    snapshotId: input.snapshotId,
    sourceFingerprint: input.sourceFingerprint,
    preparationRows,
    preparationBytes,
    writeRows: q,
    writeBytes,
    codecBytes,
    writeChildren: writes,
    children: exact(1 + writes),
    rows: exact(preparationRows + 3 * q + writes),
    bytes: exact(preparationBytes + writeBytes),
    counts: Object.freeze({
      files: input.files,
      references: 0,
      keys: input.associations,
      aliases: 0,
      reexports: input.reexports,
      pages: input.pages,
    }),
  });
}

/** Consecutive output-bin pairs exceed one governed dimension; disjoint pairs prove this bound. */
export function candidateNextFitUpper(rows: number, bytes: number, codecBytes: number, operations: number): number {
  for (const n of [rows, bytes, codecBytes, operations]) exact(n);
  return operations === 0
    ? 0
    : Math.min(operations, exact(1 + 2 * (ceil(rows, 1000) + ceil(bytes, cap) + ceil(codecBytes, codecCap))));
}
