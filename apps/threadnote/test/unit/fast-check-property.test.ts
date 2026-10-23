import {beforeEach, expect, it as effectIt, type TestContext} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';

fcProp(
  effectIt,
  'preserves tuple input shape for pure Fast-check properties',
  [FC.integer({min: 0, max: 10}), FC.constantFrom('a', 'b')] as const,
  ([count, label]) => {
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(10);
    expect(['a', 'b']).toContain(label);
  },
  {fastCheck: {numRuns: 20}},
);

fcEffectProp(
  effectIt,
  'preserves record input shape inside the Effect property runner',
  {count: FC.integer({min: 0, max: 10}), label: FC.constantFrom('a', 'b')},
  ({count, label}) =>
    Effect.sync(() => {
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(10);
      expect(['a', 'b']).toContain(label);
    }),
  {fastCheck: {numRuns: 20}},
);

const contextCase = 'forwards the existing native test context across Effect property evaluations';
let registeredContext: TestContext | undefined;
let contextEvaluations = 0;
beforeEach(context => {
  if (context.task.name === contextCase) {
    registeredContext = context;
    contextEvaluations = 0;
  }
});
fcEffectProp(
  effectIt,
  contextCase,
  {value: FC.constant('shape-preserved')},
  ({value}, context) =>
    Effect.sync(() => {
      expect(value).toBe('shape-preserved');
      expect(context).toBe(registeredContext);
      expect(context.signal.aborted).toBe(false);
      if (contextEvaluations++ === 0)
        context.onTestFinished(() => {
          expect(contextEvaluations).toBe(6);
        });
    }),
  {fastCheck: {numRuns: 6, seed: 73}},
);
