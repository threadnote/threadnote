import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {
  emptyObsidianConfiguration,
  mutateSourceConfiguration,
  parseObsidianConfiguration,
  readSourceConfiguration,
  removeObsidianSource,
  renderObsidianConfiguration,
  requireObsidianSource,
  requireSuperhumanSource,
  upsertObsidianProjection,
  upsertObsidianSource,
  upsertSuperhumanSource,
  validateSuperhumanDocumentId,
} from '@threadnote/threadnote/integrations/config';

describe('Registered source configuration composition', () => {
  effectIt.effect('serializes concurrent mixed-source read-modify-write transactions', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const agentContextHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-source-config-'});
        const config = {agentContextHome};
        yield* Effect.all(
          [
            mutateSourceConfiguration(config, current =>
              upsertObsidianSource(current, {
                enabled: true,
                exclude: [],
                id: 'vault',
                include: ['**/*.md'],
                type: 'obsidian',
                vault: '/vault',
                watch: false,
              }),
            ),
            mutateSourceConfiguration(config, current =>
              upsertSuperhumanSource(current, {
                type: 'superhuman',
                id: 'docs',
                enabled: true,
                credentialEnv: 'SUPERHUMAN_DOCS_API_TOKEN',
                project: null,
                documents: [{id: 'Doc_Inner_S'}],
                includeHidden: false,
                refreshIntervalMinutes: 15,
                maxStaleHours: 24,
              }),
            ),
          ],
          {concurrency: 2},
        );
        const result = yield* readSourceConfiguration(config);
        expect(result.version).toBe(2);
        expect(result.sources.map(source => source.id).sort()).toEqual(['docs', 'vault']);
      }).pipe(provideTestLayer(Layer.merge(BunServices.layer, TestSystemInfoLayer))),
    ),
  );

  it('upgrades only when a Superhuman source is added and retains Obsidian projections', () => {
    const legacy = upsertObsidianProjection(emptyObsidianConfiguration(), {
      enabled: true,
      folder: 'Threadnote',
      id: 'memories',
      includeShared: true,
      kinds: ['durable'],
      statuses: ['active'],
      type: 'obsidian',
      vault: '/vault',
    });
    expect(parseObsidianConfiguration(renderObsidianConfiguration(legacy))).toEqual(legacy);
    const mixed = upsertSuperhumanSource(legacy, {
      type: 'superhuman',
      id: 'docs',
      enabled: true,
      credentialEnv: 'SUPERHUMAN_DOCS_API_TOKEN',
      project: null,
      documents: [{id: 'Doc_Inner_S', pages: ['Page_A']}],
      includeHidden: false,
      refreshIntervalMinutes: 15,
      maxStaleHours: 24,
    });
    expect(mixed.version).toBe(2);
    expect(parseObsidianConfiguration(renderObsidianConfiguration(mixed))).toEqual(mixed);
    expect(requireSuperhumanSource(mixed, 'docs').documents[0]?.id).toBe('Doc_Inner_S');
    expect(() => requireObsidianSource(mixed, 'docs')).toThrow(/No Obsidian source/);
    const changedProjection = upsertObsidianProjection(mixed, {...mixed.projections[0], folder: 'Updated'});
    expect(requireSuperhumanSource(changedProjection, 'docs')).toEqual(requireSuperhumanSource(mixed, 'docs'));
    expect(parseObsidianConfiguration(renderObsidianConfiguration(changedProjection))).toEqual(changedProjection);
    expect(requireSuperhumanSource(removeObsidianSource(mixed, 'docs'), 'docs')).toEqual(
      requireSuperhumanSource(mixed, 'docs'),
    );
  });

  it('rejects invalid or duplicate provider IDs and cross-provider source ID replacement', () => {
    expect(() => validateSuperhumanDocumentId('Doc_Inner_S')).not.toThrow();
    for (const invalid of ['a/b', 'a.b', 'a b', 'x'.repeat(129), 'con', 'CON', 'NUL', 'COM1']) {
      expect(() => validateSuperhumanDocumentId(invalid)).toThrow();
    }
    const source = {
      type: 'superhuman' as const,
      id: 'docs',
      enabled: true,
      credentialEnv: 'SUPERHUMAN_DOCS_API_TOKEN',
      project: null,
      documents: [{id: 'Doc_Inner_S'}],
      includeHidden: false,
      refreshIntervalMinutes: 15,
      maxStaleHours: 24,
    };
    for (const id of ['docs.', 'con'])
      expect(() => upsertSuperhumanSource(emptyObsidianConfiguration(), {...source, id})).toThrow();
    expect(() =>
      upsertSuperhumanSource(emptyObsidianConfiguration(), {...source, documents: [{id: 'doc_1', pages: ['CON']}]}),
    ).toThrow();
    expect(() =>
      upsertSuperhumanSource(
        upsertObsidianSource(emptyObsidianConfiguration(), {
          enabled: true,
          exclude: [],
          id: 'docs',
          include: ['**/*.md'],
          type: 'obsidian',
          vault: '/vault',
          watch: false,
        }),
        source,
      ),
    ).toThrow(/another type/);
  });
});
