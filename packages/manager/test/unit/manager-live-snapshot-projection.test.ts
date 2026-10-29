import {Record as EffectRecord, Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {createManagerLiveSnapshotProjection} from '../../src/live/snapshot_projection.js';
import type {ManagerLiveSnapshot} from '../../src/live/store.js';

const isPayload = Schema.is(Schema.Struct({value: Schema.Finite}));
type Payload = {readonly value: number};

describe('typed Manager live snapshot views', () => {
  it('preserves raw payloads, source snapshots and stable view identity across equivalent guards', () => {
    fc.assert(
      fc.property(fc.record({value: fc.integer(), extra: fc.jsonValue()}), data => {
        const source: ManagerLiveSnapshot = {status: 'ready', data};
        const before = structuredClone(source);
        const project = createManagerLiveSnapshotProjection<Payload>();
        const first = project(source, isPayload);
        const second = project(source, (value): value is Payload => isPayload(value));
        expect(second).toBe(first);
        expect(first.data).toBe(data);
        const projectedData: Readonly<Record<string, unknown>> = first.data ?? {};
        expect(EffectRecord.keys(projectedData)).toEqual(EffectRecord.keys(data));
        expect(source).toEqual(before);
      }),
      {numRuns: 64},
    );
  });

  it('keeps distinct guards isolated and caches malformed payload errors without reflecting their fields', () => {
    const source: ManagerLiveSnapshot = {status: 'ready', data: {value: 'private malformed data'}};
    const project = createManagerLiveSnapshotProjection<Payload>();
    const first = project(source, isPayload);
    expect(first.status).toBe('error');
    expect(project(source, (value): value is Payload => isPayload(value))).toBe(first);
    expect(JSON.stringify(first)).not.toContain('private malformed data');
    expect(source).toEqual({status: 'ready', data: {value: 'private malformed data'}});
  });

  it('retains loading/error payload presence and source errors', () => {
    const project = createManagerLiveSnapshotProjection<Payload>();
    const failure = new Error('source request failed');
    const absent: ManagerLiveSnapshot = {status: 'loading'};
    const explicit: ManagerLiveSnapshot = {status: 'loading', data: undefined};
    expect(Object.getOwnPropertyDescriptor(project(absent, isPayload), 'data')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(project(explicit, isPayload), 'data')).toBeDefined();
    expect(project({status: 'error', error: failure}, isPayload)).toEqual({status: 'error', error: failure});
  });
});
