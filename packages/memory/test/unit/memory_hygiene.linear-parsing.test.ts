import fc from 'fast-check';
import {expect, it} from 'vitest';
import {buildCompactPlan, DEFAULT_HANDOFF_NEXT_STEP, parseMemoryDocument} from '@threadnote/memory/hygiene';

function decisions(body: string): readonly boolean[] {
  const record = parseMemoryDocument(
    'threadnote://user/test/memories/handoffs/active/fixture/parser.md',
    [
      'HANDOFF',
      'kind: handoff',
      'project: fixture',
      'topic: parser',
      'timestamp: 2026-08-01T00:00:00.000Z',
      '',
      body,
    ].join('\n'),
  )!;
  return [8, 30].flatMap(age => {
    const now = new Date(Date.UTC(2026, 7, 1 + age));
    const plan = buildCompactPlan([{...record, body}], {now, project: 'fixture'});
    return [plan.archives.length > 0, plan.manualReview.length > 0];
  });
}

function legacyDecisions(body: string): readonly boolean[] {
  if (body.length > 4_096) throw new Error('Legacy oracle is limited to small generated inputs.');
  const lines = body.trim().split(/\r?\n/);
  const fields = new Map<string, string[]>();
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(?:[-*]\s+)?(status|next_step|blockers?):\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    let value = match[2];
    if (!value) {
      const following = lines
        .slice(index + 1)
        .find(candidate => candidate.trim())
        ?.trim();
      if (following && !/^\s*(?:[-*]\s+)?[\w -]+\s*:/.test(following)) value = following.replace(/^[-*]\s+/, '');
    }
    const key = match[1].toLowerCase();
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }
  const values = (keys: readonly string[]) =>
    keys
      .flatMap(key => fields.get(key) ?? [])
      .map(value =>
        value
          .trim()
          .toLowerCase()
          .replace(/[.!;:]+$/g, '')
          .replace(/\s+/g, ' '),
      )
      .filter(Boolean);
  const statuses = values(['status']);
  const next = values(['next_step']);
  const terminal =
    statuses.some(status =>
      [
        'abandoned',
        'canceled',
        'cancelled',
        'closed',
        'complete',
        'completed',
        'done',
        'merged',
        'released',
        'resolved',
        'shipped',
        'superseded',
      ].includes(status),
    ) || next.includes('none');
  const pending =
    statuses.some(status =>
      /^(?:active|awaiting(?:\s+.+)?|blocked|in[ _-]?progress|open|pending|waiting(?:\s+.+)?)$/.test(status),
    ) ||
    next.some(value => value !== 'none' && value !== DEFAULT_HANDOFF_NEXT_STEP) ||
    values(['blockers', 'blocker']).some(
      value => !/^(?:n\/?a|no(?:\s+blockers?)?|none(?:\s+recorded)?|not\s+applicable)$/.test(value),
    ) ||
    /\b(?:PR|pull request|issue)\s+(?:is\s+)?open\b/i.test(body) ||
    /\b(?:awaiting|blocked by|waiting for)\b/i.test(body) ||
    /\b(?:remains?|still)\s+(?:blocked|open|pending)\b/i.test(body) ||
    /^\s*(?:[-*]\s+)?(?:blocked|blocker|pending)\s*:/im.test(body);
  return [terminal && !pending, false, !pending, pending];
}

it('preserves legacy retention decisions across bounded generated handoff lines', () => {
  const whitespace = fc
    .array(fc.constantFrom(' ', '\t', '\r', '\u2028', '\u2029', '\ufeff'), {maxLength: 5})
    .map(characters => characters.join(''));
  const plainValue = fc.constantFrom(
    '',
    'completed',
    'None.',
    'none recorded',
    'pending',
    'not applicable',
    'finish review',
    DEFAULT_HANDOFF_NEXT_STEP,
    'none\u2028.',
    'complete\rx',
    'a   :',
    '- :',
    '* :',
    '*  : ignored',
    '* \t : ignored',
    '* \t: ignored',
    '*\t : ignored',
    '---:',
  );
  const pendingValue = fc
    .tuple(
      fc.constantFrom('awaiting', 'waiting', 'AWAITING', 'WAITING', 'waitingreview'),
      whitespace,
      fc.constantFrom('', 'review', 'for review', '.!', 'completed.!'),
    )
    .map(parts => parts.join(''));
  const value = fc.oneof(plainValue, pendingValue);
  const field = fc
    .tuple(
      whitespace,
      fc.constantFrom('', '- ', '*\t'),
      fc.constantFrom(
        'status:',
        'Status:',
        'next_step:',
        'blocker:',
        'blockers:',
        'blocKer:',
        'status :',
        'other_header:',
      ),
      value,
      whitespace,
    )
    .map(([prefix, bullet, key, text, suffix]) => `${prefix}${bullet}${key}${text}${suffix}`);
  const line = fc.oneof(field, value, whitespace);
  fc.assert(
    fc.property(fc.array(line, {minLength: 1, maxLength: 12}), fc.boolean(), (lines, crlf) => {
      const body = lines.join(crlf ? '\r\n' : '\n');
      expect(decisions(body)).toEqual(legacyDecisions(body));
    }),
    {numRuns: 300},
  );
});

it.each([
  ['star whitespace-only header', 'status: completed\nnext_step:\n*  : ignored', [true, false, true, false]],
  ['confusable header casing', 'blocKer: finish review', [false, false, true, false]],
  ['awaiting tabs and suffix', `status: awaiting${'\t'.repeat(100_000)}review`, [false, false, false, true]],
  ['waiting tabs and suffix', `status: waiting${'\t'.repeat(100_000)}review`, [false, false, false, true]],
  ['waiting trailing tabs', `status: waiting${'\t'.repeat(100_000)}`, [false, false, false, true]],
  ['waiting punctuation-only suffix', `status: waiting${'\t'.repeat(100_000)}.!`, [false, false, true, false]],
  ['waiting without separator', 'status: waitingreview', [false, false, true, false]],
  ['inline line terminator after tabs', `status:${'\t'.repeat(100_000)}x\rx`, [false, false, true, false]],
  ['non-header after interior spaces', `status:\na${' '.repeat(100_000)}?`, [false, false, true, false]],
  ['header after interior spaces', `next_step:\na${' '.repeat(100_000)}:`, [false, false, true, false]],
  ['nonterminal punctuation suffix', `status:a${'!'.repeat(100_000)}b`, [false, false, true, false]],
  ['terminal punctuation suffix', `status:completed${'.!;:'.repeat(25_000)}`, [true, false, true, false]],
  ['many empty fields', `status:completed\n${'status:\n'.repeat(20_000)}`, [true, false, true, false]],
] as const)('handles bounded adversarial %s without changing retention', (_label, body, expected) => {
  expect(decisions(body)).toEqual(expected);
});
