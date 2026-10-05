import {Crypto, Data, DateTime, Effect, FileSystem, Option, Path} from 'effect';
import {makeCodeGraphCitationRepositoryRouteObservation} from '@threadnote/graph/citation/recovery';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {observationFromCodeGraphStatus} from '@threadnote/graph/query/contract';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {worktreeBuildRequestObservation} from '@threadnote/graph/inventory';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import {planContextHealthCitationBatch} from '@threadnote/context/citation_validation';
import {
  CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
  type ContextBriefCitationValidationReceiptV2,
  type ContextHealthCitationSubjectV1,
  type ContextBriefMemoryCitationValidationV2,
} from '@threadnote/context/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const POLICY = `health-receipts-v1:validator-${CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION}`;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
const MAX_PROJECTIONS = 64;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RECEIPTS = 20_000;
const MAX_SOURCES = 32;
const UNKNOWN_RETRY_MILLISECONDS = 60_000;
const LOCK = {retryIntervalMilliseconds: 10, staleAfterMilliseconds: 60_000, waitTimeoutMilliseconds: 50};
export class ContextMaintenanceEvidenceRequestError extends Data.TaggedError('ContextMaintenanceEvidenceRequestError')<{
  readonly message: string;
}> {}
const requestPersistenceError = () =>
  new ContextMaintenanceEvidenceRequestError({message: 'Unable to persist requested citation evidence work.'});

interface SourceObservation {
  readonly epoch: string;
  readonly repositoryId?: string;
  readonly snapshotId?: string;
  readonly current: boolean;
}
interface Entry {
  readonly uri: string;
  readonly contentHash: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly associations?: Readonly<Record<string, string>>;
  readonly receipts: ContextBriefMemoryCitationValidationV2['receipts'];
}
interface Projection {
  readonly version: 1;
  readonly policy: string;
  readonly entries: readonly Entry[];
}

export interface ContextMaintenanceWorkerObservation {
  readonly sourceEpoch?: string;
  readonly association: Effect.Success<ReturnType<typeof readContextMaintenanceCitationAssociation>>;
  readonly memoryGeneration?: string;
}

type CitationEvidenceOptions<R> = {
  readonly mode?: 'foreground' | 'worker' | 'diagnostic';
  readonly validate: (
    selected: readonly ContextHealthCitationSubjectV1[],
  ) => Effect.Effect<readonly ContextBriefMemoryCitationValidationV2[], unknown, R>;
  readonly observeWorker?: (observation: ContextMaintenanceWorkerObservation) => Effect.Effect<void, never, R>;
  readonly workerSubjectFence?: () => Effect.Effect<string | undefined, unknown, R>;
  readonly skipWorkerValidation?: (
    record: MemoryRecord,
    observation: ContextMaintenanceWorkerObservation,
  ) => Effect.Effect<boolean, unknown, R>;
};

/** Published identities and real source observations, never SQLite/WAL or lease/cache writes. */
export const readContextMaintenanceSourceEpoch = Effect.fn('contextMaintenance.sourceEpoch')(function* (
  config: RuntimeConfig,
  cwd: string,
  project?: string,
) {
  return (yield* observeSource(config, cwd, project)).epoch;
});

export const readContextMaintenanceCitationAssociation = Effect.fn('contextMaintenance.citationAssociation')(function* (
  config: RuntimeConfig,
  cwd: string,
  citations: readonly MemoryCodeCitationV1[],
  observe?: (root: string) => ReturnType<typeof observeSource>,
) {
  const selectors = [
    ...new Map(citations.map(citation => [`${citation.repositoryId}:${citation.sourceCommit}`, citation])).values(),
  ].sort((a, b) => `${a.repositoryId}:${a.sourceCommit}`.localeCompare(`${b.repositoryId}:${b.sourceCommit}`));
  const resolve = yield* makeCodeGraphCitationRepositoryRouteObservation({
    threadnoteHome: config.agentContextHome,
    callerCwd: cwd,
  });
  const observations = yield* Effect.forEach(
    selectors,
    citation =>
      resolve({
        repositoryId: citation.repositoryId,
        sourceCommit: citation.sourceCommit,
      }).pipe(Effect.orElseSucceed(() => ({generation: 'unavailable', routes: [], complete: false}))),
    {concurrency: 4},
  );
  const roots = [
    ...new Set(observations.flatMap(observation => observation.routes.map(route => route.identity.repoRoot))),
  ]
    .sort()
    .slice(0, MAX_SOURCES);
  const sources = yield* Effect.forEach(
    roots,
    root => (observe?.(root) ?? observeSource(config, root)).pipe(Effect.map(source => [root, source.epoch] as const)),
    {concurrency: 4},
  );
  const sourceMap = new Map(sources);
  const bySelector = Object.fromEntries(
    observations.map((observation, index) => [
      `${selectors[index].repositoryId}:${selectors[index].sourceCommit}`,
      sha256HexSync(
        JSON.stringify([
          observation.generation,
          observation.complete,
          observation.routes.map(route => [
            route.identity.repoRoot,
            sourceMap.get(route.identity.repoRoot) ?? 'unobserved',
          ]),
        ]),
      ),
    ]),
  );
  return {
    epoch: sha256HexSync(JSON.stringify([selectors.length, bySelector])),
    roots,
    bySelector,
    sourceEpochs: Object.fromEntries(sources),
  };
});

