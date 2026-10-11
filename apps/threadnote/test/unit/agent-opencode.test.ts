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
} from '@threadnote/threadnote/agent_integration/json_config';
import {readAgentIntegrationRegistry} from '@threadnote/threadnote/agent_integration/registry';
import {planAgentSurface} from '@threadnote/threadnote/agent_integration/surfaces';
import {SystemInfo} from '@threadnote/platform/system';
import type {JsonObject} from '@threadnote/platform/json';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';

const commandLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provide(TestSystemInfoLayer),
);
const testLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, commandLayer);
const adapter = getAgentAdapter('opencode')!;

describe('OpenCode and Zeno integration', () => {
  it('resolves Zeno to the documented flat-schema surface without enabling the separate v2 surface', () => {
    expect(getAgentAdapter('zeno')).toBe(adapter);
    expect(adapter.json).toMatchObject({container: 'mcp', entryType: 'local', commandArray: true});
    expect(getAgentAdapter('opencode-v2')?.kind).toBe('catalog');
  });

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
          const original = JSON.parse(JSON.stringify({...settings, mcp: servers})) as JsonObject;
          const raw = `// keep user configuration\r\n${JSON.stringify(original, undefined, 2).replaceAll('\n', '\r\n')}\r\n`;
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
