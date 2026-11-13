/* oxlint-disable effecttsgo/strict-effect-provide -- Each test is a scoped native filesystem/authority entrypoint with one narrow layer. */
import {dlopen} from 'bun:ffi';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {
  Array as EffectArray,
  Arbitrary,
  Clock,
  Deferred,
  Fiber,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Option,
  Record as EffectRecord,
  Schema,
  String as EffectString,
} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, vi} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import * as Native from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  SystemInfo,
  runtimeOpenPrivateWriterDirectory,
  runtimeReadPrivateWriterFile,
  runtimeClosePrivateWriterDirectory,
  runtimePublishPrivateWriterFile,
} from '@threadnote/platform/system';
import {observationKey, type QueryOutcome} from '@threadnote/semantic/contracts';
import {makeSemanticProposalStore} from '../../src/semantic/proposal_store.js';
import {
  WindowsSourceProof,
  makeWindowsSemanticSources,
  takeSemanticPrepared,
  SemanticSessionFault,
} from '../../src/semantic/source_evidence.js';
import {
  prepareSemanticEndpointDirectory,
  withSemanticEndpointLock,
  readSemanticEndpointBootstrap,
  publishSemanticEndpointBootstrap,
} from '../../src/semantic/admission.js';
import {createSemanticProposal} from '@threadnote/semantic/proposals';
import {restoreApplyJournal} from '@threadnote/semantic/journal';
import {makeSemanticWriterAuthorityFromDirectory} from '../../src/semantic/writer_authority.js';
import {makeSemanticHostWriterFromAuthority} from '../../src/semantic/writer.js';
import {
  semanticHostProfileName,
  writeSemanticHostProfile,
  inspectSemanticHostProfile,
} from '../../src/semantic/host_profile.js';
import {makeSemanticAgentChanges} from '../../src/semantic/agent_changes.js';
import type {SemanticRequest} from '../../src/semantic/coordinator.js';
import {SemanticWriterAdmissionRequest, SemanticWriterProposal} from '../../src/semantic/agent_change_protocol.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

const layer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, cryptoLayer);
const supported = Native.runtimeNativePlatformSupport().writer;
const reorderObjectKeys = (value: unknown, shifts: readonly number[], depth = 0): unknown => {
  if (EffectArray.isArray(value)) return EffectArray.map(value, child => reorderObjectKeys(child, shifts, depth + 1));
  if (!Predicate.isObject(value)) return value;
  const entries = EffectRecord.toEntries(value);
  const shift = shifts[depth % shifts.length];
  const offset = shift % Math.max(1, entries.length);
  const rotated = [...EffectArray.drop(entries, offset), ...EffectArray.take(entries, offset)];
  return EffectRecord.fromEntries(
    EffectArray.map(shift % 2 ? EffectArray.reverse(rotated) : rotated, ([key, child]) => [
      key,
      reorderObjectKeys(child, shifts, depth + 1),
    ]),
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
  const system = yield* SystemInfo;
  const temporaryDirectory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-real-writer-'}));
  const directory =
    Native.runtimePlatform === 'win32'
      ? yield* Effect.sync(() => protectedFixtureRoot(temporaryDirectory))
      : temporaryDirectory;
  const root = path.join(directory, 'repository');
  const sourceRoot = path.join(root, 'project');
  const home = path.join(directory, 'private');
  const authorityHome = path.join(directory, 'authority');
  if (Native.runtimePlatform === 'win32') {
    const base = yield* Effect.acquireRelease(
      Effect.sync(() => Native.runtimeOpenPrivateWriterDirectory(directory)),
      value => Effect.sync(() => Native.runtimeClosePrivateWriterDirectory(value)),
    );
    for (const name of ['private', 'authority']) {
      const child = Native.runtimeOpenPrivateWriterChild(base, name, true);
      Native.runtimeClosePrivateWriterDirectory(child);
    }
    for (const folder of [root, sourceRoot]) yield* fs.makeDirectory(folder, {mode: 0o700});
  } else for (const folder of [root, sourceRoot, home, authorityHome]) yield* fs.makeDirectory(folder, {mode: 0o700});
  const worktree = (yield* path.toFileUrl(root)).href;
  const config = {
    account: 'local',
    user: 'writer-test',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(home, 'manifest.json'),
  };
  const principal = EffectString.slice(0, -5)(semanticHostProfileName(config, worktree));
  const profile = JSON.stringify({version: 1, enabled: true, worktree, catalog: {}});
  if (Native.runtimePlatform === 'win32') {
    yield* writeSemanticHostProfile(config, worktree, {version: 1, enabled: true, worktree, catalog: {}});
  } else {
    yield* fs.makeDirectory(path.join(home, 'semantic', 'profiles'), {recursive: true, mode: 0o700});
    yield* fs.writeFileString(path.join(home, 'semantic', 'profiles', principal + '.json'), profile, {mode: 0o600});
  }
  const sources = ['export const old = 1;\r\n', 'export const old = 2;\n'];
  const targets = [];
  for (const [index, beforeText] of sources.entries()) {
    const file = path.join(sourceRoot, `${index}.ts`);
    yield* fs.writeFileString(file, beforeText);
    const info = yield* fs.stat(file);
    if (info.ino._tag === 'None') return yield* Effect.die('Fixture inode unavailable');
    const observation = {
      version: 1 as const,
      repository: 'fixture',
      worktree,
      project: worktree,
      configuration: sha256HexSync('configuration'),
      toolchain: sha256HexSync('toolchain'),
      provider: {id: 'owning-layer-fixture', version: '1', generation: 1},
      view: {kind: 'disk' as const, id: 'disk', owner: principal, epoch: 1},
      uri: (yield* path.toFileUrl(file)).href,
      content: sha256HexSync(beforeText),
      documentVersion: null,
      projectEpoch: 1,
    };
    targets.push({
      observation,
      beforeText,
      edits: [{range: {start: {line: 0, character: 13}, end: {line: 0, character: 16}}, newText: 'fresh'}],
      precondition: {
        sourceKind: 'disk' as const,
        rawDigest: observation.content,
        encoding: 'utf-8' as const,
        physicalIdentity: JSON.stringify([String(info.dev), String(info.ino.value)]),
        owner: principal,
        documentVersion: null,
      },
    });
  }
  const proposal = createSemanticProposal(
    {
      version: 1,
      operation: 'rename',
      evidence: {
        basis: 'semantic',
        observation: targets[0].observation,
        scope: 'project',
        completeness: 'partial',
        limitations: [],
      },
      targets,
    },
    sha256HexSync,
  );
  const processStartIdentity = system.canonicalProcessStartIdentity
    ? yield* system.canonicalProcessStartIdentity(system.processId)
    : undefined;
  if (!processStartIdentity) return yield* Effect.die('Fixture process identity unavailable');
  const session = {
    processId: system.processId,
    processStartIdentity,
    boot: sha256HexSync('fixture-boot'),
    runtimeIdentity: sha256HexSync('fixture-runtime'),
  };
  let handle = {id: sha256HexSync('preview'), digest: proposal.digest, capability: sha256HexSync('read-capability')};
  const scope = {root, worktree, home, principal};
  const resolved: {
    proposal: typeof proposal;
    session: typeof session;
    profile: string;
    expiresAt: number;
    windows?: import('../../src/semantic/proposal_store.js').WindowsRetainedProof;
  } = {
    proposal,
    session,
    profile: sha256HexSync(profile),
    expiresAt: (yield* Clock.currentTimeMillis) + 600000,
  };
  const guardedDirectory = yield* Effect.acquireRelease(
    Effect.sync(() => runtimeOpenPrivateWriterDirectory(authorityHome)),
    directory => Effect.sync(() => runtimeClosePrivateWriterDirectory(directory)),
  );
  const authority = yield* makeSemanticWriterAuthorityFromDirectory(guardedDirectory);
  const writer = yield* makeSemanticHostWriterFromAuthority(authority);
  if (Native.runtimePlatform === 'win32') {
    const proof: WindowsSourceProof = {
      version: 1,
      platform: 'win32',
      targets: EffectArray.map(proposal.targets, (target, ordinal) => {
        const captured = Native.runtimeCaptureWindowsSource(root, ['project', `${ordinal}.ts`], 4 * 1024 * 1024);
        return {
          ordinal,
          uri: target.observation.uri,
          rawDigest: sha256HexSync(captured.bytes),
          observationKey: observationKey(target.observation),
          ...Native.runtimeExportWindowsSourceWitness(captured.evidence),
        };
      }),
    };
    const store = yield* makeSemanticProposalStore({directory: path.join(home, 'proposals'), namespace: session.boot});
    const binding = sha256HexSync(JSON.stringify([worktree, principal, resolved.profile, session.runtimeIdentity]));
    const retained = yield* store.retain(proposal, binding, proof);
    handle = retained.handle;
    const historical = yield* store.get(handle, binding);
    const transferred = yield* Schema.decodeUnknownEffect(SemanticWriterProposal, {onExcessProperty: 'error'})(
      JSON.parse(
        JSON.stringify({
          version: 2,
          status: 'writer-proposal',
          worktree,
          principal,
          profile: resolved.profile,
          proposal: historical.proposal,
          session,
          expiresAt: historical.expiresAt,
          windows: historical.windows,
        }),
      ),
    );
    if (transferred.version !== 2) return yield* Effect.die('Windows private resolve version missing');
    resolved.windows = transferred.windows;
    resolved.expiresAt = transferred.expiresAt;
  }
  const admissionRequest = {
    version: 1 as const,
    callerCwd: root,
    handle,
    taskAuthorization: 'Fixture task authorizes exact rename',
    diskOwnership: 'closed-disk' as const,
  };
  const admit = () =>
    Schema.decodeEffect(SemanticWriterAdmissionRequest)(admissionRequest).pipe(
      Effect.flatMap(request => writer.admit(scope, request, resolved)),
      Effect.flatMap(result =>
        'writer' in result && result.writer ? Effect.succeed(result.writer) : Effect.die('Fixture admission refused'),
      ),
    );
  const refresh = () =>
    Effect.succeed({
      ...resolved,
      endpoint: {request: () => Effect.succeed({version: 1, status: 'invalidated'})},
      request: {
        version: 1 as const,
        action: 'resolve-for-writer' as const,
        worktree,
        principal,
        profile: resolved.profile,
        handle,
        maxBytes: 8 * 1024 * 1024,
        milliseconds: 10000,
      },
    });
  return {
    fs,
    path,
    root,
    sourceRoot,
    home,
    authorityHome,
    directory,
    sources,
    proposal,
    scope,
    resolved,
    authority,
    writer,
    admissionRequest,
    admit,
    refresh,
  };
});

