import {cryptoLayer} from '@threadnote/platform/crypto';
import {Digest as EffectDigest} from 'effect/crypto';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
/* oxlint-disable effecttsgo/strict-effect-provide -- Scoped Effect tests provide only filesystem/path/crypto services. */
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {ByteSize, Console, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {CommandExecutor} from '@threadnote/platform/command';
import {SemanticActionChoice} from '../../src/semantic/action_choices.js';
import {Observation} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {sha256FileHex} from '@threadnote/platform/digest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {LspFault, makeLspClient, spawnLspWire, type LspClient} from '../../src/semantic/lsp_transport.js';
import {makeSemanticNotifications, SemanticSessionFault, SemanticSetupFault} from '../../src/semantic/provider.js';
import {semanticSdkDigest, semanticTreeDigest} from '../../src/semantic/fingerprint.js';
import {
  ensureSemanticEndpoint,
  makeSemanticCoordinator,
  requestSemanticEndpoint,
  serveSemanticEndpoint,
  verifyNativeSemanticCandidate,
} from '../../src/semantic/coordinator.js';
import {
  goEnvironment,
  makeGoProject,
  makeGoSession,
  goExecutableDigest,
  parseGoModuleStream,
} from '../../src/semantic/providers/go.js';
import {
  rustEnvironment,
  makeRustProject,
  makeRustSession,
  rustExecutableDigest,
  rustProviderVersion,
} from '../../src/semantic/providers/rust.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
const io = Layer.merge(BunServices.layer, cryptoLayer);
const commands = TestCommandExecutorLayer.pipe(Layer.provide(Layer.merge(io, TestSystemInfoLayer)));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'semantic-go-rust-'}).pipe(Effect.flatMap(fs.realPath));
  return {fs, path, root};
});
const goView = Effect.gen(function* () {
  const f = yield* fixture;
  const text = 'package p\nvar value = missing\n';
  const file = f.path.join(f.root, 'main.go');
  yield* f.fs.writeFileString(file, text);
  const root = (yield* f.path.toFileUrl(f.root)).href;
  const uri = (yield* f.path.toFileUrl(file)).href;
  const basis: Observation = {
    version: 1,
    repository: 'go-fixture',
    worktree: root,
    project: root,
    configuration: EffectString.repeat(64)('a'),
    toolchain: EffectString.repeat(64)('b'),
    provider: {id: 'gopls', version: 'v0.24.0', generation: 0},
    view: {kind: 'overlay', id: 'go-view', owner: 'unit', epoch: 0},
    uri,
    content: sha256HexSync(text),
    documentVersion: 1,
    projectEpoch: 0,
  };
  const notifications = makeSemanticNotifications();
  const options = {
    basis,
    notifications,
    roots: [],
    profile: {kind: 'unit'},
    ready: Effect.void,
    startupMilliseconds: 1000,
    initializationOptions: {},
  };
  const edit = {
    documentChanges: [
      {
        textDocument: {uri, version: 1},
        edits: [{range: {start: {line: 1, character: 12}, end: {line: 1, character: 19}}, newText: '1'}],
      },
    ],
  };
  return {...f, text, file, uri, basis, notifications, options, edit};
});
const goClient = (request: LspClient['request']): LspClient => ({
  pid: 1,
  request: (method, params, ms) =>
    method === 'initialize'
      ? Effect.succeed({
          serverInfo: {name: 'gopls', version: JSON.stringify({Version: 'v0.24.0', GoVersion: 'go1.27.3'})},
          capabilities: {positionEncoding: 'utf-16', renameProvider: true, codeActionProvider: {resolveProvider: true}},
        })
      : method === 'textDocument/documentSymbol'
        ? Effect.succeed(null)
        : request(method, params, ms),
  notify: () => Effect.void,
  close: Effect.succeed({code: 0, drained: true, forced: false, stdioClosed: true, fault: undefined, graceful: true}),
});
describe('native semantic setup causes', () => {
  // Artifact admission is narrower than native process/private-storage implementation support.
  const hostHasNativeArtifacts = process.platform === 'darwin' && process.arch === 'arm64';
  for (const id of ['gopls', 'rust-analyzer'] as const) {
    effectIt.effect(
      `publishes control before selected ${id} verification and refuses missing or incompatible SDKs before preparation`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const worktree = f.path.join(f.root, 'source');
          yield* f.fs.makeDirectory(worktree, {mode: 0o700});
          const text = id === 'gopls' ? 'package p\nvar value = 1\n' : 'pub fn value() {}\n';
          const file = f.path.join(worktree, id === 'gopls' ? 'main.go' : 'lib.rs');
          yield* f.fs.writeFileString(file, text);
          const worktreeUri = (yield* f.path.toFileUrl(worktree)).href;
          const basis: Observation = {
            version: 1,
            repository: 'setup-fixture',
            worktree: worktreeUri,
            project: worktreeUri,
            configuration: EffectString.repeat(64)('a'),
            toolchain: EffectString.repeat(64)('b'),
            provider: {id, version: id === 'gopls' ? 'v0.24.0' : rustProviderVersion, generation: 0},
            view: {kind: 'disk', id: 'setup', owner: 'unit', epoch: 0},
            uri: (yield* f.path.toFileUrl(file)).href,
            content: sha256HexSync(text),
            documentVersion: null,
            projectEpoch: 0,
          };
          let launches = 0;
          const command = CommandExecutor.of({
            execute: () => Effect.die('Setup must not execute tools'),
            executeStreaming: () => Effect.die('Setup must not execute tools'),
            spawnDetached: () =>
              Effect.sync(() => {
                launches++;
                return true;
              }),
          });
          const candidate = {
            executable: f.path.join(f.root, 'missing-provider'),
            executableDigest: id === 'gopls' ? goExecutableDigest : rustExecutableDigest,
            sdkDirectory: f.path.join(f.root, 'missing-sdk'),
            sdkTreeDigest: EffectString.repeat(64)('a'),
          };
          const absent = yield* verifyNativeSemanticCandidate(undefined, id).pipe(Effect.flip);
          expect(absent).toMatchObject({providerId: id, reason: 'missing', component: 'provider'});
          const unsafeHome = yield* f.fs.makeTempDirectoryScoped({directory: worktree, prefix: 'unsafe-home-'});
          expect(
            yield* ensureSemanticEndpoint({
              enabled: true,
              dataHome: unsafeHome,
              worktree: worktreeUri,
              runtimeIdentity: EffectString.repeat(64)('c'),
              [id === 'gopls' ? 'go' : 'rust']: candidate,
            }).pipe(Effect.provideService(CommandExecutor, command), Effect.flip),
          ).toMatchObject({code: 'prerequisite'});
          expect(yield* f.fs.readDirectory(unsafeHome)).toEqual([]);
          for (const [reason, digest] of [
            ['missing', candidate.executableDigest],
            ['incompatible', EffectString.repeat(64)('b')],
          ] as const) {
            const home = yield* f.fs.makeTempDirectoryScoped({directory: f.root, prefix: 'home-'});
            const coordinator = yield* makeSemanticCoordinator({
              enabled: true,
              dataHome: home,
              worktree: worktreeUri,
              [id === 'gopls' ? 'go' : 'rust']: {...candidate, executableDigest: digest},
            }).pipe(Effect.provideService(CommandExecutor, command));
            const directory = yield* f.fs
              .makeTempDirectoryScoped({directory: '/tmp', prefix: 'tn-setup-http-'})
              .pipe(Effect.flatMap(f.fs.realPath));
            const token = EffectString.repeat(64)('c');
            const endpoint = yield* serveSemanticEndpoint(coordinator, {directory, token, worktree: worktreeUri});
            expect(yield* requestSemanticEndpoint(endpoint.socket, token, {operation: 'status'})).toMatchObject({
              experimental: true,
              sessions: 0,
              providers: 0,
            });
            const error = yield* coordinator.attach(basis, text, id === 'gopls' ? 'go' : 'rust').pipe(Effect.flip);
            expect(Schema.is(SemanticSetupFault)(error)).toBe(true);
            expect(error).toMatchObject({
              providerId: id,
              reason: reason === 'missing' && !hostHasNativeArtifacts ? 'incompatible' : reason,
              component: 'provider',
              requiredVersion: id === 'gopls' ? 'v0.24.0' : rustProviderVersion,
              requiredSdkVersion: id === 'gopls' ? '1.27.3' : '1.99.1',
              nextAction: expect.stringContaining('host-approved'),
            });
            expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
            expect(yield* f.fs.exists(f.path.join(home, 'semantic', 'environments'))).toBe(false);
            expect(yield* f.fs.readFileString(file)).toBe(text);
          }
          expect(launches).toBe(0);
        }).pipe(
          Effect.provide(Layer.mergeAll(io, TestSystemInfoLayer)),
          Effect.provideService(ChildEnvironmentPolicy, {
            sanitizeExternal: () => {
              throw new Error('SDK must refuse before provider launch');
            },
            preserveIntendedChild: env => env,
          }),
          TestClock.withLive,
        ),
    );
  }
  effectIt.effect('preserves bounded setup details across the coordinator HTTP boundary', () =>
    Effect.gen(function* () {
      const f = yield* goView;
      const fault = SemanticSetupFault.make({
        providerId: 'gopls',
        reason: 'missing',
        component: 'provider',
        requiredVersion: 'v0.24.0',
        requiredSdkVersion: '1.27.3',
        nextAction: 'Configure the host-approved gopls and Go artifacts',
      });
      const token = EffectString.repeat(64)('c');
      const socketDirectory = yield* f.fs
        .makeTempDirectoryScoped({directory: '/tmp', prefix: 'tn-http-'})
        .pipe(Effect.flatMap(f.fs.realPath));
      const endpoint = yield* serveSemanticEndpoint(
        {
          status: Effect.die('Unexpected status'),
          closeView: () => Effect.void,
          use: () => Effect.die('Unexpected query'),
          attach: () => Effect.fail(fault),
        },
        {directory: socketDirectory, token, worktree: f.basis.worktree},
      );
      const response = yield* requestSemanticEndpoint(endpoint.socket, token, {
        operation: 'attach',
        observation: f.basis,
        text: f.text,
        language: 'go',
      });
      expect(response).toEqual({
        status: 'unavailable',
        readOnly: true,
        reason: 'setup',
        setup: {
          providerId: 'gopls',
          reason: 'missing',
          component: 'provider',
          requiredVersion: 'v0.24.0',
          requiredSdkVersion: '1.27.3',
        },
        nextAction: fault.nextAction,
      });
      expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
    }).pipe(
      Effect.provide(Layer.merge(io, TestSystemInfoLayer)),
      Effect.provideService(ChildEnvironmentPolicy, {sanitizeExternal: env => env, preserveIntendedChild: env => env}),
      TestClock.withLive,
    ),
  );
});
describe('read-only code action resolution', () => {
  effectIt.effect('retains current native diagnostic context, validates resolved edits and rejects all commands', () =>
    Effect.gen(function* () {
      const f = yield* goView;
      const diagnostic = {
        range: {start: {line: 1, character: 12}, end: {line: 1, character: 19}},
        severity: 1,
        code: 'Undefined',
        source: 'compiler',
        message: 'undefined: missing',
        data: {fix: 'one'},
      };
      const calls: string[] = [];
      const session = yield* makeGoSession(
        goClient((method, params) =>
          Effect.sync((): Schema.Json => {
            calls.push(method);
            if (method === 'textDocument/codeAction') {
              expect(params).toMatchObject({context: {diagnostics: [diagnostic]}});
              return [
                {title: 'Fix', data: {fix: 'one'}},
                {title: 'Command', command: {command: 'untrusted'}},
                {title: 'Mixed', edit: f.edit, command: {command: 'untrusted'}},
                {title: 'Resolved command', data: {fix: 'command'}},
              ];
            }
            expect(method).toBe('codeAction/resolve');
            if (!Schema.is(Schema.Struct({data: Schema.Struct({fix: Schema.String})}))(params))
              throw new Error('Invalid resolve fixture parameters');
            return params.data.fix === 'one'
              ? {title: 'Fix', edit: f.edit}
              : {title: 'Resolved command', command: {command: 'untrusted'}};
          }),
        ),
        f.options,
      );
      const observation = yield* session.upsert(f.basis, f.text, 'go', 1000);
      f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: [diagnostic]});
      const result = yield* session.prepare('code-action', observation, {line: 1, character: 12}, undefined, 1000);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.evidence.observation).toEqual(observation);
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
          title: 'Fix',
          applied: false,
          files: [
            {uri: f.uri, content: sha256HexSync(f.text), documentVersion: 1, edits: f.edit.documentChanges[0].edits},
          ],
        });
      }
      expect(calls).toEqual(['textDocument/codeAction', 'codeAction/resolve', 'codeAction/resolve']);
      expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('fences an action resolved after its source view changes', () =>
    Effect.gen(function* () {
      const f = yield* goView;
      const entered = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Schema.Json>();
      const session = yield* makeGoSession(
        goClient(method =>
          method === 'textDocument/codeAction'
            ? Effect.succeed([{title: 'Fix', data: {}}])
            : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(response))),
        ),
        f.options,
      );
      const first = yield* session.upsert(f.basis, f.text, 'go', 1000);
      const pending = yield* Effect.forkChild(
        session.prepare('code-action', first, {line: 1, character: 12}, undefined, 1000),
      );
      yield* Deferred.await(entered);
      const changed = f.text + '// changed\n';
      yield* session.upsert({...f.basis, content: sha256HexSync(changed), documentVersion: 2}, changed, 'go', 1000);
      yield* Deferred.succeed(response, {title: 'Fix', edit: f.edit});
      expect((yield* Fiber.join(pending)).status).toBe('stale');
      expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
    }).pipe(Effect.provide(io)),
  );
});
describe('host SDK integrity bounds', () => {
  effectIt.effect('enforces the aggregate SDK byte budget at exactly one GiB without allocating that many bytes', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const name of ['a', 'b', 'c', 'd']) yield* f.fs.writeFileString(f.path.join(f.root, name), 'x');
      const metadata = FileSystem.FileSystem.of({
        ...f.fs,
        stat: file =>
          f.fs
            .stat(file)
            .pipe(
              Effect.map(info =>
                info.type === 'File'
                  ? {...info, size: ByteSize.bytes(f.path.basename(file) === 'e' ? 1 : 256 * 1024 * 1024)}
                  : info,
              ),
            ),
      });
      expect(yield* semanticSdkDigest(f.root).pipe(Effect.provideService(FileSystem.FileSystem, metadata))).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      yield* f.fs.writeFileString(f.path.join(f.root, 'e'), 'x');
      expect(
        yield* semanticSdkDigest(f.root).pipe(Effect.provideService(FileSystem.FileSystem, metadata), Effect.flip),
      ).toMatchObject({code: 'capacity'});
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect.prop(
    'preserves the source digest and creation-order independence for trees inside both bounds',
    [Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMinLength(1), Schema.isMaxLength(6))],
    ([bodies]) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = f.path.join(f.root, 'first');
        const second = f.path.join(f.root, 'second');
        yield* f.fs.makeDirectory(first);
        yield* f.fs.makeDirectory(second);
        for (let i = 0; i < bodies.length; i++) yield* f.fs.writeFileString(f.path.join(first, i + '.rs'), bodies[i]);
        for (let i = bodies.length - 1; i >= 0; i--)
          yield* f.fs.writeFileString(f.path.join(second, i + '.rs'), bodies[i]);
        const original = yield* semanticTreeDigest(first);
        expect(yield* semanticSdkDigest(first)).toBe(original);
        expect(yield* semanticSdkDigest(second)).toBe(original);
        yield* f.fs.writeFileString(f.path.join(second, '0.rs'), bodies[0] + '\nchanged');
        expect(yield* semanticSdkDigest(second)).not.toBe(original);
        expect(Array.from(yield* f.fs.readFile(f.path.join(first, '0.rs')))).toEqual(
          Array.from(new TextEncoder().encode(bodies[0])),
        );
      }).pipe(Effect.provide(io)),
    {arbitrary: {runs: 20}},
  );
  effectIt.effect('admits a larger SDK file while retaining the existing source-file bound', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const file = f.path.join(f.root, 'compiler');
      yield* f.fs.writeFile(file, new Uint8Array());
      yield* f.fs.truncate(file, 33 * 1024 * 1024);
      const rejected = yield* semanticTreeDigest(f.root).pipe(
        Effect.catch(error => Effect.succeed(Schema.is(LspFault)(error) ? error.code : 'other')),
      );
      expect(rejected).toBe('capacity');
      expect(yield* semanticSdkDigest(f.root)).toMatch(/^[a-f0-9]{64}$/u);
      expect(Number((yield* f.fs.stat(file)).size)).toBe(33 * 1024 * 1024);
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('rejects SDK files beyond the fixed bound before allocating their bytes', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const file = f.path.join(f.root, 'compiler');
      yield* f.fs.writeFile(file, new Uint8Array());
      yield* f.fs.truncate(file, 257 * 1024 * 1024);
      const rejected = yield* semanticSdkDigest(f.root).pipe(
        Effect.catch(error => Effect.succeed(Schema.is(LspFault)(error) ? error.code : 'other')),
      );
      expect(rejected).toBe('capacity');
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('interrupts an in-flight SDK hash and permits a clean restart without changing the SDK', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const crypto = yield* EffectDigest.Digest;
      const file = f.path.join(f.root, 'compiler');
      const bytes = new Uint8Array(2 * 1024 * 1024).fill(17);
      yield* f.fs.writeFile(file, bytes);
      const expected = yield* semanticSdkDigest(f.root);
      const entered = yield* Deferred.make<void>();
      const hold = yield* Deferred.make<void>();
      let active = 0;
      const interrupted = yield* Effect.forkChild(
        semanticSdkDigest(f.root).pipe(
          Effect.provideService(EffectDigest.Digest, {
            ...crypto,
            digest: (algorithm, input) =>
              Effect.gen(function* () {
                active++;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(hold);
                return yield* crypto.digest(algorithm, input);
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    active--;
                  }),
                ),
              ),
          }),
        ),
      );
      yield* Deferred.await(entered);
      expect(active).toBe(1);
      yield* Fiber.interrupt(interrupted);
      expect(active).toBe(0);
      expect(yield* semanticSdkDigest(f.root)).toBe(expected);
      const after = yield* f.fs.readFile(file);
      expect(after.byteLength).toBe(bytes.byteLength);
      expect(sha256HexSync(after)).toBe(sha256HexSync(bytes));
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect('retains canonical and no-symlink checks for host SDKs', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const actual = f.path.join(f.root, 'actual');
      const link = f.path.join(f.root, 'link');
      yield* f.fs.writeFileString(actual, 'compiler');
      yield* f.fs.symlink(actual, link);
      const rejected = yield* semanticSdkDigest(f.root).pipe(
        Effect.catch(error => Effect.succeed(Schema.is(LspFault)(error) ? error.code : 'other')),
      );
      expect(rejected).toBe('prerequisite');
      expect(yield* f.fs.readFileString(actual)).toBe('compiler');
    }).pipe(Effect.provide(io)),
  );
});
describe('Go module metadata stream', () => {
  it('round-trips nested JSON objects with arbitrary inter-object whitespace without mutation', () => {
    fc.assert(
      fc.property(
        fc.array(fc.dictionary(fc.string({maxLength: 12}), fc.jsonValue({maxDepth: 2}), {maxKeys: 4}), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.constantFrom('', '\n', '\r\n ', '\t'),
        (modules, separator) => {
          const original = JSON.stringify(modules);
          const text = EffectArray.join(
            EffectArray.map(modules, (module, index) => JSON.stringify(module, null, index % 2 ? 2 : undefined)),
            separator,
          );
          expect(parseGoModuleStream(text)).toEqual(JSON.parse(original));
          expect(JSON.stringify(modules)).toBe(original);
        },
      ),
      {numRuns: 48},
    );
  });
  it('rejects incomplete, non-object, commented and over-capacity streams', () => {
    for (const text of ['', '{', 'null', '[{}]', '{}garbage', '{}/* comment */{}', EffectString.repeat(129)('{}')])
      expect(() => parseGoModuleStream(text)).toThrow();
    const module = {Path: 'quoted}\\"{\n😀', Replace: {GoMod: 'nested{manifest}'}};
    expect(parseGoModuleStream(JSON.stringify(module) + '{}')).toEqual([module, {}]);
  });
});
it('constructs a closed Go environment with package-driver, compiler-cache and toolchain hooks disabled', () => {
  expect(goEnvironment('/host/sdk', '/host/private', '/source/go.work')).toMatchObject({
    PATH: '/host/sdk/bin:/usr/bin:/bin',
    GOROOT: '/host/sdk',
    GOWORK: '/source/go.work',
    GOENV: 'off',
    GOTOOLCHAIN: 'local',
    GOPACKAGESDRIVER: 'off',
    GOCACHEPROG: '',
    GOFLAGS: '-mod=readonly',
    GOVCS: '*:off',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    CGO_ENABLED: '0',
    GOCACHE: '/host/private/cache',
    GOMODCACHE: '/host/private/modules',
    TMPDIR: '/host/private/tmp',
  });
});
const noCommands = CommandExecutor.of({
  execute: () => Effect.die('Unexpected tool execution'),
  executeStreaming: () => Effect.die('Unexpected streaming tool execution'),
});
const failureCode = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.catch(error => Effect.succeed(Schema.is(LspFault)(error) ? error.code : 'unexpected-error')));
describe('project execution policy', () => {
  for (const kind of ['lib', 'bin', 'test', 'example', 'bench']) {
    effectIt.effect(`rejects external Cargo ${kind} targets before running metadata`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const project = f.path.join(f.root, 'source');
        yield* f.fs.makeDirectory(project);
        const section = kind === 'lib' ? '[lib]' : '[[' + kind + ']]';
        const manifest =
          '[package]\nname="example"\nversion="0.1.0"\n' + section + '\nname="external"\npath="../outside.rs"\n';
        yield* f.fs.writeFileString(f.path.join(project, 'Cargo.toml'), manifest);
        expect(
          yield* failureCode(
            makeRustProject({
              project,
              worktree: project,
              sdk: '/host/sdk',
              privateDirectory: f.path.join(f.root, 'private'),
            }),
          ),
        ).toBe('prerequisite');
        expect(yield* f.fs.exists(f.path.join(f.root, 'private'))).toBe(false);
        expect(yield* f.fs.readFileString(f.path.join(project, 'Cargo.toml'))).toBe(manifest);
      }).pipe(Effect.provide(io), Effect.provideService(CommandExecutor, noCommands)),
    );
  }
  effectIt.effect('rejects external source roots returned only by Cargo metadata before provider launch', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const project = f.path.join(f.root, 'source');
      yield* f.fs.makeDirectory(project);
      const manifest = f.path.join(project, 'Cargo.toml');
      const text = '[package]\nname="example"\nversion="0.1.0"\n';
      yield* f.fs.writeFileString(manifest, text);
      let probes = 0;
      const commands = CommandExecutor.of({
        ...noCommands,
        execute: (_exe, args) =>
          Effect.sync(() => {
            expect(args[0]).toBe('metadata');
            probes++;
            return {
              exitCode: 0,
              stderr: '',
              stdout: JSON.stringify({
                workspace_root: project,
                packages: [
                  {
                    manifest_path: manifest,
                    name: 'example',
                    version: '0.1.0',
                    targets: [{src_path: f.path.join(f.root, 'outside.rs')}],
                  },
                ],
              }),
            };
          }),
      });
      expect(
        yield* failureCode(
          makeRustProject({
            project,
            worktree: project,
            sdk: '/host/sdk',
            privateDirectory: f.path.join(f.root, 'private'),
          }).pipe(Effect.provideService(CommandExecutor, commands)),
        ),
      ).toBe('prerequisite');
      expect(probes).toBe(1);
      expect(yield* f.fs.readFileString(manifest)).toBe(text);
    }).pipe(Effect.provide(io)),
  );
  for (const file of [
    '.cargo/config',
    '.cargo/config.toml',
    'rust-analyzer.toml',
    '.rust-analyzer.toml',
    'rust-toolchain',
    'rust-toolchain.toml',
  ]) {
    effectIt.effect('rejects ancestor ' + file + ' before executing a Cargo probe', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const project = f.path.join(f.root, 'source');
        yield* f.fs.makeDirectory(project);
        yield* f.fs.writeFileString(f.path.join(project, 'Cargo.toml'), '[package]\nname="example"\nversion="0.1.0"\n');
        const config = f.path.join(f.root, file);
        yield* f.fs.makeDirectory(f.path.dirname(config), {recursive: true});
        yield* f.fs.writeFileString(config, 'repository command must not run');
        expect(
          yield* failureCode(
            makeRustProject({
              project,
              worktree: project,
              sdk: '/host/sdk',
              privateDirectory: f.path.join(f.root, 'private'),
            }),
          ),
        ).toBe('prerequisite');
        expect(yield* f.fs.readFileString(config)).toBe('repository command must not run');
      }).pipe(Effect.provide(io), Effect.provideService(CommandExecutor, noCommands)),
    );
  }
  effectIt.effect('rejects an external Cargo path dependency before running metadata', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const project = f.path.join(f.root, 'source');
      yield* f.fs.makeDirectory(project);
      yield* f.fs.writeFileString(
        f.path.join(project, 'Cargo.toml'),
        '[package]\nname="example"\nversion="0.1.0"\n[dependencies]\ndep={path="../outside"}\n',
      );
      expect(
        yield* failureCode(
          makeRustProject({
            project,
            worktree: project,
            sdk: '/host/sdk',
            privateDirectory: f.path.join(f.root, 'private'),
          }),
        ),
      ).toBe('prerequisite');
    }).pipe(Effect.provide(io), Effect.provideService(CommandExecutor, noCommands)),
  );
  effectIt.effect('rejects Go local replacements outside the worktree before loading the module graph', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const project = f.path.join(f.root, 'source');
      yield* f.fs.makeDirectory(project);
      const original = 'module example.test/main\ngo 1.27.0\n';
      yield* f.fs.writeFileString(f.path.join(project, 'go.mod'), original);
      let probes = 0;
      const commands = CommandExecutor.of({
        ...noCommands,
        execute: (_exe, args) =>
          Effect.sync(() => {
            expect(args.slice(0, 3)).toEqual(['mod', 'edit', '-json']);
            probes++;
            return {
              exitCode: 0,
              stderr: '',
              stdout: JSON.stringify({Replace: [{New: {Path: '../outside', Version: ''}}]}),
            };
          }),
      });
      expect(
        yield* failureCode(
          makeGoProject({
            project,
            worktree: project,
            sdk: '/host/sdk',
            privateDirectory: f.path.join(f.root, 'private'),
          }).pipe(Effect.provideService(CommandExecutor, commands)),
        ),
      ).toBe('prerequisite');
      expect(probes).toBe(1);
      expect(yield* f.fs.readFileString(f.path.join(project, 'go.mod'))).toBe(original);
    }).pipe(Effect.provide(io)),
  );
});
it('constructs a private Rust tool/config/cache environment without ambient compiler hooks', () => {
  const env = rustEnvironment('/host/sdk', '/host/private');
  expect(env).toMatchObject({
    HOME: '/host/private/home',
    CARGO: '/host/sdk/bin/cargo',
    RUSTC: '/host/sdk/bin/rustc',
    CARGO_HOME: '/host/private/cargo',
    CARGO_NET_OFFLINE: 'true',
    CARGO_CACHE_RUSTC_INFO: '0',
    RUSTC_WRAPPER: '',
    RUSTC_WORKSPACE_WRAPPER: '',
    CARGO_BUILD_RUSTC_WRAPPER: '',
    CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: '',
    CARGO_ENCODED_RUSTFLAGS: '',
    CARGO_TARGET_DIR: '/host/private/target',
    CARGO_BUILD_BUILD_DIR: '/host/private/build',
  });
  expect(env.RUST_SRC_PATH).toBeUndefined();
  expect(env.__TEST_RA_USER_CONFIG_DIR).toBeUndefined();
});
describe('gopls unopened document versions', () => {
  const closedView = Effect.gen(function* () {
    const f = yield* goView;
    const content = 'package p\nvar missing = 1\n';
    const file = f.path.join(f.root, 'model.go');
    yield* f.fs.writeFileString(file, content);
    const uri = (yield* f.path.toFileUrl(file)).href;
    const edits = [{range: {start: {line: 1, character: 4}, end: {line: 1, character: 11}}, newText: 'renamed'}];
    const response = (version: number): Schema.Json => ({documentChanges: [{textDocument: {uri, version}, edits}]});
    return {...f, closedContent: content, closedFile: file, closedUri: uri, edits, response};
  });
  effectIt.effect(
    'normalizes its pinned zero sentinel only for an unopened target and retains the raw byte precondition',
    () =>
      Effect.gen(function* () {
        const f = yield* closedView;
        const session = yield* makeGoSession(
          goClient(method =>
            method === 'textDocument/rename' ? Effect.succeed(f.response(0)) : Effect.die('Unexpected method'),
          ),
          f.options,
        );
        const observation = yield* session.upsert(f.basis, f.text, 'go', 1000);
        const result = yield* session.prepare('rename', observation, {line: 1, character: 12}, 'renamed', 1000);
        expect(result.status).toBe('ok');
        if (result.status === 'ok')
          expect(result.items).toEqual([
            {
              kind: 'prepared-edit',
              operation: 'rename',
              files: [
                {
                  uri: f.closedUri,
                  content: sha256HexSync(f.closedContent),
                  documentVersion: null,
                  source: 'disk',
                  edits: f.edits,
                },
              ],
              scope: 'all-provider-returned-edits',
              applied: false,
            },
          ]);
        expect(yield* f.fs.readFileString(f.closedFile)).toBe(f.closedContent);
      }).pipe(Effect.provide(io)),
  );
  effectIt.effect('rejects zero when this session opened the target at a real wire version', () =>
    Effect.gen(function* () {
      const f = yield* goView;
      const edit = {
        documentChanges: EffectArray.map(f.edit.documentChanges, change => ({
          ...change,
          textDocument: {...change.textDocument, version: 0},
        })),
      };
      const session = yield* makeGoSession(
        goClient(method => (method === 'textDocument/rename' ? Effect.succeed(edit) : Effect.die('Unexpected method'))),
        f.options,
      );
      const observation = yield* session.upsert(f.basis, f.text, 'go', 1000);
      const result = yield* session
        .prepare('rename', observation, {line: 1, character: 12}, 'renamed', 1000)
        .pipe(
          Effect.catch(error =>
            Effect.succeed(Schema.is(SemanticSessionFault)(error) ? error.reason : 'unexpected-error'),
          ),
        );
      expect(result).toBe('invalid');
      expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect.prop(
    'never accepts a nonzero claimed version for an unopened target',
    [Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 2000}))],
    ([version]) =>
      Effect.gen(function* () {
        const f = yield* closedView;
        const session = yield* makeGoSession(
          goClient(method =>
            method === 'textDocument/rename' ? Effect.succeed(f.response(version)) : Effect.die('Unexpected method'),
          ),
          f.options,
        );
        const observation = yield* session.upsert(f.basis, f.text, 'go', 1000);
        const result = yield* session
          .prepare('rename', observation, {line: 1, character: 12}, 'renamed', 1000)
          .pipe(
            Effect.catch(error =>
              Effect.succeed(Schema.is(SemanticSessionFault)(error) ? error.reason : 'unexpected-error'),
            ),
          );
        expect(result).toBe('invalid');
      }).pipe(Effect.provide(io)),
    {arbitrary: {runs: 20}},
  );
});
effectIt.effect(
  'keeps Rust project readiness across ordered buffer changes without requiring another status notification',
  () =>
    Effect.gen(function* () {
      const f = yield* goView;
      const text = 'pub fn value() {}\n';
      const file = f.path.join(f.root, 'main.rs');
      yield* f.fs.writeFileString(file, text);
      const uri = (yield* f.path.toFileUrl(file)).href;
      const basis = {
        ...f.basis,
        uri,
        content: sha256HexSync(text),
        provider: {...f.basis.provider, id: 'rust-analyzer', version: rustProviderVersion},
      };
      const notifications = makeSemanticNotifications();
      let statusEvents = 0;
      const client: LspClient = {
        pid: 1,
        request: method =>
          method === 'initialize'
            ? Effect.succeed({
                serverInfo: {name: 'rust-analyzer', version: rustProviderVersion},
                capabilities: {positionEncoding: 'utf-16', documentSymbolProvider: true},
              })
            : method === 'textDocument/documentSymbol'
              ? Effect.succeed([])
              : Effect.die('Unexpected request'),
        notify: method =>
          Effect.sync(() => {
            if (method === 'textDocument/didOpen') {
              statusEvents++;
              notifications.receive('experimental/serverStatus', {health: 'ok', quiescent: true});
            }
          }),
        close: Effect.succeed({
          code: 0,
          drained: true,
          forced: false,
          stdioClosed: true,
          fault: undefined,
          graceful: true,
        }),
      };
      const session = yield* makeRustSession(client, {...f.options, basis, notifications});
      const first = yield* session.upsert(basis, text, 'rust', 1000);
      const changed = text + '// changed\n';
      const update = yield* Effect.forkChild(
        session.upsert({...basis, content: sha256HexSync(changed), documentVersion: 2}, changed, 'rust', 1000),
      );
      yield* TestClock.adjust(20001);
      const second = yield* Fiber.join(update);
      expect(second.documentVersion).toBe(2);
      expect(statusEvents).toBe(1);
      expect((yield* session.query('symbols', first, undefined, 1000)).status).toBe('stale');
      expect((yield* session.close).graceful).toBe(true);
      expect(yield* f.fs.readFileString(file)).toBe(text);
    }).pipe(Effect.provide(io)),
);
const rustDiagnosticFixture = Effect.gen(function* () {
  const f = yield* goView;
  const text = 'pub fn value() { missing(); }\n';
  const file = f.path.join(f.root, 'main.rs');
  yield* f.fs.writeFileString(file, text);
  const uri = (yield* f.path.toFileUrl(file)).href;
  const basis: Observation = {
    ...f.basis,
    uri,
    content: sha256HexSync(text),
    provider: {...f.basis.provider, id: 'rust-analyzer', version: rustProviderVersion},
  };
  const notifications = makeSemanticNotifications();
  const client = (request: LspClient['request'], diagnosticProvider = true): LspClient => ({
    pid: 1,
    request: (method, params, milliseconds) =>
      method === 'initialize'
        ? Effect.succeed({
            serverInfo: {name: 'rust-analyzer', version: rustProviderVersion},
            capabilities: {
              positionEncoding: 'utf-16',
              documentSymbolProvider: true,
              codeActionProvider: true,
              ...(diagnosticProvider
                ? {diagnosticProvider: {identifier: 'native', interFileDependencies: true, workspaceDiagnostics: false}}
                : {}),
            },
          })
        : method === 'textDocument/documentSymbol'
          ? Effect.succeed([])
          : request(method, params, milliseconds),
    notify: method =>
      Effect.sync(() => {
        if (method === 'textDocument/didOpen')
          notifications.receive('experimental/serverStatus', {health: 'ok', quiescent: true});
      }),
    close: Effect.succeed({code: 0, drained: true, forced: false, stdioClosed: true, fault: undefined, graceful: true}),
  });
  const diagnostic = (message: string) => ({
    range: {start: {line: 0, character: 16}, end: {line: 0, character: 23}},
    message,
    code: message,
    severity: 1,
  });
  return {
    ...f,
    text,
    file,
    uri,
    basis,
    notifications,
    client,
    diagnostic,
    options: {...f.options, basis, notifications},
  };
});
describe('Rust pull diagnostic observations', () => {
  for (const olderCompletesFirst of [false, true]) {
    effectIt.effect('keeps only the latest overlapping pull when older-completes-first=' + olderCompletesFirst, () =>
      Effect.gen(function* () {
        const f = yield* rustDiagnosticFixture;
        const entered = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const reports = [yield* Deferred.make<Schema.Json>(), yield* Deferred.make<Schema.Json>()];
        const newerDiagnostic = f.diagnostic('newer');
        let requests = 0;
        const session = yield* makeRustSession(
          f.client((method, params) =>
            Effect.gen(function* () {
              if (method === 'textDocument/codeAction') {
                expect(params).toMatchObject({context: {diagnostics: [newerDiagnostic]}});
                return [];
              }
              expect(method).toBe('textDocument/diagnostic');
              expect(params).toEqual({textDocument: {uri: f.uri}, identifier: 'native'});
              const index = requests++;
              if (index > 1) return {kind: 'full', items: [newerDiagnostic]};
              yield* Deferred.succeed(entered[index], undefined);
              return yield* Deferred.await(reports[index]);
            }),
          ),
          f.options,
        );
        yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));
        const observation = yield* session.upsert(f.basis, f.text, 'rust', 1000);
        const older = yield* Effect.forkChild(
          session
            .diagnostics(observation, 1000)
            .pipe(
              Effect.catch(error =>
                Effect.succeed(Schema.is(SemanticSessionFault)(error) ? error.reason : 'unexpected-error'),
              ),
            ),
        );
        yield* Deferred.await(entered[0]);
        const newer = yield* Effect.forkChild(session.diagnostics(observation, 1000));
        yield* Deferred.await(entered[1]);
        if (olderCompletesFirst) {
          yield* Deferred.succeed(reports[0], {kind: 'full', items: [f.diagnostic('older')]});
          expect(yield* Fiber.join(older)).toBe('stale');
        }
        yield* Deferred.succeed(reports[1], {kind: 'full', items: [newerDiagnostic]});
        const delivered = yield* Fiber.join(newer);
        expect(delivered.observation).toEqual(observation);
        expect(EffectArray.map(delivered.items, item => item.message)).toEqual(['newer']);
        if (!olderCompletesFirst) {
          yield* Deferred.succeed(reports[0], {kind: 'full', items: [f.diagnostic('older')]});
          expect(yield* Fiber.join(older)).toBe('stale');
        }
        f.notifications.receive('textDocument/publishDiagnostics', {
          uri: f.uri,
          version: 1,
          diagnostics: [f.diagnostic('unsolicited')],
        });
        expect(
          (yield* session.prepare('code-action', observation, {line: 0, character: 16}, undefined, 1000)).status,
        ).toBe('ok');
        const unchanged = yield* session.diagnostics(observation, 1000);
        expect(unchanged.added).toEqual([]);
        expect(EffectArray.map(unchanged.remaining, item => item.message)).toEqual(['newer']);
        expect(unchanged.resolved).toEqual([]);
      }).pipe(Effect.provide(io)),
    );
  }
  effectIt.effect('rejects a pull for an older view without replacing the new view or its diagnostic baseline', () =>
    Effect.gen(function* () {
      const f = yield* rustDiagnosticFixture;
      const entered = yield* Deferred.make<void>();
      const delayed = yield* Deferred.make<Schema.Json>();
      let requests = 0;
      const session = yield* makeRustSession(
        f.client(method =>
          Effect.gen(function* () {
            expect(method).toBe('textDocument/diagnostic');
            if (requests++ > 0) return {kind: 'full', items: [f.diagnostic('current')]};
            yield* Deferred.succeed(entered, undefined);
            return yield* Deferred.await(delayed);
          }),
        ),
        f.options,
      );
      yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));
      const first = yield* session.upsert(f.basis, f.text, 'rust', 1000);
      const pending = yield* Effect.forkChild(
        session
          .diagnostics(first, 1000)
          .pipe(
            Effect.catch(error =>
              Effect.succeed(Schema.is(SemanticSessionFault)(error) ? error.reason : 'unexpected-error'),
            ),
          ),
      );
      yield* Deferred.await(entered);
      const changed = f.text + '// changed overlay\n';
      const second = yield* session.upsert(
        {...f.basis, content: sha256HexSync(changed), documentVersion: 2},
        changed,
        'rust',
        1000,
      );
      const current = yield* session.diagnostics(second, 1000);
      yield* Deferred.succeed(delayed, {kind: 'full', items: [f.diagnostic('obsolete')]});
      expect(yield* Fiber.join(pending)).toBe('stale');
      expect(current.observation).toEqual(second);
      expect(second.documentVersion).toBe(2);
      const again = yield* session.diagnostics(second, 1000);
      expect(again.added).toEqual([]);
      expect(EffectArray.map(again.remaining, item => item.message)).toEqual(['current']);
      expect(again.resolved).toEqual([]);
      expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
    }).pipe(Effect.provide(io)),
  );
  effectIt.effect(
    'rejects unadvertised, incomplete and related-document reports without inventing a clean result',
    () =>
      Effect.gen(function* () {
        const f = yield* rustDiagnosticFixture;
        const invalidReports: Schema.Json[] = [
          {kind: 'unchanged', resultId: 'unknown'},
          {kind: 'full', items: [], relatedDocuments: {[f.uri]: {kind: 'full', items: []}}},
          {
            kind: 'full',
            items: [
              {...f.diagnostic('invalid'), range: {start: {line: 99, character: 0}, end: {line: 99, character: 1}}},
            ],
          },
        ];
        for (const invalid of invalidReports) {
          let response: Schema.Json = invalid;
          const session = yield* makeRustSession(
            f.client(() => Effect.succeed(response)),
            f.options,
          );
          const observation = yield* session.upsert(f.basis, f.text, 'rust', 1000);
          expect(
            yield* session
              .diagnostics(observation, 1000)
              .pipe(
                Effect.catch(error =>
                  Effect.succeed(Schema.is(SemanticSessionFault)(error) ? error.reason : 'unexpected-error'),
                ),
              ),
          ).toBe('provider');
          response = {kind: 'full', items: []};
          expect((yield* session.diagnostics(observation, 1000)).items).toEqual([]);
          yield* session.close;
        }
        const unadvertised = yield* makeRustSession(
          f.client(() => Effect.die('Unadvertised diagnostic request'), false),
          f.options,
        );
        const observation = yield* unadvertised.upsert(f.basis, f.text, 'rust', 1000);
        expect(
          yield* unadvertised
            .diagnostics(observation, 1000)
            .pipe(
              Effect.catch(error =>
                Effect.succeed(Schema.is(SemanticSessionFault)(error) ? error.reason : 'unexpected-error'),
              ),
            ),
        ).toBe('provider');
        yield* unadvertised.close;
      }).pipe(Effect.provide(io)),
  );
});
for (const language of ['go', 'rust'] as const) {
  const executablePath = language === 'go' ? process.env.THREADNOTE_GO_PROVIDER : process.env.THREADNOTE_RUST_PROVIDER;
  const sdkPath = language === 'go' ? process.env.THREADNOTE_GO_SDK : process.env.THREADNOTE_RUST_SDK;
  describe.skipIf(!executablePath || !sdkPath || process.platform === 'win32')(
    'pinned ' + language + ' read-only profile',
    () => {
      effectIt.effect(
        'resolves typed methods, prepares every cross-file rename edit and preserves source bytes',
        () =>
          Effect.gen(function* () {
            if (!sdkPath || !executablePath) {
              return yield* Effect.die('Pinned provider fixture environment is incomplete');
            }
            const f = yield* fixture;
            const projectDirectory = f.path.join(f.root, 'project');
            yield* f.fs.makeDirectory(projectDirectory);
            const sdk = yield* f.fs.realPath(sdkPath);
            const executable = yield* f.fs.realPath(executablePath);
            const executableDigest = yield* sha256FileHex(executable);
            expect(executableDigest).toBe(language === 'go' ? goExecutableDigest : rustExecutableDigest);
            const sdkDigest = yield* semanticSdkDigest(sdk);
            const id = language === 'go' ? 'gopls' : 'rust-analyzer';
            const nativeCandidate = {executable, executableDigest, sdkDirectory: sdk, sdkTreeDigest: sdkDigest};
            yield* verifyNativeSemanticCandidate(nativeCandidate, id);
            const emptySdk = f.path.join(f.root, 'empty-sdk');
            yield* f.fs.makeDirectory(emptySdk);
            for (const [candidate, reason] of [
              [{...nativeCandidate, sdkDirectory: f.path.join(f.root, 'missing-sdk')}, 'missing'],
              [{...nativeCandidate, sdkDirectory: emptySdk}, 'missing'],
              [{...nativeCandidate, sdkTreeDigest: EffectString.repeat(64)('0')}, 'incompatible'],
            ] as const) {
              const error = yield* verifyNativeSemanticCandidate(candidate, id).pipe(Effect.flip);
              expect(error).toMatchObject({
                providerId: id,
                reason,
                component: 'sdk',
                nextAction: expect.stringContaining('host-approved'),
              });
            }
            const method = language === 'go' ? 'Run' : 'run';
            const modelSource =
              language === 'go'
                ? 'package sample\ntype Alpha struct{}\nfunc (Alpha) Run() int { return 1 }\ntype Beta struct{}\nfunc (Beta) Run() string { return "beta" }\n'
                : 'pub struct Alpha;\nimpl Alpha { pub fn run(&self) -> i32 { 1 } }\npub struct Beta;\nimpl Beta { pub fn run(&self) -> &\'static str { "beta" } }\n';
            const text =
              language === 'go'
                ? 'package sample\r\ntype Alias = Alpha\r\nfunc caller() {\r\n alias := Alias{}\r\n _ = alias.Run()\r\n _ = Beta{}.Run()\r\n}\r\n// 😀 café Ω\r\n'
                : 'mod model;\r\nuse model::{Alpha, Beta};\r\ntype Alias = Alpha;\r\npub fn caller() {\r\n let alias: Alias = Alpha;\r\n let _ = alias.run();\r\n let _ = Beta.run();\r\n}\r\n// 😀 café Ω\r\n';
            const mainName = language === 'go' ? 'main.go' : 'src/lib.rs';
            const modelName = language === 'go' ? 'model.go' : 'src/model.rs';
            if (language === 'rust') yield* f.fs.makeDirectory(f.path.join(projectDirectory, 'src'));
            yield* f.fs.writeFileString(f.path.join(projectDirectory, mainName), text);
            yield* f.fs.writeFileString(f.path.join(projectDirectory, modelName), modelSource);
            if (language === 'go')
              yield* f.fs.writeFileString(
                f.path.join(projectDirectory, 'go.mod'),
                'module example.test/semantic_fixture\ngo 1.27.0\n',
              );
            else {
              yield* f.fs.writeFileString(
                f.path.join(projectDirectory, 'Cargo.toml'),
                '[package]\nname="semantic_fixture"\nversion="0.1.0"\nedition="2024"\nbuild="build.rs"\n',
              );
              yield* f.fs.writeFileString(
                f.path.join(projectDirectory, 'Cargo.lock'),
                'version = 4\n[[package]]\nname = "semantic_fixture"\nversion = "0.1.0"\n',
              );
              yield* f.fs.writeFileString(
                f.path.join(projectDirectory, 'build.rs'),
                'fn main() { std::fs::write("executed-sentinel", "unexpected").unwrap(); }\n',
              );
            }
            const before = yield* semanticTreeDigest(projectDirectory);
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                expect(yield* semanticTreeDigest(projectDirectory)).toBe(before);
                expect(yield* f.fs.exists(f.path.join(projectDirectory, 'executed-sentinel'))).toBe(false);
              }).pipe(Effect.orDie),
            );
            const projectOptions = {
              project: projectDirectory,
              worktree: projectDirectory,
              sdk,
              privateDirectory: f.path.join(f.root, 'private'),
            };
            const project =
              language === 'go' ? yield* makeGoProject(projectOptions) : yield* makeRustProject(projectOptions);
            const root = (yield* f.path.toFileUrl(projectDirectory)).href;
            const uri = (yield* f.path.toFileUrl(f.path.join(projectDirectory, mainName))).href;
            const modelUri = (yield* f.path.toFileUrl(f.path.join(projectDirectory, modelName))).href;
            const basis: Observation = {
              version: 1,
              repository: 'native-fixture',
              worktree: root,
              project: root,
              configuration: before,
              toolchain: sha256HexSync(JSON.stringify([executableDigest, sdkDigest])),
              provider: {
                id: language === 'go' ? 'gopls' : 'rust-analyzer',
                version: language === 'go' ? 'v0.24.0' : rustProviderVersion,
                generation: 0,
              },
              view: {kind: 'overlay', id: language + '-view', owner: 'fixture', epoch: 0},
              uri,
              content: sha256HexSync(text),
              documentVersion: 1,
              projectEpoch: 0,
            };
            const wire = yield* spawnLspWire({
              command: executable,
              args: [],
              cwd: projectDirectory,
              environment: project.environment,
            });
            const notifications = makeSemanticNotifications();
            const backend = yield* makeLspClient(wire, notifications.receive, project.settings);
            const actionResponses: {
              method: string;
              response: Schema.Json;
            }[] = [];
            const diagnosticReports: Schema.Json[] = [];
            const client: LspClient = {
              ...backend,
              request: (method, params, ms) =>
                backend.request(method, params, ms).pipe(
                  Effect.tap(response =>
                    Effect.sync(() => {
                      if (method === 'textDocument/codeAction' || method === 'codeAction/resolve')
                        actionResponses.push({method, response: structuredClone(response)});
                      if (method === 'textDocument/diagnostic') diagnosticReports.push(structuredClone(response));
                    }),
                  ),
                ),
            };
            const sessionOptions = {
              basis,
              notifications,
              roots: project.roots,
              profile: project.profile,
              ready: project.ready,
              initializationOptions: project.initializationOptions,
              startupMilliseconds: 20000,
            };
            const session =
              language === 'go'
                ? yield* makeGoSession(client, sessionOptions)
                : yield* makeRustSession(client, sessionOptions);
            yield* Effect.addFinalizer(() =>
              session.close.pipe(
                Effect.tap(receipt =>
                  Effect.sync(() => {
                    expect(receipt.drained).toBe(true);
                    expect(receipt.graceful).toBe(true);
                  }),
                ),
                Effect.asVoid,
              ),
            );
            const observation = yield* session.upsert(basis, text, language, 20000);
            const line = language === 'go' ? 4 : 5;
            const start = EffectOption.getOrElse(
              EffectString.indexOf(method)(EffectString.split('\r\n')(text)[line]),
              () => -1,
            );
            const position = {line, character: start + 1};
            const modelLine = language === 'go' ? 2 : 1;
            const modelStart = EffectOption.getOrElse(
              EffectString.indexOf(method)(EffectString.split('\n')(modelSource)[modelLine]),
              () => -1,
            );
            const mainRange = {start: {line, character: start}, end: {line, character: start + method.length}};
            const modelRange = {
              start: {line: modelLine, character: modelStart},
              end: {line: modelLine, character: modelStart + method.length},
            };
            const definition = yield* session.query('definition', observation, position, 20000);
            expect(definition.status).toBe('ok');
            if (definition.status === 'ok') expect(definition.items).toEqual([{uri: modelUri, range: modelRange}]);
            const references = yield* session.query('references', observation, position, 20000);
            expect(references.status).toBe('ok');
            if (references.status === 'ok')
              expect(
                [...references.items].sort((a, b) => EffectString.localeCompare(JSON.stringify(b))(JSON.stringify(a))),
              ).toEqual(
                [
                  {uri, range: mainRange},
                  {uri: modelUri, range: modelRange},
                ].sort((a, b) => EffectString.localeCompare(JSON.stringify(b))(JSON.stringify(a))),
              );
            expect((yield* session.query('hover', observation, position, 20000)).status).toBe('ok');
            expect((yield* session.query('symbols', observation, undefined, 20000)).status).toBe('ok');
            const completion = yield* session.query('completion', observation, {line, character: start}, 20000);
            expect(completion.status).toBe('ok');
            if (completion.status === 'ok') {
              expect(completion.evidence.observation).toEqual(observation);
              expect(
                EffectArray.some(
                  (yield* Schema.decodeUnknownEffect(
                    Schema.Struct({
                      suggestions: Schema.Array(
                        Schema.Struct({
                          label: Schema.String,
                        }),
                      ),
                    }),
                  )(completion.items[0])).suggestions,
                  item => EffectString.startsWith(method)(item.label),
                ),
              ).toBe(true);
            }
            const hierarchy = yield* session.query('call-hierarchy', observation, position, 20000);
            expect(hierarchy.status).toBe('ok');
            if (hierarchy.status === 'ok') {
              expect(hierarchy.evidence.observation).toEqual(observation);
              expect(hierarchy.items.length).toBeGreaterThan(0);
            }
            if (language === 'rust')
              expect((yield* session.query('type-hierarchy', observation, position, 20000)).status).toBe('unsupported');
            const newName = language === 'go' ? 'Exécute' : 'exécute';
            const rename = yield* session.prepare('rename', observation, position, newName, 20000);
            expect(rename.status).toBe('ok');
            if (rename.status === 'ok') {
              expect(rename.items).toHaveLength(1);
              const prepared = rename.items[0];
              if (!Schema.is(Schema.Struct({files: Schema.Array(Schema.Struct({uri: Schema.String}))}))(prepared)) {
                return yield* Effect.die('Invalid rename preparation fixture result');
              }
              const files = prepared.files;
              expect([...files].sort((a, b) => EffectString.localeCompare(b.uri)(a.uri))).toEqual(
                [
                  {
                    uri,
                    content: sha256HexSync(text),
                    documentVersion: 1,
                    source: 'overlay',
                    edits: [{range: mainRange, newText: newName}],
                  },
                  {
                    uri: modelUri,
                    content: sha256HexSync(modelSource),
                    documentVersion: null,
                    source: 'disk',
                    edits: [{range: modelRange, newText: newName}],
                  },
                ].sort((a, b) => EffectString.localeCompare(b.uri)(a.uri)),
              );
            }
            const baseline = yield* session.diagnostics(observation, 20000);
            expect(baseline.observation).toEqual(observation);
            const firstMissing = language === 'go' ? 'missingOne' : 'missing_one';
            const secondMissing = language === 'go' ? 'missingTwo' : 'missing_two';
            const end = EffectOption.getOrElse(EffectString.lastIndexOf('}')(text), () => -1);
            const bad =
              EffectString.slice(0, end)(text) +
              (language === 'go'
                ? ' _ = missingOne()\r\n _ = missingTwo\r\n'
                : ' let _ = missing_one();\r\n let _ = missing_two;\r\n') +
              EffectString.slice(end)(text);
            const badObservation = yield* session.upsert(
              {...basis, content: sha256HexSync(bad), documentVersion: 2},
              bad,
              language,
              20000,
            );
            expect((yield* session.query('references', observation, position, 20000)).status).toBe('stale');
            const badDiagnostics = yield* session.diagnostics(badObservation, 20000);
            expect(badDiagnostics.observation).toEqual(badObservation);
            const actionLine = EffectOption.getOrElse(
              EffectArray.findFirstIndex(EffectString.split('\r\n')(bad), value =>
                EffectString.includes(firstMissing)(value),
              ),
              () => -1,
            );
            const secondLine = EffectOption.getOrElse(
              EffectArray.findFirstIndex(EffectString.split('\r\n')(bad), value =>
                EffectString.includes(secondMissing)(value),
              ),
              () => -1,
            );
            const firstColumn = EffectOption.getOrElse(
              EffectString.indexOf(firstMissing)(EffectString.split('\r\n')(bad)[actionLine]),
              () => -1,
            );
            const secondColumn = EffectOption.getOrElse(
              EffectString.indexOf(secondMissing)(EffectString.split('\r\n')(bad)[secondLine]),
              () => -1,
            );
            const firstError = EffectOption.getOrUndefined(
              EffectArray.findFirst(badDiagnostics.added, d => d.range.start.line === actionLine),
            );
            const secondError = EffectOption.getOrUndefined(
              EffectArray.findFirst(badDiagnostics.added, d => d.range.start.line === secondLine),
            );
            const analyzerStatus =
              language === 'rust' && !firstError
                ? yield* client.request('rust-analyzer/analyzerStatus', {textDocument: {uri}}, 20000)
                : null;
            expect(
              firstError?.range,
              EffectString.slice(0, 16000)(JSON.stringify({diagnosticReports, badDiagnostics, analyzerStatus})),
            ).toEqual({
              start: {line: actionLine, character: firstColumn},
              end: {line: actionLine, character: firstColumn + firstMissing.length},
            });
            expect(secondError?.range).toEqual({
              start: {line: secondLine, character: secondColumn},
              end: {line: secondLine, character: secondColumn + secondMissing.length},
            });
            expect(firstError?.id).not.toBe(secondError?.id);
            if (language === 'rust') {
              expect(firstError?.code).toBe('E0425');
              expect(secondError?.code).toBe('E0425');
            }
            const actions = yield* session.prepare(
              'code-action',
              badObservation,
              {
                line: actionLine,
                character: EffectOption.getOrElse(
                  EffectString.indexOf(firstMissing)(EffectString.split('\r\n')(bad)[actionLine]),
                  () => -1,
                ),
              },
              undefined,
              20000,
            );
            expect(actions.status).toBe('ok');
            if (actions.status === 'ok') {
              expect(actions.evidence.observation).toEqual(badObservation);
              expect(
                actions.items.length,
                EffectString.slice(0, 4000)(JSON.stringify(actionResponses)),
              ).toBeGreaterThan(0);
              const originals = new Map([
                [uri, bad],
                [modelUri, modelSource],
              ]);
              const rawActions = yield* Schema.decodeUnknownEffect(
                Schema.Array(
                  Schema.Struct({
                    title: Schema.String,
                    edit: Schema.optional(
                      Schema.Struct({
                        changes: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.Json))),
                        documentChanges: Schema.optional(
                          Schema.Array(
                            Schema.Struct({
                              textDocument: Schema.Struct({
                                uri: Schema.String,
                              }),
                              edits: Schema.Array(Schema.Json),
                            }),
                          ),
                        ),
                      }),
                    ),
                  }),
                ),
              )(
                EffectArray.flatMap(actionResponses, entry =>
                  entry.method === 'textDocument/codeAction'
                    ? EffectArray.isArray(entry.response)
                      ? entry.response
                      : []
                    : [entry.response],
                ),
              );
              for (const item of yield* Schema.decodeUnknownEffect(
                Schema.Array(
                  Schema.Struct({
                    title: Schema.String,
                    applied: Schema.Boolean,
                    files: Schema.Array(
                      Schema.Struct({
                        uri: Schema.String,
                        content: Schema.String,
                        documentVersion: Schema.Union([Schema.Finite, Schema.Null]),
                        source: Schema.String,
                        edits: Schema.Array(Schema.Json),
                      }),
                    ),
                  }),
                ),
              )(actions.items)) {
                expect(item.applied).toBe(false);
                const raw = EffectOption.getOrUndefined(
                  EffectArray.findFirst(rawActions, action => action.title === item.title && !!action.edit),
                )?.edit;
                expect(raw).toBeDefined();
                const edits =
                  (effectOptionalValue =>
                    effectOptionalValue == null
                      ? undefined
                      : EffectArray.map(effectOptionalValue, change => ({
                          uri: change.textDocument.uri,
                          edits: change.edits,
                        })))(raw?.documentChanges) ??
                  EffectArray.map(EffectRecord.toEntries(raw?.changes ?? {}), ([target, edits]) => ({
                    uri: target,
                    edits,
                  }));
                expect(EffectArray.map(item.files, file => file.uri).sort()).toEqual(
                  EffectArray.map(edits, file => file.uri).sort(),
                );
                for (const file of item.files) {
                  expect(originals.has(file.uri)).toBe(true);
                  expect(file.content).toBe(sha256HexSync(originals.get(file.uri)!));
                  expect(file.documentVersion).toBe(file.uri === uri ? 2 : null);
                  expect(file.source).toBe(file.uri === uri ? 'overlay' : 'disk');
                  expect(
                    [...file.edits].sort((a, b) => EffectString.localeCompare(JSON.stringify(b))(JSON.stringify(a))),
                  ).toEqual(
                    [
                      ...EffectOption.getOrUndefined(EffectArray.findFirst(edits, target => target.uri === file.uri))!
                        .edits,
                    ].sort((a, b) => EffectString.localeCompare(JSON.stringify(b))(JSON.stringify(a))),
                  );
                }
              }
            }
            const middle = EffectString.replace(firstMissing + '()', '1')(bad);
            const middleObservation = yield* session.upsert(
              {...basis, content: sha256HexSync(middle), documentVersion: 3},
              middle,
              language,
              20000,
            );
            const middleDiagnostics = yield* session.diagnostics(middleObservation, 20000);
            expect(EffectArray.some(middleDiagnostics.remaining, d => d.id === secondError?.id)).toBe(true);
            const resolved = EffectOption.getOrUndefined(
              EffectArray.findFirst(middleDiagnostics.resolved, d => d.item.id === firstError?.id),
            );
            expect(resolved?.observation).toEqual(badObservation);
            expect(resolved?.resolvedIn).toEqual(middleObservation);
            const cleanObservation = yield* session.upsert({...basis, documentVersion: 4}, text, language, 20000);
            const cleanDiagnostics = yield* session.diagnostics(cleanObservation, 20000);
            expect(
              EffectArray.some(cleanDiagnostics.items, d => d.id === firstError?.id || d.id === secondError?.id),
            ).toBe(false);
            expect(EffectArray.some(cleanDiagnostics.resolved, d => d.item.id === secondError?.id)).toBe(true);
            yield* project.verify;
            expect(yield* semanticTreeDigest(projectDirectory)).toBe(before);
            expect(yield* f.fs.exists(f.path.join(projectDirectory, 'executed-sentinel'))).toBe(false);
            const closed = yield* session.close;
            expect(closed).toMatchObject({drained: true, graceful: true, stdioClosed: true});
            expect(yield* semanticSdkDigest(sdk)).toBe(sdkDigest);
          }).pipe(
            Effect.provide(Layer.mergeAll(io, commands, TestSystemInfoLayer)),
            Effect.provideService(ChildEnvironmentPolicy, {
              sanitizeExternal: env => env,
              preserveIntendedChild: env => env,
            }),
            TestClock.withLive,
          ),
        120000,
      );
      effectIt.effect(
        'isolates workspace dependency versions through the coordinator and invalidates configuration, dependency and branch changes',
        () =>
          Effect.gen(function* () {
            if (!sdkPath || !executablePath) return yield* Effect.die('Pinned native fixture prerequisites missing');
            const f = yield* fixture;
            const sdk = yield* f.fs.realPath(sdkPath);
            const executable = yield* f.fs.realPath(executablePath);
            const repo = f.path.join(f.root, 'repo');
            const home = f.path.join(f.root, 'home');
            yield* f.fs.makeDirectory(repo);
            yield* f.fs.makeDirectory(home, {mode: 0o700});
            const write = (file: string, text: string) =>
              f.fs
                .makeDirectory(f.path.dirname(file), {recursive: true})
                .pipe(Effect.andThen(f.fs.writeFileString(file, text)));
            const rows = [];
            const method = language === 'go' ? 'Selected' : 'selected';
            for (const variant of [0, 1]) {
              const version =
                language === 'go' ? (variant === 0 ? 'v1.0.0' : 'v1.1.0') : variant === 0 ? '1.0.0' : '2.0.0';
              const project = f.path.join(repo, language + '-' + version);
              const app = f.path.join(project, 'app');
              const dependency = f.path.join(project, 'dependency');
              const text =
                language === 'go'
                  ? 'package main\nimport "example.test/shared"\nfunc main() {\n alias := shared.Alpha{}\n _ = alias.Selected()\n _ = shared.Beta{}.Selected()\n}\n'
                  : 'use shared_dep::Alpha;\nfn main() {\n let alias = Alpha;\n let _ = alias.selected();\n let _ = shared_dep::Beta.selected();\n}\n';
              const model =
                language === 'go'
                  ? 'package shared\ntype Alpha struct{}\nfunc (Alpha) Selected() ' +
                    (variant === 0 ? 'int { return 1 }' : 'string { return "two" }') +
                    '\ntype Beta struct{}\nfunc (Beta) Selected() bool { return true }\n'
                  : 'pub struct Alpha;\nimpl Alpha { pub fn selected(&self) -> ' +
                    (variant === 0 ? 'u32 { 1 }' : '&\'static str { "two" }') +
                    ' }\npub struct Beta;\nimpl Beta { pub fn selected(&self) -> bool { true } }\n';
              const mainFile = f.path.join(app, language === 'go' ? 'main.go' : 'src/main.rs');
              const modelFile = f.path.join(dependency, language === 'go' ? 'model.go' : 'src/lib.rs');
              const configFile = f.path.join(project, language === 'go' ? 'go.work' : 'Cargo.toml');
              const dependencyManifest = f.path.join(dependency, language === 'go' ? 'go.mod' : 'Cargo.toml');
              const appManifest = f.path.join(app, language === 'go' ? 'go.mod' : 'Cargo.toml');
              const lockFile = language === 'rust' ? f.path.join(project, 'Cargo.lock') : undefined;
              yield* write(mainFile, text);
              yield* write(modelFile, model);
              if (language === 'go') {
                yield* write(configFile, 'go 1.27.0\nuse ./app\n');
                yield* write(
                  appManifest,
                  'module example.test/application\ngo 1.27.0\nrequire example.test/shared ' +
                    version +
                    '\nreplace example.test/shared => ../dependency\n',
                );
                yield* write(dependencyManifest, 'module example.test/shared\ngo 1.27.0\n');
              } else {
                yield* write(configFile, '[workspace]\nmembers=["app", "dependency"]\nresolver="2"\n');
                yield* write(
                  appManifest,
                  '[package]\nname="application"\nversion="0.1.0"\nedition="2024"\n[dependencies]\nshared_dep={path="../dependency"}\n',
                );
                yield* write(
                  dependencyManifest,
                  '[package]\nname="shared_dep"\nversion="' + version + '"\nedition="2024"\n',
                );
                if (lockFile)
                  yield* write(
                    lockFile,
                    'version = 4\n[[package]]\nname = "application"\nversion = "0.1.0"\ndependencies = ["shared_dep"]\n[[package]]\nname = "shared_dep"\nversion = "' +
                      version +
                      '"\n',
                  );
              }
              rows.push({
                project,
                text,
                model,
                mainFile,
                modelFile,
                configFile,
                dependencyManifest,
                appManifest,
                lockFile,
                version,
                variant,
              });
            }
            const command = yield* CommandExecutor;
            const git = (args: readonly string[]) =>
              command.execute('git', ['-C', repo, ...args], {
                env: {PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
                timeoutMs: 10000,
              });
            yield* git(['init', '--initial-branch=main']);
            yield* git(['config', 'user.name', 'Private semantic fixture']);
            yield* git(['config', 'user.email', 'fixture@example.invalid']);
            yield* git(['add', '.']);
            yield* git(['commit', '-m', 'Workspace fixture']);
            const before = yield* semanticTreeDigest(repo);
            const candidate = {
              executable,
              executableDigest: yield* sha256FileHex(executable),
              sdkDirectory: sdk,
              sdkTreeDigest: yield* semanticSdkDigest(sdk),
            };
            const coordinator = yield* makeSemanticCoordinator({
              enabled: true,
              dataHome: home,
              ...(language === 'go' ? {go: candidate} : {rust: candidate}),
            });
            const root = (yield* f.path.toFileUrl(repo)).href;
            const scopes = new Set<string>();
            const grants = [];
            const step = <A, E, R>(label: string, program: Effect.Effect<A, E, R>) =>
              program.pipe(
                Effect.tapError(() => Console.error('Native coordinator fixture: ' + language + ' ' + label)),
              );
            const occurrence = (body: string, line: number) => {
              const character = EffectOption.getOrElse(
                EffectString.indexOf(method)(EffectString.split('\n')(body)[line]),
                () => -1,
              );
              expect(character).toBeGreaterThanOrEqual(0);
              return {start: {line, character}, end: {line, character: character + method.length}};
            };
            for (const row of rows) {
              const uri = (yield* f.path.toFileUrl(row.mainFile)).href;
              const modelUri = (yield* f.path.toFileUrl(row.modelFile)).href;
              const project = (yield* f.path.toFileUrl(row.project)).href;
              const range = occurrence(row.text, language === 'go' ? 4 : 3);
              const modelRange = occurrence(row.model, language === 'go' ? 2 : 1);
              const position = {...range.start, character: range.start.character + 1};
              const input: Observation = {
                version: 1,
                repository: 'coordinator-workspace-fixture',
                worktree: root,
                project,
                configuration: before,
                toolchain: candidate.sdkTreeDigest,
                provider: {
                  id: language === 'go' ? 'gopls' : 'rust-analyzer',
                  version: language === 'go' ? 'v0.24.0' : rustProviderVersion,
                  generation: 0,
                },
                view: {kind: 'overlay', id: language + '-' + row.variant, owner: 'fixture', epoch: 0},
                uri,
                content: sha256HexSync(row.text),
                documentVersion: 1,
                projectEpoch: 0,
              };
              const grant = yield* step('attach ' + row.version, coordinator.attach(input, row.text, language));
              if (!grant.project) return yield* Effect.die('Missing project evidence');
              expect(grant.observation.project).toBe(project);
              expect(grant.project.configuration).toBe(project);
              if (language === 'go') {
                if (!Schema.is(Schema.Struct({moduleGraph: Schema.Array(Schema.Json)}))(grant.project.profile))
                  return yield* Effect.die('Missing Go module version evidence');
                expect(grant.project.profile.moduleGraph).toContainEqual({
                  path: 'example.test/shared',
                  version: row.version,
                  main: false,
                  manifest: row.dependencyManifest,
                });
              } else {
                if (!Schema.is(Schema.Struct({packages: Schema.Array(Schema.Json)}))(grant.project.profile))
                  return yield* Effect.die('Missing Cargo package version evidence');
                expect(grant.project.profile.packages).toContainEqual({
                  name: 'shared_dep',
                  version: row.version,
                  manifest: row.dependencyManifest,
                });
              }
              const definition = yield* step(
                'definition ' + row.version,
                coordinator.use(grant.observation, 45000, api =>
                  api.query('definition', grant.observation, position, 30000),
                ),
              );
              expect(definition.status).toBe('ok');
              if (definition.status !== 'ok') return yield* Effect.die('Definition was not ready');
              expect(definition.items).toEqual([{uri: modelUri, range: modelRange}]);
              expect(definition.evidence.observation).toEqual(grant.observation);
              expect(definition.evidence.scope).toMatch(/^project:[a-f0-9]{64}$/u);
              scopes.add(definition.evidence.scope);
              const references = yield* step(
                'references ' + row.version,
                coordinator.use(grant.observation, 45000, api =>
                  api.query('references', grant.observation, position, 30000),
                ),
              );
              expect(references.status).toBe('ok');
              if (references.status !== 'ok') return yield* Effect.die('References were not ready');
              expect(
                [...references.items].sort((a, b) => EffectString.localeCompare(JSON.stringify(b))(JSON.stringify(a))),
              ).toEqual(
                [
                  {uri, range},
                  {uri: modelUri, range: modelRange},
                ].sort((a, b) => EffectString.localeCompare(JSON.stringify(b))(JSON.stringify(a))),
              );
              const hover = yield* step(
                'hover ' + row.version,
                coordinator.use(grant.observation, 45000, api =>
                  api.query('hover', grant.observation, position, 30000),
                ),
              );
              expect(hover.status).toBe('ok');
              expect(JSON.stringify(hover)).toContain(
                language === 'go' ? (row.variant === 0 ? 'int' : 'string') : row.variant === 0 ? 'u32' : 'str',
              );
              if (language === 'go' && row.variant === 0)
                expect(
                  yield* failureCode(
                    coordinator.use(grant.observation, 45000, api =>
                      api.prepare!('rename', grant.observation, position, 'renamed', 30000),
                    ),
                  ),
                ).toBe('rejected');
              const newName = language === 'go' ? 'Renamed' : 'renamed';
              const renamed = yield* step(
                'rename ' + row.version,
                coordinator.use(grant.observation, 45000, api =>
                  api.prepare!('rename', grant.observation, position, newName, 30000),
                ),
              );
              expect(renamed.status).toBe('ok');
              if (renamed.status !== 'ok') return yield* Effect.die('Rename was not ready');
              const prepared = renamed.items[0];
              if (!Schema.is(Schema.Struct({files: Schema.Array(Schema.Json)}))(prepared))
                return yield* Effect.die('Incomplete rename preparation');
              expect(prepared.files).toHaveLength(2);
              expect(prepared.files).toEqual(
                expect.arrayContaining([
                  {
                    uri,
                    content: sha256HexSync(row.text),
                    documentVersion: 1,
                    source: 'overlay',
                    edits: [{range, newText: newName}],
                  },
                  {
                    uri: modelUri,
                    content: sha256HexSync(row.model),
                    documentVersion: null,
                    source: 'disk',
                    edits: [{range: modelRange, newText: newName}],
                  },
                ]),
              );
              grants.push({row, input, observation: grant.observation, position});
            }
            expect(scopes.size).toBe(2);
            expect(yield* coordinator.status).toMatchObject({sessions: 2, providers: 2, imports: 0});
            expect(yield* semanticTreeDigest(repo)).toBe(before);
            for (const grant of grants) yield* coordinator.closeView(grant.observation);
            const first = grants[0];
            const attach = (id: string) =>
              coordinator.attach({...first.input, view: {...first.input.view, id}}, first.row.text, language);
            const rejected = (observation: Observation) =>
              failureCode(
                coordinator.use(observation, 45000, api => api.query('hover', observation, first.position, 30000)),
              );
            const config = yield* attach('configuration');
            yield* f.fs.writeFileString(
              first.row.configFile,
              (yield* f.fs.readFileString(first.row.configFile)) + (language === 'go' ? '// changed\n' : '# changed\n'),
            );
            expect(yield* rejected(config.observation)).toBe('rejected');
            const current = yield* attach('configuration');
            expect(current.observation.configuration).not.toBe(config.observation.configuration);
            expect(current.observation.projectEpoch).toBeGreaterThan(config.observation.projectEpoch);
            yield* coordinator.closeView(current.observation);
            const dependency = yield* attach('dependency');
            const versionFile = language === 'go' ? first.row.appManifest : first.row.dependencyManifest;
            const nextVersion = language === 'go' ? 'v1.2.0' : '1.1.0';
            yield* f.fs.writeFileString(
              versionFile,
              EffectString.replace(first.row.version, nextVersion)(yield* f.fs.readFileString(versionFile)),
            );
            if (first.row.lockFile)
              yield* f.fs.writeFileString(
                first.row.lockFile,
                EffectString.replace(first.row.version, nextVersion)(yield* f.fs.readFileString(first.row.lockFile)),
              );
            expect(yield* rejected(dependency.observation)).toBe('rejected');
            const refreshed = yield* attach('dependency');
            if (!refreshed.project) return yield* Effect.die('Missing refreshed dependency evidence');
            expect(refreshed.observation.configuration).not.toBe(dependency.observation.configuration);
            expect(JSON.stringify(refreshed.project.profile)).toContain(nextVersion);
            yield* coordinator.closeView(refreshed.observation);
            const branch = yield* attach('branch');
            yield* git(['checkout', '-b', 'another-branch']);
            expect(yield* rejected(branch.observation)).toBe('rejected');
            expect(yield* coordinator.status).toMatchObject({
              sessions: 0,
              providers: 0,
              imports: 0,
              quarantined: 0,
              failures: [],
            });
          }).pipe(
            Effect.provide(Layer.mergeAll(io, commands, TestSystemInfoLayer)),
            Effect.provideService(ChildEnvironmentPolicy, {
              sanitizeExternal: env => env,
              preserveIntendedChild: env => env,
            }),
            TestClock.withLive,
          ),
        240000,
      );
    },
  );
}

