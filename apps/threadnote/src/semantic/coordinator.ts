import {Clock, Crypto, Deferred, Effect, Exit, FileSystem, Option, Path, Schema, Scope, Semaphore} from 'effect';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo, runtimeReadBoundedStableRegularFile} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Counter, Digest, FileUri, Identifier, Observation, Position} from '@threadnote/semantic/contracts';
import {sha256FileHex} from '@threadnote/platform/digest';
import {CommandExecutor, runDetachedCommandEffect} from '@threadnote/platform/command';
import {LspFault, makeLspClient, spawnLspWire, type LspWire} from './lsp_transport.js';
import {makeTypeScriptSession, SemanticSessionFault} from './providers/typescript.js';
import {fromPromiseInterruptible, fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {parse as parseJsonc, type ParseError} from 'jsonc-parser';

const Instance = Schema.Struct({pid: Counter, identity: Identifier});

const readBounded = (file: string, maximumBytes: number) =>
  fromPromiseInterruptibleAwaiting(
    () => runtimeReadBoundedStableRegularFile(file, maximumBytes),
    () => LspFault.make({code: 'rejected'}),
  );
const readBoundedText = (file: string, maximumBytes: number) =>
  readBounded(file, maximumBytes).pipe(
    Effect.flatMap(bytes =>
      Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes),
        catch: () => LspFault.make({code: 'protocol'}),
      }),
    ),
  );
