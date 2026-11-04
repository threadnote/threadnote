import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {candidateCapacityPlan, candidateNextFitUpper} from '@threadnote/graph/store/resolution/candidate_capacity';
import {
  codeGraphCandidateWindowDemand,
  codeGraphDiskCapacityReservationProjection,
} from '@threadnote/graph/disk/capacity';
import {
  resolutionCandidateFileRepresentable,
  resolutionCandidateReexportRow,
} from '@threadnote/graph/store/resolution/candidate_index';
import type {CodeGraphReference} from '@threadnote/graph/types';
const reference = (id: string): CodeGraphReference => ({
  edgeId: id,
  evidencePath: 'f',
  resolutionDomain: 'd',
  lookupTiers: [],
  aliasLookupKeys: ['a'],
  relation: 'reexports',
  sourceName: 's',
  targetName: 'x',
  provenance: 'resolved',
  evidenceSpan: {line: 1, column: 1, endLine: 1, endColumn: 2},
});
const input = (n: number) => ({
  snapshotId: 's',
  files: [{path: 'f', contentHash: 'h'}],
  references: Array.from({length: n}, (_, i) => reference(String(i))),
});
describe('candidate whole-stage capacity plan', () => {
  for (const count of [0, 1, 100, 1000])
    it(`owns all legal empty-tier alias reexport overhead for ${count} edges`, () => {
      const original = input(count);
      expect(resolutionCandidateFileRepresentable('s', original.files[0], original.references)).toBe(true);
      const plan = candidateCapacityPlan(original);
      let actual = 2 * (3 + 256) + 1 + 256;
      for (const ref of original.references) {
        const row = resolutionCandidateReexportRow(ref)!;
        actual +=
          Buffer.byteLength(row.json) +
          Buffer.byteLength('s') +
          Buffer.byteLength('f') +
          Buffer.byteLength(row.id) +
          128;
      }
      expect(plan.writeBytes).toBeGreaterThanOrEqual(actual);
      expect(plan.counts).toMatchObject({keys: 0, reexports: count});
      expect(plan.children).toBeGreaterThan(0);
    });
  it('reserves exact nonzero SQLite TEMP and all durable components without freelist credit', () => {
    const demand = codeGraphCandidateWindowDemand({
      children: 2,
      bytes: 8,
      rows: 3,
      pageSize: 4096,
      walAutoCheckpointPages: 1,
      lexicalFormatVersion: 3,
    });
    expect(demand).toMatchObject({
      state: 'measured',
      mainHighWaterBytes: 9000,
      transientHighWaterBytes: 8984,
      recoveryFloorBytes: 17288,
      sqliteTemporaryBytes: 8970,
    });
    const durable = EffectString.repeat(64)('a'),
      temp = EffectString.repeat(64)('b');
    expect(
      codeGraphDiskCapacityReservationProjection({
        demand,
        durableFilesystemKey: durable,
        temporaryFilesystemKey: temp,
        freelistBytes: 999999999,
      }),
    ).toMatchObject({
      state: 'measured',
      filesystems: [
        {key: durable, bytes: 35272},
        {key: temp, bytes: 8970},
      ],
    });
    expect(
      codeGraphDiskCapacityReservationProjection({
        demand,
        durableFilesystemKey: durable,
        temporaryFilesystemKey: durable,
        freelistBytes: 999999999,
      }),
    ).toMatchObject({
      state: 'measured',
      filesystems: [{key: durable, bytes: 44242}],
    });
  });
  it('dominates independently summed child MAX demands under mixed row, byte and page floors', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({bytes: fc.integer({min: 0, max: 2000000}), rows: fc.integer({min: 0, max: 4000})}), {
          minLength: 1,
          maxLength: 30,
        }),
        children => {
          const bytes = EffectArray.reduce(children, 0, (n, x) => n + x.bytes),
            rows = EffectArray.reduce(children, 0, (n, x) => n + x.rows),
            p = 8192,
            k = 500;
          const demand = codeGraphCandidateWindowDemand({
            children: children.length,
            bytes,
            rows,
            pageSize: p,
            walAutoCheckpointPages: k,
            lexicalFormatVersion: 3,
          });
          expect(demand.state).toBe('measured');
          if (demand.state !== 'measured') return;
          const main = EffectArray.reduce(children, 0, (n, x) => n + Math.max(p, 5 * x.bytes, 256 * x.rows));
          const transient = EffectArray.reduce(children, 0, (n, x) => n + Math.max(p, 3 * x.bytes, 256 * x.rows));
          const recovery = EffectArray.reduce(
            children,
            0,
            (n, x) => n + Math.max(Math.max(p, 3 * x.bytes, 256 * x.rows), 32 + k * (p + 24)),
          );
          expect(demand.mainHighWaterBytes).toBeGreaterThanOrEqual(main);
          expect(demand.transientHighWaterBytes).toBeGreaterThanOrEqual(transient);
          expect(demand.recoveryFloorBytes).toBeGreaterThanOrEqual(recovery);
          const key = EffectString.repeat(64)('a'),
            temp = EffectString.repeat(64)('b');
          const shared = codeGraphDiskCapacityReservationProjection({
            demand,
            durableFilesystemKey: key,
            temporaryFilesystemKey: key,
            freelistBytes: 999999999,
          });
          const split = codeGraphDiskCapacityReservationProjection({
            demand,
            durableFilesystemKey: key,
            temporaryFilesystemKey: temp,
            freelistBytes: 999999999,
          });
          expect(shared.state).toBe('measured');
          expect(split.state).toBe('measured');
          if (shared.state === 'measured' && split.state === 'measured')
            expect(shared.filesystems[0].bytes).toBe(EffectArray.reduce(split.filesystems, 0, (n, x) => n + x.bytes));
        },
      ),
      {numRuns: 100},
    );
    expect(
      codeGraphCandidateWindowDemand({
        children: 1,
        bytes: 1,
        rows: 1,
        pageSize: 8192,
        walAutoCheckpointPages: 0,
        lexicalFormatVersion: 3,
      }).state,
    ).toBe('unknown');
  });
});

it('bounds independent greedy row/byte/codec partitions without a per-source exclusion', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          rows: fc.integer({min: 1, max: 1000}),
          bytes: fc.integer({min: 0, max: 8388608}),
          codec: fc.integer({min: 0, max: 7831552}),
        }),
        {maxLength: 100},
      ),
      ops => {
        let pages = 0,
          rows = 0,
          bytes = 0,
          codec = 0;
        for (const op of ops) {
          if (pages === 0) {
            pages = 1;
          } else if (rows + op.rows > 1000 || bytes + op.bytes > 8388608 || codec + op.codec > 7831552) {
            pages++;
            rows = 0;
            bytes = 0;
            codec = 0;
          }
          rows += op.rows;
          bytes += op.bytes;
          codec += op.codec;
        }
        const sum = EffectArray.reduce(ops, {rows: 0, bytes: 0, codec: 0}, (n, x) => ({
          rows: n.rows + x.rows,
          bytes: n.bytes + x.bytes,
          codec: n.codec + x.codec,
        }));
        expect(candidateNextFitUpper(sum.rows, sum.bytes, sum.codec, ops.length)).toBeGreaterThanOrEqual(pages);
      },
    ),
    {numRuns: 200},
  );
});
