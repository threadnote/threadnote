import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const ACTIVATION_PLAN_VERSION = 1 as const;
export const ACTIVATION_RECEIPT_VERSION = 1 as const;
export const ACTIVATION_MAX_OPERATIONS = 10 as const;
export const ACTIVATION_MAX_DURATION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export const ACTIVATION_OPERATION_KINDS = [
  'surface.primary.ensure',
  'surface.secondary.ensure',
  'team.ensure',
  'imports.preview',
  'imports.review',
  'brief.verify',
  'decision.review',
  'decision.apply',
  'decision.publish',
  'decision.propose',
  'secondary.prove',
] as const;

export const ACTIVATION_APPROVAL_KINDS = ['imports-reviewed', 'decision-apply', 'decision-publish'] as const;

export type ActivationOperationKind = (typeof ACTIVATION_OPERATION_KINDS)[number];
export type ActivationApprovalKind = (typeof ACTIVATION_APPROVAL_KINDS)[number];
export type ActivationPublicationMode = 'direct' | 'proposal';
export type ActivationSuccessfulOutcome = 'applied' | 'already-current' | 'verified';

export interface ActivationPlanInputV1 {
  readonly catalogSnapshotHash: string;
  readonly primarySurfaceId: string;
  readonly publicationMode: ActivationPublicationMode;
  readonly repositoryIdentityHash: string;
  readonly secondarySurfaceId: string;
  readonly selectedSourceSetHash: string;
  readonly taskHash: string;
  readonly teamId: string;
  readonly teamShareStateHash: string;
  readonly threadnoteVersion: string;
}

export interface ActivationPlanOperationV1 {
  readonly approvalKind?: ActivationApprovalKind;
  readonly dependsOn: readonly string[];
  readonly expectedOutcome: 'applied' | 'verified';
  readonly id: string;
  readonly inputHash: string;
  readonly kind: ActivationOperationKind;
  readonly reversible: boolean;
}

export interface ActivationOperationDefinitionV1 {
  readonly approvalKind?: ActivationApprovalKind;
  readonly expectedOutcome: 'applied' | 'verified';
  readonly id: string;
  readonly kind: ActivationOperationKind;
  readonly reversible: boolean;
}

export interface ActivationPlanV1 extends ActivationPlanInputV1 {
  readonly activationId: string;
  readonly operations: readonly ActivationPlanOperationV1[];
  readonly planHash: string;
  readonly type: 'threadnote-activation-plan';
  readonly version: typeof ACTIVATION_PLAN_VERSION;
}

export interface ActivationApprovalV1 {
  readonly approvalHash: string;
  readonly approved: true;
  readonly kind: ActivationApprovalKind;
  readonly operationId: string;
  readonly planHash: string;
  readonly receiptRevision: string;
  readonly reviewRevisionHash: string;
  readonly type: 'threadnote-activation-approval';
  readonly version: typeof ACTIVATION_RECEIPT_VERSION;
}

export type ActivationFailureCode =
  | 'capability-unavailable'
  | 'drift-detected'
  | 'input-invalid'
  | 'offline-unavailable'
  | 'operation-failed'
  | 'verification-failed';

export type ActivationOperationOutcomeV1 =
  | {
      readonly ownership: 'activation-created' | 'preexisting';
      readonly status: ActivationSuccessfulOutcome;
      readonly subsystemReceiptHash: string;
      readonly undoEligible: boolean;
    }
  | {
      readonly failureCode: ActivationFailureCode;
      readonly status: 'failed';
    };

export type ActivationReceiptOperationV1 = {
  readonly approvalHash?: string;
  readonly attempt: number;
  readonly failureCode?: ActivationFailureCode;
  readonly id: string;
  readonly inputHash: string;
  readonly kind: ActivationOperationKind;
  readonly outcomeHash?: string;
  readonly ownership?: 'activation-created' | 'preexisting';
  readonly status: 'pending' | ActivationSuccessfulOutcome | 'failed';
  readonly subsystemReceiptHash?: string;
  readonly undoEligible?: boolean;
};

