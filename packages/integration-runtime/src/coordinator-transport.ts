import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import {Cause, Clock, Context, Crypto, Effect, FileSystem, Layer, Option, Path, Schema, Stream} from 'effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import {
  SourceCoordinator,
  SourceCoordinatorError,
  SourceHttpAdmission,
  type SourceAdmissionRequest,
  type SourceWorkDescriptor,
  type SourceWorkRegistration,
  type SourceWorkResult,
} from '@threadnote/integration-core/source-coordinator';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {runtimeReadBoundedStableRegularFile, SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  assertCoordinatorFile,
  coordinatorConcurrency,
  coordinatorPaths,
  decodeCoordinatorConfig,
  makeCoordinatorEngine,
  openCoordinatorStore,
  sameCoordinatorIdentity,
  validatedSourceWorkDescriptor,
  type CoordinatorTicket,
} from './coordinator.js';

const unavailable = () =>
  SourceCoordinatorError.make({message: 'Integration coordinator is unavailable. Retry the operation.'});
const workerStages = [
  'configuration',
  'HTTP client initialization',
  'singleton acquisition',
  'queue initialization',
  'engine initialization',
  'token generation',
  'listener initialization',
  'process identity',
  'listener activation',
  'endpoint publication',
  'initial queue cleanup',
  'work scheduling',
] as const;
type WorkerStage = (typeof workerStages)[number];
const workerMessage = (stage: WorkerStage) =>
  `Integration sync coordinator stopped during ${stage}. Retry source sync to restart it.`;
const workerFailure = (stage: WorkerStage) => SourceCoordinatorError.make({message: workerMessage(stage)});
const workerMessages = new Set<string>(workerStages.map(workerMessage));

/** Only fixed runtime-owned messages may be printed by the standalone worker. */
export function coordinatorWorkerFailureMessage(error: unknown): string {
  return Schema.is(SourceCoordinatorError)(error) && workerMessages.has(error.message)
    ? error.message
    : 'Integration sync coordinator stopped during runtime bootstrap. Retry source sync to restart it.';
}

const atWorkerStage =
  (stage: WorkerStage) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause(cause => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
        const error = Option.getOrUndefined(Cause.findErrorOption(cause));
        return Effect.fail(
          Schema.is(SourceCoordinatorError)(error) && workerMessages.has(error.message) ? error : workerFailure(stage),
        );
      }),
    );
type ClientStage =
  | 'local queue validation'
  | 'source inventory'
  | 'credential handoff'
  | 'queue initialization'
  | 'demand publication'
  | 'worker launch'
  | 'result delivery';
const atClientStage =
  (stage: ClientStage) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(() =>
        SourceCoordinatorError.make({message: `Integration coordinator failed during ${stage}. Retry the operation.`}),
      ),
    );
const BODY_LIMIT = 1_048_576;
interface Endpoint {
  readonly protocol: 1;
  readonly home: string;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly processStartIdentity?: string;
}
interface CredentialBinding {
  readonly descriptor: SourceWorkDescriptor;
  readonly values: Readonly<Record<string, string>>;
}

const endpoint = Effect.fn('source.readCoordinatorEndpoint')(function* (config: RuntimeConfig) {
  const paths = yield* coordinatorPaths(config);
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  if (!(yield* fs.exists(paths.endpoint))) return undefined;
  yield* assertCoordinatorFile(paths.endpoint);
  const raw = yield* fromPromiseInterruptible(
    () => runtimeReadBoundedStableRegularFile(paths.endpoint, 8_192),
    unavailable,
  );
  const data = yield* Effect.try({
    try: () => {
      const value = JSON.parse(new TextDecoder().decode(raw)) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unavailable();
      return value as Endpoint;
    },
    catch: unavailable,
  });
  if (
    data.protocol !== 1 ||
    data.home !== paths.home ||
    !Number.isInteger(data.port) ||
    data.port < 1 ||
    data.port > 65_535 ||
    !/^[a-f0-9]{64}$/.test(data.token) ||
    !Number.isInteger(data.pid) ||
    data.pid <= 0 ||
    !system.isProcessRunning(data.pid)
  )
    return undefined;
  const start = yield* (system.canonicalProcessStartIdentity ?? system.processStartIdentity)(data.pid);
  if (data.processStartIdentity !== undefined && start !== data.processStartIdentity) return undefined;
  return data;
});