effectIt.effect.skipIf(!supported)(
  'public admission decoding preserves native writer authentication through retirement',
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        const raw: unknown = JSON.parse(JSON.stringify(f.admissionRequest));
        const request = yield* Schema.decodeUnknownEffect(SemanticWriterAdmissionRequest)(raw);
        expect(EffectRecord.keys(request.handle)).toEqual(['id', 'capability', 'digest']);
        const admitted = yield* f.writer.admit(f.scope, request, f.resolved);
        if (!('writer' in admitted) || !admitted.writer) return yield* Effect.die('Public-shaped admission refused');
        const handle = admitted.writer;
        const record = yield* f.writer.resolve(f.scope, handle);
        expect((yield* f.writer.status(f.scope, handle)).status).toBe('not-started');
        expect((yield* f.writer.apply(f.scope, handle, record, f.refresh)).status).toBe('applied');
        expect((yield* f.writer.recover(f.scope, handle, record)).status).toBe('applied');
        expect((yield* f.writer.retire(f.scope, handle, 'terminal', request.taskAuthorization)).status).toBe('retired');
        for (const [index, target] of f.proposal.targets.entries())
          expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(target.afterText);
      }),
    ).pipe(Effect.provide(layer)),
);

describe.skipIf(!supported)('native admission serialization', () => {
  effectIt.effect('authenticates reordered values through the real decoder and capability verifier', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        const handle = yield* f.admit();
        const original = yield* f.writer.resolve(f.scope, handle);
        const name = handle.operation + '.admission.json';
        const seeded = runtimeReadPrivateWriterFile(f.authority.directory, name, 16 * 1024 * 1024);
        if (!seeded) return yield* Effect.die('Seeded admission bytes unavailable');
        const serialized: unknown = JSON.parse(JSON.stringify(original));
        let currentBytes = new Uint8Array();
        let reads = 0;
        let served: Uint8Array | undefined;
        const unexpectedIo = (): never => {
          throw new Error('Unexpected I/O in value-authentication property');
        };
        const authority = new Proxy(f.authority, {
          get(target, key) {
            if (key === 'directory') return target.directory;
            if (key === 'withOperation')
              return <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
                operation === handle.operation
                  ? effect
                  : Effect.die('Unexpected operation in value-authentication property');
            return unexpectedIo();
          },
        });
        const retire = Effect.gen(function* () {
          expect(
            (yield* f.writer.retire(f.scope, handle, 'discarded', 'Explicit property fixture cleanup')).status,
          ).toBe('retired');
        });
        yield* Effect.acquireUseRelease(
          Effect.sync(() => [
            vi.spyOn(Native, 'runtimeReadPrivateWriterFile').mockImplementation((directory, filename, maximum) => {
              if (directory !== f.authority.directory || filename !== name || maximum !== 16 * 1024 * 1024)
                return unexpectedIo();
              reads++;
              served = currentBytes.slice();
              return {...seeded, bytes: served};
            }),
            vi.spyOn(Native, 'runtimePublishPrivateWriterFile').mockImplementation(unexpectedIo),
            vi.spyOn(Native, 'runtimeRemovePrivateWriterFile').mockImplementation(unexpectedIo),
            vi.spyOn(Native, 'runtimeOpenWriterRoot').mockImplementation(unexpectedIo),
            vi.spyOn(Native, 'runtimeOpenGuardedDiskTarget').mockImplementation(unexpectedIo),
            vi.spyOn(Native, 'runtimeCommitGuardedDiskTarget').mockImplementation(unexpectedIo),
          ]),
          () =>
            Effect.gen(function* () {
              const isolated = yield* makeSemanticHostWriterFromAuthority(authority).pipe(
                Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
              );
              const checkRead = (before: number) => {
                expect(reads).toBe(before + 1);
                expect(served).not.toBe(currentBytes);
                expect(served).toEqual(currentBytes);
              };
              const authenticatePermutation = (shifts: readonly number[]) =>
                Effect.gen(function* () {
                  const reordered = reorderObjectKeys(serialized, shifts);
                  expect(reordered).toEqual(serialized); // Values and material array order are the independent model.
                  currentBytes = new TextEncoder().encode(JSON.stringify(reordered));
                  const before = reads;
                  expect(yield* isolated.resolve(f.scope, handle)).toEqual(original);
                  checkRead(before);
                  return true;
                });
              // Require a changed encoding even if the generated rotations happen to be identities.
              expect(JSON.stringify(reorderObjectKeys(serialized, [1]))).not.toBe(JSON.stringify(serialized));
              yield* authenticatePermutation([1]);
              const result = yield* Arbitrary.checkEffect(
                Arbitrary.schema(
                  Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 65535}))).check(
                    Schema.isMinLength(1),
                    Schema.isMaxLength(12),
                  ),
                ),
                authenticatePermutation,
                {runs: 8},
              );
              const failure = Arbitrary.formatCheckFailure(result);
              if (failure !== undefined) return yield* Effect.die(new Error(failure));
              const before = reads;
              const wrong = sha256HexSync('wrong-value-property-capability');
              const capability = wrong === handle.capability ? sha256HexSync('other-wrong-capability') : wrong;
              expect(yield* isolated.resolve(f.scope, {...handle, capability}).pipe(Effect.flip)).toMatchObject({
                _tag: 'ApplyFault',
                reason: 'unauthorized',
              });
              checkRead(before);
            }),
          spies =>
            Effect.sync(() => {
              for (const spy of spies) spy.mockRestore();
            }),
        ).pipe(Effect.ensuring(retire.pipe(Effect.orDie)));
        expect(serialized).toEqual(original);
        for (const [index, source] of f.sources.entries())
          expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(source);
      }),
    ).pipe(Effect.provide(layer)),
  );
  effectIt.effect('publishes one nonidentity native key ordering and authenticates it through retirement', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        const handle = yield* f.admit();
        const original = yield* f.writer.resolve(f.scope, handle);
        const serialized: unknown = JSON.parse(JSON.stringify(original));
        const reordered = reorderObjectKeys(serialized, [1]);
        expect(reordered).toEqual(serialized);
        expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(serialized));
        yield* f.authority.withAdmission(
          handle.operation,
          Effect.sync(() => {
            const result = runtimePublishPrivateWriterFile(
              f.authority.directory,
              handle.operation + '.admission.json',
              new TextEncoder().encode(JSON.stringify(reordered)),
              {
                mode: 'replace',
                nonce: sha256HexSync('key-order-roundtrip'),
                assertCurrentSync: () => f.authority.assertOperationSync(handle.operation),
              },
            );
            expect(result.status).toBe('published');
          }),
        );
        expect(yield* f.writer.resolve(f.scope, handle)).toEqual(original);
        expect((yield* f.writer.status(f.scope, handle)).status).toBe('not-started');
        expect(
          (yield* f.writer.retire(f.scope, handle, 'discarded', 'Explicit native ordering fixture cleanup')).status,
        ).toBe('retired');
        for (const [index, source] of f.sources.entries())
          expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(source);
      }),
    ).pipe(Effect.provide(layer)),
  );
});

