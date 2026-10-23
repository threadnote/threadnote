import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {BenchmarkLeaseTrace} from '../../../../scripts/benchmark-lease-trace.js';

describe('bounded paired lease diagnostic trace', () => {
  it('retains aligned acquisition, session-open, body, session-close and lock-release intervals', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: 0, max: 50}), {minLength: 5, maxLength: 5}), durations => {
        let wall = 0;
        const trace = new BenchmarkLeaseTrace(() => ({wallMilliseconds: wall, processCpuMilliseconds: wall / 2}));
        trace.observe('acquire', 'writer-gate', 'begin');
        wall += durations[0];
        trace.observe('acquire', 'session', 'begin');
        wall += durations[1];
        trace.observe('acquire', 'session-body', 'begin');
        wall += durations[2];
        trace.observe('acquire', 'session-body', 'end');
        wall += durations[3];
        trace.observe('acquire', 'session', 'end');
        wall += durations[4];
        trace.observe('acquire', 'writer-gate', 'end');
        const report = trace.report();
        expect(report.boundariesBalanced).toBe(true);
        expect(report.complete).toBe(false);
        expect(
          report.points.slice(1).map((point, index) => point.wallMilliseconds - report.points[index].wallMilliseconds),
        ).toEqual(durations);
        expect(report.points.at(-1)?.wallMilliseconds).toBe(durations.reduce((a, b) => a + b, 0));
        expect(report.points.at(-1)?.processCpuMilliseconds).toBe(wall / 2);
        report.points.length = 0;
        expect(trace.report().points).toHaveLength(6);
      }),
      {numRuns: 40},
    );
  });
  it('requires every successful lease stage and rejects duplicate stage records', () => {
    const trace = new BenchmarkLeaseTrace();
    for (const operation of ['acquire', 'release'] as const) {
      for (const stage of [
        'writer-gate',
        'session',
        'session-body',
        'schema',
        'lease-sql',
        'connection-configure',
        'transaction',
        'transaction-body',
      ] as const) {
        trace.observe(operation, stage, 'begin');
        trace.observe(operation, stage, 'end');
      }
    }
    expect(trace.report().complete).toBe(false);
    for (const stage of ['token', 'prepare', 'prune'] as const) {
      trace.observe('acquire', stage, 'begin');
      trace.observe('acquire', stage, 'end');
    }
    trace.observe('release', 'exists', 'begin');
    trace.observe('release', 'exists', 'end');
    expect(trace.report().complete).toBe(true);
    trace.observe('release', 'exists', 'begin');
    trace.observe('release', 'exists', 'end');
    expect(trace.report().complete).toBe(false);
  });
  it('marks overflow and mismatched or incomplete boundaries as incomplete without unbounded retention', () => {
    const trace = new BenchmarkLeaseTrace();
    expect(trace.report().complete).toBe(false);
    trace.observe('release', 'writer-gate', 'begin');
    trace.observe('release', 'session', 'end');
    expect(trace.report().complete).toBe(false);
    for (let index = 0; index < 100; index++) trace.observe('acquire', 'token', index % 2 === 0 ? 'begin' : 'end');
    expect(trace.report().points).toHaveLength(64);
    expect(trace.report().dropped).toBe(38);
    expect(trace.report().complete).toBe(false);
  });
});
