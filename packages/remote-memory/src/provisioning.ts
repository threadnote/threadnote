import {Array as EffectArray} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RemoteMemoryFeatureFlag, RemoteMemoryScope} from './authorization.js';
import {remoteMemoryError} from './errors.js';
import {
  remoteMemoryProvisioningPolicy,
  remoteMemoryProvisioningSharePolicy,
  validateRemoteMemoryProvisioningInput,
  type RemoteMemoryProvisioningInput,
} from './postgres/control_plane.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

export const REMOTE_MEMORY_PROVISIONING_PLAN_VERSION = 1 as const;

export interface RemoteMemoryProvisioningRequestV1 extends Omit<
  RemoteMemoryProvisioningInput,
  'capabilities' | 'clientId' | 'expectedCurrentPolicyVersion' | 'expectedCurrentSharePolicyVersion'
> {
  readonly capabilities?: readonly RemoteMemoryScope[];
  readonly clientId: string;
}

export type RemoteMemoryProvisioningPlanInputV1 = RemoteMemoryProvisioningInput & {readonly clientId: string};

export interface RemoteMemoryProvisioningStateV1 {
  readonly grant?: {
    readonly expiresAt?: string;
    readonly policyDigest: string;
    readonly policyVersion: string;
    readonly status: 'active' | 'revoked';
  };
  readonly identityPrincipalId?: string;
  readonly membershipStatus?: 'active' | 'revoked';
  readonly principalStatus?: 'active' | 'disabled';
  readonly share?: {
    readonly featureFlags: readonly RemoteMemoryFeatureFlag[];
    readonly policyDigest: string;
    readonly policyVersion: string;
    readonly status: 'active' | 'deleted' | 'revoked';
  };
  readonly tenant?: {
    readonly region: string;
    readonly status: 'active' | 'deleted' | 'disabled';
  };
  readonly version: typeof REMOTE_MEMORY_PROVISIONING_PLAN_VERSION;
}

export interface RemoteMemoryProvisioningPlanV1 {
  readonly action: 'create_grant' | 'create_share_and_grant' | 'replace_grant' | 'unchanged' | 'update_control_plane';
  readonly changes: readonly RemoteMemoryProvisioningChangeV1[];
  readonly dryRun: boolean;
  readonly input: RemoteMemoryProvisioningPlanInputV1;
  readonly observed: RemoteMemoryProvisioningStateV1;
  readonly planDigest: string;
  readonly planId: string;
  readonly plannedAt: string;
  readonly version: typeof REMOTE_MEMORY_PROVISIONING_PLAN_VERSION;
}

export interface RemoteMemoryProvisioningReceiptV1 {
  readonly action: RemoteMemoryProvisioningPlanV1['action'];
  readonly bindingDigest: string;
  readonly capabilities: readonly RemoteMemoryScope[];
  readonly cloudAdmissionRequired: boolean;
  readonly changes: readonly RemoteMemoryProvisioningChangeV1[];
  readonly planDigest: string;
  readonly planId: string;
  readonly policyVersion: string;
  readonly principalId: string;
  readonly shareId: string;
  readonly status: 'ready';
  readonly tenantId: string;
  readonly version: typeof REMOTE_MEMORY_PROVISIONING_PLAN_VERSION;
}

export type RemoteMemoryProvisioningChangeV1 =
  | 'create_grant'
  | 'create_identity'
  | 'create_membership'
  | 'create_principal'
  | 'create_share'
  | 'create_tenant'
  | 'replace_grant'
  | 'replace_share_policy';

export function normalizeRemoteMemoryProvisioningRequest(
  request: RemoteMemoryProvisioningRequestV1,
): RemoteMemoryProvisioningPlanInputV1 {
  const requestInput = {...request};
  Reflect.deleteProperty(requestInput, 'expectedCurrentPolicyVersion');
  Reflect.deleteProperty(requestInput, 'expectedCurrentSharePolicyVersion');
  const capabilities = sortedUnique(request.capabilities ?? ['memory:read']);
  const writes = EffectArray.some(capabilities, capability => capability !== 'memory:read');
  const requiredFeatureFlags = pilotFeatureFlags(capabilities);
  const featureFlags = request.featureFlags === undefined ? undefined : sortedUnique(request.featureFlags);
  if (featureFlags && EffectArray.some(requiredFeatureFlags, feature => !featureFlags.includes(feature))) {
    throw remoteMemoryError('invalid_request', 'Pilot share feature flags do not enable every requested capability.');
  }
  const input: RemoteMemoryProvisioningPlanInputV1 = {
    ...definedEntries(requestInput),
    capabilities,
    clientId: request.clientId,
    cursorAttestationRequired: request.cursorAttestationRequired ?? writes,
    ...(featureFlags === undefined ? {} : {featureFlags}),
  };
  validateRemoteMemoryProvisioningInput(input);
  return input;
}

