import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import type {
  HostedContextHealthReceiptV1,
  HostedContextHealthRunInputV1,
  HostedContextHealthScheduleReceiptV1,
  HostedContextHealthScheduleV1,
} from './hosted/context_health.js';
import type {
  HostedContextHealthClaimBatchV1,
  HostedContextHealthClaimV1,
  HostedContextHealthCycleCompletionV1,
} from './hosted/context_health_postgres.js';
import type {RemoteMemoryProvisioningInput} from './postgres/control_plane.js';
import {
  planRemoteMemoryProvisioning,
  remoteMemoryProvisioningReceipt,
  verifyRemoteMemoryProvisioningPlan,
  type RemoteMemoryProvisioningPlanV1,
  type RemoteMemoryProvisioningReceiptV1,
  type RemoteMemoryProvisioningRequestV1,
  type RemoteMemoryProvisioningStateV1,
} from './provisioning.js';
import {
  finalizeGitBetaCutover,
  materializeGitBetaImport,
  planGitBetaImport,
  planRemoteMemoryExport,
  verifyGitBetaImportPlan,
  type GitBetaImportApplyOutcomeV1,
  type GitBetaImportPlanV1,
  type GitBetaImportPolicyV1,
  type GitBetaMemorySourceV1,
  type RemoteMemoryCutoverReceiptV1,
  type RemoteMemoryExistingRecordV1,
  type RemoteMemoryExportPlanV1,
  type RemoteMemoryPortableRecordV1,
} from './portability.js';

export const REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION = 1 as const;

export type RemoteMemoryOperatorCapability =
  | 'apply_git_beta_import'
  | 'export_records'
  | 'inspect_records'
  | 'manage_context_ci'
  | 'manage_context_health'
  | 'migrate_schema'
  | 'provision_control_plane';

export interface RemoteMemoryOperatorCapabilitiesV1 {
  readonly available: readonly RemoteMemoryOperatorCapability[];
  readonly unavailable: Readonly<Partial<Record<RemoteMemoryOperatorCapability, string>>>;
  readonly version: typeof REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION;
}

export interface RemoteMemoryMigrationResultV1 {
  readonly readyVersions: readonly number[];
  readonly status: 'ready';
  readonly version: typeof REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION;
}

export interface RemoteMemoryProvisionResultV1 {
  readonly principalId: string;
  readonly shareId: string;
  readonly status: 'ready';
  readonly tenantId: string;
  readonly version: typeof REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION;
}

export interface GitBetaImportVerificationV1 {
  readonly checked: number;
  readonly mismatches: readonly {
    readonly reason: 'alias_missing' | 'content_hash_mismatch' | 'record_missing';
    readonly sourceUri: string;
    readonly targetUri: string;
  }[];
  readonly status: 'failed' | 'matched';
  readonly version: typeof REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION;
}

export interface RemoteMemoryOperatorAdapter {
  readonly controlContextCi?: (input: unknown, webhookKey?: string) => Promise<unknown>;
  readonly applyProvisioningPlan?: (
    plan: RemoteMemoryProvisioningPlanV1,
    receipt: RemoteMemoryProvisioningReceiptV1,
  ) => Promise<RemoteMemoryProvisioningReceiptV1>;
  readonly applyGitBetaImport?: (input: {
    readonly aliasCompatibilityEndsAt: string;
    readonly planDigest: string;
    readonly planId: string;
    readonly records: readonly RemoteMemoryPortableRecordV1[];
    readonly shareId: string;
  }) => Promise<readonly GitBetaImportApplyOutcomeV1[]>;
  readonly capabilities: RemoteMemoryOperatorCapabilitiesV1;
  readonly exportRecords?: (shareId: string) => Promise<readonly RemoteMemoryPortableRecordV1[]>;
  readonly inspectRecords?: (shareId: string) => Promise<readonly RemoteMemoryExistingRecordV1[]>;
  readonly inspectProvisioningState?: (
    input: RemoteMemoryProvisioningRequestV1,
  ) => Promise<RemoteMemoryProvisioningStateV1>;
  readonly claimContextHealthJobs?: (concurrency: number) => Promise<HostedContextHealthClaimBatchV1>;
  readonly assertContextHealthWorkerPrivileges?: () => Promise<void>;
  readonly completeContextHealthCycle?: (input: {
    readonly failed: boolean;
    readonly generation: number;
  }) => Promise<HostedContextHealthCycleCompletionV1>;
  readonly failContextHealthClaim?: (claim: HostedContextHealthClaimV1) => Promise<void>;
  readonly registerContextHealthSchedule?: (
    schedule: HostedContextHealthScheduleV1,
    nextDueAt: string,
  ) => Promise<HostedContextHealthScheduleReceiptV1>;
  readonly recordContextHealthRun?: (
    claim: HostedContextHealthClaimV1,
    input: HostedContextHealthRunInputV1,
  ) => Promise<HostedContextHealthReceiptV1>;
  readonly setContextHealthScheduleStatus?: (input: {
    readonly project: string;
    readonly shareId: string;
    readonly status: 'active' | 'paused';
    readonly tenantId: string;
  }) => Promise<{
    readonly changed: boolean;
    readonly labels: {readonly project: string; readonly share: string; readonly tenant: string};
    readonly status: 'active' | 'paused';
    readonly version: 1;
  }>;
  readonly migrateSchema?: () => Promise<RemoteMemoryMigrationResultV1>;
  readonly provisionControlPlane?: (input: RemoteMemoryProvisioningInput) => Promise<void>;
}

