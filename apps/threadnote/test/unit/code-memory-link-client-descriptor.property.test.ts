import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertCodeMemoryLinkClientImplementationBinding,
  codeMemoryLinkClientArgumentVectorHash,
  codeMemoryLinkClientImplementationDescriptorHash,
  codeMemoryLinkClientPathDigest,
  parseCodeMemoryLinkClientImplementationDescriptorV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const hash = (character: string) => Effect.pipe(character, EffectString.repeat(64));

describe('Code Memory Link client implementation descriptors', () => {
  it('hashes a canonical exact descriptor and rejects ambiguous artifact order', () => {
    const artifactBindings = [
      binding('client-bundle', '/reviewed/client.bundle.js', '1'),
      binding('client-entrypoint', '/reviewed/client.ts', '2'),
      binding('proxy-bundle', '/reviewed/proxy.bundle.js', '3'),
    ];
    const binaryBindings = [
      binding('client-runtime', '/reviewed/bun', '4'),
      binding('codex-app-server', '/reviewed/codex', '5'),
      binding('git', '/reviewed/git', '6'),
    ];
    const descriptor = {
      argumentVectorHash: codeMemoryLinkClientArgumentVectorHash(['adapter.ts', '--model', 'opaque-a']),
      artifactBindings,
      binaryBindings,
      configurationHash: hash('7'),
      configurationProjectionHash: hash('8'),
      dependenciesLockHash: hash('9'),
      entrypointHash: artifactBindings[1].sha256,
      environmentPolicyHash: hash('a'),
      executionBundleHash: artifactBindings[0].sha256,
      expectedClientProjectionHash: hash('b'),
      version: 2 as const,
    };

    expect(codeMemoryLinkClientImplementationDescriptorHash(descriptor)).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      parseCodeMemoryLinkClientImplementationDescriptorV1({
        ...descriptor,
        artifactBindings: [...descriptor.artifactBindings].reverse(),
      }),
    ).toThrow(/canonical order/);
    expect(() => parseCodeMemoryLinkClientImplementationDescriptorV1({...descriptor, extra: true})).toThrow(
      /unsupported or missing fields/,
    );

    const descriptorHash = codeMemoryLinkClientImplementationDescriptorHash(descriptor);
    const roster = [
      {clientId: `cli_${Effect.pipe('1', EffectString.repeat(16))}`, implementationDescriptorHash: descriptorHash},
      {clientId: `cli_${Effect.pipe('2', EffectString.repeat(16))}`, implementationDescriptorHash: hash('4')},
    ];
    expect(assertCodeMemoryLinkClientImplementationBinding({clientId: roster[0].clientId, descriptor, roster})).toBe(
      descriptorHash,
    );
    expect(() =>
      assertCodeMemoryLinkClientImplementationBinding({clientId: roster[1].clientId, descriptor, roster}),
    ).toThrow(/does not match the selected client id/);

    expect(() =>
      parseCodeMemoryLinkClientImplementationDescriptorV1({
        ...descriptor,
        artifactBindings: EffectArray.map(descriptor.artifactBindings, binding =>
          binding.role === 'client-bundle' ? {...binding, sha256: hash('c')} : binding,
        ),
      }),
    ).toThrow(/execution bundle hash differs/);
  });

  it('is deterministic and sensitive to every argument-vector element', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), {maxLength: 12}), fc.string(), (prefix, suffix) => {
        const original = codeMemoryLinkClientArgumentVectorHash(prefix);
        expect(codeMemoryLinkClientArgumentVectorHash([...prefix])).toBe(original);
        expect(codeMemoryLinkClientArgumentVectorHash([...prefix, suffix])).not.toBe(original);
      }),
      {numRuns: 100},
    );
  });
});

function binding(role: string, path: string, character: string) {
  return {pathDigest: codeMemoryLinkClientPathDigest(path), role, sha256: hash(character)};
}
