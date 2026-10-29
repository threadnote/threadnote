import {Array as EffectArray} from 'effect';
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
import {decode, fail, hash, isRecord, readOptional, requireValue, stableJson} from './files.js';
import {consumerId, enrollmentContext, parseRuntimeIndex, parseTarget, type Enrollment} from './registry.js';
import {parseHistoricalDevSkillsManifest, parseNativeRequirements} from './manifest.js';
import * as EffectRecord from 'effect/Record';

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
    isRecord(value) && EffectArray.every(EffectRecord.keys(value), key => allowed.includes(key)),
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
    const validNumbers = EffectArray.isArray(input)
      ? EffectArray.filter(
          input,
          (item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0,
        )
      : [];
    requireValue(
      EffectArray.isArray(input) &&
        input.length <= 32 &&
        validNumbers.length === input.length &&
        new Set(validNumbers).size === validNumbers.length,
      'Invalid candidate capability set.',
    );
    return [...validNumbers];
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
  requireValue(EffectArray.isArray(value) && value.length <= 2048, 'Invalid refresh diagnostics.');
  return EffectArray.map(value, issue => {
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
    if (!isRecord(issue) || typeof issue.code !== 'string' || typeof issue.message !== 'string') {
      throw fail('invalid-state', 'Invalid refresh issue.');
    }
    return {
      code: issue.code,
      message: issue.message,
      ...(typeof issue.path === 'string' ? {path: issue.path} : {}),
    };
  });
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
      EffectArray.every(target.discoveryRoots, root => path.resolve(root) === root),
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
      EffectArray.isArray(value.members) &&
      value.members.length <= 1024 &&
      EffectArray.isArray(value.affected) &&
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
  const release: DevSkillsReleaseIdentity = {
    installationRoot: value.release.installationRoot,
    releaseRoot: value.release.releaseRoot,
    releaseVersion: value.release.releaseVersion,
    bundleDigest: value.release.bundleDigest,
  };
  const capabilities = parseCapabilities(value.capabilities);
  const desired = parseHistoricalDevSkillsManifest(value.desired);
  requireValue(
    capabilities.runtimeVersion === release.releaseVersion &&
      desired.releaseVersion === release.releaseVersion &&
      desired.digest === release.bundleDigest &&
      (value.runtimeHash === null || digest(value.runtimeHash)),
    'Refresh desired release differs.',
  );
  const members: RefreshMember[] = EffectArray.map(value.members, item => {
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
        EffectArray.isArray(item.retained) &&
        item.retained.length <= 1024 &&
        EffectArray.every([item.receiptHash, item.homeHash, item.observedHash], hash => hash === null || digest(hash)),
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
      retained: EffectArray.map(item.retained, parseInstalled),
      ...(item.installed ? {installed: parseInstalled(item.installed)} : {}),
      receiptHash: nullableDigest(item.receiptHash),
      homeHash: nullableDigest(item.homeHash),
      observedHash: nullableDigest(item.observedHash),
      issues: issues(item.issues),
    };
  });
  const affected = EffectArray.map(value.affected, item => parsePinned(item, path));
  const ids = [...EffectArray.map(members, member => member.consumerId), ...EffectArray.map(affected, consumerId)];
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
  const allowed = new Set([
    ...EffectArray.map(request.members, member => member.consumerId),
    ...EffectArray.map(request.affected, consumerId),
  ]);
  const outcomes: Record<string, DevSkillsRefreshOutcome> = {};
  for (const [id, outcome] of EffectRecord.toEntries(value.outcomes)) {
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
    const outcomeState = refreshOutcomeState(outcome.state);
    const attemptedAt = validTimestamp(outcome.attemptedAt);
    const completedAt = outcome.completedAt === undefined ? undefined : validTimestamp(outcome.completedAt);
    outcomes[id] = {
      intentId: requiredString(outcome.intentId),
      requestedReleaseVersion: requiredString(outcome.requestedReleaseVersion),
      requestedBundleDigest: requiredString(outcome.requestedBundleDigest),
      state: outcomeState,
      attemptedAt,
      ...(completedAt === undefined ? {} : {completedAt}),
      issues: issues(outcome.issues),
    };
  }
  const batchIssues = value.issues === undefined ? undefined : issues(value.issues);
  requireValue(
    !batchIssues ||
      (batchIssues.length <= 1 &&
        EffectArray.every(
          batchIssues,
          issue => issue.code === 'enrollment-drift' && issue.message.length <= 512 && issue.path === undefined,
        )),
    'Invalid refresh batch diagnostics.',
  );
  return {schemaVersion: 1, intentId: value.intentId, request, outcomes, ...(batchIssues ? {issues: batchIssues} : {})};
}
function nullableDigest(value: unknown): string | null {
  if (value === null) return null;
  if (!digest(value)) throw fail('invalid-state', 'Invalid refresh hash.');
  return value;
}
function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw fail('invalid-state', 'Invalid refresh string.');
  return value;
}
function validTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw fail('invalid-state', 'Invalid refresh timestamp.');
  return value;
}
function refreshOutcomeState(value: unknown): DevSkillsRefreshOutcome['state'] {
  if (value === 'current' || value === 'pending' || value === 'skipped') return value;
  throw fail('invalid-state', 'Invalid refresh outcome state.');
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
    ...EffectArray.map(state.request.members, member => ({id: member.consumerId, target: member.enrollment.target})),
    ...EffectArray.map(state.request.affected, consumer => ({id: consumerId(consumer), target: consumer.target})),
  ];
  const targets = EffectArray.map(all, ({id, target}) => ({
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
      Boolean(override) ||
      Boolean(state.issues?.length) ||
      EffectArray.some(targets, target => target.outcome.state === 'pending'),
  };
};
export const readDevSkillsRefresh = Effect.fn('devSkills.readRefresh')(function* (config: RuntimeConfig) {
  const context = yield* enrollmentContext(config);
  const read = yield* readRefreshStateAt(context.root);
  return read.state ? refreshResult(read.state) : undefined;
});
