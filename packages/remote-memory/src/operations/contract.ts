import {Schema} from 'effect';

export const OPERATIONS_CHECKS = [
  'backup',
  'isolated-restore',
  'restore-reconciliation',
  'account-recovery',
  'mfa-recovery',
  'jwks-rotation',
  'workload-credential-rotation',
  'start',
  'readiness',
  'write-disable',
  'read-continuity',
  'route-withdrawal',
  'safe-stop',
  'rollback',
  'post-rollback-reconciliation',
  'alert-delivery',
] as const;
export type OperationsCheck = (typeof OPERATIONS_CHECKS)[number];

export const OPERATIONS_ALERTS = [
  'auth',
  'recall',
  'read',
  'write',
  'cas',
  'git-synchronization',
  'registry-publication',
  'database-saturation',
  'canary',
  'backup-overdue',
  'restore-failed',
  'reconciliation-drift',
  'identity-recovery',
  'credential-rotation',
  'readiness',
  'write-disable',
  'rollback',
  'backlog',
  'failed-checks',
  'persistent-stale-evidence',
  'scheduler-lag',
  'worker-heartbeat',
] as const;
const rotationContinuity = [
  'approvedOverlapHandoffVerified',
  'authenticatedServiceContinuous',
  'authenticatedReadsContinuous',
];
const reconciliation = {
  facts: [
    'completeInventoryVerified',
    'gitIsAuthority',
    'databaseReconciledFromGit',
    'grantsRevalidated',
    'indexesRebuilt',
    'singleWriterFenced',
  ],
  metrics: [
    'verifiedRecords',
    'hashMismatches',
    'aliasMismatches',
    'grantMismatches',
    'indexMismatches',
    'unresolvedWrites',
  ],
};
export const OPERATIONS_CHECK_SPECIFICATIONS: Readonly<
  Record<
    OperationsCheck,
    {
      readonly facts: readonly string[];
      readonly metrics: readonly string[];
    }
  >
> = {
  backup: {
    facts: ['gitBackupVerified', 'databaseBackupVerified', 'pitrVerified', 'encrypted', 'restoreAccessVerified'],
    metrics: ['backupAgeSeconds', 'pitrWindowSeconds', 'pitrLagSeconds'],
  },
  'isolated-restore': {
    facts: ['isolated', 'productionTrafficAbsent', 'productionWritesAbsent', 'gitRestored', 'databaseRestored'],
    metrics: ['elapsedSeconds', 'recoveryPointLossSeconds'],
  },
  'restore-reconciliation': reconciliation,
  'account-recovery': {
    facts: ['recoveryAccessVerified', 'previousSessionsRevoked', 'leastPrivilegeVerified'],
    metrics: [],
  },
  'mfa-recovery': {
    facts: ['recoveryAccessVerified', 'oldFactorRejected', 'newFactorAccepted', 'noMfaBypass'],
    metrics: [],
  },
  'jwks-rotation': {
    facts: [
      ...rotationContinuity,
      'newKeyAccepted',
      'retiredKeyRejected',
      'unknownKeyRejected',
      'issuerAudienceVerified',
    ],
    metrics: [],
  },
  'workload-credential-rotation': {
    facts: [
      ...rotationContinuity,
      'recoveryAccessVerified',
      'newCredentialAccepted',
      'oldCredentialRejected',
      'leastPrivilegeVerified',
    ],
    metrics: [],
  },
  start: {facts: ['preflightPassed', 'runtimeLeastPrivilegeVerified', 'singleWriterFenced'], metrics: []},
  readiness: {
    facts: ['ready', 'authenticatedReadVerified', 'unauthorizedReadDenied'],
    metrics: ['recoveryElapsedSeconds'],
  },
  'write-disable': {facts: ['remoteWritesDenied', 'backgroundWritersDisabled', 'admittedWritesDrained'], metrics: []},
  'read-continuity': {
    facts: ['authorizedReadsAvailable', 'unauthorizedReadsDenied', 'localStdioAvailable'],
    metrics: [],
  },
  'route-withdrawal': {facts: ['remoteRouteWithdrawn', 'newRequestsDenied', 'localStdioAvailable'], metrics: []},
  'safe-stop': {facts: ['admissionStopped', 'workDrained', 'workersStopped', 'localStdioAvailable'], metrics: []},
  rollback: {
    facts: [
      'previousArtifactRestored',
      'schemaCompatible',
      'writesRemainDisabled',
      'safeReadsAvailable',
      'localStdioAvailable',
    ],
    metrics: [],
  },
  'post-rollback-reconciliation': reconciliation,
  'alert-delivery': {
    facts: OPERATIONS_ALERTS.flatMap(kind =>
      [
        'namedOwnersResolved',
        'operatorAcknowledged',
        'supportAcknowledged',
        'escalationTested',
        'safeActionTested',
        'rollbackTested',
      ].map(fact => `${kind}:${fact}`),
    ),
    metrics: [],
  },
};

