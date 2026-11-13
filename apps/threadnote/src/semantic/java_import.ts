import {Array as EffectArray, Effect, FileSystem, Path, Schema, String as EffectString} from 'effect';
import {canonicalFileUri, Digest, FileUri} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readBounded} from './fingerprint.js';
import {
  inspectSemanticHostProfile,
  JavaImportPolicy,
  readSemanticHostProfile,
  SemanticHostProfileFault,
  writeSemanticJavaImportPolicy,
} from './host_profile.js';
import {makeSemanticAdmission} from './admission.js';
import {LspFault, type WireStop} from './lsp_transport.js';
import {makeJavaPreparation, type JavaPreparationHost} from './providers/java.js';
import {JavaRuntimeCandidate, javaRuntimeQualification, makeJavaRuntime} from './providers/java_runtime.js';

/** Original authored-project input, compared byte for byte. Never a replacement for a repository POM. */
export const javaImportCanonicalPom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>io.threadnote.diagnostic</groupId>
  <artifactId>original-java21</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
`;
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
export class JavaImportFault extends Schema.TaggedError<JavaImportFault, {readonly brand: unique symbol}>()(
  'JavaImportFault',
  {reason: Schema.Literals(['invalid-request', 'unsupported-input', 'stale', 'denied', 'enforcement-unavailable'])},
) {}
const reject = (reason: JavaImportFault['reason']) => JavaImportFault.make({reason});

/** A closed bounded input inventory, not an XML evaluator or an arbitrary-build permission bit. */
export const inspectJavaImportInputs = Effect.fn('semantic.inspectJavaImportInputs')(function* (
  worktree: string,
  project: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const root of [worktree, project])
    if (
      !path.isAbsolute(root) ||
      path.resolve(root) !== root ||
      (yield* fs.realPath(root)) !== root ||
      (yield* fs.stat(root)).type !== 'Directory'
    )
      return yield* reject('unsupported-input');
  // The preparation engine copies the whole worktree. This finite profile must inventory that entire closure.
  if (project !== worktree) return yield* reject('unsupported-input');
  const entries: [string, string][] = [];
  let total = 0;
  let sources = 0;
  const walk = (directory: string, relative: string, depth: number): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (depth > 24) return yield* reject('unsupported-input');
      for (const name of (yield* fs.readDirectory(directory)).sort()) {
        if (relative === '' && name === '.git' && project === worktree) continue;
        const file = path.join(directory, name);
        const member = relative ? relative + '/' + name : name;
        if (entries.length >= 512 || (yield* fs.realPath(file)) !== file) return yield* reject('unsupported-input');
        const info = yield* fs.stat(file);
        if (info.type === 'Directory') {
          if (
            !['src', 'src/main', 'src/main/java'].includes(member) &&
            !/^src\/main\/java\/(?:[A-Za-z_$][A-Za-z0-9_$]*\/)*[A-Za-z_$][A-Za-z0-9_$]*$/.test(member)
          )
            return yield* reject('unsupported-input');
          entries.push([member + '/', 'directory']);
          yield* walk(file, member, depth + 1);
        } else {
          if (
            info.type !== 'File' ||
            Number(info.size) > 1024 * 1024 ||
            (member !== 'pom.xml' &&
              !/^src\/main\/java\/(?:[A-Za-z_$][A-Za-z0-9_$]*\/)*[A-Za-z_$][A-Za-z0-9_$]*\.java$/.test(member))
          )
            return yield* reject('unsupported-input');
          const bytes = yield* readBounded(file, 1024 * 1024);
          if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return yield* reject('unsupported-input');
          const text = yield* Effect.try({
            try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
            catch: () => reject('unsupported-input'),
          });
          total += bytes.byteLength;
          if (
            total > 8 * 1024 * 1024 ||
            EffectString.includes('\u0000')(text) ||
            EffectString.startsWith('\ufeff')(text)
          )
            return yield* reject('unsupported-input');
          if (member === 'pom.xml' && text !== javaImportCanonicalPom) return yield* reject('unsupported-input');
          if (member !== 'pom.xml') sources++;
          entries.push([member, sha256HexSync(bytes)]);
        }
      }
    });
  yield* walk(project, '', 0);
  if (!sources || !EffectArray.some(entries, ([name]) => name === 'pom.xml')) return yield* reject('unsupported-input');
  return sha256HexSync(JSON.stringify(entries));
});

interface EnforcementContract {
  readonly mode: JavaImportPolicy['mode'];
  readonly serverTreeDigest: string;
  readonly runtimeSdkDigest: string;
  readonly projectSdkDigest: string;
  readonly originalPomDigest: string;
  readonly noIndependentBuildOwner: true;
}
// No pinned JDT/m2e implementation has yet passed the independent nonexecution/acquisition examination.
// Adding a row requires source review and actual exact-importer evidence; no JSON or service can supply a row.
const enforcementContracts: readonly EnforcementContract[] = Object.freeze([]);
const enforcedContract = (policy: JavaImportPolicy) =>
  EffectArray.findFirst(
    enforcementContracts,
    contract =>
      contract.mode === policy.mode &&
      contract.serverTreeDigest === policy.candidate.serverTreeDigest &&
      contract.runtimeSdkDigest === policy.candidate.runtimeSdkDigest &&
      contract.projectSdkDigest === policy.candidate.projectSdkDigest &&
      contract.originalPomDigest === sha256HexSync(javaImportCanonicalPom),
  );

const Common = {version: Schema.Literal(1), callerCwd: Schema.String};
const PolicyRequest = Schema.Struct({
  ...Common,
  project: FileUri,
  candidate: JavaRuntimeCandidate,
  expectedDigest: Schema.optional(Digest),
  previewDigest: Schema.optional(Digest),
});
const RevokeRequest = Schema.Struct({...Common, expectedDigest: Digest});
const RunRequest = Schema.Struct(Common);
const authorizations = new WeakMap<object, {readonly guard: Effect.Effect<void, unknown>}>();

/** Orders currentness reads only; it cannot mint authority or fill the enforcement registry. */
export const verifyJavaImportCurrentness = <E, R, E2, R2>(
  profileGuard: Effect.Effect<void, E, R>,
  verifyInputsAndRuntime: Effect.Effect<void, E2, R2>,
) => profileGuard.pipe(Effect.andThen(verifyInputsAndRuntime), Effect.andThen(profileGuard));

/** Concrete native/cache adapter. Only the private post-admission mint can supply its live token. */
const executeImport = Effect.fn('semantic.executeJavaImport')(function* (
  config: RuntimeConfig,
  root: string,
  project: string,
  worktree: string,
  profileDigest: string,
  policy: JavaImportPolicy,
  contract: EnforcementContract,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileGuard = Effect.gen(function* () {
    const current = yield* readSemanticHostProfile(config, worktree);
    if (current.digest !== profileDigest || JSON.stringify(current.profile.javaImport) !== JSON.stringify(policy))
      return yield* reject('stale');
  });
  const runtime = yield* makeJavaRuntime(policy.candidate);
  const guard = verifyJavaImportCurrentness(
    profileGuard,
    Effect.gen(function* () {
      if ((yield* inspectJavaImportInputs(root, project)) !== policy.sourceDigest) return yield* reject('stale');
      yield* runtime.verify;
    }),
  );
  const descriptor = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* guard;
      const selected = yield* readSemanticHostProfile(config, worktree);
      const admission = yield* makeSemanticAdmission({directory: path.join(selected.home, 'semantic', 'admission-v1')});
      const reservation = yield* admission.acquire(sha256HexSync(worktree), 120000);
      let launchMayHaveStarted = false;
      let finish: Effect.Effect<WireStop> | undefined;
      const token = Object.freeze({});
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          authorizations.delete(token);
          const receipt = finish ? yield* finish.pipe(Effect.result) : undefined;
          const drained =
            !launchMayHaveStarted ||
            (contract.noIndependentBuildOwner &&
              receipt?._tag === 'Success' &&
              receipt.success.drained &&
              receipt.success.stdioClosed);
          yield* reservation.release(drained);
        }).pipe(Effect.orDie),
      );
      yield* guard; // Queue waiting cannot preserve a stale policy.
      authorizations.set(token, {
        guard: guard.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path)),
      });
      const verifySetup = Effect.suspend(() => authorizations.get(token)?.guard ?? reject('denied'));
      const host: JavaPreparationHost = {
        verifySetup,
        beforePreparationLaunch: () => {
          launchMayHaveStarted = true;
        },
        capturePreparationProvider: (_pid, originalFinish) => {
          finish = originalFinish;
        },
        onProviderStarted: pid => reservation.bindProvider(pid),
        provisionOfflineCache: context =>
          Effect.gen(function* () {
            for (const directory of [path.join(context.runtimeDirectory, 'm2'), context.gradleUserHome]) {
              const info = yield* fs.stat(directory);
              if (
                (yield* fs.realPath(directory)) !== directory ||
                info.type !== 'Directory' ||
                info.mode & 0o077 ||
                (yield* fs.readDirectory(directory)).length !== 0
              )
                return yield* LspFault.make({code: 'prerequisite'});
            }
          }),
        drainBuildProcesses: () =>
          Effect.suspend(() =>
            finish
              ? finish.pipe(
                  Effect.flatMap(receipt =>
                    receipt.drained && receipt.stdioClosed && contract.noIndependentBuildOwner
                      ? Effect.succeed({drained: true})
                      : LspFault.make({code: 'exit'}),
                  ),
                )
              : LspFault.make({code: 'exit'}),
          ),
      };
      const privateDirectory = path.join(selected.home, 'semantic', 'java-import');
      const artifactDirectory = path.join(privateDirectory, 'artifacts');
      for (const directory of [privateDirectory, artifactDirectory])
        yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
      const operation = makeJavaPreparation(
        {project, worktree: root, candidate: policy.candidate, privateDirectory, artifactDirectory, build: 'maven'},
        host,
      ).pipe(Effect.tap(() => verifySetup));
      // A failing scoped watchdog interrupts the operation and joins its original native finalization.
      const watchdog = Effect.forever(Effect.sleep(250).pipe(Effect.andThen(profileGuard)));
      return yield* Effect.raceFirst(operation, watchdog);
    }),
  );
  // Admission release may yield after the engine/watchdog complete. Fence that entire cleanup interval.
  yield* guard;
  return descriptor;
});

/** Local CLI composition only. JSON cannot choose privileged dispatch or assert local intent. */
export const runSemanticJavaImport = Effect.fn('semantic.javaImport')(function* (
  config: RuntimeConfig,
  input: unknown,
  action: 'preview' | 'apply' | 'revoke' | 'run',
  localIntent = false,
) {
  const operation = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parsed = yield* Schema.decodeUnknownEffect(
      action === 'revoke' ? RevokeRequest : action === 'run' ? RunRequest : PolicyRequest,
      {onExcessProperty: 'error'},
    )(input).pipe(Effect.mapError(() => reject('invalid-request')));
    if (!path.isAbsolute(parsed.callerCwd)) return yield* reject('invalid-request');
    const root = yield* fs.realPath(parsed.callerCwd);
    const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
    if ((action === 'apply' || action === 'revoke' || action === 'run') && !localIntent) return yield* reject('denied');
    const selected = yield* inspectSemanticHostProfile(config, worktree).pipe(
      Effect.catchTag('SemanticHostProfileFault', fault =>
        fault.reason === 'missing' ? Effect.void : Effect.fail(fault),
      ),
    );
    if (action === 'revoke') {
      const request = yield* Schema.decodeUnknownEffect(RevokeRequest, {onExcessProperty: 'error'})(input);
      const written = yield* writeSemanticJavaImportPolicy(config, worktree, undefined, request.expectedDigest);
      return {version: 1, action, state: 'revoked', profileDigest: written.digest, changed: written.changed};
    }
    if (action === 'run') {
      if (!selected?.profile.enabled || !selected.profile.javaImport) return yield* reject('denied');
      const policy = selected.profile.javaImport;
      const project = yield* path.fromFileUrl(new URL(policy.project));
      if ((yield* inspectJavaImportInputs(root, project)) !== policy.sourceDigest) return yield* reject('stale');
      const contract = enforcedContract(policy);
      if (contract._tag === 'None') return yield* reject('enforcement-unavailable');
      const descriptor = yield* executeImport(config, root, project, worktree, selected.digest, policy, contract.value);
      return {version: 1, action, state: 'prepared', descriptor};
    }
    const request = yield* Schema.decodeUnknownEffect(PolicyRequest, {onExcessProperty: 'error'})(input);
    const project = yield* path.fromFileUrl(new URL(request.project));
    const sourceDigest = yield* inspectJavaImportInputs(root, project);
    // Standalone runtime verification needs no preexisting JavaHostCandidate/environment.
    const runtime = yield* makeJavaRuntime(request.candidate);
    yield* runtime.verify;
    if ((yield* inspectJavaImportInputs(root, project)) !== sourceDigest) return yield* reject('stale');
    const policy: JavaImportPolicy = {
      version: 1,
      mode: 'maven21-dependency-free-v1',
      project: request.project,
      sourceDigest,
      candidate: request.candidate,
      permissions,
    };
    const preview = {worktree, policy, expectedDigest: selected?.digest ?? null};
    const previewDigest = sha256HexSync(JSON.stringify(preview));
    if (action === 'apply') {
      if (request.previewDigest !== previewDigest || request.expectedDigest !== selected?.digest)
        return yield* reject('stale');
      const written = yield* writeSemanticJavaImportPolicy(config, worktree, policy, request.expectedDigest);
      return {version: 1, action, state: 'configured', profileDigest: written.digest, changed: written.changed};
    }
    return {
      version: 1,
      action,
      state: 'preview',
      ...preview,
      previewDigest,
      versions: {
        server: javaRuntimeQualification.serverVersion,
        runtime: javaRuntimeQualification.runtimeVersion,
        project: javaRuntimeQualification.projectVersion,
      },
      operation: 'Import unchanged original dependency-free Maven project into a private copy',
      enforcement: enforcedContract(policy)._tag === 'Some' ? 'finite-application-profile' : 'unavailable',
      authority:
        'Caller-asserted same-user local intent; no writer grant. Finite application policy, not a machine sandbox',
      nextAction:
        'Apply requires --authorize-import and the exact previewDigest/expectedDigest; import remains blocked without independently reviewed pinned-importer enforcement',
    };
  });
  return yield* operation.pipe(
    Effect.catch(error =>
      Effect.succeed({
        version: 1,
        action,
        state: Schema.is(JavaImportFault)(error)
          ? error.reason
          : Schema.is(SemanticHostProfileFault)(error)
            ? error.reason
            : 'unavailable',
        nextAction:
          'Inspect current private policy and original inputs; missing enforcement proof refuses before cache, admission or provider launch. Maven/Gradle and platform qualification remain incomplete',
      }),
    ),
  );
});