export interface ActivationReceiptV1 {
  readonly activationId: string;
  readonly completedAt?: string;
  readonly firstBrief?: {
    readonly completedAt: string;
    readonly durationMilliseconds: number;
  };
  readonly generation: number;
  readonly operations: readonly ActivationReceiptOperationV1[];
  readonly planHash: string;
  readonly previousRevision?: string;
  readonly revision: string;
  readonly startedAt: string;
  readonly status: 'pending' | 'in-progress' | 'failed' | 'completed';
  readonly type: 'threadnote-activation-receipt';
  readonly updatedAt: string;
  readonly version: typeof ACTIVATION_RECEIPT_VERSION;
}

export interface ActivationUndoPlanOperationV1 {
  readonly inputHash: string;
  readonly operationId: string;
  readonly outcomeHash: string;
  readonly subsystemReceiptHash: string;
}

export interface ActivationUndoPlanV1 {
  readonly activationId: string;
  readonly operations: readonly ActivationUndoPlanOperationV1[];
  readonly planHash: string;
  readonly receiptRevision: string;
  readonly requiresApproval: 'undo-apply';
  readonly retainedOperationIds: readonly string[];
  readonly type: 'threadnote-activation-undo-plan';
  readonly undoPlanHash: string;
  readonly version: typeof ACTIVATION_RECEIPT_VERSION;
}

export interface ActivationUndoApprovalV1 {
  readonly approved: true;
  readonly receiptRevision: string;
  readonly type: 'threadnote-activation-undo-approval';
  readonly undoPlanHash: string;
  readonly version: typeof ACTIVATION_RECEIPT_VERSION;
}

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const BoundedVersion = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.makeFilter(value =>
    EffectArray.some([...value], character => {
      const code =
        Effect.pipe(
          character,
          EffectString.codePointAt(0),
          Effect.Option.getOrElse(() => undefined),
        ) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
      ? 'Expected text without control characters.'
      : undefined,
  ),
);
const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u));
const Attempt = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 1_000}));
const Generation = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 10_000}));
const Duration = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: ACTIVATION_MAX_DURATION_MILLISECONDS}));

const ActivationPlanOperationV1Schema = Schema.Struct({
  approvalKind: Schema.optionalKey(Schema.Literals(ACTIVATION_APPROVAL_KINDS)),
  dependsOn: Schema.Array(Identifier).check(Schema.isMaxLength(ACTIVATION_MAX_OPERATIONS)),
  expectedOutcome: Schema.Literals(['applied', 'verified']),
  id: Identifier,
  inputHash: Sha256,
  kind: Schema.Literals(ACTIVATION_OPERATION_KINDS),
  reversible: Schema.Boolean,
});

const ActivationPlanV1Schema = Schema.Struct({
  activationId: Sha256,
  catalogSnapshotHash: Sha256,
  operations: Schema.Array(ActivationPlanOperationV1Schema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ACTIVATION_MAX_OPERATIONS),
  ),
  planHash: Sha256,
  primarySurfaceId: Identifier,
  publicationMode: Schema.Literals(['direct', 'proposal']),
  repositoryIdentityHash: Sha256,
  secondarySurfaceId: Identifier,
  selectedSourceSetHash: Sha256,
  taskHash: Sha256,
  teamId: Identifier,
  teamShareStateHash: Sha256,
  threadnoteVersion: BoundedVersion,
  type: Schema.Literal('threadnote-activation-plan'),
  version: Schema.Literal(ACTIVATION_PLAN_VERSION),
});

const ActivationReceiptOperationV1Schema = Schema.Struct({
  approvalHash: Schema.optionalKey(Sha256),
  attempt: Attempt,
  failureCode: Schema.optionalKey(
    Schema.Literals([
      'capability-unavailable',
      'drift-detected',
      'input-invalid',
      'offline-unavailable',
      'operation-failed',
      'verification-failed',
    ]),
  ),
  id: Identifier,
  inputHash: Sha256,
  kind: Schema.Literals(ACTIVATION_OPERATION_KINDS),
  outcomeHash: Schema.optionalKey(Sha256),
  ownership: Schema.optionalKey(Schema.Literals(['activation-created', 'preexisting'])),
  status: Schema.Literals(['pending', 'applied', 'already-current', 'verified', 'failed']),
  subsystemReceiptHash: Schema.optionalKey(Sha256),
  undoEligible: Schema.optionalKey(Schema.Boolean),
});

