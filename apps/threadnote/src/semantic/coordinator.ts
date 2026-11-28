import {
  makeSemanticAdmission,
  prepareSemanticEndpointDirectory,
  withSemanticEndpointLock,
  readSemanticEndpointBootstrap,
  publishSemanticEndpointBootstrap,
  semanticSessionLimits,
  SemanticCompatibilityFault,
  type SemanticReservation,
} from './admission.js';
export {
  makeSemanticAdmission,
  semanticSessionLimits,
  SemanticCompatibilityFault,
  type SemanticReservation,
  type SemanticAdmissionOptions,
  type SemanticPressure,
} from './admission.js';
import {SemanticAgentEndpointChange, semanticAgentChangeLimits} from './agent_change_protocol.js';
import {makeSemanticAgentChanges} from './agent_changes.js';
import {semanticCandidateMetadata, semanticCandidateRoots} from './candidate_fence.js';
import {Digest as EffectDigest, SecureRandom} from 'effect/crypto';
import {
  JavaHostCandidate,
  NativeTypeScriptHostCandidate,
  SemanticHostCatalog,
  semanticCatalogKey,
  semanticHostSelection,
  type TypeScriptHostCandidate,
  type PythonHostCandidate,
} from './host_catalog.js';
export {
  semanticCandidateKey,
  semanticCatalogKey,
  type TypeScriptHostCandidate,
  type PythonHostCandidate,
  type JavaHostCandidate,
} from './host_catalog.js';
import {
  SemanticAgentEndpointQuery,
  SemanticAgentEndpointView,
  SemanticAgentBufferHandle,
  SemanticEndpointReadiness,
  SemanticVerificationReply,
} from './agent_query_protocol.js';
import {makeSemanticOwnedBufferViews} from './owned_buffer_views.js';
import {makeSemanticAgentDiskQueries} from './agent_query_store.js';
import {
  makeSemanticReadinessJobs,
  makeSemanticStartupBinding,
  semanticCompiledRuntimeIdentity,
  runSemanticSelectedVerification,
  verifyReadinessProfile,
  type SemanticStartupControl,
} from './readiness_jobs.js';
import {
  hasReadCleanupUnconfirmed,
  makeReadDeadline,
  ReadDeadlineContext,
  readDeadlineRemaining,
  withinReadDeadline,
} from '@threadnote/platform/read_deadline';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {
  Cause,
  Clock,
  Console,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Option,
  Order,
  Path,
  Schema,
  Scope,
  Semaphore,
} from 'effect';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import {SystemInfo, runtimePlatform} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  Counter,
  Digest,
  FileUri,
  Identifier,
  Observation,
  observationKey,
  Position,
  type QueryOutcome,
} from '@threadnote/semantic/contracts';
import {sha256FileHex} from '@threadnote/platform/digest';
import {CommandExecutor, runDetachedCommandEffect} from '@threadnote/platform/command';
import {LspFault, makeLspClient, SemanticWireStartup, spawnLspWire, type LspWire} from './lsp_transport.js';
import {SemanticProviderNotRunning} from './source_evidence.js';
import {makeTypeScriptSession, semanticTypeScriptCoordinatorSession} from './providers/typescript.js';
import {verifyNativeTypeScriptCandidate} from './providers/typescript_runtime.js';
import {recheckNativeTypeScriptExecutable} from '@threadnote/graph/typescript_runtime';
import {
  SemanticSessionFault,
  SemanticSetupFault,
  SemanticLanguage,
  SemanticQuery,
  makeSemanticNotifications,
  SemanticJavaRuntimeVerifier,
  SemanticPrivateSourceEvidence,
  makeSemanticSources,
  makeSemanticDiskSourceCapture,
  takeCurrentSemanticPrepared,
  validateSemanticSource,
  type WindowsSemanticSources,
  type SemanticSession,
  type SdkHostCandidate,
} from './provider.js';
import {makePythonSession} from './providers/python.js';
import {makePythonProject, PythonEnvironment} from './providers/python_project.js';
import {makeJavaAnalysis, verifyJavaOutputDirectories} from './providers/java.js';
import {
  javaRuntimeQualification,
  javaRuntimePinsForHost,
  javaRuntimeSetupAction,
  makeJavaRuntime,
} from './providers/java_runtime.js';
import {makeGoProject, makeGoSession, goProviderVersion, goRuntimePinsForHost} from './providers/go.js';
import {makeRustProject, makeRustSession, rustProviderVersion, rustRuntimePinsForHost} from './providers/rust.js';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {
  boundedFileDigest,
  readBoundedText,
  semanticTreeDigest,
  semanticSdkDigest,
  typeScriptConfigurationHasExtendsCycle,
} from './fingerprint.js';
export {semanticTreeDigest} from './fingerprint.js';
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
  yield* makeJavaRuntime(selected.runtimeCandidate).pipe(Effect.provideService(SemanticJavaRuntimeVerifier, undefined));
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
  for (const root of [
    candidate.runtimeCandidate.serverDirectory,
    candidate.runtimeCandidate.runtimeJavaHome,
    candidate.runtimeCandidate.projectJavaHome,
  ])
    if (!path.isAbsolute(root) || (yield* fs.realPath(root)) !== root)
      return yield* SemanticSetupFault.make({
        providerId: 'jdtls',
        component: 'sdk',
        reason: 'incompatible',
        requiredVersion: javaRuntimeQualification.serverVersion,
        requiredSdkVersion: javaRuntimeQualification.runtimeVersion,
        nextAction: 'Restore canonical qualified Java SDK roots',
      });
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
/** Cheap canonical/protected-root fences precede bootstrap writes; byte trust stays selected and explicit. */
const verifyCoordinatorStorage = Effect.fn('semantic.verifyCoordinatorStorage')(function* (
  catalog: SemanticCoordinatorOptions,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots: string[] = [];
  if (catalog.worktree) roots.push(yield* path.fromFileUrl(new URL(catalog.worktree)));
  for (const candidate of [
    catalog.candidate,
    catalog.nativeCandidate,
    catalog.python,
    catalog.go,
    catalog.rust,
    catalog.java,
  ])
    if (candidate) roots.push(...semanticCandidateRoots(candidate));
  for (const root of roots) {
    if (
      !path.isAbsolute(root) ||
      Option.isSome(yield* fs.readLink(root).pipe(Effect.option)) ||
      ((yield* fs.exists(root)) && (yield* fs.realPath(root)) !== path.resolve(root))
    )
      return yield* LspFault.make({code: 'prerequisite'});
  }
  yield* verifyJavaOutputDirectories([path.join(home, 'semantic')], roots);
});
export interface SemanticCoordinatorOptions {
  readonly enabled: boolean;
  readonly dataHome: string;
  readonly candidate?: TypeScriptHostCandidate;
  readonly nativeCandidate?: NativeTypeScriptHostCandidate;
  readonly python?: PythonHostCandidate;
  readonly go?: SdkHostCandidate;
  readonly rust?: SdkHostCandidate;
  readonly java?: JavaHostCandidate;
  /** Java must bind its protected worktree before allocating shared coordinator state. */
  readonly worktree?: string;
  /** Exact-runtime, host-owned selected verification; never accepted from public requests. */
  readonly verifySelected?: (
    id: string,
    candidate:
      | TypeScriptHostCandidate
      | NativeTypeScriptHostCandidate
      | PythonHostCandidate
      | SdkHostCandidate
      | JavaHostCandidate,
    runtimeVersion: boolean,
    configurationOnly: boolean,
  ) => Effect.Effect<string, unknown>;
}
interface AnalysisSession {
  readonly sources?: WindowsSemanticSources;
  readonly scope: Scope.Closeable;
  readonly api: SemanticSession;
  readonly verify: Effect.Effect<void, unknown>;
  readonly verifyNativeOwner?: Effect.Effect<void, LspFault>;
  readonly basis: Observation;
  readonly diskBasis: string;
  readonly reservation: SemanticReservation;
  readonly startup: ReturnType<typeof makeSemanticStartupBinding>;
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
  const pins = id === 'gopls' ? goRuntimePinsForHost() : rustRuntimePinsForHost();
  if (!pins) return yield* nativeSetupFault(id, 'incompatible', 'provider');
  const expected = pins.providerExecutableDigest;
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
    if (
      !Schema.is(Digest)(candidate.sdkTreeDigest) ||
      !path.isAbsolute(candidate.sdkDirectory) ||
      (pins.sdkTreeDigest !== undefined && candidate.sdkTreeDigest !== pins.sdkTreeDigest)
    )
      return yield* nativeSetupFault(id, 'incompatible', 'sdk');
    if (!(yield* fs.exists(candidate.sdkDirectory))) return yield* nativeSetupFault(id, 'missing', 'sdk');
    if (
      (yield* fs.realPath(candidate.sdkDirectory)) !== candidate.sdkDirectory ||
      (yield* fs.stat(candidate.sdkDirectory)).type !== 'Directory'
    )
      return yield* nativeSetupFault(id, 'incompatible', 'sdk');
    const tools =
      pins.provider === 'gopls'
        ? [['go', pins.goExecutableDigest]]
        : [
            ['rustc', pins.rustcExecutableDigest],
            ['cargo', pins.cargoExecutableDigest],
          ];
    for (const [file, digest] of tools) {
      const tool = path.join(candidate.sdkDirectory, 'bin', file + (runtimePlatform === 'win32' ? '.exe' : ''));
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
export const verifySemanticNodeCandidate = Effect.fn('semantic.verifyNodeCandidate')(function* (
  candidate: TypeScriptHostCandidate | PythonHostCandidate,
  verifyRuntimeVersion = false,
  ownedWorkerGroup = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
  if (verifyRuntimeVersion) {
    const command = yield* CommandExecutor;
    const version = yield* command.execute(candidate.runtime, ['--version'], {
      detached: ownedWorkerGroup ? false : undefined,
      env: {},
      timeoutMs: 2000,
      maxOutputBytes: 128,
    });
    if (EffectString.trim(version.stdout) !== 'v24.19.0') return yield* LspFault.make({code: 'prerequisite'});
  }
});
/** Host-only construction. Repository requests can select a source view, never an executable, plugin or build policy. */
export const makeSemanticCoordinator = Effect.fn('semantic.makeCoordinator')(function* (
  options: SemanticCoordinatorOptions,
) {
  // A legacy Node TypeScript candidate is never started: only the TypeScript slot stays unconfigured.
  const {verifySelected, candidate: _legacyTypeScript, ...configuration} = options;
  const catalog = structuredClone(configuration);
  if (!catalog.enabled) return yield* LspFault.make({code: 'prerequisite'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const command = yield* CommandExecutor;
  const crypto = yield* SecureRandom.SecureRandom;
  const digest = yield* EffectDigest.Digest;
  const home = yield* fs.realPath(catalog.dataHome);
  if (home !== path.resolve(catalog.dataHome)) return yield* LspFault.make({code: 'prerequisite'});
  if (catalog.java) yield* verifyJavaCoordinatorDirectory(catalog.java, home, catalog.worktree);
  yield* verifyCoordinatorStorage(catalog, home);
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
  // Serialize coordinator candidate preflights; providers own their per-operation publication guards.
  const sdkVerification = yield* Semaphore.make(1);
  const verifyCandidate = (
    candidate:
      | TypeScriptHostCandidate
      | NativeTypeScriptHostCandidate
      | PythonHostCandidate
      | SdkHostCandidate
      | JavaHostCandidate,
    id: string,
    verifyRuntimeVersion = false,
  ): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | EffectDigest.Digest> =>
    verifySelected
      ? (id === 'gopls' || id === 'rust-analyzer' || id === 'jdtls'
          ? sdkVerification.withPermit(verifySelected(id, candidate, verifyRuntimeVersion, false))
          : verifySelected(id, candidate, verifyRuntimeVersion, false)
        ).pipe(Effect.asVoid)
      : 'runtimeCandidate' in candidate
        ? id === 'jdtls'
          ? sdkVerification.withPermit(verifyJavaSemanticCandidate(candidate))
          : Effect.fail(LspFault.make({code: 'prerequisite'}))
        : id === 'typescript-native' && Schema.is(NativeTypeScriptHostCandidate)(candidate)
          ? sdkVerification.withPermit(verifyNativeTypeScriptCandidate(candidate))
          : 'runtime' in candidate
            ? verifySemanticNodeCandidate(candidate, verifyRuntimeVersion).pipe(
                Effect.provideService(CommandExecutor, command),
              )
            : id === 'gopls' || id === 'rust-analyzer'
              ? sdkVerification.withPermit(verifyNativeSemanticCandidate(candidate, id))
              : Effect.fail(LspFault.make({code: 'prerequisite'}));
  const configured = [
    ...(catalog.nativeCandidate
      ? [{candidate: catalog.nativeCandidate, id: 'typescript-native', version: '7.1.0-beta'}]
      : []),
    ...(catalog.python ? [{candidate: catalog.python, id: 'basedpyright', version: '1.40.2'}] : []),
    ...(catalog.go ? [{candidate: catalog.go, id: 'gopls', version: goProviderVersion}] : []),
    ...(catalog.rust ? [{candidate: catalog.rust, id: 'rust-analyzer', version: rustProviderVersion}] : []),
    ...(catalog.java ? [{candidate: catalog.java, id: 'jdtls', version: javaRuntimeQualification.serverVersion}] : []),
  ];
  if (!configured.length) return yield* LspFault.make({code: 'prerequisite'});
  const configurationBasis = (
    id: string,
    worktree: string,
    binding?: ReturnType<typeof makeSemanticStartupBinding>,
  ) => {
    const selected = EffectOption.getOrUndefined(EffectArray.findFirst(configured, entry => entry.id === id));
    const result =
      verifySelected && selected
        ? sdkVerification.withPermit(verifySelected(id, selected.candidate, false, true))
        : semanticTreeDigest(worktree, id === 'typescript-native');
    return binding ? result.pipe(Effect.onError(binding.failed)) : result;
  };
  const retire = (id: string, session: AnalysisSession) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        if (session.closing) return Deferred.await(session.closed);
        session.closing = true;
        return Effect.gen(function* () {
          yield* session.api.invalidate;
          const receipt = yield* session.api.close;
          yield* Scope.close(session.scope, Exit.void);
          yield* session.reservation.release(
            receipt.drained && receipt.stdioClosed && !session.startup.cleanupUnknown(),
          );
          if (sessions.get(id) === session) sessions.delete(id);
          if (!receipt.graceful) recordFailure(id, receipt.fault?.code ?? 'shutdown', session);
        }).pipe(Effect.onExit(exit => Deferred.done(session.closed, exit)));
      }),
    );
  /** `existingOnly` attaches only to a running session: without one it fails and starts nothing. */
  const attach = (
    observation: Observation,
    text: string,
    language: SemanticLanguage,
    environment?: string,
    control?: SemanticStartupControl,
    existingOnly = false,
  ) =>
    startup.withPermit(
      Effect.gen(function* () {
        const input = structuredClone(yield* Schema.decodeEffect(Observation)(observation));
        if (sha256HexSync(text) !== input.content) return yield* LspFault.make({code: 'protocol'});
        const providerId = semanticHostSelection[language].provider;
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
        session?.startup.bind(control);
        let diskBasis = session ? yield* configurationBasis(providerId, worktree, session.startup) : '';
        fixed = {...fixed, configuration: diskBasis};
        if (session && (session.diskBasis !== diskBasis || session.basis.toolchain !== toolchain)) {
          // A read-only existing-only request never closes a running session; it only reports that none is usable.
          if (existingOnly) return yield* SemanticProviderNotRunning.make({});
          yield* retire(id, session);
          return yield* LspFault.make({code: 'rejected'});
        }
        if (!session && existingOnly) return yield* SemanticProviderNotRunning.make({});
        if (!session) {
          if ((failures.get(id) ?? 0) >= 2 || failures.size >= 256) return yield* LspFault.make({code: 'prerequisite'});
          const owned = yield* Scope.fork(scope);
          const startupBinding = makeSemanticStartupBinding(control);
          const create = Effect.gen(function* () {
            const sources = Option.getOrUndefined(yield* makeSemanticSources(worktree, fixed, text));
            const reservation = yield* admission.acquire(
              sha256HexSync(fixed.repository + '\0' + fixed.worktree),
              control ? yield* control.remaining : 10000,
            );
            const wireState: {finish?: LspWire['finish']; attempted: boolean} = {attempted: false};
            yield* Effect.addFinalizer(() =>
              wireState.finish
                ? wireState.finish.pipe(
                    Effect.flatMap(receipt =>
                      reservation.release(receipt.drained && receipt.stdioClosed && !startupBinding.cleanupUnknown()),
                    ),
                    Effect.ignore,
                  )
                : reservation.release(!wireState.attempted && !startupBinding.cleanupUnknown()).pipe(Effect.ignore),
            );
            if (control) yield* control.stage('verifying-inputs');
            const roots = semanticCandidateRoots(candidate);
            const nativeSdk =
              (providerId === 'gopls' || providerId === 'rust-analyzer') && 'sdkDirectory' in candidate
                ? candidate.sdkDirectory
                : undefined;
            const candidateMetadata = () => semanticCandidateMetadata(roots, nativeSdk);
            // Native startup and read-time verification use the same full verifier.
            const startupMetadata = nativeSdk === undefined ? undefined : candidateMetadata();
            yield* verifyCandidate(candidate, providerId, true);
            let fence =
              startupMetadata !== undefined && candidateMetadata() === startupMetadata ? startupMetadata : undefined;
            if (control) yield* control.stage('preparing-project');
            diskBasis = yield* configurationBasis(providerId, worktree, startupBinding);
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
              'executable' in candidate && (language === 'go' || language === 'rust')
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
            fixed = {
              ...fixed,
              configuration: diskBasis,
              provider: {
                id: providerId,
                version: provider.version,
                generation: reservation.generation,
              },
              projectEpoch: reservation.generation,
            };
            const nativeGuard: {
              current?: {readonly policy: Effect.Effect<void, unknown>; readonly owner: Effect.Effect<void, LspFault>};
            } = {};
            // Later requests compare metadata from around the last complete verification.
            const candidateCurrent = Effect.suspend(() => {
              const policy = nativeGuard.current?.policy;
              if (providerId === 'typescript-native' && !policy)
                return Effect.fail(LspFault.make({code: 'prerequisite'}));
              const before = candidateMetadata();
              if (before !== undefined && before === fence) return policy ?? Effect.void;
              fence = undefined;
              return (policy ?? verifyCandidate(candidate, providerId)).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (before === undefined) return Effect.void;
                    const after = candidateMetadata();
                    if (after !== before) return Effect.fail(LspFault.make({code: 'rejected'}));
                    fence = after;
                    return Effect.void;
                  }),
                ),
              );
            });
            const verify = candidateCurrent.pipe(
              Effect.andThen(projectOptions?.verify ?? Effect.void),
              Effect.onError(startupBinding.failed),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.provideService(EffectDigest.Digest, digest),
            );
            const captureEditSource = sources
              ? sources.capture
              : yield* makeSemanticDiskSourceCapture(worktree, semanticAgentChangeLimits.maxSourceBytes).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                );
            const api = yield* Effect.gen(function* () {
              let api: SemanticSession;
              if (control) yield* control.stage('acquiring-provider');
              wireState.attempted = true;
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
                  () => session?.closing !== true && !sources?.poisoned(),
                  captureEditSource,
                ).pipe(
                  Effect.provideService(SemanticJavaRuntimeVerifier, runtime =>
                    sha256HexSync(JSON.stringify(runtime)) !== sha256HexSync(JSON.stringify(candidate.runtimeCandidate))
                      ? Effect.fail(LspFault.make({code: 'rejected'}))
                      : verifyCandidate(candidate, providerId).pipe(Effect.onError(startupBinding.failed)),
                  ),
                );
                api = java.api;
              } else {
                // Re-verify the admitted native binary immediately before it is started (ownership and lstat identity).
                // On Darwin the recheck also names the image the kernel must report before the compiler runs.
                const expectedDarwinImage =
                  providerId === 'typescript-native' && !('runtime' in candidate)
                    ? yield* fromPromiseInterruptible(
                        () => recheckNativeTypeScriptExecutable(candidate.executable, candidate.executableDigest),
                        () => LspFault.make({code: 'prerequisite'}),
                      )
                    : undefined;
                const wire = yield* spawnLspWire({
                  ...(expectedDarwinImage ? {expectedDarwinImage} : {}),
                  command: 'runtime' in candidate ? candidate.runtime : candidate.executable,
                  args:
                    'runtime' in candidate
                      ? [
                          ...(pythonProject?.runtimeArguments ?? []),
                          path.join(
                            candidate.serverDirectory,
                            language === 'python' ? 'langserver.index.js' : 'lib/cli.mjs',
                          ),
                          '--stdio',
                        ]
                      : providerId === 'typescript-native'
                        ? ['--lsp', '--stdio']
                        : [],
                  cwd: project,
                  // No repository PATH, NODE_OPTIONS, Python startup hooks, plugins or inherited execution settings.
                  environment: nativeProject?.environment ?? {},
                });
                wireState.finish = wire.finish;
                yield* reservation.bindProvider(wire.pid, wire.identity);
                const notifications = makeSemanticNotifications();
                const client = yield* makeLspClient(wire, notifications.receive, projectOptions?.settings);
                if (control) yield* control.stage('initializing');
                if (pythonProject && 'runtime' in candidate) {
                  api = yield* makePythonSession(client, {
                    basis: fixed,
                    notifications,
                    captureEditSource,
                    roots: [...pythonProject.roots, candidate.serverDirectory],
                    profile: pythonProject.profile,
                    environmentReady: pythonProject.ready,
                    startupMilliseconds: control ? yield* control.remaining : 10000,
                  });
                } else if (nativeProject) {
                  api = yield* (language === 'go' ? makeGoSession : makeRustSession)(client, {
                    basis: fixed,
                    notifications,
                    captureEditSource,
                    roots: nativeProject.roots,
                    profile: nativeProject.profile,
                    ready: nativeProject.ready,
                    initializationOptions: nativeProject.initializationOptions,
                    startupMilliseconds: control ? yield* control.remaining : 20000,
                  }).pipe(
                    Effect.mapError(error =>
                      Schema.is(SemanticSessionFault)(error) && error.reason === 'provider'
                        ? nativeSetupFault(language === 'go' ? 'gopls' : 'rust-analyzer', 'incompatible', 'provider')
                        : error,
                    ),
                  );
                } else if (
                  providerId === 'typescript-native' &&
                  'executable' in candidate &&
                  'sdkDirectory' in candidate &&
                  'sourceCommit' in candidate
                ) {
                  const assertOriginalCurrent = wire.assertOriginalCurrent;
                  if (!assertOriginalCurrent) return yield* LspFault.make({code: 'prerequisite'});
                  const ts = yield* makeTypeScriptSession(client, {
                    basis: fixed,
                    tsserver: candidate.executable,
                    compiler: candidate.executable,
                    sourceRoot: candidate.sdkDirectory,
                    verifyPolicy: verifyCandidate(candidate, providerId).pipe(
                      Effect.provideService(FileSystem.FileSystem, fs),
                      Effect.provideService(Path.Path, path),
                      Effect.provideService(EffectDigest.Digest, digest),
                    ),
                    captureEditSource,
                    configurationIncomplete: configuration =>
                      typeScriptConfigurationHasExtendsCycle(worktree, configuration).pipe(
                        Effect.provideService(FileSystem.FileSystem, fs),
                        Effect.provideService(Path.Path, path),
                      ),
                    maxMemoryMb: 512,
                    startupMilliseconds: control ? yield* control.remaining : 10000,
                    native: {sdkRoot: candidate.sdkDirectory, assertOriginalCurrent},
                  });
                  nativeGuard.current = {
                    policy: ts.verifyPolicy,
                    owner: Effect.try({try: assertOriginalCurrent, catch: () => LspFault.make({code: 'exit'})}),
                  };
                  api = semanticTypeScriptCoordinatorSession(ts);
                } else return yield* LspFault.make({code: 'prerequisite'});
              }
              return api;
            }).pipe(Effect.provideService(SemanticPrivateSourceEvidence, sources?.port));
            if (control) yield* control.stage('synchronizing');
            fixed = yield* api.upsert(fixed, text, language, control ? yield* control.remaining : 10000);
            if (control) yield* control.stage('checking-ready');
            yield* reservation.finishImport;
            return {
              scope: owned,
              sources,
              api,
              verify,
              verifyNativeOwner: nativeGuard.current?.owner,
              basis: fixed,
              diskBasis,
              reservation,
              startup: startupBinding,
              queries: yield* Semaphore.make(semanticSessionLimits.queriesPerSession),
              queued: 0,
              lastUsed: yield* Clock.currentTimeMillis,
              closing: false,
              faulted: false,
              closed: Deferred.makeUnsafe<void, unknown>(),
            };
          }).pipe(Effect.provideService(Scope.Scope, owned));
          const created = yield* create.pipe(
            Effect.provideService(SemanticWireStartup, startupBinding.wire),
            Effect.onError(startupBinding.failed),
            Effect.onExit(exit => (Exit.isFailure(exit) ? Scope.close(owned, exit) : Effect.void)),
            Effect.exit,
          );
          if (Exit.isFailure(created)) {
            yield* Scope.close(owned, created);
            const error = Cause.findErrorOption(created.cause);
            if (
              Option.isSome(error) &&
              Schema.is(SemanticSessionFault)(error.value) &&
              error.value.reason === 'stale'
            ) {
              if (hasReadCleanupUnconfirmed(created.cause)) return yield* Effect.failCause(created.cause);
              return yield* error.value;
            }
            if (Option.isSome(error) && Schema.is(SemanticSetupFault)(error.value)) {
              recordFailure(id, `setup-${error.value.component}-${error.value.reason}`);
              return yield* error.value;
            }
            recordFailure(id, 'startup');
            if (hasReadCleanupUnconfirmed(created.cause)) return yield* Effect.failCause(created.cause);
            return yield* LspFault.make({code: 'prerequisite'});
          }
          session = created.value;
          sessions.set(id, session);
        } else {
          if (session.sources?.poisoned()) {
            yield* retire(id, session);
            return yield* SemanticSessionFault.make({reason: 'stale'});
          }
          fixed = {...fixed, provider: session.basis.provider, projectEpoch: session.basis.projectEpoch};
          const active = session;
          fixed = yield* active.api
            .upsert(fixed, text, language, control ? yield* control.remaining : 10000)
            .pipe(
              Effect.onError(cause =>
                active.startup
                  .failed(cause)
                  .pipe(
                    Effect.andThen(
                      control || active.sources?.poisoned()
                        ? retire(id, active).pipe(Effect.ignore)
                        : active.api.available.pipe(
                            Effect.flatMap(ready => (ready ? Effect.void : retire(id, active).pipe(Effect.ignore))),
                          ),
                    ),
                  ),
              ),
            );
        }
        const active = session;
        const projectInfo = yield* Effect.gen(function* () {
          const info = yield* active.api.project(fixed.uri);
          if (
            (fixed.view.kind === 'disk' && (yield* boundedFileDigest(file, 32 * 1024 * 1024)) !== fixed.content) ||
            (yield* configurationBasis(providerId, worktree, active.startup)) !== diskBasis
          )
            return yield* LspFault.make({code: 'rejected'});
          return info;
        }).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? retire(id, active).pipe(Effect.ignore) : Effect.void)));
        session.lastUsed = yield* Clock.currentTimeMillis;
        return {
          observation: structuredClone(fixed),
          status: 'experimental' as const,
          completeness: 'partial' as const,
          edits: providerId === 'typescript-native' ? ('disabled' as const) : ('preparation-only' as const),
          project: projectInfo,
        };
      }),
    );
  const use = <A, E, R>(
    observation: Observation,
    milliseconds: number,
    f: (api: SemanticSession) => Effect.Effect<A, E, R>,
    observationPurpose?: 'observe' | 'context-close',
  ) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 45000)
        return yield* LspFault.make({code: 'protocol'});
      const fixed = structuredClone(yield* Schema.decodeEffect(Observation)(observation));
      const id = sessionIdentity(fixed);
      const session = sessions.get(id);
      if (!session || session.closing) return yield* LspFault.make({code: 'prerequisite'});
      if (session.queued >= semanticSessionLimits.queuedPerSession) return yield* LspFault.make({code: 'capacity'});
      session.queued++;
      return yield* session.queries
        .withPermit(
          Effect.gen(function* () {
            if (session.closing) return yield* LspFault.make({code: 'closing'});
            if (session.sources && fixed.provider.generation !== session.basis.provider.generation)
              return yield* SemanticSessionFault.make({reason: 'stale'});
            if (session.sources) yield* validateSemanticSource(session.sources, fixed);
            const worktree = yield* path.fromFileUrl(new URL(fixed.worktree));
            // The native context close reads the saved observation only after the final owner and configuration checks.
            const nativeContextClose =
              observationPurpose === 'context-close' &&
              fixed.provider.id === 'typescript-native' &&
              fixed.view.kind === 'disk';
            const before = nativeContextClose
              ? session.diskBasis
              : yield* configurationBasis(fixed.provider.id, worktree, session.startup);
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
            if (!nativeContextClose)
              yield* session.verify.pipe(Effect.onError(() => retire(id, session).pipe(Effect.ignore)));
            session.lastUsed = yield* Clock.currentTimeMillis;
            const closing = Effect.gen(function* () {
              yield* session.verify.pipe(Effect.onError(() => retire(id, session).pipe(Effect.ignore)));
              if (
                session.closing ||
                (yield* configurationBasis(fixed.provider.id, worktree, session.startup)) !== before ||
                (nativeContextClose && (session.closing || sessions.get(id) !== session))
              ) {
                yield* retire(id, session);
                return yield* LspFault.make({code: 'rejected'});
              }
            });
            // A verified observation is published after the last asynchronous host fence.
            if (observationPurpose) {
              yield* closing;
              if (nativeContextClose) {
                if (session.sources?.poisoned()) return yield* SemanticSessionFault.make({reason: 'stale'});
                yield* session.verifyNativeOwner ?? Effect.fail(LspFault.make({code: 'exit'}));
              }
              return yield* f(session.api);
            }
            const result = yield* f(session.api);
            yield* closing;
            if (session.sources?.poisoned()) return yield* SemanticSessionFault.make({reason: 'stale'});
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
            Effect.gen(function* () {
              session.queued--;
              if (session.sources?.poisoned()) yield* retire(id, session).pipe(Effect.ignore);
            }),
          ),
        );
    });
  yield* Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(1000);
      const now = yield* Clock.currentTimeMillis;
      for (const [id, session] of sessions)
        if (session.queued === 0 && now - session.lastUsed >= semanticSessionLimits.idleMilliseconds)
          yield* retire(id, session);
    }
  }).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions, ([id, session]) => retire(id, session).pipe(Effect.ignore), {concurrency: 8}),
  );
  return {
    catalogKey: semanticCatalogKey(catalog),
    attach,
    use,
    usePrepared: <E, R>(
      observation: Observation,
      milliseconds: number,
      f: (api: SemanticSession) => Effect.Effect<QueryOutcome, E, R>,
    ) =>
      use(observation, milliseconds, api => {
        const id = sessionIdentity(observation),
          producer = sessions.get(id);
        if (producer?.api !== api || producer.basis.provider.generation !== observation.provider.generation)
          return SemanticSessionFault.make({reason: 'stale'});
        return f(api).pipe(
          Effect.flatMap(outcome => takeCurrentSemanticPrepared(outcome, producer, () => sessions.get(id))),
        );
      }),
    observe: (observation: Observation, milliseconds: number, purpose: 'observe' | 'context-close' = 'observe') =>
      use(observation, milliseconds, api => api.observation(observation.uri), purpose),
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
          ...(id === 'jdtls'
            ? {
                requirements: {
                  platform: javaRuntimePinsForHost()?.platform ?? 'unavailable',
                  runtimeSdk: {language: 'java', version: javaRuntimeQualification.runtimeVersion},
                  projectSdk: {language: 'java', version: javaRuntimeQualification.projectVersion},
                  nextAction: javaRuntimeSetupAction,
                },
                license: {qualification: 'pending', redistribution: 'release-gated'},
              }
            : {}),
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
            rename: id === 'typescript-native' ? 'experimental-preparation-only' : 'preparation-only',
            codeActions: id === 'typescript-native' ? 'unsupported' : 'candidate-quickfix-text-only-retained-selection',
            optional: id === 'typescript-native' ? 'unsupported-unqualified' : 'provider-advertised-reads',
            apply: 'unsupported',
            commands: 'unsupported',
          },
        })),
        effectiveLimits: {
          queryMilliseconds: 10000,
          maximumQueryMilliseconds: 45000,
          idleMilliseconds: semanticSessionLimits.idleMilliseconds,
          queriesPerSession: semanticSessionLimits.queriesPerSession,
          queuedPerSession: semanticSessionLimits.queuedPerSession,
          providerLeaderRssBytesPerHome: semanticSessionLimits.providerLeaderRssBytesPerHome,
          resourceEnforcement: 'admission-only-registered-provider-leaders',
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
          'RSS admission covers registered provider leaders; descendants, transient peaks and OS hard limits remain unqualified',
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
  Schema.Struct({operation: Schema.Literal('agent-readiness'), request: SemanticEndpointReadiness}),
  Schema.Struct({operation: Schema.Literal('agent-change'), request: SemanticAgentEndpointChange}),
  Schema.Struct({operation: Schema.Literal('agent-view'), request: SemanticAgentEndpointView}),
  Schema.Struct({operation: Schema.Literal('agent-query'), request: SemanticAgentEndpointQuery}),
  Schema.Struct({
    operation: Schema.Literal('agent-observe'),
    handle: Schema.optionalKey(SemanticAgentBufferHandle),
    observation: Observation,
    milliseconds: Counter.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(45000)),
  }),
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
type EndpointCoordinator = Omit<Coordinator, 'observe' | 'catalogKey' | 'usePrepared'> &
  Partial<Pick<Coordinator, 'observe' | 'catalogKey' | 'usePrepared'>>;
