import {Clock, Crypto, Effect, Equal, FileSystem, Option, Path} from 'effect';
import {
  canonicalMemoryDocumentContent,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';
import {localUserMemoriesRoot, MemoryOperationError} from '../migrations.js';

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
  readonly incompleteReason?: InventoryIncompleteReason;
}

export function contextMaintenanceInventoryPreparation(
  snapshot: {readonly complete: boolean; readonly incompleteReason?: InventoryIncompleteReason},
  admittedRecords: number,
): ContextMaintenanceInventoryPreparationV2 {
  return {
    complete: snapshot.complete,
    admittedRecords,
    ...(snapshot.incompleteReason === undefined ? {} : {incompleteReason: snapshot.incompleteReason}),
  };
}

function decodeInventory(raw: string, root: string, user: string): Inventory | undefined {
  const value = JSON.parse(raw) as Partial<Omit<Inventory, 'version'>> & {version?: number; refreshCursor?: number};
  if (
    ![1, 2].includes(value.version ?? 0) ||
    value.root !== root ||
    typeof value.mutationGeneration !== 'string' ||
    typeof value.complete !== 'boolean' ||
    (value.version === 1 && (!Number.isSafeInteger(value.refreshCursor) || value.refreshCursor! < 0)) ||
    value.entries === null ||
    typeof value.entries !== 'object' ||
    !Array.isArray(value.queue) ||
    (value.version === 1 && !value.complete && value.queue.length === 0)
  )
    return undefined;
  const contained = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' &&
    (candidate === root || candidate.startsWith(`${root}/`) || candidate.startsWith(`${root}\\`));
  if (
    !value.queue.every(
      page =>
        page !== null &&
        contained(page.directory) &&
        Number.isSafeInteger(page.offset) &&
        page.offset >= 0 &&
        (page.names === undefined ||
          (Array.isArray(page.names) &&
            page.names.length <= 10_000 &&
            page.offset <= page.names.length &&
            page.names.every((name: unknown) => typeof name === 'string' && !/[\\/\0]/u.test(name)))),
    )
  )
    return undefined;
  if (
    !Object.entries(value.entries).every(
      ([uri, entry]) =>
        entry !== null &&
        typeof entry === 'object' &&
        entry.uri === uri &&
        uri.startsWith(`threadnote://user/${uriSegment(user)}/memories/`) &&
        contained(entry.path) &&
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
  // V1 completeness is only a discovery hint; every completed view receives a fresh terminal proof below.
  return {...value, version: 2} as Inventory;
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
  const segments = path.relative(root, candidate).split(path.sep);
  const projectAt = segments.indexOf('projects');
  return (
    project === undefined ||
    projectAt < 0 ||
    segments[projectAt + 1] === undefined ||
    segments[projectAt + 1] === project
  );
}
const checkAuthority = (fs: FileSystem.FileSystem, path: Path.Path, canonicalRoot: string, candidate: string) =>
  Effect.gen(function* () {
    const canonical = yield* fs.realPath(candidate);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`))
      return yield* MemoryOperationError.make({message: 'Maintenance inventory target left its authority boundary.'});
  });

const persistInventory = Effect.fn('contextMaintenance.persistInventory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  inventory: Inventory,
) {
  const encoded = new TextEncoder().encode(JSON.stringify(inventory));
  if (encoded.length > contextMaintenanceInventoryAuthorityLimits.canonicalBytes)
    return yield* MemoryOperationError.make({message: 'Maintenance inventory exceeds its cache boundary.'});
  yield* fs.makeDirectory(path.dirname(file), {recursive: true});
  const temporary = `${file}.${yield* (yield* Crypto.Crypto).randomUUIDv4}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
      yield* handle.writeAll(encoded);
      yield* handle.sync;
    }),
  ).pipe(
    Effect.andThen(fs.rename(temporary, file)),
    Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)),
  );
});

