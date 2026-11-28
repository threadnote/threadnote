import {Clock, Effect, FileSystem, Option, Path, Schema} from 'effect';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import {SecureRandom} from 'effect/crypto';
import * as Native from '@threadnote/platform/system';
import {withExclusiveFileLock, withExclusiveFileLockLease} from '@threadnote/platform/file/lock';
import {
  SystemInfo,
  runtimeProbeProviderTree,
  runtimeNativePlatformSupport,
  runtimeAssertPrivateProviderPath,
} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Counter, Digest, Identifier} from '@threadnote/semantic/contracts';
import {LspFault} from './lsp_transport.js';
import {readBoundedText} from './fingerprint.js';

export const semanticSessionLimits = Object.freeze({
  queriesPerSession: 4,
  queuedPerSession: 32,
  idleMilliseconds: 600000,
  providersPerHome: 8,
  providersPerWorkspace: 4,
  importsPerHome: 2,
  queued: 32,
  providerLeaderRssBytesPerHome: 2 * 1024 * 1024 * 1024,
});
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
const limits = semanticSessionLimits;
export interface SemanticPressure {
  readonly state: 'normal' | 'pressured' | 'unknown';
  readonly rssBytes: number | null;
  readonly observedProviders: number;
  readonly expectedProviders: number;
  readonly coverage: 'registered-provider-leaders';
  readonly limitBytes: number;
}
export class SemanticCompatibilityFault extends Schema.TaggedError<
  SemanticCompatibilityFault,
  {readonly brand: unique symbol}
