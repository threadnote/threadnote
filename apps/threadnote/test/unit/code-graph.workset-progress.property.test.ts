import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphWorksetPrepareCoverage,
  type CodeGraphWorksetPrepareMemberV1,
  type CodeGraphWorksetPrepareProgressV1,
} from '@threadnote/graph/workset_catalog/workset';
import {
  CODE_GRAPH_WORKSET_JSON_PROGRESS_INTERVAL_MILLISECONDS,
  codeGraphWorksetJsonProgressDecision,
} from '@threadnote/graph/workset/progress';
import {codeGraphWorksetTelemetryFields} from '@threadnote/threadnote/code_graph/workset/telemetry';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('code graph workset progress properties', () => {
  it('partitions every member receipt exactly and marks only all-ready coverage complete', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('excluded', 'failed', 'missing', 'ready'), {maxLength: 128}), states => {
        const members = EffectArray.map(states, (state, index) => member(state, index));
        const coverage = codeGraphWorksetPrepareCoverage(members);
        expect(coverage.ready + coverage.failed + coverage.missing + coverage.excluded).toBe(members.length);
        expect(coverage.requested).toBe(members.length);
        expect(coverage.complete).toBe(EffectArray.every(states, state => state === 'ready'));
      }),
    );
  });

  it('coalesces identical non-terminal JSON updates inside the interval', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 4_096}), fc.integer({min: 0, max: 1_000_000}), (completed, now) => {
        const progress = progressEvent(completed);
        const first = codeGraphWorksetJsonProgressDecision({completed: 0}, progress, now);
        const repeated = codeGraphWorksetJsonProgressDecision(
          first.state,
          progress,
          now + CODE_GRAPH_WORKSET_JSON_PROGRESS_INTERVAL_MILLISECONDS - 1,
        );
        expect(first.emit).toBe(true);
        expect(repeated.emit).toBe(false);
      }),
    );
  });

  it('never regresses the coalescer completed-member high-water mark', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: 0, max: 4_096}), {maxLength: 256}), samples => {
        const final = EffectArray.reduce(
          samples,
          {completed: 0},
          (state, completed, index) =>
            codeGraphWorksetJsonProgressDecision(state, progressEvent(completed), index).state,
        );
        expect(final.completed).toBe(Math.max(0, ...samples));
      }),
    );
  });

  it('projects workset progress into path-free anonymous telemetry fields', () => {
    expect(codeGraphWorksetTelemetryFields(progressEvent(3))).toEqual({
      phase: 'graph.registering',
      workUnitsCompleted: 3,
      workUnitsTotal: 8,
    });
  });
});

function member(state: 'excluded' | 'failed' | 'missing' | 'ready', index: number): CodeGraphWorksetPrepareMemberV1 {
  const project = `project-${index}`;
  switch (state) {
    case 'ready':
      return {
        project,
        projectionDigest: Effect.pipe('a', EffectString.repeat(64)),
        repositoryId: Effect.pipe('b', EffectString.repeat(64)),
        snapshotId: `cgsn_${Effect.pipe('c', EffectString.repeat(40))}-direct`,
        state,
        symbolCount: index,
      };
    case 'failed':
      return {
        detail: {
          code: 'unknown',
          errorType: 'UnknownError',
          retryable: false,
          summary: 'Repository indexing failed; run graph diagnostics for this project and retry.',
        },
        project,
        reason: 'index-failed',
        state,
      };
    case 'missing':
      return {project, reason: 'missing-path', state};
    case 'excluded':
      return {project, reason: 'unknown-project', state};
  }
}

function progressEvent(completed: number): CodeGraphWorksetPrepareProgressV1 {
  return {
    completed,
    elapsedMilliseconds: completed * 10,
    message: 'fixture',
    phase: 'indexing',
    project: 'fixture',
    total: 8,
    type: 'code-graph-workset-progress',
    version: 1,
    workset: 'engineering',
  };
}
