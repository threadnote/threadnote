import {runtimeCurrentPlatform} from '../system.js';
import {ownedProviderTreeBrand} from './provider-contract.js';
import type {
  OwnedProviderBackend,
  RuntimeOwnedProviderTree,
  RuntimeOwnedProviderLaunch,
  RuntimeOwnedProviderProcess,
  RuntimeOwnedProviderObservation,
} from './provider-contract.js';
import {linuxRuntimeLibc, assertPosixPrivateProviderPath} from './posix-native.js';
import {assertWindowsPrivateProviderPath} from './windows-files.js';
import {spawnWindowsProvider} from './provider-windows.js';
import {spawnPosixProvider, probePosixProviderTree} from './provider-posix.js';
import {writerFail as fail} from './fault.js';
export type {
  RuntimeOwnedProviderTree,
  RuntimeOwnedProviderLaunch,
  RuntimeOwnedProviderProcess,
  RuntimeOwnedProviderObservation,
} from './provider-contract.js';
const liveNativeOwners = new Set<OwnedProviderBackend>();
const owned = new WeakMap<RuntimeOwnedProviderTree, OwnedProviderBackend>();
function backend(handle: RuntimeOwnedProviderTree): OwnedProviderBackend {
  return owned.get(handle) ?? fail('identity');
}
export function runtimeSpawnOwnedProviderTree(options: RuntimeOwnedProviderLaunch): RuntimeOwnedProviderProcess {
  if (
    runtimeCurrentPlatform() !== 'win32' &&
    runtimeCurrentPlatform() !== 'darwin' &&
    runtimeCurrentPlatform() !== 'linux'
  )
    return fail('unsupported-platform');
  if (liveNativeOwners.size >= 64) return fail('identity');
  const instance = runtimeCurrentPlatform() === 'win32' ? spawnWindowsProvider(options) : spawnPosixProvider(options);
  liveNativeOwners.add(instance);
  const handle: RuntimeOwnedProviderTree = Object.freeze({[ownedProviderTreeBrand]: true as const});
  owned.set(handle, instance);
  return Object.freeze({
    handle,
    pid: instance.pid,
    identity: instance.identity,
    stdout: instance.stdout,
    stderr: instance.stderr,
    write: instance.write,
    closeInput: instance.closeInput,
  });
}
export function runtimeObserveOwnedProviderTree(handle: RuntimeOwnedProviderTree): RuntimeOwnedProviderObservation {
  return backend(handle).observe();
}
export function runtimeTerminateOwnedProviderTree(handle: RuntimeOwnedProviderTree, mode: 'terminate' | 'kill'): void {
  backend(handle).terminate(mode);
}
export function runtimeCloseOwnedProviderTree(handle: RuntimeOwnedProviderTree): void {
  const instance = backend(handle);
  instance.close();
  liveNativeOwners.delete(instance);
}
/** Read-only recovery. Neither a surviving leader nor an absent leader authenticates its former whole tree. */
export function runtimeProbeProviderTree(instance: {
  readonly pid: number;
  readonly identity: string;
}): 'present' | 'absent' | 'unknown' {
  if (!Number.isSafeInteger(instance.pid) || instance.pid <= 0 || !instance.identity) return 'unknown';
  if (runtimeCurrentPlatform() === 'darwin' || runtimeCurrentPlatform() === 'linux')
    return probePosixProviderTree(instance);
  // Windows recovery has no original authenticated Job handle; leader/PGID absence is insufficient.
  return 'unknown';
}

/** Implementation admission only. Qualification receipts belong to the exact release candidate. */
export function runtimeNativePlatformSupport(): {readonly writer: boolean; readonly providerTree: boolean} {
  const target = runtimeNativePlatformTarget();
  const supported = target !== undefined && runtimeCurrentPlatform() !== 'win32';
  return {writer: supported, providerTree: target !== undefined};
}
export function runtimeAssertPrivateProviderPath(path: string, options: {readonly kind: 'file' | 'directory'}): void {
  if (runtimeCurrentPlatform() === 'win32') assertWindowsPrivateProviderPath(path, options.kind);
  else assertPosixPrivateProviderPath(path, options.kind);
}

export function runtimeNativePlatformTarget(): string | undefined {
  if (process.arch !== 'arm64' && process.arch !== 'x64') return undefined;
  if (runtimeCurrentPlatform() === 'darwin') return `darwin-${process.arch}`;
  if (runtimeCurrentPlatform() === 'win32') return process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64-baseline';
  if (runtimeCurrentPlatform() === 'linux')
    try {
      const libc = linuxRuntimeLibc();
      return `linux-${process.arch === 'arm64' ? 'arm64' : 'x64-baseline'}${libc.kind === 'musl' ? '-musl' : ''}`;
    } catch {
      return undefined;
    }
  return undefined;
}
