import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  casedCodeIdentifiers,
  exactCasedCodeIdentifier,
  hasExactCasedCodeIdentifierMatch,
} from '@threadnote/recall/identifier';
import {identifiers} from '@threadnote/recall/index/lexical';
import {rankRecallCandidates, type RecallRankContext} from '@threadnote/recall/rank';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const TARGET_IDENTIFIER = 'rankRecallCandidates';
const TARGET_URI = 'threadnote://resources/repos/threadnote/recall-ranker.md';

function identifierCorpus(
  declaredIdentifiers: readonly string[] = [TARGET_IDENTIFIER],
): Parameters<typeof rankRecallCandidates>[1] {
  const target = {
    authority: 'canonical_repo' as const,
    fields: {
      identifiers: declaredIdentifiers,
      project: 'threadnote',
      title: 'Recall ranker code',
      topic: 'ranker-code',
    },
    text: 'The implementation defines candidate ranking behavior.',
    uri: TARGET_URI,
  };
  const distractors = Array.from({length: 20}, (_, index) => ({
    fields: {project: 'threadnote', title: `Code behavior ${index}`},
    text: `Code behavior implementation defined recall candidate ${index}`,
    uri: `threadnote://resources/repos/threadnote/distractor-${index}.md`,
  }));
  return [target, ...distractors];
}

describe('cased recall identifiers', () => {
  it('retains exact NFC camelCase and PascalCase tokens without changing structured identifiers', () => {
    expect(identifiers('retryPolicy alpha_42 CACHE-HWM-73 HTTPServer Threadnote cafe\u0301Parser v2Config')).toEqual([
      'alpha_42',
      'cache-hwm-73',
      'v2config',
      'retryPolicy',
      'HTTPServer',
      'caféParser',
      'v2Config',
    ]);
    expect(casedCodeIdentifiers('Ranker.rankRecallCandidates and ResolveUpdateChannel')).toEqual([
      'rankRecallCandidates',
      'ResolveUpdateChannel',
    ]);
  });

  it.each([
    'Threadnote',
    'lowercase',
    'UPPERCASE',
    'implementation symbol rankRecallCandidates',
    '$rankRecallCandidates',
  ])('does not accept %s as one distinctively cased identifier field', value => {
    expect(exactCasedCodeIdentifier(value)).toBeUndefined();
  });

  it('matches exact original-query identifiers across generated casing shapes', () => {
    const lowerLetter = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz');
    const segment = fc
      .array(lowerLetter, {maxLength: 8, minLength: 2})
      .map(characters => EffectArray.join(characters, ''));
    const camelIdentifier = fc.array(segment, {maxLength: 4, minLength: 2}).map(
      ([first, ...rest]) =>
        `${first}${EffectArray.join(
          EffectArray.map(
            rest,
            part => `${Effect.pipe(part[0], EffectString.toUpperCase)}${Effect.pipe(part, EffectString.slice(1))}`,
          ),
          '',
        )}`,
    );

    fc.assert(
      fc.property(camelIdentifier, identifier => {
        const caseMutation = `${Effect.pipe(identifier[0], EffectString.toUpperCase)}${Effect.pipe(identifier, EffectString.slice(1))}`;
        expect(hasExactCasedCodeIdentifierMatch(`Where is ${identifier}?`, [identifier])).toBe(true);
        expect(hasExactCasedCodeIdentifierMatch(`Where is ${caseMutation}?`, [identifier])).toBe(false);
        expect(hasExactCasedCodeIdentifierMatch(`Where is ${identifier}Extra?`, [identifier])).toBe(false);
        expect(hasExactCasedCodeIdentifierMatch(`Where is ${identifier}?`, [`symbol ${identifier}`])).toBe(false);
      }),
      {numRuns: 64},
    );
  });

  it.each(['rankRecallCandidates', 'ResolveUpdateChannel', 'HTTPServer'])(
    'allows weak lexical evidence for the exact %s identifier to remain answerable',
    identifier => {
      const ranked = rankRecallCandidates(`Where is ${identifier} behavior defined?`, identifierCorpus([identifier]), {
        project: 'threadnote',
      });

      expect(ranked.results[0]?.candidate.uri).toBe(TARGET_URI);
      expect(ranked.confidence.level).not.toBe('no_answer');
    },
  );

  it.each<{
    readonly identifiers?: readonly string[];
    readonly query: string;
    readonly queryVariants?: readonly string[];
  }>([
    {query: 'Where is RankRecallCandidates behavior defined?'},
    {query: 'Where is rank recall candidates behavior defined?'},
    {query: 'Where is rankRecallCandidate behavior defined?'},
    {query: 'Where is rаnkRecallCandidates behavior defined?'},
    {query: 'Where is otherRecallCandidates behavior defined?'},
    {
      identifiers: ['implementation symbol rankRecallCandidates'],
      query: 'Where is rankRecallCandidates behavior defined?',
    },
    {query: 'Where is ranking behavior defined?', queryVariants: ['rankRecallCandidates']},
  ])('does not rescue non-exact identifier evidence from $query', ({identifiers: declared, query, queryVariants}) => {
    const context: RecallRankContext = {project: 'threadnote', queryVariants};
    const ranked = rankRecallCandidates(query, identifierCorpus(declared), context);

    expect(ranked.confidence.level).toBe('no_answer');
  });
});
