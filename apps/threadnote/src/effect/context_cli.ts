import {Command} from 'effect/cli';
import type {CliRuntimeRunner, CliMutationRuntimeRunner} from './cli.js';
import {
  makeContextBriefCommand,
  makeContextHealthCommand,
  makeContextHealthRepairCommand,
  makeContextMaintainCommand,
  makeContextCheckCommand,
} from './workflow_cli.js';
import {makeContextMetadataCommand} from './maintenance_metadata_cli.js';
import {runContextBrief} from '../context_brief/commands.js';
import {runContextHealth} from '../memory/context/health_commands.js';
import {runContextHealthAggregate, runContextHealthSchedule} from '../memory/context/health_aggregate_commands.js';
import {runContextHealthRepairApply, runContextHealthRepairPreview} from '../memory/context/health_repair_commands.js';
import {runContextMaintainCommand} from '../memory/context/maintenance.js';
import {runMaintenanceMetadataApply, runMaintenanceMetadataPreview} from '../memory/maintenance/metadata_commands.js';
import {runContextCheck} from '../context_check/commands.js';

export function makeContextRuntimeCommand(
  withRuntimeEffect: CliRuntimeRunner,
  withMutationRuntimeEffect: CliMutationRuntimeRunner,
) {
  const contextBrief = makeContextBriefCommand(options =>
    withMutationRuntimeEffect(config => runContextBrief(config, options)),
  );
  const contextHealth = makeContextHealthCommand(
    options => withRuntimeEffect(config => runContextHealth(config, options)),
    options => withRuntimeEffect(config => runContextHealthAggregate(config, options)),
    options => runContextHealthSchedule(options),
  );
  const contextHealthRepair = makeContextHealthRepairCommand(
    options => withRuntimeEffect(config => runContextHealthRepairPreview(config, options)),
    options => withRuntimeEffect(config => runContextHealthRepairApply(config, options)),
  );
  const contextMetadata = makeContextMetadataCommand(
    options => withRuntimeEffect(config => runMaintenanceMetadataPreview(config, options)),
    options => withRuntimeEffect(config => runMaintenanceMetadataApply(config, options)),
  );
  const contextMaintain = makeContextMaintainCommand(options =>
    withRuntimeEffect(config => runContextMaintainCommand(config, options)),
  );
  const contextCheck = makeContextCheckCommand(options =>
    withRuntimeEffect(config => runContextCheck(config, options)),
  );
  return Command.make('context').pipe(
    Command.withDescription('Compile task-oriented agent context'),
    Command.withSubcommands([
      contextBrief,
      contextHealth,
      contextHealthRepair,
      contextMetadata,
      contextCheck,
      contextMaintain,
    ]),
  );
}
