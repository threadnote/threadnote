import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isSharedMemoryUri} from '@threadnote/memory/document';
import {isMemoryId} from '@threadnote/memory/identity-alias';
import {parseResourceId} from '@threadnote/store/resource-id';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const SECOND_SURFACE_PROOF_VERSION = 1 as const;
export const SECOND_SURFACE_PROOF_MAX_RESULTS = 32 as const;
export const SECOND_SURFACE_PROOF_MAX_DURATION_MILLISECONDS = 10 * 60 * 1_000;
export const SECOND_SURFACE_PROOF_MAX_URI_LENGTH = 1_024 as const;

export type SecondSurfaceMcpCapability = 'managed' | 'partial' | 'unsupported';
export type SecondSurfaceAccess = 'local-stdio' | 'remote';

export interface SecondSurfaceSnapshotV1 {
  readonly access: SecondSurfaceAccess;
  readonly capabilitiesFingerprint: string;
  readonly configurationState: 'current' | 'stale' | 'absent';
  readonly mcpCapability: SecondSurfaceMcpCapability;
  readonly mcpConfigFingerprint?: string;
  readonly mcpReceiptFingerprint?: string;
  readonly mcpServerFingerprint?: string;
  readonly surfaceId: string;
}

export interface SecondSurfaceProofContextV1 {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly catalogRevision: string;
  readonly catalogSnapshotHash: string;
  readonly decision: {
    readonly canonicalUri: string;
    readonly contentHash: string;
    readonly memoryId: string;
    readonly publicationReceiptHash: string;
  };
  readonly primary: SecondSurfaceSnapshotV1;
  readonly queryFingerprint: string;
  readonly repositoryIdentityHash: string;
  readonly repositoryState: 'clean' | 'dirty';
  readonly secondary: SecondSurfaceSnapshotV1;
  readonly startedAt: string;
  readonly teamId: string;
  readonly teamShareStateHash: string;
}

interface SecondSurfaceObservationV1 {
  readonly activationReceiptRevision: string;
  readonly capabilitiesFingerprint: string;
  readonly catalogRevision: string;
  readonly catalogSnapshotHash: string;
  readonly invocationId: string;
  readonly mcpConfigFingerprint: string;
  readonly mcpReceiptFingerprint: string;
  readonly mcpServerFingerprint: string;
  readonly observedAt: string;
  readonly repositoryIdentityHash: string;
  readonly responseFingerprint: string;
  readonly surfaceId: string;
  readonly teamShareStateHash: string;
}

export interface SecondSurfaceRecallResultV1 {
  readonly canonicalUri: string;
  readonly identityConflict: boolean;
  readonly memoryId: string;
}

export interface SecondSurfaceRecallObservationV1 extends SecondSurfaceObservationV1 {
  readonly complete: boolean;
  readonly queryFingerprint: string;
  readonly results: readonly SecondSurfaceRecallResultV1[];
  readonly returnedResults: number;
  readonly totalResults: number;
  readonly truncated: boolean;
}

export interface SecondSurfaceReadObservationV1 extends SecondSurfaceObservationV1 {
  readonly canonicalUri: string;
  readonly complete: boolean;
  readonly contentHash: string;
  readonly memoryId: string;
  readonly readable: boolean;
  readonly recallResponseFingerprint: string;
  readonly requestedMemoryId: string;
  readonly requestedUri: string;
  readonly resourceCount: number;
}

export interface SecondSurfaceRecallRequestV1 {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly catalogRevision: string;
  readonly queryFingerprint: string;
  readonly surfaceId: string;
  readonly teamShareStateHash: string;
  readonly type: 'threadnote-second-surface-recall';
  readonly version: typeof SECOND_SURFACE_PROOF_VERSION;
}

export interface SecondSurfaceReadRequestV1 {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly memoryId: string;
  readonly recallResponseFingerprint: string;
  readonly surfaceId: string;
  readonly type: 'threadnote-second-surface-read';
  readonly uri: string;
  readonly version: typeof SECOND_SURFACE_PROOF_VERSION;
}

