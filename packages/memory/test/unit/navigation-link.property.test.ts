import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Array as EffectArray, String as EffectString} from 'effect';
import {canonicalResourceUri} from '@threadnote/store/resource-id';
import {
  decodeMemoryLaunchUri,
  decodeMemoryLinkFragment,
  encodeMemoryLinkFragment,
  formatMemoryLink,
  memoryLaunchUri,
  memoryLinkHref,
  memoryNavigationTarget,
} from '@threadnote/memory/navigation-link';

const idPart = FC.array(FC.constantFrom('a', 'Z', '0', '-', '_'), {minLength: 1, maxLength: 64}).map(parts =>
  EffectArray.join(parts, ''),
);
const pathPart = FC.array(FC.constantFrom('a', 'Z', '0', 'é', '中', '😀'), {minLength: 1, maxLength: 16}).map(parts =>
  EffectArray.join(parts, ''),
);

describe('memory navigation links', () => {
  fcProp(
    it,
    'round-trips stable identities without introducing authority',
    {id: idPart},
    ({id}) => {
      const target = {kind: 'id' as const, ref: `tn_${id}`};
      const fragment = encodeMemoryLinkFragment(target);
      expect(decodeMemoryLinkFragment(fragment)).toEqual(target);
      expect(decodeMemoryLaunchUri(memoryLaunchUri(target))).toEqual(target);
      expect(fragment).toBe(encodeMemoryLinkFragment(target));
      expect(memoryLinkHref(target)).toBe(`https://threadnote.io/open/#${fragment}`);
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'preserves canonical Unicode memory URIs',
    {user: pathPart, topic: pathPart},
    ({user, topic}) => {
      const uri = canonicalResourceUri('user', [user, 'memories', 'durable', 'projects', 'test', `${topic}.md`]);
      const target = memoryNavigationTarget(uri);
      expect(decodeMemoryLinkFragment(encodeMemoryLinkFragment(target))).toEqual({kind: 'uri', ref: uri});
    },
    {fastCheck: {numRuns: 150}},
  );

  it('prefers a verified stable ID supplied by the caller and retains exact legacy URI semantics otherwise', () => {
    const uri = 'threadnote://user/alice/memories/durable/projects/project/note.md';
    expect(memoryNavigationTarget(uri, 'tn_abc')).toEqual({kind: 'id', ref: 'tn_abc'});
    expect(memoryNavigationTarget(uri)).toEqual({kind: 'uri', ref: uri});
    expect(memoryNavigationTarget('threadnote://memory/tn_abc')).toEqual({kind: 'id', ref: 'tn_abc'});
    expect(() => memoryNavigationTarget('threadnote://memory/tn_abc', 'tn_other')).toThrow();
    expect(() => memoryNavigationTarget('threadnote://share/remote/note.md', 'tn_abc')).toThrow();
  });

  it.each([
    'threadnote://user/alice/memories/durable/projects/project/note.md#body',
    'threadnote://user/alice/memories/durable/projects/project/note.md?token=secret',
    'threadnote://share/remote/memories/durable/project/note.md',
    'viking://user/alice/memories/durable/projects/project/note.md',
    'memories/durable/projects/project/note.md',
    'threadnote://user/alice/memories',
  ])('rejects unsupported or ambiguous URI %s', uri => {
    expect(() => memoryNavigationTarget(uri)).toThrow();
  });

  it('rejects malformed selectors, extra fields and non-canonical JSON', () => {
    const target = {kind: 'id' as const, ref: 'tn_abc'};
    for (const fragment of [
      'v2.AA',
      'v1.not+base64',
      'v1.' + EffectString.repeat(7000)('A'),
      'v1.' + Buffer.from(JSON.stringify({...target, token: 'secret'})).toString('base64url'),
      'v1.' + Buffer.from('{"ref":"tn_abc","kind":"id"}').toString('base64url'),
    ])
      expect(() => decodeMemoryLinkFragment(fragment)).toThrow();
    expect(() => decodeMemoryLaunchUri('threadnote://other/v1#' + encodeMemoryLinkFragment(target))).toThrow();
    expect(() => decodeMemoryLaunchUri(memoryLaunchUri(target) + '&redirect=https://elsewhere')).toThrow();
  });

  it('escapes hostile labels while keeping the encoded target separate', () => {
    const target = {kind: 'id' as const, ref: 'tn_abc'};
    const link = formatMemoryLink(target, '[other](https://elsewhere)');
    expect(link).toContain('\\[other\\]\\(https://elsewhere\\)');
    expect(EffectString.endsWith(`](${memoryLinkHref(target)})`)(link)).toBe(true);
  });
});
