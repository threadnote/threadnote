import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {buildCompactPlan, DEFAULT_HANDOFF_NEXT_STEP, parseMemoryDocument} from '@threadnote/memory/hygiene';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

function decisions(body: string): readonly boolean[] {
  const record = parseMemoryDocument(
    'threadnote://user/test/memories/handoffs/active/fixture/parser.md',
    EffectArray.join(
      [
        'HANDOFF',
        'kind: handoff',
        'project: fixture',
        'topic: parser',
        'timestamp: 2026-08-01T00:00:00.000Z',
        '',
        body,
      ],
      '\n',
    ),
  )!;
  return EffectArray.flatMap([8, 30], age => {
    const now = new Date(Date.UTC(2026, 7, 1 + age));
    const plan = buildCompactPlan([{...record, body}], {now, project: 'fixture'});
    return [plan.archives.length > 0, plan.manualReview.length > 0];
  });
}

function legacyDecisions(body: string): readonly boolean[] {
  if (body.length > 4_096) throw new Error('Legacy oracle is limited to small generated inputs.');
  const lines = Effect.pipe(body, EffectString.trim, EffectString.split(/\r?\n/));
  const fields = new Map<string, string[]>();
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(?:[-*]\s+)?(status|next_step|blockers?):\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    let value = match[2];
    if (!value) {
      const following = Effect.pipe(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            lines.slice(index + 1),
            __effectArrayValue => !!(candidate => Effect.pipe(candidate, EffectString.trim))(__effectArrayValue),
          ),
        ),
        effectOptionalString =>
          effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
      );
      if (following && !/^\s*(?:[-*]\s+)?[\w -]+\s*:/.test(following))
        value = Effect.pipe(following, EffectString.replace(/^[-*]\s+/, ''));
    }
    const key = Effect.pipe(match[1], EffectString.toLowerCase);
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }
  const values = (keys: readonly string[]) =>
    EffectArray.filter(
      EffectArray.map(
        EffectArray.flatMap(keys, key => fields.get(key) ?? []),
        value =>
          Effect.pipe(
            value,
            EffectString.trim,
            EffectString.toLowerCase,
            EffectString.replace(/[.!;:]+$/g, ''),
            EffectString.replace(/\s+/g, ' '),
          ),
      ),
      Boolean,
    );
  const statuses = values(['status']);
  const next = values(['next_step']);
  const terminal =
    EffectArray.some(statuses, status =>
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
    EffectArray.some(statuses, status =>
      /^(?:active|awaiting(?:\s+.+)?|blocked|in[ _-]?progress|open|pending|waiting(?:\s+.+)?)$/.test(status),
    ) ||
    EffectArray.some(next, value => value !== 'none' && value !== DEFAULT_HANDOFF_NEXT_STEP) ||
    EffectArray.some(
      values(['blockers', 'blocker']),
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
    .map(characters => EffectArray.join(characters, ''));
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
    .map(parts => EffectArray.join(parts, ''));
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
      const body = EffectArray.join(lines, crlf ? '\r\n' : '\n');
      expect(decisions(body)).toEqual(legacyDecisions(body));
    }),
    {numRuns: 300},
  );
});

it.each([
  ['star whitespace-only header', 'status: completed\nnext_step:\n*  : ignored', [true, false, true, false]],
  ['confusable header casing', 'blocKer: finish review', [false, false, true, false]],
  [
    'awaiting tabs and suffix',
    `status: awaiting${Effect.pipe('\t', EffectString.repeat(100_000))}review`,
    [false, false, false, true],
  ],
  [
    'waiting tabs and suffix',
    `status: waiting${Effect.pipe('\t', EffectString.repeat(100_000))}review`,
    [false, false, false, true],
  ],
  [
    'waiting trailing tabs',
    `status: waiting${Effect.pipe('\t', EffectString.repeat(100_000))}`,
    [false, false, false, true],
  ],
  [
    'waiting punctuation-only suffix',
    `status: waiting${Effect.pipe('\t', EffectString.repeat(100_000))}.!`,
    [false, false, true, false],
  ],
  ['waiting without separator', 'status: waitingreview', [false, false, true, false]],
  [
    'inline line terminator after tabs',
    `status:${Effect.pipe('\t', EffectString.repeat(100_000))}x\rx`,
    [false, false, true, false],
  ],
  [
    'non-header after interior spaces',
    `status:\na${Effect.pipe(' ', EffectString.repeat(100_000))}?`,
    [false, false, true, false],
  ],
  [
    'header after interior spaces',
    `next_step:\na${Effect.pipe(' ', EffectString.repeat(100_000))}:`,
    [false, false, true, false],
  ],
  [
    'nonterminal punctuation suffix',
    `status:a${Effect.pipe('!', EffectString.repeat(100_000))}b`,
    [false, false, true, false],
  ],
  [
    'terminal punctuation suffix',
    `status:completed${Effect.pipe('.!;:', EffectString.repeat(25_000))}`,
    [true, false, true, false],
  ],
  [
    'many empty fields',
    `status:completed\n${Effect.pipe('status:\n', EffectString.repeat(20_000))}`,
    [true, false, true, false],
  ],
] as const)('handles bounded adversarial %s without changing retention', (_label, body, expected) => {
  expect(decisions(body)).toEqual(expected);
});
