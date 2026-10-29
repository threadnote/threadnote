import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  requiredIdentifier,
  portableIdentifier,
  positiveInteger,
  requiredString,
  optionalBoolean,
  SourceConfigurationError,
  CREDENTIAL_ENV_PATTERN,
  type SourceConfig,
  type SourceConfiguration,
  type ProjectionConfig,
} from '@threadnote/integration-core/config';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export {validateSourceIdentifier} from '@threadnote/integration-core/config';
export interface GitHubSourceConfig {
  readonly type: 'github';
  readonly id: string;
  readonly enabled: boolean;
  readonly credentialEnv: string;
  readonly credentialStorage?: 'local';
  readonly project: string | null;
  readonly repositories: readonly string[];
  readonly refreshIntervalMinutes: number;
  readonly maxStaleHours: number;
}
export const DEFAULT_GITHUB_CREDENTIAL_ENV = 'THREADNOTE_GITHUB_TOKEN';
export function upsertGitHubSource<S extends SourceConfig, P extends ProjectionConfig>(
  configuration: SourceConfiguration<S, P>,
  source: GitHubSourceConfig,
): SourceConfiguration<S | GitHubSourceConfig, P> {
  const checked = validateGitHubSourceConfig(source);
  if (EffectArray.some(configuration.sources, item => item.id === checked.id && item.type !== checked.type))
    throw SourceConfigurationError.make({message: `Source "${checked.id}" already has another type.`});
  return {
    version: 2,
    projections: configuration.projections,
    sources: [...EffectArray.filter(configuration.sources, item => item.id !== checked.id), checked].sort((a, b) =>
      Effect.pipe(a.id, EffectString.localeCompare(b.id)),
    ),
  };
}
export function requireGitHubSource(configuration: SourceConfiguration, id: string): GitHubSourceConfig {
  const source = EffectOption.getOrUndefined(EffectArray.findFirst(configuration.sources, item => item.id === id));
  if (!source || !isGitHubSource(source))
    throw SourceConfigurationError.make({message: `No GitHub source named "${id}".`});
  return source;
}
export function validateGitHubSourceConfig(source: GitHubSourceConfig): GitHubSourceConfig {
  return parseGitHubSource(
    {
      id: source.id,
      type: source.type,
      enabled: source.enabled,
      credential_env: source.credentialEnv,
      credential_storage: source.credentialStorage,
      project: source.project,
      repositories: source.repositories,
      refresh_interval_minutes: source.refreshIntervalMinutes,
      max_stale_hours: source.maxStaleHours,
    },
    'github source',
  );
}
export function normalizeGitHubRepository(value: unknown): string {
  if (typeof value !== 'string')
    throw SourceConfigurationError.make({message: 'GitHub repository must be owner/name or a github.com URL.'});
  let path = Effect.pipe(value, EffectString.trim);
  if (Effect.pipe(path, EffectString.startsWith('https://'))) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      throw SourceConfigurationError.make({message: 'GitHub repository URL is invalid.'});
    }
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash)
      throw SourceConfigurationError.make({message: 'GitHub repository URL must be on github.com.'});
    path = Effect.pipe(url.pathname, EffectString.replace(/\/$/, ''), EffectString.slice(1));
  }
  const parts = Effect.pipe(path, EffectString.split('/'));
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0]) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1]) ||
    parts[1] === '.' ||
    parts[1] === '..'
  )
    throw SourceConfigurationError.make({message: 'GitHub repository must be owner/name or a github.com URL.'});
  return `${Effect.pipe(parts[0], EffectString.toLowerCase)}/${Effect.pipe(parts[1], EffectString.toLowerCase)}`;
}
function parseGitHubSource(value: Record<string, unknown>, label: string): GitHubSourceConfig {
  const id = portableIdentifier(requiredIdentifier(value.id, `${label}.id`), `${label}.id`);
  const credentialEnv =
    value.credential_env === undefined
      ? DEFAULT_GITHUB_CREDENTIAL_ENV
      : requiredString(value.credential_env, `${label}.credential_env`);
  if (!CREDENTIAL_ENV_PATTERN.test(credentialEnv))
    throw SourceConfigurationError.make({message: `${label}.credential_env must be an environment variable name.`});
  if (value.credential_storage !== undefined && value.credential_storage !== 'local')
    throw SourceConfigurationError.make({message: `${label}.credential_storage must be "local" when present.`});
  const project = value.project === null ? null : requiredIdentifier(value.project, `${label}.project`);
  if (!EffectArray.isArray(value.repositories) || value.repositories.length === 0 || value.repositories.length > 64)
    throw SourceConfigurationError.make({message: `${label}.repositories must contain 1 to 64 repositories.`});
  const repositories = EffectArray.map(value.repositories, repository => normalizeGitHubRepository(repository));
  if (new Set(repositories).size !== repositories.length)
    throw SourceConfigurationError.make({message: `${label}.repositories contains duplicate repositories.`});
  return {
    type: 'github',
    id,
    enabled: optionalBoolean(value.enabled, true, `${label}.enabled`),
    credentialEnv,
    ...(value.credential_storage === 'local' ? {credentialStorage: 'local' as const} : {}),
    project,
    repositories: repositories.sort(),
    refreshIntervalMinutes: positiveInteger(
      value.refresh_interval_minutes,
      15,
      10_080,
      `${label}.refresh_interval_minutes`,
    ),
    maxStaleHours: positiveInteger(value.max_stale_hours, 24, 8_760, `${label}.max_stale_hours`),
  };
}

export function isGitHubSource(source: SourceConfig): source is GitHubSourceConfig {
  return source.type === 'github';
}

export function sourceConfigurationFingerprint(source: GitHubSourceConfig): string {
  return sha256HexSync(
    JSON.stringify({
      type: source.type,
      id: source.id,
      enabled: source.enabled,
      credentialEnv: source.credentialEnv,
      credentialStorage: source.credentialStorage ?? null,
      project: source.project,
      repositories: EffectArray.map(source.repositories, normalizeGitHubRepository).sort(),
      refreshIntervalMinutes: source.refreshIntervalMinutes,
      maxStaleHours: source.maxStaleHours,
    }),
  );
}

export {
  readSourceConfiguration,
  writeSourceConfiguration,
  mutateSourceConfiguration,
  type SourceConfig,
  type SourceConfiguration,
} from '@threadnote/integration-core/config';

export function serializeGitHubSource(source: GitHubSourceConfig) {
  return {
    id: source.id,
    type: source.type,
    enabled: source.enabled,
    credential_env: source.credentialEnv,
    ...(source.credentialStorage === undefined ? {} : {credential_storage: source.credentialStorage}),
    project: source.project,
    repositories: [...source.repositories],
    refresh_interval_minutes: source.refreshIntervalMinutes,
    max_stale_hours: source.maxStaleHours,
  };
}
export const githubSourceCodec = {
  type: 'github' as const,
  versions: [2] as const,
  parse: parseGitHubSource,
  serialize: serializeGitHubSource,
};