const ActivationReceiptV1Schema = Schema.Struct({
  activationId: Sha256,
  completedAt: Schema.optionalKey(IsoInstant),
  firstBrief: Schema.optionalKey(
    Schema.Struct({
      completedAt: IsoInstant,
      durationMilliseconds: Duration,
    }),
  ),
  generation: Generation,
  operations: Schema.Array(ActivationReceiptOperationV1Schema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(ACTIVATION_MAX_OPERATIONS),
  ),
  planHash: Sha256,
  previousRevision: Schema.optionalKey(Sha256),
  revision: Sha256,
  startedAt: IsoInstant,
  status: Schema.Literals(['pending', 'in-progress', 'failed', 'completed']),
  type: Schema.Literal('threadnote-activation-receipt'),
  updatedAt: IsoInstant,
  version: Schema.Literal(ACTIVATION_RECEIPT_VERSION),
});

const ActivationUndoPlanOperationV1Schema = Schema.Struct({
  inputHash: Sha256,
  operationId: Identifier,
  outcomeHash: Sha256,
  subsystemReceiptHash: Sha256,
});

const ActivationUndoPlanV1Schema = Schema.Struct({
  activationId: Sha256,
  operations: Schema.Array(ActivationUndoPlanOperationV1Schema).check(Schema.isMaxLength(ACTIVATION_MAX_OPERATIONS)),
  planHash: Sha256,
  receiptRevision: Sha256,
  requiresApproval: Schema.Literal('undo-apply'),
  retainedOperationIds: Schema.Array(Identifier).check(Schema.isMaxLength(ACTIVATION_MAX_OPERATIONS)),
  type: Schema.Literal('threadnote-activation-undo-plan'),
  undoPlanHash: Sha256,
  version: Schema.Literal(ACTIVATION_RECEIPT_VERSION),
});

const ActivationUndoApprovalV1Schema = Schema.Struct({
  approved: Schema.Literal(true),
  receiptRevision: Sha256,
  type: Schema.Literal('threadnote-activation-undo-approval'),
  undoPlanHash: Sha256,
  version: Schema.Literal(ACTIVATION_RECEIPT_VERSION),
});

const STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;

export function parseActivationPlanV1(value: unknown): ActivationPlanV1 {
  const plan = Schema.decodeUnknownSync(ActivationPlanV1Schema, STRICT_PARSE_OPTIONS)(value);
  if (plan.primarySurfaceId === plan.secondarySurfaceId) throw new Error('Activation surfaces must be distinct.');
  if (activationIdV1(plan) !== plan.activationId) throw new Error('Activation ID does not match its target.');
  const ids = new Set<string>();
  for (const operation of plan.operations) {
    if (ids.has(operation.id)) throw new Error('Activation operation IDs must be unique.');
    if (EffectArray.some(operation.dependsOn, dependency => !ids.has(dependency))) {
      throw new Error(`Activation operation ${operation.id} has an unordered dependency.`);
    }
    ids.add(operation.id);
  }
  if (canonicalJson(plan.operations) !== canonicalJson(canonicalActivationOperationsV1(plan))) {
    throw new Error('Activation plan operations do not match the canonical journey.');
  }
  if (activationPlanHashV1(plan) !== plan.planHash) throw new Error('Activation plan hash does not match its body.');
  return plan;
}

export function parseActivationReceiptV1(value: unknown): ActivationReceiptV1 {
  const receipt = Schema.decodeUnknownSync(ActivationReceiptV1Schema, STRICT_PARSE_OPTIONS)(value);
  if (new Set(EffectArray.map(receipt.operations, operation => operation.id)).size !== receipt.operations.length) {
    throw new Error('Activation receipt operation IDs must be unique.');
  }
  for (const operation of receipt.operations) validateReceiptOperation(operation);
  const expectedStatus = activationReceiptStatusV1(receipt.operations);
  if (receipt.status !== expectedStatus) throw new Error('Activation receipt status does not match operation state.');
  if ((receipt.status === 'completed') !== (receipt.completedAt !== undefined)) {
    throw new Error('Only completed activation receipts include completion time.');
  }
  const briefComplete = EffectArray.some(
    receipt.operations,
    operation => operation.kind === 'brief.verify' && operation.status === 'verified',
  );
  if ((receipt.firstBrief !== undefined) !== briefComplete) {
    throw new Error('Activation first-brief timing must match verified brief state.');
  }
  if (activationReceiptRevisionV1(receipt) !== receipt.revision) {
    throw new Error('Activation receipt revision does not match its body.');
  }
  validateReceiptTiming(receipt);
  return receipt;
}