export type SecondSurfaceProofFailureCode =
  | 'activation-drift'
  | 'catalog-drift'
  | 'configuration-drift'
  | 'duration-exceeded'
  | 'input-invalid'
  | 'mcp-contract-mismatch'
  | 'mcp-missing'
  | 'read-drift'
  | 'read-incomplete'
  | 'read-unreadable'
  | 'recall-ambiguous'
  | 'recall-incomplete'
  | 'recall-truncated'
  | 'remote-dirty-worktree'
  | 'repository-drift'
  | 'same-surface'
  | 'share-drift'
  | 'surface-not-current'
  | 'surface-unsupported'
  | 'time-invalid'
  | 'wrong-memory';

export type SecondSurfaceStepResultV1<Request> =
  | {readonly request: Request; readonly status: 'ready'}
  | {readonly code: SecondSurfaceProofFailureCode; readonly status: 'rejected'};

export interface SecondSurfaceProofReceiptV1 {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly catalogRevision: string;
  readonly catalogSnapshotHash: string;
  readonly completedAt: string;
  readonly decisionCanonicalUri: string;
  readonly decisionContentHash: string;
  readonly decisionMemoryId: string;
  readonly durationMilliseconds: number;
  readonly mcpServerFingerprint: string;
  readonly primaryAccess: SecondSurfaceAccess;
  readonly primaryCapabilitiesFingerprint: string;
  readonly primaryMcpCapability: Exclude<SecondSurfaceMcpCapability, 'unsupported'>;
  readonly primaryMcpConfigFingerprint: string;
  readonly primaryMcpReceiptFingerprint: string;
  readonly primarySurfaceId: string;
  readonly proofHash: string;
  readonly publicationReceiptHash: string;
  readonly queryFingerprint: string;
  readonly readInvocationId: string;
  readonly readResponseFingerprint: string;
  readonly recallCompletedAt: string;
  readonly recallInvocationId: string;
  readonly recallResponseFingerprint: string;
  readonly repositoryIdentityHash: string;
  readonly repositoryState: 'clean' | 'dirty';
  readonly secondaryAccess: SecondSurfaceAccess;
  readonly secondaryCapabilitiesFingerprint: string;
  readonly secondaryMcpCapability: Exclude<SecondSurfaceMcpCapability, 'unsupported'>;
  readonly secondaryMcpConfigFingerprint: string;
  readonly secondaryMcpReceiptFingerprint: string;
  readonly secondarySurfaceId: string;
  readonly startedAt: string;
  readonly teamId: string;
  readonly teamShareStateHash: string;
  readonly type: 'threadnote-second-surface-proof';
  readonly version: typeof SECOND_SURFACE_PROOF_VERSION;
}

export type SecondSurfaceProofResultV1 =
  | {readonly receipt: SecondSurfaceProofReceiptV1; readonly status: 'verified'}
  | {readonly code: SecondSurfaceProofFailureCode; readonly status: 'rejected'};

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u));
const Duration = Schema.Int.check(
  Schema.isBetween({minimum: 0, maximum: SECOND_SURFACE_PROOF_MAX_DURATION_MILLISECONDS}),
);
const MemoryId = Schema.String.check(Schema.isPattern(/^tn_[A-Za-z0-9_-]{1,128}$/u));
const Uri = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SECOND_SURFACE_PROOF_MAX_URI_LENGTH));
const Count = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: SECOND_SURFACE_PROOF_MAX_RESULTS}));

const SecondSurfaceSnapshotV1Schema = Schema.Struct({
  access: Schema.Literals(['local-stdio', 'remote']),
  capabilitiesFingerprint: Sha256,
  configurationState: Schema.Literals(['current', 'stale', 'absent']),
  mcpCapability: Schema.Literals(['managed', 'partial', 'unsupported']),
  mcpConfigFingerprint: Schema.optionalKey(Sha256),
  mcpReceiptFingerprint: Schema.optionalKey(Sha256),
  mcpServerFingerprint: Schema.optionalKey(Sha256),
  surfaceId: Identifier,
});

