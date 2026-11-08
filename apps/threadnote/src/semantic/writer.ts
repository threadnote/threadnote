import {Array as EffectArray, Clock, Effect, FileSystem, Option, Path, Schema, String as EffectString} from 'effect';
import {SecureRandom} from 'effect/crypto';
import {canonicalFileUri, Counter, Digest, FileUri, Identifier} from '@threadnote/semantic/contracts';
import {createSemanticProposal, semanticProposalLimits, type SemanticProposal} from '@threadnote/semantic/proposals';
import {applySemanticChange, recoverSemanticChange, type ApplyPorts} from '@threadnote/semantic/apply';
import {
  ApplyFault,
  ApplyBinding,
  restoreApplyJournal,
  createApplyJournal,
  updateApplyJournal,
  applyReceipt,
  type ApplyPlan,
  type ApplyTarget,
} from '@threadnote/semantic/journal';
import {OwnedView} from '@threadnote/semantic/views';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {constantTimeHexEqual} from '@threadnote/platform/hmac';
import * as Native from '@threadnote/platform/system';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {SemanticAgentQueryHost} from './agent_queries.js';
import {readSemanticHostProfile, semanticHostProfileName} from './host_profile.js';
import {
  SemanticWriterAdmissionRequest,
  SemanticWriterRequest,
  SemanticWriterProposal,
  SemanticWriterSession,
  SemanticWriterRetirementRequest,
  semanticAgentChangeLimits,
  type SemanticWriterHandle,
  type SemanticAgentEndpointChange,
} from './agent_change_protocol.js';
import {makeSemanticWriterAuthority, type WriterResourceClaim} from './writer_authority.js';

export const semanticWriterLimits = Object.freeze({
  maxOperations: 32,
  maxPrivateBytes: 64 * 1024 * 1024,
  maxJournalBytes: 16 * 1024 * 1024,
});
const reject = (reason: ApplyFault['reason'] = 'unavailable') => ApplyFault.make({reason});
const GateRefusal = Schema.Struct({
  status: Schema.Literals([
    'unsupported',
    'stale',
    'conflict',
    'unavailable',
    'budget-exceeded',
    'invalid-request',
    'timeout',
  ]),
});
class WriterGateFault extends Schema.TaggedError<WriterGateFault, {readonly brand: unique symbol}>()(
  'WriterGateFault',
  {
    status: GateRefusal.fields.status,
  },
) {}
const safe = (error: unknown) => reject(Schema.is(ApplyFault)(error) ? error.reason : 'unavailable');
const attempt = <A>(f: () => A) => Effect.try({try: f, catch: safe});
const refusal = (status: string, operation?: string) => ({
  version: 1 as const,
  status,
  applicable: false,
  ...(operation ? {operation, recoveryRequired: true} : {}),
  reason: 'Writer admission, source ownership or qualified host prerequisites are unavailable',
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema, {onExcessProperty: 'error'})(value).pipe(
    Effect.mapError(() => reject('invalid-input')),
  );

const writerScope = (config: RuntimeConfig, callerCwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!path.isAbsolute(callerCwd)) return yield* reject('invalid-input');
    const root = yield* fs.realPath(callerCwd);
    const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
    const home = yield* fs.realPath(config.agentContextHome);
    if (home !== path.resolve(config.agentContextHome)) return yield* reject('unauthorized');
    const principal = EffectString.slice(0, -5)(semanticHostProfileName(config, worktree));
    return {root, worktree, home, principal};
  });
type WriterScope = Effect.Success<ReturnType<typeof writerScope>>;

const resolveCurrent = <R>(
  services: SemanticAgentQueryHost<R>,
  config: RuntimeConfig,
  scope: WriterScope,
  handle: {id: string; digest: string; capability: string},
  milliseconds: number,
) =>
  Effect.gen(function* () {
    const selected = yield* readSemanticHostProfile(config, scope.worktree);
    const runtimeIdentity = yield* services.runtimeIdentity;
    const endpoint = yield* services.connect({
      enabled: true,
      dataHome: selected.home,
      worktree: scope.worktree,
      runtimeIdentity,
      ...selected.profile.catalog,
    });
    const request = {
      version: 1 as const,
      action: 'resolve-for-writer' as const,
      worktree: scope.worktree,
      principal: scope.principal,
      profile: selected.digest,
      handle,
      maxBytes: semanticAgentChangeLimits.maxPageBytes,
      milliseconds,
    };
    const response = yield* endpoint.request({operation: 'agent-change', request});
    if (Schema.is(GateRefusal)(response)) return yield* WriterGateFault.make({status: response.status});
    const resolved = yield* decode(SemanticWriterProposal, response);
    if (
      resolved.worktree !== scope.worktree ||
      resolved.principal !== scope.principal ||
      resolved.profile !== selected.digest ||
      resolved.session.runtimeIdentity !== runtimeIdentity
    )
      return yield* reject('identity-conflict');
    const proposal = yield* attempt(() => createSemanticProposal(resolved.proposal, sha256HexSync));
    if (proposal.digest !== handle.digest) return yield* reject('identity-conflict');
    const closing = yield* readSemanticHostProfile(config, scope.worktree);
    if (closing.digest !== selected.digest) return yield* reject('unauthorized');
    return {
      proposal,
      session: resolved.session,
      profile: selected.digest,
      expiresAt: resolved.expiresAt,
      endpoint,
      request,
    };
  });

