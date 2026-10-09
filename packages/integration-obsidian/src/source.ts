import {inspectObsidianFile, scanObsidianDirectoryPage} from './scan.js';
import {SourceCoordinator, type SourceWorkOptions} from '@threadnote/integration-core/source-coordinator';
import {Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Clock, Console, Crypto, DateTime, Effect, FileSystem, Path, Result, Schema} from 'effect';
const MAX_SECRET_MATCHES_TO_PRINT = 5;
import {sha256Hex} from '@threadnote/platform/digest';
import {fromPromise} from '@threadnote/platform/errors';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {ResourceStore, type ResourceStoreMutation} from '@threadnote/store/resource-store';
import {scanFilesWithinBoundary} from '@threadnote/platform/safe_scan';
import {
  DEFAULT_OBSIDIAN_EXCLUDES,
  type ObsidianSourceConfig,
  type SourceConfig,
  isObsidianSource,
  isObsidianProjection,
  mutateSourceConfiguration,
  readObsidianConfiguration,
  removeObsidianSource,
  requireObsidianSource,
  upsertObsidianSource,
  validateObsidianIdentifier,
} from './config.js';
import {withSourceLock} from '@threadnote/integration-core/lock';
import {applyScrubber} from '@threadnote/platform/scrubber';
import {canonicalResourceUri} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {globToRegExp} from '@threadnote/platform/glob';
import {isDirectory, toPosixPath} from '@threadnote/integration-core/utils';
import {validMemoryObsidianEvidence, type MemoryObsidianEvidenceV1} from '@threadnote/memory/document';

export interface ObsidianSourceAddOptions {
  readonly apply?: boolean;
  readonly exclude?: readonly string[];
  readonly id: string;
  readonly inbox?: string;
  readonly include: readonly string[];
  readonly vault: string;
}

export interface ObsidianSourceCommandOptions {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly id: string;
}

export type ObsidianInventoryAction = 'add' | 'remove' | 'skip' | 'unchanged' | 'update';

export interface ObsidianInventoryEntry {
  readonly action: ObsidianInventoryAction;
  readonly detail?: string;
  readonly relativePath: string;
  readonly uri?: string;
}

export interface ObsidianInventory {
  readonly entries: readonly ObsidianInventoryEntry[];
  readonly source: ObsidianSourceConfig;
  readonly more?: boolean;
}

export interface ObsidianSourceAutoSyncResult {
  readonly syncedSources: readonly string[];
  readonly warnings: readonly string[];
}

interface ObsidianSourceFileState {
  readonly contentHash: string;
  readonly fileIdentity?: string;
  readonly modifiedAt?: string;
  readonly noteId?: string;
  readonly sanitizedHash?: string;
  readonly sanitizerVersion?: string;
  readonly size: number;
  readonly uri: string;
}

interface ObsidianScanCheckpoint {
  readonly fingerprint: string;
  readonly directories: readonly string[];
  readonly offset: number;
  readonly seen: readonly string[];
}

interface ObsidianSourceState {
  readonly scan?: ObsidianScanCheckpoint;
  readonly files: Readonly<Record<string, ObsidianSourceFileState>>;
  readonly sourceId: string;
  readonly sourceInstanceId?: string;
  readonly syncedAt?: string;
  readonly version: 1 | 2;
}

interface ScannedObsidianNote {
  readonly contentHash: string;
  readonly fileIdentity?: string;
  readonly modifiedAt?: string;
  readonly path: string;
  readonly redactions: readonly string[];
  readonly relativePath: string;
  readonly sanitizedContent: string;
  readonly sanitizedHash: string;
  readonly size: number;
  readonly uri: string;
}

interface ObsidianInventoryPlan extends ObsidianInventory {
  readonly safeNotes: readonly ScannedObsidianNote[];
  readonly state: ObsidianSourceState;
  readonly scan?: ObsidianScanCheckpoint;
}

interface ObsidianSourceSyncBehavior {
  readonly quantum?: boolean;
  readonly apply: boolean;
  readonly log: boolean;
  readonly writeUnchangedState: boolean;
}