async function boundedBody(request: Request | Response): Promise<unknown> {
  if (!request.body) throw unavailable();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > BODY_LIMIT) throw unavailable();
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

const post = Effect.fn('source.coordinatorPost')(function* (
  target: Endpoint,
  operation: string,
  body: unknown,
  timeoutMs: number,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* Effect.gen(function* () {
    const request = HttpClientRequest.post(`http://127.0.0.1:${target.port}/v1/${operation}`).pipe(
      HttpClientRequest.setHeaders({authorization: `Bearer ${target.token}`, 'content-type': 'application/json'}),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    const response = yield* client
      .execute(request)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, {redirect: 'error'}));
    if (response.status !== 200) return yield* unavailable();
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* Stream.runForEach(response.stream, chunk =>
      Effect.gen(function* () {
        size += chunk.byteLength;
        if (size > BODY_LIMIT) return yield* unavailable();
        chunks.push(chunk);
      }),
    );
    return yield* Effect.try({
      try: () => {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
      },
      catch: unavailable,
    });
  }).pipe(Effect.timeout(timeoutMs), Effect.mapError(unavailable));
});

const handoffBindings = (
  target: Endpoint,
  config: RuntimeConfig,
  bindings: readonly CredentialBinding[],
  timeoutMs: number,
) =>
  Effect.forEach(
    Array.from({length: Math.ceil(bindings.length / 64)}, (_, index) => bindings.slice(index * 64, (index + 1) * 64)),
    batch =>
      post(target, 'bindings', {config, bindings: batch}, timeoutMs).pipe(
        Effect.flatMap(reply => {
          if (typeof reply !== 'object' || reply === null || !('accepted' in reply) || reply.accepted !== batch.length)
            return unavailable();
          return Effect.void;
        }),
      ),
    {concurrency: 1},
  ).pipe(Effect.asVoid);

const wake = (target: Endpoint, config: RuntimeConfig) =>
  post(target, 'wake', {config}, 150).pipe(
    Effect.flatMap(reply =>
      typeof reply === 'object' && reply !== null && 'ok' in reply && reply.ok === true ? Effect.void : unavailable(),
    ),
  );