describe('backend-owned synchronized rename source closure', () => {
  for (const failure of ['none', 'wrong-wire-version', 'closing-identity'] as const) {
    effectIt.effect(`retains exact pre-request targets or refuses ${failure}`, () =>
      Effect.gen(function* () {
        const f = yield* goView;
        const secondFile = f.path.join(f.root, 'other.go');
        const secondUri = (yield* f.path.toFileUrl(secondFile)).href;
        const secondText = 'package p\nvar other = value\n';
        yield* f.fs.writeFileString(secondFile, secondText);
        let requests = 0;
        let captures = 0;
        const versions = new Map<string, number>();
        const ordinary = goClient(method =>
          Effect.sync(() => {
            if (method !== 'textDocument/rename') return null;
            requests++;
            return {
              documentChanges: EffectArray.map([f.uri, secondUri], uri => ({
                textDocument: {
                  uri,
                  version: failure === 'wrong-wire-version' && requests > 1 ? 1 : (versions.get(uri) ?? 0),
                },
                edits: [
                  {
                    range: {
                      start: {line: 1, character: uri === f.uri ? 4 : 12},
                      end: {line: 1, character: uri === f.uri ? 9 : 17},
                    },
                    newText: 'next',
                  },
                ],
              })),
            };
          }),
        );
        const session = yield* makeGoSession(
          {
            ...ordinary,
            notify: (method, params) =>
              Effect.gen(function* () {
                if (method !== 'textDocument/didOpen' && method !== 'textDocument/didChange') return;
                const data = yield* Schema.decodeUnknownEffect(
                  Schema.Struct({textDocument: Schema.Struct({uri: Schema.String, version: Schema.Finite})}),
                )(params).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'})));
                versions.set(data.textDocument.uri, data.textDocument.version);
              }),
          },
          {
            ...f.options,
            captureEditSource: uri =>
              Effect.sync(() => {
                expect(uri).toBe(secondUri);
                captures++;
                return {
                  uri,
                  text: secondText,
                  content: sha256HexSync(secondText),
                  identity: failure === 'closing-identity' && captures > 1 ? 'replaced' : 'original',
                };
              }),
          },
        );
        const view = yield* session.upsert(f.basis, f.text, 'go', 1000);
        const result = yield* Effect.exit(session.prepare('rename', view, {line: 1, character: 5}, 'next', 1000));
        expect(requests).toBe(2);
        if (failure === 'none') {
          expect(result._tag).toBe('Success');
          if (result._tag === 'Success')
            expect(result.value).toMatchObject({
              status: 'ok',
              evidence: {observation: {projectEpoch: 1}},
              items: [
                {
                  sourceBasis: 'pre-request-synchronized-text-v1',
                  files: [
                    {beforeText: f.text, precondition: {sourceKind: 'overlay', physicalIdentity: null}},
                    {
                      beforeText: secondText,
                      observation: {documentVersion: null},
                      precondition: {sourceKind: 'disk', physicalIdentity: 'original'},
                    },
                  ],
                },
              ],
            });
        } else expect(result._tag).toBe('Failure');
        expect(yield* f.fs.readFileString(secondFile)).toBe(secondText);
      }).pipe(Effect.provide(io)),
    );
  }
});

