import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {Command} from 'effect/cli';
import {expect} from 'vitest';
import {isJsonObject, parseJsonConfigObject} from '@threadnote/platform/json';
import {SystemInfo} from '@threadnote/platform/system';
import {rename} from '@threadnote/testing/node-fs-promises';
import {inspectCliInvocation, threadnoteCommand} from '@threadnote/threadnote/effect/cli';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {activateStandaloneRelease} from '@threadnote/threadnote/installations';
import {commandLauncherPath, renderCommandShim} from '@threadnote/threadnote/command-shim';
import {
  AGENT_INTEGRATION_ARTIFACT_VERSION,
  emptyAgentIntegrationRegistry,
  withAgentIntegrationHost,
  writeAgentIntegrationRegistry,
} from '@threadnote/threadnote/agent_integration/registry';
import {runCodexOwnerRefresh} from '../../src/mcp/codex_broker_reload.js';
import {CODEX_MCP_RELEASE_ENV} from '../../src/mcp/codex_broker_rotation.js';
import {StandaloneBrokerLayer} from '../../src/effect/runtime-bootstrap.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

effectIt.effect('requires both explicit Codex flags and an exclusive Codex repair target', () =>
  Effect.gen(function* () {
    const flags = ['--codex-reload-socket', '/private/owner.sock', '--codex-reload-thread', 'known-chat'];
    const run = Command.runWith(threadnoteCommand, {version: '1.0.0'});
    for (const args of [
      ['repair', '--mcp', 'codex', ...flags.slice(0, 2)],
      ['repair', ...flags],
      ['repair', '--mcp', 'none', ...flags],
      ['repair', '--mcp', 'codex', '--core-only', ...flags],
      ['repair', '--mcp', 'codex', '--codex-reload-socket', 'relative.sock', ...flags.slice(2)],
    ]) {
      expect((yield* run(args).pipe(Effect.result))._tag).toBe('Failure');
    }
    const preview = ['repair', '--mcp', 'codex', '--dry-run', ...flags];
    expect(inspectCliInvocation(preview)).toMatchObject({
      observationalCodexRefresh: true,
      writeAnonymousTelemetry: false,
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['repair', '--mcp', 'codex']).observationalCodexRefresh).toBeUndefined();
    expect((yield* run(preview).pipe(Effect.result))._tag).toBe('Success');
  }).pipe(provideTestLayer(ApplicationLayer)),
);