const observeSource = Effect.fn('contextMaintenance.observeSource')(function* (
  config: RuntimeConfig,
  cwd: string,
  project?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const query = yield* CodeGraphQueryService;
  const manifest = yield* fs.readFileString(config.manifestPath).pipe(Effect.orElseSucceed(() => 'unavailable'));
  const status = yield* query
    .status(config.agentContextHome, cwd, {
      manifestPath: config.manifestPath,
      ...(project === undefined ? {} : {project}),
      observeWorktree: true,
      requestMaintenance: false,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  const identity =
    status?.identity ?? (yield* resolveRepositoryIdentity(cwd).pipe(Effect.orElseSucceed(() => undefined)));
  const observedOverlay = status === undefined ? undefined : observationFromCodeGraphStatus(status)?.overlay;
  // A clean full-repository observation already proves no source delta. Dirty
  // or scoped evidence needs the policy-independent source identity, excluding
  // this private home so cache/lease writes cannot invalidate their own receipts.
  const overlay =
    identity === undefined
      ? undefined
      : observedOverlay?.dirty === false
        ? observedOverlay
        : yield* worktreeBuildRequestObservation(identity, config.agentContextHome).pipe(
            Effect.map(observation => observation.state),
            Effect.orElseSucceed(() => undefined),
          );
  return sourceObservation({cwd, manifest, status, identity, overlay});
});

/** Kept pure so source/cache invalidation invariants can be checked independently. */
export function sourceObservation(input: {
  readonly cwd: string;
  readonly manifest: string;
  readonly status?: CodeGraphStatus;
  readonly identity?: CodeGraphStatus['identity'];
  readonly overlay?: {readonly dirty: boolean; readonly fingerprint?: string};
}): SourceObservation {
  const {status, identity, overlay} = input;
  return {
    epoch: sha256HexSync(
      JSON.stringify([
        POLICY,
        input.cwd,
        input.manifest,
        identity,
        status?.readySnapshot,
        status?.languagePacks,
        status?.projectCoverage,
        status?.freshness,
        status?.stale,
        overlay,
      ]),
    ),
    ...(identity === undefined ? {} : {repositoryId: identity.repositoryId}),
    ...(status?.readySnapshot === undefined ? {} : {snapshotId: status.readySnapshot.id}),
    current: identity !== undefined && overlay !== undefined && status?.freshness === 'current' && !status.stale,
  };
}

export function projectMaintenanceCitationReceipts(input: {
  readonly entries: readonly Entry[];
  readonly records: readonly MemoryRecord[];
  readonly sources: ReadonlyMap<string, SourceObservation>;
  readonly now: number;
  readonly associations?: Readonly<Record<string, string>>;
}): readonly ContextBriefMemoryCitationValidationV2[] {
  return projectCitationReceipts(input, false);
}

function projectCitationReceipts(
  input: Parameters<typeof projectMaintenanceCitationReceipts>[0],
  includeExpiredUnknown: boolean,
): readonly ContextBriefMemoryCitationValidationV2[] {
  const entries = new Map(input.entries.map(entry => [entry.uri, entry]));
  return input.records.flatMap(record => {
    const entry = entries.get(record.uri);
    if (
      entry === undefined ||
      entry.contentHash !== memoryHash(record) ||
      !Object.entries(entry.sources).every(([cwd, epoch]) => input.sources.get(cwd)?.epoch === epoch)
    )
      return [];
    const ids = new Set((record.metadata.codeCitations ?? []).map(citation => citation.id));
    const receipts = entry.receipts.filter(
      receipt =>
        (input.associations === undefined ||
          (record.metadata.codeCitations ?? []).some(citation => {
            const selector = `${citation.repositoryId}:${citation.sourceCommit}`;
            return (
              citation.id === receipt.citationId &&
              entry.associations?.[selector] !== undefined &&
              entry.associations[selector] === input.associations?.[selector]
            );
          })) &&
        ids.has(receipt.citationId) &&
        (receipt.status === 'unknown' ||
          receipt.provenance === 'historical-verified' ||
          Object.keys(entry.sources).some(root => {
            if (receipt.recovery !== undefined && root !== receipt.recovery.callerCwd) return false;
            const source = input.sources.get(root);
            return (
              source?.current === true &&
              receipt.repositoryId === source.repositoryId &&
              receipt.snapshotId === source.snapshotId
            );
          })) &&
        (receiptWithinRetryWindow(receipt, input.now) ||
          (includeExpiredUnknown && expiredUnknownAttempt(receipt, input.now))),
    );
    return receipts.length === 0 ? [] : [{uri: record.uri, receipts, cacheHits: receipts.length}];
  });
}

function receiptWithinRetryWindow(receipt: ContextBriefCitationValidationReceiptV2, now: number): boolean {
  return (
    receipt.status !== 'unknown' ||
    receipt.provenance === 'historical-verified' ||
    (Number.isFinite(Date.parse(receipt.observedAt)) &&
      now - Date.parse(receipt.observedAt) >= 0 &&
      now - Date.parse(receipt.observedAt) < UNKNOWN_RETRY_MILLISECONDS)
  );
}

function expiredUnknownAttempt(receipt: ContextBriefCitationValidationReceiptV2, now: number): boolean {
  const observed = Date.parse(receipt.observedAt);
  return (
    receipt.status === 'unknown' &&
    receipt.provenance !== 'historical-verified' &&
    Number.isFinite(observed) &&
    now - observed >= UNKNOWN_RETRY_MILLISECONDS
  );
}

/** A receipt must have a live subject and its own published association before foreground route probing. */
export function foregroundReceiptCandidates(
  entries: readonly Entry[],
  records: readonly MemoryRecord[],
  candidates: readonly ContextHealthCitationSubjectV1[],
  _now: number,
) {
  const byEntry = new Map(entries.map(entry => [entry.uri, entry]));
  const byRecord = new Map(records.map(record => [record.uri, record]));
  const selectedEntries: Entry[] = [];
  const selectedCandidates: ContextHealthCitationSubjectV1[] = [];
  for (const candidate of candidates) {
    const entry = byEntry.get(candidate.uri);
    const record = byRecord.get(candidate.uri);
    if (entry === undefined || record === undefined || entry.contentHash !== memoryHash(record)) continue;
    const canonicalCitations = new Map((record.metadata.codeCitations ?? []).map(citation => [citation.id, citation]));
    const eligibleIds = new Set(
      entry.receipts.flatMap(receipt => (canonicalCitations.has(receipt.citationId) ? [receipt.citationId] : [])),
    );
    const codeCitations = candidate.codeCitations.flatMap(citation => {
      const canonical = canonicalCitations.get(citation.id);
      if (canonical === undefined || !eligibleIds.has(citation.id)) return [];
      const selector = `${canonical.repositoryId}:${canonical.sourceCommit}`;
      return entry.associations?.[selector] === undefined ? [] : [canonical];
    });
    if (codeCitations.length === 0) continue;
    selectedEntries.push(entry);
    selectedCandidates.push({...candidate, codeCitations});
  }
  return {entries: selectedEntries, candidates: selectedCandidates};
}

/**
 * Foreground reads consume receipts and enqueue missing work without source validation.
 * Explicit diagnostics admit one 96-citation batch. The worker supplies bounded record chunks;
 * its validated receipts accumulate independently of report pagination.
 */
const collectContextMaintenanceCitationEvidenceInner = Effect.fn('contextMaintenance.collectCitationEvidenceInner')(
  function* <R>(
    config: RuntimeConfig,
    project: string,
    records: readonly MemoryRecord[],
    candidates: readonly ContextHealthCitationSubjectV1[],
    cwd: string,
    options: CitationEvidenceOptions<R>,
  ) {
    if (!candidates.some(candidate => candidate.codeCitations.length > 0)) return [];
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(
      config.agentContextHome,
      'context-maintenance',
      'evidence',
      `${sha256HexSync(`${project}\0${cwd}`)}.json`,
    );
    const beforeMemory = yield* mutationGeneration(config);
    const now = (yield* DateTime.nowAsDate).getTime();
    const stored = yield* readProjection(file);
    const recordUris = new Set(records.map(record => record.uri));
    const entries = stored?.entries.filter(entry => recordUris.has(entry.uri)) ?? [];
    const foreground = options.mode === undefined || options.mode === 'foreground';
    const eligible = foreground ? foregroundReceiptCandidates(entries, records, candidates, now) : undefined;
    if (foreground && eligible?.candidates.length === 0) {
      yield* enqueueEvidenceRequest(
        file,
        project,
        cwd,
        candidates.filter(candidate => candidate.codeCitations.length > 0).map(candidate => candidate.uri),
      );
      return [];
    }
    const sources = new Map<string, SourceObservation>();
    const openingObservations = new Map<string, SourceObservation>();
    const openingSource = (root: string) =>
      Effect.gen(function* () {
        const previous = openingObservations.get(root);
        if (previous !== undefined) return previous;
        const source = yield* observeSource(config, root);
        openingObservations.set(root, source);
        return source;
      });
    const association = yield* readContextMaintenanceCitationAssociation(
      config,
      cwd,
      (eligible?.candidates ?? candidates).flatMap(candidate => candidate.codeCitations),
      openingSource,
    );
    const roots = [
      ...new Set([
        cwd,
        ...association.roots,
        ...(eligible?.entries ?? entries).flatMap(entry => Object.keys(entry.sources)),
      ]),
    ].slice(0, MAX_SOURCES);
    for (const root of roots) sources.set(root, yield* openingSource(root));
    const projected = projectMaintenanceCitationReceipts({
      entries: eligible?.entries ?? entries,
      records,
      sources,
      now,
      associations: association.bySelector,
    });
    const candidateIds = foreground ? new Map<string, Set<string>>() : undefined;
    if (candidateIds !== undefined)
      for (const candidate of candidates) {
        const ids = candidateIds.get(candidate.uri) ?? new Set<string>();
        for (const citation of candidate.codeCitations) ids.add(citation.id);
        candidateIds.set(candidate.uri, ids);
      }
    const cached =
      candidateIds === undefined
        ? projected
        : projected.flatMap(validation => {
            const receipts = validation.receipts.filter(receipt =>
              candidateIds.get(validation.uri)?.has(receipt.citationId),
            );
            return receipts.length === 0 ? [] : [{...validation, receipts, cacheHits: receipts.length}];
          });
    const lastAttempts = foreground
      ? projectCitationReceipts(
          {entries: eligible?.entries ?? entries, records, sources, now, associations: association.bySelector},
          true,
        ).flatMap(validation => {
          const receipts = validation.receipts.filter(
            receipt =>
              expiredUnknownAttempt(receipt, now) && candidateIds?.get(validation.uri)?.has(receipt.citationId),
          );
          return receipts.length === 0 ? [] : [{...validation, receipts, cacheHits: 0}];
        })
      : [];
    const receiptIds = new Map(
      cached.map(validation => [validation.uri, new Set(validation.receipts.map(receipt => receipt.citationId))]),
    );
    const pending = yield* Effect.forEach(candidates, candidate =>
      Effect.gen(function* () {
        const record = records.find(record => record.uri === candidate.uri);
        const skip =
          options.mode === 'worker' && options.skipWorkerValidation !== undefined && record !== undefined
            ? yield* options.skipWorkerValidation(record, {
                sourceEpoch: association.sourceEpochs[cwd] ?? sources.get(cwd)?.epoch,
                association,
                memoryGeneration: beforeMemory,
              })
            : false;
        return {
          ...candidate,
          codeCitations: skip
            ? []
            : candidate.codeCitations.filter(citation => !receiptIds.get(candidate.uri)?.has(citation.id)),
        };
      }),
    );
    const selected =
      options.mode === 'worker'
        ? pending
        : options.mode === 'diagnostic'
          ? planContextHealthCitationBatch(pending).candidates
          : [];
    const computed = selected.some(candidate => candidate.codeCitations.length > 0)
      ? yield* options.validate(selected)
      : [];
    // Current recovery receipts can depend on an alternate checkout. Observe those
    // published identities too; overflow remains deferred, never cache-certified.
    for (const root of new Set(
      computed.flatMap(validation =>
        validation.receipts.flatMap(receipt => (receipt.recovery === undefined ? [] : [receipt.recovery.callerCwd])),
      ),
    )) {
      if (!sources.has(root) && sources.size < MAX_SOURCES) sources.set(root, yield* openingSource(root));
    }
    const closing = new Map<string, SourceObservation>();
    const closingObservations = new Map<string, SourceObservation>();
    const closingSource = (root: string) =>
      Effect.gen(function* () {
        const previous = closingObservations.get(root);
        if (previous !== undefined) return previous;
        const source = yield* observeSource(config, root);
        closingObservations.set(root, source);
        return source;
      });
    for (const [root] of sources) closing.set(root, yield* closingSource(root));
    const canonicalByUri = new Map(records.map(record => [record.uri, record]));
    const returnedCitations = foreground
      ? [...cached, ...lastAttempts, ...computed].flatMap(validation =>
          validation.receipts.map(receipt =>
            canonicalByUri
              .get(validation.uri)
              ?.metadata.codeCitations?.find(citation => citation.id === receipt.citationId),
          ),
        )
      : [];
    const closingCitations = foreground
      ? returnedCitations.filter(citation => citation !== undefined)
      : candidates.flatMap(candidate => candidate.codeCitations);
    const closingAssociation = yield* readContextMaintenanceCitationAssociation(
      config,
      cwd,
      closingCitations,
      closingSource,
    );
    const proofGeneration =
      options.mode === 'worker' && options.workerSubjectFence !== undefined
        ? yield* options.workerSubjectFence().pipe(Effect.orElseSucceed(() => undefined))
        : beforeMemory === (yield* mutationGeneration(config))
          ? beforeMemory
          : undefined;
    const unchanged =
      (foreground
        ? returnedCitations.length === closingCitations.length &&
          closingCitations.every(citation => {
            const selector = `${citation.repositoryId}:${citation.sourceCommit}`;
            const opening = association.bySelector[selector];
            return opening !== undefined && opening === closingAssociation.bySelector[selector];
          })
        : association.epoch === closingAssociation.epoch) &&
      proofGeneration !== undefined &&
      [...sources].every(([root, observation]) => observation.epoch === closing.get(root)?.epoch);
    if (!unchanged) {
      if (foreground)
        yield* enqueueEvidenceRequest(
          file,
          project,
          cwd,
          candidates.filter(candidate => candidate.codeCitations.length > 0).map(candidate => candidate.uri),
        );
      return [];
    }
    if (options.mode === 'worker' && options.observeWorker !== undefined)
      yield* options.observeWorker({
        sourceEpoch: closingAssociation.sourceEpochs[cwd] ?? (yield* readContextMaintenanceSourceEpoch(config, cwd)),
        association: closingAssociation,
        memoryGeneration: proofGeneration,
      });
    const byUri = new Map(cached.map(validation => [validation.uri, validation]));
    for (const validation of computed) {
      const previous = byUri.get(validation.uri);
      byUri.set(validation.uri, {...validation, receipts: [...(previous?.receipts ?? []), ...validation.receipts]});
    }
    const validations = [...byUri.values()];
    const returnedByUri = new Map(byUri);
    for (const attempt of lastAttempts) {
      const previous = returnedByUri.get(attempt.uri);
      returnedByUri.set(
        attempt.uri,
        previous === undefined ? attempt : {...previous, receipts: [...previous.receipts, ...attempt.receipts]},
      );
    }
    const returnedValidations = [...returnedByUri.values()];
    const recordsByUri = new Map(records.map(record => [record.uri, record]));
    const additions: Entry[] = computed.flatMap(validation => {
      const record = recordsByUri.get(validation.uri);
      if (record === undefined) return [];
      const receipts = validation.receipts.filter(receipt => {
        if (receipt.status === 'unknown') return true;
        if (receipt.provenance === 'historical-verified') return true;
        const source = closing.get(receipt.recovery?.callerCwd ?? cwd);
        return (
          source?.current === true &&
          receipt.repositoryId === source.repositoryId &&
          receipt.snapshotId === source.snapshotId
        );
      });
      if (receipts.length === 0) return [];
      return [
        {
          uri: record.uri,
          contentHash: memoryHash(record),
          sources: Object.fromEntries([...closing].map(([root, source]) => [root, source.epoch])),
          associations: Object.fromEntries(
            (record.metadata.codeCitations ?? []).flatMap(citation => {
              const selector = `${citation.repositoryId}:${citation.sourceCommit}`;
              const epoch = closingAssociation.bySelector[selector];
              return epoch === undefined ? [] : [[selector, epoch]];
            }),
          ),
          receipts,
        },
      ];
    });
    if (additions.length > 0)
      yield* withExclusiveFileLock(
        fs,
        `${file}.lock`,
        LOCK,
        Effect.gen(function* () {
          if (proofGeneration !== (yield* mutationGeneration(config))) return;
          const latest = yield* readProjection(file);
          const merged = new Map((latest?.entries ?? []).map(entry => [entry.uri, entry]));
          for (const entry of additions) {
            const previous = merged.get(entry.uri);
            const compatible =
              previous?.contentHash === entry.contentHash &&
              JSON.stringify(previous.sources) === JSON.stringify(entry.sources) &&
              JSON.stringify(previous.associations) === JSON.stringify(entry.associations);
            const receipts = new Map(
              [...(compatible ? previous.receipts : []), ...entry.receipts].map(receipt => [
                receipt.citationId,
                receipt,
              ]),
            );
            merged.set(entry.uri, {...entry, receipts: [...receipts.values()]});
          }
          const bounded: Entry[] = [];
          let count = 0;
          for (const entry of [...merged.values()].reverse()) {
            if (count + entry.receipts.length > MAX_RECEIPTS) continue;
            count += entry.receipts.length;
            bounded.push(entry);
          }
          const projection = {version: 1, policy: POLICY, entries: bounded.reverse()} satisfies Projection;
          const text = JSON.stringify(projection);
          if (new TextEncoder().encode(text).byteLength <= MAX_BYTES) {
            yield* atomicWrite(file, text);
            yield* pruneProjections(file).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.ignore);
    const checked = new Set(
      validations.flatMap(validation => validation.receipts.map(receipt => `${validation.uri}\0${receipt.citationId}`)),
    );
    if (options.mode === 'worker') return validations;
    if (
      candidates.some(candidate =>
        candidate.codeCitations.some(citation => !checked.has(`${candidate.uri}\0${citation.id}`)),
      )
    ) {
      const uris = candidates
        .filter(candidate => candidate.codeCitations.some(citation => !checked.has(`${candidate.uri}\0${citation.id}`)))
        .map(candidate => candidate.uri);
      yield* enqueueEvidenceRequest(file, project, cwd, uris);
    } else
      yield* clearContextMaintenanceEvidenceRequest(
        config,
        project,
        cwd,
        candidates.map(candidate => candidate.uri),
      );
    return returnedValidations;
  },
);

export const collectContextMaintenanceCitationEvidence = Effect.fn('contextMaintenance.collectCitationEvidence')(
  function* <R>(
    config: RuntimeConfig,
    project: string,
    records: readonly MemoryRecord[],
    candidates: readonly ContextHealthCitationSubjectV1[],
    cwd: string,
    options: CitationEvidenceOptions<R>,
  ) {
    const collect = collectContextMaintenanceCitationEvidenceInner(config, project, records, candidates, cwd, options);
    if (options.mode === 'worker' || options.mode === 'diagnostic') return yield* collect;
    const result = yield* collect.pipe(Effect.timeoutOption(3_000));
    if (Option.isSome(result)) return result.value;
    const uris = candidates.filter(candidate => candidate.codeCitations.length > 0).map(candidate => candidate.uri);
    if (uris.length > 0) {
      const path = yield* Path.Path;
      const file = path.join(
        config.agentContextHome,
        'context-maintenance',
        'evidence',
        `${sha256HexSync(`${project}\0${cwd}`)}.json`,
      );
      yield* enqueueEvidenceRequest(file, project, cwd, uris);
    }
    return [];
  },
);

const mutationGeneration = Effect.fn('contextMaintenance.evidenceMemoryGeneration')(function* (config: RuntimeConfig) {
  return yield* readCanonicalMutationGeneration(
    yield* FileSystem.FileSystem,
    yield* Path.Path,
    config.agentContextHome,
    config.account,
  ).pipe(Effect.orElseSucceed(() => undefined));
});
const readProjection = Effect.fn('contextMaintenance.readEvidenceProjection')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const info = yield* fs.stat(file);
    if (info.type !== 'File' || Number(info.size) > MAX_BYTES) return undefined;
    const text = yield* fs.readFileString(file);
    return yield* Effect.try(() => decodeProjection(JSON.parse(text)));
  }).pipe(Effect.orElseSucceed(() => undefined));
});
const atomicWrite = Effect.fn('contextMaintenance.writeEvidenceProjection')(function* (file: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  yield* fs.makeDirectory(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
  yield* fs
    .writeFileString(temporary, text, {mode: 0o600})
    .pipe(
      Effect.andThen(fs.rename(temporary, file)),
      Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
    );
});
function memoryHash(record: MemoryRecord): string {
  return sha256HexSync(canonicalMemoryDocumentContent(record.content));
}

function decodeProjection(value: unknown): Projection | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const projection = value as Projection;
  if (projection.version !== 1 || projection.policy !== POLICY || !Array.isArray(projection.entries)) return undefined;
  let receipts = 0;
  for (const entry of projection.entries) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.uri !== 'string' ||
      typeof entry.contentHash !== 'string' ||
      entry.sources === null ||
      typeof entry.sources !== 'object' ||
      Array.isArray(entry.sources) ||
      Object.keys(entry.sources).length === 0 ||
      Object.keys(entry.sources).length > MAX_SOURCES ||
      !Object.values(entry.sources).every(epoch => typeof epoch === 'string') ||
      (entry.associations !== undefined &&
        (entry.associations === null ||
          typeof entry.associations !== 'object' ||
          Array.isArray(entry.associations) ||
          Object.keys(entry.associations).length > MAX_SOURCES ||
          !Object.values(entry.associations).every(epoch => typeof epoch === 'string'))) ||
      !Array.isArray(entry.receipts)
    )
      return undefined;
    receipts += entry.receipts.length;
    if (receipts > MAX_RECEIPTS) return undefined;
    for (const receipt of entry.receipts) {
      if (
        receipt === null ||
        typeof receipt !== 'object' ||
        typeof receipt.citationId !== 'string' ||
        typeof receipt.observedAt !== 'string' ||
        receipt.validatorVersion !== CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION ||
        !['exact', 'relocated', 'changed', 'deleted', 'unknown'].includes(receipt.status) ||
        !['current-complete', 'incomplete'].includes(receipt.coverage) ||
        (receipt.provenance !== undefined &&
          !['current-verified', 'historical-verified', 'unverified'].includes(receipt.provenance))
      )
        return undefined;
    }
  }
  return projection;
}

