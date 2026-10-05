import {Data, Effect, FileSystem, Option, Path, PlatformError} from 'effect';
import {
  fileSystemModeIsPrivate,
  readPathFileSystemAuthority,
  readPathFileSystemIdentity,
  runtimePlatform,
  sameFileSystemIdentity,
  type FileSystemIdentity,
} from '@threadnote/platform/system';

export const DEFERRED_CODE_ANCHOR_URI_ADDRESS_HEX_LENGTH = 32;
export const DEFERRED_CODE_ANCHOR_ITEM_ROOT_NAME = 'i';
export const DEFERRED_CODE_ANCHOR_ROUTE_ROOT_NAME = 'r';
export const DEFERRED_CODE_ANCHOR_ROUTE_QUARANTINE_NAME = '.quarantine-v1';
export const DEFERRED_CODE_ANCHOR_LEGACY_QUARANTINE_NAME = '.legacy-quarantine-v1';

export class DeferredCodeAnchorError extends Data.TaggedError('DeferredCodeAnchorError')<{
  readonly message: string;
}> {}

export const deferredCodeAnchorError = (message: string) => new DeferredCodeAnchorError({message});

export type DeferredCodeAnchorPathEntryKind = 'directory' | 'file' | 'missing' | 'other' | 'symlink';

export interface DeferredCodeAnchorPrivateDirectoryAuthority {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly directory: string;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly realPath: string;
}

export function deferredCodeAnchorPathEntryKind(fs: FileSystem.FileSystem, target: string) {
  return fs.readLink(target).pipe(
    Effect.as('symlink' as const),
    Effect.catchIf(
      error => error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound',
      () => Effect.succeed('missing' as const),
      () =>
        fs.stat(target).pipe(
          Effect.map(info =>
            info.type === 'Directory'
              ? ('directory' as const)
              : info.type === 'File'
                ? ('file' as const)
                : ('other' as const),
          ),
          Effect.catchIf(
            statError => statError instanceof PlatformError.PlatformError && statError.reason._tag === 'NotFound',
            () => Effect.succeed('missing' as const),
          ),
        ),
    ),
  ) satisfies Effect.Effect<DeferredCodeAnchorPathEntryKind, unknown>;
}

export const inspectPrivateDeferredCodeAnchorDirectories = Effect.fn('memoryCodeAnchor.inspectPrivateDirectories')(
  function* (fs: FileSystem.FileSystem, directories: readonly string[]) {
    const authorities: DeferredCodeAnchorPrivateDirectoryAuthority[] = [];
    for (const directory of [...new Set(directories)]) {
      const kind = yield* deferredCodeAnchorPathEntryKind(fs, directory);
      if (kind === 'missing') return undefined;
      if (kind !== 'directory') {
        return yield* deferredCodeAnchorError(
          'Deferred code-anchor private directory must not be a link or non-directory.',
        );
      }
      const authority = yield* readPathFileSystemAuthority(directory, 'Directory');
      if (Option.isNone(authority)) {
        return yield* deferredCodeAnchorError(
          'Deferred code-anchor private directory has insufficient identity metadata.',
        );
      }
      if (!fileSystemModeIsPrivate(runtimePlatform, Number(authority.value.mode))) {
        return yield* deferredCodeAnchorError('Deferred code-anchor private directory is not private.');
      }
      const realPath = yield* fs.realPath(directory);
      const revalidated = yield* readPathFileSystemAuthority(directory, 'Directory');
      if (
        Option.isNone(revalidated) ||
        !sameFileSystemIdentity(authority.value, revalidated.value) ||
        authority.value.birthtimeNs !== revalidated.value.birthtimeNs ||
        authority.value.mode !== revalidated.value.mode
      ) {
        return yield* deferredCodeAnchorError('Deferred code-anchor private directory changed during inspection.');
      }
      authorities.push({
        birthtimeNs: authority.value.birthtimeNs,
        dev: authority.value.dev,
        directory,
        ino: authority.value.ino,
        mode: authority.value.mode,
        realPath,
      });
    }
    return authorities;
  },
);

