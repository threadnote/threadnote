import {syncRegisteredSources} from '@threadnote/integration-runtime/source';
import {Console, Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readSourceConfiguration} from './config.js';
import {
  runObsidianSourceAdd,
  runObsidianSourceInventory,
  runObsidianSourceRemove,
  runObsidianSourceStatus,
  runObsidianSourceSync,
  syncObsidianSourcesBeforeRecall,
} from '@threadnote/integration-obsidian/source';
import {
  runSuperhumanSourceAdd,
  runSuperhumanSourceInventory,
  runSuperhumanSourceRemove,
  runSuperhumanSourceStatus,
  runSuperhumanSourceSync,
  syncSuperhumanSourcesBeforeRecall,
} from '@threadnote/integration-superhuman/source';
import {
  runPocketSourceAdd,
  runPocketSourceInventory,
  runPocketSourceRemove,
  runPocketSourceStatus,
  runPocketSourceSync,
  syncPocketSourcesBeforeRecall,
} from '@threadnote/integration-pocket/source';
import {
  runGitHubSourceAdd,
  runGitHubSourceRemove,
  runGitHubSourceStatus,
  runGitHubSourceSync,
  syncGitHubSourcesBeforeRecall,
} from '@threadnote/integration-github/source';

import {
  runLinearSourceAdd,
  runLinearSourceRemove,
  runLinearSourceStatus,
  runLinearSourceSync,
  syncLinearSourcesBeforeRecall,
} from '@threadnote/integration-linear/source';

export interface SourceAddOptions {
  readonly type: 'obsidian' | 'superhuman' | 'pocket' | 'linear' | 'github';
  readonly id: string;
  readonly apply?: boolean;
  readonly vault?: string;
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly inbox?: string;
  readonly documents: readonly string[];
  readonly repositories?: readonly string[];
  readonly pages?: readonly string[];
  readonly credentialEnv?: string;
  readonly organizationId?: string;
  readonly principalId?: string;
  readonly teamIds?: readonly string[];
  readonly projectIds?: readonly string[];
  readonly issueIds?: readonly string[];
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
  if (options.type === 'linear') return yield* runLinearSourceAdd(config, options);
  if (options.type === 'github')
    return yield* runGitHubSourceAdd(config, {...options, repositories: options.repositories ?? []});
  if (options.type === 'pocket') return yield* runPocketSourceAdd(config, options);
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
        : source.type === 'linear'
          ? `${source.id} (linear): ${source.projectIds.length} selected project(s), ${source.issueIds.length} issue(s); project ${source.project}; ${source.enabled ? 'enabled' : 'disabled'}`
          : source.type === 'github'
            ? `${source.id} (github): ${source.repositories.join(', ')}; project ${source.project ?? 'projectless'}; ${source.enabled ? 'enabled' : 'disabled'}`
            : source.type === 'pocket'
              ? `${source.id} (pocket): all accessible recordings; project ${source.project ?? 'projectless'}; ${source.enabled ? 'enabled' : 'disabled'}`
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
  if ((yield* sourceType(config, id)) === 'linear') return yield* runLinearSourceStatus(config, id);
  if ((yield* sourceType(config, id)) === 'github') return yield* runGitHubSourceStatus(config, id);
  if ((yield* sourceType(config, id)) === 'pocket') {
    const inventory = yield* runPocketSourceInventory(config, id);
    yield* Console.log(`Pocket source "${id}": ${inventory.entries.length} cached item(s).`);
    for (const entry of inventory.entries)
      yield* Console.log(`${entry.documentId}: ${entry.status}; ${entry.chunks} local chunk(s)`);
    if (inventory.progress)
      yield* Console.log(`Import continues at page ${inventory.progress.page}, item ${inventory.progress.offset + 1}.`);
    return inventory;
  }
  if ((yield* sourceType(config, id)) === 'superhuman') {
    return yield* runSuperhumanSourceInventory(config, id);
  }
  return yield* runObsidianSourceInventory(config, id);
});

export const runSourceStatus = Effect.fn('source.status')(function* (config: RuntimeConfig, id: string) {
  if ((yield* sourceType(config, id)) === 'linear') return yield* runLinearSourceStatus(config, id);
  if ((yield* sourceType(config, id)) === 'github') return yield* runGitHubSourceStatus(config, id);
  if ((yield* sourceType(config, id)) === 'pocket') return yield* runPocketSourceStatus(config, id);
  if ((yield* sourceType(config, id)) === 'superhuman') {
    return yield* runSuperhumanSourceStatus(config, id);
  }
  return yield* runObsidianSourceStatus(config, id);
});

export const runSourceSync = Effect.fn('source.sync')(function* (config: RuntimeConfig, options: SourceCommandOptions) {
  if ((yield* sourceType(config, options.id)) === 'linear') return yield* runLinearSourceSync(config, options);
  if ((yield* sourceType(config, options.id)) === 'github') return yield* runGitHubSourceSync(config, options);
  if ((yield* sourceType(config, options.id)) === 'pocket') return yield* runPocketSourceSync(config, options);
  if ((yield* sourceType(config, options.id)) === 'superhuman') {
    return yield* runSuperhumanSourceSync(config, options);
  }
  return yield* runObsidianSourceSync(config, options);
});

export const runSourceRemove = Effect.fn('source.remove')(function* (
  config: RuntimeConfig,
  options: SourceCommandOptions,
) {
  if ((yield* sourceType(config, options.id)) === 'linear') return yield* runLinearSourceRemove(config, options);
  if ((yield* sourceType(config, options.id)) === 'github') return yield* runGitHubSourceRemove(config, options);
  if ((yield* sourceType(config, options.id)) === 'pocket') return yield* runPocketSourceRemove(config, options);
  if ((yield* sourceType(config, options.id)) === 'superhuman') {
    return yield* runSuperhumanSourceRemove(config, options);
  }
  return yield* runObsidianSourceRemove(config, options);
});

export const syncSourcesBeforeRecall = Effect.fn('source.syncBeforeRecall')(function* (config: RuntimeConfig) {
  return yield* syncRegisteredSources([
    syncObsidianSourcesBeforeRecall(config),
    syncSuperhumanSourcesBeforeRecall(config),
    syncPocketSourcesBeforeRecall(config),
    syncLinearSourcesBeforeRecall(config),
    syncGitHubSourcesBeforeRecall(config),
  ]);
});
