import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  applyRemoteMemoryProvisioningOperator,
  planRemoteMemoryProvisioningOperator,
  remoteMemoryOperatorCapabilities,
  RemoteMemoryOperatorError,
  type RemoteMemoryOperatorAdapter,
} from '@threadnote/remote-memory/operator';
import {
  normalizeRemoteMemoryProvisioningRequest,
  planRemoteMemoryProvisioning,
  provisioningPlanMatchesCurrentState,
  remoteMemoryProvisioningReceipt,
  verifyRemoteMemoryProvisioningPlan,
  type RemoteMemoryProvisioningRequestV1,
  type RemoteMemoryProvisioningStateV1,
} from '@threadnote/remote-memory/provisioning';
import {
  remoteMemoryProvisioningPolicy,
  remoteMemoryProvisioningSharePolicy,
} from '@threadnote/remote-memory/postgres/control_plane';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const plannedAt = '2026-09-18T00:00:00.000Z';
const emptyState: RemoteMemoryProvisioningStateV1 = {version: 1};
const request: RemoteMemoryProvisioningRequestV1 = {
  clientId: 'okta-client-reader',
  displayName: 'Pilot memory',
  issuer: 'https://pilot.okta.example/oauth2/threadnote',
  policyVersion: 'reader-v1',
  principalId: 'pilot-reader',
  projects: ['threadnote'],
  region: 'eu-pilot-1',
  repositoryBindings: {threadnote: ['https://github.com/example/threadnote.git']},
  shareId: 'pilot-share',
  sharePolicyVersion: 'share-v1',
  subject: '00u-reader',
  tenantId: 'pilot-tenant',
};

