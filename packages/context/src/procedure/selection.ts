import {Array as EffectArray, Predicate} from 'effect';
import {findAgentSurface, type AgentCatalogEntry} from '@threadnote/integrations/catalog';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  compareSemanticVersions,
  parseProcedureManifest,
  parseProcedureVerificationReceipt,
  procedureManifestSha256,
  procedureStatus,
  type ProcedureManifest,
  type ProcedureManifestV2,
  type ProcedureRollout,
  type ProcedureVerificationReceipt,
} from './contract.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

export const MAXIMUM_CONTEXT_BRIEF_PROCEDURES = 4;

export type VerifiedProcedureCoverageGap =
  'procedure-evidence-truncated' | 'procedure-evidence-unavailable' | 'procedure-version-conflict';

export interface PublishedProcedureCandidate {
  readonly artifactSha256: string;
  readonly manifest: ProcedureManifestV2;
  readonly receipt: ProcedureVerificationReceipt;
  readonly team: string;
}

export interface VerifiedProcedureEvidence {
  readonly artifact: {
    readonly id: string;
    readonly semanticVersion: string;
  };
  readonly dependencies: ProcedureManifest['dependencies'];
  readonly owner: string;
  readonly provenance: {
    readonly artifactSha256: string;
    readonly kind: 'verified-procedure-git-share';
    readonly manifestSha256: string;
    readonly team: string;
    readonly threadnoteVersion: string;
    readonly verifiedAt: string;
    readonly verifier: string;
  };
  readonly reviewedOn: string;
  readonly rollout: ProcedureRollout;
  readonly summary: string;
}

export interface SelectVerifiedProceduresInput {
  readonly candidates: readonly PublishedProcedureCandidate[];
  readonly channel?: ProcedureRollout['channel'];
  readonly cohort: string;
  readonly limit?: number;
  readonly surface: string;
  readonly task: string;
}

export interface VerifiedProcedureSelection {
  readonly gaps: readonly VerifiedProcedureCoverageGap[];
  readonly procedures: readonly VerifiedProcedureEvidence[];
}

/** Selects reviewed metadata only. Artifacts and verification commands never enter an agent prompt. */
export function selectVerifiedProcedures(input: SelectVerifiedProceduresInput): readonly VerifiedProcedureEvidence[] {
  return selectVerifiedProcedureEvidence(input).procedures;
}

/** Selects reviewed metadata and reports fail-closed repository conflicts as bounded coverage gaps. */
export function selectVerifiedProcedureEvidence(input: SelectVerifiedProceduresInput): VerifiedProcedureSelection {
  const surface = findAgentSurface(input.surface);
  if (surface === undefined) return {gaps: [], procedures: []};
  const channel = input.channel ?? 'stable';
  const limit = Math.max(
    0,
    Math.min(input.limit ?? MAXIMUM_CONTEXT_BRIEF_PROCEDURES, MAXIMUM_CONTEXT_BRIEF_PROCEDURES),
  );
  if (limit === 0) return {gaps: [], procedures: []};
  const conflictedKeys = conflictingCandidateKeys(input.candidates);
  const integrityFailures = EffectArray.filter(input.candidates, candidate => !hasCurrentIntegrity(candidate));
  const currentCandidates = input.candidates;
  const current = EffectArray.filter(
    EffectArray.filter(
      currentCandidates,
      (candidate, __effectArrayIndex) =>
        __effectArrayIndex in currentCandidates && hasCurrentIntegrity(candidate) && isCompatible(candidate, surface),
    ),
    candidate => !conflictedKeys.has(candidateKey(candidate)),
  ).sort(compareCandidate);
  const byArtifact = groupBy(current, candidate => candidate.manifest.artifact.id);
  const roots = EffectArray.filter(
    EffectArray.map(
      [...byArtifact.entries()],
      ([artifactId, candidates]) =>
        [artifactId, EffectArray.filter(candidates, candidate => taskMatches(candidate.manifest, input.task))] as const,
    ),
    ([, candidates]) => candidates.length > 0,
  ).sort(([left], [right]) => compareText(left, right));
  const admitted = new Map<string, PublishedProcedureCandidate>();
  const visiting = new Set<string>();
  const cohort = `${input.cohort}\u0000${surface.id}`;
  for (const [, versions] of roots) {
    const root = selectVersion(versions, channel, cohort);
    if (root === undefined || !admitWithDependencies(root, current, channel, cohort, admitted, visiting, limit)) {
      continue;
    }
    if (admitted.size >= limit) break;
  }
  const gaps: VerifiedProcedureCoverageGap[] = [];
  if (integrityFailures.length > 0) gaps.push('procedure-evidence-unavailable');
  if (conflictedKeys.size > 0) gaps.push('procedure-version-conflict');
  return {
    gaps,
    procedures: EffectArray.map([...admitted.values()], toEvidence),
  };
}

