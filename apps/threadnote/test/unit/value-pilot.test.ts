import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {aggregateValueReportV1} from '@threadnote/threadnote/value_report/index';
import {buildValueReportExportV1} from '@threadnote/threadnote/value_report/export';
import {buildPilotReport, parsePilotReport, serializePilotReport} from '@threadnote/threadnote/value_report/pilot';
import {parsePilotInput, type PilotInput} from '@threadnote/threadnote/value_report/pilot/contract';
import {pilotInput} from '../helpers/value-pilot-fixture.js';

function pilotSource(windowStart: string, elapsedDays: number, actor: number) {
  const start = new Date(`${windowStart}T00:00:00.000Z`);
  const end = new Date(start.getTime() + elapsedDays * 86_400_000);
  return buildValueReportExportV1(
    aggregateValueReportV1({
      period: {from: start.toISOString(), to: end.toISOString()},
      counts: {
        contextBrief: {attempts: actor + 1, successful: actor + 1},
        knowledgeDelta: {approved: actor},
      },
    }),
  );
}

function reorder<T>(values: readonly T[], order: readonly number[]): T[] {
  return EffectArray.map(order, index => values[index]);
}

describe('offline content-free pilot report', () => {
  it('keeps unobserved results missing, even when legacy counters are positive', () => {
    const input = pilotInput();
    const report = buildPilotReport({
      ...input,
      sources: [
        {
          actor: 0,
          value: buildValueReportExportV1(
            aggregateValueReportV1({
              period: {from: '2026-08-03T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z'},
              counts: {contextBrief: {attempts: 3, successful: 3}, setup: {completed: 1}},
            }),
          ),
        },
      ],
    });
    expect(report.metrics.firstSourceVerifiedBrief.state).toBe('missing');
    expect(report.metrics.falseCurrentRate.rate).toBeNull();
    expect(report.metrics.setupCompletion.state).toBe('missing');
    expect(report.supportingValue.successfulBriefs).toBe('3-4');
    expect(report.pilotSuccess).toBe('not-assessed');
  });

  it('distinguishes observed zero, pending, failure and inapplicability', () => {
    const report = buildPilotReport({
      ...pilotInput(),
      observations: [
        {actor: 0, sample: 0, metric: 'falseCurrentRate', state: 'observed', value: 0},
        {actor: 1, sample: 0, metric: 'setupCompletion', state: 'pending'},
        {actor: 2, sample: 0, metric: 'setupCompletion', state: 'failed'},
        {actor: 0, sample: 0, metric: 'setupMilliseconds', state: 'inapplicable'},
      ],
    });
    expect(report.metrics.falseCurrentRate.state).toBe('mixed');
    expect(report.metrics.falseCurrentRate.positive).toBe('0');
    expect(report.metrics.falseCurrentRate.rate).toBe('suppressed');
    expect(report.metrics.setupCompletion.pending).toBe('1-2');
    expect(report.metrics.setupCompletion.failed).toBe('1-2');
    expect(report.metrics.setupMilliseconds.inapplicable).toBe('1-2');
  });

  it('derives cross-actor reuse only from ordered, source-verified evidence', () => {
    const evidence: PilotInput['evidence'] = [
      {actor: 0, item: 0, minute: 0, kind: 'verified-brief'},
      {actor: 0, item: 0, minute: 1, kind: 'approved-delta'},
      {actor: 1, item: 0, minute: 10_080, kind: 'verified-reuse'},
    ];
    const report = buildPilotReport({...pilotInput(), evidence});
    expect(report.metrics.secondActorReuseWithinSevenDays.positive).toBe('1-2');
    expect(report.metrics.approvedDeltaReuse.positive).toBe('1-2');
    expect(
      buildPilotReport({...pilotInput(), evidence: EffectArray.map(evidence, e => ({...e, actor: 0}))}).metrics
        .secondActorReuseWithinSevenDays.positive,
    ).toBe('0');
    expect(
      buildPilotReport({
        ...pilotInput(),
        evidence: EffectArray.map(evidence, e => (e.kind === 'verified-reuse' ? {...e, minute: 10_081} : e)),
      }).metrics.secondActorReuseWithinSevenDays.positive,
    ).toBe('0');
  });

  it('leaves incomplete seven-day and weekly opportunities pending', () => {
    const report = buildPilotReport({
      ...pilotInput(),
      elapsedDays: 2,
      evidence: [{actor: 0, item: 0, minute: 1, kind: 'verified-brief'}],
    });
    expect(report.metrics.secondActorReuseWithinSevenDays.pending).toBe('1-2');
    expect(EffectArray.map(report.weeks, week => week.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('keeps the seven-day reuse opportunity pending at its exclusive deadline', () => {
    const report = buildPilotReport({
      ...pilotInput(),
      elapsedDays: 8,
      evidenceCoverage: 'complete',
      evidence: [{actor: 0, item: 0, minute: 1_440, kind: 'verified-brief'}],
    });
    expect(report.metrics.secondActorReuseWithinSevenDays.pending).toBe('1-2');
    expect(report.metrics.secondActorReuseWithinSevenDays.observed).toBe('0');
  });

  it('suppresses unavailable cross-actor loop absence evidence', () => {
    const evidence: PilotInput['evidence'] = [
      {actor: 0, item: 0, minute: 0, kind: 'verified-brief'},
      {actor: 0, item: 0, minute: 1, kind: 'approved-delta'},
      {actor: 0, item: 0, minute: 2, kind: 'full-loop'},
    ];
    const report = buildPilotReport({
      ...pilotInput(),
      evidence,
    });
    expect(report.weeks[0]).toMatchObject({
      state: 'missing',
      fullLoopActors: '1-2',
      crossActorFullLoopActors: null,
    });
    expect(
      buildPilotReport({...pilotInput(), evidenceCoverage: 'complete', evidence}).weeks[0].crossActorFullLoopActors,
    ).toBe('0');
    expect(
      buildPilotReport({...pilotInput(), evidenceCoverage: 'unavailable'}).weeks[0].crossActorFullLoopActors,
    ).toBeNull();
  });

  it('requires all loop stages and retains only actors completing cross-actor loops in all four weeks', () => {
    const evidence: PilotInput['evidence'][number][] = [];
    for (let week = 0; week < 4; week += 1) {
      for (let actor = 0; actor < 3; actor += 1) {
        const item = week * 3 + actor;
        const minute = week * 10_080;
        evidence.push(
          {actor: (actor + 1) % 3, item, minute, kind: 'verified-brief'},
          {actor, item, minute: minute + 1, kind: 'verified-reuse'},
          {actor, item, minute: minute + 2, kind: 'approved-delta'},
          {actor, item, minute: minute + 3, kind: 'full-loop'},
        );
      }
    }
    const report = buildPilotReport({...pilotInput(), evidence, evidenceCoverage: 'complete'});
    expect(EffectArray.map(report.weeks, week => week.crossActorFullLoopActors)).toEqual(['3-4', '3-4', '3-4', '3-4']);
    expect(report.fourWeekCrossActorRetention).toEqual({state: 'observed', actors: '3-4'});
    expect(report.pilotSuccess).toBe('not-assessed');
    const incomplete = buildPilotReport({
      ...pilotInput(),
      evidence: EffectArray.filter(evidence, event => event.kind !== 'approved-delta'),
    });
    expect(EffectArray.map(incomplete.weeks, week => week.fullLoopActors)).toEqual(['0', '0', '0', '0']);
    const shifted = buildPilotReport({
      ...pilotInput(),
      windowStart: '2026-08-31',
      evidence,
      evidenceCoverage: 'complete',
    });
    expect(shifted.reportDigest).not.toBe(report.reportDigest);
    expect(shifted.weeks).toEqual(report.weeks);
  });

  it('rejects report tampering and never upgrades a partial absence to observed zero', () => {
    const report = buildPilotReport(pilotInput());
    expect(() => parsePilotReport({...report, actors: '100+'})).toThrow();
    expect(() => parsePilotReport({...report, userId: 'secret'})).toThrow();
    expect(EffectArray.every(report.weeks, week => week.retainedFromPriorWeek === null)).toBe(true);
    const complete = buildPilotReport({...pilotInput(), evidenceCoverage: 'complete'});
    expect(complete.metrics.firstSourceVerifiedBrief.state).toBe('observed');
    expect(complete.metrics.firstSourceVerifiedBrief.rate).toBe('0');
  });

  it('rejects content, foreign versions, bad periods, duplicate claims and unscoped actors', () => {
    const input = pilotInput();
    expect(() => parsePilotInput({...input, repository: 'secret'})).toThrow();
    expect(() => parsePilotInput({...input, version: 2})).toThrow();
    expect(() => parsePilotInput({...input, windowStart: '2026-02-30'})).toThrow();
    expect(() => parsePilotInput({...input, elapsedDays: 29})).toThrow();
    const observation = {actor: 0, sample: 0, metric: 'falseCurrentRate', state: 'observed', value: 0};
    expect(() => parsePilotInput({...input, observations: [observation, observation]})).toThrow();
    expect(() => parsePilotInput({...input, observations: [{...observation, actor: 3}]})).toThrow();
    expect(() => parsePilotInput({...input, observations: [{...observation, query: 'secret'}]})).toThrow();
    expect(() => parsePilotInput({...input, observations: [{...observation, value: 2}]})).toThrow();
  });

  it('is invariant under independently ordered input lanes and arbitrary actor renaming, and never mutates input', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.integer({min: 0, max: 1}), fc.integer({min: 0, max: 1}), fc.integer({min: 0, max: 1})),
        fc.shuffledSubarray([0, 1, 2], {minLength: 3, maxLength: 3}),
        fc.shuffledSubarray([0, 1, 2], {minLength: 3, maxLength: 3}),
        fc.shuffledSubarray([0, 1, 2], {minLength: 3, maxLength: 3}),
        fc.shuffledSubarray([0, 1, 2, 3, 4, 5, 6, 7], {minLength: 8, maxLength: 8}),
        (values, actorSlots, sourceOrder, observationOrder, evidenceOrder) => {
          const base = pilotInput();
          const input: PilotInput = {
            ...base,
            sources: EffectArray.map([0, 1, 2], actor => ({
              actor,
              value: pilotSource(base.windowStart, base.elapsedDays, actor),
            })),
            observations: EffectArray.map(values, (value, actor) => ({
              actor,
              sample: 0,
              metric: 'falseCurrentRate',
              state: 'observed',
              value,
            })),
            evidence: [
              {actor: 0, item: 0, minute: 0, kind: 'verified-brief'},
              {actor: 1, item: 0, minute: 1, kind: 'verified-reuse'},
              {actor: 1, item: 0, minute: 2, kind: 'approved-delta'},
              {actor: 1, item: 0, minute: 3, kind: 'full-loop'},
              {actor: 1, item: 1, minute: 10_080, kind: 'verified-brief'},
              {actor: 2, item: 1, minute: 10_081, kind: 'verified-reuse'},
              {actor: 2, item: 1, minute: 10_082, kind: 'approved-delta'},
              {actor: 2, item: 1, minute: 10_083, kind: 'full-loop'},
            ],
          };
          const reordered = {
            ...input,
            sources: reorder(
              EffectArray.map(input.sources, source => ({...source, actor: actorSlots[source.actor]})),
              sourceOrder,
            ),
            observations: reorder(
              EffectArray.map(input.observations, observation => ({
                ...observation,
                actor: actorSlots[observation.actor],
              })),
              observationOrder,
            ),
            evidence: reorder(
              EffectArray.map(input.evidence, event => ({...event, actor: actorSlots[event.actor]})),
              evidenceOrder,
            ),
          };
          const before = JSON.stringify(input);
          const reorderedBefore = JSON.stringify(reordered);
          const report = buildPilotReport(input);
          const reorderedReport = buildPilotReport(reordered);
          expect(serializePilotReport(report)).toBe(serializePilotReport(reorderedReport));
          expect(JSON.stringify(input)).toBe(before);
          expect(JSON.stringify(reordered)).toBe(reorderedBefore);
          expect(parsePilotReport(JSON.parse(serializePilotReport(report)))).toEqual(report);
          expect(serializePilotReport(report)).not.toMatch(
            /"(?:actor|item|sample|observations|evidence|path|query|repository|userId)":/u,
          );
        },
      ),
      {numRuns: 40},
    );
  });
});
