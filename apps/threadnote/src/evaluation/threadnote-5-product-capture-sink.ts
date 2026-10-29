import {Array as EffectArray} from 'effect';
import {ByteSize, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {
  deferredCodeAnchorPathEntryKind,
  ensurePrivateDeferredCodeAnchorDirectory,
} from '../memory/deferred/code_anchor_private_fs.js';
import {runtimePlatform} from '@threadnote/platform/system';
import {
  createThreadnote5ProductCaptureV1,
  parseProductCaptureConfiguration,
  productCaptureCanonicalJson,
  productCaptureFilename,
  productCaptureIdentityDigest,
} from './threadnote-5-product-capture.js';
import type {Threadnote5ProductEventV1} from './threadnote-5-product-capture-events.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE = 'THREADNOTE_PRIVATE_CAPTURE_V1' as const;

export class ProductCaptureError extends Schema.TaggedError<ProductCaptureError, {readonly brand: unique symbol}>()(
  'ProductCaptureError',
  {
    message: Schema.String,
  },
) {}

/** @internal Test-only synchronization points for exercising process-crash windows. */
export interface ProductCaptureTestHooks {
  readonly beforeLink?: () => Effect.Effect<void, never, never>;
  readonly afterLink?: () => Effect.Effect<void, never, never>;
}

interface DirectoryAuthorityInput {
  readonly mode: number;
  readonly uid: number | undefined;
}

interface DirectoryAuthority {
  readonly birthtimeMilliseconds: number;
  readonly dev: bigint;
  readonly directory: string;
  readonly ino: bigint;
  readonly mode: number;
  readonly realPath: string;
  readonly uid: number;
}

interface FileAuthority {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly uid: number;
}

export function isTrustedProductCaptureDirectoryAuthority(
  authority: DirectoryAuthorityInput,
  effectiveUid: number,
  captureRoot: boolean,
): boolean {
  if (authority.uid === undefined) return false;
  if (captureRoot) return authority.uid === effectiveUid && (authority.mode & 0o777) === 0o700;
  return (
    (authority.uid === effectiveUid || authority.uid === 0) &&
    ((authority.mode & 0o022) === 0 || (authority.mode & 0o1000) !== 0)
  );
}

export const captureThreadnote5ProductEventV1 = Effect.fn('productCapture.publish')(function* (
  configuration: string | undefined,
  event: () => Threadnote5ProductEventV1,
  hooks: ProductCaptureTestHooks | undefined = undefined,
) {
  if (configuration === undefined) return undefined;
  const capture = yield* Effect.try({
    catch: () => ProductCaptureError.make({message: 'Invalid private product capture configuration or native event.'}),
    try: () => parseProductCaptureConfiguration(configuration),
  });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const {root} = capture;
  if (
    runtimePlatform === 'win32' ||
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    path.dirname(root) === root ||
    Effect2.pipe(root, EffectString.endsWith(path.sep))
  ) {
    return yield* ProductCaptureError.make({
      message: 'Private product capture requires a canonical absolute POSIX root.',
    });
  }
  const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : undefined;
  if (effectiveUid === undefined) {
    return yield* ProductCaptureError.make({message: 'Private product capture requires an effective user identity.'});
  }
  const ancestors: string[] = [];
  for (let current = root; ; current = path.dirname(current)) {
    ancestors.unshift(current);
    if (path.dirname(current) === current) break;
  }
  const ancestorAuthority = yield* inspectAncestors(fs, ancestors, root, effectiveUid);
  const directory = yield* ensurePrivateDeferredCodeAnchorDirectory(
    fs,
    path.join(root, productCaptureIdentityDigest(capture.identity)),
    [root],
  );
  yield* assertAncestors(fs, ancestors, root, effectiveUid, ancestorAuthority);
  const directoryAuthority = yield* inspectDirectories(fs, [root, directory], effectiveUid);
  yield* assertDirectories(fs, [root, directory], effectiveUid, directoryAuthority);
  const envelope = yield* Effect.try({
    catch: () => ProductCaptureError.make({message: 'Invalid private product capture configuration or native event.'}),
    try: () => createThreadnote5ProductCaptureV1(capture.identity, event()),
  });
  const output = path.join(directory, productCaptureFilename(envelope));
  const pending = `${output}.pending`;
  const bytes = new TextEncoder().encode(`${productCaptureCanonicalJson(envelope)}\n`);
  yield* assertAncestors(fs, ancestors, root, effectiveUid, ancestorAuthority);
  yield* assertDirectories(fs, [root, directory], effectiveUid, directoryAuthority);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(pending, {flag: 'wx', mode: 0o600});
      const reserved = yield* inspectFileHandle(file, effectiveUid, 0n, 1);
      let published = false;
      return yield* Effect.gen(function* () {
        yield* assertPathMatchesFile(fs, pending, file, reserved, effectiveUid, 0n, 1);
        yield* assertAncestors(fs, ancestors, root, effectiveUid, ancestorAuthority);
        yield* assertDirectories(fs, [root, directory], effectiveUid, directoryAuthority);
        yield* file.writeAll(bytes);
        yield* file.sync;
        const written = yield* inspectFileHandle(file, effectiveUid, BigInt(bytes.byteLength), 1);
        yield* assertPathMatchesFile(fs, pending, file, written, effectiveUid, BigInt(bytes.byteLength), 1);
        yield* assertAncestors(fs, ancestors, root, effectiveUid, ancestorAuthority);
        yield* assertDirectories(fs, [root, directory], effectiveUid, directoryAuthority);
        if ((yield* deferredCodeAnchorPathEntryKind(fs, output)) !== 'missing') {
          return yield* ProductCaptureError.make({message: 'Private product capture destination is occupied.'});
        }
        yield* assertPathMatchesFile(fs, pending, file, written, effectiveUid, BigInt(bytes.byteLength), 1);
        if (hooks?.beforeLink !== undefined) yield* hooks.beforeLink();
        yield* fs.link(pending, output);
        if (hooks?.afterLink !== undefined) yield* hooks.afterLink();
        const linked = yield* inspectFileHandle(file, effectiveUid, BigInt(bytes.byteLength), 2);
        yield* assertPathMatchesFile(fs, pending, file, linked, effectiveUid, BigInt(bytes.byteLength), 2);
        yield* assertPathMatchesFile(fs, output, file, linked, effectiveUid, BigInt(bytes.byteLength), 2);
        yield* assertAncestors(fs, ancestors, root, effectiveUid, ancestorAuthority);
        yield* assertDirectories(fs, [root, directory], effectiveUid, directoryAuthority);
        // Keep the non-artifact link because path-only cleanup cannot safely unlink against a same-UID racer.
        published = true;
        return output;
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            published ? Effect.void : file.truncate(0).pipe(Effect.andThen(file.sync), Effect.ignore),
          ),
        ),
      );
    }),
  );
});

