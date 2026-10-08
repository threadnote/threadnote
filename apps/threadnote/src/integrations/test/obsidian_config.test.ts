import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import fc from 'fast-check';
import {Effect, FileSystem, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {provideTestLayer} from '../../../test/helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../../../test/helpers/system-layer.js';
import {
  emptyObsidianConfiguration,
  mutateSourceConfiguration,
  normalizeGitHubRepository,
  parseObsidianConfiguration,
  readSourceConfiguration,
  removeObsidianSource,
  renderObsidianConfiguration,
  requireObsidianSource,
  requireGitHubSource,
  requireSuperhumanSource,
  sourceConfigurationFingerprint,
  upsertObsidianProjection,
  upsertObsidianSource,
  upsertGitHubSource,
  upsertSuperhumanSource,
  validateSuperhumanDocumentId,
} from '@threadnote/threadnote/integrations/config';

describe('Obsidian source configuration', () => {
  it('does not include configuration bytes in malformed YAML errors', () => {
    const privateValue = 'SYNTHETIC_PRIVATE_CONFIGURATION_SENTINEL';
    let failure: unknown;
    try {
      parseObsidianConfiguration(`version: 2\nsources: [${privateValue}\nprojections: []`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain(privateValue);
    expect(JSON.stringify(failure)).not.toContain(privateValue);
  });

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

  it('round-trips versioned sources and projections', () => {
    const configuration = upsertObsidianProjection(
      upsertObsidianSource(emptyObsidianConfiguration(), {
        enabled: true,
        exclude: ['.obsidian/**', 'Personal/**'],
        id: 'engineering',
        inbox: 'Threadnote Inbox',
        include: ['Engineering/**'],
        type: 'obsidian',
        vault: '/vault',
        watch: false,
      }),
      {
        enabled: true,
        folder: 'Threadnote',
        id: 'memory',
        includeShared: true,
        kinds: ['durable', 'handoff'],
        selectedUris: ['threadnote://user/tester/memories/durable/projects/threadnote/obsidian.md'],
        statuses: ['active'],
        type: 'obsidian',
        vault: '/vault',
      },
    );

    expect(parseObsidianConfiguration(renderObsidianConfiguration(configuration))).toEqual(configuration);
  });

  it('requires an explicit source allowlist', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /vault',
          '    include: []',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/include must contain at least one allowlist pattern/i);
  });

  it('preserves configurations without selected_uris as legacy all-matching projections', () => {
    const configuration = parseObsidianConfiguration(
      [
        'version: 1',
        'sources: []',
        'projections:',
        '  - id: memory',
        '    type: obsidian',
        '    vault: /vault',
        '    folder: Threadnote',
      ].join('\n'),
    );

    expect(configuration.projections[0]?.selectedUris).toBeUndefined();
  });

  it('accepts only canonical memory resources in projection selections', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources: []',
          'projections:',
          '  - id: memory',
          '    type: obsidian',
          '    vault: /vault',
          '    folder: Threadnote',
          '    selected_uris:',
          '      - threadnote://resources/external/obsidian/vault/Note.md',
        ].join('\n'),
      ),
    ).toThrow(/only canonical Threadnote memory URIs/i);
  });

  it('rejects unsafe projection folders and duplicate identifiers', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources: []',
          'projections:',
          '  - id: memory',
          '    type: obsidian',
          '    vault: /vault',
          '    folder: ../outside',
        ].join('\n'),
      ),
    ).toThrow(/safe vault-relative folder/i);

    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /vault',
          '    include: ["Engineering/**"]',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /other',
          '    include: ["Docs/**"]',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/duplicate source id/i);
  });

  it('rejects source traversal patterns and unsafe Inbox folders', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /vault',
          '    include: ["../Private/**"]',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/vault-relative patterns without parent traversal/i);

    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: /vault',
          '    include: ["Engineering/**"]',
          '    inbox: ../Inbox',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/safe vault-relative folder/i);
  });

  it('requires absolute vault paths and accepts native Windows paths', () => {
    expect(() =>
      parseObsidianConfiguration(
        [
          'version: 1',
          'sources:',
          '  - id: engineering',
          '    type: obsidian',
          '    vault: relative/vault',
          '    include: ["Engineering/**"]',
          'projections: []',
        ].join('\n'),
      ),
    ).toThrow(/vault must be an absolute path/i);

    const configuration = parseObsidianConfiguration(
      [
        'version: 1',
        'sources:',
        '  - id: engineering',
        '    type: obsidian',
        '    vault: "C:\\\\Users\\\\example\\\\Vault"',
        '    include: ["Engineering/**"]',
        'projections: []',
      ].join('\n'),
    );
    expect(requireObsidianSource(configuration, 'engineering').vault).toBe('C:\\Users\\example\\Vault');
  });

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

  it('round-trips GitHub repository allowlists and fingerprints independently of repository order', () => {
    const name = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), {minLength: 1, maxLength: 12})
      .map(parts => `r${parts.join('')}`);
    fc.assert(
      fc.property(fc.uniqueArray(name, {minLength: 1, maxLength: 8}), fc.boolean(), (names, local) => {
        const source = {
          type: 'github' as const,
          id: 'github',
          enabled: true,
          credentialEnv: 'THREADNOTE_GITHUB_TOKEN',
          ...(local ? {credentialStorage: 'local' as const} : {}),
          project: 'engineering',
          repositories: names.map(value => `Owner/${value}`),
          refreshIntervalMinutes: 15,
          maxStaleHours: 24,
        };
        const configuration = upsertGitHubSource(emptyObsidianConfiguration(), source);
        const parsed = parseObsidianConfiguration(renderObsidianConfiguration(configuration));
        expect(parsed).toEqual(configuration);
        expect(requireGitHubSource(parsed, 'github').repositories).toEqual(names.map(value => `owner/${value}`).sort());
        expect(sourceConfigurationFingerprint(source)).toBe(
          sourceConfigurationFingerprint({...source, repositories: [...source.repositories].reverse()}),
        );
      }),
      {numRuns: 40},
    );
  });

  it('accepts only GitHub repository roots and rejects duplicate canonical repositories', () => {
    expect(normalizeGitHubRepository('https://github.com/Owner/Repo/')).toBe('owner/repo');
    for (const invalid of [
      'https://evil.example/Owner/Repo',
      'http://github.com/Owner/Repo',
      'https://github.com/Owner/Repo/issues',
      'https://github.com/Owner/Repo?tab=readme',
      'Owner/../Repo',
      'Owner/Repo/extra',
    ])
      expect(() => normalizeGitHubRepository(invalid)).toThrow();
    expect(() =>
      upsertGitHubSource(emptyObsidianConfiguration(), {
        type: 'github',
        id: 'github',
        enabled: true,
        credentialEnv: 'THREADNOTE_GITHUB_TOKEN',
        project: null,
        repositories: ['Owner/Repo', 'https://github.com/owner/repo'],
        refreshIntervalMinutes: 15,
        maxStaleHours: 24,
      }),
    ).toThrow(/duplicate repositories/);
  });
});
