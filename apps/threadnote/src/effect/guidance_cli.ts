import {Console, Effect} from 'effect';
import {Argument, Command} from 'effect/cli';
import {getAgentAdapter} from '../agent_integration/adapters.js';
import {
  GuidanceError,
  renderGuidanceResult,
  runGuidanceImport,
  runGuidanceProject,
  runGuidanceRemove,
  runGuidanceStatus,
} from '../guidance/index.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {boolean, optionalString, repeatedString, requiredString} from './cli/flags.js';

export const guidanceCommandMetadata = {
  productionLog: {
    subcommands: {import: 'requires-apply', project: 'requires-apply', remove: 'requires-apply', status: 'never'},
  },
} as const;

export function makeGuidanceCommand(
  withRuntime: <E, R>(body: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const surface = Argument.String('surface').pipe(
    Argument.withDescription('Agent surface from `threadnote agents list`'),
  );
  const adapterFor = (selector: string) => {
    const adapter = getAgentAdapter(selector);
    if (!adapter) throw new Error(`Unknown surface ${selector}; run threadnote agents list.`);
    if (!adapter.guidance) throw new Error(`${selector} does not declare project guidance support.`);
    return adapter;
  };
  const importCommand = Command.make(
    'import',
    {
      apply: boolean('apply', 'Create or reuse a private candidate review'),
      cwd: optionalString('cwd', 'Project root'),
      json: boolean('json', 'Emit JSON'),
      project: requiredString('project', 'Project namespace'),
      surface,
    },
    ({surface, json, ...options}) =>
      withRuntime(config =>
        Effect.try({try: () => adapterFor(surface), catch: cause => GuidanceError.make({message: String(cause)})}).pipe(
          Effect.flatMap(adapter => runGuidanceImport(config, adapter, options)),
          Effect.flatMap(value => Console.log(renderGuidanceResult(value, json))),
        ),
      ),
  );
  const projectCommand = Command.make(
    'project',
    {
      apply: boolean('apply', 'Write the managed project-guidance block'),
      cwd: optionalString('cwd', 'Project root'),
      force: boolean('force', 'Replace only a conflicting managed block'),
      json: boolean('json', 'Emit JSON'),
      memory: repeatedString('memory', 'Active durable memory URI; repeat'),
      project: requiredString('project', 'Project namespace'),
      surface,
    },
    ({surface, json, ...options}) =>
      withRuntime(config =>
        Effect.try({try: () => adapterFor(surface), catch: cause => GuidanceError.make({message: String(cause)})}).pipe(
          Effect.flatMap(adapter => runGuidanceProject(config, adapter, options)),
          Effect.flatMap(value => Console.log(renderGuidanceResult(value, json))),
        ),
      ),
  );
  const status = Command.make(
    'status',
    {
      cwd: optionalString('cwd', 'Project root'),
      json: boolean('json', 'Emit JSON'),
      project: requiredString('project', 'Project namespace'),
      surface,
    },
    ({surface, json, project, cwd}) =>
      withRuntime(config =>
        Effect.try({try: () => adapterFor(surface), catch: cause => GuidanceError.make({message: String(cause)})}).pipe(
          Effect.flatMap(adapter => runGuidanceStatus(config, adapter, project, cwd)),
          Effect.flatMap(value => Console.log(renderGuidanceResult(value, json))),
        ),
      ),
  );
  const remove = Command.make(
    'remove',
    {
      apply: boolean('apply', 'Remove only the receipt-proven managed block'),
      cwd: optionalString('cwd', 'Project root'),
      force: boolean('force', 'Remove a changed or missing managed block while preserving unmanaged text'),
      json: boolean('json', 'Emit JSON'),
      project: requiredString('project', 'Project namespace'),
      surface,
    },
    ({surface, json, ...options}) =>
      withRuntime(config =>
        Effect.try({try: () => adapterFor(surface), catch: cause => GuidanceError.make({message: String(cause)})}).pipe(
          Effect.flatMap(adapter => runGuidanceRemove(config, adapter, options)),
          Effect.flatMap(value => Console.log(renderGuidanceResult(value, json))),
        ),
      ),
  );
  return Command.make('guidance').pipe(
    Command.withDescription('Import and safely project reviewed project guidance'),
    Command.withSubcommands([importCommand, projectCommand, status, remove]),
  );
}
