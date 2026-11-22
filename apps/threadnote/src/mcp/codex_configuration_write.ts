import {Effect, FileSystem, Path, Schema} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {fromPromise} from '@threadnote/platform/errors';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runtimeLstat, SystemInfo, type RuntimeBigIntStats} from '@threadnote/platform/system';

class CodexAccessMetadataError extends Schema.TaggedError<CodexAccessMetadataError, {readonly brand: unique symbol}>()(
  'CodexAccessMetadataError',
  {message: Schema.String},
) {}

const lockOptions = {
  createParentDirectory: false,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 2_000,
} as const;

export function withCodexConfigurationLock<A, E, R>(hostRoot: string, write: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* withExclusiveFileLock(fs, path.join(hostRoot, '.threadnote-mcp.lock'), lockOptions, write);
  });
}

function sameAccessMetadata(before: RuntimeBigIntStats, staged: RuntimeBigIntStats): boolean {
  return (
    staged.isFile() &&
    staged.mode === before.mode &&
    'uid' in before &&
    'uid' in staged &&
    before.uid === staged.uid &&
    'gid' in before &&
    'gid' in staged &&
    before.gid === staged.gid
  );
}

/** Read back Linux ACLs independently of cp, which may tolerate unsupported ACL copying. */
const readLinuxAccessDetails = Effect.fn('mcp.readLinuxCodexAccessDetails')(function* (target: string) {
  const options = {
    timeoutMs: 1500,
    maxOutputBytes: 16_384,
    env: {LC_ALL: 'C'},
  };
  const listing = yield* runCommandEffect(
    '/bin/ls',
    ['-lndZ', '--color=never', '--quoting-style=escape', '--', target],
    options,
  );
  const access = /^-[rwxStTs-]{9}([+.])?\s+\d+\s+\d+\s+\d+\s+(\S+)/u.exec(listing.stdout);
  if (listing.exitCode !== 0 || listing.stderr !== '' || !access || (access[1] === '.' && access[2] === '?')) {
    return yield* CodexAccessMetadataError.make({
      message: 'Cannot verify Linux Codex configuration access metadata.',
    });
  }
  const acl =
    access[1] === '+' ? yield* runCommandEffect('getfacl', ['-c', '-n', '-p', '--', target], options) : undefined;
  if (acl && (acl.exitCode !== 0 || acl.stderr !== '' || acl.stdout === '')) {
    return yield* CodexAccessMetadataError.make({
      message: 'Cannot verify Linux Codex configuration ACL.',
    });
  }
  return `${access[1] ?? ''}${access[2]}\n${acl?.stdout ?? ''}`;
});

const windowsAccessScript = `
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$source = $env:THREADNOTE_CODEX_METADATA_SOURCE
$destination = $env:THREADNOTE_CODEX_METADATA_DESTINATION
$ordinary = [IO.FileAttributes]::Archive -bor [IO.FileAttributes]::Normal
if (([IO.File]::GetAttributes($source) -band (-bnot [int]$ordinary)) -ne 0) { exit 3 }
$streams = @(Get-Item -LiteralPath $source -Stream *)
if ($streams.Count -ne 1 -or $streams[0].Stream -ne ':$DATA') { exit 3 }
# Read the mandatory label using READ_CONTROL. Querying the audit SACL would
# require SeSecurityPrivilege even for an ordinary file.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CodexFileIntegrity {
  private const uint FileObject = 1, LabelInformation = 0x10, SaclInformation = 0x08;

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern uint GetNamedSecurityInfoW(string path, uint type, uint information,
    IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
    IntPtr descriptor, uint revision, uint information, out IntPtr sddl, IntPtr length);

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  public static string Read(string path) {
    IntPtr descriptor, sddl;
    uint status = GetNamedSecurityInfoW(path, FileObject, LabelInformation,
      IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
    if (status != 0) throw new Win32Exception((int)status);
    try {
      // Conversion serializes only the label already present in this descriptor.
      if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
        descriptor, 1, SaclInformation, out sddl, IntPtr.Zero)) throw new Win32Exception();
      try { return Marshal.PtrToStringUni(sddl); }
      finally { LocalFree(sddl); }
    } finally { LocalFree(descriptor); }
  }
}
'@
if ([CodexFileIntegrity]::Read($source) -cne [CodexFileIntegrity]::Read($destination)) { exit 4 }
$owner = [Security.AccessControl.AccessControlSections]::Owner
$group = [Security.AccessControl.AccessControlSections]::Group
$dacl = [Security.AccessControl.AccessControlSections]::Access
$sections = $owner -bor $group -bor $dacl
$from = [IO.File]::GetAccessControl($source, $sections)
$to = [IO.File]::GetAccessControl($destination, $sections)
$expected = $from.GetSecurityDescriptorSddlForm($sections)
if ($expected -cne $to.GetSecurityDescriptorSddlForm($sections)) {
  $copy = $dacl
  if ($from.GetSecurityDescriptorSddlForm($owner) -cne $to.GetSecurityDescriptorSddlForm($owner)) { $copy = $copy -bor $owner }
  if ($from.GetSecurityDescriptorSddlForm($group) -cne $to.GetSecurityDescriptorSddlForm($group)) { $copy = $copy -bor $group }
  $to.SetSecurityDescriptorSddlForm($from.GetSecurityDescriptorSddlForm($copy), $copy)
  [IO.File]::SetAccessControl($destination, $to)
  $actual = [IO.File]::GetAccessControl($destination, $sections)
  if ($expected -cne $actual.GetSecurityDescriptorSddlForm($sections)) { exit 3 }
}
`;

