import {Schema} from 'effect';

export class SetupOperationError extends Schema.TaggedError<SetupOperationError>()('SetupOperationError', {
  message: Schema.String,
}) {}

export const SETUP_PLAN_VERSION = 1 as const;
export const SETUP_RECEIPT_VERSION = 1 as const;
export const SETUP_MAX_DURATION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export const SETUP_OPERATION_KINDS = [
  'core.ensure',
  'manifest.ensure',
  'project.seed',
  'surface.ensure',
  'surface.hooks',
  'dev-skills.ensure',
  'graph.index',
  'doctor.verify',
  'context-brief.verify',
] as const;

export type SetupOperationKind = (typeof SETUP_OPERATION_KINDS)[number];
export type SetupOperationStatus = 'pending' | 'applied' | 'already-current' | 'verified' | 'failed' | 'rolled-back';

export interface SetupPlanOperationV1 {
  readonly dependsOn: readonly string[];
  readonly id: string;
  readonly inputHash: string;
  readonly kind: SetupOperationKind;
  readonly reversible: boolean;
}

export interface SetupPlanV1 {
  readonly workflows?: {readonly bundleDigest: string; readonly disabled: boolean};
  readonly adapterContractHash: string;
  readonly manifestPath: string;
  readonly operations: readonly SetupPlanOperationV1[];
  readonly planHash: string;
  readonly projectRoot: string;
  readonly repositoryIdentityHash: string;
  readonly scope?: 'user' | 'project' | 'local';
  readonly surfaceId: string;
  readonly taskHash: string;
  readonly threadnoteVersion: string;
  readonly type: 'threadnote-setup-plan';
  readonly version: typeof SETUP_PLAN_VERSION;
}

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const BoundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384));
const BoundedVersion = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const BoundedMessage = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u));
const BoundedCount = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 1_000_000}));
const BoundedDuration = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: SETUP_MAX_DURATION_MILLISECONDS}));

const SetupReceiptOperationV1Schema = Schema.Struct({
  afterHash: Schema.optionalKey(Sha256),
  attempt: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 1_000})),
  beforeHash: Schema.optionalKey(Sha256),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.Literals(['operation-failed', 'verification-failed']),
      message: BoundedMessage,
    }),
  ),
  id: Identifier,
  inputHash: Sha256,
  kind: Schema.Literals(SETUP_OPERATION_KINDS),
  ownership: Schema.Literals(['setup-created', 'preexisting']),
  ownershipEvidence: Schema.optionalKey(Schema.Literal('successful-mutation')),
  reversible: Schema.Boolean,
  status: Schema.Literals(['pending', 'applied', 'already-current', 'verified', 'failed', 'rolled-back']),
  subsystemReceiptRef: Schema.optionalKey(BoundedPath),
});

const SetupReceiptVerificationV1Schema = Schema.Struct({
  contextBriefHash: Sha256,
  durationMilliseconds: BoundedDuration,
  freshness: Schema.Literal('fresh'),
  graphCards: BoundedCount,
  graphContracts: BoundedCount,
  readyRepositories: Schema.Literal(1),
  repositorySourceHash: Sha256,
  requestedRepositories: Schema.Literal(1),
  sourceVerified: Schema.Literal(true),
});

export const SetupReceiptV1Schema = Schema.Struct({
  completedAt: Schema.optionalKey(IsoInstant),
  operations: Schema.Array(SetupReceiptOperationV1Schema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SETUP_OPERATION_KINDS.length),
  ),
  planHash: Sha256,
  previousReceiptHash: Schema.optionalKey(Sha256),
  receiptId: Sha256,
  recovery: Schema.Struct({
    resumeOperationIds: Schema.Array(Identifier).check(Schema.isMaxLength(SETUP_OPERATION_KINDS.length)),
    undoOperationIds: Schema.Array(Identifier).check(Schema.isMaxLength(SETUP_OPERATION_KINDS.length)),
  }),
  rolledBackAt: Schema.optionalKey(IsoInstant),
  scope: Schema.optionalKey(Schema.Literals(['user', 'project', 'local'])),
  startedAt: IsoInstant,
  status: Schema.Literals(['pending', 'completed', 'failed', 'rolling-back', 'rolled-back']),
  supportedAgentReuse: Schema.optionalKey(Schema.Literals([0, 1])),
  surfaceId: Identifier,
  threadnoteVersion: BoundedVersion,
  type: Schema.Literal('threadnote-setup-receipt'),
  updatedAt: IsoInstant,
  verification: Schema.optionalKey(SetupReceiptVerificationV1Schema),
  version: Schema.Literal(SETUP_RECEIPT_VERSION),
});

