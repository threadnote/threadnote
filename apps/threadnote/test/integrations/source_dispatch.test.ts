import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {readSourceConfiguration} from '@threadnote/threadnote/integrations/config';
import {
  runSourceAdd,
  runSourceInventory,
  runSourceList,
  runSourceRemove,
  runSourceStatus,
  runSourceSync,
  syncSourcesBeforeRecall,
} from '@threadnote/threadnote/integrations/source';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {source as linearSource} from './linear-fixtures.js';
import {SourceCoordinator} from '@threadnote/integration-core/source-coordinator';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-source-dispatch-'}));
  const home = path.join(root, 'home');
  const vault = path.join(root, 'vault');
  yield* fs.makeDirectory(vault);
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(root, 'manifest.yaml'),
    user: 'tester',
  };
  return {config, vault};
});

describe('source provider dispatch', () => {
  effectIt.effect('requests a background refresh without syncing inline', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      const requests = yield* Ref.make<readonly RuntimeConfig[]>([]);
      const result = yield* syncSourcesBeforeRecall(config).pipe(
        Effect.provideService(SourceCoordinator, {
          requestRefresh: config => Ref.update(requests, previous => [...previous, config]),
          sync: () => Effect.die('Recall must not wait for explicit sync.'),
        }),
      );
      expect(result).toEqual({syncedSources: [], warnings: []});
      expect(yield* Ref.get(requests)).toEqual([config]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('dispatches Pocket inventory and status through the application registry', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      yield* runSourceAdd(config, {
        type: 'pocket',
        id: 'pocket-cli',
        projectless: true,
        include: [],
        documents: [],
        apply: true,
      }).pipe(captureConsole);
      const inventory = yield* runSourceInventory(config, 'pocket-cli').pipe(captureConsole);
      const status = yield* runSourceStatus(config, 'pocket-cli').pipe(captureConsole);
      expect(inventory.output).toContain('Pocket source "pocket-cli": 0 cached item(s).');
      expect(status.output).toContain('Pocket source "pocket-cli": 0 cached item(s).');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('dispatches Linear add, list, sync preview, inventory, status and removal', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      yield* runSourceAdd(config, {
        ...linearSource,
        include: [],
        documents: [],
        apply: true,
      }).pipe(captureConsole);
      expect((yield* runSourceList(config).pipe(captureConsole)).output).toContain('(linear)');
      const preview = yield* runSourceSync(config, {id: linearSource.id, apply: false}).pipe(captureConsole);
      expect(preview.value && 'syncedDocuments' in preview.value ? preview.value.syncedDocuments : undefined).toEqual(
        [],
      );
      const requested = yield* Ref.make<readonly string[]>([]);
      yield* runSourceSync(config, {id: linearSource.id, apply: true}).pipe(
        Effect.provideService(SourceCoordinator, {
          requestRefresh: () => Effect.void,
          sync: (_config, sourceId) =>
            Ref.update(requested, previous => [...previous, sourceId]).pipe(
              Effect.as({
                sourceId,
                syncedDocuments: [],
                warnings: [],
                value: {sourceId, syncedDocuments: [], warnings: []},
              }),
            ),
        }),
        captureConsole,
      );
      expect(yield* Ref.get(requested)).toEqual([linearSource.id]);
      expect((yield* runSourceInventory(config, linearSource.id).pipe(captureConsole)).value.entries).toHaveLength(0);
      expect((yield* runSourceStatus(config, linearSource.id).pipe(captureConsole)).output).toContain('Linear source');
      yield* runSourceRemove(config, {id: linearSource.id, apply: true}).pipe(captureConsole);
      expect((yield* readSourceConfiguration(config)).sources).toEqual([]);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('configures both providers and removes only the selected source after apply', () =>
    Effect.gen(function* () {
      const {config, vault} = yield* fixture;
      yield* runSourceAdd(config, {
        type: 'obsidian',
        id: 'local-notes',
        vault,
        include: ['**/*.md'],
        documents: [],
        apply: true,
      }).pipe(captureConsole);
      yield* runSourceAdd(config, {
        type: 'superhuman',
        id: 'canvas-notes',
        include: [],
        documents: ['doc_test'],
        pages: ['page_test'],
        project: 'threadnote',
        apply: true,
      }).pipe(captureConsole);
      yield* runSourceAdd(config, {
        type: 'github',
        id: 'repo-source',
        repositories: ['https://github.com/Owner/Repo'],
        credentialEnv: 'THREADNOTE_GITHUB_TOKEN',
        projectless: true,
        include: [],
        documents: [],
        apply: true,
      }).pipe(captureConsole);
      const listed = yield* runSourceList(config).pipe(captureConsole);
      expect(listed.output).toContain('local-notes (obsidian)');
      expect(listed.output).toContain('canvas-notes (superhuman)');
      expect(listed.output).toContain('repo-source (github): owner/repo');
      const inventory = yield* runSourceInventory(config, 'repo-source').pipe(captureConsole);
      expect(inventory.output).toContain('GitHub source "repo-source": 0 cached item(s).');
      const sync = yield* runSourceSync(config, {id: 'repo-source', apply: true}).pipe(
        Effect.provideService(SourceCoordinator, {
          requestRefresh: () => Effect.void,
          sync: (_config, sourceId) =>
            Effect.succeed({
              sourceId,
              syncedDocuments: [],
              warnings: ['GitHub source authentication was rejected.'],
              value: {sourceId, syncedDocuments: [], warnings: ['GitHub source authentication was rejected.']},
            }),
        }),
        captureConsole,
      );
      expect(sync.output).toContain('GitHub source authentication was rejected.');
      yield* runSourceRemove(config, {id: 'canvas-notes'}).pipe(captureConsole);
      expect((yield* readSourceConfiguration(config)).sources).toHaveLength(3);
      yield* runSourceRemove(config, {id: 'canvas-notes', apply: true}).pipe(captureConsole);
      expect((yield* readSourceConfiguration(config)).sources.map(source => source.id)).toEqual([
        'local-notes',
        'repo-source',
      ]);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('requires provider-specific configuration without writing a source', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      const noVault = yield* runSourceAdd(config, {
        type: 'obsidian',
        id: 'missing-vault',
        include: ['**/*.md'],
        documents: [],
        apply: true,
      }).pipe(Effect.exit);
      expect(Exit.isFailure(noVault)).toBe(true);
      const noDocuments = yield* runSourceAdd(config, {
        type: 'superhuman',
        id: 'missing-docs',
        include: [],
        documents: [],
        projectless: true,
        apply: true,
      }).pipe(Effect.exit);
      expect(Exit.isFailure(noDocuments)).toBe(true);
      expect((yield* readSourceConfiguration(config)).sources).toEqual([]);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
