import {Array as EffectArray} from 'effect';
import {Clock, Crypto, Effect, Equal, FileSystem, Option, Path, Schema} from 'effect';
import {
  canonicalMemoryDocumentContent,
  isAgentArtifactUri,
  isAgentArtifactPath,
  isSharedMemoryUri,
  parseMemoryDocument,
  validMemoryObsidianEvidence,
  type MemoryMetadata,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {assertMemoryCodeCitation, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {isConsolidationReceiptShape, type ConsolidationReceipt} from '@threadnote/memory/consolidation';
import {
  validateReviewedSupportLegacyOrigin,
  validateReviewedSupportSnapshot,
  type ReviewedMemorySupportV1,
} from '@threadnote/memory/reviewed-support';
import type {TopicMaintenanceManifest} from '@threadnote/memory/topic-maintenance';
import {validSourceEvidenceCitation} from '@threadnote/store/source-evidence-citation';
import {isOneOf} from '@threadnote/platform/validation';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {canonicalResourceUri, parseResourceId} from '@threadnote/store/resource-id';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';
import {ContextMaintenanceSnapshotDiagnosticV1} from '@threadnote/context/health_maintenance';
import {localUserMemoriesRoot} from '../migrations.js';
import {maintenanceSnapshotFailure, withMaintenanceSnapshotDiagnostic} from './maintenance_snapshot.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

interface InventoryEntry {
  readonly uri: string;
  readonly path: string;
  readonly signature: string;
  /** Exact bytes for inventory authority and physical generation. */
  readonly hash: string;
  /** Approved payload identity; absent in older V2 scheduling hints until read afresh. */
  readonly canonicalContentHash?: string;
  readonly bodyHash: string;
  readonly headerTitle: MemoryRecord['headerTitle'];
  readonly metadata: MemoryMetadata;
}
interface DirectoryPage {
  readonly directory: string;
  readonly names?: readonly string[];
  readonly offset: number;
}
interface Inventory {
  readonly version: 2;
  readonly mutationGeneration: string;
  readonly entries: Readonly<Record<string, InventoryEntry>>;
  readonly queue: readonly DirectoryPage[];
  readonly complete: boolean;
  readonly root: string;
  readonly incompleteReason?: InventoryIncompleteReason;
  readonly diagnostics?: Readonly<Record<string, ContextMaintenanceSnapshotDiagnosticV1>>;
}

/** Terminal work is bounded independently from the normal discovery name budget. */
export const contextMaintenanceInventoryAuthorityLimits = {
  catalogNames: 10_000,
  canonicalBytes: 32 * 1024 * 1024,
  recordBytes: 8 * 1024 * 1024,
  elapsedMilliseconds: 2_000,
  readConcurrency: 8,
} as const;
type InventoryIncompleteReason =
  | 'inventory-records-omitted'
  | 'inventory-discovery-incomplete'
  | 'inventory-terminal-catalog-boundary'
  | 'inventory-terminal-byte-boundary'
  | 'inventory-terminal-time-boundary'
  | 'inventory-terminal-lock-contended'
  | 'inventory-terminal-generation-race'
  | 'inventory-terminal-membership-race';

export interface ContextMaintenanceInventoryPreparationV2 {
  readonly complete: boolean;
  readonly admittedRecords: number;
  readonly omittedRecords?: number;
  readonly diagnostics?: readonly ContextMaintenanceSnapshotDiagnosticV1[];
  readonly incompleteReason?: InventoryIncompleteReason;
}

export function contextMaintenanceInventoryPreparation(
  snapshot: {
    readonly complete: boolean;
    readonly incompleteReason?: InventoryIncompleteReason;
    readonly diagnostics?: readonly ContextMaintenanceSnapshotDiagnosticV1[];
  },
  admittedRecords: number,
): ContextMaintenanceInventoryPreparationV2 {
  return {
    complete: snapshot.complete,
    admittedRecords,
    ...(snapshot.diagnostics?.length
      ? {omittedRecords: snapshot.diagnostics.length, diagnostics: snapshot.diagnostics.slice(0, 8)}
      : {}),
    ...(snapshot.incompleteReason === undefined ? {} : {incompleteReason: snapshot.incompleteReason}),
  };
}

function inventoryMemoryUri(path: Path.Path, root: string, user: string, candidate: string): string {
  return canonicalResourceUri('user', [
    uriSegment(user),
    'memories',
    ...Effect2.pipe(path.relative(root, candidate), EffectString.split(path.sep)),
  ]);
}

function inventoryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function isMemoryCitation(value: unknown): value is MemoryCodeCitationV1 {
  try {
    assertMemoryCodeCitation(value);
    return true;
  } catch {
    return false;
  }
}

function isTopicMaintenanceManifest(value: unknown): value is TopicMaintenanceManifest {
  if (!inventoryRecord(value) || !EffectArray.isArray(value.paragraphs)) return false;
  const paragraphsValid = EffectArray.every(value.paragraphs, (paragraph: unknown) => {
    if (
      !inventoryRecord(paragraph) ||
      !isOneOf(['descriptive', 'normative', 'historical'], paragraph.role) ||
      !isOneOf(['direct', 'contextual', 'unresolved'], paragraph.support) ||
      !EffectArray.isArray(paragraph.citationIds) ||
      !EffectArray.every(paragraph.citationIds, (id: unknown) => typeof id === 'string') ||
      typeof paragraph.ordinal !== 'number' ||
      !Number.isFinite(paragraph.ordinal) ||
      typeof paragraph.hash !== 'string'
    )
      return false;
    return (
      (!('scope' in paragraph) || paragraph.scope === undefined || typeof paragraph.scope === 'string') &&
      (!('validity' in paragraph) || paragraph.validity === undefined || typeof paragraph.validity === 'string')
    );
  });
  if (!paragraphsValid || !EffectArray.isArray(value.additionalDependencies)) return false;
  const dependenciesValid = EffectArray.every(
    value.additionalDependencies,
    (dependency: unknown) =>
      inventoryRecord(dependency) &&
      isOneOf(['configuration', 'dependency'], dependency.kind) &&
      typeof dependency.citationId === 'string',
  );
  if (!dependenciesValid) return false;
  const common =
    typeof value.memoryId === 'string' && typeof value.bodyHash === 'string' && value.coverage === 'declared-only';
  if (!common) return false;
  if (value.version === 1) return typeof value.repositoryId === 'string';
  if (value.version === 2)
    return (
      typeof value.repositoryId === 'string' &&
      EffectArray.isArray(value.originCitationIds) &&
      EffectArray.every(value.originCitationIds, (id: unknown) => typeof id === 'string') &&
      EffectArray.isArray(value.acceptedSources) &&
      EffectArray.every(
        value.acceptedSources,
        (source: unknown) =>
          inventoryRecord(source) &&
          typeof source.citationId === 'string' &&
          typeof source.acceptedCitationId === 'string',
      )
    );
  if (value.version !== 3) return false;
  if (value.sourceKind === 'obsidian')
    return (
      value.additionalDependencies.length === 0 &&
      typeof value.originCitationId === 'string' &&
      validMemoryObsidianEvidence(value.activeEvidence)
    );
  return (
    value.sourceKind === 'code' &&
    typeof value.repositoryId === 'string' &&
    EffectArray.isArray(value.originCitationIds) &&
    EffectArray.every(value.originCitationIds, (id: unknown) => typeof id === 'string') &&
    EffectArray.isArray(value.acceptedSources) &&
    EffectArray.every(
      value.acceptedSources,
      (source: unknown) =>
        inventoryRecord(source) &&
        typeof source.citationId === 'string' &&
        typeof source.acceptedCitationId === 'string',
    ) &&
    (!('dependencyExpansions' in value) ||
      value.dependencyExpansions === undefined ||
      (EffectArray.isArray(value.dependencyExpansions) &&
        EffectArray.every(
          value.dependencyExpansions,
          (expansion: unknown) =>
            inventoryRecord(expansion) &&
            expansion.version === 1 &&
            typeof expansion.revision === 'string' &&
            typeof expansion.proofDigest === 'string' &&
            typeof expansion.requestDigest === 'string' &&
            typeof expansion.previousManifestHash === 'string' &&
            typeof expansion.sourceCommit === 'string' &&
            EffectArray.isArray(expansion.citationIds) &&
            EffectArray.every(expansion.citationIds, (id: unknown) => typeof id === 'string'),
        )))
  );
}

function isReviewedMemorySupport(value: unknown): value is ReviewedMemorySupportV1 {
  if (
    !inventoryRecord(value) ||
    value.type !== 'reviewed-memory-support' ||
    value.version !== 1 ||
    !('active' in value)
  )
    return false;
  try {
    validateReviewedSupportSnapshot(value.active);
    if ('initialApproval' in value && value.initialApproval !== undefined)
      validateReviewedSupportSnapshot(value.initialApproval);
    if ('legacyOrigin' in value && value.legacyOrigin !== undefined)
      validateReviewedSupportLegacyOrigin(value.legacyOrigin);
    return true;
  } catch {
    return false;
  }
}

const MemoryCitationSchema = Schema.declare<MemoryCodeCitationV1>(isMemoryCitation);
const TopicMaintenanceManifestSchema = Schema.declare<TopicMaintenanceManifest>(isTopicMaintenanceManifest);
const ReviewedMemorySupportSchema = Schema.declare<ReviewedMemorySupportV1>(isReviewedMemorySupport);
const MemoryMetadataSchema = Schema.Struct({
  archivedFrom: Schema.optionalKey(Schema.String),
  authority: Schema.optionalKey(
    Schema.Literals(['agent_generated', 'canonical_repo', 'external', 'reviewed_shared', 'user_approved']),
  ),
  candidateId: Schema.optionalKey(Schema.String),
  codeCitations: Schema.optionalKey(Schema.Array(MemoryCitationSchema)),
  citationErrors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        index: Schema.optionalKey(Schema.Int),
        reason: Schema.Literals([
          'aggregate-too-large',
          'duplicate-id',
          'entry-too-large',
          'id-mismatch',
          'invalid-json',
          'invalid-shape',
          'non-canonical',
          'schema-version-mismatch',
          'too-many-citations',
          'unsupported-version',
        ]),
      }),
    ),
  ),
  consolidation: Schema.optionalKey(Schema.declare<ConsolidationReceipt>(isConsolidationReceiptShape)),
  consolidationError: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(Schema.Array(Schema.String)),
  obsidianEvidence: Schema.optionalKey(
    Schema.declare<MemoryMetadata['obsidianEvidence'] & {}>(validMemoryObsidianEvidence),
  ),
  obsidianEvidenceError: Schema.optionalKey(Schema.Boolean),
  sourceEvidence: Schema.optionalKey(
    Schema.declare<NonNullable<MemoryMetadata['sourceEvidence']>>(validSourceEvidenceCitation),
  ),
  sourceEvidenceError: Schema.optionalKey(Schema.Boolean),
  reviewedSupport: Schema.optionalKey(ReviewedMemorySupportSchema),
  reviewedSupportError: Schema.optionalKey(Schema.String),
  topicMaintenance: Schema.optionalKey(TopicMaintenanceManifestSchema),
  topicMaintenanceError: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(['durable', 'handoff', 'incident', 'preference', 'smoke']),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  lastReviewed: Schema.optionalKey(Schema.String),
  memoryId: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  reviewAfter: Schema.optionalKey(Schema.String),
  references: Schema.optionalKey(Schema.Array(Schema.String)),
  relations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literals(['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes']),
        uri: Schema.String,
      }),
    ),
  ),
  schemaVersion: Schema.optionalKey(Schema.Finite),
  sourceHash: Schema.optionalKey(Schema.String),
  sourceAgentClient: Schema.String,
  sourceCommit: Schema.optionalKey(Schema.String),
  sourceObservedAt: Schema.optionalKey(Schema.String),
  sourceSessionId: Schema.optionalKey(Schema.String),
  status: Schema.Literals(['active', 'archived', 'expired', 'superseded']),
  supersedes: Schema.optionalKey(Schema.String),
  timestamp: Schema.String,
  topic: Schema.optionalKey(Schema.String),
  trust: Schema.optionalKey(Schema.Literals(['approved', 'inferred', 'untrusted'])),
  updatedAt: Schema.optionalKey(Schema.String),
  validFrom: Schema.optionalKey(Schema.String),
  validTo: Schema.optionalKey(Schema.String),
  visibility: Schema.optionalKey(Schema.Literals(['external', 'personal', 'shared'])),
  workspaceScope: Schema.optionalKey(Schema.String),
});
const InventoryEntrySchema = Schema.Struct({
  uri: Schema.String,
  path: Schema.String,
  signature: Schema.String,
  hash: Schema.String,
  canonicalContentHash: Schema.optionalKey(Schema.String),
  bodyHash: Schema.String,
  headerTitle: Schema.Literals(['MEMORY', 'HANDOFF']),
  metadata: MemoryMetadataSchema,
});
const DirectoryPageSchema = Schema.Struct({
  directory: Schema.String,
  names: Schema.optionalKey(Schema.Array(Schema.String)),
  offset: Schema.Int,
});
const InventorySchema = Schema.Struct({
  version: Schema.Literals([1, 2]),
  mutationGeneration: Schema.String,
  entries: Schema.Record(Schema.String, InventoryEntrySchema),
  queue: Schema.Array(DirectoryPageSchema),
  complete: Schema.Boolean,
  root: Schema.String,
  incompleteReason: Schema.optionalKey(
    Schema.Literals([
      'inventory-records-omitted',
      'inventory-discovery-incomplete',
      'inventory-terminal-catalog-boundary',
      'inventory-terminal-byte-boundary',
      'inventory-terminal-time-boundary',
      'inventory-terminal-lock-contended',
      'inventory-terminal-generation-race',
      'inventory-terminal-membership-race',
    ]),
  ),
  diagnostics: Schema.optionalKey(Schema.Record(Schema.String, ContextMaintenanceSnapshotDiagnosticV1)),
  refreshCursor: Schema.optionalKey(Schema.Int),
});

