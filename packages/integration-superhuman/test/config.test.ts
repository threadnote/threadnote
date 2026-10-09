import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {makeSourceConfigurationRegistry} from '@threadnote/integration-runtime/config';
import {superhumanSourceCodec, upsertSuperhumanSource, sourceConfigurationFingerprint} from '../src/config.js';
const registry = makeSourceConfigurationRegistry({sources: [superhumanSourceCodec], projections: []});
const emptyObsidianConfiguration = registry.empty;
const parseObsidianConfiguration = registry.parse;
const renderObsidianConfiguration = registry.render;

describe('Superhuman configuration', () => {
  it('round-trips bounded mixed document allowlists and fingerprints are order-insensitive', () => {
    const idArb = fc
      .array(fc.constantFrom('A', 'b', '3', '_', '-'), {minLength: 1, maxLength: 12})
      .map(chars => chars.join(''));
    fc.assert(
      fc.property(
        fc.uniqueArray(idArb, {minLength: 1, maxLength: 8}),
        fc.array(idArb, {maxLength: 8}),
        fc.boolean(),
        (ids, pageIds, localCredential) => {
          const pages = [...new Set(pageIds)];
          const source = {
            type: 'superhuman' as const,
            id: 'docs',
            enabled: true,
            credentialEnv: 'SUPERHUMAN_DOCS_API_TOKEN',
            ...(localCredential ? {credentialStorage: 'local' as const} : {}),
            project: 'engineering',
            documents: ids.map((id, index) => ({id, ...(index === 0 && pages.length ? {pages} : {})})),
            includeHidden: false,
            refreshIntervalMinutes: 15,
            maxStaleHours: 24,
          };
          const config = upsertSuperhumanSource(emptyObsidianConfiguration(), source);
          expect(parseObsidianConfiguration(renderObsidianConfiguration(config))).toEqual(config);
          const alternate = {...source, credentialStorage: localCredential ? undefined : ('local' as const)};
          expect(sourceConfigurationFingerprint(alternate)).not.toBe(sourceConfigurationFingerprint(source));
          expect(sourceConfigurationFingerprint({...source, documents: [...source.documents].reverse()})).toBe(
            sourceConfigurationFingerprint(source),
          );
        },
      ),
      {numRuns: 40},
    );
  });
});