/** Strictly validates the non-executable procedure evidence carried by public Context Brief channels. */
export function parseVerifiedProcedureEvidenceList(value: unknown): readonly VerifiedProcedureEvidence[] {
  if (!EffectArray.isArray(value) || value.length > MAXIMUM_CONTEXT_BRIEF_PROCEDURES) {
    throw new Error(`verifiedProcedures must contain at most ${MAXIMUM_CONTEXT_BRIEF_PROCEDURES} entries`);
  }
  return EffectArray.map(value, (entry, index) =>
    parseVerifiedProcedureEvidence(entry, `verifiedProcedures[${index}]`),
  );
}

function parseVerifiedProcedureEvidence(value: unknown, label: string): VerifiedProcedureEvidence {
  const source = evidenceObject(value, label);
  exactEvidenceKeys(
    source,
    ['artifact', 'dependencies', 'owner', 'provenance', 'reviewedOn', 'rollout', 'summary'],
    label,
  );
  const artifact = evidenceObject(source.artifact, `${label}.artifact`);
  exactEvidenceKeys(artifact, ['id', 'semanticVersion'], `${label}.artifact`);
  const provenance = evidenceObject(source.provenance, `${label}.provenance`);
  exactEvidenceKeys(
    provenance,
    ['artifactSha256', 'kind', 'manifestSha256', 'team', 'threadnoteVersion', 'verifiedAt', 'verifier'],
    `${label}.provenance`,
  );
  const rollout = evidenceObject(source.rollout, `${label}.rollout`);
  exactEvidenceKeys(rollout, ['channel', 'percentage'], `${label}.rollout`);
  if (provenance.kind !== 'verified-procedure-git-share') {
    throw new Error(`${label}.provenance.kind is invalid`);
  }
  boundedOpaqueText(provenance.team, `${label}.provenance.team`);
  const manifest = parseProcedureManifest({
    artifact: {
      id: artifact.id,
      semanticVersion: artifact.semanticVersion,
      sha256: provenance.artifactSha256,
    },
    compatible: {capabilities: [], surfaceIds: []},
    dependencies: source.dependencies,
    owner: source.owner,
    presentation: {summary: source.summary, taskKeywords: []},
    relatedDurableMemoryIds: [],
    reviewedOn: source.reviewedOn,
    rollout,
    schemaVersion: 2,
    verification: {commands: [], fixtures: []},
  });
  if (manifest.schemaVersion !== 2) throw new Error(`${label} is not publishable procedure evidence`);
  parseProcedureVerificationReceipt({
    artifact: manifest.artifact,
    commandIds: [],
    fixtureDigests: [],
    hostVersion: 'context-brief-projection',
    manifestSha256: provenance.manifestSha256,
    schemaVersion: 1,
    threadnoteVersion: provenance.threadnoteVersion,
    verifiedAt: provenance.verifiedAt,
    verifier: provenance.verifier,
  });
  if (!isVerifiedProcedureEvidence(value)) throw new Error(`${label} is not valid procedure evidence`);
  return value;
}

function isEvidenceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function isProcedureDependencyList(value: unknown): value is ProcedureManifest['dependencies'] {
  return (
    EffectArray.isArray(value) &&
    EffectArray.every(
      value,
      dependency =>
        isEvidenceRecord(dependency) &&
        typeof dependency.artifactId === 'string' &&
        typeof dependency.semanticVersion === 'string',
    )
  );
}

