import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3,
  CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-contract';
import type {BenchmarkProcessTreeSample} from '../../../../scripts/code-graph-benchmark-sampler.js';
import {
  CONTEXT_BRIEF_CITATION_RSS_OBSERVER_MODE,
  CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS,
  applyContextBriefCitationRssRequest,
  contextBriefCitationRssArtifact,
  contextBriefCitationRssNextSampleDeadlineNanos,
  contextBriefCitationRssObserverArguments,
  isContextBriefCitationRssObserverMode,
  makeContextBriefCitationRssObserverState,
  observeContextBriefCitationRssSample,
  parseContextBriefCitationRssAcknowledgement,
  parseContextBriefCitationRssArtifact,
  parseContextBriefCitationRssReady,
  parseContextBriefCitationRssRequest,
  type ContextBriefCitationRssObserverState,
} from '../../../../scripts/context-brief-citation-rss-observer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('Context Brief citation RSS observer protocol', () => {
  it('round-trips acknowledged begin/end/stop barriers into bounded root and tree evidence', () => {
    const initial = state();
    const beginRequest = request('begin', 1, 'workset-128-memory-001');
    const begun = applyContextBriefCitationRssRequest(initial, beginRequest, attempt(100, sample(100, 100)));
    expect(begun.acknowledgement).toEqual({
      observationId: 'workset-128-memory-001',
      sequence: 1,
      state: 'begun',
      version: 2,
    });
    expect(
      applyContextBriefCitationRssRequest(begun.state, beginRequest, attempt(999, sample(999, 999))),
    ).toMatchObject({replayed: true, state: begun.state});

    const sampled = observeContextBriefCitationRssSample(begun.state, attempt(110, sample(125, 170, 2)));
    const failed = observeContextBriefCitationRssSample(sampled, {
      attempts: 1,
      failures: 1,
      observedAtMilliseconds: 115,
    });
    const ended = applyContextBriefCitationRssRequest(
      failed,
      request('end', 2, 'workset-128-memory-001'),
      attempt(120, sample(120, 150), 2, 1),
    );
    expect(() =>
      applyContextBriefCitationRssRequest(ended.state, {operation: 'stop', sequence: 3, version: 2}),
    ).toThrow(/barriers require a process-tree sample/u);
    const stopped = applyContextBriefCitationRssRequest(
      ended.state,
      {operation: 'stop', sequence: 3, version: 2},
      attempt(130, sample(110, 110)),
    );
    const artifact = contextBriefCitationRssArtifact(stopped.state);

    expect(artifact).toMatchObject({
      maximumSampleGapMilliseconds: 10,
      maximumConsecutiveSampleGapBreaches: 0,
      finalSample: {
        processCount: 1,
        rootRssBytes: 110,
        sampleAttempts: 1,
        sampleFailures: 0,
        treeRssBytes: 110,
      },
      observerExcluded: true,
      processCountPeakObserved: 2,
      rootIdentityValidation: 'linux-proc-starttime',
      rootStartIdentity: '4242',
      sampleGapBreachCount: 0,
      sampleGapBreachRate: 0,
      sampleGapPolicy: CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3,
      sampleAttempts: 6,
      sampleFailures: 2,
      scope: 'recursive-process-tree',
      samplingSchedule: CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE,
      source: 'linux-proc',
      successfulSamples: 4,
      version: 2,
    });
    expect(artifact.observations).toEqual([
      {
        durationMilliseconds: 20,
        maximumSampleGapMilliseconds: 10,
        observationId: 'workset-128-memory-001',
        processCountBaseline: 1,
        processCountPeakObserved: 2,
        rootRssBaselineBytes: 100,
        rootRssGrowthObservedBytes: 25,
        rootRssPeakObservedBytes: 125,
        sampleAttempts: 5,
        sampleFailures: 2,
        successfulSamples: 3,
        treeRssBaselineBytes: 100,
        treeRssGrowthObservedBytes: 70,
        treeRssPeakObservedBytes: 170,
      },
    ]);
    expect(parseContextBriefCitationRssArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
  });

  it('fails closed on sequence gaps, conflicting duplicates, cross-observation ends, and active stops', () => {
    const initial = state();
    expect(() =>
      applyContextBriefCitationRssRequest(
        initial,
        request('begin', 2, 'local-100k-memory-001'),
        attempt(1, sample(10, 10)),
      ),
    ).toThrow(/sequence is not contiguous/u);
    const begun = applyContextBriefCitationRssRequest(
      initial,
      request('begin', 1, 'local-100k-memory-001'),
      attempt(1, sample(10, 10)),
    );
    expect(() =>
      applyContextBriefCitationRssRequest(begun.state, request('begin', 1, 'local-100k-memory-002')),
    ).toThrow(/conflicting duplicate/u);
    expect(() =>
      applyContextBriefCitationRssRequest(
        begun.state,
        request('end', 2, 'local-100k-memory-002'),
        attempt(2, sample(10, 10)),
      ),
    ).toThrow(/does not match/u);
    expect(() =>
      applyContextBriefCitationRssRequest(begun.state, {operation: 'stop', sequence: 2, version: 2}),
    ).toThrow(/active observation/u);
    expect(() => observeContextBriefCitationRssSample(begun.state, attempt(0, sample(10, 10)))).toThrow(
      /time moved backwards/u,
    );
  });

  it('admits the complete 100-sample release schedule and rejects observation 301', () => {
    expect(CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS).toBe(300);
    let current = state();
    for (let index = 0; index < CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS; index += 1) {
      const observationId = `release-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}`;
      current = applyContextBriefCitationRssRequest(
        current,
        request('begin', index * 2 + 1, observationId),
        attempt(index * 2, sample(100, 100)),
      ).state;
      current = applyContextBriefCitationRssRequest(
        current,
        request('end', index * 2 + 2, observationId),
        attempt(index * 2 + 1, sample(100, 100)),
      ).state;
    }

    expect(current.observations).toHaveLength(300);
    expect(() =>
      applyContextBriefCitationRssRequest(
        current,
        request('begin', 601, 'release-overflow'),
        attempt(601, sample(100, 100)),
      ),
    ).toThrow(/observation bound exceeded/u);
    const stopped = applyContextBriefCitationRssRequest(
      current,
      {operation: 'stop', sequence: 601, version: 2},
      attempt(601, sample(100, 100)),
    );
    expect(contextBriefCitationRssArtifact(stopped.state).observations).toHaveLength(300);
  });

  it('rejects malformed or internally inconsistent wire evidence', () => {
    expect(() =>
      parseContextBriefCitationRssRequest({...request('begin', 1, 'local-100k-memory-001'), extra: 1}),
    ).toThrow(/fields are invalid/u);
    expect(() => parseContextBriefCitationRssAcknowledgement({sequence: 1, state: 'begun', version: 2})).toThrow(
      /fields are invalid/u,
    );
    expect(() => parseContextBriefCitationRssAcknowledgement({sequence: 602, state: 'stopped', version: 2})).toThrow(
      /protocol bound/u,
    );
    expect(() =>
      parseContextBriefCitationRssReady({
        intervalMilliseconds: 10,
        observerExcluded: true,
        rootIdentityValidation: 'darwin-ps-lstart',
        rootStartIdentity: '4242',
        samplingSchedule: CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE,
        scope: 'recursive-process-tree',
        source: 'linux-proc',
        state: 'ready',
        version: 2,
      }),
    ).toThrow(/do not match/u);

    const artifact = oneObservationArtifact();
    expect(() =>
      parseContextBriefCitationRssArtifact({...artifact, sampleAttempts: artifact.sampleAttempts + 1}),
    ).toThrow(/sampleAttempts is inconsistent/u);
    expect(() =>
      parseContextBriefCitationRssArtifact({
        ...artifact,
        observations: [{...artifact.observations[0], treeRssGrowthObservedBytes: 999}],
      }),
    ).toThrow(/growth is inconsistent/u);
    expect(() =>
      parseContextBriefCitationRssArtifact({
        ...artifact,
        finalSample: {...artifact.finalSample, rootRssBytes: artifact.finalSample.treeRssBytes + 1},
      }),
    ).toThrow(/final root RSS exceeds tree RSS/u);
    for (const inconsistent of [
      {...artifact, maximumConsecutiveSampleGapBreaches: artifact.maximumConsecutiveSampleGapBreaches + 1},
      {...artifact, maximumSampleGapMilliseconds: artifact.maximumSampleGapMilliseconds + 1},
      {...artifact, sampleGapBreachCount: artifact.sampleGapBreachCount + 1},
      {...artifact, sampleGapBreachRate: artifact.sampleGapBreachRate + 0.1},
    ]) {
      expect(() => parseContextBriefCitationRssArtifact(inconsistent)).toThrow(/is inconsistent/u);
    }
    expect(() =>
      parseContextBriefCitationRssArtifact({
        ...artifact,
        sampleGapPolicy: {...artifact.sampleGapPolicy, hardMaximumGapMilliseconds: 250},
      }),
    ).toThrow(/sample-gap policy is invalid/u);
  });

  it('keeps observed growth translation-invariant and equal to the independent maximum model', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 1_000_000_000, min: 1}),
        fc.integer({max: 1_000_000, min: 0}),
        fc.array(
          fc.record({
            childBytes: fc.integer({max: 8_000_000, min: 0}),
            rootGrowthBytes: fc.integer({max: 8_000_000, min: 0}),
          }),
          {maxLength: 20, minLength: 1},
        ),
        (translation, baseline, observations) => {
          const original = modeledArtifact(baseline, observations);
          const translated = modeledArtifact(baseline + translation, observations);
          const maximumRootGrowth = Math.max(0, ...EffectArray.map(observations, value => value.rootGrowthBytes));
          const maximumTreeGrowth = Math.max(
            0,
            ...EffectArray.map(observations, value => value.rootGrowthBytes + value.childBytes),
          );
          expect(original.observations[0]?.rootRssGrowthObservedBytes).toBe(maximumRootGrowth);
          expect(original.observations[0]?.treeRssGrowthObservedBytes).toBe(maximumTreeGrowth);
          expect(translated.observations[0]?.rootRssGrowthObservedBytes).toBe(maximumRootGrowth);
          expect(translated.observations[0]?.treeRssGrowthObservedBytes).toBe(maximumTreeGrowth);
          expect(translated.sampleAttempts).toBe(original.sampleAttempts);
          expect(translated.maximumSampleGapMilliseconds).toBe(original.maximumSampleGapMilliseconds);
        },
      ),
      {numRuns: 100},
    );
  });

  it('builds a reserved same-bundle observer invocation without serializing paths into evidence', () => {
    const args = contextBriefCitationRssObserverArguments({
      acknowledgementPath: '/tmp/private-ack',
      barrierTimeoutMilliseconds: 5_000,
      intervalMilliseconds: 10,
      outputPath: '/tmp/private-output',
      readyPath: '/tmp/private-ready',
      requestPath: '/tmp/private-request',
      rootProcessId: 42,
    });
    expect(args[0]).toBe(CONTEXT_BRIEF_CITATION_RSS_OBSERVER_MODE);
    expect(isContextBriefCitationRssObserverMode(args)).toBe(true);
    expect(isContextBriefCitationRssObserverMode(['--user-option'])).toBe(false);
    expect(JSON.stringify(oneObservationArtifact())).not.toContain('/tmp/private');
  });

  fcEffectProp(
    effectIt,
    'advances absolute monotonic deadlines without adding a fixed interval after slow samples',
    {
      elapsedIntervals: fc.integer({max: 10_000, min: 0}),
      intervalMilliseconds: fc.integer({max: 1_000, min: 10}),
      offsetNanos: fc.integer({max: 999_999, min: 0}),
      originNanos: fc.bigInt({max: 1_000_000_000_000n, min: 0n}),
    },
    ({elapsedIntervals, intervalMilliseconds, offsetNanos, originNanos}) =>
      Effect.sync(() => {
        const intervalNanos = BigInt(intervalMilliseconds) * 1_000_000n;
        const currentDeadline = originNanos + intervalNanos;
        const observedAt = currentDeadline + BigInt(elapsedIntervals) * intervalNanos + BigInt(offsetNanos);
        const next = contextBriefCitationRssNextSampleDeadlineNanos(currentDeadline, observedAt, intervalMilliseconds);

        expect(next).toBeGreaterThan(observedAt);
        expect(next - observedAt).toBeLessThanOrEqual(intervalNanos);
        expect((next - currentDeadline) % intervalNanos).toBe(0n);
      }),
    {fastCheck: {numRuns: 100}},
  );

  it('retains an upcoming absolute deadline and rejects unreviewed sampling intervals', () => {
    expect(contextBriefCitationRssNextSampleDeadlineNanos(20_000_000n, 19_999_999n, 10)).toBe(20_000_000n);
    expect(() => contextBriefCitationRssNextSampleDeadlineNanos(20_000_000n, 20_000_000n, 9)).toThrow(
      /interval is out of bounds/u,
    );
  });
});