export type SetupReceiptV1 = typeof SetupReceiptV1Schema.Type;
export type SetupReceiptOperationV1 = SetupReceiptV1['operations'][number];
export type SetupReceiptVerificationV1 = NonNullable<SetupReceiptV1['verification']>;

const STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;

export function parseSetupReceiptV1(value: unknown): SetupReceiptV1 {
  const receipt = Schema.decodeUnknownSync(SetupReceiptV1Schema, STRICT_PARSE_OPTIONS)(value);
  const ids = new Set(receipt.operations.map(operation => operation.id));
  if (ids.size !== receipt.operations.length) throw new Error('Setup receipt operation IDs must be unique.');
  for (const operation of receipt.operations) {
    if (operation.status === 'failed' && operation.error === undefined)
      throw new Error(`Failed setup operation ${operation.id} must include an error.`);
    if (operation.status !== 'failed' && operation.error !== undefined)
      throw new Error(`Non-failed setup operation ${operation.id} cannot include an error.`);
    if (operation.ownershipEvidence !== undefined && (operation.ownership !== 'setup-created' || !operation.reversible))
      throw new Error(`Setup ownership evidence for ${operation.id} must describe a reversible created artifact.`);
  }
  for (const id of [...receipt.recovery.resumeOperationIds, ...receipt.recovery.undoOperationIds]) {
    if (!ids.has(id)) throw new Error(`Setup recovery references unknown operation ${id}.`);
  }
  const expectedRecovery = setupRecovery(receipt.operations);
  if (JSON.stringify(receipt.recovery) !== JSON.stringify(expectedRecovery))
    throw new Error('Setup recovery does not match operation state.');
  if (receipt.status === 'completed') {
    if (receipt.completedAt === undefined || receipt.verification === undefined)
      throw new Error('Completed setup receipts require completion time and verification evidence.');
    if (receipt.recovery.resumeOperationIds.length > 0)
      throw new Error('Completed setup receipts cannot include resume operations.');
  } else if (
    receipt.completedAt !== undefined &&
    receipt.status !== 'rolling-back' &&
    receipt.status !== 'rolled-back'
  ) {
    throw new Error('Incomplete setup receipts cannot include a completion time.');
  }
  if (receipt.status === 'failed' && receipt.verification !== undefined) {
    throw new Error('Failed setup receipts cannot include completion verification.');
  }
  if (
    receipt.verification !== undefined &&
    !receipt.operations.some(operation => operation.kind === 'context-brief.verify' && operation.status === 'verified')
  ) {
    throw new Error('Setup verification requires a verified Context Brief operation.');
  }
  if (receipt.status === 'rolled-back') {
    if (receipt.rolledBackAt === undefined || receipt.recovery.undoOperationIds.length > 0)
      throw new Error('Rolled-back setup receipts require rollback time and no remaining undo operations.');
  } else if (receipt.rolledBackAt !== undefined) {
    throw new Error('Only rolled-back setup receipts can include a rollback time.');
  }
  return receipt;
}

export function setupRecovery(operations: readonly SetupReceiptOperationV1[]): SetupReceiptV1['recovery'] {
  const complete = new Set<SetupOperationStatus>(['applied', 'already-current', 'verified']);
  return {
    resumeOperationIds: operations.filter(operation => !complete.has(operation.status)).map(operation => operation.id),
    undoOperationIds: operations
      .filter(
        operation =>
          operation.status !== 'rolled-back' &&
          operation.ownership === 'setup-created' &&
          operation.ownershipEvidence === 'successful-mutation' &&
          operation.reversible,
      )
      .map(operation => operation.id)
      .reverse(),
  };
}
