import {Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {FileUri} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readBoundedText} from './fingerprint.js';
import {SemanticHostCatalog} from './host_catalog.js';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';

export const SemanticHostProfile = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  worktree: FileUri,
  catalog: SemanticHostCatalog,
});
export class SemanticHostProfileFault extends Schema.TaggedError<
  SemanticHostProfileFault,
  {readonly brand: unique symbol}
>()('SemanticHostProfileFault', {
  reason: Schema.Literals(['missing', 'disabled', 'incompatible', 'untrusted', 'invalid']),
}) {}

export const semanticHostProfileName = (config: Pick<RuntimeConfig, 'account' | 'user'>, worktree: string) =>
  sha256HexSync(JSON.stringify([config.account, config.user, worktree])) + '.json';

/** Read desired host configuration only. Reads never create, migrate or repair setup state. */
export const inspectSemanticHostProfile = Effect.fn('semantic.inspectHostProfile')(function* (
  config: RuntimeConfig,
  worktree: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const reject = (reason: typeof SemanticHostProfileFault.prototype.reason) => SemanticHostProfileFault.make({reason});
  if (!Schema.is(FileUri)(worktree)) return yield* reject('invalid');
  const home = yield* fs.realPath(config.agentContextHome);
  if (home !== path.resolve(config.agentContextHome)) return yield* reject('untrusted');
  const root = yield* path.fromFileUrl(new URL(worktree));
  if ((yield* fs.realPath(root)) !== root || (yield* fs.stat(root)).type !== 'Directory')
    return yield* reject('untrusted');
  const directory = path.join(home, 'semantic', 'profiles');
  const file = path.join(directory, semanticHostProfileName(config, worktree));
  if (file === root || EffectString.startsWith(root + path.sep)(file)) return yield* reject('untrusted');
  for (const folder of [home, path.join(home, 'semantic'), directory]) {
    if (!(yield* fs.exists(folder))) return yield* reject('missing');
    const info = yield* fs.stat(folder);
    if (
      info.type !== 'Directory' ||
      (system.userId !== undefined && Option.isSome(info.uid) && info.uid.value !== system.userId) ||
      (yield* fs.realPath(folder)) !== folder ||
      Option.isSome(yield* fs.readLink(folder).pipe(Effect.option)) ||
      (info.mode & (folder === home ? 0o022 : 0o077)) !== 0
    )
      return yield* reject('untrusted');
  }
  if (!(yield* fs.exists(file))) return yield* reject('missing');
  const verify = Effect.gen(function* () {
    const info = yield* fs.stat(file);
    if (
      info.type !== 'File' ||
      (info.mode & 0o077) !== 0 ||
      Number(info.size) > 16 * 1024 ||
      (system.userId !== undefined && Option.isSome(info.uid) && info.uid.value !== system.userId) ||
      (yield* fs.realPath(file)) !== file ||
      Option.isSome(yield* fs.readLink(file).pipe(Effect.option))
    )
      return yield* reject('untrusted');
  });
  yield* verify;
  const text = yield* readBoundedText(file, 16 * 1024);
  yield* verify;
  const decoded = yield* Effect.try({try: () => JSON.parse(text), catch: () => reject('invalid')});
  if (typeof decoded === 'object' && decoded !== null && 'version' in decoded && decoded.version !== 1)
    return yield* reject('incompatible');
  const profile = yield* Schema.decodeUnknownEffect(SemanticHostProfile, {onExcessProperty: 'error'})(decoded).pipe(
    Effect.mapError(() => reject('invalid')),
  );
  if (profile.worktree !== worktree) return yield* reject('incompatible');
  return {home, profile: structuredClone(profile), digest: sha256HexSync(text)};
});

/** Query admission remains enabled-only; operational inspection never grants analysis or writer authority. */
export const readSemanticHostProfile = Effect.fn('semantic.readHostProfile')(function* (
  config: RuntimeConfig,
  worktree: string,
) {
  const selected = yield* inspectSemanticHostProfile(config, worktree);
  if (!selected.profile.enabled) return yield* SemanticHostProfileFault.make({reason: 'disabled'});
  return selected;
});