const SecondSurfaceProofContextV1Schema = Schema.Struct({
  activationId: Sha256,
  activationReceiptRevision: Sha256,
  catalogRevision: Identifier,
  catalogSnapshotHash: Sha256,
  decision: Schema.Struct({
    canonicalUri: Uri,
    contentHash: Sha256,
    memoryId: MemoryId,
    publicationReceiptHash: Sha256,
  }),
  primary: SecondSurfaceSnapshotV1Schema,
  queryFingerprint: Sha256,
  repositoryIdentityHash: Sha256,
  repositoryState: Schema.Literals(['clean', 'dirty']),
  secondary: SecondSurfaceSnapshotV1Schema,
  startedAt: IsoInstant,
  teamId: Identifier,
  teamShareStateHash: Sha256,
});

const ObservationFields = {
  activationReceiptRevision: Sha256,
  capabilitiesFingerprint: Sha256,
  catalogRevision: Identifier,
  catalogSnapshotHash: Sha256,
  invocationId: Sha256,
  mcpConfigFingerprint: Sha256,
  mcpReceiptFingerprint: Sha256,
  mcpServerFingerprint: Sha256,
  observedAt: IsoInstant,
  repositoryIdentityHash: Sha256,
  responseFingerprint: Sha256,
  surfaceId: Identifier,
  teamShareStateHash: Sha256,
} as const;

const SecondSurfaceRecallObservationV1Schema = Schema.Struct({
  ...ObservationFields,
  complete: Schema.Boolean,
  queryFingerprint: Sha256,
  results: Schema.Array(Schema.Struct({canonicalUri: Uri, identityConflict: Schema.Boolean, memoryId: MemoryId})).check(
    Schema.isMaxLength(SECOND_SURFACE_PROOF_MAX_RESULTS),
  ),
  returnedResults: Count,
  totalResults: Count,
  truncated: Schema.Boolean,
});

const SecondSurfaceReadObservationV1Schema = Schema.Struct({
  ...ObservationFields,
  canonicalUri: Uri,
  complete: Schema.Boolean,
  contentHash: Sha256,
  memoryId: MemoryId,
  readable: Schema.Boolean,
  recallResponseFingerprint: Sha256,
  requestedMemoryId: MemoryId,
  requestedUri: Uri,
  resourceCount: Count,
});

const SecondSurfaceProofReceiptV1Schema = Schema.Struct({
  activationId: Sha256,
  activationReceiptRevision: Sha256,
  catalogRevision: Identifier,
  catalogSnapshotHash: Sha256,
  completedAt: IsoInstant,
  decisionCanonicalUri: Uri,
  decisionContentHash: Sha256,
  decisionMemoryId: MemoryId,
  durationMilliseconds: Duration,
  mcpServerFingerprint: Sha256,
  primaryAccess: Schema.Literals(['local-stdio', 'remote']),
  primaryCapabilitiesFingerprint: Sha256,
  primaryMcpCapability: Schema.Literals(['managed', 'partial']),
  primaryMcpConfigFingerprint: Sha256,
  primaryMcpReceiptFingerprint: Sha256,
  primarySurfaceId: Identifier,
  proofHash: Sha256,
  publicationReceiptHash: Sha256,
  queryFingerprint: Sha256,
  readInvocationId: Sha256,
  readResponseFingerprint: Sha256,
  recallCompletedAt: IsoInstant,
  recallInvocationId: Sha256,
  recallResponseFingerprint: Sha256,
  repositoryIdentityHash: Sha256,
  repositoryState: Schema.Literals(['clean', 'dirty']),
  secondaryAccess: Schema.Literals(['local-stdio', 'remote']),
  secondaryCapabilitiesFingerprint: Sha256,
  secondaryMcpCapability: Schema.Literals(['managed', 'partial']),
  secondaryMcpConfigFingerprint: Sha256,
  secondaryMcpReceiptFingerprint: Sha256,
  secondarySurfaceId: Identifier,
  startedAt: IsoInstant,
  teamId: Identifier,
  teamShareStateHash: Sha256,
  type: Schema.Literal('threadnote-second-surface-proof'),
  version: Schema.Literal(SECOND_SURFACE_PROOF_VERSION),
});

const STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;

export function planSecondSurfaceRecallV1(
  suppliedContext: unknown,
): SecondSurfaceStepResultV1<SecondSurfaceRecallRequestV1> {
  const context = decodeContext(suppliedContext);
  if (context === undefined) return rejected('input-invalid');
  return planDecodedRecall(context);
}

function planDecodedRecall(
  context: SecondSurfaceProofContextV1,
): SecondSurfaceStepResultV1<SecondSurfaceRecallRequestV1> {
  const failure = validateContext(context);
  if (failure !== undefined) return rejected(failure);
  return {
    request: {
      activationId: context.activationId,
      activationReceiptRevision: context.activationReceiptRevision,
      catalogRevision: context.catalogRevision,
      queryFingerprint: context.queryFingerprint,
      surfaceId: context.secondary.surfaceId,
      teamShareStateHash: context.teamShareStateHash,
      type: 'threadnote-second-surface-recall',
      version: SECOND_SURFACE_PROOF_VERSION,
    },
    status: 'ready',
  };
}

export function planSecondSurfaceReadV1(
  suppliedContext: unknown,
  suppliedRecall: unknown,
): SecondSurfaceStepResultV1<SecondSurfaceReadRequestV1> {
  const context = decodeContext(suppliedContext);
  const recall = decodeRecall(suppliedRecall);
  if (context === undefined || recall === undefined) return rejected('input-invalid');
  return planDecodedRead(context, recall);
}

function planDecodedRead(
  context: SecondSurfaceProofContextV1,
  recall: SecondSurfaceRecallObservationV1,
): SecondSurfaceStepResultV1<SecondSurfaceReadRequestV1> {
  const contextFailure = validateContext(context);
  if (contextFailure !== undefined) return rejected(contextFailure);
  const observationFailure = validateObservation(context, recall);
  if (observationFailure !== undefined) return rejected(observationFailure);
  if (EffectArray.some(recall.results, result => !isCanonicalUri(result.canonicalUri)))
    return rejected('input-invalid');
  if (recall.queryFingerprint !== context.queryFingerprint) return rejected('read-drift');
  if (!recall.complete) return rejected('recall-incomplete');
  if (
    recall.truncated ||
    recall.returnedResults !== recall.totalResults ||
    recall.returnedResults !== recall.results.length
  ) {
    return rejected('recall-truncated');
  }
  const related = EffectArray.filter(
    recall.results,
    result => result.memoryId === context.decision.memoryId || result.canonicalUri === context.decision.canonicalUri,
  );
  if (related.length === 0) return rejected('wrong-memory');
  if (related.length !== 1 || related[0].identityConflict) return rejected('recall-ambiguous');
  if (!decisionIdentityMatches(context, related[0])) return rejected('wrong-memory');
  return {
    request: {
      activationId: context.activationId,
      activationReceiptRevision: context.activationReceiptRevision,
      memoryId: context.decision.memoryId,
      recallResponseFingerprint: recall.responseFingerprint,
      surfaceId: context.secondary.surfaceId,
      type: 'threadnote-second-surface-read',
      uri: context.decision.canonicalUri,
      version: SECOND_SURFACE_PROOF_VERSION,
    },
    status: 'ready',
  };
}

