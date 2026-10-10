import {Crypto, Effect, FileSystem, Option, Path, Result, Schema} from 'effect';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readCodexCloudProfile, sameCloudIdentity} from '../codex/profile.js';

export const CURSOR_CLOUD_PROFILE_VERSION = 1 as const;

export interface CursorCloudIdentityProfileV1 {
  readonly account: string;
  readonly agentId: string;
  readonly provider: 'cursor-cloud';
  readonly user: string;
  readonly version: typeof CURSOR_CLOUD_PROFILE_VERSION;
}

export class CursorCloudIdentityProfileError extends Schema.TaggedError<CursorCloudIdentityProfileError>()(
  'CursorCloudIdentityProfileError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const cursorCloudIdentityProfilePath = Effect.fn('cursorCloud.identityProfilePath')(function* (
  agentContextHome: string,
) {
  const path = yield* Path.Path;
  return path.join(agentContextHome, 'cursor-cloud', 'profile.json');
});

export const readCursorCloudIdentityProfile = Effect.fn('cursorCloud.readIdentityProfile')(function* (
  agentContextHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* cursorCloudIdentityProfilePath(agentContextHome);
  if (!(yield* fs.exists(file))) return undefined;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return yield* CursorCloudIdentityProfileError.make({
      message: 'Personal Cursor Cloud profile must not be a symlink.',
    });
  }
  const raw = yield* fs.readFileString(file);
  const parsed = Result.try(() => JSON.parse(raw) as unknown);
  if (Result.isFailure(parsed) || !isCursorCloudIdentityProfile(parsed.success)) {
    return yield* CursorCloudIdentityProfileError.make({
      message:
        'Personal Cursor Cloud profile is invalid. Move ~/.threadnote/cursor-cloud/profile.json aside and rerun bootstrap with the intended --user and --agent-id.',
    });
  }
  return parsed.success;
});

export const persistCursorCloudIdentityProfile = Effect.fn('cursorCloud.persistIdentityProfile')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'agentId' | 'user'>,
) {
  const codexProfile = yield* readCodexCloudProfile(config.agentContextHome);
  if (codexProfile && !sameCloudIdentity(codexProfile, config)) {
    return yield* CursorCloudIdentityProfileError.make({
      message: 'This Threadnote home has a conflicting Codex Cloud identity. Use a separate THREADNOTE_HOME.',
    });
  }
  const existing = yield* readCursorCloudIdentityProfile(config.agentContextHome);
  const profile = cursorCloudIdentityProfile(config);
  if (existing) {
    if (sameCursorCloudIdentity(existing, profile)) return existing;
    return yield* CursorCloudIdentityProfileError.make({
      message: `Personal Cursor Cloud already uses user "${existing.user}" and agent "${existing.agentId}" in this Threadnote home. Reuse that identity or use a separate THREADNOTE_HOME; changing it would strand the existing canonical memory cache.`,
    });
  }

  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* cursorCloudIdentityProfilePath(config.agentContextHome);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.profile.${yield* crypto.randomUUIDv4}.tmp`);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* fs.writeFileString(temporary, `${JSON.stringify(profile, undefined, 2)}\n`, {mode: 0o600});
  yield* fs.rename(temporary, target).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  yield* fs.chmod(target, 0o600);
  yield* fs.chmod(directory, 0o700);
  return profile;
});

function cursorCloudIdentityProfile(
  config: Pick<RuntimeConfig, 'account' | 'agentId' | 'user'>,
): CursorCloudIdentityProfileV1 {
  return {
    account: validateIdentity(config.account, 'account'),
    agentId: validateIdentity(config.agentId, 'agent id'),
    provider: 'cursor-cloud',
    user: validateIdentity(config.user, 'user'),
    version: CURSOR_CLOUD_PROFILE_VERSION,
  };
}

function isCursorCloudIdentityProfile(value: unknown): value is CursorCloudIdentityProfileV1 {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CursorCloudIdentityProfileV1>;
  if (
    candidate.version !== CURSOR_CLOUD_PROFILE_VERSION ||
    candidate.provider !== 'cursor-cloud' ||
    typeof candidate.account !== 'string' ||
    typeof candidate.agentId !== 'string' ||
    typeof candidate.user !== 'string'
  ) {
    return false;
  }
  return [candidate.account, candidate.agentId, candidate.user].every(value => {
    try {
      return validatePortableSegment(value) === value;
    } catch {
      return false;
    }
  });
}

function validateIdentity(value: string, label: string): string {
  try {
    return validatePortableSegment(value);
  } catch (cause) {
    throw CursorCloudIdentityProfileError.make({
      cause,
      message: `Personal Cursor Cloud ${label} is not a portable identity.`,
    });
  }
}

function sameCursorCloudIdentity(left: CursorCloudIdentityProfileV1, right: CursorCloudIdentityProfileV1): boolean {
  return left.account === right.account && left.agentId === right.agentId && left.user === right.user;
}