export function samePrivateDeferredCodeAnchorDirectories(
  left: readonly DeferredCodeAnchorPrivateDirectoryAuthority[],
  right: readonly DeferredCodeAnchorPrivateDirectoryAuthority[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (authority, index) =>
        authority.birthtimeNs === right[index]?.birthtimeNs &&
        authority.dev === right[index]?.dev &&
        authority.directory === right[index]?.directory &&
        authority.ino === right[index]?.ino &&
        authority.mode === right[index]?.mode &&
        authority.realPath === right[index]?.realPath,
    )
  );
}

export const validatePrivateDeferredCodeAnchorDirectories = Effect.fn('memoryCodeAnchor.validatePrivateDirectories')(
  function* (fs: FileSystem.FileSystem, directories: readonly string[]) {
    return (yield* inspectPrivateDeferredCodeAnchorDirectories(fs, directories)) !== undefined;
  },
);

export const readPrivateDeferredCodeAnchorDirectory = Effect.fn('memoryCodeAnchor.readPrivateDirectory')(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  ancestors: readonly string[],
) {
  const before = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestors);
  if (before === undefined) return undefined;
  const names = yield* fs.readDirectory(directory);
  const after = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestors);
  if (after === undefined || !samePrivateDeferredCodeAnchorDirectories(before, after)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor private directory changed during read.');
  }
  return names;
});

export const ensurePrivateDeferredCodeAnchorDirectory = Effect.fn('memoryCodeAnchor.ensurePrivateDirectory')(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  parentDirectories: readonly string[],
) {
  const parentAuthority = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, parentDirectories);
  if (parentAuthority === undefined) {
    return yield* deferredCodeAnchorError('Deferred code-anchor private directory parent is unavailable.');
  }
  const kind = yield* deferredCodeAnchorPathEntryKind(fs, directory);
  if (kind !== 'missing' && kind !== 'directory') {
    return yield* deferredCodeAnchorError(
      'Deferred code-anchor private directory must not be a link or non-directory.',
    );
  }
  if (kind === 'missing') {
    yield* fs.makeDirectory(directory, {mode: 0o700}).pipe(
      Effect.catchIf(
        error => error instanceof PlatformError.PlatformError && error.reason._tag === 'AlreadyExists',
        () => Effect.void,
      ),
    );
  }
  const parentAfter = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, parentDirectories);
  if (parentAfter === undefined || !samePrivateDeferredCodeAnchorDirectories(parentAuthority, parentAfter)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor private directory parent changed.');
  }
  if (!(yield* validatePrivateDeferredCodeAnchorDirectories(fs, [...parentDirectories, directory]))) {
    return yield* deferredCodeAnchorError('Deferred code-anchor private directory is unavailable.');
  }
  return directory;
});

export const removePrivateDeferredCodeAnchorFile = Effect.fn('memoryCodeAnchor.removePrivateFile')(function* (
  fs: FileSystem.FileSystem,
  target: string,
  ancestorDirectories: readonly string[],
) {
  const before = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
  if (before === undefined) return false;
  const kind = yield* deferredCodeAnchorPathEntryKind(fs, target);
  if (kind === 'missing') return false;
  if (kind !== 'file') {
    return yield* deferredCodeAnchorError('Deferred code-anchor private file must not be a link or non-file.');
  }
  const info = yield* fs.stat(target);
  if (!fileSystemModeIsPrivate(runtimePlatform, info.mode)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor private file is not private.');
  }
  const identity = yield* readPathFileSystemIdentity(target, info, 'File');
  if (Option.isNone(identity)) return false;
  const beforeRemoval = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
  const current = yield* fs.stat(target).pipe(Effect.option);
  const currentIdentity = Option.isSome(current)
    ? yield* readPathFileSystemIdentity(target, current.value, 'File')
    : Option.none<FileSystemIdentity>();
  if (
    beforeRemoval === undefined ||
    !samePrivateDeferredCodeAnchorDirectories(before, beforeRemoval) ||
    Option.isNone(current) ||
    Option.isNone(currentIdentity) ||
    !sameDeferredCodeAnchorFile(info, identity.value, current.value, currentIdentity.value)
  ) {
    return yield* deferredCodeAnchorError('Deferred code-anchor private directory changed before removal.');
  }
  yield* fs.remove(target, {force: true});
  const after = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
  if (after === undefined || !samePrivateDeferredCodeAnchorDirectories(before, after)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor private directory changed after removal.');
  }
  return true;
});