export function completeSecondSurfaceProofV1(
  suppliedContext: unknown,
  suppliedRecall: unknown,
  suppliedRead: unknown,
): SecondSurfaceProofResultV1 {
  const context = decodeContext(suppliedContext);
  const recall = decodeRecall(suppliedRecall);
  const read = decodeRead(suppliedRead);
  if (context === undefined || recall === undefined || read === undefined) return rejected('input-invalid');
  const readPlan = planDecodedRead(context, recall);
  if (readPlan.status === 'rejected') return readPlan;
  const observationFailure = validateObservation(context, read);
  if (observationFailure !== undefined) return rejected(observationFailure);
  const recallTime = instantMilliseconds(recall.observedAt);
  const readTime = instantMilliseconds(read.observedAt);
  if (recallTime === undefined || readTime === undefined || readTime < recallTime) return rejected('time-invalid');
  if (read.recallResponseFingerprint !== recall.responseFingerprint) return rejected('read-drift');
  if (!read.readable) return rejected('read-unreadable');
  if (!read.complete || read.resourceCount !== 1) return rejected('read-incomplete');
  if (
    read.requestedMemoryId !== readPlan.request.memoryId ||
    read.requestedUri !== readPlan.request.uri ||
    !decisionIdentityMatches(context, read) ||
    read.contentHash !== context.decision.contentHash
  ) {
    return rejected('wrong-memory');
  }
  const started = instantMilliseconds(context.startedAt);
  if (started === undefined) return rejected('time-invalid');
  const durationMilliseconds = readTime - started;
  if (durationMilliseconds > SECOND_SURFACE_PROOF_MAX_DURATION_MILLISECONDS) return rejected('duration-exceeded');
  const primary = context.primary;
  const secondary = context.secondary;
  if (primary.mcpCapability === 'unsupported' || secondary.mcpCapability === 'unsupported') {
    return rejected('surface-unsupported');
  }
  const body = {
    activationId: context.activationId,
    activationReceiptRevision: context.activationReceiptRevision,
    catalogRevision: context.catalogRevision,
    catalogSnapshotHash: context.catalogSnapshotHash,
    completedAt: read.observedAt,
    decisionCanonicalUri: context.decision.canonicalUri,
    decisionContentHash: context.decision.contentHash,
    decisionMemoryId: context.decision.memoryId,
    durationMilliseconds,
    mcpServerFingerprint: secondary.mcpServerFingerprint!,
    primaryAccess: primary.access,
    primaryCapabilitiesFingerprint: primary.capabilitiesFingerprint,
    primaryMcpCapability: primary.mcpCapability,
    primaryMcpConfigFingerprint: primary.mcpConfigFingerprint!,
    primaryMcpReceiptFingerprint: primary.mcpReceiptFingerprint!,
    primarySurfaceId: primary.surfaceId,
    publicationReceiptHash: context.decision.publicationReceiptHash,
    queryFingerprint: context.queryFingerprint,
    readInvocationId: read.invocationId,
    readResponseFingerprint: read.responseFingerprint,
    recallCompletedAt: recall.observedAt,
    recallInvocationId: recall.invocationId,
    recallResponseFingerprint: recall.responseFingerprint,
    repositoryIdentityHash: context.repositoryIdentityHash,
    repositoryState: context.repositoryState,
    secondaryAccess: secondary.access,
    secondaryCapabilitiesFingerprint: secondary.capabilitiesFingerprint,
    secondaryMcpCapability: secondary.mcpCapability,
    secondaryMcpConfigFingerprint: secondary.mcpConfigFingerprint!,
    secondaryMcpReceiptFingerprint: secondary.mcpReceiptFingerprint!,
    secondarySurfaceId: secondary.surfaceId,
    startedAt: context.startedAt,
    teamId: context.teamId,
    teamShareStateHash: context.teamShareStateHash,
    type: 'threadnote-second-surface-proof' as const,
    version: SECOND_SURFACE_PROOF_VERSION,
  };
  try {
    const receipt = parseSecondSurfaceProofReceiptV1({...body, proofHash: secondSurfaceProofHashV1(body)});
    return {receipt, status: 'verified'};
  } catch {
    return rejected('input-invalid');
  }
}