const preserveWindowsAccess = Effect.fn('mcp.preserveWindowsCodexAccess')(function* (target: string, staging: string) {
  const system = yield* SystemInfo;
  const path = yield* Path.Path;
  const environment = system.environment();
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = yield* runCommandEffect(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', windowsAccessScript],
    {
      timeoutMs: 5000,
      allowFailure: true,
      maxOutputBytes: 1024,
      env: {
        ...environment,
        THREADNOTE_CODEX_METADATA_SOURCE: target,
        THREADNOTE_CODEX_METADATA_DESTINATION: staging,
      },
    },
  );
  if (result.exitCode !== 0 || result.stderr !== '') {
    const message =
      result.exitCode === 4
        ? 'Windows Codex configuration integrity labels differ.'
        : 'Cannot preserve Windows Codex configuration access metadata.';
    return yield* CodexAccessMetadataError.make({message});
  }
});

/** Stage in a private sibling directory. The caller checks the live snapshot before publishing. */
export const stageCodexConfiguration = Effect.fn('mcp.stageCodexConfiguration')(function* (
  hostRoot: string,
  target: string,
  before: RuntimeBigIntStats | undefined,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const temporary = yield* fs.makeTempDirectoryScoped({
    directory: hostRoot,
    prefix: '.threadnote-mcp-',
  });
  const staging = path.join(temporary, 'config.toml');
  const linux = system.platform === 'linux';
  const windows = system.platform === 'win32';
  const originalAccess = before && linux ? yield* readLinuxAccessDetails(target) : undefined;
  if (before) {
    if (
      (system.platform !== 'darwin' && !linux && !windows) ||
      !before.isFile() ||
      !('nlink' in before) ||
      before.nlink !== 1n
    ) {
      return yield* CodexAccessMetadataError.make({
        message: 'Cannot preserve the access metadata on this Codex configuration.',
      });
    }
    if (windows) {
      // Keep the staging file empty until its discretionary ACL is verified.
      yield* fs.writeFileString(staging, '', {mode: 0o600});
      yield* preserveWindowsAccess(target, staging);
    } else {
      // BSD cp -p preserves ACLs. GNU cp also requests xattrs for access labels
      // and is independently checked below. Treat metadata warnings as failures.
      const mode = linux ? '--preserve=mode,ownership,timestamps,xattr' : '-p';
      const copied = yield* runCommandEffect('/bin/cp', [mode, target, staging], {
        timeoutMs: 1500,
        maxOutputBytes: 256,
      });
      if (copied.exitCode !== 0 || copied.stderr !== '') {
        return yield* CodexAccessMetadataError.make({
          message: 'Cannot preserve the access metadata on this Codex configuration.',
        });
      }
    }
  }
  yield* fs.writeFileString(staging, content, {mode: 0o600});
  if (before) {
    const staged = yield* fromPromise('mcp.statStagedCodexConfig', () => runtimeLstat(staging));
    if (
      (windows ? !staged.isFile() || staged.mode !== before.mode : !sameAccessMetadata(before, staged)) ||
      (linux && (yield* readLinuxAccessDetails(staging)) !== originalAccess)
    ) {
      return yield* CodexAccessMetadataError.make({
        message: 'Staged Codex configuration access metadata differs from the original.',
      });
    }
  }
  yield* syncWritableFile(fs, staging);
  return staging;
});

/** Publish under the shared lock after rechecking the expected live state. */
export function publishStagedCodexConfiguration<E, R>(
  target: string,
  staging: string,
  replacedExisting: boolean,
  canPublish: Effect.Effect<boolean, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* canPublish)) return false;
    if (replacedExisting) {
      yield* fs.rename(staging, target);
    } else {
      // Race-safe creation for homes without a configuration file yet.
      yield* fs.link(staging, target);
    }
    yield* syncDirectoryBestEffort(fs, path.dirname(target));
    return true;
  });
}
