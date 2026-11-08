/* oxlint-disable effecttsgo/strict-effect-provide -- Each test is a scoped native filesystem/authority entrypoint with one narrow layer. */
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Array as EffectArray, Clock, Effect, FileSystem, Layer, Path, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  SystemInfo,
  runtimeOpenPrivateWriterDirectory,
  runtimeReadPrivateWriterFile,
  runtimeClosePrivateWriterDirectory,
  runtimePublishPrivateWriterFile,
} from '@threadnote/platform/system';
import {createSemanticProposal} from '@threadnote/semantic/proposals';
import {restoreApplyJournal} from '@threadnote/semantic/journal';
import {makeSemanticWriterAuthorityFromDirectory} from '../../src/semantic/writer_authority.js';
import {makeSemanticHostWriterFromAuthority} from '../../src/semantic/writer.js';
import {semanticHostProfileName} from '../../src/semantic/host_profile.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

const layer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, cryptoLayer);
const supported = process.platform === 'darwin' && process.arch === 'arm64';
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-real-writer-'}));
  const root = path.join(directory, 'repository');
  const sourceRoot = path.join(root, 'project');
  const home = path.join(directory, 'private');
  const authorityHome = path.join(directory, 'authority');
  for (const folder of [root, sourceRoot, home, authorityHome]) yield* fs.makeDirectory(folder, {mode: 0o700});
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
  yield* fs.makeDirectory(path.join(home, 'semantic', 'profiles'), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(path.join(home, 'semantic', 'profiles', principal + '.json'), profile, {mode: 0o600});
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
  const handle = {id: sha256HexSync('preview'), digest: proposal.digest, capability: sha256HexSync('read-capability')};
  const scope = {root, worktree, home, principal};
  const resolved = {
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
  const admit = () =>
    writer
      .admit(
        scope,
        {
          version: 1,
          callerCwd: root,
          handle,
          taskAuthorization: 'Fixture task authorizes exact rename',
          diskOwnership: 'closed-disk',
        },
        resolved,
      )
      .pipe(
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
    admit,
    refresh,
  };
});

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
        yield* f.writer.apply(f.scope, firstHandle, firstRecord, f.refresh);
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