/** Route markers are advisory. A marker symlink itself may be unlinked, but no ancestor may be followed. */
export const removePrivateDeferredCodeAnchorRouteMarker = Effect.fn('memoryCodeAnchor.removePrivateRouteMarker')(
  function* (fs: FileSystem.FileSystem, markerPath: string, ancestorDirectories: readonly string[]) {
    const before = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
    if (before === undefined) return false;
    const kind = yield* deferredCodeAnchorPathEntryKind(fs, markerPath);
    if (kind === 'missing') return false;
    if (kind === 'directory' || kind === 'other') {
      return yield* deferredCodeAnchorError('Deferred code-anchor route marker must be a file.');
    }
    if (kind === 'file') {
      const info = yield* fs.stat(markerPath);
      if (!fileSystemModeIsPrivate(runtimePlatform, info.mode)) {
        return yield* deferredCodeAnchorError('Deferred code-anchor route marker is not private.');
      }
      const identity = yield* readPathFileSystemIdentity(markerPath, info, 'File');
      if (Option.isNone(identity)) return false;
      const current = yield* fs.stat(markerPath).pipe(Effect.option);
      const currentIdentity = Option.isSome(current)
        ? yield* readPathFileSystemIdentity(markerPath, current.value, 'File')
        : Option.none<FileSystemIdentity>();
      if (
        Option.isNone(current) ||
        Option.isNone(currentIdentity) ||
        !sameDeferredCodeAnchorFile(info, identity.value, current.value, currentIdentity.value)
      ) {
        return yield* deferredCodeAnchorError('Deferred code-anchor route marker changed before removal.');
      }
    }
    const beforeRemoval = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
    if (beforeRemoval === undefined || !samePrivateDeferredCodeAnchorDirectories(before, beforeRemoval)) {
      return yield* deferredCodeAnchorError('Deferred code-anchor route changed before marker removal.');
    }
    yield* fs.remove(markerPath, {force: true});
    const after = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
    if (after === undefined || !samePrivateDeferredCodeAnchorDirectories(before, after)) {
      return yield* deferredCodeAnchorError('Deferred code-anchor route changed after marker removal.');
    }
    return true;
  },
);

/**
 * Move an untrusted advisory lane entry out of every numeric lane. Rename does
 * not follow the final entry, so files, links, directories, and special files
 * are all handled without reading or recursively deleting their contents.
 */
export const quarantinePrivateDeferredCodeAnchorRouteEntry = Effect.fn('memoryCodeAnchor.quarantinePrivateRouteEntry')(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    entryPath: string,
    sourceAncestors: readonly string[],
    queueAncestors: readonly string[],
  ) {
    return yield* quarantinePrivateDeferredCodeAnchorEntry(
      fs,
      path,
      entryPath,
      sourceAncestors,
      queueAncestors,
      DEFERRED_CODE_ANCHOR_ROUTE_QUARANTINE_NAME,
      'route',
    );
  },
);

/** Preserve an invalid flat-layout intent for doctor inspection while unblocking later migration pages. */
export const quarantinePrivateDeferredCodeAnchorLegacyEntry = Effect.fn(
  'memoryCodeAnchor.quarantinePrivateLegacyEntry',
)(function* (fs: FileSystem.FileSystem, path: Path.Path, entryPath: string, rootAncestors: readonly string[]) {
  return yield* quarantinePrivateDeferredCodeAnchorEntry(
    fs,
    path,
    entryPath,
    rootAncestors,
    rootAncestors,
    DEFERRED_CODE_ANCHOR_LEGACY_QUARANTINE_NAME,
    'legacy',
  );
});

