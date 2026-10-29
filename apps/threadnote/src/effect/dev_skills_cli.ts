import {Console, Effect} from 'effect';
import {Command} from 'effect/cli';
import {
  applyDevSkills,
  listDevSkills,
  previewDevSkills,
  readDevSkillsRuntimeCapabilities,
  runDevSkillsRefresh,
  statusDevSkills,
} from '../dev_skills/index.js';
import {
  DevSkillsError,
  type DevSkillsPlan,
  type DevSkillsReadiness,
  type DevSkillsResult,
} from '../dev_skills/contract.js';
import type {CliRuntimeRunner} from './cli.js';
import {boolean, optionalChoice, optionalString, requiredChoice, requiredString} from './cli/flags.js';
import {
  prepareCandidateDevSkillsUpdate,
  readCandidateDevSkillsUpdate,
  refreshCandidateDevSkillsUpdate,
} from '../dev_skills/update_protocol.js';

export const devSkillsCommandMetadata = {productionLog: {mode: 'never'}} as const;

const selectionFlags = () => ({
  scope: optionalChoice('scope', ['user', 'project', 'local'], 'Native skill scope supported by the selected host'),
  cwd: optionalString('cwd', 'Project checkout for project or local scope'),
  profile: optionalChoice(
    'profile',
    ['desktop', 'codex-cloud-personal', 'cursor-cloud-personal'],
    'Personal workflow profile',
  ),
});

export function makeDevSkillsCommand(withRuntime: CliRuntimeRunner) {
  const updateProtocol = () => requiredChoice('protocol-version', ['1'], 'Updater wire protocol version');
  const prepareUpdate = Command.make(
    'prepare-update',
    {
      protocolVersion: updateProtocol(),
      releaseRoot: requiredString('release-root', 'Exact final installation release root'),
      releaseVersion: requiredString('release-version', 'Exact candidate release version'),
    },
    ({releaseRoot, releaseVersion}) =>
      withRuntime(config =>
        prepareCandidateDevSkillsUpdate(config, releaseRoot, releaseVersion).pipe(
          Effect.flatMap(result => Console.log(JSON.stringify(result))),
        ),
      ),
  ).pipe(Command.withDescription('Prepare a verified candidate’s workflow update for the updater'));
  const updateState = (command: 'refresh-update' | 'update-status') =>
    Command.make(
      command,
      {protocolVersion: updateProtocol(), intent: requiredString('intent', 'Prepared update intent')},
      ({intent}) =>
        withRuntime(config =>
          (command === 'refresh-update'
            ? refreshCandidateDevSkillsUpdate(config, intent)
            : readCandidateDevSkillsUpdate(config, intent)
          ).pipe(Effect.flatMap(result => Console.log(JSON.stringify(result)))),
        ),
    );
  const refresh = Command.make(
    'refresh-enrolled',
    {intent: requiredString('intent', 'Prepared update intent'), json: boolean('json', 'Print the refresh result')},
    ({intent}) =>
      withRuntime(config =>
        runDevSkillsRefresh(config, intent).pipe(Effect.flatMap(result => Console.log(JSON.stringify(result)))),
      ),
  ).pipe(Command.withDescription('Resume the active release’s prepared workflow refresh'));
  const capabilities = Command.make(
    'runtime-capabilities',
    {json: boolean('json', 'Print the runtime compatibility declaration')},
    () =>
      withRuntime(() =>
        readDevSkillsRuntimeCapabilities().pipe(Effect.flatMap(result => Console.log(JSON.stringify(result)))),
      ),
  ).pipe(Command.withDescription('Report workflow compatibility for the Threadnote updater'));
  const list = Command.make(
    'list',
    {json: boolean('json', 'Print bundle and supported agent targets as JSON')},
    ({json}) => withRuntime(config => listDevSkills(config).pipe(Effect.flatMap(result => printCatalog(result, json)))),
  );
  const status = Command.make(
    'status',
    {
      agent: optionalString('agent', 'Agent host alias or catalog surface; omit to inspect enrolled targets'),
      ...selectionFlags(),
      json: boolean('json', 'Print installation and workflow readiness as JSON'),
    },
    ({agent, scope, cwd, profile, json}) =>
      withRuntime(config => {
        if (agent === undefined && (scope !== undefined || cwd !== undefined || profile !== undefined))
          return Effect.fail(
            DevSkillsError.make({
              code: 'invalid-selector',
              message: 'Provide --agent when selecting a scope, project or profile.',
            }),
          );
        return statusDevSkills(config, agent === undefined ? undefined : {agent, scope, cwd, profile}).pipe(
          Effect.flatMap(result => printStatus(result, json)),
        );
      }),
  );
  const actions = (['install', 'update', 'remove'] as const).map(action =>
    Command.make(
      action,
      {
        agent: requiredString('agent', 'Agent host alias or catalog surface, for example codex'),
        ...selectionFlags(),
        dryRun: boolean('dry-run', 'Preview exact changes without writing files'),
        json: boolean('json', 'Print the lifecycle result as JSON'),
      },
      ({agent, scope, cwd, profile, dryRun, json}) =>
        withRuntime(config => {
          const selector = {agent, scope, cwd, profile};
          if (dryRun)
            return previewDevSkills(config, action, selector).pipe(Effect.flatMap(result => printPlan(result, json)));
          return applyDevSkills(config, action, selector).pipe(Effect.flatMap(result => printPlan(result, json)));
        }),
    ),
  );
  return Command.make('dev-skills').pipe(
    Command.withDescription('Install and manage Threadnote development workflows for your agent host'),
    Command.withSubcommands([
      list,
      status,
      ...actions,
      capabilities,
      refresh,
      prepareUpdate,
      updateState('refresh-update'),
      updateState('update-status'),
    ]),
  );
}

