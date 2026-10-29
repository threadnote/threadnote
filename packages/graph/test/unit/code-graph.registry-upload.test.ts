import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {parseGraphShareRegistryTarget} from '@threadnote/graph/sharing/registry/reference';
import {parseGraphShareRegistryUploadLocation} from '@threadnote/graph/sharing/registry/upload';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

const target = parseGraphShareRegistryTarget('oci://registry.example.test/acme/canonical');
const path = '/v2/acme/canonical/blobs/uploads/session-123';

describe('registry upload session authority', () => {
  it('preserves the opaque query exactly for absolute and relative same-repository locations', () => {
    const location = path + '?_state=a%2fb%2B%3D&token=x+y';
    expect(parseGraphShareRegistryUploadLocation(target, location)).toBe(location);
    expect(parseGraphShareRegistryUploadLocation(target, target.origin + location)).toBe(location);
  });

  it('confines generated session locations without reserializing signed query bytes', () => {
    const component = FC.array(FC.constantFrom(...'abcXYZ012_-'), {minLength: 1, maxLength: 64}).map(x =>
      EffectArray.join(x, ''),
    );
    FC.assert(
      FC.property(component, component, FC.boolean(), (session, state, absolute) => {
        const location = `/v2/acme/canonical/blobs/uploads/${session}?_state=${state}%2f%3D+x`;
        const accepted = parseGraphShareRegistryUploadLocation(target, (absolute ? target.origin : '') + location);
        expect(accepted).toBe(location);
        const url = new URL(accepted, target.origin);
        expect(url.origin).toBe(target.origin);
        expect(Effect.pipe(url.pathname, EffectString.startsWith('/v2/acme/canonical/blobs/uploads/'))).toBe(true);
        expect(url.search).toBe(`?_state=${state}%2f%3D+x`);
        expect(() =>
          parseGraphShareRegistryUploadLocation(target, 'https://foreign.example.test' + location),
        ).toThrow();
      }),
      {numRuns: 80},
    );
  });

  it('rejects foreign, ambiguous and privileged locations with closed errors', () => {
    for (const location of [
      undefined,
      '//registry.example.test' + path,
      'https://user@registry.example.test' + path,
      'http://registry.example.test' + path,
      'https://registry.example.test:443' + path,
      '/v2/acme/worker/blobs/uploads/session',
      '/v2/acme/canonical/blobs/uploads/../session',
      '/v2/acme/canonical/blobs/uploads/%73ession',
      '/v2/acme/canonical/blobs/uploads/session/next',
      path + '#fragment',
      path + '?digest=sha256:aaa',
      path + '?%64igest=sha256:aaa',
      path + '?from=acme/other',
      path + '?mount=sha256:aaa',
      path + '?_state=one&%5fstate=two',
      path + '?a=raw space',
      path + '?',
      path + '?_state=' + Effect.pipe('x', EffectString.repeat(8192)),
    ]) {
      expect(() => parseGraphShareRegistryUploadLocation(target, location)).toThrow(
        'Registry upload location is invalid.',
      );
    }
  });
});
