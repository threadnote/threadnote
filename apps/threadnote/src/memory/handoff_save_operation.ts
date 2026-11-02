import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {
  Array as EffectArray,
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  String as EffectString,
} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {
  runtimeOpenTextDirectoryNameReader,
  runtimeReadBoundedStableRegularFile,
  SystemInfo,
} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {fromPromise} from '@threadnote/platform/errors';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {observeCanonicalProcessInstanceIdentity} from '../process/process_identity.js';
import {
  compiledHandoffSaveIdentity,
  eligibleOwnedHandoff,
  CurrentHandoffSaveObserver,
  HANDOFF_SAVE_HISTORY_LIMIT,
  HANDOFF_SAVE_READY_MILLISECONDS,
  HANDOFF_SAVE_RECEIPT_BYTES,
  HANDOFF_SAVE_RESULT_MILLISECONDS,
  HANDOFF_SAVE_WORKER_ARGUMENT,
  handoffSaveOperationIdSchema,
  handoffSaveReceiptSchema,
  handoffSaveResponseSchema,
  type HandoffSaveReceipt,
  type HandoffSaveStage,
} from './handoff_save_contract.js';

class HandoffSaveOperationError extends Schema.TaggedError<
  HandoffSaveOperationError,
  {readonly brand: unique symbol}
