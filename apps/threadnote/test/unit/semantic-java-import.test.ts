import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Record as EffectRecord,
  Schema,
  String as EffectString,
} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {canonicalFileUri} from '@threadnote/semantic/contracts';
import {CommandExecutor} from '@threadnote/platform/command';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {cryptoLayer} from '@threadnote/platform/crypto';
import * as Native from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  inspectJavaImportInputs,
  inspectTrustedJavaImportInputs,
  inspectJavaImportCache,
  javaTrustedImportPreviewDigest,
  JavaImportFault,
  verifyJavaImportCurrentness,
  javaImportCanonicalPom,
  runSemanticJavaImport,
} from '../../src/semantic/java_import.js';
import {
  inspectSemanticHostProfile,
  JavaImportPolicy,
  type JavaTrustedImportPolicyBody,
  javaTrustedImportMode,
  javaTrustedImportPermissions,
  javaTrustedImportRisk,
  javaTrustedImportRiskVersion,
  writeSemanticHostProfile,
  writeSemanticJavaImportPolicy,
} from '../../src/semantic/host_profile.js';
import {runSemanticDoctor} from '../../src/semantic/doctor.js';
import * as javaRuntime from '../../src/semantic/providers/java_runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  materializeJavaMavenConfiguration,
  javaMavenImportSettings,
} from '../../src/semantic/providers/java_preparation.js';

const layer = Layer.mergeAll(
  BunServices.layer,
  cryptoLayer,
  TestSystemInfoLayer,
  Layer.succeed(CommandExecutor, {
    execute: () => Effect.die('No process'),
    executeStreaming: () => Effect.die('No process'),
  }),
);
const permissions = {
  importer: true,
  repositoryCommands: false,
  sourceExecution: false,
  network: false,
  dependencies: false,
  plugins: false,
  annotationProcessors: false,
  gradle: false,
} as const;
const candidate = {
  serverDirectory: '/host/jdtls',
  runtimeJavaHome: '/host/java25',
  projectJavaHome: '/host/java21',
  serverTreeDigest: javaRuntime.javaRuntimeQualification.serverTreeDigest,
  runtimeSdkDigest: javaRuntime.javaRuntimeQualification.runtimeSdkDigest,
  projectSdkDigest: javaRuntime.javaRuntimeQualification.projectSdkDigest,
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-import-'}));
  const root = path.join(parent, 'original');
  const home = path.join(parent, 'home');
  yield* fs.makeDirectory(home, {mode: 0o700});
  yield* fs.makeDirectory(path.join(root, 'src/main/java'), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(path.join(root, 'pom.xml'), javaImportCanonicalPom);
  yield* fs.writeFileString(path.join(root, 'src/main/java/Main.java'), 'class Main {}\n');
  const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
  const config: RuntimeConfig = {
    account: 'local',
    user: 'test',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(parent, 'manifest.json'),
  };
  const policy: JavaImportPolicy = {
    version: 1,
    mode: 'maven21-dependency-free-v1',
    project: worktree,
    sourceDigest: yield* inspectJavaImportInputs(root, root),
    candidate,
    permissions,
  };
  return {fs, path, root, home, worktree, config, policy, request: {version: 1, callerCwd: root}};
});

it('any nonempty widening of denied operations is rejected by the closed policy', () => {
  const denied = [
    'repositoryCommands',
    'sourceExecution',
    'network',
    'dependencies',
    'plugins',
    'annotationProcessors',
    'gradle',
  ] as const;
  fc.assert(
    fc.property(fc.subarray([...denied], {minLength: 1}), fields => {
      const modified = {...permissions};
      const selected = EffectRecord.fromEntries(EffectArray.map(fields, field => [field, true] as const));
      expect(
        Schema.is(JavaImportPolicy)({
          version: 1,
          mode: 'maven21-dependency-free-v1',
          project: 'file:///original',
          sourceDigest: EffectString.repeat(64)('0'),
          candidate,
          permissions: {...modified, ...selected},
        }),
      ).toBe(false);
    }),
    {numRuns: 32},
  );
});

