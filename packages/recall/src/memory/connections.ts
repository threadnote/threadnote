import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {DateTime, Effect} from 'effect';
import {
  MEMORY_RELATION_TYPES,
  isMemoryRelationType,
  parseMemoryDocument,
  type MemoryRecord,
  type MemoryRelationType,
} from '@threadnote/memory/document';
import {isMemoryId, memoryIdentityAlias, memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {
  loadMemoryRelocationIdentityWitnesses,
  readMemoryWithRelocations,
  type MemoryRelocationIdentityWitnessCandidate,
} from '@threadnote/memory/relocation';
import {parseResourceId, resourceIdIsManagedMemoryNamespace} from '@threadnote/store/resource-id';
import type {MemoryStatus} from '@threadnote/memory/types';
import {recallCandidateIsEligible, type RecallEligibilityPolicy} from '../eligibility.js';
import {
  loadRecallIndexData,
  loadRecallMemoryIdentities,
  loadRecallMemoryLinks,
  recallUriMatchesScopes,
} from '../index.js';
import {classifyMemoryIdentityCandidates} from './identity.js';
import type {RecallMemoryLinkMatch} from './links.js';
import {recallMemoryContentHash, type RecallCandidate} from '../rank.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const MAX_RECALL_MEMORY_REFS = 8;
export const MAX_RECALL_MEMORY_CONNECTIONS = 8;

export type RecallMemoryPremiseState = 'conflicted' | 'current' | 'historical' | 'unresolved';
export type RecallMemoryConnectionDirection = 'incoming' | 'outgoing';
export type RecallMemoryConnectionResolution = 'conflicted' | 'resolved' | 'unresolved';

export interface RecallMemoryConnectionInput {
  readonly memoryRefs: readonly string[];
  readonly relationTypes?: readonly string[];
}

export interface ParsedRecallMemoryConnectionInput {
  readonly memoryRefs: readonly string[];
  readonly relationTypes?: readonly MemoryRelationType[];
}

export interface RecallMemoryPremiseEvidence {
  readonly activeSupersederCount?: number;
  readonly identityConflict?: boolean;
  readonly resolved: boolean;
  readonly status?: MemoryStatus;
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface RecallMemoryPremiseReceiptV1 {
  readonly memoryId?: string;
  readonly requestedOrdinal: number;
  readonly requestedRef: string;
  readonly state: RecallMemoryPremiseState;
  readonly uri?: string;
}

export interface RecallMemoryConnectionReceiptV1 {
  readonly currentness: RecallMemoryPremiseState;
  readonly direction: RecallMemoryConnectionDirection;
  readonly distance: 1;
  readonly neighborMemoryId?: string;
  readonly neighborUri?: string;
  readonly origin: 'evidence' | 'references' | 'relation' | 'supersedes';
  readonly relationOrdinal: number;
  readonly relationType: MemoryRelationType;
  readonly requestedOrdinal: number;
  readonly resolution: RecallMemoryConnectionResolution;
  readonly sourceMemoryId?: string;
  readonly sourceUri?: string;
  readonly targetMemoryId?: string;
  readonly targetUri?: string;
}

export interface RecallMemoryConnectionCoverageV1 {
  readonly connectionCount: number;
  readonly premiseCount: number;
  readonly resultCount: number;
  readonly truncated: boolean;
  readonly truncatedSeedOrdinals?: readonly number[];
  readonly version: 1;
}

export interface RecallMemoryConnectionDiagnostics {
  readonly canonicalMismatches: number;
  readonly canonicalRereads: number;
  readonly currentnessTruncatedMemoryIds?: readonly string[];
  readonly rawLinkRows: number;
  readonly refreshRepairs: number;
  readonly truncatedSeedOrdinals: readonly number[];
}

export interface RecallMemoryConnectionsResult {
  readonly candidates: readonly RecallCandidate[];
  readonly connections: readonly RecallMemoryConnectionReceiptV1[];
  readonly coverage: RecallMemoryConnectionCoverageV1;
  readonly diagnostics: RecallMemoryConnectionDiagnostics;
  readonly premises: readonly RecallMemoryPremiseReceiptV1[];
}

export interface RetrieveRecallMemoryConnectionsInput<R> extends RecallMemoryConnectionInput {
  readonly allowedUriScopes: readonly string[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly includeHistorical?: boolean;
  readonly limit?: number;
  readonly now?: Date;
  readonly readRecords: (uris: readonly string[]) => Effect.Effect<readonly MemoryRecord[], unknown, R>;
}

interface RecallMemoryConnectionsConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

interface ResolvedConnection {
  readonly candidate?: RecallCandidate;
  readonly memoryId?: string;
  readonly receipt: RecallMemoryConnectionReceiptV1;
}

interface ResolvedRequestedPremise {
  readonly memoryId?: string;
  readonly requestedRef: string;
  readonly witnessedCandidate?: RecallCandidate;
  readonly witnessedRecord?: MemoryRecord;
}

const CONNECTION_RECEIPT_LIMIT = 32;
const CONNECTION_CANDIDATE_LIMIT = 64;
const ACTIVE_SUPERSEDER_PROOF_LIMIT_PER_MEMORY = 2;
const RELATION_PRIORITY: Readonly<Record<MemoryRelationType, number>> = {
  depends_on: 1,
  evidence_for: 0,
  references: 3,
  related_to: 4,
  supersedes: 2,
};

/**
 * Parse the explicit connection-recall controls before any index or filesystem
 * work. Raw stable memory IDs, identity aliases, and canonical managed-memory
 * URIs are the only valid premise forms; arbitrary resources must not become
 * graph traversal roots.
 */
export function parseRecallMemoryConnectionInput(
  input: RecallMemoryConnectionInput,
): ParsedRecallMemoryConnectionInput {
  const memoryRefs = uniqueStrings(
    EffectArray.map(uniqueStrings(input.memoryRefs, 'memory reference'), normalizeRecallMemoryReference),
    'memory reference',
  );
  if (memoryRefs.length === 0) throw new Error('Recall memory connections require at least one memory reference.');
  if (memoryRefs.length > MAX_RECALL_MEMORY_REFS) {
    throw new Error(`Recall memory connections accept at most ${MAX_RECALL_MEMORY_REFS} memory references.`);
  }

  const relationTypes = input.relationTypes
    ? EffectArray.map(uniqueStrings(input.relationTypes, 'memory relation type'), value => {
        if (!isMemoryRelationType(value)) {
          throw new Error(
            `Unknown memory relation type "${value}". Expected one of: ${EffectArray.join(MEMORY_RELATION_TYPES, ', ')}.`,
          );
        }
        return value;
      })
    : undefined;

  return {
    memoryRefs,
    ...(relationTypes && relationTypes.length > 0 ? {relationTypes: [...relationTypes].sort(compareCodeUnits)} : {}),
  };
}

function normalizeRecallMemoryReference(ref: string): string {
  if (isMemoryId(ref)) return memoryIdentityAlias(ref);
  let resource: ReturnType<typeof parseResourceId>;
  try {
    resource = parseResourceId(ref);
  } catch {
    throw new Error(`Invalid memory reference: ${ref}`);
  }
  if (resource.anchor !== undefined) {
    throw new Error(`Recall memory reference must identify a whole managed memory: ${ref}`);
  }
  const canonicalUri = resource.canonicalUri;
  if (memoryIdFromIdentityAlias(canonicalUri) === undefined && !resourceIdIsManagedMemoryNamespace(canonicalUri)) {
    throw new Error(`Recall memory reference must identify a managed memory: ${ref}`);
  }
  return canonicalUri;
}

/** Currentness is evidence-derived and deliberately independent of ranking freshness. */
export function classifyRecallMemoryPremiseState(
  evidence: RecallMemoryPremiseEvidence,
  now: Date,
): RecallMemoryPremiseState {
  if (!evidence.resolved) return 'unresolved';
  if (evidence.identityConflict || (evidence.activeSupersederCount ?? 0) > 1) return 'conflicted';
  if ((evidence.status ?? 'active') !== 'active') return 'historical';
  if (!dateWindowContains(now, evidence.validFrom, evidence.validTo)) return 'historical';
  if ((evidence.activeSupersederCount ?? 0) === 1) return 'historical';
  return 'current';
}

/**
 * Resolve explicit premises and their verified, authorized, direct neighbors.
 * The index is only a selector: canonical records decide identity, edge
 * existence, lifecycle, and whether a receipt may claim current authority.
 */
export const retrieveRecallMemoryConnections = Effect.fn('recall.retrieveMemoryConnections')(function* <R>(
  config: RecallMemoryConnectionsConfig,
  input: RetrieveRecallMemoryConnectionsInput<R>,
) {
  const parsed = parseRecallMemoryConnectionInput(input);
  if (input.allowedUriScopes.length === 0) {
    throw new Error('Recall memory connections require at least one authorized URI scope.');
  }
  const now = input.now ?? (yield* DateTime.nowAsDate);
  const limit = boundedConnectionResultLimit(input.limit);
  const requestedCanonicalUris = EffectArray.filter(
    EffectArray.map(parsed.memoryRefs, ref => parseResourceId(ref).canonicalUri),
    ref => memoryIdFromIdentityAlias(ref) === undefined && recallUriMatchesScopes(ref, input.allowedUriScopes),
  );
  const requestedRecords = yield* input.readRecords(requestedCanonicalUris);
  const canonicalRecordByUri = new Map(EffectArray.map(requestedRecords, record => [record.uri, record] as const));
  const requestedRecordByUri = new Map(
    EffectArray.map(
      EffectArray.filter(
        requestedRecords,
        (record, __effectArrayIndex) => __effectArrayIndex in requestedRecords && authorizedRecord(record, input),
      ),
      record => [record.uri, record] as const,
    ),
  );
  const requestedPremises = yield* resolveRequestedPremises(config, parsed.memoryRefs, requestedRecordByUri, input);
  for (const premise of requestedPremises) {
    if (premise.witnessedRecord) canonicalRecordByUri.set(premise.witnessedRecord.uri, premise.witnessedRecord);
  }
  const requestedMemoryIds = EffectArray.flatMap(requestedPremises, premise =>
    premise.memoryId ? [premise.memoryId] : [],
  );
  const premiseIndex =
    requestedMemoryIds.length === 0
      ? undefined
      : yield* loadRecallIndexData(config, {
          allowedUriScopes: input.allowedUriScopes,
          eligibility: input.eligibility,
          includeInactive: true,
          memoryIds: requestedMemoryIds,
          validateNow: true,
        });
  const witnessedPremiseCandidates = EffectArray.flatMap(requestedPremises, premise =>
    premise.witnessedCandidate ? [premise.witnessedCandidate] : [],
  );
  const premiseCandidates = mergeRecallCandidates(premiseIndex?.candidates ?? [], witnessedPremiseCandidates);
  const premiseCandidatesById = groupCandidatesByMemoryId(premiseCandidates);
  const premiseCandidateUris = [
    ...new Set(
      EffectArray.flatMap(premiseCandidates, (__effectFlatMapValue, __effectFlatMapIndex) =>
        __effectFlatMapIndex in premiseCandidates ? candidateUrisForRead(__effectFlatMapValue) : [],
      ),
    ),
  ];
  const unreadPremiseCandidateUris = EffectArray.filter(premiseCandidateUris, uri => !canonicalRecordByUri.has(uri));
  const newlyReadPremiseRecords =
    unreadPremiseCandidateUris.length === 0 ? [] : yield* input.readRecords(unreadPremiseCandidateUris);
  for (const record of newlyReadPremiseRecords) canonicalRecordByUri.set(record.uri, record);
  const premiseLiveRecords = EffectArray.flatMap(premiseCandidateUris, uri => {
    const record = canonicalRecordByUri.get(uri);
    return record ? [record] : [];
  });
  const verifiedPremises = verifyLiveRecallCandidates(premiseCandidates, premiseLiveRecords, input);
  const premiseSeeds = EffectArray.flatMap(requestedPremises, ({memoryId}, requestedOrdinal) =>
    memoryId && verifiedPremises.liveCandidateById.has(memoryId) && !verifiedPremises.conflictIds.has(memoryId)
      ? [{memoryId, requestedOrdinal}]
      : [],
  );
  const witnessedPremiseSources = EffectArray.flatMap(requestedPremises, (premise, requestedOrdinal) =>
    premise.memoryId !== undefined && premise.witnessedRecord !== undefined
      ? [{memoryId: premise.memoryId, requestedOrdinal, uri: premise.witnessedRecord.uri}]
      : [],
  );

  let canonicalMismatches = 0;
  let canonicalRereads = requestedCanonicalUris.length + unreadPremiseCandidateUris.length;
  let rawLinkRows = 0;
  let refreshRepairs = 0;
  let truncatedSeedOrdinals: readonly number[] = [];
  const rawLinks =
    premiseSeeds.length === 0
      ? []
      : yield* loadRecallMemoryLinks(config, {
          allowedUriScopes: input.allowedUriScopes,
          eligibility: input.eligibility,
          includeInactive: true,
          // Preserve bounded canonical backfill within each selector lane.
          // Multi-premise global exhaustion remains explicit in coverage.
          limit: CONNECTION_CANDIDATE_LIMIT,
          memorySeeds: premiseSeeds,
          onCanonicalMismatch: count => {
            canonicalMismatches += count;
          },
          onCanonicalReread: count => {
            canonicalRereads += count;
          },
          onCanonicalRecords: records => {
            for (const record of records) canonicalRecordByUri.set(record.uri, record);
          },
          onRawRows: count => {
            rawLinkRows += count;
          },
          onRefreshRepair: () => {
            refreshRepairs += 1;
          },
          onSearchTruncated: ordinals => {
            truncatedSeedOrdinals = [...new Set([...truncatedSeedOrdinals, ...ordinals])].sort((a, b) => a - b);
          },
          relationTypes: parsed.relationTypes,
          witnessedSources: witnessedPremiseSources,
        });
  const linkedMemoryIds = EffectArray.flatMap(rawLinks, link =>
    EffectArray.filter([link.sourceMemoryId, link.targetMemoryId], isString),
  );
  const allMemoryIds = [...new Set([...requestedMemoryIds, ...linkedMemoryIds])];
  const index =
    allMemoryIds.length === 0
      ? undefined
      : yield* loadRecallIndexData(config, {
          allowedUriScopes: input.allowedUriScopes,
          eligibility: input.eligibility,
          includeInactive: true,
          memoryIds: allMemoryIds,
          validateNow: true,
        });
  const indexedCandidates = mergeRecallCandidates(index?.candidates ?? [], witnessedPremiseCandidates);
  const candidateUris = [
    ...new Set(
      EffectArray.flatMap(indexedCandidates, (__effectFlatMapValue, __effectFlatMapIndex) =>
        __effectFlatMapIndex in indexedCandidates ? candidateUrisForRead(__effectFlatMapValue) : [],
      ),
    ),
  ];
  const unreadCandidateUris = EffectArray.filter(candidateUris, uri => !canonicalRecordByUri.has(uri));
  canonicalRereads += unreadCandidateUris.length;
  const newlyReadCandidateRecords =
    unreadCandidateUris.length === 0 ? [] : yield* input.readRecords(unreadCandidateUris);
  for (const record of newlyReadCandidateRecords) canonicalRecordByUri.set(record.uri, record);
  const liveRecords = EffectArray.flatMap(candidateUris, uri => {
    const record = canonicalRecordByUri.get(uri);
    return record ? [record] : [];
  });
  const verifiedCandidates = verifyLiveRecallCandidates(indexedCandidates, liveRecords, input);
  const liveCandidateById = verifiedCandidates.liveCandidateById;
  const conflictIds = verifiedCandidates.conflictIds;
  const finalPremiseSeeds = EffectArray.filter(
    premiseSeeds,
    seed => liveCandidateById.has(seed.memoryId) && !conflictIds.has(seed.memoryId),
  );
  const finalPremiseIdByOrdinal = new Map(
    EffectArray.map(finalPremiseSeeds, seed => [seed.requestedOrdinal, seed.memoryId] as const),
  );
  const verifiedRawLinks = EffectArray.filter(rawLinks, link => {
    const premiseId = finalPremiseIdByOrdinal.get(link.requestedOrdinal);
    return (
      premiseId !== undefined &&
      (link.direction === 'outgoing' ? link.sourceMemoryId === premiseId : link.targetMemoryId === premiseId)
    );
  });
  const verifiedLinkedMemoryIds = EffectArray.flatMap(verifiedRawLinks, link =>
    EffectArray.filter([link.sourceMemoryId, link.targetMemoryId], isString),
  );

  const currentnessIds = [
    ...new Set([...EffectArray.map(finalPremiseSeeds, seed => seed.memoryId), ...verifiedLinkedMemoryIds]),
  ];
  const currentnessIdSet = new Set(currentnessIds);
  let witnessedCurrentnessTruncated = false;
  const witnessedSupersederLinks =
    witnessedPremiseSources.length === 0
      ? []
      : yield* loadRecallMemoryLinks(config, {
          allowedUriScopes: input.allowedUriScopes,
          directions: ['outgoing'],
          eligibility: input.eligibility,
          includeInactive: true,
          limit: witnessedPremiseSources.length * CONNECTION_CANDIDATE_LIMIT,
          limitPerSeed: CONNECTION_CANDIDATE_LIMIT,
          memorySeeds: witnessedPremiseSources,
          onCanonicalMismatch: count => {
            canonicalMismatches += count;
          },
          onCanonicalReread: count => {
            canonicalRereads += count;
          },
          onCanonicalRecords: records => {
            for (const record of records) canonicalRecordByUri.set(record.uri, record);
          },
          onRawRows: count => {
            rawLinkRows += count;
          },
          onRefreshRepair: () => {
            refreshRepairs += 1;
          },
          onSearchTruncated: ordinals => {
            witnessedCurrentnessTruncated ||= ordinals.length > 0;
          },
          relationTypes: ['supersedes'],
          sourceCurrentAt: now,
          witnessedSources: witnessedPremiseSources,
        });
  let currentnessTruncatedOrdinals: readonly number[] = [];
  const indexedSupersederLinks =
    currentnessIds.length === 0
      ? []
      : yield* loadRecallMemoryLinks(config, {
          allowedUriScopes: input.allowedUriScopes,
          eligibility: input.eligibility,
          directions: ['incoming'],
          includeInactive: true,
          limit: currentnessIds.length * ACTIVE_SUPERSEDER_PROOF_LIMIT_PER_MEMORY,
          limitPerSeed: ACTIVE_SUPERSEDER_PROOF_LIMIT_PER_MEMORY,
          memorySeeds: EffectArray.map(currentnessIds, (memoryId, requestedOrdinal) => ({memoryId, requestedOrdinal})),
          onCanonicalMismatch: count => {
            canonicalMismatches += count;
          },
          onCanonicalReread: count => {
            canonicalRereads += count;
          },
          onCanonicalRecords: records => {
            for (const record of records) canonicalRecordByUri.set(record.uri, record);
          },
          onRawRows: count => {
            rawLinkRows += count;
          },
          onRefreshRepair: () => {
            refreshRepairs += 1;
          },
          onSearchTruncated: ordinals => {
            currentnessTruncatedOrdinals = [...new Set([...currentnessTruncatedOrdinals, ...ordinals])].sort(
              (a, b) => a - b,
            );
          },
          relationTypes: ['supersedes'],
          sourceCurrentAt: now,
        });
  const supersederLinks = deduplicateSupersederLinks([
    ...indexedSupersederLinks,
    ...EffectArray.filter(verifiedRawLinks, link => link.relationType === 'supersedes'),
    ...EffectArray.filter(
      witnessedSupersederLinks,
      (link, __effectArrayIndex2) =>
        __effectArrayIndex2 in witnessedSupersederLinks &&
        (link.targetMemoryId === undefined ? false : currentnessIdSet.has(link.targetMemoryId)),
    ),
  ]);
  const currentnessTruncatedMemoryIds = new Set(
    witnessedCurrentnessTruncated
      ? currentnessIds
      : EffectArray.flatMap(currentnessTruncatedOrdinals, ordinal => {
          const memoryId = currentnessIds[ordinal];
          return memoryId === undefined ? [] : [memoryId];
        }),
  );
  const missingSupersederIds = [
    ...new Set(
      EffectArray.filter(
        EffectArray.map(supersederLinks, link => link.sourceMemoryId),
        memoryId => !liveCandidateById.has(memoryId) && !conflictIds.has(memoryId),
      ),
    ),
  ];
  if (missingSupersederIds.length > 0) {
    const supersederIndex = yield* loadRecallIndexData(config, {
      allowedUriScopes: input.allowedUriScopes,
      eligibility: input.eligibility,
      includeInactive: true,
      memoryIds: missingSupersederIds,
      validateNow: true,
    });
    const supersederUris = [
      ...new Set(
        EffectArrayPipe(supersederIndex.candidates, __effectFlatMapValues =>
          EffectArray.flatMap(__effectFlatMapValues, (value, __effectFlatMapIndex2) =>
            __effectFlatMapIndex2 in __effectFlatMapValues ? candidateUrisForRead(value) : [],
          ),
        ),
      ),
    ];
    const unreadSupersederUris = EffectArray.filter(supersederUris, uri => !canonicalRecordByUri.has(uri));
    canonicalRereads += unreadSupersederUris.length;
    const newlyReadSupersederRecords =
      unreadSupersederUris.length === 0 ? [] : yield* input.readRecords(unreadSupersederUris);
    for (const record of newlyReadSupersederRecords) canonicalRecordByUri.set(record.uri, record);
    const supersederRecords = EffectArray.flatMap(supersederUris, uri => {
      const record = canonicalRecordByUri.get(uri);
      return record ? [record] : [];
    });
    const verifiedSuperseders = verifyLiveRecallCandidates(supersederIndex.candidates, supersederRecords, input);
    for (const memoryId of verifiedSuperseders.conflictIds) {
      conflictIds.add(memoryId);
      liveCandidateById.delete(memoryId);
    }
    for (const [memoryId, candidate] of verifiedSuperseders.liveCandidateById) {
      if (!conflictIds.has(memoryId)) liveCandidateById.set(memoryId, candidate);
    }
  }
  const activeSupersedersByTarget = new Map<string, Set<string>>();
  for (const link of supersederLinks) {
    if (!link.targetMemoryId) continue;
    const source = liveCandidateById.get(link.sourceMemoryId);
    if (!source || conflictIds.has(link.sourceMemoryId) || !candidateIsCurrentlyActive(source, now)) continue;
    const sources = activeSupersedersByTarget.get(link.targetMemoryId) ?? new Set<string>();
    sources.add(link.sourceMemoryId);
    activeSupersedersByTarget.set(link.targetMemoryId, sources);
  }
  const stateForId = (memoryId: string | undefined): RecallMemoryPremiseState => {
    if (!memoryId) return 'unresolved';
    if (conflictIds.has(memoryId)) return 'conflicted';
    const candidate = liveCandidateById.get(memoryId);
    if (!candidate) return 'unresolved';
    const activeSupersederCount = activeSupersedersByTarget.get(memoryId)?.size ?? 0;
    if (
      currentnessTruncatedMemoryIds.has(memoryId) &&
      candidateIsCurrentlyActive(candidate, now) &&
      activeSupersederCount < ACTIVE_SUPERSEDER_PROOF_LIMIT_PER_MEMORY
    ) {
      return 'unresolved';
    }
    const state = classifyRecallMemoryPremiseState(
      {
        activeSupersederCount,
        identityConflict: candidate.identityConflict,
        resolved: true,
        status: candidate.status,
        validFrom: candidate.validFrom,
        validTo: candidate.validTo,
      },
      now,
    );
    return state;
  };

  const premises = EffectArray.map(
    requestedPremises,
    ({memoryId, requestedRef}, requestedOrdinal): RecallMemoryPremiseReceiptV1 => {
      const candidate = memoryId ? liveCandidateById.get(memoryId) : undefined;
      const requestedCandidate = memoryId ? premiseCandidatesById.get(memoryId)?.[0] : undefined;
      return {
        ...(memoryId ? {memoryId} : {}),
        requestedOrdinal,
        requestedRef,
        state: stateForId(memoryId),
        ...((candidate?.uri ?? requestedCandidate?.uri) ? {uri: candidate?.uri ?? requestedCandidate?.uri} : {}),
      };
    },
  );

  const resolvedConnections = EffectArray.flatMap(verifiedRawLinks, link =>
    resolveConnection(link, liveCandidateById, conflictIds, stateForId),
  );
  const fairConnections = fairConnectionOrder(deduplicateResolvedConnections(resolvedConnections));
  const selectedCandidates: RecallCandidate[] = [];
  const selectedIds = new Set<string>();
  for (const connection of fairConnections) {
    if (!connection.memoryId || !connection.candidate || selectedIds.has(connection.memoryId)) continue;
    const state = connection.receipt.currentness;
    if (state === 'conflicted' || state === 'unresolved') continue;
    if (state === 'historical' && input.includeHistorical !== true) continue;
    selectedIds.add(connection.memoryId);
    selectedCandidates.push(connection.candidate);
    if (selectedCandidates.length >= limit) break;
  }
  const selectedConnections = EffectArray.map(
    EffectArray.filter(
      fairConnections,
      (connection, __effectArrayIndex) =>
        __effectArrayIndex in fairConnections &&
        (connection.receipt.resolution !== 'resolved' ||
          (connection.memoryId !== undefined && selectedIds.has(connection.memoryId))),
    ).slice(0, CONNECTION_RECEIPT_LIMIT),
    connection => connection.receipt,
  );
  const truncated =
    truncatedSeedOrdinals.length > 0 ||
    currentnessTruncatedMemoryIds.size > 0 ||
    fairConnections.length > selectedConnections.length ||
    selectedIds.size <
      new Set(
        EffectArray.flatMap(fairConnections, connection =>
          connection.memoryId && connection.receipt.resolution === 'resolved' ? [connection.memoryId] : [],
        ),
      ).size;
  return {
    candidates: selectedCandidates,
    connections: selectedConnections,
    coverage: {
      connectionCount: selectedConnections.length,
      premiseCount: premises.length,
      resultCount: selectedCandidates.length,
      truncated,
      ...(truncatedSeedOrdinals.length > 0 ? {truncatedSeedOrdinals} : {}),
      version: 1,
    },
    diagnostics: {
      canonicalMismatches,
      canonicalRereads,
      ...(currentnessTruncatedMemoryIds.size > 0
        ? {currentnessTruncatedMemoryIds: [...currentnessTruncatedMemoryIds].sort(compareCodeUnits)}
        : {}),
      rawLinkRows,
      refreshRepairs,
      truncatedSeedOrdinals,
    },
    premises,
  } satisfies RecallMemoryConnectionsResult;
});

interface CanonicalPremiseFallback {
  readonly expectedMemoryId?: string;
  readonly record: MemoryRecord;
}

const resolveRequestedPremises = Effect.fn('recall.resolveRequestedConnectionPremises')(function* <R>(
  config: RecallMemoryConnectionsConfig,
  requestedRefs: readonly string[],
  directRecordByUri: ReadonlyMap<string, MemoryRecord>,
  input: RetrieveRecallMemoryConnectionsInput<R>,
) {
  const aliasMemoryIds = new Set<string>();
  const canonicalFallbacks = new Map<string, CanonicalPremiseFallback>();
  for (const requestedRef of requestedRefs) {
    const requestedUri = parseResourceId(requestedRef).canonicalUri;
    const aliasMemoryId = memoryIdFromIdentityAlias(requestedUri);
    if (aliasMemoryId !== undefined) {
      aliasMemoryIds.add(aliasMemoryId);
      continue;
    }
    const direct = directRecordByUri.get(requestedUri);
    if (direct?.metadata.memoryId !== undefined || !recallUriMatchesScopes(requestedUri, input.allowedUriScopes)) {
      continue;
    }
    if (direct !== undefined) {
      canonicalFallbacks.set(requestedUri, {record: direct});
      continue;
    }
    const relocated = yield* readMemoryWithRelocations(config, requestedUri, {
      allowedUriScopes: input.allowedUriScopes,
    }).pipe(Effect.option);
    if (relocated._tag === 'None') continue;
    const record = parseMemoryDocument(relocated.value.canonicalUri, relocated.value.content);
    if (!record || !authorizedRecord(record, input)) continue;
    canonicalFallbacks.set(requestedUri, {
      ...(relocated.value.memoryId ? {expectedMemoryId: relocated.value.memoryId} : {}),
      record,
    });
  }

  let witnesses: readonly MemoryRelocationIdentityWitnessCandidate[] = [];
  let indexedResolutions = new Map<string, ReturnType<typeof classifyMemoryIdentityCandidates>>();
  if (canonicalFallbacks.size > 0) {
    const expectedMemoryIds = EffectArray.flatMap([...canonicalFallbacks.values()], fallback =>
      fallback.expectedMemoryId ? [fallback.expectedMemoryId] : [],
    );
    witnesses = yield* loadMemoryRelocationIdentityWitnesses(
      config,
      [...aliasMemoryIds, ...expectedMemoryIds],
      input.allowedUriScopes,
      {destinationUris: EffectArray.map([...canonicalFallbacks.values()], fallback => fallback.record.uri)},
    );
    const identityIds = [
      ...new Set([...aliasMemoryIds, ...expectedMemoryIds, ...EffectArray.map(witnesses, value => value.memoryId)]),
    ];
    const indexed =
      identityIds.length === 0
        ? []
        : yield* loadRecallMemoryIdentities(config, {
            allowedUriScopes: input.allowedUriScopes,
            memoryIds: identityIds,
            validateNow: true,
          });
    indexedResolutions = new Map(
      EffectArray.map(identityIds, memoryId => [
        memoryId,
        classifyMemoryIdentityCandidates(indexed, memoryId, input.allowedUriScopes),
      ]),
    );
  } else if (aliasMemoryIds.size > 0) {
    const indexed = yield* loadRecallMemoryIdentities(config, {
      allowedUriScopes: input.allowedUriScopes,
      memoryIds: [...aliasMemoryIds],
      validateNow: true,
    });
    indexedResolutions = new Map(
      EffectArray.map([...aliasMemoryIds], memoryId => [
        memoryId,
        classifyMemoryIdentityCandidates(indexed, memoryId, input.allowedUriScopes),
      ]),
    );
    const fallbackMemoryIds = EffectArray.filter(
      [...aliasMemoryIds],
      memoryId => indexedResolutions.get(memoryId)?.state === 'not-found',
    );
    if (fallbackMemoryIds.length > 0) {
      witnesses = yield* loadMemoryRelocationIdentityWitnesses(config, fallbackMemoryIds, input.allowedUriScopes);
    }
  }

  const witnessedByRequestedRef = new Map<string, MemoryRelocationIdentityWitnessCandidate>();
  for (const requestedRef of requestedRefs) {
    const requestedUri = parseResourceId(requestedRef).canonicalUri;
    const aliasMemoryId = memoryIdFromIdentityAlias(requestedUri);
    if (aliasMemoryId !== undefined) {
      if (indexedResolutions.get(aliasMemoryId)?.state !== 'not-found') continue;
      const resolution = classifyMemoryIdentityCandidates(witnesses, aliasMemoryId, input.allowedUriScopes);
      const witness =
        resolution.state === 'resolved'
          ? EffectOption.getOrUndefined(
              EffectArray.findFirst(
                witnesses,
                candidate =>
                  candidate.memoryId === aliasMemoryId &&
                  candidate.uri === resolution.uri &&
                  candidate.missingMemoryId &&
                  candidate.identityConflict !== true,
              ),
            )
          : undefined;
      if (witness) witnessedByRequestedRef.set(requestedUri, witness);
      continue;
    }
    const fallback = canonicalFallbacks.get(requestedUri);
    if (!fallback) continue;
    const candidateIds = [
      ...new Set(
        EffectArray.filter(
          EffectArray.filter(
            EffectArray.map(
              EffectArray.filter(
                witnesses,
                candidate => candidate.uri === fallback.record.uri && candidate.missingMemoryId,
              ),
              candidate => candidate.memoryId,
            ),
            memoryId => fallback.expectedMemoryId === undefined || memoryId === fallback.expectedMemoryId,
          ),
          memoryId => indexedResolutions.get(memoryId)?.state === 'not-found',
        ),
      ),
    ];
    if (candidateIds.length !== 1) continue;
    const resolution = classifyMemoryIdentityCandidates(witnesses, candidateIds[0], input.allowedUriScopes);
    const witness =
      resolution.state === 'resolved' && resolution.uri === fallback.record.uri
        ? EffectOption.getOrUndefined(
            EffectArray.findFirst(
              witnesses,
              candidate =>
                candidate.memoryId === candidateIds[0] &&
                candidate.uri === resolution.uri &&
                candidate.missingMemoryId &&
                candidate.identityConflict !== true,
            ),
          )
        : undefined;
    if (witness) witnessedByRequestedRef.set(requestedUri, witness);
  }

  const resolved: ResolvedRequestedPremise[] = [];
  const seenPremises = new Set<string>();
  for (const requestedRef of requestedRefs) {
    const requestedUri = parseResourceId(requestedRef).canonicalUri;
    const directMemoryId = directRecordByUri.get(requestedUri)?.metadata.memoryId;
    const witness = witnessedByRequestedRef.get(requestedUri);
    const memoryId = memoryIdFromIdentityAlias(requestedUri) ?? directMemoryId ?? witness?.memoryId;
    const identity = memoryId ? `memory-id:${memoryId}` : `memory-ref:${requestedUri}`;
    if (seenPremises.has(identity)) continue;
    seenPremises.add(identity);
    resolved.push({
      ...(memoryId ? {memoryId} : {}),
      requestedRef: requestedUri,
      ...(witness
        ? {
            witnessedCandidate: witnessedPremiseCandidate(witness),
            witnessedRecord: witnessedMemoryRecord(witness),
          }
        : {}),
    });
  }
  return resolved;
});

function witnessedMemoryRecord(witness: MemoryRelocationIdentityWitnessCandidate): MemoryRecord {
  return {
    ...witness.record,
    metadata: {...witness.record.metadata, memoryId: witness.memoryId},
  };
}

function witnessedPremiseCandidate(witness: MemoryRelocationIdentityWitnessCandidate): RecallCandidate {
  const metadata = witness.record.metadata;
  return {
    contentHash: recallMemoryContentHash(witness.record.body),
    fields: {
      project: metadata.project,
      topic: metadata.topic,
      workspaceScope: metadata.workspaceScope,
    },
    kind: metadata.kind,
    memoryId: witness.memoryId,
    status: metadata.status,
    text: '',
    timestamp: metadata.timestamp,
    uri: witness.uri,
    validFrom: metadata.validFrom,
    validTo: metadata.validTo,
  };
}

function mergeRecallCandidates(
  indexed: readonly RecallCandidate[],
  witnessed: readonly RecallCandidate[],
): readonly RecallCandidate[] {
  const merged = new Map<string, RecallCandidate>();
  for (const candidate of [...indexed, ...witnessed]) {
    const key = `${candidate.memoryId ?? ''}\u0000${candidate.uri}`;
    if (!merged.has(key)) merged.set(key, candidate);
  }
  return [...merged.values()];
}

function resolveConnection(
  link: RecallMemoryLinkMatch,
  liveCandidateById: ReadonlyMap<string, RecallCandidate>,
  conflictIds: ReadonlySet<string>,
  stateForId: (memoryId: string | undefined) => RecallMemoryPremiseState,
): readonly ResolvedConnection[] {
  const neighborMemoryId = link.direction === 'outgoing' ? link.targetMemoryId : link.sourceMemoryId;
  if (
    link.direction === 'outgoing' &&
    link.targetMemoryId &&
    !liveCandidateById.has(link.targetMemoryId) &&
    !conflictIds.has(link.targetMemoryId)
  ) {
    return [];
  }
  const candidate = neighborMemoryId ? liveCandidateById.get(neighborMemoryId) : undefined;
  const currentness = stateForId(neighborMemoryId);
  const resolution: RecallMemoryConnectionResolution =
    neighborMemoryId !== undefined && conflictIds.has(neighborMemoryId)
      ? 'conflicted'
      : neighborMemoryId === undefined || candidate === undefined
        ? 'unresolved'
        : 'resolved';
  const source = liveCandidateById.get(link.sourceMemoryId);
  const target = link.targetMemoryId ? liveCandidateById.get(link.targetMemoryId) : undefined;
  return [
    {
      ...(candidate ? {candidate} : {}),
      ...(neighborMemoryId ? {memoryId: neighborMemoryId} : {}),
      receipt: {
        currentness,
        direction: link.direction,
        distance: 1,
        ...(neighborMemoryId ? {neighborMemoryId} : {}),
        ...(candidate ? {neighborUri: candidate.uri} : {}),
        origin: link.relationOrigin,
        relationOrdinal: link.relationOrdinal,
        relationType: link.relationType,
        requestedOrdinal: link.requestedOrdinal,
        resolution,
        sourceMemoryId: link.sourceMemoryId,
        sourceUri: source?.uri ?? link.sourceUri,
        ...(link.targetMemoryId ? {targetMemoryId: link.targetMemoryId} : {}),
        ...(target ? {targetUri: target.uri} : {}),
      },
    },
  ];
}

function deduplicateResolvedConnections(connections: readonly ResolvedConnection[]): readonly ResolvedConnection[] {
  const selected = new Map<string, ResolvedConnection>();
  for (const connection of connections) {
    const receipt = connection.receipt;
    const key = EffectArray.join(
      EffectArray.map(
        [
          receipt.requestedOrdinal,
          receipt.direction,
          receipt.sourceMemoryId,
          receipt.neighborMemoryId ?? '',
          receipt.relationType,
          receipt.origin,
          receipt.relationOrdinal,
        ],
        item => (item === null || item === undefined ? '' : String(item)),
      ),
      '\u0000',
    );
    const current = selected.get(key);
    if (!current || compareCodeUnits(receipt.sourceUri ?? '', current.receipt.sourceUri ?? '') < 0) {
      selected.set(key, connection);
    }
  }
  return [...selected.values()];
}

function deduplicateSupersederLinks(links: readonly RecallMemoryLinkMatch[]): readonly RecallMemoryLinkMatch[] {
  const selected = new Map<string, RecallMemoryLinkMatch>();
  for (const link of links) {
    if (link.relationType !== 'supersedes' || link.targetMemoryId === undefined) continue;
    const key = `${link.sourceMemoryId}\u0000${link.targetMemoryId}`;
    if (!selected.has(key)) selected.set(key, link);
  }
  return [...selected.values()];
}

function fairConnectionOrder(connections: readonly ResolvedConnection[]): readonly ResolvedConnection[] {
  const lanes = new Map<number, ResolvedConnection[]>();
  for (const connection of connections) {
    const ordinal = connection.receipt.requestedOrdinal;
    lanes.set(ordinal, [...(lanes.get(ordinal) ?? []), connection]);
  }
  for (const lane of lanes.values()) lane.sort(compareResolvedConnections);
  const ordered: ResolvedConnection[] = [];
  const ordinals = [...lanes.keys()].sort((a, b) => a - b);
  for (let rank = 0; ; rank += 1) {
    let appended = false;
    for (const ordinal of ordinals) {
      const connection = lanes.get(ordinal)?.[rank];
      if (!connection) continue;
      ordered.push(connection);
      appended = true;
    }
    if (!appended) return ordered;
  }
}

function compareResolvedConnections(left: ResolvedConnection, right: ResolvedConnection): number {
  const stateRank: Readonly<Record<RecallMemoryPremiseState, number>> = {
    current: 0,
    historical: 1,
    conflicted: 2,
    unresolved: 3,
  };
  return (
    stateRank[left.receipt.currentness] - stateRank[right.receipt.currentness] ||
    RELATION_PRIORITY[left.receipt.relationType] - RELATION_PRIORITY[right.receipt.relationType] ||
    compareCodeUnits(left.memoryId ?? '', right.memoryId ?? '') ||
    compareCodeUnits(left.receipt.direction, right.receipt.direction) ||
    left.receipt.relationOrdinal - right.receipt.relationOrdinal
  );
}

function groupCandidatesByMemoryId(
  candidates: readonly RecallCandidate[],
): ReadonlyMap<string, readonly RecallCandidate[]> {
  const grouped = new Map<string, RecallCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.memoryId) continue;
    grouped.set(candidate.memoryId, [...(grouped.get(candidate.memoryId) ?? []), candidate]);
  }
  return grouped;
}

function verifyLiveRecallCandidates<R>(
  candidates: readonly RecallCandidate[],
  records: readonly MemoryRecord[],
  input: RetrieveRecallMemoryConnectionsInput<R>,
): {
  readonly conflictIds: Set<string>;
  readonly liveCandidateById: Map<string, RecallCandidate>;
} {
  const candidatesById = groupCandidatesByMemoryId(candidates);
  const liveById = groupLiveRecordsByMemoryId(
    EffectArray.filter(
      records,
      (record, __effectArrayIndex) => __effectArrayIndex in records && authorizedRecord(record, input),
    ),
  );
  const liveCandidateById = new Map<string, RecallCandidate>();
  const conflictIds = new Set<string>();
  for (const [memoryId, indexedCandidates] of candidatesById) {
    const liveRecords = liveById.get(memoryId) ?? [];
    const contentHashes = new Set(EffectArray.map(liveRecords, record => recallMemoryContentHash(record.body)));
    if (
      EffectArray.some(indexedCandidates, candidate => Boolean(candidate.identityConflict)) ||
      contentHashes.size > 1
    ) {
      conflictIds.add(memoryId);
      continue;
    }
    const candidate = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        indexedCandidates,
        __effectArrayValue =>
          !!(indexed =>
            EffectArray.some(
              liveRecords,
              record =>
                candidateUrisForRead(indexed).includes(record.uri) &&
                indexed.contentHash === recallMemoryContentHash(record.body),
            ))(__effectArrayValue),
      ),
    );
    if (candidate) liveCandidateById.set(memoryId, candidate);
  }
  return {conflictIds, liveCandidateById};
}

