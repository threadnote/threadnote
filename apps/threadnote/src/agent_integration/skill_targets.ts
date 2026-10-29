import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Effect, Path, Schema} from 'effect';
import {AGENT_CATALOG, findAgentSurface, type AgentCatalogEntry} from '@threadnote/integrations/catalog';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {DevSkillsError, type DevSkillsSelector, type DevSkillsTarget} from '../dev_skills/contract.js';
import {getAgentAdapter} from './adapters.js';
import {resolveAgentHostPaths} from './host_paths.js';
import {resolveJsonAgentSkillPaths} from './surface_plan.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const failure = (code: string, message: string) => DevSkillsError.make({code, message});
const selectorError = (error: unknown) =>
  Schema.is(DevSkillsError)(error) ? error : failure('invalid-selector', 'The workflow target selector is invalid.');
const profiles = ['desktop', 'codex-cloud-personal', 'cursor-cloud-personal'] as const;

const selectedEntry = (selector: DevSkillsSelector) => {
  const entry = findAgentSurface(selector.agent);
  if (!entry) throw failure('unknown-agent', `Unknown agent ${selector.agent}; list development skill targets first.`);
  if (selector.profile !== undefined && !profiles.includes(selector.profile))
    throw failure('unsupported-profile', 'Only desktop and personal Codex/Cursor development workflows are supported.');
  if (entry.devSkills.status === 'unsupported') throw failure('unsupported', `${entry.id}: ${entry.devSkills.reason}`);
  const profile = selector.profile ?? entry.devSkills.profile;
  if (profile === entry.devSkills.profile) return entry;
  // A desktop family alias may select its declared personal profile; an explicit
  // cloud surface cannot silently downgrade or switch to another provider.
  const personal =
    entry.devSkills.profile === 'desktop' && profile !== 'desktop'
      ? EffectOption.getOrUndefined(
          EffectArray.findFirst(
            AGENT_CATALOG,
            candidate =>
              candidate.agentId === entry.agentId &&
              candidate.devSkills.status === 'managed' &&
              candidate.devSkills.profile === profile,
          ),
        )
      : undefined;
  if (!personal) throw failure('profile-conflict', `${entry.id} does not declare the selected workflow profile.`);
  return personal;
};

/** Resolve selectors for enrollment lookup without consulting environment roots. */
export const resolveDevSkillsIdentity = Effect.fn('devSkills.resolveIdentity')(function* (selector: DevSkillsSelector) {
  const entry = yield* Effect.try({try: () => selectedEntry(selector), catch: selectorError});
  const capability = entry.devSkills;
  if (capability.status !== 'managed') return yield* failure('unsupported', capability.reason);
  return {surfaceId: entry.id, agentId: entry.agentId, profile: capability.profile};
});

/** Pure capability projection; installation/readiness state is supplied separately. */
export function listDevSkillsTargets() {
  return EffectArray.map(AGENT_CATALOG, entry => ({
    surfaceId: entry.id,
    agentId: entry.agentId,
    displayName: entry.displayName,
    aliases: [...entry.aliases],
    ...(entry.devSkills.status === 'managed'
      ? {
          status: 'managed' as const,
          profile: entry.devSkills.profile,
          scopes: [...entry.devSkills.scopes],
          ...(entry.devSkills.scopeReason ? {scopeReason: entry.devSkills.scopeReason} : {}),
          defaultScope: entry.devSkills.defaultScope,
          platforms: [...entry.devSkills.platforms],
          layout: entry.devSkills.layout,
        }
      : {status: 'unsupported' as const, reason: entry.devSkills.reason}),
  }));
}

/** Bounded predecessor namespaces; callers inspect recognized skill/pack layouts only. */
export const legacyDevSkillsDiscoveryRoots = Effect.fn('devSkills.legacyDiscoveryRoots')(function* (
  target: DevSkillsTarget,
) {
  const path = yield* Path.Path;
  return [
    ...new Set(
      EffectArray.flatMap(target.discoveryRoots, root => [
        path.join(root, 'threadnote'),
        path.join(root, 'threadnote-packs'),
      ]),
    ),
  ];
});

const checkedEntry = (selector: DevSkillsSelector) =>
  Effect.try({try: () => selectedEntry(selector), catch: selectorError});

