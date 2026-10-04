import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {resourceAccountMutationLockPath} from '@threadnote/store/resource/lock';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  contextMaintenanceInventoryAuthorityLimits,
  prepareContextMaintenanceInventory,
} from '@threadnote/threadnote/memory/context/maintenance_inventory';

const systemLayer = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'inventory-test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: e => ({...e}), sanitizeExternal: e => ({...e})}),
    ),
  ),
);
const dependencies = Layer.mergeAll(
  BunServices.layer,
  systemLayer,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const layer = Layer.merge(dependencies, ResourceStore.layer.pipe(Layer.provide(dependencies)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const uri = (index: number, project = 'selected') =>
  `threadnote://user/tester/memories/durable/projects/${project}/record-${String(index).padStart(2, '0')}.md`;
const content = (index: number, project = 'selected', body = `Synthetic record ${index}.`) =>
  formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      schemaVersion: 5,
      memoryId: `tn_inventory_${project}_${index}`,
      project,
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-10-03T15:00:00.000Z',
      topic: `record-${String(index).padStart(2, '0')}`,
    },
    body,
  );
const pairs = (hashes: ReadonlyMap<string, string>) => [...hashes].sort(([a], [b]) => a.localeCompare(b));
const fixture = (order: readonly number[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* ResourceStore;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'inventory-test-'});
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'test',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'tester',
    };
    const location = {account: 'local', home, user: 'tester'};
    const directory = path.join(home, 'data', 'local', 'user', 'tester', 'memories', 'durable', 'projects', 'selected');
    const model = new Map<string, string>();
    for (const index of order) {
      const text = content(index);
      yield* store.write(location, uri(index), text, {mode: 'create'});
      model.set(uri(index), sha256HexSync(text));
    }
    yield* store.write(location, uri(0, 'unrelated'), content(0, 'unrelated'), {mode: 'create'});
    let revision = 0;
    return {
      fs,
      path,
      store,
      home,
      config,
      location,
      directory,
      model,
      recordPath: (index: number) => path.join(directory, `record-${String(index).padStart(2, '0')}.md`),
      prepare: (budget: number) => prepareContextMaintenanceInventory(config, 'selected', budget),
      noise: () =>
        store.write(location, uri(0, 'unrelated'), content(0, 'unrelated', `Unrelated ${++revision}.`), {
          mode: 'replace',
        }),
    };
  });
const settle = (f: Effect.Success<ReturnType<typeof fixture>>, budget: number, noise = false) =>
  Effect.gen(function* () {
    for (let tick = 0; tick < 64; tick++) {
      if (noise) yield* f.noise();
      const result = yield* f.prepare(budget);
      if (result.complete) return {result, ticks: tick + 1};
    }
    throw new Error('Finite inventory did not establish fresh authority in 64 preparations');
  });

