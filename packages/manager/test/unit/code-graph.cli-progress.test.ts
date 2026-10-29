import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  formatCodeGraphDoctorProgressLine,
  formatCodeGraphIndexProgressLine,
  formatCodeGraphPurgeProgressLine,
  formatCodeGraphRepairProgressLine,
} from '@threadnote/graph/cli/progress';
import type {CodeGraphProgress} from '@threadnote/graph/types';
import {graphMaintenanceRemainingMilliseconds} from '@threadnote/manager/graph/model';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph compact CLI progress', () => {
  it('never includes a scanning activity path or newline', () => {
    const progress = scanningProgress('src/very/long/path/that/must/stay/out/of/the/status/line.ts');
    const line = formatCodeGraphIndexProgressLine(progress);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(line).not.toContain(progress.activity!.path);
    expect(line).toContain('Scanning ·');
  });

  it('formats repair, doctor, and purge as single compact lines', () => {
    expect(formatCodeGraphRepairProgressLine({current: 2, phase: 'checking', total: 5})).toBe(
      'Repairing · checking 2/5 databases',
    );
    expect(formatCodeGraphDoctorProgressLine({current: 2, phase: 'checking', total: 5})).toBe(
      'Checking · checking 2/5 databases',
    );
    expect(formatCodeGraphPurgeProgressLine({phase: 'quarantining', dryRun: true})).toBe(
      'Would purge · quarantining files',
    );
    expect(
      formatCodeGraphIndexProgressLine({
        admission: {
          admissionClass: 'current-required',
          enqueuedAt: '2026-09-21T08:00:00.000Z',
          position: 1,
          size: 2,
        },
        phase: 'waiting',
        reason: 'home-builder-cap',
      }),
    ).toBe('Waiting for graph builder slot · queue 1/2');
  });

  fcEffectProp(
    effectIt,
    'index lines stay one row and omit scanning paths',
    {
      path: fc.uuid().map(id => `src/${id}/file.ts`),
      completed: fc.integer({max: 10_000, min: 0}),
      total: fc.integer({max: 10_000, min: 0}),
    },
    ({path, completed, total}) =>
      Effect.sync(() => {
        const line = formatCodeGraphIndexProgressLine(scanningProgress(path, completed, total));
        expect(Effect2.pipe(line, EffectString.includes('\n')) || Effect2.pipe(line, EffectString.includes('\r'))).toBe(
          false,
        );
        expect(line).not.toContain(path);
      }),
    {fastCheck: {numRuns: 40}},
  );

  fcEffectProp(
    effectIt,
    'maintenance remaining estimate is monotone as completed increases',
    {
      elapsed: fc.integer({max: 60_000, min: 1}),
      total: fc.integer({max: 32, min: 2}),
    },
    ({elapsed, total}) =>
      Effect.sync(() => {
        const startedAt = '2026-09-09T00:00:00.000Z';
        const now = Date.parse(startedAt) + elapsed;
        let previous = Number.POSITIVE_INFINITY;
        for (let completed = 1; completed <= total; completed += 1) {
          const remaining = graphMaintenanceRemainingMilliseconds({completed, startedAt, total}, now);
          expect(remaining).toBeDefined();
          expect(remaining!).toBeLessThanOrEqual(previous);
          previous = remaining!;
        }
      }),
    {fastCheck: {numRuns: 40}},
  );
});

function scanningProgress(path: string, completed = 3, total = 10): Extract<CodeGraphProgress, {phase: 'scanning'}> {
  return {
    accepted: 2,
    activity: {
      batchCompleted: 1,
      batchTotal: 2,
      bytes: 128,
      language: 'typescript',
      path,
      stage: 'extracting',
    },
    completed,
    excluded: 0,
    phase: 'scanning',
    skipped: 1,
    total,
    unit: 'files',
  };
}
