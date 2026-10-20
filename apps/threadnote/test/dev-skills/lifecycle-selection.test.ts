import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {describe, expect} from 'vitest';
import {selectDevSkillsTarget} from '../../src/dev_skills/plan.js';
import {resolveDevSkillsTarget} from '../../src/agent_integration/skill_targets.js';
import {consumerId, homeIndexPath, runtimeIndexPath} from '../../src/dev_skills/registry.js';
import {devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('pinned project selection', () => {
  effectIt.effect('selects the recorded Windows project spelling and identity before resolving native roots', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const path = Context.get(yield* Layer.build(BunPath.layerWin32), Path.Path);
      const home = 'C:\\Users\\Fixture\\Threadnote';
      const installationRoot = 'C:\\Threadnote';
      const cwd = 'C:\\Work\\Project';
      const config = {...f.config, agentContextHome: home};
      const system = SystemInfo.of({
        ...f.system,
        platform: 'win32',
        homeDirectory: 'C:\\Users\\Fixture',
        currentDirectory: () => 'c:\\work\\project',
        environment: () => ({THREADNOTE_INSTALL_ROOT: installationRoot}),
      });
      const target = yield* resolveDevSkillsTarget(config, {agent: 'roo', cwd}).pipe(
        Effect.provideService(SystemInfo, system),
        Effect.provideService(Path.Path, path),
      );
      const consumer = {home, installationRoot, target};
      const id = consumerId(consumer);
      const entry = {...consumer, state: 'enrolled'};
      const files = new Map([
        [homeIndexPath(path, home), JSON.stringify({schemaVersion: 1, home, installationRoot, targets: {[id]: entry}})],
        [
          runtimeIndexPath(path, installationRoot),
          JSON.stringify({schemaVersion: 1, installationRoot, enrollments: {[id]: entry}}),
        ],
      ]);
      const info = yield* f.fs.stat(f.manifest);
      const missing = f.path.join(f.root, 'missing');
      const fs = FileSystem.FileSystem.of({
        ...f.fs,
        readLink: () => f.fs.readLink(missing),
        realPath: file => Effect.succeed(file),
        stat: file => (files.has(file) ? Effect.succeed(info) : f.fs.stat(missing)),
        readFileString: file => (files.has(file) ? Effect.succeed(files.get(file)!) : f.fs.readFileString(missing)),
      });
      const before = yield* snapshot(f.root);
      for (const spelling of [undefined, 'c:\\work\\project', 'C:/WORK/Project/']) {
        const selected = yield* selectDevSkillsTarget(config, {agent: 'roo', cwd: spelling}).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        expect(selected).toEqual(target);
        expect(consumerId({...consumer, target: selected})).toBe(id);
      }
      expect(yield* snapshot(f.root)).toEqual(before);
    }).pipe(provideTestLayer(devSkillsTestLayer)),
  );
});