interface EndpointOptions {
  readonly dataHome?: string;
  readonly runtimeIdentity?: string;
  readonly directory: string;
  readonly token: string;
  readonly worktree: string;
}
/** Local socket only. Bootstrap attachment and each source view have separate unguessable capabilities. */
export const serveSemanticEndpoint = Effect.fn('semantic.serveEndpoint')(function* (
  coordinator: EndpointCoordinator,
  options: EndpointOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  if (!Schema.is(Digest)(options.token) || !Schema.is(FileUri)(options.worktree))
    return yield* LspFault.make({code: 'protocol'});
  yield* prepareSemanticEndpointDirectory(options.directory);
  const socket = path.join(options.directory, 'rpc.sock');
  if (new TextEncoder().encode(socket).length > 100) return yield* LspFault.make({code: 'prerequisite'});
  // Existing private-only endpoints need no read-publication port; public reads require it.
  const observe = coordinator.observe;
  const agentQueries =
    Schema.is(Digest)(options.runtimeIdentity) && observe
      ? yield* makeSemanticAgentDiskQueries({...coordinator, observe}, options.worktree, options.runtimeIdentity)
      : undefined;
  const agentChanges =
    Schema.is(Digest)(options.runtimeIdentity) && observe && options.dataHome
      ? yield* makeSemanticAgentChanges(
          {...coordinator, observe, attach: agentQueries?.attachDisk ?? coordinator.attach},
          {
            directory: path.join(path.dirname(options.directory), 'proposals', sha256HexSync(options.worktree)),
            profileHome: options.dataHome,
            worktree: options.worktree,
            runtimeIdentity: options.runtimeIdentity,
          },
        )
      : undefined;
  const {
    grants,
    checkPublic,
    request: legacyAgentView,
    ...bufferViews
  } = yield* makeSemanticOwnedBufferViews(coordinator, options, sessionIdentity);
  const readiness =
    agentQueries && options.dataHome && coordinator.catalogKey
      ? yield* makeSemanticReadinessJobs({
          worktree: options.worktree,
          reserve: (source, content) => bufferViews.reserve(source, content),
          prepare: (source, content, control, reserved) =>
            verifyReadinessProfile(options.dataHome!, source, coordinator.catalogKey!).pipe(
              Effect.andThen(
                source.buffer
                  ? bufferViews.prepare(source, content, control, reserved)
                  : agentQueries.prepare(source, content, control),
              ),
            ),
          current: (source, observation) =>
            Effect.gen(function* () {
              yield* verifyReadinessProfile(options.dataHome!, source, coordinator.catalogKey!);
              const remaining = yield* Effect.serviceOption(ReadDeadlineContext).pipe(
                Effect.flatMap(deadline =>
                  Option.isSome(deadline) ? readDeadlineRemaining(deadline.value) : Effect.succeed(10000),
                ),
              );
              const current = yield* source.buffer
                ? coordinator.observe!(observation, Math.min(45000, remaining))
                : agentQueries.observe(observation, Math.min(45000, remaining));
              if (source.buffer) yield* verifyReadinessProfile(options.dataHome!, source, coordinator.catalogKey!);
              return current !== undefined && observationKey(current) === observationKey(observation);
            }),
          close: observation =>
            observation.view.kind === 'overlay'
              ? bufferViews.closePending(observation)
              : coordinator.closeView(observation),
        })
      : undefined;
  const agentView = (body: SemanticAgentEndpointView) =>
    body.action === 'open' && body.startup
      ? Effect.gen(function* () {
          if (!readiness) return yield* LspFault.make({code: 'prerequisite'});
          const source = yield* bufferViews.sourceForOpen(body);
          return yield* readiness.claim(body.startup!, source, bufferViews.publish);
        }).pipe(
          Effect.timeoutOption(body.milliseconds),
          Effect.flatMap(result =>
            result._tag === 'Some' ? Effect.succeed(result.value) : Effect.fail(LspFault.make({code: 'timeout'})),
          ),
        )
      : legacyAgentView(body);
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
        if (status.sessions !== 0 || grants.size !== 0 || requests !== 1 || (readiness && !(yield* readiness.idle)))
          return yield* LspFault.make({code: 'closing'});
        shutdown = true;
        return {status: 'shutting-down'};
      }
      if (body.operation === 'agent-view') return yield* agentView(body.request);
      if (body.operation === 'agent-readiness') {
        if (
          !readiness ||
          !agentQueries ||
          !options.dataHome ||
          !coordinator.catalogKey ||
          body.request.worktree !== options.worktree
        )
          return yield* LspFault.make({code: 'prerequisite'});
        const source = body.request;
        if (source.action === 'start') {
          if ((source.buffer === undefined) !== (source.text === undefined))
            return yield* LspFault.make({code: 'protocol'});
          const deadline = yield* makeReadDeadline(120000);
          const content = yield* withinReadDeadline(
            deadline,
            verifyReadinessProfile(options.dataHome, source, coordinator.catalogKey).pipe(
              Effect.andThen(
                source.buffer
                  ? source.text !== undefined && sha256HexSync(source.text) === source.buffer.content
                    ? Effect.succeed(source.text)
                    : Effect.fail(LspFault.make({code: 'protocol'}))
                  : agentQueries.capture(source),
              ),
            ),
          );
          return yield* readiness.start(source, content, deadline);
        }
        return yield* (source.action === 'cancel' ? readiness.cancel : readiness.status)(
          source.job,
          source.profile,
          source.principal,
          source.worktree,
        );
      }
      if (body.operation === 'agent-change') {
        if (!agentChanges) return yield* LspFault.make({code: 'prerequisite'});
        if (body.request.action === 'invalidate-for-writer') {
          const result = yield* agentChanges.execute(body.request);
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              version: Schema.Literal(1),
              status: Schema.Literal('writer-invalidation'),
              observations: Schema.Array(Observation),
            }),
            {onExcessProperty: 'error'},
          )(result);
          yield* Effect.forEach(decoded.observations, observation => coordinator.closeView(observation));
          return {version: 1, status: 'invalidated'};
        }
        if (body.request.action !== 'prepare' || !body.request.view) return yield* agentChanges.execute(body.request);
        const selector = body.request.view;
        const owned = yield* checkPublic(selector.handle, body.request.profile);
        return yield* owned.grant.gate.withPermit(
          Effect.gen(function* () {
            yield* checkPublic(selector.handle, body.request.profile);
            const before = owned.binding.observation;
            if (
              body.request.worktree !== before.worktree ||
              body.request.project !== before.project ||
              body.request.uri !== before.uri ||
              body.request.language !== owned.binding.language ||
              body.request.environment !== owned.binding.environment ||
              selector.documentVersion !== before.documentVersion
            )
              return yield* SemanticSessionFault.make({reason: 'conflict'});
            const observed: {current?: Observation} = {};
            const result = yield* agentChanges.execute(body.request, before, observed);
            yield* checkPublic(selector.handle, body.request.profile);
            // Closure may advance the shared epoch without changing the owned document/version. The preparation
            // already observed the view after its closure; each observation runs every host check, so observe
            // again only when the preparation stopped before that point.
            const refreshed = observed.current ?? (yield* coordinator.observe!(before, body.request.milliseconds));
            if (
              refreshed &&
              refreshed.content === before.content &&
              refreshed.documentVersion === before.documentVersion
            )
              owned.binding.observation = refreshed;
            return result;
          }),
        );
      }

      if (body.operation === 'agent-observe') {
        if (!agentQueries) return yield* LspFault.make({code: 'prerequisite'});
        if (body.observation.view.kind === 'disk')
          return yield* agentQueries.observe(body.observation, body.milliseconds, 'context-close');
        if (!body.handle) return yield* SemanticSessionFault.make({reason: 'conflict'});
        const owned = yield* checkPublic(body.handle);
        return yield* owned.grant.gate.withPermit(
          Effect.gen(function* () {
            if (observationKey(owned.binding.observation) !== observationKey(body.observation))
              return yield* SemanticSessionFault.make({reason: 'stale'});
            const observed = yield* coordinator.observe!(body.observation, body.milliseconds);
            yield* checkPublic(body.handle!);
            return observed;
          }),
        );
      }
      if (body.operation === 'agent-query') {
        if (!agentQueries) return yield* LspFault.make({code: 'prerequisite'});
        if (!body.request.view) return yield* agentQueries.query(body.request);
        const selector = body.request.view;
        const owned = yield* checkPublic(selector.handle, body.request.profile);
        return yield* owned.grant.gate.withPermit(
          Effect.gen(function* () {
            yield* checkPublic(selector.handle, body.request.profile);
            const observed = owned.binding.observation;
            if (
              body.request.worktree !== observed.worktree ||
              body.request.project !== observed.project ||
              body.request.uri !== observed.uri ||
              body.request.language !== owned.binding.language ||
              body.request.environment !== owned.binding.environment ||
              selector.documentVersion !== observed.documentVersion
            )
              return yield* SemanticSessionFault.make({reason: 'conflict'});
            const result = yield* agentQueries.query(body.request, {observation: observed});
            yield* checkPublic(selector.handle, body.request.profile);
            if (
              grants.get(owned.id) !== owned.grant ||
              observationKey(owned.binding.observation) !== observationKey(observed)
            )
              return yield* SemanticSessionFault.make({reason: 'stale'});
            return result;
          }),
        );
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
      if (grant?.public) return yield* SemanticSessionFault.make({reason: 'conflict'});
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
  yield* server.serve(Effect.interruptible(handler));
  yield* Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(1000);
      const now = yield* Clock.currentTimeMillis;
      agentQueries?.prune(now);
      for (const [id, grant] of grants) {
        yield* grant.gate.withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            if (
              grants.get(id) === grant &&
              ((grant.public ?? grant.reserved)
                ? now >= (grant.public ?? grant.reserved)!.expiresAt ||
                  now < (grant.public ?? grant.reserved)!.expiresAt - 600000
                : now - grant.lastUsed >= 600000)
            ) {
              if (grant.public) yield* coordinator.closeView(grant.public.observation);
              else if (grant.reserved)
                yield* bufferViews.closePending(grant.reserved.observation).pipe(Effect.ignoreCause);
              if (!grant.reserved) grants.delete(id);
            }
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
      Effect.flatMap(idle => (readiness?.idle ?? Effect.succeed(true)).pipe(Effect.map(noJobs => idle && noJobs))),
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
const Bootstrap = Schema.Struct({
  version: Schema.Literal(1),
  runtimeIdentity: Digest,
  token: Digest,
  worktree: FileUri,
  dataHome: Schema.String,
  ...SemanticHostCatalog.fields,
});
export interface SemanticEndpointLaunch extends SemanticCoordinatorOptions {
  readonly worktree: string;
  /** Exact application/runtime identity supplied by the host, independent of provider selection. */
  readonly runtimeIdentity: string;
}
/** Probe the exact current runtime attachment only; operational inspection never starts or repairs a worker. */
export const inspectSemanticEndpoint = Effect.fn('semantic.inspectEndpoint')(function* (
  options: Pick<SemanticEndpointLaunch, 'dataHome' | 'worktree' | 'runtimeIdentity'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!Schema.is(Digest)(options.runtimeIdentity) || !Schema.is(FileUri)(options.worktree))
    return yield* LspFault.make({code: 'prerequisite'});
  const home = yield* fs.realPath(options.dataHome);
  if (home !== path.resolve(options.dataHome)) return yield* LspFault.make({code: 'prerequisite'});
  const key = sha256HexSync(JSON.stringify([home, options.worktree, options.runtimeIdentity]));
  const directory = path.join(home, 'semantic', EffectString.slice(0, 20)(key));
  const file = path.join(directory, 'host.json');
  if (!(yield* fs.exists(file))) return undefined;
  const bootstrap = yield* readSemanticBootstrap(file);
  if (
    bootstrap.runtimeIdentity !== options.runtimeIdentity ||
    bootstrap.worktree !== options.worktree ||
    bootstrap.dataHome !== home
  )
    return yield* SemanticCompatibilityFault.make({component: 'bootstrap'});
  return yield* requestSemanticEndpoint(path.join(directory, 'rpc.sock'), bootstrap.token, {operation: 'status'}).pipe(
    Effect.timeoutOption(2000),
    Effect.map(Option.getOrUndefined),
  );
});
/** Endpoint directories a presence hint reads at most; a data home has one per runtime and worktree. */
const PRESENCE_DIRECTORIES = 32;
/**
 * A passive presence hint, for a caller that must not attach: some coordinator bootstrap for this data home and
 * worktree exists next to its socket file. It reads files only: no socket request, attach, lock, write or process
 * start. It does not compare the runtime identity, because that hashes the whole executable; an attach still
 * makes the exact check. Any doubt gives false.
 */
export const semanticEndpointBootstrapPresent = Effect.fn('semantic.endpointBootstrapPresent')(function* (
  options: Pick<SemanticEndpointLaunch, 'dataHome' | 'worktree'>,
) {
  if (!Schema.is(FileUri)(options.worktree)) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(options.dataHome);
  if (home !== path.resolve(options.dataHome)) return false;
  const root = path.join(home, 'semantic');
  if (!(yield* fs.exists(root))) return false;
  const entries = EffectArray.take(EffectArray.sort(yield* fs.readDirectory(root), Order.String), PRESENCE_DIRECTORIES);
  for (const entry of entries) {
    const directory = path.join(root, entry);
    const bootstrapFile = path.join(directory, 'host.json');
    if (!(yield* fs.exists(bootstrapFile)) || !(yield* fs.exists(path.join(directory, 'rpc.sock')))) continue;
    const bootstrap = yield* readSemanticBootstrap(bootstrapFile).pipe(Effect.option);
    if (Option.isSome(bootstrap) && bootstrap.value.worktree === options.worktree && bootstrap.value.dataHome === home)
      return true;
  }
  return false;
});
/**
 * Attach to the coordinator that already runs for this exact runtime, worktree, data home and host catalog.
 * It never starts, repairs or writes. No attachment, another identity or a failed status probe gives undefined;
 * a storage fence or bootstrap that does not decode fails.
 */
export const attachSemanticEndpoint = Effect.fn('semantic.attachEndpoint')(function* (
  options: SemanticEndpointLaunch,
  milliseconds = 250,
) {
  const launch = structuredClone(options);
  if (!launch.enabled || !Schema.is(Digest)(launch.runtimeIdentity) || !Schema.is(FileUri)(launch.worktree))
    return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(launch.dataHome);
  if (home !== path.resolve(launch.dataHome)) return undefined;
  yield* verifyCoordinatorStorage(launch, home);
  const key = sha256HexSync(JSON.stringify([home, launch.worktree, launch.runtimeIdentity]));
  const directory = path.join(home, 'semantic', EffectString.slice(0, 20)(key));
  const bootstrapFile = path.join(directory, 'host.json');
  if (!(yield* fs.exists(bootstrapFile))) return undefined;
  const bootstrap = yield* readSemanticBootstrap(bootstrapFile);
  if (
    bootstrap.worktree !== launch.worktree ||
    bootstrap.runtimeIdentity !== launch.runtimeIdentity ||
    bootstrap.dataHome !== home ||
    semanticCatalogKey(bootstrap) !== semanticCatalogKey(launch)
  )
    return undefined;
  const socket = path.join(directory, 'rpc.sock');
  const running = yield* requestSemanticEndpoint(socket, bootstrap.token, {operation: 'status'}).pipe(
    Effect.timeoutOption(Math.max(1, milliseconds)),
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
  if (!running) return undefined;
  return {
    request: (body: SemanticRequest, capability?: string) =>
      requestSemanticEndpoint(socket, bootstrap.token, body, capability),
  };
});
/**
 * Every provider slot of a published bootstrap, for the coordinator it starts. Only the endpoint identity is removed,
 * so no slot can be left out: a missing slot leaves a profile with only that provider without a configured provider.
 */
export function semanticBootstrapCatalog(bootstrap: typeof Bootstrap.Type): SemanticHostCatalog {
  const {
    version: _version,
    runtimeIdentity: _runtimeIdentity,
    token: _token,
    worktree: _worktree,
    dataHome: _dataHome,
    ...catalog
  } = bootstrap;
  return catalog;
}
/** Starts one runtime/worktree coordinator lazily. Capabilities/source text never enter process arguments. */
export const ensureSemanticEndpoint = Effect.fn('semantic.ensureEndpoint')(function* (options: SemanticEndpointLaunch) {
  const launch = structuredClone(options);
  if (!launch.enabled || !Schema.is(Digest)(launch.runtimeIdentity) || !Schema.is(FileUri)(launch.worktree))
    return yield* LspFault.make({code: 'prerequisite'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const crypto = yield* SecureRandom.SecureRandom;
  const home = yield* fs.realPath(launch.dataHome);
  if (home !== path.resolve(launch.dataHome)) return yield* LspFault.make({code: 'prerequisite'});
  if (launch.java) yield* verifyJavaCoordinatorDirectory(launch.java, home, launch.worktree);
  yield* verifyCoordinatorStorage(launch, home);
  const key = sha256HexSync(JSON.stringify([home, launch.worktree, launch.runtimeIdentity]));
  const directory = path.join(home, 'semantic', EffectString.slice(0, 20)(key));
  const privateDirectory = yield* prepareSemanticEndpointDirectory(directory);
  const bootstrapFile = path.join(directory, 'host.json');
  const socket = path.join(directory, 'rpc.sock');
  return yield* withSemanticEndpointLock(directory, privateDirectory, 'startup.lock', 15000, assertCurrentSync =>
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
          ...(launch.nativeCandidate ? {nativeCandidate: launch.nativeCandidate} : {}),
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
        // Only cheap canonical/private-root fences precede control-plane publication. Selected jobs own byte trust.
        if (!existing)
          yield* publishSemanticEndpointBootstrap(directory, privateDirectory, serialized, assertCurrentSync);
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
}, Effect.scoped);
const readSemanticBootstrap = Effect.fn('semantic.readBootstrap')(function* (file: string) {
  const text = yield* readSemanticEndpointBootstrap(file);
  const raw = yield* Effect.try({try: () => JSON.parse(text), catch: () => LspFault.make({code: 'protocol'})});
  return yield* Schema.decodeUnknownEffect(Bootstrap, {onExcessProperty: 'error'})(raw).pipe(
    Effect.mapError(() => SemanticCompatibilityFault.make({component: 'bootstrap'})),
  );
});
export const runSemanticCoordinatorWorker = Effect.fn('semantic.worker')(function* (arguments_: readonly string[]) {
  // Read-only verifier mode runs before the worker lock, socket removal or coordinator construction.
  if (arguments_[0] === '--verify-config') {
    if (
      arguments_.length < 4 ||
      arguments_.length > 6 ||
      arguments_[2] !== '--provider' ||
      EffectArray.some(arguments_.slice(4), flag => flag !== '--runtime-version' && flag !== '--configuration-only') ||
      new Set(arguments_.slice(4)).size !== arguments_.length - 4
    )
      return yield* LspFault.make({code: 'protocol'});
    const bootstrap = yield* readSemanticBootstrap(arguments_[1]);
    if ((yield* semanticCompiledRuntimeIdentity) !== bootstrap.runtimeIdentity)
      return yield* LspFault.make({code: 'rejected'});
    const id = arguments_[3];
    const candidate =
      id === 'typescript-native'
        ? bootstrap.nativeCandidate
        : id === 'basedpyright'
          ? bootstrap.python
          : id === 'gopls'
            ? bootstrap.go
            : id === 'rust-analyzer'
              ? bootstrap.rust
              : id === 'jdtls'
                ? bootstrap.java
                : undefined;
    if (!candidate || !Schema.is(SemanticVerificationReply.fields.provider)(id))
      return yield* LspFault.make({code: 'prerequisite'});
    const runtimeVersion = arguments_.includes('--runtime-version');
    const configurationOnly = arguments_.includes('--configuration-only');
    let digest = sha256HexSync(JSON.stringify([id, candidate]));
    if (configurationOnly) {
      const path = yield* Path.Path;
      digest = yield* semanticTreeDigest(
        yield* path.fromFileUrl(new URL(bootstrap.worktree)),
        id === 'typescript-native',
      );
    } else if ('runtimeCandidate' in candidate) yield* verifyJavaSemanticCandidate(candidate);
    else if (id === 'typescript-native' && Schema.is(NativeTypeScriptHostCandidate)(candidate))
      yield* verifyNativeTypeScriptCandidate(candidate);
    else if ('runtime' in candidate) yield* verifySemanticNodeCandidate(candidate, runtimeVersion, true);
    else if (id === 'gopls' || id === 'rust-analyzer') yield* verifyNativeSemanticCandidate(candidate, id);
    else return yield* LspFault.make({code: 'prerequisite'});
    return yield* Console.log(
      JSON.stringify({
        version: 1,
        provider: id,
        candidate: sha256HexSync(JSON.stringify([id, candidate])),
        mode: configurationOnly ? 'configuration' : 'candidate',
        digest,
        runtimeVersion,
      }),
    );
  }
  if (arguments_.length !== 2 || arguments_[0] !== '--config') return yield* LspFault.make({code: 'protocol'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bootstrap = yield* readSemanticBootstrap(arguments_[1]);
  const system = yield* SystemInfo;
  const command = yield* CommandExecutor;
  const directory = path.dirname(arguments_[1]);
  const privateDirectory = yield* prepareSemanticEndpointDirectory(directory, false);
  return yield* withSemanticEndpointLock(directory, privateDirectory, 'worker.lock', 250, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const socket = path.join(directory, 'rpc.sock');
        yield* fs.remove(socket).pipe(Effect.ignore);
        const coordinator = yield* makeSemanticCoordinator({
          enabled: true,
          dataHome: bootstrap.dataHome,
          ...semanticBootstrapCatalog(bootstrap),
          worktree: bootstrap.worktree,
          verifySelected: (id, candidate, runtimeVersion, configurationOnly) =>
            runSemanticSelectedVerification(
              arguments_[1],
              id,
              sha256HexSync(JSON.stringify([id, candidate])),
              runtimeVersion,
              configurationOnly,
            ).pipe(Effect.provideService(SystemInfo, system), Effect.provideService(CommandExecutor, command)),
        });
        const endpoint = yield* serveSemanticEndpoint(coordinator, {
          directory,
          dataHome: bootstrap.dataHome,
          token: bootstrap.token,
          worktree: bootstrap.worktree,
          runtimeIdentity: bootstrap.runtimeIdentity,
        });
        while ((yield* fs.exists(arguments_[1])) && !(yield* endpoint.idle)) yield* Effect.sleep(1000);
      }),
    ),
  );
}, Effect.scoped);
