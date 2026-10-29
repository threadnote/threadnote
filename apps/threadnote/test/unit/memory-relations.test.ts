import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  MAX_MEMORY_RELATIONS,
  MEMORY_RELATION_TYPES,
  formatMemoryDocument,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {discardMemoryRelocation, recordMemoryRelocation} from '@threadnote/memory/relocation';
import {
  formatMemoryRelationOption,
  normalizeMemoryRelationInputs,
  parseMemoryRelationOption,
  resolveAuthoredMemoryRelations,
} from '@threadnote/threadnote/memory/relations';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('memory relation authoring', () => {
  it('parses all five CLI relation types and rejects malformed or non-memory targets', () => {
    for (const type of MEMORY_RELATION_TYPES) {
      const relation = parseMemoryRelationOption(`${type}=threadnote://memory/tn_target`);
      expect(relation).toEqual({type, uri: 'threadnote://memory/tn_target'});
      expect(formatMemoryRelationOption(relation)).toBe(`${type}=threadnote://memory/tn_target`);
    }

    expect(() => parseMemoryRelationOption('related_to')).toThrow('<type>=<threadnote://uri>');
    expect(() => parseMemoryRelationOption('unknown=threadnote://memory/tn_target')).toThrow('Unsupported');
    expect(() => parseMemoryRelationOption('related_to=threadnote://resources/readme.md')).toThrow(
      'must identify Threadnote memories',
    );
    expect(() =>
      normalizeMemoryRelationInputs(
        Array.from({length: MAX_MEMORY_RELATIONS + 1}, (_, index) => ({
          type: 'related_to',
          uri: `threadnote://memory/tn_${index}`,
        })),
      ),
    ).toThrow(`at most ${MAX_MEMORY_RELATIONS}`);
  });

  it('round-trips and idempotently normalizes bounded stable relations', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MEMORY_RELATION_TYPES),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/u),
        (type, suffix) => {
          const relation = parseMemoryRelationOption(`${type}=threadnote://memory/tn_${suffix}`);
          expect(parseMemoryRelationOption(formatMemoryRelationOption(relation))).toEqual(relation);
          expect(normalizeMemoryRelationInputs(normalizeMemoryRelationInputs([relation]))).toEqual([relation]);
        },
      ),
      {numRuns: 100},
    );
  });

  it('normalizes relation sets independently of caller ordering without mutating input', () => {
    const relation = fc.record({
      type: fc.constantFrom(...MEMORY_RELATION_TYPES),
      uri: fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/u).map(suffix => `threadnote://memory/tn_${suffix}`),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(relation, {
          maxLength: MAX_MEMORY_RELATIONS,
          minLength: 1,
          selector: value => `${value.type}\n${value.uri}`,
        }),
        inputs => {
          const original = structuredClone(inputs);
          const expected = normalizeMemoryRelationInputs(inputs);
          expect(normalizeMemoryRelationInputs([...inputs].reverse())).toEqual(expected);
          expect(inputs).toEqual(original);
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('normalizes canonical and alias targets through one authorized live identity', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-relations-'});
      const config = yield* relationConfig(fs, path, home);
      const activeUri = yield* writeMemory(fs, path, config, 'active-target', 'tn_active_target', 'active');
      const archivedUri = yield* writeMemory(fs, path, config, 'archived-target', 'tn_archived_target', 'archived');
      const canonicalFirstUri = yield* writeMemory(fs, path, config, 'a-target', 'tn_z_target', 'active');
      const canonicalLastUri = yield* writeMemory(fs, path, config, 'z-target', 'tn_a_target', 'active');
      const scope = `threadnote://user/${config.user}/memories`;

      const canonical = yield* resolveAuthoredMemoryRelations(config, [{type: 'depends_on', uri: activeUri}], {
        allowedUriScopes: [scope],
      });
      const alias = yield* resolveAuthoredMemoryRelations(
        config,
        [{type: 'depends_on', uri: memoryIdentityAlias('tn_active_target')}],
        {allowedUriScopes: [scope]},
      );

      expect(canonical.relations).toEqual([{type: 'depends_on', uri: memoryIdentityAlias('tn_active_target')}]);
      expect(alias.relations).toEqual(canonical.relations);
      expect(canonical.targets).toEqual([expect.objectContaining({uri: activeUri})]);

      const canonicalSet = yield* resolveAuthoredMemoryRelations(
        config,
        [
          {type: 'related_to', uri: canonicalFirstUri},
          {type: 'related_to', uri: canonicalLastUri},
        ],
        {allowedUriScopes: [scope]},
      );
      const aliasSet = yield* resolveAuthoredMemoryRelations(
        config,
        [
          {type: 'related_to', uri: memoryIdentityAlias('tn_z_target')},
          {type: 'related_to', uri: memoryIdentityAlias('tn_a_target')},
        ],
        {allowedUriScopes: [scope]},
      );
      expect(canonicalSet.relations).toEqual([
        {type: 'related_to', uri: memoryIdentityAlias('tn_a_target')},
        {type: 'related_to', uri: memoryIdentityAlias('tn_z_target')},
      ]);
      expect(aliasSet).toEqual(canonicalSet);

      const duplicate = yield* Effect.flip(
        resolveAuthoredMemoryRelations(
          config,
          [
            {type: 'depends_on', uri: activeUri},
            {type: 'depends_on', uri: memoryIdentityAlias('tn_active_target')},
          ],
          {allowedUriScopes: [scope]},
        ),
      );
      expect(errorMessage(duplicate)).toContain('Duplicate');

      const self = yield* Effect.flip(
        resolveAuthoredMemoryRelations(config, [{type: 'related_to', uri: activeUri}], {
          allowedUriScopes: [scope],
          sourceMemoryId: 'tn_active_target',
        }),
      );
      expect(errorMessage(self)).toContain('cannot relate to itself');

      const inactive = yield* Effect.flip(
        resolveAuthoredMemoryRelations(config, [{type: 'references', uri: archivedUri}], {
          allowedUriScopes: [scope],
        }),
      );
      expect(errorMessage(inactive)).toContain('active');

      const scoped = yield* Effect.flip(
        resolveAuthoredMemoryRelations(config, [{type: 'references', uri: activeUri}], {
          allowedUriScopes: [`${scope}/shared/team-a`],
        }),
      );
      expect(errorMessage(scoped)).toContain('authorized memory scope');

      const movedSourceUri = yield* writeMemory(fs, path, config, 'moved-source', 'tn_private_move', 'active');
      const movedTargetUri = yield* writeMemory(fs, path, config, 'moved-target', 'tn_private_move', 'archived');
      const movedSourcePath = memoryFilePath(path, config, 'moved-source', 'active');
      const movedTargetPath = memoryFilePath(path, config, 'moved-target', 'archived');
      yield* recordMemoryRelocation(config, {
        fromContent: yield* fs.readFileString(movedSourcePath),
        fromUri: movedSourceUri,
        toContent: yield* fs.readFileString(movedTargetPath),
        toUri: movedTargetUri,
      });
      yield* fs.remove(movedSourcePath);
      const activeProjectScope = `threadnote://user/${config.user}/memories/durable/projects/threadnote`;
      const crossScopeRelocation = yield* Effect.flip(
        resolveAuthoredMemoryRelations(config, [{type: 'references', uri: movedSourceUri}], {
          allowedUriScopes: [activeProjectScope],
        }),
      );
      yield* discardMemoryRelocation(config, movedSourceUri);
      const absentTarget = yield* Effect.flip(
        resolveAuthoredMemoryRelations(config, [{type: 'references', uri: movedSourceUri}], {
          allowedUriScopes: [activeProjectScope],
        }),
      );
      expect(errorMessage(crossScopeRelocation)).toBe(errorMessage(absentTarget));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('accepts shared projection URIs even when the target has no memory_id', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-relations-shared-'});
      const config = yield* relationConfig(fs, path, home);
      const identifiedUri = yield* writeSharedMemory(fs, path, config, 'shared-identified', 'tn_shared_identified');
      const legacyUri = yield* writeSharedMemory(fs, path, config, 'shared-legacy');
      const scope = `threadnote://user/${config.user}/memories`;

      const identified = yield* resolveAuthoredMemoryRelations(config, [{type: 'related_to', uri: identifiedUri}], {
        allowedUriScopes: [scope],
      });
      expect(identified.relations).toEqual([{type: 'related_to', uri: memoryIdentityAlias('tn_shared_identified')}]);
      expect(identified.targets).toEqual([expect.objectContaining({uri: identifiedUri})]);

      const legacy = yield* resolveAuthoredMemoryRelations(config, [{type: 'related_to', uri: legacyUri}], {
        allowedUriScopes: [scope],
      });
      expect(legacy.relations).toEqual([{type: 'related_to', uri: legacyUri}]);
      expect(legacy.targets).toEqual([expect.objectContaining({uri: legacyUri})]);

      const self = yield* Effect.flip(
        resolveAuthoredMemoryRelations(config, [{type: 'related_to', uri: legacyUri}], {
          allowedUriScopes: [scope],
          sourceUri: legacyUri,
        }),
      );
      expect(errorMessage(self)).toContain('cannot relate to itself');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'round-trips shared related_to targets with or without a stable memory_id',
    {
      hasMemoryId: fc.boolean(),
      suffix: fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/u),
    },
    ({hasMemoryId, suffix}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-relations-prop-'});
        const config = yield* relationConfig(fs, path, home);
        const topic = `shared-${suffix}`;
        const uri = yield* writeSharedMemory(fs, path, config, topic, hasMemoryId ? `tn_${suffix}` : undefined);
        const resolved = yield* resolveAuthoredMemoryRelations(config, [{type: 'related_to', uri}], {
          allowedUriScopes: [`threadnote://user/${config.user}/memories`],
        });
        expect(resolved.relations).toEqual([
          {
            type: 'related_to',
            uri: hasMemoryId ? memoryIdentityAlias(`tn_${suffix}`) : uri,
          },
        ]);
      }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

const relationConfig = Effect.fn('test.relationConfig')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
) {
  const manifestPath = path.join(home, 'seed-manifest.yaml');
  yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath,
    user: 'relation-user',
  } satisfies RuntimeConfig;
});

const writeMemory = Effect.fn('test.writeRelationMemory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RuntimeConfig,
  topic: string,
  memoryId: string,
  status: 'active' | 'archived',
) {
  const lifecycle = status === 'active' ? ['durable', 'projects', 'threadnote'] : ['durable', 'archived', 'threadnote'];
  const target = memoryFilePath(path, config, topic, status);
  const root = path.dirname(target);
  yield* fs.makeDirectory(root, {recursive: true});
  const uri = `threadnote://user/${config.user}/memories/${EffectArray.join(lifecycle, '/')}/${topic}.md`;
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId,
    project: 'threadnote',
    sourceAgentClient: 'test',
    status,
    timestamp: '2026-08-31T00:00:00.000Z',
    topic,
  };
  yield* fs.writeFileString(target, formatMemoryDocument('MEMORY', metadata, `${topic} body`));
  return uri;
});

