import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  diagnoseTopicStudySourceCoverageV1,
  projectTopicStudyPreflightAblationsV1,
  selectTopicStudyCurrentCaseV1,
} from '../../../../scripts/topic-maintenance-longitudinal-native-adapter.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const declared = {
  hash: 'source-hash',
  clean: true,
  indexFresh: true,
  files: [
    {path: 'health.ts', availability: 'present', content: 'export const title = "Context Health";'},
    {path: 'config.ts', availability: 'present', content: 'export const timeoutSeconds = 95;'},
  ],
};

const publicProjection = (refs: readonly {path: string; selection: string; sources: readonly object[]}[]) =>
  JSON.stringify({
    method: 'topic-plus-common-source-state-review-v2',
    scopeFreshness: 'fresh',
    evidenceState: 'partial',
    publicSourceOmissions: 1,
    publicOutputTruncated: false,
    refs,
  });

describe('longitudinal source evidence diagnostics', () => {
  it('distinguishes declared presence from public inclusion, omission and excerpt truncation', () => {
    const coverage = diagnoseTopicStudySourceCoverageV1(
      publicProjection([
        {path: 'health.ts', selection: 'included', sources: [{content: 'excerpt', truncated: true}]},
        {path: 'config.ts', selection: 'not-returned-by-public-brief', sources: []},
      ]),
      declared,
    );
    expect(coverage.refs).toEqual([
      expect.objectContaining({path: 'health.ts', declared: 'present', public: 'truncated'}),
      expect.objectContaining({path: 'config.ts', declared: 'present', public: 'omitted'}),
    ]);
    expect(coverage.counts).toEqual({included: 0, omitted: 1, truncated: 1, unknown: 0});
    expect(coverage.evidenceState).toBe('partial');
    expect(JSON.stringify(coverage)).not.toContain('export const');
  });

  it('counts actual partial-brief source bytes while keeping freshness separate', () => {
    const projection = publicProjection([
      {path: 'health.ts', selection: 'included', sources: [{content: 'public excerpt', truncated: false}]},
      {path: 'config.ts', selection: 'not-returned-by-public-brief', sources: []},
    ]);
    const coverage = diagnoseTopicStudySourceCoverageV1(projection, declared);
    expect(EffectArray.map(coverage.refs, ref => ref.public)).toEqual(['included', 'omitted']);
    expect(coverage.counts).toEqual({included: 1, omitted: 1, truncated: 0, unknown: 0});
    expect(coverage.scopeFreshness).toBe('fresh');
    expect(coverage.evidenceState).toBe('partial');
    expect(coverage.fullDeclaredSourceEligible).toBe(true);

    const staleProjection = {...JSON.parse(projection), scopeFreshness: 'stale'};
    const stale = diagnoseTopicStudySourceCoverageV1(JSON.stringify(staleProjection), declared);
    expect(EffectArray.map(stale.refs, ref => ref.public)).toEqual(['included', 'omitted']);
    expect(stale.scopeFreshness).toBe('stale');
    expect(stale.evidenceState).toBe('partial');
    expect(stale.fullDeclaredSourceEligible).toBe(false);
  });

  it('reports unavailable public evidence as unknown and keeps each preflight ablation labeled', () => {
    const coverage = diagnoseTopicStudySourceCoverageV1(null, declared);
    expect(coverage.counts.unknown).toBe(2);
    expect(coverage.publicRetrievalAvailable).toBe(false);
    expect(coverage.evidenceState).toBe('unavailable');
    expect(coverage.scopeFreshness).toBe('unknown');
    expect(coverage.fullDeclaredSourceEligible).toBe(false);
    const ablations = projectTopicStudyPreflightAblationsV1('The accepted topic.', declared, 'fresh');
    expect(ablations.fullDeclaredSource.method).toBe('topic-plus-full-declared-source-preflight-v1');
    expect(ablations.fullDeclaredSource.answerInput).toContain('export const timeoutSeconds = 95;');
    expect(ablations.fullDeclaredSource.answerInput).toContain('Full declared source');
    expect(ablations.memoryOnly.method).toBe('topic-memory-only-preflight-v1');
    expect(ablations.memoryOnly.answerInput).toContain('The accepted topic.');
    expect(ablations.memoryOnly.answerInput).not.toContain('export const');
  });

  it('marks a partly omitted public excerpt as truncated coverage', () => {
    const coverage = diagnoseTopicStudySourceCoverageV1(
      publicProjection([
        {path: 'health.ts', selection: 'included-with-projection-omission', sources: [{truncated: false}]},
        {path: 'config.ts', selection: 'included', sources: [{truncated: false}]},
      ]),
      declared,
    );
    expect(EffectArray.map(coverage.refs, ref => ref.public)).toEqual(['truncated', 'included']);
  });

  it('does not offer full-source input when declared sources are ineligible', () => {
    const ablations = projectTopicStudyPreflightAblationsV1('topic', {...declared, clean: false}, 'fresh');
    expect(ablations.fullDeclaredSource.answerInput).toBeNull();
    expect(ablations.fullDeclaredSource.reason).toBe('declared-source-ineligible');
    expect(ablations.memoryOnly.answerInput).toContain('topic');
    expect(projectTopicStudyPreflightAblationsV1('topic', declared, 'stale').fullDeclaredSource.answerInput).toBeNull();
    expect(
      projectTopicStudyPreflightAblationsV1(
        'topic',
        {
          ...declared,
          files: [{...declared.files[0], content: Effect.pipe('é', EffectString.repeat(5000))}, declared.files[1]],
        },
        'fresh',
      ).fullDeclaredSource.answerInput,
    ).toBeNull();
  });

  it('is invariant to public and declared source order', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (reversePublic, reverseDeclared) => {
        const refs = [
          {path: 'health.ts', selection: 'included', sources: [{content: 'excerpt', truncated: false}]},
          {path: 'config.ts', selection: 'not-returned-by-public-brief', sources: []},
        ];
        const first = diagnoseTopicStudySourceCoverageV1(publicProjection(refs), declared);
        const second = diagnoseTopicStudySourceCoverageV1(
          publicProjection(reversePublic ? [...refs].reverse() : refs),
          {...declared, files: reverseDeclared ? [...declared.files].reverse() : declared.files},
        );
        expect(second).toEqual(first);
      }),
      {numRuns: 20},
    );
  });
});