const inspectAncestors = Effect.fn('productCapture.inspectAncestors')(function* (
  fs: FileSystem.FileSystem,
  ancestors: readonly string[],
  root: string,
  effectiveUid: number,
) {
  const authorities: DirectoryAuthority[] = [];
  for (const ancestor of ancestors) {
    if ((yield* deferredCodeAnchorPathEntryKind(fs, ancestor)) !== 'directory') {
      return yield* ProductCaptureError.make({
        message: 'Private product capture forbids symlink or missing ancestors.',
      });
    }
    const info = yield* fs.stat(ancestor);
    const birthtime = Option.getOrUndefined(info.birthtime);
    const ino = Option.getOrUndefined(info.ino);
    const uid = Option.getOrUndefined(info.uid);
    if (
      birthtime === undefined ||
      ino === undefined ||
      uid === undefined ||
      !isTrustedProductCaptureDirectoryAuthority({mode: info.mode, uid}, effectiveUid, ancestor === root)
    ) {
      return yield* ProductCaptureError.make({
        message: 'Private product capture ancestor lacks trusted owner, mode, or identity.',
      });
    }
    authorities.push({
      birthtimeMilliseconds: birthtime.getTime(),
      dev: info.dev,
      directory: ancestor,
      ino,
      mode: info.mode,
      realPath: yield* fs.realPath(ancestor),
      uid,
    });
  }
  return authorities;
});

const inspectDirectories = Effect.fn('productCapture.inspectDirectories')(function* (
  fs: FileSystem.FileSystem,
  directories: readonly string[],
  effectiveUid: number,
) {
  const authorities: DirectoryAuthority[] = [];
  for (const directory of directories) {
    if ((yield* deferredCodeAnchorPathEntryKind(fs, directory)) !== 'directory') {
      return yield* ProductCaptureError.make({message: 'Private product capture directory is unavailable.'});
    }
    const info = yield* fs.stat(directory);
    const birthtime = Option.getOrUndefined(info.birthtime);
    const ino = Option.getOrUndefined(info.ino);
    const uid = Option.getOrUndefined(info.uid);
    const realPath = yield* fs.realPath(directory);
    if (
      birthtime === undefined ||
      ino === undefined ||
      uid === undefined ||
      realPath !== directory ||
      !isTrustedProductCaptureDirectoryAuthority({mode: info.mode, uid}, effectiveUid, true)
    ) {
      return yield* ProductCaptureError.make({
        message: 'Private product capture directory lacks operator-owned private authority.',
      });
    }
    authorities.push({
      birthtimeMilliseconds: birthtime.getTime(),
      dev: info.dev,
      directory,
      ino,
      mode: info.mode,
      realPath,
      uid,
    });
  }
  return authorities;
});

