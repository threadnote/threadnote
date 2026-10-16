import {describe, expect, it} from 'vitest';
import {inferProjectFromManifest, parseSeedManifest, requireManifestWorkset} from '@threadnote/workspace/manifest';

const manifest = parseSeedManifest(
  JSON.stringify({
    version: 1,
    projects: ['product', 'product-mobile'].map(name => ({
      name,
      path: '/fixture',
      seed: [],
      uri: `threadnote://resources/repos/${name}`,
    })),
    worksets: [
      {name: 'mobile', projects: ['product-mobile']},
      {name: 'empty', projects: []},
      {name: 'incomplete', projects: ['product', 'unknown']},
    ],
  }),
  'fixture.yaml',
);

describe('recall manifest metadata', () => {
  it('returns query preferences without resolving explicit project boundaries', () => {
    expect(inferProjectFromManifest(manifest, 'Product mobile assistant')?.name).toBe('product');
    expect(inferProjectFromManifest(manifest, 'mobile assistant')?.name).toBe('product-mobile');
    expect(inferProjectFromManifest(manifest, 'product-mobile assistant')?.name).toBe('product-mobile');
  });

  it('preserves empty worksets and rejects unknown names or members explicitly', () => {
    expect(requireManifestWorkset(manifest, 'MOBILE').projects.map(project => project.name)).toEqual([
      'product-mobile',
    ]);
    expect(requireManifestWorkset(manifest, 'empty').projects).toEqual([]);
    expect(() => requireManifestWorkset(manifest, 'missing', 'fixture.yaml')).toThrow(
      'No workset named "missing" in fixture.yaml.',
    );
    expect(() => requireManifestWorkset(manifest, 'incomplete')).toThrow('unknown projects: unknown');
  });
});
