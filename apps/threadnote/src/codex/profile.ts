import {Crypto, Effect, FileSystem, Option, Path, Result, Schema} from 'effect';
import {validatePortableSegment} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {normalizeTeamName} from '../share/index.js';
import {readCursorCloudIdentityProfile} from '../cursor/profile.js';

export const DEFAULT_CODEX_CLOUD_IDENTITY = 'codex-cloud';
export const MAX_CODEX_CLOUD_SHARES = 16;

export interface CodexCloudProfile {
  readonly account: string;
  readonly agentId: string;
  readonly provider: 'codex-cloud';
  readonly teams: readonly string[];
  readonly user: string;
  readonly version: 1;
}

export class CodexCloudError extends Schema.TaggedError<CodexCloudError>()('CodexCloudError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export function normalizeCodexCloudShares(values: readonly string[]): readonly string[] {
  const teams = [...new Set(values.map(normalizeTeamName))].sort();
  if (teams.length === 0 || teams.length > MAX_CODEX_CLOUD_SHARES) {
    throw CodexCloudError.make({message: `Codex Cloud requires 1–${MAX_CODEX_CLOUD_SHARES} configured shares.`});
  }
  return teams;
}

export const codexCloudProfilePath = Effect.fn('codexCloud.profilePath')(function* (home: string) {
  return (yield* Path.Path).join(home, 'codex-cloud', 'profile.json');
});

export const readCodexCloudProfile = Effect.fn('codexCloud.readProfile')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* codexCloudProfilePath(home);
  if (!(yield* fs.exists(file))) return undefined;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
    return yield* CodexCloudError.make({message: 'Codex Cloud profile must not be a symlink.'});
  }
  const raw = yield* fs.readFileString(file);
  const parsed = Result.try(() => JSON.parse(raw) as unknown);
  if (Result.isFailure(parsed) || !isProfile(parsed.success)) {
    return yield* CodexCloudError.make({
      message:
        'Invalid Codex Cloud profile. Restore codex-cloud/profile.json or use a separate THREADNOTE_HOME and bootstrap with the intended stable identity.',
    });
  }
  return parsed.success;
});

export function sameCloudIdentity(
  left: Pick<CodexCloudProfile, 'account' | 'agentId' | 'user'>,
  right: Pick<RuntimeConfig, 'account' | 'agentId' | 'user'>,
): boolean {
  return left.account === right.account && left.agentId === right.agentId && left.user === right.user;
}

export const assertCodexCloudIdentity = Effect.fn('codexCloud.assertIdentity')(function* (config: RuntimeConfig) {
  for (const existing of [
    yield* readCodexCloudProfile(config.agentContextHome),
    yield* readCursorCloudIdentityProfile(config.agentContextHome),
  ]) {
    if (existing && !sameCloudIdentity(existing, config)) {
      return yield* CodexCloudError.make({
        message: `This Threadnote home already uses user "${existing.user}" and agent "${existing.agentId}" (${existing.provider}). Reuse that identity or choose a separate THREADNOTE_HOME.`,
      });
    }
  }
  for (const value of [config.account, config.agentId, config.user]) {
    yield* Effect.try({
      try: () => validatePortableSegment(value),
      catch: cause => CodexCloudError.make({cause, message: 'Codex Cloud identity must use portable identifiers.'}),
    });
  }
});

export const persistCodexCloudProfile = Effect.fn('codexCloud.persistProfile')(function* (
  config: RuntimeConfig,
  teams: readonly string[],
) {
  yield* assertCodexCloudIdentity(config);
  const profile: CodexCloudProfile = {
    account: config.account,
    agentId: config.agentId,
    provider: 'codex-cloud',
    teams: normalizeCodexCloudShares(teams),
    user: config.user,
    version: 1,
  };
  const existing = yield* readCodexCloudProfile(config.agentContextHome);
  if (existing && JSON.stringify(existing) === JSON.stringify(profile)) return existing;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* codexCloudProfilePath(config.agentContextHome);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.profile.${yield* crypto.randomUUIDv4}.tmp`);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  yield* fs.writeFileString(temporary, `${JSON.stringify(profile, undefined, 2)}\n`, {mode: 0o600});
  yield* fs.rename(temporary, target).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  yield* fs.chmod(target, 0o600);
  yield* fs.chmod(directory, 0o700);
  return profile;
});

function isProfile(value: unknown): value is CodexCloudProfile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CodexCloudProfile>;
  if (
    candidate.version !== 1 ||
    candidate.provider !== 'codex-cloud' ||
    !Array.isArray(candidate.teams) ||
    candidate.teams.some(team => typeof team !== 'string')
  )
    return false;
  try {
    if (
      ![candidate.account, candidate.agentId, candidate.user].every(
        value => typeof value === 'string' && validatePortableSegment(value) === value,
      )
    )
      return false;
    return JSON.stringify(candidate.teams) === JSON.stringify(normalizeCodexCloudShares(candidate.teams));
  } catch {
    return false;
  }
}
