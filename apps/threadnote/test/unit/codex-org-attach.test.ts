import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, PlatformError, Predicate} from 'effect';
import {describe, expect, it} from 'vitest';
import {parse} from 'smol-toml';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer, StandaloneBrokerLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  renderCodexOrgMcpConfig,
  runCodexOrgMcpInstall,
  supportsCodexOrgOAuth,
} from '@threadnote/threadnote/mcp/codex_org_attach';
import {resolveComposerAttach, type ComposerShareBinding} from '@threadnote/threadnote/mcp/composer_attach';
import {runMcpInstall} from '@threadnote/threadnote/mcp/install';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const attach: ComposerShareBinding = {
  clientId: 'registered-codex',
  url: 'https://composer.example.test/mcp',
  shareId: 'engineering',
  additionalScopes: ['offline_access'],
  callback: {url: 'http://127.0.0.1:18789/callback/client-specific', port: 18789},
};
const original =
  '# keep comments\nmodel = "configured-model"\nmcp_oauth_callback_port = 12345\n[mcp_servers."threadnote"]\ncommand = "personal-stdio"\nargs = ["mcp"]\n[mcp_servers.threadnote.env]\nTHREADNOTE_HOME = "/personal/home"\n[projects."/repo"]\ntrust_level = "trusted"\n';