it('uses native Windows executable and cache paths without inherited tool hooks', () => {
  const go = goEnvironment('C:\\SDK Space\\go', 'C:\\private Ω', 'C:\\source\\go.work', 'win32');
  expect(go.PATH).toBe('C:\\SDK Space\\go\\bin');
  expect(go.GOWORK).toBe('C:\\source\\go.work');
  expect(go.GOCACHE).toBe('C:\\private Ω\\cache');
  expect(go.TEMP).toBe('C:\\private Ω\\tmp');
  expect(go.GOENV).toBe('off');
  expect(go.GOTOOLCHAIN).toBe('local');
  const rust = rustEnvironment('D:\\Rust SDK', 'C:\\private Ω', 'win32');
  expect(rust.PATH).toBe('D:\\Rust SDK\\bin');
  expect(rust.CARGO).toBe('D:\\Rust SDK\\bin\\cargo.exe');
  expect(rust.RUSTC).toBe('D:\\Rust SDK\\bin\\rustc.exe');
  expect(rust.RUSTDOC).toBe('D:\\Rust SDK\\bin\\rustdoc.exe');
  expect(rust.CARGO_BUILD_RUSTC_WRAPPER).toBe('');
  expect(rust.CARGO_NET_OFFLINE).toBe('true');
});