function decodeInventory(raw: string, root: string, user: string, path: Path.Path): Inventory | undefined {
  const decoded: unknown = JSON.parse(raw);
  if (!Schema.is(InventorySchema)(decoded)) return undefined;
  const value = decoded;
  if (
    ![1, 2].includes(value.version ?? 0) ||
    value.root !== root ||
    typeof value.mutationGeneration !== 'string' ||
    typeof value.complete !== 'boolean' ||
    (value.version === 1 && (!Number.isSafeInteger(value.refreshCursor) || value.refreshCursor! < 0)) ||
    value.entries === null ||
    typeof value.entries !== 'object' ||
    !EffectArray.isArray(value.queue) ||
    (value.version === 1 && !value.complete && value.queue.length === 0)
  )
    return undefined;
  const contained = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' &&
    (candidate === root ||
      Effect2.pipe(candidate, EffectString.startsWith(`${root}/`)) ||
      Effect2.pipe(candidate, EffectString.startsWith(`${root}\\`)));
  const isDirectoryPage = (page: unknown): page is DirectoryPage => {
    if (page === null || typeof page !== 'object' || !('directory' in page) || !('offset' in page)) return false;
    const offset = page.offset;
    const names = 'names' in page ? page.names : undefined;
    return (
      contained(page.directory) &&
      typeof offset === 'number' &&
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      (names === undefined ||
        (EffectArray.isArray(names) &&
          names.length <= 10_000 &&
          offset <= names.length &&
          EffectArray.every(names, (name: unknown) => typeof name === 'string' && !/[/\0]/u.test(name))))
    );
  };
  const queue = EffectArray.filter(value.queue, isDirectoryPage);
  if (queue.length !== value.queue.length) return undefined;
  if (
    !EffectArray.every(
      EffectRecord.toEntries(value.entries),
      ([uri, entry]) =>
        entry !== null &&
        typeof entry === 'object' &&
        entry.uri === uri &&
        Effect2.pipe(uri, EffectString.startsWith(`threadnote://user/${uriSegment(user)}/memories/`)) &&
        contained(entry.path) &&
        uri === inventoryMemoryUri(path, root, user, entry.path) &&
        typeof entry.signature === 'string' &&
        /^[a-f0-9]{64}$/u.test(entry.hash) &&
        (entry.canonicalContentHash === undefined ||
          (typeof entry.canonicalContentHash === 'string' && /^[a-f0-9]{64}$/u.test(entry.canonicalContentHash))) &&
        /^[a-f0-9]{64}$/u.test(entry.bodyHash) &&
        typeof entry.headerTitle === 'string' &&
        entry.metadata !== null &&
        typeof entry.metadata === 'object' &&
        ['durable', 'handoff', 'incident', 'preference', 'smoke'].includes(entry.metadata.kind) &&
        ['active', 'archived', 'expired', 'superseded'].includes(entry.metadata.status) &&
        typeof entry.metadata.timestamp === 'string',
    )
  )
    return undefined;
  if (
    value.diagnostics !== undefined &&
    (value.diagnostics === null ||
      typeof value.diagnostics !== 'object' ||
      EffectArray.isArray(value.diagnostics) ||
      EffectArray.some(
        EffectRecord.toEntries(value.diagnostics),
        ([uri, diagnostic]) =>
          !Effect2.pipe(uri, EffectString.startsWith(`threadnote://user/${uriSegment(user)}/memories/`)) ||
          parseResourceId(uri).canonicalUri !== uri ||
          diagnostic?.memoryUri !== uri ||
          ![
            'invalid-header',
            'invalid-utf8',
            'permission-denied',
            'record-size-limit',
            'record-changed',
            'io-error',
          ].includes(diagnostic.category),
      ))
  )
    return undefined;
  const diagnostics = EffectRecord.fromEntries(
    EffectArray.map(EffectRecord.toEntries(value.diagnostics ?? {}), ([uri, diagnostic]) => [
      uri,
      maintenanceSnapshotFailure(diagnostic.category, 'record-read', uri).diagnostic,
    ]),
  );
  // V1 completeness is only a discovery hint; every completed view receives a fresh terminal proof below.
  return {...value, version: 2, queue, diagnostics};
}