/** Only semantic change admit invokes this OS-local issuance boundary. No RPC dispatches it. */
export const runSemanticWriterAdmissionWith = <R>(
  services: SemanticAgentQueryHost<R>,
  config: RuntimeConfig,
  input: unknown,
) =>
  Effect.gen(function* () {
    if (bytes(input).length > semanticAgentChangeLimits.maxRequestBytes) return yield* reject('invalid-input');
    const request = yield* decode(SemanticWriterAdmissionRequest, input);
    const scope = yield* writerScope(config, request.callerCwd);
    const resolved = yield* resolveCurrent(
      services,
      config,
      scope,
      request.handle,
      request.milliseconds ?? semanticAgentChangeLimits.defaultMilliseconds,
    );
    const writer = yield* makeSemanticHostWriter;
    return yield* writer.admit(scope, request, resolved);
  }).pipe(
    Effect.timeoutOption(
      Schema.is(SemanticWriterAdmissionRequest)(input)
        ? (input.milliseconds ?? semanticAgentChangeLimits.defaultMilliseconds)
        : semanticAgentChangeLimits.defaultMilliseconds,
    ),
    Effect.map(result => (result._tag === 'Some' ? result.value : refusal('unavailable'))),
    Effect.scoped,
    Effect.catch(error =>
      Effect.succeed(
        refusal(
          Schema.is(WriterGateFault)(error)
            ? error.status
            : Schema.is(ApplyFault)(error) && error.reason === 'invalid-input'
              ? 'invalid-request'
              : 'unavailable',
        ),
      ),
    ),
  );

/** CLI and MCP consume an already-issued secret; neither may mint one from read authorization. */
export const runSemanticWriterRequestWith = <R>(
  services: SemanticAgentQueryHost<R>,
  config: RuntimeConfig,
  input: unknown,
) =>
  Effect.gen(function* () {
    if (bytes(input).length > semanticAgentChangeLimits.maxRequestBytes) return yield* reject('invalid-input');
    const request = yield* decode(SemanticWriterRequest, input);
    const scope = yield* writerScope(config, request.callerCwd);
    const writer = yield* makeSemanticHostWriter;
    const record = yield* writer.resolve(scope, request.writer);
    const operation = request.writer.operation;
    if (request.action === 'status') {
      const status = yield* writer.status(scope, request.writer);
      return bytes(status).length <= (request.maxBytes ?? semanticAgentChangeLimits.defaultPageBytes)
        ? status
        : refusal('budget-exceeded', operation);
    }
    const run =
      request.action === 'recover'
        ? writer.recover(scope, request.writer, record)
        : writer.apply(scope, request.writer, record, () =>
            resolveCurrent(
              services,
              config,
              scope,
              record.handle,
              request.milliseconds ?? semanticAgentChangeLimits.defaultMilliseconds,
            ),
          );
    const response = yield* run;
    return bytes(response).length <= (request.maxBytes ?? semanticAgentChangeLimits.defaultPageBytes)
      ? response
      : refusal('budget-exceeded', operation);
  }).pipe(
    Effect.timeoutOption(
      Schema.is(SemanticWriterRequest)(input)
        ? (input.milliseconds ?? semanticAgentChangeLimits.defaultMilliseconds)
        : semanticAgentChangeLimits.defaultMilliseconds,
    ),
    Effect.map(result =>
      result._tag === 'Some'
        ? result.value
        : refusal('indeterminate', Schema.is(SemanticWriterRequest)(input) ? input.writer.operation : undefined),
    ),
    Effect.scoped,
    Effect.catch(error =>
      Effect.succeed(
        refusal(
          Schema.is(ApplyFault)(error) && error.reason === 'invalid-input' ? 'invalid-request' : 'unavailable',
          Schema.is(SemanticWriterRequest)(input) ? input.writer.operation : undefined,
        ),
      ),
    ),
  );

const Claim = Schema.Struct({canonicalUri: FileUri, authority: Identifier, fence: Counter, owner: Identifier});
const Admission = Schema.Struct({
  version: Schema.Literal(1),
  operation: Digest,
  principal: Digest,
  worktree: FileUri,
  home: FileUri,
  profile: Digest,
  createdAt: Counter,
  expiresAt: Counter,
  rootIdentity: Schema.Struct({dev: Schema.String, ino: Schema.String}),
  handle: Schema.Struct({id: Digest, digest: Digest, capability: Digest}),
  session: SemanticWriterSession,
  taskAuthorization: Digest,
  diskOwnership: Schema.Literal('closed-disk'),
  proposal: Schema.Unknown,
  claims: Schema.Array(Claim).check(Schema.isMinLength(1), Schema.isMaxLength(semanticProposalLimits.maxTargets)),
  owners: Schema.Array(OwnedView).check(Schema.isMinLength(1), Schema.isMaxLength(semanticProposalLimits.maxTargets)),
  capabilityVerifier: Digest,
});
type Admission = typeof Admission.Type;
type Authority = Effect.Success<typeof makeSemanticWriterAuthority>;
type Resolved = {
  proposal: SemanticProposal;
  session: SemanticWriterSession;
  profile: string;
  expiresAt: number;
};
const admissionName = (operation: string) => operation + '.admission.json';
const journalName = (operation: string) => operation + '.journal.json';
const startName = (operation: string) => operation + '.started.json';
const Tombstone = Schema.Struct({
  version: Schema.Literal(1),
  operation: Digest,
  kind: Schema.Literals(['terminal', 'discarded']),
  claims: Schema.Array(Claim),
  principal: Digest,
  worktree: FileUri,
  home: FileUri,
  taskAuthorization: Digest,
  journalDigest: Schema.NullOr(Digest),
  journalRevision: Schema.NullOr(Counter),
  capabilityVerifier: Digest,
});
type Tombstone = typeof Tombstone.Type;
const retirementVerifier = (capability: string, record: Tombstone) =>
  sha256HexSync(
    JSON.stringify([
      'threadnote-writer-retirement-v1',
      capability,
      record.operation,
      record.kind,
      record.claims,
      record.principal,
      record.worktree,
      record.home,
      record.taskAuthorization,
      record.journalDigest,
      record.journalRevision,
    ]),
  );
