import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import FC from 'fast-check';
import {
  parseDarwinProcessResources,
  parseLinuxProcessResources,
  parseWindowsProcessResources,
  parseProcessCpuTime,
  processCpuObservation,
  readProcessResourceCounters,
  parseDarwinWorkingDirectories,
  type TimedProcessResourceCounters,
} from '../src/process-resources.js';

const at = '2026-11-03T16:00:00.000Z';
const sample = (
  cpuMilliseconds: number,
  monotonicMilliseconds: number,
  processStartIdentity = 'instance-a',
): TimedProcessResourceCounters => ({
  processId: 42,
  processStartIdentity,
  cpuMilliseconds,
  monotonicMilliseconds,
});

describe('recent per-process resource observations', () => {
  it('reads only requested cwd fields from NUL-delimited lsof output', () => {
    expect([
      ...parseDarwinWorkingDirectories(
        'p42\0\nfcwd\0n/work/repo with spaces\0\np99\0\nfcwd\0n/private/other\0\np43\0\nftxt\0n/not-a-cwd\0',
        [42, 43],
      ),
    ]).toEqual([[42, '/work/repo with spaces']]);
    expect(parseDarwinWorkingDirectories('p42\0\nfcwd\0n/bad\npath\0', [42]).size).toBe(0);
  });
  it('round trips bounded cwd records without leaking unselected processes', () => {
    FC.assert(
      FC.property(
        FC.uniqueArray(
          FC.record({id: FC.integer({min: 1, max: 1000}), name: FC.stringMatching(/^[a-zA-Z0-9 _-]{1,40}$/u)}),
          {selector: row => row.id, maxLength: 12},
        ),
        rows => {
          const selected = EffectArray.filter(rows, row => row.id % 2 === 0);
          const ids = EffectArray.map(selected, row => row.id);
          const output = EffectArray.join(
            EffectArray.map(rows, row => `p${row.id}\0\nfcwd\0n/work/${row.name}\0\n`),
            '',
          );
          expect([...parseDarwinWorkingDirectories(output, ids)]).toEqual(
            EffectArray.map(selected, row => [row.id, `/work/${row.name}`]),
          );
        },
      ),
      {numRuns: 64},
    );
  });
  it.each([
    [0, 0],
    [500, 100],
    [1250, 250],
  ])('measures %s CPU milliseconds over half a second as %s percent', (cpu, percent) => {
    expect(processCpuObservation(sample(1000, 0), sample(1000 + cpu, 500), at)).toEqual({
      state: 'sampled',
      percent,
      sampledAt: at,
      windowMilliseconds: 500,
    });
  });

  it('keeps first, missing, reused, reset and stale counters distinct from idle zero', () => {
    expect(processCpuObservation(undefined, sample(1, 0), at).state).toBe('sampling');
    for (const current of [
      undefined,
      sample(2, 500, 'other-instance'),
      sample(0, 500),
      sample(2, 0),
      sample(2, 10_001),
      sample(NaN, 500),
    ]) {
      expect(processCpuObservation(sample(1, 0), current, at).state).toBe('unavailable');
    }
  });

  it('preserves CPU ratios under scaling and offsets without mutating observations', () => {
    FC.assert(
      FC.property(
        FC.record({
          elapsed: FC.integer({min: 1, max: 2000}),
          cpu: FC.integer({min: 0, max: 20_000}),
          offset: FC.nat({max: 1_000_000}),
          scale: FC.integer({min: 1, max: 4}),
        }),
        ({elapsed, cpu, offset, scale}) => {
          const before = sample(offset, offset);
          const after = sample(offset + cpu, offset + elapsed);
          const copy = {...after};
          const observed = processCpuObservation(before, after, at);
          const scaled = processCpuObservation(
            sample(offset, offset),
            sample(offset + cpu * scale, offset + elapsed * scale),
            at,
          );
          expect(observed.state).toBe('sampled');
          if (observed.state !== 'sampled' || scaled.state !== 'sampled') throw new Error('Expected a valid sample');
          expect(observed.percent).toBeCloseTo((cpu / elapsed) * 100);
          expect(scaled.percent).toBeCloseTo(observed.percent);
          expect(Number.isFinite(observed.percent) && observed.percent >= 0).toBe(true);
          expect(after).toEqual(copy);
        },
      ),
      {numRuns: 100},
    );
  });

  it('parses fractional macOS time and canonical start identity, filtering unrequested PIDs', () => {
    expect(parseProcessCpuTime('123:45.67')).toBe(7_425_670);
    expect(parseProcessCpuTime('1-02:03:04.5')).toBe(93_784_500);
    expect(parseProcessCpuTime('12:60.1')).toBeUndefined();
    const rows = parseDarwinProcessResources(
      ' 42 100 1:23.45 Tue Nov  3 15:00:00 2026\n 77 50 0:01.00 Tue Nov  3 15:00:00 2026\n',
      [42],
    );
    expect([...rows.values()]).toEqual([
      {
        processId: 42,
        cpuMilliseconds: 83450,
        rssBytes: 102400,
        processStartIdentity: 'darwin-v2:Tue Nov  3 15:00:00 2026',
      },
    ]);
    expect(parseDarwinProcessResources('42 invalid 2:00.0 fake', [42]).size).toBe(0);
  });

  it('reads Linux utime/stime and start ticks from the same stat record even with parentheses in comm', () => {
    const fields = EffectArray.map(Array.from({length: 22}), () => '0');
    fields[0] = 'R';
    fields[11] = '125';
    fields[12] = '75';
    fields[19] = '123456';
    fields[21] = '10';
    const stat = '42 (worker (nested)) ' + EffectArray.join(fields, ' ');
    expect(parseLinuxProcessResources(stat, 42, 100, 4096)).toEqual({
      processId: 42,
      cpuMilliseconds: 2000,
      rssBytes: 40960,
      processStartIdentity: 'linux:123456',
    });
    expect(parseLinuxProcessResources(stat, 43, 100, 4096)).toBeUndefined();
    expect(parseLinuxProcessResources(stat, 42, 0, 4096)).toBeUndefined();
    expect(parseLinuxProcessResources('42 invalid', 42, 100, 4096)).toBeUndefined();
  });

  it('accepts a Windows singleton or array without losing start-time precision', () => {
    const row = {pid: 42, cpu: 123.45, rss: 1024, start: '639000000000000001'};
    expect([...parseWindowsProcessResources(JSON.stringify(row), [42]).values()]).toEqual([
      {processId: 42, cpuMilliseconds: 123.45, rssBytes: 1024, processStartIdentity: 'win32:639000000000000001'},
    ]);
    expect(parseWindowsProcessResources(JSON.stringify([row, {...row, pid: 50}]), [42]).size).toBe(1);
    expect(parseWindowsProcessResources('{bad', [42]).size).toBe(0);
    expect(parseWindowsProcessResources(JSON.stringify({...row, cpu: -1}), [42]).size).toBe(0);
  });

  effectIt.effect('does not probe empty or unsupported inventories', () =>
    Effect.gen(function* () {
      expect((yield* readProcessResourceCounters([], 'darwin', {}, env => env)).size).toBe(0);
      expect((yield* readProcessResourceCounters([42], 'freebsd', {}, env => env)).size).toBe(0);
    }),
  );

  effectIt.effect('samples a busy native child more highly than a sleeping child', () =>
    Effect.gen(function* () {
      if (!['darwin', 'linux', 'win32'].includes(process.platform)) return;
      yield* Effect.acquireUseRelease(
        Effect.sync(() => [
          Bun.spawn([process.execPath, '-e', 'while(true){}'], {stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'}),
          Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
          }),
        ]),
        children =>
          Effect.gen(function* () {
            const ids = EffectArray.map(children, child => child.pid);
            const start = performance.now();
            const first = yield* readProcessResourceCounters(ids, process.platform, process.env, env => env);
            yield* Effect.sleep(500);
            const second = yield* readProcessResourceCounters(ids, process.platform, process.env, env => env);
            const busy = second.get(ids[0]);
            const idle = second.get(ids[1]);
            expect(first.size).toBe(2);
            expect(second.size).toBe(2);
            if (process.platform === 'darwin') expect(second.get(ids[0])?.workingDirectory).toBe(process.cwd());
            if (!busy || !idle) throw new Error('Resource probe unavailable');
            expect(busy.cpuMilliseconds - first.get(ids[0])!.cpuMilliseconds).toBeGreaterThan(
              idle.cpuMilliseconds - first.get(ids[1])!.cpuMilliseconds + 50,
            );
            expect(performance.now() - start).toBeLessThan(5000);
          }),
        children =>
          Effect.forEach(
            children,
            child =>
              Effect.sync(() => {
                child.kill();
              }),
            {discard: true},
          ),
      );
    }).pipe(TestClock.withLive),
  );
});