function printCatalog(result: Effect.Success<ReturnType<typeof listDevSkills>>, json: boolean) {
  return Console.log(
    json
      ? JSON.stringify(result)
      : [
          `Threadnote development workflows · ${result.bundle.releaseVersion}`,
          'dev-spec → dev-plan → dev-cycle (with watch-pr)',
          ...result.surfaces.map(surface =>
            surface.status === 'managed'
              ? `${surface.surfaceId}\t${surface.scopes.join(', ')}\t${surface.platforms.join(', ')}\t${surface.profile}`
              : `${surface.surfaceId}\tUnsupported: ${surface.reason}`,
          ),
        ].join('\n'),
  );
}

function readinessLines(readiness?: DevSkillsReadiness): readonly string[] {
  if (!readiness) return [];
  return (['planning', 'publication', 'watch'] as const).map(operation => {
    const value = readiness[operation];
    const reasons = [...new Set(value.reasons.map(reason => reason.message))].join(' ');
    return `  ${operation}: ${value.state}${reasons ? ' — ' + reasons : ''}`;
  });
}

function printStatus(result: Effect.Success<ReturnType<typeof statusDevSkills>>, json: boolean) {
  return Console.log(
    json
      ? JSON.stringify(result)
      : [
          `Bundled workflows: ${result.bundle.releaseVersion}`,
          ...(result.targets.length === 0
            ? ['No recorded workflow installations. Use dev-skills list to choose an agent.']
            : []),
          ...result.targets.flatMap(status => [
            `${status.target.surfaceId} (${status.target.profile}, ${status.target.scope}): ${status.installationState}${status.enrolled ? '' : ' · not enrolled'}`,
            `  Destination: ${status.target.skillRoot}`,
            `  Consumers: ${status.consumers.length}`,
            ...status.issues.map(issue => `  ${issue.message}${issue.path ? ' (' + issue.path + ')' : ''}`),
            ...readinessLines(status.readiness),
          ]),
        ].join('\n'),
  );
}

function printPlan(result: DevSkillsPlan | DevSkillsResult, json: boolean) {
  const prefix = 'applied' in result ? (result.applied ? 'Applied' : 'No change for') : 'Preview';
  return Console.log(
    json
      ? JSON.stringify(result)
      : [
          `${prefix} ${result.action}: ${result.target.surfaceId} (${result.target.profile}, ${result.target.scope})`,
          `Destination: ${result.target.skillRoot}`,
          `Installation: ${result.installationState}`,
          `Affected consumers: ${result.consumers.length}`,
          ...result.consumers.map(consumer => `  ${consumer.target.surfaceId}: ${consumer.home}`),
          `File changes: ${result.changes.length}`,
          ...result.changes.map(
            change =>
              `  ${change.beforeHash === null ? 'Create' : change.afterHash === null ? 'Remove' : 'Update'} ${change.path}`,
          ),
          ...result.issues.map(issue => `${issue.code}: ${issue.message}${issue.path ? ' (' + issue.path + ')' : ''}`),
          ...('retainedPaths' in result ? result.retainedPaths.map(path => `Preserved modified file: ${path}`) : []),
          ...readinessLines(result.readiness),
        ].join('\n'),
  );
}
