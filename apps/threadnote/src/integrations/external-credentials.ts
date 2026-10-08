import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {Crypto, Effect, FileSystem, Option, Path, Redacted, Schema} from 'effect';
import {
  runtimeLstat,
  runtimeReadBoundedStableRegularFile,
  SystemInfo,
  type RuntimeBigIntStats,
} from '@threadnote/platform/system';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export class ExternalCredentialError extends Schema.TaggedError<ExternalCredentialError>()('ExternalCredentialError', {
  message: Schema.String,
}) {}

const unavailable = () => ExternalCredentialError.make({message: 'External credential is unavailable or insecure.'});
const invalid = () =>
  ExternalCredentialError.make({
    message: 'API token must be a nonempty UTF-8 value of at most 4096 bytes without whitespace.',
  });
type CredentialConfig = Pick<RuntimeConfig, 'agentContextHome'>;
type CredentialSource = {readonly id: string; readonly credentialEnv: string; readonly credentialStorage?: 'local'};
type CredentialProvider = 'pocket' | 'superhuman';
type Validator = (token: Redacted.Redacted<string>) => boolean;

export function validExternalApiToken(token: Redacted.Redacted<string>): boolean {
  const value = Redacted.value(token);
  if (value.length === 0 || value.length > 4096) return false;
  const bytes = new TextEncoder().encode(value);
  return (
    bytes.length > 0 &&
    bytes.length <= 4096 &&
    !/\s|\p{Cc}/u.test(value) &&
    new TextDecoder('utf-8', {fatal: true}).decode(bytes) === value
  );
}

async function optionalNativeStat(target: string): Promise<RuntimeBigIntStats | undefined> {
  try {
    return await runtimeLstat(target);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw unavailable();
  }
}

const statOptional = (target: string) => fromPromiseInterruptible(() => optionalNativeStat(target), unavailable);

const validateSourceId = (sourceId: string) =>
  Effect.try({
    try: () => {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(sourceId)) throw unavailable();
      validatePortableSegment(sourceId, 'source id');
    },
    catch: unavailable,
  });

const inspect = Effect.fn('external.inspectCredentialPath')(function* (
  target: string,
  kind: 'file' | 'directory',
  privateMode: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const before = yield* statOptional(target);
  if (before === undefined) return undefined;
  if (before.isSymbolicLink() || (kind === 'file' ? !before.isFile() : !before.isDirectory()))
    return yield* unavailable();
  const info = yield* fs.stat(target).pipe(Effect.mapError(unavailable));
  const owner = Option.getOrUndefined(info.uid);
  if (
    system.userId === undefined ||
    owner !== system.userId ||
    (info.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
    (kind === 'file' && Option.getOrUndefined(info.nlink) !== 1)
  )
    return yield* unavailable();
  const after = yield* statOptional(target);
  if (
    !after ||
    !samePath(before, after) ||
    BigInt(info.mode) !== before.mode ||
    BigInt(info.dev) !== before.dev ||
    (Option.isSome(info.ino) && BigInt(info.ino.value) !== before.ino)
  )
    return yield* unavailable();
  return after;
});

function samePath(left: RuntimeBigIntStats, right: RuntimeBigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode
  );
}

const paths = Effect.fn('external.credentialPaths')(function* (
  config: CredentialConfig,
  sourceId: string,
  provider: CredentialProvider,
) {
  const system = yield* SystemInfo;
  if (system.platform === 'win32' || system.userId === undefined)
    return yield* ExternalCredentialError.make({
      message:
        'Protected External credential storage is unsupported on this platform. Use an environment credential binding.',
    });
  yield* validateSourceId(sourceId);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(config.agentContextHome) || !(yield* inspect(config.agentContextHome, 'directory', false)))
    return yield* unavailable();
  const home = yield* fs.realPath(config.agentContextHome).pipe(Effect.mapError(unavailable));
  const root = path.join(home, 'threadnote');
  const directories = [root, path.join(root, 'credentials'), path.join(root, 'credentials', provider)];
  return {directories, filename: path.join(directories[2], sourceId)};
});

const inspectDirectories = Effect.fn('external.inspectCredentialDirectories')(function* (
  directories: readonly string[],
  create: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const states: RuntimeBigIntStats[] = [];
  for (const [index, directory] of directories.entries()) {
    if (create && (yield* statOptional(directory)) === undefined)
      yield* fs.makeDirectory(directory, {mode: 0o700}).pipe(Effect.mapError(unavailable));
    const state = yield* inspect(directory, 'directory', index > 0);
    if (state === undefined) return undefined;
    states.push(state);
  }
  return states;
});