class ObsidianSourceError extends Schema.TaggedError<ObsidianSourceError>()('ObsidianSourceError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const SOURCE_STATE_VERSION = 2;
const SOURCE_STATE_FILENAME = 'state-v1.json';
export const OBSIDIAN_SANITIZER_VERSION = 'scrubber-redact-v1';
const SOURCE_MAX_NOTE_BYTES = 512 * 1_024;
const SOURCE_LOCK_RETRY_MILLISECONDS = 25;
const SOURCE_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const SOURCE_LOCK_WAIT_MILLISECONDS = 10_000;
const SOURCE_LOCK_OPTIONS = {
  retryIntervalMilliseconds: SOURCE_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: SOURCE_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: SOURCE_LOCK_WAIT_MILLISECONDS,
} as const;
const PRIVATE_FILE_MODE = 0o600;
const MARKDOWN_EXTENSION = '.md';
const EVIDENCE_MAX_PINS = 256;
const EVIDENCE_MAX_BYTES = 64 * 1_024 * 1_024;
const EVIDENCE_MAX_FRAGMENT_BYTES = 8_192;

interface PinnedObsidianEvidence {
  readonly citation: MemoryObsidianEvidenceV1;
  readonly sanitizedContent: string;
}

export interface ObsidianEvidenceRead {
  readonly citation: MemoryObsidianEvidenceV1;
  readonly historical: 'available' | 'expired' | 'revoked' | 'missing' | 'corrupt';
  readonly fragment?: string;
  /** Revision equality is a mechanical signal, not validation of the derived claim. */
  readonly currentRevision: 'same' | 'changed' | 'removed' | 'unknown';
}

export const inspectObsidianNote = Effect.fn('obsidian.inspectNote')(function* (
  config: RuntimeConfig,
  sourceId: string,
  relativePath: string,
) {
  assertSafeSourceRelativePath(relativePath);
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* sourceStatePath(config, sourceId);
  return yield* withSourceLock(
    config,
    sourceId,
    withExclusiveFileLock(
      fs,
      `${statePath}.lock`,
      SOURCE_LOCK_OPTIONS,
      Effect.gen(function* () {
        const source = requireObsidianSource(yield* readObsidianConfiguration(config), sourceId);
        if (!source.enabled || !sourcePathMatches(relativePath, source.include, source.exclude)) {
          return yield* ObsidianSourceError.make({
            message: 'Obsidian note is outside the current source access policy.',
          });
        }
        const state = yield* readSourceState(statePath, sourceId);
        const entry = state.files[relativePath];
        if (
          !state.sourceInstanceId ||
          !entry?.noteId ||
          !entry.fileIdentity ||
          !entry.sanitizedHash ||
          entry.sanitizerVersion !== OBSIDIAN_SANITIZER_VERSION
        ) {
          return yield* ObsidianSourceError.make({message: 'Apply source sync before reviewing this Obsidian note.'});
        }
        const store = yield* ResourceStore;
        const sanitizedContent = yield* store.read(resourceStoreLocation(config), entry.uri);
        const live = (yield* buildObsidianInventory(config, source)).safeNotes.find(
          note => note.relativePath === relativePath,
        );
        if (
          (yield* sha256Hex(sanitizedContent)) !== entry.sanitizedHash ||
          !live ||
          live.fileIdentity !== entry.fileIdentity ||
          live.sanitizedHash !== entry.sanitizedHash
        ) {
          return yield* ObsidianSourceError.make({
            message: 'Live note differs from the synced sanitized revision; apply source sync and review it again.',
          });
        }
        return {
          sourceId,
          sourceInstanceId: state.sourceInstanceId,
          noteId: entry.noteId,
          relativePath,
          revisionHash: entry.sanitizedHash,
          sanitizerVersion: OBSIDIAN_SANITIZER_VERSION,
          sanitizedContent,
        };
      }),
    ),
  );
});

export const captureObsidianEvidence = Effect.fn('obsidian.captureEvidence')(function* (
  config: RuntimeConfig,
  input: {
    readonly sourceId: string;
    readonly relativePath: string;
    readonly fragment: string;
    readonly expectedSourceInstanceId: string;
    readonly expectedNoteId: string;
    readonly expectedRevisionHash: string;
    readonly expectedSanitizerVersion: string;
    readonly retentionDays?: number;
  },
) {
  const source = requireObsidianSource(yield* readObsidianConfiguration(config), input.sourceId);
  if (!source.enabled) return yield* ObsidianSourceError.make({message: 'Obsidian source access is disabled.'});
  assertSafeSourceRelativePath(input.relativePath);
  const retentionDays = input.retentionDays ?? 90;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    return yield* ObsidianSourceError.make({message: 'Obsidian evidence retentionDays must be 1–365.'});
  }
  if (!input.fragment || new TextEncoder().encode(input.fragment).byteLength > EVIDENCE_MAX_FRAGMENT_BYTES) {
    return yield* ObsidianSourceError.make({message: 'Obsidian evidence fragment must be 1–8192 UTF-8 bytes.'});
  }
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* sourceStatePath(config, source.id);
  return yield* withSourceLock(
    config,
    source.id,
    withExclusiveFileLock(
      fs,
      `${statePath}.lock`,
      SOURCE_LOCK_OPTIONS,
      Effect.gen(function* () {
        const currentSource = requireObsidianSource(yield* readObsidianConfiguration(config), source.id);
        if (
          !currentSource.enabled ||
          !sourcePathMatches(input.relativePath, currentSource.include, currentSource.exclude)
        ) {
          return yield* ObsidianSourceError.make({
            message: 'Obsidian note is outside the current source access policy.',
          });
        }
        const state = yield* readSourceState(statePath, source.id);
        const entry = state.files[input.relativePath];
        if (
          !state.sourceInstanceId ||
          !entry?.noteId ||
          !entry.fileIdentity ||
          !entry.sanitizedHash ||
          entry.sanitizerVersion !== OBSIDIAN_SANITIZER_VERSION
        ) {
          return yield* ObsidianSourceError.make({message: 'Apply source sync before citing this Obsidian note.'});
        }
        if (
          input.expectedSourceInstanceId !== state.sourceInstanceId ||
          input.expectedNoteId !== entry.noteId ||
          input.expectedRevisionHash !== entry.sanitizedHash ||
          input.expectedSanitizerVersion !== entry.sanitizerVersion
        ) {
          return yield* ObsidianSourceError.make({
            message: 'Reviewed Obsidian note identity or sanitized revision changed; inspect and review it again.',
          });
        }
        const store = yield* ResourceStore;
        const sanitizedContent = yield* store.read(resourceStoreLocation(config), entry.uri);
        if ((yield* sha256Hex(sanitizedContent)) !== entry.sanitizedHash) {
          return yield* ObsidianSourceError.make({
            message: 'Synced note revision changed during evidence capture; sync again.',
          });
        }
        const live = (yield* buildObsidianInventory(config, currentSource)).safeNotes.find(
          note => note.relativePath === input.relativePath,
        );
        if (!live || live.fileIdentity !== entry.fileIdentity || live.sanitizedHash !== entry.sanitizedHash) {
          return yield* ObsidianSourceError.make({
            message: 'Live note differs from the synced sanitized revision; apply source sync and review it again.',
          });
        }
        const fragmentStart = sanitizedContent.indexOf(input.fragment);
        if (fragmentStart < 0) {
          return yield* ObsidianSourceError.make({
            message: 'Evidence fragment is absent from the exact sanitized imported revision.',
          });
        }
        const crypto = yield* Crypto.Crypto;
        const now = yield* Clock.currentTimeMillis;
        const pinId = yield* crypto.randomUUIDv4;
        const citation: MemoryObsidianEvidenceV1 = {
          version: 1,
          sourceId: source.id,
          sourceInstanceId: state.sourceInstanceId,
          vaultHash: yield* sha256Hex(yield* canonicalDirectory(currentSource.vault, 'Obsidian vault')),
          accessHash: yield* sourceAccessHash(currentSource),
          noteId: entry.noteId,
          relativePath: input.relativePath,
          revisionHash: entry.sanitizedHash,
          sanitizerVersion: OBSIDIAN_SANITIZER_VERSION,
          fragmentHash: yield* sha256Hex(input.fragment),
          fragmentStart,
          fragmentEnd: fragmentStart + input.fragment.length,
          pinId,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + retentionDays * 86_400_000)),
        };
        const dir = yield* evidenceDirectory(config, source.id);
        yield* fs.makeDirectory(dir, {recursive: true});
        const path = yield* Path.Path;
        const names = (yield* fs.readDirectory(dir)).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name));
        let retainedBytes = 0;
        let retainedCount = 0;
        for (const name of names) {
          const candidatePath = path.join(dir, name);
          const raw = yield* fs.readFileString(candidatePath);
          const parsed = parseJsonOrUndefined(raw);
          const candidate = parsed as Partial<PinnedObsidianEvidence> | undefined;
          if (candidate?.citation?.expiresAt && Date.parse(candidate.citation.expiresAt) <= now) {
            yield* fs.remove(candidatePath, {force: true});
          } else {
            retainedBytes += new TextEncoder().encode(raw).byteLength;
            retainedCount += 1;
          }
        }
        const pin: PinnedObsidianEvidence = {citation, sanitizedContent};
        const serialized = `${JSON.stringify(pin)}\n`;
        if (
          retainedCount >= EVIDENCE_MAX_PINS ||
          retainedBytes + new TextEncoder().encode(serialized).byteLength > EVIDENCE_MAX_BYTES
        ) {
          return yield* ObsidianSourceError.make({
            message: 'Obsidian evidence retention capacity reached; existing unexpired pins remain available.',
          });
        }
        const destination = path.join(dir, `${pinId}.json`);
        const temporary = `${destination}.tmp`;
        yield* fs.writeFileString(temporary, serialized, {mode: PRIVATE_FILE_MODE});
        yield* fs
          .rename(temporary, destination)
          .pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
        yield* fs.chmod(destination, PRIVATE_FILE_MODE);
        return citation;
      }),
    ),
  );
});

