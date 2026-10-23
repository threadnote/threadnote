import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {nextContextHealthChangeAt} from '@threadnote/context/health';
import type {MemoryRecord} from '@threadnote/memory/document';
import {buildCompactPlan} from '@threadnote/memory/hygiene';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function record(
  id: string,
  overrides: Partial<MemoryRecord['metadata']> = {},
  body = 'task: retain context',
): MemoryRecord {
  const metadata = {
    kind: 'durable' as const,
    project: 'threadnote',
    sourceAgentClient: 'test',
    status: 'active' as const,
    timestamp: new Date(NOW - 20 * DAY).toISOString(),
    topic: 'health',
    ...overrides,
  };
  return {
    body,
    content: body,
    headerTitle: metadata.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
    metadata,
    uri: `threadnote://user/test/memories/${metadata.kind === 'handoff' ? 'handoffs/active' : 'durable/projects/threadnote'}/${id}.md`,
  };
}

describe('nextContextHealthChangeAt', () => {
  it('advances across exact review and validity boundaries without returning a past deadline', () => {
    const records = [
      record('due', {
        reviewAfter: new Date(NOW + 5_000).toISOString(),
        validTo: new Date(NOW + 10_000).toISOString(),
      }),
    ];
    const before = JSON.stringify(records);
    expect(nextContextHealthChangeAt({records, project: 'threadnote', now: new Date(NOW)})).toBe(NOW + 5_000);
    expect(nextContextHealthChangeAt({records, project: 'threadnote', now: new Date(NOW + 5_000)})).toBe(NOW + 10_000);
    expect(nextContextHealthChangeAt({records, project: 'threadnote', now: new Date(NOW + 10_000)})).toBeUndefined();
    expect(JSON.stringify(records)).toBe(before);
  });

  it('uses the hygiene 7/14/30-day boundaries from the latest handoff observation', () => {
    const observedAt = NOW - 2 * DAY;
    const handoff = record(
      'handoff',
      {
        kind: 'handoff',
        timestamp: new Date(NOW - 20 * DAY).toISOString(),
        lastReviewed: new Date(observedAt).toISOString(),
      },
      'status: complete\nnext_step: none',
    );
    const at = (milliseconds: number) =>
      nextContextHealthChangeAt({
        records: [handoff],
        project: 'threadnote',
        now: new Date(milliseconds),
      });
    expect(at(NOW)).toBe(observedAt + 7 * DAY);
    expect(
      buildCompactPlan([handoff], {project: 'threadnote', now: new Date(observedAt + 7 * DAY - 1)}).archives,
    ).toHaveLength(0);
    expect(
      buildCompactPlan([handoff], {project: 'threadnote', now: new Date(observedAt + 7 * DAY)}).archives,
    ).toHaveLength(1);
    expect(at(observedAt + 7 * DAY)).toBe(observedAt + 14 * DAY);
    expect(at(observedAt + 14 * DAY)).toBe(observedAt + 30 * DAY);
    expect(at(observedAt + 30 * DAY)).toBeUndefined();
  });

  it('ignores inactive and other-project records', () => {
    const records = [
      record('archived', {status: 'archived', validTo: new Date(NOW + 1_000).toISOString()}),
      record('other', {project: 'other', reviewAfter: new Date(NOW + 2_000).toISOString()}),
    ];
    expect(nextContextHealthChangeAt({records, project: 'threadnote', now: new Date(NOW)})).toBeUndefined();
  });

  it('uses the same UTC midnight for a date-only review_after as the report', () => {
    const records = [record('calendar-review', {reviewAfter: '2026-10-24'})];
    expect(nextContextHealthChangeAt({records, project: 'threadnote', now: new Date(NOW)})).toBe(
      Date.parse('2026-10-24T00:00:00.000Z'),
    );
  });

  it('returns the earliest future threshold across arbitrary validity dates', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: -10_000, max: 10_000}), {maxLength: 20}), offsets => {
        const records = offsets.map((offset, index) =>
          record(`r${index}`, {
            validTo: new Date(NOW + offset).toISOString(),
          }),
        );
        const expected = offsets.filter(offset => offset > 0).sort((left, right) => left - right)[0];
        expect(nextContextHealthChangeAt({records, project: 'threadnote', now: new Date(NOW)})).toBe(
          expected === undefined ? undefined : NOW + expected,
        );
      }),
      {numRuns: 24},
    );
  });
});