const revalidate = Effect.fn('external.revalidateCredentialDirectories')(function* (
  directories: readonly string[],
  before: readonly RuntimeBigIntStats[],
) {
  const after = yield* inspectDirectories(directories, false);
  if (after === undefined || !before.every((entry, index) => samePath(entry, after[index])))
    return yield* unavailable();
});

const readLocal = Effect.fn('external.readLocalCredential')(function* (
  config: CredentialConfig,
  sourceId: string,
  provider: CredentialProvider,
  valid: Validator,
) {
  const {directories, filename} = yield* paths(config, sourceId, provider);
  const before = yield* inspectDirectories(directories, false);
  if (before === undefined) return yield* unavailable();
  const fileBefore = yield* inspect(filename, 'file', true);
  if (fileBefore === undefined || fileBefore.size > 4096n) return yield* unavailable();
  const bytes = yield* fromPromiseInterruptible(() => runtimeReadBoundedStableRegularFile(filename, 4096), unavailable);
  const token = yield* Effect.try({
    try: () => Redacted.make(new TextDecoder('utf-8', {fatal: true}).decode(bytes)),
    catch: unavailable,
  });
  const fileAfter = yield* inspect(filename, 'file', true);
  if (fileAfter === undefined || !samePath(fileBefore, fileAfter) || fileBefore.ctimeNs !== fileAfter.ctimeNs)
    return yield* unavailable();
  yield* revalidate(directories, before);
  if (!valid(token)) return yield* unavailable();
  return token;
});

export const resolveExternalCredential = Effect.fn('external.resolveCredential')(function* (
  config: CredentialConfig,
  source: CredentialSource,
  provider: CredentialProvider,
  valid: Validator = validExternalApiToken,
) {
  if (source.credentialStorage === 'local') return yield* readLocal(config, source.id, provider, valid);
  const system = yield* SystemInfo;
  const value = system.environment()[source.credentialEnv];
  if (typeof value !== 'string') return yield* unavailable();
  const token = Redacted.make(value);
  if (!valid(token)) return yield* unavailable();
  return token;
});

export const externalCredentialConfigured = (
  config: CredentialConfig,
  source: CredentialSource,
  provider: CredentialProvider,
  valid: Validator = validExternalApiToken,
) =>
  resolveExternalCredential(config, source, provider, valid).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

export const storeExternalCredential = Effect.fn('external.storeCredential')(function* (
  config: CredentialConfig,
  sourceId: string,
  token: Redacted.Redacted<string>,
  provider: CredentialProvider,
  valid: Validator = validExternalApiToken,
) {
  if (!valid(token)) return yield* invalid();
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const {directories, filename} = yield* paths(config, sourceId, provider);
  const before = yield* inspectDirectories(directories, true);
  if (before === undefined) return yield* unavailable();
  yield* inspect(filename, 'file', true);
  const temporary = `${filename}.${yield* crypto.randomUUIDv4}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temporary, {flag: 'wx', mode: 0o600}).pipe(Effect.mapError(unavailable));
      yield* file.writeAll(new TextEncoder().encode(Redacted.value(token))).pipe(Effect.mapError(unavailable));
      yield* file.sync.pipe(Effect.mapError(unavailable));
      yield* revalidate(directories, before);
      yield* inspect(filename, 'file', true);
      yield* fs.rename(temporary, filename).pipe(Effect.mapError(unavailable));
      const directory = yield* fs.open(directories[2], {flag: 'r'}).pipe(Effect.mapError(unavailable));
      yield* directory.sync.pipe(Effect.mapError(unavailable));
      yield* revalidate(directories, before);
      yield* inspect(filename, 'file', true);
    }),
  ).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

export const removeExternalCredential = Effect.fn('external.removeCredential')(function* (
  config: CredentialConfig,
  sourceId: string,
  provider: CredentialProvider,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* validateSourceId(sourceId);
  if (!path.isAbsolute(config.agentContextHome)) return yield* unavailable();
  if (
    (yield* statOptional(path.join(config.agentContextHome, 'threadnote', 'credentials', provider, sourceId))) ===
    undefined
  )
    return;
  const {directories, filename} = yield* paths(config, sourceId, provider);
  const before = yield* inspectDirectories(directories, false);
  if (before === undefined) return;
  const file = yield* inspect(filename, 'file', true);
  if (file === undefined) return;
  yield* revalidate(directories, before);
  const current = yield* inspect(filename, 'file', true);
  if (current === undefined || !samePath(file, current) || file.ctimeNs !== current.ctimeNs)
    return yield* unavailable();
  yield* fs.remove(filename).pipe(Effect.mapError(unavailable));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.open(directories[2], {flag: 'r'});
      yield* directory.sync;
    }).pipe(Effect.mapError(unavailable)),
  );
  yield* revalidate(directories, before);
});