export const readObsidianEvidence = Effect.fn('obsidian.readEvidence')(function* (
  config: RuntimeConfig,
  citation: MemoryObsidianEvidenceV1,
) {
  const candidate: unknown = citation;
  if (!validMemoryObsidianEvidence(candidate)) {
    return {citation, historical: 'corrupt' as const, currentRevision: 'unknown' as const};
  }
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* sourceStatePath(config, citation.sourceId);
  return yield* withSourceLock(
    config,
    citation.sourceId,
    withExclusiveFileLock(
      fs,
      `${statePath}.lock`,
      SOURCE_LOCK_OPTIONS,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const path = yield* Path.Path;
        const pinPath = path.join(yield* evidenceDirectory(config, citation.sourceId), `${citation.pinId}.json`);
        if (Date.parse(citation.expiresAt) <= now) {
          yield* fs.remove(pinPath, {force: true});
          return {citation, historical: 'expired' as const, currentRevision: 'unknown' as const};
        }
        const configuration = yield* readObsidianConfiguration(config);
        const source = configuration.sources.find(item => item.id === citation.sourceId);
        if (!source || !isObsidianSource(source)) {
          return {citation, historical: 'revoked' as const, currentRevision: 'unknown' as const};
        }
        const vault = yield* Effect.result(canonicalDirectory(source.vault, 'Obsidian vault'));
        if (
          !source.enabled ||
          Result.isFailure(vault) ||
          (yield* sha256Hex(vault.success)) !== citation.vaultHash ||
          (yield* sourceAccessHash(source)) !== citation.accessHash
        ) {
          return {citation, historical: 'revoked' as const, currentRevision: 'unknown' as const};
        }
        const state = yield* readSourceState(statePath, citation.sourceId);
        if (state.sourceInstanceId !== citation.sourceInstanceId) {
          return {citation, historical: 'revoked' as const, currentRevision: 'unknown' as const};
        }
        const recordedPaths = Object.entries(state.files)
          .filter(([, file]) => file.noteId === citation.noteId)
          .map(([relativePath]) => relativePath);
        for (const relativePath of recordedPaths.length > 0 ? recordedPaths : [citation.relativePath]) {
          if (!(yield* sourceEvidenceReadable(vault.success, relativePath))) {
            return {citation, historical: 'revoked' as const, currentRevision: 'unknown' as const};
          }
        }
        if (!(yield* fs.exists(pinPath)))
          return {citation, historical: 'missing' as const, currentRevision: 'unknown' as const};
        const raw = yield* fs.readFileString(pinPath);
        const pin = parseJsonOrUndefined(raw);
        if (
          !pin ||
          typeof pin !== 'object' ||
          !('citation' in pin) ||
          !('sanitizedContent' in pin) ||
          typeof pin.sanitizedContent !== 'string' ||
          JSON.stringify(pin.citation) !== JSON.stringify(citation) ||
          (yield* sha256Hex(pin.sanitizedContent)) !== citation.revisionHash ||
          citation.fragmentEnd > pin.sanitizedContent.length
        ) {
          return {citation, historical: 'corrupt' as const, currentRevision: 'unknown' as const};
        }
        const fragment = pin.sanitizedContent.slice(citation.fragmentStart, citation.fragmentEnd);
        if ((yield* sha256Hex(fragment)) !== citation.fragmentHash) {
          return {citation, historical: 'corrupt' as const, currentRevision: 'unknown' as const};
        }
        const recorded = Object.values(state.files).find(file => file.noteId === citation.noteId);
        const liveInventory = yield* Effect.result(buildObsidianInventory(config, source));
        const live =
          Result.isSuccess(liveInventory) && recorded?.fileIdentity
            ? liveInventory.success.safeNotes.find(note => note.fileIdentity === recorded.fileIdentity)
            : undefined;
        const currentRevision =
          Result.isFailure(liveInventory) || !recorded?.fileIdentity
            ? ('unknown' as const)
            : live === undefined &&
                liveInventory.success.entries.some(
                  entry => entry.action === 'skip' && entry.relativePath === citation.relativePath,
                )
              ? ('unknown' as const)
              : live === undefined
                ? ('removed' as const)
                : live.sanitizedHash === citation.revisionHash &&
                    OBSIDIAN_SANITIZER_VERSION === citation.sanitizerVersion
                  ? ('same' as const)
                  : ('changed' as const);
        return {citation, historical: 'available' as const, currentRevision, fragment};
      }),
    ),
  );
});

