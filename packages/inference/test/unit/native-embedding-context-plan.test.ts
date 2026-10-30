import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  nativeEmbeddingContextPlan,
  parseEmbeddingContextPoolSize,
  type EmbeddingContextPoolSize,
} from '../../src/engine/node-llama-cpp.js';

describe('native embedding context planning', () => {
  it('keeps requested capacities serial by default and limited to 1, 2, 4, or 8', () => {
    expect(parseEmbeddingContextPoolSize(undefined)).toBe(1);
    expect(parseEmbeddingContextPoolSize('')).toBe(1);
    expect(parseEmbeddingContextPoolSize(' 4 ')).toBe(4);
    for (const invalid of ['0', '3', '16', 'four']) {
      expect(() => parseEmbeddingContextPoolSize(invalid)).toThrow(/1, 2, 4, or 8/);
    }
  });

  it('uses three single-thread CPU contexts within a requested cap of four or eight', () => {
    for (const requestedContexts of [4, 8] as const) {
      expect(nativeEmbeddingContextPlan({cpuMathCores: 3, modelGpuLayers: 0, requestedContexts})).toEqual({
        contexts: 3,
        threadCounts: [1, 1, 1],
      });
    }
  });

  it('retains explicit caps, other core partitions, and serial GPU or unknown offload', () => {
    expect(nativeEmbeddingContextPlan({cpuMathCores: 3, modelGpuLayers: 0, requestedContexts: 2})).toEqual({
      contexts: 2,
      threadCounts: [2, 1],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 6, modelGpuLayers: 0, requestedContexts: 8})).toEqual({
      contexts: 4,
      threadCounts: [2, 2, 1, 1],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 8, modelGpuLayers: 0, requestedContexts: 4})).toEqual({
      contexts: 4,
      threadCounts: [2, 2, 2, 2],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 8, modelGpuLayers: 0, requestedContexts: 2})).toEqual({
      contexts: 2,
      threadCounts: [4, 4],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 8, modelGpuLayers: 0, requestedContexts: 8})).toEqual({
      contexts: 8,
      threadCounts: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 5, modelGpuLayers: 0, requestedContexts: 8})).toEqual({
      contexts: 4,
      threadCounts: [2, 1, 1, 1],
    });
    expect(nativeEmbeddingContextPlan({cpuMathCores: 7, modelGpuLayers: 0, requestedContexts: 8})).toEqual({
      contexts: 4,
      threadCounts: [2, 2, 2, 1],
    });
    for (const modelGpuLayers of [0, 1, undefined]) {
      expect(nativeEmbeddingContextPlan({cpuMathCores: 3, modelGpuLayers, requestedContexts: 1})).toEqual({
        contexts: 1,
        threadCounts: [undefined],
      });
    }
    for (const modelGpuLayers of [1, undefined]) {
      expect(nativeEmbeddingContextPlan({cpuMathCores: 3, modelGpuLayers, requestedContexts: 8})).toEqual({
        contexts: 1,
        threadCounts: [undefined],
      });
    }
  });

  it('conserves explicit CPU threads, bounds contexts, and balances allocations', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 128}),
        fc.constantFrom<EmbeddingContextPoolSize>(1, 2, 4, 8),
        (cpuMathCores, requestedContexts) => {
          const input = Object.freeze({cpuMathCores, modelGpuLayers: 0, requestedContexts});
          const plan = nativeEmbeddingContextPlan(input);
          expect(nativeEmbeddingContextPlan(input)).toEqual(plan);
          expect(plan.contexts).toBeGreaterThanOrEqual(1);
          expect(plan.contexts).toBeLessThanOrEqual(Math.min(cpuMathCores, requestedContexts));
          if (cpuMathCores >= requestedContexts) expect(plan.contexts).toBe(requestedContexts);
          expect(plan.threadCounts).toHaveLength(plan.contexts);
          if (requestedContexts === 1) {
            expect(plan.threadCounts).toEqual([undefined]);
          } else {
            const threads = EffectArray.filter(plan.threadCounts, (count): count is number => count !== undefined);
            expect(threads).toHaveLength(plan.contexts);
            expect(EffectArray.every(threads, count => Number.isSafeInteger(count) && count > 0)).toBe(true);
            expect(EffectArray.reduce(threads, 0, (sum, count) => sum + count)).toBe(cpuMathCores);
            expect(Math.max(...threads) - Math.min(...threads)).toBeLessThanOrEqual(1);
          }
          if (![1, 2, 4, 8].includes(plan.contexts)) {
            expect(cpuMathCores).toBe(3);
            expect(plan).toEqual({contexts: 3, threadCounts: [1, 1, 1]});
          }
        },
      ),
      {numRuns: 80},
    );
  });

  it('never reduces admitted context count when CPU capacity or the requested cap increases', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 128}),
        fc.integer({min: 1, max: 128}),
        fc.constantFrom<EmbeddingContextPoolSize>(1, 2, 4, 8),
        fc.constantFrom<EmbeddingContextPoolSize>(1, 2, 4, 8),
        (firstCores, secondCores, firstCap, secondCap) => {
          const cores = Math.min(firstCores, secondCores);
          const cap = firstCap <= secondCap ? firstCap : secondCap;
          const before = nativeEmbeddingContextPlan({
            cpuMathCores: cores,
            modelGpuLayers: 0,
            requestedContexts: cap,
          });
          expect(
            nativeEmbeddingContextPlan({
              cpuMathCores: Math.max(firstCores, secondCores),
              modelGpuLayers: 0,
              requestedContexts: cap,
            }).contexts,
          ).toBeGreaterThanOrEqual(before.contexts);
          expect(
            nativeEmbeddingContextPlan({
              cpuMathCores: cores,
              modelGpuLayers: 0,
              requestedContexts: firstCap >= secondCap ? firstCap : secondCap,
            }).contexts,
          ).toBeGreaterThanOrEqual(before.contexts);
        },
      ),
      {numRuns: 80},
    );
  });
});
