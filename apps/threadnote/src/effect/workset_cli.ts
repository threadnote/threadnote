import {Console, Effect} from 'effect';
import {Command} from 'effect/cli';
import {applicationError, fromSync} from '@threadnote/platform/errors';
import {
  mutateManagerWorksetDefinition,
  normalizeManagerWorksetName,
  readManagerWorksetCatalog,
  readManagerWorksetDefinition,
  type ManagerWorksetDefinitionMutationResult,
} from '../manager/worksets.js';
import {runCodeGraphWorksetPrepare, runCodeGraphWorksetStatus} from '../code_graph/commands.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {argument, boolean, describeFlag, integerFlag, optional, optionalString, repeatedString} from './cli/flags.js';

interface JsonOption {
  readonly json: boolean;
}

export function makeWorksetCommand(
  withRuntime: <E, R>(body: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const list = Command.make('list', {json: boolean('json', 'Emit versioned machine-readable JSON')}, options =>
    withRuntime(config => runWorksetListCommand(config, options)),
  ).pipe(Command.withDescription('List and inspect local Workset definitions'));

  const show = Command.make(
    'show',
    {json: boolean('json', 'Emit versioned machine-readable JSON'), name: argument('name', 'Workset name')},
    ({name, ...options}) => withRuntime(config => runWorksetShowCommand(config, name, options)),
  ).pipe(Command.withDescription('Show a Workset definition and resolved member state'));

  const create = Command.make(
    'create',
    {
      description: optionalString('description', 'Optional Workset description'),
      json: boolean('json', 'Emit versioned machine-readable JSON'),
      name: argument('name', 'New Workset name'),
      projects: repeatedString('project', 'Manifest project member; repeat for each member', 4_096),
    },
    options => withRuntime(config => runWorksetCreateCommand(config, options)),
  ).pipe(Command.withDescription('Create a local Workset definition'));

  const update = Command.make(
    'update',
    {
      clearDescription: boolean('clear-description', 'Remove the Workset description'),
      description: optionalString('description', 'Replace the Workset description'),
      json: boolean('json', 'Emit versioned machine-readable JSON'),
      name: optionalString('name', 'Rename the Workset'),
      projects: repeatedString('project', 'Replace members; omit to preserve current members', 4_096),
      workset: argument('workset', 'Existing Workset name'),
    },
    options => withRuntime(config => runWorksetUpdateCommand(config, options)),
  ).pipe(Command.withDescription('Update or rename a local Workset definition'));

  const delete_ = Command.make(
    'delete',
    {
      confirm: boolean('confirm', 'Required: permanently remove this Workset definition'),
      json: boolean('json', 'Emit versioned machine-readable JSON'),
      workset: argument('workset', 'Workset name'),
    },
    options => withRuntime(config => runWorksetDeleteCommand(config, options)),
  ).pipe(Command.withDescription('Delete a local Workset definition (requires --confirm)'));

  const prepare = Command.make(
    'prepare',
    {
      concurrency: optional(
        describeFlag(
          integerFlag('concurrency'),
          'Maximum repositories to index and project concurrently (default 2, maximum 8)',
        ),
      ),
      json: boolean('json', 'Print a machine-readable preparation receipt'),
      name: argument('name', 'Workset name'),
    },
    options => withRuntime(config => runCodeGraphWorksetPrepare(config, options)),
  ).pipe(Command.withDescription('Build member snapshots explicitly and atomically publish the routing catalog'));

  const status = Command.make(
    'status',
    {
      json: boolean('json', 'Print a machine-readable workset coverage receipt'),
      name: argument('name', 'Workset name'),
    },
    options => withRuntime(config => runCodeGraphWorksetStatus(config, options)),
  ).pipe(Command.withDescription('Compare the workset manifest, ready snapshots, and published routing catalog'));

  return Command.make('workset').pipe(
    Command.withDescription('Manage, prepare, and inspect named sets of related repos'),
    Command.withSubcommands([list, show, create, update, delete_, prepare, status]),
  );
}

export function runWorksetListCommand(config: RuntimeConfig, options: JsonOption) {
  return Effect.gen(function* () {
    const catalog = yield* readManagerWorksetCatalog(config);
    if (options.json) {
      yield* Console.log(
        JSON.stringify({
          editability: catalog.editability,
          revision: catalog.revision,
          version: 1,
          worksets: catalog.definitions,
        }),
      );
      return;
    }
    if (catalog.definitions.length === 0) {
      yield* Console.log(
        'No worksets defined. Create one with `threadnote workset create <name> --project <project>`.',
      );
      return;
    }
    yield* Console.log(`Worksets (${catalog.definitions.length}):`);
    for (const workset of catalog.definitions) {
      yield* Console.log(
        `- ${workset.name} (${workset.memberCount} project(s))${workset.description ? ` — ${workset.description}` : ''}`,
      );
    }
  });
}

export function runWorksetShowCommand(config: RuntimeConfig, name: string, options: JsonOption) {
  return Effect.gen(function* () {
    const workset = yield* readManagerWorksetDefinition(config, yield* worksetSelector(name));
    if (options.json) {
      yield* Console.log(JSON.stringify({version: 1, workset}));
      return;
    }
    yield* Console.log(`Workset: ${workset.name}`);
    if (workset.description) yield* Console.log(workset.description);
    yield* Console.log('Projects:');
    for (const member of workset.members) {
      if (!member.configured) {
        yield* Console.log(`- ${member.project} [not found in manifest projects]`);
        continue;
      }
      yield* Console.log(`- ${member.project}${member.uri === undefined ? '' : ` (${member.uri})`}`);
    }
  });
}

export function runWorksetCreateCommand(
  config: RuntimeConfig,
  options: JsonOption & {readonly description?: string; readonly name: string; readonly projects: readonly string[]},
) {
  return Effect.gen(function* () {
    const catalog = yield* readManagerWorksetCatalog(config);
    const result = yield* mutateManagerWorksetDefinition(config, {
      ...(options.description === undefined ? {} : {description: options.description}),
      expectedRevision: catalog.revision,
      name: options.name,
      operation: 'create',
      projects: options.projects,
    });
    yield* renderWorksetMutation(result, options.json, options.name);
  });
}

export function runWorksetUpdateCommand(
  config: RuntimeConfig,
  options: JsonOption & {
    readonly clearDescription: boolean;
    readonly description?: string;
    readonly name?: string;
    readonly projects: readonly string[];
    readonly workset: string;
  },
) {
  return Effect.gen(function* () {
    if (options.clearDescription && options.description !== undefined) {
      return yield* applicationError(
        'update workset',
        new Error('Specify either --description or --clear-description, not both.'),
      );
    }
    const workset = yield* worksetSelector(options.workset);
    const [catalog, current] = yield* Effect.all([
      readManagerWorksetCatalog(config),
      readManagerWorksetDefinition(config, workset),
    ]);
    const result = yield* mutateManagerWorksetDefinition(config, {
      ...(options.clearDescription
        ? {}
        : options.description === undefined && current.description !== undefined
          ? {description: current.description}
          : options.description === undefined
            ? {}
            : {description: options.description}),
      expectedRevision: catalog.revision,
      name: options.name ?? current.name,
      operation: 'update',
      projects: options.projects.length === 0 ? current.members.map(member => member.project) : options.projects,
      workset,
    });
    const destination = options.name ?? current.name;
    const canonicalDestination = result.catalog.definitions.find(
      definition => definition.name.toLowerCase() === normalizeManagerWorksetName(destination).toLowerCase(),
    )?.name;
    yield* renderWorksetMutation(result, options.json, canonicalDestination ?? current.name);
  });
}

export function runWorksetDeleteCommand(
  config: RuntimeConfig,
  options: JsonOption & {readonly confirm: boolean; readonly workset: string},
) {
  return Effect.gen(function* () {
    if (!options.confirm) {
      return yield* applicationError('delete workset', new Error('Refusing to delete without --confirm.'));
    }
    const workset = yield* worksetSelector(options.workset);
    const catalog = yield* readManagerWorksetCatalog(config);
    const result = yield* mutateManagerWorksetDefinition(config, {
      confirm: true,
      expectedRevision: catalog.revision,
      operation: 'delete',
      workset,
    });
    yield* renderWorksetMutation(result, options.json, workset);
  });
}

function worksetSelector(value: string) {
  return fromSync('workset', () => normalizeManagerWorksetName(value));
}

function renderWorksetMutation(result: ManagerWorksetDefinitionMutationResult, json: boolean, name: string) {
  if (json)
    return Console.log(
      JSON.stringify({
        catalog: result.catalog,
        changed: result.changed,
        operation: result.operation,
        version: 1,
        warnings: result.warnings,
      }),
    );
  return Effect.gen(function* () {
    const action = result.operation === 'create' ? 'Created' : result.operation === 'delete' ? 'Deleted' : 'Updated';
    yield* Console.log(`${action} workset: ${name}${result.changed ? '' : ' (no changes)'}`);
    for (const warning of result.warnings) yield* Console.log(`WARN ${warning}`);
  });
}