const signature = (info: FileSystem.File.Info) => `${Number(info.size)}:${JSON.stringify(info.mtime)}`;
const statIfPresent = (fs: FileSystem.FileSystem, candidate: string) =>
  fs.stat(candidate).pipe(
    Effect.asSome,
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeedNone,
    ),
  );
function inProject(path: Path.Path, root: string, candidate: string, project: string | undefined) {
  const segments = Effect2.pipe(path.relative(root, candidate), EffectString.split(path.sep));
  const projectAt = segments.indexOf('projects');
  return (
    project === undefined ||
    projectAt < 0 ||
    segments[projectAt + 1] === undefined ||
    segments[projectAt + 1] === uriSegment(project)
  );
}
const checkAuthority = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  canonicalRoot: string,
  candidate: string,
  memoryUri?: string,
) =>
  Effect.gen(function* () {
    const canonical = yield* fs.realPath(candidate);
    if (canonical !== canonicalRoot && !Effect2.pipe(canonical, EffectString.startsWith(`${canonicalRoot}${path.sep}`)))
      return yield* maintenanceSnapshotFailure('authority-boundary', 'authority-check', memoryUri);
  }).pipe(withMaintenanceSnapshotDiagnostic('authority-check', memoryUri));

const persistInventory = Effect.fn('contextMaintenance.persistInventory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  inventory: Inventory,
) {
  const encoded = new TextEncoder().encode(JSON.stringify(inventory));
  if (encoded.length > contextMaintenanceInventoryAuthorityLimits.canonicalBytes)
    return yield* maintenanceSnapshotFailure('cache-size-limit', 'inventory-cache');
  yield* fs
    .makeDirectory(path.dirname(file), {recursive: true})
    .pipe(withMaintenanceSnapshotDiagnostic('inventory-cache'));
  const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4()}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
      yield* handle.writeAll(encoded);
      yield* handle.sync;
    }),
  ).pipe(
    Effect.andThen(fs.rename(temporary, file)),
    Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
    withMaintenanceSnapshotDiagnostic('inventory-cache'),
  );
});