/** Catalog-only target resolution: no filesystem writes/reads, MCP parsing, or bootstrap. */
export const resolveDevSkillsTarget = Effect.fn('devSkills.resolveTarget')(function* (
  _config: RuntimeConfig,
  selector: DevSkillsSelector,
  recorded?: DevSkillsTarget,
) {
  const entry: AgentCatalogEntry = yield* checkedEntry(selector);
  const capability = entry.devSkills;
  if (capability.status !== 'managed') return yield* failure('unsupported', capability.reason);
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const mode = Effect2.pipe(environment.THREADNOTE_CURSOR_CLOUD_MODE, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (
    (mode && mode !== 'personal') ||
    environment.THREADNOTE_CURSOR_MEMORY_ENDPOINT ||
    environment.THREADNOTE_CURSOR_MEMORY_SHARE_ID ||
    ['cursor-cloud-local', 'org', 'remote-hybrid'].includes(environment.THREADNOTE_MCP_TOOLSET ?? '')
  )
    return yield* failure('unsupported-profile', 'Corporate and remote-hybrid workflow targets are unsupported.');
  if (!EffectArray.some(capability.platforms, platform => platform === system.platform))
    return yield* failure('unsupported-platform', `${entry.id} has no native workflow target on ${system.platform}.`);
  const scope = selector.scope ?? recorded?.scope ?? capability.defaultScope;
  if (!capability.scopes.includes(scope))
    return yield* failure(
      'unsupported-scope',
      `${entry.id} declares native workflow scopes ${EffectArray.join(capability.scopes, ', ')}; ${scope} is unsupported. ${capability.scopeReason ?? ''}`,
    );
  if (recorded) {
    if (
      recorded.surfaceId !== entry.id ||
      recorded.agentId !== entry.agentId ||
      recorded.profile !== capability.profile ||
      recorded.scope !== scope ||
      recorded.layout !== capability.layout
    )
      return yield* failure(
        'target-conflict',
        'The recorded workflow target belongs to another selector or adapter layout.',
      );
    const requestedCwd = scope === 'user' || selector.cwd === undefined ? undefined : path.resolve(selector.cwd);
    if (
      (scope === 'user' && recorded.cwd !== undefined) ||
      (scope !== 'user' && (!recorded.cwd || !path.isAbsolute(recorded.cwd))) ||
      (requestedCwd !== undefined && (!recorded.cwd || path.relative(recorded.cwd, requestedCwd) !== '')) ||
      !path.isAbsolute(recorded.skillRoot) ||
      path.dirname(recorded.skillRoot) === recorded.skillRoot ||
      !recorded.discoveryRoots.includes(recorded.skillRoot) ||
      !EffectArray.every(recorded.discoveryRoots, root => path.isAbsolute(root))
    )
      return yield* failure(
        'target-conflict',
        'The recorded workflow root/scope is invalid or belongs to another repository.',
      );
    return {...recorded, discoveryRoots: [...recorded.discoveryRoots]};
  }
  let skillRoot: string;
  let cwd: string | undefined;
  let discoveryRoots: string[];
  if (capability.root.kind === 'json-strategy') {
    const adapter = getAgentAdapter(entry.id);
    if (!adapter?.json || adapter.json.skillRoot === 'none')
      return yield* failure('unsupported', `${entry.id} has no declared executable native skill strategy.`);
    const roots = yield* resolveJsonAgentSkillPaths(adapter.json, scope, selector).pipe(
      Effect.mapError(error => failure('invalid-host-root', error.message)),
    );
    skillRoot = roots.skillRoot;
    cwd = roots.cwd;
    discoveryRoots = [skillRoot];
  } else if (capability.root.kind === 'omp-profile') {
    const profile = environment.OMP_PROFILE ?? environment.PI_PROFILE;
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native optional-chain guard narrows `profile` for the following validation.
    if (profile?.trim() && (!/^[A-Za-z0-9_.-]+$/u.test(profile.trim()) || ['.', '..'].includes(profile.trim())))
      return yield* failure('invalid-host-root', 'OMP_PROFILE/PI_PROFILE must be one profile name.');
    const configured = Effect2.pipe(environment.PI_CODING_AGENT_DIR, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    if (
      !Effect2.pipe(profile, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) &&
      configured &&
      !path.isAbsolute(configured) &&
      !Effect2.pipe(configured, EffectString.startsWith('~/'))
    )
      return yield* failure('invalid-host-root', 'PI_CODING_AGENT_DIR must be absolute or home-relative.');
    skillRoot = (yield* resolveAgentHostPaths('omp'))!.skillRoot;
    discoveryRoots = [skillRoot];
  } else {
    skillRoot = path.join(system.homeDirectory, ...Effect2.pipe(capability.root.path, EffectString.split('/')));
    discoveryRoots = EffectArray.map(capability.root.discoveryPaths, root =>
      path.join(system.homeDirectory, ...Effect2.pipe(root, EffectString.split('/'))),
    );
  }
  if (!path.isAbsolute(skillRoot) || !EffectArray.every(discoveryRoots, root => path.isAbsolute(root)))
    return yield* failure('invalid-host-root', 'Native skill roots must be absolute.');
  return {
    surfaceId: entry.id,
    agentId: entry.agentId,
    profile: capability.profile,
    scope,
    ...(cwd === undefined ? {} : {cwd}),
    skillRoot,
    layout: capability.layout,
    discoveryRoots: [...new Set(discoveryRoots)],
  } satisfies DevSkillsTarget;
});