describe('maintenance inventory authority and fairness', () => {
  effectIt.effect('resumes bounded discovery across native unrelated writes and selects the tail', () =>
    Effect.gen(function* () {
      const f = yield* fixture(Array.from({length: 30}, (_, i) => i));
      const result = yield* settle(f, 8, true);
      expect(result.ticks).toBe(5);
      expect(pairs(result.result.hashes)).toEqual(pairs(f.model));
      expect(result.result.records).toHaveLength(30);
      expect(result.result.hashes.has(uri(29))).toBe(true);
      expect(result.result.incompleteReason).toBeUndefined();
      expect(result.result.reconciliation?.canonicalBytes).toBeGreaterThan(0);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('the first complete result rehashes an edited tail and removes deleted membership', () =>
    Effect.gen(function* () {
      const f = yield* fixture(Array.from({length: 30}, (_, i) => i));
      yield* settle(f, 8);
      const text = content(29, 'selected', 'Tail changed while discovery was incomplete.');
      yield* f.store.write(f.location, uri(29), text, {mode: 'replace'});
      yield* f.store.remove(f.location, uri(28));
      f.model.set(uri(29), sha256HexSync(text));
      f.model.delete(uri(28));
      yield* f.noise().pipe(Effect.orDie);
      const result = yield* f.prepare(8);
      expect(result.complete).toBe(true);
      expect(pairs(result.hashes)).toEqual(pairs(f.model));
      expect(result.records).toHaveLength(29);
      expect(result.hashes.has(uri(28))).toBe(false);
      const moved = content(27, 'unrelated');
      yield* f.store.write(f.location, uri(27), moved, {mode: 'replace'});
      f.model.delete(uri(27));
      const afterMove = yield* f.prepare(8);
      expect(afterMove.complete).toBe(true);
      expect(pairs(afterMove.hashes)).toEqual(pairs(f.model));
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('fresh authority never trusts an unchanged size/mtime signature as the current hash', () =>
    Effect.gen(function* () {
      const f = yield* fixture([0]);
      yield* settle(f, 8);
      const original = yield* f.fs.stat(f.recordPath(0));
      const changed = content(0, 'selected', 'Synthetic record X.');
      yield* f.store.write(f.location, uri(0), changed, {mode: 'replace'});
      const mtime = Option.getOrThrow(original.mtime);
      yield* f.fs.utimes(f.recordPath(0), mtime, mtime);
      const restored = yield* f.fs.stat(f.recordPath(0));
      expect(restored.size).toBe(original.size);
      expect(JSON.stringify(restored.mtime)).toBe(JSON.stringify(original.mtime));
      const result = yield* f.prepare(8);
      expect(result.complete).toBe(true);
      expect(result.hashes.get(uri(0))).toBe(sha256HexSync(changed));
      expect(result.canonicalContentHashes.get(uri(0))).toBe(sha256HexSync(changed));
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('legacy v2 hints cannot invent canonical identity before a fresh bounded read', () =>
    Effect.gen(function* () {
      const f = yield* fixture([0]);
      const raw = `${content(0)}\n\n<!-- MEMORY_FIELDS\nversion: 1\n-->`;
      yield* f.store.write(f.location, uri(0), raw, {mode: 'replace'});
      yield* settle(f, 8);
      const cacheFile = f.path.join(f.home, 'context-maintenance', 'inventory', `${sha256HexSync('selected')}.json`);
      const prior = JSON.parse(yield* f.fs.readFileString(cacheFile));
      for (const entry of Object.values<{canonicalContentHash?: string}>(prior.entries))
        delete entry.canonicalContentHash;
      prior.complete = false;
      prior.queue = [{directory: prior.root, offset: 0}];
      yield* f.fs.writeFileString(cacheFile, JSON.stringify(prior));
      const partial = yield* f.prepare(1);
      expect(partial.complete).toBe(false);
      expect(partial.hashes.get(uri(0))).toBe(sha256HexSync(raw));
      expect(partial.canonicalContentHashes.has(uri(0))).toBe(false);
      const fresh = yield* settle(f, 8);
      expect(fresh.result.hashes.get(uri(0))).toBe(sha256HexSync(raw));
      expect(fresh.result.canonicalContentHashes.get(uri(0))).toBe(sha256HexSync(content(0)));
      expect(yield* f.store.read(f.location, uri(0))).toBe(raw);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('native unrelated writers during bounded discovery cannot reset fair tail progress', () =>
    Effect.gen(function* () {
      const f = yield* fixture(Array.from({length: 30}, (_, i) => i));
      const injectedTicks = new Set<number>();
      let tick = 0;
      const lock = resourceAccountMutationLockPath(f.path, f.home, 'local');
      const wrapped = FileSystem.FileSystem.of({
        ...f.fs,
        stat: file =>
          Effect.gen(function* () {
            if (
              file.startsWith(`${f.directory}${f.path.sep}`) &&
              file.endsWith('.md') &&
              !injectedTicks.has(tick) &&
              !(yield* f.fs.exists(lock))
            ) {
              injectedTicks.add(tick);
              yield* f.noise().pipe(Effect.orDie);
            }
            return yield* f.fs.stat(file);
          }),
      });
      for (tick = 1; tick <= 10; tick++) {
        const result = yield* f.prepare(8).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
        if (result.complete) {
          expect(tick).toBe(5);
          expect(injectedTicks.size).toBe(5);
          expect(pairs(result.hashes)).toEqual(pairs(f.model));
          return;
        }
      }
      throw new Error('Native writes inside preparation starved the selected tail');
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect(
    'a native canonical write after terminal release invalidates completeness without resetting discovery',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture([0, 1]);
        yield* settle(f, 8);
        let injected = false;
        const wrapped = FileSystem.FileSystem.of({
          ...f.fs,
          rename: (from, to) =>
            f.fs.rename(from, to).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  if (
                    !injected &&
                    to === f.path.join(f.home, 'context-maintenance', 'inventory', `${sha256HexSync('selected')}.json`)
                  ) {
                    injected = true;
                    yield* f.noise().pipe(Effect.orDie);
                  }
                }),
              ),
            ),
        });
        const raced = yield* f.prepare(8).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
        expect(raced.complete).toBe(false);
        expect(raced.incompleteReason).toBe('inventory-terminal-generation-race');
        expect(pairs(raced.hashes)).toEqual(pairs(f.model));
        const next = yield* f.prepare(8);
        expect(next.complete).toBe(true);
        expect(pairs(next.hashes)).toEqual(pairs(f.model));
      }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('unreadable private bytes and escaped authority fail closed after a warm cache', () =>
    Effect.gen(function* () {
      const f = yield* fixture([0]);
      yield* settle(f, 8);
      yield* f.store.write(f.location, uri(0), 'not a memory', {mode: 'replace'});
      const unreadable = yield* f.prepare(8).pipe(Effect.result);
      expect(Result.isFailure(unreadable)).toBe(true);
      yield* f.store.write(f.location, uri(0), content(0), {mode: 'replace'});
      const outside = yield* f.fs.makeTempDirectoryScoped({prefix: 'inventory-outside-'});
      const external = f.path.join(outside, 'outside.md');
      yield* f.fs.writeFileString(external, content(0));
      yield* f.fs.remove(f.recordPath(0));
      yield* f.fs.symlink(external, f.recordPath(0));
      const escaped = yield* f.prepare(8).pipe(Effect.result);
      expect(Result.isFailure(escaped)).toBe(true);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('terminal catalog bounds return incomplete rather than cached complete authority', () =>
    Effect.gen(function* () {
      const f = yield* fixture([0]);
      yield* settle(f, 8);
      const wrapped = FileSystem.FileSystem.of({
        ...f.fs,
        readDirectory: directory =>
          directory === f.directory
            ? Effect.succeed(
                Array.from(
                  {length: contextMaintenanceInventoryAuthorityLimits.catalogNames + 1},
                  (_, i) => `name-${i}.md`,
                ),
              )
            : f.fs.readDirectory(directory),
      });
      const result = yield* f.prepare(8).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe('inventory-terminal-catalog-boundary');
      expect((yield* f.prepare(8)).complete).toBe(true);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('terminal timeout releases the native lock and preserves a retryable fair cursor', () =>
    Effect.gen(function* () {
      const f = yield* fixture([0]);
      yield* settle(f, 8);
      const entered = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<never>();
      const wrapped = FileSystem.FileSystem.of({
        ...f.fs,
        readDirectory: directory =>
          directory === f.directory
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(blocked)))
            : f.fs.readDirectory(directory),
      });
      const fiber = yield* f.prepare(8).pipe(Effect.provideService(FileSystem.FileSystem, wrapped), Effect.forkChild);
      yield* Deferred.await(entered);
      const result = yield* Fiber.join(fiber);
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe('inventory-terminal-time-boundary');
      expect(yield* f.fs.exists(resourceAccountMutationLockPath(f.path, f.home, 'local'))).toBe(false);
      expect((yield* f.prepare(8)).complete).toBe(true);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('terminal total-byte and per-record limits never certify an over-boundary corpus', () =>
    Effect.gen(function* () {
      const f = yield* fixture([0, 1, 2, 3, 4]);
      const large = 'x'.repeat(7 * 1024 * 1024);
      for (let i = 0; i < 5; i++)
        yield* f.store.write(f.location, uri(i), content(i, 'selected', large), {mode: 'replace'});
      const result = yield* f.prepare(100);
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe('inventory-terminal-byte-boundary');
      yield* f.store.write(
        f.location,
        uri(0),
        content(0, 'selected', 'x'.repeat(contextMaintenanceInventoryAuthorityLimits.recordBytes)),
        {mode: 'replace'},
      );
      expect(Result.isFailure(yield* f.prepare(100).pipe(Effect.result))).toBe(true);
    }).pipe(TestClock.withLive, provide),
  );

  fcEffectProp(
    effectIt,
    'physical insertion order, page size and unrelated writes equal independent canonical byte hashes',
    {
      order: fc.shuffledSubarray(
        Array.from({length: 12}, (_, i) => i),
        {minLength: 12, maxLength: 12},
      ),
      budget: fc.integer({min: 1, max: 8}),
      crlf: fc.boolean(),
      prefix: fc.constantFrom('', ' \n\t'),
      suffix: fc.constantFrom('', '\n', '\n\n<!-- MEMORY_FIELDS\nversion: 1\n-->'),
    },
    ({order, budget, crlf, prefix, suffix}) =>
      Effect.gen(function* () {
        const f = yield* fixture(order);
        const reverse = yield* fixture([...order].reverse());
        const logical = crlf
          ? content(11, 'selected', 'Independent β tail.').replaceAll('\n', '\r\n')
          : content(11, 'selected', 'Independent β tail.');
        const changed = `${prefix}${logical}${suffix}`;
        const logicalModel = new Map(
          order.filter(index => index !== 10).map(index => [uri(index), sha256HexSync(content(index))]),
        );
        logicalModel.set(uri(11), sha256HexSync(logical));
        for (const candidate of [f, reverse]) {
          yield* candidate.store.write(candidate.location, uri(11), changed, {mode: 'replace'});
          yield* candidate.store.remove(candidate.location, uri(10));
          candidate.model.set(uri(11), sha256HexSync(changed));
          candidate.model.delete(uri(10));
        }
        const a = yield* settle(f, budget, true);
        const b = yield* settle(reverse, 9 - budget, true);
        expect(pairs(a.result.hashes)).toEqual(pairs(f.model));
        expect(pairs(b.result.hashes)).toEqual(pairs(reverse.model));
        expect(pairs(a.result.hashes)).toEqual(pairs(b.result.hashes));
        expect(pairs(a.result.canonicalContentHashes)).toEqual(pairs(logicalModel));
        expect(pairs(b.result.canonicalContentHashes)).toEqual(pairs(logicalModel));
        expect(a.result.generation).toBe(b.result.generation);
        const before = yield* f.store.read(f.location, uri(11));
        const again = yield* f.prepare(budget);
        expect(again.complete).toBe(true);
        expect(pairs(again.hashes)).toEqual(pairs(f.model));
        expect(pairs(again.canonicalContentHashes)).toEqual(pairs(logicalModel));
        expect(yield* f.store.read(f.location, uri(11))).toBe(before);
      }).pipe(TestClock.withLive, provide),
    {fastCheck: {numRuns: 8, seed: 80408}, timeout: 30000},
  );
});