const quarantinePrivateDeferredCodeAnchorEntry = Effect.fn('memoryCodeAnchor.quarantinePrivateEntry')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  entryPath: string,
  sourceAncestors: readonly string[],
  destinationAncestors: readonly string[],
  quarantineName: string,
  label: string,
) {
  const sourceAuthority = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, sourceAncestors);
  if (sourceAuthority === undefined) return false;
  if ((yield* deferredCodeAnchorPathEntryKind(fs, entryPath)) === 'missing') return false;

  const queueRoot = destinationAncestors[destinationAncestors.length - 1];
  const quarantineRoot = yield* ensurePrivateDeferredCodeAnchorDirectory(
    fs,
    path.join(queueRoot, quarantineName),
    destinationAncestors,
  );
  const quarantineAncestors = [...destinationAncestors, quarantineRoot];
  let slotRoot: string | undefined;
  for (let attempt = 0; attempt < 8 && slotRoot === undefined; attempt += 1) {
    const candidate = path.join(quarantineRoot, `q-${randomDeferredCodeAnchorTemporarySuffix()}`);
    const parentAuthority = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, quarantineAncestors);
    if (parentAuthority === undefined) {
      return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} quarantine changed.`);
    }
    const created = yield* fs.makeDirectory(candidate, {mode: 0o700}).pipe(
      Effect.as(true),
      Effect.catchIf(
        error => error instanceof PlatformError.PlatformError && error.reason._tag === 'AlreadyExists',
        () => Effect.succeed(false),
      ),
    );
    const parentAfter = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, quarantineAncestors);
    if (parentAfter === undefined || !samePrivateDeferredCodeAnchorDirectories(parentAuthority, parentAfter)) {
      return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} quarantine changed.`);
    }
    if (created) {
      if (!(yield* validatePrivateDeferredCodeAnchorDirectories(fs, [...quarantineAncestors, candidate]))) {
        return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} quarantine slot is unavailable.`);
      }
      slotRoot = candidate;
    }
  }
  if (slotRoot === undefined) {
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} quarantine is contended.`);
  }

  const targetAncestors = [...quarantineAncestors, slotRoot];
  const combinedAncestors = [...sourceAncestors, ...targetAncestors];
  const renameAuthority = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, combinedAncestors);
  if (
    renameAuthority === undefined ||
    !samePrivateDeferredCodeAnchorDirectories(
      sourceAuthority,
      renameAuthority.filter(authority => sourceAncestors.includes(authority.directory)),
    )
  ) {
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} changed before quarantine.`);
  }
  const target = path.join(slotRoot, 'entry');
  if ((yield* deferredCodeAnchorPathEntryKind(fs, target)) !== 'missing') {
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} quarantine target is occupied.`);
  }
  const beforeRename = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, combinedAncestors);
  if (beforeRename === undefined || !samePrivateDeferredCodeAnchorDirectories(renameAuthority, beforeRename)) {
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} changed before quarantine rename.`);
  }
  yield* fs.rename(entryPath, target);
  const after = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, combinedAncestors);
  if (after === undefined || !samePrivateDeferredCodeAnchorDirectories(renameAuthority, after)) {
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} changed during quarantine rename.`);
  }
  return true;
});

export function randomDeferredCodeAnchorTemporarySuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

