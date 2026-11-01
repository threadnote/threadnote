import {isJsonObject} from '@threadnote/platform/json';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {Cause, Clock, Crypto, Deferred, Effect, Exit, FileSystem, Option, Path, Schema, Scope, Semaphore} from 'effect';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  Counter,
  Digest,
  FileUri,
  Identifier,
  Observation,
  Position,
  type QueryOutcome,
} from '@threadnote/semantic/contracts';
import {sha256FileHex} from '@threadnote/platform/digest';
import {CommandExecutor, runDetachedCommandEffect} from '@threadnote/platform/command';
import {LspFault, makeLspClient, spawnLspWire, type LspWire} from './lsp_transport.js';
import {makeTypeScriptSession} from './providers/typescript.js';
import {
  SemanticSessionFault,
  SemanticSetupFault,
  SemanticLanguage,
  SemanticQuery,
  isCoreSemanticQuery,
  makeSemanticNotifications,
  type SemanticSession,
  type SdkHostCandidate,
} from './provider.js';
import {makePythonSession} from './providers/python.js';
import {makePythonProject, PythonEnvironment} from './providers/python_project.js';
import {makeJavaAnalysis, verifyJavaOutputDirectories} from './providers/java.js';
import {JavaEnvironment} from './providers/java_project.js';
import {JavaRuntimeCandidate, javaRuntimeQualification, makeJavaRuntime} from './providers/java_runtime.js';
import {makeGoProject, makeGoSession, goProviderVersion, goExecutableDigest, goToolDigest} from './providers/go.js';
import {
  makeRustProject,
  makeRustSession,
  rustProviderVersion,
  rustExecutableDigest,
  rustToolDigest,
  cargoToolDigest,
} from './providers/rust.js';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {boundedFileDigest, readBoundedText, semanticTreeDigest, semanticSdkDigest} from './fingerprint.js';
export {semanticTreeDigest} from './fingerprint.js';
const Instance = Schema.Struct({pid: Counter, identity: Identifier});
type Instance = typeof Instance.Type;
const Reservation = Schema.Struct({
  token: Digest,
  workspace: Digest,
  owner: Instance,
  provider: Schema.NullOr(Instance),
  generation: Counter,
  importing: Schema.Boolean,
  quarantined: Schema.Boolean,
});
export interface TypeScriptHostCandidate {
  readonly runtime: string;
  readonly runtimeDigest: string;
  readonly runtimeVersion: '24.19.0';
  readonly serverDirectory: string;
  readonly serverTreeDigest: string;
  readonly sdkDirectory: string;
  readonly sdkTreeDigest: string;
}
export const semanticCandidateKey = (candidate: TypeScriptHostCandidate) =>
  JSON.stringify([
    candidate.runtime,
    candidate.runtimeDigest,
    candidate.runtimeVersion,
    candidate.serverDirectory,
    candidate.serverTreeDigest,
    candidate.sdkDirectory,
    candidate.sdkTreeDigest,
  ]);