export function parseSecondSurfaceProofReceiptV1(value: unknown): SecondSurfaceProofReceiptV1 {
  const receipt = Schema.decodeUnknownSync(SecondSurfaceProofReceiptV1Schema, STRICT_PARSE_OPTIONS)(value);
  if (receipt.primarySurfaceId === receipt.secondarySurfaceId) throw new Error('Proof surfaces must be distinct.');
  if (!isCanonicalSharedUri(receipt.decisionCanonicalUri)) {
    throw new Error('Proof decision URI must be a canonical shared Threadnote memory URI.');
  }
  if (sharedUriTeam(receipt.decisionCanonicalUri) !== receipt.teamId) {
    throw new Error('Proof decision URI must belong to the bound team.');
  }
  if (receipt.repositoryState === 'dirty' && receipt.secondaryAccess !== 'local-stdio') {
    throw new Error('Dirty-worktree proof must come from local stdio.');
  }
  const started = instantMilliseconds(receipt.startedAt);
  const recalled = instantMilliseconds(receipt.recallCompletedAt);
  const completed = instantMilliseconds(receipt.completedAt);
  if (
    started === undefined ||
    recalled === undefined ||
    completed === undefined ||
    recalled < started ||
    completed < recalled
  ) {
    throw new Error('Proof timestamps must be ordered ISO instants.');
  }
  if (completed - started !== receipt.durationMilliseconds) {
    throw new Error('Proof duration does not match its timestamps.');
  }
  if (secondSurfaceProofHashV1(receipt) !== receipt.proofHash) {
    throw new Error('Proof hash does not match its receipt body.');
  }
  return receipt;
}

export function parseSecondSurfaceProofContextV1(value: unknown): SecondSurfaceProofContextV1 {
  return Schema.decodeUnknownSync(SecondSurfaceProofContextV1Schema, STRICT_PARSE_OPTIONS)(value);
}

export function secondSurfaceProofContextHashV1(context: SecondSurfaceProofContextV1): string {
  return sha256HexSync(canonicalJson(parseSecondSurfaceProofContextV1(context)));
}

export function secondSurfaceProofMatchesContextV1(
  context: SecondSurfaceProofContextV1,
  receipt: SecondSurfaceProofReceiptV1,
): boolean {
  const parsedContext = parseSecondSurfaceProofContextV1(context);
  const parsedReceipt = parseSecondSurfaceProofReceiptV1(receipt);
  return (
    parsedReceipt.activationId === parsedContext.activationId &&
    parsedReceipt.activationReceiptRevision === parsedContext.activationReceiptRevision &&
    parsedReceipt.catalogRevision === parsedContext.catalogRevision &&
    parsedReceipt.catalogSnapshotHash === parsedContext.catalogSnapshotHash &&
    parsedReceipt.decisionCanonicalUri === parsedContext.decision.canonicalUri &&
    parsedReceipt.decisionContentHash === parsedContext.decision.contentHash &&
    parsedReceipt.decisionMemoryId === parsedContext.decision.memoryId &&
    parsedReceipt.publicationReceiptHash === parsedContext.decision.publicationReceiptHash &&
    parsedReceipt.primaryAccess === parsedContext.primary.access &&
    parsedReceipt.primarySurfaceId === parsedContext.primary.surfaceId &&
    parsedReceipt.primaryCapabilitiesFingerprint === parsedContext.primary.capabilitiesFingerprint &&
    parsedReceipt.primaryMcpCapability === parsedContext.primary.mcpCapability &&
    parsedReceipt.primaryMcpConfigFingerprint === parsedContext.primary.mcpConfigFingerprint &&
    parsedReceipt.primaryMcpReceiptFingerprint === parsedContext.primary.mcpReceiptFingerprint &&
    parsedReceipt.queryFingerprint === parsedContext.queryFingerprint &&
    parsedReceipt.repositoryIdentityHash === parsedContext.repositoryIdentityHash &&
    parsedReceipt.repositoryState === parsedContext.repositoryState &&
    parsedReceipt.secondaryAccess === parsedContext.secondary.access &&
    parsedReceipt.secondarySurfaceId === parsedContext.secondary.surfaceId &&
    parsedReceipt.secondaryCapabilitiesFingerprint === parsedContext.secondary.capabilitiesFingerprint &&
    parsedReceipt.secondaryMcpCapability === parsedContext.secondary.mcpCapability &&
    parsedReceipt.secondaryMcpConfigFingerprint === parsedContext.secondary.mcpConfigFingerprint &&
    parsedReceipt.secondaryMcpReceiptFingerprint === parsedContext.secondary.mcpReceiptFingerprint &&
    parsedReceipt.mcpServerFingerprint === parsedContext.secondary.mcpServerFingerprint &&
    parsedReceipt.startedAt === parsedContext.startedAt &&
    parsedReceipt.teamId === parsedContext.teamId &&
    parsedReceipt.teamShareStateHash === parsedContext.teamShareStateHash
  );
}

