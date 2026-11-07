/* oxlint-disable effecttsgo/strict-effect-provide -- Each scoped Effect test is a narrow filesystem/crypto/lock entrypoint. */
import {it as effectIt} from '@effect/vitest';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {Array as EffectArray, Clock, Effect, FileSystem, Layer, Path, Schema, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {createSemanticProposal} from '@threadnote/semantic/proposals';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {makeSemanticProposalStore, semanticProposalStoreLimits} from '../../src/semantic/proposal_store.js';
import {LspFault} from '../../src/semantic/lsp_transport.js';

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, cryptoLayer, TestSystemInfoLayer);
const binding = sha256HexSync('worktree/profile/runtime');
const proposal = (beforeText = 'old') => {
  const observation = {
    version: 1,
    repository: 'repo',
    worktree: 'file:///worktree',
    project: 'file:///worktree/project',
    configuration: sha256HexSync('config'),
    toolchain: sha256HexSync('toolchain'),
    provider: {id: 'test', version: '1', generation: 1},
    view: {kind: 'disk', id: 'view', owner: 'owner', epoch: 1},
    uri: 'file:///worktree/project/main.ts',
    content: sha256HexSync(beforeText),
    documentVersion: null,
    projectEpoch: 1,
  };
  return createSemanticProposal(
    {
      version: 1,
      operation: 'rename',
      evidence: {basis: 'semantic', observation, scope: 'project', completeness: 'complete', limitations: []},
      targets: [
        {
          observation,
          beforeText,
          edits: [{range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}, newText: 'new'}],
          precondition: {
            sourceKind: 'disk',
            rawDigest: observation.content,
            encoding: 'utf-8',
            physicalIdentity: 'owned-inode',
            owner: 'owner',
            documentVersion: null,
          },
        },
      ],
    },
    sha256HexSync,
  );
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'semantic-proposal-'}));
  const directory = path.join(home, 'proposals');
  const store = yield* makeSemanticProposalStore({directory, namespace: 'first'});
  return {fs, path, home, directory, store};
});
const rejected = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  Effect.gen(function* () {
    const error = yield* effect.pipe(Effect.flip);
    expect(Schema.is(LspFault)(error)).toBe(true);
  });