/** Read a stable, regular, authority-contained handle with a hard allocation/read boundary. */
const readEntry = Effect.fn('contextMaintenance.inventoryReadEntry')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  canonicalRoot: string,
  candidate: string,
  uri: string,
  project: string | undefined,
  expectedInfo?: FileSystem.File.Info,
  maxBytes: number = contextMaintenanceInventoryAuthorityLimits.recordBytes,
) {
  yield* checkAuthority(fs, path, canonicalRoot, candidate, uri);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const before = expectedInfo ?? (yield* fs.stat(candidate));
      if (before.type !== 'File') return yield* maintenanceSnapshotFailure('record-not-regular', 'record-read', uri);
      if (Number(before.size) > maxBytes)
        return yield* maintenanceSnapshotFailure('record-size-limit', 'record-read', uri);
      const handle = yield* fs.open(candidate, {flag: 'r'});
      const opened = yield* handle.stat;
      yield* checkAuthority(fs, path, canonicalRoot, candidate, uri);
      if (
        opened.type !== 'File' ||
        opened.dev !== before.dev ||
        !Equal.equals(opened.ino, before.ino) ||
        signature(opened) !== signature(before)
      )
        return yield* maintenanceSnapshotFailure('record-changed', 'record-read', uri);
      if (Number(opened.size) > maxBytes)
        return yield* maintenanceSnapshotFailure('record-size-limit', 'record-read', uri);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        if (bytes === maxBytes) {
          const end = yield* handle.stat;
          if (Number(end.size) !== bytes)
            return yield* maintenanceSnapshotFailure('record-size-limit', 'record-read', uri);
          break;
        }
        const chunk = yield* handle.readAlloc(Math.min(64 * 1024, Number(opened.size) - bytes + 1, maxBytes - bytes));
        if (Option.isNone(chunk)) break;
        bytes += chunk.value.length;
        if (bytes > maxBytes) return yield* maintenanceSnapshotFailure('record-size-limit', 'record-read', uri);
        if (bytes > Number(opened.size)) return yield* maintenanceSnapshotFailure('record-changed', 'record-read', uri);
        chunks.push(chunk.value);
      }
      const after = yield* handle.stat;
      const current = yield* fs.stat(candidate);
      yield* checkAuthority(fs, path, canonicalRoot, candidate, uri);
      if (
        signature(after) !== signature(opened) ||
        bytes !== Number(after.size) ||
        current.dev !== opened.dev ||
        !Equal.equals(current.ino, opened.ino) ||
        signature(current) !== signature(after)
      )
        return yield* maintenanceSnapshotFailure('record-changed', 'record-read', uri);
      const raw = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.length;
      }
      const content = yield* Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true}).decode(raw),
        catch: () => maintenanceSnapshotFailure('invalid-utf8', 'record-read', uri),
      });
      const record = parseMemoryDocument(uri, content);
      if (record === undefined) {
        const firstLine = Effect2.pipe(
          Effect2.pipe(content, EffectString.trim)
            // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
            .split(/\r\n?|\n/u, 1)[0],
          effectOptionalString =>
            effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        );
        if (!isSharedMemoryUri(uri) || firstLine === 'MEMORY' || firstLine === 'HANDOFF')
          return yield* maintenanceSnapshotFailure('invalid-header', 'record-read', uri);
      }
      const entry: InventoryEntry | undefined =
        record !== undefined && (project === undefined || (record.metadata.project ?? 'unscoped') === project)
          ? {
              uri,
              path: candidate,
              signature: signature(after),
              hash: sha256HexSync(raw),
              canonicalContentHash: sha256HexSync(canonicalMemoryDocumentContent(content)),
              bodyHash: sha256HexSync(record.body),
              headerTitle: record.headerTitle,
              metadata: record.metadata,
            }
          : undefined;
      return {entry, bytes, record};
    }),
  ).pipe(withMaintenanceSnapshotDiagnostic('record-read', uri));
});