>()('HandoffSaveOperationError', {
  message: Schema.String,
}) {}
const terminal = (value: HandoffSaveReceipt) => value.stage === 'complete' || value.stage === 'not-started';
const lockOptions = {
  createParentDirectory: false,
  retryIntervalMilliseconds: 10,
  waitTimeoutMilliseconds: 100,
  staleAfterMilliseconds: 300_000,
  useCanonicalProcessStartIdentity: true,
} as const;
const accountKey = (config: RuntimeConfig) => sha256HexSync(JSON.stringify([config.account]));
const scopeKey = (config: RuntimeConfig) => sha256HexSync(JSON.stringify([config.account, config.user]));
const paths = (path: Path.Path, config: RuntimeConfig, operationId: string) => {
  const accountDirectory = path.join(
    config.agentContextHome,
    'memory-operations',
    'handoff-save-v1',
    accountKey(config),
  );
  const directory = path.join(accountDirectory, scopeKey(config));
  return {
    directory,
    receipt: path.join(directory, operationId + '.json'),
    owner: path.join(accountDirectory, 'owner.json'),
    intake: path.join(accountDirectory, 'intake.lock'),
    decision: path.join(directory, operationId + '.decision.lock'),
    cancel: path.join(directory, operationId + '.cancel'),
  };
};
/** Existing canonical home plus four private directories, never recursive recreation. */
const privateScope = Effect.fn('handoffSave.privateScope')(function* (config: RuntimeConfig, create = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(config.agentContextHome);
  const pins: {name: string; dev: bigint; ino: bigint}[] = [];
  const pin = (name: string) =>
    Effect.gen(function* () {
      if ((yield* fs.realPath(name)) !== name)
        return yield* HandoffSaveOperationError.make({message: 'Private operation directory is redirected.'});
      const info = yield* fs.stat(name);
      if (info.type !== 'Directory' || Option.isNone(info.ino))
        return yield* HandoffSaveOperationError.make({message: 'Private directory identity is unavailable.'});
      pins.push({name, dev: info.dev, ino: info.ino.value});
    });
  const assert = Effect.gen(function* () {
    for (const known of pins) {
      if ((yield* fs.realPath(known.name)) !== known.name)
        return yield* HandoffSaveOperationError.make({message: 'Private directory changed.'});
      const info = yield* fs.stat(known.name);
      if (info.type !== 'Directory' || info.dev !== known.dev || Option.getOrUndefined(info.ino) !== known.ino)
        return yield* HandoffSaveOperationError.make({message: 'Private directory changed.'});
    }
  });
  yield* pin(home);
  let directory = home;
  for (const component of ['memory-operations', 'handoff-save-v1', accountKey(config), scopeKey(config)]) {
    yield* assert;
    directory = path.join(directory, component);
    if (!(yield* fs.exists(directory))) {
      if (!create) return undefined;
      yield* fs.makeDirectory(directory, {mode: 0o700}).pipe(
        Effect.catchIf(
          error => error.reason._tag === 'AlreadyExists',
          () => Effect.void,
        ),
      );
    }
    yield* pin(directory);
  }
  yield* assert;
  return {config: {...config, agentContextHome: home}, assert};
});
const readReceipt = Effect.fn('handoffSave.readReceipt')(function* (config: RuntimeConfig, operationId: string) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* privateScope(config);
  if (!scope) return undefined;
  const file = paths(yield* Path.Path, scope.config, operationId).receipt;
  if (!(yield* fs.exists(file))) return undefined;
  const bytes = yield* fromPromise('handoffSave.readReceipt', () =>
    runtimeReadBoundedStableRegularFile(file, HANDOFF_SAVE_RECEIPT_BYTES),
  );
  const parsed: unknown = yield* Effect.try(() => JSON.parse(new TextDecoder().decode(bytes)));
  const value = yield* Schema.decodeUnknownEffect(handoffSaveReceiptSchema, {onExcessProperty: 'error'})(parsed);
  if (value.operationId !== operationId || value.account !== config.account || value.user !== config.user)
    return yield* HandoffSaveOperationError.make({message: 'Handoff operation scope mismatch.'});
  yield* scope.assert;
  return value;
});
type HandoffPrivateScope = NonNullable<Effect.Success<ReturnType<typeof privateScope>>>;
const writeReceipt = Effect.fn('handoffSave.writeReceipt')(function* (
  config: RuntimeConfig,
  value: HandoffSaveReceipt,
  scope: HandoffPrivateScope,
  expected?: HandoffSaveReceipt,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* scope.assert;
  const location = paths(yield* Path.Path, scope.config, value.operationId);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > HANDOFF_SAVE_RECEIPT_BYTES)
    return yield* HandoffSaveOperationError.make({message: 'Handoff receipt exceeds its bound.'});
  const checkPrevious = Effect.gen(function* () {
    yield* scope.assert;
    const current = yield* readReceipt(scope.config, value.operationId);
    if (
      expected === undefined
        ? current !== undefined
        : current === undefined || !Schema.toEquivalence(handoffSaveReceiptSchema)(current, expected)
    )
      return yield* HandoffSaveOperationError.make({message: 'Private receipt authority changed.'});
    yield* scope.assert;
  });
  yield* checkPrevious;
  const temporary = location.receipt + '.' + (yield* (yield* Crypto.Crypto).randomUUIDv4()) + '.tmp';
  yield* scope.assert;
  yield* fs.writeFileString(temporary, encoded, {flag: 'wx', mode: 0o600});
  yield* syncWritableFile(fs, temporary);
  yield* scope.assert;
  yield* checkPrevious;
  yield* fs.rename(temporary, location.receipt);
  yield* syncDirectoryBestEffort(fs, location.directory);
});
const intakeOwnerSchema = Schema.Struct({
  operationId: handoffSaveOperationIdSchema,
  user: Schema.String.check(Schema.isMaxLength(256)),
  processId: Schema.Int,
  processStartIdentity: Schema.String.check(Schema.isMaxLength(512)),
});
const sameLiveOwner = Effect.fn('handoffSave.sameOwner')(function* (
  value: Pick<HandoffSaveReceipt, 'processId' | 'processStartIdentity'>,
) {
  const system = yield* SystemInfo;
  if (!system.isProcessRunning(value.processId)) return false;
  const observed = yield* observeCanonicalProcessInstanceIdentity(system, value.processId);
  return observed === undefined || observed === value.processStartIdentity;
});
function resultForReceipt(value: HandoffSaveReceipt): CallToolResult {
  if (value.stage === 'complete' && value.response)
    return {
      ...value.response,
      content: [...value.response.content],
      structuredContent: {...value.response.structuredContent, operationId: value.operationId, state: 'complete'},
    };
  if (value.stage === 'complete' && value.result)
    return {
      content: [{type: 'text', text: `Stored memory: ${value.result.memoryUri}`}],
      structuredContent: {...value.result, operationId: value.operationId, state: 'complete'},
    };
  return {
    content: [
      {
        type: 'text',
        text: `Handoff save ${value.stage === 'not-started' ? 'was not started' : 'has no verified complete result'}. Inspect memory_write_status; do not resubmit an uncertain save.`,
      },
    ],
    structuredContent: {
      operationId: value.operationId,
      state: value.stage === 'not-started' ? 'not-started' : 'pending',
      stage: value.stage,
      canonicalObserved: value.canonicalObserved,
      lexicalVerified: value.lexicalVerified,
    },
  };
}
export const inspectHandoffSaveOperation = Effect.fn('handoffSave.inspect')(
  function* (config: RuntimeConfig, operationId: string, cancel = false) {
    if (!Schema.is(handoffSaveOperationIdSchema)(operationId))
      return {isError: true, content: [{type: 'text' as const, text: 'Invalid handoff operation ID.'}]};
    const scope = yield* privateScope(config);
    if (!scope)
      return {
        content: [{type: 'text' as const, text: 'Operation receipt unavailable; outcome is unknown. Do not replay.'}],
        structuredContent: {operationId, state: 'unknown'},
      };
    let value = yield* readReceipt(scope.config, operationId);
    yield* scope.assert;
    if (!value)
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Operation receipt unavailable; outcome is unknown. Do not resubmit a possibly authorized save.',
          },
        ],
        structuredContent: {operationId, state: 'unknown'},
      };
    if (cancel && !terminal(value)) {
      const fs = yield* FileSystem.FileSystem;
      const location = paths(yield* Path.Path, scope.config, operationId);
      yield* scope.assert;
      yield* withExclusiveFileLock(
        fs,
        location.decision,
        lockOptions,
        Effect.gen(function* () {
          yield* scope.assert;
          const latest = yield* readReceipt(config, operationId);
          if (!latest || terminal(latest)) return;
          yield* scope.assert;
          if (!(yield* fs.exists(location.cancel))) {
            yield* fs.writeFileString(location.cancel, operationId, {flag: 'wx', mode: 0o600});
            yield* syncWritableFile(fs, location.cancel);
            yield* syncDirectoryBestEffort(fs, location.directory);
          }
        }),
      );
      value = (yield* readReceipt(scope.config, operationId)) ?? value;
      yield* scope.assert;
      // Cancellation is a separate intent, never an authorization or a stage rewrite.
      // Only pre-go workers are stopped; an authorized writer finishes required durability.
      if (!value.authorized && !terminal(value)) {
        const system = yield* SystemInfo;
        const observed = yield* observeCanonicalProcessInstanceIdentity(system, value.processId);
        yield* scope.assert;
        if (observed === value.processStartIdentity)
          yield* Effect.sync(() => system.signalProcess(value!.processId, 'SIGTERM')).pipe(Effect.ignore);
      }
    }
    const alive = yield* sameLiveOwner(value);
    yield* scope.assert;
    const result = value.stage === 'complete' && alive ? pendingResult(operationId, true) : resultForReceipt(value);
    return {
      ...result,
      structuredContent: {
        ...result.structuredContent,
        sequence: value.sequence,
        stage: value.stage,
        alive,
        state:
          value.stage === 'complete' && alive
            ? 'pending'
            : terminal(value)
              ? value.stage
              : alive
                ? 'pending'
                : 'unknown',
        updatedAt: value.updatedAt,
        authorized: value.authorized,
        possiblyApplied: value.possiblyApplied,
        canonicalObserved: value.canonicalObserved,
        lexicalVerified: value.lexicalVerified,
        ...(cancel ? {cancellationRequested: true} : {}),
      },
    };
  },
  Effect.catchCauseIf(
    cause => !Cause.hasInterrupts(cause),
    () =>
      Effect.succeed({
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: 'Operation receipt is unavailable or invalid; the outcome is unknown. Do not replay a possibly authorized save.',
          },
        ],
        structuredContent: {state: 'unknown'},
      }),
  ),
);

const parentFrameSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('ready'),
    operationId: handoffSaveOperationIdSchema,
    source: Schema.Unknown,
    processId: Schema.Int,
    processStartIdentity: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('result'),
    operationId: handoffSaveOperationIdSchema,
    source: Schema.Unknown,
    receipt: handoffSaveReceiptSchema,
  }),
]);
const executableStamp = (value: FileSystem.File.Info) => [
  value.dev,
  Option.getOrUndefined(value.ino),
  value.size,
  Option.getOrUndefined(value.mtime)?.getTime(),
];
interface HandoffSaveChild {
  readonly pid: number;
  readonly stdin: {write(value: string): number | Promise<number>; flush(): number | Promise<number>; end(): unknown};
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly kill: (signal?: NodeJS.Signals) => unknown;
}
export const CurrentHandoffSaveSpawn = Context.Reference<
  ((options: {readonly executable: string; readonly environment: NodeJS.ProcessEnv}) => HandoffSaveChild) | undefined
>('threadnote/HandoffSaveSpawn', {defaultValue: () => undefined});
const activeChildren = new Map<number, {readonly child: HandoffSaveChild; authorized: boolean}>();
process.once('exit', () => {
  for (const {child, authorized} of activeChildren.values())
    if (!authorized) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* Process already exited. */
      }
    }
});
const pendingResult = (operationId: string, authorized: boolean): CallToolResult => ({
  content: [
    {
      type: 'text',
      text: authorized
        ? 'Handoff save admitted and pending. Call memory_write_status with this operationId; do not resubmit.'
        : 'Handoff save was not authorized. Inspect memory_write_status before retrying this operation.',
    },
  ],
  structuredContent: {operationId, state: authorized ? 'pending' : 'not-started', authorized},
});