function groupLiveRecordsByMemoryId(records: readonly MemoryRecord[]): ReadonlyMap<string, readonly MemoryRecord[]> {
  const grouped = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const memoryId = record.metadata.memoryId;
    if (!memoryId) continue;
    grouped.set(memoryId, [...(grouped.get(memoryId) ?? []), record]);
  }
  return grouped;
}

function candidateUrisForRead(candidate: RecallCandidate): readonly string[] {
  return [candidate.uri, ...(candidate.equivalentUris ?? [])];
}

function authorizedRecord<R>(record: MemoryRecord, input: RetrieveRecallMemoryConnectionsInput<R>): boolean {
  return (
    recallUriMatchesScopes(record.uri, input.allowedUriScopes) &&
    (input.eligibility === undefined || recallCandidateIsEligible(input.eligibility, record.metadata))
  );
}

function candidateIsCurrentlyActive(candidate: RecallCandidate, now: Date): boolean {
  return (candidate.status ?? 'active') === 'active' && dateWindowContains(now, candidate.validFrom, candidate.validTo);
}

function boundedConnectionResultLimit(value: number | undefined): number {
  if (value === undefined) return MAX_RECALL_MEMORY_CONNECTIONS;
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_RECALL_MEMORY_CONNECTIONS, Math.max(0, Math.floor(value)));
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function dateWindowContains(now: Date, validFrom: string | undefined, validTo: string | undefined): boolean {
  const nowTime = now.getTime();
  const from = validFrom === undefined ? undefined : Date.parse(validFrom);
  const to = validTo === undefined ? undefined : Date.parse(validTo);
  if (from !== undefined && (!Number.isFinite(from) || nowTime < from)) return false;
  if (to !== undefined && (!Number.isFinite(to) || nowTime > to)) return false;
  return true;
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = Effect2.pipe(raw, EffectString.trim);
    if (!value) throw new Error(`Recall ${label} must not be empty.`);
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