effectIt.effect('binds exact unchanged original bytes and rejects hidden, unknown, alternate and linked inputs', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(yield* f.fs.readFileString(f.path.join(f.root, 'pom.xml'))).toBe(javaImportCanonicalPom);
    expect(yield* inspectJavaImportInputs(f.root, f.root)).toBe(f.policy.sourceDigest);
    for (const relative of ['pom.xml', 'src/main/java/Main.java']) {
      const file = f.path.join(f.root, relative);
      const original = yield* f.fs.readFile(file);
      yield* f.fs.writeFile(file, new Uint8Array([0xef, 0xbb, 0xbf, ...original]));
      expect(yield* inspectJavaImportInputs(f.root, f.root).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {reason: 'unsupported-input'},
      });
      yield* f.fs.writeFile(file, original);
      expect(yield* inspectJavaImportInputs(f.root, f.root)).toBe(f.policy.sourceDigest);
      expect(yield* f.fs.readFile(file)).toEqual(original);
    }
    // Parent/sibling importer inputs cannot hide outside the finite project's inventory.
    expect(yield* inspectJavaImportInputs(f.path.dirname(f.root), f.root).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
    });
    for (const [relative, text] of [
      ['.mvn/maven.config', '-o'],
      ['settings.xml', '<settings/>'],
      ['src/main/java/Plugin.jar', 'jar'],
    ] as const) {
      const file = f.path.join(f.root, relative);
      yield* f.fs.makeDirectory(f.path.dirname(file), {recursive: true});
      yield* f.fs.writeFileString(file, text);
      expect(yield* inspectJavaImportInputs(f.root, f.root).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      yield* f.fs.remove(EffectString.startsWith('.mvn')(relative) ? f.path.join(f.root, '.mvn') : file, {
        recursive: true,
      });
    }
    yield* f.fs.writeFileString(
      f.path.join(f.root, 'pom.xml'),
      EffectString.replace('<properties>', '<dependencies/>\n  <properties>')(javaImportCanonicalPom),
    );
    expect(yield* inspectJavaImportInputs(f.root, f.root).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
    yield* f.fs.writeFileString(f.path.join(f.root, 'pom.xml'), javaImportCanonicalPom);
    yield* f.fs.writeFileString(f.path.join(f.root, 'src/main/java/Main.java'), 'class Main { int changed; }\n');
    expect(yield* inspectJavaImportInputs(f.root, f.root)).not.toBe(f.policy.sourceDigest);
    yield* f.fs.symlink(f.path.join(f.root, 'src/main/java/Main.java'), f.path.join(f.root, 'src/main/java/Link.java'));
    expect(yield* inspectJavaImportInputs(f.root, f.root).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
  }).pipe(provideTestLayer(layer)),
);

