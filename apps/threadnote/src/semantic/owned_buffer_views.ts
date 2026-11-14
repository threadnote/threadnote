import {
  Array as EffectArray,
  Clock,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Option as EffectOption,
  Path,
  Semaphore,
  String as EffectString,
} from 'effect';
import {SecureRandom} from 'effect/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Observation, observationKey} from '@threadnote/semantic/contracts';
import {
  SemanticAgentBufferHandle,
  type SemanticAgentEndpointView,
  type SemanticReadinessSource,
  semanticAgentBufferLimits,
  semanticReadinessLimits,
} from './agent_query_protocol.js';
import {SemanticLanguage, SemanticSessionFault} from './provider.js';
import {semanticHostSelection} from './host_catalog.js';
import {LspFault} from './lsp_transport.js';
import type {SemanticStartupControl} from './readiness_jobs.js';

interface BufferBinding {
  id: string;
  observation: Observation;
  language: SemanticLanguage;
  environment?: string;
  profile: string;
  bytes: number;
  expiresAt: number;
}
export interface SemanticOwnedViewGrant {
  token: string;
  lastUsed: number;
  gate: Semaphore.Semaphore;
  public?: BufferBinding;
  reserved?: BufferBinding;
  control?: SemanticStartupControl;
  preparing?: Deferred.Deferred<void>;
  retiring?: boolean;
  unknown?: boolean;
}
interface ViewCoordinator<R> {
  readonly attach: (
    observation: Observation,
    text: string,
    language: SemanticLanguage,
    environment?: string,
    control?: SemanticStartupControl,
  ) => Effect.Effect<{observation: Observation}, unknown, R>;
  readonly observe?: (
    observation: Observation,
    milliseconds: number,
  ) => Effect.Effect<Observation | undefined, unknown, R>;
  readonly closeView: (observation: Observation) => Effect.Effect<void, unknown, R>;
}
/** The original public buffer registry also owns pending startup reservations. Pending entries are never query grants. */
export const makeSemanticOwnedBufferViews = Effect.fn('semantic.ownedBufferViews')(function* <R>(
  coordinator: ViewCoordinator<R>,
  options: {readonly worktree: string; readonly runtimeIdentity?: string},
  sessionIdentity: (observation: Observation) => string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* SecureRandom.SecureRandom;
  const observe = coordinator.observe;
  const clock = yield* Clock.Clock;
  const grants = new Map<string, SemanticOwnedViewGrant>();
  const lifecycle = Semaphore.makeUnsafe(1);
  const publicGrant = (handle: typeof SemanticAgentBufferHandle.Type) => {
    const entry = EffectOption.getOrUndefined(
      EffectArray.findFirst([...grants], ([, grant]) => grant.public?.id === handle.id),
    );
    if (!entry) return undefined;
    if (entry[1].token !== handle.capability) throw SemanticSessionFault.make({reason: 'conflict'});
    return entry;
  };
  const checkPublic = Effect.fn('semantic.checkPublicView')(function* (
    handle: typeof SemanticAgentBufferHandle.Type,
    profile?: string,
  ) {
    const found = yield* Effect.try({
      try: () => publicGrant(handle),
      catch: () => SemanticSessionFault.make({reason: 'conflict'}),
    });
    if (!found || !found[1].public) return yield* SemanticSessionFault.make({reason: 'stale'});
    const now = yield* Clock.currentTimeMillis;
    if (
      now >= found[1].public.expiresAt ||
      now < found[1].public.expiresAt - semanticAgentBufferLimits.ttlMilliseconds ||
      (profile !== undefined && found[1].public.profile !== profile)
    )
      return yield* SemanticSessionFault.make({reason: 'stale'});
    return {id: found[0], grant: found[1], binding: found[1].public};
  });
  const agentView = (body: SemanticAgentEndpointView) =>
    body.action === 'open'
      ? Effect.gen(function* () {
          const source = yield* sourceForOpen(body);
          const observation = yield* prepare(source, body.text!);
          return yield* Effect.gen(function* () {
            const result = publish(observation);
            yield* checkPublic(result.handle, body.profile);
            return result;
          }).pipe(
            Effect.onExit(exit =>
              Exit.isFailure(exit)
                ? coordinator
                    .closeView(observation)
                    .pipe(Effect.ensuring(Effect.sync(() => grants.delete(sessionIdentity(observation)))))
                : Effect.void,
            ),
          );
        }).pipe(
          Effect.timeoutOption(body.milliseconds),
          Effect.flatMap(result =>
            result._tag === 'Some' ? Effect.succeed(result.value) : Effect.fail(LspFault.make({code: 'timeout'})),
          ),
        )
      : lifecycle
          .withPermit(
            Effect.gen(function* () {
              if (new TextEncoder().encode(JSON.stringify(body)).length > semanticAgentBufferLimits.maxRequestBytes)
                return yield* LspFault.make({code: 'capacity'});
              if (body.worktree !== options.worktree || !options.runtimeIdentity || !observe)
                return yield* LspFault.make({code: 'rejected'});
              if (new TextEncoder().encode(JSON.stringify(body)).length > semanticAgentBufferLimits.maxRequestBytes)
                return yield* LspFault.make({code: 'capacity'});
              const bytes = new TextEncoder().encode(body.text ?? '').length;
              const publicEntries = EffectArray.filter(
                [...grants.values()],
                grant => grant.public !== undefined || grant.reserved !== undefined,
              );
              const total = EffectArray.reduce(
                publicEntries,
                0,
                (sum, grant) => sum + ((grant.public ?? grant.reserved)?.bytes ?? 0),
              );
              if (
                bytes > semanticAgentBufferLimits.maxTextBytes ||
                (body.text !== undefined &&
                  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body.text))
              )
                return yield* LspFault.make({code: 'capacity'});
              if (
                !body.handle ||
                body.project ||
                body.uri ||
                body.language ||
                body.environment ||
                body.startup ||
                body.principal
              )
                return yield* LspFault.make({code: 'protocol'});
              const owned = yield* checkPublic(body.handle, body.profile);
              return yield* owned.grant.gate.withPermit(
                Effect.gen(function* () {
                  const current = yield* checkPublic(body.handle!, body.profile);
                  if (current.grant !== owned.grant) return yield* SemanticSessionFault.make({reason: 'stale'});
                  if (body.action === 'close') {
                    yield* coordinator.closeView(current.binding.observation);
                    grants.delete(current.id);
                    return {version: 1, status: 'ok', action: 'close'};
                  }
                  const before = current.binding.observation;
                  if (body.expectedVersion !== before.documentVersion)
                    return yield* SemanticSessionFault.make({reason: 'conflict'});
                  if (
                    body.text === undefined ||
                    before.documentVersion === null ||
                    before.documentVersion >= Number.MAX_SAFE_INTEGER
                  )
                    return yield* LspFault.make({code: 'protocol'});
                  if (total - current.binding.bytes + bytes > semanticAgentBufferLimits.maxRetainedBytes)
                    return yield* LspFault.make({code: 'capacity'});
                  const verified = yield* coordinator.observe!(before, body.milliseconds);
                  if (!verified || observationKey(verified) !== observationKey(before))
                    return yield* SemanticSessionFault.make({reason: 'stale'});
                  return yield* Effect.gen(function* () {
                    const attached = yield* coordinator.attach(
                      {...before, content: sha256HexSync(body.text!), documentVersion: before.documentVersion! + 1},
                      body.text!,
                      current.binding.language,
                      current.binding.environment,
                    );
                    current.binding.observation = attached.observation;
                    current.binding.bytes = bytes;
                    yield* checkPublic(body.handle!, body.profile);
                    return {
                      version: 1,
                      status: 'ok',
                      action: 'update',
                      observation: attached.observation,
                      expiresAt: current.binding.expiresAt,
                    };
                  }).pipe(
                    Effect.onExit(exit =>
                      Exit.isFailure(exit)
                        ? coordinator
                            .closeView(current.binding.observation)
                            .pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => grants.delete(current.id))))
                        : Effect.void,
                    ),
                  );
                }),
              );
            }),
          )
          .pipe(
            Effect.timeoutOption(body.milliseconds),
            Effect.flatMap(result =>
              result._tag === 'Some' ? Effect.succeed(result.value) : Effect.fail(LspFault.make({code: 'timeout'})),
            ),
          );

  const sourceForOpen = Effect.fn('semantic.bufferOpenSource')(function* (body: SemanticAgentEndpointView) {
    if (new TextEncoder().encode(JSON.stringify(body)).length > semanticAgentBufferLimits.maxRequestBytes)
      return yield* LspFault.make({code: 'capacity'});
    if (
      body.worktree !== options.worktree ||
      !options.runtimeIdentity ||
      !observe ||
      !body.project ||
      !body.uri ||
      !body.language ||
      body.text === undefined ||
      body.handle ||
      body.expectedVersion !== undefined
    )
      return yield* LspFault.make({code: 'protocol'});
    return {
      worktree: body.worktree,
      project: body.project,
      uri: body.uri,
      language: body.language,
      profile: body.profile,
      principal: body.principal ?? '',
      ...(body.environment ? {environment: body.environment} : {}),
      buffer: {kind: 'buffer' as const, content: sha256HexSync(body.text)},
    };
  });
  const closePending = Effect.fn('semantic.closePendingBuffer')(function* (observation: Observation) {
    const id = sessionIdentity(observation),
      grant = grants.get(id);
    if (!grant?.reserved) return;
    grant.retiring = true;
    if (grant.preparing) {
      const finished = yield* Deferred.await(grant.preparing).pipe(
        Effect.timeoutOption(semanticReadinessLimits.terminationMilliseconds),
      );
      if (finished._tag === 'None') {
        grant.unknown = true;
        grant.control?.cleanup('unknown');
        return yield* LspFault.make({code: 'closing'});
      }
    }
    yield* coordinator.closeView(grant.reserved.observation);
    if (grant.unknown || grant.control?.cleanupUnknown()) return yield* LspFault.make({code: 'closing'});
    if (grants.get(id) === grant && grant.reserved) grants.delete(id);
  });
  const reserve = Effect.fn('semantic.reserveOwnedBuffer')(function* (source: SemanticReadinessSource, text: string) {
    const bytes = new TextEncoder().encode(text).length;
    if (
      source.worktree !== options.worktree ||
      source.buffer?.kind !== 'buffer' ||
      source.buffer.content !== sha256HexSync(text) ||
      bytes > semanticAgentBufferLimits.maxTextBytes ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
    )
      return yield* LspFault.make({code: 'capacity'});
    const {seed} = yield* lifecycle.withPermit(
      Effect.gen(function* () {
        const root = yield* path.fromFileUrl(new URL(options.worktree));
        const project = yield* path.fromFileUrl(new URL(source.project));
        const file = yield* path.fromFileUrl(new URL(source.uri));
        if (
          !(project === root || EffectString.startsWith(root + path.sep)(project)) ||
          !EffectString.startsWith(project + path.sep)(file) ||
          EffectString.split(path.sep)(file).includes('.git') ||
          (yield* fs.realPath(project)) !== project ||
          (yield* fs.realPath(file)) !== file ||
          (yield* fs.stat(file)).type !== 'File'
        )
          return yield* LspFault.make({code: 'rejected'});
        const identity = sha256HexSync(yield* crypto.randomBytes(32));
        const token = sha256HexSync(yield* crypto.randomBytes(32));
        const seed: Observation = {
          version: 1,
          repository: sha256HexSync(options.worktree),
          worktree: options.worktree,
          project: source.project,
          configuration: EffectString.repeat(64)('0'),
          toolchain: EffectString.repeat(64)('0'),
          provider: {id: semanticHostSelection[source.language].provider, version: 'host-unbound', generation: 0},
          view: {kind: 'overlay', id: identity, owner: 'agent-buffer:' + identity, epoch: 0},
          uri: source.uri,
          content: sha256HexSync(text),
          documentVersion: 1,
          projectEpoch: 0,
        };
        const id = sessionIdentity(seed);
        const expiresAt = (yield* Clock.currentTimeMillis) + semanticAgentBufferLimits.ttlMilliseconds;
        const grant: SemanticOwnedViewGrant = {
          token,
          lastUsed: expiresAt - semanticAgentBufferLimits.ttlMilliseconds,
          gate: Semaphore.makeUnsafe(1),
          reserved: {
            id: identity,
            observation: seed,
            language: source.language,
            ...(source.environment ? {environment: source.environment} : {}),
            profile: source.profile,
            bytes,
            expiresAt,
          },
        };
        // Entropy/path/current-time checks yield. Recheck aggregate reservations at insertion.
        const entries = [...grants.values()];
        const count = EffectArray.filter(
          entries,
          entry => entry.public !== undefined || entry.reserved !== undefined,
        ).length;
        const total = EffectArray.reduce(
          entries,
          0,
          (sum, entry) => sum + ((entry.public ?? entry.reserved)?.bytes ?? 0),
        );
        if (
          count >= semanticAgentBufferLimits.maxGrants ||
          grants.size >= 256 ||
          total + bytes > semanticAgentBufferLimits.maxRetainedBytes
        )
          return yield* LspFault.make({code: 'capacity'});
        grants.set(id, grant);
        return {id, grant, seed};
      }),
    );
    return seed;
  });
  const prepare = Effect.fn('semantic.prepareOwnedBuffer')(function* (
    source: SemanticReadinessSource,
    text: string,
    control?: SemanticStartupControl,
    reserved?: Observation,
  ) {
    const seed = reserved ?? (yield* reserve(source, text));
    const id = sessionIdentity(seed),
      grant = grants.get(id);
    const binding = grant?.reserved;
    if (
      !grant ||
      !binding ||
      source.buffer?.content !== sha256HexSync(text) ||
      seed.content !== source.buffer.content ||
      binding.profile !== source.profile ||
      binding.language !== source.language ||
      binding.environment !== source.environment ||
      seed.worktree !== source.worktree ||
      seed.project !== source.project ||
      seed.uri !== source.uri
    )
      return yield* LspFault.make({code: 'rejected'});
    if (grant.retiring || grant.preparing) return yield* LspFault.make({code: 'closing'});
    grant.control = control;
    const finished = yield* Deferred.make<void>();
    grant.preparing = finished;
    return yield* Effect.gen(function* () {
      const attached = yield* coordinator.attach(seed, text, source.language, source.environment, control);
      if (grants.get(id) !== grant || !grant.reserved || grant.retiring)
        return yield* SemanticSessionFault.make({reason: 'stale'});
      grant.reserved.observation = attached.observation;
      return attached.observation;
    }).pipe(
      Effect.onExit(exit =>
        Deferred.succeed(finished, undefined).pipe(
          Effect.andThen(Exit.isFailure(exit) ? closePending(seed) : Effect.void),
        ),
      ),
    );
  });
  // Called synchronously only after the job's fresh currentness and cancellation checks.
  const publish = (observation: Observation) => {
    const grant = grants.get(sessionIdentity(observation));
    const binding = grant?.reserved ?? grant?.public;
    const now = clock.currentTimeMillisUnsafe();
    if (
      !grant ||
      !binding ||
      now >= binding.expiresAt ||
      now < binding.expiresAt - semanticAgentBufferLimits.ttlMilliseconds ||
      grant.retiring ||
      grant.unknown ||
      grant.control?.cleanupUnknown() ||
      observationKey(binding.observation) !== observationKey(observation)
    )
      throw SemanticSessionFault.make({reason: 'stale'});
    grant.public = binding;
    delete grant.reserved;
    return {
      version: 1 as const,
      status: 'ok' as const,
      action: 'open' as const,
      handle: {id: binding.id, capability: grant.token},
      observation: binding.observation,
      expiresAt: binding.expiresAt,
    };
  };

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...grants.values()],
      grant => (grant.reserved ? closePending(grant.reserved.observation).pipe(Effect.ignore) : Effect.void),
      {concurrency: 8},
    ),
  );
  return {grants, checkPublic, request: agentView, sourceForOpen, reserve, prepare, publish, closePending};
});
