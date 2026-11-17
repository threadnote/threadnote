import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from '../../fact/budget.js';
import type {ProjectResolutionLookupKey} from '../../incremental/closure.js';
import {compareCodeUnits} from '../../ordering.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphReference} from '../../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** One complete scan must stay within the ordinary 5,000-file attribution-work ceiling. */
export const PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES = 5_000;
/**
 * Pages remain independently bounded; this limit caps aggregate decoded work.
 * Real repositories can produce roughly 8x as many cached-fact bytes as
 * source bytes, so 256 MiB keeps ordinary exported TypeScript edits
 * incremental without making the scan unbounded.
 */
export const PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES = 256 * 1_048_576;
export const PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FILES = 32;
/** Matches the independent per-file cached-fact ceiling while keeping every decoded page bounded. */
export const PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES = CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS = 4_096;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_ASSOCIATIONS = 1_000_000;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_ASSOCIATIONS_PER_FILE = 32_768;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVATIONS = 2_000_000;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES = 256 * 1_048_576;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS = 10_000;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS = 100_000;
export const PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES = 8 * 1_048_576;
const PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK = 65_536;
const PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORD_BYTES =
  BigUint64Array.BYTES_PER_ELEMENT + Uint16Array.BYTES_PER_ELEMENT;
/**
 * Deterministic typed-array payload ceiling for the one-pass projection. The
 * projection grows in chunks and never retains lookup strings or per-identity
 * objects. Transient hash sets are separately bounded by the per-file
 * association and reexport-key limits.
 */
export const PROJECT_RESOLUTION_CANDIDATE_PROJECTION_STORAGE_MAX_BYTES =
  Math.ceil(
    PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVATIONS /
      PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK,
  ) *
  PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK *
  PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORD_BYTES;

export type ProjectResolutionCandidateScanFallbackDetail =
  | 'candidate-lookup-keys'
  | 'candidate-projection-associations'
  | 'candidate-projection-file-associations'
  | 'candidate-projection-observations'
  | 'candidate-projection-observed-key-bytes'
  | 'candidate-reexport-key-bytes'
  | 'candidate-reexport-lookup-keys'
  | 'candidate-reexports'
  | 'candidate-scan-fact-bytes'
  | 'candidate-scan-files'
  | 'candidate-selected-files';

export interface ProjectResolutionCandidateScanPage {
  readonly factBytes: number;
  readonly files: readonly CodeGraphInventoryFile[];
}

export type ProjectResolutionCandidateScanPlan =
  | {
      readonly factBytes: number;
      readonly files: number;
      readonly mode: 'eligible';
      readonly pages: readonly ProjectResolutionCandidateScanPage[];
    }
  | {
      readonly detail: 'candidate-scan-fact-bytes' | 'candidate-scan-files';
      readonly limit: number;
      readonly mode: 'fallback';
      readonly observed: number;
      readonly reason: 'project-closure-unbounded';
    }
  | {
      readonly mode: 'fallback';
      readonly reason: 'cache-incomplete';
    };

export type ProjectResolutionCandidateClosure =
  | {
      readonly affectedAliasLookupIdentities: ReadonlySet<string>;
      readonly directAliasSymbolConflictIdentities: ReadonlySet<string>;
      readonly factBytes: number;
      readonly lookupKeys: number;
      readonly mode: 'eligible';
      readonly paths: readonly string[];
      readonly reexports: readonly ProjectResolutionReexportKeys[];
      readonly scannedFiles: number;
      readonly projectionObservations?: number;
      readonly projectionObservedKeyBytes?: number;
    }
  | {
      readonly mode: 'fallback';
      readonly reason: 'cache-incomplete';
    }
  | {
      readonly detail: ProjectResolutionCandidateScanFallbackDetail;
      readonly limit: number;
      readonly mode: 'fallback';
      readonly observed: number;
      readonly reason: 'project-closure-unbounded';
    };

export interface ProjectResolutionCandidateFactPage {
  readonly bytesByPath: ReadonlyMap<string, number>;
  readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
  /** A second attribution version shares the same path ordinal and every projection cap. */
  readonly previousFacts?: ReadonlyMap<string, CodeGraphFileFacts>;
}

/**
 * Repository-wide resolver evidence for one attribution context. It is exactly
 * what the full scan observes: every reference lookup identity with the file
 * that carries it, every symbol lookup identity, and every static reexport
 * hyperedge in scan order. Fingerprints are the scan's own, so collisions can
 * only widen a closure, never narrow it.
 */
export interface ProjectResolutionCandidateIndex {
  readonly paths: readonly string[];
  /** One entry per distinct fingerprint within a file, aligned with `referenceOrdinals`. */
  readonly referenceFingerprints: BigUint64Array;
  readonly referenceOrdinals: Uint32Array;
  /** One entry per observed symbol lookup identity; duplicates are allowed. */
  readonly symbolFingerprints: BigUint64Array;
  readonly reexports: readonly ProjectResolutionReexportKeys[];
}