>()('SemanticCompatibilityFault', {component: Schema.Literals(['admission', 'bootstrap'])}) {}
export interface SemanticAdmissionOptions {
  /** One stable, private directory in the canonical data home, shared across runtime generations/worktrees. */
  readonly directory: string;
  readonly processGroupPresent?: (pid: number) => boolean;
  /** Inspection may acquire the existing state lock but never creates or rewrites ledger state. */
  readonly readOnly?: boolean;
}
export interface SemanticReservation {
  readonly generation: number;
  readonly bindProvider: (pid: number, identity?: string) => Effect.Effect<void, unknown>;
  readonly finishImport: Effect.Effect<void, unknown>;
  /** A positive group-drain receipt is required; failure conserves/quarantines the reservation. */
  readonly release: (drained: boolean) => Effect.Effect<void, unknown>;
}
/** File-locked FIFO admission is shared by every worktree coordinator, rather than a per-process counter. */
export const makeSemanticAdmission = Effect.fn('semantic.makeAdmission')(function* (options: SemanticAdmissionOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const crypto = yield* SecureRandom.SecureRandom;
  const identity = yield* system.canonicalProcessStartIdentity?.(system.processId) ?? succeedUndefined;
  if (!identity || !runtimeNativePlatformSupport().providerTree) return yield* LspFault.make({code: 'prerequisite'});
  const owner: Instance = {pid: system.processId, identity};
  let privateDirectory: Native.RuntimePrivateWriterDirectory | undefined;
  if (Native.runtimePlatform === 'win32') {
    const own = (operation: () => Native.RuntimePrivateWriterDirectory) =>
      Effect.acquireRelease(Effect.try({try: operation, catch: () => LspFault.make({code: 'prerequisite'})}), value =>
        Effect.sync(() => Native.runtimeClosePrivateWriterDirectory(value)),
      );
    privateDirectory = yield* own(() =>
      options.readOnly
        ? Native.runtimeOpenPrivateWriterDirectory(options.directory)
        : Native.runtimeProvisionPrivateWriterDirectory(options.directory),
    );
  } else if (!options.readOnly) yield* fs.makeDirectory(options.directory, {recursive: true, mode: 0o700});
  const directory = yield* fs.realPath(options.directory);
  if (directory !== path.resolve(options.directory)) return yield* LspFault.make({code: 'prerequisite'});
  yield* Effect.try({
    try: () => runtimeAssertPrivateProviderPath(directory, {kind: 'directory'}),
    catch: () => LspFault.make({code: 'prerequisite'}),
  });
  const ledgerPath = path.join(directory, 'admission-v1.json');
  const providerState = (instance: Instance) => {
    // An injected legacy group probe is a test seam only; production observes persisted
    // identity conservatively. In particular a lost Windows Job is never proved absent.
    if (options.processGroupPresent) return options.processGroupPresent(instance.pid) ? 'present' : 'absent';
    try {
      return runtimeProbeProviderTree(instance);
    } catch {
      return 'unknown';
    }
  };
  const token = () => crypto.randomBytes(32).pipe(Effect.map(bytes => sha256HexSync(bytes)));
  const alive = (instance: Instance) =>
    Effect.gen(function* () {
      if (!system.isProcessRunning(instance.pid)) return false;
      const observed = yield* (system.canonicalProcessStartIdentity?.(instance.pid) ?? succeedUndefined).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      // Missing identity is uncertainty, not proof of death. Different canonical identities prove reuse.
      return observed === undefined || observed === instance.identity;
    });
  const lockPolicy = {
    createParentDirectory: false,
    retryIntervalMilliseconds: 20,
    waitTimeoutMilliseconds: 2000,
    staleAfterMilliseconds: 10000,
    useCanonicalProcessStartIdentity: true,
  } as const;
  const ledgerLock = <A, E, R>(use: (assertNative?: () => void) => Effect.Effect<A, E, R>) => {
    const retained = privateDirectory;
    return retained
      ? withExclusiveFileLockLease(
          fs,
          path.join(directory, 'admission-v1.lock'),
          {
            ...lockPolicy,
            privateDirectory: retained,
            assertParentCurrent: () => Native.runtimeAssertPrivateWriterDirectoryCurrent(retained),
          },
          lease =>
            use(() => {
              Native.runtimeAssertPrivateWriterDirectoryCurrent(retained);
              lease.assertCurrentSync();
            }),
        )
      : withExclusiveFileLock(fs, path.join(directory, 'admission-v1.lock'), lockPolicy, use());
  };
  const transaction = <A, E, R>(f: (ledger: Ledger) => Effect.Effect<A, E, R>) =>
    ledgerLock(assertNative =>
      Effect.gen(function* () {
        let ledger: Ledger = {version: 1, nextGeneration: 0, slots: [], tickets: []};
        if (yield* fs.exists(ledgerPath)) {
          let raw: string;
          if (privateDirectory) {
            const retained = privateDirectory;
            const file = yield* Effect.try({
              try: () => Native.runtimeReadPrivateWriterFile(retained, 'admission-v1.json', 128 * 1024),
              catch: () => LspFault.make({code: 'prerequisite'}),
            });
            if (!file) return yield* LspFault.make({code: 'prerequisite'});
            raw = yield* Effect.try({
              try: () => new TextDecoder('utf-8', {fatal: true}).decode(file.bytes),
              catch: () => LspFault.make({code: 'protocol'}),
            });
          } else {
            const info = yield* fs.stat(ledgerPath);
            if (
              info.type !== 'File' ||
              Number(info.size) > 128 * 1024 ||
              Option.isSome(yield* fs.readLink(ledgerPath).pipe(Effect.option))
            )
              return yield* LspFault.make({code: 'prerequisite'});
            yield* Effect.try({
              try: () => runtimeAssertPrivateProviderPath(ledgerPath, {kind: 'file'}),
              catch: () => LspFault.make({code: 'prerequisite'}),
            });
            raw = yield* readBoundedText(ledgerPath, 128 * 1024);
          }
          const json = yield* Effect.try({try: () => JSON.parse(raw), catch: () => LspFault.make({code: 'protocol'})});
          const decoded = yield* Schema.decodeUnknownEffect(Ledger, {onExcessProperty: 'error'})(json).pipe(
            Effect.mapError(() => SemanticCompatibilityFault.make({component: 'admission'})),
          );
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
          if (slot.provider && providerState(slot.provider) === 'absent') continue;
          // A crash between reservation and provider registration cannot safely be guessed away.
          retained.push({...slot, quarantined: true});
        }
        ledger.slots = retained;
        const result = yield* f(ledger);
        if (options.readOnly) return result;
        if (privateDirectory) {
          const retained = privateDirectory,
            nonce = yield* token();
          const encoded = new TextEncoder().encode(JSON.stringify(ledger));
          if (encoded.length > 128 * 1024 || !assertNative) return yield* LspFault.make({code: 'prerequisite'});
          const published = yield* Effect.try({
            try: () =>
              Native.runtimePublishPrivateWriterFile(retained, 'admission-v1.json', encoded, {
                mode: 'replace',
                nonce,
                assertCurrentSync: assertNative,
              }),
            catch: () => LspFault.make({code: 'prerequisite'}),
          });
          if (published.status !== 'published') return yield* LspFault.make({code: 'prerequisite'});
          return result;
        }
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
      Effect.provideService(SecureRandom.SecureRandom, crypto),
      Effect.provideService(Path.Path, path),
    );
  let pressureSample: {key: string; at: number; value: SemanticPressure} | undefined;
  const pressure = (ledger: Ledger, budgetMilliseconds = 1500) =>
    Effect.gen(function* () {
      const providers = EffectArray.flatMap(ledger.slots, slot => (slot.provider ? [slot.provider] : []));
      const key = JSON.stringify(providers);
      const now = yield* Clock.currentTimeMillis;
      if (pressureSample?.key === key && now >= pressureSample.at && now - pressureSample.at < 1000)
        return pressureSample.value;
      const unavailable: SemanticPressure = {
        state: 'unknown',
        rssBytes: null,
        observedProviders: 0,
        expectedProviders: providers.length,
        coverage: 'registered-provider-leaders',
        limitBytes: limits.providerLeaderRssBytesPerHome,
      };
      if (providers.length === 0) return {...unavailable, state: 'normal' as const, rssBytes: 0};
      if (!system.processResourceCounters || !system.canonicalProcessStartIdentity) return unavailable;
      const observed = yield* Effect.gen(function* () {
        for (const provider of providers)
          if ((yield* system.canonicalProcessStartIdentity!(provider.pid)) !== provider.identity) return unavailable;
        const counters = yield* system.processResourceCounters!(EffectArray.map(providers, provider => provider.pid));
        let rssBytes = 0;
        let observedProviders = 0;
        for (const provider of providers) {
          const row = counters.get(provider.pid);
          if (
            (yield* system.canonicalProcessStartIdentity!(provider.pid)) !== provider.identity ||
            row?.rssBytes === undefined ||
            !Number.isSafeInteger(row.rssBytes) ||
            row.rssBytes < 0
          )
            continue;
          rssBytes += row.rssBytes;
          observedProviders++;
        }
        return observedProviders !== providers.length || !Number.isSafeInteger(rssBytes)
          ? {...unavailable, observedProviders}
          : {
              ...unavailable,
              state: rssBytes >= limits.providerLeaderRssBytesPerHome ? ('pressured' as const) : ('normal' as const),
              rssBytes,
              observedProviders,
            };
      }).pipe(
        Effect.timeoutOption(budgetMilliseconds),
        Effect.map(Option.getOrElse(() => unavailable)),
        Effect.orElseSucceed(() => unavailable),
      );
      pressureSample = {key, at: now, value: observed};
      return observed;
    });
  const status = transaction(ledger =>
    Effect.gen(function* () {
      const resources = yield* pressure(ledger);
      return {
        limits,
        providers: ledger.slots.length,
        imports: EffectArray.filter(ledger.slots, slot => slot.importing).length,
        queued: ledger.tickets.length,
        quarantined: EffectArray.filter(ledger.slots, slot => slot.quarantined).length,
        pressure: structuredClone(resources),
        nextAction: EffectArray.some(ledger.slots, slot => slot.quarantined)
          ? 'Inspect owned process trees; uncertain reservations remain occupied'
          : resources.state === 'pressured'
            ? 'New providers wait for the registered-provider RSS budget; existing work may continue'
            : resources.state === 'unknown'
              ? 'RSS observation is incomplete; count limits remain enforced; inspect host process resources'
              : 'Ready',
      };
    }),
  );
  const acquire = (workspace: string, milliseconds: number) =>
    Effect.gen(function* () {
      if (options.readOnly) return yield* LspFault.make({code: 'prerequisite'});
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
            Effect.gen(function* () {
              if (
                ledger.slots.length >= limits.providersPerHome ||
                EffectArray.filter(ledger.slots, slot => slot.importing).length >= limits.importsPerHome
              )
                return false;
              const remaining = milliseconds - ((yield* Clock.currentTimeMillis) - started);
              if (remaining <= 0 || (yield* pressure(ledger, Math.min(remaining, 500))).state === 'pressured')
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
        bindProvider: (pid: number, creationIdentity?: string) =>
          Effect.gen(function* () {
            const identity =
              creationIdentity ?? (yield* system.canonicalProcessStartIdentity?.(pid) ?? succeedUndefined);
            if (!Schema.is(Identifier)(identity) || !Number.isSafeInteger(pid) || pid <= 0)
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

/** Endpoint bootstrap shares the native private-home contract; existing unsafe objects are never repaired. */
export const prepareSemanticEndpointDirectory = Effect.fn('semantic.prepareEndpointDirectory')(function* (
  directory: string,
  create = true,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  if (path.resolve(directory) !== directory) return yield* LspFault.make({code: 'prerequisite'});
  if (Native.runtimePlatform !== 'win32') {
    if (create) yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    if ((yield* fs.realPath(directory)) !== directory || (yield* fs.stat(directory)).mode & 0o077)
      return yield* LspFault.make({code: 'prerequisite'});
    return undefined;
  }
  const own = (operation: () => Native.RuntimePrivateWriterDirectory) =>
    Effect.acquireRelease(Effect.try({try: operation, catch: () => LspFault.make({code: 'prerequisite'})}), value =>
      Effect.sync(() => Native.runtimeClosePrivateWriterDirectory(value)),
    );
  return yield* own(() =>
    create
      ? Native.runtimeProvisionPrivateWriterDirectory(directory)
      : Native.runtimeOpenPrivateWriterDirectory(directory),
  );
});

/** The startup and worker leases retain the very directory opened before bootstrap use. */
export const withSemanticEndpointLock = <A, E, R>(
  directory: string,
  retained: Native.RuntimePrivateWriterDirectory | undefined,
  name: 'startup.lock' | 'worker.lock',
  waitTimeoutMilliseconds: number,
  use: (assertCurrentSync: () => void) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const policy = {
      createParentDirectory: false,
      retryIntervalMilliseconds: 25,
      waitTimeoutMilliseconds,
      staleAfterMilliseconds: 60000,
      useCanonicalProcessStartIdentity: true,
    } as const;
    return yield* retained
      ? withExclusiveFileLockLease(
          fs,
          path.join(directory, name),
          {
            ...policy,
            privateDirectory: retained,
            assertParentCurrent: () => Native.runtimeAssertPrivateWriterDirectoryCurrent(retained),
          },
          lease =>
            use(() => {
              Native.runtimeAssertPrivateWriterDirectoryCurrent(retained);
              lease.assertCurrentSync();
            }),
        )
      : withExclusiveFileLock(
          fs,
          path.join(directory, name),
          policy,
          use(() => {}),
        );
  });

export const readSemanticEndpointBootstrap = Effect.fn('semantic.readEndpointBootstrap')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  if (Native.runtimePlatform === 'win32')
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* prepareSemanticEndpointDirectory(path.dirname(file), false);
        if (!directory) return yield* LspFault.make({code: 'prerequisite'});
        return yield* Effect.try({
          try: () => {
            const entry = Native.runtimeReadPrivateWriterFile(directory, path.basename(file), 16 * 1024);
            if (!entry) throw LspFault.make({code: 'prerequisite'});
            return new TextDecoder('utf-8', {fatal: true}).decode(entry.bytes);
          },
          catch: () => LspFault.make({code: 'prerequisite'}),
        });
      }),
    );
  if (
    (yield* fs.realPath(path.dirname(file))) !== path.dirname(file) ||
    Option.isSome(yield* fs.readLink(file).pipe(Effect.option))
  )
    return yield* LspFault.make({code: 'prerequisite'});
  const info = yield* fs.stat(file);
  if (info.type !== 'File' || info.mode & 0o077 || Number(info.size) > 16 * 1024)
    return yield* LspFault.make({code: 'prerequisite'});
  return yield* readBoundedText(file, 16 * 1024);
});

export const publishSemanticEndpointBootstrap = Effect.fn('semantic.publishEndpointBootstrap')(function* (
  directory: string,
  retained: Native.RuntimePrivateWriterDirectory | undefined,
  serialized: string,
  assertCurrentSync: () => void,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  if (!retained)
    return yield* fs.writeFileString(path.join(directory, 'host.json'), serialized, {flag: 'wx', mode: 0o600});
  yield* Effect.try({
    try: () => {
      const outcome = Native.runtimePublishPrivateWriterFile(
        retained,
        'host.json',
        new TextEncoder().encode(serialized),
        {
          mode: 'exclusive',
          nonce: sha256HexSync(serialized),
          assertCurrentSync,
        },
      );
      if (outcome.status !== 'published') throw LspFault.make({code: 'prerequisite'});
    },
    catch: () => LspFault.make({code: 'prerequisite'}),
  });
});
