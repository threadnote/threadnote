import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {makeSourceConfigurationRegistry, makeSourceConfigurationStore} from '@threadnote/integration-runtime/config';
import {
  obsidianSourceCodec,
  obsidianProjectionCodec,
  upsertObsidianSource,
  upsertObsidianProjection,
  requireObsidianSource,
  ObsidianConfigurationError,
} from '../src/config.js';
import {SourceConfigurationError} from '@threadnote/integration-core/config';
const registry = makeSourceConfigurationRegistry({
  sources: [obsidianSourceCodec],
  projections: [obsidianProjectionCodec],
});
const emptyObsidianConfiguration = registry.empty;
const parseObsidianConfiguration = registry.parse;
const renderObsidianConfiguration = registry.render;

describe('Obsidian configuration', () => {
  effectIt.effect('preserves Obsidian validation failures through configuration persistence', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentContextHome = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(agentContextHome, 'threadnote');
      yield* fs.makeDirectory(directory);
      yield* fs.writeFileString(
        path.join(directory, 'sources.yaml'),
        'version: 1\nsources: [{type: obsidian, id: vault, include: []}]\nprojections: []',
      );
      const failure = yield* makeSourceConfigurationStore(registry).read({agentContextHome}).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ObsidianConfigurationError);
    }).pipe(effect =>
      Effect.scoped(
        Layer.build(BunServices.layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
      ),
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

  it('retains provider validation errors and uses neutral errors for unknown providers', () => {
    expect(() =>
      parseObsidianConfiguration('version: 1\nsources: [{type: obsidian, id: vault, include: []}]\nprojections: []'),
    ).toThrow(ObsidianConfigurationError);
    expect(() =>
      parseObsidianConfiguration('version: 2\nsources: [{type: unknown, id: other}]\nprojections: []'),
    ).toThrow(SourceConfigurationError);
  });
});