effectIt.effect.skipIf(!supported)(
  'rejects changed admission values, target order and unsupported preview verifiers',
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        const handle = yield* f.admit();
        const record = yield* f.writer.resolve(f.scope, handle);
        const name = handle.operation + '.admission.json';
        const replace = (value: unknown) =>
          f.authority.withAdmission(
            handle.operation,
            Effect.sync(() => {
              const result = runtimePublishPrivateWriterFile(
                f.authority.directory,
                name,
                new TextEncoder().encode(JSON.stringify(value)),
                {
                  mode: 'replace',
                  nonce: sha256HexSync('tampered-value-fixture'),
                  assertCurrentSync: () => f.authority.assertOperationSync(handle.operation),
                },
              );
              expect(result.status).toBe('published');
            }),
          );
        expect(
          (yield* f.writer
            .resolve(f.scope, {...handle, capability: sha256HexSync('wrong-writer-secret')})
            .pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(
          (yield* f.writer
            .resolve({...f.scope, principal: sha256HexSync('other-principal')}, handle)
            .pipe(Effect.result))._tag,
        ).toBe('Failure');
        const tampered = [
          {...record, operation: sha256HexSync('other-operation')},
          {...record, profile: sha256HexSync('other-profile')},
          {...record, expiresAt: record.expiresAt + 1},
          {...record, rootIdentity: {...record.rootIdentity, ino: record.rootIdentity.ino + '1'}},
          {...record, handle: {...record.handle, capability: sha256HexSync('other-read-secret')}},
          {
            ...record,
            session: {...record.session, processStartIdentity: record.session.processStartIdentity + '-different'},
          },
          {...record, session: {...record.session, runtimeIdentity: sha256HexSync('other-runtime')}},
          {...record, taskAuthorization: sha256HexSync('other-task')},
          {
            ...record,
            claims: EffectArray.map(record.claims, (claim, index) =>
              index === 0 ? {...claim, owner: 'other-owner'} : claim,
            ),
          },
          {
            ...record,
            owners: EffectArray.map(record.owners, (owner, index) =>
              index === 0
                ? {...owner, observation: {...owner.observation, projectEpoch: owner.observation.projectEpoch + 1}}
                : owner,
            ),
          },
          {...record, claims: EffectArray.reverse(record.claims), owners: EffectArray.reverse(record.owners)},
        ];
        for (const value of tampered) {
          yield* replace(value);
          expect((yield* f.writer.resolve(f.scope, handle).pipe(Effect.result))._tag).toBe('Failure');
        }
        yield* replace(record);
        expect(yield* f.writer.resolve(f.scope, handle)).toEqual(record);
        // The old unqualified preview encoding is retained as evidence, never migrated or accepted.
        const preview = {
          ...record,
          capabilityVerifier: sha256HexSync(
            JSON.stringify([
              'threadnote-writer-admission-v1',
              handle.capability,
              record.operation,
              record.principal,
              record.worktree,
              record.home,
              record.profile,
              record.createdAt,
              record.expiresAt,
              record.rootIdentity,
              record.handle,
              record.session,
              record.taskAuthorization,
              record.diskOwnership,
              f.proposal.digest,
              record.claims,
              record.owners,
            ]),
          ),
        };
        yield* replace(preview);
        expect((yield* f.writer.resolve(f.scope, handle).pipe(Effect.result))._tag).toBe('Failure');
        expect(
          (yield* f.writer.retire(f.scope, handle, 'discarded', 'No preview migration').pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(
          JSON.parse(
            new TextDecoder().decode(
              runtimeReadPrivateWriterFile(f.authority.directory, name, 16 * 1024 * 1024)!.bytes,
            ),
          ),
        ).toEqual(preview);
        expect(
          runtimeReadPrivateWriterFile(f.authority.directory, handle.operation + '.started.json', 16384),
        ).toBeUndefined();
        expect(
          runtimeReadPrivateWriterFile(f.authority.directory, handle.operation + '.journal.json', 16 * 1024 * 1024),
        ).toBeUndefined();
        for (const [index, original] of f.sources.entries())
          expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(original);
      }),
    ).pipe(Effect.provide(layer)),
);

effectIt.effect.skipIf(!supported)(
  'committed admission registration with lost acknowledgement remains recoverable',
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        const interrupted = yield* makeSemanticHostWriterFromAuthority({
          ...f.authority,
          registerOperation: ref =>
            f.authority.registerOperation(ref).pipe(Effect.andThen(Effect.fail('Registration acknowledgement lost'))),
        });
        expect((yield* interrupted.admit(f.scope, f.admissionRequest, f.resolved).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        const refs = yield* f.authority.withAdmission('inspect-admission-cut', f.authority.listOperations);
        expect(refs).toHaveLength(1);
        const operation = refs[0].operation;
        const admission = runtimeReadPrivateWriterFile(
          f.authority.directory,
          operation + '.admission.json',
          16 * 1024 * 1024,
        );
        expect(admission).toBeDefined();
        expect(JSON.parse(new TextDecoder().decode(admission!.bytes))).toMatchObject({operation});
        expect(runtimeReadPrivateWriterFile(f.authority.directory, operation + '.started.json', 16384)).toBeUndefined();
        expect(
          runtimeReadPrivateWriterFile(f.authority.directory, operation + '.journal.json', 16 * 1024 * 1024),
        ).toBeUndefined();
        const next = yield* f.admit();
        expect(next.operation).not.toBe(operation);
        const journal = restoreApplyJournal(
          JSON.parse(
            new TextDecoder().decode(
              runtimeReadPrivateWriterFile(f.authority.directory, operation + '.journal.json', 16 * 1024 * 1024)!.bytes,
            ),
          ),
        );
        expect(
          EffectArray.every(journal.results, result => result.state === 'conflict' || result.state === 'unwritten'),
        ).toBe(true);
        expect(runtimeReadPrivateWriterFile(f.authority.directory, operation + '.started.json', 16384)).toBeDefined();
        for (const [index, original] of f.sources.entries())
          expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(original);
      }),
    ).pipe(Effect.provide(layer)),
);