export interface PythonHostCandidate {
  readonly runtime: string;
  readonly runtimeDigest: string;
  readonly runtimeVersion: '24.19.0';
  readonly serverDirectory: string;
  readonly serverTreeDigest: string;
  readonly environments: readonly PythonEnvironment[];
}
const JavaHostCandidate = Schema.Struct({
  runtimeCandidate: JavaRuntimeCandidate,
  environments: Schema.Array(JavaEnvironment).check(Schema.isBetweenLength(1, 16)),
});
export type JavaHostCandidate = typeof JavaHostCandidate.Type;
export const verifyJavaSemanticCandidate = Effect.fn('semantic.verifyJavaCandidate')(function* (
  candidate: JavaHostCandidate | undefined,
) {
  if (!candidate) return yield* makeJavaRuntime(undefined).pipe(Effect.asVoid);
  const selected = yield* Schema.decodeEffect(JavaHostCandidate, {onExcessProperty: 'error'})(candidate).pipe(
    Effect.mapError(() => LspFault.make({code: 'prerequisite'})),
  );
  if (
    new Set(EffectArray.map(selected.environments, environment => environment.id)).size !== selected.environments.length
  )
    return yield* LspFault.make({code: 'prerequisite'});
  yield* makeJavaRuntime(selected.runtimeCandidate);
});
const verifyJavaCoordinatorDirectory = Effect.fn('semantic.verifyJavaCoordinatorDirectory')(function* (
  candidate: JavaHostCandidate,
  home: string,
  worktreeUri: string | undefined,
) {
  if (!Schema.is(FileUri)(worktreeUri)) return yield* LspFault.make({code: 'prerequisite'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktree = yield* path.fromFileUrl(new URL(worktreeUri));
  if ((yield* fs.realPath(worktree)) !== worktree || (yield* fs.stat(worktree)).type !== 'Directory')
    return yield* LspFault.make({code: 'prerequisite'});
  const directory = path.join(home, 'semantic');
  if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
    return yield* LspFault.make({code: 'prerequisite'});
  if (yield* fs.exists(directory)) {
    const info = yield* fs.stat(directory);
    if ((yield* fs.realPath(directory)) !== directory || info.type !== 'Directory' || info.mode & 0o077)
      return yield* LspFault.make({code: 'prerequisite'});
  }
  // Qualify canonical SDK roots before using their spelling to protect any shared write.
  yield* verifyJavaSemanticCandidate(candidate);
  yield* verifyJavaOutputDirectories(
    [directory],
    [
      worktree,
      candidate.runtimeCandidate.serverDirectory,
      candidate.runtimeCandidate.runtimeJavaHome,
      candidate.runtimeCandidate.projectJavaHome,
    ],
  );
});
export const semanticCatalogKey = (
  options: Pick<SemanticCoordinatorOptions, 'candidate' | 'python' | 'go' | 'rust' | 'java'>,
) =>
  JSON.stringify([
    options.candidate ? semanticCandidateKey(options.candidate) : null,
    options.python
      ? [
          options.python.runtime,
          options.python.runtimeDigest,
          options.python.runtimeVersion,
          options.python.serverDirectory,
          options.python.serverTreeDigest,
          EffectArray.map(
            [...options.python.environments].sort((a, b) => EffectString.localeCompare(b.id)(a.id)),
            e => [e.id, e.metadataFile, e.metadataDigest],
          ),
        ]
      : null,
    ...EffectArray.map([options.go, options.rust], candidate =>
      candidate
        ? [candidate.executable, candidate.executableDigest, candidate.sdkDirectory, candidate.sdkTreeDigest]
        : null,
    ),
    options.java
      ? [
          options.java.runtimeCandidate.serverDirectory,
          options.java.runtimeCandidate.serverTreeDigest,
          options.java.runtimeCandidate.runtimeJavaHome,
          options.java.runtimeCandidate.runtimeSdkDigest,
          options.java.runtimeCandidate.projectJavaHome,
          options.java.runtimeCandidate.projectSdkDigest,
          EffectArray.map(
            [...options.java.environments].sort((a, b) => EffectString.localeCompare(b.id)(a.id)),
            environment => [environment.id, environment.metadataFile, environment.metadataDigest],
          ),
        ]
      : null,
  ]);
export interface SemanticCoordinatorOptions {
  readonly enabled: boolean;
  readonly dataHome: string;
  readonly candidate?: TypeScriptHostCandidate;
  readonly python?: PythonHostCandidate;
  readonly go?: SdkHostCandidate;
  readonly rust?: SdkHostCandidate;
  readonly java?: JavaHostCandidate;
  /** Java must bind its protected worktree before allocating shared coordinator state. */
  readonly worktree?: string;
}
interface AnalysisSession {
  readonly scope: Scope.Closeable;
  readonly api: SemanticSession;
  readonly verify: Effect.Effect<void, unknown>;
  readonly basis: Observation;
  readonly diskBasis: string;
  readonly reservation: SemanticReservation;
  readonly queries: Semaphore.Semaphore;
  queued: number;
  lastUsed: number;
  closing: boolean;
  faulted: boolean;
  closed: Deferred.Deferred<void, unknown>;
}
const sessionIdentity = (o: Observation) =>
  JSON.stringify([
    o.repository,
    o.worktree,
    o.project,
    o.provider.id,
    o.view.kind,
    o.view.id,
    o.view.owner,
    o.view.epoch,
  ]);
type NativeProviderId = 'gopls' | 'rust-analyzer';
const nativeSetupFault = (
  providerId: NativeProviderId,
  reason: SemanticSetupFault['reason'],
  component: SemanticSetupFault['component'],
) =>
  SemanticSetupFault.make({
    providerId,
    reason,
    component,
    requiredVersion: providerId === 'gopls' ? goProviderVersion : rustProviderVersion,
    requiredSdkVersion: providerId === 'gopls' ? '1.27.3' : '1.99.1',
    nextAction:
      reason === 'unavailable'
        ? 'Check host filesystem access and supported artifact size limits, then retry semantic setup with the required provider and SDK versions'
        : providerId === 'gopls'
          ? 'Configure the host-approved gopls v0.24.0 and Go 1.27.3 artifacts with their verified SHA-256 digests, then retry semantic setup'
          : 'Configure the host-approved rust-analyzer 0.3.3097 and Rust 1.99.1 artifacts with their verified SHA-256 digests, then retry semantic setup',
  });
/** Shared cold-start preflight and worker trust boundary; no provider or repository process is launched here. */
export const verifyNativeSemanticCandidate = Effect.fn('semantic.verifyNativeCandidate')(function* (
  candidate: SdkHostCandidate | undefined,
  id: NativeProviderId,
) {
  if (!candidate) return yield* nativeSetupFault(id, 'missing', 'provider');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expected = id === 'gopls' ? goExecutableDigest : rustExecutableDigest;
  yield* Effect.gen(function* () {
    if (candidate.executableDigest !== expected || !path.isAbsolute(candidate.executable))
      return yield* nativeSetupFault(id, 'incompatible', 'provider');
    if (!(yield* fs.exists(candidate.executable))) return yield* nativeSetupFault(id, 'missing', 'provider');
    if (
      (yield* fs.realPath(candidate.executable)) !== candidate.executable ||
      (yield* fs.stat(candidate.executable)).type !== 'File' ||
      (yield* sha256FileHex(candidate.executable)) !== expected
    )
      return yield* nativeSetupFault(id, 'incompatible', 'provider');
  }).pipe(
    Effect.mapError(error =>
      Schema.is(SemanticSetupFault)(error) ? error : nativeSetupFault(id, 'unavailable', 'provider'),
    ),
  );
  yield* Effect.gen(function* () {
    if (!Schema.is(Digest)(candidate.sdkTreeDigest) || !path.isAbsolute(candidate.sdkDirectory))
      return yield* nativeSetupFault(id, 'incompatible', 'sdk');
    if (!(yield* fs.exists(candidate.sdkDirectory))) return yield* nativeSetupFault(id, 'missing', 'sdk');
    if (
      (yield* fs.realPath(candidate.sdkDirectory)) !== candidate.sdkDirectory ||
      (yield* fs.stat(candidate.sdkDirectory)).type !== 'Directory'
    )
      return yield* nativeSetupFault(id, 'incompatible', 'sdk');
    const tools =
      id === 'gopls'
        ? [['bin/go', goToolDigest]]
        : [
            ['bin/rustc', rustToolDigest],
            ['bin/cargo', cargoToolDigest],
          ];
    for (const [file, digest] of tools) {
      const tool = path.join(candidate.sdkDirectory, file);
      if (!(yield* fs.exists(tool))) return yield* nativeSetupFault(id, 'missing', 'sdk');
      if ((yield* boundedFileDigest(tool, 64 * 1024 * 1024)) !== digest)
        return yield* nativeSetupFault(id, 'incompatible', 'sdk');
    }
    if ((yield* semanticSdkDigest(candidate.sdkDirectory)) !== candidate.sdkTreeDigest)
      return yield* nativeSetupFault(id, 'incompatible', 'sdk');
  }).pipe(
    Effect.mapError(error =>
      Schema.is(SemanticSetupFault)(error) ? error : nativeSetupFault(id, 'unavailable', 'sdk'),
    ),
  );
});
/** Host-only construction. Repository requests can select a source view, never an executable, plugin or build policy. */
export const makeSemanticCoordinator = Effect.fn('semantic.makeCoordinator')(function* (
  options: SemanticCoordinatorOptions,
) {
  const catalog = structuredClone(options);
  if (!catalog.enabled) return yield* LspFault.make({code: 'prerequisite'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const command = yield* CommandExecutor;
  const crypto = yield* Crypto.Crypto;
  const home = yield* fs.realPath(catalog.dataHome);
  if (home !== path.resolve(catalog.dataHome)) return yield* LspFault.make({code: 'prerequisite'});
  if (catalog.java) yield* verifyJavaCoordinatorDirectory(catalog.java, home, catalog.worktree);
  const admission = yield* makeSemanticAdmission({directory: path.join(home, 'semantic', 'admission-v1')});
  const startup = yield* Semaphore.make(1);
  const sessions = new Map<string, AnalysisSession>();
  const failures = new Map<string, number>();
  const causes = new Map<string, string>();
  const recordFailure = (id: string, reason: string, session?: AnalysisSession) => {
    if (!session?.faulted) failures.set(id, (failures.get(id) ?? 0) + 1);
    if (session) session.faulted = true;
    causes.set(id, reason);
  };
  const verifyNodeCandidate = (candidate: TypeScriptHostCandidate | PythonHostCandidate) =>
    Effect.gen(function* () {
      if (
        candidate.runtimeVersion !== '24.19.0' ||
        !Schema.is(Digest)(candidate.runtimeDigest) ||
        !Schema.is(Digest)(candidate.serverTreeDigest)
      )
        return yield* LspFault.make({code: 'prerequisite'});
      for (const file of [candidate.runtime, candidate.serverDirectory])
        if (!path.isAbsolute(file) || (yield* fs.realPath(file)) !== file)
          return yield* LspFault.make({code: 'prerequisite'});
      if (
        (yield* sha256FileHex(candidate.runtime)) !== candidate.runtimeDigest ||
        (yield* semanticTreeDigest(candidate.serverDirectory)) !== candidate.serverTreeDigest
      )
        return yield* LspFault.make({code: 'prerequisite'});
      if ('sdkDirectory' in candidate) {
        if (
          !path.isAbsolute(candidate.sdkDirectory) ||
          (yield* fs.realPath(candidate.sdkDirectory)) !== candidate.sdkDirectory ||
          (yield* semanticTreeDigest(candidate.sdkDirectory)) !== candidate.sdkTreeDigest
        )
          return yield* LspFault.make({code: 'prerequisite'});
        for (const [directory, version] of [
          [candidate.sdkDirectory, '6.0.3'],
          [candidate.serverDirectory, '6.0.2'],
        ]) {
          const text = yield* readBoundedText(path.join(directory, 'package.json'), 1024 * 1024);
          const value = yield* Effect.try({
            try: () => JSON.parse(text),
            catch: () => LspFault.make({code: 'prerequisite'}),
          });
          if (value?.version !== version) return yield* LspFault.make({code: 'prerequisite'});
        }
      } else {
        // The wheel's package.json carries upstream Pyright's version; pin the distributed basedpyright server itself.
        if (
          (yield* boundedFileDigest(
            path.join(candidate.serverDirectory, 'dist/pyright-langserver.js'),
            16 * 1024 * 1024,
          )) !== '3ff64ca89ba46d04a7e8410955f20fb5e02d6b76d9a76f92e57bf43c95635c33' ||
          candidate.environments.length < 1 ||
          candidate.environments.length > 16 ||
          new Set(EffectArray.map(candidate.environments, e => e.id)).size !== candidate.environments.length
        )
          return yield* LspFault.make({code: 'prerequisite'});
        for (const environment of candidate.environments) yield* Schema.decodeEffect(PythonEnvironment)(environment);
      }
    });
  // Serialize coordinator candidate preflights; providers own their per-operation publication guards.
  const sdkVerification = yield* Semaphore.make(1);
  const verifyCandidate = (
    candidate: TypeScriptHostCandidate | PythonHostCandidate | SdkHostCandidate | JavaHostCandidate,
    id: string,
  ) =>
    'runtimeCandidate' in candidate
      ? id === 'jdtls'
        ? sdkVerification.withPermit(verifyJavaSemanticCandidate(candidate))
        : Effect.fail(LspFault.make({code: 'prerequisite'}))
      : 'runtime' in candidate
        ? verifyNodeCandidate(candidate)
        : id === 'gopls' || id === 'rust-analyzer'
          ? sdkVerification.withPermit(verifyNativeSemanticCandidate(candidate, id))
          : Effect.fail(LspFault.make({code: 'prerequisite'}));
  const configured = [
    ...(catalog.candidate ? [{candidate: catalog.candidate, id: 'typescript-language-server', version: '6.0.2'}] : []),
    ...(catalog.python ? [{candidate: catalog.python, id: 'basedpyright', version: '1.40.2'}] : []),
    ...(catalog.go ? [{candidate: catalog.go, id: 'gopls', version: goProviderVersion}] : []),
    ...(catalog.rust ? [{candidate: catalog.rust, id: 'rust-analyzer', version: rustProviderVersion}] : []),
    ...(catalog.java ? [{candidate: catalog.java, id: 'jdtls', version: javaRuntimeQualification.serverVersion}] : []),
  ];
  if (!configured.length) return yield* LspFault.make({code: 'prerequisite'});
  for (const {candidate, id} of configured) {
    if (id !== 'jdtls') yield* verifyCandidate(candidate, id);
    if (!('runtime' in candidate)) continue;
    const version = yield* command.execute(candidate.runtime, ['--version'], {
      env: {},
      timeoutMs: 2000,
      maxOutputBytes: 128,
    });
    if (EffectString.trim(version.stdout) !== 'v24.19.0') return yield* LspFault.make({code: 'prerequisite'});
  }
  const retire = (id: string, session: AnalysisSession) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        if (session.closing) return Deferred.await(session.closed);
        session.closing = true;
        return Effect.gen(function* () {
          yield* session.api.invalidate;
          const receipt = yield* session.api.close;
          yield* Scope.close(session.scope, Exit.void);
          yield* session.reservation.release(receipt.drained && receipt.stdioClosed);
          if (sessions.get(id) === session) sessions.delete(id);
          if (!receipt.graceful) recordFailure(id, receipt.fault?.code ?? 'shutdown', session);
        }).pipe(Effect.onExit(exit => Deferred.done(session.closed, exit)));
      }),
    );
  const attach = (observation: Observation, text: string, language: SemanticLanguage, environment?: string) =>
    startup.withPermit(
      Effect.gen(function* () {
        const input = structuredClone(yield* Schema.decodeEffect(Observation)(observation));
        if (sha256HexSync(text) !== input.content) return yield* LspFault.make({code: 'protocol'});
        const providerId =
          language === 'python'
            ? 'basedpyright'
            : language === 'go'
              ? 'gopls'
              : language === 'rust'
                ? 'rust-analyzer'
                : language === 'java'
                  ? 'jdtls'
                  : 'typescript-language-server';
        const provider = EffectOption.getOrUndefined(
          EffectArray.findFirst(configured, entry => entry.id === providerId),
        );
        const candidate = provider?.candidate;
        if (!candidate && (providerId === 'gopls' || providerId === 'rust-analyzer'))
          return yield* nativeSetupFault(providerId, 'missing', 'provider');
        const selected =
          language === 'python' || language === 'java'
            ? (effectOptionalValue =>
                effectOptionalValue == null
                  ? undefined
                  : EffectOption.getOrUndefined(EffectArray.findFirst(effectOptionalValue, e => e.id === environment)))(
                language === 'python' ? catalog.python?.environments : catalog.java?.environments,
              )
            : undefined;
        if (
          !provider ||
          !candidate ||
          input.provider.id !== providerId ||
          (language === 'python' || language === 'java' ? !selected : environment !== undefined)
        )
          return yield* LspFault.make({code: 'prerequisite'});
        const toolchain = sha256HexSync(
          JSON.stringify(
            'runtimeCandidate' in candidate
              ? [
                  candidate.runtimeCandidate.serverDirectory,
                  candidate.runtimeCandidate.serverTreeDigest,
                  candidate.runtimeCandidate.runtimeJavaHome,
                  candidate.runtimeCandidate.runtimeSdkDigest,
                  candidate.runtimeCandidate.projectJavaHome,
                  candidate.runtimeCandidate.projectSdkDigest,
                  selected,
                ]
              : [
                  'runtime' in candidate ? candidate.runtimeDigest : candidate.executableDigest,
                  'runtime' in candidate ? candidate.serverTreeDigest : candidate.sdkTreeDigest,
                  'sdkTreeDigest' in candidate ? candidate.sdkTreeDigest : selected,
                ],
          ),
        );
        let fixed = {...input, toolchain};
        if (language === 'java' && fixed.worktree !== catalog.worktree)
          return yield* LspFault.make({code: 'prerequisite'});
        const project = yield* path.fromFileUrl(new URL(fixed.project));
        const worktree = yield* path.fromFileUrl(new URL(fixed.worktree));
        const file = yield* path.fromFileUrl(new URL(fixed.uri));
        if (
          !(project === worktree || EffectString.startsWith(worktree + path.sep)(project)) ||
          !EffectString.startsWith(project + path.sep)(file) ||
          EffectString.split(path.sep)(file).includes('.git') ||
          (yield* fs.realPath(project)) !== project ||
          (yield* fs.realPath(worktree)) !== worktree
        )
          return yield* LspFault.make({code: 'prerequisite'});
        if (fixed.view.kind === 'disk' && (yield* boundedFileDigest(file, 32 * 1024 * 1024)) !== fixed.content)
          return yield* LspFault.make({code: 'rejected'});
        const id = sessionIdentity(fixed);
        let session = sessions.get(id);
        const diskBasis = yield* semanticTreeDigest(worktree, providerId === 'typescript-language-server');
        fixed = {...fixed, configuration: diskBasis};
        if (session && (session.diskBasis !== diskBasis || session.basis.toolchain !== toolchain)) {
          yield* retire(id, session);
          return yield* LspFault.make({code: 'rejected'});
        }
        if (!session) {
          if ((failures.get(id) ?? 0) >= 2 || failures.size >= 256) return yield* LspFault.make({code: 'prerequisite'});
          const owned = yield* Scope.fork(scope);
          const create = Effect.gen(function* () {
            yield* verifyCandidate(candidate, providerId);
            const pythonProject =
              selected && 'runtime' in candidate
                ? yield* makePythonProject({
                    project,
                    worktree,
                    privateDirectory: path.join(home, 'semantic', 'environments'),
                    runtime: candidate.runtime,
                    environment: selected,
                  })
                : undefined;
            const nativeProject =
              'executable' in candidate
                ? language === 'go'
                  ? yield* makeGoProject({
                      project,
                      worktree,
                      sdk: candidate.sdkDirectory,
                      privateDirectory: path.join(home, 'semantic', 'environments'),
                    }).pipe(Effect.timeout(10000), Effect.provideService(CommandExecutor, command))
                  : yield* makeRustProject({
                      project,
                      worktree,
                      sdk: candidate.sdkDirectory,
                      privateDirectory: path.join(home, 'semantic', 'environments'),
                    }).pipe(Effect.timeout(10000), Effect.provideService(CommandExecutor, command))
                : undefined;
            const projectOptions = pythonProject ?? nativeProject;
            const javaDirectory =
              'runtimeCandidate' in candidate ? path.join(home, 'semantic', 'environments') : undefined;
            if (javaDirectory && 'runtimeCandidate' in candidate) {
              yield* verifyJavaOutputDirectories(
                [javaDirectory],
                [
                  worktree,
                  candidate.runtimeCandidate.serverDirectory,
                  candidate.runtimeCandidate.runtimeJavaHome,
                  candidate.runtimeCandidate.projectJavaHome,
                ],
              );
              const parent = path.dirname(javaDirectory);
              if ((yield* fs.realPath(parent)) !== parent || (yield* fs.stat(parent)).type !== 'Directory')
                return yield* LspFault.make({code: 'prerequisite'});
              if (!(yield* fs.exists(javaDirectory))) yield* fs.makeDirectory(javaDirectory, {mode: 0o700});
              if ((yield* fs.realPath(javaDirectory)) !== javaDirectory || (yield* fs.stat(javaDirectory)).mode & 0o077)
                return yield* LspFault.make({code: 'prerequisite'});
            }
            const reservation = yield* admission.acquire(
              sha256HexSync(fixed.repository + '\0' + fixed.worktree),
              10000,
            );
            fixed = {
              ...fixed,
              provider: {
                id: providerId,
                version: provider.version,
                generation: reservation.generation,
              },
              projectEpoch: reservation.generation,
            };
            const wireState: {
              finish?: LspWire['finish'];
            } = {};
            yield* Effect.addFinalizer(() =>
              wireState.finish
                ? wireState.finish.pipe(
                    Effect.flatMap(receipt => reservation.release(receipt.drained && receipt.stdioClosed)),
                    Effect.ignore,
                  )
                : Effect.void,
            );
            const verify = verifyCandidate(candidate, providerId).pipe(
              Effect.andThen(projectOptions?.verify ?? Effect.void),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(Crypto.Crypto, crypto),
            );
            let api: SemanticSession;
            if ('runtimeCandidate' in candidate) {
              if (!selected || !javaDirectory) return yield* LspFault.make({code: 'prerequisite'});
              const java = yield* makeJavaAnalysis(
                {
                  basis: fixed,
                  candidate: candidate.runtimeCandidate,
                  environment: selected,
                  privateDirectory: javaDirectory,
                },
                (pid, finish) => {
                  wireState.finish = finish;
                  return reservation.bindProvider(pid);
                },
                () => session?.closing !== true,
              );
              api = java.api;
            } else {
              const wire = yield* spawnLspWire({
                command: 'runtime' in candidate ? candidate.runtime : candidate.executable,
                args:
                  'runtime' in candidate
                    ? [
                        path.join(
                          candidate.serverDirectory,
                          language === 'python' ? 'langserver.index.js' : 'lib/cli.mjs',
                        ),
                        '--stdio',
                      ]
                    : [],
                cwd: project,
                // No repository PATH, NODE_OPTIONS, Python startup hooks, plugins or inherited execution settings.
                environment: nativeProject?.environment ?? {},
              });
              wireState.finish = wire.finish;
              yield* reservation.bindProvider(wire.pid);
              const notifications = makeSemanticNotifications();
              const client = yield* makeLspClient(wire, notifications.receive, projectOptions?.settings);
              if (pythonProject && 'runtime' in candidate) {
                api = yield* makePythonSession(client, {
                  basis: fixed,
                  notifications,
                  roots: [...pythonProject.roots, candidate.serverDirectory],
                  profile: pythonProject.profile,
                  environmentReady: pythonProject.ready,
                  startupMilliseconds: 10000,
                });
              } else if (nativeProject) {
                api = yield* (language === 'go' ? makeGoSession : makeRustSession)(client, {
                  basis: fixed,
                  notifications,
                  roots: nativeProject.roots,
                  profile: nativeProject.profile,
                  ready: nativeProject.ready,
                  initializationOptions: nativeProject.initializationOptions,
                  startupMilliseconds: 20000,
                }).pipe(
                  Effect.mapError(error =>
                    Schema.is(SemanticSessionFault)(error) && error.reason === 'provider'
                      ? nativeSetupFault(language === 'go' ? 'gopls' : 'rust-analyzer', 'incompatible', 'provider')
                      : error,
                  ),
                );
              } else {
                if (!('runtime' in candidate) || !('sdkDirectory' in candidate))
                  return yield* LspFault.make({code: 'prerequisite'});
                const ts = yield* makeTypeScriptSession(client, {
                  basis: fixed,
                  tsserver: path.join(candidate.sdkDirectory, 'lib/tsserver.js'),
                  maxMemoryMb: 512,
                  startupMilliseconds: 10000,
                });
                api = {
                  ...ts,
                  query: (operation, observation, position, milliseconds) =>
                    isCoreSemanticQuery(operation)
                      ? ts.query(operation, observation, position, milliseconds)
                      : Effect.succeed<QueryOutcome>({
                          version: 1,
                          status: 'unsupported',
                          reason: 'Optional operation is not qualified for the TypeScript profile',
                          evidence: null,
                        }),
                  upsert: (o, t, l, ms) =>
                    l === 'python' || l === 'go' || l === 'rust' || l === 'java'
                      ? Effect.fail(LspFault.make({code: 'rejected'}))
                      : ts.upsert(o, t, l, ms),
                };
              }
            }
            fixed = yield* api.upsert(fixed, text, language, 10000);
            yield* reservation.finishImport;
            return {
              scope: owned,
              api,
              verify,
              basis: fixed,
              diskBasis,
              reservation,
              queries: yield* Semaphore.make(4),
              queued: 0,
              lastUsed: yield* Clock.currentTimeMillis,
              closing: false,
              faulted: false,
              closed: Deferred.makeUnsafe<void, unknown>(),
            };
          }).pipe(Effect.provideService(Scope.Scope, owned));
          const created = yield* create.pipe(
            Effect.onExit(exit => (Exit.isFailure(exit) ? Scope.close(owned, exit) : Effect.void)),
            Effect.exit,
          );
          if (Exit.isFailure(created)) {
            yield* Scope.close(owned, created);
            const error = Cause.findErrorOption(created.cause);
            if (Option.isSome(error) && Schema.is(SemanticSetupFault)(error.value)) {
              recordFailure(id, `setup-${error.value.component}-${error.value.reason}`);
              return yield* error.value;
            }
            recordFailure(id, 'startup');
            return yield* LspFault.make({code: 'prerequisite'});
          }
          session = created.value;
          sessions.set(id, session);
        } else {
          fixed = {...fixed, provider: session.basis.provider, projectEpoch: session.basis.projectEpoch};
          const active = session;
          fixed = yield* active.api
            .upsert(fixed, text, language, 10000)
            .pipe(
              Effect.onError(() =>
                active.api.available.pipe(
                  Effect.flatMap(ready => (ready ? Effect.void : retire(id, active).pipe(Effect.ignore))),
                ),
              ),
            );
        }
        const active = session;
        const projectInfo = yield* Effect.gen(function* () {
          const info = yield* active.api.project(fixed.uri);
          if (
            (fixed.view.kind === 'disk' && (yield* boundedFileDigest(file, 32 * 1024 * 1024)) !== fixed.content) ||
            (yield* semanticTreeDigest(worktree, providerId === 'typescript-language-server')) !== diskBasis
          )
            return yield* LspFault.make({code: 'rejected'});
          return info;
        }).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? retire(id, active).pipe(Effect.ignore) : Effect.void)));
        session.lastUsed = yield* Clock.currentTimeMillis;
        return {
          observation: structuredClone(fixed),
          status: 'experimental' as const,
          completeness: 'partial' as const,
          edits: providerId !== 'typescript-language-server' ? ('preparation-only' as const) : ('disabled' as const),
          project: projectInfo,
        };
      }),
    );
  const use = <A, E, R>(
    observation: Observation,
    milliseconds: number,
    f: (api: SemanticSession) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 45000)
        return yield* LspFault.make({code: 'protocol'});
      const fixed = structuredClone(yield* Schema.decodeEffect(Observation)(observation));
      const id = sessionIdentity(fixed);
      const session = sessions.get(id);
      if (!session || session.closing) return yield* LspFault.make({code: 'prerequisite'});
      if (session.queued >= 32) return yield* LspFault.make({code: 'capacity'});
      session.queued++;
      return yield* session.queries
        .withPermit(
          Effect.gen(function* () {
            if (session.closing) return yield* LspFault.make({code: 'closing'});
            const worktree = yield* path.fromFileUrl(new URL(fixed.worktree));
            const before = yield* semanticTreeDigest(worktree, fixed.provider.id === 'typescript-language-server');
            if (before !== session.diskBasis) {
              yield* retire(id, session);
              return yield* LspFault.make({code: 'rejected'});
            }
            // Java owns complete publication fences, including this host's closing predicate.
            // Returning its committed diagnostic delta must not add another asynchronous rejection.
            if (session.basis.provider.id === 'jdtls') {
              session.lastUsed = yield* Clock.currentTimeMillis;
              return yield* f(session.api).pipe(
                Effect.onError(() =>
                  session.api.available.pipe(
                    Effect.flatMap(ready => (ready ? Effect.void : retire(id, session).pipe(Effect.ignore))),
                  ),
                ),
              );
            }
            yield* session.verify.pipe(Effect.onError(() => retire(id, session).pipe(Effect.ignore)));
            session.lastUsed = yield* Clock.currentTimeMillis;
            const result = yield* f(session.api);
            yield* session.verify.pipe(Effect.onError(() => retire(id, session).pipe(Effect.ignore)));
            if (
              session.closing ||
              (yield* semanticTreeDigest(worktree, fixed.provider.id === 'typescript-language-server')) !== before
            ) {
              yield* retire(id, session);
              return yield* LspFault.make({code: 'rejected'});
            }
            return result;
          }),
        )
        .pipe(
          Effect.timeoutOption(milliseconds),
          Effect.flatMap(result =>
            Effect.fromOption(result).pipe(Effect.mapError(() => LspFault.make({code: 'timeout'}))),
          ),
          Effect.tapError(error => {
            if (!Schema.is(LspFault)(error) || !['exit', 'write', 'protocol', 'timeout'].includes(error.code))
              return Effect.void;
            recordFailure(id, error.code, session);
            return retire(id, session).pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid);
          }),
          Effect.ensuring(
            Effect.sync(() => {
              session.queued--;
            }),
          ),
        );
    });
  yield* Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(1000);
      const now = yield* Clock.currentTimeMillis;
      for (const [id, session] of sessions)
        if (session.queued === 0 && now - session.lastUsed >= 600000) yield* retire(id, session);
    }
  }).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions, ([id, session]) => retire(id, session).pipe(Effect.ignore), {concurrency: 8}),
  );
  return {
    attach,
    use,
    status: admission.status.pipe(
      Effect.map(admission => ({
        ...admission,
        experimental: true,
        readOnly: true,
        sessions: sessions.size,
        providerProfiles: EffectArray.map(configured, ({candidate, id, version}) => ({
          id,
          version,
          status: 'experimental',
          prerequisites: 'host-qualified-candidate',
          ...(id === 'gopls' || id === 'rust-analyzer'
            ? {
                license: {
                  expression: id === 'gopls' ? 'BSD-3-Clause' : 'MIT OR Apache-2.0',
                  entitlement: 'not-required',
                  redistribution: 'release-gated',
                },
              }
            : {}),
          environments:
            'environments' in candidate ? EffectArray.map(candidate.environments, environment => environment.id) : [],
          capabilities: {
            reads: 'experimental',
            diagnostics: 'experimental',
            rename: id === 'typescript-language-server' ? 'unsupported' : 'preparation-only',
            codeActions: id === 'typescript-language-server' ? 'unsupported' : 'inline-preparation-only',
            optional: id === 'typescript-language-server' ? 'unsupported-unqualified' : 'provider-advertised-reads',
            apply: 'unsupported',
            commands: 'unsupported',
          },
        })),
        effectiveLimits: {
          queryMilliseconds: 10000,
          maximumQueryMilliseconds: 45000,
          idleMilliseconds: 600000,
          queriesPerSession: 4,
          queuedPerSession: 32,
          providerFrameBytes: 32 * 1024 * 1024,
          projectFiles: 20000,
          projectBytes: 256 * 1024 * 1024,
        },
        failures: EffectArray.map([...failures], ([id, attempts]) => ({
          attempts,
          cause: causes.get(id),
          nextAction:
            attempts >= 2
              ? 'Correct prerequisites and restart the idle coordinator explicitly'
              : 'Reattach an explicit view once prerequisites are ready',
        })),
        limitations: [
          'Read-only experimental pilot',
          'Symlinked/external projects require further qualification',
          'Aggregate RSS pressure enforcement remains a mandatory release qualification gate',
        ],
      })),
    ),
    closeView: (observation: Observation) =>
      Effect.suspend(() => {
        const id = sessionIdentity(observation);
        const session = sessions.get(id);
        return session ? retire(id, session) : Effect.void;
      }),
  };
});
const Request = Schema.Union([
  Schema.Struct({operation: Schema.Literal('status')}),
  Schema.Struct({operation: Schema.Literal('shutdown')}),
  Schema.Struct({
    operation: Schema.Literal('attach'),
    observation: Observation,
    text: Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024)),
    language: SemanticLanguage,
    environment: Schema.optional(Identifier),
  }),
  Schema.Struct({
    operation: Schema.Literal('query'),
    observation: Observation,
    query: SemanticQuery,
    position: Schema.optional(Position),
    milliseconds: Counter,
  }),
  Schema.Struct({
    operation: Schema.Literal('prepare'),
    observation: Observation,
    edit: Schema.Literals(['rename', 'code-action']),
    position: Position,
    newName: Schema.optional(Identifier),
    milliseconds: Counter,
  }),
  Schema.Struct({operation: Schema.Literal('diagnostics'), observation: Observation, milliseconds: Counter}),
  Schema.Struct({operation: Schema.Literal('close'), observation: Observation}),
]);
export type SemanticRequest = typeof Request.Type;
type Coordinator = Effect.Success<ReturnType<typeof makeSemanticCoordinator>>;
interface EndpointOptions {
  readonly directory: string;
  readonly token: string;
  readonly worktree: string;
}
/** Local socket only. Bootstrap attachment and each source view have separate unguessable capabilities. */
export const serveSemanticEndpoint = Effect.fn('semantic.serveEndpoint')(function* (
  coordinator: Coordinator,
  options: EndpointOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  if (!Schema.is(Digest)(options.token) || !Schema.is(FileUri)(options.worktree))
    return yield* LspFault.make({code: 'protocol'});
  yield* fs.makeDirectory(options.directory, {recursive: true, mode: 0o700});
  if (
    (yield* fs.realPath(options.directory)) !== path.resolve(options.directory) ||
    (yield* fs.stat(options.directory)).mode & 0o077
  )
    return yield* LspFault.make({code: 'prerequisite'});
  const socket = path.join(options.directory, 'rpc.sock');
  if (new TextEncoder().encode(socket).length > 100) return yield* LspFault.make({code: 'prerequisite'});
  const grants = new Map<
    string,
    {
      token: string;
      lastUsed: number;
      gate: Semaphore.Semaphore;
    }
  >();
  let requests = 0;
  let shutdown = false;
  let lastUsed = yield* Clock.currentTimeMillis;
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.authorization !== `Bearer ${options.token}` || request.method !== 'POST' || request.url !== '/')
      return HttpServerResponse.jsonUnsafe({status: 'unavailable'}, {status: 403});
    if (requests >= 36)
      return HttpServerResponse.jsonUnsafe({status: 'unavailable', reason: 'capacity'}, {status: 429});
    requests++;
    return yield* Effect.gen(function* () {
      const body = yield* Schema.decodeUnknownEffect(Request)(yield* request.json);
      lastUsed = yield* Clock.currentTimeMillis;
      if (body.operation === 'status') return yield* coordinator.status;
      if (body.operation === 'shutdown') {
        const status = yield* coordinator.status;
        if (status.sessions !== 0 || grants.size !== 0 || requests !== 1)
          return yield* LspFault.make({code: 'closing'});
        shutdown = true;
        return {status: 'shutting-down'};
      }
      if (body.observation.worktree !== options.worktree) return yield* LspFault.make({code: 'rejected'});
      const id = sessionIdentity(body.observation);
      let grant = grants.get(id);
      let created = false;
      if (!grant && body.operation === 'attach') {
        const token = sha256HexSync(yield* crypto.randomBytes(32));
        // Randomness yields: reserve only after rechecking the current owner.
        grant = grants.get(id);
        if (!grant) {
          if (grants.size >= 256) return yield* LspFault.make({code: 'capacity'});
          grant = {token, lastUsed, gate: Semaphore.makeUnsafe(1)};
          grants.set(id, grant);
          created = true;
        }
      }
      if (grant && !created && grant.token !== request.headers['x-threadnote-view'])
        return yield* SemanticSessionFault.make({reason: 'conflict'});
      if (!grant) return yield* LspFault.make({code: 'rejected'});
      grant.lastUsed = lastUsed;
      if (body.operation === 'attach' || body.operation === 'close') {
        const claim = grant;
        return yield* claim.gate
          .withPermit(
            Effect.gen(function* () {
              if (grants.get(id) !== claim) return yield* SemanticSessionFault.make({reason: 'conflict'});
              if (body.operation === 'close') {
                yield* coordinator.closeView(body.observation);
                grants.delete(id);
                return {status: 'closed'};
              }
              const result = yield* coordinator.attach(body.observation, body.text, body.language, body.environment);
              return {...result, capability: claim.token};
            }),
          )
          .pipe(
            Effect.onExit(exit =>
              Exit.isFailure(exit) && created
                ? coordinator.closeView(body.observation).pipe(
                    Effect.ignore,
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (grants.get(id) === claim) grants.delete(id);
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
      }
      if (body.operation === 'prepare')
        return yield* coordinator.use(body.observation, body.milliseconds, api =>
          api.prepare
            ? api.prepare(body.edit, body.observation, body.position, body.newName, body.milliseconds)
            : Effect.succeed<QueryOutcome>({
                version: 1,
                status: 'unsupported',
                reason: 'Provider edit preparation is unavailable',
                evidence: null,
              }),
        );
      if (body.operation === 'diagnostics')
        return yield* coordinator.use(body.observation, body.milliseconds, api =>
          api.diagnostics(body.observation, body.milliseconds),
        );
      return yield* coordinator.use(body.observation, body.milliseconds, api =>
        api.query(body.query, body.observation, body.position, body.milliseconds),
      );
    }).pipe(
      Effect.flatMap(result =>
        Effect.try({
          try: () => {
            const text = JSON.stringify(result);
            if (new TextEncoder().encode(text).length > 32 * 1024 * 1024)
              return HttpServerResponse.jsonUnsafe({status: 'unavailable', reason: 'capacity'}, {status: 413});
            return HttpServerResponse.jsonUnsafe(result);
          },
          catch: () => LspFault.make({code: 'protocol'}),
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              status: 'unavailable',
              readOnly: true,
              reason: Schema.is(LspFault)(error)
                ? error.code
                : Schema.is(SemanticSessionFault)(error)
                  ? error.reason
                  : Schema.is(SemanticSetupFault)(error)
                    ? 'setup'
                    : 'prerequisite',
              ...(Schema.is(SemanticSetupFault)(error)
                ? {
                    setup: {
                      providerId: error.providerId,
                      reason: error.reason,
                      component: error.component,
                      requiredVersion: error.requiredVersion,
                      requiredSdkVersion: error.requiredSdkVersion,
                    },
                  }
                : {}),
              nextAction: Schema.is(SemanticSetupFault)(error)
                ? error.nextAction
                : 'Inspect semantic status and source-view readiness; structural graph and memory remain available',
            },
            {status: 409},
          ),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          requests--;
        }),
      ),
    );
  });
  const server = yield* BunHttpServer.make({
    unix: socket,
    maxRequestBodySize: 16 * 1024 * 1024,
    idleTimeout: 55,
    gracefulShutdownTimeout: 2000,
  });
  yield* fs.chmod(socket, 0o600);
  yield* server.serve(handler);
  yield* Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(1000);
      const now = yield* Clock.currentTimeMillis;
      for (const [id, grant] of grants) {
        yield* grant.gate.withPermitsIfAvailable(1)(
          Effect.sync(() => {
            if (grants.get(id) === grant && now - grant.lastUsed >= 600000) grants.delete(id);
          }),
        );
      }
    }
  }).pipe(Effect.forkScoped);
  return {
    socket,
    idle: Effect.sync(() => requests === 0).pipe(
      Effect.flatMap(empty =>
        Clock.currentTimeMillis.pipe(Effect.map(now => empty && (shutdown || now - lastUsed >= 600000))),
      ),
    ),
  };
});
/** Promise conversion is limited to this local OS IPC boundary; cancellation aborts the HTTP request. */
export function requestSemanticEndpoint(socket: string, token: string, body: SemanticRequest, capability?: string) {
  return fromPromiseInterruptible(
    async signal => {
      const response = await fetch('http://threadnote.semantic/', {
        unix: socket,
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(capability ? {'x-threadnote-view': capability} : {}),
        },
        body: JSON.stringify(body),
      });
      const reader = response.body?.getReader();
      if (!reader) throw LspFault.make({code: 'protocol'});
      const decoder = new TextDecoder('utf-8', {fatal: true});
      let text = '';
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 32 * 1024 * 1024) {
            await reader.cancel();
            throw LspFault.make({code: 'capacity'});
          }
          text += decoder.decode(chunk.value, {stream: true});
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const json: unknown = JSON.parse(text);
      return json;
    },
    error => (Schema.is(LspFault)(error) ? error : LspFault.make({code: 'protocol'})),
  ).pipe(
    Effect.timeoutOption(45000),
    Effect.flatMap(result =>
      Option.isSome(result)
        ? Schema.decodeUnknownEffect(Schema.Json)(result.value).pipe(
            Effect.mapError(() => LspFault.make({code: 'protocol'})),
          )
        : Effect.fail(LspFault.make({code: 'timeout'})),
    ),
  );
}
const HostCandidate = Schema.Struct({
  runtime: Schema.String,
  runtimeDigest: Digest,
  runtimeVersion: Schema.Literal('24.19.0'),
  serverDirectory: Schema.String,
  serverTreeDigest: Digest,
  sdkDirectory: Schema.String,
  sdkTreeDigest: Digest,
});
const SdkCandidate = Schema.Struct({
  executable: Schema.String,
  executableDigest: Digest,
  sdkDirectory: Schema.String,
  sdkTreeDigest: Digest,
});
const Bootstrap = Schema.Struct({
  version: Schema.Literal(1),
  runtimeIdentity: Digest,
  token: Digest,
  worktree: FileUri,
  dataHome: Schema.String,
  candidate: Schema.optional(HostCandidate),
  go: Schema.optional(SdkCandidate),
  rust: Schema.optional(SdkCandidate),
  java: Schema.optional(JavaHostCandidate),
  python: Schema.optional(
    Schema.Struct({
      runtime: Schema.String,
      runtimeDigest: Digest,
      runtimeVersion: Schema.Literal('24.19.0'),
      serverDirectory: Schema.String,
      serverTreeDigest: Digest,
      environments: Schema.Array(PythonEnvironment).check(Schema.isMaxLength(16)),
    }),
  ),
});
export interface SemanticEndpointLaunch extends SemanticCoordinatorOptions {
  readonly worktree: string;
  /** Exact application/runtime identity supplied by the host, independent of provider selection. */
  readonly runtimeIdentity: string;
}
/** Starts one runtime/worktree coordinator lazily. Capabilities/source text never enter process arguments. */
export const ensureSemanticEndpoint = Effect.fn('semantic.ensureEndpoint')(function* (options: SemanticEndpointLaunch) {
  const launch = structuredClone(options);
  if (!launch.enabled || !Schema.is(Digest)(launch.runtimeIdentity) || !Schema.is(FileUri)(launch.worktree))
    return yield* LspFault.make({code: 'prerequisite'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const crypto = yield* Crypto.Crypto;
  const home = yield* fs.realPath(launch.dataHome);
  if (home !== path.resolve(launch.dataHome)) return yield* LspFault.make({code: 'prerequisite'});
  if (launch.java) yield* verifyJavaCoordinatorDirectory(launch.java, home, launch.worktree);
  const key = sha256HexSync(JSON.stringify([home, launch.worktree, launch.runtimeIdentity]));
  const directory = path.join(home, 'semantic', EffectString.slice(0, 20)(key));
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  if ((yield* fs.realPath(directory)) !== directory || (yield* fs.stat(directory)).mode & 0o077)
    return yield* LspFault.make({code: 'prerequisite'});
  const bootstrapFile = path.join(directory, 'host.json');
  const socket = path.join(directory, 'rpc.sock');
  return yield* withExclusiveFileLock(
    fs,
    path.join(directory, 'startup.lock'),
    {
      createParentDirectory: false,
      retryIntervalMilliseconds: 25,
      waitTimeoutMilliseconds: 15000,
      staleAfterMilliseconds: 60000,
      useCanonicalProcessStartIdentity: true,
    },
    Effect.gen(function* () {
      let bootstrap: typeof Bootstrap.Type;
      const existing = yield* fs.exists(bootstrapFile);
      if (existing) {
        bootstrap = yield* readSemanticBootstrap(bootstrapFile);
        if (
          bootstrap.worktree !== launch.worktree ||
          bootstrap.runtimeIdentity !== launch.runtimeIdentity ||
          bootstrap.dataHome !== home ||
          semanticCatalogKey(bootstrap) !== semanticCatalogKey(launch)
        )
          return yield* LspFault.make({code: 'prerequisite'});
      } else {
        bootstrap = {
          version: 1,
          runtimeIdentity: launch.runtimeIdentity,
          worktree: launch.worktree,
          token: sha256HexSync(yield* crypto.randomBytes(32)),
          dataHome: home,
          ...(launch.candidate ? {candidate: launch.candidate} : {}),
          ...(launch.python ? {python: launch.python} : {}),
          ...(launch.go ? {go: launch.go} : {}),
          ...(launch.rust ? {rust: launch.rust} : {}),
          ...(launch.java ? {java: launch.java} : {}),
        };
      }
      const serialized = JSON.stringify(bootstrap);
      if (new TextEncoder().encode(serialized).length > 16 * 1024) return yield* LspFault.make({code: 'capacity'});
      const probe = requestSemanticEndpoint(socket, bootstrap.token, {operation: 'status'}).pipe(
        Effect.timeoutOption(250),
        Effect.map(
          result =>
            Option.isSome(result) &&
            typeof result.value === 'object' &&
            result.value !== null &&
            'experimental' in result.value &&
            result.value.experimental === true,
        ),
        Effect.orElseSucceed(() => false),
      );
      if (!(yield* probe)) {
        // Surface native setup causes in the parent before publishing bootstrap or waiting for a worker that cannot start.
        if (launch.go) yield* verifyNativeSemanticCandidate(launch.go, 'gopls');
        if (launch.rust) yield* verifyNativeSemanticCandidate(launch.rust, 'rust-analyzer');
        if (!existing) yield* fs.writeFileString(bootstrapFile, serialized, {flag: 'wx', mode: 0o600});
        const name = (effectOptionalValue =>
          effectOptionalValue == null ? undefined : EffectString.toLowerCase(effectOptionalValue))(
          EffectString.split('/')(EffectString.replaceAll('\\', '/')(system.executablePath)).at(-1),
        );
        const args = [
          ...(name === 'bun' || name === 'bun.exe' ? [system.developmentEntrypoint] : []),
          '__semantic-coordinator',
          '--config',
          bootstrapFile,
        ];
        const started = yield* runDetachedCommandEffect(system.executablePath, args, {
          env: system.intendedChildEnvironment(system.environment(), 'semantic-coordinator'),
        });
        if (!started) return yield* LspFault.make({code: 'prerequisite'});
        const until = (yield* Clock.currentTimeMillis) + 10000;
        while (!(yield* probe)) {
          if ((yield* Clock.currentTimeMillis) >= until) return yield* LspFault.make({code: 'timeout'});
          yield* Effect.sleep(100);
        }
      }
      return {
        request: (body: SemanticRequest, capability?: string) =>
          requestSemanticEndpoint(socket, bootstrap.token, body, capability),
      };
    }),
  );
});
const readSemanticBootstrap = Effect.fn('semantic.readBootstrap')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    (yield* fs.realPath(path.dirname(file))) !== path.dirname(file) ||
    Option.isSome(yield* fs.readLink(file).pipe(Effect.option))
  )
    return yield* LspFault.make({code: 'prerequisite'});
  const info = yield* fs.stat(file);
  if (info.type !== 'File' || info.mode & 0o077 || Number(info.size) > 16 * 1024)
    return yield* LspFault.make({code: 'prerequisite'});
  const text = yield* readBoundedText(file, 16 * 1024);
  const raw = yield* Effect.try({try: () => JSON.parse(text), catch: () => LspFault.make({code: 'protocol'})});
  return yield* Schema.decodeUnknownEffect(Bootstrap)(raw);
});
export const runSemanticCoordinatorWorker = Effect.fn('semantic.worker')(function* (arguments_: readonly string[]) {
  if (arguments_.length !== 2 || arguments_[0] !== '--config') return yield* LspFault.make({code: 'protocol'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bootstrap = yield* readSemanticBootstrap(arguments_[1]);
  const directory = path.dirname(arguments_[1]);
  return yield* withExclusiveFileLock(
    fs,
    path.join(directory, 'worker.lock'),
    {
      createParentDirectory: false,
      retryIntervalMilliseconds: 25,
      waitTimeoutMilliseconds: 250,
      staleAfterMilliseconds: 60000,
      useCanonicalProcessStartIdentity: true,
    },
    Effect.scoped(
      Effect.gen(function* () {
        const socket = path.join(directory, 'rpc.sock');
        yield* fs.remove(socket).pipe(Effect.ignore);
        const coordinator = yield* makeSemanticCoordinator({
          enabled: true,
          dataHome: bootstrap.dataHome,
          candidate: bootstrap.candidate,
          python: bootstrap.python,
          go: bootstrap.go,
          rust: bootstrap.rust,
          java: bootstrap.java,
          worktree: bootstrap.worktree,
        });
        const endpoint = yield* serveSemanticEndpoint(coordinator, {
          directory,
          token: bootstrap.token,
          worktree: bootstrap.worktree,
        });
        while ((yield* fs.exists(arguments_[1])) && !(yield* endpoint.idle)) yield* Effect.sleep(1000);
      }),
    ),
  );
});
const Ticket = Schema.Struct({token: Digest, workspace: Digest, owner: Instance});
const Ledger = Schema.Struct({
  version: Schema.Literal(1),
  nextGeneration: Counter,
  slots: Schema.Array(Reservation).check(Schema.isMaxLength(8)),
  tickets: Schema.Array(Ticket).check(Schema.isMaxLength(32)),
});
type Ledger = {
  version: 1;
  nextGeneration: number;
  slots: (typeof Reservation.Type)[];
  tickets: (typeof Ticket.Type)[];
};
const limits = Object.freeze({providersPerHome: 8, providersPerWorkspace: 4, importsPerHome: 2, queued: 32});
/** Probe only. Unknown/EPERM remains occupied; no PID-only signalling or recovery. */
function processGroupPresent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return !isJsonObject(cause) || cause.code !== 'ESRCH';
  }
}
export interface SemanticAdmissionOptions {
  /** One stable, private directory in the canonical data home, shared across runtime generations/worktrees. */
  readonly directory: string;
  readonly processGroupPresent?: (pid: number) => boolean;
}
export interface SemanticReservation {
  readonly generation: number;
  readonly bindProvider: (pid: number) => Effect.Effect<void, unknown>;
  readonly finishImport: Effect.Effect<void, unknown>;
  /** A positive group-drain receipt is required; failure conserves/quarantines the reservation. */
  readonly release: (drained: boolean) => Effect.Effect<void, unknown>;
}
/** File-locked FIFO admission is shared by every worktree coordinator, rather than a per-process counter. */
export const makeSemanticAdmission = Effect.fn('semantic.makeAdmission')(function* (options: SemanticAdmissionOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const crypto = yield* Crypto.Crypto;
  const identity = yield* system.canonicalProcessStartIdentity?.(system.processId) ?? succeedUndefined;
  if (!identity || system.platform === 'win32') return yield* LspFault.make({code: 'prerequisite'});
  const owner: Instance = {pid: system.processId, identity};
  yield* fs.makeDirectory(options.directory, {recursive: true, mode: 0o700});
  const directory = yield* fs.realPath(options.directory);
  if (directory !== path.resolve(options.directory) || (yield* fs.stat(directory)).mode & 0o077)
    return yield* LspFault.make({code: 'prerequisite'});
  const ledgerPath = path.join(directory, 'admission-v1.json');
  const groupPresent = options.processGroupPresent ?? processGroupPresent;
  const token = () => crypto.randomBytes(32).pipe(Effect.map(bytes => sha256HexSync(bytes)));
  const alive = (instance: Instance) =>
    Effect.gen(function* () {
      if (!system.isProcessRunning(instance.pid)) return false;
      const observed = yield* system.canonicalProcessStartIdentity?.(instance.pid) ?? succeedUndefined;
      // Missing identity is uncertainty, not proof of death. Different canonical identities prove reuse.
      return observed === undefined || observed === instance.identity;
    });
  const transaction = <A, E, R>(f: (ledger: Ledger) => Effect.Effect<A, E, R>) =>
    withExclusiveFileLock(
      fs,
      path.join(directory, 'admission-v1.lock'),
      {
        createParentDirectory: false,
        retryIntervalMilliseconds: 20,
        waitTimeoutMilliseconds: 2000,
        staleAfterMilliseconds: 10000,
        useCanonicalProcessStartIdentity: true,
      },
      Effect.gen(function* () {
        let ledger: Ledger = {version: 1, nextGeneration: 0, slots: [], tickets: []};
        if (yield* fs.exists(ledgerPath)) {
          const info = yield* fs.stat(ledgerPath);
          if (
            info.type !== 'File' ||
            info.mode & 0o077 ||
            Number(info.size) > 128 * 1024 ||
            Option.isSome(yield* fs.readLink(ledgerPath).pipe(Effect.option))
          )
            return yield* LspFault.make({code: 'prerequisite'});
          const raw = yield* readBoundedText(ledgerPath, 128 * 1024);
          const json = yield* Effect.try({try: () => JSON.parse(raw), catch: () => LspFault.make({code: 'protocol'})});
          const decoded = yield* Schema.decodeUnknownEffect(Ledger)(json);
          ledger = {
            version: 1,
            nextGeneration: decoded.nextGeneration,
            slots: [...decoded.slots],
            tickets: [...decoded.tickets],
          };
        }
        ledger.tickets = yield* Effect.filter(ledger.tickets, ticket => alive(ticket.owner));
        const retained: Ledger['slots'] = [];
        for (const slot of ledger.slots) {
          if (yield* alive(slot.owner)) {
            retained.push(slot);
            continue;
          }
          if (slot.provider && !(yield* alive(slot.provider)) && !groupPresent(slot.provider.pid)) continue;
          // A crash between reservation and provider registration cannot safely be guessed away.
          retained.push({...slot, quarantined: true});
        }
        ledger.slots = retained;
        const result = yield* f(ledger);
        const temporary = path.join(directory, `.admission-${yield* token()}`);
        yield* fs
          .writeFileString(temporary, JSON.stringify(ledger), {flag: 'wx', mode: 0o600})
          .pipe(
            Effect.andThen(fs.rename(temporary, ledgerPath)),
            Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
          );
        return result;
      }),
    ).pipe(
      Effect.provideService(SystemInfo, system),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(Path.Path, path),
    );
  const status = transaction(ledger =>
    Effect.succeed({
      limits,
      providers: ledger.slots.length,
      imports: EffectArray.filter(ledger.slots, slot => slot.importing).length,
      queued: ledger.tickets.length,
      quarantined: EffectArray.filter(ledger.slots, slot => slot.quarantined).length,
      nextAction: EffectArray.some(ledger.slots, slot => slot.quarantined)
        ? 'Inspect owned process trees; uncertain reservations remain occupied'
        : 'Ready',
    }),
  );
  const acquire = (workspace: string, milliseconds: number) =>
    Effect.gen(function* () {
      if (
        !Schema.is(Digest)(workspace) ||
        !Number.isSafeInteger(milliseconds) ||
        milliseconds < 1 ||
        milliseconds > 120000
      )
        return yield* LspFault.make({code: 'protocol'});
      const id = yield* token();
      let assigned = false;
      let generation = 0;
      yield* Effect.addFinalizer(() =>
        transaction(ledger =>
          Effect.sync(() => {
            ledger.tickets = EffectArray.filter(ledger.tickets, ticket => ticket.token !== id);
            ledger.slots = EffectArray.map(ledger.slots, slot =>
              slot.token === id ? {...slot, quarantined: true} : slot,
            );
          }),
        ).pipe(Effect.ignore),
      );
      yield* transaction(ledger =>
        Effect.gen(function* () {
          if (ledger.tickets.length >= limits.queued) return yield* LspFault.make({code: 'capacity'});
          ledger.tickets.push({token: id, workspace, owner});
        }),
      );
      yield* Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        while (!assigned) {
          assigned = yield* transaction(ledger =>
            Effect.sync(() => {
              if (
                ledger.slots.length >= limits.providersPerHome ||
                EffectArray.filter(ledger.slots, slot => slot.importing).length >= limits.importsPerHome
              )
                return false;
              // Skip a ticket blocked by its own workspace cap so another workspace can progress.
              const eligible = EffectOption.getOrUndefined(
                EffectArray.findFirst(
                  ledger.tickets,
                  ticket =>
                    EffectArray.filter(ledger.slots, slot => slot.workspace === ticket.workspace).length <
                    limits.providersPerWorkspace,
                ),
              );
              if (eligible?.token !== id || ledger.nextGeneration >= Number.MAX_SAFE_INTEGER) return false;
              generation = ++ledger.nextGeneration;
              ledger.tickets = EffectArray.filter(ledger.tickets, ticket => ticket.token !== id);
              ledger.slots.push({
                token: id,
                workspace,
                owner,
                provider: null,
                generation,
                importing: true,
                quarantined: false,
              });
              return true;
            }),
          );
          if (assigned) break;
          if ((yield* Clock.currentTimeMillis) - started >= milliseconds)
            return yield* LspFault.make({code: 'timeout'});
          yield* Effect.sleep(20);
        }
      }).pipe(
        Effect.ensuring(
          transaction(ledger =>
            Effect.sync(() => {
              ledger.tickets = EffectArray.filter(ledger.tickets, ticket => ticket.token !== id);
            }),
          ).pipe(Effect.ignore),
        ),
      );
      let released = false;
      const update = (f: (slot: typeof Reservation.Type) => typeof Reservation.Type | undefined) =>
        transaction(ledger =>
          Effect.gen(function* () {
            if (released) return;
            const index = EffectOption.getOrElse(
              EffectArray.findFirstIndex(
                ledger.slots,
                slot => slot.token === id && slot.owner.pid === owner.pid && slot.owner.identity === owner.identity,
              ),
              () => -1,
            );
            if (index < 0) return yield* LspFault.make({code: 'closing'});
            const next = f(ledger.slots[index]);
            if (next) ledger.slots[index] = next;
            else {
              ledger.slots.splice(index, 1);
              released = true;
            }
          }),
        );
      return {
        generation,
        bindProvider: (pid: number) =>
          Effect.gen(function* () {
            const identity = yield* system.canonicalProcessStartIdentity?.(pid) ?? succeedUndefined;
            if (!identity || !Number.isSafeInteger(pid) || pid <= 0)
              return yield* LspFault.make({code: 'prerequisite'});
            yield* update(slot => ({...slot, provider: {pid, identity}}));
          }),
        finishImport: update(slot => ({...slot, importing: false})),
        release: (drained: boolean) =>
          update(slot => (drained ? undefined : {...slot, quarantined: true, importing: false})),
      } satisfies SemanticReservation;
    });
  return {acquire, status};
});