const assertAncestors = Effect.fn('productCapture.assertAncestors')(function* (
  fs: FileSystem.FileSystem,
  ancestors: readonly string[],
  root: string,
  effectiveUid: number,
  expected: readonly DirectoryAuthority[],
) {
  if (!sameDirectories(expected, yield* inspectAncestors(fs, ancestors, root, effectiveUid))) {
    return yield* ProductCaptureError.make({message: 'Private product capture ancestors changed.'});
  }
});

const assertDirectories = Effect.fn('productCapture.assertDirectories')(function* (
  fs: FileSystem.FileSystem,
  directories: readonly string[],
  effectiveUid: number,
  expected: readonly DirectoryAuthority[],
) {
  if (!sameDirectories(expected, yield* inspectDirectories(fs, directories, effectiveUid))) {
    return yield* ProductCaptureError.make({message: 'Private product capture directories changed.'});
  }
});

function sameDirectories(left: readonly DirectoryAuthority[], right: readonly DirectoryAuthority[]): boolean {
  return (
    left.length === right.length &&
    EffectArray.every(left, (authority, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        authority.birthtimeMilliseconds === candidate.birthtimeMilliseconds &&
        authority.dev === candidate.dev &&
        authority.directory === candidate.directory &&
        authority.ino === candidate.ino &&
        authority.mode === candidate.mode &&
        authority.realPath === candidate.realPath &&
        authority.uid === candidate.uid
      );
    })
  );
}

const inspectFileHandle = Effect.fn('productCapture.inspectFileHandle')(function* (
  file: FileSystem.File,
  effectiveUid: number,
  expectedSize: bigint,
  expectedLinks: number,
) {
  const authority = yield* fileAuthority(yield* file.stat, effectiveUid);
  if (authority.size !== expectedSize || authority.nlink !== BigInt(expectedLinks)) {
    return yield* ProductCaptureError.make({message: 'Private product capture reservation state is invalid.'});
  }
  return authority;
});

const assertPathMatchesFile = Effect.fn('productCapture.assertPathMatchesFile')(function* (
  fs: FileSystem.FileSystem,
  target: string,
  file: FileSystem.File,
  expected: FileAuthority,
  effectiveUid: number,
  expectedSize: bigint,
  expectedLinks: number,
) {
  if ((yield* deferredCodeAnchorPathEntryKind(fs, target)) !== 'file') {
    return yield* ProductCaptureError.make({message: 'Private product capture reservation path changed.'});
  }
  const pathAuthority = yield* fileAuthority(yield* fs.stat(target), effectiveUid);
  const handleAuthority = yield* inspectFileHandle(file, effectiveUid, expectedSize, expectedLinks);
  if (
    (yield* deferredCodeAnchorPathEntryKind(fs, target)) !== 'file' ||
    !sameFileAuthority(expected, pathAuthority) ||
    !sameFileAuthority(expected, handleAuthority)
  ) {
    return yield* ProductCaptureError.make({message: 'Private product capture reservation identity changed.'});
  }
});

const fileAuthority = Effect.fn('productCapture.fileAuthority')(function* (
  info: FileSystem.File.Info,
  effectiveUid: number,
) {
  const ino = Option.getOrUndefined(info.ino);
  const nlink = Option.getOrUndefined(info.nlink);
  const uid = Option.getOrUndefined(info.uid);
  if (
    info.type !== 'File' ||
    ino === undefined ||
    nlink === undefined ||
    uid !== effectiveUid ||
    (info.mode & 0o777) !== 0o600
  ) {
    return yield* ProductCaptureError.make({message: 'Private product capture reservation lacks file authority.'});
  }
  return {dev: info.dev, ino, mode: info.mode, nlink, size: ByteSize.toBigInt(info.size), uid};
});

function sameFileAuthority(left: FileAuthority, right: FileAuthority): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  );
}