for (const cut of ['complete-admission', 'partial-admission'] as const) {
  effectIt.effect.skipIf(!supported)(`unindexed ${cut} is safely discarded before a fresh admission`, () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        let operation: string | undefined;
        const interrupted = yield* makeSemanticHostWriterFromAuthority({
          ...f.authority,
          enrollResources: (session, resources, id) =>
            f.authority.enrollResources(session, resources, id).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  operation = id;
                }),
              ),
              Effect.filterOrElse(
                () => cut === 'complete-admission',
                () =>
                  Effect.sync(() => {
                    // Exact post-create crash state: malformed private bytes, no index, START or journal.
                    const result = runtimePublishPrivateWriterFile(
                      f.authority.directory,
                      id + '.admission.json',
                      new TextEncoder().encode('{"version":1,"proposal":'),
                      {
                        mode: 'exclusive',
                        nonce: sha256HexSync('partial-publication-cut'),
                        assertCurrentSync: () => f.authority.assertOperationSync(id),
                      },
                    );
                    expect(result.status).toBe('published');
                  }).pipe(Effect.andThen(Effect.fail('Interrupted partial admission publication'))),
              ),
            ),
          registerOperation: () => Effect.fail('Interrupted before index registration'),
        });
        expect((yield* interrupted.admit(f.scope, f.admissionRequest, f.resolved).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        expect(operation).toBeDefined();
        expect(yield* f.authority.withAdmission('inspect-unindexed', f.authority.listOperations)).toHaveLength(0);
        const name = operation + '.admission.json';
        expect(runtimeReadPrivateWriterFile(f.authority.directory, name, 16 * 1024 * 1024)).toBeDefined();
        yield* f.admit();
        expect(runtimeReadPrivateWriterFile(f.authority.directory, name, 16 * 1024 * 1024)).toBeUndefined();
        expect(runtimeReadPrivateWriterFile(f.authority.directory, operation + '.started.json', 16384)).toBeUndefined();
        expect(
          runtimeReadPrivateWriterFile(f.authority.directory, operation + '.journal.json', 16 * 1024 * 1024),
        ).toBeUndefined();
        // Repeating normal admission neither resurrects the cleaned ID nor writes source.
        yield* f.admit();
        expect(runtimeReadPrivateWriterFile(f.authority.directory, name, 16 * 1024 * 1024)).toBeUndefined();
        for (const [index, original] of f.sources.entries())
          expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(original);
      }),
    ).pipe(Effect.provide(layer)),
  );
}

for (const evidence of ['started', 'journal'] as const) {
  effectIt.effect.skipIf(!supported)(
    `unindexed admission with ${evidence} evidence is retained and refuses issuance`,
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const f = yield* fixture;
          const operation = sha256HexSync('unindexed-' + evidence);
          const pending = '.pending-' + sha256HexSync('unattributable-temp');
          const names = [operation + '.admission.json', operation + '.' + evidence + '.json', pending];
          yield* f.authority.withAdmission(
            operation,
            Effect.sync(() => {
              for (const [index, name] of names.entries()) {
                const result = runtimePublishPrivateWriterFile(
                  f.authority.directory,
                  name,
                  new TextEncoder().encode('unconfirmed'),
                  {
                    mode: 'exclusive',
                    nonce: sha256HexSync('retention-fixture-' + index),
                    assertCurrentSync: () => f.authority.assertOperationSync(operation),
                  },
                );
                expect(result.status).toBe('published');
              }
            }),
          );
          expect((yield* f.writer.admit(f.scope, f.admissionRequest, f.resolved).pipe(Effect.result))._tag).toBe(
            'Failure',
          );
          expect(yield* f.authority.withAdmission('inspect-retained', f.authority.listOperations)).toHaveLength(0);
          for (const name of names)
            expect(
              new TextDecoder().decode(runtimeReadPrivateWriterFile(f.authority.directory, name, 16384)!.bytes),
            ).toBe('unconfirmed');
          for (const [index, original] of f.sources.entries())
            expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(original);
        }),
      ).pipe(Effect.provide(layer)),
  );
}

effectIt.effect.skipIf(!supported)('actual native admission applies once and recovery preserves later disk edits', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture;
      const handle = yield* f.admit();
      const record = yield* f.writer.resolve(f.scope, handle);
      expect((yield* f.writer.status(f.scope, handle)).status).toBe('not-started');
      const receipt = yield* f.writer.apply(f.scope, handle, record, f.refresh);
      expect(receipt.status).toBe('applied');
      for (const [index, target] of f.proposal.targets.entries())
        expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(target.afterText);
      // No graph service is injected: this real native boundary case does not claim graph invalidation qualification.
      expect(receipt.invalidation).toBe('pending');
      expect((yield* f.writer.status(f.scope, handle)).observationBasis).toBe('last-recorded');
      const journal = yield* f.authority.withOperation(
        handle.operation,
        Effect.sync(() => {
          const file = runtimeReadPrivateWriterFile(
            f.authority.directory,
            handle.operation + '.journal.json',
            16 * 1024 * 1024,
          );
          return restoreApplyJournal(JSON.parse(new TextDecoder().decode(file!.bytes)));
        }),
      );
      expect(EffectArray.every(journal.results, result => result.state === 'applied')).toBe(true);
      yield* f.fs.writeFileString(f.path.join(f.sourceRoot, '0.ts'), 'later user edit');
      const recovered = yield* f.writer.recover(f.scope, handle, record);
      expect(recovered.status).toBe('applied');
      expect(recovered.targets[0].observed).toBe('diverged');
      expect(
        (yield* f.writer.apply(f.scope, handle, record, () => Effect.die('Retry reloaded the provider'))).targets[0]
          .observed,
      ).toBe('diverged');
      expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, '0.ts'))).toBe('later user edit');
    }),
  ).pipe(Effect.provide(layer)),
);