export interface CoordinatorClientOptions<R, LaunchR = never> {
  readonly registrations: readonly SourceWorkRegistration<R>[];
  readonly spawnWorker: (config: RuntimeConfig) => Effect.Effect<unknown, unknown, LaunchR>;
  readonly syncTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

/** No database or worker is opened merely by building the application layer. */
export function makeCoordinatorClientLayer<R, LaunchR>(options: CoordinatorClientOptions<R, LaunchR>) {
  return Layer.effectContext(
    Effect.gen(function* () {
      const initialContext = yield* Effect.context<
        R | LaunchR | FileSystem.FileSystem | Path.Path | SystemInfo | Crypto.Crypto
      >();
      const httpContext = yield* Layer.build(FetchHttpClient.layer);
      const context = Context.merge(initialContext, httpContext);
      if (
        [options.syncTimeoutMs, options.startupTimeoutMs].some(
          value => value !== undefined && (!Number.isFinite(value) || value <= 0),
        )
      )
        return yield* unavailable();
      const system = yield* SystemInfo;
      const canonical = (config: RuntimeConfig) =>
        Effect.gen(function* () {
          const paths = yield* coordinatorPaths(config);
          return decodeCoordinatorConfig({...config, agentContextHome: paths.home}, paths.home);
        });
      const ensureWorker = (config: RuntimeConfig) =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          let launched = false;
          let discovered = false;
          do {
            const target = yield* endpoint(config).pipe(Effect.orElseSucceed(() => undefined));
            if (target) discovered = true;
            if (target && (yield* wake(target, config).pipe(Effect.result))._tag === 'Success') return target;
            if (!launched) {
              yield* options.spawnWorker(config).pipe(atClientStage('worker launch'));
              launched = true;
            }
            yield* Effect.sleep(25);
          } while ((yield* Clock.currentTimeMillis) - started < (options.startupTimeoutMs ?? 10_000));
          return yield* SourceCoordinatorError.make({
            message: discovered
              ? 'Integration coordinator did not accept requests before its startup deadline. Retry the operation.'
              : 'Integration coordinator did not publish a valid endpoint before its startup deadline. Retry the operation.',
          });
        });
      const request = (config: RuntimeConfig, sourceId: string | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const normalized = yield* canonical(config).pipe(atClientStage('local queue validation'));
            const descriptors = (yield* Effect.forEach(
              options.registrations,
              registration => registration.list(normalized),
              {concurrency: 1},
            ).pipe(atClientStage('source inventory'))).flat();
            const selected =
              sourceId === undefined ? descriptors : descriptors.filter(value => value.sourceId === sourceId);
            if (sourceId !== undefined && selected.length !== 1)
              return yield* SourceCoordinatorError.make({
                message: `Source ${sourceId.slice(0, 128)} is unavailable or disabled.`,
              });
            const bindings = selected
              .filter(descriptor => descriptor.credentialEnv !== undefined)
              .map(descriptor => {
                const name = descriptor.credentialEnv!;
                const value = system.environment()[name];
                return {descriptor, values: value !== undefined && value.length <= 4_096 ? {[name]: value} : {}};
              });
            const handoff = (target: Endpoint, timeoutMs: number) =>
              handoffBindings(target, normalized, bindings, timeoutMs).pipe(atClientStage('credential handoff'));
            // Hand off rotations before making durable work visible to a live worker.
            // A cold worker inherits this caller's environment from the launch adapter.
            const existing = yield* endpoint(normalized).pipe(Effect.orElseSucceed(() => undefined));
            if (existing && bindings.length) {
              if (sourceId === undefined)
                yield* handoff(existing, 150).pipe(Effect.timeout(150), atClientStage('credential handoff'));
              else yield* handoff(existing, 5_000);
            }
            const store = yield* openCoordinatorStore(normalized).pipe(atClientStage('queue initialization'));
            const tickets = yield* store
              .enqueue(normalized, selected, sourceId === undefined ? 'automatic' : 'explicit')
              .pipe(atClientStage('demand publication'));
            if (tickets.length === 0) return {config: normalized, tickets};
            if (sourceId === undefined) {
              // Wake follows the durable write. A retiring worker rejects it;
              // the detached contender waits for singleton release or yields
              // promptly to a different authenticated accepting worker.
              // Cold callers still launch to transfer their inherited bindings.
              if (!existing || (yield* wake(existing, normalized).pipe(Effect.result))._tag === 'Failure')
                yield* options.spawnWorker(normalized).pipe(atClientStage('worker launch'));
            } else {
              const target = yield* ensureWorker(normalized);
              if (!existing && bindings.length) yield* handoff(target, 5_000);
            }
            return {config: normalized, tickets};
          }).pipe(Effect.mapError(error => (Schema.is(SourceCoordinatorError)(error) ? error : unavailable()))),
        );
      const coordinator = SourceCoordinator.of({
        requestRefresh: config => request(config, undefined).pipe(Effect.asVoid, Effect.provide(context)),
        sync: (config, sourceId) =>
          Effect.gen(function* () {
            const requested = yield* request(config, sourceId);
            const ticket = requested.tickets[0];
            if (!ticket) return yield* unavailable();
            for (;;) {
              const target = yield* ensureWorker(requested.config);
              const result = (yield* post(target, 'result', {config: requested.config, ticket}, 5_000).pipe(
                atClientStage('result delivery'),
              )) as {
                ready: boolean;
                failed?: boolean;
                result?: SourceWorkResult;
                missingValue?: boolean;
              };
              if (result.ready) {
                if (result.failed || result.missingValue || !result.result)
                  return yield* SourceCoordinatorError.make({
                    message: 'Source sync failed or the coordinator restarted before delivery. Retry the operation.',
                  });
                return result.result;
              }
              yield* Effect.sleep(50);
            }
          }).pipe(
            Effect.timeout(options.syncTimeoutMs ?? 120_000),
            Effect.mapError(error =>
              Schema.is(SourceCoordinatorError)(error)
                ? error
                : SourceCoordinatorError.make({
                    message: 'Source sync exceeded its deadline. Refresh continues in the background.',
                  }),
            ),
            Effect.provide(context),
          ),
      });
      const admission = SourceHttpAdmission.of({
        admit: request =>
          Effect.gen(function* () {
            const config = yield* canonical(request.config);
            const target = yield* ensureWorker(config);
            yield* post(target, 'admit', {...request, config}, 30_000);
          }).pipe(Effect.asVoid, Effect.mapError(unavailable), Effect.provide(context)),
        cooldown: request =>
          Effect.gen(function* () {
            const config = yield* canonical(request.config);
            const target = yield* ensureWorker(config);
            yield* post(target, 'cooldown', {...request, config}, 5_000);
          }).pipe(Effect.asVoid, Effect.mapError(unavailable), Effect.provide(context)),
      });
      return Context.make(SourceCoordinator, coordinator).pipe(Context.add(SourceHttpAdmission, admission));
    }),
  );
}