const pruneProjections = Effect.fn('contextMaintenance.pruneEvidenceProjections')(function* (retainedFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(retainedFile);
  const files = yield* Effect.forEach(
    (yield* fs.readDirectory(directory)).filter(name => /^[0-9a-f]{64}\.json$/u.test(name)),
    name =>
      fs.stat(path.join(directory, name)).pipe(
        Effect.map(info => ({
          file: path.join(directory, name),
          bytes: Number(info.size),
          modified: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
        })),
        Effect.option,
      ),
    {concurrency: 4},
  );
  const ordered = files
    .flatMap(value => (Option.isSome(value) ? [value.value] : []))
    .sort(
      (left, right) =>
        Number(right.file === retainedFile) - Number(left.file === retainedFile) || right.modified - left.modified,
    );
  let bytes = 0;
  for (const [index, item] of ordered.entries()) {
    bytes += item.bytes;
    if (index >= MAX_PROJECTIONS || bytes > MAX_PROJECT_BYTES) {
      yield* fs.remove(item.file, {force: true}).pipe(Effect.ignore);
      yield* fs.remove(`${item.file}.pending`, {force: true}).pipe(Effect.ignore);
    }
  }
});

export interface ContextMaintenanceEvidenceRequest {
  readonly project: string;
  readonly cwd: string;
  readonly page?: number;
  readonly uris: readonly string[];
  readonly cursor?: string;
  readonly deferredUntil?: Readonly<Record<string, string>>;
  readonly revision?: string;
}
export interface ContextMaintenanceEvidenceRequestPage {
  readonly requests: readonly ContextMaintenanceEvidenceRequest[];
  readonly files: readonly string[];
  readonly namesHash: string;
  readonly total: number;
  readonly scanned: number;
  readonly lastFile?: string;
  readonly unreadable: boolean;
}
export interface ContextMaintenanceEvidenceRequestDiscovery {
  readonly namesHash: string;
  readonly scope?: string;
  readonly scanned: number;
  readonly lastFile?: string;
  readonly scopedPending: boolean;
}
export const pendingContextMaintenanceEvidenceRoots = Effect.fn('contextMaintenance.pendingRequestRoots')(function* (
  requests: readonly ContextMaintenanceEvidenceRequest[],
  now: number,
  project?: string,
) {
  const path = yield* Path.Path;
  return requests
    .filter(request => project === undefined || request.project === project)
    .filter(
      request =>
        path.isAbsolute(request.cwd) &&
        request.uris.some(uri => !(Date.parse(request.deferredUntil?.[uri] ?? '') > now)),
    )
    .map(contextMaintenanceEvidenceRequestKey);
});
export function contextMaintenanceEvidenceRequestKey(request: ContextMaintenanceEvidenceRequest): string {
  return `${request.project}\0${request.cwd}\0${request.page ?? 0}`;
}
export function contextMaintenanceEvidenceRequestFileName(request: ContextMaintenanceEvidenceRequest): string {
  const root = sha256HexSync(`${request.project}\0${request.cwd}`);
  return request.page === undefined || request.page === 0
    ? `${root}.json.pending`
    : `${root}.${String(request.page).padStart(6, '0')}.json.pending`;
}
export function advanceContextMaintenanceEvidenceRequestDiscovery(
  previous: ContextMaintenanceEvidenceRequestDiscovery | undefined,
  page: ContextMaintenanceEvidenceRequestPage,
  scope?: string,
): ContextMaintenanceEvidenceRequestDiscovery {
  if (previous?.namesHash !== page.namesHash || previous.scope !== scope)
    return {
      namesHash: page.namesHash,
      scope,
      scanned: previous === undefined || page.lastFile === undefined ? page.scanned : 0,
      lastFile: previous === undefined ? page.lastFile : undefined,
      scopedPending: page.unreadable || page.requests.some(request => scope === undefined || request.project === scope),
    };
  return {
    namesHash: page.namesHash,
    scope,
    scanned: Math.min(page.total, previous.scanned + page.scanned),
    lastFile: page.lastFile,
    scopedPending:
      previous.scopedPending ||
      page.unreadable ||
      page.requests.some(request => scope === undefined || request.project === scope),
  };
}
export function advanceContextMaintenanceEvidenceRequestExecution(
  previous: ContextMaintenanceEvidenceRequestDiscovery | undefined,
  page: ContextMaintenanceEvidenceRequestPage,
  scope: string | undefined,
  hasEligible: boolean,
  executedRoot?: string,
) {
  const pinned = () => ({
    ...advanceContextMaintenanceEvidenceRequestDiscovery(
      previous,
      {...page, scanned: 0, lastFile: previous?.lastFile},
      scope,
    ),
    lastFile: previous?.lastFile,
  });
  // Keep eligible filenames in view across record and semantic phases; advance only past work actually attempted.
  if (hasEligible && executedRoot === undefined) return pinned();
  const executed = page.requests.find(request => contextMaintenanceEvidenceRequestKey(request) === executedRoot);
  const index =
    executedRoot === undefined
      ? page.files.length - 1
      : page.files.indexOf(executed === undefined ? '' : contextMaintenanceEvidenceRequestFileName(executed));
  if (executedRoot !== undefined && index < 0) return pinned();
  return {
    ...advanceContextMaintenanceEvidenceRequestDiscovery(
      previous,
      {...page, scanned: index + 1, lastFile: page.files[index]},
      scope,
    ),
    lastFile: page.files[index],
  };
}
export const readContextMaintenanceEvidenceRequestPage = Effect.fn('contextMaintenance.readEvidenceRequestPage')(
  function* (config: RuntimeConfig, afterFile?: string) {
    const path = yield* Path.Path;
    const directory = path.join(config.agentContextHome, 'context-maintenance', 'evidence');
    const names = yield* readEvidenceRequestFileNames(config);
    const requests: ContextMaintenanceEvidenceRequest[] = [];
    const ordered = names ?? [];
    const next = afterFile === undefined ? 0 : ordered.findIndex(name => name > afterFile);
    const rotated = next < 0 ? ordered : [...ordered.slice(next), ...ordered.slice(0, next)];
    const selected = rotated.slice(0, MAX_PROJECTIONS);
    let unreadable = names === undefined;
    for (const name of selected) {
      const request = yield* readEvidenceRequest(path.join(directory, name));
      if (request !== undefined && name === contextMaintenanceEvidenceRequestFileName(request)) requests.push(request);
      else unreadable = true;
    }
    return {
      requests,
      files: selected,
      namesHash: names === undefined ? 'unreadable' : sha256HexSync(ordered.join('\0')),
      total: ordered.length,
      scanned: selected.length,
      lastFile: selected.at(-1),
      unreadable,
    } satisfies ContextMaintenanceEvidenceRequestPage;
  },
);
export const readContextMaintenanceEvidenceRequestNamesHash = Effect.fn('contextMaintenance.requestNamesHash')(
  function* (config: RuntimeConfig) {
    const names = yield* readEvidenceRequestFileNames(config);
    return names === undefined ? undefined : sha256HexSync(names.join('\0'));
  },
);
export const contextMaintenanceEvidenceDiscoveryPending = Effect.fn('contextMaintenance.requestDiscoveryPending')(
  function* (
    config: RuntimeConfig,
    discovery: ContextMaintenanceEvidenceRequestDiscovery | undefined,
    total: number,
    scope?: string,
  ) {
    return (
      discovery === undefined ||
      discovery.scope !== scope ||
      discovery.scanned < total ||
      discovery.scopedPending ||
      discovery.namesHash !== (yield* readContextMaintenanceEvidenceRequestNamesHash(config))
    );
  },
);
const readEvidenceRequestFileNames = Effect.fn('contextMaintenance.requestFileNames')(function* (
  config: RuntimeConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs
    .readDirectory(path.join(config.agentContextHome, 'context-maintenance', 'evidence'))
    .pipe(Effect.orElseSucceed(error => (error.reason._tag === 'NotFound' ? [] : undefined)));
  return names?.filter(name => /^[0-9a-f]{64}(?:\.\d{6})?\.json\.pending$/u.test(name)).sort();
});
export const readContextMaintenanceEvidenceRequests = Effect.fn('contextMaintenance.readEvidenceRequests')(function* (
  config: RuntimeConfig,
) {
  return (yield* readContextMaintenanceEvidenceRequestPage(config)).requests;
});
export const clearContextMaintenanceEvidenceRequest = Effect.fn('contextMaintenance.ackEvidenceRequest')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
  acknowledgedUris: readonly string[],
  expectedRevision?: string,
  page?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(
    config.agentContextHome,
    'context-maintenance',
    'evidence',
    `${sha256HexSync(`${project}\0${cwd}`)}.json`,
  );
  return yield* withExclusiveFileLock(
    fs,
    `${file}.lock`,
    LOCK,
    Effect.gen(function* () {
      const pages =
        page === undefined && expectedRevision === undefined ? yield* readOwnerRequestPages(file) : [page ?? 0];
      for (const currentPage of pages) {
        const pageFile = requestPageFile(file, currentPage);
        const request = yield* readEvidenceRequest(pageFile);
        if (request === undefined || (expectedRevision !== undefined && request.revision !== expectedRevision))
          continue;
        const acknowledged = new Set(acknowledgedUris);
        const uris = request.uris.filter(uri => !acknowledged.has(uri));
        if (uris.length === request.uris.length) continue;
        if (uris.length === 0) yield* fs.remove(pageFile, {force: true});
        else
          yield* writeEvidenceRequestPage(pageFile, {
            ...request,
            policy: POLICY,
            uris,
            deferredUntil: Object.fromEntries(
              Object.entries(request.deferredUntil ?? {}).filter(([uri]) => !acknowledged.has(uri)),
            ),
          });
      }
    }),
  ).pipe(Effect.ignore);
});
export const deferContextMaintenanceEvidenceRequest = Effect.fn('contextMaintenance.deferEvidenceRequest')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
  uris: readonly string[],
  retryAt: string,
  expectedRevision?: string,
  page = 0,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(
    config.agentContextHome,
    'context-maintenance',
    'evidence',
    `${sha256HexSync(`${project}\0${cwd}`)}.json`,
  );
  yield* withExclusiveFileLock(
    fs,
    `${file}.lock`,
    LOCK,
    Effect.gen(function* () {
      const pageFile = requestPageFile(file, page);
      const request = yield* readEvidenceRequest(pageFile);
      if (request === undefined || (expectedRevision !== undefined && request.revision !== expectedRevision)) return;
      const pending = new Set(request.uris);
      const deferredUntil = {...request.deferredUntil};
      for (const uri of uris) if (pending.has(uri)) deferredUntil[uri] = retryAt;
      yield* writeEvidenceRequestPage(pageFile, {...request, policy: POLICY, deferredUntil});
    }),
  ).pipe(Effect.ignore);
});
export const advanceContextMaintenanceEvidenceRequest = Effect.fn('contextMaintenance.advanceEvidenceRequest')(
  function* (config: RuntimeConfig, project: string, cwd: string, cursor: string, expectedRevision?: string, page = 0) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(
      config.agentContextHome,
      'context-maintenance',
      'evidence',
      `${sha256HexSync(`${project}\0${cwd}`)}.json`,
    );
    yield* withExclusiveFileLock(
      fs,
      `${file}.lock`,
      LOCK,
      Effect.gen(function* () {
        const pageFile = requestPageFile(file, page);
        const request = yield* readEvidenceRequest(pageFile);
        if (
          request !== undefined &&
          (expectedRevision === undefined || request.revision === expectedRevision) &&
          request.uris.includes(cursor)
        )
          yield* writeEvidenceRequestPage(pageFile, {...request, policy: POLICY, cursor});
      }),
    ).pipe(Effect.ignore);
  },
);