const sourceEvidenceReadable = Effect.fn('obsidian.sourceEvidenceReadable')(function* (
  vault: string,
  relativePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const segments = relativePath.split('/');
  const directories = [
    vault,
    ...segments.slice(0, -1).map((_, index) => path.join(vault, ...segments.slice(0, index + 1))),
  ];
  for (const [index, directory] of directories.entries()) {
    const resolved = yield* Effect.result(fs.realPath(directory));
    if (Result.isFailure(resolved)) return index > 0 && resolved.failure.reason._tag === 'NotFound';
    if (resolved.success !== directory) return false;
    const listed = yield* Effect.result(fs.readDirectory(directory));
    if (Result.isFailure(listed)) return index > 0 && listed.failure.reason._tag === 'NotFound';
    const searchable = yield* Effect.result(fs.stat(`${directory}/.`));
    if (Result.isFailure(searchable)) return index > 0 && searchable.failure.reason._tag === 'NotFound';
  }
  const notePath = path.join(vault, ...segments);
  const resolvedNote = yield* Effect.result(fs.realPath(notePath));
  if (Result.isFailure(resolvedNote)) return resolvedNote.failure.reason._tag === 'NotFound';
  if (resolvedNote.success !== notePath) return false;
  const note = yield* Effect.result(fs.stat(notePath));
  if (Result.isFailure(note)) return note.failure.reason._tag === 'NotFound';
  if (note.success.type !== 'File') return false;
  const access = yield* Effect.result(fs.access(notePath, {readable: true}));
  return Result.isSuccess(access) || access.failure.reason._tag === 'NotFound';
});

export const discardObsidianEvidence = Effect.fn('obsidian.discardEvidence')(function* (
  config: RuntimeConfig,
  citation: MemoryObsidianEvidenceV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(path.join(yield* evidenceDirectory(config, citation.sourceId), `${citation.pinId}.json`), {
    force: true,
  });
});

const evidenceDirectory = Effect.fn('obsidian.evidenceDirectory')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome' | 'account'>,
  sourceId: string,
) {
  const path = yield* Path.Path;
  return path.join(yield* sourceStateDirectory(config, sourceId), 'evidence');
});

const sourceAccessHash = Effect.fn('obsidian.sourceAccessHash')(function* (source: ObsidianSourceConfig) {
  return yield* sha256Hex(
    JSON.stringify({vault: source.vault, include: source.include, exclude: source.exclude, inbox: source.inbox}),
  );
});

export const runObsidianSourceAdd = Effect.fn('obsidian.sourceAdd')(function* (
  config: RuntimeConfig,
  options: ObsidianSourceAddOptions,
) {
  if (options.include.length === 0) {
    return yield* ObsidianSourceError.make({
      message: 'Obsidian sources require at least one --include allowlist pattern.',
    });
  }
  const id = validateObsidianIdentifier(options.id, 'source id');
  const vault = yield* canonicalDirectory(options.vault, 'Obsidian vault');
  const inbox = options.inbox ? normalizeRelativePath(options.inbox, 'Inbox folder') : undefined;
  const current = yield* readObsidianConfiguration(config);
  const makeSource = (configuration: typeof current): ObsidianSourceConfig => {
    const existing = configuration.sources.some(source => source.id === id)
      ? requireObsidianSource(configuration, id)
      : undefined;
    return {
      enabled: existing?.enabled ?? true,
      exclude: safePatterns(
        [
          ...DEFAULT_OBSIDIAN_EXCLUDES,
          ...(options.exclude ?? []),
          ...(inbox ? [`${inbox}/**`] : []),
          ...configuration.projections
            .filter(isObsidianProjection)
            .filter(projection => projection.vault === vault)
            .map(projection => `${projection.folder}/**`),
        ],
        'Source exclude',
      ),
      id,
      inbox,
      include: safePatterns(options.include, 'Source include'),
      type: 'obsidian',
      vault,
      watch: existing?.watch ?? false,
    };
  };
  const source = makeSource(current);
  if (options.apply !== true) {
    yield* Console.log(`Would configure Obsidian source "${id}":`);
    yield* Console.log(sourceSummary(source));
    yield* Console.log('Re-run with --apply to write the configuration.');
    return;
  }
  const path = yield* withSourceLock(
    config,
    id,
    mutateSourceConfiguration(config, latest => upsertObsidianSource(latest, makeSource(latest))),
  );
  yield* Console.log(`Configured Obsidian source "${id}" in ${path}.`);
});

export const runObsidianSourceList = Effect.fn('obsidian.sourceList')(function* (config: RuntimeConfig) {
  const configuration = yield* readObsidianConfiguration(config);
  const allSources: readonly SourceConfig[] = configuration.sources;
  const sources = allSources.filter(isObsidianSource);
  if (sources.length === 0) {
    yield* Console.log('No Obsidian sources configured.');
    return;
  }
  for (const source of sources) {
    yield* Console.log(sourceSummary(source));
  }
});

export const runObsidianSourceInventory = Effect.fn('obsidian.sourceInventory')(function* (
  config: RuntimeConfig,
  id: string,
) {
  const source = requireObsidianSource(yield* readObsidianConfiguration(config), id);
  const plan = yield* buildObsidianInventory(config, source);
  yield* printInventory(plan);
  return {
    entries: plan.entries,
    source: plan.source,
    ...(plan.scan === undefined ? {} : {more: true}),
  } satisfies ObsidianInventory;
});

export const runObsidianSourceStatus = Effect.fn('obsidian.sourceStatus')(function* (
  config: RuntimeConfig,
  id: string,
) {
  const source = requireObsidianSource(yield* readObsidianConfiguration(config), id);
  const plan = yield* buildObsidianInventory(config, source);
  const counts = inventoryCounts(plan.entries);
  yield* Console.log(sourceSummary(source));
  yield* Console.log(
    `State: ${counts.unchanged} current, ${counts.add} add, ${counts.update} update, ${counts.remove} remove, ${counts.skip} skipped.`,
  );
});

export const runObsidianSourceSync = Effect.fn('obsidian.sourceSync')(function* (
  config: RuntimeConfig,
  options: ObsidianSourceCommandOptions,
) {
  const apply = options.apply === true && options.dryRun !== true;
  const source = requireObsidianSource(yield* readObsidianConfiguration(config), options.id);
  if (!source.enabled) {
    return yield* ObsidianSourceError.make({message: `Obsidian source "${source.id}" is disabled.`});
  }
  const coordinator = yield* Effect.serviceOption(SourceCoordinator);
  if (apply && Option.isSome(coordinator)) {
    const result = yield* coordinator.value.sync(config, source.id);
    if (result.value === undefined)
      return yield* ObsidianSourceError.make({message: 'Source sync reply expired. Retry the source sync.'});
    const inventory = result.value as ObsidianInventory;
    yield* printInventory(inventory);
    const counts = inventoryCounts(inventory.entries);
    yield* Console.log(
      `Obsidian source sync ${inventory.more ? 'progress' : 'complete'}: ${counts.add} added, ${counts.update} updated, ${counts.remove} removed, ${counts.unchanged} unchanged, ${counts.skip} skipped.`,
    );
    if (inventory.more) yield* Console.log('Import continues in the background.');
    return inventory;
  }
  return yield* syncObsidianSource(config, source, {
    apply,
    log: true,
    writeUnchangedState: true,
  });
});