export interface ProjectResolutionCandidateIndexMatches {
  /** Distinct paths whose references carry a requested fingerprint; more than the maximum only signals overflow. */
  readonly referencePaths: ReadonlySet<string>;
  readonly symbolFingerprints: ReadonlySet<bigint>;
}

/** Resolves fingerprints against one evidence source; `undefined` means the evidence is no longer available. */
export type ProjectResolutionCandidateIndexLookup<E> = (query: {
  readonly maximumReferencePaths: number;
  readonly referenceFingerprints: ReadonlySet<bigint>;
  readonly symbolFingerprints: ReadonlySet<bigint>;
}) => Effect.Effect<ProjectResolutionCandidateIndexMatches | undefined, E>;

export function planProjectResolutionCandidateScan(input: {
  readonly bytesByPath: ReadonlyMap<string, number>;
  readonly files: readonly CodeGraphInventoryFile[];
  readonly maximumFactBytes?: number;
  readonly maximumFiles?: number;
  readonly pageMaximumFactBytes?: number;
  readonly pageMaximumFiles?: number;
}): ProjectResolutionCandidateScanPlan {
  const maximumFiles = input.maximumFiles ?? PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FILES;
  const maximumFactBytes = input.maximumFactBytes ?? PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES;
  const pageMaximumFiles = input.pageMaximumFiles ?? PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FILES;
  const pageMaximumFactBytes = input.pageMaximumFactBytes ?? PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES;
  if (
    !isNonNegativeSafeInteger(maximumFiles) ||
    !isNonNegativeSafeInteger(maximumFactBytes) ||
    !isPositiveSafeInteger(pageMaximumFiles) ||
    !isPositiveSafeInteger(pageMaximumFactBytes) ||
    new Set(EffectArray.map(input.files, file => file.path)).size !== input.files.length
  ) {
    return {mode: 'fallback', reason: 'cache-incomplete'};
  }
  if (input.files.length > maximumFiles) {
    return {
      detail: 'candidate-scan-files',
      limit: maximumFiles,
      mode: 'fallback',
      observed: input.files.length,
      reason: 'project-closure-unbounded',
    };
  }
  const ordered = [...input.files].sort((left, right) => compareCodeUnits(left.path, right.path));
  const pages: ProjectResolutionCandidateScanPage[] = [];
  let page: CodeGraphInventoryFile[] = [];
  let pageBytes = 0;
  let factBytes = 0;
  for (const file of ordered) {
    const bytes = input.bytesByPath.get(file.path);
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) {
      return {mode: 'fallback', reason: 'cache-incomplete'};
    }
    if (factBytes > maximumFactBytes - bytes) {
      return {
        detail: 'candidate-scan-fact-bytes',
        limit: maximumFactBytes,
        mode: 'fallback',
        observed: factBytes + bytes,
        reason: 'project-closure-unbounded',
      };
    }
    const pageFull = page.length > 0 && (page.length >= pageMaximumFiles || pageBytes > pageMaximumFactBytes - bytes);
    if (pageFull) {
      pages.push({factBytes: pageBytes, files: page});
      page = [];
      pageBytes = 0;
    }
    page.push(file);
    pageBytes += bytes;
    factBytes += bytes;
  }
  if (page.length > 0) pages.push({factBytes: pageBytes, files: page});
  return {factBytes, files: ordered.length, mode: 'eligible', pages};
}

/**
 * Find the complete bounded set of cached base references whose resolver
 * candidates can be affected by changed published lookup keys. One streaming
 * pass retains static reexport mappings and a bounded fingerprint projection
 * from lookup identities to evidence paths. Fingerprint collisions can only
 * add candidate paths or direct-symbol conflicts, so the result stays a safe
 * superset. The reexport fixed point is computed after the pass, then resolved
 * against that projection without decoding the repository a second time. Each
 * page must already be attributed to immediate repository/workspace lookup
 * keys; full facts are never retained between pages.
 */
