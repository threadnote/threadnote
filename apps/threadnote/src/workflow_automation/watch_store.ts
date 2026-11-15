import {SecureRandom} from 'effect/crypto';
import * as EffectArray from 'effect/Array';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  nativeWatchEventLimit,
  decodeNativeWatchState,
  decodeNativeWatchSweep,
  type NativeWatchState,
} from '@threadnote/workflow-automations/watch';
import {verifyNativeWatchBoundPr, type NativeWatchProviderCache} from './watch_provider.js';
import {readNativeWorkflowState} from './store.js';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {nativeCycleSnapshotIsCurrentIteration} from '@threadnote/workflow-automations/cycle-runtime';
import {
  nativeCycleSupplementalRef,
  nativeCycleSupplementalRevision,
} from '@threadnote/workflow-automations/cycle-runtime';
import {runCommandEffect} from '@threadnote/platform/command';
import {bindNativeCycleDeliveryBase, verifyNativeCycleDeliveryRepository} from './cycle_delivery.js';
import * as Cause from 'effect/Cause';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {decodeBoundedWorkflowJson, encodeBoundedWorkflowJson} from '../workflow_memory/journal_codec.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {
  nativeWatchNotificationSchema,
  validateNativeWatchNotification,
  type NativeWatchNotification,
} from './watch_notification_state.js';
import * as EffectString from 'effect/String';
import * as Fn from 'effect/Function';

export interface NativeWatchEnvelope {
  format: 'threadnote-native-watch-runtime';
  version: 1;
  state: NativeWatchState;
  owner?: NativeWatchOwner;
  invalidation?: {readonly kind: 'candidate_invalidated'; readonly reason: string; readonly at: number};
  provider: NativeWatchProviderCache;
  collector: null | {
    token: string;
    pid: number;
    startIdentity?: string;
    startedAt: number;
    lastSeenAt: number;
    nextPollAt: number;
    status: 'starting' | 'running' | 'stopped' | 'blocked' | 'terminal';
    reason?: string;
    consecutiveErrors: number;
  };
  stopRequested: boolean;
  notification?: NativeWatchNotification;
  metrics: {
    requests: number;
    notModified: number;
    responseBytes: number;
    graphqlCost: number;
    providerMilliseconds: number;
    sweeps: number;
    consumerReads: number;
  };
}
const integer = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: Number.MAX_SAFE_INTEGER}));
const text = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.makeFilter(value =>
      EffectArray.some([...value], character => {
        const code = Fn.pipe(
          character,
          EffectString.charCodeAt(0),
          Option.getOrElse(() => NaN),
        );
        return code < 32 || (code >= 127 && code <= 159);
      })
        ? 'Text contains control characters.'
        : undefined,
    ),
  );
const ownerHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const ownerSha = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
export const nativeWatchOwnerSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('candidate-pr'),
    runId: text(128),
    generationHash: ownerHash,
    phaseId: text(128),
    phaseHash: ownerHash,
    snapshotRef: text(4096),
    snapshotId: text(128),
    snapshotDigest: ownerHash,
    baselineHead: ownerSha,
    baselineTree: ownerSha,
    baselineRef: text(512),
    callerCwd: text(4096),
    head: ownerSha,
    tree: ownerSha,
    branch: text(512),
    scopeDigest: ownerHash,
    prUrl: text(2048),
    comparisonRef: text(512),
    comparisonResolvedRef: text(512),
    baseConfigDigest: ownerHash,
    baseRefBinding: Schema.optionalKey(Schema.Struct({ref: text(512), remote: text(128), repository: text(512)})),
    baseBranch: text(512),
    headBranch: text(512),
  }),
  Schema.Struct({
    kind: Schema.Literal('supplemental-publication'),
    runId: text(128),
    generationHash: ownerHash,
    publicationId: text(128),
    head: ownerSha,
    tree: ownerSha,
    phaseId: text(128),
    prUrl: text(2048),
  }),
]);
export type NativeWatchOwner = typeof nativeWatchOwnerSchema.Type;
export type NativeCandidateWatchOwner = Extract<NativeWatchOwner, {kind: 'candidate-pr'}>;
export const nativeWatchOwnerDigest = (owner: NativeWatchOwner) => sha256HexSync(stableJson(owner));

export const nativeCandidateWatchFailureIsDrift = (error: unknown): boolean =>
  Schema.is(WorkflowAutomationError)(error) &&
  ['candidate-binding-drift', 'candidate-source-drift', 'candidate-base-drift', 'watch-binding-drift'].includes(
    error.code,
  );