effectIt.effect.skipIf(!supported)(
  'interrupted invalidation keeps the durable journal pending and never replays target writes',
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        const handle = yield* f.admit();
        const record = yield* f.writer.resolve(f.scope, handle);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const refresh = () =>
          f.refresh().pipe(
            Effect.map(fresh => ({
              ...fresh,
              endpoint: {
                request: (body: SemanticRequest) =>
                  Effect.gen(function* () {
                    expect(body.operation).toBe('agent-change');
                    if (body.operation !== 'agent-change') throw new Error('Unexpected fixture RPC');
                    expect(body.request.action).toBe('invalidate-for-writer');
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release).pipe(
                      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                    );
                    return {version: 1, status: 'invalidated'};
                  }),
              },
            })),
          );
        yield* Effect.gen(function* () {
          const applying = yield* Effect.forkChild(f.writer.apply(f.scope, handle, record, refresh));
          yield* Deferred.await(entered);
          for (const [index, target] of f.proposal.targets.entries())
            expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(target.afterText);
          const cancelled = yield* Fiber.interrupt(applying).pipe(Effect.timeoutOption(1000));
          expect(cancelled._tag).toBe('Some');
          expect((yield* Fiber.await(applying))._tag).toBe('Failure');
          expect((yield* Deferred.await(interrupted).pipe(Effect.timeoutOption(1000)))._tag).toBe('Some');
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        const journal = yield* f.authority.withOperation(
          handle.operation,
          Effect.sync(() => {
            const file = runtimeReadPrivateWriterFile(
              f.authority.directory,
              handle.operation + '.journal.json',
              16 * 1024 * 1024,
            );
            return restoreApplyJournal(JSON.parse(new TextDecoder().decode(file!.bytes)));
          }),
        );
        expect(journal.invalidation).toBe('pending');
        expect(EffectArray.every(journal.results, result => result.state === 'applied')).toBe(true);
        yield* f.fs.writeFileString(f.path.join(f.sourceRoot, '0.ts'), 'later user edit');
        const recovered = yield* f.writer.recover(f.scope, handle, record);
        expect(recovered.invalidation).toBe('pending');
        expect(recovered.targets[0].observed).toBe('diverged');
        yield* f.writer.apply(f.scope, handle, record, () =>
          Effect.die('Retry must not refresh or replay source writes'),
        );
        expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, '0.ts'))).toBe('later user edit');
        for (const [index, target] of f.proposal.targets.entries())
          if (index !== 0)
            expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(target.afterText);
      }),
    ).pipe(Effect.provide(layer)),
);

effectIt.effect.skipIf(!supported)('started-without-journal refuses replay until explicit local discard', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture;
      const handle = yield* f.admit();
      const record = yield* f.writer.resolve(f.scope, handle);
      // Exact crash cut: the durable consumed-start marker exists, but core has not published its first journal.
      yield* f.authority.withOperation(
        handle.operation,
        Effect.sync(() => {
          const result = runtimePublishPrivateWriterFile(
            f.authority.directory,
            handle.operation + '.started.json',
            new TextEncoder().encode(
              JSON.stringify({version: 1, operation: handle.operation, proposal: f.proposal.digest}),
            ),
            {
              mode: 'exclusive',
              nonce: sha256HexSync('start-boundary-fixture'),
              assertCurrentSync: () => f.authority.assertOperationSync(handle.operation),
            },
          );
          expect(result.status).toBe('published');
        }),
      );
      expect(
        yield* f.writer
          .apply(f.scope, handle, record, () => Effect.die('Consumed operation requested a new provider proposal'))
          .pipe(Effect.flip),
      ).toBeDefined();
      expect(yield* f.writer.recover(f.scope, handle, record).pipe(Effect.flip)).toBeDefined();
      expect(
        yield* f.writer.retire(f.scope, handle, 'terminal', 'Attempt normal cleanup').pipe(Effect.flip),
      ).toBeDefined();
      expect(
        (yield* f.writer.retire(f.scope, handle, 'discarded', 'Explicitly discard interrupted fixture evidence'))
          .status,
      ).toBe('retired');
      expect(yield* f.writer.resolve(f.scope, handle).pipe(Effect.flip)).toBeDefined();
      for (const [index, original] of f.sources.entries())
        expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, `${index}.ts`))).toBe(original);
    }),
  ).pipe(Effect.provide(layer)),
);

effectIt.effect.skipIf(!supported)('shared resource registry rejects an alternate URI for one physical file', () =>
  TestClock.withLive(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.admit();
      const physicalIdentity = f.proposal.targets[0].precondition.physicalIdentity;
      if (!physicalIdentity) return yield* Effect.die('Fixture physical identity unavailable');
      const operation = sha256HexSync('alias-refusal');
      const refused = yield* f.authority
        .withAdmission(
          operation,
          f.authority.enrollResources(
            f.resolved.session,
            [{canonicalUri: f.scope.worktree + '/alternate-spelling.ts', physicalIdentity}],
            operation,
          ),
        )
        .pipe(Effect.flip);
      expect(refused).toMatchObject({reason: 'identity'});
      expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, '0.ts'))).toBe(f.sources[0]);
    }),
  ).pipe(Effect.provide(layer)),
);

effectIt.effect.skipIf(!supported)(
  'actual target preflight and mid-apply conditional guards preserve concurrent bytes',
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        const handle = yield* f.admit();
        const record = yield* f.writer.resolve(f.scope, handle);
        let first = true;
        // A trusted authority adapter interposition models a nonparticipating edit exactly after the
        // first real target critical section. No production hook or source writer is replaced.
        const interposed = {
          ...f.authority,
          withTarget: <A, E, R>(claim: (typeof record.claims)[number], effect: Effect.Effect<A, E, R>) =>
            f.authority.withTarget(claim, effect).pipe(
              Effect.tap(() => {
                if (!first || claim.canonicalUri !== f.proposal.targets[0].observation.uri) return Effect.void;
                // Initial preflight also enters target gates. Wait until real bytes prove target1 was applied.
                return f.fs.readFileString(f.path.join(f.sourceRoot, '0.ts')).pipe(
                  Effect.flatMap(content => {
                    if (content !== f.proposal.targets[0].afterText) return Effect.void;
                    first = false;
                    return f.fs.writeFileString(f.path.join(f.sourceRoot, '1.ts'), 'concurrent user bytes');
                  }),
                );
              }),
            ),
        };
        const writer = yield* makeSemanticHostWriterFromAuthority(interposed);
        const receipt = yield* writer.apply(f.scope, handle, record, f.refresh);
        expect(receipt.status).toBe('partial');
        expect(receipt.targets[0].state).toBe('applied');
        expect(receipt.targets[1].state).toBe('conflict');
        expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, '1.ts'))).toBe('concurrent user bytes');
        yield* writer.recover(f.scope, handle, record);
        expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, '1.ts'))).toBe('concurrent user bytes');
      }),
    ).pipe(Effect.provide(layer)),
);

