import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  commandLauncherPath,
  commandShimCheck,
  configuredLauncherModes,
  installCommandShim,
  managedCommandLauncherKinds,
  primaryCommandLauncherKind,
  removeCommandShim,
  renderCommandShim,
} from '@threadnote/threadnote/command-shim';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';

describe('Windows Git Bash command launchers', () => {
  it('routes generic and legacy OAuth helpers through the standalone boundary', async () => {
    const threadnoteHome = await mkdtemp('threadnote-oauth-helper-');
    try {
      for (const [command, input, error] of [
        ['__credential-oauth-m2m', '{}', 'OAuth graph credential unavailable.\n'],
        ['__credential-registry-oauth-m2m', 'registry.example.test\n', 'OAuth registry credential unavailable.\n'],
        [
          '__credential-registry-oauth-publisher-m2m',
          'registry.example.test\n',
          'OAuth registry credential unavailable.\n',
        ],
        ['__graph-oauth-helper', '{}\n', 'Graph OAuth credential helper is unavailable.\n'],
        ['__graph-auth0-helper', '{}\n', 'Graph OAuth credential helper is unavailable.\n'],
        ['__credential-registry-oauth-user', 'registry.example.test\n', 'OAuth registry credential unavailable.\n'],
        ['__credential-registry-auth0-user', 'registry.example.test\n', 'OAuth registry credential unavailable.\n'],
      ] as const) {
        const child = Bun.spawn([process.execPath, 'apps/threadnote/src/standalone.ts', command, 'get'], {
          cwd: process.cwd(),
          env: {...process.env, THREADNOTE_HOME: threadnoteHome},
          stdin: new Blob([input]),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toBe(error);
      }
    } finally {
      await rm(threadnoteHome, {force: true, recursive: true});
    }
  });

  effectIt.effect('installs cmd and extensionless POSIX launchers for CLI and MCP on Windows', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap(fs => fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shims-'})),
        );
        const {releaseRoot, testSystem} = yield* windowsShimFixture(root);
        const installed = yield* captureConsole(installCommandShim(false, releaseRoot)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(managedCommandLauncherKinds('win32')).toEqual(['cmd', 'posix']);
        expect(managedCommandLauncherKinds('linux')).toEqual(['posix']);
        expect(managedCommandLauncherKinds('darwin')).toEqual(['posix']);
        expect(primaryCommandLauncherKind('win32')).toBe('cmd');
        expect(primaryCommandLauncherKind('linux')).toBe('posix');
        expect(primaryCommandLauncherKind('darwin')).toBe('posix');
        expect(yield* commandLauncherPath('cli').pipe(Effect.provideService(SystemInfo, testSystem))).toMatch(
          /threadnote\.cmd$/,
        );
        expect(yield* commandLauncherPath('mcp').pipe(Effect.provideService(SystemInfo, testSystem))).toMatch(
          /threadnote-mcp-server\.cmd$/,
        );
        expect(
          yield* commandLauncherPath('credential-auth0-m2m').pipe(Effect.provideService(SystemInfo, testSystem)),
        ).toMatch(/threadnote-credential-auth0-m2m\.cmd$/);
        expect(
          yield* commandLauncherPath('credential-registry-auth0-m2m').pipe(
            Effect.provideService(SystemInfo, testSystem),
          ),
        ).toMatch(/docker-credential-threadnote-auth0-m2m\.cmd$/);
        expect(
          yield* commandLauncherPath('credential-registry-auth0-publisher-m2m').pipe(
            Effect.provideService(SystemInfo, testSystem),
          ),
        ).toMatch(/docker-credential-threadnote-auth0-publisher-m2m\.cmd$/);
        expect(
          yield* commandLauncherPath('credential-registry-oauth-user').pipe(
            Effect.provideService(SystemInfo, testSystem),
          ),
        ).toMatch(/docker-credential-threadnote-oauth-user\.cmd$/);
        expect(
          yield* commandLauncherPath('credential-registry-auth0-user').pipe(
            Effect.provideService(SystemInfo, testSystem),
          ),
        ).toMatch(/docker-credential-threadnote-auth0-user\.cmd$/);

        const files = {
          cliCmd: yield* readLauncher(testSystem, 'cli', 'cmd'),
          cliPosix: yield* readLauncher(testSystem, 'cli', 'posix'),
          mcpCmd: yield* readLauncher(testSystem, 'mcp', 'cmd'),
          mcpPosix: yield* readLauncher(testSystem, 'mcp', 'posix'),
        };
        expect(installed.output).toContain(`Wrote command launcher: ${files.cliCmd.path}`);
        expect(installed.output).toContain(`Wrote command launcher: ${files.cliPosix.path}`);
        expect(installed.output).toContain(`Wrote command launcher: ${files.mcpCmd.path}`);
        expect(installed.output).toContain(`Wrote command launcher: ${files.mcpPosix.path}`);
        expect(path.basename(files.cliPosix.path)).toBe('threadnote');
        expect(path.basename(files.mcpPosix.path)).toBe('threadnote-mcp-server');
        expect(files.cliCmd.content).toBe(yield* renderFor(testSystem, releaseRoot, 'cli', 'cmd'));
        expect(files.cliPosix.content).toBe(yield* renderFor(testSystem, releaseRoot, 'cli', 'posix'));
        expect(files.mcpCmd.content).toBe(yield* renderFor(testSystem, releaseRoot, 'mcp', 'cmd'));
        expect(files.mcpPosix.content).toBe(yield* renderFor(testSystem, releaseRoot, 'mcp', 'posix'));
        expect(files.cliPosix.content.startsWith('#!/usr/bin/env sh\n')).toBe(true);
        expect(files.cliPosix.content).toContain('THREADNOTE_CALLER_CWD="$PWD"');
        expect(files.cliPosix.content).toContain('export THREADNOTE_CALLER_CWD');
        expect(files.cliPosix.content).toContain('exec "$THREADNOTE_ENTRY" "$@"');
        expect(files.mcpPosix.content).toContain('exec "$THREADNOTE_ENTRY" mcp-broker "$@"');
        for (const mode of [
          'credential-oauth-m2m',
          'credential-registry-oauth-m2m',
          'credential-registry-oauth-publisher-m2m',
          'credential-registry-oauth-user',
          'credential-auth0-m2m',
          'credential-registry-auth0-m2m',
          'credential-registry-auth0-publisher-m2m',
          'credential-registry-auth0-user',
        ] as const) {
          for (const kind of managedCommandLauncherKinds('win32')) {
            const launcher = yield* commandLauncherPath(mode, kind).pipe(Effect.provideService(SystemInfo, testSystem));
            expect(yield* FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.exists(launcher)))).toBe(false);
          }
        }
        expect(files.cliCmd.content.startsWith('@echo off\r\n')).toBe(true);
        expect(files.cliCmd.content).toContain('%*');

        const repeat = yield* captureConsole(installCommandShim(false, releaseRoot)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(repeat.output).toContain(`Command launcher already current: ${files.cliPosix.path}`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('doctor warns when the Git Bash launcher is missing beside a current cmd launcher', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-doctor-'});
        const {testSystem} = yield* windowsShimFixture(root);
        const cmdPath = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.writeFileString(
          cmdPath,
          yield* renderCommandShim(undefined, 'cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem)),
          {mode: 0o755},
        );

        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('warn');
        expect(check.detail).toBe(`${posixPath} missing; repair will create it`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('doctor warns when the cmd launcher is missing beside a current Git Bash launcher', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-doctor-cmd-'});
        const {testSystem} = yield* windowsShimFixture(root);
        const cmdPath = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.writeFileString(
          posixPath,
          yield* renderCommandShim(undefined, 'cli', 'posix').pipe(Effect.provideService(SystemInfo, testSystem)),
          {mode: 0o755},
        );

        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('warn');
        expect(check.detail).toBe(`${cmdPath} missing; repair will create it`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('doctor warns when the Git Bash launcher points at a different standalone release', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-stale-'});
        const {testSystem} = yield* windowsShimFixture(root);
        const cmdPath = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.writeFileString(
          cmdPath,
          yield* renderCommandShim(undefined, 'cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem)),
          {mode: 0o755},
        );
        yield* fs.writeFileString(
          posixPath,
          yield* renderCommandShim(path.join(root, 'stale-release'), 'cli', 'posix').pipe(
            Effect.provideService(SystemInfo, testSystem),
          ),
          {mode: 0o755},
        );

        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('warn');
        expect(check.detail).toBe(`${posixPath} points at a different standalone release; repair will rewrite it`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('doctor reports all Windows CLI and MCP launchers current after a default install', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap(fs => fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-doctor-ok-'})),
        );
        const {testSystem} = yield* windowsShimFixture(root);
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        const cliCmd = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const cliPosix = yield* commandLauncherPath('cli', 'posix').pipe(Effect.provideService(SystemInfo, testSystem));
        const mcpCmd = yield* commandLauncherPath('mcp', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const mcpPosix = yield* commandLauncherPath('mcp', 'posix').pipe(Effect.provideService(SystemInfo, testSystem));
        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('ok');
        expect(check.detail).toBe(`${cliCmd}; ${cliPosix}; ${mcpCmd}; ${mcpPosix}`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs configured legacy helpers and removes obsolete managed helpers on Windows', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-configured-shims-'});
        const {testSystem} = yield* windowsShimFixture(root);
        const home = testSystem.environment().THREADNOTE_HOME!;
        const dockerDirectory = testSystem.environment().DOCKER_CONFIG!;
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* fs.makeDirectory(path.join(home, 'graph-sharing'), {recursive: true});
        yield* fs.makeDirectory(dockerDirectory, {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'graph-sharing', 'control-credentials.json'),
          JSON.stringify({schemaVersion: 1, bindings: [{helper: 'auth0-m2m'}]}),
        );
        yield* fs.writeFileString(
          path.join(dockerDirectory, 'config.json'),
          JSON.stringify({credHelpers: {'registry.example.test': 'threadnote-auth0-user'}}),
        );
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        for (const mode of ['credential-auth0-m2m', 'credential-registry-auth0-user'] as const) {
          for (const kind of managedCommandLauncherKinds('win32')) {
            const launcher = yield* commandLauncherPath(mode, kind).pipe(Effect.provideService(SystemInfo, testSystem));
            expect(yield* fs.readFileString(launcher)).toContain(`__${mode}`);
          }
        }
        expect((yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem))).status).toBe('ok');
        const missingRequired = yield* commandLauncherPath('credential-registry-auth0-user', 'cmd').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.remove(missingRequired);
        expect((yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem))).detail).toBe(
          `${missingRequired} missing; repair will create it`,
        );
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        expect(yield* fs.exists(missingRequired)).toBe(true);

        yield* fs.remove(path.join(home, 'graph-sharing', 'control-credentials.json'));
        yield* fs.remove(path.join(dockerDirectory, 'config.json'));
        const foreign = yield* commandLauncherPath('credential-registry-oauth-user', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.writeFileString(foreign, '#!/bin/sh\necho user-owned\n');
        const linked = yield* commandLauncherPath('credential-registry-oauth-m2m', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const managedTarget = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        yield* fs.symlink(managedTarget, linked);
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        for (const mode of ['credential-auth0-m2m', 'credential-registry-auth0-user'] as const) {
          for (const kind of managedCommandLauncherKinds('win32')) {
            const launcher = yield* commandLauncherPath(mode, kind).pipe(Effect.provideService(SystemInfo, testSystem));
            expect(yield* fs.exists(launcher)).toBe(false);
          }
        }
        expect(yield* fs.readFileString(foreign)).toBe('#!/bin/sh\necho user-owned\n');
        expect(yield* fs.readLink(linked)).toBe(managedTarget);
        expect((yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem))).status).toBe('ok');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps configured helpers when Docker requirements cannot be read safely', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-unknown-helper-config-'});
        const {testSystem} = yield* windowsShimFixture(root);
        const dockerDirectory = testSystem.environment().DOCKER_CONFIG!;
        const dockerConfig = path.join(dockerDirectory, 'config.json');
        yield* fs.makeDirectory(dockerDirectory, {recursive: true});
        yield* fs.writeFileString(
          dockerConfig,
          JSON.stringify({credHelpers: {'registry.example.test': 'threadnote-auth0-user'}}),
        );
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        const helper = yield* commandLauncherPath('credential-registry-auth0-user', 'cmd').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const original = yield* fs.readFileString(helper);

        yield* fs.writeFileString(dockerConfig, JSON.stringify({padding: 'x'.repeat(65_536)}));
        const oversized = yield* installCommandShim(false).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.flip,
        );
        expect(String(oversized)).toContain('exceeds 64 KiB');
        expect(yield* fs.readFileString(helper)).toBe(original);
        const doctor = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem), Effect.flip);
        expect(String(doctor)).toContain('exceeds 64 KiB');

        yield* fs.writeFileString(dockerConfig, '{');
        const malformed = yield* installCommandShim(false).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.flip,
        );
        expect(String(malformed)).toContain('configuration is invalid');
        expect(yield* fs.readFileString(helper)).toBe(original);

        yield* fs.writeFileString(
          dockerConfig,
          JSON.stringify({credHelpers: {'registry.example.test': 'threadnote-auth0-user'}}),
        );
        const failingFs = FileSystem.FileSystem.of({
          ...fs,
          readFileString: file =>
            file === dockerConfig ? fs.readFileString(path.join(root, 'missing-config')) : fs.readFileString(file),
        });
        const unreadable = yield* installCommandShim(false).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.provideService(FileSystem.FileSystem, failingFs),
          Effect.flip,
        );
        expect(String(unreadable)).toContain('configuration is unavailable');
        expect(yield* fs.readFileString(helper)).toBe(original);

        const relativeDockerSystem = SystemInfo.of({
          ...testSystem,
          environment: () => ({...testSystem.environment(), DOCKER_CONFIG: 'relative-docker-config'}),
        });
        const relative = yield* installCommandShim(false).pipe(
          Effect.provideService(SystemInfo, relativeDockerSystem),
          Effect.flip,
        );
        expect(String(relative)).toContain('must be absolute');
        expect(yield* fs.readFileString(helper)).toBe(original);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('launcher selection is stable under duplicate and reordered configuration', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('oauth-m2m', 'auth0-m2m', 'custom'), {maxLength: 10}),
        fc.array(
          fc.constantFrom(
            'threadnote-oauth-m2m',
            'threadnote-oauth-publisher-m2m',
            'threadnote-auth0-m2m',
            'threadnote-auth0-publisher-m2m',
            'threadnote-oauth-user',
            'threadnote-auth0-user',
            'other',
          ),
          {maxLength: 10},
        ),
        (control, docker) => {
          const selected = configuredLauncherModes(
            {schemaVersion: 1, bindings: control.map(helper => ({helper}))},
            {credHelpers: Object.fromEntries(docker.map((helper, index) => [String(index), helper]))},
          );
          const reversed = configuredLauncherModes(
            {schemaVersion: 1, bindings: [...control, ...control].reverse().map(helper => ({helper}))},
            {
              credHelpers: Object.fromEntries(
                [...docker, ...docker].reverse().map((helper, index) => [String(index), helper]),
              ),
            },
          );
          expect(selected).toEqual(reversed);
          expect(selected.slice(0, 2)).toEqual(['cli', 'mcp']);
          expect(new Set(selected).size).toBe(selected.length);
          for (const [helper, mode] of [
            ['oauth-m2m', 'credential-oauth-m2m'],
            ['auth0-m2m', 'credential-auth0-m2m'],
          ] as const) {
            expect(selected.includes(mode)).toBe(control.includes(helper));
          }
          for (const [helper, mode] of [
            ['threadnote-oauth-m2m', 'credential-registry-oauth-m2m'],
            ['threadnote-oauth-publisher-m2m', 'credential-registry-oauth-publisher-m2m'],
            ['threadnote-oauth-user', 'credential-registry-oauth-user'],
            ['threadnote-auth0-m2m', 'credential-registry-auth0-m2m'],
            ['threadnote-auth0-publisher-m2m', 'credential-registry-auth0-publisher-m2m'],
            ['threadnote-auth0-user', 'credential-registry-auth0-user'],
          ] as const) {
            expect(selected.includes(mode)).toBe(docker.includes(helper));
          }
        },
      ),
      {numRuns: 80},
    );
  });

  effectIt.effect('doctor warns when the Git Bash MCP launcher is missing beside current CLI launchers', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-doctor-mcp-'});
        const {testSystem} = yield* windowsShimFixture(root);
        yield* installCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        const mcpPosix = yield* commandLauncherPath('mcp', 'posix').pipe(Effect.provideService(SystemInfo, testSystem));
        yield* fs.remove(mcpPosix);
        const check = yield* commandShimCheck().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(check.status).toBe('warn');
        expect(check.detail).toBe(`${mcpPosix} missing; repair will create it`);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not overwrite an unmanaged Git Bash launcher and still writes the cmd launcher', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-unmanaged-'});
        const {releaseRoot, testSystem} = yield* windowsShimFixture(root);
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const unmanaged = '#!/usr/bin/env bash\necho "Generated by threadnote is documentation, not ownership"\n';
        yield* fs.writeFileString(posixPath, unmanaged, {mode: 0o755});

        const installed = yield* captureConsole(installCommandShim(false, releaseRoot)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(installed.output).toContain(`WARN not overwriting unmanaged command launcher: ${posixPath}`);
        expect(yield* fs.readFileString(posixPath)).toBe(unmanaged);
        const cmd = yield* readLauncher(testSystem, 'cli', 'cmd');
        expect(cmd.content).toBe(yield* renderFor(testSystem, releaseRoot, 'cli', 'cmd'));
        expect(path.basename(posixPath)).toBe('threadnote');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes a managed Git Bash launcher without touching an unmanaged cmd launcher', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-mixed-remove-'});
        const {releaseRoot, testSystem} = yield* windowsShimFixture(root);
        const cmdPath = yield* commandLauncherPath('cli', 'cmd').pipe(Effect.provideService(SystemInfo, testSystem));
        const posixPath = yield* commandLauncherPath('cli', 'posix').pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        const unmanaged = '@echo off\r\necho unmanaged\r\n';
        yield* fs.writeFileString(cmdPath, unmanaged, {mode: 0o755});
        yield* installCommandShim(false, releaseRoot).pipe(Effect.provideService(SystemInfo, testSystem));
        const removed = yield* captureConsole(removeCommandShim(false)).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );

        expect(removed.output).toContain(`WARN not removing unmanaged command launcher: ${cmdPath}`);
        expect(yield* fs.readFileString(cmdPath)).toBe(unmanaged);
        expect(yield* fs.exists(posixPath)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes managed Windows cmd and POSIX launchers together', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-win-shim-remove-'});
        const {releaseRoot, testSystem} = yield* windowsShimFixture(root);
        yield* installCommandShim(false, releaseRoot).pipe(Effect.provideService(SystemInfo, testSystem));
        yield* removeCommandShim(false).pipe(Effect.provideService(SystemInfo, testSystem));
        for (const mode of [
          'cli',
          'mcp',
          'credential-oauth-m2m',
          'credential-registry-oauth-m2m',
          'credential-registry-oauth-publisher-m2m',
          'credential-auth0-m2m',
          'credential-registry-auth0-m2m',
          'credential-registry-auth0-publisher-m2m',
          'credential-registry-oauth-user',
          'credential-registry-auth0-user',
        ] as const) {
          for (const kind of managedCommandLauncherKinds('win32')) {
            const launcher = yield* commandLauncherPath(mode, kind).pipe(Effect.provideService(SystemInfo, testSystem));
            expect(yield* fs.exists(launcher)).toBe(false);
          }
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'Windows POSIX shims are LF shebang scripts that exec the same release exe as the cmd launcher',
    {
      mode: fc.constantFrom(
        'cli' as const,
        'mcp' as const,
        'credential-oauth-m2m' as const,
        'credential-registry-oauth-m2m' as const,
        'credential-registry-oauth-publisher-m2m' as const,
        'credential-registry-oauth-user' as const,
        'credential-auth0-m2m' as const,
        'credential-registry-auth0-m2m' as const,
        'credential-registry-auth0-publisher-m2m' as const,
        'credential-registry-auth0-user' as const,
      ),
      variant: fc.constantFrom('plain' as const, 'spaced' as const),
      version: fc.stringMatching(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    },
    ({mode, variant, version}) =>
      Effect.gen(function* () {
        const baseSystem = yield* SystemInfo;
        const releaseRoot =
          variant === 'plain'
            ? `C:\\Threadnote\\versions\\${version}`
            : `C:\\Users\\John Doe\\Threadnote\\versions\\${version}`;
        const testSystem = SystemInfo.of({...baseSystem, platform: 'win32'});
        const [cmd, posix] = yield* Effect.all([
          renderCommandShim(releaseRoot, mode, 'cmd'),
          renderCommandShim(releaseRoot, mode, 'posix'),
        ]).pipe(Effect.provideService(SystemInfo, testSystem));
        const posixEntry = posixEntryPath(posix);
        const cmdEntry = cmdEntryPath(cmd);
        expect(cmd.includes('\r\n')).toBe(true);
        expect(posix.includes('\r')).toBe(false);
        expect(posix.includes('\\')).toBe(false);
        expect(posix.startsWith('#!/usr/bin/env sh\n')).toBe(true);
        expect(posix).toContain('THREADNOTE_CALLER_CWD="$PWD"');
        expect(posixEntry).toBe(cmdEntry.replaceAll('\\', '/'));
        expect(posixEntry).toContain(`/${version}/threadnote.exe`);
        expect(cmdEntry.replaceAll('\\', '/')).toContain(`/${version}/threadnote.exe`);
        if (variant === 'plain') {
          expect(posix).toContain(`THREADNOTE_ENTRY=C:/Threadnote/versions/${version}/threadnote.exe`);
        } else {
          expect(posix).toContain(`THREADNOTE_ENTRY='C:/Users/John Doe/Threadnote/versions/${version}/threadnote.exe'`);
        }
        expect(posix).toContain('exec "$THREADNOTE_ENTRY"');
        if (mode === 'mcp') {
          expect(posix).toContain('mcp-broker');
          expect(cmd).toContain('mcp-broker');
        } else if (
          mode === 'credential-oauth-m2m' ||
          mode === 'credential-registry-oauth-m2m' ||
          mode === 'credential-registry-oauth-publisher-m2m' ||
          mode === 'credential-registry-oauth-user'
        ) {
          expect(posix).toContain(`__${mode}`);
          expect(cmd).toContain(`__${mode}`);
        } else if (mode === 'credential-auth0-m2m') {
          expect(posix).toContain('__credential-auth0-m2m');
          expect(cmd).toContain('__credential-auth0-m2m');
        } else if (mode === 'credential-registry-auth0-m2m') {
          expect(posix).toContain('__credential-registry-auth0-m2m');
          expect(cmd).toContain('__credential-registry-auth0-m2m');
        } else if (mode === 'credential-registry-auth0-publisher-m2m') {
          expect(posix).toContain('__credential-registry-auth0-publisher-m2m');
          expect(cmd).toContain('__credential-registry-auth0-publisher-m2m');
        } else if (mode === 'credential-registry-auth0-user') {
          expect(posix).toContain('__credential-registry-auth0-user');
          expect(cmd).toContain('__credential-registry-auth0-user');
        } else {
          expect(posix).not.toContain('mcp-broker');
          expect(cmd).not.toContain('mcp-broker');
        }
      }).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 40}},
  );
});