export const requestedRootProjectionComplete = Effect.fn('contextMaintenance.requestedProjectionComplete')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
  record: MemoryRecord,
  observation: ContextMaintenanceWorkerObservation,
) {
  const path = yield* Path.Path;
  const file = path.join(
    config.agentContextHome,
    'context-maintenance',
    'evidence',
    `${sha256HexSync(`${project}\0${cwd}`)}.json`,
  );
  const projection = yield* readProjection(file);
  const entry = projection?.entries.find(item => item.uri === record.uri);
  if (entry === undefined || entry.contentHash !== memoryHash(record)) return false;
  if (entry.sources[cwd] !== observation.sourceEpoch) return false;
  const now = (yield* DateTime.nowAsDate).getTime();
  const receipts = new Map(entry.receipts.map(receipt => [receipt.citationId, receipt]));
  return (record.metadata.codeCitations ?? []).every(citation => {
    const selector = `${citation.repositoryId}:${citation.sourceCommit}`;
    const receipt = receipts.get(citation.id);
    return (
      receipt !== undefined &&
      receiptWithinRetryWindow(receipt, now) &&
      (receipt.status !== 'unknown' ||
        (!['validation-error', 'citation-limit'].includes(receipt.reason) &&
          (receipt.reason !== 'graph-stale' || receipt.repositoryRouteUnavailable === true))) &&
      entry.associations?.[selector] !== undefined &&
      entry.associations[selector] === observation.association.bySelector[selector]
    );
  });
});
const readEvidenceRequest = Effect.fn('contextMaintenance.readEvidenceRequest')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const info = yield* fs.stat(file);
    if (info.type !== 'File' || Number(info.size) > MAX_REQUEST_BYTES) return undefined;
    const text = yield* fs.readFileString(file);
    return yield* Effect.try(() => {
      const value = JSON.parse(text) as ContextMaintenanceEvidenceRequest & {policy: string};
      return value !== null &&
        typeof value === 'object' &&
        value.policy === POLICY &&
        typeof value.project === 'string' &&
        typeof value.cwd === 'string' &&
        (value.page === undefined || (Number.isSafeInteger(value.page) && value.page > 0)) &&
        (value.cursor === undefined || typeof value.cursor === 'string') &&
        (value.revision === undefined || typeof value.revision === 'string') &&
        (value.deferredUntil === undefined ||
          (value.deferredUntil !== null &&
            typeof value.deferredUntil === 'object' &&
            Object.entries(value.deferredUntil).every(
              ([uri, date]) => typeof uri === 'string' && typeof date === 'string',
            ))) &&
        Array.isArray(value.uris) &&
        value.uris.length <= 100 &&
        value.uris.every(uri => typeof uri === 'string')
        ? value
        : undefined;
    });
  }).pipe(Effect.orElseSucceed(() => undefined));
});

