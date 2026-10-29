import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {runtimeStat} from '@threadnote/platform/system';
import {fromPromise} from '@threadnote/platform/errors';

/** Exact native stat identity used to bind verified bytes and invalidate verification caches. */
export interface ModelArtifactFileIdentity {
  readonly size: string;
  readonly device: string;
  readonly inode: string;
  readonly modifiedAtNs: string;
  readonly changedAtNs: string;
}

export function validModelArtifactFileIdentity(identity: ModelArtifactFileIdentity): boolean {
  return (
    EffectArray.every([identity.size, identity.device, identity.inode], value => /^(0|[1-9][0-9]*)$/.test(value)) &&
    EffectArray.every([identity.modifiedAtNs, identity.changedAtNs], value => /^-?(0|[1-9][0-9]*)$/.test(value))
  );
}

export const modelArtifactFileIdentity = Effect.fn('models.artifactFileIdentity')(function* (file: string) {
  // Effect FileInfo omits ctime; use the existing exact native stat boundary.
  const info = yield* fromPromise('models.artifactFileIdentity', () => runtimeStat(file));
  if (!info.isFile()) return undefined;
  const identity: ModelArtifactFileIdentity = {
    size: String(info.size),
    device: String(info.dev),
    inode: String(info.ino),
    modifiedAtNs: String(info.mtimeNs),
    changedAtNs: String(info.ctimeNs),
  };
  return validModelArtifactFileIdentity(identity) ? identity : undefined;
});

export function sameModelArtifactFile(left: ModelArtifactFileIdentity, right: ModelArtifactFileIdentity): boolean {
  return (
    left.size === right.size &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs
  );
}
