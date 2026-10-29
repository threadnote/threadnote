import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {getAgentAdapter} from '@threadnote/threadnote/agent_integration/adapters';
import {agentAdapterStatus} from '@threadnote/threadnote/agent_integration/adapter_actions';
import {
  parseAgentJson,
  removeAgentServer,
  mergeAgentServer,
  writeAgentServer,
  agentServerContainer,
  createdAgentContainerParents,
} from '@threadnote/threadnote/agent_integration/json_config';
import {readAgentIntegrationRegistry} from '@threadnote/threadnote/agent_integration/registry';
import {planAgentSurface} from '@threadnote/threadnote/agent_integration/surfaces';
import {SystemInfo} from '@threadnote/platform/system';
import {isJsonObject, type JsonObject} from '@threadnote/platform/json';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requireJsonObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object.');
  return value;
}

const commandLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provide(TestSystemInfoLayer),
);
const testLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, commandLayer);
const adapter = getAgentAdapter('opencode')!;

describe('OpenCode and Zeno integration', () => {
  it('separates Zeno desktop roots from OpenCode without enabling the separate upstream v2 surface', () => {
    expect(getAgentAdapter('zeno')).toBe(getAgentAdapter('zeno-desktop'));
    expect(getAgentAdapter('zeno')).not.toBe(adapter);
    expect(adapter.json).toMatchObject({container: 'mcp', entryType: 'local', commandArray: true});
    expect(getAgentAdapter('opencode-v2')?.kind).toBe('catalog');
  });

  it('round-trips nested MCP entries without changing settings, input objects, comments, or preexisting parents', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string().filter(key => key !== 'servers'),
          fc.jsonValue(),
        ),
        fc.boolean(),
        fc.boolean(),
        (metadata, hasParent, hasServers) => {
          const original = JSON.parse(
            JSON.stringify(
              hasParent ? {mcp: {...metadata, ...(hasServers ? {servers: {other: {command: ['other']}}} : {})}} : {},
            ),
          );
          const before = JSON.stringify(original);
          const raw = `// retain comment\n${JSON.stringify(original, undefined, 2)}\n`;
          const container = ['mcp', 'servers'];
          const entry = {type: 'local', command: ['threadnote'], disabled: false};
          const merged = mergeAgentServer(original, container, 'threadnote', entry);
          const installed = writeAgentServer(raw, 'jsonc', container, 'threadnote', merged);
          expect(JSON.stringify(original)).toBe(before);
          expect(parseAgentJson(installed, 'jsonc')).toEqual(merged);
          expect(writeAgentServer(installed, 'jsonc', container, 'threadnote', merged)).toBe(installed);
          const removed = removeAgentServer(
            merged,
            container,
            'threadnote',
            agentServerContainer(original, container) === undefined,
            createdAgentContainerParents(original, container),
          );
          const rendered = writeAgentServer(installed, 'jsonc', container, 'threadnote', removed);
          expect(parseAgentJson(rendered, 'jsonc')).toEqual(original);
          expect(rendered).toContain('// retain comment');
        },
      ),
      {numRuns: 40},
    );
  });

  for (const legacy of [false, true]) {
    effectIt.effect(`Zeno ${legacy ? 'legacy' : 'native'}: uses its isolated root and retains the config format`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const temp = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-zeno-'});
        const home = path.join(temp, 'home');
        const zeno = getAgentAdapter('zeno')!;
        const testSystem = SystemInfo.of({
          ...system,
          homeDirectory: home,
          platform: 'darwin',
          environment: () => ({XDG_CONFIG_HOME: path.join(temp, 'ignored-xdg')}),
        });
        const config = {
          account: 'local',
          agentContextHome: path.join(home, '.threadnote'),
          agentId: 'threadnote',
          manifestPath: path.join(home, '.threadnote/manifest.yaml'),
          user: 'tester',
        };
        yield* Effect.gen(function* () {
          const initial = yield* planAgentSurface(config, zeno);
          expect(initial.root).toBe(path.join(home, 'Library/Application Support/ai.zeno.desktop/config/opencode'));
          expect(initial.container).toEqual(['mcp', 'servers']);
          expect(initial.entry).toMatchObject({disabled: false, environment: {THREADNOTE_MCP_SURFACE: 'zeno-desktop'}});
          const original = legacy
            ? {provider: {local: {name: 'Local'}}, small_model: 'local/test'}
            : {providers: {local: {name: 'Local'}}, mcp: {timeout: 1234}};
          const raw = `// Zeno settings\n${JSON.stringify(original, undefined, 2)}\n`;
          yield* fs.makeDirectory(initial.root, {recursive: true});
          const file = path.join(initial.root, 'opencode.jsonc');
          yield* fs.writeFileString(file, raw);
          yield* zeno.actions.install(config, zeno, {apply: true});
          const receipt = (yield* readAgentIntegrationRegistry(config))!.surfaces!['zeno-desktop'];
          expect(receipt.strategy.container).toEqual(legacy ? 'mcp' : ['mcp', 'servers']);
          expect(
            agentServerContainer(parseAgentJson(yield* fs.readFileString(file), 'jsonc'), receipt.strategy.container),
          ).toMatchObject({threadnote: legacy ? {enabled: true} : {disabled: false}});
          expect((yield* agentAdapterStatus(config, zeno)).state).toBe('current');
          const installed = yield* fs.readFileString(file);
          const settings = parseAgentJson(installed, 'jsonc');
          const servers = requireJsonObject(agentServerContainer(settings, receipt.strategy.container));
          const disabledEntry = {
            ...requireJsonObject(servers.threadnote),
            ...(legacy ? {enabled: false} : {disabled: true}),
          };
          yield* fs.writeFileString(
            file,
            writeAgentServer(
              installed,
              'jsonc',
              receipt.strategy.container,
              'threadnote',
              mergeAgentServer(settings, receipt.strategy.container, 'threadnote', disabledEntry),
            ),
          );
          yield* zeno.actions.repair(config, zeno, {apply: true});
          expect((yield* agentAdapterStatus(config, zeno)).state).toBe('disabled');
          yield* fs.remove(file);
          yield* zeno.actions.repair(config, zeno, {apply: true});
          expect((yield* agentAdapterStatus(config, zeno)).state).toBe('current');
          // Restore unrelated settings before removal, just as a host would write them.
          const entry = agentServerContainer(
            parseAgentJson(yield* fs.readFileString(file), 'jsonc'),
            receipt.strategy.container,
          );
          yield* fs.writeFileString(
            file,
            writeAgentServer(
              raw,
              'jsonc',
              receipt.strategy.container,
              'threadnote',
              mergeAgentServer(
                original,
                receipt.strategy.container,
                'threadnote',
                requireJsonObject(requireJsonObject(entry).threadnote),
              ),
            ),
          );
          yield* zeno.actions.remove(config, zeno, {apply: true});
          expect(parseAgentJson(yield* fs.readFileString(file), 'jsonc')).toEqual(original);
          expect(yield* fs.readFileString(file)).toContain('// Zeno settings');
          expect(yield* fs.exists(path.join(temp, 'ignored-xdg'))).toBe(false);
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      }).pipe(TestClock.withLive, provideTestLayer(testLayer)),
    );
  }

  effectIt.effect('Zeno fresh install creates native configuration and removes only its own empty parents', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-zeno-fresh-'});
      const zeno = getAgentAdapter('zeno')!;
      const config = {
        account: 'local',
        agentContextHome: path.join(home, '.threadnote'),
        agentId: 'threadnote',
        manifestPath: path.join(home, '.threadnote/manifest.yaml'),
        user: 'tester',
      };
      yield* Effect.gen(function* () {
        const plan = yield* planAgentSurface(config, zeno);
        yield* zeno.actions.install(config, zeno, {apply: true});
        const installed = parseAgentJson(yield* fs.readFileString(plan.mcpPath), 'jsonc');
        expect(installed).toMatchObject({mcp: {servers: {threadnote: {type: 'local', disabled: false}}}});
        expect((yield* agentAdapterStatus(config, zeno)).state).toBe('current');
        yield* zeno.actions.remove(config, zeno, {apply: true});
        expect(yield* fs.exists(plan.mcpPath)).toBe(false);
      }).pipe(
        Effect.provideService(
          SystemInfo,
          SystemInfo.of({...system, homeDirectory: home, platform: 'darwin', environment: () => ({})}),
        ),
      );
    }).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  it('preserves arbitrary unrelated MCP entries and JSONC comments through repeated merge and removal', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string().filter(key => key !== 'mcp'),
          fc.jsonValue(),
        ),
        fc.dictionary(
          fc.string().filter(key => key !== 'threadnote'),
          fc.jsonValue(),
        ),
        (settings, servers) => {
          const original = parseAgentJson(JSON.stringify({...settings, mcp: servers}));
          const raw = `// keep user configuration\r\n${Effect2.pipe(JSON.stringify(original, undefined, 2), EffectString.replaceAll('\n', '\r\n'))}\r\n`;
          const entry = {
            type: 'local',
            command: ['threadnote-mcp-server'],
            environment: {THREADNOTE_MCP_CLIENT: 'opencode'},
            enabled: true,
          };
          const merged = mergeAgentServer(original, 'mcp', 'threadnote', entry);
          const installed = writeAgentServer(raw, 'jsonc', 'mcp', 'threadnote', merged);
          expect(parseAgentJson(installed, 'jsonc')).toEqual(merged);
          expect(writeAgentServer(installed, 'jsonc', 'mcp', 'threadnote', merged)).toBe(installed);
          const removed = writeAgentServer(
            installed,
            'jsonc',
            'mcp',
            'threadnote',
            removeAgentServer(merged, 'mcp', 'threadnote', false),
          );
          expect(parseAgentJson(removed, 'jsonc')).toEqual(original);
          expect(removed).toContain('// keep user configuration\r\n');
        },
      ),
      {numRuns: 40},
    );
  });

  for (const scope of ['user', 'project'] as const) {
    effectIt.effect(`${scope}: prefers existing JSONC and pins its path through repair and removal`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const temp = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-opencode-'});
        const home = path.join(temp, 'home');
        const cwd = path.join(temp, 'project');
        const configRoot = path.join(temp, 'custom-config');
        const config = {
          account: 'local',
          agentContextHome: path.join(home, '.threadnote'),
          agentId: 'threadnote',
          manifestPath: path.join(home, '.threadnote/manifest.yaml'),
          user: 'tester',
        };
        const testSystem = SystemInfo.of({
          ...system,
          homeDirectory: home,
          currentDirectory: () => cwd,
          environment: () => ({OPENCODE_CONFIG_DIR: configRoot, XDG_CONFIG_HOME: path.join(temp, 'xdg')}),
        });
        yield* Effect.gen(function* () {
          const initial = yield* planAgentSurface(config, adapter, {scope});
          expect(initial.root).toBe(scope === 'user' ? configRoot : cwd);
          expect(initial.mcpPath).toBe(path.join(initial.root, 'opencode.json'));
          expect(initial.skillRoot).toBe(path.join(initial.root, scope === 'user' ? 'skills' : '.opencode/skills'));
          expect(initial.entry).toMatchObject({
            type: 'local',
            enabled: true,
            environment: {THREADNOTE_MCP_SURFACE: 'opencode'},
          });
          expect(initial.entry.env).toBeUndefined();
          const jsoncPath = path.join(initial.root, 'opencode.jsonc');
          const lowerPriority = '{"mcp":{"other":{"type":"local","command":["other"]}}}\n';
          yield* fs.makeDirectory(initial.root, {recursive: true});
          yield* fs.writeFileString(initial.mcpPath, lowerPriority);
          yield* fs.writeFileString(jsoncPath, '// preferred config\n{"model":"local/test",}\n');
          yield* adapter.actions.install(config, adapter, {apply: true, scope});
          const receipt = (yield* readAgentIntegrationRegistry(config))!.surfaces!.opencode;
          expect(receipt.mcp.path).toBe(jsoncPath);
          expect(yield* fs.readFileString(initial.mcpPath)).toBe(lowerPriority);
          expect(parseAgentJson(yield* fs.readFileString(jsoncPath), 'jsonc')).toMatchObject({
            model: 'local/test',
            mcp: {threadnote: initial.entry},
          });
          yield* fs.remove(jsoncPath);
          yield* adapter.actions.repair(config, adapter, {apply: true});
          expect(yield* fs.exists(jsoncPath)).toBe(true);
          expect((yield* agentAdapterStatus(config, adapter)).state).toBe('current');
          const movedSystem = SystemInfo.of({
            ...testSystem,
            environment: () => ({OPENCODE_CONFIG_DIR: 'relative-now-invalid', XDG_CONFIG_HOME: 'relative-now-invalid'}),
          });
          yield* adapter.actions
            .remove(config, adapter, {apply: true})
            .pipe(Effect.provideService(SystemInfo, movedSystem));
          expect(yield* fs.readFileString(initial.mcpPath)).toBe(lowerPriority);
          expect(parseAgentJson(yield* fs.readFileString(jsoncPath), 'jsonc')).toEqual({});
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      }).pipe(TestClock.withLive, provideTestLayer(testLayer)),
    );
  }
});
