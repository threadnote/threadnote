import {Array as EffectArray} from 'effect';
import {Cause, Effect, Path, Schema} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {expandPath} from '@threadnote/platform/paths';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import {
  MANAGER_DEV_SKILLS_ROUTES as routes,
  type ManagerDevSkillsApiError,
  type ManagerDevSkillsApplyResponse,
  type ManagerDevSkillsCatalog,
  type ManagerDevSkillsPlan,
  type ManagerDevSkillsProjects,
  type ManagerDevSkillsStatus,
} from '@threadnote/manager/dev-skills/contracts';
import {
  applyDevSkills,
  DevSkillsError,
  listDevSkills,
  previewDevSkills,
  statusDevSkills,
  type DevSkillsAction,
  type DevSkillsProfile,
  type DevSkillsScope,
  type DevSkillsSelector,
} from '../dev_skills/index.js';
import {selectDevSkillsTarget} from '../dev_skills/plan.js';
import {consumerId, enrollmentContext, readReceipt} from '../dev_skills/registry.js';
import {isRecord, stableJson} from '../dev_skills/files.js';
import {managerProjectPathIsForeign} from './project/roots.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface ManagerDevSkillsRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
}
interface ManagerDevSkillsResponse {
  readonly status: number;
  readonly body: unknown;
}
class ManagerDevSkillsHttpError extends Schema.TaggedError<
  ManagerDevSkillsHttpError,
  {readonly brand: unique symbol}
>()('ManagerDevSkillsHttpError', {
  code: Schema.String,
  message: Schema.String,
  recovery: Schema.Literals(['preview', 'select-project', 'select-target', 'retry']),
}) {}
const invalid = (message: string) =>
  ManagerDevSkillsHttpError.make({code: 'invalid-input', message, recovery: 'select-target'});
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || EffectArray.some(EffectRecord.keys(value), key => !allowed.includes(key)))
    throw invalid(
      'Provide only the documented workflow request fields. Destinations and runtime configuration are server-owned.',
    );
  return value;
}
function isDevSkillsProfile(value: string): value is DevSkillsProfile {
  return value === 'desktop' || value === 'codex-cloud-personal' || value === 'cursor-cloud-personal';
}

function isDevSkillsScope(value: string): value is DevSkillsScope {
  return value === 'user' || value === 'project' || value === 'local';
}

function selectorInput(value: unknown): DevSkillsSelector {
  const selected = object(value, ['agent', 'profile', 'scope', 'cwd']);
  if (typeof selected.agent !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/u.test(selected.agent))
    throw invalid('Select a catalog agent.');
  const profile = selected.profile;
  if (profile !== undefined && (typeof profile !== 'string' || !isDevSkillsProfile(profile)))
    throw invalid('Select a desktop or personal Codex/Cursor profile.');
  const scope = selected.scope;
  if (scope !== undefined && (typeof scope !== 'string' || !isDevSkillsScope(scope)))
    throw invalid('Select a declared user, project or local scope.');
  const cwd = selected.cwd;
  if (scope === 'project' || scope === 'local') {
    if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || Effect2.pipe(cwd, EffectString.includes('\0')))
      throw invalid('Project and local scope require one registered project folder.');
  } else if (cwd !== undefined) {
    throw invalid('A project folder is valid only for an explicit project or local scope.');
  }
  return {
    agent: selected.agent,
    ...(profile === undefined ? {} : {profile}),
    ...(scope === undefined ? {} : {scope}),
    ...(cwd === undefined ? {} : {cwd}),
  };
}

function queryInput(url: URL): DevSkillsSelector | undefined {
  if (!url.search) return undefined;
  const entries = [...url.searchParams];
  if (new Set(EffectArray.map(entries, ([key]) => key)).size !== entries.length)
    throw invalid('Duplicate workflow selector fields are not allowed.');
  return selectorInput(EffectRecord.fromEntries(entries));
}
function isDevSkillsAction(value: string): value is DevSkillsAction {
  return value === 'install' || value === 'update' || value === 'remove';
}