const unavailable = (message: string) =>
  WorkflowAutomationError.make({code: 'candidate-verification-unavailable', message, retryable: true});
const boundedCandidateGit = (owner: {callerCwd: string}, args: readonly string[], timeoutMs = 1500) =>
  runCommandEffect(
    'git',
    ['--no-optional-locks', '-c', 'core.warnAmbiguousRefs=true', '-C', owner.callerCwd, ...args],
    {allowFailure: true, timeoutMs, maxOutputBytes: 65_536},
  ).pipe(
    Effect.flatMap(result => {
      if (result.exitCode === 124) return Effect.fail(unavailable('The bounded candidate source probe timed out.'));
      if (result.exitCode !== 0 || EffectString.trim(result.stderr))
        return Effect.fail(
          issue('candidate-source-drift', 'The exact candidate source/ref is unavailable or ambiguous.'),
        );
      return Effect.succeed(EffectString.trim(result.stdout));
    }),
    Effect.mapError(error =>
      Schema.is(WorkflowAutomationError)(error) ? error : unavailable('Candidate source verification is unavailable.'),
    ),
  );
const candidateGitConfiguration = (owner: {callerCwd: string}) =>
  boundedCandidateGit(owner, ['config', '--get-regexp', '^(remote[.].*[.](url|fetch)|url[.].*[.]insteadof)$']);

/** A short local fence fits below the two-second control-lock waiter budget. No network is permitted. */
export const verifyNativeCandidateSourceFence = Effect.fn('workflowWatch.candidateSourceFence')(function* (
  owner: NativeCandidateWatchOwner,
) {
  const status = yield* boundedCandidateGit(
    owner,
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignore-submodules=none'],
    500,
  );
  const lines = EffectString.split(status, '\n');
  if (
    !lines.includes('# branch.oid ' + owner.head) ||
    !lines.includes('# branch.head ' + owner.branch) ||
    EffectArray.some(lines, line => Boolean(line) && !EffectString.startsWith('# ')(line))
  )
    return yield* issue('candidate-source-drift', 'The candidate requires its exact clean committed HEAD and branch.');
});

export const nativeCandidateWatchOwnerIsCurrent = (
  stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
  owner: NativeCandidateWatchOwner,
): boolean => {
  const runtime = stored.state.cycle;
  const phase = runtime
    ? Option.getOrUndefined(EffectArray.findFirst(runtime.state.plan.phases, item => item.id === owner.phaseId))
    : undefined;
  const proof = runtime?.state.phases[owner.phaseId];
  const baseline = runtime?.baselines[owner.phaseId];
  const snapshot = runtime
    ? EffectArray.filter(runtime.snapshots, item => item.snapshot.phaseId === owner.phaseId).at(-1)?.snapshot
    : undefined;
  const ref = decodeNativeTaskActionRef(owner.snapshotRef);
  return Boolean(
    runtime &&
    phase &&
    proof &&
    baseline &&
    snapshot &&
    ref &&
    nativeCycleSnapshotIsCurrentIteration(runtime, owner.phaseId, owner.snapshotId) &&
    sha256HexSync(stored.state.generation) === owner.generationHash &&
    proof.phaseHash === owner.phaseHash &&
    snapshot.snapshotId === owner.snapshotId &&
    snapshot.phaseHash === owner.phaseHash &&
    snapshot.head === owner.head &&
    snapshot.tree === owner.tree &&
    sha256HexSync(stableJson(snapshot)) === owner.snapshotDigest &&
    sha256HexSync(
      stableJson({
        phase,
        files: snapshot.files,
        scopeFiles: snapshot.scopeFiles,
        scopeBase: snapshot.scopeBase,
        declaredBaseHead: snapshot.declaredBaseHead,
      }),
    ) === owner.scopeDigest &&
    baseline.head === owner.baselineHead &&
    baseline.tree === owner.baselineTree &&
    baseline.pinnedRef === owner.baselineRef &&
    baseline.repo === owner.callerCwd &&
    phase.branch === owner.branch &&
    phase.baseBranch === owner.comparisonRef &&
    ref.kind === 'snapshot' &&
    ref.runId === owner.runId &&
    ref.generationHash === owner.generationHash &&
    ref.phaseId === owner.phaseId &&
    ref.phaseHash === owner.phaseHash &&
    ref.snapshotId === owner.snapshotId &&
    ref.sourceHead === owner.head &&
    ref.sourceTree === owner.tree &&
    ref.baselineHead === owner.baselineHead &&
    ref.baselineTree === owner.baselineTree &&
    ref.baselineRef === owner.baselineRef,
  );
};
/** Immutable native fence is cheap; callers use it with a short local fence and existing CAS. */
export const verifyNativeCandidateNativeFence = Effect.fn('workflowWatch.candidateNativeFence')(function* (
  config: RuntimeConfig,
  owner: NativeCandidateWatchOwner,
) {
  const stored = yield* readNativeWorkflowState(config, owner.runId);
  if (!stored || !nativeCandidateWatchOwnerIsCurrent(stored, owner))
    return yield* issue(
      'candidate-binding-drift',
      'The candidate snapshot no longer proves the current phase iteration.',
    );
});