export function parseActivationUndoPlanV1(value: unknown): ActivationUndoPlanV1 {
  const plan = Schema.decodeUnknownSync(ActivationUndoPlanV1Schema, STRICT_PARSE_OPTIONS)(value);
  const operationIds = EffectArray.map(plan.operations, operation => operation.operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error('Activation undo operation IDs must be unique.');
  }
  if (new Set(plan.retainedOperationIds).size !== plan.retainedOperationIds.length) {
    throw new Error('Activation retained operation IDs must be unique.');
  }
  if (EffectArray.some(plan.retainedOperationIds, operationId => operationIds.includes(operationId))) {
    throw new Error('Activation undo and retained operation IDs must be disjoint.');
  }
  if (activationUndoPlanHashV1(plan) !== plan.undoPlanHash) {
    throw new Error('Activation undo plan hash does not match its body.');
  }
  return plan;
}

export function parseActivationUndoApprovalV1(value: unknown): ActivationUndoApprovalV1 {
  return Schema.decodeUnknownSync(ActivationUndoApprovalV1Schema, STRICT_PARSE_OPTIONS)(value);
}

export function activationPlanHashV1(plan: Omit<ActivationPlanV1, 'planHash'> | ActivationPlanV1): string {
  if ('planHash' in plan) {
    const {planHash: _, ...body} = plan;
    return sha256HexSync(canonicalJson(body));
  }
  return sha256HexSync(canonicalJson(plan));
}

export function activationIdV1(
  input: Pick<ActivationPlanInputV1, 'primarySurfaceId' | 'repositoryIdentityHash' | 'secondarySurfaceId' | 'teamId'>,
): string {
  return sha256HexSync(
    canonicalJson({
      primarySurfaceId: input.primarySurfaceId,
      repositoryIdentityHash: input.repositoryIdentityHash,
      secondarySurfaceId: input.secondarySurfaceId,
      teamId: input.teamId,
      version: ACTIVATION_PLAN_VERSION,
    }),
  );
}

export function canonicalActivationOperationsV1(input: ActivationPlanInputV1): readonly ActivationPlanOperationV1[] {
  const activationId = activationIdV1(input);
  const definitions = activationOperationDefinitionsV1(input.publicationMode);
  return EffectArray.map(definitions, (definition, index) => {
    const dependsOn = index === 0 ? [] : [definitions[index - 1].id];
    return {
      ...definition,
      dependsOn,
      inputHash: sha256HexSync(
        canonicalJson({
          activationId,
          catalogSnapshotHash: input.catalogSnapshotHash,
          definition,
          dependsOn,
          publicationMode: input.publicationMode,
          repositoryIdentityHash: input.repositoryIdentityHash,
          selectedSourceSetHash: input.selectedSourceSetHash,
          taskHash: input.taskHash,
          teamShareStateHash: input.teamShareStateHash,
          threadnoteVersion: input.threadnoteVersion,
          version: ACTIVATION_PLAN_VERSION,
        }),
      ),
    };
  });
}

export function activationOperationDefinitionsV1(
  publicationMode: ActivationPlanInputV1['publicationMode'],
): readonly ActivationOperationDefinitionV1[] {
  return [
    {
      expectedOutcome: 'applied',
      id: 'surface-primary',
      kind: 'surface.primary.ensure',
      reversible: true,
    },
    {
      expectedOutcome: 'applied',
      id: 'surface-secondary',
      kind: 'surface.secondary.ensure',
      reversible: true,
    },
    {expectedOutcome: 'applied', id: 'team-share', kind: 'team.ensure', reversible: true},
    {expectedOutcome: 'verified', id: 'imports-preview', kind: 'imports.preview', reversible: false},
    {
      approvalKind: 'imports-reviewed',
      expectedOutcome: 'verified',
      id: 'imports-review',
      kind: 'imports.review',
      reversible: true,
    },
    {expectedOutcome: 'verified', id: 'first-brief', kind: 'brief.verify', reversible: false},
    {expectedOutcome: 'verified', id: 'decision-review', kind: 'decision.review', reversible: false},
    {
      approvalKind: 'decision-apply',
      expectedOutcome: 'applied',
      id: 'decision-apply',
      kind: 'decision.apply',
      reversible: true,
    },
    {
      approvalKind: 'decision-publish',
      expectedOutcome: 'applied',
      id: publicationMode === 'direct' ? 'decision-publish' : 'decision-propose',
      kind: publicationMode === 'direct' ? 'decision.publish' : 'decision.propose',
      reversible: false,
    },
    {expectedOutcome: 'verified', id: 'secondary-proof', kind: 'secondary.prove', reversible: false},
  ];
}