export function planRemoteMemoryProvisioning(input: {
  readonly apply: boolean;
  readonly plannedAt: string;
  readonly request: RemoteMemoryProvisioningRequestV1;
  readonly state: RemoteMemoryProvisioningStateV1;
}): RemoteMemoryProvisioningPlanV1 {
  const plannedAt = exactIsoTimestamp(input.plannedAt, 'Provisioning plan time is invalid.');
  const normalizedRequest = normalizeRemoteMemoryProvisioningRequest(input.request);
  const normalized: RemoteMemoryProvisioningPlanInputV1 =
    input.state.share || normalizedRequest.featureFlags
      ? normalizedRequest
      : {...normalizedRequest, featureFlags: pilotFeatureFlags(normalizedRequest.capabilities)};
  assertPilotGrant(normalized, plannedAt, input.state);
  assertObservedState(normalized, input.state);
  const plannedInput: RemoteMemoryProvisioningPlanInputV1 = {
    ...normalized,
    ...(input.state.grant ? {expectedCurrentPolicyVersion: input.state.grant.policyVersion} : {}),
    ...(input.state.share ? {expectedCurrentSharePolicyVersion: input.state.share.policyVersion} : {}),
  };
  const changes = provisioningChanges(plannedInput, input.state);
  const action = provisioningAction(changes);
  const unsigned = {
    action,
    changes,
    dryRun: !input.apply,
    input: canonicalInput(plannedInput),
    observed: input.state,
    plannedAt,
    version: REMOTE_MEMORY_PROVISIONING_PLAN_VERSION,
  } as const;
  const identity = {
    input: unsigned.input,
    observed: unsigned.observed,
    plannedAt,
    version: REMOTE_MEMORY_PROVISIONING_PLAN_VERSION,
  } as const;
  return {
    ...unsigned,
    planDigest: sha256HexSync(canonicalJson(unsigned)),
    planId: `tnpp_${Effect.pipe(sha256HexSync(canonicalJson(identity)), EffectString.slice(0, 32))}`,
  };
}

export function verifyRemoteMemoryProvisioningPlan(plan: RemoteMemoryProvisioningPlanV1): void {
  if (plan.version !== REMOTE_MEMORY_PROVISIONING_PLAN_VERSION || !/^tnpp_[0-9a-f]{32}$/u.test(plan.planId)) {
    throw remoteMemoryError('invalid_request', 'The provisioning plan identity is invalid.');
  }
  const expected = planRemoteMemoryProvisioning({
    apply: !plan.dryRun,
    plannedAt: plan.plannedAt,
    request: plan.input,
    state: plan.observed,
  });
  if (canonicalJson(expected) !== canonicalJson(plan)) {
    throw remoteMemoryError('invalid_request', 'The provisioning plan digest or canonical contents are invalid.');
  }
}

export function provisioningPlanMatchesCurrentState(
  plan: RemoteMemoryProvisioningPlanV1,
  state: RemoteMemoryProvisioningStateV1,
): boolean {
  verifyRemoteMemoryProvisioningPlan(plan);
  try {
    const current = planRemoteMemoryProvisioning({
      apply: true,
      plannedAt: plan.plannedAt,
      request: plan.input,
      state,
    });
    return current.planId === plan.planId && current.planDigest === plan.planDigest;
  } catch {
    return false;
  }
}

export function remoteMemoryProvisioningReceipt(
  plan: RemoteMemoryProvisioningPlanV1,
): RemoteMemoryProvisioningReceiptV1 {
  verifyRemoteMemoryProvisioningPlan(plan);
  return {
    action: plan.action,
    bindingDigest: sha256HexSync(
      canonicalJson({clientId: plan.input.clientId ?? null, issuer: plan.input.issuer, subject: plan.input.subject}),
    ),
    capabilities: sortedUnique(plan.input.capabilities),
    cloudAdmissionRequired: plan.input.cloudAdmissionRequired ?? false,
    changes: plan.changes,
    planDigest: plan.planDigest,
    planId: plan.planId,
    policyVersion: plan.input.policyVersion,
    principalId: plan.input.principalId,
    shareId: plan.input.shareId,
    status: 'ready',
    tenantId: plan.input.tenantId,
    version: REMOTE_MEMORY_PROVISIONING_PLAN_VERSION,
  };
}