export function secondSurfaceProofHashV1(
  receipt: Omit<SecondSurfaceProofReceiptV1, 'proofHash'> | SecondSurfaceProofReceiptV1,
): string {
  if ('proofHash' in receipt) {
    const {proofHash: _, ...body} = receipt;
    return sha256HexSync(canonicalJson(body));
  }
  return sha256HexSync(canonicalJson(receipt));
}

function decodeContext(value: unknown): SecondSurfaceProofContextV1 | undefined {
  try {
    return Schema.decodeUnknownSync(SecondSurfaceProofContextV1Schema, STRICT_PARSE_OPTIONS)(value);
  } catch {
    return undefined;
  }
}

function decodeRecall(value: unknown): SecondSurfaceRecallObservationV1 | undefined {
  try {
    return Schema.decodeUnknownSync(SecondSurfaceRecallObservationV1Schema, STRICT_PARSE_OPTIONS)(value);
  } catch {
    return undefined;
  }
}

function decodeRead(value: unknown): SecondSurfaceReadObservationV1 | undefined {
  try {
    return Schema.decodeUnknownSync(SecondSurfaceReadObservationV1Schema, STRICT_PARSE_OPTIONS)(value);
  } catch {
    return undefined;
  }
}

function validateContext(context: SecondSurfaceProofContextV1): SecondSurfaceProofFailureCode | undefined {
  if (
    !isSha256(context.activationId) ||
    !isSha256(context.activationReceiptRevision) ||
    !isIdentifier(context.catalogRevision) ||
    !isSha256(context.catalogSnapshotHash) ||
    !isIdentifier(context.teamId) ||
    !isSha256(context.teamShareStateHash) ||
    !isSha256(context.repositoryIdentityHash) ||
    !isSha256(context.queryFingerprint) ||
    !isMemoryId(context.decision.memoryId) ||
    !isCanonicalSharedUri(context.decision.canonicalUri) ||
    sharedUriTeam(context.decision.canonicalUri) !== context.teamId ||
    !isSha256(context.decision.contentHash) ||
    !isSha256(context.decision.publicationReceiptHash) ||
    instantMilliseconds(context.startedAt) === undefined
  ) {
    return 'input-invalid';
  }
  if (context.repositoryState !== 'clean' && context.repositoryState !== 'dirty') return 'input-invalid';
  if (context.primary.surfaceId === context.secondary.surfaceId) return 'same-surface';
  for (const surface of [context.primary, context.secondary]) {
    if (
      !isIdentifier(surface.surfaceId) ||
      !isSha256(surface.capabilitiesFingerprint) ||
      (surface.access !== 'local-stdio' && surface.access !== 'remote') ||
      !['managed', 'partial', 'unsupported'].includes(surface.mcpCapability) ||
      !['current', 'stale', 'absent'].includes(surface.configurationState)
    ) {
      return 'input-invalid';
    }
    if (surface.mcpCapability === 'unsupported') return 'surface-unsupported';
    if (surface.configurationState !== 'current') return 'surface-not-current';
    if (
      !isSha256(surface.mcpConfigFingerprint) ||
      !isSha256(surface.mcpReceiptFingerprint) ||
      !isSha256(surface.mcpServerFingerprint)
    ) {
      return 'mcp-missing';
    }
  }
  if (context.primary.mcpServerFingerprint !== context.secondary.mcpServerFingerprint) {
    return 'mcp-contract-mismatch';
  }
  if (context.repositoryState === 'dirty' && context.secondary.access !== 'local-stdio') {
    return 'remote-dirty-worktree';
  }
  return undefined;
}

