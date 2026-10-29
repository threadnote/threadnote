import {Schema} from 'effect';
import type {CodeGraphEvidenceCardV1, CodeGraphWorksetQueryResultV2} from '../workset/evidence.js';

export const CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION = 2 as const;

export const CODE_GRAPH_WORKSET_CATALOG_LIMITS = {
  bridgeRecordBytesMaximum: 64 * 1_024,
  bridgeSetBytesMaximum: 64 * 1_024 * 1_024,
  bridgesPerGeneration: 250_000,
  catalogPhysicalBytesMaximum: 4 * 1_024 * 1_024 * 1_024,
  exactKeysPerSymbol: 256,
  lookupKeysPerSymbol: 64,
  membersPerGeneration: 4_096,
  projectionBytesMaximum: 512 * 1_024 * 1_024,
  projectionPageBytesMaximum: 8 * 1_024 * 1_024,
  readPageMaximum: 1_000,
  resultSetBytesMaximum: 2 * 1_024 * 1_024,
  resultSetCardBytesMaximum: 64 * 1_024,
  resultSetCardsMaximum: 512,
  resultSetPageMaximum: 128,
  resultSetTtlMillisecondsDefault: 30 * 60 * 1_000,
  resultSetTtlMillisecondsMaximum: 24 * 60 * 60 * 1_000,
  resultSetsBytesMaximum: 16 * 1_024 * 1_024,
  resultSetsMaximum: 128,
  symbolsPerProjection: 250_000,
  termsPerSymbol: 64,
} as const;

export type CodeGraphWorksetCatalogErrorReason =
  'busy' | 'capacity' | 'corrupt' | 'expired' | 'incompatible' | 'invalid-input' | 'missing' | 'stale' | 'storage';

export class CodeGraphWorksetCatalogError extends Schema.TaggedError<
  CodeGraphWorksetCatalogError,
  {readonly brand: unique symbol}
>()('CodeGraphWorksetCatalogError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
  reason: Schema.Literals([
    'busy',
    'capacity',
    'corrupt',
    'expired',
    'incompatible',
    'invalid-input',
    'missing',
    'stale',
    'storage',
  ]),
}) {
  static of(
    reason: CodeGraphWorksetCatalogErrorReason,
    message: string,
    options?: ErrorOptions,
  ): CodeGraphWorksetCatalogError {
    return CodeGraphWorksetCatalogError.make({
      message,
      reason,
      ...(options?.cause === undefined ? {} : {cause: options.cause}),
    });
  }
}

export interface CodeGraphWorksetCatalogSpanV1 {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly line: number;
}

export interface CodeGraphWorksetRoutingTermV1 {
  readonly term: string;
  readonly weight: number;
}

export interface CodeGraphWorksetRoutingSymbolV1 {
  readonly exported: boolean;
  readonly kind: string;
  readonly language: string;
  readonly lookupKeys: readonly string[];
  readonly name: string;
  readonly nodeId: string;
  readonly packageName?: string;
  /** Repository-relative, slash-normalized evidence path. */
  readonly path: string;
  readonly qualifiedName: string;
  readonly span: CodeGraphWorksetCatalogSpanV1;
  readonly terms: readonly CodeGraphWorksetRoutingTermV1[];
}

/** Absent fields are the v1 full-repository receipt, never a scoped wildcard. */
export interface CodeGraphWorksetScopeReceiptV1 {
  readonly scopeId?: string;
  readonly definitionDigest?: string;
  readonly closureDigest?: string;
  readonly completeness?: 'complete' | 'partial' | 'legacy-full';
}

export interface CodeGraphWorksetRoutingProjectionDraftV1 extends CodeGraphWorksetScopeReceiptV1 {
  readonly checkoutId: string;
  readonly commitId: string;
  readonly componentCount: number;
  readonly extractorGeneration: number;
  readonly projectorVersion: typeof CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION;
  readonly repositoryId: string;
  /** Digest of the ready repository snapshot from which this projection was derived. */
  readonly snapshotDigest: string;
  readonly snapshotId: string;
  readonly symbols: readonly CodeGraphWorksetRoutingSymbolV1[];
  readonly worktreeId: string;
}

export interface CodeGraphWorksetRoutingProjectionV1 extends CodeGraphWorksetRoutingProjectionDraftV1 {
  readonly projectionDigest: string;
}

/** Lightweight final projection identity used by page-streaming catalog writers. */
export interface CodeGraphWorksetRoutingProjectionReceiptV1 extends Omit<
  CodeGraphWorksetRoutingProjectionDraftV1,
  'symbols'
> {
  readonly projectionDigest: string;
  readonly symbolCount: number;
}

/** Page-bound symbol-chain state; it never retains previously observed symbols. */
export interface CodeGraphWorksetRoutingProjectionDigestStateV1 {
  readonly chainDigest: string;
  readonly lastNodeId?: string;
  readonly symbolCount: number;
}

export interface CodeGraphWorksetCatalogGenerationMemberV1 {
  readonly projection: CodeGraphWorksetRoutingProjectionV1;
  readonly repositoryKey: string;
}

export interface CodeGraphWorksetCatalogGenerationInputV1 {
  readonly manifestDigest: string;
  readonly members: readonly CodeGraphWorksetCatalogGenerationMemberV1[];
  readonly worksetName: string;
}

export interface CodeGraphWorksetCatalogGenerationIdentityV1 {
  readonly digest: string;
  readonly id: string;
  readonly members: readonly CodeGraphWorksetCatalogGenerationMemberV1[];
}