describe.skipIf(!Native.runtimeNativePlatformSupport().writer)('protected local JVM import policy', () => {
  effectIt.effect(
    'denies absent policy, JSON intent and unsupported enforcement before runtime/admission/cache effects',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const runtime = vi
          .spyOn(javaRuntime, 'makeJavaRuntime')
          .mockImplementation(() => Effect.die('Denied import must not verify or launch a provider'));
        yield* Effect.addFinalizer(() => Effect.sync(() => runtime.mockRestore()));
        expect(yield* runSemanticJavaImport(f.config, f.request, 'run', true)).toMatchObject({state: 'denied'});
        expect(yield* runSemanticJavaImport(f.config, {...f.request, authorized: true}, 'run', true)).toMatchObject({
          state: 'invalid-request',
        });
        yield* writeSemanticJavaImportPolicy(f.config, f.worktree, f.policy, undefined);
        expect(yield* runSemanticJavaImport(f.config, f.request, 'run')).toMatchObject({state: 'denied'});
        expect(yield* runSemanticJavaImport(f.config, f.request, 'run', true)).toMatchObject({
          state: 'enforcement-unavailable',
        });
        expect(runtime).not.toHaveBeenCalled();
        expect(yield* f.fs.exists(f.path.join(f.home, 'semantic', 'admission-v1'))).toBe(false);
        expect(yield* f.fs.exists(f.path.join(f.home, 'semantic', 'java-import'))).toBe(false);
      }).pipe(provideTestLayer(layer)),
  );
  effectIt.effect(
    'generic setup cannot create, change or drop policy; disable preserves it and revoke uses exact CAS',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const base = {version: 1, enabled: true, worktree: f.worktree, catalog: {}};
        expect(
          yield* writeSemanticHostProfile(f.config, f.worktree, {...base, javaImport: f.policy}).pipe(Effect.result),
        ).toMatchObject({_tag: 'Failure', failure: {reason: 'incompatible'}});
        const first = yield* writeSemanticJavaImportPolicy(f.config, f.worktree, f.policy, undefined);
        for (const javaImport of [undefined, {...f.policy, sourceDigest: EffectString.repeat(64)('1')}]) {
          expect(
            yield* writeSemanticHostProfile(f.config, f.worktree, {...base, javaImport}, first.digest).pipe(
              Effect.result,
            ),
          ).toMatchObject({_tag: 'Failure', failure: {reason: 'incompatible'}});
          expect(
            yield* runSemanticDoctor(
              f.config,
              {...f.request, profile: {...base, javaImport}, apply: true, expectedDigest: first.digest},
              'setup',
            ),
          ).toMatchObject({state: 'incompatible'});
        }
        const disabled = yield* runSemanticDoctor(
          f.config,
          {...f.request, apply: true, expectedDigest: first.digest},
          'disable',
        );
        expect(disabled).toMatchObject({state: 'disabled', policy: {javaImport: {state: 'disabled'}}});
        const retained = yield* inspectSemanticHostProfile(f.config, f.worktree);
        expect(retained.profile).toMatchObject({enabled: false, catalog: {}, javaImport: f.policy});
        expect(yield* runSemanticJavaImport(f.config, f.request, 'run', true)).toMatchObject({state: 'denied'});
        const reactivation = {...f.request, profile: {...retained.profile, enabled: true}, apply: true};
        expect(
          yield* runSemanticDoctor(f.config, {...reactivation, expectedDigest: first.digest}, 'setup'),
        ).toMatchObject({state: 'incompatible'});
        const reactivated = yield* runSemanticDoctor(
          f.config,
          {...reactivation, expectedDigest: retained.digest},
          'setup',
        );
        expect(reactivated).toMatchObject({
          state: 'configured',
          changed: true,
          policy: {javaImport: {state: 'configured'}},
        });
        const reenabled = yield* inspectSemanticHostProfile(f.config, f.worktree);
        expect(reenabled.profile).toEqual({...base, javaImport: f.policy});
        expect(reactivated.policy.javaImport.state).toBe(reenabled.profile.enabled ? 'configured' : 'disabled');
        expect(yield* runSemanticJavaImport(f.config, f.request, 'run', true)).toMatchObject({
          state: 'enforcement-unavailable',
        });
        expect(
          yield* runSemanticJavaImport(f.config, {...f.request, expectedDigest: retained.digest}, 'revoke', true),
        ).toMatchObject({state: 'incompatible'});
        expect(
          yield* runSemanticJavaImport(f.config, {...f.request, expectedDigest: reenabled.digest}, 'revoke', true),
        ).toMatchObject({state: 'revoked'});
        expect((yield* inspectSemanticHostProfile(f.config, f.worktree)).profile).toEqual(base);
      }).pipe(provideTestLayer(layer), TestClock.withLive),
  );
  effectIt.effect('withholds a result when policy is revoked during the final expensive currentness checks', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* writeSemanticJavaImportPolicy(f.config, f.worktree, f.policy, undefined);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let profileReads = 0;
      const profileGuard = Effect.gen(function* () {
        profileReads++;
        const selected = yield* inspectSemanticHostProfile(f.config, f.worktree);
        if (!selected.profile.enabled || selected.digest !== first.digest)
          return yield* JavaImportFault.make({reason: 'stale'});
      });
      const checking = yield* Effect.forkChild(
        verifyJavaImportCurrentness(
          profileGuard,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.as('would-be-published-result')),
      );
      yield* Deferred.await(entered);
      expect(profileReads).toBe(1);
      expect(
        yield* runSemanticJavaImport(f.config, {...f.request, expectedDigest: first.digest}, 'revoke', true),
      ).toMatchObject({state: 'revoked'});
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(checking).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {reason: 'stale'},
      });
      expect(profileReads).toBe(2);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect(
    'previews and explicitly applies standalone runtime bootstrap with exact source/profile bindings',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const runtime = vi.spyOn(javaRuntime, 'makeJavaRuntime').mockReturnValue(
          Effect.succeed({
            verify: Effect.void,
            identity: 'fixture',
            projectJavaHome: candidate.projectJavaHome,
            analysis: () => Effect.die('No launch'),
            preparation: () => Effect.die('No launch'),
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => runtime.mockRestore()));
        const request = {...f.request, project: f.worktree, candidate};
        const preview = yield* runSemanticJavaImport(f.config, request, 'preview');
        expect(preview).toMatchObject({
          state: 'preview',
          enforcement: 'unavailable',
          expectedDigest: null,
          policy: f.policy,
        });
        expect(yield* f.fs.exists(f.path.join(f.home, 'semantic'))).toBe(false);
        const previewDigest = 'previewDigest' in preview ? preview.previewDigest : undefined;
        expect(yield* runSemanticJavaImport(f.config, {...request, previewDigest}, 'apply')).toMatchObject({
          state: 'denied',
        });
        expect(
          yield* runSemanticJavaImport(
            f.config,
            {...request, previewDigest: EffectString.repeat(64)('0')},
            'apply',
            true,
          ),
        ).toMatchObject({state: 'stale'});
        expect(yield* runSemanticJavaImport(f.config, {...request, previewDigest}, 'apply', true)).toMatchObject({
          state: 'configured',
        });
        const selected = yield* inspectSemanticHostProfile(f.config, f.worktree);
        expect(selected.profile).toMatchObject({catalog: {}, javaImport: f.policy});
        expect(yield* runSemanticJavaImport(f.config, {...request, previewDigest}, 'apply', true)).toMatchObject({
          state: 'stale',
        });
        yield* f.fs.writeFileString(f.path.join(f.root, 'src/main/java/Main.java'), 'class Main {int drift;}\n');
        expect(yield* runSemanticJavaImport(f.config, f.request, 'run', true)).toMatchObject({state: 'stale'});
        expect((yield* inspectSemanticHostProfile(f.config, f.worktree)).digest).toBe(selected.digest);
      }).pipe(provideTestLayer(layer), TestClock.withLive),
  );
});