/** Strict destination binding is established once; its exact ref/config witness is checked on every observation. */
export const bindNativeCandidateWatchBase = Effect.fn('workflowWatch.bindCandidateBase')(
  function* (
    checkout: string,
    comparisonRef: string,
    source: {phaseId: string; phaseHash: string; head: string; tree: string},
    pr: string,
  ) {
    const observed = yield* verifyNativeWatchBoundPr(pr, {
      head: source.head,
      headBranch: undefined,
      baseBranch: undefined,
    });
    const input = {
      phaseId: source.phaseId,
      phaseHash: source.phaseHash,
      delivery: 'pr',
      headSha: source.head,
      validatedTree: source.tree,
      pr: {
        url: pr,
        headSha: source.head,
        branch: observed.headBranch,
        baseBranch: observed.baseBranch,
        state: observed.state === 'merged' ? 'merged' : 'open',
      },
    };
    yield* verifyNativeCycleDeliveryRepository(checkout, input);
    const bound = yield* bindNativeCycleDeliveryBase(checkout, comparisonRef, input);
    const probe = {callerCwd: checkout};
    const comparisonResolvedRef = yield* boundedCandidateGit(probe, [
      'rev-parse',
      '--symbolic-full-name',
      '--verify',
      '--end-of-options',
      comparisonRef,
    ]);
    if (
      !bound.pr ||
      (bound.pr.baseRefBinding
        ? comparisonResolvedRef !== bound.pr.baseRefBinding.ref
        : comparisonResolvedRef !== 'refs/heads/' + observed.baseBranch)
    )
      return yield* issue('candidate-base-drift', 'The comparison ref does not identify the exact PR destination.');
    return {
      baseBranch: observed.baseBranch,
      headBranch: observed.headBranch,
      comparisonResolvedRef,
      baseConfigDigest: sha256HexSync(yield* candidateGitConfiguration(probe)),
      ...(bound.pr.baseRefBinding ? {baseRefBinding: bound.pr.baseRefBinding} : {}),
    };
  },
  Effect.timeout('10 seconds'),
  Effect.catchIf(Cause.isTimeoutError, () =>
    Effect.fail(unavailable('Candidate base verification exceeded its deadline.')),
  ),
);

/** Provider I/O is outside control locks. Sweeps reuse their own before/after PR observations. */
export const verifyNativeCandidateWatchOwner = Effect.fn('workflowWatch.verifyCandidateOwner')(
  function* (config: RuntimeConfig, owner: NativeCandidateWatchOwner, options: {readonly provider?: boolean} = {}) {
    yield* verifyNativeCandidateNativeFence(config, owner);
    yield* verifyNativeCandidateSourceFence(owner);
    const objects = EffectString.split(
      yield* boundedCandidateGit(owner, ['rev-parse', '--verify', 'HEAD^{tree}']),
      '\n',
    );
    const pinned = yield* boundedCandidateGit(owner, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      owner.baselineRef + '^{tree}',
    ]);
    const comparison = yield* boundedCandidateGit(owner, [
      'rev-parse',
      '--symbolic-full-name',
      '--verify',
      '--end-of-options',
      owner.comparisonRef,
    ]);
    const configuration = sha256HexSync(yield* candidateGitConfiguration(owner));
    if (
      objects[0] !== owner.tree ||
      pinned !== owner.baselineTree ||
      comparison !== owner.comparisonResolvedRef ||
      configuration !== owner.baseConfigDigest
    )
      return yield* issue(
        'candidate-source-drift',
        'The candidate source, baseline or exact destination binding changed.',
      );
    if (options.provider !== false)
      yield* verifyNativeWatchBoundPr(owner.prUrl, {
        head: owner.head,
        baseBranch: owner.baseBranch,
        headBranch: owner.headBranch,
      });
    yield* verifyNativeCandidateSourceFence(owner);
  },
  Effect.timeout('10 seconds'),
  Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(unavailable('Candidate verification exceeded its deadline.'))),
);