/** Pumps belong to the process supervisor, not the finished MCP request scope. */
function superviseChildFrames(
  child: HandoffSaveChild,
  owned: {authorized: boolean},
  config: RuntimeConfig,
  operationId: string,
  identity: unknown,
) {
  const {
    promise: ready,
    resolve: readyResolve,
    reject: readyReject,
  } = Promise.withResolvers<Extract<typeof parentFrameSchema.Type, {type: 'ready'}>>();
  const {promise: result, resolve: resultResolve, reject: resultReject} = Promise.withResolvers<HandoffSaveReceipt>();
  void ready.catch(() => {});
  void result.catch(() => {});
  let valid = true;
  let seenReady = false;
  void (async () => {
    const next = frameReader(child.stdout);
    for (;;) {
      const raw = await next();
      if (raw === undefined) throw new Error('Handoff pipe closed without a result.');
      const frame = Schema.decodeUnknownSync(parentFrameSchema, {onExcessProperty: 'error'})(raw);
      if (frame.operationId !== operationId || JSON.stringify(frame.source) !== JSON.stringify(identity))
        throw new Error('Handoff worker identity changed.');
      if (frame.type === 'ready') {
        if (seenReady || owned.authorized) throw new Error('Repeated handoff ready frame.');
        seenReady = true;
        readyResolve(frame);
      } else {
        const receipt = frame.receipt;
        if (
          !owned.authorized ||
          receipt.operationId !== operationId ||
          receipt.account !== config.account ||
          receipt.user !== config.user ||
          receipt.processId !== child.pid
        )
          throw new Error('Handoff result scope changed.');
        await child.exited;
        resultResolve(receipt);
        return;
      }
    }
  })().catch(error => {
    valid = false;
    readyReject(error);
    resultReject(error);
  });
  return {ready, result, valid: () => valid};
}