export const scanProjectResolutionCandidateClosure = Effect.fn('codeGraph.scanProjectResolutionCandidateClosure')(
  function* <E>(input: {
    readonly maximumSelectedFiles: number;
    readonly maximumProjectionAssociations?: number;
    readonly maximumProjectionAssociationsPerFile?: number;
    readonly maximumProjectionObservations?: number;
    readonly maximumProjectionObservedKeyBytes?: number;
    /** Test seam for proving conservative collision behavior. */
    readonly projectionFingerprint?: (identity: string) => bigint;
    readonly plan: Extract<ProjectResolutionCandidateScanPlan, {readonly mode: 'eligible'}>;
    readonly initialLookupKeys: readonly ProjectResolutionLookupKey[];
    readonly additionalReexports?: readonly ProjectResolutionReexportKeys[];
    /** Membership evidence is complete only after all raw pages have been observed. */
    readonly finalizeLookupKeys?: () => readonly ProjectResolutionLookupKey[];
    readonly loadPage: (
      files: readonly CodeGraphInventoryFile[],
    ) => Effect.Effect<ProjectResolutionCandidateFactPage, E>;
    /** Receives the complete single-version evidence once every page has been observed. */
    readonly onIndex?: (index: ProjectResolutionCandidateIndex) => void;
  }) {
    const maximumProjectionAssociations =
      input.maximumProjectionAssociations ?? PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_ASSOCIATIONS;
    const maximumProjectionAssociationsPerFile =
      input.maximumProjectionAssociationsPerFile ?? PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_ASSOCIATIONS_PER_FILE;
    const maximumProjectionObservations =
      input.maximumProjectionObservations ?? PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVATIONS;
    const maximumProjectionObservedKeyBytes =
      input.maximumProjectionObservedKeyBytes ?? PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES;
    if (
      EffectArray.some(input.initialLookupKeys, value => !validResolutionLookupKey(value)) ||
      !isNonNegativeSafeInteger(input.maximumSelectedFiles) ||
      !isNonNegativeSafeInteger(maximumProjectionAssociations) ||
      !isNonNegativeSafeInteger(maximumProjectionAssociationsPerFile) ||
      !isNonNegativeSafeInteger(maximumProjectionObservations) ||
      !isNonNegativeSafeInteger(maximumProjectionObservedKeyBytes) ||
      maximumProjectionAssociations > PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_ASSOCIATIONS ||
      maximumProjectionAssociationsPerFile > PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_ASSOCIATIONS_PER_FILE ||
      maximumProjectionObservations > PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVATIONS ||
      maximumProjectionObservedKeyBytes > PROJECT_RESOLUTION_CANDIDATE_MAX_PROJECTION_OBSERVED_KEY_BYTES ||
      input.plan.files >= PROJECTION_SYMBOL_RECORD
    ) {
      return {mode: 'fallback', reason: 'cache-incomplete'} as const;
    }
    const initialLookupKeys = uniqueResolutionLookupKeys(input.initialLookupKeys);
    if (initialLookupKeys.length > PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS) {
      return unbounded('candidate-lookup-keys', initialLookupKeys.length, PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS);
    }
    const reexports: ProjectResolutionReexportKeys[] = [];
    const baseReexports: ProjectResolutionReexportKeys[] = [];
    const projection = createResolutionCandidateProjection({
      fingerprint: input.projectionFingerprint ?? resolutionCandidateIdentityFingerprint,
      files: input.plan.files,
      maximumAssociations: maximumProjectionAssociations,
      maximumAssociationsPerFile: maximumProjectionAssociationsPerFile,
      maximumObservations: maximumProjectionObservations,
      maximumObservedKeyBytes: maximumProjectionObservedKeyBytes,
    });
    const scannedPaths: string[] = [];
    let versioned = false;
    let reexportKeyBytes = 0;
    let reexportLookupKeys = 0;
    for (const reexport of input.additionalReexports ?? []) {
      const retained = retainReexport(reexport, reexports.length, reexportLookupKeys, reexportKeyBytes);
      if (retained.mode === 'fallback') return retained;
      reexports.push(retained.reexport);
      reexportKeyBytes = retained.totalKeyBytes;
      reexportLookupKeys = retained.totalLookupKeys;
    }
    for (const page of input.plan.pages) {
      const loaded = yield* input.loadPage(page.files);
      if (!completePage(page, loaded)) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
      for (const file of page.files) {
        const fileOrdinal = scannedPaths.length;
        scannedPaths.push(file.path);
        const currentFacts = loaded.facts.get(file.path)!;
        const previousFacts = loaded.previousFacts?.get(file.path);
        if (previousFacts !== undefined) versioned = true;
        for (const facts of previousFacts === undefined ? [currentFacts] : [previousFacts, currentFacts]) {
          if (!validFactLookupKeys(facts)) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
          for (const symbol of facts.symbols) {
            for (const key of symbol.lookupKeys ?? []) {
              const retained = projection.retainSymbol(
                resolutionLookupKeyIdentity(lookupKeyDomain(key, symbol.resolutionDomain), key),
              );
              if (retained !== undefined) return retained;
            }
          }
          for (const reference of facts.references ?? []) {
            for (const tier of reference.lookupTiers) {
              for (const key of tier) {
                const retained = projection.retainReference(
                  resolutionLookupKeyIdentity(reference.resolutionDomain, key),
                  fileOrdinal,
                );
                if (retained !== undefined) return retained;
              }
            }
            if (!isReexport(reference)) continue;
            const aliases = symbolResolutionLookupKeys(reference.resolutionDomain, reference.aliasLookupKeys ?? []);
            const candidates = resolutionLookupKeys(reference.resolutionDomain, reference.lookupTiers.flat());
            const retained = retainReexport(
              {aliases, candidates, sourcePath: reference.evidencePath},
              reexports.length,
              reexportLookupKeys,
              reexportKeyBytes,
            );
            if (retained.mode === 'fallback') return retained;
            reexports.push(retained.reexport);
            if (facts === currentFacts) baseReexports.push(retained.reexport);
            reexportKeyBytes = retained.totalKeyBytes;
            reexportLookupKeys = retained.totalLookupKeys;
          }
        }
      }
    }
    if (scannedPaths.length !== input.plan.files) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
    if (!versioned) input.onIndex?.(projection.index(scannedPaths, baseReexports));
    return yield* resolveObservedResolutionCandidateClosure({
      baseReexports,
      factBytes: input.plan.factBytes,
      fingerprint: projection.fingerprint,
      lookup: query => Effect.succeed(projection.match(query, scannedPaths)),
      lookupKeys: [...initialLookupKeys, ...(input.finalizeLookupKeys?.() ?? [])],
      maximumSelectedFiles: input.maximumSelectedFiles,
      ...(versioned ? {observation: projection.observation()} : {}),
      reexports,
      scannedFiles: input.plan.files,
    });
  },
);