export const nativeCandidateWatchRef = (owner: NativeCandidateWatchOwner, watchId: string) => {
  const identity = EffectString.slice(0, 48)(nativeWatchOwnerDigest(owner));
  return encodeNativeTaskActionRef({
    version: 1,
    kind: 'candidate-watch',
    runId: owner.runId,
    generationHash: owner.generationHash,
    phaseId: owner.phaseId,
    phaseHash: owner.phaseHash,
    snapshotId: owner.snapshotId,
    sourceHead: owner.head,
    sourceTree: owner.tree,
    baselineHead: owner.baselineHead,
    baselineTree: owner.baselineTree,
    baselineRef: owner.baselineRef,
    watchId,
    consumerId: 'candidate-task-' + identity,
    wakeupId: 'candidate-task-' + identity,
    payloadDigest: nativeWatchOwnerDigest(owner),
  });
};

const envelopeSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-watch-runtime'),
  version: Schema.Literal(1),
  state: Schema.Unknown,
  owner: Schema.optionalKey(nativeWatchOwnerSchema),
  invalidation: Schema.optionalKey(
    Schema.Struct({kind: Schema.Literal('candidate_invalidated'), reason: text(64), at: integer}),
  ),
  provider: Schema.Struct({
    pages: Schema.Array(
      Schema.Struct({
        key: text(2048),
        etag: Schema.optionalKey(text(2048)),
        modified: Schema.optionalKey(text(256)),
        projection: Schema.Struct({
          items: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(10_000)),
          size: integer,
          pending: integer,
          failed: integer,
          pull: Schema.optionalKey(
            Schema.Struct({
              head: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)),
              base: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u))),
              mergeable: Schema.Boolean.pipe(Schema.NullOr, Schema.optionalKey),
              state: Schema.Literals(['open', 'closed', 'merged']),
              identity: Schema.optionalKey(
                Schema.Struct({url: text(2048), repository: text(256), baseBranch: text(256), headBranch: text(256)}),
              ),
            }),
          ),
        }),
      }),
    ).check(Schema.isMaxLength(402)),
  }),
  collector: Schema.NullOr(
    Schema.Struct({
      token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu)),
      pid: integer,
      startIdentity: Schema.optionalKey(text(256)),
      startedAt: integer,
      lastSeenAt: integer,
      nextPollAt: integer,
      status: Schema.Literals(['starting', 'running', 'stopped', 'blocked', 'terminal']),
      reason: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/u))),
      consecutiveErrors: integer,
    }),
  ),
  stopRequested: Schema.Boolean,
  notification: Schema.optionalKey(nativeWatchNotificationSchema),
  metrics: Schema.Struct({
    requests: integer,
    notModified: integer,
    responseBytes: integer,
    graphqlCost: integer,
    providerMilliseconds: integer,
    sweeps: integer,
    consumerReads: integer,
  }),
});
export function decodeNativeWatchEnvelope(value: unknown): NativeWatchEnvelope {
  try {
    const envelope = Schema.decodeUnknownSync(envelopeSchema, {onExcessProperty: 'error'})(value);
    const state = decodeNativeWatchState(envelope.state);
    checkRunId(state.watchId);
    if (envelope.owner) {
      checkRunId(envelope.owner.runId);
      if (
        (state.head !== undefined && state.head !== envelope.owner.head) ||
        envelope.owner.prUrl !== state.pr ||
        (envelope.owner.kind === 'candidate-pr' && !EffectString.startsWith('candidate-')(state.watchId)) ||
        (envelope.owner.kind === 'supplemental-publication' && !EffectString.startsWith('sup-')(state.watchId))
      )
        throw new Error('Owner identity');
    } else if (EffectString.startsWith('candidate-')(state.watchId) || EffectString.startsWith('sup-')(state.watchId)) {
      throw new Error('Missing typed owner');
    }
    if (
      envelope.owner?.kind === 'candidate-pr' &&
      !envelope.invalidation &&
      state.events.length >= nativeWatchEventLimit
    )
      throw new Error('Candidate invalidation sequence must remain available');
    if (
      envelope.invalidation &&
      (envelope.owner?.kind !== 'candidate-pr' ||
        !envelope.stopRequested ||
        state.events.at(-1)?.kind !== 'candidate_invalidated' ||
        state.events.at(-1)?.key !== envelope.invalidation.reason ||
        state.events.at(-1)?.at !== envelope.invalidation.at)
    )
      throw new Error('Invalid candidate invalidation');
    if (envelope.notification) validateNativeWatchNotification(envelope.notification, state);
    if (new Set(EffectArray.map(envelope.provider.pages, page => page.key)).size !== envelope.provider.pages.length)
      throw new Error('Duplicate page');
    const head = Fn.pipe('a', EffectString.repeat(40));
    const pages = EffectArray.map(envelope.provider.pages, page => {
      const projection = page.projection;
      if (projection.size > 1_000_000 || projection.pending + projection.failed > projection.size)
        throw new Error('Counts');
      const sweep = decodeNativeWatchSweep({
        head,
        startedHead: head,
        state: 'open',
        at: 0,
        sources: [{source: 'comments', complete: true, items: projection.items, at: 0}],
        ci: {
          head,
          complete: true,
          count: 0,
          pending: 0,
          failed: 0,
          version: Fn.pipe('a', EffectString.repeat(64)),
        },
      });
      const source = sweep.sources[0];
      if (!source.complete) throw new Error('Source');
      return {...page, projection: {...projection, items: source.items}};
    });
    return {...envelope, state, provider: {pages}};
  } catch {
    throw issue('invalid-state', 'Malformed native watch runtime envelope.');
  }
}
const issue = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const STATE_CODEC = 'threadnote-native-watch-runtime-gzip-v1';
function checkRunId(runId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) ||
    Fn.pipe(runId, EffectString.includes('..')) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(runId) ||
    ['constructor', 'prototype'].includes(runId)
  )
    throw issue('invalid-request', 'Native run IDs must be bounded portable identifiers, never paths.');
}