function ticketFrom(value: unknown): CoordinatorTicket {
  if (typeof value !== 'object' || value === null) throw unavailable();
  const ticket = value as CoordinatorTicket;
  if (!/^[a-f0-9]{64}$/.test(ticket.key) || !Number.isSafeInteger(ticket.generation) || ticket.generation < 1)
    throw unavailable();
  return {key: ticket.key, generation: ticket.generation};
}

function credentialValues(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw unavailable();
  const entries = Object.entries(value);
  if (entries.length > 64) throw unavailable();
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, token] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof token !== 'string' || token.length > 4_096)
      throw unavailable();
    result[key] = token;
  }
  return result;
}

export const runCoordinatorWorker = Effect.fn('source.runCoordinatorWorker')(function* <R>(options: {
  readonly config: RuntimeConfig;
  readonly registrations: readonly SourceWorkRegistration<R>[];
  readonly idleTimeoutMs?: number;
  readonly quantumTimeoutMs?: number;
  readonly maxConcurrentSources?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const crypto = yield* Crypto.Crypto;
  const paths = yield* coordinatorPaths(options.config).pipe(atWorkerStage('configuration'));
  const config = yield* Effect.try({
    try: () => decodeCoordinatorConfig({...options.config, agentContextHome: paths.home}, paths.home),
    catch: unavailable,
  }).pipe(atWorkerStage('configuration'));
  const concurrency = yield* Effect.try({
    try: () => coordinatorConcurrency(options.maxConcurrentSources),
    catch: unavailable,
  }).pipe(atWorkerStage('configuration'));
  if (options.idleTimeoutMs !== undefined && (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs <= 0))
    return yield* workerFailure('configuration');
  const httpContext = yield* Layer.build(FetchHttpClient.layer).pipe(atWorkerStage('HTTP client initialization'));
  let acquired = false;
  const ownership = withExclusiveFileLock(
    fs,
    paths.lock,
    {
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 10_000,
      heartbeatIntervalMilliseconds: 1_000,
      waitTimeoutMilliseconds: 30_000,
      onAcquired: () =>
        Effect.sync(() => {
          acquired = true;
        }),
      useCanonicalProcessStartIdentity: true,
      recoverReusedProcessIdImmediately: true,
    },
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openCoordinatorStore(config).pipe(atWorkerStage('queue initialization'));
        const engine = yield* makeCoordinatorEngine({
          store,
          registrations: options.registrations,
          quantumTimeoutMs: options.quantumTimeoutMs,
          maxConcurrentSources: options.maxConcurrentSources,
        }).pipe(atWorkerStage('engine initialization'));
        const token = Array.from(yield* crypto.randomBytes(32).pipe(atWorkerStage('token generation')), byte =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        const server = yield* BunHttpServer.make({
          hostname: '127.0.0.1',
          port: 0,
          maxRequestBodySize: BODY_LIMIT,
          idleTimeout: 35,
        }).pipe(atWorkerStage('listener initialization'));
        const port =
          server.address._tag === 'InetAddressV4' || server.address._tag === 'InetAddressV6' ? server.address.port : 0;
        if (!port) return yield* workerFailure('listener initialization');
        const state: Endpoint = {
          protocol: 1,
          home: paths.home,
          port,
          token,
          pid: system.processId,
          processStartIdentity: yield* (system.canonicalProcessStartIdentity ?? system.processStartIdentity)(
            system.processId,
          ).pipe(atWorkerStage('process identity')),
        };
        let lastActivity = yield* Clock.currentTimeMillis;
        let accepting = true;
        const handler = Effect.gen(function* () {
          const incoming = yield* HttpServerRequest.HttpServerRequest;
          const web = yield* HttpServerRequest.toWeb(incoming);
          const url = new URL(web.url);
          if (
            web.method !== 'POST' ||
            web.headers.has('origin') ||
            web.headers.get('authorization') !== `Bearer ${token}` ||
            web.headers.get('host') !== `127.0.0.1:${port}` ||
            web.headers.get('content-type') !== 'application/json'
          )
            return HttpServerResponse.fromWeb(new Response(null, {status: 403}));
          const raw = yield* fromPromiseInterruptible(() => boundedBody(web), unavailable);
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return yield* unavailable();
          const data = raw as Record<string, unknown>;
          const requestConfig = yield* Effect.try({
            try: () => decodeCoordinatorConfig(data.config, paths.home),
            catch: unavailable,
          });
          if (!accepting) return yield* unavailable();
          lastActivity = yield* Clock.currentTimeMillis;
          if (url.pathname === '/v1/wake') return HttpServerResponse.fromWeb(Response.json({ok: true}));
          if (url.pathname === '/v1/bindings') {
            if (!Array.isArray(data.bindings) || data.bindings.length > 64) return yield* unavailable();
            for (const rawBinding of data.bindings) {
              if (typeof rawBinding !== 'object' || rawBinding === null) return yield* unavailable();
              const binding = rawBinding as {descriptor: unknown; values: unknown};
              const descriptor = yield* Effect.try({
                try: () => validatedSourceWorkDescriptor(binding.descriptor),
                catch: unavailable,
              });
              const registration = options.registrations.find(value => value.provider === descriptor?.provider);
              if (
                !registration ||
                !descriptor.credentialEnv ||
                !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(descriptor.credentialEnv)
              )
                return yield* unavailable();
              const supplied = yield* Effect.try({try: () => credentialValues(binding.values), catch: unavailable});
              const values =
                supplied[descriptor.credentialEnv] === undefined
                  ? {}
                  : {[descriptor.credentialEnv]: supplied[descriptor.credentialEnv]};
              // Authenticated, bounded ephemeral handoff only. The worker's
              // consumption-time fresh descriptor/account fence is authoritative.
              engine.acceptBinding(requestConfig, descriptor, values);
            }
            return HttpServerResponse.fromWeb(Response.json({ok: true, accepted: data.bindings.length}));
          }
          if (url.pathname === '/v1/credentials') {
            if (!Array.isArray(data.tickets) || data.tickets.length > 1_024) return yield* unavailable();
            const values = yield* Effect.try({try: () => credentialValues(data.values), catch: unavailable});
            for (const raw of data.tickets) {
              const ticket = yield* Effect.try({try: () => ticketFrom(raw), catch: unavailable});
              // Credential handoff never creates work or changes durable identities.
              const rows = yield* store.sql<{
                readonly config_json: string;
                readonly descriptor_json: string;
              }>`SELECT config_json,descriptor_json FROM source_jobs WHERE key=${ticket.key} AND generation=${ticket.generation}`;
              if (rows[0]) {
                const expected = decodeCoordinatorConfig(JSON.parse(rows[0].config_json), paths.home);
                if (!sameCoordinatorIdentity(expected, requestConfig)) return yield* unavailable();
                const descriptor = JSON.parse(rows[0].descriptor_json) as {credentialEnv?: string};
                engine.acceptCredentials(
                  ticket,
                  descriptor.credentialEnv && values[descriptor.credentialEnv] !== undefined
                    ? {[descriptor.credentialEnv]: values[descriptor.credentialEnv]}
                    : {},
                );
              }
            }
            return HttpServerResponse.fromWeb(Response.json({ok: true}));
          }
          if (url.pathname === '/v1/result') {
            const ticket = yield* Effect.try({try: () => ticketFrom(data.ticket), catch: unavailable});
            const rows = yield* store.sql<{
              readonly config_json: string;
            }>`SELECT config_json FROM source_jobs WHERE key=${ticket.key}`;
            if (rows[0]) {
              const expected = decodeCoordinatorConfig(JSON.parse(rows[0].config_json), paths.home);
              if (!sameCoordinatorIdentity(expected, requestConfig)) return yield* unavailable();
            }
            const completed = yield* store.sql<{
              readonly generation: number;
            }>`SELECT generation FROM source_receipts WHERE key=${ticket.key} AND generation>=${ticket.generation} ORDER BY generation LIMIT 1`;
            const delivered = completed[0] ? {...ticket, generation: completed[0].generation} : ticket;
            const receipt = yield* store.receipt(delivered);
            const result = engine.result(delivered);
            return HttpServerResponse.fromWeb(
              Response.json(
                receipt
                  ? {ready: true, failed: receipt.failed, result: result ?? receipt.result, missingValue: !result}
                  : {ready: false},
              ),
            );
          }
          if (url.pathname === '/v1/admit' || url.pathname === '/v1/cooldown') {
            const request = {
              config: requestConfig,
              provider: data.provider,
              accountKey: data.accountKey,
              method: data.method,
            } as SourceAdmissionRequest;
            if (!options.registrations.some(registration => registration.provider === request.provider))
              return yield* unavailable();
            if (url.pathname === '/v1/admit') yield* engine.admission.admit(request);
            else yield* engine.admission.cooldown({...request, retryAfterMs: Number(data.retryAfterMs)});
            return HttpServerResponse.fromWeb(Response.json({ok: true}));
          }
          return HttpServerResponse.fromWeb(new Response(null, {status: 404}));
        }).pipe(
          Effect.orElseSucceed(() =>
            HttpServerResponse.fromWeb(Response.json({error: 'Coordinator request failed.'}, {status: 409})),
          ),
        );
        yield* server.serve(handler).pipe(atWorkerStage('listener activation'));
        yield* Effect.gen(function* () {
          yield* assertCoordinatorFile(paths.endpoint);
          const temporary = `${paths.endpoint}.${token}.tmp`;
          yield* fs.writeFileString(temporary, JSON.stringify(state), {mode: 0o600, flag: 'wx'});
          yield* fs.rename(temporary, paths.endpoint);
        }).pipe(atWorkerStage('endpoint publication'));
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const current = yield* endpoint(config).pipe(Effect.orElseSucceed(() => undefined));
            if (current?.token === token) yield* fs.remove(paths.endpoint).pipe(Effect.ignore);
          }),
        );
        for (let index = 0; index < concurrency; index++)
          yield* Effect.forkScoped(Effect.forever(engine.consume.pipe(Effect.catchCause(() => Effect.sleep(100)))));
        yield* store.cleanup.pipe(atWorkerStage('initial queue cleanup'));
        let lastCleanup = yield* Clock.currentTimeMillis;
        for (;;) {
          yield* engine.dispatch.pipe(atWorkerStage('work scheduling'));
          const now = yield* Clock.currentTimeMillis;
          if (engine.activeCount() > 0) lastActivity = now;
          if (now - lastCleanup > 60_000) {
            yield* store.cleanup.pipe(atWorkerStage('work scheduling'));
            lastCleanup = now;
          }
          const due = (yield* store.pending.pipe(atWorkerStage('work scheduling'))).some(row => row.not_before <= now);
          if (!due && engine.activeCount() === 0 && now - lastActivity >= (options.idleTimeoutMs ?? 60_000)) {
            // This decision and accepting=false are synchronous: a wake either
            // extends activity before retirement or observes a retiring worker.
            accepting = false;
            return;
          }
          yield* Effect.sleep(50);
        }
      }),
    ),
  );
  const anotherWorkerAccepted = Effect.scoped(
    Effect.gen(function* () {
      for (;;) {
        if (acquired) return yield* Effect.never;
        const target = yield* endpoint(config).pipe(Effect.orElseSucceed(() => undefined));
        if (target && target.pid !== system.processId) {
          const acknowledged = yield* Effect.gen(function* () {
            yield* wake(target, config);
            // A concurrent cold caller may have supplied a different environment.
            // Forward only bindings matching current durable desired identities.
            const store = yield* openCoordinatorStore(config);
            const lists = new Map<string, readonly SourceWorkDescriptor[]>();
            const groups = new Map<string, {config: RuntimeConfig; bindings: CredentialBinding[]}>();
            for (const row of yield* store.pending) {
              const jobConfig = yield* Effect.try({
                try: () => decodeCoordinatorConfig(JSON.parse(row.config_json), paths.home),
                catch: unavailable,
              });
              const descriptor = yield* Effect.try({
                try: () => validatedSourceWorkDescriptor(JSON.parse(row.descriptor_json)),
                catch: unavailable,
              });
              if (!descriptor.credentialEnv) continue;
              const registration = options.registrations.find(value => value.provider === descriptor.provider);
              if (!registration) continue;
              const groupKey = JSON.stringify([jobConfig, descriptor.provider]);
              let listed = lists.get(groupKey);
              if (!listed) {
                listed = yield* registration.list(jobConfig);
                lists.set(groupKey, listed);
              }
              if (
                !listed.some(
                  value =>
                    value.sourceId === descriptor.sourceId &&
                    value.fingerprint === descriptor.fingerprint &&
                    value.accountKey === descriptor.accountKey,
                )
              )
                continue;
              const value = system.environment()[descriptor.credentialEnv];
              const binding = {
                descriptor,
                values: value === undefined || value.length > 4_096 ? {} : {[descriptor.credentialEnv]: value},
              };
              const group = groups.get(groupKey) ?? {config: jobConfig, bindings: []};
              group.bindings.push(binding);
              groups.set(groupKey, group);
            }
            for (const group of groups.values()) yield* handoffBindings(target, group.config, group.bindings, 5_000);
            yield* wake(target, config);
          }).pipe(Effect.scoped, Effect.result);
          if (acknowledged._tag === 'Success' && !acquired) return;
        }
        yield* Effect.sleep(25);
      }
    }),
  );
  return yield* Effect.raceFirst(ownership, anotherWorkerAccepted).pipe(
    Effect.provide(httpContext),
    atWorkerStage('singleton acquisition'),
  );
});
