import {describe, expect, it} from 'vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {fromPromise} from '@threadnote/platform/errors';
import {isGitExecutable, resolveCommandInvocation, runCommandEffect} from '@threadnote/platform/command';
import {resolveHomeDirectory, runtimeLstat, SystemInfo} from '@threadnote/platform/system';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import {executableNames} from '@threadnote/threadnote/utils';

import {publishStagedCodexConfiguration, stageCodexConfiguration} from '../../src/mcp/codex_configuration_write.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';

const codexWriteLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

effectIt.layer(codexWriteLayer)(windows => {
  windows.effect('creates and updates a Codex config while preserving the explicit Windows DACL and owner', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      if (system.platform !== 'win32') return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({
        prefix: 'codex config & [rotation]-',
      });
      const target = path.join(home, 'config.toml');
      const initial = yield* stageCodexConfiguration(home, target, undefined, 'first');
      expect(yield* publishStagedCodexConfiguration(target, initial, false, Effect.succeed(true))).toBe(true);
      expect(yield* fs.readFileString(target)).toBe('first');

      const environment = system.environment();
      const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows';
      const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const inspect = `
$ErrorActionPreference = 'Stop'
$file = $env:THREADNOTE_TEST_CODEX_TARGET
$sections = [Security.AccessControl.AccessControlSections]'Owner, Group, Access'
$acl = [IO.File]::GetAccessControl($file, $sections)
if ($env:THREADNOTE_TEST_CODEX_RESTRICT -eq '1') {
  $acl.SetAccessRuleProtection($true, $true)
  [IO.File]::SetAccessControl($file, $acl)
  $acl = [IO.File]::GetAccessControl($file, $sections)
}
[Console]::Out.Write($acl.GetSecurityDescriptorSddlForm($sections))
`;
      const descriptor = (restrict: boolean) =>
        runCommandEffect(powershell, ['-NoProfile', '-NonInteractive', '-Command', inspect], {
          timeoutMs: 5000,
          env: {
            ...environment,
            THREADNOTE_TEST_CODEX_TARGET: target,
            THREADNOTE_TEST_CODEX_RESTRICT: restrict ? '1' : '0',
          },
        });
      const expected = (yield* descriptor(true)).stdout;
      expect(expected).toMatch(/D:P/u);
      const before = yield* fromPromise('test.readWindowsCodexConfigStat', () => runtimeLstat(target));
      const next = yield* stageCodexConfiguration(home, target, before, 'updated');
      expect(yield* publishStagedCodexConfiguration(target, next, true, Effect.succeed(true))).toBe(true);
      expect(yield* fs.readFileString(target)).toBe('updated');
      expect((yield* descriptor(false)).stdout).toBe(expected);

      const labeled = path.join(home, 'with-integrity-label.toml');
      yield* fs.writeFileString(labeled, 'original integrity label');
      const icacls = path.join(root, 'System32', 'icacls.exe');
      const setLabel = yield* runCommandEffect(icacls, [labeled, '/setintegritylevel', 'L'], {
        timeoutMs: 5000,
        allowFailure: true,
      });
      if (setLabel.exitCode === 0) {
        const labelBefore = yield* runCommandEffect(icacls, [labeled], {timeoutMs: 5000});
        expect(labelBefore.exitCode).toBe(0);
        const stats = yield* fromPromise('test.readLabeledCodexConfigStat', () => runtimeLstat(labeled));
        const mismatch = yield* stageCodexConfiguration(home, labeled, stats, 'would remove label').pipe(Effect.result);
        expect(Result.isFailure(mismatch) && mismatch.failure.message).toBe(
          'Windows Codex configuration integrity labels differ.',
        );
        expect(yield* fs.readFileString(labeled)).toBe('original integrity label');
        expect((yield* runCommandEffect(icacls, [labeled], {timeoutMs: 5000})).stdout).toBe(labelBefore.stdout);
      }

      const stream = `${target}:threadnote-test`;
      yield* fs.writeFileString(stream, 'existing NTFS stream');
      const after = yield* fromPromise('test.readWindowsCodexConfigStat', () => runtimeLstat(target));
      const unsupported = yield* stageCodexConfiguration(home, target, after, 'would lose stream').pipe(Effect.result);
      expect(Result.isFailure(unsupported)).toBe(true);
      expect(yield* fs.readFileString(stream)).toBe('existing NTFS stream');
      expect(yield* fs.readFileString(target)).toBe('updated');
    }).pipe(TestClock.withLive),
  );
});