export function activationUndoPlanHashV1(
  plan: Omit<ActivationUndoPlanV1, 'undoPlanHash'> | ActivationUndoPlanV1,
): string {
  if ('undoPlanHash' in plan) {
    const {undoPlanHash: _, ...body} = plan;
    return sha256HexSync(canonicalJson(body));
  }
  return sha256HexSync(canonicalJson(plan));
}

export function activationReceiptRevisionV1(
  receipt: Omit<ActivationReceiptV1, 'revision'> | ActivationReceiptV1,
): string {
  if ('revision' in receipt) {
    const {revision: _, ...body} = receipt;
    return sha256HexSync(canonicalJson(body));
  }
  return sha256HexSync(canonicalJson(receipt));
}

export function activationReceiptStatusV1(
  operations: readonly ActivationReceiptOperationV1[],
): ActivationReceiptV1['status'] {
  if (EffectArray.every(operations, operation => operationIsComplete(operation.status))) return 'completed';
  if (EffectArray.some(operations, operation => operation.status === 'failed')) return 'failed';
  if (EffectArray.every(operations, operation => operation.status === 'pending')) return 'pending';
  return 'in-progress';
}

export function operationIsComplete(status: ActivationReceiptOperationV1['status']): boolean {
  return status === 'applied' || status === 'already-current' || status === 'verified';
}

function validateReceiptOperation(operation: ActivationReceiptOperationV1): void {
  if (operation.status === 'pending') {
    if (operation.attempt !== 0 || receiptOutcomeFields(operation).length > 0) {
      throw new Error(`Pending activation operation ${operation.id} cannot include outcome evidence.`);
    }
    return;
  }
  if (operation.attempt < 1 || operation.outcomeHash === undefined) {
    throw new Error(`Attempted activation operation ${operation.id} requires outcome evidence.`);
  }
  if (operation.status === 'failed') {
    if (operation.failureCode === undefined || successFields(operation).length > 0) {
      throw new Error(`Failed activation operation ${operation.id} has invalid evidence.`);
    }
    return;
  }
  if (
    operation.failureCode !== undefined ||
    operation.ownership === undefined ||
    operation.subsystemReceiptHash === undefined ||
    operation.undoEligible === undefined
  ) {
    throw new Error(`Successful activation operation ${operation.id} has invalid evidence.`);
  }
  if (operation.undoEligible && operation.ownership !== 'activation-created') {
    throw new Error(`Activation operation ${operation.id} can only undo activation-created state.`);
  }
}

function receiptOutcomeFields(operation: ActivationReceiptOperationV1): unknown[] {
  return EffectArray.filter(
    [
      operation.approvalHash,
      operation.failureCode,
      operation.outcomeHash,
      operation.ownership,
      operation.subsystemReceiptHash,
      operation.undoEligible,
    ],
    value => value !== undefined,
  );
}

function successFields(operation: ActivationReceiptOperationV1): unknown[] {
  return EffectArray.filter(
    [operation.ownership, operation.subsystemReceiptHash, operation.undoEligible],
    value => value !== undefined,
  );
}

function validateReceiptTiming(receipt: ActivationReceiptV1): void {
  const startedAt = Date.parse(receipt.startedAt);
  const updatedAt = Date.parse(receipt.updatedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt) || updatedAt < startedAt) {
    throw new Error('Activation receipt update time cannot precede its start.');
  }
  if (receipt.completedAt !== undefined && receipt.completedAt !== receipt.updatedAt) {
    throw new Error('Activation completion time must match its final update.');
  }
  if (receipt.firstBrief !== undefined) {
    const briefAt = Date.parse(receipt.firstBrief.completedAt);
    if (
      !Number.isFinite(briefAt) ||
      briefAt - startedAt !== receipt.firstBrief.durationMilliseconds ||
      briefAt > updatedAt
    ) {
      throw new Error('Activation first-brief timing is inconsistent.');
    }
  }
}