function mutationInput(value: unknown, applying: boolean) {
  const body = object(value, applying ? ['action', 'selector', 'previewDigest', 'confirm'] : ['action', 'selector']);
  if (typeof body.action !== 'string' || !isDevSkillsAction(body.action))
    throw invalid('Select install, update or remove.');
  let previewDigest: string | undefined;
  if (applying) {
    if (body.confirm !== true || typeof body.previewDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(body.previewDigest))
      throw invalid('Apply requires explicit confirmation and the exact preview digest.');
    previewDigest = body.previewDigest;
  }
  return {
    action: body.action,
    selector: selectorInput(body.selector),
    previewDigest,
  };
}

const validate = <A>(body: () => A) =>
  Effect.try({
    try: body,
    catch: error => (Schema.is(ManagerDevSkillsHttpError)(error) ? error : invalid('The workflow request is invalid.')),
  });

function supportedProjectPath(value: string, platform: NodeJS.Platform): boolean {
  if (!value || value.length > 4096 || managerProjectPathIsForeign(value, platform)) return false;
  for (const character of value) {
    const point = Effect2.pipe(
      character,
      EffectString.codePointAt(0),
      Effect2.Option.getOrElse(() => undefined),
    )!;
    if (point <= 0x1f || point === 0x7f) return false;
  }
  // Win32 aliases trailing ASCII spaces/dots; do not present their rewritten identity.
  return (
    platform !== 'win32' ||
    !EffectArray.some(
      Effect2.pipe(value, EffectString.split(/[\\/]/u)),
      part => part !== '.' && part !== '..' && /[ .]$/u.test(part),
    )
  );
}

/** This identity resolver is shared by browser choices and admission, never display sanitization. */
const readManagerDevSkillsProjects = Effect.fn('managerDevSkills.readProjects')(function* (config: RuntimeConfig) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const manifest = yield* readSeedManifest(config.manifestPath);
  const projects: Array<{name: string; path: string}> = [];
  for (const project of manifest.projects) {
    if (!supportedProjectPath(project.path, system.platform)) continue;
    const expanded = yield* expandPath(project.path);
    if (!supportedProjectPath(expanded, system.platform)) continue;
    projects.push({name: project.name, path: path.resolve(expanded)});
  }
  return {schemaVersion: 1, projects} satisfies ManagerDevSkillsProjects;
});

/** Project choices authorize known roots, never a destination supplied by the browser. */
const admitSelector = Effect.fn('managerDevSkills.admitSelector')(function* (
  config: RuntimeConfig,
  selector: DevSkillsSelector,
  statusOnly = false,
) {
  const path = yield* Path.Path;
  if (selector.cwd !== undefined && (!path.isAbsolute(selector.cwd) || path.resolve(selector.cwd) !== selector.cwd))
    return yield* invalid('Select an absolute, normalized project folder from Worksets.');
  const target = yield* selectDevSkillsTarget(config, selector);
  const selected = {
    agent: target.surfaceId,
    profile: target.profile,
    scope: target.scope,
    ...(target.cwd ? {cwd: target.cwd} : {}),
  };
  if (target.scope === 'user') return selected;
  if (!selector.cwd || (selector.scope !== 'project' && selector.scope !== 'local'))
    return yield* invalid('Explicitly select a project or local scope and registered project folder.');
  const context = yield* enrollmentContext(config);
  const consumer = {home: context.home, installationRoot: context.root, target};
  const id = consumerId(consumer);
  const enrollment = context.homeIndex.targets[id];
  // Removed history can be observed without restoring installation authority.
  if (statusOnly && enrollment?.state === 'removed' && stableJson(enrollment.target) === stableJson(target))
    return selected;
  if (enrollment?.state === 'enrolled' && stableJson(enrollment.target) === stableJson(target)) {
    const receipt = (yield* readReceipt(target)).receipt;
    if (stableJson(receipt?.consumers[id]) === stableJson(consumer)) return selected;
  }
  const catalog = yield* readManagerDevSkillsProjects(config).pipe(Effect.result);
  if (
    catalog._tag === 'Success' &&
    EffectArray.some(
      catalog.success.projects,
      project => path.isAbsolute(project.path) && path.relative(path.resolve(project.path), target.cwd!) === '',
    )
  )
    return selected;
  return yield* ManagerDevSkillsHttpError.make({
    code: 'project-not-registered',
    message:
      'Select a registered project folder in Worksets, or an existing receipt-owned workflow target. No destination was created.',
    recovery: 'select-project',
  });
});