function isVerifiedProcedureEvidence(value: unknown): value is VerifiedProcedureEvidence {
  if (!isEvidenceRecord(value)) return false;
  const artifact = value.artifact;
  const provenance = value.provenance;
  const rollout = value.rollout;
  return (
    isEvidenceRecord(artifact) &&
    typeof artifact.id === 'string' &&
    typeof artifact.semanticVersion === 'string' &&
    isProcedureDependencyList(value.dependencies) &&
    typeof value.owner === 'string' &&
    isEvidenceRecord(provenance) &&
    typeof provenance.artifactSha256 === 'string' &&
    provenance.kind === 'verified-procedure-git-share' &&
    typeof provenance.manifestSha256 === 'string' &&
    typeof provenance.team === 'string' &&
    typeof provenance.threadnoteVersion === 'string' &&
    typeof provenance.verifiedAt === 'string' &&
    typeof provenance.verifier === 'string' &&
    typeof value.reviewedOn === 'string' &&
    isEvidenceRecord(rollout) &&
    (rollout.channel === 'preview' || rollout.channel === 'stable') &&
    typeof rollout.percentage === 'number' &&
    typeof value.summary === 'string'
  );
}

function admitWithDependencies(
  candidate: PublishedProcedureCandidate,
  candidates: readonly PublishedProcedureCandidate[],
  channel: ProcedureRollout['channel'],
  cohort: string,
  admitted: Map<string, PublishedProcedureCandidate>,
  visiting: Set<string>,
  limit: number,
): boolean {
  const key = candidateKey(candidate);
  if (admitted.has(key)) return true;
  if (visiting.has(key) || admitted.size >= limit) return false;
  const before = new Set(admitted.keys());
  visiting.add(key);
  for (const dependency of candidate.manifest.dependencies) {
    const found = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        candidates,
        __effectArrayValue =>
          !!(value =>
            value.manifest.artifact.id === dependency.artifactId &&
            value.manifest.artifact.semanticVersion === dependency.semanticVersion &&
            rolloutAdmits(value.manifest, channel, cohort))(__effectArrayValue),
      ),
    );
    if (found === undefined || !admitWithDependencies(found, candidates, channel, cohort, admitted, visiting, limit)) {
      for (const admittedKey of admitted.keys()) if (!before.has(admittedKey)) admitted.delete(admittedKey);
      visiting.delete(key);
      return false;
    }
  }
  visiting.delete(key);
  if (admitted.size >= limit) {
    for (const admittedKey of admitted.keys()) if (!before.has(admittedKey)) admitted.delete(admittedKey);
    return false;
  }
  admitted.set(key, candidate);
  return true;
}

function hasCurrentIntegrity(candidate: PublishedProcedureCandidate): boolean {
  return (
    candidate.artifactSha256 === candidate.manifest.artifact.sha256 &&
    procedureStatus(candidate.manifest, {
      capabilities: candidate.manifest.compatible.capabilities,
      localArtifactSha256: candidate.artifactSha256,
      receipt: candidate.receipt,
      surfaceIds: candidate.manifest.compatible.surfaceIds,
    }) === 'current'
  );
}

function isCompatible(candidate: PublishedProcedureCandidate, surface: AgentCatalogEntry): boolean {
  const capabilities: readonly string[] = EffectArray.map(
    EffectArray.filter(
      EffectRecord.toEntries(surface.capabilities),
      ([, capability]) => capability.status === 'managed',
    ),
    ([name]) => name,
  );
  const surfaceIds = [...new Set([surface.id, surface.agentId, ...surface.aliases])];
  return (
    EffectArray.every(candidate.manifest.compatible.capabilities, capability => capabilities.includes(capability)) &&
    (candidate.manifest.compatible.surfaceIds.length === 0 ||
      EffectArray.some(candidate.manifest.compatible.surfaceIds, id => surfaceIds.includes(id)))
  );
}

function selectVersion(
  candidates: readonly PublishedProcedureCandidate[],
  channel: ProcedureRollout['channel'],
  cohort: string,
): PublishedProcedureCandidate | undefined {
  return EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...candidates].sort((left, right) => {
        const byVersion = compareSemanticVersions(
          right.manifest.artifact.semanticVersion,
          left.manifest.artifact.semanticVersion,
        );
        return byVersion || compareCandidate(left, right);
      }),
      __effectArrayValue => !!(candidate => rolloutAdmits(candidate.manifest, channel, cohort))(__effectArrayValue),
    ),
  );
}

function rolloutAdmits(manifest: ProcedureManifestV2, channel: ProcedureRollout['channel'], cohort: string): boolean {
  if (manifest.rollout.channel !== channel || manifest.rollout.percentage === 0) return false;
  if (manifest.rollout.percentage === 100) return true;
  const bucket =
    Number.parseInt(
      Effect.pipe(
        sha256HexSync(`${manifest.artifact.id}\u0000${manifest.artifact.semanticVersion}\u0000${cohort}`),
        EffectString.slice(0, 8),
      ),
      16,
    ) % 100;
  return bucket < manifest.rollout.percentage;
}