function assertPilotGrant(
  input: RemoteMemoryProvisioningInput,
  plannedAt: string,
  state: RemoteMemoryProvisioningStateV1,
): void {
  if (input.capabilities.includes('memory:admin')) {
    throw remoteMemoryError('invalid_request', 'External pilot identities cannot receive memory:admin.');
  }
  const writes = EffectArray.some(input.capabilities, capability => capability !== 'memory:read');
  if (writes && (!input.allowedProjects || input.allowedProjects.length === 0)) {
    throw remoteMemoryError('invalid_request', 'Write-capable pilot grants must name at least one allowed project.');
  }
  if (writes) {
    const grantExpiresAt = input.grantExpiresAt;
    if (grantExpiresAt === undefined) {
      throw remoteMemoryError('invalid_request', 'Write-capable pilot grants require a bounded expiry.');
    }
    const expiry = Date.parse(exactIsoTimestamp(grantExpiresAt, 'Provisioning grant expiry is invalid.'));
    const start = Date.parse(plannedAt);
    if (expiry <= start || expiry - start > 31 * 24 * 60 * 60 * 1000) {
      throw remoteMemoryError('invalid_request', 'Write-capable pilot grants must expire within 31 days.');
    }
  }
  if (!state.share) {
    requireCompletePilotSharePolicy(input, 'Creating a pilot share');
  } else if (input.sharePolicyVersion !== undefined) {
    requireCompletePilotSharePolicy(input, 'Replacing a pilot share policy');
  } else {
    const enabled = new Set(state.share.featureFlags);
    if (EffectArray.some(pilotFeatureFlags(input.capabilities), feature => !enabled.has(feature))) {
      throw remoteMemoryError(
        'conflict',
        'The existing share policy does not enable every requested pilot capability.',
      );
    }
    if (
      input.featureFlags &&
      canonicalJson(sortedUnique(input.featureFlags)) !== canonicalJson(sortedUnique(state.share.featureFlags))
    ) {
      throw remoteMemoryError('conflict', 'Changing pilot feature flags requires a new share policy version.');
    }
  }
}

function assertObservedState(input: RemoteMemoryProvisioningInput, state: RemoteMemoryProvisioningStateV1): void {
  if (state.version !== REMOTE_MEMORY_PROVISIONING_PLAN_VERSION) {
    throw remoteMemoryError('invalid_request', 'The provisioning state version is unsupported.');
  }
  if (state.tenant && (state.tenant.region !== input.region || state.tenant.status !== 'active')) {
    throw remoteMemoryError('conflict', 'The tenant region or lifecycle state differs from provisioning input.');
  }
  if (state.principalStatus !== undefined && state.principalStatus !== 'active') {
    throw remoteMemoryError('conflict', 'The provisioning principal is disabled.');
  }
  if (state.membershipStatus !== undefined && state.membershipStatus !== 'active') {
    throw remoteMemoryError('conflict', 'The pilot membership is suspended or revoked.');
  }
  if (state.identityPrincipalId !== undefined && state.identityPrincipalId !== input.principalId) {
    throw remoteMemoryError('conflict', 'The external identity is already bound to another principal.');
  }
  if (state.share !== undefined && state.share.status !== 'active') {
    throw remoteMemoryError('conflict', 'The memory share lifecycle state does not allow provisioning.');
  }
  if (state.grant !== undefined && state.grant.status !== 'active') {
    throw remoteMemoryError('conflict', 'The existing pilot grant is suspended or revoked.');
  }
}