export const readContextMaintenanceCanonicalRecord = Effect.fn('contextMaintenance.readCanonicalRecord')(function* (
  config: RuntimeConfig,
  uri: string,
  options: {readonly maxBytes?: number} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!Effect2.pipe(uri, EffectString.startsWith(prefix)) || isAgentArtifactUri(uri))
    return yield* maintenanceSnapshotFailure('authority-boundary', 'authority-check', uri);
  const resource = yield* Effect.try({
    try: () => parseResourceId(uri),
    catch: () => maintenanceSnapshotFailure('authority-boundary', 'authority-check', uri),
  });
  const relative = resource.segments.slice(2);
  if (!relative.length) return yield* maintenanceSnapshotFailure('authority-boundary', 'authority-check', uri);
  const root = yield* localUserMemoriesRoot(config);
  const canonicalRoot = yield* fs.realPath(root);
  const canonicalHome = yield* fs.realPath(config.agentContextHome);
  if (!Effect2.pipe(canonicalRoot, EffectString.startsWith(`${canonicalHome}${path.sep}`)))
    return yield* maintenanceSnapshotFailure('authority-boundary', 'authority-check', uri);
  const maxBytes = options.maxBytes ?? contextMaintenanceInventoryAuthorityLimits.recordBytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > contextMaintenanceInventoryAuthorityLimits.recordBytes
  )
    return yield* maintenanceSnapshotFailure('record-size-limit', 'record-read', uri);
  const read = yield* readEntry(
    fs,
    path,
    canonicalRoot,
    path.join(root, ...relative),
    uri,
    undefined,
    undefined,
    maxBytes,
  );
  if (!read.record) return yield* maintenanceSnapshotFailure('invalid-header', 'record-read', uri);
  return {record: read.record, hash: read.entry!.hash, bytes: read.bytes};
}, withMaintenanceSnapshotDiagnostic('record-read'));