export function assertHostedContextHealthWorkerPrivileges(adapter: RemoteMemoryOperatorAdapter): Promise<void> {
  return requireCapability(adapter, 'manage_context_health', adapter.assertContextHealthWorkerPrivileges)();
}

export function registerHostedContextHealthOperator(
  adapter: RemoteMemoryOperatorAdapter,
  schedule: HostedContextHealthScheduleV1,
  nextDueAt: string,
): Promise<HostedContextHealthScheduleReceiptV1> {
  return requireCapability(
    adapter,
    'manage_context_health',
    adapter.registerContextHealthSchedule,
  )(schedule, nextDueAt);
}

export function recordHostedContextHealthOperator(
  adapter: RemoteMemoryOperatorAdapter,
  claim: HostedContextHealthClaimV1,
  input: HostedContextHealthRunInputV1,
): Promise<HostedContextHealthReceiptV1> {
  return requireCapability(adapter, 'manage_context_health', adapter.recordContextHealthRun)(claim, input);
}

export function claimHostedContextHealthOperator(
  adapter: RemoteMemoryOperatorAdapter,
  concurrency: number,
): Promise<HostedContextHealthClaimBatchV1> {
  return requireCapability(adapter, 'manage_context_health', adapter.claimContextHealthJobs)(concurrency);
}

export function failHostedContextHealthOperatorClaim(
  adapter: RemoteMemoryOperatorAdapter,
  claim: HostedContextHealthClaimV1,
): Promise<void> {
  return requireCapability(adapter, 'manage_context_health', adapter.failContextHealthClaim)(claim);
}

export function completeHostedContextHealthOperatorCycle(
  adapter: RemoteMemoryOperatorAdapter,
  input: {readonly failed: boolean; readonly generation: number},
): Promise<HostedContextHealthCycleCompletionV1> {
  return requireCapability(adapter, 'manage_context_health', adapter.completeContextHealthCycle)(input);
}

export function setHostedContextHealthOperatorStatus(
  adapter: RemoteMemoryOperatorAdapter,
  input: {
    readonly project: string;
    readonly shareId: string;
    readonly status: 'active' | 'paused';
    readonly tenantId: string;
  },
) {
  return requireCapability(adapter, 'manage_context_health', adapter.setContextHealthScheduleStatus)(input);
}

export class RemoteMemoryOperatorError extends Schema.TaggedError<
  RemoteMemoryOperatorError,
  {readonly brand: unique symbol}
>()('RemoteMemoryOperatorError', {
  code: Schema.Literals(['blocked_plan', 'capability_unavailable', 'invalid_input', 'verification_failed']),
  message: Schema.String,
}) {
  static of(
    code: 'blocked_plan' | 'capability_unavailable' | 'invalid_input' | 'verification_failed',
    message: string,
  ): RemoteMemoryOperatorError {
    return RemoteMemoryOperatorError.make({code, message});
  }
}

export function remoteMemoryOperatorCapabilities(
  available: readonly RemoteMemoryOperatorCapability[],
  unavailable: Readonly<Partial<Record<RemoteMemoryOperatorCapability, string>>> = {},
): RemoteMemoryOperatorCapabilitiesV1 {
  return {
    available: [...new Set(available)].sort(compareCodeUnits),
    unavailable,
    version: REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION,
  };
}

