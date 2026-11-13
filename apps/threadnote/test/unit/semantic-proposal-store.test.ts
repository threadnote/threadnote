/* oxlint-disable effecttsgo/strict-effect-provide -- Each scoped Effect test is a narrow filesystem/crypto/lock entrypoint. */
import {it as effectIt} from '@effect/vitest';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {
  Array as EffectArray,
  Record as EffectRecord,
  Option,
  Clock,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  String as EffectString,
} from 'effect';
import {TestClock} from 'effect/testing';
import {dlopen} from 'bun:ffi';
import * as Native from '@threadnote/platform/system';
import fc from 'fast-check';
import {hmacSha256Hex} from '@threadnote/platform/hmac';
import {
  WindowsProofClosure,
  windowsProofDigest,
  assertWindowsProofTargets,
  windowsResourceIdentity,
} from '../../src/semantic/source_evidence.js';
import {authenticateWindowsRetainedProof, type WindowsRetainedProof} from '../../src/semantic/proposal_store.js';
import {describe, expect, it} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {observationKey} from '@threadnote/semantic/contracts';
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
const protectedFixtureRoot = (parent: string): string => {
  const kernel = dlopen('kernel32.dll', {
    GetSystemDirectoryW: {args: ['buffer', 'u32'], returns: 'u32'},
    CreateDirectoryW: {args: ['buffer', 'buffer'], returns: 'i32'},
    LocalFree: {args: ['u64'], returns: 'u64'},
  });
  const wide = (text: string) => {
    const result = new Uint16Array(text.length + 1);
    for (let index = 0; index < text.length; index++)
      result[index] = Option.getOrElse(EffectString.charCodeAt(index)(text), () => 0);
    return result;
  };
  const system = new Uint16Array(32768),
    count = kernel.symbols.GetSystemDirectoryW(system, system.length);
  expect(count > 2 && count < system.length).toBe(true);
  const systemPath = new TextDecoder('utf-16le').decode(new Uint8Array(system.buffer, 0, count * 2));
  const security = dlopen(systemPath + '\\advapi32.dll', {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {args: ['buffer', 'u32', 'buffer', 'ptr'], returns: 'i32'},
  });
  const descriptor = new BigUint64Array(1),
    path = parent + '\\protected';
  try {
    const principal = Native.runtimeReadStableOsUserIdentity().userId;
    expect(
      security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        wide(`O:${principal}D:P(A;;FA;;;${principal})`),
        1,
        descriptor,
        null,
      ),
    ).toBe(1);
    const attributes = new BigUint64Array(3);
    new DataView(attributes.buffer).setUint32(0, 24, true);
    attributes[1] = descriptor[0];
    expect(kernel.symbols.CreateDirectoryW(wide(path), attributes)).toBe(1);
    return process.getBuiltinModule('fs').realpathSync(path);
  } finally {
    if (descriptor[0] !== 0n) expect(kernel.symbols.LocalFree(descriptor[0])).toBe(0n);
    security.close();
    kernel.close();
  }
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'semantic-proposal-'}));
  const home =
    Native.runtimePlatform === 'win32' ? yield* Effect.sync(() => protectedFixtureRoot(temporary)) : temporary;
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
      if (Native.runtimePlatform === 'win32') return; // POSIX file symlink setup; real Windows junction refusal is owned by the native target fixture.
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

  effectIt.effect.skipIf(process.platform === 'win32')(
    'recovers interrupted exclusive publication and refuses replaced or nonprivate directories',
    () =>
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

it('authenticates complete Windows historical closure values and refuses any altered proof or binding without granting eligibility', () => {
  fc.assert(
    fc.property(
      fc.integer({min: 1, max: 1000}),
      fc.constantFrom(
        'object',
        'snapshot',
        'uri',
        'rawDigest',
        'observationKey',
        'binding',
        'namespace',
        'proposalDigest',
      ),
      (seed, field) => {
        const original = proposal('old' + String(seed));
        const closure = Schema.decodeSync(WindowsProofClosure)({
          kind: 'complete',
          proof: {
            version: 1,
            platform: 'win32',
            targets: EffectArray.map(original.targets, (target, ordinal) => ({
              ordinal,
              uri: target.observation.uri,
              rawDigest: target.precondition.rawDigest,
              observationKey: observationKey(target.observation),
              object: 'historical native object ' + seed,
              snapshot: 'historical native snapshot ' + seed,
            })),
          },
        });
        const capability = sha256HexSync('private capability ' + seed),
          handle = {id: sha256HexSync('id ' + seed), digest: original.digest, capability};
        const entry: WindowsRetainedProof = {
          version: 2,
          id: handle.id,
          proposalDigest: handle.digest,
          binding,
          namespace: 'boot',
          createdAt: seed,
          expiresAt: seed + semanticProposalStoreLimits.ttlMilliseconds,
          proof: closure,
          proofDigest: windowsProofDigest(closure),
          capabilityHash: '',
        };
        // Independent ordered protocol model. This test authenticates synthetic history, never native issuance.
        const sealed = {
          ...entry,
          capabilityHash: hmacSha256Hex(
            capability,
            JSON.stringify([
              'threadnote-semantic-preview-windows-v2',
              entry.id,
              entry.proposalDigest,
              binding,
              entry.namespace,
              entry.createdAt,
              entry.expiresAt,
              entry.proofDigest,
            ]),
          ),
        };
        const reordered = EffectRecord.fromEntries(EffectArray.reverse(EffectRecord.toEntries(sealed)));
        expect(authenticateWindowsRetainedProof(handle, binding, reordered).proofDigest).toBe(entry.proofDigest);
        const absent = {...entry, proof: {kind: 'absent' as const}, proofDigest: windowsProofDigest({kind: 'absent'})};
        const authenticatedAbsence = {
          ...absent,
          capabilityHash: hmacSha256Hex(
            capability,
            JSON.stringify([
              'threadnote-semantic-preview-windows-v2',
              absent.id,
              absent.proposalDigest,
              absent.binding,
              absent.namespace,
              absent.createdAt,
              absent.expiresAt,
              absent.proofDigest,
            ]),
          ),
        };
        expect(authenticateWindowsRetainedProof(handle, binding, authenticatedAbsence).proof.kind).toBe('absent');
        let changed = structuredClone(sealed);
        if (['object', 'snapshot', 'uri', 'rawDigest', 'observationKey'].includes(field)) {
          if (changed.proof.kind !== 'complete') throw new Error('Missing proof fixture');
          const row = changed.proof.proof.targets[0];
          const altered = {
            ...row,
            [field]: field === 'uri' ? 'file:///other.ts' : field === 'rawDigest' ? sha256HexSync('other') : 'altered',
          };
          const proof = {...changed.proof, proof: {...changed.proof.proof, targets: [altered]}};
          changed = {...changed, proof, proofDigest: windowsProofDigest(proof)};
        } else Object.assign(changed, {[field]: field === 'namespace' ? 'other-boot' : sha256HexSync('other')});
        expect(() => authenticateWindowsRetainedProof(handle, binding, changed)).toThrow();
        if (closure.kind === 'complete') {
          assertWindowsProofTargets(closure.proof, original);
          const row = closure.proof.targets[0];
          const low = '1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0',
            high = `1,0,0,0,0,0,0,0,${(seed % 255) + 1},0,0,0,0,0,0,0`;
          const nativeObject = (id: string) =>
            JSON.stringify(['S-1-5-21-1', [['name', 'path', '18446744073709551615', id, '123', 0, 'S-1-5-21-1', []]]]);
          expect(windowsResourceIdentity({...row, object: nativeObject(low)})).not.toBe(
            windowsResourceIdentity({...row, object: nativeObject(high)}),
          );
          expect(() => assertWindowsProofTargets({...closure.proof, targets: []}, original)).toThrow();
          expect(() =>
            assertWindowsProofTargets(
              {...closure.proof, targets: [...closure.proof.targets, ...closure.proof.targets]},
              original,
            ),
          ).toThrow();
        }
      },
    ),
    {numRuns: 32},
  );
});
