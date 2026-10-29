import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {AGENT_ADAPTERS, getAgentAdapter, jsonServerDisabled} from '@threadnote/threadnote/agent_integration/adapters';
import {
  agentAdapterStatus,
  removeRegisteredAgentAdaptersInTransaction,
} from '@threadnote/threadnote/agent_integration/adapter_actions';
import {AGENT_CATALOG, validateAgentCatalog} from '@threadnote/integrations/catalog';
import {
  atomicAgentWrite,
  installAgentIntegration,
  removeAgentIntegrations,
} from '@threadnote/threadnote/agent_integration/index';
import {
  mergeAgentServer,
  parseAgentJson,
  removeAgentServer,
} from '@threadnote/threadnote/agent_integration/json_config';
import {
  artifactHasOtherConsumers,
  migrateAgentIntegrationRegistry,
  readAgentIntegrationRegistry,
  type AgentIntegrationHostReceipt,
} from '@threadnote/threadnote/agent_integration/registry';
import {planAgentSurface} from '@threadnote/threadnote/agent_integration/surfaces';
import {captureConsole} from '@threadnote/threadnote/effect/console';

import {SystemInfo} from '@threadnote/platform/system';
import {isJsonObject, type JsonObject} from '@threadnote/platform/json';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectRecord from 'effect/Record';
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
const jsonAdapters = EffectArray.filter(
  AGENT_ADAPTERS,
  (adapter, __effectArrayIndex) =>
    __effectArrayIndex in AGENT_ADAPTERS &&
    ['gemini-cli', 'qwen-code', 'amp-cli', 'factory-droid'].includes(adapter.catalog.id),
);
const runtime = (home: string): RuntimeConfig => ({
  account: 'local',
  agentContextHome: home,
  agentId: 'threadnote',
  manifestPath: `${home}/manifest.yaml`,
  user: 'tester',
});
const installAgentSurface = (config: RuntimeConfig, selector: string, options: {readonly apply?: boolean} = {}) => {
  const adapter = getAgentAdapter(selector)!;
  return adapter.actions.install(config, adapter, {apply: options.apply === true});
};
const removeAgentSurface = (config: RuntimeConfig, selector: string, apply = false) => {
  const adapter = getAgentAdapter(selector)!;
  return adapter.actions.remove(config, adapter, {apply});
};
const surfacePlan = (config: RuntimeConfig, selector: string) => planAgentSurface(config, getAgentAdapter(selector)!);

