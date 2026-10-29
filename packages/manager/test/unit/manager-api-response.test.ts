import {describe, expect, it} from 'vitest';
import * as EffectRecord from 'effect/Record';
import * as EffectArray from 'effect/Array';
import * as fc from 'fast-check';
import {requireApiResponse, ManagerResponseContractError} from '../../src/api/response_guard.js';
import {isTicketResponse, isJobResponse} from '../../src/api/response_guards.js';

describe('Manager API response guards', () => {
  it('validates by reference without changing extra fields, insertion order, or nested JSON', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.tuple(fc.string(), fc.jsonValue()), {selector: ([key]) => key}), entries => {
        const response = EffectRecord.fromEntries([
          ['ticket', 'ticket'],
          ...EffectArray.filter(entries, ([key]) => key !== 'ticket'),
        ]);
        const originalKeys = EffectRecord.keys(response);
        const originalValues = EffectRecord.values(response);

        expect(requireApiResponse(response, isTicketResponse)).toBe(response);
        expect(EffectRecord.keys(response)).toEqual(originalKeys);
        expect(EffectRecord.values(response)).toEqual(originalValues);
      }),
      {numRuns: 64},
    );
  });

  it('rejects a payload that misses a required response field', () => {
    expect(() => requireApiResponse({job: {}}, isJobResponse)).toThrow(ManagerResponseContractError);
  });
});