const trustedBody: JavaTrustedImportPolicyBody = {
  version: 1,
  mode: javaTrustedImportMode,
  build: 'maven',
  project: 'file:///original',
  sourceDigest: sha256HexSync('source'),
  candidate,
  scope: {account: 'local', user: 'test', worktree: 'file:///original'},
  cacheImage: {
    directory: 'file:///cache',
    manifestDigest: sha256HexSync('manifest'),
    imageDigest: sha256HexSync('image'),
  },
  configuration: {version: 'private-java-import-bootstrap-v1', digest: sha256HexSync('configuration')},
  risk: {version: javaTrustedImportRiskVersion, digest: sha256HexSync(javaTrustedImportRisk)},
  permissions: javaTrustedImportPermissions,
};
it('trusted approval binds source, scope, SDK, cache, build and predecessor regardless of object insertion order', () => {
  const mutations: readonly ((body: JavaTrustedImportPolicyBody, suffix: string) => JavaTrustedImportPolicyBody)[] = [
    (b, v) => ({...b, sourceDigest: sha256HexSync('source:' + v)}),
    (b, v) => ({...b, project: 'file:///project-' + encodeURIComponent(v)}),
    (b, v) => ({...b, scope: {...b.scope, user: 'user:' + v}}),
    (b, v) => ({...b, scope: {...b.scope, account: 'account:' + v}}),
    (b, v) => ({...b, scope: {...b.scope, worktree: 'file:///worktree-' + encodeURIComponent(v)}}),
    (b, v) => ({...b, candidate: {...b.candidate, projectSdkDigest: sha256HexSync('sdk:' + v)}}),
    (b, v) => ({...b, candidate: {...b.candidate, serverDirectory: '/server-' + v}}),
    (b, v) => ({...b, cacheImage: {...b.cacheImage, manifestDigest: sha256HexSync('manifest:' + v)}}),
    (b, v) => ({...b, cacheImage: {...b.cacheImage, imageDigest: sha256HexSync('image:' + v)}}),
    (b, v) => ({...b, configuration: {...b.configuration, digest: sha256HexSync('config:' + v)}}),
    b => ({...b, build: 'gradle'}),
    (b, v) => ({
      ...b,
      gradle: {
        sdkDirectory: '/derivative-' + v,
        sdkDigest: '521eff6fca682960da1988c278f2bf3b1ebcc0900220eec0ca93263102d105be',
      },
    }),
  ];
  fc.assert(
    fc.property(fc.string({maxLength: 16}), suffix => {
      const digest = javaTrustedImportPreviewDigest(trustedBody, null);
      for (const mutate of mutations)
        expect(javaTrustedImportPreviewDigest(mutate(trustedBody, suffix), null)).not.toBe(digest);
      expect(javaTrustedImportPreviewDigest(trustedBody, sha256HexSync('previous:' + suffix))).not.toBe(digest);
      const reordered = {...trustedBody, scope: {worktree: trustedBody.scope.worktree, user: 'test', account: 'local'}};
      expect(javaTrustedImportPreviewDigest(reordered, null)).toBe(digest);
    }),
    {numRuns: 32},
  );
});
it('the trusted mode cannot retain even one residual denial or borrow restricted permission literals', () => {
  const policy = {
    ...trustedBody,
    approval: {expectedDigest: null, previewDigest: javaTrustedImportPreviewDigest(trustedBody, null)},
  };
  expect(Schema.is(JavaImportPolicy)(policy)).toBe(true);
  const fields = [
    'repositoryCommands',
    'sourceExecution',
    'network',
    'dependencies',
    'plugins',
    'annotationProcessors',
    'gradle',
  ] as const;
  expect(
    Schema.is(JavaImportPolicy)({...policy, permissions: {...policy.permissions, filesystem: 'private-copy-only'}}),
  ).toBe(false);
  fc.assert(
    fc.property(fc.subarray([...fields], {minLength: 1}), selected => {
      const denial = EffectRecord.fromEntries(EffectArray.map(selected, field => [field, false] as const));
      expect(Schema.is(JavaImportPolicy)({...policy, permissions: {...policy.permissions, ...denial}})).toBe(false);
    }),
    {numRuns: 32},
  );
});