/**
 * Resolve the same closure as the full scan from previously collected evidence.
 * Only fingerprints reachable from the edit are looked up, so the work is
 * proportional to the affected references rather than to the repository.
 */
export const resolveIndexedProjectResolutionCandidateClosure = Effect.fn(
  'codeGraph.resolveIndexedProjectResolutionCandidateClosure',
)(function* <E>(input: {
  readonly additionalReexports?: readonly ProjectResolutionReexportKeys[];
  readonly initialLookupKeys: readonly ProjectResolutionLookupKey[];
  readonly lookup: ProjectResolutionCandidateIndexLookup<E>;
  readonly maximumSelectedFiles: number;
  /** Must match the fingerprint that collected the evidence. */
  readonly projectionFingerprint?: (identity: string) => bigint;
  /** Base reexports in the order the collecting scan retained them. */
  readonly reexports: readonly ProjectResolutionReexportKeys[];
}) {
  if (
    EffectArray.some(input.initialLookupKeys, value => !validResolutionLookupKey(value)) ||
    !isNonNegativeSafeInteger(input.maximumSelectedFiles)
  ) {
    return {mode: 'fallback', reason: 'cache-incomplete'} as const;
  }
  const initialLookupKeys = uniqueResolutionLookupKeys(input.initialLookupKeys);
  if (initialLookupKeys.length > PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS) {
    return unbounded('candidate-lookup-keys', initialLookupKeys.length, PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS);
  }
  // Retain in the scan's order so every reexport cap observes the same totals.
  const reexports: ProjectResolutionReexportKeys[] = [];
  let reexportKeyBytes = 0;
  let reexportLookupKeys = 0;
  for (const reexport of [...(input.additionalReexports ?? []), ...input.reexports]) {
    const retained = retainReexport(reexport, reexports.length, reexportLookupKeys, reexportKeyBytes);
    if (retained.mode === 'fallback') return retained;
    reexports.push(retained.reexport);
    reexportKeyBytes = retained.totalKeyBytes;
    reexportLookupKeys = retained.totalLookupKeys;
  }
  const fingerprint = input.projectionFingerprint ?? resolutionCandidateIdentityFingerprint;
  return yield* resolveObservedResolutionCandidateClosure({
    baseReexports: input.reexports,
    factBytes: 0,
    fingerprint: identity => validProjectionFingerprint(fingerprint(identity)),
    lookup: input.lookup,
    lookupKeys: initialLookupKeys,
    maximumSelectedFiles: input.maximumSelectedFiles,
    reexports,
    scannedFiles: 0,
  });
});

