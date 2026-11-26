import * as EffectArray from 'effect/Array';
import * as Native from '@threadnote/platform/system';
import type {
  JavaHostCandidate,
  NativeTypeScriptHostCandidate,
  PythonHostCandidate,
  SdkHostCandidate,
  TypeScriptHostCandidate,
} from './host_catalog.js';

type SdkCandidate = typeof SdkHostCandidate.Type;

type Candidate =
  TypeScriptHostCandidate | NativeTypeScriptHostCandidate | PythonHostCandidate | SdkCandidate | JavaHostCandidate;

/** Every file tree a selected candidate executes or reads; the same roots the coordinator storage fence checks. */
export function semanticCandidateRoots(candidate: Candidate): readonly string[] {
  return 'runtimeCandidate' in candidate
    ? [
        candidate.runtimeCandidate.serverDirectory,
        candidate.runtimeCandidate.runtimeJavaHome,
        candidate.runtimeCandidate.projectJavaHome,
      ]
    : 'runtime' in candidate
      ? [candidate.runtime, candidate.serverDirectory, ...('sdkDirectory' in candidate ? [candidate.sdkDirectory] : [])]
      : [candidate.executable, candidate.sdkDirectory];
}

/** Above this many entries a snapshot is not cheap; the caller keeps the full digest on every request. */
const maximumEntries = 200_000;

/**
 * A metadata snapshot of the candidate trees, without following links: path, device, inode, mode, link count, size,
 * and modification and change times in nanoseconds. Writing a file's bytes changes its change time even when the
 * modification time is reset, so an unchanged snapshot is the cheap per-request fence after one full digest.
 * Undefined means the snapshot could not be taken completely.
 */
export function semanticCandidateMetadata(roots: readonly string[]): string | undefined {
  const native = Native.runtimeNativeDescriptorOperations();
  const path = Native.platformPathFor(Native.runtimePlatform);
  const hasher = new Bun.CryptoHasher('sha256');
  let entries = 0;
  const visit = (file: string): boolean => {
    if (++entries > maximumEntries) return false;
    const info = native.lstatSync(file, {bigint: true});
    hasher.update(
      JSON.stringify([
        file,
        String(info.dev),
        String(info.ino),
        String(info.mode),
        String(info.nlink),
        String(info.size),
        String(info.mtimeNs),
        String(info.ctimeNs),
      ]) + '\n',
    );
    if (!info.isDirectory()) return true;
    const names = EffectArray.map(native.readdirSync(file), String).sort();
    for (const name of names) if (!visit(path.join(file, name))) return false;
    return true;
  };
  try {
    for (const root of [...roots].sort()) if (!visit(root)) return undefined;
  } catch {
    return undefined;
  }
  return hasher.digest('hex');
}
