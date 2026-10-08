import {Effect, FileSystem, Option, Path, Redacted} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {runtimeLstat, runtimeReadBoundedStableRegularFile, SystemInfo} from '@threadnote/platform/system';
import {parsePilotInput, SlackPilotError} from './contract.js';
import {probeSlackPilot} from './probe.js';

const invalid = () => new SlackPilotError({code: 'invalid-input'});

const privateFile = Effect.fn('slack.privateFile')(function* (target: string | undefined) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  if (!target || !path.isAbsolute(target) || system.userId === undefined) return yield* invalid();
  const before = yield* fromPromiseInterruptible(() => runtimeLstat(target), invalid);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 4_096n) return yield* invalid();
  const info = yield* fs.stat(target).pipe(Effect.mapError(invalid));
  const inode = Option.getOrUndefined(info.ino);
  if (
    Option.getOrUndefined(info.uid) !== system.userId ||
    (info.mode & 0o077) !== 0 ||
    BigInt(info.mode) !== before.mode ||
    BigInt(info.dev) !== before.dev ||
    inode === undefined ||
    BigInt(inode) !== before.ino
  )
    return yield* invalid();
  const bytes = yield* fromPromiseInterruptible(() => runtimeReadBoundedStableRegularFile(target, 4_096), invalid);
  const after = yield* fromPromiseInterruptible(() => runtimeLstat(target), invalid);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.birthtimeNs !== after.birthtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.mtimeNs !== after.mtimeNs
  )
    return yield* invalid();
  return yield* Effect.try({try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes), catch: invalid});
});

export const runSlackPilotProbe = Effect.fn('slack.runProbe')(function* (inputFile: string) {
  const raw = yield* privateFile(inputFile);
  const input = yield* Effect.try({try: () => parsePilotInput(JSON.parse(raw)), catch: invalid});
  const system = yield* SystemInfo;
  const tokenPath = system.environment().THREADNOTE_SLACK_TOKEN_FILE;
  if (!tokenPath) return yield* new SlackPilotError({code: 'missing-credential'});
  const token = Redacted.make((yield* privateFile(tokenPath)).trim());
  const summary = yield* fromPromiseInterruptible(
    signal => probeSlackPilot(token, input, {signal}),
    error => (error instanceof SlackPilotError ? error : new SlackPilotError({code: 'transport-rejected'})),
  );
  return `${JSON.stringify(summary, null, 2)}\n`;
});