export const writePrivateDeferredCodeAnchorFile = Effect.fn('memoryCodeAnchor.writePrivateFile')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  content: string,
  label: string,
  ancestorDirectories: readonly string[],
) {
  const ancestorAuthority = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
  if (ancestorAuthority === undefined) {
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} parent is unavailable.`);
  }
  const temporary = path.join(path.dirname(target), `.${randomDeferredCodeAnchorTemporarySuffix()}.tmp`);
  yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
  const temporaryInfo = yield* fs.stat(temporary);
  if (temporaryInfo.type !== 'File' || !fileSystemModeIsPrivate(runtimePlatform, temporaryInfo.mode)) {
    yield* fs.remove(temporary, {force: true}).pipe(Effect.ignore);
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} staging file is not private.`);
  }
  const temporaryIdentity = yield* readPathFileSystemIdentity(temporary, temporaryInfo, 'File');
  if (Option.isNone(temporaryIdentity)) {
    yield* fs.remove(temporary, {force: true}).pipe(Effect.ignore);
    return yield* deferredCodeAnchorError(
      `Deferred code-anchor ${label} staging file has insufficient identity metadata.`,
    );
  }
  const beforeRename = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
  if (beforeRename === undefined || !samePrivateDeferredCodeAnchorDirectories(ancestorAuthority, beforeRename)) {
    yield* fs.remove(temporary, {force: true}).pipe(Effect.ignore);
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} parent changed before write.`);
  }
  yield* fs.rename(temporary, target).pipe(Effect.tapError(() => fs.remove(temporary, {force: true})));
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} must not be a symbolic link.`);
  }
  const targetInfo = yield* fs.stat(target);
  const targetIdentity = yield* readPathFileSystemIdentity(target, targetInfo, 'File');
  if (
    targetInfo.type !== 'File' ||
    !fileSystemModeIsPrivate(runtimePlatform, targetInfo.mode) ||
    Option.isNone(targetIdentity) ||
    !sameDeferredCodeAnchorFile(temporaryInfo, temporaryIdentity.value, targetInfo, targetIdentity.value)
  ) {
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} changed during write.`);
  }
  const after = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
  if (after === undefined || !samePrivateDeferredCodeAnchorDirectories(ancestorAuthority, after)) {
    return yield* deferredCodeAnchorError(`Deferred code-anchor ${label} parent changed after write.`);
  }
});

export function sameDeferredCodeAnchorFile(
  left: FileSystem.File.Info,
  leftIdentity: FileSystemIdentity,
  right: FileSystem.File.Info,
  rightIdentity: FileSystemIdentity,
): boolean {
  return (
    left.type === 'File' &&
    right.type === 'File' &&
    sameFileSystemIdentity(leftIdentity, rightIdentity) &&
    left.mode === right.mode &&
    left.size === right.size &&
    Option.getOrUndefined(left.birthtime)?.getTime() === Option.getOrUndefined(right.birthtime)?.getTime() &&
    Option.getOrUndefined(left.mtime)?.getTime() === Option.getOrUndefined(right.mtime)?.getTime()
  );
}

export function deferredCodeAnchorItemAncestors(path: Path.Path, root: string, uriDigest: string): readonly string[] {
  const itemRoot = path.join(root, DEFERRED_CODE_ANCHOR_ITEM_ROOT_NAME);
  return [root, itemRoot, path.join(itemRoot, `u${uriDigest.slice(0, DEFERRED_CODE_ANCHOR_URI_ADDRESS_HEX_LENGTH)}`)];
}

export function deferredCodeAnchorIntentAncestorsForPath(path: Path.Path, root: string, intentPath: string) {
  const parent = path.dirname(intentPath);
  if (parent === root) return [root] as const;
  const itemRoot = path.join(root, DEFERRED_CODE_ANCHOR_ITEM_ROOT_NAME);
  if (path.dirname(parent) !== itemRoot || !/^u[a-f0-9]{32}$/u.test(path.basename(parent))) {
    throw deferredCodeAnchorError('Deferred code-anchor intent path is outside the private item layout.');
  }
  return [root, itemRoot, parent] as const;
}

export function deferredCodeAnchorRouteAncestors(
  path: Path.Path,
  root: string,
  key: string,
  lane?: number,
): readonly string[] {
  const routeRoot = path.join(root, DEFERRED_CODE_ANCHOR_ROUTE_ROOT_NAME);
  const queueRoot = path.join(routeRoot, key);
  return lane === undefined
    ? [root, routeRoot, queueRoot]
    : [root, routeRoot, queueRoot, path.join(queueRoot, String(lane))];
}
