import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  formatRemoteMemoryUri,
  formatRemoteShareRootUri,
  InvalidRemoteMemoryAlias,
  parseRemoteShareAddress,
  remoteShareUriIsWithin,
  resolveRemoteMemoryAlias,
} from '@threadnote/memory/remote/address';
import {Array as EffectArray} from 'effect';

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

const portableSegmentArbitrary = FC.oneof(
  FC.constantFrom('a', 'Z', '0', 'é', '中', 'क', '😀'),
  FC.tuple(FC.array(segmentMiddleArbitrary, {maxLength: 12}), segmentBoundaryArbitrary).map(
    ([middle, finalCharacter]) => `seg-${EffectArray.join(middle, '')}${finalCharacter}`,
  ),
);

describe('remote memory addresses', () => {
  it('formats the immutable roots and documented durable and handoff layouts', () => {
    expect(formatRemoteShareRootUri('shr_01')).toBe('threadnote://share/shr_01/memories');
    expect(remoteShareUriIsWithin(formatRemoteShareRootUri('shr_01'), 'shr_01')).toBe(true);
    expect(remoteShareUriIsWithin('threadnote://share/shr_01/memories/durable', 'shr_01')).toBe(true);
    expect(formatRemoteMemoryUri({kind: 'durable', project: 'threadnote', shareId: 'shr_01', topic: 'decision'})).toBe(
      'threadnote://share/shr_01/memories/durable/threadnote/decision.md',
    );
    expect(formatRemoteMemoryUri({kind: 'handoff', project: 'threadnote', shareId: 'shr_01', topic: 'release'})).toBe(
      'threadnote://share/shr_01/memories/handoffs/active/threadnote/release.md',
    );
  });

  fcProp(
    it,
    'round-trips arbitrary portable Unicode share, project, and topic segments',
    {
      kind: FC.constantFrom('durable' as const, 'handoff' as const),
      project: portableSegmentArbitrary,
      shareId: portableSegmentArbitrary,
      topic: portableSegmentArbitrary,
    },
    input => {
      const canonicalUri = formatRemoteMemoryUri(input);
      expect(parseRemoteShareAddress(canonicalUri)).toEqual({...input, canonicalUri});
      expect(remoteShareUriIsWithin(canonicalUri, input.shareId)).toBe(true);
    },
    {fastCheck: {numRuns: 250}},
  );

  it.each([
    'threadnote://share/shr-a/memories/durable/project/%2e%2e',
    'threadnote://share/shr-a/memories/durable/project/%2Fescape.md',
    'threadnote://share/shr-a/memories/durable/project/%5Cescape.md',
    'threadnote://share/shr-a/memories/durable/project/e%CC%81.md',
    'threadnote://share/shr-a/memories/durable/project/topic.md#fragment',
    'threadnote://share/shr-a/memories/durable/project/topic.md?revision=1',
    'threadnote://user/shr-a/memories/durable/project/topic.md',
    'viking://share/shr-a/memories/durable/project/topic.md',
  ])('rejects unsafe or non-canonical containment candidate %s', candidate => {
    expect(remoteShareUriIsWithin(candidate, 'shr-a')).toBe(false);
  });

  it('resolves a beta URI only through an alias scoped to the authorized share', () => {
    const canonicalUri = formatRemoteMemoryUri({
      kind: 'durable',
      project: 'threadnote',
      shareId: 'shr-a',
      topic: 'decision',
    });
    const aliasUri = 'threadnote://user/alice/memories/shared/team/durable/threadnote/decision.md';
    const alias = {aliasUri, canonicalUri, shareId: 'shr-a', version: 1 as const};

    expect(resolveRemoteMemoryAlias({aliases: [alias], authorizedShareId: 'shr-a', inputUri: aliasUri})).toEqual({
      address: {canonicalUri, kind: 'durable', project: 'threadnote', shareId: 'shr-a', topic: 'decision'},
      aliasUri,
      canonicalUri,
      version: 1,
    });
    expect(() => resolveRemoteMemoryAlias({aliases: [alias], authorizedShareId: 'shr-b', inputUri: aliasUri})).toThrow(
      InvalidRemoteMemoryAlias,
    );
  });

  it('never treats another remote share address as a migration alias', () => {
    const foreignUri = formatRemoteMemoryUri({kind: 'durable', project: 'p', shareId: 'shr-b', topic: 't'});
    const localUri = formatRemoteMemoryUri({kind: 'durable', project: 'p', shareId: 'shr-a', topic: 't'});

    expect(() =>
      resolveRemoteMemoryAlias({
        aliases: [{aliasUri: foreignUri, canonicalUri: localUri, shareId: 'shr-a', version: 1}],
        authorizedShareId: 'shr-a',
        inputUri: foreignUri,
      }),
    ).toThrow(InvalidRemoteMemoryAlias);
  });

  it('rejects ambiguous aliases instead of selecting by storage order', () => {
    const aliasUri = 'threadnote://user/alice/memories/shared/team/durable/p/t.md';
    const first = formatRemoteMemoryUri({kind: 'durable', project: 'p', shareId: 'shr-a', topic: 'one'});
    const second = formatRemoteMemoryUri({kind: 'durable', project: 'p', shareId: 'shr-a', topic: 'two'});

    expect(() =>
      resolveRemoteMemoryAlias({
        aliases: [
          {aliasUri, canonicalUri: first, shareId: 'shr-a', version: 1},
          {aliasUri, canonicalUri: second, shareId: 'shr-a', version: 1},
        ],
        authorizedShareId: 'shr-a',
        inputUri: aliasUri,
      }),
    ).toThrow(InvalidRemoteMemoryAlias);
  });
});
