import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {inspectCliInvocation} from '../../src/effect/cli.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';

const dependencies = Layer.merge(BunServices.layer, TestSystemInfoLayer);
const layer = Layer.merge(dependencies, TestCommandExecutorLayer.pipe(Layer.provide(dependencies)));

effectIt.effect('the public source CLI refuses unpinned application code with one JSON error and no home writes', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const environment = system.environment();
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-archive-cli-'});
    const home = path.join(root, 'data');
    const userHome = path.join(root, 'user');
    const temporary = path.join(root, 'tmp');
    for (const directory of [home, userHome, temporary]) yield* fs.makeDirectory(directory);
    const manifest = path.join(home, 'manifest.yaml');
    yield* fs.writeFileString(manifest, 'version: 1\nprojects: []\n');
    const names = yield* fs.readDirectory(root, {recursive: true});
    const invocation = inspectCliInvocation(['--home', home, 'memory-archive']);
    expect(invocation).toMatchObject({
      operation: 'memory-archive',
      writeAnonymousTelemetry: false,
      writeProductionLog: false,
    });
    const result = yield* runCommandEffect(
      system.executablePath,
      [path.resolve('apps/threadnote/src/standalone.ts'), '--home', home, '--manifest', manifest, 'memory-archive'],
      {
        cwd: root,
        env: {
          PATH: environment.PATH,
          SystemRoot: environment.SystemRoot,
          ComSpec: environment.ComSpec,
          PATHEXT: environment.PATHEXT,
          HOME: userHome,
          USERPROFILE: userHome,
          XDG_CONFIG_HOME: path.join(userHome, '.config'),
          XDG_CACHE_HOME: path.join(userHome, '.cache'),
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          THREADNOTE_HOME: home,
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_USER: 'tester',
          THREADNOTE_AGENT_ID: 'test',
          THREADNOTE_INSTALL_ROOT: path.join(root, 'installation'),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          NO_COLOR: '1',
        },
        input: new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            action: 'plan',
            uri: 'threadnote://user/tester/memories/durable/projects/threadnote/legacy-plan.md',
          }),
        ),
        allowFailure: true,
      },
    );
    expect(result.exitCode, result.stderr + result.stdout).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({version: 1, status: 'error', code: 'unsupported-runtime'});
    expect(yield* fs.readDirectory(root, {recursive: true})).toEqual(names);
    expect(yield* fs.readFileString(manifest)).toBe('version: 1\nprojects: []\n');
  }).pipe(provideTestLayer(layer), TestClock.withLive),
);
