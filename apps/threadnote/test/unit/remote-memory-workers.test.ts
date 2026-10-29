import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
import {rotateTenantIds} from '@threadnote/remote-memory/handoff_retention';
import {remoteIndexerBackoffMilliseconds, rotateShares} from '@threadnote/remote-memory/indexer';
import {superviseRemoteMemoryService} from '@threadnote/threadnote/remote_memory/main';
import {
  createRemoteMemoryWorkerHealth,
  remoteMemoryWorkerRowsReady,
  type RemoteMemoryWorkerHealthRow,
} from '@threadnote/remote-memory/worker_health';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('remote memory worker scheduling', () => {
  it('rotates each sorted share to the front without changing the fair cyclic order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({max: 100, min: 0}), {maxLength: 30, minLength: 1}), values => {
        const shares = EffectArray.map(
          values.sort((left, right) => left - right),
          value => ({share_id: Effect.pipe(String(value), EffectString.padStart(3, '0')), tenant_id: 'tenant'}),
        );
        for (const [index, share] of shares.entries()) {
          const rotated = rotateShares(shares, `${share.tenant_id}\u0000${share.share_id}`);
          expect(rotated).toEqual([...shares.slice(index), ...shares.slice(0, index)]);
        }
      }),
      {numRuns: 100},
    );
  });

  it('rotates bounded cleanup tenants without dropping or duplicating work', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({maxLength: 12, minLength: 1}), {maxLength: 30, minLength: 1}), values => {
        const tenants = [...values].sort();
        for (const [index, tenant] of tenants.entries()) {
          const rotated = rotateTenantIds(tenants, tenant);
          expect(rotated).toEqual([...tenants.slice(index), ...tenants.slice(0, index)]);
        }
      }),
      {numRuns: 100},
    );
  });

  it('uses monotonic bounded retry backoff', () => {
    fc.assert(
      fc.property(fc.integer({max: 10_000, min: 1}), attempts => {
        const delay = remoteIndexerBackoffMilliseconds(attempts);
        expect(delay).toBeLessThanOrEqual(60_000);
        expect(remoteIndexerBackoffMilliseconds(attempts + 1)).toBeGreaterThanOrEqual(delay);
      }),
      {numRuns: 100},
    );
  });
});

describe('remote memory worker health', () => {
  it('accepts exactly two fresh successful aggregate rows', () => {
    const now = new Date('2026-08-13T12:00:00.000Z');
    expect(remoteMemoryWorkerRowsReady(healthyRows(now), now)).toBe(true);
    expect(remoteMemoryWorkerRowsReady(healthyRows(now).slice(0, 1), now)).toBe(false);
    expect(remoteMemoryWorkerRowsReady([healthyRows(now)[0], healthyRows(now)[0]], now)).toBe(false);
  });

  it('fails readiness for stale heartbeat, stale index lag, or a worker failure', () => {
    const now = new Date('2026-08-13T12:00:00.000Z');
    const [indexer, retention] = healthyRows(now);
    expect(
      remoteMemoryWorkerRowsReady([{...indexer, heartbeat_at: new Date(now.getTime() - 120_001)}, retention], now),
    ).toBe(false);
    expect(
      remoteMemoryWorkerRowsReady([{...indexer, oldest_pending_at: new Date(now.getTime() - 300_001)}, retention], now),
    ).toBe(false);
    expect(remoteMemoryWorkerRowsReady([indexer, {...retention, failure_class: 'retention_failed'}], now)).toBe(false);
  });

  it('marks rejected and unexpectedly completed workers unavailable, except during shutdown', async () => {
    const onFailure = vi.fn();
    const rejected = createRemoteMemoryWorkerHealth(onFailure);
    rejected.supervise('indexer', Promise.reject(new Error('database unavailable')));
    await Promise.resolve();
    expect(() => rejected.assertReady()).toThrow('indexer worker is unavailable');

    const completed = createRemoteMemoryWorkerHealth(onFailure);
    completed.supervise('retention', Promise.resolve());
    await Promise.resolve();
    expect(() => completed.assertReady()).toThrow('retention worker is unavailable');

    const stopping = createRemoteMemoryWorkerHealth(onFailure, () => true);
    stopping.supervise('indexer', Promise.resolve());
    await Promise.resolve();
    expect(() => stopping.assertReady()).not.toThrow();
  });

  it('drains the service and fails fast after an unexpected worker exit', async () => {
    const workerHealth = createRemoteMemoryWorkerHealth(() => undefined);
    const shutdown = vi.fn(async () => undefined);
    workerHealth.supervise('indexer', Promise.resolve());

    await expect(
      superviseRemoteMemoryService({shutdown, signal: new Promise(() => undefined), workerHealth}),
    ).rejects.toThrow('Remote memory indexer worker failed');
    expect(shutdown).toHaveBeenCalledExactlyOnceWith('indexer worker failure');
  });
});

function healthyRows(now: Date): readonly [RemoteMemoryWorkerHealthRow, RemoteMemoryWorkerHealthRow] {
  return [
    {
      failure_class: null,
      heartbeat_at: now,
      last_success_at: now,
      oldest_pending_at: null,
      worker_name: 'indexer',
    },
    {
      failure_class: null,
      heartbeat_at: now,
      last_success_at: now,
      oldest_pending_at: null,
      worker_name: 'retention',
    },
  ];
}
