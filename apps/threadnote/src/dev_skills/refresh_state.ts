import {Effect, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {
  DevSkillsConsumer,
  DevSkillsInstalled,
  DevSkillsIssue,
  DevSkillsManifest,
  DevSkillsRefreshOutcome,
  DevSkillsRefreshResult,
  DevSkillsReleaseIdentity,
  DevSkillsRuntimeCapabilities,
} from './contract.js';
import {decode, hash, isRecord, readOptional, requireValue, stableJson} from './files.js';
import {consumerId, enrollmentContext, parseRuntimeIndex, parseTarget, type Enrollment} from './registry.js';
import {parseDevSkillsManifest, parseNativeRequirements} from './manifest.js';

export interface RefreshMember {
  readonly consumerId: string;
  readonly enrollment: Enrollment;
  readonly retained: readonly DevSkillsInstalled[];
  readonly installed?: DevSkillsInstalled;
  readonly receiptHash: string | null;
  readonly homeHash: string | null;
  readonly observedHash: string | null;
  readonly issues: readonly DevSkillsIssue[];
}
export interface RefreshRequest {
  readonly schemaVersion: 1;
  readonly release: DevSkillsReleaseIdentity;
  readonly capabilities: DevSkillsRuntimeCapabilities;
  readonly desired: DevSkillsManifest;
  readonly runtimeHash: string | null;
  readonly members: readonly RefreshMember[];
  readonly affected: readonly DevSkillsConsumer[];
}
export interface RefreshState {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly request: RefreshRequest;
  readonly outcomes: Readonly<Record<string, DevSkillsRefreshOutcome>>;
  readonly issues?: readonly DevSkillsIssue[];
}
export const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const version = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
export function keys(value: unknown, allowed: readonly string[]) {
  requireValue(
    isRecord(value) && Object.keys(value).every(key => allowed.includes(key)),
    'Unknown refresh protocol fields.',
  );
}
export function parseCapabilities(value: unknown): DevSkillsRuntimeCapabilities {
  requireValue(
    isRecord(value) && (value.schemaVersion === 1 || value.schemaVersion === 2) && version(value.runtimeVersion),
    'Invalid candidate runtime capabilities.',
  );
  keys(value, [
    'schemaVersion',
    'runtimeVersion',
    'workflowProtocols',
    'stateSchemas',
    'enrollmentSchemas',
    ...(value.schemaVersion === 2 ? ['manifestSchemas', 'nativeFeatures'] : []),
  ]);
  const numbers = (input: unknown): number[] => {
    requireValue(
      Array.isArray(input) &&
        input.length <= 32 &&
        new Set(input).size === input.length &&
        input.every((item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0),
      'Invalid candidate capability set.',
    );
    return input;
  };
  const common = {
    runtimeVersion: value.runtimeVersion,
    workflowProtocols: numbers(value.workflowProtocols),
    stateSchemas: numbers(value.stateSchemas),
    enrollmentSchemas: numbers(value.enrollmentSchemas),
  };
  return value.schemaVersion === 1
    ? {schemaVersion: 1, ...common}
    : {
        schemaVersion: 2,
        ...common,
        manifestSchemas: numbers(value.manifestSchemas),
        nativeFeatures: parseNativeRequirements(value.nativeFeatures),
      };
}

function issues(value: unknown): readonly DevSkillsIssue[] {
  requireValue(Array.isArray(value) && value.length <= 2048, 'Invalid refresh diagnostics.');
  for (const issue of value) {
    keys(issue, ['code', 'message', 'path']);
    requireValue(
      isRecord(issue) &&
        typeof issue.code === 'string' &&
        issue.code.length <= 128 &&
        typeof issue.message === 'string' &&
        issue.message.length <= 4000 &&
        (issue.path === undefined || typeof issue.path === 'string'),
      'Invalid refresh issue.',
    );
  }
  return value as DevSkillsIssue[];
}
export function parseInstalled(value: unknown): DevSkillsInstalled {
  keys(value, [
    'releaseVersion',
    'digest',
    'workflowProtocol',
    'stateSchema',
    'minimumRuntime',
    'manifestSchema',
    'nativeRequirements',
  ]);
  requireValue(
    isRecord(value) &&
      version(value.releaseVersion) &&
      version(value.minimumRuntime) &&
      digest(value.digest) &&
      Number.isSafeInteger(value.workflowProtocol) &&
      Number.isSafeInteger(value.stateSchema),
    'Invalid retained workflow requirements.',
  );
  requireValue(
    typeof value.workflowProtocol === 'number' && typeof value.stateSchema === 'number',
    'Invalid retained workflow versions.',
  );
  requireValue(
    (value.manifestSchema === undefined && value.nativeRequirements === undefined) || value.manifestSchema === 2,
    'Invalid retained manifest schema.',
  );
  return {
    releaseVersion: value.releaseVersion,
    digest: value.digest,
    minimumRuntime: value.minimumRuntime,
    workflowProtocol: value.workflowProtocol,
    stateSchema: value.stateSchema,
    ...(value.manifestSchema === 2
      ? {manifestSchema: 2, nativeRequirements: parseNativeRequirements(value.nativeRequirements)}
      : {}),
  };
}
function parsePinned(value: unknown, path: Path.Path): DevSkillsConsumer {
  keys(value, ['home', 'installationRoot', 'target', 'state', 'enabled', 'createdBy']);
  requireValue(
    isRecord(value) &&
      typeof value.home === 'string' &&
      path.resolve(value.home) === value.home &&
      typeof value.installationRoot === 'string' &&
      path.resolve(value.installationRoot) === value.installationRoot,
    'Invalid refresh consumer.',
  );
  keys(value.target, ['surfaceId', 'agentId', 'profile', 'scope', 'cwd', 'skillRoot', 'layout', 'discoveryRoots']);
  const target = parseTarget(value.target);
  requireValue(
    path.resolve(target.skillRoot) === target.skillRoot &&
      target.discoveryRoots.every(root => path.resolve(root) === root),
    'Noncanonical refresh target.',
  );
  return {home: value.home, installationRoot: value.installationRoot, target};
}
function parseRequest(value: unknown, root: string, path: Path.Path): RefreshRequest {
  keys(value, ['schemaVersion', 'release', 'capabilities', 'desired', 'runtimeHash', 'members', 'affected']);
  requireValue(
    isRecord(value) &&
      value.schemaVersion === 1 &&
      isRecord(value.release) &&
      Array.isArray(value.members) &&
      value.members.length <= 1024 &&
      Array.isArray(value.affected) &&
      value.affected.length <= 1024,
    'Invalid refresh request.',
  );
  keys(value.release, ['installationRoot', 'releaseRoot', 'releaseVersion', 'bundleDigest']);
  requireValue(
    value.release.installationRoot === root &&
      version(value.release.releaseVersion) &&
      value.release.releaseRoot === path.join(root, 'versions', value.release.releaseVersion) &&
      digest(value.release.bundleDigest),
    'Invalid final release identity.',
  );
  const release = value.release as unknown as DevSkillsReleaseIdentity;
  const capabilities = parseCapabilities(value.capabilities);
  const desired = parseDevSkillsManifest(value.desired);
  requireValue(
    capabilities.runtimeVersion === release.releaseVersion &&
      desired.releaseVersion === release.releaseVersion &&
      desired.digest === release.bundleDigest &&
      (value.runtimeHash === null || digest(value.runtimeHash)),
    'Refresh desired release differs.',
  );
  const members: RefreshMember[] = value.members.map(item => {
    keys(item, [
      'consumerId',
      'enrollment',
      'retained',
      'installed',
      'receiptHash',
      'homeHash',
      'observedHash',
      'issues',
    ]);
    requireValue(
      isRecord(item) &&
        digest(item.consumerId) &&
        Array.isArray(item.retained) &&
        item.retained.length <= 1024 &&
        [item.receiptHash, item.homeHash, item.observedHash].every(hash => hash === null || digest(hash)),
      'Invalid refresh member.',
    );
    const consumer = parsePinned(item.enrollment, path);
    requireValue(
      consumer.installationRoot === root && item.consumerId === consumerId(consumer),
      'Refresh member identity differs.',
    );
    const enrollment = parseRuntimeIndex({
      schemaVersion: 2,
      installationRoot: root,
      enrollments: {[item.consumerId]: item.enrollment},
    }).enrollments[item.consumerId];
    return {
      consumerId: item.consumerId,
      enrollment,
      retained: item.retained.map(parseInstalled),
      ...(item.installed ? {installed: parseInstalled(item.installed)} : {}),
      receiptHash: item.receiptHash as string | null,
      homeHash: item.homeHash as string | null,
      observedHash: item.observedHash as string | null,
      issues: issues(item.issues),
    };
  });
  const affected = value.affected.map(item => parsePinned(item, path));
  const ids = [...members.map(member => member.consumerId), ...affected.map(consumerId)];
  requireValue(new Set(ids).size === ids.length, 'Duplicate refresh consumer.');
  return {
    schemaVersion: 1,
    release,
    capabilities,
    desired,
    runtimeHash: value.runtimeHash,
    members,
    affected,
  };
}
export function parseRefreshState(value: unknown, root: string, path: Path.Path): RefreshState {
  keys(value, ['schemaVersion', 'intentId', 'request', 'outcomes', 'issues']);
  requireValue(
    isRecord(value) && value.schemaVersion === 1 && digest(value.intentId) && isRecord(value.outcomes),
    'Invalid refresh state.',
  );
  const request = parseRequest(value.request, root, path);
  requireValue(value.intentId === hash(stableJson(request)), 'Refresh immutable request fingerprint differs.');
  const allowed = new Set([...request.members.map(member => member.consumerId), ...request.affected.map(consumerId)]);
  const outcomes: Record<string, DevSkillsRefreshOutcome> = {};
  for (const [id, outcome] of Object.entries(value.outcomes)) {
    keys(outcome, [
      'intentId',
      'requestedReleaseVersion',
      'requestedBundleDigest',
      'state',
      'attemptedAt',
      'completedAt',
      'issues',
    ]);
    requireValue(
      allowed.has(id) &&
        isRecord(outcome) &&
        outcome.intentId === value.intentId &&
        outcome.requestedReleaseVersion === request.release.releaseVersion &&
        outcome.requestedBundleDigest === request.release.bundleDigest &&
        ['current', 'pending', 'skipped'].includes(String(outcome.state)) &&
        typeof outcome.attemptedAt === 'string' &&
        Number.isFinite(Date.parse(outcome.attemptedAt)) &&
        (outcome.state === 'pending'
          ? outcome.completedAt === undefined
          : typeof outcome.completedAt === 'string' && Number.isFinite(Date.parse(outcome.completedAt))),
      'Invalid refresh outcome.',
    );
    outcomes[id] = {...outcome, issues: issues(outcome.issues)} as unknown as DevSkillsRefreshOutcome;
  }
  const batchIssues = value.issues === undefined ? undefined : issues(value.issues);
  requireValue(
    !batchIssues ||
      (batchIssues.length <= 1 &&
        batchIssues.every(
          issue => issue.code === 'enrollment-drift' && issue.message.length <= 512 && issue.path === undefined,
        )),
    'Invalid refresh batch diagnostics.',
  );
  return {schemaVersion: 1, intentId: value.intentId, request, outcomes, ...(batchIssues ? {issues: batchIssues} : {})};
}
export const refreshStatePath = (path: Path.Path, root: string) => path.join(root, 'dev-skills-refresh.json');
export const readRefreshStateAt = Effect.fn('devSkills.readRefreshState')(function* (root: string) {
  const path = yield* Path.Path;
  const content = yield* readOptional(refreshStatePath(path, root));
  const state = content === null ? undefined : yield* decode(content, value => parseRefreshState(value, root, path));
  return {content, state};
});
export const refreshResult = (state: RefreshState, override?: readonly DevSkillsIssue[]): DevSkillsRefreshResult => {
  const all = [
    ...state.request.members.map(member => ({id: member.consumerId, target: member.enrollment.target})),
    ...state.request.affected.map(consumer => ({id: consumerId(consumer), target: consumer.target})),
  ];
  const targets = all.map(({id, target}) => ({
    consumerId: id,
    target,
    outcome: override
      ? {
          intentId: state.intentId,
          requestedReleaseVersion: state.request.release.releaseVersion,
          requestedBundleDigest: state.request.release.bundleDigest,
          state: 'pending' as const,
          attemptedAt: new Date().toISOString(),
          issues: override,
        }
      : (state.outcomes[id] ?? {
          intentId: state.intentId,
          requestedReleaseVersion: state.request.release.releaseVersion,
          requestedBundleDigest: state.request.release.bundleDigest,
          state: 'pending' as const,
          attemptedAt: new Date().toISOString(),
          issues: [{code: 'refresh-pending', message: 'Refresh has not yet verified this target.'}],
        }),
  }));
  return {
    schemaVersion: 1,
    intentId: state.intentId,
    release: state.request.release,
    targets,
    ...(state.issues?.length ? {issues: state.issues} : {}),
    repairRequired:
      Boolean(override) || Boolean(state.issues?.length) || targets.some(target => target.outcome.state === 'pending'),
  };
};
export const readDevSkillsRefresh = Effect.fn('devSkills.readRefresh')(function* (config: RuntimeConfig) {
  const context = yield* enrollmentContext(config);
  const read = yield* readRefreshStateAt(context.root);
  return read.state ? refreshResult(read.state) : undefined;
});
