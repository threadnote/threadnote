import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {readSourceConfiguration} from '@threadnote/threadnote/integrations/config';
import {runSourceAdd, runSourceList, runSourceRemove} from '@threadnote/threadnote/integrations/source';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../../../test/helpers/effect-layer.js';

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
      const listed = yield* runSourceList(config).pipe(captureConsole);
      expect(listed.output).toContain('local-notes (obsidian)');
      expect(listed.output).toContain('canvas-notes (superhuman)');
      yield* runSourceRemove(config, {id: 'canvas-notes'}).pipe(captureConsole);
      expect((yield* readSourceConfiguration(config)).sources).toHaveLength(2);
      yield* runSourceRemove(config, {id: 'canvas-notes', apply: true}).pipe(captureConsole);
      expect((yield* readSourceConfiguration(config)).sources.map(source => source.id)).toEqual(['local-notes']);
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
