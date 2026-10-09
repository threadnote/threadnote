import type {Effect, FileSystem, Path} from 'effect';
import type {SystemInfo} from '@threadnote/platform/system';
import type {ExternalProvider, ExternalSourceAccessPolicy} from '@threadnote/store/external-resource';
import type {ConfigurationHome, SourceConfig} from './config.js';

export interface ExternalSourcePolicyRegistration {
  readonly provider: ExternalProvider;
  readonly resolve: (
    source: SourceConfig,
    config: ConfigurationHome,
  ) => Effect.Effect<ExternalSourceAccessPolicy | undefined, never, FileSystem.FileSystem | Path.Path | SystemInfo>;
}