/** Fixed private namespace. Neither requests nor legacy helper files select this root. */
const stateDirectory = Effect.fn('workflowAutomation.stateDirectory')(function* (
  config: RuntimeConfig,
  create: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = yield* fs.realPath(config.agentContextHome);
  for (const segment of ['workflow-automations', 'native-watch-v1']) {
    directory = path.join(directory, segment);
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
      return yield* issue('unsafe-state', 'Native run state directories cannot be symbolic links.');
    if (!(yield* fs.exists(directory))) {
      if (!create) return undefined;
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    }
    if (
      Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)) ||
      (yield* fs.stat(directory)).type !== 'Directory' ||
      (yield* fs.realPath(directory)) !== directory
    )
      return yield* issue('unsafe-state', 'Native run state must stay in its canonical private directory.');
  }
  return directory;
});

const statePath = Effect.fn('workflowAutomation.statePath')(function* (
  config: RuntimeConfig,
  runId: string,
  create = false,
) {
  yield* Effect.try({
    try: () => checkRunId(runId),
    catch: error =>
      Schema.is(WorkflowAutomationError)(error)
        ? error
        : issue('invalid-state', 'Could not validate native workflow state.'),
  });
  const directory = yield* stateDirectory(config, create);
  return directory === undefined ? undefined : (yield* Path.Path).join(directory, runId + '.json');
});

const stateBytes = Effect.fn('workflowAutomation.stateBytes')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
    return yield* issue('unsafe-state', 'Native run state cannot be a symbolic link.');
  if (!(yield* fs.exists(file))) return undefined;
  const stat = yield* fs.stat(file);
  if (stat.type !== 'File' || Number(stat.size) > 16 * 1024 * 1024)
    return yield* issue('invalid-state', 'Native run state must be a bounded regular file.');
  const bytes = yield* fs.readFileString(file);
  if (new TextEncoder().encode(bytes).byteLength > 16 * 1024 * 1024)
    return yield* issue('invalid-state', 'Native run state exceeds its stored byte limit.');
  return bytes;
});

