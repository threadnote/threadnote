import {describe, expect, it} from 'vitest';
import * as EffectRecord from 'effect/Record';
import * as EffectArray from 'effect/Array';
import * as fc from 'fast-check';
import {requireApiResponse, ManagerResponseContractError} from '../../src/api/response_guard.js';
import {isGraphDiagramResult, isTicketResponse, isJobResponse} from '../../src/api/response_guards.js';

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

  it('validates diagram scopes and outcome-specific fields', () => {
    const scope = {repositoryId: 'repo', repositoryName: 'Repo', snapshotId: 'snapshot', viewKey: 'view'};
    const response = {
      scope,
      status: 'diagram',
      diagramType: 'flowchart',
      source: 'flowchart LR\n  A --> B',
      inferred: false,
      evidence: {nodes: [], edges: [], groups: []},
      freshness: 'unknown',
      limits: [],
    };
    expect(requireApiResponse(response, isGraphDiagramResult)).toBe(response);
    expect(isGraphDiagramResult({...response, source: null})).toBe(false);
    expect(isGraphDiagramResult({...response, scope: {...scope, snapshotId: 1}})).toBe(false);
    expect(isGraphDiagramResult({...response, status: 'unavailable', message: 'Missing evidence'})).toBe(false);
    const incomplete = {
      scope,
      status: 'incomplete',
      freshness: 'unknown',
      limits: [],
      message: 'Read interrupted.',
      nextAction: 'Retry the question.',
      coverage: {completeness: 'incomplete', boundaries: [], gaps: [{kind: 'interrupted', label: 'Read stopped'}]},
    };
    expect(requireApiResponse(incomplete, isGraphDiagramResult)).toBe(incomplete);
    expect(isGraphDiagramResult({...incomplete, coverage: undefined})).toBe(false);
  });

  it('rejects a payload that misses a required response field', () => {
    expect(() => requireApiResponse({job: {}}, isJobResponse)).toThrow(ManagerResponseContractError);
  });
});
