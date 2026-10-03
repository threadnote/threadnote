import {Crypto, Effect, FileSystem, Path} from 'effect';
import {parseMemoryDocument, type MemoryMetadata, type MemoryRecord} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';
import {localUserMemoriesRoot, MemoryOperationError} from '../migrations.js';

interface InventoryEntry {
  readonly uri: string;
  readonly path: string;
  readonly signature: string;
  readonly hash: string;
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
  readonly version: 1;
  readonly mutationGeneration: string;
  readonly entries: Readonly<Record<string, InventoryEntry>>;
  readonly queue: readonly DirectoryPage[];
  readonly complete: boolean;
  readonly refreshCursor: number;
  readonly root: string;
}

function decodeInventory(raw: string, root: string, user: string): Inventory | undefined {
  const value = JSON.parse(raw) as Partial<Inventory>;
  if (
    value.version !== 1 ||
    value.root !== root ||
    typeof value.mutationGeneration !== 'string' ||
    typeof value.complete !== 'boolean' ||
    !Number.isSafeInteger(value.refreshCursor) ||
    value.refreshCursor! < 0 ||
    value.entries === null ||
    typeof value.entries !== 'object' ||
    !Array.isArray(value.queue) ||
    (!value.complete && value.queue.length === 0)
  )
    return undefined;
  const contained = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && (candidate === root || candidate.startsWith(`${root}/`));
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
  return value as Inventory;
}

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
  let prior = yield* fs.readFileString(file).pipe(
    Effect.flatMap(raw => Effect.try(() => decodeInventory(raw, root, config.user))),
    Effect.orElseSucceed(() => undefined),
  );
  if (prior !== undefined && prior.version !== 1) prior = undefined;
  const reset = prior === undefined || prior.mutationGeneration !== generation;
  const entries: Record<string, InventoryEntry> = {...prior?.entries};
  const queue: DirectoryPage[] = reset ? [{directory: root, offset: 0}] : [...(prior?.queue ?? [])];
  let admitted = 0;
  while (queue.length > 0 && admitted < budget) {
    const page = queue.shift()!;
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
      if (name.startsWith('.')) continue;
      admitted++;
      const candidate = path.join(page.directory, name);
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (info._tag === 'None') continue;
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      const segments = relative.split('/');
      const projectAt = segments.indexOf('projects');
      if (
        project !== undefined &&
        projectAt >= 0 &&
        segments[projectAt + 1] !== undefined &&
        segments[projectAt + 1] !== project
      )
        continue;
      if (info.value.type === 'Directory') queue.push({directory: candidate, offset: 0});
      else if (info.value.type === 'File' && name.endsWith('.md')) {
        const canonical = yield* fs.realPath(candidate);
        const canonicalRoot = yield* fs.realPath(root);
        if (!canonical.startsWith(`${canonicalRoot}${path.sep}`)) continue;
        const uri = `threadnote://user/${uriSegment(config.user)}/memories/${relative}`;
        const signature = `${Number(info.value.size)}:${JSON.stringify(info.value.mtime)}`;
        if (entries[uri]?.signature === signature) continue;
        if (Number(info.value.size) > 8 * 1024 * 1024)
          return yield* MemoryOperationError.make({message: 'Maintenance inventory record exceeds its read boundary.'});
        const content = yield* fs.readFileString(candidate);
        const record = parseMemoryDocument(uri, content);
        if (record === undefined) {
          if (!relative.startsWith('shared/'))
            return yield* MemoryOperationError.make({message: 'Unreadable private memory inventory record.'});
          delete entries[uri];
        } else if (project === undefined || (record.metadata.project ?? 'unscoped') === project) {
          entries[uri] = {
            uri,
            path: candidate,
            signature,
            hash: sha256HexSync(content),
            bodyHash: sha256HexSync(record.body),
            headerTitle: record.headerTitle,
            metadata: record.metadata,
          };
        }
      }
    }
    if (offset < names.length) queue.unshift({directory: page.directory, names, offset});
  }
  let refreshCursor = prior?.refreshCursor ?? 0;
  if (queue.length === 0) {
    const uris = Object.keys(entries).sort();
    for (let index = 0; index < Math.min(budget - admitted, uris.length); index++) {
      const uri = uris[refreshCursor++ % uris.length];
      const entry = entries[uri];
      const info = yield* fs.stat(entry.path).pipe(Effect.option);
      if (info._tag === 'None') {
        delete entries[uri];
        continue;
      }
      const signature = `${Number(info.value.size)}:${JSON.stringify(info.value.mtime)}`;
      if (signature !== entry.signature) {
        if (Number(info.value.size) > 8 * 1024 * 1024)
          return yield* MemoryOperationError.make({message: 'Maintenance inventory record exceeds its read boundary.'});
        const canonical = yield* fs.realPath(entry.path);
        const canonicalRoot = yield* fs.realPath(root);
        if (!canonical.startsWith(`${canonicalRoot}${path.sep}`))
          return yield* MemoryOperationError.make({
            message: 'Maintenance inventory target left its authority boundary.',
          });
        const content = yield* fs.readFileString(entry.path);
        const record = parseMemoryDocument(uri, content);
        if (record === undefined)
          return yield* MemoryOperationError.make({message: 'Maintenance inventory changed to an unreadable memory.'});
        entries[uri] = {
          ...entry,
          signature,
          hash: sha256HexSync(content),
          bodyHash: sha256HexSync(record.body),
          metadata: record.metadata,
        };
      }
    }
    // Directory traversal is also rotated so newly created external files are eventually discovered.
    if (!reset && prior?.complete && refreshCursor >= Object.keys(entries).length) {
      refreshCursor = 0;
      queue.push({directory: root, offset: 0});
    }
  }
  const inventory: Inventory = {
    version: 1,
    mutationGeneration: generation,
    entries,
    queue,
    complete: queue.length === 0 || (!reset && prior?.complete === true),
    refreshCursor,
    root,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(inventory));
  if (encoded.length > 32 * 1024 * 1024)
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
  const ordered = Object.values(entries).sort((left, right) => left.uri.localeCompare(right.uri));
  return {
    complete: inventory.complete,
    generation: sha256HexSync(ordered.map(entry => `${entry.uri}:${entry.hash}`).join('|')),
    hashes: new Map(ordered.map(entry => [entry.uri, entry.hash])),
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