function requestPageFile(file: string, page: number): string {
  return page === 0 ? `${file}.pending` : `${file.slice(0, -5)}.${String(page).padStart(6, '0')}.json.pending`;
}
const readOwnerRequestPages = Effect.fn('contextMaintenance.ownerRequestPages')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.basename(file, '.json');
  const names = yield* fs
    .readDirectory(path.dirname(file))
    .pipe(Effect.orElseSucceed(error => (error.reason._tag === 'NotFound' ? [] : undefined)));
  if (names === undefined) return yield* requestPersistenceError();
  return names
    .flatMap(name => {
      if (name === `${root}.json.pending`) return [0];
      const match = new RegExp(`^${root}\\.(\\d{6})\\.json\\.pending$`, 'u').exec(name);
      return match === null || Number(match[1]) === 0 ? [] : [Number(match[1])];
    })
    .sort((left, right) => left - right);
});
function requestBytes(request: ContextMaintenanceEvidenceRequest & {readonly policy: string}): number {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}
function requestPageCanAdmit(request: ContextMaintenanceEvidenceRequest & {readonly policy: string}): boolean {
  if (request.uris.length > 100) return false;
  const deferredUntil = {
    ...request.deferredUntil,
    ...Object.fromEntries(request.uris.map(uri => [uri, '2099-12-31T23:59:59.999Z'])),
  };
  const encoder = new TextEncoder();
  const largestCursor = request.uris.reduce(
    (largest, uri) => (encoder.encode(uri).byteLength > encoder.encode(largest).byteLength ? uri : largest),
    request.cursor ?? '',
  );
  return (
    requestBytes(request) <= MAX_REQUEST_BYTES &&
    requestBytes({...request, cursor: largestCursor, deferredUntil}) <= MAX_REQUEST_BYTES
  );
}
const writeEvidenceRequestPage = Effect.fn('contextMaintenance.writeRequestPage')(function* (
  file: string,
  request: ContextMaintenanceEvidenceRequest & {readonly policy: string},
) {
  if (request.uris.length > 100 || requestBytes(request) > MAX_REQUEST_BYTES) return yield* requestPersistenceError();
  yield* atomicWrite(file, JSON.stringify(request));
});