export const OperationsOpaqueId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const OperationsTimestamp = Schema.String.check(
  Schema.makeFilter(value => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
      ? undefined
      : 'Invalid timestamp.';
  }),
);
const Count = Schema.Number.check(Schema.isInt(), Schema.isBetween({minimum: 0, maximum: 1_000_000_000}));
const Seconds = Schema.Number.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 31_536_000}));
const Owners = Schema.Struct({
  operator: OperationsOpaqueId,
  support: OperationsOpaqueId,
  escalation: OperationsOpaqueId,
});
const DraftFields = {
  version: Schema.Literal(1),
  deploymentId: OperationsOpaqueId,
  plannedAt: OperationsTimestamp,
  maxEvidenceAgeSeconds: Seconds,
  owners: Owners,
  ownerRosterDigest: Digest,
  authority: Schema.Literal('git'),
  backup: Schema.Struct({
    method: Schema.Literal('snapshot-and-pitr'),
    scheduleSeconds: Seconds,
    retentionSeconds: Seconds,
    rpoSeconds: Seconds,
    rtoSeconds: Seconds,
  }),
  baseline: Schema.Struct({
    expectedRecords: Schema.Number.check(Schema.isInt(), Schema.isBetween({minimum: 1, maximum: 1_000_000_000})),
    gitAuthorityDigest: Digest,
    databaseCheckpointDigest: Digest,
    aliasCatalogDigest: Digest,
    grantPolicyDigest: Digest,
    runtimeArtifactDigest: Digest,
    rollbackArtifactDigest: Digest,
  }),
  alerts: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(OPERATIONS_ALERTS),
      owners: Owners,
      safeFirstAction: Schema.Literals(['disable-writes', 'withdraw-route', 'pause-worker', 'retain-isolation']),
      rollback: Schema.Literal('keep-writes-disabled-restore-reviewed-baseline'),
    }),
  ).check(Schema.isMinLength(OPERATIONS_ALERTS.length), Schema.isMaxLength(OPERATIONS_ALERTS.length)),
} as const;
export const OperationsDraftSchema = Schema.Struct(DraftFields);
export const OperationsManifestSchema = Schema.Struct({...DraftFields, manifestDigest: Digest});
export type OperationsManifest = typeof OperationsManifestSchema.Type;

const Check = Schema.Literals(OPERATIONS_CHECKS);
const ObservationSchema = Schema.Union([
  Schema.Struct({check: Check, status: Schema.Literal('pending')}),
  Schema.Struct({
    check: Check,
    status: Schema.Literal('observed'),
    observedAt: OperationsTimestamp,
    observerId: OperationsOpaqueId,
    evidenceDigest: Digest,
    facts: Schema.Record(Schema.String, Schema.Boolean),
    metrics: Schema.Record(Schema.String, Count),
  }),
]);
export const OperationsEvidenceSchema = Schema.Struct({
  version: Schema.Literal(1),
  manifestDigest: Digest,
  drillId: OperationsOpaqueId,
  isolatedTargetId: OperationsOpaqueId,
  checks: Schema.Array(ObservationSchema).check(
    Schema.isMinLength(OPERATIONS_CHECKS.length),
    Schema.isMaxLength(OPERATIONS_CHECKS.length),
  ),
});
export type OperationsEvidence = typeof OperationsEvidenceSchema.Type;

export const OperationsReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  receiptDigest: Digest,
  manifestDigest: Digest,
  evidenceDigest: Digest,
  checkedAt: OperationsTimestamp,
  deploymentId: OperationsOpaqueId,
  drillId: OperationsOpaqueId,
  isolatedTargetId: OperationsOpaqueId,
  evidenceTrust: Schema.Literal('operator-attested'),
  providerActions: Schema.Literal('none'),
  status: Schema.Literals(['verified', 'pending', 'blocked']),
  checks: Schema.Array(
    Schema.Struct({
      check: Check,
      status: Schema.Literals(['verified', 'pending', 'blocked']),
    }),
  ).check(Schema.isMinLength(OPERATIONS_CHECKS.length), Schema.isMaxLength(OPERATIONS_CHECKS.length)),
});
export type OperationsReceipt = typeof OperationsReceiptSchema.Type;

export function parseOperations<A>(schema: Schema.Codec<A>, value: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema, {onExcessProperty: 'error'})(value);
  } catch {
    throw new Error('Invalid operations input.');
  }
}
