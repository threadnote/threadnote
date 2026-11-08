import {Clock, Effect, FileSystem, Option, Path, Schema} from 'effect';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import {SecureRandom} from 'effect/crypto';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {isJsonObject} from '@threadnote/platform/json';
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
/** Probe only. Unknown/EPERM remains occupied; no PID-only signalling or recovery. */
function processGroupPresent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return !isJsonObject(cause) || cause.code !== 'ESRCH';
  }
}
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
  const crypto = yield* SecureRandom.SecureRandom;
  const identity = yield* system.canonicalProcessStartIdentity?.(system.processId) ?? succeedUndefined;
  if (!identity || system.platform === 'win32') return yield* LspFault.make({code: 'prerequisite'});
  const owner: Instance = {pid: system.processId, identity};
  if (!options.readOnly) yield* fs.makeDirectory(options.directory, {recursive: true, mode: 0o700});
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
          if (slot.provider && !(yield* alive(slot.provider)) && !groupPresent(slot.provider.pid)) continue;
          // A crash between reservation and provider registration cannot safely be guessed away.
          retained.push({...slot, quarantined: true});
        }
        ledger.slots = retained;
        const result = yield* f(ledger);
        if (options.readOnly) return result;
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
