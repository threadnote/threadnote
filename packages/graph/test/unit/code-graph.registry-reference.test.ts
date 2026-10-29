import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {parseGraphShareRegistryTarget} from '@threadnote/graph/sharing/registry/reference';
import {parseGraphShareRegistryChallenge} from '@threadnote/graph/sharing/registry/auth';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

const name = FC.array(FC.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), {minLength: 1, maxLength: 20}).map(
  chars => EffectArray.join(chars, ''),
);
describe('trusted registry targets', () => {
  it('keeps generated repositories and token scopes confined to their exact authority', () => {
    FC.assert(
      FC.property(
        name,
        FC.array(name, {minLength: 1, maxLength: 5}),
        FC.integer({min: 1, max: 65535}),
        (host, parts, port) => {
          const reference = `oci://registry-${host}.example.test:${port}/${EffectArray.join(parts, '/')}`;
          const target = parseGraphShareRegistryTarget(reference);
          expect(target.repository).toBe(EffectArray.join(parts, '/'));
          expect(target.origin).toBe(new URL(`https://registry-${host}.example.test:${port}`).origin);
          expect(target.pullScope).toBe(`repository:${EffectArray.join(parts, '/')}:pull`);
          expect(new URL(`/v2/${target.repository}/blobs/sha256:abc`, target.origin).pathname).toBe(
            `/v2/${EffectArray.join(parts, '/')}/blobs/sha256:abc`,
          );
          expect(
            parseGraphShareRegistryChallenge(
              `Bearer realm="${target.origin}/token",scope="${target.pullScope}"`,
              target,
            ),
          ).toEqual({kind: 'bearer', realm: `${target.origin}/token`});
          expect(() =>
            parseGraphShareRegistryChallenge(
              `Bearer realm="${target.origin}/token",scope="${target.pullScope},push"`,
              target,
            ),
          ).toThrow();
        },
      ),
      {numRuns: 80},
    );
  });
  it('rejects credentials, path aliases, unsupported schemes, case changes and invalid ports', () => {
    for (const value of [
      'https://registry.example.test/repo',
      'oci://127.1/repo',
      'oci://900.555.66/repo',
      'oci://user@registry.example.test/repo',
      'oci://registry.example.test/a/../other',
      'oci://registry.example.test/a/%2e%2e/other',
      'oci://registry.example.test/a//b',
      'oci://registry.example.test/A',
      'oci://registry.example.test/repo?other',
      'oci://registry.example.test/repo#tag',
      'oci://registry.example.test:0/repo',
      'oci://registry.example.test:65536/repo',
      'oci://registry.example.test:0443/repo',
      'oci://registry.example.test/' + Effect.pipe('a', EffectString.repeat(256)),
    ])
      expect(() => parseGraphShareRegistryTarget(value)).toThrow();
  });
  it('rejects ambiguous, malformed and foreign authentication challenges', () => {
    const target = parseGraphShareRegistryTarget('oci://registry.example.test/repo');
    for (const value of [
      undefined,
      'Digest realm="fixture"',
      'Bearer realm="https://foreign.example.test/token"',
      'Bearer realm="https://registry.example.test/token",realm="https://foreign.example.test/token"',
      'Bearer realm="https://registry.example.test/../token"',
      'Bearer realm="https://registry.example.test/%74oken"',
      'Bearer realm="https://registry.example.test/token#fragment"',
      'Bearer realm="https://user@registry.example.test/token"',
    ])
      expect(() => parseGraphShareRegistryChallenge(value, target)).toThrow();
  });

  it('allows only the selected writer repository capability and its challenge subsets', () => {
    const target = parseGraphShareRegistryTarget('oci://registry.example.test/acme/canonical');
    const challenge = (scope: string) => `Bearer realm="${target.origin}/token",scope="${scope}"`;
    for (const actions of ['pull', 'push', 'pull,push', 'push,pull']) {
      expect(
        parseGraphShareRegistryChallenge(challenge(`repository:acme/canonical:${actions}`), target, 'write'),
      ).toEqual({
        kind: 'bearer',
        realm: `${target.origin}/token`,
      });
    }
    for (const scope of [
      'repository:acme/worker:pull,push',
      'repository:acme/canonical:pull,push,delete',
      'repository:acme/canonical:pull,pull',
      'repository:acme/canonical:',
      'registry:catalog:*',
    ]) {
      expect(() => parseGraphShareRegistryChallenge(challenge(scope), target, 'write')).toThrow();
    }
    expect(() => parseGraphShareRegistryChallenge(challenge('repository:acme/canonical:push'), target)).toThrow();
  });
});