export async function migrateRemoteMemoryOperator(
  adapter: RemoteMemoryOperatorAdapter,
): Promise<RemoteMemoryMigrationResultV1> {
  return requireCapability(adapter, 'migrate_schema', adapter.migrateSchema)();
}

export async function provisionRemoteMemoryOperator(
  adapter: RemoteMemoryOperatorAdapter,
  input: RemoteMemoryProvisioningInput,
): Promise<RemoteMemoryProvisionResultV1> {
  await requireCapability(adapter, 'provision_control_plane', adapter.provisionControlPlane)(input);
  return {
    principalId: input.principalId,
    shareId: input.shareId,
    status: 'ready',
    tenantId: input.tenantId,
    version: REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION,
  };
}

export async function planRemoteMemoryProvisioningOperator(
  adapter: RemoteMemoryOperatorAdapter,
  input: {
    readonly apply: boolean;
    readonly plannedAt?: string;
    readonly request: RemoteMemoryProvisioningRequestV1;
  },
): Promise<RemoteMemoryProvisioningPlanV1> {
  const inspect = requireCapability(adapter, 'provision_control_plane', adapter.inspectProvisioningState);
  return planRemoteMemoryProvisioning({
    apply: input.apply,
    plannedAt: input.plannedAt ?? new Date().toISOString(),
    request: input.request,
    state: await inspect(input.request),
  });
}

export async function applyRemoteMemoryProvisioningOperator(
  adapter: RemoteMemoryOperatorAdapter,
  plan: RemoteMemoryProvisioningPlanV1,
): Promise<RemoteMemoryProvisioningReceiptV1> {
  verifyRemoteMemoryProvisioningPlan(plan);
  if (plan.dryRun) {
    throw RemoteMemoryOperatorError.of(
      'invalid_input',
      'A preview provisioning plan cannot be applied. Create a plan with --for-apply.',
    );
  }
  if (plan.input.grantExpiresAt !== undefined && Date.parse(plan.input.grantExpiresAt) <= Date.now()) {
    throw RemoteMemoryOperatorError.of(
      'blocked_plan',
      'The provisioning grant expired before apply. Create a new plan.',
    );
  }
  const apply = requireCapability(adapter, 'provision_control_plane', adapter.applyProvisioningPlan);
  return apply(plan, remoteMemoryProvisioningReceipt(plan));
}

export async function planGitBetaImportOperator(
  adapter: RemoteMemoryOperatorAdapter,
  input: {
    readonly aliasCompatibilityEndsAt: string;
    readonly apply: boolean;
    readonly policy?: Partial<Omit<GitBetaImportPolicyV1, 'version'>>;
    readonly records: readonly GitBetaMemorySourceV1[];
    readonly shareId: string;
  },
): Promise<GitBetaImportPlanV1> {
  const inspect = requireCapability(adapter, 'inspect_records', adapter.inspectRecords);
  const existing = await inspect(input.shareId);
  return planGitBetaImport({
    aliasCompatibilityEndsAt: input.aliasCompatibilityEndsAt,
    dryRun: !input.apply,
    existing,
    policy: input.policy,
    records: input.records,
    shareId: input.shareId,
  });
}

export async function applyGitBetaImportOperator(
  adapter: RemoteMemoryOperatorAdapter,
  input: {readonly plan: GitBetaImportPlanV1; readonly records: readonly GitBetaMemorySourceV1[]},
): Promise<{
  readonly cutover: RemoteMemoryCutoverReceiptV1;
  readonly verification: GitBetaImportVerificationV1;
  readonly version: typeof REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION;
}> {
  verifyGitBetaImportPlan(input.plan);
  if (input.plan.dryRun) {
    throw RemoteMemoryOperatorError.of('invalid_input', 'A dry-run plan cannot be applied. Create an apply plan.');
  }
  if (input.plan.counts.blocked + input.plan.counts.conflict + input.plan.counts.invalid > 0) {
    throw RemoteMemoryOperatorError.of('blocked_plan', 'The Git beta import plan contains blocking records.');
  }
  const apply = requireCapability(adapter, 'apply_git_beta_import', adapter.applyGitBetaImport);
  const inspect = requireCapability(adapter, 'inspect_records', adapter.inspectRecords);
  const currentPlan = planGitBetaImport({
    aliasCompatibilityEndsAt: input.plan.aliasCompatibilityEndsAt,
    dryRun: false,
    existing: await inspect(input.plan.shareId),
    policy: input.plan.policy,
    records: input.records,
    shareId: input.plan.shareId,
  });
  assertApplyPlanMatchesCurrentState(input.plan, currentPlan);
  const records = materializeGitBetaImport(input.plan, input.records);
  const outcomes = await apply({
    aliasCompatibilityEndsAt: input.plan.aliasCompatibilityEndsAt,
    planDigest: input.plan.planDigest,
    planId: input.plan.planId,
    records,
    shareId: input.plan.shareId,
  });
  const verification = verifyAppliedGitBetaImport(input.plan, await inspect(input.plan.shareId));
  const cutover = finalizeGitBetaCutover({
    outcomes,
    plan: input.plan,
    verified: verification.status === 'matched',
  });
  if (cutover.status !== 'ready') {
    throw RemoteMemoryOperatorError.of(
      'verification_failed',
      'The import did not verify. Keep the Git beta environment active and do not switch transports.',
    );
  }
  return {cutover, verification, version: REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION};
}