describe('private semantic proposal retention', () => {
  effectIt.effect(
    'requires exact binding, capability and digest, and returns immutable historical previews after restart',
    () =>
      Effect.gen(function* () {
        const {store, directory, fs, path} = yield* fixture;
        const original = proposal();
        const retained = yield* store.retain(original, binding);
        expect(retained.handle.id).toMatch(/^[a-f0-9]{64}$/u);
        expect(retained.handle.capability).not.toBe(retained.handle.id);
        expect(retained.handle.digest).toBe(original.digest);
        const text = yield* fs.readFileString(path.join(directory, retained.handle.id + '.json'));
        expect(text).not.toContain(retained.handle.capability);
        yield* rejected(store.get(retained.handle, sha256HexSync('different principal')));
        yield* rejected(store.get({...retained.handle, capability: sha256HexSync('wrong capability')}, binding));
        yield* rejected(store.get({...retained.handle, digest: sha256HexSync('wrong digest')}, binding));
        yield* rejected(store.get({...retained.handle, id: '../escape'}, binding));
        const first = yield* store.get(retained.handle, binding);
        expect(first.proposal).toEqual(original);
        expect(first.stale).toBe(false);
        expect(Object.isFrozen(first.proposal.targets[0])).toBe(true);
        const restarted = yield* makeSemanticProposalStore({directory, namespace: 'second'});
        const historical = yield* restarted.get(retained.handle, binding);
        expect(historical.stale).toBe(true);
        expect(historical.expiresAt).toBe(retained.expiresAt);
        expect(historical.proposal).toEqual(original);
        yield* rejected(store.discard(retained.handle, sha256HexSync('different principal')));
        yield* rejected(store.discard({...retained.handle, capability: sha256HexSync('wrong')}, binding));
        yield* rejected(restarted.discard(retained.handle, binding));
        yield* store.discard(retained.handle, binding);
        yield* rejected(store.get(retained.handle, binding));
      }).pipe(Effect.provide(layer)),
  );

  effectIt.effect('rejects altered after images, source payloads, symlinks and hardlink aliases', () =>
    Effect.gen(function* () {
      const {store, directory, home, fs, path} = yield* fixture;
      const retained = yield* store.retain(proposal(), binding);
      const file = path.join(directory, retained.handle.id + '.json');
      const original = yield* fs.readFileString(file);
      yield* fs.writeFileString(file, EffectString.replace('"namespace":"first"', '"namespace":"second"')(original));
      const restarted = yield* makeSemanticProposalStore({directory, namespace: 'second'});
      yield* rejected(restarted.get(retained.handle, binding));
      // Keep a valid digest while corrupting only a derived field, which the factory would otherwise discard.
      yield* fs.writeFileString(file, EffectString.replace('"afterText":"new"', '"afterText":"bad"')(original));
      yield* rejected(store.get(retained.handle, binding));
      yield* fs.writeFileString(file, EffectString.replace('"beforeText":"old"', '"beforeText":"bad"')(original));
      yield* rejected(store.get(retained.handle, binding));
      yield* fs.writeFileString(file, original);
      const alias = path.join(home, 'alias');
      yield* fs.link(file, alias);
      yield* rejected(store.get(retained.handle, binding));
      yield* fs.remove(alias);
      yield* fs.rename(file, alias);
      yield* fs.symlink(alias, file);
      yield* rejected(store.get(retained.handle, binding));
    }).pipe(Effect.provide(layer)),
  );

  effectIt.effect('enforces absolute expiry and persists a clock high water mark across restart', () =>
    Effect.gen(function* () {
      const {store, directory} = yield* fixture;
      yield* TestClock.setTime(10000);
      const retained = yield* store.retain(proposal(), binding);
      yield* TestClock.adjust(5000);
      expect((yield* store.get(retained.handle, binding)).expiresAt).toBe(retained.expiresAt);
      yield* TestClock.setTime(14000);
      const restarted = yield* makeSemanticProposalStore({directory, namespace: 'second'});
      yield* rejected(restarted.get(retained.handle, binding));
      yield* TestClock.setTime(retained.expiresAt);
      yield* rejected(restarted.get(retained.handle, binding));
      yield* TestClock.setTime(10000);
      yield* rejected(restarted.get(retained.handle, binding));
    }).pipe(Effect.provide(layer)),
  );

  effectIt.effect('refuses count capacity without evicting valid proposals and cleans expired entries', () =>
    Effect.gen(function* () {
      const {store, fs, directory} = yield* fixture;
      const handles = [];
      for (let index = 0; index < semanticProposalStoreLimits.maxProposals; index++)
        handles.push(yield* store.retain(proposal(), binding));
      yield* rejected(store.retain(proposal(), binding));
      expect((yield* store.get(handles[0].handle, binding)).proposal).toEqual(proposal());
      yield* TestClock.adjust(semanticProposalStoreLimits.ttlMilliseconds);
      yield* store.prune();
      expect(
        EffectArray.filter(yield* fs.readDirectory(directory), name => /^[a-f0-9]{64}\.json$/u.test(name)),
      ).toEqual([]);
      yield* store.retain(proposal(), binding);
    }).pipe(Effect.provide(layer)),
  );

  effectIt.effect('accounts for complete serialized blobs in aggregate capacity', () =>
    Effect.gen(function* () {
      const {store, fs, directory, path} = yield* fixture;
      const large = proposal('old' + EffectString.repeat(1024 * 1024)('x'));
      const first = yield* store.retain(large, binding);
      const bytes = Number((yield* fs.stat(path.join(directory, first.handle.id + '.json'))).size);
      const count = Math.floor(semanticProposalStoreLimits.maxRetainedBytes / bytes);
      for (let index = 1; index < count; index++) yield* store.retain(large, binding);
      yield* rejected(store.retain(large, binding));
      expect((yield* store.get(first.handle, binding)).proposal.digest).toBe(large.digest);
      expect(count * bytes).toBeLessThanOrEqual(semanticProposalStoreLimits.maxRetainedBytes);
      expect((count + 1) * bytes).toBeGreaterThan(semanticProposalStoreLimits.maxRetainedBytes);
    }).pipe(Effect.provide(layer)),
  );

  effectIt.effect('recovers interrupted exclusive publication and refuses replaced or nonprivate directories', () =>
    Effect.gen(function* () {
      const {store, fs, directory, path} = yield* fixture;
      const retained = yield* store.retain(proposal(), binding);
      yield* fs.link(
        path.join(directory, retained.handle.id + '.json'),
        path.join(directory, retained.handle.id + '.tmp'),
      );
      expect((yield* store.get(retained.handle, binding)).proposal).toEqual(proposal());
      expect(EffectArray.some(yield* fs.readDirectory(directory), name => /\.tmp$/u.test(name))).toBe(false);
      yield* fs.chmod(directory, 0o755);
      yield* rejected(store.get(retained.handle, binding));
      yield* fs.chmod(directory, 0o700);
      yield* fs.rename(directory, directory + '-old');
      yield* fs.makeDirectory(directory, {mode: 0o700});
      yield* rejected(store.get(retained.handle, binding));
    }).pipe(Effect.provide(layer)),
  );

  effectIt.effect('serializes distinct store instances at the count boundary', () =>
    Effect.gen(function* () {
      const {store, directory} = yield* fixture;
      yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis));
      for (let index = 0; index < semanticProposalStoreLimits.maxProposals - 1; index++)
        yield* store.retain(proposal(), binding);
      const other = yield* makeSemanticProposalStore({directory, namespace: 'second'});
      // Real file-lock contention and lease heartbeat use live time, independently of deterministic TTL tests.
      const outcomes = yield* TestClock.withLive(
        Effect.all(
          [
            store.retain(proposal(), binding).pipe(Effect.result),
            other.retain(proposal(), binding).pipe(Effect.result),
          ],
          {concurrency: 2},
        ),
      );
      expect(EffectArray.filter(outcomes, result => result._tag === 'Success')).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );
});