/** Explicit local setup only. Unknown configuration is never migrated, replaced or removed. */
export const writeSemanticHostProfile = Effect.fn('semantic.writeHostProfile')(function* (
  config: RuntimeConfig,
  worktree: string,
  input: unknown,
  expectedDigest?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const reject = (reason: typeof SemanticHostProfileFault.prototype.reason) => SemanticHostProfileFault.make({reason});
  const profile = yield* Schema.decodeUnknownEffect(SemanticHostProfile, {onExcessProperty: 'error'})(input).pipe(
    Effect.mapError(() => reject('invalid')),
  );
  if (profile.worktree !== worktree || !Schema.is(FileUri)(worktree)) return yield* reject('incompatible');
  const home = yield* fs.realPath(config.agentContextHome);
  const root = yield* path.fromFileUrl(new URL(worktree));
  if (
    home !== path.resolve(config.agentContextHome) ||
    (yield* fs.realPath(root)) !== root ||
    (yield* fs.stat(root)).type !== 'Directory'
  )
    return yield* reject('untrusted');
  const directory = path.join(home, 'semantic', 'profiles');
  const file = path.join(directory, semanticHostProfileName(config, worktree));
  if (file === root || EffectString.startsWith(root + path.sep)(file)) return yield* reject('untrusted');
  const verifyFolders = Effect.gen(function* () {
    for (const folder of [home, path.join(home, 'semantic'), directory]) {
      const info = yield* fs.stat(folder);
      if (
        info.type !== 'Directory' ||
        (yield* fs.realPath(folder)) !== folder ||
        Option.isSome(yield* fs.readLink(folder).pipe(Effect.option)) ||
        (system.userId !== undefined && Option.isSome(info.uid) && info.uid.value !== system.userId) ||
        (info.mode & (folder === home ? 0o022 : 0o077)) !== 0
      )
        return yield* reject('untrusted');
    }
  });
  // Verify each existing parent before creating the next child. Never repair permissions automatically.
  for (const folder of [home, path.join(home, 'semantic'), directory]) {
    if (!(yield* fs.exists(folder))) yield* fs.makeDirectory(folder, {mode: 0o700});
    const info = yield* fs.stat(folder);
    if (
      info.type !== 'Directory' ||
      (yield* fs.realPath(folder)) !== folder ||
      Option.isSome(yield* fs.readLink(folder).pipe(Effect.option)) ||
      (system.userId !== undefined && Option.isSome(info.uid) && info.uid.value !== system.userId) ||
      (info.mode & (folder === home ? 0o022 : 0o077)) !== 0
    )
      return yield* reject('untrusted');
  }
  const text = JSON.stringify(profile);
  if (new TextEncoder().encode(text).length > 16 * 1024) return yield* reject('invalid');
  return yield* withExclusiveFileLock(
    fs,
    path.join(directory, 'setup.lock'),
    {
      createParentDirectory: false,
      waitTimeoutMilliseconds: 2000,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 10000,
      useCanonicalProcessStartIdentity: true,
    },
    Effect.gen(function* () {
      yield* verifyFolders;
      if (yield* fs.exists(file)) {
        const previous = yield* inspectSemanticHostProfile(config, worktree);
        if (JSON.stringify(previous.profile) === text) return {digest: previous.digest, changed: false};
        if (expectedDigest !== previous.digest) return yield* reject('incompatible');
        // Only known profiles with an exact expected image can be explicitly replaced.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const temporaryDirectory = yield* fs.makeTempDirectoryScoped({directory, prefix: '.setup-'});
            const temporary = path.join(temporaryDirectory, 'profile.json');
            yield* fs.writeFileString(temporary, text, {flag: 'wx', mode: 0o600});
            yield* verifyFolders;
            if ((yield* inspectSemanticHostProfile(config, worktree)).digest !== previous.digest)
              return yield* reject('incompatible');
            yield* fs.rename(temporary, file);
          }),
        );
      } else {
        if (expectedDigest !== undefined) return yield* reject('incompatible');
        yield* Effect.scoped(
          Effect.gen(function* () {
            const temporaryDirectory = yield* fs.makeTempDirectoryScoped({directory, prefix: '.setup-'});
            const temporary = path.join(temporaryDirectory, 'profile.json');
            yield* fs.writeFileString(temporary, text, {flag: 'wx', mode: 0o600});
            yield* verifyFolders;
            // Exclusive publication never replaces a profile created by another setup participant.
            yield* fs.link(temporary, file);
          }),
        );
      }
      return {digest: sha256HexSync(text), changed: true};
    }),
  );
});
