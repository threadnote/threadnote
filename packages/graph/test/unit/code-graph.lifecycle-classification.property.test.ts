import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_LIFECYCLE_PROTECTIONS,
  classifyCodeGraphLifecycle,
  planCodeGraphLifecycleReclamation,
  type CodeGraphLifecycleCandidate,
  type CodeGraphLifecycleProtection,
  type CodeGraphLifecycleState,
} from '@threadnote/graph/lifecycle/classification';
import {
  codeGraphLifecycleOpportunityUnits,
  selectCodeGraphLifecycleOpportunityTarget,
  selectCodeGraphLifecycleOpportunityUnit,
} from '@threadnote/graph/lifecycle/opportunity';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const reclaimableState = fc.constantFrom<CodeGraphLifecycleState>(
  'missing-view',
  'abandoned-build',
  'orphaned-sidecar',
  'retired-generation',
);
const protection = fc.constantFrom<CodeGraphLifecycleProtection>(...CODE_GRAPH_LIFECYCLE_PROTECTIONS);

describe('code graph lifecycle classification properties', () => {
  it('lets every active protection dominate otherwise valid destructive authority', () => {
    fc.assert(
      fc.property(reclaimableState, fc.uniqueArray(protection, {minLength: 1}), (state, protections) => {
        const classified = classifyCodeGraphLifecycle({authority: 'proven-disposable', protections, state});
        expect(classified).toMatchObject({action: 'preserve', disposition: 'preserve', reason: 'protected'});
        expect(classified.protections).toEqual([...protections].sort());
      }),
      {numRuns: 120},
    );
  });

  it('never converts unreadability, corruption, or a required clean base into automatic deletion', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CodeGraphLifecycleState>('unreadable-store', 'corrupt-store', 'required-clean-base'),
        fc.array(protection),
        (state, protections) => {
          expect(classifyCodeGraphLifecycle({authority: 'proven-disposable', protections, state}).disposition).not.toBe(
            'reclaim',
          );
        },
      ),
      {numRuns: 80},
    );
  });

  it('plans a bounded order-independent reclaim sequence that converges and is idempotent', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            authority: fc.constantFrom('proven-disposable' as const, 'unproven' as const),
            id: fc.string({maxLength: 24, minLength: 1}),
            protected: fc.boolean(),
            state: reclaimableState,
          }),
          {maxLength: 64, selector: value => value.id},
        ),
        values => {
          const candidates: readonly CodeGraphLifecycleCandidate[] = EffectArray.map(values, value => ({
            id: value.id,
            lifecycle: {
              authority: value.authority,
              protections: value.protected ? ['active-writer'] : [],
              state: value.state,
            },
          }));
          const expected = EffectArray.map(
            EffectArray.filter(
              candidates,
              candidate => classifyCodeGraphLifecycle(candidate.lifecycle).disposition === 'reclaim',
            ),
            candidate => candidate.id,
          ).sort();
          expect(
            EffectArray.map(planCodeGraphLifecycleReclamation([...candidates].reverse(), 64), value => value.id),
          ).toEqual(expected);

          let remaining = [...candidates];
          const reclaimed: string[] = [];
          for (let step = 0; step <= candidates.length; step += 1) {
            const page = planCodeGraphLifecycleReclamation(remaining, 1);
            if (page.length === 0) break;
            reclaimed.push(page[0].id);
            remaining = EffectArray.filter(remaining, candidate => candidate.id !== page[0].id);
          }
          expect(reclaimed).toEqual(expected);
          expect(planCodeGraphLifecycleReclamation(remaining, 1)).toEqual([]);
          expect(planCodeGraphLifecycleReclamation(remaining, 1)).toEqual([]);
        },
      ),
      {numRuns: 120},
    );
  });

  it('rotates lifecycle opportunities fairly regardless of catalog order', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3], {maxLength: 4, minLength: 4}), order => {
        const targets = EffectArray.map(order, index => ({
          checkoutId: Effect.pipe(index.toString(16), EffectString.repeat(64)),
          databasePath: `/database/${index}`,
        }));
        const visited: string[] = [];
        let cursor: string | undefined;
        for (let index = 0; index < targets.length; index += 1) {
          const selected = selectCodeGraphLifecycleOpportunityTarget(targets, cursor);
          if (!selected) throw TestError.make({message: 'valid lifecycle target was not selected'});
          visited.push(selected.checkoutId);
          cursor = `${selected.checkoutId}\0${selected.databasePath}`;
        }
        expect(visited).toEqual([
          Effect.pipe('0', EffectString.repeat(64)),
          Effect.pipe('1', EffectString.repeat(64)),
          Effect.pipe('2', EffectString.repeat(64)),
          Effect.pipe('3', EffectString.repeat(64)),
        ]);
        expect(selectCodeGraphLifecycleOpportunityTarget(targets, cursor)?.checkoutId).toBe(
          Effect.pipe('0', EffectString.repeat(64)),
        );
      }),
      {numRuns: 40},
    );
  });

  it('prioritizes cold pending reconciliation without breaking fair rotation', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3], {maxLength: 4, minLength: 4}), order => {
        const targets = EffectArray.map(order, index => ({
          ...(index % 2 === 1 ? {anchorPath: `/repository/${index}`} : {}),
          checkoutId: Effect.pipe(index.toString(16), EffectString.repeat(64)),
          databasePath: `/database/${index}`,
          reconciliationPending: index % 2 === 1,
        }));
        const visited: string[] = [];
        let cursor: string | undefined;
        for (let index = 0; index < targets.length; index += 1) {
          const selected = selectCodeGraphLifecycleOpportunityTarget(targets, cursor);
          if (!selected) throw TestError.make({message: 'valid lifecycle target was not selected'});
          visited.push(selected.checkoutId);
          cursor = `${selected.checkoutId}\0${selected.databasePath}`;
        }
        expect(visited[0]).toBe(Effect.pipe('1', EffectString.repeat(64)));
        expect(new Set(visited)).toEqual(new Set(EffectArray.map(targets, target => target.checkoutId)));
        const unanchored = EffectArray.map(targets, target => ({
          checkoutId: target.checkoutId,
          databasePath: target.databasePath,
          reconciliationPending: target.reconciliationPending,
        }));
        expect(selectCodeGraphLifecycleOpportunityTarget(unanchored)?.checkoutId).toBe(
          Effect.pipe('0', EffectString.repeat(64)),
        );
      }),
      {numRuns: 40},
    );
  });

  it('builds a bounded pending unit ring that visits every explicit lane exactly once', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3], {maxLength: 4, minLength: 4}), order => {
        const targets = EffectArray.map(order, index => ({
          ...(index === 1 || index === 3 ? {anchorPath: `/repository/${index}`} : {}),
          checkoutId: Effect.pipe(index.toString(16), EffectString.repeat(64)),
          databasePath: `/database/${index}`,
          reconciliationPending: index === 1 || index === 2,
        }));
        const units = codeGraphLifecycleOpportunityUnits(targets, 'status');
        const expected = [
          `reconciliation:${Effect.pipe('1', EffectString.repeat(64))}`,
          ...EffectArray.map(
            [0, 1, 2, 3],
            index => `ordinary:${Effect.pipe(index.toString(16), EffectString.repeat(64))}`,
          ),
          ...EffectArray.map(
            [0, 1, 2, 3],
            index => `residual:${Effect.pipe(index.toString(16), EffectString.repeat(64))}`,
          ),
        ];
        const visited: string[] = [];
        let cursor: string | undefined;
        for (let index = 0; index < units.length; index += 1) {
          const selected = selectCodeGraphLifecycleOpportunityUnit(units, cursor);
          if (!selected) throw TestError.make({message: 'valid lifecycle unit was not selected'});
          visited.push(`${selected.lane}:${selected.target.checkoutId}`);
          cursor = `${selected.lane}\0${selected.target.checkoutId}\0${selected.target.databasePath}`;
        }

        expect(visited).toEqual(expected);
        expect(new Set(visited).size).toBe(units.length);
        expect(selectCodeGraphLifecycleOpportunityUnit(units, cursor)).toEqual(units[0]);
      }),
      {numRuns: 40},
    );
  });
});
