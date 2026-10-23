import {DateTime, Effect, FileSystem, Path, Schema} from 'effect';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {readBoundedContainedStableRegularFile} from '@threadnote/graph/inventory/contained_file';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  atomicAgentWrite,
  assertAgentTargetNotSymlink,
  removeAgentTargetIfUnchanged,
} from '../agent_integration/index.js';
import {withAgentIntegrationLock} from '../agent_integration/registry.js';
import type {AgentAdapter, AgentGuidanceContract} from '../agent_integration/adapters/contract.js';
import {AGENT_ADAPTERS} from '../agent_integration/adapters.js';
import {credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import {
  buildExactDurableCandidateReview,
  listCandidateReviews,
  saveCandidateReview,
} from '@threadnote/memory/candidate';
import {readActiveProjectMemoryRecords} from '../memory/maintenance/records.js';
import {parseResourceId} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readFileIfExists} from '../utils.js';
import {SystemInfo} from '@threadnote/platform/system';
import {USER_INSTRUCTIONS_END_MARKER, USER_INSTRUCTIONS_START_MARKER} from '../constants.js';

const LEGACY_GUIDANCE_SCHEMA_VERSION = 1 as const;
export const GUIDANCE_SCHEMA_VERSION = 2 as const;
const GUIDANCE_BLOCK_SCHEMA_VERSION = 1 as const;
export const GUIDANCE_BLOCK_START = '<!-- threadnote:project-guidance:start v1 -->';
export const GUIDANCE_BLOCK_END = '<!-- threadnote:project-guidance:end -->';
const MAX_IMPORT_BYTES = 60 * 1024;
const MAX_GUIDANCE_BLOCK_BYTES = 256 * 1024;
const MAX_GUIDANCE_RECEIPT_BYTES = 256 * 1024;
const MAX_GUIDANCE_SOURCES = 64;
const MAX_GUIDANCE_URI_BYTES = 4 * 1024;
const MAX_GUIDANCE_IDENTITY_BYTES = 4 * 1024;
const MAX_GUIDANCE_TARGET_BYTES = 1_024;
const MAX_IMPORT_DIRECTORY_DEPTH = 8;
const MAX_IMPORT_DIRECTORY_ENTRIES = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const IGNORED_RULE_FILE_SUFFIXES = [
  '.DS_Store',
  '.bak',
  '.cache',
  '.crdownload',
  '.db',
  '.dmp',
  '.dump',
  '.eslintcache',
  '.lock',
  '.log',
  '.old',
  '.part',
  '.partial',
  '.pyc',
  '.pyo',
  '.stackdump',
  '.swo',
  '.swp',
  '.temp',
  '.tmp',
] as const;

export class GuidanceError extends Schema.TaggedError<GuidanceError>()('GuidanceError', {message: Schema.String}) {}

export interface GuidanceSourceV1 {
  readonly contentHash: string;
  readonly text: string;
  readonly uri: string;
}

export interface CollectedGuidanceImportSourceV1 {
  readonly contentHash: string;
  readonly relativePath: string;
  readonly text: string;
}

export interface GuidanceReceiptV2 {
  readonly expectedManagedBlockHash: string;
  readonly previousManagedBlockHash: string | null;
  readonly project: string;
  readonly removeTargetWhenEmpty: boolean;
  readonly repositoryId: string;
  readonly sources: readonly {readonly contentHash: string; readonly uri: string}[];
  readonly state: 'current' | 'pending';
  readonly targetIdentity: string;
  readonly targetPath: string;
  readonly version: typeof GUIDANCE_SCHEMA_VERSION;
  readonly wrapperOwned: boolean;
}

/** Receipt written by the first local 5.0.0 guidance build. Read-only migration input. */
export interface GuidanceReceiptV1 extends Omit<GuidanceReceiptV2, 'targetIdentity' | 'version'> {
  readonly surface: string;
  readonly version: typeof LEGACY_GUIDANCE_SCHEMA_VERSION;
}

export type GuidanceDriftState = 'current' | 'locally-modified' | 'missing-block' | 'stale-sources' | 'unavailable';

export interface GuidanceStatusV1 {
  readonly state: GuidanceDriftState;
  readonly surface: string;
}

export interface GuidanceHealthEvidenceV1 {
  readonly sourceUris: readonly string[];
  readonly state: Exclude<GuidanceDriftState, 'current'>;
}

export interface GuidanceProjectOptions {
  readonly apply: boolean;
  readonly cwd?: string;
  readonly force: boolean;
  readonly memory: readonly string[];
  readonly project: string;
}

export interface GuidanceImportOptions {
  readonly apply: boolean;
  readonly cwd?: string;
  readonly project: string;
}

export interface GuidanceRemoveOptions {
  readonly apply: boolean;
  readonly cwd?: string;
  readonly force: boolean;
  readonly project: string;
}

export function renderManagedGuidanceBlock(sources: readonly GuidanceSourceV1[]): string {
  const canonical = canonicalSources(sources);
  if (canonical.length === 0 || canonical.length > MAX_GUIDANCE_SOURCES)
    throw new Error(`Project guidance requires between 1 and ${MAX_GUIDANCE_SOURCES} unique sources.`);
  for (const source of canonical) {
    if (
      source.uri.includes(GUIDANCE_BLOCK_START) ||
      source.uri.includes(GUIDANCE_BLOCK_END) ||
      source.text.includes(GUIDANCE_BLOCK_START) ||
      source.text.includes(GUIDANCE_BLOCK_END)
    )
      throw new Error('Project guidance source contains a reserved managed-block marker.');
    if (!SHA256_PATTERN.test(source.contentHash)) throw new Error('Project guidance source hash is invalid.');
  }
  const sourceMetadata = canonical.map(({contentHash, uri}) => ({contentHash, uri}));
  const contentHash = sha256HexSync(canonical.map(source => `${source.uri}\n${source.text}`).join('\n\n'));
  const block = [
    GUIDANCE_BLOCK_START,
    `<!-- threadnote:project-guidance:metadata ${JSON.stringify({contentHash, schemaVersion: GUIDANCE_BLOCK_SCHEMA_VERSION, sources: sourceMetadata})} -->`,
    ...canonical.map(source => `## Source ${source.uri}\n\n${source.text.trimEnd()}`),
    GUIDANCE_BLOCK_END,
  ].join('\n\n');
  if (new TextEncoder().encode(block).byteLength > MAX_GUIDANCE_BLOCK_BYTES)
    throw new Error(`Managed project guidance exceeds ${MAX_GUIDANCE_BLOCK_BYTES} UTF-8 bytes.`);
  if (hasMalformedGuidanceBlock(block) || guidanceBlock(block) !== block)
    throw new Error('Managed project guidance could not be rendered as one complete block.');
  return block;
}

export function guidanceImportReviewId(surface: string, project: string, imported: string): string {
  return `review-guidance-${sha256HexSync(`${surface}\n${project}\n${imported}`).slice(0, 16)}`;
}

export function guidanceBlock(content: string): string | undefined {
  const start = content.indexOf(GUIDANCE_BLOCK_START);
  const end = content.indexOf(GUIDANCE_BLOCK_END);
  if (start < 0 || end < start || content.indexOf(GUIDANCE_BLOCK_START, start + 1) >= 0) return undefined;
  return content.slice(start, end + GUIDANCE_BLOCK_END.length);
}

export function hasMalformedGuidanceBlock(content: string): boolean {
  const starts = content.split(GUIDANCE_BLOCK_START).length - 1;
  const ends = content.split(GUIDANCE_BLOCK_END).length - 1;
  return (
    starts !== ends ||
    starts > 1 ||
    (starts === 1 && content.indexOf(GUIDANCE_BLOCK_END) < content.indexOf(GUIDANCE_BLOCK_START))
  );
}