describe('Codex organization attach', () => {
  effectIt.effect.each([
    'apply',
    'legacy',
    'concurrent',
    'unreadable-initial',
    'unreadable-final',
    'unreadable-always',
  ] as const)('native install handles %s without touching personal stdio', mode =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const baseCommands = yield* CommandExecutor;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'codex-org-install-'});
        const configPath = path.join(root, 'config.toml');
        const bin = path.join(root, 'bin');
        yield* fs.makeDirectory(bin);
        yield* fs.writeFileString(path.join(bin, 'codex'), '', {mode: 0o755});
        yield* fs.writeFileString(configPath, original);
        yield* fs.chmod(configPath, 0o640);
        let configReads = 0;
        const guardedFs = FileSystem.FileSystem.of({
          ...fs,
          readFileString: (file, encoding) =>
            Effect.gen(function* () {
              if (file === configPath) {
                configReads++;
                if (
                  (mode === 'unreadable-initial' && configReads === 1) ||
                  (mode === 'unreadable-final' && configReads === 2) ||
                  mode === 'unreadable-always'
                ) {
                  return yield* PlatformError.systemError({
                    _tag: 'PermissionDenied',
                    module: 'FileSystem',
                    method: 'readFileString',
                    pathOrDescriptor: file,
                  });
                }
              }
              return yield* fs.readFileString(file, encoding);
            }),
        });
        const calls: (readonly string[])[] = [];
        const commands = CommandExecutor.of({
          ...baseCommands,
          execute: (_executable, args) =>
            Effect.gen(function* () {
              calls.push(args);
              if (mode === 'concurrent')
                yield* fs.writeFileString(configPath, `${original}# concurrent edit\n`).pipe(Effect.orDie);
              return {exitCode: 0, stderr: '', stdout: `codex-cli ${mode === 'legacy' ? '0.144.5' : '0.153.4'}\n`};
            }),
        });
        const system = SystemInfo.of({
          ...baseSystem,
          platform: 'linux',
          environment: () => ({PATH: bin, CODEX_HOME: root}),
        });
        const install = captureConsole(runCodexOrgMcpInstall(attach, true)).pipe(
          Effect.provideService(SystemInfo, system),
          Effect.provideService(CommandExecutor, commands),
          Effect.provideService(FileSystem.FileSystem, guardedFs),
        );
        const result = yield* install.pipe(Effect.result);
        const after = yield* fs.readFileString(configPath);
        if (mode === 'apply') {
          expect(result._tag).toBe('Success');
          expect(after).toBe(renderCodexOrgMcpConfig(original, attach));
          const repeated = yield* install;
          expect(repeated.output).toContain('Already configured:');
          expect(yield* fs.readFileString(configPath)).toBe(after);
        } else {
          expect(result._tag).toBe('Failure');
          expect(after).toBe(mode === 'concurrent' ? `${original}# concurrent edit\n` : original);
        }
        if (baseSystem.platform !== 'win32') expect((yield* fs.stat(configPath)).mode & 0o777).toBe(0o640);
        expect(EffectArray.every(calls, args => args.length === 1 && args[0] === '--version')).toBe(true);
        if (mode === 'unreadable-initial' || mode === 'unreadable-always') expect(calls).toEqual([]);
        expect(
          EffectArray.filter(
            yield* fs.readDirectory(root),
            __effectArrayValue =>
              !!(name => Effect2.pipe(name, EffectString.startsWith('.threadnote-org')))(__effectArrayValue),
          ),
        ).toEqual([]);
      }),
    ).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  effectIt.effect.each(['readable', 'dangling'] as const)('preserves a %s config symlink and its target', mode =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        if (baseSystem.platform === 'win32') return;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'codex-org-link-'});
        const configPath = path.join(root, 'config.toml');
        const target = path.join(root, 'managed-config.toml');
        if (mode === 'readable') yield* fs.writeFileString(target, original);
        yield* fs.symlink(target, configPath);
        const result = yield* runCodexOrgMcpInstall(attach, true).pipe(
          Effect.provideService(SystemInfo, SystemInfo.of({...baseSystem, environment: () => ({CODEX_HOME: root})})),
          Effect.result,
        );
        expect(result._tag).toBe('Failure');
        expect(yield* fs.readLink(configPath)).toBe(target);
        if (mode === 'readable') expect(yield* fs.readFileString(target)).toBe(original);
        else expect(yield* fs.exists(target)).toBe(false);
        expect(
          EffectArray.filter(
            yield* fs.readDirectory(root),
            __effectArrayValue =>
              !!(name => Effect2.pipe(name, EffectString.startsWith('.threadnote-org')))(__effectArrayValue),
          ),
        ).toEqual([]);
      }),
    ).pipe(provideTestLayer(StandaloneBrokerLayer)),
  );

  it('rejects comma-bearing scopes only at the Codex native login boundary', () => {
    expect(() => renderCodexOrgMcpConfig(original, {...attach, additionalScopes: ['custom,scope']})).toThrow('comma');
    expect(
      resolveComposerAttach({composerUrl: attach.url, shareId: attach.shareId, composerOAuthScopes: ['custom,scope']})
        ?.additionalScopes,
    ).toEqual(['custom,scope']);
  });

  it('appends native configuration and preserves every prior byte and value', () => {
    const proposed = renderCodexOrgMcpConfig(original, attach);
    expect(Effect2.pipe(proposed, EffectString.startsWith(original))).toBe(true);
    const actual = parse(proposed);
    const originalConfig = parse(original);
    if (!Predicate.isObject(actual.mcp_servers) || !Predicate.isObject(originalConfig.mcp_servers))
      throw new Error('Expected parsed MCP server tables.');
    const servers = actual.mcp_servers;
    expect(servers.threadnote).toEqual(originalConfig.mcp_servers.threadnote);
    expect(actual.mcp_oauth_callback_port).toBe(12345);
    expect(servers['threadnote-org']).toMatchObject({
      url: attach.url,
      http_headers: {'threadnote-share-id': attach.shareId},
      oauth: {client_id: attach.clientId, callback_url: attach.callback?.url, callback_port: 18789},
    });
    expect(servers['threadnote-org']).not.toHaveProperty('oauth_resource');
    expect(renderCodexOrgMcpConfig(proposed, attach)).toBe(proposed);
    expect(renderCodexOrgMcpConfig(proposed, {...attach, callback: undefined})).toBe(proposed);
  });

  it('preserves compatible extra settings and disabled state without rewriting', () => {
    const proposed = Effect2.pipe(
      renderCodexOrgMcpConfig(original, attach),
      EffectString.replace(
        '[mcp_servers.threadnote-org]',
        '[mcp_servers.threadnote-org]\nenabled = false\ntool_timeout_sec = 45',
      ),
    );
    expect(renderCodexOrgMcpConfig(proposed, attach)).toBe(proposed);
  });

  it('rejects parse, inline table and conflicting binding/scope/callback changes', () => {
    for (const content of [
      'invalid = [',
      'mcp_servers = "wrong"',
      'mcp_servers = { threadnote = {command = "keep"} }',
    ]) {
      expect(() => renderCodexOrgMcpConfig(content, attach)).toThrow();
    }
    const proposed = renderCodexOrgMcpConfig(original, attach);
    for (const changed of [
      {...attach, shareId: 'other'},
      {...attach, additionalScopes: []},
      {...attach, callback: {url: 'http://127.0.0.1:18790/callback', port: 18790}},
    ]) {
      expect(() => renderCodexOrgMcpConfig(proposed, changed)).toThrow('conflicts');
    }
    expect(() => renderCodexOrgMcpConfig('', {...attach, callback: undefined})).toThrow('callback');
    expect(() => renderCodexOrgMcpConfig('', {...attach, clientId: undefined})).toThrow('registered');
  });

  it.each([
    'http://localhost:18789/callback',
    'https://127.0.0.1:18789/callback',
    'http://127.0.0.1:18788/callback',
    'http://user@127.0.0.1:18789/callback',
    'http://127.0.0.1:18789/callback?x=1',
  ])('rejects an invalid direct callback %#', composerCallbackUrl => {
    expect(() =>
      resolveComposerAttach({
        composerUrl: attach.url,
        shareId: attach.shareId,
        composerCallbackUrl,
        composerCallbackPort: 18789,
      }),
    ).toThrow('callback');
  });

  it('requires a stable supported version', () => {
    expect(supportsCodexOrgOAuth('codex-cli 0.153.4\n')).toBe(true);
    expect(supportsCodexOrgOAuth('codex-cli 0.154.0')).toBe(true);
    for (const version of ['codex-cli 0.144.5', 'codex-cli 0.153.3', 'codex-cli 0.153.4-alpha.1', 'unknown'])
      expect(supportsCodexOrgOAuth(version)).toBe(false);
  });

  effectIt.effect('dry run and rejected options leave config and receipts absent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseSystem = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'codex-org-preview-'});
        const home = path.join(root, 'team-home');
        const system = SystemInfo.of({
          ...baseSystem,
          homeDirectory: root,
          environment: () => ({CODEX_HOME: path.join(root, 'codex')}),
        });
        const config = {
          account: 'local',
          agentContextHome: home,
          agentId: 'test',
          manifestPath: path.join(home, 'seed.yaml'),
          user: 'test',
        };
        const options = {
          composerClientId: attach.clientId,
          composerUrl: attach.url,
          shareId: attach.shareId,
          composerOAuthScopes: attach.additionalScopes,
          composerCallbackUrl: attach.callback?.url,
          composerCallbackPort: attach.callback?.port,
        };
        const preview = yield* captureConsole(runMcpInstall(config, 'codex', options)).pipe(
          Effect.provideService(SystemInfo, system),
        );
        expect(preview.output).toContain('mcp login threadnote-org --scopes');
        expect(preview.output).toContain('offline_access');
        expect(yield* fs.exists(home)).toBe(false);
        expect(yield* fs.exists(path.join(root, 'codex'))).toBe(false);
        for (const agent of ['cursor', 'copilot', 'claude'] as const) {
          const result = yield* runMcpInstall(config, agent, {...options, apply: true, project: root}).pipe(
            Effect.provideService(SystemInfo, system),
            Effect.result,
          );
          expect(result._tag).toBe('Failure');
        }
        expect(yield* fs.exists(home)).toBe(false);
        expect(yield* fs.exists(path.join(root, '.cursor'))).toBe(false);
        expect(yield* fs.exists(path.join(root, '.vscode'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
