import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  cursorHooksAreCurrent,
  hasManagedCursorHooks,
  runCursorHooksInstall,
  withCursorHooks,
} from '@threadnote/threadnote/cursor/hooks';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {SystemInfo} from '@threadnote/platform/system';
import {isJsonObject, type JsonObject} from '@threadnote/platform/json';
import * as EffectRecord from 'effect/Record';

const TestLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, TestSystemInfoLayer);
const managed = {_threadnote: 'managed', command: 'old threadnote command'};

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cursor-hooks-'});
  const configPath = path.join(root, '.cursor', 'hooks.json');
  const system = yield* SystemInfo;
  return {
    fs,
    root,
    configPath,
    system: SystemInfo.of({...system, homeDirectory: root, currentDirectory: () => root, environment: () => ({})}),
  };
});

describe('Cursor hook config', () => {
  it('uses Cursor flat commands and restricts hosted Cloud to preCompact', () => {
    expect(withCursorHooks({}, 'desktop')).toEqual({
      version: 1,
      hooks: {
        sessionStart: [
          {_threadnote: 'managed', type: 'command', command: 'threadnote cursor-hook sessionStart', timeout: 15},
        ],
        preCompact: [
          {_threadnote: 'managed', type: 'command', command: 'threadnote cursor-hook preCompact', timeout: 15},
        ],
      },
    });
    expect(cursorHooksAreCurrent(withCursorHooks({}, 'desktop'), 'desktop')).toBe(true);
    expect(cursorHooksAreCurrent(withCursorHooks({}, 'cloud'), 'desktop')).toBe(false);
    const cloud = withCursorHooks(withCursorHooks({}, 'desktop'), 'cloud');
    expect(cloud.hooks).toMatchObject({sessionStart: [], preCompact: [{command: 'threadnote cursor-hook preCompact'}]});
    expect(cloud.hooks).not.toHaveProperty('workspaceOpen');
  });

  it('preserves unrelated hooks through idempotent installs, target changes, and removal', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom('sessionStart', 'preCompact', 'workspaceOpen', 'stop', 'custom'),
          fc.array(fc.record({command: fc.string(), timeout: fc.nat({max: 120})}), {maxLength: 5}),
        ),
        fc.jsonValue(),
        (hooks, metadata) => {
          const original: JsonObject = {version: 1, hooks, metadata};
          const before = structuredClone(original);
          const desktop = withCursorHooks(original, 'desktop');
          expect(withCursorHooks(desktop, 'desktop')).toEqual(desktop);
          const cloud = withCursorHooks(desktop, 'cloud');
          expect(withCursorHooks(cloud, 'cloud')).toEqual(cloud);
          const removed = withCursorHooks(cloud, 'cloud', true);
          expect(withCursorHooks(removed, 'cloud', true)).toEqual(removed);
          const remaining = removed.hooks;
          if (!isJsonObject(remaining)) throw new Error('Expected remaining cursor hooks.');
          for (const [event, entries] of EffectRecord.toEntries(hooks)) expect(remaining[event]).toEqual(entries);
          expect(removed.metadata).toEqual(metadata);
          expect(original).toEqual(before);
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('previews without writing, installs once, and removes only managed entries', () =>
    Effect.gen(function* () {
      const {fs, root, configPath, system} = yield* fixture;
      const run = (options: Parameters<typeof runCursorHooksInstall>[0]) =>
        captureConsole(runCursorHooksInstall(options).pipe(Effect.provideService(SystemInfo, system)));
      const preview = yield* run({apply: true, dryRun: true});
      expect(preview.output).toContain('Would update');
      expect(preview.output).toContain('Local user hooks do not carry into Cloud VMs');
      expect(yield* fs.exists(configPath)).toBe(false);
      yield* fs.makeDirectory(`${root}/.cursor`);
      const user = {command: 'custom-audit', matcher: 'Shell'};
      yield* fs.writeFileString(
        configPath,
        JSON.stringify({version: 1, metadata: {preserve: true}, hooks: {sessionStart: [user, managed], stop: []}}),
      );
      yield* run({apply: true});
      expect(yield* hasManagedCursorHooks().pipe(Effect.provideService(SystemInfo, system))).toBe(true);
      const once = yield* fs.readFileString(configPath);
      const second = yield* run({apply: true});
      expect(second.output).toContain('already managed');
      expect(yield* fs.readFileString(configPath)).toBe(once);
      yield* run({apply: true, remove: true});
      expect(yield* hasManagedCursorHooks().pipe(Effect.provideService(SystemInfo, system))).toBe(false);
      expect(JSON.parse(yield* fs.readFileString(configPath))).toEqual({
        version: 1,
        metadata: {preserve: true},
        hooks: {sessionStart: [user], preCompact: [], stop: []},
      });
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect('requires a project for hosted Cloud and writes only that project', () =>
    Effect.gen(function* () {
      const {fs, root, configPath, system} = yield* fixture;
      const rejected = yield* runCursorHooksInstall({target: 'cloud', apply: true}).pipe(Effect.result);
      expect(Result.isFailure(rejected)).toBe(true);
      const project = `${root}/project`;
      const installed = yield* captureConsole(
        runCursorHooksInstall({target: 'cloud', project, apply: true}).pipe(Effect.provideService(SystemInfo, system)),
      );
      expect(installed.output).toContain('sessionStart, sessionEnd, and workspaceOpen are unavailable');
      expect(yield* fs.exists(configPath)).toBe(false);
      const saved = JSON.parse(yield* fs.readFileString(`${project}/.cursor/hooks.json`));
      expect(EffectRecord.keys(saved.hooks)).toEqual(['preCompact']);
      yield* runCursorHooksInstall({target: 'cloud', project, apply: true, remove: true});
      expect(JSON.parse(yield* fs.readFileString(`${project}/.cursor/hooks.json`)).hooks).toEqual({preCompact: []});
    }).pipe(provideTestLayer(TestLayer)),
  );

  effectIt.effect.each(['{broken', '[]', '{"version":2}', '{"hooks":[]}', '{"hooks":{"preCompact":{}}}'])(
    'preserves unsupported or invalid config %s',
    raw =>
      Effect.gen(function* () {
        const {fs, root, configPath, system} = yield* fixture;
        yield* fs.makeDirectory(`${root}/.cursor`);
        yield* fs.writeFileString(configPath, raw);
        for (const remove of [false, true]) {
          const result = yield* runCursorHooksInstall({apply: true, remove}).pipe(
            Effect.provideService(SystemInfo, system),
            Effect.result,
          );
          expect(Result.isFailure(result)).toBe(true);
          expect(yield* fs.readFileString(configPath)).toBe(raw);
        }
      }).pipe(provideTestLayer(TestLayer)),
  );
});