effectIt.effect.skipIf(!supported)(
  'actual shared authority hands over nested roots across two private homes and retires without replay',
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        const firstHandle = yield* f.admit();
        const firstRecord = yield* f.writer.resolve(f.scope, firstHandle);
        expect(yield* f.writer.apply(f.scope, firstHandle, firstRecord, f.refresh)).toMatchObject({status: 'applied'});
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
              stdin: 'ignore',
              stdout: 'ignore',
              stderr: 'ignore',
            }),
          ),
          process =>
            Effect.gen(function* () {
              process.kill('SIGTERM');
              const stopped = yield* Effect.tryPromise(() => process.exited).pipe(
                Effect.orDie,
                Effect.timeoutOption(2000),
              );
              if (stopped._tag === 'None') {
                process.kill('SIGKILL');
                const killed = yield* Effect.tryPromise(() => process.exited).pipe(
                  Effect.orDie,
                  Effect.timeoutOption(2000),
                );
                if (killed._tag === 'None') return yield* Effect.die('Owned writer fixture process did not exit');
              }
            }),
        );
        const system = yield* SystemInfo;
        const processStartIdentity = system.canonicalProcessStartIdentity
          ? yield* system.canonicalProcessStartIdentity(child.pid)
          : undefined;
        if (!processStartIdentity) return yield* Effect.die('Second owner identity unavailable');
        const home = f.path.join(f.directory, 'second-private');
        yield* f.fs.makeDirectory(f.path.join(home, 'semantic', 'profiles'), {recursive: true, mode: 0o700});
        const worktree = (yield* f.path.toFileUrl(f.sourceRoot)).href;
        const principal = EffectString.slice(
          0,
          -5,
        )(semanticHostProfileName({account: 'local', user: 'writer-test'}, worktree));
        const profile = JSON.stringify({version: 1, enabled: true, worktree, catalog: {}});
        yield* f.fs.writeFileString(f.path.join(home, 'semantic', 'profiles', principal + '.json'), profile, {
          mode: 0o600,
        });
        const targets = [];
        for (const target of f.proposal.targets) {
          const filename = yield* f.path.fromFileUrl(new URL(target.observation.uri));
          const beforeText = yield* f.fs.readFileString(filename);
          const observation = {
            ...target.observation,
            worktree,
            project: worktree,
            content: sha256HexSync(beforeText),
            view: {...target.observation.view, owner: principal, epoch: 2},
          };
          targets.push({
            observation,
            beforeText,
            edits: [{range: {start: {line: 0, character: 13}, end: {line: 0, character: 18}}, newText: 'next'}],
            precondition: {...target.precondition, rawDigest: observation.content, owner: principal},
          });
        }
        const proposal = createSemanticProposal(
          {
            version: 1,
            operation: 'rename',
            evidence: {...f.proposal.evidence, observation: targets[0].observation},
            targets,
          },
          sha256HexSync,
        );
        // These are two real owner processes on one runtime. They are not two supported runtime artifacts/A10 proof.
        const session = {
          ...f.resolved.session,
          processId: child.pid,
          processStartIdentity,
          boot: sha256HexSync('second-owner-session'),
        };
        const resolved = {...f.resolved, proposal, session, profile: sha256HexSync(profile)};
        const scope = {root: f.sourceRoot, worktree, home, principal};
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => runtimeOpenPrivateWriterDirectory(f.authorityHome)),
          directory => Effect.sync(() => runtimeClosePrivateWriterDirectory(directory)),
        );
        const authority = yield* makeSemanticWriterAuthorityFromDirectory(reader);
        const writer = yield* makeSemanticHostWriterFromAuthority(authority);
        expect(yield* writer.resolve(scope, firstHandle).pipe(Effect.flip)).toBeDefined();
        const readHandle = {
          id: sha256HexSync('second-preview'),
          digest: proposal.digest,
          capability: sha256HexSync('second-read-capability'),
        };
        const admitted = yield* writer.admit(
          scope,
          {
            version: 1,
            callerCwd: scope.root,
            handle: readHandle,
            taskAuthorization: 'Authorize exact next rename',
            diskOwnership: 'closed-disk',
          },
          resolved,
        );
        if (!('writer' in admitted) || !admitted.writer) return yield* Effect.die('Handover admission refused');
        const secondHandle = admitted.writer;
        const secondRecord = yield* writer.resolve(scope, secondHandle);
        expect(secondRecord.claims[0].fence).toBeGreaterThan(firstRecord.claims[0].fence);
        const oldReceipt = yield* f.writer.recover(f.scope, firstHandle, firstRecord);
        expect(oldReceipt.targets[0].ownership).toBe('changed');
        expect(
          yield* f.authority
            .withOperation(
              firstHandle.operation,
              f.authority.withTarget(firstRecord.claims[0], Effect.die('Stale owner entered native mutation')),
            )
            .pipe(Effect.flip),
        ).toBeDefined();
        const refresh = () =>
          Effect.succeed({
            ...resolved,
            endpoint: {request: () => Effect.succeed({version: 1, status: 'invalidated'})},
            request: {
              version: 1 as const,
              action: 'resolve-for-writer' as const,
              worktree,
              principal,
              profile: resolved.profile,
              handle: readHandle,
              milliseconds: 10000,
              maxBytes: 8 * 1024 * 1024,
            },
          });
        expect((yield* writer.apply(scope, secondHandle, secondRecord, refresh)).status).toBe('applied');
        const currentText = yield* f.fs.readFileString(f.path.join(f.sourceRoot, '0.ts'));
        expect((yield* writer.retire(scope, secondHandle, 'terminal', 'Retire completed fixture')).status).toBe(
          'retired',
        );
        expect(yield* writer.resolve(scope, secondHandle).pipe(Effect.flip)).toBeDefined();
        expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, '0.ts'))).toBe(currentText);
        yield* f.writer.retire(f.scope, firstHandle, 'terminal', 'Retire first completed fixture');
        const refs = yield* authority.withAdmission('fixture-inventory', authority.listOperations);
        expect(refs).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
  10000,
);

