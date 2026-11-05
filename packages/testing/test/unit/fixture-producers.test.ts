import {expect, it} from '@effect/vitest';
import * as fc from 'fast-check';
import {FixtureProducers} from '../../src/fixture-producers.js';

it('requires spawn, exit and close on the registered child and reports code and signal', () => {
  fc.assert(
    fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (spawned, exited, closed, failed) => {
      const registry = new FixtureProducers();
      const child = registry.register();
      if (spawned) child.spawned();
      if (exited) child.exited(7, null);
      if (closed) child.closed();
      if (failed) child.failed();
      expect(registry.seal()).toEqual(
        spawned && exited && closed && !failed ? [{state: 'exited', code: 7, signal: null}] : [{state: 'unknown'}],
      );
      expect(() => registry.register()).toThrow();
    }),
    {numRuns: 50},
  );
});

it('does not mistake a launch failure or a missing exit event for exit proof', () => {
  const registry = new FixtureProducers();
  const failedLaunch = registry.register();
  failedLaunch.failed();
  failedLaunch.closed();
  const incomplete = registry.register();
  incomplete.spawned();
  incomplete.closed();
  expect(registry.seal()).toEqual([{state: 'unknown'}, {state: 'unknown'}]);
});

it('keeps a sealed registry unknown until the original child has actually closed', () => {
  const registry = new FixtureProducers();
  const child = registry.register();
  child.spawned();
  child.exited(null, 'SIGTERM');
  expect(registry.seal()).toEqual([{state: 'unknown'}]);
  child.closed();
  expect(registry.seal()).toEqual([{state: 'exited', code: null, signal: 'SIGTERM'}]);
});
