import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path, Redacted} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {readSourceConfiguration} from '@threadnote/threadnote/integrations/config';
import {
  runSourceAdd,
  runSourceInventory,
  runSourceList,
  runSourceRemove,
  runSourceStatus,
  runSourceSync,
} from '@threadnote/threadnote/integrations/source';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runLinearSourceAdd, runLinearSourceSync} from '@threadnote/integration-linear/source';
import {safeFetch, source as linearSource} from './linear-fixtures.js';
import {syncSourcesBeforeRecall} from '@threadnote/integration-core/source-sync';

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
  effectIt.effect('provides real source sync to recall through the application layer', () =>
    Effect.gen(function* () {
      const {config, vault} = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(vault, 'notes.md'), '# Registered sync\nLocal provider evidence.\n');
      yield* runSourceAdd(config, {
        type: 'obsidian',
        id: 'notes',
        vault,
        include: ['**/*.md'],
        documents: [],
        apply: true,
      }).pipe(captureConsole);
      const result = yield* syncSourcesBeforeRecall(config).pipe(captureConsole);
      expect(result.value.syncedSources).toContain('notes');
      expect(result.value.warnings).toEqual([]);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
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
      yield* runLinearSourceAdd(config, {
        ...linearSource,
        apply: true,
        apiToken: Redacted.make('synthetic-linear-dispatch-key'),
      }).pipe(captureConsole);
      yield* runLinearSourceSync(config, {
        id: linearSource.id,
        apply: true,
        clientOptions: {fetch: safeFetch},
      }).pipe(captureConsole);
      expect((yield* runSourceInventory(config, linearSource.id).pipe(captureConsole)).value.entries).toHaveLength(1);
      expect((yield* runSourceStatus(config, linearSource.id).pipe(captureConsole)).output).toContain('active');
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
      const system = yield* SystemInfo;
      const sync = yield* runSourceSync(config, {id: 'repo-source', apply: true}).pipe(
        Effect.provideService(SystemInfo, {...system, environment: () => ({})}),
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