/** No parent receipt writes. The in-memory authorization latch precedes the go frame. */
export const launchOwnedHandoffSave = Effect.fn('handoffSave.launch')(function* (
  config: RuntimeConfig,
  args: Readonly<Record<string, unknown>>,
) {
  const identity = compiledHandoffSaveIdentity();
  if (!identity) return yield* Effect.die(new Error('Owned saves require a qualified compiled runtime.'));
  const system = yield* SystemInfo;
  const fs = yield* FileSystem.FileSystem;
  const spawn = yield* CurrentHandoffSaveSpawn;
  const operationId = yield* (yield* Crypto.Crypto).randomUUIDv4();
  let owned: {child: HandoffSaveChild; authorized: boolean} | undefined;
  const stopUnapproved = Effect.sync(() => {
    if (owned && !owned.authorized) {
      try {
        owned.child.stdin.end();
        owned.child.kill('SIGTERM');
      } catch {
        /* Exact handle already exited. */
      }
    }
  });
  const prepare = Effect.gen(function* () {
    const before = yield* fs.stat(system.executablePath);
    const environment = {...system.environment(), THREADNOTE_HANDOFF_SAVE_HOME: config.agentContextHome};
    const child = yield* Effect.sync(() =>
      spawn
        ? spawn({executable: system.executablePath, environment})
        : Bun.spawn({
            cmd: [system.executablePath, HANDOFF_SAVE_WORKER_ARGUMENT],
            env: environment,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'ignore',
          }),
    );
    const owner = {child, authorized: false};
    owned = owner;
    activeChildren.set(child.pid, owner);
    void child.exited.finally(() => {
      if (activeChildren.get(child.pid) === owner) activeChildren.delete(child.pid);
    });
    const frames = superviseChildFrames(child, owner, config, operationId, identity);
    yield* fromPromise('handoffSave.sendRequest', async () => {
      await child.stdin.write(
        JSON.stringify({
          protocol: 1,
          operationId,
          source: identity,
          config: {
            account: config.account,
            user: config.user,
            agentId: config.agentId,
            agentContextHome: config.agentContextHome,
            manifestPath: config.manifestPath,
          },
          args,
        }) + '\n',
      );
      await child.stdin.flush();
    });
    const frame = yield* fromPromise('handoffSave.ready', () => frames.ready);
    const observed = yield* observeCanonicalProcessInstanceIdentity(system, child.pid);
    const after = yield* fs.stat(system.executablePath);
    if (
      !frames.valid() ||
      frame.processId !== child.pid ||
      !observed ||
      observed !== frame.processStartIdentity ||
      EffectArray.some(executableStamp(before), (value, index) => value !== executableStamp(after)[index])
    )
      return yield* HandoffSaveOperationError.make({message: 'Handoff executable or process instance changed.'});
    return {owner, frames};
  });
  return yield* Effect.gen(function* () {
    const ready = yield* prepare.pipe(Effect.timeoutOption(HANDOFF_SAVE_READY_MILLISECONDS));
    if (Option.isNone(ready)) return pendingResult(operationId, false);
    const {owner, frames} = ready.value;
    // No await, mutation or durable I/O may intervene between the latch and go authorization.
    owner.authorized = true;
    const completed = yield* fromPromise('handoffSave.goAndResult', async () => {
      await owner.child.stdin.write(JSON.stringify({protocol: 1, type: 'go', operationId, source: identity}) + '\n');
      await owner.child.stdin.flush();
      await owner.child.stdin.end();
      return await frames.result;
    }).pipe(Effect.timeoutOption(HANDOFF_SAVE_RESULT_MILLISECONDS));
    return Option.isSome(completed) ? resultForReceipt(completed.value) : pendingResult(operationId, true);
  }).pipe(
    Effect.catchCauseIf(
      cause => !Cause.hasInterrupts(cause),
      () => Effect.succeed(pendingResult(operationId, owned?.authorized === true)),
    ),
    Effect.ensuring(stopUnapproved),
  );
});