export const syncObsidianSourcesBeforeRecall = Effect.fn('obsidian.syncBeforeRecall')(function* (
  config: RuntimeConfig,
) {
  const configuration = yield* readObsidianConfiguration(config);
  const allSources: readonly SourceConfig[] = configuration.sources;
  const syncedSources: string[] = [];
  const warnings: string[] = [];
  for (const source of allSources.filter(isObsidianSource).filter(candidate => candidate.enabled)) {
    const result = yield* Effect.result(
      syncObsidianSource(config, source, {
        apply: true,
        log: false,
        writeUnchangedState: false,
      }),
    );
    if (Result.isFailure(result)) {
      warnings.push(
        `Auto-sync for Obsidian source "${source.id}" failed: ${
          result.failure instanceof Error ? result.failure.message : String(result.failure)
        }`,
      );
      continue;
    }
    if (result.success.entries.some(entry => isSourceMutation(entry.action))) {
      syncedSources.push(source.id);
    }
    const skipped = result.success.entries.filter(entry => entry.action === 'skip').length;
    if (skipped > 0) {
      warnings.push(
        `Obsidian source "${source.id}" skipped ${skipped} note(s). ` +
          `Run \`threadnote source status ${source.id}\` for details.`,
      );
    }
  }
  return {syncedSources, warnings} satisfies ObsidianSourceAutoSyncResult;
});

const syncObsidianSource = Effect.fn('obsidian.syncSource')(function* (
  config: RuntimeConfig,
  source: ObsidianSourceConfig,
  behavior: ObsidianSourceSyncBehavior,
) {
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* sourceStatePath(config, source.id);
  return yield* withSourceLock(
    config,
    source.id,
    withExclusiveFileLock(
      fs,
      `${statePath}.lock`,
      SOURCE_LOCK_OPTIONS,
      Effect.gen(function* () {
        const currentSource = requireObsidianSource(yield* readObsidianConfiguration(config), source.id);
        if (!currentSource.enabled) {
          return yield* ObsidianSourceError.make({message: `Obsidian source "${source.id}" is disabled.`});
        }
        const plan = yield* buildObsidianInventory(config, currentSource, behavior.quantum);
        if (behavior.log) {
          yield* printInventory(plan);
        }
        if (!behavior.apply) {
          if (behavior.log) {
            yield* Console.log('Dry run complete. Re-run with --apply to update the external index.');
          }
          return {
            entries: plan.entries,
            source: plan.source,
            ...(plan.scan === undefined ? {} : {more: true}),
          } satisfies ObsidianInventory;
        }
        const changedPaths = new Set(
          plan.entries
            .filter(entry => entry.action === 'add' || entry.action === 'update')
            .map(entry => entry.relativePath),
        );
        const changedNotes = plan.safeNotes.filter(note => changedPaths.has(note.relativePath));
        const removals = plan.entries.filter(entry => entry.action === 'remove' && entry.uri);
        const mutations: ResourceStoreMutation[] = [
          ...changedNotes.map(note => ({
            content: note.sanitizedContent,
            options: {mode: 'upsert' as const},
            type: 'write' as const,
            uri: note.uri,
          })),
          ...removals.flatMap(entry =>
            typeof entry.uri === 'string' ? [{ignoreMissing: true, type: 'remove' as const, uri: entry.uri}] : [],
          ),
        ];
        if (mutations.length > 0) {
          const store = yield* ResourceStore;
          yield* store.mutate(resourceStoreLocation(config), mutations);
        }
        if (mutations.length === 0 && !behavior.writeUnchangedState && !behavior.quantum) {
          return {
            entries: plan.entries,
            source: plan.source,
            ...(plan.scan === undefined ? {} : {more: true}),
          } satisfies ObsidianInventory;
        }
        const currentTimeMillis = yield* Clock.currentTimeMillis;
        const crypto = yield* Crypto.Crypto;
        const identities = new Map<string, ObsidianSourceFileState[]>();
        for (const previous of Object.values(plan.state.files)) {
          if (!previous.fileIdentity) continue;
          identities.set(previous.fileIdentity, [...(identities.get(previous.fileIdentity) ?? []), previous]);
        }
        const nextFiles: Record<string, ObsidianSourceFileState> = Object.fromEntries(
          behavior.quantum
            ? Object.entries(plan.state.files).filter(
                ([relative]) =>
                  !plan.entries.some(entry => entry.relativePath === relative && entry.action === 'remove'),
              )
            : [],
        );
        for (const note of plan.safeNotes) {
          const matching = note.fileIdentity ? identities.get(note.fileIdentity) : undefined;
          const previousNoteId = matching?.[0]?.noteId;
          nextFiles[note.relativePath] = {
            contentHash: note.contentHash,
            fileIdentity: note.fileIdentity,
            modifiedAt: note.modifiedAt,
            noteId:
              previousNoteId && matching?.every(previous => previous.noteId === previousNoteId)
                ? previousNoteId
                : yield* crypto.randomUUIDv4,
            sanitizedHash: note.sanitizedHash,
            sanitizerVersion: OBSIDIAN_SANITIZER_VERSION,
            size: note.size,
            uri: note.uri,
          };
        }
        const nextState: ObsidianSourceState = {
          files: nextFiles,
          ...(plan.scan === undefined ? {} : {scan: plan.scan}),
          sourceId: source.id,
          sourceInstanceId: plan.state.sourceInstanceId ?? (yield* crypto.randomUUIDv4),
          syncedAt:
            plan.scan === undefined ? DateTime.formatIso(DateTime.makeUnsafe(currentTimeMillis)) : plan.state.syncedAt,
          version: SOURCE_STATE_VERSION,
        };
        yield* writeSourceState(statePath, nextState);
        if (behavior.log) {
          const counts = inventoryCounts(plan.entries);
          yield* Console.log(
            `Obsidian source sync complete: ${counts.add} added, ${counts.update} updated, ${counts.remove} removed, ` +
              `${counts.unchanged} unchanged, ${counts.skip} skipped.`,
          );
        }
        return {
          entries: plan.entries,
          source: plan.source,
          ...(plan.scan === undefined ? {} : {more: true}),
        } satisfies ObsidianInventory;
      }),
    ),
  );
});

