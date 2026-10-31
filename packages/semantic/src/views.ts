import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import {Schema} from 'effect';
import {Counter, Digest, Evidence, Identifier, Observation, observationKey} from './contracts.js';
export const Continuation = Schema.Struct({
  version: Schema.Literal(1),
  snapshot: Identifier,
  query: Digest,
  observation: Schema.String,
  offset: Counter,
});
export type Continuation = typeof Continuation.Type;
export interface QuerySnapshot {
  readonly id: string;
  readonly query: string;
  readonly evidence: Evidence;
  readonly items: readonly Schema.Json[];
}
export interface QueryPage {
  readonly version: 1;
  readonly status: 'ok';
  readonly evidence: Evidence;
  readonly items: readonly Schema.Json[];
  readonly offset: number;
  readonly remaining: number;
  readonly next: Continuation | null;
}
export type PageResult =
  | {
      readonly status: 'page';
      readonly page: QueryPage;
      readonly encodedBytes: number;
    }
  | {
      readonly status: 'stale' | 'invalid-cursor' | 'invalid-budget' | 'budget-exceeded';
    };
const snapshotSchema = Schema.Struct({
  id: Identifier,
  query: Digest,
  evidence: Evidence,
  items: Schema.Array(Schema.Json).check(Schema.isMaxLength(100000)),
});
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of EffectRecord.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** The coordinator retains this snapshot; a caller-supplied cursor never supplies result data. */
export function createQuerySnapshot(value: QuerySnapshot): QuerySnapshot {
  return freeze(structuredClone(Schema.decodeSync(snapshotSchema)(value)));
}
export function queryPage(
  snapshot: QuerySnapshot,
  current: Observation,
  query: string,
  budget: {
    readonly maxItems: number;
    readonly maxBytes: number;
  },
  cursor?: Continuation,
): PageResult {
  if (
    !EffectArray.every([budget.maxItems, budget.maxBytes], n => Number.isSafeInteger(n) && n > 0) ||
    budget.maxItems > 1000 ||
    budget.maxBytes > 8 * 1024 * 1024
  )
    return {status: 'invalid-budget'};
  const observation = observationKey(snapshot.evidence.observation);
  if (query !== snapshot.query || observationKey(current) !== observation) return {status: 'stale'};
  if (
    cursor &&
    (cursor.version !== 1 ||
      cursor.snapshot !== snapshot.id ||
      cursor.query !== query ||
      cursor.observation !== observation ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 1 ||
      cursor.offset >= snapshot.items.length)
  )
    return {status: 'invalid-cursor'};
  const offset = cursor?.offset ?? 0;
  const render = (count: number): QueryPage => {
    const end = offset + count;
    return {
      version: 1,
      status: 'ok',
      evidence: snapshot.evidence,
      items: snapshot.items.slice(offset, end),
      offset,
      remaining: snapshot.items.length - end,
      next:
        end < snapshot.items.length
          ? {
              version: 1,
              snapshot: snapshot.id,
              query,
              observation,
              offset: end,
            }
          : null,
    };
  };
  let selected: PageResult = {status: 'budget-exceeded'};
  // Serialize each item once. Only the small envelope changes per candidate;
  // terminal cursor removal means envelope size is not necessarily monotonic.
  const encoder = new TextEncoder();
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const limit = Math.min(budget.maxItems, snapshot.items.length - offset);
  const envelopeBytes = bytes({...render(0), remaining: 0, next: null});
  const cursorBytes = bytes({
    version: 1,
    snapshot: snapshot.id,
    query,
    observation,
    offset: 0,
  });
  let itemBytes = 0;
  let selectedCount = -1;
  let selectedBytes = 0;
  for (let count = 0; count <= limit; count++) {
    if (count > 0) itemBytes += bytes(snapshot.items[offset + count - 1]) + (count > 1 ? 1 : 0);
    if (count === 0 && snapshot.items.length > 0) continue;
    const end = offset + count;
    const remaining = snapshot.items.length - end;
    const encodedBytes =
      envelopeBytes +
      itemBytes +
      String(remaining).length -
      1 +
      (remaining > 0 ? cursorBytes + String(end).length - 1 - 4 : 0);
    if (encodedBytes <= budget.maxBytes) {
      selectedCount = count;
      selectedBytes = encodedBytes;
    }
  }
  if (selectedCount >= 0)
    selected = {
      status: 'page',
      page: render(selectedCount),
      encodedBytes: selectedBytes,
    };
  return selected;
}
export const OwnedView = Schema.Struct({
  observation: Observation,
  authority: Identifier,
  fence: Counter,
});
export type OwnedView = typeof OwnedView.Type;
/** Pure precondition check only; the writer must enforce it at the actual mutation boundary. */
export function sameOwnedView(expected: OwnedView, actual: OwnedView): boolean {
  return (
    expected.authority === actual.authority &&
    expected.fence === actual.fence &&
    observationKey(expected.observation) === observationKey(actual.observation)
  );
}