describe('agent catalog and adapter contracts', () => {
  it('has one descriptor per catalog surface and no false managed claims', () => {
    expect(EffectArray.map(AGENT_ADAPTERS, adapter => adapter.catalog.id)).toEqual(
      EffectArray.map(AGENT_CATALOG, entry => entry.id),
    );
    expect(new Set(EffectArray.map(AGENT_CATALOG, entry => entry.id)).size).toBe(AGENT_CATALOG.length);
    for (const adapter of AGENT_ADAPTERS) {
      expect(EffectRecord.keys(adapter.actions).sort()).toEqual(['install', 'remove', 'repair', 'status']);
      for (const action of EffectRecord.values(adapter.actions)) expect(action).toBeTypeOf('function');
      expect(adapter.catalog.capabilities.mcp.status === 'managed').toBe(Boolean(adapter.json || adapter.legacyClient));
      if (adapter.catalog.projectGuidance.status === 'managed') {
        expect(
          adapter.guidance,
          `${adapter.catalog.id} must declare its managed project-guidance contract`,
        ).toBeDefined();
        expect(adapter.guidance?.projection.relativePath).toBe(adapter.catalog.projectGuidance.targetPath);
      } else {
        expect(
          adapter.guidance,
          `${adapter.catalog.id} must not exceed its catalog project-guidance claim`,
        ).toBeUndefined();
      }
    }
    expect(() => validateAgentCatalog({version: 1, agents: [AGENT_CATALOG[0], AGENT_CATALOG[0]]})).toThrow();
  });

  it('rejects comments and malformed containers without destructive rewriting', () => {
    expect(() => parseAgentJson('{ // preserve me\n "theme": "dark" }')).toThrow();
    expect(() => mergeAgentServer({mcpServers: []}, 'mcpServers', 'threadnote', {})).toThrow();
  });

  it('preserves unrelated JSON and round-trips owned entries idempotently', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string().filter(key => key !== 'mcpServers'),
          fc.jsonValue(),
        ),
        fc.dictionary(
          fc.string().filter(key => key !== 'threadnote'),
          fc.jsonValue(),
        ),
        (settings, servers) => {
          const before = requireJsonObject({...settings, mcpServers: servers});
          const entry = {command: 'threadnote-mcp-server', args: []};
          const after = mergeAgentServer(before, 'mcpServers', 'threadnote', entry);
          expect(mergeAgentServer(after, 'mcpServers', 'threadnote', entry)).toEqual(after);
          expect(removeAgentServer(after, 'mcpServers', 'threadnote', false)).toEqual(before);
          expect(before).toEqual({...settings, mcpServers: servers});
        },
      ),
      {numRuns: 40},
    );
  });

  it('migrates v1 losslessly and builds deterministic shared ownership', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom('codex', 'claude', 'cursor', 'copilot', 'omp')), agents => {
        const receipt: AgentIntegrationHostReceipt = {
          artifactVersion: 1,
          artifacts: {'/shared/SKILL.md': Effect2.pipe('a', EffectString.repeat(64))},
          installedVersion: '4.7.7',
          mcp: {name: 'threadnote', repair: false},
          status: 'current',
        };
        const v1 = {
          version: 1 as const,
          legacyInstructionsMigrated: true,
          hosts: EffectRecord.fromEntries(EffectArray.map(agents, agent => [agent, receipt])),
        };
        const migrated = migrateAgentIntegrationRegistry(v1);
        expect(migrated.hosts).toEqual(v1.hosts);
        expect(migrated.version).toBe(2);
        expect(migrateAgentIntegrationRegistry(migrated)).toEqual(migrated);
        expect(migrated.physicalArtifacts?.['/shared/SKILL.md'] ?? []).toEqual(
          EffectArray.map(agents, agent => `legacy:${agent}`).sort(),
        );
        for (const agent of agents)
          expect(artifactHasOtherConsumers(migrated, '/shared/SKILL.md', `legacy:${agent}`)).toBe(agents.length > 1);
      }),
      {numRuns: 30},
    );
  });

  it('detects explicit entry disablement and allow/exclude policies', () => {
    expect(jsonServerDisabled({mcpServers: {threadnote: {disabled: true}}}, 'mcpServers', 'threadnote')).toBe(true);
    expect(jsonServerDisabled({mcp: {allowed: ['other']}}, 'mcpServers', 'threadnote')).toBe(true);
    expect(jsonServerDisabled({mcp: {excluded: ['threadnote']}}, 'mcpServers', 'threadnote')).toBe(true);
    expect(jsonServerDisabled({mcp: {allowed: ['threadnote']}}, 'mcpServers', 'threadnote')).toBe(false);
    expect(jsonServerDisabled({mcp: {allowed: ['thread*']}}, 'mcpServers', 'threadnote', true)).toBe(false);
    expect(
      jsonServerDisabled({mcp: {allowed: ['*'], excluded: ['thread?ote']}}, 'mcpServers', 'threadnote', true),
    ).toBe(true);
  });

  for (const adapter of jsonAdapters) {
    effectIt.effect(
      `${adapter.catalog.id}: dry run, install, reinstall, receipt-root repair, status and uninstall`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const system = yield* SystemInfo;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-adapter-'});
            const home = path.join(root, 'user');
            const config = runtime(path.join(home, '.threadnote'));
            const testSystem = SystemInfo.of({
              ...system,
              homeDirectory: home,
              environment: () => ({...system.environment(), XDG_CONFIG_HOME: path.join(root, 'config')}),
            });
            yield* Effect.gen(function* () {
              const initial = yield* planAgentSurface(config, adapter);
              const fixture = (() => {
                switch (adapter.catalog.id) {
                  case 'gemini-cli':
                    return {
                      root: path.join(home, '.gemini'),
                      mcpFile: 'settings.json',
                      instruction: 'GEMINI.md',
                      container: 'mcpServers',
                    };
                  case 'qwen-code':
                    return {
                      root: path.join(home, '.qwen'),
                      mcpFile: 'settings.json',
                      instruction: 'QWEN.md',
                      container: 'mcpServers',
                    };
                  case 'amp-cli':
                    return {
                      root: path.join(root, 'config', 'amp'),
                      mcpFile: 'settings.json',
                      instruction: 'AGENTS.md',
                      container: 'amp.mcpServers',
                    };
                  case 'factory-droid':
                    return {
                      root: path.join(home, '.factory'),
                      mcpFile: 'mcp.json',
                      instruction: 'AGENTS.md',
                      container: 'mcpServers',
                    };
                  default:
                    throw new Error(`Unexpected adapter fixture ${adapter.catalog.id}.`);
                }
              })();
              expect(initial.root).toBe(fixture.root);
              expect(initial.mcpPath).toBe(path.join(fixture.root, fixture.mcpFile));
              expect(initial.artifacts[0].path).toBe(path.join(fixture.root, fixture.instruction));
              expect(initial.artifacts[0].content).toContain('`threadnote context brief --cwd <cwd> --task <task>`');
              expect(initial.artifacts[0].content).not.toContain('threadnote context brief --caller-cwd');
              expect(
                EffectOption.getOrUndefined(
                  EffectArray.findFirst(initial.artifacts, artifact => artifact.name === 'skill threadnote-context'),
                )?.content,
              ).toContain('`threadnote context brief --cwd <cwd> --task <task>`');
              expect(adapter.json!.container).toBe(fixture.container);
              yield* installAgentSurface(config, adapter.catalog.id);
              expect(yield* fs.exists(home)).toBe(false);
              const staleInstruction = Effect2.pipe(
                initial.artifacts[0].content,
                EffectString.replace(
                  'threadnote context brief --cwd <cwd> --task <task>',
                  'threadnote context brief --caller-cwd <cwd> --task <task>',
                ),
              );
              expect(staleInstruction).not.toBe(initial.artifacts[0].content);
              yield* fs.makeDirectory(path.dirname(initial.artifacts[0].path), {recursive: true});
              yield* fs.writeFileString(initial.artifacts[0].path, staleInstruction);
              yield* fs.makeDirectory(path.dirname(initial.mcpPath), {recursive: true});
              const unrelated = {theme: 'dark', [fixture.container]: {unrelated: {command: 'other'}}};
              yield* fs.writeFileString(initial.mcpPath, JSON.stringify(unrelated));
              yield* installAgentSurface(config, adapter.catalog.id, {apply: true});
              const first = yield* fs.readFileString(initial.mcpPath);
              expect(yield* fs.readFileString(initial.artifacts[0].path)).toContain(
                '`threadnote context brief --cwd <cwd> --task <task>`',
              );
              expect(yield* fs.readFileString(initial.artifacts[0].path)).not.toContain('--caller-cwd');
              expect((yield* agentAdapterStatus(config, adapter)).state).toBe('current');
              if (adapter.json!.unverifiedPolicyFile !== undefined) {
                const enablementPath = path.join(initial.root, adapter.json!.unverifiedPolicyFile);
                yield* fs.writeFileString(enablementPath, '{"threadnote":false}');
                expect((yield* agentAdapterStatus(config, adapter)).state).toBe('stale');
                yield* fs.remove(enablementPath);
              }
              yield* installAgentSurface(config, adapter.catalog.id, {apply: true});
              expect(yield* fs.readFileString(initial.mcpPath)).toBe(first);
              const customized = parseAgentJson(first);
              const owned = requireJsonObject(requireJsonObject(customized[fixture.container]).threadnote);
              const customizedEntry = {
                ...owned,
                env: {...requireJsonObject(owned.env), CUSTOM_AGENT_OPTION: 'preserve'},
              };
              yield* fs.writeFileString(
                initial.mcpPath,
                JSON.stringify({
                  ...customized,
                  [fixture.container]: {
                    ...requireJsonObject(customized[fixture.container]),
                    threadnote: customizedEntry,
                  },
                }),
              );
              yield* installAgentSurface(config, adapter.catalog.id, {apply: true});
              const repaired = parseAgentJson(yield* fs.readFileString(initial.mcpPath));
              expect(requireJsonObject(requireJsonObject(repaired[fixture.container]).threadnote).env).toMatchObject({
                CUSTOM_AGENT_OPTION: 'preserve',
              });
              expect((yield* agentAdapterStatus(config, adapter)).state).toBe('current');
              const receipt = (yield* readAgentIntegrationRegistry(config))!.surfaces![adapter.catalog.id];
              const changedSystem = SystemInfo.of({
                ...testSystem,
                environment: () => ({
                  ...testSystem.environment(),
                  XDG_CONFIG_HOME: path.join(root, 'different-config'),
                }),
              });
              yield* fs.remove(initial.artifacts[0].path);
              yield* installAgentSurface(config, adapter.catalog.id, {apply: true}).pipe(
                Effect.provideService(SystemInfo, changedSystem),
              );
              expect(yield* fs.exists(initial.artifacts[0].path)).toBe(true);
              expect((yield* readAgentIntegrationRegistry(config))!.surfaces![adapter.catalog.id].root).toBe(
                receipt.root,
              );
              yield* removeAgentSurface(config, adapter.catalog.id, true);
              expect(JSON.parse(yield* fs.readFileString(initial.mcpPath))).toEqual(unrelated);
              for (const artifact of initial.artifacts) expect(yield* fs.exists(artifact.path)).toBe(false);
            }).pipe(Effect.provideService(SystemInfo, testSystem));
          }),
        ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
    );
  }

  for (const removeFirst of ['amp', 'codex']) {
    effectIt.effect(`shared skills survive removing ${removeFirst} before the final consumer`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-leases-'});
          const home = path.join(root, 'user');
          const config = runtime(path.join(home, '.threadnote'));
          yield* Effect.gen(function* () {
            yield* installAgentIntegration(config, 'codex', {dryRun: false, name: 'threadnote', toolset: 'core'});
            yield* installAgentSurface(config, 'amp', {apply: true});
            const skill = path.join(home, '.agents', 'skills', 'threadnote-context', 'SKILL.md');
            if (removeFirst === 'amp') yield* removeAgentSurface(config, 'amp', true);
            else yield* removeAgentIntegrations(config, false);
            expect(yield* fs.exists(skill)).toBe(true);
            if (removeFirst === 'amp') yield* removeAgentIntegrations(config, false);
            else yield* removeAgentSurface(config, 'amp', true);
            expect(yield* fs.exists(skill)).toBe(false);
          }).pipe(
            Effect.provideService(
              SystemInfo,
              SystemInfo.of({
                ...system,
                homeDirectory: home,
                environment: () => ({...system.environment(), XDG_CONFIG_HOME: path.join(root, 'config')}),
              }),
            ),
          );
        }),
      ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
    );
  }

  effectIt.effect('refuses unowned MCP entries without writing receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-collision-'});
        const config = runtime(path.join(root, '.threadnote'));
        yield* Effect.gen(function* () {
          const plan = yield* surfacePlan(config, 'gemini');
          yield* fs.makeDirectory(path.dirname(plan.mcpPath), {recursive: true});
          const content = '{"mcpServers":{"threadnote":{"command":"someone-else"}}}';
          yield* fs.writeFileString(plan.mcpPath, content);
          expect((yield* installAgentSurface(config, 'gemini', {apply: true}).pipe(Effect.exit))._tag).toBe('Failure');
          expect(yield* fs.readFileString(plan.mcpPath)).toBe(content);
          expect(yield* readAgentIntegrationRegistry(config)).toBeUndefined();
          expect((yield* agentAdapterStatus(config, getAgentAdapter('gemini')!)).state).toBe('absent');
        }).pipe(Effect.provideService(SystemInfo, SystemInfo.of({...system, homeDirectory: root})));
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('refuses symlinked config, instruction, and skill targets without changing their referents', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-symlink-'});
        const home = path.join(root, 'user');
        const config = runtime(path.join(home, '.threadnote'));
        const testSystem = SystemInfo.of({...system, homeDirectory: home});
        yield* Effect.gen(function* () {
          const plan = yield* surfacePlan(config, 'gemini-cli');
          const cases = [
            {target: plan.mcpPath, label: 'config'},
            {target: plan.artifacts[0].path, label: 'instructions'},
            {target: plan.artifacts[1].path, label: 'skill'},
          ];
          for (const testCase of cases) {
            const referent = path.join(root, `${testCase.label}.txt`);
            yield* fs.makeDirectory(path.dirname(testCase.target), {recursive: true});
            yield* fs.writeFileString(referent, `${testCase.label} referent\n`);
            yield* fs.symlink(referent, testCase.target);

            expect((yield* installAgentSurface(config, 'gemini-cli', {apply: true}).pipe(Effect.exit))._tag).toBe(
              'Failure',
            );
            expect(yield* fs.readLink(testCase.target)).toBe(referent);
            expect(yield* fs.readFileString(referent)).toBe(`${testCase.label} referent\n`);
            expect(yield* readAgentIntegrationRegistry(config)).toBeUndefined();

            yield* fs.remove(testCase.target);
          }
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('aborts a conflict-aware write when the observed target changed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-write-conflict-'});
        const target = path.join(root, 'settings.json');
        yield* fs.writeFileString(target, 'current\n');

        expect(
          (yield* atomicAgentWrite(target, 'replacement\n', 0o600, {content: 'stale\n'}).pipe(Effect.exit))._tag,
        ).toBe('Failure');
        expect(yield* fs.readFileString(target)).toBe('current\n');
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('refuses adapter contract drift instead of orphaning the installed representation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-contract-drift-'});
        const home = path.join(root, 'user');
        const config = runtime(path.join(home, '.threadnote'));
        const adapter = getAgentAdapter('gemini-cli')!;
        const strategy = adapter.json;
        if (strategy === undefined) throw new Error('Gemini fixture has no JSON adapter.');
        const originalContainer = strategy.container;
        const testSystem = SystemInfo.of({...system, homeDirectory: home});

        yield* Effect.gen(function* () {
          yield* installAgentSurface(config, adapter.catalog.id, {apply: true});
          const receipt = (yield* readAgentIntegrationRegistry(config))!.surfaces![adapter.catalog.id];
          const installed = yield* fs.readFileString(receipt.mcp.path);
          if (!Reflect.set(strategy, 'container', 'changedServers'))
            throw new Error('Could not mutate adapter fixture.');

          expect((yield* installAgentSurface(config, adapter.catalog.id, {apply: true}).pipe(Effect.exit))._tag).toBe(
            'Failure',
          );
          expect(yield* fs.readFileString(receipt.mcp.path)).toBe(installed);
          expect((yield* readAgentIntegrationRegistry(config))!.surfaces![adapter.catalog.id]).toEqual(receipt);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!Reflect.set(strategy, 'container', originalContainer))
                throw new Error('Could not restore adapter fixture.');
            }),
          ),
          Effect.provideService(SystemInfo, testSystem),
        );
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('full-uninstall preview includes a shared skill removed after all selected consumers', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-preview-leases-'});
        const home = path.join(root, 'user');
        const config = runtime(path.join(home, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...system,
          homeDirectory: home,
          environment: () => ({...system.environment(), XDG_CONFIG_HOME: path.join(root, 'config')}),
        });
        yield* Effect.gen(function* () {
          yield* installAgentIntegration(config, 'codex', {dryRun: false, name: 'threadnote', toolset: 'core'});
          yield* installAgentSurface(config, 'amp-cli', {apply: true});
          const skill = path.join(home, '.agents', 'skills', 'threadnote-context', 'SKILL.md');

          const preview = yield* captureConsole(removeRegisteredAgentAdaptersInTransaction(config, true, true));

          expect(preview.output).toContain(`Would remove skill threadnote-context: ${skill}`);
          expect(yield* fs.exists(skill)).toBe(true);
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );
});