export const runObsidianSourceRemove = Effect.fn('obsidian.sourceRemove')(function* (
  config: RuntimeConfig,
  options: ObsidianSourceCommandOptions,
) {
  const apply = options.apply === true && options.dryRun !== true;
  const configuration = yield* readObsidianConfiguration(config);
  const source = requireObsidianSource(configuration, options.id);
  const rootUri = obsidianSourceRootUri(source.id);
  if (!apply) {
    yield* Console.log(`Would remove source configuration "${source.id}" and external index ${rootUri}.`);
    yield* Console.log('The Obsidian vault and Threadnote memories would be preserved.');
    yield* Console.log('Re-run with --apply to continue.');
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const statePath = yield* sourceStatePath(config, source.id);
  yield* withSourceLock(
    config,
    source.id,
    withExclusiveFileLock(
      fs,
      `${statePath}.lock`,
      SOURCE_LOCK_OPTIONS,
      Effect.gen(function* () {
        requireObsidianSource(yield* readObsidianConfiguration(config), source.id);
        const store = yield* ResourceStore;
        yield* store
          .remove(resourceStoreLocation(config), rootUri, {recursive: true})
          .pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
        yield* mutateSourceConfiguration(config, latest => removeObsidianSource(latest, source.id));
        const pathService = yield* Path.Path;
        yield* fs.remove(pathService.dirname(statePath), {force: true, recursive: true});
      }),
    ),
  );
  yield* Console.log(`Removed Obsidian source "${source.id}". The vault and memories were preserved.`);
});

export function obsidianSourceRootUri(id: string): string {
  return canonicalResourceUri('resources', ['external', 'obsidian', id.normalize('NFC')]);
}

export function obsidianSourceUri(id: string, relativePath: string): string {
  return canonicalResourceUri('resources', [
    'external',
    'obsidian',
    id.normalize('NFC'),
    ...relativePath
      .split('/')
      .filter(Boolean)
      .map(segment => segment.normalize('NFC')),
  ]);
}

export function sourcePathMatches(
  relativePath: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, '');
  return (
    include.some(pattern => globToRegExp(toPosixPath(pattern)).test(normalized)) &&
    !exclude.some(pattern => globToRegExp(toPosixPath(pattern)).test(normalized))
  );
}

const buildObsidianInventory = Effect.fn('obsidian.buildInventory')(function* (
  config: RuntimeConfig,
  source: ObsidianSourceConfig,
  quantum = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const vault = yield* canonicalDirectory(source.vault, 'Obsidian vault');
  const state = yield* readSourceState(yield* sourceStatePath(config, source.id), source.id);
  const effectiveExcludes = uniquePatterns([
    ...DEFAULT_OBSIDIAN_EXCLUDES,
    ...source.exclude,
    ...(source.inbox ? [`${source.inbox}/**`] : []),
  ]);
  const fingerprint = sha256HexSync(JSON.stringify(source));
  const previousScan = quantum && state.scan?.fingerprint === fingerprint ? state.scan : undefined;
  const directories = [...(previousScan?.directories ?? [''])];
  const directory = directories[0] ?? '';
  const offset = previousScan?.offset ?? 0;
  const seen = new Set(previousScan?.seen ?? []);
  const scanRoot = quantum ? pathService.join(vault, directory) : vault;
  const page =
    quantum && directories.length > 0 ? yield* scanObsidianDirectoryPage(fs, vault, directory, offset) : undefined;
  if (page) {
    for (const child of page.directories) {
      const relative = toPosixPath(pathService.relative(vault, child));
      if (!directoryIsExcluded(relative, effectiveExcludes)) directories.push(relative);
    }
    if (page.nextOffset === undefined) directories.shift();
  }
  const scannedFiles = quantum
    ? (page?.files ?? []).filter(
        file =>
          pathService.extname(file.path).toLowerCase() === MARKDOWN_EXTENSION &&
          sourcePathMatches(toPosixPath(pathService.relative(vault, file.path)), source.include, effectiveExcludes),
      )
    : yield* scanFilesWithinBoundary(fs, scanRoot, vault, {
        includeDirectory: path =>
          !directoryIsExcluded(toPosixPath(pathService.relative(vault, path)), effectiveExcludes),
        includeFile: path =>
          pathService.extname(path).toLowerCase() === MARKDOWN_EXTENSION &&
          sourcePathMatches(toPosixPath(pathService.relative(vault, path)), source.include, effectiveExcludes),
      });
  const nextOffset = page?.nextOffset ?? 0;
  const safeNotes: ScannedObsidianNote[] = [];
  const entries: ObsidianInventoryEntry[] = [];
  for (const file of scannedFiles) {
    const relativePath = toPosixPath(pathService.relative(vault, file.path));
    if (file.size > SOURCE_MAX_NOTE_BYTES) {
      entries.push({
        action: 'skip',
        detail: `larger than ${SOURCE_MAX_NOTE_BYTES} bytes`,
        relativePath,
      });
      continue;
    }
    const content = yield* fs.readFileString(file.path);
    const scrubbed = applyScrubber(content, {redact: true});
    if (scrubbed.blocker) {
      entries.push({action: 'skip', detail: `possible ${scrubbed.blocker}`, relativePath});
      continue;
    }
    const contentHash = yield* sha256Hex(content);
    const sanitizedHash = yield* sha256Hex(scrubbed.cleaned);
    const fileIdentity = yield* sourceFileIdentity(file.path);
    const note: ScannedObsidianNote = {
      contentHash,
      fileIdentity,
      modifiedAt: file.modifiedAt?.toISOString(),
      path: file.path,
      redactions: scrubbed.redactions.map(item => item.name),
      relativePath,
      sanitizedContent: scrubbed.cleaned,
      sanitizedHash,
      size: file.size,
      uri: obsidianSourceUri(source.id, relativePath),
    };
    safeNotes.push(note);
    seen.add(relativePath);
    const recorded = state.files[relativePath];
    entries.push({
      action: !recorded
        ? 'add'
        : recorded.contentHash === contentHash &&
            recorded.uri === note.uri &&
            recorded.fileIdentity === fileIdentity &&
            recorded.sanitizedHash === sanitizedHash &&
            recorded.sanitizerVersion === OBSIDIAN_SANITIZER_VERSION
          ? 'unchanged'
          : 'update',
      detail:
        note.redactions.length > 0
          ? `redacted ${note.redactions.slice(0, MAX_SECRET_MATCHES_TO_PRINT).join(', ')}`
          : undefined,
      relativePath,
      uri: note.uri,
    });
  }
  let scan =
    quantum && directories.length > 0 ? {fingerprint, directories, offset: nextOffset, seen: [...seen]} : undefined;
  const currentPaths = quantum ? seen : new Set(safeNotes.map(note => note.relativePath));
  let removalChecks = 0;
  let pendingRemovals = false;
  for (const [relativePath, recorded] of Object.entries(state.files)) {
    const rejected = entries.some(entry => entry.action === 'skip' && entry.relativePath === relativePath);
    if (((!quantum || scan === undefined) && !currentPaths.has(relativePath)) || rejected) {
      if (quantum && removalChecks >= 64) {
        pendingRemovals = true;
        continue;
      }
      removalChecks++;
      if (
        quantum &&
        !rejected &&
        sourcePathMatches(relativePath, source.include, effectiveExcludes) &&
        pathService.extname(relativePath).toLowerCase() === MARKDOWN_EXTENSION
      ) {
        const current = yield* inspectObsidianFile(fs, vault, relativePath);
        if (current !== undefined && Number(current.size) <= SOURCE_MAX_NOTE_BYTES) {
          seen.add(relativePath);
          continue;
        }
      }
      entries.push({action: 'remove', relativePath, uri: recorded.uri});
    }
  }
  if (quantum && pendingRemovals && scan === undefined)
    scan = {fingerprint, directories: [], offset: 0, seen: [...seen]};
  entries.sort(
    (left, right) =>
      inventoryActionRank(left.action) - inventoryActionRank(right.action) ||
      left.relativePath.localeCompare(right.relativePath),
  );
  return {entries, safeNotes, source, state, ...(scan === undefined ? {} : {scan})} satisfies ObsidianInventoryPlan;
});

