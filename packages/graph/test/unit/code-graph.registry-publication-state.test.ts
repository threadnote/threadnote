import {expect, it} from 'vitest';
import fc from 'fast-check';
import {sha256Digest} from '@threadnote/graph/sharing/digest';
import {
  assertGraphSharePublicationProgress,
  graphSharePublicationAuthority,
} from '@threadnote/graph/sharing/registry/publication_state';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const candidate = (generation: number, publisherFence = 1) => ({
  descriptorDigest: sha256Digest(`descriptor-${generation}`),
  envelopeDigest: sha256Digest(`envelope-${generation}`),
  generation,
  historyFloor: {generation: 1, sourceCommit: Effect.pipe('a', EffectString.repeat(40))},
  manifestDigest: sha256Digest(`manifest-${generation}`),
  publisherFence,
  retentionDigest: sha256Digest(`retention-${generation}`),
  sourceCommit: Effect.pipe('b', EffectString.repeat(40)),
});

it('publication progress is monotonic and rejects conflicting identities without mutating receipts', () => {
  fc.assert(
    fc.property(fc.integer({min: 1, max: 999_999}), generation => {
      const previous = candidate(generation);
      const snapshot = structuredClone(previous);
      expect(() => assertGraphSharePublicationProgress(previous, previous)).not.toThrow();
      expect(() => assertGraphSharePublicationProgress(previous, candidate(generation + 1))).not.toThrow();
      expect(() => assertGraphSharePublicationProgress(candidate(generation + 1), previous)).toThrow();
      expect(() =>
        assertGraphSharePublicationProgress(previous, {...previous, descriptorDigest: sha256Digest('conflict')}),
      ).toThrow();
      expect(() => assertGraphSharePublicationProgress(candidate(generation, 2), candidate(generation + 1))).toThrow();
      expect(previous).toEqual(snapshot);
    }),
    {numRuns: 60},
  );
});

it('isolates receipt authority by every trust and registry dimension, normalizing the default TLS port', () => {
  const scope = {
    repositoryId: Effect.pipe('a', EffectString.repeat(64)),
    branch: 'refs/heads/main',
    profileDigest: sha256Digest('profile'),
    publisherKeyFingerprint: sha256Digest('key'),
  };
  const canonical = 'oci://registry.example.test/org/canonical';
  const authority = graphSharePublicationAuthority(scope, canonical);
  expect(graphSharePublicationAuthority(scope, 'oci://registry.example.test:443/org/canonical')).toBe(authority);
  for (const modified of [
    {...scope, branch: 'refs/heads/other'},
    {...scope, repositoryId: Effect.pipe('b', EffectString.repeat(64))},
    {...scope, profileDigest: sha256Digest('other')},
    {...scope, publisherKeyFingerprint: sha256Digest('other')},
  ]) {
    expect(graphSharePublicationAuthority(modified, canonical)).not.toBe(authority);
  }
  expect(graphSharePublicationAuthority(scope, 'oci://registry.example.test/org/worker')).not.toBe(authority);
  expect(graphSharePublicationAuthority(scope, 'oci://other.example.test/org/canonical')).not.toBe(authority);
});