/** A bounded streaming reader: one request and one decision; no body is persisted. */
function frameReader(stream: ReadableStream<Uint8Array>) {
  const iterator = stream[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    for (;;) {
      const end = Option.getOrElse(EffectString.indexOf('\n')(buffer), () => -1);
      if (end >= 0) {
        const frame: unknown = JSON.parse(EffectString.slice(0, end)(buffer));
        buffer = EffectString.slice(end + 1)(buffer);
        return frame;
      }
      const next = await iterator.next();
      if (next.done) return undefined;
      buffer += decoder.decode(next.value, {stream: true});
      if (Buffer.byteLength(buffer) > HANDOFF_SAVE_RECEIPT_BYTES) throw new Error('Oversized handoff request.');
    }
  };
}
const workerRequestSchema = Schema.Struct({
  protocol: Schema.Literal(1),
  operationId: handoffSaveOperationIdSchema,
  source: Schema.Unknown,
  args: Schema.Record(Schema.String, Schema.Unknown),
  config: Schema.Struct({
    account: Schema.String,
    user: Schema.String,
    agentId: Schema.String,
    agentContextHome: Schema.String,
    manifestPath: Schema.String,
  }),
});
const goSchema = Schema.Struct({
  protocol: Schema.Literal(1),
  type: Schema.Literal('go'),
  operationId: handoffSaveOperationIdSchema,
  source: Schema.Unknown,
});

