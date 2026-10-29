import {isJsonObject} from '@threadnote/platform/json';
import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {codeGraphDiskCapacityReservationProjection, saturatingCapacityAdd} from '@threadnote/graph/disk/capacity';
import {
  aggregateCodeGraphDiskReservationReceipts,
  codeGraphDiskReservationFilesystemKey,
  parseCodeGraphDiskReservationReceipt,
  serializeCodeGraphDiskReservationReceipt,
  type CodeGraphDiskReservationReceipt,
} from '@threadnote/graph/disk/reservation';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph disk reservation ledger', () => {
  effectIt.effect('round trips one canonical path-free receipt', () =>
    Effect.sync(() => {
      const receipt = {
        calibrationIdentity: 'graph-v14:native-code-graph-14:direct-persistent:capacity-v1',
        filesystems: [{bytes: 4_096, key: Effect2.pipe('a', EffectString.repeat(64))}],
        operation: 'stage persistent code graph facts' as const,
        processId: 42,
        processStartIdentity: 'linux:1234',
        token: Effect2.pipe('b', EffectString.repeat(64)),
        version: 1 as const,
      };
      const serialized = serializeCodeGraphDiskReservationReceipt(receipt);

      expect(parseCodeGraphDiskReservationReceipt(`v1-${receipt.token}.json`, serialized)).toEqual(receipt);
      expect(serialized).not.toContain('/');

      for (const processStartIdentity of [
        'linux:1234',
        'win32:638893834360000000',
        'darwin-v2:Tue Jul 28 18:57:16 2026',
        'darwin-v2:Sat Aug  8 08:07:06 2026',
      ]) {
        const candidate = {...receipt, processStartIdentity};
        expect(
          parseCodeGraphDiskReservationReceipt(
            `v1-${candidate.token}.json`,
            serializeCodeGraphDiskReservationReceipt(candidate),
          ),
        ).toEqual(candidate);
      }
      for (const processStartIdentity of [
        'win32:00',
        'win32:123456789012345678901',
        'darwin:Sat Aug  8 08:07:06 2026',
        'darwin-v2:Sat Aug  08 08:07:06 2026',
        'darwin-v2:Sat Aug  8 08:07:60 2026',
      ]) {
        expect(() => serializeCodeGraphDiskReservationReceipt({...receipt, processStartIdentity})).toThrow();
      }
    }),
  );

  fcEffectProp(
    effectIt,
    'rejects path-bearing, control-bearing, and non-runtime process identities',
    {
      processStartIdentity: fc.oneof(
        fc.string().map(value => `linux:${value}/private/repository`),
        fc.string().map(value => `win32:${value}\\private\\repository`),
        fc.string().map(value => `darwin-v2:${value}\nleak`),
        fc.string().map(value => `unknown:${value}`),
      ),
    },
    ({processStartIdentity}) =>
      Effect.sync(() => {
        const receipt: CodeGraphDiskReservationReceipt = {
          calibrationIdentity: 'fixture-v1',
          filesystems: [{bytes: 1, key: Effect2.pipe('a', EffectString.repeat(64))}],
          operation: 'stage persistent code graph facts',
          processId: 42,
          processStartIdentity,
          token: Effect2.pipe('b', EffectString.repeat(64)),
          version: 1,
        };
        expect(() => serializeCodeGraphDiskReservationReceipt(receipt)).toThrow();
        const wire = JSON.stringify({
          version: 1,
          token: receipt.token,
          processId: receipt.processId,
          processStartIdentity,
          operation: receipt.operation,
          calibrationIdentity: receipt.calibrationIdentity,
          filesystems: receipt.filesystems,
        });
        expect(parseCodeGraphDiskReservationReceipt(`v1-${receipt.token}.json`, wire)).toBeUndefined();
      }),
    {fastCheck: {numRuns: 300}},
  );

  fcEffectProp(
    effectIt,
    'canonically round trips bounded receipts without path-bearing fields',
    {
      bytes: fc.integer({max: 2 ** 42, min: 0}),
      operation: fc.constantFrom(
        'cache code graph file facts' as const,
        'cache materialized code graph file shards' as const,
        'promote ready code graph snapshot' as const,
        'publish persistent code graph snapshot' as const,
        'register persistent code graph materialization plan' as const,
        'restore persistent code graph query indexes' as const,
        'resolve persistent code graph reexport aliases' as const,
        'resolve persistent code graph references' as const,
        'stage persistent code graph facts' as const,
        'stage persistent code graph inventory' as const,
        'stage persistent code graph workspace' as const,
      ),
      processId: fc.integer({max: 2_147_483_647, min: 1}),
      processStart: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 1}),
      tokenSeed: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
      twoFilesystems: fc.boolean(),
    },
    ({bytes, operation, processId, processStart, tokenSeed, twoFilesystems}) =>
      Effect.sync(() => {
        const token = Effect2.pipe(tokenSeed.toString(16), EffectString.padStart(64, '0'));
        const receipt: CodeGraphDiskReservationReceipt = {
          calibrationIdentity: 'graph-v14:native-code-graph-14:direct-persistent:capacity-v1',
          filesystems: [
            {bytes, key: Effect2.pipe('a', EffectString.repeat(64))},
            ...(twoFilesystems
              ? [{bytes: Math.floor(bytes / 2), key: Effect2.pipe('b', EffectString.repeat(64))}]
              : []),
          ],
          operation,
          processId,
          processStartIdentity: `linux:${processStart}`,
          token,
          version: 1,
        };
        const serialized = serializeCodeGraphDiskReservationReceipt(receipt);
        const parsedValue: unknown = JSON.parse(serialized);
        if (!isJsonObject(parsedValue)) throw new Error('Expected a reservation object.');
        const parsed = parsedValue;

        expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(4_096);
        expect(EffectRecord.keys(parsed)).toEqual([
          'version',
          'token',
          'processId',
          'processStartIdentity',
          'operation',
          'calibrationIdentity',
          'filesystems',
        ]);
        expect(serialized).not.toContain('/private/customer/repository');
        expect(parseCodeGraphDiskReservationReceipt(`v1-${token}.json`, serialized)).toEqual(receipt);
        expect(
          parseCodeGraphDiskReservationReceipt(`v1-${Effect2.pipe('f', EffectString.repeat(64))}.json`, serialized),
        ).toBeUndefined();
        expect(parseCodeGraphDiskReservationReceipt(`v1-${token}.json`, `${serialized}\n`)).toBeUndefined();
      }),
    {fastCheck: {numRuns: 300}},
  );

  fcEffectProp(
    effectIt,
    'aggregates every receipt permutation deterministically with safe saturation',
    {
      entries: fc.array(
        fc.record({
          bytes: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
          keyIndex: fc.integer({max: 2, min: 0}),
        }),
        {maxLength: 48},
      ),
    },
    ({entries}) =>
      Effect.sync(() => {
        const receipts = EffectArray.map(entries, (entry, index): CodeGraphDiskReservationReceipt => ({
          calibrationIdentity: 'fixture-v1',
          filesystems: [
            {bytes: entry.bytes, key: Effect2.pipe(['a', 'b', 'c'][entry.keyIndex], EffectString.repeat(64))},
          ],
          operation: 'stage persistent code graph facts',
          processId: index + 1,
          processStartIdentity: `linux:${index + 1}`,
          token: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
          version: 1,
        }));
        const independent = new Map<string, number>();
        for (const entry of entries) {
          const key = Effect2.pipe(['a', 'b', 'c'][entry.keyIndex], EffectString.repeat(64));
          independent.set(key, saturatingCapacityAdd(independent.get(key) ?? 0, entry.bytes));
        }
        const expected = EffectArray.map([...independent], ([key, bytes]) => ({bytes, key})).sort((left, right) =>
          Effect2.pipe(left.key, EffectString.localeCompare(right.key)),
        );

        expect(aggregateCodeGraphDiskReservationReceipts(receipts)).toEqual(expected);
        expect(aggregateCodeGraphDiskReservationReceipts([...receipts].reverse())).toEqual(expected);
      }),
    {fastCheck: {numRuns: 300}},
  );

  fcEffectProp(
    effectIt,
    'projects shared filesystem demand once and hashes only platform plus device identity',
    {
      freelist: fc.integer({max: 2 ** 40, min: 0}),
      main: fc.integer({max: 2 ** 40, min: 0}),
      recovery: fc.integer({max: 2 ** 40, min: 0}),
      transient: fc.integer({max: 2 ** 40, min: 0}),
    },
    ({freelist, main, recovery, transient}) =>
      Effect.sync(() => {
        const key = codeGraphDiskReservationFilesystemKey('linux', 123n);
        if (!key) throw TestError.make({message: 'A positive runtime device must produce a filesystem key.'});
        const projection = codeGraphDiskCapacityReservationProjection({
          demand: {
            calibrationIdentity: 'fixture-v1',
            mainHighWaterBytes: main,
            recoveryFloorBytes: recovery,
            state: 'measured',
            transientFilesystem: 'temporary',
            transientHighWaterBytes: transient,
          },
          durableFilesystemKey: key,
          freelistBytes: freelist,
          temporaryFilesystemKey: key,
        });

        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(codeGraphDiskReservationFilesystemKey('linux', 0n)).toBeUndefined();
        expect(codeGraphDiskReservationFilesystemKey('win32', 0)).toBeUndefined();
        expect(codeGraphDiskReservationFilesystemKey('linux', undefined)).toBeUndefined();
        expect(projection).toEqual({
          calibrationIdentity: 'fixture-v1',
          filesystems: [
            {
              bytes: saturatingCapacityAdd(Math.max(0, main - Math.min(main, freelist)), transient, recovery),
              key,
            },
          ],
          state: 'measured',
        });
      }),
    {fastCheck: {numRuns: 300}},
  );
});