const resolveObservedResolutionCandidateClosure = Effect.fn('codeGraph.resolveObservedResolutionCandidateClosure')(
  function* <E>(input: {
    readonly baseReexports: readonly ProjectResolutionReexportKeys[];
    readonly factBytes: number;
    readonly fingerprint: (identity: string) => bigint | undefined;
    readonly lookup: ProjectResolutionCandidateIndexLookup<E>;
    readonly lookupKeys: readonly ProjectResolutionLookupKey[];
    readonly maximumSelectedFiles: number;
    readonly observation?: {readonly projectionObservations: number; readonly projectionObservedKeyBytes: number};
    readonly reexports: readonly ProjectResolutionReexportKeys[];
    readonly scannedFiles: number;
  }) {
    const lookupKeys = resolutionCandidateLookupKeyClosure(input.lookupKeys, input.reexports);
    if (lookupKeys.mode === 'fallback') return lookupKeys;
    const referenceFingerprints = new Set<bigint>();
    for (const identity of lookupKeys.identities) {
      const fingerprint = input.fingerprint(identity);
      if (fingerprint === undefined) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
      referenceFingerprints.add(fingerprint);
    }
    const aliasFingerprints = new Map<string, bigint>();
    for (const reexport of input.reexports) {
      for (const alias of reexport.aliases) {
        const identity = resolutionLookupKeyIdentity(alias.resolutionDomain, alias.key);
        const fingerprint = input.fingerprint(identity);
        if (fingerprint === undefined) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
        aliasFingerprints.set(identity, fingerprint);
      }
    }
    const matches = yield* input.lookup({
      maximumReferencePaths: input.maximumSelectedFiles,
      referenceFingerprints,
      symbolFingerprints: new Set(aliasFingerprints.values()),
    });
    if (matches === undefined) return {mode: 'fallback', reason: 'cache-incomplete'} as const;
    if (matches.referencePaths.size > input.maximumSelectedFiles) {
      return unbounded('candidate-selected-files', input.maximumSelectedFiles + 1, input.maximumSelectedFiles);
    }
    const directAliasSymbolConflictIdentities = new Set<string>();
    for (const [identity, fingerprint] of aliasFingerprints) {
      if (matches.symbolFingerprints.has(fingerprint)) directAliasSymbolConflictIdentities.add(identity);
    }
    return {
      affectedAliasLookupIdentities: lookupKeys.aliasIdentities,
      directAliasSymbolConflictIdentities,
      factBytes: input.factBytes,
      lookupKeys: lookupKeys.identities.size,
      mode: 'eligible',
      paths: [...matches.referencePaths].sort(compareCodeUnits),
      reexports: input.baseReexports,
      scannedFiles: input.scannedFiles,
      ...input.observation,
    } as const;
  },
);

export type ProjectResolutionReexportKeys = {
  readonly aliases: readonly ProjectResolutionLookupKey[];
  readonly candidates: readonly ProjectResolutionLookupKey[];
  readonly sourcePath: string;
};

export function resolutionCandidateLookupKeyClosure(
  initialLookupKeys: readonly ProjectResolutionLookupKey[],
  reexports: readonly ProjectResolutionReexportKeys[],
  maximumLookupKeys = PROJECT_RESOLUTION_CANDIDATE_MAX_LOOKUP_KEYS,
):
  | {
      readonly aliasIdentities: ReadonlySet<string>;
      readonly identities: ReadonlySet<string>;
      readonly mode: 'eligible';
    }
  | Extract<ProjectResolutionCandidateClosure, {readonly mode: 'fallback'}> {
  if (
    !isNonNegativeSafeInteger(maximumLookupKeys) ||
    EffectArray.some(initialLookupKeys, value => !validResolutionLookupKey(value)) ||
    EffectArray.some(reexports, reexport =>
      EffectArray.some([...reexport.aliases, ...reexport.candidates], value => !validResolutionLookupKey(value)),
    )
  ) {
    return {mode: 'fallback', reason: 'cache-incomplete'};
  }
  // A reexport is a hyperedge: reaching any candidate reaches every alias.
  // Index candidates to the hyperedge rather than materializing the full
  // candidates*aliases Cartesian product. The encoded-key byte cap alone does
  // not bound that product for one broad reexport.
  const aliasesByReexport: Map<string, ProjectResolutionLookupKey>[] = [];
  const reexportsByCandidate = new Map<string, number[]>();
  for (const reexport of reexports) {
    const resolutionDomain = reexport.candidates[0]?.resolutionDomain;
    if (
      resolutionDomain !== undefined &&
      reexport.aliases.length > 0 &&
      (EffectArray.some(reexport.aliases, alias => alias.resolutionDomain !== resolutionDomain) ||
        EffectArray.some(reexport.candidates, candidate => candidate.resolutionDomain !== resolutionDomain))
    ) {
      return {mode: 'fallback', reason: 'cache-incomplete'};
    }
    const reexportIndex = aliasesByReexport.length;
    const aliases = new Map<string, ProjectResolutionLookupKey>();
    for (const alias of reexport.aliases) {
      aliases.set(resolutionLookupKeyIdentity(alias.resolutionDomain, alias.key), alias);
    }
    aliasesByReexport.push(aliases);
    const candidateIdentities = new Set<string>();
    for (const candidate of reexport.candidates) {
      const candidateIdentity = resolutionLookupKeyIdentity(candidate.resolutionDomain, candidate.key);
      if (candidateIdentities.has(candidateIdentity)) continue;
      candidateIdentities.add(candidateIdentity);
      const indexed = reexportsByCandidate.get(candidateIdentity) ?? [];
      indexed.push(reexportIndex);
      reexportsByCandidate.set(candidateIdentity, indexed);
    }
  }
  const initial = uniqueResolutionLookupKeys(initialLookupKeys);
  const keys = new Map(
    EffectArray.map(initial, value => [resolutionLookupKeyIdentity(value.resolutionDomain, value.key), value]),
  );
  if (keys.size > maximumLookupKeys) return unbounded('candidate-lookup-keys', keys.size, maximumLookupKeys);
  const queue = [...keys.values()];
  const aliasIdentities = new Set<string>();
  const expandedReexports = new Set<number>();
  for (let offset = 0; offset < queue.length; offset += 1) {
    const current = queue[offset];
    for (const reexportIndex of reexportsByCandidate.get(
      resolutionLookupKeyIdentity(current.resolutionDomain, current.key),
    ) ?? []) {
      if (expandedReexports.has(reexportIndex)) continue;
      expandedReexports.add(reexportIndex);
      for (const [identity, alias] of aliasesByReexport[reexportIndex]) {
        if (keys.has(identity)) continue;
        keys.set(identity, alias);
        aliasIdentities.add(identity);
        if (keys.size > maximumLookupKeys) return unbounded('candidate-lookup-keys', keys.size, maximumLookupKeys);
        queue.push(alias);
      }
    }
  }
  for (const reexport of reexports) {
    for (const alias of reexport.aliases) {
      const identity = resolutionLookupKeyIdentity(alias.resolutionDomain, alias.key);
      if (keys.has(identity)) aliasIdentities.add(identity);
    }
  }
  return {aliasIdentities, identities: new Set(keys.keys()), mode: 'eligible'};
}

