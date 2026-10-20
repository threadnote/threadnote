import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'fast-check';
import {expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {runMcpInstall} from '@threadnote/threadnote/mcp/index';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {withoutOmpPathSelectors} from '@threadnote/testing/omp-environment';

const runtime: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-test/seed-manifest.yaml',
  user: 'test-user',
};

fcEffectProp(
  it,
  'preserves semantically current JSON host configs across formatting, key order, and unrelated fields',
  {
    extraEnvironmentValue: FC.string({maxLength: 24}),
    extraFieldValue: FC.oneof(FC.boolean(), FC.integer(), FC.string({maxLength: 24})),
    indentation: FC.constantFrom(0, 1, 2, 4),
    reverseEntryOrder: FC.boolean(),
    reverseRootOrder: FC.boolean(),
  },
  ({extraEnvironmentValue, extraFieldValue, indentation, reverseEntryOrder, reverseRootOrder}) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-property-'}));
        const user = path.join(root, 'user');
        const home = path.join(user, '.threadnote');
        const bin = path.join(root, 'bin');
        const broker = path.join(bin, 'threadnote-mcp-server');
        const configPath = path.join(user, '.cursor', 'mcp.json');
        const environment = {
          EXTRA_USER_VALUE: extraEnvironmentValue,
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_AGENT_ID: 'threadnote',
          THREADNOTE_HOME: home,
          THREADNOTE_MCP_CLIENT: 'cursor',
          THREADNOTE_MCP_SURFACE: 'cursor-desktop',
          THREADNOTE_MCP_TOOLSET: 'core',
          THREADNOTE_USER: 'test-user',
        };
        const testRuntime: RuntimeConfig = {
          ...runtime,
          agentContextHome: home,
          manifestPath: path.join(home, 'seed-manifest.yaml'),
        };
        const server = reverseEntryOrder
          ? {userMetadata: extraFieldValue, env: environment, args: [], command: broker}
          : {command: broker, args: [], env: environment, userMetadata: extraFieldValue};
        const servers = reverseEntryOrder
          ? {unrelated: {command: 'user-server'}, threadnote: server}
          : {threadnote: server, unrelated: {command: 'user-server'}};
        const config = reverseRootOrder
          ? {userSetting: extraFieldValue, mcpServers: servers}
          : {mcpServers: servers, userSetting: extraFieldValue};
        const original = JSON.stringify(config, null, indentation);
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...withoutOmpPathSelectors(baseSystem.environment()), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
        yield* fs.writeFileString(configPath, original);

        // This property isolates MCP JSON preservation; workflow enrollment has
        // its own default/opt-out lifecycle properties in setup-composition.
        yield* runMcpInstall(testRuntime, 'cursor', {apply: true, noDevSkills: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(yield* fs.readFileString(configPath)).toBe(original);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  {fastCheck: {numRuns: 40}},
);

fcEffectProp(
  it,
  'preserves semantically current omp user configs across formatting, key order, and unrelated fields',
  {
    disabledServer: FC.stringMatching(/^[a-z][a-z0-9-]{0,15}$/u).filter(value => value !== 'threadnote'),
    extraFieldValue: FC.oneof(FC.boolean(), FC.integer(), FC.string({maxLength: 24})),
    indentation: FC.constantFrom(0, 1, 2, 4),
    reverseRootOrder: FC.boolean(),
  },
  ({disabledServer, extraFieldValue, indentation, reverseRootOrder}) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-json-mcp-omp-property-'}),
        );
        const user = path.join(root, 'user');
        const home = path.join(user, '.threadnote');
        const bin = path.join(root, 'bin');
        const broker = path.join(bin, 'threadnote-mcp-server');
        const configPath = path.join(user, '.omp', 'agent', 'mcp.json');
        const environment = {
          EXTRA_USER_VALUE: extraFieldValue,
          THREADNOTE_ACCOUNT: 'local',
          THREADNOTE_AGENT_ID: 'threadnote',
          THREADNOTE_HOME: home,
          THREADNOTE_MCP_CLIENT: 'omp',
          THREADNOTE_MCP_SURFACE: 'omp-agent',
          THREADNOTE_MCP_TOOLSET: 'core',
          THREADNOTE_USER: 'test-user',
        };
        const testRuntime: RuntimeConfig = {
          ...runtime,
          agentContextHome: home,
          manifestPath: path.join(home, 'seed-manifest.yaml'),
        };
        const server = {command: broker, args: [], env: environment, type: 'stdio', userMetadata: extraFieldValue};
        const servers = {unrelated: {command: 'user-server'}, threadnote: server};
        const config = reverseRootOrder
          ? {disabledServers: [disabledServer], userSetting: extraFieldValue, mcpServers: servers}
          : {mcpServers: servers, userSetting: extraFieldValue, disabledServers: [disabledServer]};
        const original = JSON.stringify(config, null, indentation);
        const testSystem = SystemInfo.of({
          ...baseSystem,
          environment: () => ({...withoutOmpPathSelectors(baseSystem.environment()), THREADNOTE_BIN_DIR: bin}),
          homeDirectory: user,
          platform: 'linux',
        });
        yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
        yield* fs.writeFileString(configPath, original);

        yield* runMcpInstall(testRuntime, 'omp', {apply: true, noDevSkills: true}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(yield* fs.readFileString(configPath)).toBe(original);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  {fastCheck: {numRuns: 12}},
);
