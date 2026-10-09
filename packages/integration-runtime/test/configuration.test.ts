import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {makeSourceConfigurationRegistry} from '../src/config.js';

const codec = {
  type: 'synthetic',
  versions: [2] as const,
  parse: (value: Record<string, unknown>) => ({type: 'synthetic', id: String(value.id), enabled: true}),
  serialize: (value: {readonly type: string; readonly id: string; readonly enabled: boolean}) => ({
    id: value.id,
    type: value.type,
    enabled: value.enabled,
  }),
};
const registry = makeSourceConfigurationRegistry({sources: [codec], projections: []});

describe('source configuration registry', () => {
  it('preserves source order across serialization and parsing', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/), {maxLength: 12}), ids => {
        const configuration = {
          version: 2 as const,
          sources: ids.map(id => ({type: 'synthetic', id, enabled: true})),
          projections: [],
        };
        expect(registry.parse(registry.render(configuration))).toEqual(configuration);
        expect(configuration.sources.map(source => source.id)).toEqual(ids);
      }),
      {numRuns: 50},
    );
  });

  it('rejects duplicate codec registrations and duplicate source identities', () => {
    expect(() => makeSourceConfigurationRegistry({sources: [codec, codec], projections: []})).toThrow(/Duplicate/);
    expect(() =>
      registry.parse(
        'version: 2\nsources:\n  - {type: synthetic, id: same}\n  - {type: synthetic, id: same}\nprojections: []\n',
      ),
    ).toThrow(/Duplicate source id/);
  });

  it('keeps version one restricted to compatible providers', () => {
    expect(() => registry.parse('version: 1\nsources:\n  - {type: synthetic, id: one}\nprojections: []\n')).toThrow(
      /type/,
    );
    expect(registry.empty()).toEqual({version: 1, sources: [], projections: []});
  });

  it('does not depend on later mutations of the supplied registration arrays', () => {
    const sources = [codec];
    const registered = makeSourceConfigurationRegistry({sources, projections: []});
    sources.length = 0;
    expect(
      registered.parse('version: 2\nsources:\n  - {type: synthetic, id: one}\nprojections: []\n').sources,
    ).toHaveLength(1);
  });
  it('does not include configuration bytes in malformed YAML errors', () => {
    const privateValue = 'SYNTHETIC_PRIVATE_CONFIGURATION_SENTINEL';
    let failure: unknown;
    try {
      registry.parse(`version: 2\nsources: [${privateValue}\nprojections: []`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain(privateValue);
    expect(JSON.stringify(failure)).not.toContain(privateValue);
  });
});