const trustedFixture = Effect.gen(function* () {
  const f = yield* fixture;
  const image = f.path.join(f.path.dirname(f.root), 'cache-image');
  yield* f.fs.makeDirectory(f.path.join(image, 'm2/example'), {recursive: true, mode: 0o700});
  yield* f.fs.makeDirectory(f.path.join(image, 'notices'), {mode: 0o700});
  const jar = 'authored fake cache artifact; no JVM executes this';
  const notice = 'authored fake notice; this is not legal qualification';
  yield* f.fs.writeFileString(f.path.join(image, 'm2/example/plugin.jar'), jar, {mode: 0o600});
  yield* f.fs.writeFileString(f.path.join(image, 'notices/plugin.txt'), notice, {mode: 0o600});
  const manifest = JSON.stringify({
    version: 1,
    build: 'maven',
    artifacts: [{path: 'm2/example/plugin.jar', sha256: sha256HexSync(jar), notice: 'notices/plugin.txt'}],
    notices: [{path: 'notices/plugin.txt', sha256: sha256HexSync(notice)}],
  });
  yield* f.fs.writeFileString(f.path.join(image, 'manifest.json'), manifest, {mode: 0o600});
  const cacheImage = {
    directory: canonicalFileUri((yield* f.path.toFileUrl(image)).href),
    manifestDigest: sha256HexSync(manifest),
  };
  const request = {
    ...f.request,
    mode: javaTrustedImportMode,
    build: 'maven' as const,
    project: f.worktree,
    candidate,
    cacheImage,
  };
  return {...f, image, cacheImage, request, jar, notice};
});