export function upsertGuidanceBlock(
  content: string | undefined,
  block: string,
  wrapper?: {readonly prefix: string; readonly suffix: string},
): string {
  const current = content ?? '';
  if (hasMalformedGuidanceBlock(current)) throw new Error('Project guidance markers are incomplete or duplicated.');
  const existing = guidanceBlock(current);
  if (existing !== undefined) return current.replace(existing, block);
  const prefix = current.length === 0 ? (wrapper?.prefix ?? '') : '';
  const suffix = current.length === 0 ? (wrapper?.suffix ?? '') : '';
  return `${current}${prefix}${block}${suffix}`;
}

export function removeGuidanceBlock(content: string): string | undefined {
  if (hasMalformedGuidanceBlock(content)) return undefined;
  const block = guidanceBlock(content);
  if (block === undefined) return undefined;
  const index = content.indexOf(block);
  const next = `${content.slice(0, index)}${content.slice(index + block.length)}`;
  return next.length === 0 ? '' : next;
}

function removeProjectedGuidance(
  content: string,
  wrapper: {readonly prefix: string; readonly suffix: string} | undefined,
  wrapperOwned: boolean,
): string | undefined {
  const block = guidanceBlock(content);
  if (block === undefined) return undefined;
  if (wrapperOwned && wrapper) {
    const envelope = `${wrapper.prefix}${block}${wrapper.suffix}`;
    const envelopeIndex = content.indexOf(envelope);
    if (envelopeIndex >= 0)
      return `${content.slice(0, envelopeIndex)}${content.slice(envelopeIndex + envelope.length)}`;
  }
  return removeGuidanceBlock(content);
}

function hasMalformedBootstrapBlock(content: string): boolean {
  const starts = content.split(USER_INSTRUCTIONS_START_MARKER).length - 1;
  const ends = content.split(USER_INSTRUCTIONS_END_MARKER).length - 1;
  return (
    starts !== ends ||
    starts > 1 ||
    (starts === 1 && content.indexOf(USER_INSTRUCTIONS_END_MARKER) < content.indexOf(USER_INSTRUCTIONS_START_MARKER))
  );
}

export function stripThreadnoteManagedGuidance(content: string): string {
  if (hasMalformedGuidanceBlock(content) || hasMalformedBootstrapBlock(content))
    throw new Error('Threadnote-managed guidance markers are incomplete, reversed, or duplicated.');
  const withoutProject = removeGuidanceBlock(content) ?? content;
  const start = withoutProject.indexOf(USER_INSTRUCTIONS_START_MARKER);
  const end = withoutProject.indexOf(USER_INSTRUCTIONS_END_MARKER);
  if (start < 0 || end < start) return withoutProject;
  const before = withoutProject.slice(0, start);
  const after = withoutProject.slice(end + USER_INSTRUCTIONS_END_MARKER.length);
  return before.endsWith('\n') && after.startsWith('\n') ? `${before}${after.slice(1)}` : `${before}${after}`;
}

export const collectGuidanceImportSourcesAtRoot = Effect.fn('guidance.collectImportSourcesAtRoot')(function* (
  adapter: AgentAdapter,
  selectedRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(selectedRoot);
  const contract = guidanceContract(adapter);
  const selectedDeclared: {readonly content: string | undefined; readonly relative: string}[] = [];
  for (const relative of contract.importPaths) {
    const content = yield* readGuidanceTarget(root, relative);
    selectedDeclared.push({content, relative});
    if (contract.importMode === 'first-existing' && content !== undefined) break;
  }
  const discovered =
    contract.importMode === 'first-existing'
      ? []
      : yield* readGuidanceDirectories(root, contract.importDirectories ?? []);
  const fallback =
    contract.importMode === 'first-existing' || discovered.length > 0
      ? []
      : yield* Effect.forEach(contract.directoryFallbackPaths ?? [], relative =>
          readGuidanceTarget(root, relative).pipe(Effect.map(content => ({content, relative}))),
        );
  const byPath = new Map<string, string>();
  for (const entry of [...selectedDeclared, ...discovered, ...fallback]) {
    const normalized = normalizeGuidanceImportPath(entry.relative);
    if (entry.content !== undefined && !byPath.has(normalized)) byPath.set(normalized, entry.content);
  }
  const selectedContents = [...byPath.entries()].sort(([left], [right]) => compareText(left, right));
  if (selectedContents.some(([, content]) => hasMalformedGuidanceBlock(content) || hasMalformedBootstrapBlock(content)))
    return yield* GuidanceError.make({
      message: 'Threadnote-managed guidance markers are incomplete, reversed, or duplicated; import refused.',
    });
  const sources = selectedContents.flatMap(([relativePath, content]) => {
    const text = stripImportedGuidance(content, contract).trim();
    return text.length === 0
      ? []
      : [{contentHash: sha256HexSync(content), relativePath, text} satisfies CollectedGuidanceImportSourceV1];
  });
  const imported = sources.map(source => source.text).join('\n\n');
  if (new TextEncoder().encode(imported).byteLength > MAX_IMPORT_BYTES)
    return yield* GuidanceError.make({message: `Imported guidance exceeds ${MAX_IMPORT_BYTES} bytes.`});
  return sources;
});

export const collectGuidanceImportSources = Effect.fn('guidance.collectImportSources')(function* (
  adapter: AgentAdapter,
  cwd?: string,
) {
  return yield* collectGuidanceImportSourcesAtRoot(adapter, yield* projectRoot(cwd));
});

function stripImportedGuidance(content: string, contract: AgentGuidanceContract): string {
  const containedManagedContent =
    content.includes(GUIDANCE_BLOCK_START) || content.includes(USER_INSTRUCTIONS_START_MARKER);
  const stripped = stripThreadnoteManagedGuidance(content);
  if (!containedManagedContent) return stripped;
  const wrappers = [
    ...(contract.importWrappers ?? []),
    ...(contract.projection.wrapper === undefined ? [] : [contract.projection.wrapper]),
  ];
  return wrappers.some(wrapper => stripped.trim() === `${wrapper.prefix}${wrapper.suffix}`.trim()) ? '' : stripped;
}

export const runGuidanceImport = Effect.fn('guidance.import')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: GuidanceImportOptions,
) {
  const imported = (yield* collectGuidanceImportSources(adapter, options.cwd)).map(source => source.text).join('\n\n');
  const blocker = credentialScrubberBlocker(imported);
  if (blocker)
    return yield* GuidanceError.make({message: `Imported guidance contains ${blocker}; it was not persisted.`});
  if (!imported) return {mode: 'empty' as const};
  const fingerprint = sha256HexSync(`${adapter.catalog.id}\n${options.project}\n${imported}`);
  const reviewId = guidanceImportReviewId(adapter.catalog.id, options.project, imported);
  if (!options.apply) return {mode: 'preview' as const, revision: 1, reviewId};
  return yield* withAgentIntegrationLock(
    config,
    Effect.gen(function* () {
      const existing = yield* listCandidateReviews(config.agentContextHome);
      const task = `guidance-import:${fingerprint}`;
      const previous = existing.find(review => review.project === options.project && review.task === task);
      if (previous) return {mode: 'reused' as const, revision: previous.revision, reviewId: previous.reviewId};
      const records = yield* readActiveProjectMemoryRecords(config, options.project);
      const built = yield* buildExactDurableCandidateReview(
        {
          evidence: [`guidance-import:${adapter.catalog.id}:${fingerprint}`],
          outcome: 'Imported project guidance requires explicit candidate review before it becomes memory.',
          project: options.project,
          sourceAgentClient: 'threadnote-guidance',
          task,
          topic: `guidance-import-${adapter.catalog.id}`,
        },
        imported,
        records,
        yield* DateTime.nowAsDate,
      );
      const review = {
        ...built,
        auditEvents: built.auditEvents.map(event => ({...event, reviewId})),
        candidates: built.candidates.map((candidate, index) => ({
          ...candidate,
          candidateId: `${reviewId}-${index + 1}`,
        })),
        reviewId,
      };
      yield* saveCandidateReview(config.agentContextHome, review);
      return {mode: 'created' as const, revision: review.revision, reviewId: review.reviewId};
    }),
  );
});