const boundedFileDigest = Effect.fn('semantic.boundedFileDigest')(function* (file: string, maximumBytes: number) {
  const crypto = yield* Crypto.Crypto;
  const hash = yield* crypto.digest('SHA-256', yield* readBounded(file, maximumBytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
});
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

/** Bounded conservative pilot invalidation. No build/config code is evaluated to compute this basis. */
export const semanticTreeDigest = Effect.fn('semantic.treeDigest')(function* (
  root: string,
  projectConfiguration = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonical = yield* fs.realPath(root);
  if (canonical !== path.resolve(root)) return yield* LspFault.make({code: 'prerequisite'});
  const pending = [canonical];
  const entries: [string, string][] = [];
  let files = 0;
  let totalBytes = 0;
  const configurations = new Set<string>();
  const validateConfiguration = (file: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (configurations.has(file)) return;
      if (configurations.size >= 256 || !file.startsWith(canonical + path.sep) || (yield* fs.realPath(file)) !== file)
        return yield* LspFault.make({code: 'prerequisite'});
      configurations.add(file);
      if (Number((yield* fs.stat(file)).size) > 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
      const errors: ParseError[] = [];
      const raw: unknown = parseJsonc(yield* readBoundedText(file, 1024 * 1024), errors, {allowTrailingComma: true});
      if (errors.length) return yield* LspFault.make({code: 'prerequisite'});
      const configuration = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          extends: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
          references: Schema.optional(Schema.Array(Schema.Struct({path: Schema.String}))),
        }),
      )(raw);
      const extensions =
        typeof configuration.extends === 'string' ? [configuration.extends] : (configuration.extends ?? []);
      for (const base of extensions) {
        let resolved: string;
        if (base.startsWith('.'))
          resolved = path.resolve(path.dirname(file), base.endsWith('.json') ? base : base + '.json');
        else
          resolved = yield* Effect.try({
            try: () => Bun.resolveSync(base, path.dirname(file)),
            catch: () => LspFault.make({code: 'prerequisite'}),
          });
        if (!resolved.endsWith('.json')) return yield* LspFault.make({code: 'prerequisite'});
        yield* validateConfiguration(resolved);
      }
      for (const reference of configuration.references ?? []) {
        const resolved = path.resolve(path.dirname(file), reference.path);
        if (!resolved.startsWith(canonical + path.sep) || (yield* fs.realPath(resolved)) !== resolved)
          return yield* LspFault.make({code: 'prerequisite'});
      }
    });
  while (pending.length) {
    const directory = pending.pop()!;
    const names = (yield* fs.readDirectory(directory)).sort();
    if (names.length + files > 20_000) return yield* LspFault.make({code: 'capacity'});
    for (const name of names) {
      const file = path.join(directory, name);
      const relative = path.relative(canonical, file);
      if (relative === '.git' || relative.startsWith('.git/')) continue;
      if (++files > 20_000) return yield* LspFault.make({code: 'capacity'});
      // Symlinked or external project roots need explicit provider qualification; never silently omit them.
      if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
        return yield* LspFault.make({code: 'prerequisite'});
      const before = yield* fs.stat(file);
      if (before.type === 'Directory') {
        pending.push(file);
        entries.push([relative, 'directory']);
        continue;
      }
      if (before.type !== 'File' || Number(before.size) > 32 * 1024 * 1024)
        return yield* LspFault.make({code: 'capacity'});
      totalBytes += Number(before.size);
      if (totalBytes > 256 * 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
      const hash = yield* boundedFileDigest(file, Number(before.size));
      if (projectConfiguration && /^(?:tsconfig|jsconfig)(?:\..+)?\.json$/u.test(name))
        yield* validateConfiguration(file);
      const after = yield* fs.stat(file);
      if (
        after.size !== before.size ||
        Option.getOrUndefined(after.mtime)?.getTime() !== Option.getOrUndefined(before.mtime)?.getTime()
      )
        return yield* LspFault.make({code: 'rejected'});
      entries.push([relative, hash]);
    }
  }
  // Include worktree and common branch metadata without traversing Git object storage.
  const git = path.join(canonical, '.git');
  if (yield* fs.exists(git)) {
    const info = yield* fs.stat(git);
    let directory = git;
    if (info.type === 'File') {
      if (Number(info.size) > 8192) return yield* LspFault.make({code: 'prerequisite'});
      const text = (yield* readBoundedText(git, 8192)).trim();
      if (!text.startsWith('gitdir: ')) return yield* LspFault.make({code: 'prerequisite'});
      directory = yield* fs.realPath(path.resolve(canonical, text.slice(8)));
    }
    const head = yield* readBoundedText(path.join(directory, 'HEAD'), 8192);
    entries.push(['git:HEAD', head]);
    const commonFile = path.join(directory, 'commondir');
    const common = (yield* fs.exists(commonFile))
      ? path.resolve(directory, (yield* readBoundedText(commonFile, 8192)).trim())
      : directory;
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes('\\'))
        return yield* LspFault.make({code: 'prerequisite'});
      const file = path.join(common, ref);
      if (yield* fs.exists(file)) entries.push(['git:ref', yield* readBoundedText(file, 8192)]);
      const packed = path.join(common, 'packed-refs');
      if (yield* fs.exists(packed)) {
        if (Number((yield* fs.stat(packed)).size) > 4 * 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
        entries.push(['git:packed', yield* boundedFileDigest(packed, 4 * 1024 * 1024)]);
      }
    }
  }
  return sha256HexSync(JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b))));
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
export interface SemanticCoordinatorOptions {
  readonly enabled: boolean;
  readonly dataHome: string;
  readonly candidate: TypeScriptHostCandidate;
}
type TypeScriptSession = Effect.Success<ReturnType<typeof makeTypeScriptSession>>;
interface AnalysisSession {
  readonly scope: Scope.Closeable;
  readonly api: TypeScriptSession;
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
  JSON.stringify([o.repository, o.worktree, o.project, o.view.kind, o.view.id, o.view.owner, o.view.epoch]);

/** Host-only construction. Repository requests can select a source view, never an executable, plugin or build policy. */
export const makeSemanticCoordinator = Effect.fn('semantic.makeCoordinator')(function* (
  options: SemanticCoordinatorOptions,
) {
  if (!options.enabled) return yield* LspFault.make({code: 'prerequisite'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const command = yield* CommandExecutor;
  const home = yield* fs.realPath(options.dataHome);
  if (home !== path.resolve(options.dataHome)) return yield* LspFault.make({code: 'prerequisite'});
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
  const candidate = structuredClone(options.candidate);
  const toolchain = sha256HexSync(
    JSON.stringify([candidate.runtimeDigest, candidate.serverTreeDigest, candidate.sdkTreeDigest]),
  );
  // P00 selected the 6.0.2 fallback with SDK6.0.3/Node24.19.0; this pilot never selects by executable presence.
  // config/semantic-providers/qualification-lock.json retains feasibility evidence and unresolved production gates.
  if (
    candidate.runtimeVersion !== '24.19.0' ||
    ![candidate.runtimeDigest, candidate.sdkTreeDigest, candidate.serverTreeDigest].every(value =>
      Schema.is(Digest)(value),
    )
  )
    return yield* LspFault.make({code: 'prerequisite'});
  const verifyCandidate = Effect.gen(function* () {
    for (const file of [candidate.runtime, candidate.sdkDirectory, candidate.serverDirectory])
      if ((yield* fs.realPath(file)) !== path.resolve(file)) return yield* LspFault.make({code: 'prerequisite'});
    if (
      (yield* sha256FileHex(candidate.runtime)) !== candidate.runtimeDigest ||
      (yield* semanticTreeDigest(candidate.sdkDirectory)) !== candidate.sdkTreeDigest ||
      (yield* semanticTreeDigest(candidate.serverDirectory)) !== candidate.serverTreeDigest
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
  });
  yield* verifyCandidate;
  const version = yield* command.execute(candidate.runtime, ['--version'], {
    env: {},
    timeoutMs: 2000,
    maxOutputBytes: 128,
  });
  if (version.stdout.trim() !== 'v24.19.0') return yield* LspFault.make({code: 'prerequisite'});
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
  const attach = (observation: Observation, text: string, language: Parameters<TypeScriptSession['upsert']>[2]) =>
    startup.withPermit(
      Effect.gen(function* () {
        const input = structuredClone(yield* Schema.decodeEffect(Observation)(observation));
        if (sha256HexSync(text) !== input.content) return yield* LspFault.make({code: 'protocol'});
        let fixed = {...input, toolchain};
        const project = yield* path.fromFileUrl(new URL(fixed.project));
        const worktree = yield* path.fromFileUrl(new URL(fixed.worktree));
        const file = yield* path.fromFileUrl(new URL(fixed.uri));
        if (
          !(project === worktree || project.startsWith(worktree + path.sep)) ||
          !file.startsWith(project + path.sep) ||
          (yield* fs.realPath(project)) !== project ||
          (yield* fs.realPath(worktree)) !== worktree
        )
          return yield* LspFault.make({code: 'prerequisite'});
        if (fixed.view.kind === 'disk' && (yield* boundedFileDigest(file, 32 * 1024 * 1024)) !== fixed.content)
          return yield* LspFault.make({code: 'rejected'});
        const id = sessionIdentity(fixed);
        let session = sessions.get(id);
        const diskBasis = yield* semanticTreeDigest(worktree, true);
        fixed = {...fixed, configuration: diskBasis};
        if (session && session.diskBasis !== diskBasis) {
          yield* retire(id, session);
          return yield* LspFault.make({code: 'rejected'});
        }
        if (!session) {
          if ((failures.get(id) ?? 0) >= 2 || failures.size >= 256) return yield* LspFault.make({code: 'prerequisite'});
          yield* verifyCandidate;
          const owned = yield* Scope.fork(scope);
          const create = Effect.gen(function* () {
            const reservation = yield* admission.acquire(
              sha256HexSync(fixed.repository + '\0' + fixed.worktree),
              10_000,
            );
            fixed = {
              ...fixed,
              provider: {id: 'typescript-language-server', version: '6.0.2', generation: reservation.generation},
              projectEpoch: reservation.generation,
            };
            const wireState: {current?: LspWire} = {};
            yield* Effect.addFinalizer(() =>
              wireState.current
                ? wireState.current.finish.pipe(
                    Effect.flatMap(receipt => reservation.release(receipt.drained && receipt.stdioClosed)),
                    Effect.ignore,
                  )
                : Effect.void,
            );
            const wire = yield* spawnLspWire({
              command: candidate.runtime,
              args: [path.join(candidate.serverDirectory, 'lib/cli.mjs'), '--stdio'],
              cwd: project,
              // No NODE_OPTIONS, NODE_PATH, TS plugin/log variables, repository PATH or inherited execution settings.
              environment: {},
            });
            wireState.current = wire;
            yield* reservation.bindProvider(wire.pid);
            const client = yield* makeLspClient(wire);
            const api = yield* makeTypeScriptSession(client, {
              basis: fixed,
              tsserver: path.join(candidate.sdkDirectory, 'lib/tsserver.js'),
              maxMemoryMb: 512,
              startupMilliseconds: 10_000,
            });
            fixed = yield* api.upsert(fixed, text, language, 10_000);
            yield* reservation.finishImport;
            return {
              scope: owned,
              api,
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
            recordFailure(id, 'startup');
            return yield* LspFault.make({code: 'prerequisite'});
          }
          session = created.value;
          sessions.set(id, session);
        } else {
          fixed = {...fixed, provider: session.basis.provider, projectEpoch: session.basis.projectEpoch};
          const active = session;
          fixed = yield* active.api
            .upsert(fixed, text, language, 10_000)
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
            (yield* semanticTreeDigest(worktree, true)) !== diskBasis
          )
            return yield* LspFault.make({code: 'rejected'});
          return info;
        }).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? retire(id, active).pipe(Effect.ignore) : Effect.void)));
        session.lastUsed = yield* Clock.currentTimeMillis;
        return {
          observation: structuredClone(fixed),
          status: 'experimental' as const,
          completeness: 'partial' as const,
          edits: 'disabled' as const,
          project: projectInfo,
        };
      }),
    );
  const use = <A, E, R>(
    observation: Observation,
    milliseconds: number,
    f: (api: TypeScriptSession) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 45_000)
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
            const before = yield* semanticTreeDigest(worktree, true);
            if (before !== session.diskBasis) {
              yield* retire(id, session);
              return yield* LspFault.make({code: 'rejected'});
            }
            yield* verifyCandidate;
            session.lastUsed = yield* Clock.currentTimeMillis;
            const result = yield* f(session.api);
            yield* verifyCandidate;
            if (session.closing || (yield* semanticTreeDigest(worktree, true)) !== before) {
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
        if (session.queued === 0 && now - session.lastUsed >= 600_000) yield* retire(id, session);
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
        failures: [...failures].map(([id, attempts]) => ({
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
    language: Schema.Literals(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']),
  }),
  Schema.Struct({
    operation: Schema.Literal('query'),
    observation: Observation,
    query: Schema.Literals(['definition', 'references', 'hover', 'symbols']),
    position: Schema.optional(Position),
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
  const grants = new Map<string, {token: string; lastUsed: number; gate: Semaphore.Semaphore}>();
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
              const result = yield* coordinator.attach(body.observation, body.text, body.language);
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
                  : 'prerequisite',
              nextAction:
                'Inspect semantic status and source-view readiness; structural graph and memory remain available',
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
            if (grants.get(id) === grant && now - grant.lastUsed >= 600_000) grants.delete(id);
          }),
        );
      }
    }
  }).pipe(Effect.forkScoped);
  return {
    socket,
    idle: Effect.sync(() => requests === 0).pipe(
      Effect.flatMap(empty =>
        Clock.currentTimeMillis.pipe(Effect.map(now => empty && (shutdown || now - lastUsed >= 600_000))),
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
    Effect.timeoutOption(45_000),
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
const Bootstrap = Schema.Struct({
  version: Schema.Literal(1),
  runtimeIdentity: Digest,
  token: Digest,
  worktree: FileUri,
  dataHome: Schema.String,
  candidate: HostCandidate,
});
export interface SemanticEndpointLaunch extends SemanticCoordinatorOptions {
  readonly worktree: string;
  /** Exact application/runtime identity supplied by the host, independent of provider selection. */
  readonly runtimeIdentity: string;
}

/** Starts one runtime/worktree coordinator lazily. Capabilities/source text never enter process arguments. */
export const ensureSemanticEndpoint = Effect.fn('semantic.ensureEndpoint')(function* (options: SemanticEndpointLaunch) {
  if (!options.enabled || !Schema.is(Digest)(options.runtimeIdentity) || !Schema.is(FileUri)(options.worktree))
    return yield* LspFault.make({code: 'prerequisite'});
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const crypto = yield* Crypto.Crypto;
  const home = yield* fs.realPath(options.dataHome);
  if (home !== path.resolve(options.dataHome)) return yield* LspFault.make({code: 'prerequisite'});
  const key = sha256HexSync(JSON.stringify([home, options.worktree, options.runtimeIdentity]));
  const directory = path.join(home, 'semantic', key.slice(0, 20));
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
      waitTimeoutMilliseconds: 15_000,
      staleAfterMilliseconds: 60_000,
      useCanonicalProcessStartIdentity: true,
    },
    Effect.gen(function* () {
      let bootstrap: typeof Bootstrap.Type;
      if (yield* fs.exists(bootstrapFile)) {
        bootstrap = yield* readSemanticBootstrap(bootstrapFile);
        if (
          bootstrap.worktree !== options.worktree ||
          bootstrap.runtimeIdentity !== options.runtimeIdentity ||
          bootstrap.dataHome !== home ||
          semanticCandidateKey(bootstrap.candidate) !== semanticCandidateKey(options.candidate)
        )
          return yield* LspFault.make({code: 'prerequisite'});
      } else {
        bootstrap = {
          version: 1,
          runtimeIdentity: options.runtimeIdentity,
          worktree: options.worktree,
          token: sha256HexSync(yield* crypto.randomBytes(32)),
          dataHome: home,
          candidate: options.candidate,
        };
        yield* fs.writeFileString(bootstrapFile, JSON.stringify(bootstrap), {flag: 'wx', mode: 0o600});
      }
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
        const name = system.executablePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
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
        const until = (yield* Clock.currentTimeMillis) + 10_000;
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
      staleAfterMilliseconds: 60_000,
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
type Ledger = {version: 1; nextGeneration: number; slots: (typeof Reservation.Type)[]; tickets: (typeof Ticket.Type)[]};
const limits = Object.freeze({providersPerHome: 8, providersPerWorkspace: 4, importsPerHome: 2, queued: 32});

/** Probe only. Unknown/EPERM remains occupied; no PID-only signalling or recovery. */
function processGroupPresent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
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
        staleAfterMilliseconds: 10_000,
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
      imports: ledger.slots.filter(slot => slot.importing).length,
      queued: ledger.tickets.length,
      quarantined: ledger.slots.filter(slot => slot.quarantined).length,
      nextAction: ledger.slots.some(slot => slot.quarantined)
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
        milliseconds > 120_000
      )
        return yield* LspFault.make({code: 'protocol'});
      const id = yield* token();
      let assigned = false;
      let generation = 0;
      yield* Effect.addFinalizer(() =>
        transaction(ledger =>
          Effect.sync(() => {
            ledger.tickets = ledger.tickets.filter(ticket => ticket.token !== id);
            ledger.slots = ledger.slots.map(slot => (slot.token === id ? {...slot, quarantined: true} : slot));
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
                ledger.slots.filter(slot => slot.importing).length >= limits.importsPerHome
              )
                return false;
              // Skip a ticket blocked by its own workspace cap so another workspace can progress.
              const eligible = ledger.tickets.find(
                ticket =>
                  ledger.slots.filter(slot => slot.workspace === ticket.workspace).length <
                  limits.providersPerWorkspace,
              );
              if (eligible?.token !== id || ledger.nextGeneration >= Number.MAX_SAFE_INTEGER) return false;
              generation = ++ledger.nextGeneration;
              ledger.tickets = ledger.tickets.filter(ticket => ticket.token !== id);
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
              ledger.tickets = ledger.tickets.filter(ticket => ticket.token !== id);
            }),
          ).pipe(Effect.ignore),
        ),
      );
      let released = false;
      const update = (f: (slot: typeof Reservation.Type) => typeof Reservation.Type | undefined) =>
        transaction(ledger =>
          Effect.gen(function* () {
            if (released) return;
            const index = ledger.slots.findIndex(
              slot => slot.token === id && slot.owner.pid === owner.pid && slot.owner.identity === owner.identity,
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