function memoryFilePath(path: Path.Path, config: RuntimeConfig, topic: string, status: 'active' | 'archived'): string {
  const lifecycle = status === 'active' ? ['durable', 'projects', 'threadnote'] : ['durable', 'archived', 'threadnote'];
  return path.join(
    config.agentContextHome,
    'data',
    config.account,
    'user',
    config.user,
    'memories',
    ...lifecycle,
    `${topic}.md`,
  );
}

const writeSharedMemory = Effect.fn('test.writeSharedRelationMemory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RuntimeConfig,
  topic: string,
  memoryId?: string,
) {
  const target = path.join(
    config.agentContextHome,
    'data',
    config.account,
    'user',
    config.user,
    'memories',
    'shared',
    'default',
    'durable',
    'projects',
    'threadnote',
    `${topic}.md`,
  );
  yield* fs.makeDirectory(path.dirname(target), {recursive: true});
  const uri = `threadnote://user/${config.user}/memories/shared/default/durable/projects/threadnote/${topic}.md`;
  const metadata: MemoryMetadata = {
    kind: 'durable',
    ...(memoryId === undefined ? {} : {memoryId}),
    project: 'threadnote',
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-08-31T00:00:00.000Z',
    topic,
    visibility: 'shared',
  };
  yield* fs.writeFileString(target, formatMemoryDocument('MEMORY', metadata, `${topic} body`));
  return uri;
});