function retainReexport(
  reexport: ProjectResolutionReexportKeys,
  retainedCount: number,
  retainedLookupKeys: number,
  retainedKeyBytes: number,
):
  | {
      readonly mode: 'eligible';
      readonly reexport: ProjectResolutionReexportKeys;
      readonly totalKeyBytes: number;
      readonly totalLookupKeys: number;
    }
  | Extract<ProjectResolutionCandidateClosure, {readonly mode: 'fallback'}> {
  const resolutionDomain = reexport.aliases[0]?.resolutionDomain;
  if (
    retainedCount >= PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS ||
    EffectArray.some([...reexport.aliases, ...reexport.candidates], value => !validResolutionLookupKey(value)) ||
    resolutionDomain === undefined ||
    reexport.candidates.length === 0 ||
    reexport.sourcePath.length === 0 ||
    EffectArray.some(reexport.aliases, alias => alias.resolutionDomain !== resolutionDomain) ||
    EffectArray.some(reexport.candidates, candidate => candidate.resolutionDomain !== resolutionDomain)
  ) {
    return retainedCount >= PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS
      ? unbounded('candidate-reexports', retainedCount + 1, PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS)
      : {mode: 'fallback', reason: 'cache-incomplete'};
  }
  const retainedBytes = utf8Bytes(
    EffectArray.flatMap([...reexport.aliases, ...reexport.candidates], value => [value.resolutionDomain, value.key]),
  );
  const lookupKeys = reexport.aliases.length + reexport.candidates.length;
  if (retainedLookupKeys > PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS - lookupKeys) {
    return unbounded(
      'candidate-reexport-lookup-keys',
      saturatingSafeIntegerAdd(retainedLookupKeys, lookupKeys),
      PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_LOOKUP_KEYS,
    );
  }
  if (retainedKeyBytes > PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES - retainedBytes) {
    return unbounded(
      'candidate-reexport-key-bytes',
      retainedKeyBytes + retainedBytes,
      PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES,
    );
  }
  return {
    mode: 'eligible',
    reexport,
    totalKeyBytes: retainedKeyBytes + retainedBytes,
    totalLookupKeys: retainedLookupKeys + lookupKeys,
  };
}