const sourceStateDirectory = Effect.fn('obsidian.sourceStateDirectory')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome' | 'account'>,
  sourceId: string,
) {
  const pathService = yield* Path.Path;
  const directory = pathService.join(config.agentContextHome, 'threadnote', 'sources', 'obsidian', sourceId);
  return config.account === 'local'
    ? directory
    : pathService.join(directory, 'accounts', sha256HexSync(config.account));
});

const sourceStatePath = Effect.fn('obsidian.sourceStatePath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome' | 'account'>,
  sourceId: string,
) {
  const pathService = yield* Path.Path;
  return pathService.join(yield* sourceStateDirectory(config, sourceId), SOURCE_STATE_FILENAME);
});

const readSourceState = Effect.fn('obsidian.readSourceState')(function* (path: string, sourceId: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) {
    return emptySourceState(sourceId);
  }
  const raw = yield* fs.readFileString(path);
  return yield* Effect.try({
    try: () => parseSourceState(JSON.parse(raw), sourceId),
    catch: cause =>
      Schema.is(ObsidianSourceError)(cause)
        ? cause
        : ObsidianSourceError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
  });
});

const writeSourceState = Effect.fn('obsidian.writeSourceState')(function* (path: string, state: ObsidianSourceState) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
  const temporaryPath = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(state, undefined, 2)}\n`, {mode: PRIVATE_FILE_MODE});
  yield* fs
    .rename(temporaryPath, path)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
  yield* fs.chmod(path, PRIVATE_FILE_MODE);
});

function parseSourceState(value: unknown, sourceId: string): ObsidianSourceState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    (value.version !== 1 && value.version !== SOURCE_STATE_VERSION) ||
    !('sourceId' in value) ||
    value.sourceId !== sourceId ||
    !('files' in value) ||
    typeof value.files !== 'object' ||
    value.files === null
  ) {
    throw ObsidianSourceError.make({message: `Invalid Obsidian source state for "${sourceId}".`});
  }
  const files: Record<string, ObsidianSourceFileState> = {};
  for (const [relativePath, entry] of Object.entries(value.files)) {
    assertSafeSourceRelativePath(relativePath);
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('contentHash' in entry) ||
      typeof entry.contentHash !== 'string' ||
      !('size' in entry) ||
      typeof entry.size !== 'number' ||
      !('uri' in entry) ||
      typeof entry.uri !== 'string'
    ) {
      throw ObsidianSourceError.make({message: `Invalid Obsidian source state entry "${relativePath}".`});
    }
    if (entry.uri !== obsidianSourceUri(sourceId, relativePath)) {
      throw ObsidianSourceError.make({message: `Obsidian source state URI does not match "${relativePath}".`});
    }
    files[relativePath] = {
      contentHash: entry.contentHash,
      fileIdentity: 'fileIdentity' in entry && typeof entry.fileIdentity === 'string' ? entry.fileIdentity : undefined,
      modifiedAt: 'modifiedAt' in entry && typeof entry.modifiedAt === 'string' ? entry.modifiedAt : undefined,
      noteId: 'noteId' in entry && typeof entry.noteId === 'string' ? entry.noteId : undefined,
      sanitizedHash:
        'sanitizedHash' in entry && typeof entry.sanitizedHash === 'string' ? entry.sanitizedHash : undefined,
      sanitizerVersion:
        'sanitizerVersion' in entry && typeof entry.sanitizerVersion === 'string' ? entry.sanitizerVersion : undefined,
      size: entry.size,
      uri: entry.uri,
    };
  }
  let scan: ObsidianScanCheckpoint | undefined;
  if ('scan' in value && value.scan !== undefined) {
    const checkpoint = value.scan as ObsidianScanCheckpoint;
    if (
      !checkpoint ||
      typeof checkpoint.fingerprint !== 'string' ||
      !Array.isArray(checkpoint.directories) ||
      !Array.isArray(checkpoint.seen) ||
      !Number.isSafeInteger(checkpoint.offset) ||
      checkpoint.offset < 0
    )
      throw ObsidianSourceError.make({message: 'Invalid Obsidian scan checkpoint.'});
    for (const relative of [...checkpoint.directories, ...checkpoint.seen]) {
      if (typeof relative !== 'string') throw ObsidianSourceError.make({message: 'Invalid Obsidian scan checkpoint.'});
      if (relative !== '') assertSafeSourceRelativePath(relative);
    }
    scan = checkpoint;
  }
  return {
    files,
    ...(scan === undefined ? {} : {scan}),
    sourceId,
    sourceInstanceId:
      'sourceInstanceId' in value && typeof value.sourceInstanceId === 'string' ? value.sourceInstanceId : undefined,
    syncedAt: 'syncedAt' in value && typeof value.syncedAt === 'string' ? value.syncedAt : undefined,
    version: value.version,
  };
}

function emptySourceState(sourceId: string): ObsidianSourceState {
  return {files: {}, sourceId, version: SOURCE_STATE_VERSION};
}

const sourceFileIdentity = Effect.fn('obsidian.sourceFileIdentity')(function* (path: string) {
  const stat = yield* fromPromise('obsidian.sourceFileIdentity.stat', () => Bun.file(path).stat()).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (!stat?.isFile() || !stat.ino || !stat.birthtimeMs) return undefined;
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
});

function parseJsonOrUndefined(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const canonicalDirectory = Effect.fn('obsidian.canonicalDirectory')(function* (value: string, label: string) {
  const fs = yield* FileSystem.FileSystem;
  const expanded = yield* expandPath(value);
  if (!(yield* isDirectory(expanded))) {
    return yield* ObsidianSourceError.make({message: `${label} is not a directory: ${expanded}`});
  }
  return yield* fs.realPath(expanded);
});

function normalizeRelativePath(value: string, label: string): string {
  const normalized = toPosixPath(value).replace(/^\/+|\/+$/g, '');
  if (
    normalized.length === 0 ||
    normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw ObsidianSourceError.make({message: `${label} must be a safe vault-relative path.`});
  }
  return normalized;
}

function uniquePatterns(patterns: readonly string[]): readonly string[] {
  return [
    ...new Set(
      patterns.map(pattern => toPosixPath(pattern).replace(/^\/+/, '').trim()).filter(pattern => pattern.length > 0),
    ),
  ];
}

function safePatterns(patterns: readonly string[], label: string): readonly string[] {
  if (patterns.some(pattern => toPosixPath(pattern).trim().startsWith('/'))) {
    throw ObsidianSourceError.make({
      message: `${label} patterns must be vault-relative and cannot contain parent traversal.`,
    });
  }
  const normalized = uniquePatterns(patterns);
  if (
    normalized.some(pattern => /^[a-zA-Z]:\//.test(pattern) || pattern.split('/').some(segment => segment === '..'))
  ) {
    throw ObsidianSourceError.make({
      message: `${label} patterns must be vault-relative and cannot contain parent traversal.`,
    });
  }
  return normalized;
}

function assertSafeSourceRelativePath(relativePath: string): void {
  const normalized = toPosixPath(relativePath);
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw ObsidianSourceError.make({message: `Unsafe Obsidian source state path: ${relativePath}`});
  }
}

function directoryIsExcluded(relativeDirectory: string, exclude: readonly string[]): boolean {
  if (!relativeDirectory || relativeDirectory === '.') {
    return false;
  }
  const normalized = relativeDirectory.replace(/\/+$/, '');
  return exclude.some(pattern => {
    const normalizedPattern = toPosixPath(pattern)
      .replace(/\/\*\*$/, '')
      .replace(/\/+$/, '');
    return normalized === normalizedPattern || normalized.startsWith(`${normalizedPattern}/`);
  });
}

function sourceSummary(source: ObsidianSourceConfig): string {
  return [
    `${source.id} · ${source.enabled ? 'enabled' : 'disabled'} · ${source.vault}`,
    `  include: ${source.include.join(', ')}`,
    `  exclude: ${source.exclude.join(', ') || '(none)'}`,
    ...(source.inbox ? [`  inbox: ${source.inbox}`] : []),
  ].join('\n');
}

const printInventory = Effect.fn('obsidian.printInventory')(function* (inventory: ObsidianInventory) {
  if (inventory.entries.length === 0) {
    yield* Console.log(`Obsidian source "${inventory.source.id}" has no matching Markdown notes.`);
    return;
  }
  for (const entry of inventory.entries) {
    yield* Console.log(
      `${entry.action.toUpperCase().padEnd(9)} ${entry.relativePath}${entry.detail ? ` (${entry.detail})` : ''}`,
    );
  }
  const counts = inventoryCounts(inventory.entries);
  yield* Console.log(
    `Inventory: ${counts.add} add, ${counts.update} update, ${counts.remove} remove, ` +
      `${counts.unchanged} unchanged, ${counts.skip} skipped.`,
  );
});

function inventoryCounts(entries: readonly ObsidianInventoryEntry[]): Record<ObsidianInventoryAction, number> {
  const counts: Record<ObsidianInventoryAction, number> = {
    add: 0,
    remove: 0,
    skip: 0,
    unchanged: 0,
    update: 0,
  };
  for (const entry of entries) {
    counts[entry.action] += 1;
  }
  return counts;
}

function inventoryActionRank(action: ObsidianInventoryAction): number {
  return {add: 0, update: 1, remove: 2, skip: 3, unchanged: 4}[action];
}

function isSourceMutation(action: ObsidianInventoryAction): boolean {
  return action === 'add' || action === 'update' || action === 'remove';
}

function resourceStoreLocation(config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
  return {
    account: config.account,
    home: config.agentContextHome,
    user: config.user,
  } as const;
}

export const obsidianSourceWork = {
  provider: 'obsidian',
  list: Effect.fn('obsidian.workDescriptors')(function* (config: RuntimeConfig) {
    return (yield* readObsidianConfiguration(config)).sources
      .filter(isObsidianSource)
      .filter(source => source.enabled)
      .map(source => ({
        sourceId: source.id,
        provider: 'obsidian',
        accountKey: sha256HexSync(`obsidian:${source.vault}`),
        fingerprint: sha256HexSync(JSON.stringify(source)),
        refreshIntervalMs: 60_000,
      }));
  }),
  run: Effect.fn('obsidian.workQuantum')(function* (
    config: RuntimeConfig,
    sourceId: string,
    _options: SourceWorkOptions,
  ) {
    const source = requireObsidianSource(yield* readObsidianConfiguration(config), sourceId);
    const result = yield* syncObsidianSource(config, source, {
      apply: true,
      log: false,
      writeUnchangedState: false,
      quantum: true,
    });
    return {
      sourceId,
      syncedDocuments: result.entries.filter(entry => isSourceMutation(entry.action)).map(entry => entry.relativePath),
      warnings: [],
      value: result,
      more: result.more === true,
    };
  }),
};