export const runGuidanceProject = Effect.fn('guidance.project')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: GuidanceProjectOptions,
) {
  const contract = guidanceContract(adapter);
  const root = yield* projectRoot(options.cwd);
  yield* assertProjectionFallbackInactive(root, contract);
  const repository = yield* resolveRepositoryIdentity(root);
  const target = yield* safeTarget(root, contract.projection.relativePath);
  const targetIdentity = guidanceTargetIdentity(repository.worktreeId, root, contract.projection.relativePath);
  const plan = () =>
    guidanceProjectionPlan(config, adapter, options, root, repository.repositoryId, targetIdentity, target).pipe(
      Effect.map(value => ({...value, receipt: {...value.receipt, state: 'pending' as const}})),
    );
  if (!options.apply) {
    const preview = yield* plan();
    return {
      mode: 'preview' as const,
      receipt: {...preview.receipt, previousManagedBlockHash: null, state: 'current' as const},
      state: preview.state,
    };
  }
  return yield* withAgentIntegrationLock(
    config,
    Effect.gen(function* () {
      const mutation = yield* plan();
      const currentReceipt = {
        ...mutation.receipt,
        previousManagedBlockHash: null,
        state: 'current' as const,
      };
      if (mutation.resumePending) {
        yield* writeReceipt(config, currentReceipt);
        return {mode: 'resumed' as const, receipt: currentReceipt, state: mutation.state};
      }
      yield* writeReceipt(config, mutation.receipt);
      yield* assertProjectionFallbackInactive(root, contract);
      yield* assertGuidanceTarget(root, target);
      yield* atomicAgentWrite(target, mutation.next, 0o644, {content: mutation.current});
      yield* writeReceipt(config, currentReceipt);
      return {mode: 'applied' as const, receipt: currentReceipt, state: mutation.state};
    }),
  );
});

export const runGuidanceStatus = Effect.fn('guidance.status')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  project: string,
  cwd?: string,
) {
  const root = yield* projectRoot(cwd);
  const repository = yield* resolveRepositoryIdentity(root);
  return yield* projectStatus(config, adapter, project, root, repository.repositoryId, repository.worktreeId).pipe(
    Effect.orElseSucceed(() => ({state: 'unavailable' as const, surface: adapter.catalog.id})),
  );
});

export const guidanceHealthEvidence = Effect.fn('guidance.healthEvidence')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
) {
  const root = yield* projectRoot(cwd);
  const repository = yield* resolveRepositoryIdentity(root).pipe(
    Effect.catchTag('CodeGraphRepositoryError', error =>
      error.message.startsWith('Not a Git repository') ? Effect.void : Effect.fail(error),
    ),
  );
  if (repository === undefined) return [];
  const evidence: readonly (GuidanceHealthEvidenceV1 | undefined)[] = yield* Effect.forEach(
    guidanceProjectionAdapters(),
    adapter =>
      Effect.gen(function* () {
        const contract = guidanceContract(adapter);
        const targetIdentity = guidanceTargetIdentity(repository.worktreeId, root, contract.projection.relativePath);
        const receipt = yield* readReceipt(
          config,
          repository.repositoryId,
          project,
          targetIdentity,
          contract.projection.relativePath,
        );
        if (!receipt) return undefined;
        const status = yield* projectStatus(
          config,
          adapter,
          project,
          root,
          repository.repositoryId,
          repository.worktreeId,
        ).pipe(Effect.orElseSucceed(() => ({state: 'unavailable' as const, surface: adapter.catalog.id})));
        if (!isGuidanceDriftState(status.state)) return undefined;
        return {sourceUris: receipt.sources.map(source => source.uri), state: status.state};
      }),
    {concurrency: 4},
  );
  return evidence.filter((value): value is GuidanceHealthEvidenceV1 => value !== undefined);
});

/** Finite exact files read by guidanceHealthEvidence for this registered root. */
export const guidanceHealthObservationPaths = Effect.fn('guidance.healthObservationPaths')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
) {
  const root = yield* projectRoot(cwd);
  const repository = yield* resolveRepositoryIdentity(root).pipe(
    Effect.catchTag('CodeGraphRepositoryError', error =>
      error.message.startsWith('Not a Git repository') ? Effect.void : Effect.fail(error),
    ),
  );
  if (repository === undefined)
    return [] as readonly {readonly receiptPaths: readonly string[]; readonly targetPath: string}[];
  const path = yield* Path.Path;
  return yield* Effect.forEach(guidanceProjectionAdapters(), adapter =>
    Effect.gen(function* () {
      const relative = guidanceContract(adapter).projection.relativePath;
      const identity = guidanceTargetIdentity(repository.worktreeId, root, relative);
      return {
        receiptPaths: [
          receiptPath(path, config.agentContextHome, repository.repositoryId, identity),
          legacyConsumptionPath(path, config.agentContextHome, repository.repositoryId, identity),
          ...(LEGACY_GUIDANCE_SURFACES_BY_TARGET[relative] ?? []).map(surface =>
            legacyReceiptPath(path, config.agentContextHome, repository.repositoryId, project, surface),
          ),
        ],
        targetPath: yield* safeTarget(root, relative),
      };
    }),
  );
});

export const guidanceSourceUrisForChangedPaths = Effect.fn('guidance.changedPathSources')(function* (
  config: RuntimeConfig,
  project: string,
  cwd: string,
  changedPaths: readonly string[],
) {
  const root = yield* projectRoot(cwd);
  const repository = yield* resolveRepositoryIdentity(root);
  const changed = new Set(changedPaths);
  const receipts = yield* Effect.forEach(
    guidanceProjectionAdapters(),
    adapter => {
      const targetPath = guidanceContract(adapter).projection.relativePath;
      return readReceipt(
        config,
        repository.repositoryId,
        project,
        guidanceTargetIdentity(repository.worktreeId, root, targetPath),
        targetPath,
      );
    },
    {concurrency: 4},
  );
  return [
    ...new Set(
      receipts.flatMap(receipt =>
        receipt && changed.has(receipt.targetPath) ? receipt.sources.map(source => source.uri) : [],
      ),
    ),
  ].sort(compareText);
});

function isGuidanceDriftState(value: string): value is GuidanceHealthEvidenceV1['state'] {
  return (
    value === 'locally-modified' || value === 'missing-block' || value === 'stale-sources' || value === 'unavailable'
  );
}