export const readNativeWatch = Effect.fn('workflowAutomation.readState')(function* (
  config: RuntimeConfig,
  runId: string,
  expectedRevision?: string,
) {
  const file = yield* statePath(config, runId);
  if (file === undefined) return undefined;
  const bytes = yield* stateBytes(file);
  if (bytes === undefined) return undefined;
  if (expectedRevision !== undefined && sha256HexSync(bytes) !== expectedRevision)
    return yield* issue('watch-inventory-changed', 'The retained watch changed during bounded inventory read.');
  const state = yield* fromPromiseInterruptible(
    async signal => {
      const parsed: unknown = JSON.parse(bytes);
      const value =
        parsed !== null && typeof parsed === 'object' && 'format' in parsed && parsed.format === STATE_CODEC
          ? JSON.parse(await decodeBoundedWorkflowJson(bytes, STATE_CODEC, signal))
          : parsed;
      return decodeNativeWatchEnvelope(value);
    },
    error =>
      Schema.is(WorkflowAutomationError)(error)
        ? error
        : issue(
            'invalid-state',
            'Native run state is corrupt. Restore its exact file; no recovery or rebinding was applied.',
          ),
  );
  if (state.state.watchId !== runId)
    return yield* issue('invalid-state', 'The native state file belongs to another run.');
  const result = {envelope: state, revision: sha256HexSync(bytes)};
  return result;
});

/** Bounded names-only discovery for legacy and PR-qualified watches of one canonical phase. */
export const readNativeTaskWatchIds = (config: RuntimeConfig, legacyWatchId: string) =>
  Effect.gen(function* () {
    if (!/^pr-[a-f0-9]{48}$/u.test(legacyWatchId))
      return yield* issue('invalid-state', 'Invalid canonical phase watch namespace.');
    const directory = yield* stateDirectory(config, false);
    if (directory === undefined) return [] as string[];
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(directory);
    if (names.length > 4096)
      return yield* issue('watch-inventory-capacity', 'Watch namespace exceeds bounded discovery capacity.');
    const selected = EffectArray.filter(
      names,
      name =>
        EffectString.endsWith('.json')(name) &&
        (name === `${legacyWatchId}.json` || EffectString.startsWith(`${legacyWatchId}-`)(name)),
    ).sort();
    if (selected.length > 256)
      return yield* issue('watch-inventory-capacity', 'Phase watch inventory exceeds bounded discovery capacity.');
    const pattern = new RegExp(`^${legacyWatchId}(?:-[a-f0-9]{48})?\\.json$`, 'u');
    if (EffectArray.some(selected, name => !pattern.test(name)))
      return yield* issue('invalid-state', 'The phase watch namespace contains an unrecognized identity.');
    return EffectArray.map(selected, name => EffectString.slice(0, -5)(name));
  });

export interface NativeCandidateWatchInventoryRow {
  readonly watchId: string;
  readonly watchRevision: string;
  readonly runId: string;
  readonly callerCwd: string;
  readonly phaseId: string;
  readonly snapshotId: string;
  readonly prUrl: string;
  readonly candidateWatchRef: string;
  readonly historical: boolean;
  readonly collectorStatus: 'absent' | 'starting' | 'running' | 'stopped' | 'blocked' | 'terminal';
  readonly invalidation?: {readonly kind: 'candidate_invalidated'; readonly reason: string; readonly at: number};
}
/** Bounded retained discovery; no live source/provider probe and no short control lock. */
export const readNativeCandidateWatchInventory = Effect.fn('workflowWatch.candidateInventory')(
  function* (
    config: RuntimeConfig,
    stored: NonNullable<Effect.Success<ReturnType<typeof readNativeWorkflowState>>>,
    callerCwd: string,
  ) {
    const directory = yield* stateDirectory(config, false);
    const rows: NativeCandidateWatchInventoryRow[] = [];
    if (directory === undefined) return {rows, count: 0, digest: sha256HexSync(stableJson(rows))};
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(directory);
    if (names.length > 4096)
      return yield* issue('watch-inventory-capacity', 'Watch namespace exceeds bounded discovery capacity.');
    const selected = EffectArray.filter(names, name => /^candidate-[a-f0-9]{48}\.json$/u.test(name)).sort();
    if (selected.length > 256)
      return yield* issue(
        'watch-inventory-capacity',
        'Candidate watch inventory exceeds256files; no rows were omitted.',
      );
    let diskBytes = 0;
    let logicalBytes = 0;
    for (const name of selected) {
      const file = path.join(directory, name);
      const bytes = yield* stateBytes(file);
      if (bytes === undefined)
        return yield* issue('watch-inventory-changed', 'Candidate inventory changed; reload the task view.');
      diskBytes += new TextEncoder().encode(bytes).byteLength;
      const shape = yield* Effect.try({
        try: () => JSON.parse(bytes) as unknown,
        catch: () => issue('invalid-state', 'Candidate watch inventory is corrupt.'),
      });
      const expanded =
        shape !== null &&
        typeof shape === 'object' &&
        'expandedBytes' in shape &&
        typeof shape.expandedBytes === 'number'
          ? shape.expandedBytes
          : new TextEncoder().encode(bytes).byteLength;
      logicalBytes += expanded;
      if (
        diskBytes > 32 * 1024 * 1024 ||
        !Number.isSafeInteger(expanded) ||
        expanded < 0 ||
        logicalBytes > 128 * 1024 * 1024
      )
        return yield* issue(
          'watch-inventory-capacity',
          'Candidate inventory exceeds bounded read bytes; no rows were omitted.',
        );
      const watchId = EffectString.slice(0, -5)(name);
      const watch = yield* readNativeWatch(config, watchId, sha256HexSync(bytes));
      if (!watch) return yield* issue('watch-inventory-changed', 'Candidate inventory changed; reload the task view.');
      const owner = watch.envelope.owner;
      if (owner?.kind !== 'candidate-pr')
        return yield* issue('invalid-state', 'Candidate inventory requires its typed retained owner.');
      if (owner.runId !== stored.state.runId) continue;
      if (owner.callerCwd !== callerCwd)
        return yield* issue('watch-owner-conflict', 'The retained candidate belongs to another checkout.');
      rows.push({
        watchId,
        watchRevision: watch.revision,
        runId: owner.runId,
        callerCwd: owner.callerCwd,
        phaseId: owner.phaseId,
        snapshotId: owner.snapshotId,
        prUrl: owner.prUrl,
        candidateWatchRef: nativeCandidateWatchRef(owner, watchId),
        historical: !nativeCandidateWatchOwnerIsCurrent(stored, owner),
        collectorStatus: watch.envelope.collector?.status ?? 'absent',
        ...(watch.envelope.invalidation ? {invalidation: watch.envelope.invalidation} : {}),
      });
    }
    return {rows, count: rows.length, digest: sha256HexSync(stableJson(rows))};
  },
  Effect.timeout('5 seconds'),
  Effect.catchIf(Cause.isTimeoutError, () =>
    Effect.fail(
      issue('watch-inventory-unavailable', 'Candidate discovery exceeded its bounded deadline; no rows were omitted.'),
    ),
  ),
);