function createResolutionCandidateProjection(input: {
  readonly files: number;
  readonly fingerprint: (identity: string) => bigint;
  readonly maximumAssociations: number;
  readonly maximumAssociationsPerFile: number;
  readonly maximumObservations: number;
  readonly maximumObservedKeyBytes: number;
}) {
  const recordHashes: BigUint64Array[] = [];
  const recordKinds: Uint16Array[] = [];
  let records = 0;
  let associations = 0;
  let observations = 0;
  let observedKeyBytes = 0;
  let referenceFileOrdinal = -1;
  const referenceFingerprintsForFile = new Set<bigint>();

  const observe = (
    identity: string,
  ):
    | {readonly fingerprint: bigint; readonly mode: 'eligible'}
    | Extract<ProjectResolutionCandidateClosure, {readonly mode: 'fallback'}> => {
    if (observations >= input.maximumObservations) {
      return unbounded('candidate-projection-observations', observations + 1, input.maximumObservations);
    }
    const bytes = Buffer.byteLength(identity, 'utf8');
    if (observedKeyBytes > input.maximumObservedKeyBytes - bytes) {
      return unbounded(
        'candidate-projection-observed-key-bytes',
        saturatingSafeIntegerAdd(observedKeyBytes, bytes),
        input.maximumObservedKeyBytes,
      );
    }
    const fingerprint = validProjectionFingerprint(input.fingerprint(identity));
    if (fingerprint === undefined) return {mode: 'fallback', reason: 'cache-incomplete'};
    observations += 1;
    observedKeyBytes += bytes;
    return {fingerprint, mode: 'eligible'};
  };

  const append = (fingerprint: bigint, kind: number): void => {
    const chunkIndex = Math.floor(records / PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK);
    const offset = records % PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK;
    if (recordHashes[chunkIndex] === undefined) {
      recordHashes.push(new BigUint64Array(PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK));
      recordKinds.push(new Uint16Array(PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK));
    }
    recordHashes[chunkIndex][offset] = fingerprint;
    recordKinds[chunkIndex][offset] = kind;
    records += 1;
  };

  return {
    observation: () => ({projectionObservations: observations, projectionObservedKeyBytes: observedKeyBytes}),
    fingerprint: (identity: string): bigint | undefined => validProjectionFingerprint(input.fingerprint(identity)),
    retainReference: (
      identity: string,
      fileOrdinal: number,
    ): Extract<ProjectResolutionCandidateClosure, {readonly mode: 'fallback'}> | undefined => {
      const observation = observe(identity);
      if (observation.mode === 'fallback') return observation;
      if (!Number.isSafeInteger(fileOrdinal) || fileOrdinal < referenceFileOrdinal || fileOrdinal >= input.files) {
        return {mode: 'fallback', reason: 'cache-incomplete'};
      }
      if (fileOrdinal !== referenceFileOrdinal) {
        referenceFileOrdinal = fileOrdinal;
        referenceFingerprintsForFile.clear();
      }
      if (referenceFingerprintsForFile.has(observation.fingerprint)) return undefined;
      if (associations >= input.maximumAssociations) {
        return unbounded('candidate-projection-associations', associations + 1, input.maximumAssociations);
      }
      if (referenceFingerprintsForFile.size >= input.maximumAssociationsPerFile) {
        return unbounded(
          'candidate-projection-file-associations',
          referenceFingerprintsForFile.size + 1,
          input.maximumAssociationsPerFile,
        );
      }
      referenceFingerprintsForFile.add(observation.fingerprint);
      append(observation.fingerprint, fileOrdinal);
      associations += 1;
      return undefined;
    },
    retainSymbol: (
      identity: string,
    ): Extract<ProjectResolutionCandidateClosure, {readonly mode: 'fallback'}> | undefined => {
      const observation = observe(identity);
      if (observation.mode === 'fallback') return observation;
      append(observation.fingerprint, PROJECTION_SYMBOL_RECORD);
      return undefined;
    },
    match: (
      query: {
        readonly referenceFingerprints: ReadonlySet<bigint>;
        readonly symbolFingerprints: ReadonlySet<bigint>;
      },
      paths: readonly string[],
    ): ProjectResolutionCandidateIndexMatches | undefined => {
      const referencePaths = new Set<string>();
      const symbolFingerprints = new Set<bigint>();
      for (let record = 0; record < records; record += 1) {
        const chunkIndex = Math.floor(record / PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK);
        const offset = record % PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK;
        const fingerprint = recordHashes[chunkIndex][offset];
        const kind = recordKinds[chunkIndex][offset];
        if (kind === PROJECTION_SYMBOL_RECORD) {
          if (query.symbolFingerprints.has(fingerprint)) symbolFingerprints.add(fingerprint);
        } else if (query.referenceFingerprints.has(fingerprint)) {
          const path = paths[kind];
          if (path === undefined) return undefined;
          referencePaths.add(path);
        }
      }
      return {referencePaths, symbolFingerprints};
    },
    index: (
      paths: readonly string[],
      reexports: readonly ProjectResolutionReexportKeys[],
    ): ProjectResolutionCandidateIndex => {
      const referenceFingerprints = new BigUint64Array(associations);
      const referenceOrdinals = new Uint32Array(associations);
      const symbolFingerprints = new BigUint64Array(records - associations);
      let references = 0;
      let symbols = 0;
      for (let record = 0; record < records; record += 1) {
        const chunkIndex = Math.floor(record / PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK);
        const offset = record % PROJECT_RESOLUTION_CANDIDATE_PROJECTION_RECORDS_PER_CHUNK;
        const kind = recordKinds[chunkIndex][offset];
        if (kind === PROJECTION_SYMBOL_RECORD) {
          symbolFingerprints[symbols] = recordHashes[chunkIndex][offset];
          symbols += 1;
        } else {
          referenceFingerprints[references] = recordHashes[chunkIndex][offset];
          referenceOrdinals[references] = kind;
          references += 1;
        }
      }
      return {paths, referenceFingerprints, referenceOrdinals, reexports, symbolFingerprints};
    },
  };
}

