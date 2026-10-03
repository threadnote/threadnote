import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {getAgentAdapter} from '@threadnote/threadnote/agent_integration/adapters';
import {agentAdapterDoctorChecks, agentAdapterStatus} from '@threadnote/threadnote/agent_integration/adapter_actions';
import {
  mergeAgentServer,
  parseAgentJson,
  removeAgentServer,
  writeAgentServer,
} from '@threadnote/threadnote/agent_integration/json_config';
import {
  readAgentIntegrationRegistry,
  writeAgentIntegrationRegistry,
} from '@threadnote/threadnote/agent_integration/registry';
import {planAgentSurface} from '@threadnote/threadnote/agent_integration/surfaces';

import {SystemInfo} from '@threadnote/platform/system';
import type {JsonObject} from '@threadnote/platform/json';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {expansionFixtures} from '../fixtures/agent-adapters/expansion.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const commandLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provide(TestSystemInfoLayer),
);
const testLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, commandLayer);
const runtime = (home: string): RuntimeConfig => ({
  account: 'local',
  agentContextHome: `${home}/.threadnote`,
  agentId: 'threadnote',
  manifestPath: `${home}/.threadnote/manifest.yaml`,
  user: 'tester',
});

describe('agent expansion conformance', () => {
  for (const fixture of expansionFixtures) {
    const adapter = getAgentAdapter(fixture.id)!;
    for (const scope of adapter.catalog.scopes) {
      effectIt.effect(`${fixture.id}/${scope}: lifecycle and recorded paths`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const system = yield* SystemInfo;
            const temp = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-expansion-'});
            const home = path.join(temp, 'home');
            const cwd = path.join(temp, 'project');
            const xdg = path.join(temp, 'xdg');
            const clineData = path.join(temp, 'cline-data');
            const kiroHome = path.join(temp, 'kiro-home');
            const config = runtime(home);
            const testSystem = SystemInfo.of({
              ...system,
              homeDirectory: home,
              currentDirectory: () => cwd,
              environment: () => ({
                ...system.environment(),
                XDG_CONFIG_HOME: xdg,
                CLINE_DATA_DIR: clineData,
                KIRO_HOME: kiroHome,
              }),
            });
            yield* Effect.gen(function* () {
              const plan = yield* planAgentSurface(config, adapter, {scope});
              const expectedRoot = (
                scope === 'user'
                  ? 'environmentRoot' in fixture
                    ? fixture.environmentRoot
                    : fixture.root
                  : 'projectRoot' in fixture
                    ? fixture.projectRoot
                    : fixture.root
              )
                .replace('{home}', home)
                .replace('{cwd}', cwd)
                .replace('{xdg}', xdg)
                .replace('{kiroHome}', kiroHome);
              expect(plan.root).toBe(expectedRoot);
              expect(plan.scope).toBe(scope);
              expect(plan.cwd).toBe(scope === 'user' ? undefined : cwd);
              const expectedMcpRoot = (
                scope === 'user' && 'environmentMcpRoot' in fixture ? fixture.environmentMcpRoot : '{root}'
              )
                .replace('{root}', expectedRoot)
                .replace('{clineData}', clineData);
              expect(plan.mcpPath).toBe(
                path.join(expectedMcpRoot, scope === 'local' && 'localMcp' in fixture ? fixture.localMcp : fixture.mcp),
              );
              expect(adapter.json!.container).toBe(fixture.container);
              if ('instructions' in fixture)
                expect(plan.artifacts.find(artifact => artifact.name === 'instructions')?.path).toBe(
                  path.join(
                    expectedRoot,
                    scope !== 'user' && 'projectInstructions' in fixture
                      ? fixture.projectInstructions
                      : fixture.instructions,
                  ),
                );
              else expect(plan.artifacts.some(artifact => artifact.name === 'instructions')).toBe(false);
              if ('skills' in fixture) {
                const expectedSkills = fixture.skills.replace('{home}', home).replace('{root}', expectedRoot);
                expect(plan.skillRoot).toBe(expectedSkills);
                expect(plan.artifacts.filter(artifact => artifact.name.startsWith('skill '))).toHaveLength(4);
                expect(plan.artifacts.at(-1)?.path).toBe(
                  path.join(expectedSkills, 'flat' in fixture ? 'threadnote-health.md' : 'threadnote-health/SKILL.md'),
                );
              } else expect(plan.artifacts).toHaveLength(1);
              expect((yield* planAgentSurface(config, adapter, {scope})).artifacts).toEqual(plan.artifacts);
              yield* adapter.actions.install(config, adapter, {apply: false, scope});
              expect(yield* fs.exists(home)).toBe(false);
              expect(yield* fs.exists(cwd)).toBe(false);
              expect(yield* fs.exists(xdg)).toBe(false);
              yield* fs.makeDirectory(path.dirname(plan.mcpPath), {recursive: true});
              const unrelated = {theme: 'dark', [fixture.container]: {other: {command: 'other'}}};
              const collision = JSON.stringify({...unrelated, [fixture.container]: {threadnote: {command: 'unowned'}}});
              yield* fs.writeFileString(plan.mcpPath, collision);
              expect(
                (yield* adapter.actions.install(config, adapter, {apply: true, scope}).pipe(Effect.exit))._tag,
              ).toBe('Failure');
              expect(yield* fs.readFileString(plan.mcpPath)).toBe(collision);
              expect(yield* readAgentIntegrationRegistry(config)).toBeUndefined();
              const raw =
                adapter.json!.codec === 'jsonc'
                  ? `// user comment\n${JSON.stringify(unrelated, undefined, 2)}\n`
                  : JSON.stringify(unrelated);
              yield* fs.writeFileString(plan.mcpPath, raw);
              yield* adapter.actions.install(config, adapter, {apply: true, scope});
              const first = yield* fs.readFileString(plan.mcpPath);
              const parsed = parseAgentJson(first, adapter.json!.codec);
              const entry = (parsed[fixture.container] as JsonObject).threadnote as JsonObject;
              expect(Array.isArray(entry.command)).toBe('commandArray' in fixture);
              if ('commandArray' in fixture) expect(entry).toMatchObject({type: 'local', enabled: true});
              if (adapter.json!.codec === 'jsonc') expect(first).toContain('// user comment');
              expect((yield* agentAdapterStatus(config, adapter)).state).toBe('current');
              expect(
                (yield* agentAdapterDoctorChecks(config)).find(check => check.name === `${fixture.id} agent surface`)
                  ?.status,
              ).toBe('ok');
              yield* adapter.actions.install(config, adapter, {apply: true, scope});
              expect(yield* fs.readFileString(plan.mcpPath)).toBe(first);
              const environmentKey = 'commandArray' in fixture ? 'environment' : 'env';
              const customized = {
                ...entry,
                [environmentKey]: {...(entry[environmentKey] as JsonObject), CUSTOM_OPTION: 'preserved'},
              };
              yield* fs.writeFileString(
                plan.mcpPath,
                writeAgentServer(
                  first,
                  adapter.json!.codec ?? 'json',
                  fixture.container,
                  'threadnote',
                  mergeAgentServer(parsed, fixture.container, 'threadnote', customized),
                ),
              );
              yield* adapter.actions.repair(config, adapter, {apply: true});
              const afterCustomization = parseAgentJson(yield* fs.readFileString(plan.mcpPath), adapter.json!.codec);
              expect(
                ((afterCustomization[fixture.container] as JsonObject).threadnote as JsonObject)[environmentKey],
              ).toMatchObject({CUSTOM_OPTION: 'preserved'});
              const disabled = {...entry, ...('commandArray' in fixture ? {enabled: false} : {disabled: true})};
              yield* fs.writeFileString(
                plan.mcpPath,
                writeAgentServer(
                  first,
                  adapter.json!.codec ?? 'json',
                  fixture.container,
                  'threadnote',
                  mergeAgentServer(parsed, fixture.container, 'threadnote', disabled),
                ),
              );
              expect((yield* agentAdapterStatus(config, adapter)).state).toBe('disabled');
              expect(
                (yield* agentAdapterDoctorChecks(config)).find(check => check.name === `${fixture.id} agent surface`)
                  ?.status,
              ).toBe('warn');
              yield* adapter.actions.repair(config, adapter, {apply: true});
              expect((yield* agentAdapterStatus(config, adapter)).state).toBe('disabled');
              yield* fs.writeFileString(plan.mcpPath, first);
              yield* adapter.actions.repair(config, adapter, {apply: true});
              const registry = (yield* readAgentIntegrationRegistry(config))!;
              const receipt = registry.surfaces![fixture.id];
              expect(receipt).toMatchObject({scope, root: plan.root, mcp: {path: plan.mcpPath}});
              yield* fs.remove(plan.artifacts[0].path);
              const movedSystem = SystemInfo.of({
                ...testSystem,
                currentDirectory: () => path.join(temp, 'elsewhere'),
                environment: () => ({
                  ...testSystem.environment(),
                  XDG_CONFIG_HOME: 'now-relative',
                  APPDATA: 'now-relative',
                }),
              });
              yield* adapter.actions
                .repair(config, adapter, {apply: true})
                .pipe(Effect.provideService(SystemInfo, movedSystem));
              expect(yield* fs.exists(plan.artifacts[0].path)).toBe(true);
              expect(yield* fs.exists(path.join(temp, 'elsewhere'))).toBe(false);
              expect((yield* readAgentIntegrationRegistry(config))!.surfaces![fixture.id].root).toBe(plan.root);
              yield* adapter.actions
                .remove(config, adapter, {apply: false})
                .pipe(Effect.provideService(SystemInfo, movedSystem));
              expect(yield* fs.exists(plan.artifacts[0].path)).toBe(true);
              yield* adapter.actions
                .remove(config, adapter, {apply: true})
                .pipe(Effect.provideService(SystemInfo, movedSystem));
              const restored = yield* fs.readFileString(plan.mcpPath);
              expect(parseAgentJson(restored, adapter.json!.codec)).toEqual(unrelated);
              if (adapter.json!.codec === 'jsonc') expect(restored).toContain('// user comment');
              for (const artifact of plan.artifacts) expect(yield* fs.exists(artifact.path)).toBe(false);
              expect((yield* readAgentIntegrationRegistry(config))!.surfaces![fixture.id]).toBeUndefined();
            }).pipe(Effect.provideService(SystemInfo, testSystem));
          }),
        ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
      );
    }
  }

  effectIt.effect('platform and environment path fixtures resolve without creating host files', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const temp = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-platform-paths-'});
        const home = `${temp}/home`;
        const cwd = `${temp}/project`;
        const config = runtime(home);
        for (const platform of ['darwin', 'linux', 'win32'] as const) {
          for (const configured of [true, false]) {
            const xdg = configured ? `${temp}/xdg` : `${home}/.config`;
            const appdata = configured ? `${temp}/appdata` : `${home}/AppData/Roaming`;
            const clineData = `${temp}/cline-data`;
            const kiroHome = `${temp}/kiro-home`;
            const testSystem = SystemInfo.of({
              ...system,
              platform,
              homeDirectory: home,
              currentDirectory: () => cwd,
              environment: () =>
                configured
                  ? {
                      XDG_CONFIG_HOME: xdg,
                      APPDATA: appdata,
                      CLINE_DATA_DIR: clineData,
                      KIRO_HOME: kiroHome,
                    }
                  : {},
            });
            for (const fixture of expansionFixtures) {
              const adapter = getAgentAdapter(fixture.id)!;
              const plan = yield* planAgentSurface(config, adapter).pipe(Effect.provideService(SystemInfo, testSystem));
              const template =
                configured && 'environmentRoot' in fixture
                  ? fixture.environmentRoot
                  : platform === 'win32' && 'windowsRoot' in fixture
                    ? fixture.windowsRoot
                    : fixture.root;
              expect(plan.root).toBe(
                template
                  .replace('{home}', home)
                  .replace('{cwd}', cwd)
                  .replace('{xdg}', xdg)
                  .replace('{appdata}', appdata)
                  .replace('{kiroHome}', kiroHome),
              );
              const expectedMcpRoot = (
                configured && 'environmentMcpRoot' in fixture
                  ? fixture.environmentMcpRoot
                  : 'defaultMcpRoot' in fixture
                    ? fixture.defaultMcpRoot
                    : '{root}'
              )
                .replace('{root}', plan.root)
                .replace('{clineData}', clineData);
              expect(plan.mcpPath).toBe(path.join(expectedMcpRoot, fixture.mcp));
            }
          }
        }
        expect(yield* fs.exists(home)).toBe(false);
        expect(yield* fs.exists(cwd)).toBe(false);
      }),
    ).pipe(provideTestLayer(testLayer)),
  );

  for (const order of [
    ['antigravity-cli', 'antigravity-ide'],
    ['antigravity-ide', 'antigravity-cli'],
  ]) {
    effectIt.effect(`shared MCP survives removing ${order[0]} first`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const system = yield* SystemInfo;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-shared-mcp-'});
          const config = runtime(home);
          yield* Effect.gen(function* () {
            const first = getAgentAdapter(order[0])!;
            const second = getAgentAdapter(order[1])!;
            yield* first.actions.install(config, first, {apply: true});
            expect(
              (yield* second.actions.install(config, second, {apply: true, toolset: 'full'}).pipe(Effect.exit))._tag,
            ).toBe('Failure');
            yield* second.actions.install(config, second, {apply: true});
            const plan = yield* planAgentSurface(config, first);
            expect((yield* agentAdapterStatus(config, first)).state).toBe('stale');
            expect((yield* agentAdapterStatus(config, second)).state).toBe('current');
            yield* first.actions.remove(config, first, {apply: true});
            expect(yield* fs.exists(plan.mcpPath)).toBe(true);
            expect((yield* agentAdapterStatus(config, second)).state).toBe('current');
            yield* second.actions.remove(config, second, {apply: true});
            expect(yield* fs.exists(plan.mcpPath)).toBe(false);
          }).pipe(Effect.provideService(SystemInfo, SystemInfo.of({...system, homeDirectory: home})));
        }),
      ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
    );
  }

  it('JSONC edits preserve unrelated values and comments, round-trip and are idempotent', () => {
    const verifyRoundTrip = (settings: JsonObject) => {
      const original = JSON.parse(JSON.stringify({...settings, mcp: {other: {command: 'kept'}}})) as JsonObject;
      const raw = `// preserved heading\n${JSON.stringify(original, undefined, 2)}\n`;
      const merged = mergeAgentServer(original, 'mcp', 'threadnote', {type: 'local', command: ['threadnote']});
      const written = writeAgentServer(raw, 'jsonc', 'mcp', 'threadnote', merged);
      expect(parseAgentJson(written, 'jsonc')).toEqual(merged);
      expect(written).toContain('// preserved heading');
      expect(writeAgentServer(written, 'jsonc', 'mcp', 'threadnote', merged)).toBe(written);
      const removed = writeAgentServer(
        written,
        'jsonc',
        'mcp',
        'threadnote',
        removeAgentServer(merged, 'mcp', 'threadnote', false),
      );
      expect(parseAgentJson(removed, 'jsonc')).toEqual(original);
      expect(removed).toContain('// preserved heading');
    };

    verifyRoundTrip({'': [-0]});
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string().filter(key => key !== 'mcp'),
          fc.jsonValue(),
        ),
        verifyRoundTrip,
      ),
      {numRuns: 40},
    );
  });

  it('preserves an own __proto__ JSONC property without exposing it as the object prototype', () => {
    const raw = '{"__proto__":null,"mcp":{"other":{"command":"kept"}}}';
    const parsed = parseAgentJson(raw, 'jsonc');
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(parsed.__proto__).toBe(null);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    const merged = mergeAgentServer(parsed, 'mcp', 'threadnote', {command: ['threadnote']});
    const written = writeAgentServer(raw, 'jsonc', 'mcp', 'threadnote', merged);
    const roundTrip = parseAgentJson(written, 'jsonc');
    expect(Object.hasOwn(roundTrip, '__proto__')).toBe(true);
    expect(roundTrip.__proto__).toBe(null);
  });

  it('preserves comments inside a customized JSONC MCP entry during repair', () => {
    const raw =
      '{"mcp":{"threadnote":{"command":["old"],"environment":{\n// keep custom explanation\n"CUSTOM":"yes", "THREADNOTE_HOME":"old"}}}}';
    const parsed = parseAgentJson(raw, 'jsonc');
    const next = mergeAgentServer(parsed, 'mcp', 'threadnote', {
      command: ['new'],
      environment: {CUSTOM: 'yes', THREADNOTE_HOME: 'new'},
    });
    const updated = writeAgentServer(raw, 'jsonc', 'mcp', 'threadnote', next);
    expect(updated).toContain('// keep custom explanation');
    expect(parseAgentJson(updated, 'jsonc')).toEqual(next);
  });

  effectIt.effect('preserves user comments when removing a Threadnote-created JSONC file', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-jsonc-remove-'});
        const config = runtime(home);
        const adapter = getAgentAdapter('kilo')!;
        yield* Effect.gen(function* () {
          yield* adapter.actions.install(config, adapter, {apply: true});
          const plan = yield* planAgentSurface(config, adapter);
          const installed = (yield* fs.readFileString(plan.mcpPath)).replaceAll('\n', '\r\n');
          yield* fs.writeFileString(
            plan.mcpPath,
            installed.replace('"threadnote": {', '"threadnote": {\r\n      // keep this user note'),
          );
          yield* adapter.actions.remove(config, adapter, {apply: true});
          const remaining = yield* fs.readFileString(plan.mcpPath);
          expect(remaining).toContain('// keep this user note');
          expect(remaining.replaceAll('\r\n', '')).not.toContain('\n');
          expect(parseAgentJson(remaining, 'jsonc')).toEqual({});
        }).pipe(Effect.provideService(SystemInfo, SystemInfo.of({...system, homeDirectory: home})));
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('rejects relative agent-specific root overrides', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-root-'});
        const config = runtime(home);
        for (const [selector, environment] of [
          ['cline', {CLINE_DATA_DIR: 'relative-cline'}],
          ['kiro', {KIRO_HOME: 'relative-kiro'}],
        ] as const) {
          const adapter = getAgentAdapter(selector)!;
          expect(
            (yield* planAgentSurface(config, adapter).pipe(
              Effect.provideService(
                SystemInfo,
                SystemInfo.of({...system, homeDirectory: home, environment: () => environment}),
              ),
              Effect.exit,
            ))._tag,
          ).toBe('Failure');
        }
      }),
    ).pipe(provideTestLayer(testLayer)),
  );

  effectIt.effect('refuses a symlinked recorded host root during repair and removal', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-root-symlink-'});
        const config = runtime(home);
        const adapter = getAgentAdapter('kiro')!;
        yield* Effect.gen(function* () {
          yield* adapter.actions.install(config, adapter, {apply: true});
          const plan = yield* planAgentSurface(config, adapter);
          const moved = `${home}/moved-kiro`;
          yield* fs.rename(plan.root, moved);
          yield* fs.symlink(moved, plan.root);
          const before = yield* fs.readFileString(plan.mcpPath);
          expect((yield* adapter.actions.repair(config, adapter, {apply: true}).pipe(Effect.exit))._tag).toBe(
            'Failure',
          );
          expect((yield* adapter.actions.remove(config, adapter, {apply: true}).pipe(Effect.exit))._tag).toBe(
            'Failure',
          );
          expect(yield* fs.readFileString(plan.mcpPath)).toBe(before);
          expect((yield* readAgentIntegrationRegistry(config))!.surfaces![adapter.catalog.id]).toBeDefined();
        }).pipe(Effect.provideService(SystemInfo, SystemInfo.of({...system, homeDirectory: home})));
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('rejects relative environment roots, mismatched scopes and tampered receipt paths', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-receipt-safety-'});
        const config = runtime(home);
        const adapter = getAgentAdapter('devin')!;
        yield* Effect.gen(function* () {
          expect(
            (yield* planAgentSurface(config, adapter).pipe(
              Effect.provideService(
                SystemInfo,
                SystemInfo.of({...system, homeDirectory: home, environment: () => ({XDG_CONFIG_HOME: 'relative'})}),
              ),
              Effect.exit,
            ))._tag,
          ).toBe('Failure');
          yield* adapter.actions.install(config, adapter, {apply: true});
          expect(
            (yield* adapter.actions.install(config, adapter, {apply: true, scope: 'project'}).pipe(Effect.exit))._tag,
          ).toBe('Failure');
          const registry = (yield* readAgentIntegrationRegistry(config))!;
          const receipt = registry.surfaces![adapter.catalog.id];
          yield* writeAgentIntegrationRegistry(config, {
            ...registry,
            surfaces: {[adapter.catalog.id]: {...receipt, mcp: {...receipt.mcp, path: `${home}/unrelated.json`}}},
          });
          expect((yield* adapter.actions.remove(config, adapter, {apply: true}).pipe(Effect.exit))._tag).toBe(
            'Failure',
          );
          expect((yield* adapter.actions.repair(config, adapter, {apply: true}).pipe(Effect.exit))._tag).toBe(
            'Failure',
          );
          expect(yield* fs.exists(receipt.mcp.path)).toBe(true);
        }).pipe(
          Effect.provideService(
            SystemInfo,
            SystemInfo.of({...system, homeDirectory: home, environment: () => ({XDG_CONFIG_HOME: `${home}/config`})}),
          ),
        );
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );
});