const enqueueEvidenceRequest = Effect.fn('contextMaintenance.enqueueEvidenceRequest')(function* (
  file: string,
  project: string,
  cwd: string,
  uris: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  yield* withExclusiveFileLock(
    fs,
    `${file}.lock`,
    LOCK,
    Effect.gen(function* () {
      const pending = new Set(uris);
      if (pending.size === 0) return;
      const pages = yield* readOwnerRequestPages(file);
      for (const page of pages) {
        const request = yield* readEvidenceRequest(requestPageFile(file, page));
        if (request === undefined || request.project !== project || request.cwd !== cwd || (request.page ?? 0) !== page)
          return yield* requestPersistenceError();
        for (const uri of request.uris) pending.delete(uri);
      }
      if (pending.size === 0) return;
      const crypto = yield* Crypto.Crypto;
      let nextPage = 0;
      while (pending.size > 0) {
        const page = nextPage++;
        if (page > 999_999) return yield* requestPersistenceError();
        const pageFile = requestPageFile(file, page);
        const previous = pages.includes(page) ? yield* readEvidenceRequest(pageFile) : undefined;
        if (pages.includes(page) && previous === undefined) return yield* requestPersistenceError();
        const combined = [...(previous?.uris ?? [])];
        const candidate = () => ({
          project,
          cwd,
          ...(page === 0 ? {} : {page}),
          uris: combined,
          policy: POLICY,
          cursor: previous?.cursor,
          deferredUntil: previous?.deferredUntil,
          revision: previous?.revision ?? '00000000-0000-0000-0000-000000000000',
        });
        for (const uri of pending) {
          combined.push(uri);
          if (!requestPageCanAdmit(candidate())) {
            combined.pop();
            if (combined.length === 0) return yield* requestPersistenceError();
            break;
          }
          pending.delete(uri);
        }
        if (combined.length === (previous?.uris.length ?? 0)) continue;
        yield* writeEvidenceRequestPage(pageFile, {...candidate(), revision: yield* crypto.randomUUIDv4});
      }
    }),
  ).pipe(Effect.mapError(() => requestPersistenceError()));
});