function modeledArtifact(
  baseline: number,
  observations: readonly {readonly childBytes: number; readonly rootGrowthBytes: number}[],
) {
  let current = applyContextBriefCitationRssRequest(
    state(),
    request('begin', 1, 'local-100k-memory-001'),
    attempt(0, sample(baseline, baseline)),
  ).state;
  for (const [index, observation] of observations.entries()) {
    const root = baseline + observation.rootGrowthBytes;
    current = observeContextBriefCitationRssSample(
      current,
      attempt(index + 1, sample(root, root + observation.childBytes, observation.childBytes > 0 ? 2 : 1)),
    );
  }
  const endAt = observations.length + 1;
  current = applyContextBriefCitationRssRequest(
    current,
    request('end', 2, 'local-100k-memory-001'),
    attempt(endAt, sample(baseline, baseline)),
  ).state;
  current = applyContextBriefCitationRssRequest(
    current,
    {operation: 'stop', sequence: 3, version: 2},
    attempt(endAt + 1, sample(baseline, baseline)),
  ).state;
  return contextBriefCitationRssArtifact(current);
}

function oneObservationArtifact() {
  return modeledArtifact(100, [{childBytes: 50, rootGrowthBytes: 25}]);
}

function state(): ContextBriefCitationRssObserverState {
  return makeContextBriefCitationRssObserverState({
    intervalMilliseconds: 10,
    rootIdentityValidation: 'linux-proc-starttime',
    rootStartIdentity: '4242',
    source: 'linux-proc',
  });
}

function request(operation: 'begin' | 'end', sequence: number, observationId: string) {
  return {observationId, operation, sequence, version: 2 as const};
}

function attempt(observedAtMilliseconds: number, observed: BenchmarkProcessTreeSample, attempts = 1, failures = 0) {
  return {attempts, failures, observedAtMilliseconds, sample: observed};
}

function sample(rootRssBytes: number, rssBytes: number, processCount = 1): BenchmarkProcessTreeSample {
  const processIds = Array.from({length: processCount}, (_, index) => index + 10);
  return {
    processIds,
    processes: new Map(EffectArray.map(processIds, processId => [`${processId}:${processId}`, {cpuMilliseconds: 0}])),
    rootRssBytes,
    rootStartIdentity: '4242',
    rssBytes,
  };
}