effectIt.effect(
  'trusted raw bindings cover unchanged nested parents/siblings, bytes and paths without normalizing original build files',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const nested = f.path.join(f.root, 'module');
      yield* f.fs.makeDirectory(nested);
      const pom = '<project><dependencies><dependency>original bytes</dependency></dependencies></project>';
      yield* f.fs.writeFileString(f.path.join(nested, 'pom.xml'), pom);
      yield* f.fs.writeFileString(f.path.join(f.root, 'README.md'), 'parent input');
      const before = yield* inspectTrustedJavaImportInputs(f.root, nested);
      expect(yield* inspectTrustedJavaImportInputs(f.root, nested)).toBe(before);
      expect(yield* inspectJavaImportInputs(f.root, nested).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      yield* f.fs.writeFileString(f.path.join(f.root, 'README.md'), 'changed parent input');
      expect(yield* inspectTrustedJavaImportInputs(f.root, nested)).not.toBe(before);
      expect(yield* f.fs.readFileString(f.path.join(nested, 'pom.xml'))).toBe(pom);
      yield* f.fs.makeDirectory(f.path.join(f.root, '.mvn'));
      expect(yield* inspectTrustedJavaImportInputs(f.root, nested).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
    }).pipe(provideTestLayer(layer)),
);

describe.skipIf(!Native.runtimeNativePlatformSupport().writer)(
  'explicit trusted import policy (authored fake SDK/cache only)',
  () => {
    effectIt.effect(
      'requires the separate local acknowledgement, preserves the predecessor anchor and refuses unproved build ownership before launch',
      () =>
        Effect.gen(function* () {
          const f = yield* trustedFixture;
          const runtime = vi.spyOn(javaRuntime, 'makeJavaRuntime').mockReturnValue(
            Effect.succeed({
              verify: Effect.void,
              identity: 'authored-fake',
              projectJavaHome: candidate.projectJavaHome,
              analysis: () => Effect.die('No provider'),
              preparation: () => Effect.die('No build/model launch'),
            }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => runtime.mockRestore()));
          const previous = yield* writeSemanticJavaImportPolicy(f.config, f.worktree, f.policy, undefined);
          const preview = yield* runSemanticJavaImport(f.config, f.request, 'preview');
          expect(preview).toMatchObject({
            state: 'preview',
            execution: 'import-support-unavailable',
            expectedDigest: previous.digest,
            policy: {
              mode: javaTrustedImportMode,
              approval: {expectedDigest: previous.digest},
              permissions: javaTrustedImportPermissions,
            },
          });
          const previewPolicy = 'policy' in preview ? preview.policy : undefined;
          if (!previewPolicy || previewPolicy.mode !== javaTrustedImportMode)
            throw new Error('Missing trusted preview');
          const request = {
            ...f.request,
            previewDigest: previewPolicy.approval.previewDigest,
            expectedDigest: previous.digest,
          };
          expect((yield* inspectSemanticHostProfile(f.config, f.worktree)).digest).toBe(previous.digest);
          const beforeDenial = runtime.mock.calls.length;
          expect(
            yield* runSemanticJavaImport(f.config, {...f.request, permissions: {network: false}}, 'preview'),
          ).toMatchObject({state: 'invalid-request'});
          expect(yield* runSemanticJavaImport(f.config, {...f.request, build: 'gradle'}, 'preview')).toMatchObject({
            state: 'import-support-unavailable',
          });
          expect(runtime.mock.calls.length).toBe(beforeDenial);
          expect(yield* runSemanticJavaImport(f.config, request, 'apply', true)).toMatchObject({state: 'denied'});
          expect(
            yield* runSemanticJavaImport(
              f.config,
              {...request, acknowledgeUnconfinedBuildImport: true},
              'apply',
              true,
              true,
            ),
          ).toMatchObject({state: 'invalid-request'});
          expect(
            yield* runSemanticDoctor(
              f.config,
              {
                version: 1,
                callerCwd: f.root,
                apply: true,
                profile: {version: 1, enabled: true, worktree: f.worktree, catalog: {}, javaImport: previewPolicy},
              },
              'setup',
            ),
          ).toMatchObject({state: 'incompatible'});
          expect(yield* runSemanticJavaImport(f.config, request, 'apply', true, true)).toMatchObject({
            state: 'configured',
          });
          const selected = yield* inspectSemanticHostProfile(f.config, f.worktree);
          expect(selected.digest).not.toBe(previewPolicy.approval.expectedDigest);
          expect(selected.profile.javaImport).toEqual(previewPolicy);
          const calls = runtime.mock.calls.length;
          expect(yield* runSemanticJavaImport(f.config, {version: 1, callerCwd: f.root}, 'run', true)).toMatchObject({
            state: 'import-support-unavailable',
          });
          expect(runtime.mock.calls.length).toBe(calls);
          expect(yield* f.fs.exists(f.path.join(f.home, 'semantic/admission-v1'))).toBe(false);
          expect(yield* f.fs.exists(f.path.join(f.home, 'semantic/java-import'))).toBe(false);
          expect(yield* runSemanticJavaImport(f.config, request, 'apply', true, true)).toMatchObject({state: 'stale'});
          yield* f.fs.writeFileString(f.path.join(f.root, 'README.md'), 'new source bytes');
          expect(yield* runSemanticJavaImport(f.config, {version: 1, callerCwd: f.root}, 'run', true)).toMatchObject({
            state: 'stale',
          });
          expect((yield* inspectSemanticHostProfile(f.config, f.worktree)).digest).toBe(selected.digest);
        }).pipe(provideTestLayer(layer), TestClock.withLive),
    );
    effectIt.effect(
      'requires every declared cache artifact and notice and detects byte drift before native import',
      () =>
        Effect.gen(function* () {
          const f = yield* trustedFixture;
          const image = yield* inspectJavaImportCache(f.cacheImage, 'maven', [f.root]);
          expect(image.files.size).toBe(3);
          expect((yield* inspectJavaImportCache(f.cacheImage, 'maven', [f.root])).binding).toEqual(image.binding);
          yield* f.fs.remove(f.path.join(f.image, 'notices/plugin.txt'));
          expect(yield* inspectJavaImportCache(f.cacheImage, 'maven', [f.root]).pipe(Effect.result)).toMatchObject({
            _tag: 'Failure',
          });
          yield* f.fs.writeFileString(f.path.join(f.image, 'notices/plugin.txt'), f.notice, {mode: 0o600});
          yield* f.fs.writeFileString(f.path.join(f.image, 'm2/example/plugin.jar'), f.jar + 'changed', {mode: 0o600});
          expect(yield* inspectJavaImportCache(f.cacheImage, 'maven', [f.root]).pipe(Effect.result)).toMatchObject({
            _tag: 'Failure',
          });
        }).pipe(provideTestLayer(layer)),
    );
  },
);

