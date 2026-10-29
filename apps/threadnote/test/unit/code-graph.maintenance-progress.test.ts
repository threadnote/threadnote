import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  observeCodeGraphMaintenanceStatus,
  withCodeGraphReportedMaintenanceIntent,
} from '@threadnote/graph/maintenance/gate';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('reported graph-maintenance progress', () => {
  effectIt.effect('publishes graph-maintenance status without a snapshot id', () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp('threadnote-graph-maintenance-status-')),
        directory => Effect.promise(() => rm(directory, {force: true, recursive: true})),
      );
      const observed = yield* withCodeGraphReportedMaintenanceIntent(
        home,
        {operation: 'graph-maintenance'},
        {completed: 1, phase: 'verifying-graph', total: 4},
        reporter =>
          reporter
            .progress({completed: 2, phase: 'retiring-and-cleaning', total: 4})
            .pipe(Effect.andThen(observeCodeGraphMaintenanceStatus(home))),
      );

      expect(observed).toMatchObject({
        completed: 2,
        operation: 'graph-maintenance',
        phase: 'retiring-and-cleaning',
        total: 4,
      });
      expect(observed?.snapshotId).toBeUndefined();
      expect(yield* observeCodeGraphMaintenanceStatus(home)).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('publishes a checkout-scoped graph-maintenance meter', () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp('threadnote-graph-maintenance-checkout-status-')),
        directory => Effect.promise(() => rm(directory, {force: true, recursive: true})),
      );
      const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
      const observed = yield* withCodeGraphReportedMaintenanceIntent(
        home,
        {checkoutId, operation: 'graph-maintenance'},
        {completed: 0, phase: 'acquiring-gates', total: 5},
        () => observeCodeGraphMaintenanceStatus(home),
      );

      expect(observed).toMatchObject({
        checkoutId,
        completed: 0,
        operation: 'graph-maintenance',
        phase: 'acquiring-gates',
        total: 5,
      });
      expect(observed?.snapshotId).toBeUndefined();
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});