effectIt.effect.skipIf(process.platform === 'win32')(
  'requests only the attested private owner and reports ambiguous replies without replay',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-codex-'}));
      const hostRoot = path.join(root, 'codex');
      const installRoot = path.join(root, 'install');
      const config = {agentContextHome: path.join(root, 'threadnote')};
      // Bazel's temp tree can be long and descend from a group-writable volume.
      // Keep the socket in a short private directory with a trusted ancestry.
      const socketRoot = yield* fs.makeTempDirectoryScoped({directory: yield* fs.realPath('/tmp'), prefix: 'tn-sock-'});
      const socket = path.join(socketRoot, 'owner.sock');
      const configFile = path.join(hostRoot, 'config.toml');
      const version = '6.5.0';
      const releaseRoot = path.join(installRoot, 'versions', version);
      const activePointer = path.join(installRoot, 'active-release.json');
      const nextPointer = path.join(installRoot, 'next-release.json');
      const testSystem = SystemInfo.of({
        ...system,
        homeDirectory: root,
        environment: () => ({THREADNOTE_INSTALL_ROOT: installRoot, THREADNOTE_BIN_DIR: root}),
      });
      const inFixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(SystemInfo, testSystem));
      yield* fs.makeDirectory(hostRoot);
      yield* fs.makeDirectory(releaseRoot, {recursive: true});
      yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), JSON.stringify({version}));
      yield* inFixture(activateStandaloneRelease(releaseRoot, false));
      yield* fs.writeFileString(nextPointer, yield* fs.readFileString(activePointer));
      const launcher = yield* inFixture(commandLauncherPath('mcp'));
      yield* fs.writeFileString(launcher, yield* inFixture(renderCommandShim(releaseRoot, 'mcp')), {mode: 0o700});
      yield* fs.writeFileString(
        configFile,
        `[mcp_servers.fixture]\ncommand = ${JSON.stringify(launcher)}\n[mcp_servers.fixture.env]\nTHREADNOTE_HOME = ${JSON.stringify(config.agentContextHome)}\n`,
      );
      yield* writeAgentIntegrationRegistry(
        config,
        withAgentIntegrationHost(emptyAgentIntegrationRegistry(true), 'codex', {
          artifactVersion: AGENT_INTEGRATION_ARTIFACT_VERSION,
          artifacts: {},
          installedVersion: version,
          mcp: {hostRoot, name: 'fixture', repair: true, toolset: 'core'},
          status: 'current',
        }),
      );

      let profile = configFile;
      let loaded = 'known-chat';
      const chatCwd = path.join(root, 'workspace');
      let projectDisablesEntry = false;
      let failAfterReload = false;
      let replaceGeneration = false;
      const methods: string[] = [];
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            unix: socket,
            fetch(request, server) {
              return server.upgrade(request) ? undefined : new Response(null, {status: 400});
            },
            websocket: {
              async message(peer, message) {
                if (typeof message !== 'string') return;
                const request = parseJsonConfigObject(message);
                if (typeof request?.method !== 'string') return;
                methods.push(request.method);
                if (typeof request.id !== 'number') return;
                const params = isJsonObject(request.params) ? request.params : undefined;
                const result =
                  request.method === 'initialize'
                    ? {userAgent: 'codex-fixture'}
                    : request.method === 'config/read'
                      ? {
                          config: {
                            mcp_servers: {
                              fixture: {
                                command: launcher,
                                enabled: !(projectDisablesEntry && params?.cwd === chatCwd),
                                env: {
                                  THREADNOTE_HOME: config.agentContextHome,
                                  [CODEX_MCP_RELEASE_ENV]: version,
                                },
                              },
                            },
                          },
                          layers: [{name: {type: 'user', file: profile}}],
                        }
                      : request.method === 'thread/loaded/list'
                        ? {data: [loaded]}
                        : request.method === 'thread/read' && params?.includeTurns === false
                          ? {thread: {id: loaded, cwd: chatCwd}}
                          : {};
                const response =
                  failAfterReload && request.method === 'config/mcpServer/reload'
                    ? {id: request.id, error: {code: -32_000, message: 'raw-private-fixture'}}
                    : {id: request.id, result};
                if (replaceGeneration && request.method === 'config/mcpServer/reload') {
                  await rename(nextPointer, activePointer);
                }
                peer.send(JSON.stringify(response));
              },
            },
          }),
        ),
        server => Effect.promise(async () => server.stop(true)),
      );

      const options = {socket, threadId: 'known-chat'};
      const refresh = inFixture(runCodexOwnerRefresh(config, options));
      expect((yield* inFixture(runCodexOwnerRefresh(config, {...options, dryRun: true}))).state).toBe('dry-run');
      expect(methods).toHaveLength(0);
      const link = path.join(socketRoot, 'owner-link.sock');
      yield* fs.symlink(socket, link);
      expect((yield* inFixture(runCodexOwnerRefresh(config, {...options, socket: link}))).state).toBe('pending');
      expect(methods).toHaveLength(0);

      loaded = 'other-chat';
      expect((yield* refresh).state).toBe('pending');
      expect(methods).not.toContain('thread/read');
      loaded = 'known-chat';
      profile = path.join(root, 'wrong-config.toml');
      expect((yield* refresh).state).toBe('pending');
      profile = configFile;
      projectDisablesEntry = true;
      expect((yield* refresh).state).toBe('pending');
      expect(methods).not.toContain('config/mcpServer/reload');

      projectDisablesEntry = false;
      expect(yield* refresh).toEqual({state: 'requested'});
      failAfterReload = true;
      const ambiguous = yield* captureConsole(refresh);
      expect(ambiguous.value.state).toBe('unverified');
      expect(ambiguous.output).not.toContain('raw-private-fixture');
      failAfterReload = false;
      replaceGeneration = true;
      expect((yield* refresh).state).toBe('unverified');
      expect(EffectArray.filter(methods, method => method === 'config/mcpServer/reload')).toHaveLength(3);
    }).pipe(TestClock.withLive, provideTestLayer(StandaloneBrokerLayer)),
);
