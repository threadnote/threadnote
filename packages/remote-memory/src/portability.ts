import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {formatRemoteMemoryUri, parseRemoteShareAddress} from '@threadnote/memory/remote/address';
import {canonicalMemoryDocumentContent, formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {inspectRemoteMemoryContent, parseRemoteCanonicalMemoryDocument} from '@threadnote/memory/remote/content';
import {memoryCodeCitationSharingBlocker} from '@threadnote/memory/code/citation-policy';
import {parseResourceId, validatePortableSegment} from '@threadnote/store/resource-id';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const REMOTE_MEMORY_PORTABILITY_VERSION = 1 as const;

export interface GitBetaMemorySourceV1 {
  readonly content: string;
  readonly sourceUri: string;
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

export interface RemoteMemoryExistingRecordV1 {
  readonly aliases: readonly string[];
  readonly contentHash: string;
  readonly uri: string;
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

export type GitBetaImportClassification =
  'blocked' | 'conflict' | 'duplicate' | 'invalid' | 'unchanged' | 'would_import';

export interface GitBetaImportPlanEntryV1 {
  readonly aliasUri?: string;
  readonly classification: GitBetaImportClassification;
  readonly contentHash?: string;
  readonly reason?: string;
  readonly sourceUri: string;
  readonly targetUri?: string;
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

export interface GitBetaImportPolicyV1 {
  readonly projects: 'all' | readonly string[];
  readonly sourceTeams: 'all' | readonly string[];
  readonly sourceUsers: 'all' | readonly string[];
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

export interface GitBetaImportPlanV1 {
  readonly aliasCompatibilityEndsAt: string;
  readonly counts: Readonly<Record<GitBetaImportClassification, number>>;
  readonly dryRun: boolean;
  readonly entries: readonly GitBetaImportPlanEntryV1[];
  readonly planDigest: string;
  readonly planId: string;
  readonly policy: GitBetaImportPolicyV1;
  readonly shareId: string;
  readonly sourceMutation: 'none';
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

export interface RemoteMemoryPortableRecordV1 {
  readonly aliases: readonly string[];
  readonly canonicalContent: string;
  readonly contentHash: string;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly topic: string;
  readonly uri: string;
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

export interface GitBetaImportApplyOutcomeV1 {
  readonly sourceUri: string;
  readonly status: 'failed' | 'imported' | 'unchanged';
  readonly targetUri?: string;
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

export interface RemoteMemoryCutoverReceiptV1 {
  readonly aliasCompatibilityEndsAt: string;
  readonly dualWrite: 'disabled';
  readonly failed: number;
  readonly imported: number;
  readonly planDigest: string;
  readonly planId: string;
  readonly shareId: string;
  readonly sourceDeletion: 'not_performed';
  readonly status: 'blocked' | 'ready';
  readonly switch: 'explicit_required';
  readonly verification: 'failed' | 'matched';
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

export interface RemoteMemoryExportFileV1 {
  readonly aliases: readonly string[];
  readonly canonicalContent: string;
  readonly contentHash: string;
  readonly relativePath: string;
  readonly sourceUri: string;
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

export interface RemoteMemoryExportPlanV1 {
  readonly bundleDigest: string;
  readonly files: readonly RemoteMemoryExportFileV1[];
  readonly sourceMutation: 'none';
  readonly version: typeof REMOTE_MEMORY_PORTABILITY_VERSION;
}

interface ValidGitBetaSource {
  readonly aliasUri: string;
  readonly canonicalContent: string;
  readonly contentHash: string;
  readonly project: string;
  readonly sourceUri: string;
  readonly sourceTeam: string;
  readonly sourceUser: string;
  readonly targetUri: string;
  readonly topic: string;
}

export function planGitBetaImport(input: {
  readonly aliasCompatibilityEndsAt: string;
  readonly dryRun: boolean;
  readonly existing?: readonly RemoteMemoryExistingRecordV1[];
  readonly policy?: Partial<Omit<GitBetaImportPolicyV1, 'version'>>;
  readonly records: readonly GitBetaMemorySourceV1[];
  readonly shareId: string;
}): GitBetaImportPlanV1 {
  const shareId = validatePortableSegment(input.shareId);
  const aliasCompatibilityEndsAt = compatibilityEnd(input.aliasCompatibilityEndsAt);
  const policy = importPolicy(input.policy);
  const existing = existingHashes(input.existing ?? [], shareId);
  const candidates = EffectArray.map(
    EffectArray.map(input.records, source => classifyGitBetaSource(source, shareId)),
    candidate => applyImportPolicy(candidate, policy),
  ).sort(compareImportCandidates);
  const validByTarget = new Map<string, ValidGitBetaSource[]>();
  for (const candidate of candidates) {
    if ('candidate' in candidate) {
      const values = validByTarget.get(candidate.candidate.targetUri) ?? [];
      values.push(candidate.candidate);
      validByTarget.set(candidate.candidate.targetUri, values);
    }
  }

  const resolved = new Map<ValidGitBetaSource, GitBetaImportPlanEntryV1>();
  for (const [targetUri, values] of validByTarget) {
    const hashes = new Set(EffectArray.map(values, value => value.contentHash));
    if (hashes.size > 1) {
      for (const value of values) resolved.set(value, entry(value, 'conflict', 'source_content_conflict'));
      continue;
    }
    const current = existing.get(targetUri);
    if (current === 'conflict') {
      for (const value of values) resolved.set(value, entry(value, 'conflict', 'existing_state_conflict'));
      continue;
    }
    const [winner, ...duplicates] = values;
    if (!winner) continue;
    resolved.set(
      winner,
      current === undefined
        ? entry(winner, 'would_import')
        : current === winner.contentHash
          ? entry(winner, 'unchanged')
          : entry(winner, 'conflict', 'existing_content_conflict'),
    );
    for (const duplicate of duplicates) resolved.set(duplicate, entry(duplicate, 'duplicate'));
  }

  const entries = EffectArray.map(candidates, candidate =>
    'candidate' in candidate ? resolved.get(candidate.candidate)! : candidate.entry,
  );
  const counts = importCounts(entries);
  const digestInput = {
    aliasCompatibilityEndsAt,
    counts,
    dryRun: input.dryRun,
    entries,
    policy,
    shareId,
    sourceMutation: 'none',
    version: 1,
  };
  const planDigest = sha256HexSync(stableJson(digestInput));
  return {
    aliasCompatibilityEndsAt,
    counts,
    dryRun: input.dryRun,
    entries,
    planDigest,
    planId: `tnmi_${Effect.pipe(planDigest, EffectString.slice(0, 32))}`,
    policy,
    shareId,
    sourceMutation: 'none',
    version: REMOTE_MEMORY_PORTABILITY_VERSION,
  };
}

export function materializeGitBetaImport(
  plan: GitBetaImportPlanV1,
  sources: readonly GitBetaMemorySourceV1[],
): readonly RemoteMemoryPortableRecordV1[] {
  verifyGitBetaImportPlan(plan);
  if (plan.dryRun) throw new Error('A dry-run Git beta import plan cannot be materialized for apply.');
  if (plan.counts.blocked + plan.counts.conflict + plan.counts.invalid > 0) {
    throw new Error('A blocking Git beta import plan cannot be materialized for apply.');
  }
  const sourceByUri = uniqueSourcesByUri(sources);
  if (sourceByUri.size !== plan.entries.length) {
    throw new Error('Git beta import plan does not cover the exact source set.');
  }
  assertSourceClassificationSemantics(plan, sources);
  const records: RemoteMemoryPortableRecordV1[] = [];
  const classificationsByTarget = new Map<string, GitBetaImportClassification[]>();
  for (const item of plan.entries) {
    const source = sourceByUri.get(item.sourceUri);
    if (!source) throw new Error(`Git beta import source is missing: ${item.sourceUri}.`);
    const parsed = validatedGitBetaSource(source, plan.shareId);
    assertImportPolicyAllows(parsed, plan.policy);
    if (
      parsed.sourceUri !== item.sourceUri ||
      parsed.aliasUri !== item.aliasUri ||
      parsed.targetUri !== item.targetUri ||
      parsed.contentHash !== item.contentHash
    ) {
      throw new Error(`Git beta import source changed after planning: ${item.sourceUri}.`);
    }
    const targetClassifications = classificationsByTarget.get(parsed.targetUri) ?? [];
    targetClassifications.push(item.classification);
    classificationsByTarget.set(parsed.targetUri, targetClassifications);
    if (item.classification !== 'would_import' && item.classification !== 'unchanged') continue;
    const address = parseRemoteShareAddress(parsed.targetUri);
    records.push({
      aliases: [parsed.aliasUri],
      canonicalContent: parsed.canonicalContent,
      contentHash: parsed.contentHash,
      kind: 'durable',
      project: address.project,
      topic: address.topic,
      uri: parsed.targetUri,
      version: REMOTE_MEMORY_PORTABILITY_VERSION,
    });
  }
  for (const classifications of classificationsByTarget.values()) {
    if (EffectArray.every(classifications, classification => classification === 'duplicate')) {
      throw new Error('Git beta import plan marks every source for one target as a duplicate.');
    }
  }
  return records;
}

function assertSourceClassificationSemantics(
  plan: GitBetaImportPlanV1,
  sources: readonly GitBetaMemorySourceV1[],
): void {
  const sourcePlan = planGitBetaImport({
    aliasCompatibilityEndsAt: plan.aliasCompatibilityEndsAt,
    dryRun: false,
    policy: plan.policy,
    records: sources,
    shareId: plan.shareId,
  });
  if (sourcePlan.entries.length !== plan.entries.length) {
    throw new Error('Git beta import source changed after planning or no longer matches classification semantics.');
  }
  for (let index = 0; index < sourcePlan.entries.length; index += 1) {
    const expected = sourcePlan.entries[index];
    const actual = plan.entries[index];
    const classificationMatches =
      actual.classification === expected.classification ||
      (expected.classification === 'would_import' && actual.classification === 'unchanged');
    if (
      !classificationMatches ||
      actual.aliasUri !== expected.aliasUri ||
      actual.contentHash !== expected.contentHash ||
      actual.reason !== expected.reason ||
      actual.sourceUri !== expected.sourceUri ||
      actual.targetUri !== expected.targetUri
    ) {
      throw new Error('Git beta import source changed after planning or no longer matches classification semantics.');
    }
  }
}

export function finalizeGitBetaCutover(input: {
  readonly outcomes: readonly GitBetaImportApplyOutcomeV1[];
  readonly plan: GitBetaImportPlanV1;
  readonly verified: boolean;
}): RemoteMemoryCutoverReceiptV1 {
  verifyGitBetaImportPlan(input.plan);
  const expected = EffectArray.filter(
    input.plan.entries,
    entry => entry.classification === 'would_import' || entry.classification === 'unchanged',
  );
  const outcomeBySource = new Map<string, GitBetaImportApplyOutcomeV1>();
  let duplicateOutcome = false;
  for (const outcome of input.outcomes) {
    const canonical = canonicalSourceUri(outcome.sourceUri);
    if (outcomeBySource.has(canonical)) duplicateOutcome = true;
    outcomeBySource.set(canonical, {...outcome, sourceUri: canonical});
  }
  let imported = 0;
  let failed = duplicateOutcome ? 1 : 0;
  for (const entry of expected) {
    const outcome = outcomeBySource.get(entry.sourceUri);
    if ((outcome?.status === 'imported' || outcome?.status === 'unchanged') && outcome.targetUri === entry.targetUri)
      imported += 1;
    else failed += 1;
  }
  if (outcomeBySource.size !== expected.length) failed += Math.abs(outcomeBySource.size - expected.length);
  const planBlocked = input.plan.counts.blocked + input.plan.counts.conflict + input.plan.counts.invalid > 0;
  return {
    aliasCompatibilityEndsAt: input.plan.aliasCompatibilityEndsAt,
    dualWrite: 'disabled',
    failed,
    imported,
    planDigest: input.plan.planDigest,
    planId: input.plan.planId,
    shareId: input.plan.shareId,
    sourceDeletion: 'not_performed',
    status: !planBlocked && failed === 0 && input.verified ? 'ready' : 'blocked',
    switch: 'explicit_required',
    verification: input.verified ? 'matched' : 'failed',
    version: REMOTE_MEMORY_PORTABILITY_VERSION,
  };
}

export function planRemoteMemoryExport(records: readonly RemoteMemoryPortableRecordV1[]): RemoteMemoryExportPlanV1 {
  const files = EffectArray.map(records, exportFile).sort((left, right) =>
    compareCodeUnits(left.relativePath, right.relativePath),
  );
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1].relativePath === files[index].relativePath) {
      throw new Error(`Remote memory export path conflict: ${files[index].relativePath}.`);
    }
  }
  const bundleDigest = sha256HexSync(stableJson({files, sourceMutation: 'none', version: 1}));
  return {bundleDigest, files, sourceMutation: 'none', version: REMOTE_MEMORY_PORTABILITY_VERSION};
}

export function verifyRemoteMemoryExportPlan(plan: RemoteMemoryExportPlanV1): void {
  if (plan.version !== REMOTE_MEMORY_PORTABILITY_VERSION || plan.sourceMutation !== 'none') {
    throw new Error('Unsupported remote memory export plan contract.');
  }
  const expected = sha256HexSync(stableJson({files: plan.files, sourceMutation: 'none', version: 1}));
  if (expected !== plan.bundleDigest)
    throw new Error('Remote memory export bundle digest does not match its contents.');
  let previousPath: string | undefined;
  for (const file of plan.files) {
    if (file.version !== REMOTE_MEMORY_PORTABILITY_VERSION) {
      throw new Error('Unsupported remote memory export file contract.');
    }
    const address = parseRemoteShareAddress(file.sourceUri);
    if (file.sourceUri !== address.canonicalUri) throw new Error('Remote memory export source URI is not canonical.');
    const canonical = parseRemoteCanonicalMemoryDocument({
      content: file.canonicalContent,
      kind: address.kind,
      project: address.project,
      topic: address.topic,
      uri: address.canonicalUri,
    });
    if (canonical.content !== file.canonicalContent || sha256HexSync(canonical.content) !== file.contentHash) {
      throw new Error(`Remote memory export file hash mismatch: ${file.relativePath}.`);
    }
    const expectedPath = exportRelativePath(
      address.kind,
      canonical.record.metadata.status,
      address.project,
      address.topic,
    );
    if (file.relativePath !== expectedPath) throw new Error('Remote memory export path does not match its source URI.');
    const aliases = [...new Set(EffectArray.map(file.aliases, value => canonicalSourceUri(value)))].sort(
      compareCodeUnits,
    );
    if (stableJson(aliases) !== stableJson(file.aliases)) {
      throw new Error('Remote memory export aliases are not canonical and deterministic.');
    }
    if (previousPath !== undefined && compareCodeUnits(previousPath, file.relativePath) >= 0) {
      throw new Error('Remote memory export files are not uniquely sorted.');
    }
    previousPath = file.relativePath;
  }
}

function classifyGitBetaSource(
  source: GitBetaMemorySourceV1,
  shareId: string,
):
  | {readonly candidate: ValidGitBetaSource; readonly sourceUri: string}
  | {
      readonly entry: GitBetaImportPlanEntryV1;
      readonly sourceUri: string;
    } {
  let sourceUri: string;
  try {
    sourceUri = canonicalSourceUri(source.sourceUri);
  } catch {
    return {entry: invalidEntry(source.sourceUri, 'invalid_source_uri'), sourceUri: source.sourceUri};
  }
  try {
    return {candidate: validatedGitBetaSource({...source, sourceUri}, shareId), sourceUri};
  } catch (cause) {
    const reason = safeImportReason(cause instanceof Error ? cause.message : 'invalid_source');
    const classification = Effect.pipe(reason, EffectString.startsWith('blocked:')) ? 'blocked' : 'invalid';
    return {entry: invalidEntry(sourceUri, reason, classification), sourceUri};
  }
}

function validatedGitBetaSource(source: GitBetaMemorySourceV1, shareId: string): ValidGitBetaSource {
  if (source.version !== REMOTE_MEMORY_PORTABILITY_VERSION) throw new Error('unsupported_source_version');
  const aliasUri = canonicalSourceUri(source.sourceUri);
  const resource = parseResourceId(aliasUri);
  const [userId, memories, shared, team, kind, scope, project, file] = resource.segments;
  if (
    resource.namespace !== 'user' ||
    !userId ||
    memories !== 'memories' ||
    shared !== 'shared' ||
    !team ||
    kind !== 'durable' ||
    scope !== 'projects' ||
    !project ||
    !Effect.pipe(file, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.endsWith('.md')),
    ) ||
    file === '.md' ||
    resource.segments.length !== 8
  ) {
    throw new Error('unsupported_git_beta_layout');
  }
  const topic = Effect.pipe(file, EffectString.slice(0, -3));
  validatePortableSegment(project);
  validatePortableSegment(topic);
  const inspected = inspectRemoteMemoryContent(source.content);
  if (!inspected.allowed) throw new Error(`blocked:${inspected.category}`);
  const canonicalContent = canonicalMemoryDocumentContent(inspected.canonicalContent);
  const record = parseMemoryDocument(aliasUri, canonicalContent);
  if (!record || record.headerTitle !== 'MEMORY' || record.metadata.kind !== 'durable') {
    throw new Error('invalid_memory_document');
  }
  const citationBlocker = memoryCodeCitationSharingBlocker(record.metadata);
  if (citationBlocker) throw new Error(`blocked:${citationBlocker}`);
  if (record.metadata.project !== project || record.metadata.topic !== topic) throw new Error('metadata_uri_mismatch');
  if (formatMemoryDocument(record.headerTitle, record.metadata, record.body) !== canonicalContent) {
    throw new Error('noncanonical_memory_document');
  }
  return {
    aliasUri,
    canonicalContent,
    contentHash: sha256HexSync(canonicalContent),
    project,
    sourceUri: aliasUri,
    sourceTeam: team,
    sourceUser: userId,
    targetUri: formatRemoteMemoryUri({kind: 'durable', project, shareId, topic}),
    topic,
  };
}

function canonicalSourceUri(input: string): string {
  const parsed = parseResourceId(input);
  if (parsed.inputScheme !== 'threadnote' || parsed.anchor) throw new Error('source URI must be canonical Threadnote');
  return parsed.canonicalUri;
}

function existingHashes(
  records: readonly RemoteMemoryExistingRecordV1[],
  shareId: string,
): ReadonlyMap<string, string | 'conflict'> {
  const values = new Map<string, string | 'conflict'>();
  for (const record of [...records].sort((left, right) => compareCodeUnits(left.uri, right.uri))) {
    if (record.version !== REMOTE_MEMORY_PORTABILITY_VERSION) throw new Error('Unsupported existing-record version.');
    const address = parseRemoteShareAddress(record.uri);
    if (address.shareId !== shareId) throw new Error('Existing record belongs to another remote share.');
    if (!/^[0-9a-f]{64}$/u.test(record.contentHash)) throw new Error('Existing record hash is not SHA-256.');
    const current = values.get(address.canonicalUri);
    values.set(address.canonicalUri, current && current !== record.contentHash ? 'conflict' : record.contentHash);
  }
  return values;
}

function entry(
  value: ValidGitBetaSource,
  classification: GitBetaImportClassification,
  reason?: string,
): GitBetaImportPlanEntryV1 {
  return {
    aliasUri: value.aliasUri,
    classification,
    contentHash: value.contentHash,
    ...(reason ? {reason} : {}),
    sourceUri: value.sourceUri,
    targetUri: value.targetUri,
    version: REMOTE_MEMORY_PORTABILITY_VERSION,
  };
}

function invalidEntry(
  sourceUri: string,
  reason: string,
  classification: 'blocked' | 'invalid' = 'invalid',
): GitBetaImportPlanEntryV1 {
  return {classification, reason, sourceUri, version: REMOTE_MEMORY_PORTABILITY_VERSION};
}

function importCounts(
  entries: readonly GitBetaImportPlanEntryV1[],
): Readonly<Record<GitBetaImportClassification, number>> {
  const counts: Record<GitBetaImportClassification, number> = {
    blocked: 0,
    conflict: 0,
    duplicate: 0,
    invalid: 0,
    unchanged: 0,
    would_import: 0,
  };
  for (const entry of entries) counts[entry.classification] += 1;
  return counts;
}

function exportFile(record: RemoteMemoryPortableRecordV1): RemoteMemoryExportFileV1 {
  if (record.version !== REMOTE_MEMORY_PORTABILITY_VERSION) throw new Error('Unsupported portable-record version.');
  const address = parseRemoteShareAddress(record.uri);
  if (
    record.uri !== address.canonicalUri ||
    address.kind !== record.kind ||
    address.project !== record.project ||
    address.topic !== record.topic
  ) {
    throw new Error(`Remote memory export identity mismatch: ${record.uri}.`);
  }
  const document = parseRemoteCanonicalMemoryDocument({
    content: record.canonicalContent,
    kind: record.kind,
    project: record.project,
    topic: record.topic,
    uri: record.uri,
  });
  const canonicalContent = document.content;
  if (canonicalContent !== record.canonicalContent) {
    throw new Error(`Remote memory export content is not canonical: ${record.uri}.`);
  }
  const contentHash = sha256HexSync(canonicalContent);
  if (contentHash !== record.contentHash) throw new Error(`Remote memory export hash mismatch: ${record.uri}.`);
  return {
    aliases: [...new Set(EffectArray.map(record.aliases, value => canonicalSourceUri(value)))].sort(compareCodeUnits),
    canonicalContent,
    contentHash,
    relativePath: exportRelativePath(record.kind, document.record.metadata.status, address.project, address.topic),
    sourceUri: address.canonicalUri,
    version: REMOTE_MEMORY_PORTABILITY_VERSION,
  };
}

function exportRelativePath(
  kind: 'durable' | 'handoff',
  status: 'active' | 'archived' | 'expired' | 'superseded',
  project: string,
  topic: string,
): string {
  const prefix =
    kind === 'durable' ? (status === 'active' ? 'durable/projects' : `durable/${status}`) : `handoffs/${status}`;
  return `${prefix}/${project}/${topic}.md`;
}

const GIT_BETA_IMPORT_CLASSIFICATIONS = [
  'blocked',
  'conflict',
  'duplicate',
  'invalid',
  'unchanged',
  'would_import',
] as const;

export function parseGitBetaImportPlan(value: unknown): GitBetaImportPlanV1 {
  if (!isGitBetaImportPlanShape(value)) throw new Error('Git beta import plan has an invalid shape.');
  verifyGitBetaImportPlan(value);
  return value;
}

function isGitBetaImportPlanShape(value: unknown): value is GitBetaImportPlanV1 {
  if (!isObjectRecord(value)) return false;
  const counts = value.counts;
  const policy = value.policy;
  const entries = value.entries;
  if (!isObjectRecord(counts) || !isObjectRecord(policy) || !EffectArray.isArray(entries)) return false;
  if (
    value.version !== REMOTE_MEMORY_PORTABILITY_VERSION ||
    value.sourceMutation !== 'none' ||
    typeof value.aliasCompatibilityEndsAt !== 'string' ||
    typeof value.dryRun !== 'boolean' ||
    typeof value.planDigest !== 'string' ||
    typeof value.planId !== 'string' ||
    typeof value.shareId !== 'string' ||
    policy.version !== REMOTE_MEMORY_PORTABILITY_VERSION ||
    !(policy.projects === 'all' || isStringArray(policy.projects)) ||
    !(policy.sourceTeams === 'all' || isStringArray(policy.sourceTeams)) ||
    !(policy.sourceUsers === 'all' || isStringArray(policy.sourceUsers)) ||
    !EffectArray.every(GIT_BETA_IMPORT_CLASSIFICATIONS, classification => typeof counts[classification] === 'number') ||
    !EffectArray.isArray(entries)
  ) {
    return false;
  }
  return EffectArray.every(
    entries,
    entry =>
      isObjectRecord(entry) &&
      typeof entry.sourceUri === 'string' &&
      isGitBetaImportClassification(entry.classification) &&
      entry.version === REMOTE_MEMORY_PORTABILITY_VERSION &&
      (entry.aliasUri === undefined || typeof entry.aliasUri === 'string') &&
      (entry.contentHash === undefined || typeof entry.contentHash === 'string') &&
      (entry.reason === undefined || typeof entry.reason === 'string') &&
      (entry.targetUri === undefined || typeof entry.targetUri === 'string'),
  );
}

function isGitBetaImportClassification(value: unknown): value is GitBetaImportClassification {
  return (
    typeof value === 'string' &&
    EffectArray.some(GIT_BETA_IMPORT_CLASSIFICATIONS, classification => classification === value)
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return EffectArray.isArray(value) && EffectArray.every(value, item => typeof item === 'string');
}

export function verifyGitBetaImportPlan(plan: GitBetaImportPlanV1): void {
  if (plan.version !== REMOTE_MEMORY_PORTABILITY_VERSION || plan.sourceMutation !== 'none') {
    throw new Error('Unsupported Git beta import plan contract.');
  }
  compatibilityEnd(plan.aliasCompatibilityEndsAt);
  validatePortableSegment(plan.shareId);
  const normalizedPolicy = importPolicy(plan.policy);
  if (stableJson(normalizedPolicy) !== stableJson(plan.policy)) {
    throw new Error('Git beta import plan policy is not canonical.');
  }
  const counts = importCounts(plan.entries);
  if (stableJson(counts) !== stableJson(plan.counts))
    throw new Error('Git beta import plan counts do not match entries.');
  for (const item of plan.entries) {
    if (item.version !== REMOTE_MEMORY_PORTABILITY_VERSION) throw new Error('Unsupported import plan entry contract.');
    if (item.targetUri && parseRemoteShareAddress(item.targetUri).shareId !== plan.shareId) {
      throw new Error('Git beta import plan entry belongs to another share.');
    }
  }
  const digest = sha256HexSync(
    stableJson({
      aliasCompatibilityEndsAt: plan.aliasCompatibilityEndsAt,
      counts: plan.counts,
      dryRun: plan.dryRun,
      entries: plan.entries,
      policy: plan.policy,
      shareId: plan.shareId,
      sourceMutation: plan.sourceMutation,
      version: plan.version,
    }),
  );
  if (digest !== plan.planDigest || plan.planId !== `tnmi_${Effect.pipe(digest, EffectString.slice(0, 32))}`) {
    throw new Error('Git beta import plan digest does not match its contents.');
  }
}

function safeImportReason(reason: string): string {
  if (
    reason === 'blocked:credential' ||
    reason === 'blocked:dirty-source' ||
    reason === 'blocked:local-repository-identity' ||
    reason === 'blocked:machine_local_path' ||
    reason === 'blocked:malformed-citation'
  ) {
    return reason;
  }
  const allowed = new Set([
    'invalid_memory_document',
    'metadata_uri_mismatch',
    'noncanonical_memory_document',
    'unsupported_git_beta_layout',
    'unsupported_source_version',
  ]);
  return allowed.has(reason) ? reason : 'invalid_source';
}

function applyImportPolicy(
  candidate:
    | {readonly candidate: ValidGitBetaSource; readonly sourceUri: string}
    | {readonly entry: GitBetaImportPlanEntryV1; readonly sourceUri: string},
  policy: GitBetaImportPolicyV1,
):
  | {readonly candidate: ValidGitBetaSource; readonly sourceUri: string}
  | {readonly entry: GitBetaImportPlanEntryV1; readonly sourceUri: string} {
  if (!('candidate' in candidate)) return candidate;
  const value = candidate.candidate;
  const reason = importPolicyBlockReason(value, policy);
  if (reason) return {entry: entry(value, 'blocked', reason), sourceUri: value.sourceUri};
  return candidate;
}

function assertImportPolicyAllows(value: ValidGitBetaSource, policy: GitBetaImportPolicyV1): void {
  const reason = importPolicyBlockReason(value, policy);
  if (reason) throw new Error(`Git beta import source no longer satisfies plan policy: ${reason}.`);
}

function importPolicyBlockReason(
  value: ValidGitBetaSource,
  policy: GitBetaImportPolicyV1,
): 'unmapped_project_or_repository_binding' | 'unmapped_source_team' | 'unmapped_source_user' | undefined {
  if (policy.sourceUsers !== 'all' && !policy.sourceUsers.includes(value.sourceUser)) return 'unmapped_source_user';
  if (policy.sourceTeams !== 'all' && !policy.sourceTeams.includes(value.sourceTeam)) return 'unmapped_source_team';
  if (policy.projects !== 'all' && !policy.projects.includes(value.project)) {
    return 'unmapped_project_or_repository_binding';
  }
  return undefined;
}

function importPolicy(input: Partial<Omit<GitBetaImportPolicyV1, 'version'>> | undefined): GitBetaImportPolicyV1 {
  return {
    projects: policySegments(input?.projects),
    sourceTeams: policySegments(input?.sourceTeams),
    sourceUsers: policySegments(input?.sourceUsers),
    version: REMOTE_MEMORY_PORTABILITY_VERSION,
  };
}

function policySegments(values: 'all' | readonly string[] | undefined): 'all' | readonly string[] {
  if (values === undefined || values === 'all') return 'all';
  return [...new Set(EffectArray.map(values, value => validatePortableSegment(value)))].sort(compareCodeUnits);
}

function compatibilityEnd(input: string): string {
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || input !== parsed.toISOString()) {
    throw new Error('Alias compatibility end must be a canonical ISO-8601 timestamp.');
  }
  return input;
}

function compareImportCandidates(
  left:
    | {readonly candidate: ValidGitBetaSource; readonly sourceUri: string}
    | {readonly entry: GitBetaImportPlanEntryV1; readonly sourceUri: string},
  right:
    | {readonly candidate: ValidGitBetaSource; readonly sourceUri: string}
    | {readonly entry: GitBetaImportPlanEntryV1; readonly sourceUri: string},
): number {
  const source = compareCodeUnits(left.sourceUri, right.sourceUri);
  if (source !== 0) return source;
  const leftKey =
    'candidate' in left
      ? `${left.candidate.targetUri}\u0000${left.candidate.contentHash}`
      : `${left.entry.classification}\u0000${left.entry.reason ?? ''}`;
  const rightKey =
    'candidate' in right
      ? `${right.candidate.targetUri}\u0000${right.candidate.contentHash}`
      : `${right.entry.classification}\u0000${right.entry.reason ?? ''}`;
  return compareCodeUnits(leftKey, rightKey);
}

function uniqueSourcesByUri(sources: readonly GitBetaMemorySourceV1[]): ReadonlyMap<string, GitBetaMemorySourceV1> {
  const values = new Map<string, GitBetaMemorySourceV1>();
  for (const source of sources) {
    const uri = canonicalSourceUri(source.sourceUri);
    if (values.has(uri)) throw new Error(`Git beta import contains a duplicate source URI: ${uri}.`);
    values.set(uri, source);
  }
  return values;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object' || EffectArray.isArray(current)) return current;
    return EffectRecord.fromEntries(
      EffectRecord.toEntries(current).sort(([left], [right]) => compareCodeUnits(left, right)),
    );
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