describe('preview-first pilot provisioning', () => {
  it('defaults a new principal to a read-only grant and emits a content-free receipt', () => {
    const plan = planRemoteMemoryProvisioning({apply: false, plannedAt, request, state: emptyState});

    expect(plan).toMatchObject({
      action: 'create_share_and_grant',
      changes: [
        'create_grant',
        'create_identity',
        'create_membership',
        'create_principal',
        'create_share',
        'create_tenant',
      ],
      dryRun: true,
      input: {
        capabilities: ['memory:read'],
        cursorAttestationRequired: false,
        featureFlags: ['remote_memory_ga', 'remote_memory_read'],
      },
      version: 1,
    });
    expect(plan.planId).toMatch(/^tnpp_[0-9a-f]{32}$/u);
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/u);
    verifyRemoteMemoryProvisioningPlan(plan);

    const applyPlan = planRemoteMemoryProvisioning({apply: true, plannedAt, request, state: emptyState});
    const receipt = remoteMemoryProvisioningReceipt(applyPlan);
    expect(receipt).toMatchObject({
      action: 'create_share_and_grant',
      capabilities: ['memory:read'],
      principalId: 'pilot-reader',
      shareId: 'pilot-share',
      status: 'ready',
      tenantId: 'pilot-tenant',
    });
    expect(JSON.stringify(receipt)).not.toContain(request.subject);
    expect(JSON.stringify(receipt)).not.toContain(request.clientId);
  });

  it('requires write grants to be project-bounded, expiring, and free of external admin access', () => {
    const writer = {
      ...request,
      allowedProjects: ['threadnote'],
      capabilities: ['memory:read', 'memory:write:durable'] as const,
      cursorSubjects: ['user:123'],
      grantExpiresAt: '2026-10-01T00:00:00.000Z',
      policyVersion: 'writer-v1',
      principalId: 'pilot-writer',
      subject: '00u-writer',
    };
    expect(() =>
      planRemoteMemoryProvisioning({apply: false, plannedAt, request: writer, state: emptyState}),
    ).not.toThrow();
    expect(() =>
      planRemoteMemoryProvisioning({
        apply: false,
        plannedAt,
        request: {...writer, allowedProjects: undefined},
        state: emptyState,
      }),
    ).toThrow('name at least one allowed project');
    expect(() =>
      planRemoteMemoryProvisioning({
        apply: false,
        plannedAt,
        request: {...writer, grantExpiresAt: undefined},
        state: emptyState,
      }),
    ).toThrow('require a bounded expiry');
    expect(() =>
      planRemoteMemoryProvisioning({
        apply: false,
        plannedAt,
        request: {...writer, capabilities: ['memory:admin']},
        state: emptyState,
      }),
    ).toThrow('cannot receive memory:admin');
  });

  it('binds apply plans to the exact observed grant and rejects tampering', () => {
    const existingRequest = {...request, sharePolicyVersion: undefined};
    const state: RemoteMemoryProvisioningStateV1 = {
      grant: {
        policyDigest: Effect.pipe('a', EffectString.repeat(64)),
        policyVersion: 'reader-v0',
        status: 'active',
      },
      identityPrincipalId: request.principalId,
      membershipStatus: 'active',
      principalStatus: 'active',
      share: {
        featureFlags: ['remote_memory_ga', 'remote_memory_read'],
        policyDigest: Effect.pipe('b', EffectString.repeat(64)),
        policyVersion: 'share-v1',
        status: 'active',
      },
      tenant: {region: request.region, status: 'active'},
      version: 1,
    };
    const plan = planRemoteMemoryProvisioning({apply: true, plannedAt, request: existingRequest, state});
    expect(plan.input.expectedCurrentPolicyVersion).toBe('reader-v0');
    expect(plan.input.expectedCurrentSharePolicyVersion).toBe('share-v1');
    expect(provisioningPlanMatchesCurrentState(plan, state)).toBe(true);
    expect(
      provisioningPlanMatchesCurrentState(plan, {
        ...state,
        grant: {...state.grant!, policyVersion: 'reader-v0-rotated'},
      }),
    ).toBe(false);
    expect(() =>
      verifyRemoteMemoryProvisioningPlan({...plan, planDigest: Effect.pipe('0', EffectString.repeat(64))}),
    ).toThrow('digest or canonical contents');
  });

  it('binds the explicit organization Cloud admission profile into grant policy', () => {
    const desktop = normalizeRemoteMemoryProvisioningRequest(request);
    const cloud = normalizeRemoteMemoryProvisioningRequest({...request, cloudAdmissionRequired: true});
    expect(desktop.cloudAdmissionRequired).toBeUndefined();
    expect(cloud.cloudAdmissionRequired).toBe(true);
    expect(remoteMemoryProvisioningPolicy(cloud).digest).not.toBe(remoteMemoryProvisioningPolicy(desktop).digest);
  });

  it('reports identity and share-policy mutations instead of calling them unchanged', () => {
    const existingRequest = {...request, sharePolicyVersion: undefined};
    const normalized = normalizeRemoteMemoryProvisioningRequest(existingRequest);
    const featureFlags = ['remote_memory_ga', 'remote_memory_read'] as const;
    const state: RemoteMemoryProvisioningStateV1 = {
      grant: {
        policyDigest: remoteMemoryProvisioningPolicy(normalized).digest,
        policyVersion: normalized.policyVersion,
        status: 'active',
      },
      membershipStatus: 'active',
      principalStatus: 'active',
      share: {
        featureFlags,
        policyDigest: remoteMemoryProvisioningSharePolicy({...normalized, featureFlags}).digest,
        policyVersion: request.sharePolicyVersion!,
        status: 'active',
      },
      tenant: {region: request.region, status: 'active'},
      version: 1,
    };
    const identityPlan = planRemoteMemoryProvisioning({apply: false, plannedAt, request: existingRequest, state});
    expect(identityPlan).toMatchObject({action: 'update_control_plane', changes: ['create_identity']});
    const unchanged = planRemoteMemoryProvisioning({
      apply: false,
      plannedAt,
      request: existingRequest,
      state: {...state, identityPrincipalId: request.principalId},
    });
    expect(unchanged).toMatchObject({action: 'unchanged', changes: []});
    const replacement = planRemoteMemoryProvisioning({
      apply: false,
      plannedAt,
      request: {...request, featureFlags, sharePolicyVersion: 'share-v2'},
      state: {...state, identityPrincipalId: request.principalId},
    });
    expect(replacement).toMatchObject({action: 'update_control_plane', changes: ['replace_share_policy']});
  });

  it('normalizes set-like fields independent of insertion order', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(['memory:read', 'memory:propose:durable', 'memory:review:durable'] as const, {
          minLength: 1,
        }),
        capabilities => {
          const writes = EffectArray.some(capabilities, capability => capability !== 'memory:read');
          const candidate: RemoteMemoryProvisioningRequestV1 = {
            ...request,
            allowedProjects: writes ? ['threadnote'] : undefined,
            capabilities,
            cursorAttestationRequired: false,
            grantExpiresAt: writes ? '2026-10-01T00:00:00.000Z' : undefined,
          };
          const reversed = {...candidate, capabilities: [...capabilities].reverse()};
          expect(normalizeRemoteMemoryProvisioningRequest(candidate)).toEqual(
            normalizeRemoteMemoryProvisioningRequest(reversed),
          );
          expect(
            planRemoteMemoryProvisioning({apply: false, plannedAt, request: candidate, state: emptyState}).planDigest,
          ).toBe(
            planRemoteMemoryProvisioning({apply: false, plannedAt, request: reversed, state: emptyState}).planDigest,
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('rechecks the observed control-plane state before applying and emits a content-free receipt', async () => {
    let state: RemoteMemoryProvisioningStateV1 = emptyState;
    const provisioned: unknown[] = [];
    const adapter: RemoteMemoryOperatorAdapter = {
      capabilities: remoteMemoryOperatorCapabilities(['provision_control_plane']),
      applyProvisioningPlan: async (plan, receipt) => {
        if (!provisioningPlanMatchesCurrentState(plan, state)) {
          throw RemoteMemoryOperatorError.of('blocked_plan', 'state changed');
        }
        provisioned.push(plan.input);
        return receipt;
      },
      inspectProvisioningState: async () => state,
    };
    const plan = await planRemoteMemoryProvisioningOperator(adapter, {apply: true, plannedAt, request});
    const receipt = await applyRemoteMemoryProvisioningOperator(adapter, plan);
    expect(provisioned).toEqual([plan.input]);
    expect(receipt).toMatchObject({planId: plan.planId, status: 'ready'});
    expect(JSON.stringify(receipt)).not.toContain(request.subject);
    expect(JSON.stringify(receipt)).not.toContain(request.clientId);

    provisioned.length = 0;
    state = {
      share: {
        featureFlags: ['remote_memory_ga', 'remote_memory_read'],
        policyDigest: Effect.pipe('a', EffectString.repeat(64)),
        policyVersion: 'another-share-policy',
        status: 'active',
      },
      version: 1,
    };
    await expect(applyRemoteMemoryProvisioningOperator(adapter, plan)).rejects.toMatchObject({code: 'blocked_plan'});
    expect(provisioned).toEqual([]);
  });

  it('refuses to apply a preview-only provisioning plan', async () => {
    const adapter: RemoteMemoryOperatorAdapter = {
      capabilities: remoteMemoryOperatorCapabilities(['provision_control_plane']),
      applyProvisioningPlan: async (_plan, receipt) => receipt,
      inspectProvisioningState: async () => emptyState,
    };
    const plan = await planRemoteMemoryProvisioningOperator(adapter, {apply: false, plannedAt, request});
    await expect(applyRemoteMemoryProvisioningOperator(adapter, plan)).rejects.toMatchObject({code: 'invalid_input'});
  });
});
