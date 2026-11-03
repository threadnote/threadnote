import {Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {FileUri} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readBoundedText} from './fingerprint.js';
import {SemanticHostCatalog} from './host_catalog.js';

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
export const readSemanticHostProfile = Effect.fn('semantic.readHostProfile')(function* (
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
  const profile = yield* Schema.decodeUnknownEffect(SemanticHostProfile, {onExcessProperty: 'error'})(decoded).pipe(
    Effect.mapError(() => reject('invalid')),
  );
  if (profile.worktree !== worktree) return yield* reject('incompatible');
  if (!profile.enabled) return yield* reject('disabled');
  return {home, profile: structuredClone(profile), digest: sha256HexSync(text)};
});