export const runHandoffSaveWorker = Effect.fn('handoffSave.worker')(function* () {
  const identity = compiledHandoffSaveIdentity();
  if (!identity) return;
  const next = frameReader(Bun.stdin.stream());
  const request = yield* fromPromise('handoffSave.readRequest', next).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(workerRequestSchema)),
  );
  if (JSON.stringify(request.source) !== JSON.stringify(identity)) return;
  const {operationId, args} = request;
  if (!eligibleOwnedHandoff(args, request.config.user)) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const home = yield* fs.realPath(request.config.agentContextHome);
  const config = {...request.config, agentContextHome: home};
  if ((yield* fs.realPath(system.environment().THREADNOTE_HANDOFF_SAVE_HOME ?? '')) !== home) return;
  const start = yield* observeCanonicalProcessInstanceIdentity(system, system.processId);
  if (!start) return;
  const scope = yield* privateScope(config, true);
  if (!scope) return;
  const location = paths(path, scope.config, operationId);
  let value: HandoffSaveReceipt = {
    format: 'threadnote-handoff-save',
    version: 1,
    operationId,
    account: config.account,
    user: config.user,
    source: identity,
    intentDigest: sha256HexSync(JSON.stringify(args)),
    processId: system.processId,
    processStartIdentity: start,
    sequence: 0,
    updatedAt: yield* Clock.currentTimeMillis,
    stage: 'preparing',
    goPossible: false,
    authorized: false,
    possiblyApplied: false,
    canonicalObserved: false,
    lexicalVerified: false,
  };
  const persist = (patch: Partial<HandoffSaveReceipt>) =>
    Effect.gen(function* () {
      if (terminal(value)) return;
      const updated = {
        ...value,
        ...patch,
        sequence: value.sequence + 1,
        updatedAt: Math.max(yield* Clock.currentTimeMillis, value.updatedAt),
      };
      yield* writeReceipt(config, updated, scope, value);
      value = updated;
    });
  const admitted = yield* withExclusiveFileLock(
    fs,
    location.intake,
    lockOptions,
    Effect.gen(function* () {
      yield* scope.assert;
      let previousOwner: string | undefined;
      if (yield* fs.exists(location.owner)) {
        const bytes = yield* fromPromise('handoffSave.owner', () =>
          runtimeReadBoundedStableRegularFile(location.owner, 2048),
        );
        const parsed: unknown = yield* Effect.try(() => JSON.parse(new TextDecoder().decode(bytes)));
        const owner = yield* Schema.decodeUnknownEffect(intakeOwnerSchema, {onExcessProperty: 'error'})(parsed);
        if (yield* sameLiveOwner(owner)) return false;
        if (owner.user === config.user) previousOwner = owner.operationId;
      }
      const directory = yield* fromPromise('handoffSave.history', () =>
        runtimeOpenTextDirectoryNameReader(location.directory, {entryKind: 'file'}),
      );
      let count = 0;
      let pages = 0;
      const names = new Set<string>();
      const eligible: HandoffSaveReceipt[] = [];
      try {
        for (;;) {
          if (++pages > 4) return false;
          const page = yield* fromPromise('handoffSave.historyPage', () => directory.readPage(64));
          for (const name of page.names) {
            names.add(name);
            if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
            if (++count > HANDOFF_SAVE_HISTORY_LIMIT) return false;
            const oldId = EffectString.slice(0, -5)(name);
            const old = yield* readReceipt(config, oldId);
            if (
              old &&
              old.operationId !== previousOwner &&
              !(yield* sameLiveOwner(old)) &&
              (terminal(old) || !old.goPossible) &&
              !(yield* fs.exists(paths(path, config, oldId).decision))
            )
              eligible.push(old);
          }
          if (page.done) break;
        }
      } finally {
        yield* fromPromise('handoffSave.closeHistory', () => directory.close());
      }
      // Retain recent results below capacity, including results not yet collected by their caller.
      eligible.sort(
        (left, right) => left.updatedAt - right.updatedAt || (left.operationId < right.operationId ? -1 : 1),
      );
      for (const old of EffectArray.take(eligible, 4)) {
        if (count < HANDOFF_SAVE_HISTORY_LIMIT) break;
        const previous = paths(path, config, old.operationId);
        yield* scope.assert;
        if (names.has(old.operationId + '.cancel')) {
          const cancel = new TextDecoder().decode(
            yield* fromPromise('handoffSave.retiredCancel', () =>
              runtimeReadBoundedStableRegularFile(previous.cancel, 256),
            ),
          );
          if (cancel !== old.operationId) continue;
          yield* fs.remove(previous.cancel);
        }
        yield* fs.remove(previous.receipt);
        count--;
      }
      if (count >= HANDOFF_SAVE_HISTORY_LIMIT) return false;
      yield* writeReceipt(config, value, scope);
      const temporary =
        location.owner + '.' + operationId + '.' + (yield* (yield* Crypto.Crypto).randomUUIDv4()) + '.tmp';
      yield* scope.assert;
      yield* fs.writeFileString(
        temporary,
        JSON.stringify({operationId, user: config.user, processId: system.processId, processStartIdentity: start}),
        {flag: 'wx', mode: 0o600},
      );
      yield* syncWritableFile(fs, temporary);
      yield* scope.assert;
      yield* fs.rename(temporary, location.owner);
      yield* syncDirectoryBestEffort(fs, location.directory);
      return true;
    }),
  );
  if (!admitted) return;
  const send = (frame: object) =>
    fromPromise('handoffSave.send', async () => {
      await Bun.write(Bun.stdout, JSON.stringify({...frame, operationId, source: identity}) + '\n');
    });
  const observerContext = yield* Effect.context<import('../effect/runtime.js').ApplicationServices>();
  const gate = (prepared: import('../mcp/server/memory.js').PreparedPersonalMemoryWrite) =>
    Effect.gen(function* () {
      if (value.goPossible) return yield* Effect.die(new Error('Repeated handoff mutation gate.'));
      const {canonicalMemoryDocumentContent} = yield* Effect.promise(() => import('@threadnote/memory/document'));
      yield* persist({
        stage: 'prepared',
        goPossible: true,
        ...(prepared.sourceWitnesses ? {sourceWitnesses: prepared.sourceWitnesses} : {}),
        prepared: {
          uri: prepared.memoryUri,
          memoryId: prepared.finalMetadata.memoryId!,
          desiredRevision: sha256HexSync(canonicalMemoryDocumentContent(prepared.memory)),
          ...(prepared.expectedReplaceContent === undefined
            ? {}
            : {previousRevision: sha256HexSync(canonicalMemoryDocumentContent(prepared.expectedReplaceContent))}),
        },
      });
      yield* send({type: 'ready', processId: system.processId, processStartIdentity: start});
      const decision = yield* fromPromise('handoffSave.readDecision', next);
      const go =
        Schema.is(goSchema)(decision) &&
        decision.operationId === operationId &&
        JSON.stringify(decision.source) === JSON.stringify(identity);
      yield* scope.assert;
      const authorized = yield* withExclusiveFileLock(
        fs,
        location.decision,
        lockOptions,
        Effect.gen(function* () {
          if (!go || (yield* fs.exists(location.cancel))) {
            yield* persist({stage: 'not-started'});
            return false;
          }
          yield* persist({stage: 'authorized', authorized: true});
          return true;
        }),
      );
      if (!authorized) return yield* Effect.die(new Error('Handoff save was not authorized.'));
    }).pipe(Effect.provideContext(observerContext), Effect.orDie);
  const observer = {
    prepared: gate,
    stage: (stage: HandoffSaveStage) =>
      Effect.gen(function* () {
        if (stage === 'canonical-observed' && value.prepared) {
          const [{readMemoryRecordsByUri}, {canonicalMemoryDocumentContent}] = yield* Effect.promise(() =>
            Promise.all([import('../mcp/server/memory.js'), import('@threadnote/memory/document')]),
          );
          const [record] = yield* readMemoryRecordsByUri(config, [value.prepared.uri]);
          const observed =
            record?.metadata.memoryId === value.prepared.memoryId &&
            sha256HexSync(canonicalMemoryDocumentContent(record.content)) === value.prepared.desiredRevision;
          yield* persist({stage, canonicalObserved: observed});
        } else yield* persist({stage, ...(stage === 'canonical-possibly-applied' ? {possiblyApplied: true} : {})});
      }).pipe(Effect.provideContext(observerContext), Effect.orDie),
  };
  const outcome = yield* Effect.gen(function* () {
    const [{EffectMcpServerRegistry}, {registerStoreTool}] = yield* Effect.promise(() =>
      Promise.all([import('../effect/ai/mcp.js'), import('../mcp/server/store.js')]),
    );
    const registry = new EffectMcpServerRegistry();
    registerStoreTool(registry, config, 'remember_context', 'Store memory.');
    const result = yield* registry
      .invokeTool('remember_context', args)
      .pipe(Effect.provideService(CurrentHandoffSaveObserver, observer));
    if (!value.authorized || !value.prepared)
      return yield* Effect.die(new Error('Handoff completed without its required gate.'));
    const [{readMemoryRecordsByUri}, {canonicalMemoryDocumentContent}, {recallIndexStatus}] = yield* Effect.promise(
      () =>
        Promise.all([
          import('../mcp/server/memory.js'),
          import('@threadnote/memory/document'),
          import('@threadnote/recall/index'),
        ]),
    );
    const [record] = yield* readMemoryRecordsByUri(config, [value.prepared.uri]);
    const canonicalObserved =
      record?.metadata.memoryId === value.prepared.memoryId &&
      sha256HexSync(canonicalMemoryDocumentContent(record.content)) === value.prepared.desiredRevision;
    yield* persist({canonicalObserved});
    const lexical = yield* recallIndexStatus(config, false);
    const lexicalVerified = lexical.ready && lexical.generation !== undefined;
    yield* persist({lexicalVerified, ...(lexical.generation ? {lexicalGeneration: lexical.generation} : {})});
    if (result.isError || !canonicalObserved || !lexicalVerified)
      return yield* Effect.die(new Error('Required handoff outcome is not verified.'));
    const cleanup =
      result.structuredContent !== undefined &&
      result.structuredContent !== null &&
      typeof result.structuredContent === 'object' &&
      'replacementCleanupPending' in result.structuredContent &&
      result.structuredContent.replacementCleanupPending === true;
    const response = yield* Schema.decodeUnknownEffect(handoffSaveResponseSchema)(result);
    yield* persist({
      stage: 'complete',
      response,
      result: {memoryUri: value.prepared.uri, replacementCleanupPending: cleanup},
    });
  }).pipe(Effect.exit);
  if (outcome._tag === 'Failure' && !terminal(value))
    yield* persist({stage: value.authorized ? 'failed' : 'not-started'});
  yield* send({type: 'result', receipt: value});
});