const response = (status: number, body: unknown): ManagerDevSkillsResponse => ({status, body});
function errorResponse(error: unknown): ManagerDevSkillsResponse {
  if (Schema.is(ManagerDevSkillsHttpError)(error))
    return response(400, {
      code: error.code,
      error: error.message,
      recovery: error.recovery,
      retryAfterMilliseconds: 0,
    } satisfies ManagerDevSkillsApiError);
  if (Schema.is(DevSkillsError)(error)) {
    const input = [
      'unknown-agent',
      'unsupported',
      'unsupported-platform',
      'unsupported-profile',
      'unsupported-scope',
      'profile-conflict',
      'invalid-selector',
    ].includes(error.code);
    return response(input ? 400 : 409, {
      code: error.code,
      error: error.message,
      recovery: input ? 'select-target' : 'preview',
      retryAfterMilliseconds: 0,
    } satisfies ManagerDevSkillsApiError);
  }
  return response(500, {
    code: 'workflow-operation-failed',
    error: 'The workflow operation could not complete. Refresh status before retrying.',
    recovery: 'retry',
    retryAfterMilliseconds: 0,
  } satisfies ManagerDevSkillsApiError);
}

/** Registered only behind the existing Manager authentication dispatcher. */
export const handleManagerDevSkillsRequest = Effect.fn('managerDevSkills.handleRequest')(function* (
  request: ManagerDevSkillsRequest,
) {
  if (!Effect2.pipe(request.url.pathname, EffectString.startsWith('/api/dev-skills/'))) return undefined;
  return yield* Effect.gen(function* () {
    const {url, config, method} = request;
    if (method === 'GET' && url.pathname === routes.status) {
      const selector = yield* validate(() => queryInput(url));
      const selected = selector ? yield* admitSelector(config, selector, true) : undefined;
      return response(200, (yield* statusDevSkills(config, selected)) satisfies ManagerDevSkillsStatus);
    }
    if (url.search) return yield* invalid('This workflow route does not accept query parameters.');
    if (method === 'GET' && url.pathname === routes.projects)
      return response(200, yield* readManagerDevSkillsProjects(config));
    if (method === 'GET' && url.pathname === routes.catalog) {
      const system = yield* SystemInfo;
      return response(200, {
        ...(yield* listDevSkills(config)),
        platform: system.platform,
      } satisfies ManagerDevSkillsCatalog);
    }
    if (method !== 'POST' || (url.pathname !== routes.preview && url.pathname !== routes.apply))
      return response(404, {error: 'Not found'});
    const body = yield* request.body.pipe(Effect.mapError(() => invalid('Provide a JSON object request body.')));
    const input = yield* validate(() => mutationInput(body, url.pathname === routes.apply));
    const selector = yield* admitSelector(config, input.selector);
    const manual = {reinstallMissingStore: input.action === 'install'};
    if (url.pathname === routes.preview)
      return response(
        200,
        (yield* previewDevSkills(config, input.action, selector, manual)) satisfies ManagerDevSkillsPlan,
      );
    const result = yield* applyDevSkills(config, input.action, selector, {
      ...manual,
      expectedDigest: input.previewDigest!,
    });
    const status = yield* statusDevSkills(config, selector);
    return response(200, {result, status} satisfies ManagerDevSkillsApplyResponse);
  }).pipe(Effect.catchCause(cause => Effect.succeed(errorResponse(Cause.squash(cause)))));
});