export const runGuidanceRemove = Effect.fn('guidance.remove')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: GuidanceRemoveOptions,
) {
  const contract = guidanceContract(adapter);
  const root = yield* projectRoot(options.cwd);
  const repository = yield* resolveRepositoryIdentity(root);
  const targetIdentity = guidanceTargetIdentity(repository.worktreeId, root, contract.projection.relativePath);
  const plan = Effect.fn('guidance.remove.plan')(function* () {
    const receipt = yield* readReceipt(
      config,
      repository.repositoryId,
      options.project,
      targetIdentity,
      contract.projection.relativePath,
    );
    if (!receipt) return {kind: 'absent' as const};
    const target = yield* safeTarget(root, contract.projection.relativePath);
    const current = yield* readGuidanceTargetByPath(root, target);
    if (current === undefined) {
      if (!options.force) return {kind: 'missing' as const};
      return {kind: 'receipt-only' as const};
    }
    if (hasMalformedGuidanceBlock(current))
      return yield* GuidanceError.make({message: 'Project guidance markers are malformed; removal refused.'});
    const block = guidanceBlock(current);
    if ((!block || sha256HexSync(block) !== receipt.expectedManagedBlockHash) && !options.force)
      return yield* GuidanceError.make({message: 'Guidance block changed or is missing; rerun with --force.'});
    if (!block) return {kind: 'receipt-only' as const};
    const next = removeProjectedGuidance(current, contract.projection.wrapper, receipt.wrapperOwned)!;
    return {current, kind: 'target' as const, next, receipt, target};
  });
  if (!options.apply) {
    const preview = yield* plan();
    if (preview.kind === 'absent') return {mode: 'absent' as const};
    if (preview.kind === 'missing') return {mode: 'missing' as const};
    return {
      mode: 'preview' as const,
      resolution: preview.kind,
      targetPath: contract.projection.relativePath,
    };
  }
  return yield* withAgentIntegrationLock(
    config,
    Effect.gen(function* () {
      const mutation = yield* plan();
      if (mutation.kind === 'absent') return {mode: 'absent' as const};
      if (mutation.kind === 'missing') return {mode: 'missing' as const};
      if (mutation.kind === 'target') {
        yield* assertGuidanceTarget(root, mutation.target);
        if (mutation.receipt.removeTargetWhenEmpty && isRemovableGuidanceRemainder(mutation.next, contract))
          yield* removeAgentTargetIfUnchanged(mutation.target, mutation.current);
        else yield* atomicAgentWrite(mutation.target, mutation.next, 0o644, {content: mutation.current});
      }
      yield* removeReceipt(config, repository.repositoryId, targetIdentity);
      return {
        mode: 'removed' as const,
        resolution: mutation.kind,
        targetPath: contract.projection.relativePath,
      };
    }),
  );
});

function guidanceContract(adapter: AgentAdapter) {
  if (!adapter.guidance) throw new Error(`${adapter.catalog.id} does not declare project guidance support.`);
  return adapter.guidance;
}

function canonicalSources(sources: readonly GuidanceSourceV1[]): readonly GuidanceSourceV1[] {
  const byUri = new Map<string, GuidanceSourceV1>();
  for (const source of sources) byUri.set(source.uri, source);
  return [...byUri.values()].sort((left, right) => compareText(left.uri, right.uri));
}

const guidanceSources = Effect.fn('guidance.sources')(function* (
  config: RuntimeConfig,
  project: string,
  uris: readonly string[],
) {
  if (uris.length === 0) return yield* GuidanceError.make({message: 'Provide at least one --memory URI.'});
  if (uris.length > MAX_GUIDANCE_SOURCES)
    return yield* GuidanceError.make({message: `Provide at most ${MAX_GUIDANCE_SOURCES} --memory URIs.`});
  if (new Set(uris).size !== uris.length)
    return yield* GuidanceError.make({message: 'Provide each --memory URI only once.'});
  const records = yield* readActiveProjectMemoryRecords(config, project);
  const recordsByUri = new Map(records.map(record => [record.uri, record]));
  return yield* Effect.try({
    try: () =>
      uris.map(uri => {
        const record = recordsByUri.get(uri);
        if (!record || record.metadata.kind !== 'durable')
          throw new Error(`Memory ${uri} is not an active durable project memory.`);
        return {contentHash: sha256HexSync(record.body), text: record.body, uri};
      }),
    catch: cause => GuidanceError.make({message: cause instanceof Error ? cause.message : String(cause)}),
  });
});

const guidanceProjectionPlan = Effect.fn('guidance.project.plan')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: GuidanceProjectOptions,
  root: string,
  repositoryId: string,
  targetIdentity: string,
  target: string,
) {
  const contract = guidanceContract(adapter);
  const sources = yield* guidanceSources(config, options.project, options.memory);
  const block = yield* Effect.try({
    try: () => renderManagedGuidanceBlock(sources),
    catch: cause => GuidanceError.make({message: cause instanceof Error ? cause.message : String(cause)}),
  });
  const current = yield* readGuidanceTargetByPath(root, target);
  if (hasMalformedGuidanceBlock(current ?? ''))
    return yield* GuidanceError.make({
      message: 'Project guidance markers are incomplete, reversed, or duplicated; projection refused.',
    });
  const previous = yield* readReceipt(
    config,
    repositoryId,
    options.project,
    targetIdentity,
    contract.projection.relativePath,
  );
  const state = yield* projectStatusFromEvidence(config, adapter, options.project, previous, current);
  const existingBlock = guidanceBlock(current ?? '');
  const wrapper = contract.projection.wrapper;
  const previousEnvelopeIndex =
    previous?.wrapperOwned === true ? ownedWrapperEnvelopeIndex(current, existingBlock, wrapper) : -1;
  const previousWrapperReusable = previous?.wrapperOwned === true && previousEnvelopeIndex >= 0;
  const requiredWrapperUpgrade =
    wrapper?.required === true &&
    previous !== undefined &&
    existingBlock !== undefined &&
    sha256HexSync(existingBlock) === previous.expectedManagedBlockHash &&
    isThreadnoteOnlyContent(current ?? '', contract) &&
    !requiredContractWrapperActive(current, contract);
  if (
    wrapper?.required === true &&
    (current ?? '').length > 0 &&
    !requiredContractWrapperActive(current, contract) &&
    !previousWrapperReusable &&
    !requiredWrapperUpgrade
  )
    return yield* GuidanceError.make({
      message: `${adapter.catalog.displayName} requires its project-guidance wrapper at the start of the target; projection refused.`,
    });
  const wrapperOwned =
    previousWrapperReusable ||
    requiredWrapperUpgrade ||
    (existingBlock === undefined && (current ?? '').length === 0 && wrapper !== undefined);
  const draftReceipt: GuidanceReceiptV2 = {
    expectedManagedBlockHash: sha256HexSync(block),
    previousManagedBlockHash: null,
    project: options.project,
    removeTargetWhenEmpty:
      previous?.removeTargetWhenEmpty ?? (current === undefined || isThreadnoteOnlyContent(current, contract)),
    repositoryId,
    sources: canonicalSources(sources).map(({contentHash, uri}) => ({contentHash, uri})),
    state: 'pending',
    targetIdentity,
    targetPath: contract.projection.relativePath,
    version: GUIDANCE_SCHEMA_VERSION,
    wrapperOwned,
  };
  const continuingPending = previous?.state === 'pending' && receiptsDescribeSameProjection(previous, draftReceipt);
  const receipt: GuidanceReceiptV2 = {
    ...draftReceipt,
    previousManagedBlockHash: continuingPending
      ? previous.previousManagedBlockHash
      : existingBlock === undefined
        ? null
        : sha256HexSync(existingBlock),
  };
  yield* Effect.try({
    try: () =>
      parseGuidanceReceiptV2(receipt, {
        project: options.project,
        repositoryId,
        targetIdentity,
        targetPath: contract.projection.relativePath,
      }),
    catch: () => GuidanceError.make({message: 'Generated guidance receipt exceeds its strict bounds.'}),
  });
  const next =
    requiredWrapperUpgrade && wrapper !== undefined
      ? `${wrapper.prefix}${block}${wrapper.suffix}`
      : previousWrapperReusable && existingBlock !== undefined && wrapper !== undefined
        ? `${wrapper.prefix}${block}${wrapper.suffix}${current!.slice(0, previousEnvelopeIndex)}${current!.slice(
            previousEnvelopeIndex + `${wrapper.prefix}${existingBlock}${wrapper.suffix}`.length,
          )}`
        : wrapperOwned && existingBlock === undefined && current === `${wrapper?.prefix ?? ''}${wrapper?.suffix ?? ''}`
          ? `${wrapper?.prefix ?? ''}${block}${wrapper?.suffix ?? ''}`
          : upsertGuidanceBlock(current, block, wrapperOwned ? wrapper : undefined);
  if (wrapper?.required === true && !requiredContractWrapperActive(next, contract))
    return yield* GuidanceError.make({message: `${adapter.catalog.displayName} project guidance wrapper is inactive.`});
  const projectionLimit = targetProjectionCharacterLimit(contract.projection.relativePath);
  if (projectionLimit !== undefined && unicodeCharacters(next) > projectionLimit)
    return yield* GuidanceError.make({
      message: `${adapter.catalog.displayName} project guidance exceeds the target's ${projectionLimit}-character file limit.`,
    });
  const resumePending = continuingPending && current === next;
  const continuePending = continuingPending && pendingTargetMatchesPrevious(previous, existingBlock);
  if (
    existingBlock !== undefined &&
    state.state === 'unavailable' &&
    !options.force &&
    !resumePending &&
    !continuePending &&
    !requiredWrapperUpgrade
  )
    return yield* GuidanceError.make({
      message:
        'A project guidance block exists without a matching current receipt; rerun with --force to replace only that block.',
    });
  if ((state.state === 'locally-modified' || state.state === 'missing-block') && !options.force)
    return yield* GuidanceError.make({
      message: `Guidance projection is ${state.state}; rerun with --force to replace only its managed block.`,
    });
  return {current, next, receipt, resumePending, state: state.state};
});