const PROJECTION_SYMBOL_RECORD = 0xffff;
const PROJECTION_FINGERPRINT_MAXIMUM = 0xffff_ffff_ffff_ffffn;
const PROJECTION_FINGERPRINT_SEED = 0x85eb_ca6b_27d4_eb2fn;

function resolutionCandidateIdentityFingerprint(identity: string): bigint {
  return Bun.hash.wyhash(identity, PROJECTION_FINGERPRINT_SEED);
}

function validProjectionFingerprint(value: unknown): bigint | undefined {
  return typeof value === 'bigint' && value >= 0n && value <= PROJECTION_FINGERPRINT_MAXIMUM ? value : undefined;
}

function completePage(page: ProjectResolutionCandidateScanPage, loaded: ProjectResolutionCandidateFactPage): boolean {
  if (loaded.facts.size !== page.files.length || loaded.bytesByPath.size !== page.files.length) return false;
  if (
    loaded.previousFacts &&
    EffectArray.some(
      [...loaded.previousFacts],
      ([path, facts]) => facts.path !== path || !EffectArray.some(page.files, file => file.path === path),
    )
  )
    return false;
  let bytes = 0;
  for (const file of page.files) {
    const facts = loaded.facts.get(file.path);
    const factBytes = loaded.bytesByPath.get(file.path);
    if (facts?.path !== file.path || factBytes === undefined || !Number.isSafeInteger(factBytes) || factBytes < 0) {
      return false;
    }
    bytes += factBytes;
  }
  return bytes === page.factBytes;
}

function isReexport(reference: CodeGraphReference): boolean {
  return reference.relation === 'reexports' && (reference.aliasLookupKeys?.length ?? 0) > 0;
}

function resolutionLookupKeys(resolutionDomain: string, keys: readonly string[]): ProjectResolutionLookupKey[] {
  return uniqueResolutionLookupKeys(EffectArray.map(keys, key => ({key, resolutionDomain})));
}

function symbolResolutionLookupKeys(
  fallbackResolutionDomain: string,
  keys: readonly string[],
): ProjectResolutionLookupKey[] {
  return uniqueResolutionLookupKeys(
    EffectArray.map(keys, key => ({key, resolutionDomain: lookupKeyDomain(key, fallbackResolutionDomain)})),
  );
}

function lookupKeyDomain(key: string, fallback: string | undefined): string {
  const separator = Effect2.pipe(
    key,
    EffectString.indexOf(':'),
    Effect2.Option.getOrElse(() => -1),
  );
  return separator > 0 ? Effect2.pipe(key, EffectString.slice(0, separator)) : (fallback ?? 'generic');
}

function uniqueResolutionLookupKeys(values: readonly ProjectResolutionLookupKey[]): ProjectResolutionLookupKey[] {
  const output = new Map<string, ProjectResolutionLookupKey>();
  for (const value of values) {
    if (value.resolutionDomain.length === 0 || value.key.length === 0) continue;
    output.set(resolutionLookupKeyIdentity(value.resolutionDomain, value.key), value);
  }
  return [...output.values()].sort(
    (left, right) =>
      compareCodeUnits(left.resolutionDomain, right.resolutionDomain) || compareCodeUnits(left.key, right.key),
  );
}

function resolutionLookupKeyIdentity(resolutionDomain: string, key: string): string {
  return `${resolutionDomain}\0${key}`;
}

function validFactLookupKeys(facts: CodeGraphFileFacts): boolean {
  return EffectArray.every(facts.references ?? [], reference =>
    EffectArray.every([...(reference.aliasLookupKeys ?? []), ...reference.lookupTiers.flat()], key =>
      validResolutionLookupKey({key, resolutionDomain: reference.resolutionDomain}),
    ),
  );
}

function validResolutionLookupKey(value: {readonly key: string; readonly resolutionDomain?: string}): boolean {
  return (value.resolutionDomain?.length ?? 0) > 0 && value.key.length > 0;
}

function utf8Bytes(values: readonly string[]): number {
  return EffectArray.reduce(values, 0, (total, value) =>
    saturatingSafeIntegerAdd(total, Buffer.byteLength(value, 'utf8')),
  );
}

function saturatingSafeIntegerAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function unbounded(detail: ProjectResolutionCandidateScanFallbackDetail, observed: number, limit: number) {
  return {detail, limit, mode: 'fallback', observed, reason: 'project-closure-unbounded'} as const;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