// Exact owning Windows private store→Admission→retained source mutation→lost-ack recovery boundary.
// It uses synthetic provider edits and real native source history; it is not provider/platform GA evidence.
effectIt.effect.skipIf(process.platform !== 'win32')(
  'retains Windows v2 native history and reconciles lost result acknowledgement without replaying later edits',
  () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(Native.runtimeNativePlatformSupport().writer).toBe(false);
        expect(f.resolved.windows?.proof.kind).toBe('complete');
        const handle = yield* f.admit(),
          record = yield* f.writer.resolve(f.scope, handle);
        expect(record.version).toBe(2);
        let withheld = false;
        const original = Native.runtimePublishPrivateWriterFile;
        const publish = vi
          .spyOn(Native, 'runtimePublishPrivateWriterFile')
          .mockImplementation((directory, name, bytes, input) => {
            const result = original(directory, name, bytes, input);
            if (
              !withheld &&
              result.status === 'published' &&
              EffectString.endsWith('.journal.json')(name) &&
              EffectString.includes('"state":"applied"')(new TextDecoder().decode(bytes))
            ) {
              withheld = true;
              throw new Error('Fixture lost result acknowledgement');
            }
            return result;
          });
        const mutate = vi.spyOn(Native, 'runtimeCommitGuardedDiskTarget');
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            publish.mockRestore();
            mutate.mockRestore();
          }),
        );
        yield* f.writer.apply(f.scope, handle, record, f.refresh);
        expect(withheld).toBe(true);
        expect(mutate).toHaveBeenCalledTimes(1);
        yield* f.fs.writeFileString(f.path.join(f.sourceRoot, '0.ts'), 'later Windows edit');
        const recovered = yield* f.writer.recover(f.scope, handle, record);
        expect(recovered.targets[0].observed).toBe('diverged');
        yield* f.writer.apply(f.scope, handle, record, () => Effect.die('Existing operation must not refresh'));
        expect(mutate).toHaveBeenCalledTimes(1);
        expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, '0.ts'))).toBe('later Windows edit');
      }),
    ).pipe(Effect.provide(layer)),
);

// Exact native bootstrap boundary, without spawning any provider or coordinator child.
effectIt.effect.skipIf(process.platform !== 'win32')(
  'authenticates the endpoint directory and lease before native bootstrap publication and preserves occupied bytes',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const directory = f.path.join(f.home, 'semantic', 'endpoint-fixture');
      const retained = yield* prepareSemanticEndpointDirectory(directory);
      const value = '{"version":1,"bootstrap":"private fixture"}';
      yield* withSemanticEndpointLock(directory, retained, 'startup.lock', 250, assertCurrentSync =>
        publishSemanticEndpointBootstrap(directory, retained, value, assertCurrentSync),
      );
      expect(yield* readSemanticEndpointBootstrap(f.path.join(directory, 'host.json'))).toBe(value);
      const occupied = Native.runtimeReadPrivateWriterFile(retained!, 'host.json', 16 * 1024)!;
      expect(
        (yield* withSemanticEndpointLock(directory, retained, 'startup.lock', 250, assertCurrentSync =>
          publishSemanticEndpointBootstrap(directory, retained, 'foreign replacement', assertCurrentSync),
        ).pipe(Effect.result))._tag,
      ).toBe('Failure');
      // Failed publication conserves its one-shot capability; a separate reader only observes the occupied value.
      const inspection = yield* prepareSemanticEndpointDirectory(directory, false);
      const after = Native.runtimeReadPrivateWriterFile(inspection!, 'host.json', 16 * 1024)!;
      expect(after.bytes).toEqual(occupied.bytes);
      expect(after.identity).toEqual(occupied.identity);
      const failedDirectory = f.path.join(f.home, 'semantic', 'endpoint-lost-lease');
      const failed = yield* prepareSemanticEndpointDirectory(failedDirectory);
      expect(
        (yield* publishSemanticEndpointBootstrap(failedDirectory, failed, value, () => {
          throw new Error('Fixture lease lost before mutation');
        }).pipe(Effect.result))._tag,
      ).toBe('Failure');
      expect(yield* f.fs.exists(f.path.join(failedDirectory, 'host.json'))).toBe(false);
    }).pipe(TestClock.withLive, Effect.provide(layer)),
);

// Setup may provision missing protected children beneath the actual OS account home, never repair that home's ACL.
effectIt.effect.skipIf(process.platform !== 'win32')(
  'cold Windows setup creates its private home from the actual account-home owner while inspection stays read-only',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const account = Native.runtimeReadStableOsUserIdentity();
      const nativeFs = process.getBuiltinModule('fs');
      for (const failAfterSetup of [false, true]) {
        const home = f.path.join(
          account.accountHome,
          '.threadnote-host-setup-test-' +
            EffectString.slice(0, 24)(sha256HexSync(f.directory)) +
            (failAfterSetup ? '-failure' : '-success'),
        );
        expect(yield* f.fs.exists(home)).toBe(false);
        const config = {
          account: 'local',
          user: 'writer-test',
          agentId: 'test',
          agentContextHome: home,
          manifestPath: f.path.join(home, 'manifest.json'),
        };
        const profile = {version: 1, enabled: true, worktree: f.scope.worktree, catalog: {}};
        const name = semanticHostProfileName(config, f.scope.worktree);
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            let attempted = false,
              pending = false;
            let root: Native.RuntimePrivateWriterDirectory | undefined;
            let semantic: Native.RuntimePrivateWriterDirectory | undefined;
            let profiles: Native.RuntimePrivateWriterDirectory | undefined;
            let profileIdentity: Native.RuntimeWriterIdentity | undefined;
            let occupiedIdentity: Native.RuntimeWriterIdentity | undefined;
            // Register before setup can create anything outside the scoped temporary fixture.
            yield* Effect.addFinalizer(exit =>
              Effect.gen(function* () {
                const cleanup = yield* Effect.try(() => {
                  if (!attempted) return;
                  if (pending || !root || !semantic || !profiles || !profileIdentity)
                    throw new Error('Cold setup ownership or I/O is unconfirmed');
                  const assertOwned = () => {
                    Native.runtimeAssertPrivateWriterDirectoryCurrent(root!);
                    Native.runtimeAssertPrivateWriterDirectoryCurrent(semantic!);
                    Native.runtimeAssertPrivateWriterDirectoryCurrent(profiles!);
                  };
                  assertOwned();
                  // Exact known tree only: any foreign entry or pending publication conserves the whole fixture.
                  expect(nativeFs.readdirSync(home).sort()).toEqual(
                    occupiedIdentity ? ['semantic', 'unsafe-existing'] : ['semantic'],
                  );
                  expect(nativeFs.readdirSync(semantic.path)).toEqual(['profiles']);
                  expect(nativeFs.readdirSync(profiles.path)).toEqual([name]);
                  Native.runtimeRemovePrivateWriterFile(profiles, name, profileIdentity, assertOwned);
                  if (occupiedIdentity)
                    Native.runtimeRemovePrivateWriterFile(root, 'unsafe-existing', occupiedIdentity, assertOwned);
                  // Empty-directory removal is synchronous and immediately preceded by retained native identity/security proof.
                  Native.runtimeAssertPrivateWriterDirectoryCurrent(profiles);
                  nativeFs.rmdirSync(profiles.path);
                  Native.runtimeClosePrivateWriterDirectory(profiles);
                  profiles = undefined;
                  Native.runtimeAssertPrivateWriterDirectoryCurrent(semantic);
                  nativeFs.rmdirSync(semantic.path);
                  Native.runtimeClosePrivateWriterDirectory(semantic);
                  semantic = undefined;
                  Native.runtimeAssertPrivateWriterDirectoryCurrent(root);
                  nativeFs.rmdirSync(home);
                  Native.runtimeClosePrivateWriterDirectory(root);
                  root = undefined;
                }).pipe(Effect.result);
                if (cleanup._tag === 'Failure') {
                  // Never retry/delete/close a foreign, uncertain or pending-I/O tree; preserve the original test failure.
                  yield* Effect.logError(
                    'Retained cold Windows setup fixture: ownership or I/O cleanup remains unconfirmed',
                  );
                  if (Exit.isSuccess(exit))
                    return yield* Effect.die(new Error('Cold Windows fixture retained for inspection'));
                }
              }),
            );
            expect((yield* inspectSemanticHostProfile(config, f.scope.worktree).pipe(Effect.result))._tag).toBe(
              'Failure',
            );
            expect(yield* f.fs.exists(home)).toBe(false);
            // Setup and its ownership receipt form one uninterruptible acquisition cut, with release already registered.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                attempted = true;
                pending = true;
                yield* writeSemanticHostProfile(config, f.scope.worktree, profile);
                yield* Effect.sync(() => {
                  root = Native.runtimeOpenPrivateWriterDirectory(home);
                  semantic = Native.runtimeOpenPrivateWriterChild(root, 'semantic', false);
                  profiles = Native.runtimeOpenPrivateWriterChild(semantic, 'profiles', false);
                  const file = Native.runtimeReadPrivateWriterFile(profiles, name, 16 * 1024);
                  expect(file?.bytes).toEqual(new TextEncoder().encode(JSON.stringify(profile)));
                  profileIdentity = file!.identity;
                  pending = false;
                });
              }),
            );
            if (failAfterSetup) return yield* Effect.fail('Controlled failure after owned cold setup');
            expect((yield* inspectSemanticHostProfile(config, f.scope.worktree)).profile).toEqual(profile);
            const occupied = f.path.join(home, 'unsafe-existing');
            yield* Effect.sync(() => {
              pending = true;
              const published = Native.runtimePublishPrivateWriterFile(
                root!,
                'unsafe-existing',
                new TextEncoder().encode('FOREIGN_OCCUPIED_FIXTURE'),
                {
                  mode: 'exclusive',
                  nonce: sha256HexSync('owned-cold-setup-sentinel'),
                  assertCurrentSync: () => Native.runtimeAssertPrivateWriterDirectoryCurrent(root!),
                },
              );
              expect(published.status).toBe('published');
              if (published.status !== 'published') throw new Error('Fixture sentinel publication unconfirmed');
              occupiedIdentity = published.identity;
              pending = false;
            });
            const before = yield* f.fs.stat(occupied);
            expect(() => Native.runtimeProvisionPrivateWriterDirectory(occupied)).toThrow();
            expect(yield* f.fs.readFileString(occupied)).toBe('FOREIGN_OCCUPIED_FIXTURE');
            const after = yield* f.fs.stat(occupied);
            expect(after.ino).toEqual(before.ino);
            expect(after.dev).toEqual(before.dev);
            expect(after.birthtime).toEqual(before.birthtime);
          }),
        ).pipe(Effect.result);
        if (failAfterSetup)
          expect(result).toMatchObject({_tag: 'Failure', failure: 'Controlled failure after owned cold setup'});
        else if (result._tag === 'Failure') return yield* Effect.fail(result.failure);
        expect(yield* f.fs.exists(home)).toBe(false);
      }
    }).pipe(TestClock.withLive, Effect.provide(layer)),
);