/** Read a stable, regular, authority-contained handle with a hard allocation/read boundary. */
const readEntry = Effect.fn('contextMaintenance.inventoryReadEntry')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  canonicalRoot: string,
  candidate: string,
  uri: string,
  project: string | undefined,
  expectedInfo?: FileSystem.File.Info,
) {
  yield* checkAuthority(fs, path, canonicalRoot, candidate);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const before = expectedInfo ?? (yield* fs.stat(candidate));
      if (before.type !== 'File' || Number(before.size) > contextMaintenanceInventoryAuthorityLimits.recordBytes)
        return yield* MemoryOperationError.make({message: 'Maintenance inventory record exceeds its read boundary.'});
      const handle = yield* fs.open(candidate, {flag: 'r'});
      const opened = yield* handle.stat;
      yield* checkAuthority(fs, path, canonicalRoot, candidate);
      if (
        opened.type !== 'File' ||
        opened.dev !== before.dev ||
        !Equal.equals(opened.ino, before.ino) ||
        signature(opened) !== signature(before)
      )
        return yield* MemoryOperationError.make({
          message: 'Maintenance inventory record changed before its bounded read.',
        });
      if (Number(opened.size) > contextMaintenanceInventoryAuthorityLimits.recordBytes)
        return yield* MemoryOperationError.make({message: 'Maintenance inventory record exceeds its read boundary.'});
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = yield* handle.readAlloc(Math.min(64 * 1024, Number(opened.size) - bytes + 1));
        if (Option.isNone(chunk)) break;
        bytes += chunk.value.length;
        if (bytes > contextMaintenanceInventoryAuthorityLimits.recordBytes)
          return yield* MemoryOperationError.make({message: 'Maintenance inventory record exceeds its read boundary.'});
        if (bytes > Number(opened.size))
          return yield* MemoryOperationError.make({
            message: 'Maintenance inventory record changed during its bounded read.',
          });
        chunks.push(chunk.value);
      }
      const after = yield* handle.stat;
      const current = yield* fs.stat(candidate);
      yield* checkAuthority(fs, path, canonicalRoot, candidate);
      if (
        signature(after) !== signature(opened) ||
        bytes !== Number(after.size) ||
        current.dev !== opened.dev ||
        !Equal.equals(current.ino, opened.ino) ||
        signature(current) !== signature(after)
      )
        return yield* MemoryOperationError.make({
          message: 'Maintenance inventory record changed during its bounded read.',
        });
      const raw = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.length;
      }
      const content = yield* Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true}).decode(raw),
        catch: () => MemoryOperationError.make({message: 'Unreadable private memory inventory record.'}),
      });
      const record = parseMemoryDocument(uri, content);
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      if (record === undefined && !relative.startsWith('shared/'))
        return yield* MemoryOperationError.make({message: 'Unreadable private memory inventory record.'});
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
      return {entry, bytes};
    }),
  );
});

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
        return yield* MemoryOperationError.make({message: 'Maintenance inventory root is not a directory.'});
      if (Option.isSome(rootInfo)) {
        const canonicalRoot = yield* fs.realPath(root);
        const canonicalHome = yield* fs.realPath(config.agentContextHome);
        if (!canonicalRoot.startsWith(`${canonicalHome}${path.sep}`))
          return yield* MemoryOperationError.make({message: 'Maintenance inventory root left its authority boundary.'});
        const directories = [root];
        while (directories.length > 0) {
          const directory = directories.shift()!;
          yield* checkAuthority(fs, path, canonicalRoot, directory);
          const names = (yield* fs.readDirectory(directory)).sort().filter(name => !name.startsWith('.'));
          if (names.length > contextMaintenanceInventoryAuthorityLimits.catalogNames)
            return incomplete('inventory-terminal-catalog-boundary');
          catalogNames += names.length;
          if (catalogNames > contextMaintenanceInventoryAuthorityLimits.catalogNames)
            return incomplete('inventory-terminal-catalog-boundary');
          const item = (directory?: string, entry?: InventoryEntry, incompleteReason?: InventoryIncompleteReason) => ({
            directory,
            entry,
            incompleteReason,
          });
          const children = yield* Effect.forEach(
            names,
            name =>
              Effect.gen(function* () {
                const candidate = path.join(directory, name);
                if (!inProject(path, root, candidate, project)) return item();
                const info = yield* statIfPresent(fs, candidate);
                if (Option.isNone(info)) return item(undefined, undefined, 'inventory-terminal-membership-race');
                yield* checkAuthority(fs, path, canonicalRoot, candidate);
                if (info.value.type === 'Directory') return item(candidate);
                if (name.endsWith('.md')) {
                  if (
                    info.value.type !== 'File' ||
                    Number(info.value.size) > contextMaintenanceInventoryAuthorityLimits.recordBytes
                  )
                    return yield* MemoryOperationError.make({
                      message: 'Maintenance inventory record exceeds its read boundary.',
                    });
                  if (
                    canonicalBytes + Number(info.value.size) >
                    contextMaintenanceInventoryAuthorityLimits.canonicalBytes
                  )
                    return item(undefined, undefined, 'inventory-terminal-byte-boundary');
                  // Reserve bytes before the first read yield; concurrent handles cannot
                  // jointly exceed the terminal bound. readEntry proves the reserved identity/size.
                  canonicalBytes += Number(info.value.size);
                  const relative = path.relative(root, candidate).split(path.sep).join('/');
                  const uri = `threadnote://user/${uriSegment(config.user)}/memories/${relative}`;
                  const read = yield* readEntry(fs, path, root, canonicalRoot, candidate, uri, project, info.value);
                  return item(undefined, read.entry);
                }
                return item();
              }),
            {concurrency: contextMaintenanceInventoryAuthorityLimits.readConcurrency},
          );
          for (const child of children) {
            if (child.incompleteReason !== undefined) return incomplete(child.incompleteReason);
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
      return {complete: true as const, entries, mutationGeneration, catalogNames, canonicalBytes};
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
    return yield* MemoryOperationError.make({message: 'Maintenance inventory exceeds its cache boundary.'});
  const prior = yield* fs.readFileString(file).pipe(
    Effect.flatMap(raw => Effect.try(() => decodeInventory(raw, root, config.user))),
    Effect.orElseSucceed(() => undefined),
  );
  // Account writes invalidate authority, never the fair discovery cursor. The terminal
  // snapshot reconciles every selected byte and deletion under the native mutation lock.
  let entries: Record<string, InventoryEntry> = {...prior?.entries};
  const queue: DirectoryPage[] =
    prior === undefined ? [{directory: root, offset: 0}] : prior.complete ? [] : [...prior.queue];
  let incompleteReason: InventoryIncompleteReason | undefined = 'inventory-discovery-incomplete';
  let admitted = 0;
  while (queue.length > 0 && admitted < budget) {
    const page = queue.shift()!;
    const directoryInfo = yield* statIfPresent(fs, page.directory);
    if (Option.isNone(directoryInfo)) continue;
    if (directoryInfo.value.type !== 'Directory')
      return yield* MemoryOperationError.make({message: 'Maintenance inventory directory changed during discovery.'});
    const canonicalRoot = yield* fs.realPath(root);
    const canonicalHome = yield* fs.realPath(config.agentContextHome);
    if (!canonicalRoot.startsWith(`${canonicalHome}${path.sep}`))
      return yield* MemoryOperationError.make({message: 'Maintenance inventory root left its authority boundary.'});
    yield* checkAuthority(fs, path, canonicalRoot, page.directory);
    const names =
      page.names ??
      (yield* fs.readDirectory(page.directory).pipe(
        Effect.catchIf(
          error => error.reason._tag === 'NotFound',
          () => Effect.succeed([]),
        ),
      )).sort();
    if (names.length > contextMaintenanceInventoryAuthorityLimits.catalogNames) {
      queue.unshift({directory: page.directory, offset: page.offset});
      incompleteReason = 'inventory-terminal-catalog-boundary';
      break;
    }
    let offset = page.offset;
    while (offset < names.length && admitted < budget) {
      const name = names[offset++];
      if (name.startsWith('.')) continue;
      admitted++;
      const candidate = path.join(page.directory, name);
      const info = yield* statIfPresent(fs, candidate);
      if (info._tag === 'None') continue;
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      if (!inProject(path, root, candidate, project)) continue;
      if (info.value.type === 'Directory') {
        yield* checkAuthority(fs, path, canonicalRoot, candidate);
        queue.push({directory: candidate, offset: 0});
      } else if (info.value.type === 'File' && name.endsWith('.md')) {
        yield* checkAuthority(fs, path, canonicalRoot, candidate);
        const uri = `threadnote://user/${uriSegment(config.user)}/memories/${relative}`;
        if (entries[uri]?.signature === signature(info.value) && entries[uri]?.canonicalContentHash !== undefined)
          continue;
        const read = yield* readEntry(fs, path, root, canonicalRoot, candidate, uri, project, info.value);
        if (read.entry === undefined) delete entries[uri];
        else entries[uri] = read.entry;
      }
    }
    if (offset < names.length) queue.unshift({directory: page.directory, names, offset});
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
      complete = true;
      incompleteReason = undefined;
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
  const ordered = Object.values(entries).sort((left, right) => left.uri.localeCompare(right.uri));
  return {
    complete: inventory.complete,
    incompleteReason,
    reconciliation,
    generation: sha256HexSync(ordered.map(entry => `${entry.uri}:${entry.hash}`).join('|')),
    hashes: new Map(ordered.map(entry => [entry.uri, entry.hash])),
    canonicalContentHashes: new Map(
      ordered.flatMap(entry =>
        entry.canonicalContentHash === undefined ? [] : [[entry.uri, entry.canonicalContentHash] as const],
      ),
    ),
    bodyHashes: new Map(ordered.map(entry => [entry.uri, entry.bodyHash])),
    records: ordered.map(
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
});
