import {
  Array as EffectArray,
  Option,
  Record as EffectRecord,
  String as EffectString,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Path,
  Schema,
} from 'effect';
import {SecureRandom} from 'effect/crypto';
import {isWindowsResourceIdentity} from './source_evidence.js';
import {sha256Hex} from '@threadnote/platform/digest';
import {
  runtimeReadStableOsUserIdentity,
  runtimeOpenPrivateWriterAuthority,
  runtimeClosePrivateWriterDirectory,
  runtimeAssertPrivateWriterDirectoryCurrent,
  runtimeReadPrivateWriterFile,
  runtimePublishPrivateWriterFile,
  runtimeReadWriterProcessIdentity,
  SystemInfo,
  runtimePlatform,
  type RuntimePrivateWriterDirectory,
} from '@threadnote/platform/system';
import {withExclusiveFileLockLease, type ExclusiveFileLockLease} from '@threadnote/platform/file/lock';
import {restoreApplyJournal, type ApplyJournal} from '@threadnote/semantic/journal';
import {canonicalFileUri} from '@threadnote/semantic/contracts';

export class WriterAuthorityFault extends Schema.TaggedError<WriterAuthorityFault, {readonly brand: unique symbol}>()(
  'WriterAuthorityFault',
  {
    reason: Schema.Literals([
      'unavailable',
      'incompatible',
      'ownership',
      'identity',
      'capacity',
      'lock-order',
      'journal',
    ]),
  },
) {}
const unavailable = (reason: WriterAuthorityFault['reason']): never => {
  throw WriterAuthorityFault.make({reason});
};
const attempt = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: error =>
      Schema.is(WriterAuthorityFault)(error) ? error : WriterAuthorityFault.make({reason: 'unavailable'}),
  });
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const counter = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const WriterSessionWitness = Schema.Struct({
  processId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  processStartIdentity: text,
  boot: digest,
  runtimeIdentity: text,
});
export type WriterSessionWitness = typeof WriterSessionWitness.Type;
export interface WriterResourceInput {
  readonly canonicalUri: string;
  readonly physicalIdentity: string;
  readonly nativeIdentity?: string;
}
export const WriterResourceClaim = Schema.Struct({canonicalUri: text, authority: text, fence: counter, owner: text});
export type WriterResourceClaim = typeof WriterResourceClaim.Type;
export const WriterOperationRef = Schema.Struct({
  operation: digest,
  journalName: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,179}$/u)),
  resources: Schema.Array(text).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  authority: text,
  fence: counter,
});
export type WriterOperationRef = typeof WriterOperationRef.Type;
const Resource = Schema.Struct({
  claim: WriterResourceClaim,
  physicalIdentity: text,
  nativeIdentity: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8 * 1024 * 1024))),
  session: WriterSessionWitness,
  nativeStart: text,
  revoked: Schema.Boolean,
  available: Schema.Boolean,
  blocks: Schema.Array(digest).check(Schema.isMaxLength(1000)),
});
const Registry = Schema.Struct({
  version: Schema.Literals([1, 2]),
  protocol: Schema.Literals(['threadnote-writer-v1', 'threadnote-writer-windows-v2']),
  authority: text,
  revision: counter,
  resources: Schema.Array(Resource).check(Schema.isMaxLength(1000)),
  operations: Schema.Array(WriterOperationRef).check(Schema.isMaxLength(1000)),
});
type Registry = typeof Registry.Type;
const matchesOperation = (journal: ApplyJournal, ref: WriterOperationRef) =>
  journal.plan.binding.operation === ref.operation &&
  journal.plan.targets.length === ref.resources.length &&
  EffectArray.every(journal.plan.targets, target => ref.resources.includes(target.before.observation.uri));