/** Disposable, paged discovery hints only. No traversal, writes or approval authority. */
export const readContextMaintenanceInventoryPage = Effect.fn('contextMaintenance.readInventoryPage')(function* (
  config: RuntimeConfig,
  project: string,
  options: {readonly afterUri?: string; readonly limit?: number} = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const generation = yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  let remainingBytes: number = contextMaintenanceInventoryAuthorityLimits.canonicalBytes;
  let bounded = false;
  const inventories: Inventory[] = [];
  for (const scope of [project, undefined]) {
    if (EffectArray.some(inventories, inventory => inventory.complete && inventory.mutationGeneration === generation))
      break;
    const file = path.join(
      config.agentContextHome,
      'context-maintenance',
      'inventory',
      `${sha256HexSync(scope ?? '*')}.json`,
    );
    const loaded = yield* Effect.scoped(
      Effect.gen(function* () {
        const info = yield* fs.stat(file);
        if (info.type !== 'File' || Number(info.size) > remainingBytes) {
          bounded = true;
          return undefined;
        }
        const handle = yield* fs.open(file, {flag: 'r'});
        const opened = yield* handle.stat;
        if (opened.type !== 'File' || Number(opened.size) > remainingBytes) {
          bounded = true;
          return undefined;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (size < Number(opened.size)) {
          const chunk = yield* handle.readAlloc(Math.min(64 * 1024, Number(opened.size) - size, remainingBytes));
          if (Option.isNone(chunk) || chunk.value.length === 0) return undefined;
          remainingBytes -= chunk.value.length;
          size += chunk.value.length;
          chunks.push(chunk.value);
        }
        if (signature(yield* handle.stat) !== signature(opened)) return undefined;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return yield* Effect.try(() =>
          decodeInventory(new TextDecoder('utf-8', {fatal: true}).decode(bytes), root, config.user, path),
        );
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (loaded) inventories.push(loaded);
  }
  const entries = new Map<string, InventoryEntry>();
  for (const inventory of inventories)
    for (const entry of EffectRecord.values(inventory.entries)) {
      if (inventory.mutationGeneration === generation || !entries.has(entry.uri)) entries.set(entry.uri, entry);
    }
  const eligible = EffectArray.filter([...entries.values()], entry =>
    Boolean(
      (entry.metadata.project ?? 'unscoped') === project &&
      entry.metadata.status === 'active' &&
      !isAgentArtifactUri(entry.uri) &&
      (!entry.metadata.topicMaintenance || entry.metadata.reviewedSupport),
    ),
  ).sort((left, right) => Effect2.pipe(left.uri, EffectString.localeCompare(right.uri)));
  const limit = Math.max(1, Math.min(128, Number.isSafeInteger(options.limit) ? options.limit! : 32));
  const remaining = EffectArray.filter(
    eligible,
    entry =>
      options.afterUri === undefined || Effect2.pipe(entry.uri, EffectString.localeCompare(options.afterUri)) > 0,
  );
  const page = remaining.slice(0, limit);
  return {
    uris: EffectArray.map(page, entry => entry.uri),
    total: eligible.length,
    omitted: Math.max(0, eligible.length - page.length),
    ...(remaining.length > page.length ? {nextCursor: page.at(-1)!.uri} : {}),
    incomplete:
      bounded ||
      !EffectArray.some(inventories, inventory => inventory.complete && inventory.mutationGeneration === generation),
  };
});

const isolatedReadEntry = (...args: Parameters<typeof readEntry>) =>
  readEntry(...args).pipe(
    Effect.catchIf(
      error => error.diagnostic.category !== 'authority-boundary' && error.diagnostic.category !== 'record-not-regular',
      error => Effect.succeed({entry: undefined, bytes: 0, record: undefined, diagnostic: error.diagnostic}),
    ),
  );

const freshAuthority = Effect.fn('contextMaintenance.inventoryFreshAuthority')(function* (
  config: RuntimeConfig,
  root: string,
  project: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const started = yield* Clock.currentTimeMillis;
  const proof = yield* withExclusiveFileLock(
    fs,
    resourceAccountMutationLockPath(path, config.agentContextHome, config.account),
    {
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 30_000,
      waitTimeoutMilliseconds: contextMaintenanceInventoryAuthorityLimits.elapsedMilliseconds,
    },
    Effect.gen(function* () {
      const mutationGeneration = yield* readCanonicalMutationGeneration(
        fs,
        path,
        config.agentContextHome,
        config.account,
      );
      const entries: Record<string, InventoryEntry> = {};
      const diagnostics: Record<string, ContextMaintenanceSnapshotDiagnosticV1> = {};
      let catalogNames = 0,
        canonicalBytes = 0;
      const incomplete = (incompleteReason: InventoryIncompleteReason) => ({
        complete: false as const,
        incompleteReason,
        catalogNames,
        canonicalBytes,
      });
      const rootInfo = yield* statIfPresent(fs, root);
      if (Option.isSome(rootInfo) && rootInfo.value.type !== 'Directory')
        return yield* maintenanceSnapshotFailure('record-not-regular', 'discovery');
      if (Option.isSome(rootInfo)) {
        const canonicalRoot = yield* fs.realPath(root);
        const canonicalHome = yield* fs.realPath(config.agentContextHome);
        if (!Effect2.pipe(canonicalRoot, EffectString.startsWith(`${canonicalHome}${path.sep}`)))
          return yield* maintenanceSnapshotFailure('authority-boundary', 'authority-check');
        const directories = [root];
        while (directories.length > 0) {
          const directory = directories.shift()!;
          yield* checkAuthority(fs, path, canonicalRoot, directory);
          const names = EffectArray.filter(
            (yield* fs.readDirectory(directory)).sort(),
            name => !Effect2.pipe(name, EffectString.startsWith('.')),
          );
          if (names.length > contextMaintenanceInventoryAuthorityLimits.catalogNames)
            return incomplete('inventory-terminal-catalog-boundary');
          catalogNames += names.length;
          if (catalogNames > contextMaintenanceInventoryAuthorityLimits.catalogNames)
            return incomplete('inventory-terminal-catalog-boundary');
          const item = (
            directory?: string,
            entry?: InventoryEntry,
            incompleteReason?: InventoryIncompleteReason,
            diagnostic?: ContextMaintenanceSnapshotDiagnosticV1,
          ) => ({
            directory,
            entry,
            incompleteReason,
            diagnostic,
          });
          const children = yield* Effect.forEach(
            names,
            name =>
              Effect.gen(function* () {
                const candidate = path.join(directory, name);
                if (!inProject(path, root, candidate, project)) return item();
                const uri = yield* Effect.try({
                  try: () => inventoryMemoryUri(path, root, config.user, candidate),
                  catch: () => maintenanceSnapshotFailure('authority-boundary', 'authority-check'),
                });
                const info = yield* statIfPresent(fs, candidate).pipe(
                  withMaintenanceSnapshotDiagnostic('discovery', uri),
                );
                if (Option.isNone(info)) return item(undefined, undefined, 'inventory-terminal-membership-race');
                yield* checkAuthority(fs, path, canonicalRoot, candidate, uri);
                if (isAgentArtifactUri(uri)) return item();
                if (info.value.type === 'Directory') return item(candidate);
                if (Effect2.pipe(name, EffectString.endsWith('.md'))) {
                  if (info.value.type !== 'File')
                    return yield* maintenanceSnapshotFailure('record-not-regular', 'record-read', uri);
                  if (Number(info.value.size) > contextMaintenanceInventoryAuthorityLimits.recordBytes)
                    return item(
                      undefined,
                      undefined,
                      undefined,
                      maintenanceSnapshotFailure('record-size-limit', 'record-read', uri).diagnostic,
                    );
                  if (
                    canonicalBytes + Number(info.value.size) >
                    contextMaintenanceInventoryAuthorityLimits.canonicalBytes
                  )
                    return item(undefined, undefined, 'inventory-terminal-byte-boundary');
                  // Reserve bytes before the first read yield; concurrent handles cannot
                  // jointly exceed the terminal bound. readEntry proves the reserved identity/size.
                  canonicalBytes += Number(info.value.size);
                  const read = yield* isolatedReadEntry(fs, path, canonicalRoot, candidate, uri, project, info.value);
                  return item(undefined, read.entry, undefined, 'diagnostic' in read ? read.diagnostic : undefined);
                }
                return item();
              }),
            {concurrency: contextMaintenanceInventoryAuthorityLimits.readConcurrency},
          );
          for (const child of children) {
            if (child.incompleteReason !== undefined) return incomplete(child.incompleteReason);
            if (child.diagnostic?.memoryUri) diagnostics[child.diagnostic.memoryUri] = child.diagnostic;
            if (child.directory !== undefined) directories.push(child.directory);
            if (child.entry !== undefined) entries[child.entry.uri] = child.entry;
          }
        }
      }
      if (
        mutationGeneration !==
        (yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account))
      )
        return incomplete('inventory-terminal-generation-race');
      return {complete: true as const, entries, diagnostics, mutationGeneration, catalogNames, canonicalBytes};
    }),
  ).pipe(
    Effect.catchIf(isFileLockTimeout, () =>
      Effect.succeed({
        complete: false as const,
        incompleteReason: 'inventory-terminal-lock-contended' as const,
        catalogNames: 0,
        canonicalBytes: 0,
      }),
    ),
    Effect.timeoutOption(contextMaintenanceInventoryAuthorityLimits.elapsedMilliseconds),
  );
  return {
    ...Option.getOrElse(proof, () => ({
      complete: false as const,
      incompleteReason: 'inventory-terminal-time-boundary' as const,
      catalogNames: 0,
      canonicalBytes: 0,
    })),
    elapsedMilliseconds: (yield* Clock.currentTimeMillis) - started,
  };
});

/** Preparation is restartable and bounds file reads independently of the home corpus size. */
export const prepareContextMaintenanceInventory = Effect.fn('contextMaintenance.prepareInventory')(function* (
  config: RuntimeConfig,
  project: string | undefined,
  budget: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* localUserMemoriesRoot(config);
  const file = path.join(
    config.agentContextHome,
    'context-maintenance',
    'inventory',
    `${sha256HexSync(project ?? '*')}.json`,
  );
  const generation = yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  const cacheStat = yield* fs.stat(file).pipe(Effect.option);
  if (cacheStat._tag === 'Some' && Number(cacheStat.value.size) > 32 * 1024 * 1024)
    return yield* maintenanceSnapshotFailure('cache-size-limit', 'inventory-cache');
  const prior = yield* fs.readFileString(file).pipe(
    Effect.flatMap(raw => Effect.try(() => decodeInventory(raw, root, config.user, path))),
    Effect.orElseSucceed(() => undefined),
  );
  // Account writes invalidate authority, never the fair discovery cursor. The terminal
  // snapshot reconciles every selected byte and deletion under the native mutation lock.
  let entries: Record<string, InventoryEntry> = EffectRecord.fromEntries(
    EffectArray.filter(EffectRecord.toEntries(prior?.entries ?? {}), ([uri]) => !isAgentArtifactUri(uri)),
  );
  const diagnostics: Record<string, ContextMaintenanceSnapshotDiagnosticV1> = {...prior?.diagnostics};
  const queue: DirectoryPage[] =
    prior === undefined || (!prior.complete && prior.queue.length === 0)
      ? [{directory: root, offset: 0}]
      : prior.complete
        ? []
        : EffectArray.filter(
            prior.queue,
            page =>
              !isAgentArtifactPath(Effect2.pipe(path.relative(root, page.directory), EffectString.split(path.sep))),
          );
  let incompleteReason: InventoryIncompleteReason | undefined = 'inventory-discovery-incomplete';
  let admitted = 0;
  while (queue.length > 0 && admitted < budget) {
    const page = queue.shift()!;
    const directoryInfo = yield* statIfPresent(fs, page.directory);
    if (Option.isNone(directoryInfo)) continue;
    if (directoryInfo.value.type !== 'Directory')
      return yield* maintenanceSnapshotFailure('record-changed', 'discovery');
    const canonicalRoot = yield* fs.realPath(root);
    const canonicalHome = yield* fs.realPath(config.agentContextHome);
    if (!Effect2.pipe(canonicalRoot, EffectString.startsWith(`${canonicalHome}${path.sep}`)))
      return yield* maintenanceSnapshotFailure('authority-boundary', 'authority-check');
    yield* checkAuthority(fs, path, canonicalRoot, page.directory);
    const names =
      page.names ??
      (yield* fs.readDirectory(page.directory).pipe(
        Effect.catchIf(
          error => error.reason._tag === 'NotFound',
          () => Effect.succeed([]),
        ),
      )).sort();
    let offset = page.offset;
    while (offset < names.length && admitted < budget) {
      const name = names[offset++];
      if (Effect2.pipe(name, EffectString.startsWith('.'))) continue;
      admitted++;
      const candidate = path.join(page.directory, name);
      const uri = yield* Effect.try({
        try: () => inventoryMemoryUri(path, root, config.user, candidate),
        catch: () => maintenanceSnapshotFailure('authority-boundary', 'authority-check'),
      });
      const info = yield* statIfPresent(fs, candidate).pipe(withMaintenanceSnapshotDiagnostic('discovery', uri));
      if (info._tag === 'None') continue;
      if (!inProject(path, root, candidate, project)) continue;
      if (isAgentArtifactUri(uri)) {
        yield* checkAuthority(fs, path, canonicalRoot, candidate, uri);
        continue;
      }
      if (info.value.type === 'Directory') {
        yield* checkAuthority(fs, path, canonicalRoot, candidate, uri);
        queue.push({directory: candidate, offset: 0});
      } else if (info.value.type === 'File' && Effect2.pipe(name, EffectString.endsWith('.md'))) {
        yield* checkAuthority(fs, path, canonicalRoot, candidate, uri);
        if (entries[uri]?.signature === signature(info.value) && entries[uri]?.canonicalContentHash !== undefined)
          continue;
        const read = yield* isolatedReadEntry(fs, path, canonicalRoot, candidate, uri, project, info.value);
        if ('diagnostic' in read) diagnostics[uri] = read.diagnostic;
        else delete diagnostics[uri];
        if (read.entry === undefined) delete entries[uri];
        else entries[uri] = read.entry;
      }
    }
    if (offset < names.length)
      queue.unshift({
        directory: page.directory,
        ...(names.length <= contextMaintenanceInventoryAuthorityLimits.catalogNames ? {names} : {}),
        offset,
      });
  }
  let complete = false;
  let authorityGeneration = generation;
  let reconciliation: {catalogNames: number; canonicalBytes: number; elapsedMilliseconds: number} | undefined;
  if (queue.length === 0) {
    const authority = yield* freshAuthority(config, root, project);
    reconciliation = {
      catalogNames: authority.catalogNames,
      canonicalBytes: authority.canonicalBytes,
      elapsedMilliseconds: authority.elapsedMilliseconds,
    };
    if (authority.complete) {
      entries = authority.entries;
      authorityGeneration = authority.mutationGeneration;
      for (const key of EffectRecord.keys(diagnostics)) delete diagnostics[key];
      Object.assign(diagnostics, authority.diagnostics);
      complete = EffectRecord.keys(diagnostics).length === 0;
      incompleteReason = complete ? undefined : 'inventory-records-omitted';
    } else {
      incompleteReason = authority.incompleteReason;
    }
  }
  if (
    complete &&
    authorityGeneration !== (yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account))
  ) {
    complete = false;
    incompleteReason = 'inventory-terminal-generation-race';
  }
  let inventory: Inventory = {
    version: 2,
    mutationGeneration: authorityGeneration,
    entries,
    queue,
    complete,
    ...(incompleteReason === undefined ? {} : {incompleteReason}),
    root,
    diagnostics,
  };
  yield* persistInventory(fs, path, file, inventory);
  if (
    inventory.complete &&
    inventory.mutationGeneration !==
      (yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account))
  ) {
    incompleteReason = 'inventory-terminal-generation-race';
    inventory = {...inventory, complete: false, incompleteReason};
    yield* persistInventory(fs, path, file, inventory);
  }
  const ordered = EffectRecord.values(entries).sort((left, right) =>
    Effect2.pipe(left.uri, EffectString.localeCompare(right.uri)),
  );
  return {
    complete: inventory.complete,
    incompleteReason,
    reconciliation,
    diagnostics: EffectRecord.values(diagnostics),
    generation: sha256HexSync(
      EffectArray.join(
        EffectArray.map(ordered, entry => `${entry.uri}:${entry.hash}`),
        '|',
      ),
    ),
    hashes: new Map(EffectArray.map(ordered, entry => [entry.uri, entry.hash])),
    canonicalContentHashes: new Map(
      EffectArray.flatMap(ordered, entry =>
        entry.canonicalContentHash === undefined ? [] : [[entry.uri, entry.canonicalContentHash] as const],
      ),
    ),
    bodyHashes: new Map(EffectArray.map(ordered, entry => [entry.uri, entry.bodyHash])),
    records: EffectArray.map(
      ordered,
      entry =>
        ({
          uri: entry.uri,
          headerTitle: entry.headerTitle,
          metadata: entry.metadata,
          body: '',
          content: entry.hash,
        }) satisfies MemoryRecord,
    ),
  };
}, withMaintenanceSnapshotDiagnostic('discovery'));
export function pruneAbsentMaintenanceCheckpoints<T>(
  checkpoints: Record<string, T>,
  activeKeys: ReadonlySet<string>,
  scope: {readonly project?: string; readonly complete: boolean},
): void {
  if (scope.project !== undefined || !scope.complete) return;
  for (const key of EffectRecord.keys(checkpoints)) if (!activeKeys.has(key)) delete checkpoints[key];
}
