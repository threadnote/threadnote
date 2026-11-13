import {Schema} from 'effect';
import {RuntimeWriterFault, writerFail as fail} from './fault.js';

const maximumFileBytes = 16 * 1024 * 1024;
interface Observation {
  readonly bytes: Uint8Array;
}
/** Package-private operations constructed only from a retained facade-owned target. */
export interface WriterTransactionTarget<A extends Observation> {
  readonly maximumBytes: number;
  readonly attempted: boolean;
  inspect(): A;
  sameIdentity(a: A, b: A): boolean;
  beginAttempt(): void;
  writeAt(bytes: Uint8Array, offset: number): number;
  truncate(length: number): void;
  flush(): void;
  refreshBaseline(): void;
}
export type WriterTransactionResult<A> =
  | {readonly status: 'applied'; readonly current: A}
  | {readonly status: 'conflict'; readonly reason: 'path' | 'readonly' | 'source-changed'}
  | {readonly status: 'unknown'};
const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** The existing synchronous single-attempt protocol. Its assertion is a trusted caller port, not a lease grant. */
export function commitWriterTransaction<A extends Observation>(
  input: {readonly before: A; readonly afterBytes: Uint8Array; readonly assertCurrentSync: () => void},
  prepare: () => WriterTransactionTarget<A>,
): WriterTransactionResult<A> {
  let changed = false;
  try {
    if (
      !Number.isSafeInteger(input.afterBytes.byteLength) ||
      input.afterBytes.byteLength < 0 ||
      input.afterBytes.byteLength > maximumFileBytes
    )
      fail('io');
    input.assertCurrentSync();
    const target = prepare();
    if (input.afterBytes.byteLength > target.maximumBytes) fail('io');
    if (target.attempted) fail('source-changed');
    const current = target.inspect();
    if (!target.sameIdentity(current, input.before) || !equalBytes(current.bytes, input.before.bytes))
      return {status: 'conflict', reason: 'source-changed'};
    target.beginAttempt();
    let offset = 0;
    while (offset < input.afterBytes.length) {
      input.assertCurrentSync();
      changed = true;
      const count = target.writeAt(input.afterBytes, offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > input.afterBytes.length - offset) fail('io');
      offset += count;
    }
    input.assertCurrentSync();
    changed = true;
    target.truncate(input.afterBytes.length);
    target.flush();
    target.refreshBaseline();
    const observed = target.inspect();
    if (!equalBytes(observed.bytes, input.afterBytes)) return {status: 'unknown'};
    input.assertCurrentSync();
    return {status: 'applied', current: observed};
  } catch (error) {
    if (changed) return {status: 'unknown'};
    if (
      Schema.is(RuntimeWriterFault)(error) &&
      (error.reason === 'path' || error.reason === 'readonly' || error.reason === 'source-changed')
    )
      return {status: 'conflict', reason: error.reason};
    throw error;
  }
}
