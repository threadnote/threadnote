import {expect, it} from '@effect/vitest';
import * as fc from 'fast-check';
import {fixturePipelineReceiptProvesExit} from '../../src/fixture-pipeline-receipt.js';

it('requires the expected token and a complete observed exit', () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (expected, actual) => {
      const receipt = JSON.stringify({version: 1, token: actual, code: 0, signal: null});
      expect(fixturePipelineReceiptProvesExit(receipt, expected)).toBe(actual === expected);
    }),
    {numRuns: 50},
  );
  for (const value of ['', '{}', '{', JSON.stringify({version: 1, token: 'x', code: null, signal: null})]) {
    expect(fixturePipelineReceiptProvesExit(value, 'x')).toBe(false);
  }
});