describe('public native quickfix selection', () => {
  for (const language of ['go', 'rust'] as const) {
    effectIt.effect(`selects a source-qualified ${language} quickfix with bounded advertised resolution`, () =>
      Effect.gen(function* () {
        const f = yield* goView;
        const basis =
          language === 'go'
            ? f.basis
            : {...f.basis, provider: {id: 'rust-analyzer', version: rustProviderVersion, generation: 0}};
        const budgets: number[] = [];
        let resolvedCommand = false;
        let versionless = false;
        const ordinary = goClient((method, _params, ms) =>
          Effect.gen(function* (): Effect.fn.Return<Schema.Json> {
            budgets.push(ms);
            if (method === 'textDocument/diagnostic') return {kind: 'full', items: []};
            if (method === 'textDocument/codeAction') return [{title: 'Fix', kind: 'quickfix', data: {fix: 'one'}}];
            if (method === 'codeAction/resolve') {
              yield* TestClock.adjust(1);
              return resolvedCommand
                ? {title: 'Fix', kind: 'quickfix', command: {command: 'unsafe'}}
                : {
                    title: 'Fix',
                    kind: 'quickfix',
                    edit: versionless
                      ? {documentChanges: [{...f.edit.documentChanges[0], textDocument: {uri: f.uri, version: null}}]}
                      : f.edit,
                  };
            }
            return yield* Effect.die('Unexpected public action RPC ' + method);
          }),
        );
        const client: LspClient = {
          ...ordinary,
          request: (method, params, ms) =>
            language === 'rust' && method === 'initialize'
              ? Effect.succeed({
                  serverInfo: {name: 'rust-analyzer', version: rustProviderVersion},
                  capabilities: {
                    codeActionProvider: {resolveProvider: true},
                    diagnosticProvider: {interFileDependencies: false, workspaceDiagnostics: false},
                  },
                })
              : ordinary.request(method, params, ms),
          notify: method =>
            Effect.sync(() => {
              if (method === 'initialized')
                f.notifications.receive('experimental/serverStatus', {health: 'ok', quiescent: true});
            }),
        };
        const options = {...f.options, basis, captureEditSource: () => Effect.die('Overlay is not disk')};
        const session = yield* language === 'go' ? makeGoSession(client, options) : makeRustSession(client, options);
        const view = yield* session.upsert(basis, f.text, language, 1000);
        f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: []});
        const query = {range: f.edit.documentChanges[0].edits[0].range, only: ['quickfix']};
        const listed = yield* session.actions(view, query, 1000);
        if (listed.status !== 'ok') return yield* Effect.die('Expected action choices');
        const choices = yield* Schema.decodeUnknownEffect(Schema.Array(SemanticActionChoice))(listed.items);
        const result = yield* session.actions(view, query, 1000, choices[0]);
        expect(result).toMatchObject({
          status: 'ok',
          items: [
            {
              operation: 'code-action',
              qualification: 'qualified-text-only',
              files: [{beforeText: f.text, providerDocumentVersion: 1, precondition: {sourceKind: 'overlay'}}],
            },
          ],
        });
        expect(EffectArray.every(budgets, value => value > 0 && value <= 1000)).toBe(true);
        expect(budgets).toContain(999);
        resolvedCommand = true;
        const blocked = yield* session.actions(view, query, 1000, choices[0]);
        expect(blocked.status).toBe('ok');
        if (blocked.status === 'ok')
          expect(blocked.items[0]).toMatchObject({kind: 'action-result', status: 'no-match'});
        resolvedCommand = false;
        versionless = true;
        expect(yield* session.actions(view, query, 1000, choices[0]).pipe(Effect.flip)).toMatchObject({
          reason: 'stale',
        });
        expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
      }).pipe(Effect.provide(io)),
    );
  }
  for (const language of ['go', 'rust'] as const) {
    effectIt.effect(
      `round-trips private ${language} diagnostic context and refuses changed or ambiguous witnesses`,
      () =>
        Effect.gen(function* () {
          const f = yield* goView;
          const basis =
            language === 'go'
              ? f.basis
              : {...f.basis, provider: {id: 'rust-analyzer', version: rustProviderVersion, generation: 0}};
          const diagnostic = {
            range: f.edit.documentChanges[0].edits[0].range,
            code: 'UndeclaredName',
            severity: 1,
            message: 'undefined: missing',
            source: language === 'go' ? 'compiler' : 'rustc',
            data: {opaque: 'opaque-private:original'},
          };
          let native = [diagnostic],
            actionCalls = 0;
          const contexts: (readonly Schema.Json[])[] = [];
          const paramsSchema = Schema.Struct({context: Schema.Struct({diagnostics: Schema.Array(Schema.Json)})});
          const ordinary = goClient((method, params) =>
            Effect.sync(() => {
              if (method === 'textDocument/diagnostic') return {kind: 'full', items: native};
              if (method !== 'textDocument/codeAction' || !Schema.is(paramsSchema)(params))
                throw new Error('Unexpected diagnostic action RPC');
              actionCalls++;
              contexts.push(structuredClone(params.context.diagnostics));
              // A wire client must not be able to mutate the retained provider publication.
              const first = params.context.diagnostics[0];
              if (Schema.is(Schema.Record(Schema.String, Schema.Json))(first))
                expect(Reflect.set(first, 'data', 'wire-only-mutation')).toBe(true);
              return [{title: 'Fix', kind: 'quickfix', edit: f.edit}];
            }),
          );
          const client: LspClient = {
            ...ordinary,
            request: (method, params, ms) =>
              language === 'rust' && method === 'initialize'
                ? Effect.succeed({
                    serverInfo: {name: 'rust-analyzer', version: rustProviderVersion},
                    capabilities: {
                      codeActionProvider: {resolveProvider: true},
                      diagnosticProvider: {interFileDependencies: false, workspaceDiagnostics: false},
                    },
                  })
                : ordinary.request(method, params, ms),
            notify: method =>
              Effect.sync(() => {
                if (method === 'initialized')
                  f.notifications.receive('experimental/serverStatus', {health: 'ok', quiescent: true});
              }),
          };
          const options = {...f.options, basis, captureEditSource: () => Effect.die('Overlay is not disk')};
          const session = yield* language === 'go' ? makeGoSession(client, options) : makeRustSession(client, options);
          const view = yield* session.upsert(basis, f.text, language, 1000);
          const publish = () =>
            f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: native});
          publish();
          const delta = yield* session.diagnostics(view, 1000);
          const query = {range: diagnostic.range, only: ['quickfix'], diagnosticIds: [delta.items[0].id]};
          const listed = yield* session.actions(view, query, 1000);
          if (listed.status !== 'ok') return yield* Effect.die('Missing native-context list');
          const [choice] = yield* Schema.decodeUnknownEffect(Schema.Array(SemanticActionChoice))(listed.items);
          const prepared = yield* session.actions(view, query, 1000, choice);
          expect(prepared).toMatchObject({status: 'ok', items: [{kind: 'prepared-edit'}]});
          for (const context of contexts) expect(context).toEqual([diagnostic]);
          expect(native).toEqual([diagnostic]);
          expect(JSON.stringify({delta, listed, prepared})).not.toContain('opaque-private:');
          const after = yield* session.diagnostics(view, 1000);
          expect(after.added).toEqual([]);
          expect(after.remaining).toEqual(delta.items);
          native = [{...diagnostic, data: {opaque: 'opaque-private:changed'}}];
          publish();
          const changed = yield* session.actions(view, query, 1000, choice);
          expect(changed.status).toBe('ok');
          if (changed.status === 'ok') {
            expect(changed.items[0]).toMatchObject({kind: 'action-result', status: 'changed-selection'});
            expect(
              EffectArray.filter(changed.items, item =>
                Schema.is(Schema.Struct({kind: Schema.Literal('prepared-edit')}))(item),
              ),
            ).toHaveLength(0);
          }
          native = [diagnostic, {...diagnostic, data: {opaque: 'opaque-private:ambiguous'}}];
          publish();
          const before = actionCalls;
          expect(yield* session.actions(view, query, 1000).pipe(Effect.flip)).toMatchObject({reason: 'provider'});
          expect(actionCalls).toBe(before);
          expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
        }).pipe(Effect.provide(io)),
    );
  }

  effectIt.effect.prop(
    'preserves native optional metadata and source association under diagnostic permutations without mutation',
    {
      source: Schema.Literals(['absent', 'empty', 'compiler']),
      data: Schema.Literals(['absent', 'null', 'object']),
      reverse: Schema.Boolean,
      token: Schema.String.check(Schema.isMaxLength(20)),
    },
    ({source, data, reverse, token}) =>
      Effect.gen(function* () {
        const f = yield* goView;
        const selected = {
          range: f.edit.documentChanges[0].edits[0].range,
          message: 'missing',
          severity: 1,
          ...(source === 'absent' ? {} : {source: source === 'empty' ? '' : 'compiler'}),
          ...(data === 'absent'
            ? {}
            : {data: data === 'null' ? null : {token: 'opaque-private:' + token, values: [null, false, 0]}}),
        };
        const native = [
          selected,
          {...selected, message: 'another diagnostic', data: {opaque: 'opaque-private:unselected'}},
        ];
        const original = structuredClone(native),
          contexts: (readonly Schema.Json[])[] = [];
        const paramsSchema = Schema.Struct({context: Schema.Struct({diagnostics: Schema.Array(Schema.Json)})});
        const session = yield* makeGoSession(
          goClient((method, params) =>
            Effect.sync(() => {
              if (method !== 'textDocument/codeAction' || !Schema.is(paramsSchema)(params))
                throw new Error('Unexpected metadata RPC');
              contexts.push(structuredClone(params.context.diagnostics));
              const first = params.context.diagnostics[0];
              if (Schema.is(Schema.Record(Schema.String, Schema.Json))(first))
                expect(Reflect.set(first, 'data', 'wire-only-mutation')).toBe(true);
              return [{title: 'Fix', kind: 'quickfix', edit: f.edit}];
            }),
          ),
          {...f.options, captureEditSource: () => Effect.die('Overlay is not disk')},
        );
        const view = yield* session.upsert(f.basis, f.text, 'go', 1000);
        f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: native});
        const diagnostics = yield* session.diagnostics(view, 1000);
        const target = EffectOption.getOrUndefined(
          EffectArray.findFirst(diagnostics.items, item => item.message === 'missing'),
        );
        if (!target) return yield* Effect.die('Missing selected diagnostic');
        const query = {range: selected.range, diagnosticIds: [target.id]};
        const listed = yield* session.actions(view, query, 1000);
        if (listed.status !== 'ok') return yield* Effect.die('Missing metadata list');
        const [choice] = yield* Schema.decodeUnknownEffect(Schema.Array(SemanticActionChoice))(listed.items);
        f.notifications.receive('textDocument/publishDiagnostics', {
          uri: f.uri,
          version: 1,
          diagnostics: reverse ? [...native].reverse() : native,
        });
        expect(yield* session.actions(view, query, 1000, choice)).toMatchObject({
          status: 'ok',
          items: [{kind: 'prepared-edit'}],
        });
        for (const context of contexts) expect(context).toEqual([selected]);
        expect(native).toEqual(original);
        expect(JSON.stringify({diagnostics, listed})).not.toContain('opaque-private:');
      }).pipe(Effect.provide(io)),
    {arbitrary: {runs: 16}},
  );

  effectIt.effect('refuses native diagnostic metadata changed while a public action request is pending', () =>
    Effect.gen(function* () {
      const f = yield* goView;
      const entered = yield* Deferred.make<void>(),
        response = yield* Deferred.make<Schema.Json>();
      const session = yield* makeGoSession(
        goClient(method =>
          method === 'textDocument/codeAction'
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(response)))
            : Effect.die('Unexpected metadata-race RPC'),
        ),
        {...f.options, captureEditSource: () => Effect.die('Overlay is not disk')},
      );
      const view = yield* session.upsert(f.basis, f.text, 'go', 1000);
      const diagnostic = {
        range: f.edit.documentChanges[0].edits[0].range,
        message: 'missing',
        data: {opaque: 'before'},
      };
      f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: [diagnostic]});
      const pending = yield* Effect.forkChild(Effect.result(session.actions(view, {range: diagnostic.range}, 1000)));
      yield* Deferred.await(entered);
      f.notifications.receive('textDocument/publishDiagnostics', {
        uri: f.uri,
        version: 1,
        diagnostics: [{...diagnostic, data: {opaque: 'after'}}],
      });
      yield* Deferred.succeed(response, [{title: 'Fix', kind: 'quickfix', edit: f.edit}]);
      expect(yield* Fiber.join(pending)).toMatchObject({_tag: 'Failure', failure: {reason: 'stale'}});
      expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
    }).pipe(Effect.provide(io)),
  );

  effectIt.effect.prop(
    'keeps only unique unchanged quickfix selection under permutations and mutations',
    {
      permutation: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 5})),
      mutation: Schema.Literals(['none', 'edit', 'query', 'source', 'duplicate']),
    },
    ({permutation, mutation}) =>
      Effect.gen(function* () {
        const f = yield* goView;
        const actions = EffectArray.map([0, 1, 2], index => ({
          title: 'Fix ' + index,
          kind: 'quickfix',
          edit: {
            documentChanges: [
              {...f.edit.documentChanges[0], edits: [{...f.edit.documentChanges[0].edits[0], newText: String(index)}]},
            ],
          },
        }));
        let response: Schema.Json[] = actions;
        const session = yield* makeGoSession(
          goClient(method =>
            method === 'textDocument/codeAction' ? Effect.succeed(response) : Effect.die('Unexpected selection RPC'),
          ),
          {
            ...f.options,
            captureEditSource: () => Effect.die('Overlay is not disk'),
          },
        );
        let view = yield* session.upsert(f.basis, f.text, 'go', 1000);
        f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: []});
        let query = {range: f.edit.documentChanges[0].edits[0].range};
        const first = yield* session.actions(view, query, 1000);
        if (first.status !== 'ok') return yield* Effect.die('Missing list');
        const choices = yield* Schema.decodeUnknownEffect(Schema.Array(SemanticActionChoice))(first.items);
        const selected = choices[1];
        const permutations = [
          [0, 1, 2],
          [0, 2, 1],
          [1, 0, 2],
          [1, 2, 0],
          [2, 0, 1],
          [2, 1, 0],
        ];
        response = EffectArray.map(permutations[permutation], index => actions[index]);
        if (mutation === 'edit')
          response = EffectArray.map(response, action =>
            action === actions[1]
              ? {
                  ...actions[1],
                  edit: {
                    documentChanges: [
                      {...f.edit.documentChanges[0], edits: [{...f.edit.documentChanges[0].edits[0], newText: '9'}]},
                    ],
                  },
                }
              : action,
          );
        if (mutation === 'duplicate') response.push(actions[1]);
        if (mutation === 'query') query = {range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}};
        if (mutation === 'source') {
          const text = f.text + '// changed\n';
          view = yield* session.upsert({...view, content: sha256HexSync(text), documentVersion: 2}, text, 'go', 1000);
          f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 2, diagnostics: []});
        }
        const result = yield* session.actions(view, query, 1000, selected);
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
          const prepared = EffectArray.filter(result.items, item =>
            Schema.is(Schema.Struct({kind: Schema.Literal('prepared-edit')}))(item),
          );
          expect(prepared.length).toBe(mutation === 'none' ? 1 : 0);
          if (mutation === 'none') expect(prepared[0]).toMatchObject({files: [{edits: [{newText: '1'}]}]});
        }
        expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
      }).pipe(Effect.provide(io)),
    {arbitrary: {runs: 20}},
  );

  effectIt.effect('refuses a source invalidated while the public action resolver is pending', () =>
    Effect.gen(function* () {
      const f = yield* goView;
      const entered = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Schema.Json>();
      const session = yield* makeGoSession(
        goClient(method =>
          method === 'textDocument/codeAction'
            ? Effect.succeed([{title: 'Fix', kind: 'quickfix', data: {}}])
            : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(response))),
        ),
        {
          ...f.options,
          captureEditSource: () => Effect.die('Overlay is not disk'),
        },
      );
      const view = yield* session.upsert(f.basis, f.text, 'go', 1000);
      f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: []});
      const pending = yield* Effect.forkChild(
        Effect.exit(session.actions(view, {range: f.edit.documentChanges[0].edits[0].range}, 1000)),
      );
      yield* Deferred.await(entered);
      yield* session.invalidate;
      yield* Deferred.succeed(response, {title: 'Fix', kind: 'quickfix', edit: f.edit});
      expect((yield* Fiber.join(pending))._tag).toBe('Failure');
      expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
    }).pipe(Effect.provide(io)),
  );
});