/** Exact known-notice recovery never enumerates other watches or checks source freshness. */
export const readNativeOwnedWatchRoute = Effect.fn('workflowWatch.ownedRoute')(function* (
  config: RuntimeConfig,
  watchId: string,
) {
  const watch = yield* readNativeWatch(config, watchId);
  const owner = watch?.envelope.owner;
  if (!watch || !owner) return undefined;
  const consumer = watch.envelope.state.consumer;
  if (!consumer) return yield* issue('watch-owner-conflict', 'Owned notice requires its retained consumer.');
  let callerCwd: string;
  let candidateWatchRef: string | undefined;
  let supplementalRef: string | undefined;
  if (owner.kind === 'candidate-pr') {
    callerCwd = owner.callerCwd;
    candidateWatchRef = nativeCandidateWatchRef(owner, watchId);
  } else {
    const stored = yield* readNativeWorkflowState(config, owner.runId);
    const runtime = stored?.state.cycle;
    const publication = runtime
      ? Option.getOrUndefined(
          EffectArray.findFirst(
            runtime.state.supplementalPublications ?? [],
            item => item.publicationId === owner.publicationId,
          ),
        )
      : undefined;
    const init = publication?.initialization;
    const baseline = runtime?.baselines[owner.phaseId];
    if (
      !stored ||
      !runtime ||
      !publication ||
      !init ||
      !baseline ||
      sha256HexSync(stored.state.generation) !== owner.generationHash ||
      init.phaseId !== owner.phaseId ||
      init.head !== owner.head ||
      init.tree !== owner.tree ||
      init.pr.url !== owner.prUrl
    )
      return yield* issue('watch-owner-conflict', 'The supplemental notice has no exact retained native owner.');
    callerCwd = baseline.repo;
    supplementalRef = encodeNativeTaskActionRef({
      version: 1,
      kind: 'supplemental-publication',
      runId: owner.runId,
      generationHash: owner.generationHash,
      stateRevision: stored.revision,
      phaseId: init.phaseId,
      phaseHash: init.phaseHash,
      snapshotId: init.snapshotId,
      sourceHead: init.head,
      sourceTree: init.tree,
      publicationId: publication.publicationId,
      publicationRef: nativeCycleSupplementalRef(publication),
      payloadDigest: nativeCycleSupplementalRevision(runtime),
    });
  }
  const outbox = watch.envelope.notification?.outbox;
  const base =
    owner.kind === 'candidate-pr'
      ? decodeNativeTaskActionRef(candidateWatchRef!)
      : {
          version: 1 as const,
          kind: 'delivery' as const,
          runId: owner.runId,
          generationHash: owner.generationHash,
          payloadDigest: nativeWatchOwnerDigest(owner),
          watchId,
          consumerId: consumer.id,
          wakeupId: consumer.wakeupId,
        };
  const noticeRef =
    base && outbox?.attemptId
      ? encodeNativeTaskActionRef({
          ...base,
          kind: owner.kind === 'candidate-pr' ? 'candidate-notice' : 'delivery',
          eventKey: outbox.key,
          watchAttemptId: outbox.attemptId,
        })
      : undefined;
  return {
    runId: owner.runId,
    callerCwd,
    ...(candidateWatchRef ? {candidateWatchRef} : {}),
    ...(supplementalRef ? {supplementalRef} : {}),
    ...(noticeRef ? {noticeRef} : {}),
  };
});