describe('current-event topic observer', () => {
  const now = Date.parse('2026-10-17T10:00:00.000Z');
  const currentCase = {
    family: 'topic-maintenance',
    memoryId: 'target',
    disposition: 'deferred-policy',
    reason: 'topic-review-rejected',
    lastChecked: '2026-10-17T10:00:01.000Z',
  };

  it.each(['topic-review-rejected', 'topic-review-deferred'])(
    'accepts current suppressed observation with reason %s',
    reason => {
      const result = selectTopicStudyCurrentCaseV1(
        {state: 'running', paused: false, cases: [{...currentCase, reason}]},
        'target',
        now,
      );
      expect(result.caseRecord).toMatchObject({disposition: 'deferred-policy', reason});
    },
  );

  it('rejects stale suppressed cases even when every retry returns the same case', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 60_000}), delay => {
        const result = selectTopicStudyCurrentCaseV1(
          {
            state: 'idle',
            paused: false,
            cases: [{...currentCase, lastChecked: new Date(now - delay).toISOString()}],
          },
          'target',
          now,
        );
        expect(result.caseRecord).toBeNull();
        expect(result.reason).toBe('stale-last-checked');
      }),
      {numRuns: 20},
    );
  });

  it('rejects an unrecognized suppressed disposition reason', () => {
    const result = selectTopicStudyCurrentCaseV1(
      {state: 'idle', paused: false, cases: [{...currentCase, reason: 'unknown'}]},
      'target',
      now,
    );
    expect(result.caseRecord).toBeNull();
    expect(result.reason).toBe('invalid-suppression-reason');
  });
});