describe('Windows platform contracts', () => {
  it('expands PATHEXT for extensionless commands and preserves explicit launchers', () => {
    expect(executableNames('node', 'win32', '.COM;.EXE;.CMD')).toEqual(['node.COM', 'node.EXE', 'node.CMD', 'node']);
    expect(executableNames('threadnote.cmd', 'win32', '.COM;.EXE;.CMD')).toEqual(['threadnote.cmd']);
  });

  it('routes cmd launchers through ComSpec without changing native executable arguments', () => {
    expect(
      resolveCommandInvocation(
        'C:\\Program Files\\nodejs\\npm.cmd',
        ['install', 'package with spaces'],
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual({
      args: [],
      executable: 'C:\\Program^ Files\\nodejs\\npm.cmd ^"install^" ^"package^ with^ spaces^"',
      shell: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(resolveCommandInvocation('C:\\Program Files\\nodejs\\node.exe', ['--version'], 'win32')).toEqual({
      args: ['--version'],
      executable: 'C:\\Program Files\\nodejs\\node.exe',
    });
  });

  it('recognizes resolved Git launchers for environment sanitization', () => {
    expect(isGitExecutable('C:\\Program Files\\Git\\cmd\\git.EXE')).toBe(true);
    expect(isGitExecutable('C:\\tools\\git.cmd')).toBe(true);
    expect(isGitExecutable('C:\\tools\\not-git.exe')).toBe(false);
  });

  it('uses Windows home variables without requiring HOME', () => {
    expect(resolveHomeDirectory({USERPROFILE: 'C:\\Users\\dev'}, 'win32')).toBe('C:\\Users\\dev');
    expect(resolveHomeDirectory({HOMEDRIVE: 'D:', HOMEPATH: '\\Profiles\\dev'}, 'win32')).toBe('D:\\Profiles\\dev');
  });

  it('rejects Windows reserved names in portable resource identifiers', () => {
    expect(() => validatePortableSegment('CON', 'CON')).toThrow(/reserved/i);
    expect(() => validatePortableSegment('notes.', 'notes.')).toThrow();
    expect(() => validatePortableSegment('release-notes', 'release-notes')).not.toThrow();
  });

  it('verifies installer checksums without PowerShell module discovery', async () => {
    const installer = await Bun.file(new URL('../../../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility");
    expect(installer).toContain('Microsoft.PowerShell.Utility\\Get-FileHash');
    expect(installer).toContain('[Security.Cryptography.SHA256]::Create()');
  });

  it('accepts only an explicitly declared unsigned Windows payload and warns the user', async () => {
    const installer = await Bun.file(new URL('../../../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain("else { 'threadnote/threadnote' }");
    expect(installer).toContain('$metadataVersion = $metadata.version');
    expect(installer).toContain('$metadataVersion -isnot [string]');
    expect(installer).toContain('$metadataVersion -cne $version');
    expect(installer).toContain('$metadataExecutable = $metadata.executable');
    expect(installer).toContain('$metadataExecutable -isnot [string]');
    expect(installer).toContain("$metadataExecutable -cne 'threadnote.exe'");
    expect(installer).toContain('$codeSignature = $metadata.codeSignature');
    expect(installer).toContain('$codeSignature -isnot [string]');
    expect(installer).toContain("$codeSignature -cne 'unsigned'");
    expect(installer).toContain("@('Kashkovsky/threadnote', 'threadnote/threadnote')");
    expect(installer).toContain('$officialRepositories -ccontains $repository');
    expect(installer).toContain('This Windows release is unsigned');
    expect(installer).not.toContain('Get-AuthenticodeSignature');
  });

  it('downloads release archives as binary data on Windows PowerShell', async () => {
    const installer = await Bun.file(new URL('../../../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain('[System.Net.Http.HttpClient]::new()');
    expect(installer).toContain('[System.Net.Http.HttpCompletionOption]::ResponseHeadersRead');
    expect(installer).toContain('$cancellation.CancelAfter($downloadTimeout)');
    expect(installer).toContain('$sourceStream.CopyToAsync($destinationStream, 81920, $cancellation.Token)');
    expect(installer).not.toContain('[System.Net.WebClient]::new()');
    expect(installer).not.toContain('Invoke-WebRequest');
  });

  it('recovers cross-runtime locks and interrupted release promotion safely', async () => {
    const installer = await Bun.file(new URL('../../../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain('Get-ThreadnoteLockOwner');
    expect(installer).toContain('Read-ThreadnoteInstallationLock');
    expect(installer).toContain('[AllowEmptyString()][string]$Token');
    expect(installer).toContain('$script:installationLockAcquired = $true');
    expect(installer).toContain('-not $script:installationLockAcquired');
    expect(installer).toContain('processStartIdentity');
    expect(installer).toContain('$installationLockStaleAge');
    expect(installer).toContain('$lockInfo.LastWriteTimeUtc');
    expect(installer).toContain('Recover-ThreadnoteReleasePromotion');
    expect(installer).toContain('.promotion-backup');
    expect(installer).toContain('.promotion.json');
    expect(installer).toContain('Invoke-ThreadnoteWithRetry');
    expect(installer).toContain('Assert-ThreadnoteReleaseArchive');
    expect(installer).toContain("$type -notin @('-', 'd')");
  });

  it('selects the inclusive beta release channel from an explicit bootstrap flag', async () => {
    const installer = await Bun.file(new URL('../../../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain('[switch]$Beta');
    expect(installer).toContain("$channel = if ($Beta) { 'beta' }");
    expect(installer).toContain("'beta' { $null }");
    expect(installer).toContain('$null -ne $prerelease');
  });
});