function validateObservation(
  context: SecondSurfaceProofContextV1,
  observation: SecondSurfaceObservationV1,
): SecondSurfaceProofFailureCode | undefined {
  if (
    !isSha256(observation.invocationId) ||
    !isSha256(observation.responseFingerprint) ||
    instantMilliseconds(observation.observedAt) === undefined
  ) {
    return 'input-invalid';
  }
  if (observation.surfaceId !== context.secondary.surfaceId) return 'configuration-drift';
  if (
    observation.catalogRevision !== context.catalogRevision ||
    observation.catalogSnapshotHash !== context.catalogSnapshotHash ||
    observation.capabilitiesFingerprint !== context.secondary.capabilitiesFingerprint
  ) {
    return 'catalog-drift';
  }
  if (observation.activationReceiptRevision !== context.activationReceiptRevision) return 'activation-drift';
  if (observation.repositoryIdentityHash !== context.repositoryIdentityHash) return 'repository-drift';
  if (observation.teamShareStateHash !== context.teamShareStateHash) return 'share-drift';
  if (
    observation.mcpConfigFingerprint !== context.secondary.mcpConfigFingerprint ||
    observation.mcpReceiptFingerprint !== context.secondary.mcpReceiptFingerprint
  ) {
    return 'configuration-drift';
  }
  if (observation.mcpServerFingerprint !== context.secondary.mcpServerFingerprint) {
    return 'mcp-contract-mismatch';
  }
  const started = instantMilliseconds(context.startedAt)!;
  const observed = instantMilliseconds(observation.observedAt)!;
  if (observed < started) return 'time-invalid';
  if (observed - started > SECOND_SURFACE_PROOF_MAX_DURATION_MILLISECONDS) return 'duration-exceeded';
  return undefined;
}

function decisionIdentityMatches(
  context: SecondSurfaceProofContextV1,
  identity: Pick<SecondSurfaceRecallResultV1, 'canonicalUri' | 'memoryId'>,
): boolean {
  return identity.memoryId === context.decision.memoryId && identity.canonicalUri === context.decision.canonicalUri;
}

function isCanonicalSharedUri(value: string): boolean {
  try {
    const parsed = parseResourceId(value);
    return parsed.anchor === undefined && parsed.canonicalUri === value && isSharedMemoryUri(value);
  } catch {
    return false;
  }
}

function isCanonicalUri(value: string): boolean {
  try {
    const parsed = parseResourceId(value);
    return parsed.canonicalUri === value;
  } catch {
    return false;
  }
}

function sharedUriTeam(value: string): string | undefined {
  try {
    const resource = parseResourceId(value);
    return resource.namespace === 'user' && resource.segments[1] === 'memories' && resource.segments[2] === 'shared'
      ? resource.segments[3]
      : undefined;
  } catch {
    return undefined;
  }
}

function instantMilliseconds(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === value ||
    (Effect.pipe(value, EffectString.endsWith('Z')) &&
      canonical === Effect.pipe(value, EffectString.replace(/Z$/u, '.000Z')))
    ? milliseconds
    : undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function rejected(code: SecondSurfaceProofFailureCode) {
  return {code, status: 'rejected' as const};
}
