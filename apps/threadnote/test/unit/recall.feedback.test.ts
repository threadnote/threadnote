import {DateTime, Effect} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  aggregateRecallFeedback,
  loadRecallFeedback,
  recallQueryFingerprint,
  recordRecallFeedback,
  summarizeRecallFeedback,
  type RecallFeedbackEvent,
} from '@threadnote/recall/feedback';
import {join, mkdir, mkdtemp, readFile, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect as run} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('recall feedback', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp('threadnote-feedback-');
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  it('stores only a query fingerprint and suppresses repeated reinforcement', async () => {
    const input = {
      action: 'useful' as const,
      project: 'threadnote',
      query: 'Threadnote recall quality',
      timestamp: '2026-07-23T10:00:00.000Z',
      uri: 'threadnote://user/me/memory.md',
    };
    expect((await run(recordRecallFeedback(directory, input))).recorded).toBe(true);
    expect((await run(recordRecallFeedback(directory, input))).recorded).toBe(false);

    const feedback = await run(
      loadRecallFeedback(directory, {
        now: new Date('2026-07-23T10:00:00.000Z'),
        project: 'threadnote',
        query: input.query,
      }),
    );
    expect(feedback.get(input.uri)).toBeCloseTo(0.15);
    const queryFingerprint = await run(recallQueryFingerprint(input.query));
    expect(queryFingerprint).toHaveLength(64);
    const stored = await readFile(join(directory, 'feedback', 'recall-events-v1.jsonl'), 'utf8');
    expect(stored).not.toContain(input.query);
    expect(stored).toContain(queryFingerprint);
  });

  it('keeps pins project-scoped, decays old events, and bounds the total signal', async () => {
    const anotherQueryFingerprint = await run(recallQueryFingerprint('another query'));
    const currentQueryFingerprint = await run(recallQueryFingerprint('current query'));
    const event = (
      action: RecallFeedbackEvent['action'],
      project: string,
      timestamp: string,
      queryFingerprint = anotherQueryFingerprint,
    ): RecallFeedbackEvent => ({
      action,
      project,
      queryFingerprint,
      rankerVersion: 'hybrid-v1',
      timestamp,
      uri: 'threadnote://user/me/memory.md',
      version: 1,
    });
    const events = [
      event('pin', 'threadnote', '2026-07-23T00:00:00.000Z'),
      event('pin', 'other', '2026-07-23T00:00:00.000Z'),
      ...Array.from({length: 10}, () =>
        event('wrong', 'threadnote', '2025-01-01T00:00:00.000Z', currentQueryFingerprint),
      ),
    ];

    const scores = await run(
      aggregateRecallFeedback(events, {
        now: new Date('2026-07-23T00:00:00.000Z'),
        project: 'threadnote',
        query: 'current query',
      }),
    );

    expect(scores.get('threadnote://user/me/memory.md')).toBeGreaterThanOrEqual(-1);
    expect(scores.get('threadnote://user/me/memory.md')).toBeLessThan(0.4);
  });

  effectIt.effect('keeps unscoped ranking limited to projectless non-pin feedback', () =>
    Effect.gen(function* () {
      const query = 'current query';
      const queryFingerprint = yield* recallQueryFingerprint(query);
      const otherQueryFingerprint = yield* recallQueryFingerprint('different query');
      const events: RecallFeedbackEvent[] = [
        {
          action: 'useful',
          queryFingerprint,
          rankerVersion: 'hybrid-v1',
          timestamp: '2026-07-23T00:00:00.000Z',
          uri: 'threadnote://user/me/global.md',
          version: 1,
        },
        {
          action: 'useful',
          project: 'threadnote',
          queryFingerprint,
          rankerVersion: 'hybrid-v1',
          timestamp: '2026-07-23T00:00:00.000Z',
          uri: 'threadnote://user/me/scoped.md',
          version: 1,
        },
        {
          action: 'pin',
          project: 'threadnote',
          queryFingerprint,
          rankerVersion: 'hybrid-v1',
          timestamp: '2026-07-23T00:00:00.000Z',
          uri: 'threadnote://user/me/pinned.md',
          version: 1,
        },
        {
          action: 'pin',
          queryFingerprint: otherQueryFingerprint,
          rankerVersion: 'hybrid-v1',
          timestamp: '2026-07-23T00:00:00.000Z',
          uri: 'threadnote://user/me/projectless-pin.md',
          version: 1,
        },
      ];

      const scores = yield* aggregateRecallFeedback(events, {
        now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-07-23T00:00:00.000Z')),
        query,
      });

      expect(scores).toEqual(new Map([['threadnote://user/me/global.md', 0.15]]));
      expect(scores.has('threadnote://user/me/projectless-pin.md')).toBe(false);
    }),
  );

  it('ignores legacy projectless pins and compacts expired events on write', async () => {
    const feedbackDirectory = join(directory, 'feedback');
    const feedbackPath = join(feedbackDirectory, 'recall-events-v1.jsonl');
    const projectlessPin: RecallFeedbackEvent = {
      action: 'pin',
      queryFingerprint: await run(recallQueryFingerprint('query')),
      rankerVersion: 'hybrid-v1',
      timestamp: '2026-07-23T00:00:00.000Z',
      uri: 'threadnote://user/me/projectless-pin.md',
      version: 1,
    };
    expect(
      (
        await run(
          aggregateRecallFeedback([projectlessPin], {
            now: new Date('2026-07-23T00:00:00.000Z'),
            project: 'threadnote',
            query: 'query',
          }),
        )
      ).has(projectlessPin.uri),
    ).toBe(false);

    await mkdir(feedbackDirectory, {recursive: true});
    await writeFile(
      feedbackPath,
      `${JSON.stringify({
        ...projectlessPin,
        action: 'useful',
        timestamp: '2020-01-01T00:00:00.000Z',
        uri: 'threadnote://user/me/expired.md',
      })}\n`,
      'utf8',
    );
    await run(
      recordRecallFeedback(directory, {
        action: 'useful',
        project: 'threadnote',
        query: 'query',
        timestamp: '2026-07-23T00:00:00.000Z',
        uri: 'threadnote://user/me/current.md',
      }),
    );

    const stored = await readFile(feedbackPath, 'utf8');
    expect(stored).toContain('threadnote://user/me/current.md');
    expect(stored).not.toContain('threadnote://user/me/expired.md');
  });

  it('serializes concurrent feedback rewrites without losing an event', async () => {
    await run(
      Effect.forEach(
        ['one', 'two'],
        suffix =>
          recordRecallFeedback(directory, {
            action: 'useful',
            project: 'threadnote',
            query: `query-${suffix}`,
            timestamp: '2026-07-23T00:00:00.000Z',
            uri: `threadnote://user/me/${suffix}.md`,
          }),
        {concurrency: 2},
      ),
    );

    const stored = await readFile(join(directory, 'feedback', 'recall-events-v1.jsonl'), 'utf8');
    expect(Effect2.pipe(stored, EffectString.trim, EffectString.split('\n'))).toHaveLength(2);
  });

  it('treats projectless non-pin feedback as global for project-filtered reports', () => {
    const events: RecallFeedbackEvent[] = [
      {
        action: 'applied',
        queryFingerprint: Effect2.pipe('a', EffectString.repeat(64)),
        rankerVersion: 'test',
        timestamp: '2026-07-23T00:00:00.000Z',
        uri: 'threadnote://user/me/global.md',
        version: 1,
      },
      {
        action: 'pin',
        queryFingerprint: Effect2.pipe('a', EffectString.repeat(64)),
        rankerVersion: 'test',
        timestamp: '2026-07-23T00:00:00.000Z',
        uri: 'threadnote://user/me/global-pin.md',
        version: 1,
      },
      {
        action: 'useful',
        project: 'other',
        queryFingerprint: Effect2.pipe('a', EffectString.repeat(64)),
        rankerVersion: 'test',
        timestamp: '2026-07-23T00:00:00.000Z',
        uri: 'threadnote://user/me/other.md',
        version: 1,
      },
    ];

    expect(
      summarizeRecallFeedback(events, {
        from: new Date('2026-07-23T00:00:00.000Z'),
        project: 'threadnote',
        to: new Date('2026-07-23T00:00:00.000Z'),
      }),
    ).toEqual({applied: 1, dismiss: 0, pin: 0, useful: 0, wrong: 0});
  });

  it('counts all actions for unfiltered reports', () => {
    const events: RecallFeedbackEvent[] = [
      {
        action: 'applied',
        project: 'threadnote',
        queryFingerprint: Effect2.pipe('a', EffectString.repeat(64)),
        rankerVersion: 'test',
        timestamp: '2026-07-23T00:00:00.000Z',
        uri: 'threadnote://user/me/scoped.md',
        version: 1,
      },
      {
        action: 'pin',
        project: 'threadnote',
        queryFingerprint: Effect2.pipe('a', EffectString.repeat(64)),
        rankerVersion: 'test',
        timestamp: '2026-07-23T00:00:00.000Z',
        uri: 'threadnote://user/me/pinned.md',
        version: 1,
      },
    ];

    expect(summarizeRecallFeedback(events)).toEqual({applied: 1, dismiss: 0, pin: 1, useful: 0, wrong: 0});
  });
});