const verifier = (capability: string, record: Admission, proposal: SemanticProposal) =>
  sha256HexSync(
    JSON.stringify([
      'threadnote-writer-admission-v1',
      capability,
      record.operation,
      record.principal,
      record.worktree,
      record.home,
      record.profile,
      record.createdAt,
      record.expiresAt,
      record.rootIdentity,
      record.handle,
      record.session,
      record.taskAuthorization,
      record.diskOwnership,
      proposal.digest,
      record.claims,
      record.owners,
    ]),
  );
const binding = (record: Admission): ApplyBinding => ({
  operation: record.operation,
  principal: record.principal,
  worktree: record.worktree,
  proposal: createSemanticProposal(record.proposal, sha256HexSync).digest,
});
const parsePrivate = (data: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(data));

/** Trusted owning tests may inject an already native-guarded authority; production has no path override. */
export const makeSemanticHostWriterFromAuthority = Effect.fn('semantic.makeHostWriter')(function* (
  authority: Authority,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const system = yield* Native.SystemInfo;
  const clock = yield* Clock.Clock;
  const graph = yield* Effect.serviceOption(CodeGraphQueryService);
  const token = () => random.randomBytes(32).pipe(Effect.map(sha256HexSync));
  const read = (name: string, maximum = semanticWriterLimits.maxJournalBytes) =>
    attempt(() => {
      const file = Native.runtimeReadPrivateWriterFile(authority.directory, name, maximum);
      return file ? parsePrivate(file.bytes) : undefined;
    });
  const publish = (
    operation: string,
    name: string,
    value: unknown,
    mode: 'exclusive' | 'replace',
    extra?: () => void,
  ) =>
    Effect.gen(function* () {
      yield* authority.assertOperation(operation);
      const encoded = bytes(value);
      if (encoded.length > semanticWriterLimits.maxJournalBytes) return yield* reject('unavailable');
      yield* attempt(() => Native.runtimeAssertPrivateWriterDirectoryCurrent(authority.directory));
      const names = yield* fs.readDirectory(authority.directory.path);
      yield* attempt(() => Native.runtimeAssertPrivateWriterDirectoryCurrent(authority.directory));
      if (names.length > semanticWriterLimits.maxOperations * 6 + 16) return yield* reject('unavailable');
      let retainedBytes = 0;
      for (const retainedName of names) {
        if (
          retainedName === name ||
          EffectString.startsWith('operation.lock')(retainedName) ||
          EffectString.startsWith('mutation.lock')(retainedName)
        )
          continue;
        retainedBytes += yield* attempt(
          () =>
            Native.runtimeReadPrivateWriterFile(authority.directory, retainedName, semanticWriterLimits.maxJournalBytes)
              ?.bytes.length ?? 0,
        );
      }
      if (retainedBytes + encoded.length > semanticWriterLimits.maxPrivateBytes) return yield* reject('unavailable');
      const nonce = yield* token();
      const result = yield* attempt(() =>
        Native.runtimePublishPrivateWriterFile(authority.directory, name, encoded, {
          mode,
          nonce,
          assertCurrentSync: () => {
            authority.assertOperationSync(operation);
            extra?.();
          },
        }),
      );
      if (result.status !== 'published') return yield* reject('unavailable');
    });
  const discardUnissuedAdmissions = (operation: string, indexed: readonly {operation: string}[]) =>
    Effect.gen(function* () {
      yield* attempt(() => Native.runtimeAssertPrivateWriterDirectoryCurrent(authority.directory));
      const names = yield* fs.readDirectory(authority.directory.path);
      yield* attempt(() => Native.runtimeAssertPrivateWriterDirectoryCurrent(authority.directory));
      if (names.length > semanticWriterLimits.maxOperations * 6 + 16) return yield* reject('unavailable');
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.admission\.json$/u.test(name)) continue;
        const candidate = EffectString.slice(0, 64)(name);
        if (EffectArray.some(indexed, ref => ref.operation === candidate)) continue;
        // Index membership is required before START or source mutation. Only these unreachable,
        // never-started admission bytes may be removed; partial JSON is not a write grant.
        yield* attempt(() => {
          authority.assertOperationSync(operation);
          if (
            Native.runtimeReadPrivateWriterFile(
              authority.directory,
              startName(candidate),
              semanticWriterLimits.maxJournalBytes,
            ) ||
            Native.runtimeReadPrivateWriterFile(
              authority.directory,
              journalName(candidate),
              semanticWriterLimits.maxJournalBytes,
            )
          )
            throw reject('invalid-journal');
          const file = Native.runtimeReadPrivateWriterFile(
            authority.directory,
            name,
            semanticWriterLimits.maxJournalBytes,
          );
          if (file)
            Native.runtimeRemovePrivateWriterFile(authority.directory, name, file.identity, () =>
              authority.assertOperationSync(operation),
            );
        });
      }
    });
  const restore = (raw: unknown) =>
    attempt(() => {
      const record = Schema.decodeUnknownSync(Admission, {onExcessProperty: 'error'})(raw);
      const proposal = createSemanticProposal(record.proposal, sha256HexSync);
      if (
        record.handle.digest !== proposal.digest ||
        record.claims.length !== proposal.targets.length ||
        record.owners.length !== proposal.targets.length
      )
        throw reject('invalid-journal');
      for (const [index, target] of proposal.targets.entries()) {
        const claim = record.claims[index];
        const owner = record.owners[index];
        if (
          claim.canonicalUri !== target.observation.uri ||
          owner.authority !== claim.authority ||
          owner.fence !== claim.fence ||
          JSON.stringify(owner.observation) !== JSON.stringify(target.observation)
        )
          throw reject('invalid-journal');
      }
      return structuredClone(record);
    });
  const authenticate = (scope: WriterScope, handle: SemanticWriterHandle) =>
    Effect.gen(function* () {
      const record = yield* restore(yield* read(admissionName(handle.operation)));
      const home = canonicalFileUri((yield* path.toFileUrl(scope.home)).href);
      if (
        record.operation !== handle.operation ||
        record.principal !== scope.principal ||
        record.worktree !== scope.worktree ||
        record.home !== home ||
        !constantTimeHexEqual(
          record.capabilityVerifier,
          verifier(handle.capability, record, createSemanticProposal(record.proposal, sha256HexSync)),
        )
      )
        return yield* reject('unauthorized');
      return record;
    });
  const withDisk = <A, E, R>(
    record: Admission,
    target: ApplyTarget,
    use: (handle: Native.RuntimeGuardedDiskTarget) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* path.fromFileUrl(new URL(target.before.observation.uri));
        const root = yield* path.fromFileUrl(new URL(record.worktree));
        const relative = path.relative(root, file);
        if (
          !EffectString.startsWith(root + path.sep)(file) ||
          EffectString.split(path.sep)(relative).includes('.git') ||
          target.sourceKind !== 'disk' ||
          !target.physicalIdentity
        )
          return yield* reject('invalid-input');
        const rooted = yield* Effect.acquireRelease(
          attempt(() =>
            Native.runtimeOpenWriterRoot(root, {
              dev: BigInt(record.rootIdentity.dev),
              ino: BigInt(record.rootIdentity.ino),
            }),
          ),
          value => Effect.sync(() => Native.runtimeCloseWriterRoot(value)),
        );
        const opened = yield* Effect.acquireRelease(
          attempt(() =>
            Native.runtimeOpenGuardedDiskTarget(
              rooted,
              EffectString.split(path.sep)(relative),
              target.physicalIdentity!,
              semanticAgentChangeLimits.maxSourceBytes,
            ),
          ),
          value => Effect.sync(() => Native.runtimeCloseGuardedDiskTarget(value)),
        );
        return yield* use(opened);
      }),
    );
  const currentTask = (record: Admission) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now < record.createdAt || now >= record.expiresAt) return false;
      const identity = system.canonicalProcessStartIdentity
        ? yield* system.canonicalProcessStartIdentity(record.session.processId)
        : undefined;
      if (
        !identity ||
        identity !== record.session.processStartIdentity ||
        !system.isProcessRunning(record.session.processId)
      )
        return false;
      const profile = path.join(
        yield* path.fromFileUrl(new URL(record.home)),
        'semantic',
        'profiles',
        record.principal + '.json',
      );
      const stat = yield* fs.stat(profile);
      if (
        stat.type !== 'File' ||
        (stat.mode & 0o077) !== 0 ||
        (yield* fs.realPath(profile)) !== profile ||
        Number(stat.size) > 16384
      )
        return false;
      return sha256HexSync(yield* fs.readFile(profile)) === record.profile;
    }).pipe(Effect.orElseSucceed(() => false));
  const portsFor = (
    scope: WriterScope,
    handle: SemanticWriterHandle,
    record: Admission,
    recovery: boolean,
    invalidate: () => Effect.Effect<void, unknown> = () => Effect.fail(reject()),
    maintenance?: {withOperation: ApplyPorts['withOperation']},
  ) => {
    let first = false;
    let active: {claim: WriterResourceClaim; disk: Native.RuntimeGuardedDiskTarget} | undefined;
    const proposal = createSemanticProposal(record.proposal, sha256HexSync);
    const planBinding = binding(record);
    const claimFor = (target: ApplyTarget) =>
      record.claims[
        Option.getOrThrow(
          EffectArray.findFirstIndex(proposal.targets, t => t.observation.uri === target.before.observation.uri),
        )
      ];
    const inspect = (target: ApplyTarget) =>
      withDisk(record, target, disk =>
        Effect.gen(function* () {
          const resource = yield* authority.observeResource(target.before.observation.uri);
          if (!resource) return null;
          return yield* attempt(() => {
            const observed = Native.runtimeInspectGuardedDiskTarget(disk);
            return {
              ...target.before,
              authority: resource.claim.authority,
              fence: resource.claim.fence,
              observation: {...target.before.observation, content: sha256HexSync(observed.bytes)},
            };
          });
        }),
      );
    const check = (target: ApplyTarget) =>
      Effect.gen(function* () {
        const file = yield* path.fromFileUrl(new URL(target.before.observation.uri));
        if ((yield* fs.realPath(file)) !== file) return {status: 'conflict', reason: 'path'} as const;
        const info = yield* fs.stat(file);
        if (info.type !== 'File') return {status: 'conflict', reason: 'path'} as const;
        if ((info.mode & 0o222) === 0) return {status: 'conflict', reason: 'readonly'} as const;
        const inspected = active
          ? yield* attempt(() => Native.runtimeInspectGuardedDiskTarget(active!.disk))
          : undefined;
        if (active) {
          yield* authority.assertTarget(active.claim);
          if (sha256HexSync(inspected!.bytes) !== target.before.observation.content)
            return {status: 'conflict', reason: 'source-changed'} as const;
          return {status: 'ok', current: target.before} as const;
        }
        return yield* authority.withTarget(
          claimFor(target),
          withDisk(record, target, disk =>
            attempt(() => {
              authority.assertTargetSync(claimFor(target));
              const observed = Native.runtimeInspectGuardedDiskTarget(disk);
              return sha256HexSync(observed.bytes) === target.before.observation.content
                ? ({status: 'ok', current: target.before} as const)
                : ({status: 'conflict', reason: 'source-changed'} as const);
            }),
          ),
        );
      }).pipe(Effect.orElseSucceed(() => ({status: 'conflict', reason: 'ownership'}) as const));
    const ports: ApplyPorts = {
      withOperation: (operation, effect) => {
        const program = Effect.gen(function* () {
          if (!maintenance) yield* authenticate(scope, handle);
          else yield* authority.assertOperation(operation);
          if (!recovery && !maintenance && (yield* read(startName(operation))) === undefined) {
            if (!(yield* currentTask(record))) return yield* reject('unauthorized');
            yield* publish(
              operation,
              startName(operation),
              {version: 1, operation, proposal: proposal.digest},
              'exclusive',
            );
            first = true;
          }
          return yield* effect;
        });
        return maintenance
          ? maintenance.withOperation(operation, program)
          : authority.withOperation(operation, program);
      },
      withTarget: (target, effect) =>
        authority.withTarget(
          claimFor(target),
          withDisk(record, target, disk =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                active = {claim: claimFor(target), disk};
              }),
              () => effect,
              () =>
                Effect.sync(() => {
                  active = undefined;
                }),
            ),
          ),
        ),
      load: () =>
        Effect.gen(function* () {
          yield* authority.assertOperation(record.operation);
          const raw = yield* read(journalName(record.operation));
          if (raw === undefined && !first) return yield* reject('invalid-journal');
          return raw;
        }),
      persist: journal =>
        Effect.gen(function* () {
          if (JSON.stringify(journal.plan.binding) !== JSON.stringify(planBinding))
            return yield* reject('identity-conflict');
          const checked = restoreApplyJournal(journal);
          yield* publish(record.operation, journalName(record.operation), checked, 'replace', () => {
            if (active) authority.assertTargetSync(active.claim);
          });
        }),
      authorize: () => (recovery || maintenance ? Effect.succeed(true) : currentTask(record)),
      check,
      mutate: (target, afterText) =>
        Effect.gen(function* () {
          if (!active || active.claim.canonicalUri !== target.before.observation.uri || !(yield* currentTask(record)))
            return {status: 'conflict', reason: 'authorization'} as const;
          const selected = active;
          const result = yield* attempt(() => {
            const before = Native.runtimeInspectGuardedDiskTarget(selected.disk);
            if (sha256HexSync(before.bytes) !== target.before.observation.content)
              return {status: 'conflict', reason: 'source-changed'} as const;
            return Native.runtimeCommitGuardedDiskTarget(selected.disk, {
              before,
              afterBytes: new TextEncoder().encode(afterText),
              assertCurrentSync: () => {
                authority.assertTargetSync(selected.claim);
                const now = clock.currentTimeMillisUnsafe();
                if (now < record.createdAt || now >= record.expiresAt) throw reject('unauthorized');
              },
            });
          });
          if (result.status !== 'applied') return result;
          return {
            status: 'applied',
            current: {
              ...target.before,
              observation: {...target.before.observation, content: sha256HexSync(result.current.bytes)},
            },
          } as const;
        }),
      inspect: target => inspect(target).pipe(Effect.orElseSucceed(() => null)),
      invalidate: () => invalidate(),
    };
    return ports;
  };
  return {
    resolve: (scope: WriterScope, handle: SemanticWriterHandle) =>
      authority.withOperation(handle.operation, authenticate(scope, handle)),
    status: (scope: WriterScope, handle: SemanticWriterHandle) =>
      authority.withOperation(
        handle.operation,
        Effect.gen(function* () {
          const record = yield* authenticate(scope, handle);
          const raw = yield* read(journalName(handle.operation));
          if (raw !== undefined)
            return {...applyReceipt(restoreApplyJournal(raw)), observationBasis: 'last-recorded' as const};
          const started = yield* read(startName(handle.operation));
          return {
            version: 1,
            status: started === undefined ? 'not-started' : 'indeterminate',
            operation: handle.operation,
            proposal: binding(record).proposal,
            applicable: false,
            recoveryRequired: started !== undefined,
            observationBasis: 'last-recorded' as const,
          };
        }),
      ),
    retire: (
      scope: WriterScope,
      handle: SemanticWriterHandle,
      disposition: 'terminal' | 'discarded',
      taskAuthorization: string,
    ) =>
      authority.withAdmission(
        handle.operation,
        Effect.gen(function* () {
          const raw = yield* read(admissionName(handle.operation));
          let tombstone: Tombstone;
          if (Schema.is(Tombstone)(raw)) {
            tombstone = yield* Schema.decodeEffect(Tombstone, {onExcessProperty: 'error'})(raw);
            const home = canonicalFileUri((yield* path.toFileUrl(scope.home)).href);
            if (
              tombstone.operation !== handle.operation ||
              tombstone.principal !== scope.principal ||
              tombstone.worktree !== scope.worktree ||
              tombstone.home !== home ||
              !constantTimeHexEqual(tombstone.capabilityVerifier, retirementVerifier(handle.capability, tombstone))
            )
              return yield* reject('unauthorized');
          } else {
            const record = yield* authenticate(scope, handle);
            const original = yield* attempt(() =>
              Native.runtimeReadPrivateWriterFile(
                authority.directory,
                journalName(handle.operation),
                semanticWriterLimits.maxJournalBytes,
              ),
            );
            let revision: number | null = null;
            if (original && disposition === 'terminal') {
              const journal = restoreApplyJournal(parsePrivate(original.bytes));
              if (EffectArray.some(journal.results, result => result.state === 'intent' || result.state === 'unknown'))
                return yield* reject('invalid-journal');
              revision = journal.revision;
            } else if (disposition === 'terminal') return yield* reject('invalid-journal');
            const unsigned: Tombstone = {
              version: 1,
              operation: handle.operation,
              kind: disposition,
              claims: record.claims,
              principal: record.principal,
              worktree: record.worktree,
              home: record.home,
              taskAuthorization: sha256HexSync(taskAuthorization),
              journalDigest: original ? sha256HexSync(original.bytes) : null,
              journalRevision: revision,
              capabilityVerifier: sha256HexSync('pending'),
            };
            tombstone = {...unsigned, capabilityVerifier: retirementVerifier(handle.capability, unsigned)};
            yield* publish(handle.operation, admissionName(handle.operation), tombstone, 'replace');
          }
          yield* authority.retireOperation(
            handle.operation,
            {tombstoneName: admissionName(handle.operation), tombstoneDigest: sha256HexSync(bytes(tombstone))},
            tombstone.claims,
          );
          for (const name of [
            journalName(handle.operation),
            startName(handle.operation),
            admissionName(handle.operation),
          ]) {
            const file = yield* attempt(() =>
              Native.runtimeReadPrivateWriterFile(authority.directory, name, semanticWriterLimits.maxJournalBytes),
            );
            if (file)
              yield* attempt(() =>
                Native.runtimeRemovePrivateWriterFile(authority.directory, name, file.identity, () =>
                  authority.assertOperationSync(handle.operation),
                ),
              );
          }
          return {
            version: 1,
            status: 'retired',
            operation: handle.operation,
            disposition: tombstone.kind,
            sourceMutation: false,
          };
        }),
      ),
    admit: (scope: WriterScope, request: typeof SemanticWriterAdmissionRequest.Type, resolved: Resolved) =>
      Effect.gen(function* () {
        const proposal = createSemanticProposal(resolved.proposal, sha256HexSync);
        if (
          proposal.targets.length === 0 ||
          (proposal.version === 2 && proposal.qualification !== 'qualified-text-only') ||
          EffectArray.some(
            proposal.targets,
            target =>
              target.precondition.sourceKind !== 'disk' ||
              target.observation.view.kind !== 'disk' ||
              new TextEncoder().encode(target.afterText).length > semanticAgentChangeLimits.maxSourceBytes,
          )
        )
          return {
            version: 1,
            status: 'integration-required',
            applicable: false,
            reason: 'A qualified closed-disk writer is required for every target',
          };
        const operation = yield* token();
        const capability = yield* token();
        const resources = EffectArray.map(proposal.targets, target => target.observation.uri);
        // Maintenance owns O→M and explicitly borrows exact indexed operations, never ordinary nested gates.
        yield* authority.withHandover(resources, (maintenanceScope, refs) =>
          Effect.forEach(refs, ref =>
            authority.borrowMaintenanceOperation(
              maintenanceScope,
              ref.operation,
              Effect.gen(function* () {
                const previous = yield* restore(yield* read(admissionName(ref.operation)));
                const previousProposal = createSemanticProposal(previous.proposal, sha256HexSync);
                const previousScope = {
                  root: yield* path.fromFileUrl(new URL(previous.worktree)),
                  worktree: previous.worktree,
                  home: yield* path.fromFileUrl(new URL(previous.home)),
                  principal: previous.principal,
                };
                const journal = yield* read(ref.journalName);
                if (journal === undefined) {
                  if ((yield* read(startName(ref.operation))) !== undefined) return yield* reject('invalid-journal');
                  const plan: ApplyPlan = {
                    binding: binding(previous),
                    targets: EffectArray.map(previousProposal.targets, (target, index) => ({
                      before: previous.owners[index],
                      after: sha256HexSync(target.afterText),
                      sourceKind: target.precondition.sourceKind,
                      physicalIdentity: target.precondition.physicalIdentity,
                    })),
                  };
                  const retired = updateApplyJournal(createApplyJournal(plan), {
                    results: EffectArray.map(plan.targets, (_, index) =>
                      index === 0 ? {state: 'conflict', reason: 'authorization'} : {state: 'unwritten'},
                    ),
                  });
                  yield* publish(
                    ref.operation,
                    startName(ref.operation),
                    {version: 1, operation: ref.operation, proposal: previousProposal.digest},
                    'exclusive',
                  );
                  yield* publish(ref.operation, ref.journalName, retired, 'replace');
                }
                // This maintenance scope authorizes observation/reconciliation only, never an old task's source write.
                const maintenancePorts = portsFor(
                  previousScope,
                  {operation: ref.operation, capability: sha256HexSync('maintenance-not-a-grant')},
                  previous,
                  true,
                  undefined,
                  {
                    withOperation: (id, effect) =>
                      id === ref.operation ? effect : Effect.fail(reject('identity-conflict')),
                  },
                );
                yield* recoverSemanticChange(binding(previous), maintenancePorts);
                const persisted = yield* read(ref.journalName);
                const current = restoreApplyJournal(persisted);
                return {
                  operation: ref.operation,
                  journalRevision: current.revision,
                  journalDigest: sha256HexSync(bytes(persisted)),
                };
              }),
            ),
          ),
        );
        return yield* authority.withAdmission(
          operation,
          Effect.gen(function* () {
            const existing = yield* authority.listOperations;
            yield* discardUnissuedAdmissions(operation, existing);
            if (existing.length >= semanticWriterLimits.maxOperations) return yield* reject('unavailable');
            let size = 0;
            for (const ref of existing) {
              for (const name of [admissionName(ref.operation), journalName(ref.operation)]) {
                size += yield* attempt(
                  () =>
                    Native.runtimeReadPrivateWriterFile(authority.directory, name, semanticWriterLimits.maxJournalBytes)
                      ?.bytes.length ?? 0,
                );
              }
            }
            const info = yield* fs.stat(scope.root);
            if (info.type !== 'Directory' || Option.isNone(info.ino)) return yield* reject('invalid-input');
            const rootIdentity = {dev: String(info.dev), ino: String(info.ino.value)};
            // Qualified source inspection precedes enrollment; no trial write is performed.
            const temporary: Admission = {
              version: 1,
              operation,
              principal: scope.principal,
              worktree: scope.worktree,
              home: canonicalFileUri((yield* path.toFileUrl(scope.home)).href),
              profile: resolved.profile,
              createdAt: yield* Clock.currentTimeMillis,
              expiresAt: resolved.expiresAt,
              rootIdentity,
              handle: request.handle,
              session: resolved.session,
              taskAuthorization: sha256HexSync(request.taskAuthorization),
              diskOwnership: 'closed-disk',
              proposal,
              claims: [],
              owners: [],
              capabilityVerifier: sha256HexSync('pending'),
            };
            if (!(yield* currentTask(temporary))) return yield* reject('unauthorized');
            for (const [index, target] of proposal.targets.entries()) {
              const file = yield* path.fromFileUrl(new URL(target.observation.uri));
              const real = yield* fs.realPath(file).pipe(Effect.option);
              if (Option.isNone(real) || real.value !== file)
                return {version: 1, status: 'conflict', applicable: false, conflicts: [{index, reason: 'path'}]};
              const writable = yield* fs.stat(file);
              if ((writable.mode & 0o222) === 0)
                return {version: 1, status: 'conflict', applicable: false, conflicts: [{index, reason: 'readonly'}]};
              const before = {observation: target.observation, authority: 'inspection', fence: 0};
              const verified = yield* withDisk(
                temporary,
                {
                  before,
                  after: sha256HexSync(target.afterText),
                  sourceKind: target.precondition.sourceKind,
                  physicalIdentity: target.precondition.physicalIdentity,
                },
                disk =>
                  attempt(
                    () =>
                      sha256HexSync(Native.runtimeInspectGuardedDiskTarget(disk).bytes) ===
                      target.precondition.rawDigest,
                  ),
              ).pipe(Effect.orElseSucceed(() => false));
              if (!verified)
                return {
                  version: 1,
                  status: 'conflict',
                  applicable: false,
                  conflicts: [{index, reason: 'source-or-physical-identity'}],
                };
            }
            const claims = yield* authority.enrollResources(
              resolved.session,
              EffectArray.map(proposal.targets, target => ({
                canonicalUri: target.observation.uri,
                physicalIdentity: target.precondition.physicalIdentity!,
              })),
              operation,
            );
            const owners = EffectArray.map(proposal.targets, (target, index) => ({
              observation: target.observation,
              authority: claims[index].authority,
              fence: claims[index].fence,
            }));
            const record: Admission = {...temporary, claims, owners};
            const sealed = {...record, capabilityVerifier: verifier(capability, record, proposal)};
            if (size + bytes(sealed).length > semanticWriterLimits.maxPrivateBytes) return yield* reject('unavailable');
            // An indexed operation must always have complete material for read-only maintenance,
            // including when registration commits but its acknowledgement or issued handle is lost.
            yield* publish(operation, admissionName(operation), sealed, 'exclusive', () => {
              for (const claim of claims) authority.assertTargetSync(claim);
            });
            yield* authority.registerOperation({
              operation,
              journalName: journalName(operation),
              resources: EffectArray.map(claims, claim => claim.canonicalUri),
              authority: claims[0].authority,
              fence: claims[0].fence,
            });
            return {
              version: 1,
              status: 'admitted',
              writer: {operation, capability},
              proposal: proposal.digest,
              targetCount: proposal.targets.length,
              authorization: 'local-caller-asserted',
              ownership: 'explicit-closed-disk',
              expiresAt: record.expiresAt,
            };
          }),
        );
      }),
    recover: (scope: WriterScope, handle: SemanticWriterHandle, record: Admission) =>
      recoverSemanticChange(binding(record), portsFor(scope, handle, record, true)),
    apply: <R>(
      scope: WriterScope,
      handle: SemanticWriterHandle,
      record: Admission,
      refresh: () => Effect.Effect<
        Resolved & {
          endpoint: Effect.Success<ReturnType<SemanticAgentQueryHost['connect']>>;
          request: SemanticAgentEndpointChange;
        },
        unknown,
        R
      >,
    ) =>
      Effect.gen(function* () {
        // Existing operations reconcile without requiring a live provider or reviving their write grant.
        const started = yield* authority.withOperation(record.operation, read(startName(record.operation)));
        if (started !== undefined)
          return yield* recoverSemanticChange(binding(record), portsFor(scope, handle, record, true));
        const fresh = yield* refresh();
        if (
          fresh.proposal.digest !== binding(record).proposal ||
          JSON.stringify(fresh.session) !== JSON.stringify(record.session) ||
          fresh.profile !== record.profile
        )
          return yield* reject('identity-conflict');
        const beforeGraph = Option.isSome(graph)
          ? yield* graph.value
              .status(scope.home, scope.root, {
                observeWorktree: true,
                observeSemantic: false,
                requestMaintenance: false,
              })
              .pipe(Effect.option)
          : Option.none();
        const invalidate = () =>
          Effect.gen(function* () {
            const result = yield* fresh.endpoint.request({
              operation: 'agent-change',
              request: {...fresh.request, action: 'invalidate-for-writer'},
            });
            if (
              typeof result !== 'object' ||
              result === null ||
              !('status' in result) ||
              result.status !== 'invalidated'
            )
              return yield* reject();
            if (Option.isNone(graph)) return yield* reject();
            const afterGraph = yield* graph.value.status(scope.home, scope.root, {
              observeWorktree: true,
              observeSemantic: false,
              requestMaintenance: false,
            });
            if (Option.isNone(beforeGraph)) return yield* reject();
            const previous = beforeGraph.value;
            if (
              afterGraph.identity.repositoryId !== previous.identity.repositoryId ||
              afterGraph.identity.worktreeId !== previous.identity.worktreeId
            )
              return yield* reject();
            const changed = EffectArray.some(
              fresh.proposal.targets,
              target => sha256HexSync(target.afterText) !== target.precondition.rawDigest,
            );
            // Observation is a source-current proof, not a queued-refresh acknowledgement. A still-current
            // identical old snapshot after changed bytes is insufficient; retain explicit pending state.
            if (
              changed &&
              previous.readySnapshot &&
              afterGraph.readySnapshot?.id === previous.readySnapshot.id &&
              !afterGraph.stale
            )
              return yield* reject();
            if (changed && previous.readySnapshot && afterGraph.freshness === 'deferred') return yield* reject();
          });
        return yield* applySemanticChange(
          {
            binding: binding(record),
            proposal: createSemanticProposal(record.proposal, sha256HexSync),
            owners: record.owners,
          },
          portsFor(scope, handle, record, false, invalidate),
          sha256HexSync,
        );
      }),
  };
});