const windowsShimFixture = Effect.fn('test.windowsShimFixture')(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseSystem = yield* SystemInfo;
  const binDirectory = path.join(root, 'bin');
  const releaseRoot = path.join(root, 'versions', '4.6.3');
  yield* fs.makeDirectory(binDirectory, {recursive: true});
  const testSystem = SystemInfo.of({
    ...baseSystem,
    environment: () => ({
      ...baseSystem.environment(),
      DOCKER_CONFIG: path.join(root, 'docker'),
      THREADNOTE_BIN_DIR: binDirectory,
      THREADNOTE_HOME: path.join(root, 'home'),
    }),
    homeDirectory: root,
    platform: 'win32',
  });
  return {binDirectory, releaseRoot, testSystem};
});

const renderFor = (
  testSystem: SystemInfoShape,
  releaseRoot: string,
  mode:
    | 'cli'
    | 'mcp'
    | 'credential-auth0-m2m'
    | 'credential-registry-auth0-m2m'
    | 'credential-registry-auth0-publisher-m2m'
    | 'credential-registry-auth0-user',
  kind: 'cmd' | 'posix',
) => renderCommandShim(releaseRoot, mode, kind).pipe(Effect.provideService(SystemInfo, testSystem));

const readLauncher = Effect.fn('test.readLauncher')(function* (
  testSystem: SystemInfoShape,
  mode:
    | 'cli'
    | 'mcp'
    | 'credential-auth0-m2m'
    | 'credential-registry-auth0-m2m'
    | 'credential-registry-auth0-publisher-m2m'
    | 'credential-registry-auth0-user',
  kind: 'cmd' | 'posix',
) {
  const fs = yield* FileSystem.FileSystem;
  const launcherPath = yield* commandLauncherPath(mode, kind).pipe(Effect.provideService(SystemInfo, testSystem));
  return {content: yield* fs.readFileString(launcherPath), path: launcherPath};
});

function posixEntryPath(posix: string): string {
  const match = /^THREADNOTE_ENTRY=(.*)$/m.exec(posix);
  expect(match?.[1]).toEqual(expect.any(String));
  const raw = match?.[1] ?? '';
  return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replaceAll("'\"'\"'", "'") : raw;
}

function cmdEntryPath(cmd: string): string {
  const line = cmd.split(/\r?\n/u).find(candidate => candidate.includes('threadnote.exe'));
  expect(line).toEqual(expect.any(String));
  const match = /^"([^"]*)"/u.exec(line ?? '');
  expect(match?.[1]).toEqual(expect.any(String));
  return (match?.[1] ?? '').replaceAll('%%', '%').replaceAll('""', '"');
}
