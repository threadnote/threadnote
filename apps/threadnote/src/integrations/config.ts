import {Effect} from 'effect';
import * as core from '@threadnote/integration-core/config';
import {
  makeSourceConfigurationRegistry,
  makeSourceConfigurationStore,
  sourceConfigurationStoreLayer,
} from '@threadnote/integration-runtime/config';
import * as obsidian from '@threadnote/integration-obsidian/config';
import * as superhuman from '@threadnote/integration-superhuman/config';
import * as pocket from '@threadnote/integration-pocket/config';
import * as github from '@threadnote/integration-github/config';
import * as linear from '@threadnote/integration-linear/config';

export type {ObsidianSourceConfig, ObsidianProjectionConfig} from '@threadnote/integration-obsidian/config';
export type {SuperhumanSourceConfig, SuperhumanDocumentConfig} from '@threadnote/integration-superhuman/config';
export type {PocketSourceConfig} from '@threadnote/integration-pocket/config';
export type {GitHubSourceConfig} from '@threadnote/integration-github/config';
export type {LinearSourceConfig} from '@threadnote/integration-linear/config';
export {validateLinearSourceConfig} from '@threadnote/integration-linear/config';
export {
  DEFAULT_OBSIDIAN_EXCLUDES,
  DEFAULT_PROJECTION_KINDS,
  DEFAULT_PROJECTION_STATUSES,
  ObsidianConfigurationError,
  isObsidianSource,
  requireObsidianSource,
  requireObsidianProjection,
  validateObsidianIdentifier,
} from '@threadnote/integration-obsidian/config';
export {
  DEFAULT_SUPERHUMAN_CREDENTIAL_ENV,
  DEFAULT_SUPERHUMAN_REFRESH_INTERVAL_MINUTES,
  DEFAULT_SUPERHUMAN_MAX_STALE_HOURS,
  requireSuperhumanSource,
  validateSuperhumanDocumentId,
  validateSuperhumanPageId,
  validateSuperhumanSourceConfig,
} from '@threadnote/integration-superhuman/config';
export {
  DEFAULT_POCKET_CREDENTIAL_ENV,
  requirePocketSource,
  validatePocketSourceConfig,
} from '@threadnote/integration-pocket/config';
export {
  DEFAULT_GITHUB_CREDENTIAL_ENV,
  requireGitHubSource,
  validateGitHubSourceConfig,
  normalizeGitHubRepository,
} from '@threadnote/integration-github/config';
export {requireLinearSource} from '@threadnote/integration-linear/config';
export {sourceConfigurationPath as obsidianConfigurationPath} from '@threadnote/integration-runtime/config';

export type SourceConfig =
  | obsidian.ObsidianSourceConfig
  | superhuman.SuperhumanSourceConfig
  | pocket.PocketSourceConfig
  | github.GitHubSourceConfig
  | linear.LinearSourceConfig;
export type SourceConfiguration = core.SourceConfiguration<SourceConfig, obsidian.ObsidianProjectionConfig>;
export type ObsidianConfiguration = SourceConfiguration;
export const sourceConfigurationRegistry = makeSourceConfigurationRegistry<
  SourceConfig,
  obsidian.ObsidianProjectionConfig
>({
  sources: [
    obsidian.obsidianSourceCodec,
    superhuman.superhumanSourceCodec,
    pocket.pocketSourceCodec,
    linear.linearSourceCodec,
    github.githubSourceCodec,
  ],
  projections: [obsidian.obsidianProjectionCodec],
});
export const sourceConfigurationLayer = sourceConfigurationStoreLayer(sourceConfigurationRegistry);
const store = makeSourceConfigurationStore(sourceConfigurationRegistry);
export const emptyObsidianConfiguration = sourceConfigurationRegistry.empty;
export const parseSourceConfiguration = sourceConfigurationRegistry.parse;
export const parseObsidianConfiguration = parseSourceConfiguration;
export const renderSourceConfiguration = sourceConfigurationRegistry.render;
export const renderObsidianConfiguration = renderSourceConfiguration;
export const readSourceConfiguration = (config: core.ConfigurationHome) =>
  store.read(config).pipe(Effect.map(value => value as SourceConfiguration));
export const readObsidianConfiguration = readSourceConfiguration;
export const writeSourceConfiguration = store.write;
export const writeObsidianConfiguration = writeSourceConfiguration;
export const mutateSourceConfiguration = (
  config: core.ConfigurationHome,
  update: (current: SourceConfiguration) => SourceConfiguration,
) => store.mutate(config, current => update(current as SourceConfiguration));
export const upsertObsidianSource = (configuration: SourceConfiguration, source: obsidian.ObsidianSourceConfig) =>
  obsidian.upsertObsidianSource(configuration, source) as SourceConfiguration;
export const upsertObsidianProjection = (
  configuration: SourceConfiguration,
  projection: obsidian.ObsidianProjectionConfig,
) => obsidian.upsertObsidianProjection(configuration, projection) as SourceConfiguration;
export const removeObsidianSource = (configuration: SourceConfiguration, id: string) =>
  obsidian.removeObsidianSource(configuration, id) as SourceConfiguration;
export const removeObsidianProjection = (configuration: SourceConfiguration, id: string) =>
  obsidian.removeObsidianProjection(configuration, id) as SourceConfiguration;
export const upsertSuperhumanSource = (configuration: SourceConfiguration, source: superhuman.SuperhumanSourceConfig) =>
  superhuman.upsertSuperhumanSource(configuration, source) as SourceConfiguration;
export const upsertPocketSource = (configuration: SourceConfiguration, source: pocket.PocketSourceConfig) =>
  pocket.upsertPocketSource(configuration, source) as SourceConfiguration;
export const upsertGitHubSource = (configuration: SourceConfiguration, source: github.GitHubSourceConfig) =>
  github.upsertGitHubSource(configuration, source) as SourceConfiguration;
export const upsertLinearSource = (configuration: SourceConfiguration, source: linear.LinearSourceConfig) =>
  linear.upsertLinearSource(configuration, source) as SourceConfiguration;
export function sourceConfigurationFingerprint(source: Exclude<SourceConfig, obsidian.ObsidianSourceConfig>): string {
  switch (source.type) {
    case 'linear':
      return linear.linearConfigurationFingerprint(source);
    case 'github':
      return github.sourceConfigurationFingerprint(source);
    case 'pocket':
      return pocket.sourceConfigurationFingerprint(source);
    case 'superhuman':
      return superhuman.sourceConfigurationFingerprint(source);
  }
}
