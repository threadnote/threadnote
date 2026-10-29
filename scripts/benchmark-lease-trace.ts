import {Array as EffectArray} from 'effect';
import type {CodeGraphLeaseTimingObserver} from '@threadnote/graph/store';

interface LeaseTimingPoint {
  readonly operation: 'acquire' | 'release';
  readonly stage: Parameters<CodeGraphLeaseTimingObserver>[0];
  readonly boundary: 'begin' | 'end';
  readonly wallMilliseconds: number;
  readonly processCpuMilliseconds: number;
}

/** Per-sample nested boundaries, retained separately from assessed measurements. */
export class BenchmarkLeaseTrace {
  readonly #points: LeaseTimingPoint[] = [];
  #dropped = 0;
  readonly #started: {wallMilliseconds: number; processCpuMilliseconds: number};

  constructor(
    readonly clock = () => {
      const cpu = process.cpuUsage();
      return {wallMilliseconds: performance.now(), processCpuMilliseconds: (cpu.user + cpu.system) / 1_000};
    },
  ) {
    this.#started = clock();
  }

  observe(operation: 'acquire' | 'release', stage: LeaseTimingPoint['stage'], boundary: 'begin' | 'end'): void {
    if (this.#points.length >= 64) {
      this.#dropped++;
      return;
    }
    const now = this.clock();
    this.#points.push({
      operation,
      stage,
      boundary,
      wallMilliseconds: now.wallMilliseconds - this.#started.wallMilliseconds,
      processCpuMilliseconds: now.processCpuMilliseconds - this.#started.processCpuMilliseconds,
    });
  }

  report() {
    const stack: string[] = [];
    let balanced = true;
    const started = new Set<string>();
    let repeated = false;
    for (const point of this.#points) {
      const key = `${point.operation}:${point.stage}`;
      if (point.boundary === 'begin') {
        repeated ||= started.has(key);
        started.add(key);
        stack.push(key);
      } else if (stack.pop() !== key) balanced = false;
    }
    const common = [
      'writer-gate',
      'session',
      'session-body',
      'schema',
      'lease-sql',
      'connection-configure',
      'transaction',
      'transaction-body',
    ];
    const required = [
      ...EffectArray.map(['token', 'prepare', 'prune', ...common], stage => `acquire:${stage}`),
      ...EffectArray.map(['exists', ...common], stage => `release:${stage}`),
    ];
    const boundariesBalanced = balanced && stack.length === 0 && !repeated;
    return {
      boundariesBalanced,
      complete: this.#dropped === 0 && boundariesBalanced && EffectArray.every(required, key => started.has(key)),
      dropped: this.#dropped,
      points: EffectArray.map(this.#points, point => ({...point})),
    };
  }
}