effectIt.effect('private Maven ancestor and configuration guards refuse drift without restoring old eligibility', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const parent = f.path.dirname(f.root);
    yield* f.fs.makeDirectory(f.path.join(parent, '.mvn'));
    yield* f.fs.writeFileString(f.path.join(parent, '.mvn/maven.config'), 'hostile outer settings');
    const workspace = yield* javaRuntime.makeJavaWorkspace(f.home);
    const boundary = yield* javaRuntime.makeJavaMavenBoundary(workspace);
    expect(boundary.directory).toBe(f.path.join(workspace.directory, '.mvn'));
    expect(yield* f.fs.readDirectory(boundary.directory)).toEqual([]);
    yield* boundary.verify;
    yield* f.fs.writeFileString(f.path.join(boundary.directory, 'maven.config'), 'drift');
    expect(yield* boundary.verify.pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
    yield* f.fs.remove(f.path.join(boundary.directory, 'maven.config'));
    expect(yield* boundary.verify.pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
    const configuration = yield* materializeJavaMavenConfiguration(workspace.directory, '/vetted/Java&21');
    expect(javaMavenImportSettings(workspace.directory, '/vetted/Java&21').java.configuration.maven).toEqual({
      userSettings: workspace.directory + '/maven-settings.xml',
      globalSettings: workspace.directory + '/maven-global-settings.xml',
    });
    expect(yield* f.fs.readFileString(f.path.join(workspace.directory, 'home/.m2/toolchains.xml'))).toContain(
      'Java&amp;21',
    );
    const file = f.path.join(workspace.directory, 'maven-global-settings.xml');
    const original = yield* f.fs.readFileString(file);
    yield* f.fs.writeFileString(file, 'changed');
    expect(yield* configuration.verify.pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
    yield* f.fs.writeFileString(file, original);
    expect(yield* configuration.verify.pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
    expect(yield* f.fs.readFileString(f.path.join(f.root, 'pom.xml'))).toBe(javaImportCanonicalPom);
  }).pipe(provideTestLayer(layer)),
);