function provisioningChanges(
  input: RemoteMemoryProvisioningInput,
  state: RemoteMemoryProvisioningStateV1,
): RemoteMemoryProvisioningChangeV1[] {
  const changes: RemoteMemoryProvisioningChangeV1[] = [];
  if (!state.tenant) changes.push('create_tenant');
  if (state.principalStatus === undefined) changes.push('create_principal');
  if (state.identityPrincipalId === undefined) changes.push('create_identity');
  if (state.membershipStatus === undefined) changes.push('create_membership');
  if (!state.share) {
    changes.push('create_share');
  } else if (input.sharePolicyVersion !== undefined) {
    const desired = remoteMemoryProvisioningSharePolicy(input);
    if (input.sharePolicyVersion === state.share.policyVersion) {
      if (desired.digest !== state.share.policyDigest) {
        throw remoteMemoryError('conflict', 'The requested share policy version has different policy content.');
      }
    } else {
      changes.push('replace_share_policy');
    }
  }
  if (!state.grant) {
    changes.push('create_grant');
  } else if (
    state.grant.policyVersion !== input.policyVersion ||
    state.grant.policyDigest !== remoteMemoryProvisioningPolicy(input).digest ||
    (state.grant.expiresAt ?? undefined) !== (input.grantExpiresAt ?? undefined)
  ) {
    changes.push('replace_grant');
  }
  return changes.sort(compareText);
}

function provisioningAction(
  changes: readonly RemoteMemoryProvisioningChangeV1[],
): RemoteMemoryProvisioningPlanV1['action'] {
  if (changes.length === 0) return 'unchanged';
  if (changes.includes('create_share')) return 'create_share_and_grant';
  if (changes.length === 1 && changes[0] === 'create_grant') return 'create_grant';
  if (changes.length === 1 && changes[0] === 'replace_grant') return 'replace_grant';
  return 'update_control_plane';
}

function requireCompletePilotSharePolicy(input: RemoteMemoryProvisioningInput, operation: string): void {
  if (!input.featureFlags || !input.projects || input.projects.length === 0 || input.repositoryBindings === undefined) {
    throw remoteMemoryError(
      'invalid_request',
      `${operation} requires complete feature, project, and repository policy.`,
    );
  }
  const projects = new Set(input.projects);
  if (
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(input.allowedProjects), __effectArrayReceiver =>
        EffectArray.some(__effectArrayReceiver, project => !projects.has(project)),
      ),
    )
  ) {
    throw remoteMemoryError('invalid_request', 'The pilot grant references a project outside the share catalog.');
  }
}

function pilotFeatureFlags(capabilities: readonly RemoteMemoryScope[]): RemoteMemoryFeatureFlag[] {
  const features: RemoteMemoryFeatureFlag[] = ['remote_memory_ga', 'remote_memory_read'];
  if (
    EffectArray.some(capabilities, capability =>
      ['memory:propose:durable', 'memory:review:durable', 'memory:write:durable'].includes(capability),
    )
  ) {
    features.push('remote_memory_durable_write');
  }
  if (capabilities.includes('memory:write:handoff')) features.push('remote_memory_handoff_write');
  return sortedUnique(features);
}

function canonicalInput(input: RemoteMemoryProvisioningPlanInputV1): RemoteMemoryProvisioningPlanInputV1 {
  return definedEntries({
    ...input,
    ...(input.allowedProjects ? {allowedProjects: sortedUnique(input.allowedProjects)} : {}),
    capabilities: sortedUnique(input.capabilities),
    ...(input.cursorOwnerIds ? {cursorOwnerIds: sortedUnique(input.cursorOwnerIds)} : {}),
    ...(input.cursorSubjects ? {cursorSubjects: sortedUnique(input.cursorSubjects)} : {}),
    ...(input.featureFlags ? {featureFlags: sortedUnique(input.featureFlags)} : {}),
    ...(input.projects ? {projects: sortedUnique(input.projects)} : {}),
    ...(input.repositoryBindings
      ? {
          repositoryBindings: EffectRecord.fromEntries(
            EffectArray.map(
              EffectRecord.toEntries(input.repositoryBindings).sort(([left], [right]) => compareText(left, right)),
              ([project, repositories]) => [project, sortedUnique(repositories)],
            ),
          ),
        }
      : {}),
  });
}

function exactIsoTimestamp(value: string, message: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw remoteMemoryError('invalid_request', message);
  }
  return value;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function definedEntries<Values extends RemoteMemoryProvisioningRequestV1 | RemoteMemoryProvisioningPlanInputV1>(
  value: Values,
): Values;
function definedEntries<Values extends object>(value: Values): Values {
  const result = {...value};
  for (const [key, item] of EffectRecord.toEntries(result)) {
    if (item === undefined) Reflect.deleteProperty(result, key);
  }
  return result;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