const projectStatus = Effect.fn('guidance.projectStatus')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  project: string,
  root: string,
  repositoryId: string,
  worktreeId: string,
) {
  const contract = guidanceContract(adapter);
  const targetIdentity = guidanceTargetIdentity(worktreeId, root, contract.projection.relativePath);
  const receipt = yield* readReceipt(config, repositoryId, project, targetIdentity, contract.projection.relativePath);
  const target = yield* safeTarget(root, contract.projection.relativePath);
  const current = yield* readGuidanceTargetByPath(root, target);
  return yield* projectStatusFromEvidence(config, adapter, project, receipt, current);
});

const projectStatusFromEvidence = Effect.fn('guidance.projectStatusFromEvidence')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  project: string,
  receipt: GuidanceReceiptV2 | undefined,
  current: string | undefined,
) {
  if (!receipt || receipt.state !== 'current') return {state: 'unavailable' as const, surface: adapter.catalog.id};
  if (current !== undefined && hasMalformedGuidanceBlock(current))
    return {state: 'unavailable' as const, surface: adapter.catalog.id};
  const block = current === undefined ? undefined : guidanceBlock(current);
  if (!block) return {state: 'missing-block' as const, surface: adapter.catalog.id};
  const contract = guidanceContract(adapter);
  const limit = targetProjectionCharacterLimit(contract.projection.relativePath);
  if (
    (limit !== undefined && current !== undefined && unicodeCharacters(current) > limit) ||
    (contract.projection.wrapper?.required === true && !requiredContractWrapperActive(current, contract))
  )
    return {state: 'unavailable' as const, surface: adapter.catalog.id};
  if (
    sha256HexSync(block) !== receipt.expectedManagedBlockHash ||
    !wrapperOwnershipMatches(current, block, contract.projection.wrapper, receipt.wrapperOwned)
  )
    return {state: 'locally-modified' as const, surface: adapter.catalog.id};
  const records = yield* readActiveProjectMemoryRecords(config, project);
  const currentHashes = new Map(records.map(record => [record.uri, sha256HexSync(record.body)]));
  if (receipt.sources.some(source => currentHashes.get(source.uri) !== source.contentHash))
    return {state: 'stale-sources' as const, surface: adapter.catalog.id};
  return {state: 'current' as const, surface: adapter.catalog.id};
});

const projectRoot = Effect.fn('guidance.projectRoot')(function* (cwd?: string) {
  const path = yield* Path.Path;
  if (cwd !== undefined) return path.resolve(cwd);
  const system = yield* SystemInfo;
  return path.resolve(system.currentDirectory());
});