function immutable<A>(value: A): A {
  if (value !== null && typeof value === 'object') {
    for (const child of EffectRecord.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const maintenanceBrand: unique symbol = Symbol('writer-maintenance');
export interface WriterMaintenanceScope {
  readonly [maintenanceBrand]: true;
}
export interface WriterReconciliationAcknowledgement {
  readonly operation: string;
  readonly journalRevision: number;
  readonly journalDigest: string;
}
interface GateScope {
  readonly authority: object;
  readonly operation: string;
  readonly operationLease?: ExclusiveFileLockLease;
  readonly mutationLease?: ExclusiveFileLockLease;
  readonly admission?: boolean;
  readonly maintenance?: WriterMaintenanceScope;
  readonly allowedOperations?: readonly string[];
  readonly claim?: WriterResourceClaim;
  blockedResources?: ReadonlySet<string>;
  active: boolean;
}
const Gate = Context.Reference<GateScope | undefined>('threadnote/semantic/writer-authority/gate', {
  defaultValue: () => undefined,
});
export interface SemanticWriterAuthority {
  readonly directory: RuntimePrivateWriterDirectory;
  readonly withOperation: <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, unknown, R>;
  readonly withAdmission: <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, unknown, R>;
  readonly withTarget: <A, E, R>(
    claim: WriterResourceClaim,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, unknown, R>;
  readonly assertOperation: (operation: string) => Effect.Effect<void, unknown>;
  readonly assertOperationSync: (operation: string) => void;
  readonly assertTarget: (claim: WriterResourceClaim) => Effect.Effect<void, unknown>;
  readonly assertTargetSync: (claim: WriterResourceClaim) => void;
  readonly enrollResources: (
    session: WriterSessionWitness,
    resources: readonly WriterResourceInput[],
    operation: string,
  ) => Effect.Effect<readonly WriterResourceClaim[], unknown>;
  readonly registerOperation: (ref: WriterOperationRef) => Effect.Effect<void, unknown>;
  readonly listOperations: Effect.Effect<readonly WriterOperationRef[], unknown>;
  readonly observeResource: (
    canonicalUri: string,
  ) => Effect.Effect<
    {readonly claim: WriterResourceClaim; readonly revoked: boolean; readonly blocked: boolean} | undefined,
    unknown
  >;
  readonly retireOperation: (
    operation: string,
    tombstone: {readonly tombstoneName: string; readonly tombstoneDigest: string},
    claims: readonly WriterResourceClaim[],
  ) => Effect.Effect<void, unknown>;
  readonly revokeResources: (claims: readonly WriterResourceClaim[]) => Effect.Effect<void, unknown>;
  readonly withHandover: <R>(
    resources: readonly string[],
    reconcile: (
      scope: WriterMaintenanceScope,
      refs: readonly WriterOperationRef[],
    ) => Effect.Effect<readonly WriterReconciliationAcknowledgement[], unknown, R>,
  ) => Effect.Effect<void, unknown, R>;
  readonly borrowMaintenanceOperation: <A, E, R>(
    scope: WriterMaintenanceScope,
    operation: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, unknown, R>;
  readonly close: () => void;
}

type Needs = FileSystem.FileSystem | Path.Path | SystemInfo | SecureRandom.SecureRandom;
/** Production rendezvous is derived exclusively from the native OS account, never configured HOME. */
export const makeSemanticWriterAuthority = Effect.gen(function* () {
  const directory = yield* attempt(() => runtimeOpenPrivateWriterAuthority(runtimeReadStableOsUserIdentity()));
  return yield* makeSemanticWriterAuthorityFromDirectory(directory).pipe(
    Effect.onError(() => Effect.sync(() => runtimeClosePrivateWriterDirectory(directory))),
  );
});

/** Trusted dependency injection: the same native private-directory guards are used by owning tests. */
export const makeSemanticWriterAuthorityFromDirectory = (directory: RuntimePrivateWriterDirectory) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const random = yield* SecureRandom.SecureRandom;
    const dependencies = yield* Effect.context<Needs>();
    const ownStart = system.canonicalProcessStartIdentity
      ? yield* system.canonicalProcessStartIdentity(system.processId)
      : undefined;
    if (!ownStart) return yield* WriterAuthorityFault.make({reason: 'unavailable'});
    const identity = {};
    const currentScope = () => {
      const fiber = Fiber.getCurrent();
      return fiber ? Context.getUnsafe(fiber.context, Gate) : undefined;
    };
    const policy = {
      createParentDirectory: false,
      allowUnverifiedStaleRecovery: false,
      useCanonicalProcessStartIdentity: true,
      recoverReusedProcessIdImmediately: true,
      staleAfterMilliseconds: 30_000,
      heartbeatIntervalMilliseconds: 1_000,
      retryIntervalMilliseconds: 20,
      waitTimeoutMilliseconds: 2_000,
      assertParentCurrent: () => runtimeAssertPrivateWriterDirectoryCurrent(directory),
      privateDirectory: directory,
    } as const;
    const read = (): Registry | undefined => {
      const file = runtimeReadPrivateWriterFile(directory, 'authority.json', 16 * 1024 * 1024);
      if (!file) return undefined;
      try {
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(file.bytes));
        const value = Schema.decodeUnknownSync(Registry, {onExcessProperty: 'error'})(raw);
        if (
          runtimePlatform === 'win32'
            ? value.version !== 2 ||
              value.protocol !== 'threadnote-writer-windows-v2' ||
              EffectArray.some(value.resources, resource => !isWindowsResourceIdentity(resource.nativeIdentity ?? ''))
            : value.version !== 1 ||
              value.protocol !== 'threadnote-writer-v1' ||
              EffectArray.some(value.resources, resource => resource.nativeIdentity !== undefined)
        )
          unavailable('incompatible');
        if (
          new Set(EffectArray.map(value.resources, resource => resource.claim.canonicalUri)).size !==
            value.resources.length ||
          new Set(EffectArray.map(value.operations, operation => operation.operation)).size !==
            value.operations.length ||
          EffectArray.some(value.resources, resource => resource.claim.authority !== value.authority) ||
          EffectArray.some(value.operations, operation => operation.authority !== value.authority)
        )
          unavailable('identity');
        return immutable(value);
      } catch {
        return unavailable('incompatible');
      }
    };
    const scopeSync = (operation?: string, mutation = false): GateScope => {
      const scope = currentScope();
      if (
        !scope?.active ||
        scope.authority !== identity ||
        !scope.operationLease ||
        (operation !== undefined && operation !== scope.operation) ||
        (mutation && !scope.mutationLease)
      )
        return unavailable('lock-order');
      scope.operationLease.assertCurrentSync();
      scope.mutationLease?.assertCurrentSync();
      runtimeAssertPrivateWriterDirectoryCurrent(directory);
      return scope;
    };
    const publish = (registry: Registry, mutation = true) =>
      Effect.gen(function* () {
        const nonce = EffectString.replaceAll('-', '')(yield* random.uuidV4());
        yield* attempt(() => {
          const scope = currentScope();
          const assertion = () => {
            if (scope?.operationLease) scopeSync(undefined, mutation);
            else {
              if (!scope?.active || scope.authority !== identity || !scope.mutationLease)
                return unavailable('lock-order');
              scope.mutationLease.assertCurrentSync();
            }
          };
          const prior = read();
          if (prior && registry.revision !== prior.revision + 1) unavailable('identity');
          const checked = Schema.decodeSync(Registry, {onExcessProperty: 'error'})(registry);
          const result = runtimePublishPrivateWriterFile(
            directory,
            'authority.json',
            new TextEncoder().encode(JSON.stringify(checked)),
            {
              mode: prior ? 'replace' : 'exclusive',
              nonce,
              assertCurrentSync: assertion,
            },
          );
          if (result.status !== 'published') unavailable('unavailable');
        });
      });
    const inScope = <A, E, R>(scope: GateScope, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(Gate, scope),
        Effect.ensuring(
          Effect.sync(() => {
            scope.active = false;
          }),
        ),
      );
    const withMutation = <A, E, R>(scope: GateScope, effect: Effect.Effect<A, E, R>) =>
      withExclusiveFileLockLease(fs, path.join(directory.path, 'mutation.lock'), policy, lease =>
        inScope({...scope, mutationLease: lease, active: true}, effect),
      ).pipe(Effect.provide(dependencies));
    const withOperation = <A, E, R>(operation: string, admission: boolean, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        if (yield* Gate) return yield* WriterAuthorityFault.make({reason: 'lock-order'});
        return yield* withExclusiveFileLockLease(fs, path.join(directory.path, 'operation.lock'), policy, lease => {
          const scope: GateScope = {authority: identity, operation, operationLease: lease, admission, active: true};
          const checked = Effect.gen(function* () {
            if (!admission) {
              const registry = yield* attempt(() => read() ?? unavailable('incompatible'));
              const selected = Option.getOrUndefined(
                EffectArray.findFirst(registry.operations, ref => ref.operation === operation),
              );
              if (!selected) return yield* WriterAuthorityFault.make({reason: 'identity'});
              // O excludes every other journal writer; this overlap proof remains valid for the entire operation.
              const blocked = yield* attempt(() => {
                const blocked = new Set<string>();
                for (const ref of registry.operations) {
                  if (ref.operation === operation) continue;
                  const overlap = EffectArray.filter(ref.resources, uri => selected.resources.includes(uri));
                  if (!overlap.length) continue;
                  try {
                    const file = runtimeReadPrivateWriterFile(directory, ref.journalName, 16 * 1024 * 1024);
                    if (!file) {
                      for (const uri of overlap) blocked.add(uri);
                      continue;
                    }
                    const journal = restoreApplyJournal(JSON.parse(new TextDecoder().decode(file.bytes)));
                    if (!matchesOperation(journal, ref)) {
                      for (const uri of overlap) blocked.add(uri);
                      continue;
                    }
                    for (const [index, result] of journal.results.entries())
                      if (result.state === 'intent' || result.state === 'unknown')
                        blocked.add(journal.plan.targets[index].before.observation.uri);
                  } catch {
                    for (const uri of overlap) blocked.add(uri);
                  }
                }
                return blocked;
              });
              scope.blockedResources = blocked;
            }
            return yield* effect;
          });
          return inScope(scope, admission ? withMutation(scope, checked) : checked);
        }).pipe(Effect.provide(dependencies));
      });
    const assertTargetSync = (claim: WriterResourceClaim) => {
      const scope = scopeSync(undefined, true);
      if (scope.maintenance || scope.blockedResources?.has(claim.canonicalUri)) return unavailable('ownership');
      if (scope.claim && JSON.stringify(scope.claim) !== JSON.stringify(claim)) unavailable('ownership');
      const resource = Option.getOrUndefined(
        EffectArray.findFirst(read()?.resources ?? [], resource => resource.claim.canonicalUri === claim.canonicalUri),
      );
      if (
        !resource ||
        resource.revoked ||
        resource.blocks.length ||
        JSON.stringify(resource.claim) !== JSON.stringify(claim) ||
        runtimeReadWriterProcessIdentity(resource.session.processId) !== resource.nativeStart
      )
        unavailable('ownership');
    };
    const assertOperationSync = (operation: string) => {
      scopeSync(operation);
    };
    const checkSession = (session: WriterSessionWitness) =>
      Effect.gen(function* () {
        const current = system.canonicalProcessStartIdentity
          ? yield* system.canonicalProcessStartIdentity(session.processId)
          : undefined;
        if (!current || current !== session.processStartIdentity)
          return yield* WriterAuthorityFault.make({reason: 'ownership'});
        return yield* attempt(() => runtimeReadWriterProcessIdentity(session.processId));
      });
    const listOperations = attempt(() => {
      scopeSync();
      return structuredClone(read()?.operations ?? []);
    });
    const authority: SemanticWriterAuthority = {
      directory,
      withOperation: (operation, effect) => withOperation(operation, false, effect),
      withAdmission: (operation, effect) => withOperation(operation, true, effect),
      assertOperationSync,
      assertOperation: operation => attempt(() => assertOperationSync(operation)),
      assertTargetSync,
      assertTarget: claim => attempt(() => assertTargetSync(claim)),
      withTarget: (claim, effect) =>
        Effect.gen(function* () {
          const scope = yield* Gate;
          if (!scope?.active || scope.authority !== identity || !scope.operationLease || scope.mutationLease)
            return yield* WriterAuthorityFault.make({reason: 'lock-order'});
          const resource = yield* attempt(() =>
            Option.getOrUndefined(
              EffectArray.findFirst(read()?.resources ?? [], value => value.claim.canonicalUri === claim.canonicalUri),
            ),
          );
          if (!resource) return yield* WriterAuthorityFault.make({reason: 'ownership'});
          yield* checkSession(resource.session);
          return yield* withMutation(
            {...scope, claim},
            attempt(() => assertTargetSync(claim)).pipe(Effect.andThen(effect)),
          );
        }),
      enrollResources: (session, resources, operation) =>
        Effect.gen(function* () {
          const verified = yield* attempt(() =>
            Schema.decodeSync(WriterSessionWitness, {onExcessProperty: 'error'})(session),
          );
          const nativeStart = yield* checkSession(verified);
          const registry = yield* attempt(() => {
            const scope = scopeSync(operation, true);
            if (!scope.admission) unavailable('lock-order');
            if (
              !resources.length ||
              resources.length > 1000 ||
              new Set(EffectArray.map(resources, value => value.canonicalUri)).size !== resources.length
            )
              unavailable('capacity');
            const current = read();
            if (!current) return unavailable('incompatible');
            return current;
          });
          const next = [...registry.resources];
          const claims: WriterResourceClaim[] = [];
          for (const resource of resources) {
            yield* attempt(() => {
              if (canonicalFileUri(resource.canonicalUri) !== resource.canonicalUri) unavailable('identity');
              if (
                runtimePlatform === 'win32'
                  ? !isWindowsResourceIdentity(resource.nativeIdentity ?? '')
                  : resource.nativeIdentity !== undefined
              )
                unavailable('identity');
              const physical: unknown = JSON.parse(resource.physicalIdentity);
              if (
                !EffectArray.isArray(physical) ||
                physical.length !== 2 ||
                !EffectArray.every(physical, value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) ||
                physical[1] === '0' ||
                JSON.stringify(physical) !== resource.physicalIdentity
              )
                unavailable('identity');
            });
            if (EffectArray.some(registry.operations, ref => ref.resources.includes(resource.canonicalUri))) {
              for (const ref of EffectArray.filter(registry.operations, ref =>
                ref.resources.includes(resource.canonicalUri),
              )) {
                const file = yield* attempt(() =>
                  runtimeReadPrivateWriterFile(directory, ref.journalName, 16 * 1024 * 1024),
                );
                if (!file) return yield* WriterAuthorityFault.make({reason: 'journal'});
                const journal = yield* attempt(() =>
                  restoreApplyJournal(JSON.parse(new TextDecoder().decode(file.bytes))),
                );
                if (!matchesOperation(journal, ref)) return yield* WriterAuthorityFault.make({reason: 'journal'});
                if (EffectArray.some(journal.results, value => value.state === 'intent' || value.state === 'unknown'))
                  return yield* WriterAuthorityFault.make({reason: 'journal'});
              }
            }
            if (
              EffectArray.some(
                next,
                value =>
                  (runtimePlatform === 'win32'
                    ? value.nativeIdentity === resource.nativeIdentity
                    : value.physicalIdentity === resource.physicalIdentity) &&
                  value.claim.canonicalUri !== resource.canonicalUri,
              )
            )
              return yield* WriterAuthorityFault.make({reason: 'identity'});
            const index = Option.getOrElse(
              EffectArray.findFirstIndex(next, value => value.claim.canonicalUri === resource.canonicalUri),
              () => -1,
            );
            const previous = next[index];
            if (
              previous &&
              !previous.available &&
              (previous.revoked ||
                previous.blocks.length ||
                JSON.stringify(previous.session) !== JSON.stringify(verified) ||
                previous.nativeStart !== nativeStart ||
                (runtimePlatform === 'win32' && previous.nativeIdentity !== resource.nativeIdentity))
            )
              return yield* WriterAuthorityFault.make({reason: 'ownership'});
            const claim: WriterResourceClaim = {
              canonicalUri: resource.canonicalUri,
              authority: registry.authority,
              fence: previous?.claim.fence ?? 0,
              owner: verified.boot,
            };
            const entry = {
              claim,
              physicalIdentity: resource.physicalIdentity,
              ...(runtimePlatform === 'win32' ? {nativeIdentity: resource.nativeIdentity} : {}),
              session: verified,
              nativeStart,
              revoked: false,
              available: false,
              blocks: [],
            };
            if (index < 0) next.push(entry);
            else next[index] = entry;
            claims.push(claim);
          }
          yield* publish({...registry, revision: registry.revision + 1, resources: next});
          return claims;
        }),
      registerOperation: ref =>
        Effect.gen(function* () {
          const checked = yield* attempt(() => Schema.decodeSync(WriterOperationRef, {onExcessProperty: 'error'})(ref));
          const registry = yield* attempt(() => {
            scopeSync(checked.operation, true);
            return read() ?? unavailable('incompatible');
          });
          const previous = Option.getOrUndefined(
            EffectArray.findFirst(registry.operations, value => value.operation === ref.operation),
          );
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(checked))
              return yield* WriterAuthorityFault.make({reason: 'identity'});
            return;
          }
          if (
            registry.operations.length >= 1000 ||
            ref.authority !== registry.authority ||
            new Set(ref.resources).size !== ref.resources.length ||
            EffectArray.some(
              ref.resources,
              uri => !EffectArray.some(registry.resources, value => value.claim.canonicalUri === uri),
            )
          )
            return yield* WriterAuthorityFault.make({reason: 'capacity'});
          yield* publish({...registry, revision: registry.revision + 1, operations: [...registry.operations, checked]});
        }),
      listOperations,
      observeResource: canonicalUri =>
        attempt(() => {
          scopeSync();
          const resource = Option.getOrUndefined(
            EffectArray.findFirst(read()?.resources ?? [], value => value.claim.canonicalUri === canonicalUri),
          );
          return resource
            ? {claim: structuredClone(resource.claim), revoked: resource.revoked, blocked: resource.blocks.length > 0}
            : undefined;
        }),
      retireOperation: (operation, tombstone, claims) =>
        Effect.gen(function* () {
          yield* attempt(() => {
            const scope = scopeSync(operation, true);
            if (!scope.admission) unavailable('lock-order');
          });
          const registry = yield* attempt(() => read() ?? unavailable('incompatible'));
          const file = yield* attempt(() =>
            runtimeReadPrivateWriterFile(directory, tombstone.tombstoneName, 16 * 1024 * 1024),
          );
          if (!file || (yield* sha256Hex(new TextDecoder().decode(file.bytes))) !== tombstone.tombstoneDigest)
            return yield* WriterAuthorityFault.make({reason: 'journal'});
          const record = yield* attempt(() =>
            Schema.decodeUnknownSync(
              Schema.Struct({
                version: Schema.Literals([1, 2]),
                nativeProofDigest: Schema.optionalKey(digest),
                operation: digest,
                kind: Schema.Literals(['terminal', 'discarded']),
                claims: Schema.Array(WriterResourceClaim).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
                journalDigest: Schema.NullOr(digest),
                journalRevision: Schema.NullOr(counter),
              }),
            )(JSON.parse(new TextDecoder().decode(file.bytes))),
          );
          if (
            (runtimePlatform === 'win32') !== (record.version === 2) ||
            (record.version === 2 ? !record.nativeProofDigest : record.nativeProofDigest !== undefined) ||
            record.operation !== operation ||
            JSON.stringify(record.claims) !== JSON.stringify(claims)
          )
            return yield* WriterAuthorityFault.make({reason: 'identity'});
          const ref = Option.getOrUndefined(
            EffectArray.findFirst(registry.operations, value => value.operation === operation),
          );
          if (!ref) return; // A retired ID remains non-admitted; retry cannot touch newer owners.
          if (
            new Set(EffectArray.map(claims, claim => claim.canonicalUri)).size !== ref.resources.length ||
            EffectArray.some(ref.resources, uri => !EffectArray.some(claims, claim => claim.canonicalUri === uri))
          )
            return yield* WriterAuthorityFault.make({reason: 'identity'});
          if (record.kind === 'terminal') {
            const journalFile = yield* attempt(() =>
              runtimeReadPrivateWriterFile(directory, ref.journalName, 16 * 1024 * 1024),
            );
            if (
              !journalFile ||
              (yield* sha256Hex(new TextDecoder().decode(journalFile.bytes))) !== record.journalDigest
            )
              return yield* WriterAuthorityFault.make({reason: 'journal'});
            const journal = yield* attempt(() =>
              restoreApplyJournal(JSON.parse(new TextDecoder().decode(journalFile.bytes))),
            );
            if (
              journal.plan.binding.operation !== operation ||
              journal.revision !== record.journalRevision ||
              EffectArray.some(journal.results, result => result.state === 'intent' || result.state === 'unknown')
            )
              return yield* WriterAuthorityFault.make({reason: 'journal'});
          }
          yield* publish({
            ...registry,
            revision: registry.revision + 1,
            operations: EffectArray.filter(registry.operations, value => value.operation !== operation),
            resources: EffectArray.map(registry.resources, value => {
              if (!EffectArray.some(claims, claim => JSON.stringify(claim) === JSON.stringify(value.claim)))
                return value;
              if (value.claim.fence >= Number.MAX_SAFE_INTEGER) return unavailable('capacity');
              return {
                ...value,
                claim: {...value.claim, fence: value.claim.fence + 1},
                revoked: true,
                available: true,
                blocks: [],
              };
            }),
          });
        }),
      revokeResources: claims =>
        Effect.gen(function* () {
          if (yield* Gate) return yield* WriterAuthorityFault.make({reason: 'lock-order'});
          return yield* withExclusiveFileLockLease(fs, path.join(directory.path, 'mutation.lock'), policy, lease =>
            inScope(
              {authority: identity, operation: '', mutationLease: lease, active: true},
              Effect.gen(function* () {
                const registry = yield* attempt(() => read() ?? unavailable('incompatible'));
                for (const claim of claims)
                  if (
                    !EffectArray.some(
                      registry.resources,
                      value => JSON.stringify(value.claim) === JSON.stringify(claim),
                    )
                  )
                    return yield* WriterAuthorityFault.make({reason: 'ownership'});
                yield* publish({
                  ...registry,
                  revision: registry.revision + 1,
                  resources: EffectArray.map(registry.resources, value =>
                    EffectArray.some(claims, claim => claim.canonicalUri === value.claim.canonicalUri)
                      ? {...value, revoked: true, available: false}
                      : value,
                  ),
                });
              }),
            ),
          ).pipe(Effect.provide(dependencies));
        }),
      withHandover: (resources, reconcile) =>
        withOperation(
          'handover',
          true,
          Effect.gen(function* () {
            const registry = yield* attempt(() => read() ?? unavailable('incompatible'));
            const refs = EffectArray.filter(registry.operations, ref =>
              EffectArray.some(ref.resources, uri => resources.includes(uri)),
            );
            const scope: WriterMaintenanceScope = Object.freeze({[maintenanceBrand]: true as const});
            const current = yield* Gate;
            if (!current) return yield* WriterAuthorityFault.make({reason: 'lock-order'});
            const acknowledgements = yield* inScope(
              {
                ...current,
                maintenance: scope,
                allowedOperations: EffectArray.map(refs, ref => ref.operation),
                active: true,
              },
              reconcile(scope, refs),
            );
            if (
              acknowledgements.length !== refs.length ||
              new Set(EffectArray.map(acknowledgements, value => value.operation)).size !== refs.length
            )
              return yield* WriterAuthorityFault.make({reason: 'journal'});
            const blocks = new Set<string>();
            for (const ref of refs) {
              const ack = Option.getOrUndefined(
                EffectArray.findFirst(acknowledgements, value => value.operation === ref.operation),
              );
              const file = yield* attempt(() =>
                runtimeReadPrivateWriterFile(directory, ref.journalName, 16 * 1024 * 1024),
              );
              if (!ack || !file || ack.journalDigest !== (yield* sha256Hex(new TextDecoder().decode(file.bytes))))
                return yield* WriterAuthorityFault.make({reason: 'journal'});
              const journal = yield* attempt(() =>
                restoreApplyJournal(JSON.parse(new TextDecoder().decode(file.bytes))),
              );
              if (journal.plan.binding.operation !== ref.operation || journal.revision !== ack.journalRevision)
                return yield* WriterAuthorityFault.make({reason: 'journal'});
              EffectArray.forEach(journal.results, (value, index) => {
                if (value.state === 'intent' || value.state === 'unknown')
                  blocks.add(journal.plan.targets[index].before.observation.uri);
              });
            }
            const currentRegistry = yield* attempt(() => read() ?? unavailable('incompatible'));
            if (currentRegistry.revision !== registry.revision)
              return yield* WriterAuthorityFault.make({reason: 'identity'});
            yield* publish({
              ...registry,
              revision: registry.revision + 1,
              resources: EffectArray.map(registry.resources, value => {
                if (!resources.includes(value.claim.canonicalUri)) return value;
                if (value.claim.fence >= Number.MAX_SAFE_INTEGER) return unavailable('capacity');
                return {
                  ...value,
                  claim: {...value.claim, fence: value.claim.fence + 1},
                  revoked: true,
                  available: !blocks.has(value.claim.canonicalUri),
                  blocks: blocks.has(value.claim.canonicalUri) ? EffectArray.map(refs, ref => ref.operation) : [],
                };
              }),
            });
          }),
        ),
      borrowMaintenanceOperation: (scope, operation, effect) =>
        Effect.gen(function* () {
          const current = yield* Gate;
          if (
            !current?.active ||
            current.authority !== identity ||
            current.maintenance !== scope ||
            !current.allowedOperations?.includes(operation)
          )
            return yield* WriterAuthorityFault.make({reason: 'lock-order'});
          return yield* inScope({...current, operation, active: true}, effect);
        }),
      close: () => runtimeClosePrivateWriterDirectory(directory),
    };
    yield* authority.withAdmission(
      'initialize',
      Effect.gen(function* () {
        const current = yield* attempt(read);
        if (current) return;
        const names = yield* fs.readDirectory(directory.path);
        if (EffectArray.some(names, name => name !== 'operation.lock' && name !== 'mutation.lock'))
          return yield* WriterAuthorityFault.make({reason: 'incompatible'});
        const id = yield* random.uuidV4();
        yield* publish({
          version: runtimePlatform === 'win32' ? 2 : 1,
          protocol: runtimePlatform === 'win32' ? 'threadnote-writer-windows-v2' : 'threadnote-writer-v1',
          authority: id,
          revision: 0,
          resources: [],
          operations: [],
        });
      }),
    );
    return authority;
  });