export const makeSemanticHostWriter = Effect.acquireRelease(makeSemanticWriterAuthority, authority =>
  Effect.sync(authority.close),
).pipe(Effect.flatMap(makeSemanticHostWriterFromAuthority));

/** Explicit local cleanup never routes through public MCP admission or changes source bytes. */
export const runSemanticWriterRetirementWith = (config: RuntimeConfig, input: unknown) =>
  Effect.gen(function* () {
    if (bytes(input).length > semanticAgentChangeLimits.maxRequestBytes) return yield* reject('invalid-input');
    const request = yield* decode(SemanticWriterRetirementRequest, input);
    const scope = yield* writerScope(config, request.callerCwd);
    const writer = yield* makeSemanticHostWriter;
    return yield* writer.retire(scope, request.writer, request.disposition, request.taskAuthorization);
  }).pipe(
    Effect.timeoutOption(
      Schema.is(SemanticWriterRetirementRequest)(input)
        ? (input.milliseconds ?? semanticAgentChangeLimits.defaultMilliseconds)
        : semanticAgentChangeLimits.defaultMilliseconds,
    ),
    Effect.map(result =>
      result._tag === 'Some'
        ? result.value
        : refusal(
            'indeterminate',
            Schema.is(SemanticWriterRetirementRequest)(input) ? input.writer.operation : undefined,
          ),
    ),
    Effect.scoped,
    Effect.catch(error =>
      Effect.succeed(
        refusal(Schema.is(ApplyFault)(error) && error.reason === 'invalid-input' ? 'invalid-request' : 'unavailable'),
      ),
    ),
  );