function taskMatches(manifest: ProcedureManifestV2, task: string): boolean {
  if (manifest.presentation.taskKeywords.length === 0) return true;
  const taskTokens = new Set(
    Effect.pipe(task, __effectPipeInput => {
      const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.toLowerCase);
      const __effectPipeStage1 = Effect.pipe(
        __effectPipeStage0,
        EffectString.match(/[a-z0-9]+/gu),
        Effect.Option.getOrElse(() => null),
      );
      return __effectPipeStage1;
    }) ?? [],
  );
  return EffectArray.some(manifest.presentation.taskKeywords, keyword =>
    EffectArray.every(
      Effect.pipe(keyword, __effectPipeInput => {
        const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.toLowerCase);
        const __effectPipeStage1 = Effect.pipe(
          __effectPipeStage0,
          EffectString.match(/[a-z0-9]+/gu),
          Effect.Option.getOrElse(() => null),
        );
        return __effectPipeStage1;
      }) ?? [],
      token => taskTokens.has(token),
    ),
  );
}

function toEvidence(candidate: PublishedProcedureCandidate): VerifiedProcedureEvidence {
  const {manifest, receipt} = candidate;
  return {
    artifact: {id: manifest.artifact.id, semanticVersion: manifest.artifact.semanticVersion},
    dependencies: manifest.dependencies,
    owner: manifest.owner,
    provenance: {
      artifactSha256: candidate.artifactSha256,
      kind: 'verified-procedure-git-share',
      manifestSha256: procedureManifestSha256(manifest),
      team: candidate.team,
      threadnoteVersion: receipt.threadnoteVersion,
      verifiedAt: receipt.verifiedAt,
      verifier: receipt.verifier,
    },
    reviewedOn: manifest.reviewedOn,
    rollout: manifest.rollout,
    summary: manifest.presentation.summary,
  };
}

function candidateKey(candidate: PublishedProcedureCandidate): string {
  return `${candidate.manifest.artifact.id}\u0000${candidate.manifest.artifact.semanticVersion}`;
}

function conflictingCandidateKeys(candidates: readonly PublishedProcedureCandidate[]): ReadonlySet<string> {
  const identities = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const receipt = candidate.receipt;
    const identity = JSON.stringify({
      artifactSha256: candidate.artifactSha256,
      manifestSha256: procedureManifestSha256(candidate.manifest),
      receipt: {
        artifact: receipt.artifact,
        commandIds: receipt.commandIds,
        fixtureDigests: receipt.fixtureDigests,
        hostVersion: receipt.hostVersion,
        manifestSha256: receipt.manifestSha256,
        schemaVersion: receipt.schemaVersion,
        threadnoteVersion: receipt.threadnoteVersion,
        verifiedAt: receipt.verifiedAt,
        verifier: receipt.verifier,
      },
    });
    identities.set(key, new Set([...(identities.get(key) ?? []), identity]));
  }
  return new Set(
    EffectArray.map(
      EffectArray.filter([...identities.entries()], ([, values]) => values.size > 1),
      ([key]) => key,
    ),
  );
}

function compareCandidate(left: PublishedProcedureCandidate, right: PublishedProcedureCandidate): number {
  return (
    compareText(candidateKey(left), candidateKey(right)) ||
    compareText(procedureManifestSha256(left.manifest), procedureManifestSha256(right.manifest)) ||
    compareText(left.team, right.team)
  );
}

function groupBy<A>(values: readonly A[], key: (value: A) => string): Map<string, readonly A[]> {
  const grouped = new Map<string, A[]>();
  for (const value of values) grouped.set(key(value), [...(grouped.get(key(value)) ?? []), value]);
  return grouped;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceObject(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactEvidenceKeys(source: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unsupported = EffectArray.filter(EffectRecord.keys(source), key => !expected.has(key));
  const missing = EffectArray.filter(keys, key => !(key in source));
  if (unsupported.length > 0 || missing.length > 0) throw new Error(`${label} has invalid fields`);
}

function boundedOpaqueText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    Effect.pipe(value, EffectString.trim) !== value ||
    EffectArray.some(Array.from(value), character => {
      const codePoint = Effect.pipe(
        character,
        EffectString.codePointAt(0),
        Effect.Option.getOrElse(() => undefined),
      );
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}