const safeTarget = Effect.fn('guidance.safeTarget')(function* (root: string, relativePath: string) {
  const path = yield* Path.Path;
  if (relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..'))
    return yield* GuidanceError.make({message: 'Adapter guidance target escapes the project root.'});
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`))
    return yield* GuidanceError.make({message: 'Adapter guidance target escapes the project root.'});
  return target;
});

const readGuidanceTarget = Effect.fn('guidance.readTarget')(function* (root: string, relativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* safeTarget(root, relativePath);
  yield* assertGuidanceTarget(root, target);
  if (!(yield* fs.exists(target))) return undefined;
  const info = yield* fs.stat(target);
  if (info.type === 'Directory') return undefined;
  if (info.type !== 'File' || info.size > BigInt(MAX_IMPORT_BYTES))
    return yield* GuidanceError.make({message: `Imported guidance exceeds ${MAX_IMPORT_BYTES} bytes.`});
  return yield* readBoundedContainedStableRegularFile(fs, path, root, relativePath, MAX_IMPORT_BYTES).pipe(
    Effect.flatMap(readExactImportText),
  );
});

const readGuidanceDirectories = Effect.fn('guidance.readDirectories')(function* (
  root: string,
  directories: NonNullable<AgentGuidanceContract['importDirectories']>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const discovered: {readonly content: string; readonly relative: string}[] = [];
  let entryCount = 0;
  let totalBytes = 0;
  for (const specification of [...directories].sort((left, right) =>
    compareText(left.relativePath, right.relativePath),
  )) {
    const directory = yield* safeTarget(root, specification.relativePath);
    if (!(yield* fs.exists(directory))) continue;
    const pending = [{absolute: directory, depth: 0}];
    while (pending.length > 0) {
      const current = pending.shift()!;
      yield* assertGuidanceTarget(root, current.absolute);
      const info = yield* fs.stat(current.absolute);
      if (info.type === 'SymbolicLink')
        return yield* GuidanceError.make({message: 'Project guidance import does not follow symbolic links.'});
      if (info.type === 'Directory') {
        if (current.depth >= MAX_IMPORT_DIRECTORY_DEPTH)
          return yield* GuidanceError.make({message: 'Project guidance import directory exceeds its depth limit.'});
        const names = (yield* fs.readDirectory(current.absolute)).sort(compareText);
        entryCount += names.length;
        if (entryCount > MAX_IMPORT_DIRECTORY_ENTRIES)
          return yield* GuidanceError.make({message: 'Project guidance import directory has too many entries.'});
        pending.push(...names.map(name => ({absolute: path.join(current.absolute, name), depth: current.depth + 1})));
        continue;
      }
      if (info.type !== 'File') continue;
      const relative = path.relative(root, current.absolute);
      if (!specification.extensions.some(extension => relative.endsWith(extension))) continue;
      if (discovered.length >= MAX_GUIDANCE_SOURCES)
        return yield* GuidanceError.make({message: 'Project guidance import contains too many files.'});
      if (info.size > BigInt(MAX_IMPORT_BYTES))
        return yield* GuidanceError.make({message: `Imported guidance exceeds ${MAX_IMPORT_BYTES} bytes.`});
      const content = yield* readBoundedContainedStableRegularFile(
        fs,
        path,
        root,
        normalizeGuidanceImportPath(relative),
        MAX_IMPORT_BYTES,
      ).pipe(Effect.flatMap(readExactImportText));
      totalBytes += utf8Bytes(content);
      if (totalBytes > MAX_IMPORT_BYTES)
        return yield* GuidanceError.make({message: `Imported guidance exceeds ${MAX_IMPORT_BYTES} bytes.`});
      discovered.push({content, relative});
    }
  }
  return discovered.sort((left, right) => compareText(left.relative, right.relative));
});

const readExactImportText = Effect.fn('guidance.readExactImportText')(function* (bytes: Uint8Array) {
  if (bytes.byteLength > MAX_IMPORT_BYTES)
    return yield* GuidanceError.make({message: `Imported guidance exceeds ${MAX_IMPORT_BYTES} bytes.`});
  const text = yield* Effect.try({
    try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
    catch: () => GuidanceError.make({message: 'Imported guidance must be strict UTF-8 text.'}),
  });
  if (text.includes('\u0000') || !bytesEqual(bytes, new TextEncoder().encode(text)))
    return yield* GuidanceError.make({message: 'Imported guidance must be exact, NUL-free UTF-8 text.'});
  return text;
});

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

const assertProjectionFallbackInactive = Effect.fn('guidance.assertProjectionFallbackInactive')(function* (
  root: string,
  contract: AgentGuidanceContract,
) {
  const candidate = normalizeGuidanceImportPath(contract.projection.relativePath);
  for (const adapter of AGENT_ADAPTERS) {
    const consumer = adapter.guidance;
    if (consumer?.importMode !== 'first-existing') continue;
    const candidateIndex = consumer.importPaths.findIndex(path => normalizeGuidanceImportPath(path) === candidate);
    if (candidateIndex < 0) continue;
    let activeIndex = -1;
    for (let index = 0; index < consumer.importPaths.length; index += 1) {
      if (yield* guidanceFileExists(root, consumer.importPaths[index])) {
        activeIndex = index;
        break;
      }
    }
    if (activeIndex > candidateIndex)
      return yield* GuidanceError.make({
        message: `The active ${consumer.importPaths[activeIndex]} fallback must be migrated before projecting ${contract.projection.relativePath}.`,
      });
  }
  for (const adapter of AGENT_ADAPTERS) {
    const consumer = adapter.guidance;
    if (
      consumer === undefined ||
      normalizeGuidanceImportPath(consumer.projection.relativePath) !== candidate ||
      consumer.projection.activeFallbackBlocker === undefined
    )
      continue;
    const blocker = consumer.projection.activeFallbackBlocker;
    if (!(yield* guidanceFileExists(root, blocker.relativePath))) continue;
    if (
      blocker.inactiveWhenImportDirectoryHasFiles === true &&
      (yield* guidanceDirectoriesContainFile(root, consumer.importDirectories ?? []))
    )
      continue;
    return yield* GuidanceError.make({message: blocker.reason});
  }
});

const guidanceFileExists = Effect.fn('guidance.fileExists')(function* (root: string, relativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* safeTarget(root, relativePath);
  yield* assertGuidanceTarget(root, target);
  if (!(yield* fs.exists(target))) return false;
  return (yield* fs.stat(target)).type === 'File';
});

const guidanceDirectoriesContainFile = Effect.fn('guidance.directoriesContainFile')(function* (
  root: string,
  directories: NonNullable<AgentGuidanceContract['importDirectories']>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let entryCount = 0;
  for (const specification of directories) {
    const directory = yield* safeTarget(root, specification.relativePath);
    if (!(yield* fs.exists(directory))) continue;
    const pending = [{absolute: directory, depth: 0}];
    while (pending.length > 0) {
      const current = pending.shift()!;
      yield* assertGuidanceTarget(root, current.absolute);
      const info = yield* fs.stat(current.absolute);
      if (info.type === 'File') {
        if (current.absolute === directory || info.size === 0n) continue;
        const basename = path.basename(current.absolute);
        if (basename === 'Thumbs.db' || IGNORED_RULE_FILE_SUFFIXES.some(suffix => basename.endsWith(suffix))) continue;
        return true;
      }
      if (info.type !== 'Directory') continue;
      const names = (yield* fs.readDirectory(current.absolute)).sort(compareText);
      entryCount += names.length;
      if (entryCount > MAX_IMPORT_DIRECTORY_ENTRIES)
        return yield* GuidanceError.make({message: 'Project guidance rules directory exceeds its entry limit.'});
      if (current.depth >= MAX_IMPORT_DIRECTORY_DEPTH && names.length > 0)
        return yield* GuidanceError.make({message: 'Project guidance rules directory exceeds its depth limit.'});
      pending.push(...names.map(name => ({absolute: path.join(current.absolute, name), depth: current.depth + 1})));
    }
  }
  return false;
});

const readGuidanceTargetByPath = Effect.fn('guidance.readTargetByPath')(function* (root: string, target: string) {
  yield* assertGuidanceTarget(root, target);
  return yield* readFileIfExists(target);
});

const assertGuidanceTarget = Effect.fn('guidance.assertTarget')(function* (root: string, target: string) {
  const path = yield* Path.Path;
  let current = target;
  while (true) {
    yield* assertAgentTargetNotSymlink(current);
    if (current === root || current === path.dirname(current)) break;
    current = path.dirname(current);
  }
});

function wrapperOwnershipMatches(
  current: string | undefined,
  block: string | undefined,
  wrapper: {readonly prefix: string; readonly required?: boolean; readonly suffix: string} | undefined,
  wrapperOwned: boolean,
): boolean {
  if (!wrapperOwned) return true;
  if (wrapper === undefined) return false;
  if (current === undefined) return true;
  if (block === undefined) return current === `${wrapper.prefix}${wrapper.suffix}`;
  return current.includes(`${wrapper.prefix}${block}${wrapper.suffix}`);
}

function requiredWrapperActive(
  current: string | undefined,
  wrapper: {readonly prefix: string; readonly required?: boolean; readonly suffix: string},
): boolean {
  if (wrapper.required !== true) return true;
  if (current === undefined || !current.startsWith(wrapper.prefix)) return false;
  return wrapper.suffix.length === 0 || current.endsWith(wrapper.suffix);
}

function requiredContractWrapperActive(current: string | undefined, contract: AgentGuidanceContract): boolean {
  const projected = contract.projection.wrapper;
  if (projected?.required !== true) return true;
  return [projected, ...(contract.importWrappers ?? [])].some(wrapper =>
    requiredWrapperActive(current, {...wrapper, required: true}),
  );
}

function ownedWrapperEnvelopeIndex(
  current: string | undefined,
  block: string | undefined,
  wrapper: {readonly prefix: string; readonly suffix: string} | undefined,
): number {
  if (current === undefined || wrapper === undefined) return -1;
  return current.indexOf(
    block === undefined ? `${wrapper.prefix}${wrapper.suffix}` : `${wrapper.prefix}${block}${wrapper.suffix}`,
  );
}

function isThreadnoteOnlyContent(content: string, contract: AgentGuidanceContract): boolean {
  const hadManagedContent = content.includes(GUIDANCE_BLOCK_START) || content.includes(USER_INSTRUCTIONS_START_MARKER);
  return hadManagedContent && stripImportedGuidance(content, contract).trim().length === 0;
}

function isRemovableGuidanceRemainder(content: string, contract: AgentGuidanceContract): boolean {
  if (content.trim().length === 0) return true;
  const wrappers = [
    ...(contract.importWrappers ?? []),
    ...(contract.projection.wrapper === undefined ? [] : [contract.projection.wrapper]),
  ];
  return wrappers.some(wrapper => content.trim() === `${wrapper.prefix}${wrapper.suffix}`.trim());
}

function receiptsDescribeSameProjection(left: GuidanceReceiptV2, right: GuidanceReceiptV2): boolean {
  return (
    left.expectedManagedBlockHash === right.expectedManagedBlockHash &&
    left.project === right.project &&
    left.removeTargetWhenEmpty === right.removeTargetWhenEmpty &&
    left.repositoryId === right.repositoryId &&
    left.targetIdentity === right.targetIdentity &&
    left.targetPath === right.targetPath &&
    left.wrapperOwned === right.wrapperOwned &&
    JSON.stringify(left.sources) === JSON.stringify(right.sources)
  );
}

function pendingTargetMatchesPrevious(receipt: GuidanceReceiptV2 | undefined, block: string | undefined): boolean {
  if (!receipt || receipt.state !== 'pending') return false;
  return receipt.previousManagedBlockHash === null
    ? block === undefined
    : block !== undefined && sha256HexSync(block) === receipt.previousManagedBlockHash;
}

function guidanceTargetIdentity(worktreeId: string, root: string, targetPath: string): string {
  return sha256HexSync(['guidance-target-v2', worktreeId, root, targetPath].join('\n'));
}

function receiptPath(path: Path.Path, home: string, repositoryId: string, targetIdentity: string): string {
  return path.join(
    home,
    'guidance',
    'v2',
    'receipts',
    `${sha256HexSync([repositoryId, targetIdentity].join('\n'))}.json`,
  );
}

function legacyConsumptionPath(path: Path.Path, home: string, repositoryId: string, targetIdentity: string): string {
  return path.join(
    home,
    'guidance',
    'v2',
    'legacy-consumed',
    `${sha256HexSync([repositoryId, targetIdentity].join('\n'))}.txt`,
  );
}

function legacyReceiptPath(
  path: Path.Path,
  home: string,
  repositoryId: string,
  project: string,
  surface: string,
): string {
  return path.join(
    home,
    'guidance',
    'v1',
    'receipts',
    `${sha256HexSync([repositoryId, project, surface].join('\n'))}.json`,
  );
}

const LEGACY_GUIDANCE_SURFACES_BY_TARGET: Readonly<Record<string, readonly string[]>> = {
  'AGENTS.md': ['codex-cli'],
  'CLAUDE.md': ['claude-code'],
  '.cursor/rules/threadnote.mdc': ['cursor-desktop'],
  '.github/instructions/threadnote.instructions.md': ['copilot-vscode'],
};

const readReceipt = Effect.fn('guidance.readReceipt')(function* (
  config: RuntimeConfig,
  repositoryId: string,
  project: string,
  targetIdentity: string,
  targetPath: string,
) {
  const path = yield* Path.Path;
  const raw = yield* readBoundedReceiptFile(receiptPath(path, config.agentContextHome, repositoryId, targetIdentity));
  if (raw !== undefined)
    return yield* Effect.try({
      try: () => parseGuidanceReceiptV2(JSON.parse(raw), {project, repositoryId, targetIdentity, targetPath}),
      catch: () => GuidanceError.make({message: 'Guidance receipt is invalid or belongs to another project.'}),
    });
  const legacyConsumed = yield* readBoundedReceiptFile(
    legacyConsumptionPath(path, config.agentContextHome, repositoryId, targetIdentity),
  );
  if (legacyConsumed !== undefined) {
    if (legacyConsumed !== 'consumed\n')
      return yield* GuidanceError.make({message: 'Guidance legacy-consumption marker is invalid.'});
    return undefined;
  }
  const legacyReceipts = yield* Effect.forEach(LEGACY_GUIDANCE_SURFACES_BY_TARGET[targetPath] ?? [], surface =>
    readBoundedReceiptFile(legacyReceiptPath(path, config.agentContextHome, repositoryId, project, surface)).pipe(
      Effect.map(legacy => ({legacy, surface})),
    ),
  );
  const migrated = yield* Effect.try({
    try: () =>
      legacyReceipts
        .filter((entry): entry is {readonly legacy: string; readonly surface: string} => entry.legacy !== undefined)
        .map(({legacy, surface}) =>
          parseGuidanceReceiptV1(JSON.parse(legacy), {project, repositoryId, surface, targetPath}),
        ),
    catch: () => GuidanceError.make({message: 'Legacy guidance receipt is invalid; migration was refused.'}),
  });
  if (migrated.length === 0) return undefined;
  if (
    migrated.length > 1 &&
    migrated.slice(1).some(receipt => !legacyReceiptsDescribeSameProjection(receipt, migrated[0]))
  )
    return yield* GuidanceError.make({message: 'Legacy guidance receipts conflict; migration was refused.'});
  const legacy = migrated[0];
  return {
    expectedManagedBlockHash: legacy.expectedManagedBlockHash,
    previousManagedBlockHash: legacy.previousManagedBlockHash,
    project: legacy.project,
    removeTargetWhenEmpty: legacy.removeTargetWhenEmpty,
    repositoryId: legacy.repositoryId,
    sources: legacy.sources,
    state: legacy.state,
    targetIdentity,
    targetPath: legacy.targetPath,
    version: GUIDANCE_SCHEMA_VERSION,
    wrapperOwned: legacy.wrapperOwned,
  } satisfies GuidanceReceiptV2;
});

export function parseGuidanceReceiptV2(
  value: unknown,
  expected: {
    readonly project: string;
    readonly repositoryId: string;
    readonly targetIdentity: string;
    readonly targetPath: string;
  },
): GuidanceReceiptV2 {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as {version?: unknown}).version !== GUIDANCE_SCHEMA_VERSION ||
    !['current', 'pending'].includes(String((value as {state?: unknown}).state))
  )
    throw new Error('invalid receipt');
  const receipt = value as Partial<GuidanceReceiptV2>;
  if (
    !hasExactKeys(value, [
      'expectedManagedBlockHash',
      'previousManagedBlockHash',
      'project',
      'removeTargetWhenEmpty',
      'repositoryId',
      'sources',
      'state',
      'targetIdentity',
      'targetPath',
      'version',
      'wrapperOwned',
    ])
  )
    throw new Error('invalid receipt');
  if (
    typeof receipt.repositoryId !== 'string' ||
    typeof receipt.project !== 'string' ||
    typeof receipt.targetIdentity !== 'string' ||
    typeof receipt.targetPath !== 'string' ||
    typeof receipt.expectedManagedBlockHash !== 'string' ||
    (receipt.previousManagedBlockHash !== null && typeof receipt.previousManagedBlockHash !== 'string') ||
    typeof receipt.removeTargetWhenEmpty !== 'boolean' ||
    typeof receipt.wrapperOwned !== 'boolean' ||
    receipt.repositoryId !== expected.repositoryId ||
    receipt.project !== expected.project ||
    receipt.targetIdentity !== expected.targetIdentity ||
    receipt.targetPath !== expected.targetPath ||
    !SHA256_PATTERN.test(receipt.expectedManagedBlockHash) ||
    (typeof receipt.previousManagedBlockHash === 'string' && !SHA256_PATTERN.test(receipt.previousManagedBlockHash)) ||
    (receipt.state === 'current' && receipt.previousManagedBlockHash !== null) ||
    utf8Bytes(receipt.repositoryId) > MAX_GUIDANCE_IDENTITY_BYTES ||
    utf8Bytes(receipt.project) > MAX_GUIDANCE_IDENTITY_BYTES ||
    !SHA256_PATTERN.test(receipt.targetIdentity) ||
    utf8Bytes(receipt.targetPath) > MAX_GUIDANCE_TARGET_BYTES ||
    !Array.isArray(receipt.sources) ||
    receipt.sources.length === 0 ||
    receipt.sources.length > MAX_GUIDANCE_SOURCES ||
    receipt.sources.some(
      source =>
        !source ||
        !hasExactKeys(source, ['contentHash', 'uri']) ||
        typeof source.uri !== 'string' ||
        typeof source.contentHash !== 'string' ||
        utf8Bytes(source.uri) > MAX_GUIDANCE_URI_BYTES ||
        !SHA256_PATTERN.test(source.contentHash) ||
        !isCanonicalThreadnoteUri(source.uri),
    ) ||
    new Set(receipt.sources.map(source => source.uri)).size !== receipt.sources.length
  )
    throw new Error('invalid receipt');
  return receipt as GuidanceReceiptV2;
}

export function parseGuidanceReceiptV1(
  value: unknown,
  expected: {
    readonly project: string;
    readonly repositoryId: string;
    readonly surface: string;
    readonly targetPath: string;
  },
): GuidanceReceiptV1 {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as {version?: unknown}).version !== LEGACY_GUIDANCE_SCHEMA_VERSION ||
    !['current', 'pending'].includes(String((value as {state?: unknown}).state)) ||
    !hasExactKeys(value, [
      'expectedManagedBlockHash',
      'previousManagedBlockHash',
      'project',
      'removeTargetWhenEmpty',
      'repositoryId',
      'sources',
      'state',
      'surface',
      'targetPath',
      'version',
      'wrapperOwned',
    ])
  )
    throw new Error('invalid receipt');
  const receipt = value as Partial<GuidanceReceiptV1>;
  if (
    typeof receipt.repositoryId !== 'string' ||
    typeof receipt.project !== 'string' ||
    typeof receipt.surface !== 'string' ||
    typeof receipt.targetPath !== 'string' ||
    typeof receipt.expectedManagedBlockHash !== 'string' ||
    (receipt.previousManagedBlockHash !== null && typeof receipt.previousManagedBlockHash !== 'string') ||
    typeof receipt.removeTargetWhenEmpty !== 'boolean' ||
    typeof receipt.wrapperOwned !== 'boolean' ||
    receipt.repositoryId !== expected.repositoryId ||
    receipt.project !== expected.project ||
    receipt.surface !== expected.surface ||
    receipt.targetPath !== expected.targetPath ||
    !SHA256_PATTERN.test(receipt.expectedManagedBlockHash) ||
    (typeof receipt.previousManagedBlockHash === 'string' && !SHA256_PATTERN.test(receipt.previousManagedBlockHash)) ||
    (receipt.state === 'current' && receipt.previousManagedBlockHash !== null) ||
    utf8Bytes(receipt.repositoryId) > MAX_GUIDANCE_IDENTITY_BYTES ||
    utf8Bytes(receipt.project) > MAX_GUIDANCE_IDENTITY_BYTES ||
    utf8Bytes(receipt.surface) > MAX_GUIDANCE_IDENTITY_BYTES ||
    utf8Bytes(receipt.targetPath) > MAX_GUIDANCE_TARGET_BYTES ||
    !validReceiptSources(receipt.sources)
  )
    throw new Error('invalid receipt');
  return receipt as GuidanceReceiptV1;
}

function legacyReceiptsDescribeSameProjection(left: GuidanceReceiptV1, right: GuidanceReceiptV1): boolean {
  const {surface: _leftSurface, ...leftProjection} = left;
  const {surface: _rightSurface, ...rightProjection} = right;
  return JSON.stringify(leftProjection) === JSON.stringify(rightProjection);
}

function validReceiptSources(value: unknown): value is GuidanceReceiptV2['sources'] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_GUIDANCE_SOURCES &&
    value.every(
      source =>
        source &&
        hasExactKeys(source, ['contentHash', 'uri']) &&
        typeof source.uri === 'string' &&
        typeof source.contentHash === 'string' &&
        utf8Bytes(source.uri) <= MAX_GUIDANCE_URI_BYTES &&
        SHA256_PATTERN.test(source.contentHash) &&
        isCanonicalThreadnoteUri(source.uri),
    ) &&
    new Set(value.map(source => source.uri)).size === value.length
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const canonical = [...expected].sort(compareText);
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function isCanonicalThreadnoteUri(uri: string): boolean {
  try {
    return uri.startsWith('threadnote://') && parseResourceId(uri).canonicalUri === uri;
  } catch {
    return false;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function unicodeCharacters(value: string): number {
  return [...value].length;
}

function targetProjectionCharacterLimit(targetPath: string): number | undefined {
  const limits = AGENT_ADAPTERS.flatMap(adapter =>
    adapter.guidance?.projection.relativePath === targetPath && adapter.guidance.maxProjectionCharacters !== undefined
      ? [adapter.guidance.maxProjectionCharacters]
      : [],
  );
  return limits.length === 0 ? undefined : Math.min(...limits);
}

const readBoundedReceiptFile = Effect.fn('guidance.readBoundedReceiptFile')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(target))) return undefined;
  yield* assertAgentTargetNotSymlink(target);
  const info = yield* fs.stat(target);
  if (info.type !== 'File' || info.size > BigInt(MAX_GUIDANCE_RECEIPT_BYTES))
    return yield* GuidanceError.make({message: 'Guidance receipt is invalid or exceeds its byte limit.'});
  const raw = yield* fs.readFileString(target);
  if (utf8Bytes(raw) > MAX_GUIDANCE_RECEIPT_BYTES)
    return yield* GuidanceError.make({message: 'Guidance receipt exceeds its byte limit.'});
  return raw;
});

const writeReceipt = Effect.fn('guidance.writeReceipt')(function* (config: RuntimeConfig, receipt: GuidanceReceiptV2) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = receiptPath(path, config.agentContextHome, receipt.repositoryId, receipt.targetIdentity);
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  const content = `${JSON.stringify(receipt, undefined, 2)}\n`;
  if (utf8Bytes(content) > MAX_GUIDANCE_RECEIPT_BYTES)
    return yield* GuidanceError.make({message: 'Guidance receipt exceeds its byte limit.'});
  const previous = yield* readBoundedReceiptFile(target);
  yield* atomicAgentWrite(target, content, 0o600, {content: previous});
  yield* writeLegacyConsumptionMarker(config, receipt.repositoryId, receipt.targetIdentity);
});

const writeLegacyConsumptionMarker = Effect.fn('guidance.writeLegacyConsumptionMarker')(function* (
  config: RuntimeConfig,
  repositoryId: string,
  targetIdentity: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = legacyConsumptionPath(path, config.agentContextHome, repositoryId, targetIdentity);
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  const previous = yield* readBoundedReceiptFile(target);
  if (previous === 'consumed\n') return;
  yield* atomicAgentWrite(target, 'consumed\n', 0o600, {content: previous});
});

const removeReceipt = Effect.fn('guidance.removeReceipt')(function* (
  config: RuntimeConfig,
  repositoryId: string,
  targetIdentity: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = receiptPath(path, config.agentContextHome, repositoryId, targetIdentity);
  yield* writeLegacyConsumptionMarker(config, repositoryId, targetIdentity);
  if (yield* fs.exists(target)) {
    yield* assertAgentTargetNotSymlink(target);
    yield* fs.remove(target);
  }
});

export const renderGuidanceResult = (value: unknown, json: boolean) =>
  json ? JSON.stringify(value) : `Guidance ${JSON.stringify(value)}`;

export function normalizeGuidanceImportPath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function guidanceProjectionAdapters(): readonly AgentAdapter[] {
  const byTarget = new Map<string, AgentAdapter>();
  for (const adapter of AGENT_ADAPTERS) {
    if (adapter.guidance && !byTarget.has(adapter.guidance.projection.relativePath))
      byTarget.set(adapter.guidance.projection.relativePath, adapter);
  }
  return [...byTarget.values()];
}
