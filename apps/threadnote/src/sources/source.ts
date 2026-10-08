import {Console, Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readSourceConfiguration} from '../obsidian/config.js';
import {
  runObsidianSourceAdd,
  runObsidianSourceInventory,
  runObsidianSourceRemove,
  runObsidianSourceStatus,
  runObsidianSourceSync,
  syncObsidianSourcesBeforeRecall,
} from '../obsidian/source.js';
import {
  runSuperhumanSourceAdd,
  runSuperhumanSourceInventory,
  runSuperhumanSourceRemove,
  runSuperhumanSourceStatus,
  runSuperhumanSourceSync,
  syncSuperhumanSourcesBeforeRecall,
} from '../superhuman/source.js';

export interface SourceAddOptions {
  readonly type: 'obsidian' | 'superhuman';
  readonly id: string;
  readonly apply?: boolean;
  readonly vault?: string;
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly inbox?: string;
  readonly documents: readonly string[];
  readonly pages?: readonly string[];
  readonly credentialEnv?: string;
  readonly project?: string;
  readonly projectless?: boolean;
  readonly includeHidden?: boolean;
  readonly refreshIntervalMinutes?: number;
  readonly maxStaleHours?: number;
}

export interface SourceCommandOptions {
  readonly id: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
}

class SourceCommandError extends Schema.TaggedError<SourceCommandError>()('SourceCommandError', {
  message: Schema.String,
}) {}

export const runSourceAdd = Effect.fn('source.add')(function* (config: RuntimeConfig, options: SourceAddOptions) {
  if (options.type === 'superhuman') {
    return yield* runSuperhumanSourceAdd(config, options);
  }
  if (!options.vault) {
    return yield* SourceCommandError.make({message: 'Obsidian sources require --vault.'});
  }
  return yield* runObsidianSourceAdd(config, {...options, vault: options.vault});
});

export const runSourceList = Effect.fn('source.list')(function* (config: RuntimeConfig) {
  const configuration = yield* readSourceConfiguration(config);
  if (configuration.sources.length === 0) {
    yield* Console.log('No sources configured.');
    return;
  }
  for (const source of configuration.sources) {
    yield* Console.log(
      source.type === 'obsidian'
        ? `${source.id} (obsidian): ${source.vault}; ${source.enabled ? 'enabled' : 'disabled'}`
        : `${source.id} (superhuman): ${source.documents.length} document(s); project ${source.project ?? 'projectless'}; ${source.enabled ? 'enabled' : 'disabled'}`,
    );
  }
});

const sourceType = Effect.fn('source.type')(function* (config: RuntimeConfig, id: string) {
  const source = (yield* readSourceConfiguration(config)).sources.find(candidate => candidate.id === id);
  if (!source) {
    return yield* SourceCommandError.make({message: `No source named "${id}".`});
  }
  return source.type;
});

export const runSourceInventory = Effect.fn('source.inventory')(function* (config: RuntimeConfig, id: string) {
  if ((yield* sourceType(config, id)) === 'superhuman') {
    return yield* runSuperhumanSourceInventory(config, id);
  }
  return yield* runObsidianSourceInventory(config, id);
});

export const runSourceStatus = Effect.fn('source.status')(function* (config: RuntimeConfig, id: string) {
  if ((yield* sourceType(config, id)) === 'superhuman') {
    return yield* runSuperhumanSourceStatus(config, id);
  }
  return yield* runObsidianSourceStatus(config, id);
});

export const runSourceSync = Effect.fn('source.sync')(function* (config: RuntimeConfig, options: SourceCommandOptions) {
  if ((yield* sourceType(config, options.id)) === 'superhuman') {
    return yield* runSuperhumanSourceSync(config, options);
  }
  return yield* runObsidianSourceSync(config, options);
});

export const runSourceRemove = Effect.fn('source.remove')(function* (
  config: RuntimeConfig,
  options: SourceCommandOptions,
) {
  if ((yield* sourceType(config, options.id)) === 'superhuman') {
    return yield* runSuperhumanSourceRemove(config, options);
  }
  return yield* runObsidianSourceRemove(config, options);
});

export const syncSourcesBeforeRecall = Effect.fn('source.syncBeforeRecall')(function* (config: RuntimeConfig) {
  const obsidian = yield* syncObsidianSourcesBeforeRecall(config);
  const superhuman = yield* syncSuperhumanSourcesBeforeRecall(config);
  return {
    syncedSources: [...obsidian.syncedSources, ...superhuman.syncedSources],
    warnings: [...obsidian.warnings, ...superhuman.warnings],
  };
});