// Synthetic provider result, genuine issuer FIRST capture and native protected store/publication path.
effectIt.effect.skipIf(process.platform !== 'win32')(
  'publishes only complete issued Windows FIRST proof and applies the final view fence before returning a preview',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const target = f.proposal.targets[0],
        observed = target.observation,
        text = f.sources[0];
      const sources = yield* makeWindowsSemanticSources(f.root, observed, text);
      const first = yield* sources.capture(observed.uri);
      yield* sources.port.beforeUpsert(first, undefined);
      yield* sources.port.bind(first, observed);
      let missing = true,
        rejectPublication = false,
        assertions = 0;
      const changes = yield* makeSemanticAgentChanges(
        {
          attach: () => Effect.succeed({observation: observed}),
          use: () => Effect.die('Unexpected provider execution'),
          usePrepared: () =>
            Effect.gen(function* () {
              const result: QueryOutcome = {
                version: 1,
                status: 'ok',
                evidence: {
                  basis: 'semantic',
                  observation: observed,
                  scope: 'project',
                  completeness: 'complete',
                  limitations: [],
                },
                items: [
                  {
                    kind: 'prepared-edit',
                    operation: 'rename',
                    sourceBasis: 'pre-request-synchronized-text-v1',
                    files: [
                      {
                        uri: observed.uri,
                        content: first.content,
                        source: 'disk',
                        observation: observed,
                        beforeText: text,
                        edits: [
                          {range: {start: {line: 0, character: 13}, end: {line: 0, character: 16}}, newText: 'fresh'},
                        ],
                        precondition: {
                          sourceKind: 'disk',
                          rawDigest: observed.content,
                          encoding: 'utf-8',
                          physicalIdentity: target.precondition.physicalIdentity!,
                          owner: observed.view.owner,
                          documentVersion: null,
                        },
                      },
                    ],
                  },
                ],
              };
              yield* sources.port.prepared(result, [{capture: first, observation: observed}]);
              const taken = takeSemanticPrepared(result, sources, () => true);
              if (taken.kind !== 'writer-prepared') return yield* Effect.die('Genuine FIRST fixture not issued');
              return {
                ...taken,
                ...(missing ? {privateSourceProof: undefined} : {}),
                assertCurrentSync: () => {
                  assertions++;
                  taken.assertCurrentSync();
                  if (rejectPublication) throw SemanticSessionFault.make({reason: 'stale'});
                },
              };
            }),
          observe: () => Effect.succeed(observed),
        },
        {
          directory: f.path.join(f.home, 'native-publication-fixture'),
          profileHome: f.home,
          worktree: f.scope.worktree,
          runtimeIdentity: f.resolved.session.runtimeIdentity,
        },
      );
      const request = {
        version: 1 as const,
        action: 'prepare' as const,
        worktree: f.scope.worktree,
        principal: f.scope.principal,
        profile: f.resolved.profile,
        project: observed.project,
        uri: observed.uri,
        language: 'typescript' as const,
        operation: 'rename' as const,
        position: {line: 0, character: 14},
        newName: 'fresh',
        milliseconds: 10000,
        maxBytes: 65536,
      };
      expect(yield* changes.execute(request, observed)).toMatchObject({status: 'stale'});
      expect(assertions).toBe(0);
      missing = false;
      rejectPublication = true;
      expect(yield* changes.execute(request, observed)).toMatchObject({status: 'stale'});
      expect(assertions).toBe(1);
      rejectPublication = false;
      const prepared = yield* changes.execute(request, observed);
      expect(prepared).toMatchObject({status: 'ok', applicable: false, writerAuthorityRequired: true});
      expect(assertions).toBe(2);
      expect(JSON.stringify(prepared)).not.toMatch(
        /privateSourceProof|fileId|volumeId|snapshot|native-publication-fixture/u,
      );
      expect(yield* f.fs.readFileString(f.path.join(f.sourceRoot, '0.ts'))).toBe(text);
    }).pipe(
      TestClock.withLive,
      Effect.provideService(ChildEnvironmentPolicy, {sanitizeExternal: env => env, preserveIntendedChild: env => env}),
      Effect.provide(layer),
    ),
);
