import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {installedRecallDiagnostic} from '../helpers/installed-recall-diagnostic.js';

const recall = (value: Record<string, unknown>): Record<string, unknown> => ({
  component: 'mcp',
  operation: 'recall_context',
  processId: 42,
  ...value,
});

describe('installed recall diagnostic', () => {
  it('attributes one matching completion after the observed boundary', () => {
    expect(
      installedRecallDiagnostic(
        [
          recall({event: 'invocation.finished', invocationId: 'invalid', outcome: 'failure'}),
          recall({event: 'invocation.started', invocationId: 'valid'}),
          recall({
            event: 'invocation.finished',
            invocationId: 'valid',
            outcome: 'failure',
            phaseTimings: [
              {phase: 'recall.workspace-context', outcome: 'success', durationMilliseconds: 12},
              {phase: 'not-safe', outcome: 'failure', durationMilliseconds: 99, query: 'private'},
              {
                phase: 'recall.lexical-ranking',
                outcome: 'timed-out',
                durationMilliseconds: 34,
                errorType: 'private',
              },
            ],
          }),
        ],
        42,
        'invalid',
      ),
    ).toEqual({
      outcome: 'failure',
      phaseTimings: [
        {phase: 'recall.workspace-context', outcome: 'success', durationMilliseconds: 12},
        {phase: 'recall.lexical-ranking', outcome: 'timed-out', durationMilliseconds: 34},
      ],
    });
  });

  it('rejects missing, duplicate, and ambiguous completions', () => {
    const prefix = [
      recall({event: 'invocation.finished', invocationId: 'invalid', outcome: 'failure'}),
      recall({event: 'invocation.started', invocationId: 'target'}),
    ];
    expect(installedRecallDiagnostic(prefix, 42, 'invalid')).toBeUndefined();
    expect(
      installedRecallDiagnostic(
        [
          ...prefix,
          recall({event: 'invocation.finished', invocationId: 'target', outcome: 'failure'}),
          recall({event: 'invocation.finished', invocationId: 'target', outcome: 'success'}),
        ],
        42,
        'invalid',
      ),
    ).toBeUndefined();
    expect(
      installedRecallDiagnostic(
        [
          recall({event: 'invocation.finished', invocationId: 'invalid', outcome: 'failure'}),
          recall({event: 'invocation.finished', invocationId: 'synthetic', outcome: 'failure'}),
          recall({event: 'invocation.started', invocationId: 'target'}),
        ],
        42,
        'invalid',
      ),
    ).toBeUndefined();
  });

  it('rejects multiple starts from the server after the boundary', () => {
    expect(
      installedRecallDiagnostic(
        [
          recall({event: 'invocation.finished', invocationId: 'invalid', outcome: 'failure'}),
          recall({event: 'invocation.started', invocationId: 'target'}),
          recall({event: 'invocation.finished', invocationId: 'target', outcome: 'failure'}),
          recall({event: 'invocation.started', invocationId: 'later'}),
        ],
        42,
        'invalid',
      ),
    ).toBeUndefined();
  });

  it('ignores foreign-process invocations and unknown data', () => {
    expect(
      installedRecallDiagnostic(
        [
          null,
          {unknown: 'private'},
          recall({event: 'invocation.finished', invocationId: 'invalid', outcome: 'failure'}),
          {...recall({event: 'invocation.started', invocationId: 'foreign'}), processId: 7},
          {...recall({event: 'invocation.finished', invocationId: 'foreign', outcome: 'failure'}), processId: 7},
          recall({event: 'invocation.started', invocationId: 'target'}),
          recall({event: 'invocation.finished', invocationId: 'target', outcome: 'success'}),
        ],
        42,
        'invalid',
      ),
    ).toEqual({outcome: 'success', phaseTimings: []});
  });

  it('keeps only 32 whitelisted phase timings', () => {
    const diagnostic = installedRecallDiagnostic(
      [
        recall({event: 'invocation.finished', invocationId: 'invalid', outcome: 'failure'}),
        recall({event: 'invocation.started', invocationId: 'target'}),
        recall({
          event: 'invocation.finished',
          invocationId: 'target',
          outcome: 'failure',
          phaseTimings: [
            {phase: 'unknown', outcome: 'failure', durationMilliseconds: 1, secret: 'private'},
            {phase: 'recall.shared-sync', outcome: 'unknown', durationMilliseconds: 2},
            ...EffectArray.makeBy(40, index => ({
              phase: 'recall.semantic-retrieval',
              outcome: 'unavailable',
              durationMilliseconds: index,
              unknown: 'private',
            })),
          ],
        }),
      ],
      42,
      'invalid',
    );

    expect(diagnostic?.phaseTimings).toHaveLength(32);
    expect(diagnostic?.phaseTimings[0]).toEqual({
      phase: 'recall.semantic-retrieval',
      outcome: 'unavailable',
      durationMilliseconds: 0,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
  });
});