function assertApplyPlanMatchesCurrentState(planned: GitBetaImportPlanV1, current: GitBetaImportPlanV1): void {
  const matches =
    planned.entries.length === current.entries.length &&
    EffectArray.every(planned.entries, (entry, index) => {
      const actual = current.entries[index];
      if (!actual) return false;
      const replayTransition = entry.classification === 'would_import' && actual.classification === 'unchanged';
      return (
        (entry.classification === actual.classification || replayTransition) &&
        entry.aliasUri === actual.aliasUri &&
        entry.contentHash === actual.contentHash &&
        entry.reason === actual.reason &&
        entry.sourceUri === actual.sourceUri &&
        entry.targetUri === actual.targetUri
      );
    });
  if (!matches) {
    throw RemoteMemoryOperatorError.of(
      'blocked_plan',
      'Source or target state changed after planning. Keep Git beta active and create a new apply plan.',
    );
  }
}

export function verifyAppliedGitBetaImport(
  plan: GitBetaImportPlanV1,
  existing: readonly RemoteMemoryExistingRecordV1[],
): GitBetaImportVerificationV1 {
  verifyGitBetaImportPlan(plan);
  const byUri = new Map(EffectArray.map(existing, record => [record.uri, record]));
  const expected = EffectArray.filter(
    plan.entries,
    entry => entry.classification === 'would_import' || entry.classification === 'unchanged',
  );
  const mismatches: GitBetaImportVerificationV1['mismatches'][number][] = [];
  for (const item of expected) {
    if (!item.targetUri || !item.contentHash || !item.aliasUri) continue;
    const actual = byUri.get(item.targetUri);
    if (!actual) {
      mismatches.push({reason: 'record_missing', sourceUri: item.sourceUri, targetUri: item.targetUri});
    } else if (actual.contentHash !== item.contentHash) {
      mismatches.push({reason: 'content_hash_mismatch', sourceUri: item.sourceUri, targetUri: item.targetUri});
    } else if (!actual.aliases.includes(item.aliasUri)) {
      mismatches.push({reason: 'alias_missing', sourceUri: item.sourceUri, targetUri: item.targetUri});
    }
  }
  return {
    checked: expected.length,
    mismatches,
    status: mismatches.length === 0 ? 'matched' : 'failed',
    version: REMOTE_MEMORY_OPERATOR_CONTRACT_VERSION,
  };
}

export async function exportRemoteMemoryOperator(
  adapter: RemoteMemoryOperatorAdapter,
  shareId: string,
): Promise<RemoteMemoryExportPlanV1> {
  const exportRecords = requireCapability(adapter, 'export_records', adapter.exportRecords);
  return planRemoteMemoryExport(await exportRecords(shareId));
}

function requireCapability<Arguments extends readonly unknown[], Result>(
  adapter: RemoteMemoryOperatorAdapter,
  capability: RemoteMemoryOperatorCapability,
  operation: ((...arguments_: Arguments) => Result) | undefined,
): (...arguments_: Arguments) => Result {
  if (operation && adapter.capabilities.available.includes(capability)) return operation;
  const reason = adapter.capabilities.unavailable[capability] ?? 'The selected operator adapter does not implement it.';
  throw RemoteMemoryOperatorError.of('capability_unavailable', `${capability} is unavailable: ${reason}`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
