import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  canonicalResourceUri,
  InvalidResourceId,
  makeResourceIdScopeChecker,
  parseResourceId,
  resourceIdIsWithin,
  resourceIdWithoutAnchor,
} from '@threadnote/store/resource-id';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const segmentBoundaryArbitrary = FC.constantFrom('a', 'Z', '0', '-', '_', '+', 'é', '中', 'क', '😀');
const segmentMiddleArbitrary = FC.constantFrom(
  'a',
  'Z',
  '0',
  '-',
  '_',
  '+',
  ' ',
  '.',
  '#',
  '%',
  '@',
  '[',
  ']',
  '&',
  '=',
  ',',
  ';',
  '$',
  'é',
  '中',
  'क',
  '😀',
);

/**
 * Every value is portable by construction: the fixed prefix avoids dot and
 * Windows-reserved names, the final character is never a space or dot, and
 * the bounded alphabet stays well below the 255-byte limit.
 */
const portableSegmentArbitrary = FC.oneof(
  FC.constantFrom('a', 'Z', '0', 'é', '中', 'क', '😀'),
  FC.tuple(FC.array(segmentMiddleArbitrary, {maxLength: 12}), segmentBoundaryArbitrary).map(
    ([middle, finalCharacter]) => `seg-${EffectArray.join(middle, '')}${finalCharacter}`,
  ),
);

const anchorArbitrary = FC.array(
  FC.constantFrom('a', 'Z', '0', ' ', '.', '/', '?', '#', '%', '@', '&', '=', '+', 'é', '中', 'क', '😀', 'e\u0301'),
  {maxLength: 16, minLength: 1},
).map(parts => EffectArray.join(parts, ''));

const optionalAnchorArbitrary = FC.option(anchorArbitrary, {nil: undefined});

type InvalidUriMutation =
  | 'bad_percent'
  | 'duplicate_separator'
  | 'encoded_backslash'
  | 'encoded_nul'
  | 'encoded_separator'
  | 'non_nfc'
  | 'query'
  | 'reserved_name'
  | 'trailing_dot'
  | 'traversal'
  | 'wrong_scheme';

const invalidUriMutationArbitrary = FC.constantFrom<InvalidUriMutation>(
  'bad_percent',
  'duplicate_separator',
  'encoded_backslash',
  'encoded_nul',
  'encoded_separator',
  'non_nfc',
  'query',
  'reserved_name',
  'trailing_dot',
  'traversal',
  'wrong_scheme',
);

type InvalidSegmentMutation =
  'control' | 'encoded_separator_value' | 'non_nfc' | 'reserved_name' | 'too_long' | 'trailing_dot';

const invalidSegmentMutationArbitrary = FC.constantFrom<InvalidSegmentMutation>(
  'control',
  'encoded_separator_value',
  'non_nfc',
  'reserved_name',
  'too_long',
  'trailing_dot',
);

