import {Console, Effect} from 'effect';
import {Command} from 'effect/cli';
import {uriSegment} from '@threadnote/workspace/manifest';
import {
  mutateManagerManifestProject,
  readManagerManifestProject,
  readManagerWorksetCatalog,
  type ManagerManifestProjectMutationResult,
} from '../manager/worksets.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {applicationError} from '@threadnote/platform/errors';
import {argument, boolean, optionalString, repeatedString} from './cli/flags.js';
import {SystemInfo} from '@threadnote/platform/system';

interface JsonOption {
  readonly json: boolean;
}

export function makeProjectCommand(
  withRuntime: <E, R>(body: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const list = Command.make('list', {json: boolean('json', 'Emit versioned machine-readable JSON')}, options =>
    withRuntime(config => runProjectListCommand(config, options)),
  ).pipe(Command.withDescription('List local Threadnote projects'));
  const show = Command.make(
    'show',
    {json: boolean('json', 'Emit versioned machine-readable JSON'), project: argument('project', 'Project name')},
    ({project, ...options}) => withRuntime(config => runProjectShowCommand(config, project, options)),
  ).pipe(Command.withDescription('Show one local Threadnote project'));
  const create = Command.make(
    'create',
    {
      json: boolean('json', 'Emit versioned machine-readable JSON'),
      name: argument('name', 'New project name'),
      path: optionalString('path', 'Repository path; defaults to the current directory'),
      seed: repeatedString('seed', 'Repository guidance seed pattern; repeat for multiple patterns'),
      uri: optionalString('uri', 'Canonical project resource URI; defaults from the project name'),
    },
    options => withRuntime(config => runProjectCreateCommand(config, options)),
  ).pipe(Command.withDescription('Create a local Threadnote project'));
  const update = Command.make(
    'update',
    {
      clearSeed: boolean('clear-seed', 'Remove all repository guidance seed patterns'),
      json: boolean('json', 'Emit versioned machine-readable JSON'),
      name: optionalString('name', 'Rename the project'),
      path: optionalString('path', 'Replace the repository path'),
      project: argument('project', 'Existing project name'),
      seed: repeatedString('seed', 'Replace guidance seed patterns; repeat for multiple patterns'),
      uri: optionalString('uri', 'Replace the canonical project resource URI'),
    },
    options => withRuntime(config => runProjectUpdateCommand(config, options)),
  ).pipe(Command.withDescription('Update or rename a local Threadnote project'));
  const delete_ = Command.make(
    'delete',
    {
      confirm: boolean('confirm', 'Required: remove the project definition'),
      json: boolean('json', 'Emit versioned machine-readable JSON'),
      project: argument('project', 'Project name'),
    },
    options => withRuntime(config => runProjectDeleteCommand(config, options)),
  ).pipe(Command.withDescription('Delete a local Threadnote project (requires --confirm)'));
  return Command.make('project').pipe(
    Command.withDescription('Manage named repository and graph-scope projects'),
    Command.withSubcommands([list, show, create, update, delete_]),
  );
}

export function runProjectListCommand(config: RuntimeConfig, options: JsonOption) {
  return Effect.gen(function* () {
    const catalog = yield* readManagerWorksetCatalog(config);
    if (options.json) {
      yield* Console.log(JSON.stringify({projects: catalog.projects, revision: catalog.revision, version: 1}));
      return;
    }
    if (catalog.projects.length === 0) {
      yield* Console.log('No projects defined. Create one with `threadnote project create <name>`.');
      return;
    }
    yield* Console.log(`Projects (${catalog.projects.length}):`);
    for (const project of catalog.projects) {
      yield* Console.log(
        `- ${project.name} · ${project.path}${
          project.worksetCount === 0 ? '' : ` · ${project.worksetCount} workset${project.worksetCount === 1 ? '' : 's'}`
        }`,
      );
    }
  });
}

export function runProjectShowCommand(config: RuntimeConfig, project: string, options: JsonOption) {
  return Effect.gen(function* () {
    const current = yield* readManagerManifestProject(config, project);
    if (options.json) {
      yield* Console.log(JSON.stringify({project: current, version: 1}));
      return;
    }
    yield* Console.log(`Project: ${current.name}`);
    yield* Console.log(`Path: ${current.path}`);
    yield* Console.log(`URI: ${current.uri}`);
    yield* Console.log(`Seed patterns: ${current.seed.length === 0 ? 'none' : current.seed.join(', ')}`);
    yield* Console.log(
      current.graph === undefined
        ? 'Graph scope: full repository'
        : `Graph scope: ${current.graph.roots.join(', ')}${
            current.graph.include?.length ? ` (includes ${current.graph.include.join(', ')})` : ''
          }`,
    );
  });
}

export function runProjectCreateCommand(
  config: RuntimeConfig,
  options: JsonOption & {
    readonly name: string;
    readonly path?: string;
    readonly seed: readonly string[];
    readonly uri?: string;
  },
) {
  return Effect.gen(function* () {
    const catalog = yield* readManagerWorksetCatalog(config);
    const system = yield* SystemInfo;
    const result = yield* mutateManagerManifestProject(config, {
      expectedRevision: catalog.revision,
      name: options.name,
      operation: 'create',
      path: options.path ?? system.currentDirectory(),
      seed: options.seed,
      uri: options.uri ?? `threadnote://resources/repos/${uriSegment(options.name)}`,
    });
    yield* renderProjectMutation(result, options.json, options.name);
  });
}

export function runProjectUpdateCommand(
  config: RuntimeConfig,
  options: JsonOption & {
    readonly clearSeed: boolean;
    readonly name?: string;
    readonly path?: string;
    readonly project: string;
    readonly seed: readonly string[];
    readonly uri?: string;
  },
) {
  return Effect.gen(function* () {
    if (options.clearSeed && options.seed.length > 0) {
      return yield* applicationError('update project', new Error('Specify either --seed or --clear-seed, not both.'));
    }
    const [catalog, current] = yield* Effect.all([
      readManagerWorksetCatalog(config),
      readManagerManifestProject(config, options.project),
    ]);
    const result = yield* mutateManagerManifestProject(config, {
      expectedRevision: catalog.revision,
      name: options.name ?? current.name,
      operation: 'update',
      path: options.path ?? current.path,
      project: current.name,
      seed: options.clearSeed ? [] : options.seed.length > 0 ? options.seed : current.seed,
      uri: options.uri ?? current.uri,
    });
    yield* renderProjectMutation(result, options.json, options.name ?? current.name);
  });
}

export function runProjectDeleteCommand(
  config: RuntimeConfig,
  options: JsonOption & {readonly confirm: boolean; readonly project: string},
) {
  return Effect.gen(function* () {
    if (!options.confirm) {
      return yield* applicationError('delete project', new Error('Refusing to delete without --confirm.'));
    }
    const catalog = yield* readManagerWorksetCatalog(config);
    const result = yield* mutateManagerManifestProject(config, {
      confirm: true,
      expectedRevision: catalog.revision,
      operation: 'delete',
      project: options.project,
    });
    yield* renderProjectMutation(result, options.json, options.project);
  });
}

function renderProjectMutation(result: ManagerManifestProjectMutationResult, json: boolean, project: string) {
  if (json) {
    return Console.log(
      JSON.stringify({
        catalog: result.catalog,
        changed: result.changed,
        operation: result.operation,
        project,
        version: 1,
        warnings: result.warnings,
      }),
    );
  }
  return Effect.gen(function* () {
    const action = result.operation === 'create' ? 'Created' : result.operation === 'delete' ? 'Deleted' : 'Updated';
    yield* Console.log(`${action} project: ${project}${result.changed ? '' : ' (no changes)'}`);
    for (const warning of result.warnings) yield* Console.log(`WARN ${warning}`);
  });
}
