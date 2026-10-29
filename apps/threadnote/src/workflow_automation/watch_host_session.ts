import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import * as EffectString from 'effect/String';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {stableJson} from '../workflow_memory/protocol.js';

const uuid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu));
const claimSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-watch-host-session'),
  version: Schema.Literal(1),
  sessionId: uuid,
  home: Schema.String.check(Schema.isMaxLength(4096)),
  watchId: Schema.String.check(Schema.isMaxLength(128)),
  consumerId: Schema.String.check(Schema.isMaxLength(128)),
  wakeupId: Schema.String.check(Schema.isMaxLength(128)),
  attemptId: uuid,
  collectorToken: uuid,
});
export type NativeWatchHostClaim = typeof claimSchema.Type;
const failure = (code: string, message: string) => WorkflowAutomationError.make({code, message});

/** Shared across private watch homes. The short mutex may recover; the separate claim is deliberately sticky. */
const withSession = Effect.fn('nativeWatch.hostSession')(function* <A, E, R>(
  userHome: string,
  sessionId: string,
  operation: (file: string) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = yield* fs.realPath(userHome);
  for (const segment of ['.threadnote', 'native-watch-host-sessions-v1']) {
    directory = path.join(directory, segment);
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
      return yield* failure('unsafe-host-session', 'Host session directories cannot be symbolic links.');
    if (!(yield* fs.exists(directory))) yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    if ((yield* fs.stat(directory)).type !== 'Directory' || (yield* fs.realPath(directory)) !== directory)
      return yield* failure('unsafe-host-session', 'Host session claims require a canonical private directory.');
  }
  const canonicalId = yield* Schema.decodeEffect(uuid)(sessionId).pipe(
    Effect.mapBoth({
      onSuccess: EffectString.toLowerCase,
      onFailure: () => failure('invalid-host-session', 'Invalid host session identity.'),
    }),
  );
  const file = path.join(directory, 'cursor-' + canonicalId + '.json');
  return yield* withExclusiveFileLock(
    fs,
    file + '.lock',
    {
      createParentDirectory: false,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 300_000,
      waitTimeoutMilliseconds: 2000,
      heartbeatIntervalMilliseconds: 1000,
      useCanonicalProcessStartIdentity: true,
      recoverReusedProcessIdImmediately: true,
    },
    operation(file),
  );
});
const readClaim = Effect.fn('nativeWatch.readHostClaim')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
    return yield* failure('unsafe-host-session', 'Host session claims cannot be symbolic links.');
  if (!(yield* fs.exists(file))) return undefined;
  const stat = yield* fs.stat(file);
  if (stat.type !== 'File' || Number(stat.size) > 16_384)
    return yield* failure('invalid-host-session', 'Host session claim is not a bounded regular file.');
  const bytes = yield* fs.readFileString(file);
  return yield* Schema.decodeEffect(Schema.fromJsonString(claimSchema), {onExcessProperty: 'error'})(bytes).pipe(
    Effect.mapError(() =>
      failure('invalid-host-session', 'Host session claim is corrupt; explicit recovery is required.'),
    ),
  );
});
const canonicalClaim = Effect.fn('nativeWatch.canonicalHostClaim')(function* (claim: NativeWatchHostClaim) {
  return {
    ...claim,
    home: yield* (yield* FileSystem.FileSystem).realPath(claim.home),
    sessionId: EffectString.toLowerCase(claim.sessionId),
  };
});
export const claimNativeWatchHostSession = Effect.fn('nativeWatch.claimHostSession')(function* (
  userHome: string,
  input: NativeWatchHostClaim,
) {
  const claim = yield* canonicalClaim(input);
  yield* withSession(userHome, claim.sessionId, file =>
    Effect.gen(function* () {
      if (yield* readClaim(file))
        return yield* failure(
          'host-session-owned',
          'This Cursor CLI session has an unresolved native host claim. Recover its exact owning watch explicitly.',
        );
      const fs = yield* FileSystem.FileSystem;
      const bytes = stableJson(claim) + '\n';
      if (new TextEncoder().encode(bytes).byteLength > 16_384)
        return yield* failure('invalid-host-session', 'Host session claim exceeds its byte bound.');
      const temporary = file + '.' + (yield* (yield* Crypto.Crypto).randomUUIDv4()) + '.tmp';
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(temporary, bytes, {flag: 'wx', mode: 0o600});
        const prepared = yield* readClaim(temporary);
        if (stableJson(prepared) !== stableJson(claim))
          return yield* failure('invalid-host-session', 'Prepared host session claim changed before publication.');
        // A hard link publishes the complete inode atomically and refuses to replace any final claim.
        yield* fs.link(temporary, file);
      }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
    }),
  );
});

/** Only a verified completed child or explicit recovery of this exact attempt can release its claim. */
export const releaseNativeWatchHostSession = Effect.fn('nativeWatch.releaseHostSession')(function* (
  userHome: string,
  input: NativeWatchHostClaim,
  completedOnly = false,
) {
  const claim = yield* canonicalClaim(input);
  yield* withSession(userHome, claim.sessionId, file =>
    Effect.gen(function* () {
      const current = yield* readClaim(file);
      if (!current) return;
      if (stableJson(current) !== stableJson(claim)) {
        if (completedOnly) return;
        return yield* failure('host-session-owned', 'Another native attempt owns this Cursor CLI session.');
      }
      yield* (yield* FileSystem.FileSystem).remove(file);
    }),
  );
});
