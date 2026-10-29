import {describe, expect, it} from '@effect/vitest';
import * as fc from 'fast-check';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {
  CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS,
  decodeCodeGraphIsolatedQueryTelemetry,
} from '@threadnote/graph/isolated/impact_query';

const observation = {
  durationMilliseconds: 1,
  outcome: 'success',
  phase: 'graph.query.execute',
  stage: 'query-serialization',
} as const;

describe('isolated query telemetry boundary', () => {
  fcProp(
    it,
    'round trips bounded telemetry without changing the input',
    {
      observations: fc.array(
        fc.record({
          durationMilliseconds: fc.integer({min: 0, max: CODE_GRAPH_ISOLATED_QUERY_TIMEOUT_MILLISECONDS}),
          outcome: fc.constantFrom('failure', 'interrupted', 'success'),
          phase: fc.constantFrom('graph.query.execute', 'graph.query.snapshot', 'graph.query.status'),
          stage: fc.constantFrom(
            'query-repository-identity',
            'query-serialization',
            'query-strict-reobservation',
            'query-worktree-observation',
          ),
        }),
        {maxLength: 8},
      ),
    },
    ({observations}) => {
      const original = structuredClone(observations);
      expect(decodeCodeGraphIsolatedQueryTelemetry(observations)).toEqual(original);
      expect(observations).toEqual(original);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('rejects objects that only coerce to a valid telemetry enum', () => {
    for (const key of ['outcome', 'phase', 'stage'] as const) {
      const coercible = {toString: () => observation[key]};
      expect(decodeCodeGraphIsolatedQueryTelemetry([{...observation, [key]: coercible}])).toBeUndefined();
    }
  });
});