describe('ResourceId properties', () => {
  it('rejects the minimized encoded-separator constructor counterexample', () => {
    expect(() => canonicalResourceUri('resources', ['seg-a/escape'])).toThrow(InvalidResourceId);
  });

  it('rejects the minimized control-anchor constructor counterexample', () => {
    expect(() => canonicalResourceUri('resources', ['safe'], 'a\0')).toThrow(InvalidResourceId);
  });

  fcProp(
    it,
    'round-trips every generated canonical identifier and removes anchors idempotently',
    {
      anchor: optionalAnchorArbitrary,
      namespace: portableSegmentArbitrary,
      segments: FC.array(portableSegmentArbitrary, {maxLength: 6}),
    },
    ({anchor, namespace, segments}) => {
      const canonicalUri = canonicalResourceUri(namespace, segments, anchor);
      const parsed = parseResourceId(canonicalUri);

      expect(parsed).toEqual({
        ...(anchor === undefined ? {} : {anchor}),
        canonicalUri,
        inputScheme: 'threadnote',
        namespace,
        segments,
      });
      expect(parseResourceId(parsed.canonicalUri)).toEqual(parsed);

      const withoutAnchor = resourceIdWithoutAnchor(parsed);
      expect(withoutAnchor.anchor).toBeUndefined();
      expect(withoutAnchor.canonicalUri).toBe(canonicalResourceUri(namespace, segments));
      expect(resourceIdWithoutAnchor(withoutAnchor)).toBe(withoutAnchor);
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'accepts exactly a canonical root and its descendants while rejecting sibling roots',
    {
      childSegments: FC.array(portableSegmentArbitrary, {maxLength: 5}),
      namespace: portableSegmentArbitrary,
      rootSegments: FC.array(portableSegmentArbitrary, {maxLength: 5, minLength: 1}),
      sibling: portableSegmentArbitrary,
    },
    ({childSegments, namespace, rootSegments, sibling}) => {
      const root = canonicalResourceUri(namespace, rootSegments);
      const child = canonicalResourceUri(namespace, [...rootSegments, ...childSegments]);
      const siblingRoot = canonicalResourceUri(namespace, [...rootSegments.slice(0, -1), sibling]);

      expect(resourceIdIsWithin(root, root)).toBe(true);
      expect(resourceIdIsWithin(child, root)).toBe(true);
      if (siblingRoot !== root) expect(resourceIdIsWithin(siblingRoot, root)).toBe(false);
      expect(resourceIdIsWithin(canonicalResourceUri(`${namespace}-other`, rootSegments), root)).toBe(false);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'canonicalizes fully percent-encoded legacy aliases exactly once',
    {
      anchor: optionalAnchorArbitrary,
      namespace: portableSegmentArbitrary,
      segments: FC.array(portableSegmentArbitrary, {maxLength: 6}),
    },
    ({anchor, namespace, segments}) => {
      const encodedPath = EffectArray.join(EffectArray.map(segments, percentEncodeEveryByte), '/');
      const legacyUri = `ViKiNg://${percentEncodeEveryByte(namespace)}/${encodedPath}${
        segments.length > 0 ? '/' : ''
      }${anchor === undefined ? '' : `#${percentEncodeEveryByte(anchor)}`}`;
      const expectedCanonical = canonicalResourceUri(namespace, segments, anchor);
      const parsed = parseResourceId(legacyUri);

      expect(parsed.inputScheme).toBe('viking');
      expect(parsed.canonicalUri).toBe(expectedCanonical);
      expect(parseResourceId(parsed.canonicalUri).canonicalUri).toBe(expectedCanonical);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'rejects generated unsafe URI mutations',
    {
      mutation: invalidUriMutationArbitrary,
      namespace: portableSegmentArbitrary,
      segment: portableSegmentArbitrary,
    },
    ({mutation, namespace, segment}) => {
      const encodedNamespace = encodeURIComponent(namespace);
      const encodedSegment = encodeURIComponent(segment);
      const mutated = invalidUriFor(mutation, encodedNamespace, encodedSegment);

      expect(() => parseResourceId(mutated)).toThrow(InvalidResourceId);
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'never emits a canonical URI from an invalid segment mutation',
    {
      mutation: invalidSegmentMutationArbitrary,
      segment: portableSegmentArbitrary,
    },
    ({mutation, segment}) => {
      const invalidSegment = invalidSegmentFor(mutation, segment);

      expect(() => canonicalResourceUri('resources', [invalidSegment])).toThrow(InvalidResourceId);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'never emits a canonical URI with a control character in its anchor',
    {
      anchor: anchorArbitrary,
      control: FC.constantFrom('\0', '\n', '\u001f'),
    },
    ({anchor, control}) => {
      expect(() => canonicalResourceUri('resources', ['safe'], `${anchor}${control}`)).toThrow(InvalidResourceId);
    },
    {fastCheck: {numRuns: 50}},
  );
});

function percentEncodeEveryByte(value: string): string {
  return EffectArray.join(
    EffectArray.map(
      [...Buffer.from(value, 'utf8')],
      byte => `%${Effect.pipe(byte.toString(16), EffectString.padStart(2, '0'))}`,
    ),
    '',
  );
}

function invalidUriFor(mutation: InvalidUriMutation, namespace: string, segment: string): string {
  switch (mutation) {
    case 'bad_percent':
      return `threadnote://${namespace}/${segment}/%zz`;
    case 'duplicate_separator':
      return `threadnote://${namespace}/${segment}//child`;
    case 'encoded_backslash':
      return `threadnote://${namespace}/${segment}%5cescape`;
    case 'encoded_nul':
      return `threadnote://${namespace}/${segment}%00suffix`;
    case 'encoded_separator':
      return `threadnote://${namespace}/${segment}%2fescape`;
    case 'non_nfc':
      return `threadnote://${namespace}/${segment}/e%CC%81`;
    case 'query':
      return `threadnote://${namespace}/${segment}?unsafe=true`;
    case 'reserved_name':
      return `threadnote://${namespace}/${segment}/CON.txt`;
    case 'trailing_dot':
      return `threadnote://${namespace}/${segment}.`;
    case 'traversal':
      return `threadnote://${namespace}/${segment}/%2e%2e`;
    case 'wrong_scheme':
      return `file://${namespace}/${segment}`;
  }
}

function invalidSegmentFor(mutation: InvalidSegmentMutation, segment: string): string {
  switch (mutation) {
    case 'control':
      return `${segment}\n`;
    case 'encoded_separator_value':
      return `${segment}/escape`;
    case 'non_nfc':
      return `${segment}e\u0301`;
    case 'reserved_name':
      return 'CON.txt';
    case 'too_long':
      return Effect.pipe('a', EffectString.repeat(256));
    case 'trailing_dot':
      return `${segment}.`;
  }
}

describe('local ResourceId scope parsing', () => {
  it('reuses immutable exact-input shapes without allowing returned objects to poison later checks', () => {
    const checker = makeResourceIdScopeChecker();
    const uri = 'threadnote://user/tester/memories/team-a/plan.md';
    const parsed = checker.parse(uri);
    expect(checker.parse(uri)).toBe(parsed);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.segments)).toBe(true);
    expect(() => Object.assign(parsed, {namespace: 'share'})).toThrow();
    expect(() => Reflect.apply(Array.prototype.push, parsed.segments, ['escape'])).toThrow();
    expect(checker.isWithin(uri, 'threadnote://user/tester/memories/team-a')).toBe(true);
    expect(checker.isWithin(uri, 'threadnote://user/tester/memories/team-b')).toBe(false);
    expect(makeResourceIdScopeChecker().parse(uri)).not.toBe(parsed);
  });

  it('keys aliases separately and compares the currently supplied scopes after mutation', () => {
    const checker = makeResourceIdScopeChecker();
    const uri = 'threadnote://user/tester/memories/team-a/plan.md';
    const alias = Effect.pipe(uri, EffectString.replace('threadnote://', 'ViKiNg://'));
    expect(checker.parse(alias).inputScheme).toBe('viking');
    expect(checker.parse(uri).inputScheme).toBe('threadnote');
    const scopes = ['threadnote://user/tester/memories/team-a'];
    const allowed = () => EffectArray.some(scopes, scope => checker.isWithin(uri, scope));
    expect(allowed()).toBe(true);
    scopes[0] = 'threadnote://user/tester/memories/team-b';
    expect(allowed()).toBe(false);
    scopes[0] = 'threadnote://user/tester/memories/team-a';
    expect(allowed()).toBe(true);
  });

  it('preserves candidate-before-root errors, lazy root order and fresh failures', () => {
    const checker = makeResourceIdScopeChecker();
    const failure = (candidate: string, root: string) => {
      try {
        checker.isWithin(candidate, root);
        throw new Error('Expected invalid URI');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidResourceId);
        if (!Schema.is(InvalidResourceId)(error)) throw error;
        return error;
      }
    };
    expect(failure('bad-candidate', 'bad-root').input).toBe('bad-candidate');
    const valid = 'threadnote://user/tester/memories/team-a';
    const first = failure(valid, 'bad-root');
    expect(first.input).toBe('bad-root');
    expect(failure(valid, 'bad-root')).not.toBe(first);
    expect(EffectArray.some([valid, 'bad-unused-root'], root => checker.isWithin(valid, root))).toBe(true);
    expect(() =>
      EffectArray.some(['threadnote://share/other', 'bad-root', valid], root => checker.isWithin(valid, root)),
    ).toThrow(InvalidResourceId);
  });

  it('bounds retained entries and keeps uncached overflow values equivalent', () => {
    const checker = makeResourceIdScopeChecker();
    const first = checker.parse('threadnote://user/first');
    for (let index = 0; index < 4096; index++) checker.parse(`threadnote://user/entry-${index}`);
    expect(checker.parse('threadnote://user/first')).toBe(first);
    const uri = 'threadnote://user/overflow';
    expect(checker.parse(uri)).toEqual(parseResourceId(uri));
    expect(checker.parse(uri)).not.toBe(checker.parse(uri));
  });

  it('bounds retained characters independently of the entry limit', () => {
    const checker = makeResourceIdScopeChecker();
    const longPath = Array.from({length: 64}, () => Effect.pipe('a', EffectString.repeat(200)));
    const firstUri = canonicalResourceUri('user', [...longPath, 'first']);
    const first = checker.parse(firstUri);
    for (let index = 0; index < 40; index++)
      checker.parse(canonicalResourceUri('user', [...longPath, `entry-${index}`]));
    expect(checker.parse(firstUri)).toBe(first);
    const overflow = canonicalResourceUri('user', [...longPath, 'overflow']);
    expect(checker.parse(overflow)).toEqual(parseResourceId(overflow));
    expect(checker.parse(overflow)).not.toBe(checker.parse(overflow));
  });

  fcProp(
    it,
    'matches uncached parsing and scope membership for generated aliases and anchors',
    {
      namespace: portableSegmentArbitrary,
      rootSegments: FC.array(portableSegmentArbitrary, {maxLength: 5}),
      childSegments: FC.array(portableSegmentArbitrary, {maxLength: 5}),
      anchor: optionalAnchorArbitrary,
    },
    ({namespace, rootSegments, childSegments, anchor}) => {
      const checker = makeResourceIdScopeChecker();
      const root = canonicalResourceUri(namespace, rootSegments, anchor);
      const candidate = canonicalResourceUri(namespace, [...rootSegments, ...childSegments], anchor);
      const inputs = [root, candidate, Effect.pipe(candidate, EffectString.replace('threadnote://', 'ViKiNg://'))];
      for (const input of inputs) {
        expect(checker.parse(input)).toEqual(parseResourceId(input));
        for (const scope of inputs) expect(checker.isWithin(input, scope)).toBe(resourceIdIsWithin(input, scope));
      }
    },
    {fastCheck: {numRuns: 250}},
  );
});