export interface CodeGraphWorksetCatalogGenerationDigestMemberV1 extends CodeGraphWorksetScopeReceiptV1 {
  readonly projectionDigest: string;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

/** Generation staging input containing only already-staged projection receipts. */
export interface CodeGraphWorksetCatalogGenerationReceiptInputV1 {
  readonly manifestDigest: string;
  readonly members: readonly CodeGraphWorksetCatalogGenerationDigestMemberV1[];
  readonly worksetName: string;
}

export interface CodeGraphWorksetCatalogGenerationReceiptIdentityV1 {
  readonly digest: string;
  readonly id: string;
  readonly members: readonly CodeGraphWorksetCatalogGenerationDigestMemberV1[];
}

export interface CodeGraphWorksetCatalogGenerationReceiptV1 {
  readonly digest: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly memberCount: number;
  readonly state: 'ready' | 'staging';
  readonly worksetName: string;
}

export interface CodeGraphWorksetCatalogPublishedMemberV1 extends CodeGraphWorksetScopeReceiptV1 {
  readonly checkoutId: string;
  readonly commitId: string;
  readonly ordinal: number;
  readonly projectionDigest: string;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotDigest: string;
  readonly snapshotId: string;
  readonly symbolCount: number;
  readonly worktreeId: string;
}

export interface CodeGraphWorksetCatalogPublishedGenerationV1 {
  readonly digest: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly members: readonly CodeGraphWorksetCatalogPublishedMemberV1[];
  readonly worksetName: string;
}

export interface CodeGraphWorksetCatalogRoutingSymbolRecordV1 extends CodeGraphWorksetRoutingSymbolV1 {
  readonly ordinal: number;
  readonly projectionDigest: string;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

export interface CodeGraphWorksetCatalogRoutingSymbolCursorV1 {
  readonly nodeId: string;
  readonly ordinal: number;
}

export interface CodeGraphWorksetCatalogRoutingSymbolPageV1 {
  readonly generationId: string;
  readonly next?: CodeGraphWorksetCatalogRoutingSymbolCursorV1;
  readonly symbols: readonly CodeGraphWorksetCatalogRoutingSymbolRecordV1[];
  readonly worksetName: string;
}

export type CodeGraphWorksetCatalogHealthV1 =
  | {readonly state: 'missing'}
  | {readonly schemaVersion: number; readonly state: 'incompatible'}
  | {readonly detail: string; readonly state: 'corrupt' | 'unavailable'}
  | {
      readonly projectionCount: number;
      readonly publishedWorksets: number;
      readonly readyGenerations: number;
      readonly schemaVersion: number;
      readonly stagingGenerations: number;
      readonly state: 'ok';
    };

export interface CodeGraphWorksetCatalogMaintenanceOptionsV1 {
  /** Delete at most this many retired generations in one call. */
  readonly generationLimit?: number;
  /** Delete at most this many unreferenced projections in one call. */
  readonly projectionLimit?: number;
  /** Optional ISO instant; staging generations older than it are retired first. */
  readonly stagingBefore?: string;
}

export interface CodeGraphWorksetCatalogMaintenanceResultV1 {
  readonly projectionsDeleted: number;
  readonly retiredGenerationsDeleted: number;
  readonly stagingGenerationsRetired: number;
}

export interface CodeGraphWorksetCatalogRecoveryResultV1 {
  readonly previousState: CodeGraphWorksetCatalogHealthV1['state'];
  readonly rebuilt: boolean;
}

export interface CodeGraphQualifiedRefRecordV1 {
  readonly createdAt: string;
  readonly nodeId: string;
  readonly ref: string;
  readonly repositoryId: string;
}

export interface CodeGraphWorksetResultSetGenerationV1 {
  readonly digest: string;
  readonly id: string;
}

export interface CodeGraphWorksetResultSetInputV1 {
  readonly projectorVersion: number;
  /** Full logical V2 result; cards and coverage/snapshot receipts are persisted together. */
  readonly result: CodeGraphWorksetQueryResultV2;
  readonly ttlMilliseconds?: number;
}

export interface CodeGraphWorksetResultSetRegistrationV1 {
  readonly cardCount: number;
  /** Pure callback suitable for `projectCodeGraphWorksetEvidence`. */
  readonly continuationForOffset: (offset: number) => string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly generation: CodeGraphWorksetResultSetGenerationV1;
  readonly id: string;
  readonly initialCursor: string;
  readonly projectorVersion: number;
  readonly totalBytes: number;
  readonly worksetName: string;
}

export interface CodeGraphWorksetResultSetPageV1 {
  readonly cards: readonly CodeGraphEvidenceCardV1[];
  /** Absolute persisted sequence offset, suitable for the response projector. */
  readonly continuationForOffset: (offset: number) => string;
  readonly cursor: string;
  readonly expiresAt: string;
  readonly generation: CodeGraphWorksetResultSetGenerationV1;
  readonly next?: string;
  readonly offset: number;
  readonly projectorVersion: number;
  readonly result: CodeGraphWorksetQueryResultV2;
  readonly resultSetId: string;
  readonly totalCards: number;
  readonly totalBytes: number;
  readonly worksetName: string;
}

export interface CodeGraphWorksetResultSetMaintenanceOptionsV1 {
  /** Delete at most this many result sets in one call. */
  readonly limit?: number;
  /** Canonical ISO instant used as the expiry cutoff. Defaults to now. */
  readonly now?: string;
}

export interface CodeGraphWorksetResultSetMaintenanceResultV1 {
  readonly capacityResultSetsDeleted: number;
  readonly expiredResultSetsDeleted: number;
  readonly remainingBytes: number;
  readonly remainingResultSets: number;
}
