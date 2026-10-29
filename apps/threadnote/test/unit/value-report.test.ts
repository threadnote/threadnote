import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {
  aggregateValueReportV1,
  parseValueReportV1,
  type ValueReportInputV1,
} from '@threadnote/threadnote/value_report/index';
import {summarizeLocalValueEvents, type LocalValueEventV1} from '@threadnote/threadnote/value_report/events';
import {summarizeRecallFeedback, type RecallFeedbackEvent} from '@threadnote/recall/feedback';
import {isJsonObject} from '@threadnote/platform/json';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const feedbackEvent = (action: RecallFeedbackEvent['action'], timestamp: string): RecallFeedbackEvent => ({
  action,
  project: 'local-project',
  queryFingerprint: Effect.pipe('a', EffectString.repeat(64)),
  rankerVersion: 'hybrid-v1',
  timestamp,
  uri: 'threadnote://private/memory',
  version: 1,
});

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object.');
  return value;
}

describe('value report', () => {
  it('projects bounded count-only metrics from feedback and explicit inputs', () => {
    const input: ValueReportInputV1 = {
      feedbackEvents: [
        feedbackEvent('applied', '2026-09-01T12:00:00.000Z'),
        feedbackEvent('useful', '2026-09-01T00:00:00.000Z'),
        feedbackEvent('wrong', '2026-09-02T00:00:00.000Z'),
        feedbackEvent('pin', '2026-08-01T00:00:00.000Z'),
      ],
      period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
      project: 'local-project',
      counts: {
        contextBrief: {
          attempts: 3,
          successful: 2,
          requestedCodeAnchors: 5,
          resolvedCodeAnchors: 4,
          coverageGaps: 1,
          estimatedTokens: 100,
          followUpGraphOperations: 2,
          followUpRecallOperations: 1,
          timeToFirstSuccessfulMillisecondsSamples: [300, 100, 200],
        },
        knowledgeDelta: {proposed: 4, approved: 2, edited: 1, rejected: 1, deferred: 0},
        health: {opened: 2, resolved: 1},
        setup: {
          completed: 1,
          failed: 1,
          started: 2,
          supportedAgentReuse: 1,
          timeToFirstEvidenceMillisecondsSamples: [300, 100, 200],
        },
      },
    };

    const report = aggregateValueReportV1(input);
    expect(report).toMatchObject({
      type: 'value-report',
      version: 1,
      scope: 'local',
      feedback: {applied: 1, useful: 1, wrong: 1, dismiss: 0, pin: 0, total: 3},
      contextBrief: {
        attempts: 3,
        successful: 2,
        requestedCodeAnchors: 5,
        resolvedCodeAnchors: 4,
        timeToFirstSuccessfulMilliseconds: 200,
      },
      setup: {
        availability: 'available',
        completed: 1,
        failed: 1,
        started: 2,
        supportedAgentReuse: 1,
        timeToFirstEvidenceMilliseconds: 200,
      },
    });
    expect(JSON.stringify(report)).not.toContain('local-project');
    expect(JSON.stringify(report)).not.toContain('private');
    expect(parseValueReportV1(report)).toEqual(report);
  });

  it('reads pre-applied ValueReportV1 feedback as zero applied outcomes', () => {
    const current = aggregateValueReportV1({
      period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
    });
    const legacy = requireJsonObject(JSON.parse(JSON.stringify(current)));
    const feedback = requireJsonObject(legacy.feedback);
    delete feedback.applied;
    delete feedback.appliedRate;

    expect(parseValueReportV1(legacy).feedback).toMatchObject({applied: 0, appliedRate: 0});
  });

  it('is deterministic and order invariant for feedback and timing samples', () => {
    const input: ValueReportInputV1 = {
      feedbackEvents: [
        feedbackEvent('applied', '2026-09-03T00:00:00.000Z'),
        feedbackEvent('useful', '2026-09-01T00:00:00.000Z'),
        feedbackEvent('wrong', '2026-09-02T00:00:00.000Z'),
      ],
      period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
      counts: {contextBrief: {timeToFirstSuccessfulMillisecondsSamples: [4, 1, 9]}},
    };
    const reversed = {
      ...input,
      feedbackEvents: [...input.feedbackEvents!].reverse(),
      counts: {contextBrief: {timeToFirstSuccessfulMillisecondsSamples: [9, 4, 1]}},
    };
    expect(aggregateValueReportV1(input)).toEqual(aggregateValueReportV1(reversed));
    FC.assert(
      FC.property(FC.array(FC.integer({min: 0, max: 10_000}), {maxLength: 32}), values => {
        const report = aggregateValueReportV1({
          period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
          counts: {contextBrief: {timeToFirstSuccessfulMillisecondsSamples: values}},
        });
        const shuffled = [...values].reverse();
        return (
          JSON.stringify(report) ===
          JSON.stringify(
            aggregateValueReportV1({
              period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
              counts: {contextBrief: {timeToFirstSuccessfulMillisecondsSamples: shuffled}},
            }),
          )
        );
      }),
      {numRuns: 25},
    );
  });

  it('clamps untrusted counts and durations to the report bounds', () => {
    const report = aggregateValueReportV1({
      period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
      counts: {
        contextBrief: {
          attempts: Number.MAX_SAFE_INTEGER,
          estimatedTokens: Number.MAX_SAFE_INTEGER,
          timeToFirstSuccessfulMillisecondsSamples: [Number.MAX_SAFE_INTEGER],
        },
      },
    });
    expect(report.contextBrief.attempts).toBe(10_000);
    expect(report.contextBrief.estimatedTokens).toBe(10_000);
    expect(report.contextBrief.timeToFirstSuccessfulMilliseconds).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('summarizes local count-only events independently of storage order', () => {
    FC.assert(
      FC.property(FC.array(FC.integer({min: 0, max: 1_000}), {maxLength: 40}), durations => {
        const events: readonly LocalValueEventV1[] = EffectArray.map(durations, (durationMilliseconds, index) => ({
          coverageGaps: index % 3,
          durationMilliseconds,
          estimatedTokens: index,
          kind: 'context-brief',
          project: index % 2 === 0 ? 'threadnote' : 'other',
          requestedCodeAnchors: index % 4,
          resolvedCodeAnchors: index % 4,
          successful: index % 5 !== 0,
          timestamp: `2026-09-${Effect.pipe(String((index % 20) + 1), EffectString.padStart(2, '0'))}T00:00:00.000Z`,
          version: 1,
        }));
        const options = {
          from: new Date('2026-09-01T00:00:00.000Z'),
          project: 'threadnote',
          to: new Date('2026-09-30T00:00:00.000Z'),
        };
        expect(summarizeLocalValueEvents(events, options)).toEqual(
          summarizeLocalValueEvents([...events].reverse(), options),
        );
      }),
      {numRuns: 40},
    );
  });

  it('selects feedback by project and inclusive period boundaries', () => {
    const from = new Date('2026-09-10T00:00:00.000Z');
    const to = new Date('2026-09-20T00:00:00.000Z');
    const actions = ['applied', 'dismiss', 'pin', 'useful', 'wrong'] as const;
    const projects = [undefined, 'local-project', 'other-project'] as const;
    const timestamps = [
      '2026-09-09T23:59:59.999Z',
      from.toISOString(),
      '2026-09-15T00:00:00.000Z',
      to.toISOString(),
      '2026-09-20T00:00:00.001Z',
    ] as const;

    FC.assert(
      FC.property(
        FC.array(
          FC.record({
            action: FC.constantFrom(...actions),
            project: FC.constantFrom(...projects),
            timestamp: FC.constantFrom(...timestamps),
          }),
          {maxLength: 40},
        ),
        selections => {
          const events = EffectArray.map(selections, (selection, index): RecallFeedbackEvent => ({
            ...selection,
            queryFingerprint: Effect.pipe('a', EffectString.repeat(64)),
            rankerVersion: 'test',
            uri: `threadnote://private/${index}`,
            version: 1,
          }));
          const expected = EffectRecord.fromEntries(EffectArray.map(actions, action => [action, 0])) as Record<
            (typeof actions)[number],
            number
          >;
          for (const event of events) {
            const timestamp = Date.parse(event.timestamp);
            const projectMatches =
              event.action === 'pin'
                ? event.project === 'local-project'
                : event.project === undefined || event.project === 'local-project';
            if (projectMatches && timestamp >= from.getTime() && timestamp <= to.getTime()) {
              expected[event.action] += 1;
            }
          }
          return (
            JSON.stringify(summarizeRecallFeedback(events, {from, project: 'local-project', to})) ===
            JSON.stringify(expected)
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('keeps legacy setup completions readable and aggregates content-free lifecycle timing', () => {
    const events: readonly LocalValueEventV1[] = [
      {
        completed: 1,
        kind: 'setup',
        supportedAgentReuse: 1,
        timestamp: '2026-09-03T00:00:00.000Z',
        version: 1,
      },
      {
        durationMilliseconds: 0,
        kind: 'setup-lifecycle',
        phase: 'started',
        timestamp: '2026-09-03T00:00:00.000Z',
        version: 1,
      },
      {
        durationMilliseconds: 250,
        kind: 'setup-lifecycle',
        phase: 'completed',
        timeToFirstEvidenceMilliseconds: 250,
        timestamp: '2026-09-03T00:00:00.250Z',
        version: 1,
      },
    ];
    const counts = summarizeLocalValueEvents(events, {
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(counts.setup).toEqual({
      completed: 1,
      failed: 0,
      started: 1,
      supportedAgentReuse: 1,
      timeToFirstEvidenceMillisecondsSamples: [250],
    });
    expect(aggregateValueReportV1({counts, period: {from: '2026-09-01', to: '2026-09-30'}}).setup).toEqual({
      availability: 'available',
      completed: 1,
      failed: 0,
      started: 1,
      supportedAgentReuse: 1,
      timeToFirstEvidenceMilliseconds: 250,
    });
  });
});
