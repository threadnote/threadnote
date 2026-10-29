import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {compareCodeUnits} from '../ordering.js';
import {codeGraphQualifiedRefHandle} from '../workset/evidence.js';
import {canonicalCodeGraphMonikers} from './monikers.js';
import type {CodeGraphMonikerV1, CodeGraphSourceEvidenceV1} from './types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_VERSION = 1 as const;
export const CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION = 1 as const;

const REPOSITORY_ID = /^[0-9a-f]{64}$/u;
const MAX_REPOSITORY_KEY_LENGTH = 4_096;
const MAX_SNAPSHOT_ID_LENGTH = 256;

export interface CodeGraphBridgeRepositoryV1 {
  readonly monikers: readonly CodeGraphMonikerV1[];
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

export type CodeGraphBridgeEndpointReferenceV1 =
  {readonly componentId: string; readonly kind: 'component'} | {readonly kind: 'qualified-ref'; readonly ref: string};

export interface CodeGraphBridgeEndpointV1 {
  readonly evidence: Required<CodeGraphSourceEvidenceV1>;
  readonly identity: string;
  readonly monikerId: string;
  readonly reference: CodeGraphBridgeEndpointReferenceV1;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly role: 'export' | 'import';
  readonly snapshotId: string;
}

export type CodeGraphCrossRepositoryBridgeReasonV1 = 'declared-npm-package-compatible' | 'exact-protobuf-identity';

export interface CodeGraphCrossRepositoryBridgeV1 {
  readonly confidence: 1;
  readonly id: string;
  readonly identity: string;
  readonly kind: CodeGraphMonikerV1['kind'];
  readonly provenance: 'declared';
  readonly relation: 'depends_on' | 'imports';
  readonly resolutionDomain: CodeGraphMonikerV1['resolutionDomain'];
  readonly resolver: {
    readonly name: 'threadnote-native-moniker';
    readonly reason: CodeGraphCrossRepositoryBridgeReasonV1;
    readonly version: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION;
  };
  /** The consumer-side declared import. */
  readonly source: CodeGraphBridgeEndpointV1;
  /** The producer-side authoritative export. */
  readonly target: CodeGraphBridgeEndpointV1;
  readonly version: typeof CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_VERSION;
}

export type CodeGraphCrossRepositoryBridgeRejectionReasonV1 = 'ambiguous-producer' | 'incompatible-package-version';

export interface CodeGraphCrossRepositoryBridgeRejectionV1 {
  readonly candidateCount: number;
  readonly identity: string;
  readonly reason: CodeGraphCrossRepositoryBridgeRejectionReasonV1;
  readonly resolutionDomain: CodeGraphMonikerV1['resolutionDomain'];
  readonly source: CodeGraphBridgeEndpointV1;
}

export interface CodeGraphCrossRepositoryBridgeResolutionV1 {
  readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly rejections: readonly CodeGraphCrossRepositoryBridgeRejectionV1[];
  readonly resolverVersion: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION;
}

interface CanonicalRepository extends Omit<CodeGraphBridgeRepositoryV1, 'monikers'> {
  readonly monikers: readonly CodeGraphMonikerV1[];
}

interface LocatedMoniker {
  readonly moniker: CodeGraphMonikerV1;
  readonly repository: CanonicalRepository;
}

/**
 * Resolve only explicit import monikers to one exact, compatible export in a
 * different repository. The pure result is suitable for atomic generation
 * staging: it never guesses, reads source, or chooses among producers.
 */
export function resolveCodeGraphCrossRepositoryBridges(
  repositories: readonly CodeGraphBridgeRepositoryV1[],
): CodeGraphCrossRepositoryBridgeResolutionV1 {
  const canonicalRepositories = canonicalizeRepositories(repositories);
  const exportsByIdentity = indexExports(canonicalRepositories);
  const bridges: CodeGraphCrossRepositoryBridgeV1[] = [];
  const rejections: CodeGraphCrossRepositoryBridgeRejectionV1[] = [];

  for (const repository of canonicalRepositories) {
    for (const moniker of repository.monikers) {
      if (moniker.role !== 'import') continue;
      const allExactCandidates = exportsByIdentity.get(exactIdentityKey(moniker)) ?? [];
      // Local resolution owns a same-repository match. Without the local edge
      // result, choosing an identically named producer elsewhere would create
      // a false cross-repository edge.
      if (
        EffectArray.some(allExactCandidates, candidate => candidate.repository.repositoryId === repository.repositoryId)
      ) {
        continue;
      }
      const exactCandidates = EffectArray.filter(
        allExactCandidates,
        candidate => candidate.repository.repositoryId !== repository.repositoryId,
      );
      const compatibleCandidates = EffectArray.filter(exactCandidates, candidate =>
        monikersAreCompatible(moniker, candidate.moniker),
      );

      if (compatibleCandidates.length === 1) {
        bridges.push(createBridge({moniker, repository}, compatibleCandidates[0]));
        continue;
      }
      if (compatibleCandidates.length > 1) {
        rejections.push(rejection({moniker, repository}, 'ambiguous-producer', compatibleCandidates.length));
        continue;
      }
      if (moniker.scheme === 'package' && exactCandidates.length > 0) {
        rejections.push(rejection({moniker, repository}, 'incompatible-package-version', exactCandidates.length));
      }
    }
  }

  return {
    bridges: bridges.sort(compareBridges),
    rejections: rejections.sort(compareRejections),
    resolverVersion: CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION,
  };
}

/**
 * npm compatibility is deliberately fail-closed. An absent version on either
 * side leaves exact package identity authoritative. When both are present, the
 * producer must be an exact SemVer and the declaration must be a recognized
 * deterministic npm range.
 */
export function codeGraphNpmVersionsAreCompatible(
  importConstraint: string | undefined,
  exportVersion: string | undefined,
): boolean {
  if (importConstraint === undefined || exportVersion === undefined) return true;
  const version = parseExactSemver(exportVersion);
  if (version === undefined) return false;
  const clauses = EffectArray.map(Effect.pipe(importConstraint, EffectString.trim, EffectString.split('||')), clause =>
    Effect.pipe(clause, EffectString.trim),
  );
  return (
    clauses.length > 0 &&
    EffectArray.every(clauses, clause => clause.length > 0) &&
    EffectArray.some(clauses, clause => semverClauseMatches(version, clause))
  );
}

function canonicalizeRepositories(
  repositories: readonly CodeGraphBridgeRepositoryV1[],
): readonly CanonicalRepository[] {
  const repositoryKeys = new Set<string>();
  const snapshotMembers = new Set<string>();
  const canonical = EffectArray.map(repositories, repository => {
    if (!REPOSITORY_ID.test(repository.repositoryId)) {
      throw new Error('Cross-repository bridge repository identity is invalid.');
    }
    const repositoryKey = boundedCanonicalText(repository.repositoryKey, 'repository key', MAX_REPOSITORY_KEY_LENGTH);
    const snapshotId = boundedCanonicalText(repository.snapshotId, 'snapshot identity', MAX_SNAPSHOT_ID_LENGTH);
    if (repositoryKeys.has(repositoryKey)) {
      throw new Error('Cross-repository bridge repository keys must be unique.');
    }
    repositoryKeys.add(repositoryKey);
    const snapshotMember = `${repository.repositoryId}\0${snapshotId}`;
    if (snapshotMembers.has(snapshotMember)) {
      throw new Error('Cross-repository bridge repository snapshots must be unique.');
    }
    snapshotMembers.add(snapshotMember);
    return {
      monikers: canonicalCodeGraphMonikers(repository.monikers),
      repositoryId: repository.repositoryId,
      repositoryKey,
      snapshotId,
    } satisfies CanonicalRepository;
  });
  return canonical.sort(compareRepositories);
}

function indexExports(repositories: readonly CanonicalRepository[]): ReadonlyMap<string, readonly LocatedMoniker[]> {
  const mutable = new Map<string, LocatedMoniker[]>();
  for (const repository of repositories) {
    for (const moniker of repository.monikers) {
      if (moniker.role !== 'export') continue;
      const key = exactIdentityKey(moniker);
      const values = mutable.get(key) ?? [];
      values.push({moniker, repository});
      mutable.set(key, values);
    }
  }
  return new Map(
    EffectArray.map([...mutable], ([key, values]) => [key, values.sort(compareLocatedMonikers)] as const).sort(
      ([left], [right]) => compareCodeUnits(left, right),
    ),
  );
}

function exactIdentityKey(moniker: CodeGraphMonikerV1): string {
  return EffectArray.join([moniker.scheme, moniker.resolutionDomain, moniker.kind, moniker.identity], '\0');
}

function monikersAreCompatible(importMoniker: CodeGraphMonikerV1, exportMoniker: CodeGraphMonikerV1): boolean {
  if (
    importMoniker.role !== 'import' ||
    exportMoniker.role !== 'export' ||
    exactIdentityKey(importMoniker) !== exactIdentityKey(exportMoniker)
  ) {
    return false;
  }
  if (importMoniker.scheme === 'package' && exportMoniker.scheme === 'package') {
    return (
      importMoniker.packageName === exportMoniker.packageName &&
      importMoniker.dependencyKind !== undefined &&
      codeGraphNpmVersionsAreCompatible(importMoniker.packageVersion, exportMoniker.packageVersion)
    );
  }
  return importMoniker.scheme === 'protobuf' && exportMoniker.scheme === 'protobuf';
}

function createBridge(source: LocatedMoniker, target: LocatedMoniker): CodeGraphCrossRepositoryBridgeV1 {
  const sourceEndpoint = bridgeEndpoint(source);
  const targetEndpoint = bridgeEndpoint(target);
  const packageBridge = source.moniker.scheme === 'package';
  const reason: CodeGraphCrossRepositoryBridgeReasonV1 = packageBridge
    ? 'declared-npm-package-compatible'
    : 'exact-protobuf-identity';
  const id = `cgb_${sha256HexSync(
    EffectArray.join(
      EffectArray.map(
        [
          'threadnote-code-graph-cross-repository-bridge-v1',
          CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION,
          source.moniker.resolutionDomain,
          source.moniker.kind,
          source.moniker.identity,
          source.repository.repositoryId,
          source.repository.snapshotId,
          source.moniker.id,
          target.repository.repositoryId,
          target.repository.snapshotId,
          target.moniker.id,
        ],
        item => (item === null || item === undefined ? '' : String(item)),
      ),
      '\0',
    ),
  )}`;
  return {
    confidence: 1,
    id,
    identity: source.moniker.identity,
    kind: source.moniker.kind,
    provenance: 'declared',
    relation: packageBridge ? 'depends_on' : 'imports',
    resolutionDomain: source.moniker.resolutionDomain,
    resolver: {name: 'threadnote-native-moniker', reason, version: CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION},
    source: sourceEndpoint,
    target: targetEndpoint,
    version: CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_VERSION,
  };
}

function bridgeEndpoint(located: LocatedMoniker): CodeGraphBridgeEndpointV1 {
  const {moniker, repository} = located;
  return {
    evidence: {path: moniker.evidence.path, span: moniker.evidence.span},
    identity: moniker.identity,
    monikerId: moniker.id,
    reference:
      moniker.scheme === 'package'
        ? {componentId: moniker.componentId, kind: 'component'}
        : {
            kind: 'qualified-ref',
            ref: codeGraphQualifiedRefHandle({nodeId: moniker.symbolId, repositoryId: repository.repositoryId}),
          },
    repositoryId: repository.repositoryId,
    repositoryKey: repository.repositoryKey,
    role: moniker.role,
    snapshotId: repository.snapshotId,
  };
}

function rejection(
  source: LocatedMoniker,
  reason: CodeGraphCrossRepositoryBridgeRejectionReasonV1,
  candidateCount: number,
): CodeGraphCrossRepositoryBridgeRejectionV1 {
  return {
    candidateCount,
    identity: source.moniker.identity,
    reason,
    resolutionDomain: source.moniker.resolutionDomain,
    source: bridgeEndpoint(source),
  };
}

function compareRepositories(left: CanonicalRepository, right: CanonicalRepository): number {
  return (
    compareCodeUnits(left.repositoryKey, right.repositoryKey) ||
    compareCodeUnits(left.repositoryId, right.repositoryId) ||
    compareCodeUnits(left.snapshotId, right.snapshotId)
  );
}

function compareLocatedMonikers(left: LocatedMoniker, right: LocatedMoniker): number {
  return (
    compareRepositories(left.repository, right.repository) ||
    compareCodeUnits(left.moniker.identity, right.moniker.identity) ||
    compareCodeUnits(left.moniker.id, right.moniker.id)
  );
}

function compareBridges(left: CodeGraphCrossRepositoryBridgeV1, right: CodeGraphCrossRepositoryBridgeV1): number {
  return (
    compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
    compareCodeUnits(left.identity, right.identity) ||
    compareCodeUnits(left.source.repositoryKey, right.source.repositoryKey) ||
    compareCodeUnits(left.target.repositoryKey, right.target.repositoryKey) ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareRejections(
  left: CodeGraphCrossRepositoryBridgeRejectionV1,
  right: CodeGraphCrossRepositoryBridgeRejectionV1,
): number {
  return (
    compareCodeUnits(left.resolutionDomain, right.resolutionDomain) ||
    compareCodeUnits(left.identity, right.identity) ||
    compareCodeUnits(left.source.repositoryKey, right.source.repositoryKey) ||
    compareCodeUnits(left.source.monikerId, right.source.monikerId) ||
    compareCodeUnits(left.reason, right.reason)
  );
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

interface PartialSemver {
  readonly major?: number;
  readonly minor?: number;
  readonly patch?: number;
}

function semverClauseMatches(version: ParsedSemver, rawClause: string): boolean {
  const clause = Effect.pipe(
    rawClause,
    EffectString.replace(/([<>]=?|[~^])\s+/gu, '$1'),
    EffectString.replaceAll(',', ' '),
    EffectString.trim,
  );
  const exact = parseExactSemver(Effect.pipe(clause, EffectString.replace(/^=/u, '')));
  if (exact !== undefined) return compareSemver(version, exact) === 0;
  if (version.prerelease.length > 0) return false;

  const hyphen = Effect.pipe(
    clause,
    EffectString.match(/^(\S+)\s+-\s+(\S+)$/u),
    Effect.Option.getOrElse(() => null),
  );
  if (hyphen !== null) {
    const lower = parseExactSemver(hyphen[1]);
    const upper = parseExactSemver(hyphen[2]);
    return (
      lower !== undefined &&
      upper !== undefined &&
      compareSemver(version, lower) >= 0 &&
      compareSemver(version, upper) <= 0
    );
  }

  const tokens = EffectArray.filter(Effect.pipe(clause, EffectString.split(/\s+/u)), Boolean);
  return tokens.length > 0 && EffectArray.every(tokens, token => semverTokenMatches(version, token));
}

function semverTokenMatches(version: ParsedSemver, token: string): boolean {
  if (/^(?:\*|x)$/iu.test(token)) return true;

  const caret = Effect.pipe(
    token,
    EffectString.match(/^\^(.+)$/u),
    Effect.Option.getOrElse(() => null),
  );
  if (caret !== null) {
    const partial = parsePartialSemver(caret[1]);
    const lower = partial === undefined ? parseExactSemver(caret[1]) : partialLowerBound(partial);
    if (lower === undefined) return false;
    const upper = caretUpperBound(lower, partial);
    return compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0;
  }

  const tilde = Effect.pipe(
    token,
    EffectString.match(/^~(.+)$/u),
    Effect.Option.getOrElse(() => null),
  );
  if (tilde !== null) {
    const partial = parsePartialSemver(tilde[1]);
    const lower = partial === undefined ? undefined : partialLowerBound(partial);
    if (partial === undefined || lower === undefined || partial.major === undefined) return false;
    const upper =
      partial.minor === undefined ? semver(partial.major + 1, 0, 0) : semver(partial.major, partial.minor + 1, 0);
    return compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0;
  }

  const comparator = Effect.pipe(
    token,
    EffectString.match(/^(<=|>=|<|>)(.+)$/u),
    Effect.Option.getOrElse(() => null),
  );
  if (comparator !== null) {
    const bound = lowerBound(comparator[2]);
    if (bound === undefined) return false;
    const comparison = compareSemver(version, bound);
    switch (comparator[1]) {
      case '<':
        return comparison < 0;
      case '<=':
        return comparison <= 0;
      case '>':
        return comparison > 0;
      case '>=':
        return comparison >= 0;
    }
  }

  const partial = parsePartialSemver(Effect.pipe(token, EffectString.replace(/^=/u, '')));
  if (partial === undefined || partial.major === undefined) return false;
  if (partial.minor === undefined) return version.major === partial.major;
  if (partial.patch === undefined) return version.major === partial.major && version.minor === partial.minor;
  return (
    version.major === partial.major &&
    version.minor === partial.minor &&
    version.patch === partial.patch &&
    version.prerelease.length === 0
  );
}

function lowerBound(value: string): ParsedSemver | undefined {
  return (
    parseExactSemver(value) ??
    (partial => (partial === undefined ? undefined : partialLowerBound(partial)))(parsePartialSemver(value))
  );
}

function caretUpperBound(lower: ParsedSemver, partial: PartialSemver | undefined): ParsedSemver {
  if (lower.major > 0) return semver(lower.major + 1, 0, 0);
  if (partial === undefined) {
    return lower.minor > 0 ? semver(0, lower.minor + 1, 0) : semver(0, 0, lower.patch + 1);
  }
  if (partial.minor === undefined) return semver(1, 0, 0);
  if (lower.minor > 0) return semver(0, lower.minor + 1, 0);
  return partial.patch === undefined ? semver(0, 1, 0) : semver(0, 0, lower.patch + 1);
}

function parsePartialSemver(value: string): PartialSemver | undefined {
  const normalized = Effect.pipe(value, EffectString.trim, EffectString.replace(/^v/u, ''));
  if (!normalized || /[-+]/u.test(normalized)) return undefined;
  const parts = Effect.pipe(normalized, EffectString.split('.'));
  if (parts.length > 3) return undefined;
  const output: {major?: number; minor?: number; patch?: number} = {};
  const keys = ['major', 'minor', 'patch'] as const;
  let wildcard = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (/^(?:\*|x)$/iu.test(part)) {
      wildcard = true;
      continue;
    }
    if (wildcard || !/^(?:0|[1-9]\d*)$/u.test(part)) return undefined;
    const parsed = Number(part);
    if (!Number.isSafeInteger(parsed)) return undefined;
    output[keys[index]] = parsed;
  }
  return output;
}

function partialLowerBound(value: PartialSemver): ParsedSemver | undefined {
  return value.major === undefined ? undefined : semver(value.major, value.minor ?? 0, value.patch ?? 0);
}

function parseExactSemver(value: string): ParsedSemver | undefined {
  const match = Effect.pipe(value, __effectPipeInput => {
    const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.trim);
    const __effectPipeStage1 = Effect.pipe(
      __effectPipeStage0,
      EffectString.match(
        /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
      ),
      Effect.Option.getOrElse(() => null),
    );
    return __effectPipeStage1;
  });
  if (match === null) return undefined;
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!EffectArray.every(numbers, Number.isSafeInteger)) return undefined;
  const prerelease =
    Effect.pipe(match[4], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.split('.')),
    ) ?? [];
  if (
    EffectArray.some(
      prerelease,
      identifier =>
        /^\d+$/u.test(identifier) && identifier.length > 1 && Effect.pipe(identifier, EffectString.startsWith('0')),
    )
  ) {
    return undefined;
  }
  return {major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease};
}

function semver(major: number, minor: number, patch: number): ParsedSemver {
  return {major, minor, patch, prerelease: []};
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  const core = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (core !== 0) return core < 0 ? -1 : 1;
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return compareCodeUnits(leftPart, rightPart);
  }
  return 0;
}

function boundedCanonicalText(value: string, label: string, maximumLength: number): string {
  const normalized = Effect.pipe(value, EffectString.normalize('NFC'), EffectString.trim);
  if (
    !normalized ||
    normalized.length > maximumLength ||
    EffectArray.some(
      [...normalized],
      character =>
        Effect.pipe(
          character,
          EffectString.codePointAt(0),
          Effect.Option.getOrElse(() => undefined),
        )! < 32 ||
        Effect.pipe(
          character,
          EffectString.codePointAt(0),
          Effect.Option.getOrElse(() => undefined),
        ) === 127,
    )
  ) {
    throw new Error(`Cross-repository bridge ${label} is invalid.`);
  }
  return normalized;
}