/** Call only under the run lock. CAS and rename preserve the old file on every failed preparation. */
export const writeNativeWatch = Effect.fn('workflowAutomation.writeState')(function* (
  config: RuntimeConfig,
  state: NativeWatchEnvelope,
  expectedRevision: string | null,
) {
  const validated = yield* Effect.try({
    try: () => decodeNativeWatchEnvelope(state),
    catch: error =>
      Schema.is(WorkflowAutomationError)(error)
        ? error
        : issue('invalid-state', 'Could not validate native workflow state.'),
  });
  const serialized = yield* Effect.try({
    try: () => encodeBoundedWorkflowJson(stableJson(validated) + '\n', STATE_CODEC),
    catch: () =>
      issue('state-capacity', 'Native run state reached its byte limit. Existing receipts remain unchanged.'),
  });
  const file = (yield* statePath(config, state.state.watchId, true))!;
  const fs = yield* FileSystem.FileSystem;
  const temporary = file + '.' + (yield* (yield* SecureRandom.SecureRandom).uuidV4()) + '.tmp';
  return yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, serialized, {mode: 0o600, flag: 'wx'});
    // Revalidate parent ownership and destination bytes immediately before commit.
    yield* statePath(config, state.state.watchId);
    const previous = yield* stateBytes(file);
    if ((previous === undefined ? null : sha256HexSync(previous)) !== expectedRevision)
      return yield* issue(
        'state-conflict',
        'Native run state changed after it was read. Retry from its current receipt.',
      );
    if (previous !== undefined) {
      const prior = yield* readNativeWatch(config, state.state.watchId);
      if (stableJson(prior?.envelope.owner) !== stableJson(validated.owner))
        return yield* issue('watch-owner-conflict', 'An existing watch cannot replace its immutable owner.');
      if (
        prior?.envelope.invalidation &&
        stableJson(prior.envelope.invalidation) !== stableJson(validated.invalidation)
      )
        return yield* issue('candidate-invalidated', 'Candidate invalidation is immutable; start a fresh candidate.');
    }
    yield* statePath(config, state.state.watchId);
    const immediate = yield* stateBytes(file);
    if ((immediate === undefined ? null : sha256HexSync(immediate)) !== expectedRevision)
      return yield* issue('state-conflict', 'Watch state changed before commit.');
    yield* fs.rename(temporary, file);
    const result = {envelope: validated, revision: sha256HexSync(serialized)};
    return result;
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

function watchLock<A, E, R>(config: RuntimeConfig, id: string, collector: boolean, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* statePath(config, id, true);
    return yield* withExclusiveFileLock(
      fs,
      file! + (collector ? '.collector.lock' : '.control.lock'),
      {
        createParentDirectory: false,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 300_000,
        waitTimeoutMilliseconds: collector ? 0 : 2_000,
        heartbeatIntervalMilliseconds: 1000,
        useCanonicalProcessStartIdentity: true,
        recoverReusedProcessIdImmediately: true,
      },
      body,
    );
  });
}
export const withNativeWatchControlLock = <A, E, R>(config: RuntimeConfig, id: string, body: Effect.Effect<A, E, R>) =>
  watchLock(config, id, false, body);
export const withNativeWatchCollectorLock = <A, E, R>(
  config: RuntimeConfig,
  id: string,
  body: Effect.Effect<A, E, R>,
) => watchLock(config, id, true, body);
