import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {SystemInfo} from '@threadnote/platform/system';
import {withActivationReceiptLock} from './lock.js';
import {
  parseActivationPlanV1,
  parseActivationReceiptV1,
  type ActivationPlanV1,
  type ActivationReceiptV1,
} from './contract.js';

const MAX_ACTIVATION_STATE_BYTES = 64 * 1024;

export class ActivationStoreError extends Schema.TaggedError<ActivationStoreError, {readonly brand: unique symbol}>()(
  'ActivationStoreError',
  {
    message: Schema.String,
  },
) {}

export interface ActivationStateV1 {
  readonly plan: ActivationPlanV1;
  readonly receipt: ActivationReceiptV1;
}

export interface ActivationReceiptCasConflictV1 {
  readonly actualRevision: string;
  readonly status: 'conflict';
}

export interface ActivationReceiptCasUpdatedV1 {
  readonly receipt: ActivationReceiptV1;
  readonly status: 'updated';
}

export type ActivationReceiptCasResultV1 = ActivationReceiptCasConflictV1 | ActivationReceiptCasUpdatedV1;

export const activationStatePathsV1 = Effect.fn('activation.store.paths')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  activationId: string,
) {
  assertActivationId(activationId);
  const path = yield* Path.Path;
  const root = path.join(path.resolve(config.agentContextHome), 'activation', 'states', activationId);
  return {plan: path.join(root, 'plan.json'), receipt: path.join(root, 'receipt.json'), root};
});

/** Read-only status lookup. It never creates directories, locks, or writes state. */
export const readActivationStateV1 = Effect.fn('activation.store.read')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  activationId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* activationStatePathsV1(config, activationId);
  const planRaw = yield* readBoundedOptional(fs, paths.plan);
  const receiptRaw = yield* readBoundedOptional(fs, paths.receipt);
  if (planRaw === undefined && receiptRaw === undefined) return undefined;
  if (planRaw === undefined || receiptRaw === undefined) {
    return yield* ActivationStoreError.make({message: `Activation ${activationId} has incomplete private state.`});
  }
  const plan = yield* decodePlan(planRaw, activationId);
  const receipt = yield* decodeReceipt(receiptRaw, activationId);
  if (plan.activationId !== receipt.activationId || plan.planHash !== receipt.planHash) {
    return yield* ActivationStoreError.make({message: `Activation ${activationId} plan and receipt do not agree.`});
  }
  return {plan, receipt} satisfies ActivationStateV1;
});

/** Create a private plan/receipt pair once, or return the exact already-persisted pair. */
export const initializeActivationStateV1 = Effect.fn('activation.store.initialize')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  suppliedPlan: ActivationPlanV1,
  suppliedReceipt: ActivationReceiptV1,
) {
  const plan = parseActivationPlanV1(suppliedPlan);
  const receipt = parseActivationReceiptV1(suppliedReceipt);
  if (receipt.activationId !== plan.activationId || receipt.planHash !== plan.planHash) {
    return yield* ActivationStoreError.make({message: 'Activation plan and receipt must have the same target.'});
  }
  return yield* withActivationReceiptLock(
    config.agentContextHome,
    plan.activationId,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* activationStatePathsV1(config, plan.activationId);
      const planRaw = yield* readBoundedOptional(fs, paths.plan);
      const receiptRaw = yield* readBoundedOptional(fs, paths.receipt);
      if (planRaw !== undefined && receiptRaw !== undefined) {
        const existingPlan = yield* decodePlan(planRaw, plan.activationId);
        const existingReceipt = yield* decodeReceipt(receiptRaw, plan.activationId);
        const existing = {plan: existingPlan, receipt: existingReceipt};
        if (existing.plan.planHash !== plan.planHash) {
          return yield* ActivationStoreError.make({
            message: `Activation ${plan.activationId} input drift was detected.`,
          });
        }
        return existing;
      }
      if (planRaw !== undefined) {
        const existingPlan = yield* decodePlan(planRaw, plan.activationId);
        if (existingPlan.planHash !== plan.planHash || !isInitialReceipt(receipt)) {
          return yield* ActivationStoreError.make({
            message: `Activation ${plan.activationId} has unsafe partial state.`,
          });
        }
        yield* atomicPrivateWrite(fs, paths.receipt, json(receipt));
        return {plan: existingPlan, receipt} satisfies ActivationStateV1;
      }
      if (receiptRaw !== undefined) {
        const existingReceipt = yield* decodeReceipt(receiptRaw, plan.activationId);
        if (existingReceipt.planHash !== plan.planHash || !isInitialReceipt(existingReceipt)) {
          return yield* ActivationStoreError.make({
            message: `Activation ${plan.activationId} has unsafe partial state.`,
          });
        }
        yield* atomicPrivateWrite(fs, paths.plan, json(plan));
        return {plan, receipt: existingReceipt} satisfies ActivationStateV1;
      }
      yield* atomicPrivateWrite(fs, paths.plan, json(plan));
      yield* atomicPrivateWrite(fs, paths.receipt, json(receipt));
      return {plan, receipt} satisfies ActivationStateV1;
    }),
  );
});

/** Compare-and-swap a receipt revision while holding only this activation's lock. */
export const compareAndSetActivationReceiptV1 = Effect.fn('activation.store.compareAndSet')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  activationId: string,
  expectedRevision: string,
  suppliedReceipt: ActivationReceiptV1,
) {
  assertActivationId(activationId);
  const next = parseActivationReceiptV1(suppliedReceipt);
  if (next.activationId !== activationId) {
    return yield* ActivationStoreError.make({message: 'Activation receipt target does not match its storage target.'});
  }
  return yield* withActivationReceiptLock(
    config.agentContextHome,
    activationId,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* activationStatePathsV1(config, activationId);
      const current = yield* readActivationStateV1(config, activationId);
      if (current === undefined)
        return yield* ActivationStoreError.make({message: `Activation ${activationId} was not found.`});
      if (current.receipt.revision !== expectedRevision) {
        return {actualRevision: current.receipt.revision, status: 'conflict'} satisfies ActivationReceiptCasConflictV1;
      }
      if (current.plan.planHash !== next.planHash) {
        return yield* ActivationStoreError.make({
          message: `Activation ${activationId} receipt plan drift was detected.`,
        });
      }
      yield* atomicPrivateWrite(fs, paths.receipt, json(next));
      return {receipt: next, status: 'updated'} satisfies ActivationReceiptCasUpdatedV1;
    }),
  );
});

function decodePlan(content: string, activationId: string) {
  return Effect.try({
    catch: () => ActivationStoreError.make({message: `Activation ${activationId} has an invalid plan state.`}),
    try: () => {
      const plan = parseActivationPlanV1(JSON.parse(content));
      if (plan.activationId !== activationId) throw new Error('target mismatch');
      return plan;
    },
  });
}

function decodeReceipt(content: string, activationId: string) {
  return Effect.try({
    catch: () => ActivationStoreError.make({message: `Activation ${activationId} has an invalid receipt state.`}),
    try: () => {
      const receipt = parseActivationReceiptV1(JSON.parse(content));
      if (receipt.activationId !== activationId) throw new Error('target mismatch');
      return receipt;
    },
  });
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function isInitialReceipt(receipt: ActivationReceiptV1): boolean {
  return (
    receipt.generation === 0 &&
    receipt.status === 'pending' &&
    EffectArray.every(receipt.operations, operation => operation.status === 'pending')
  );
}

function assertActivationId(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('Activation storage requires a SHA-256 activation ID.');
}

function readBoundedOptional(fs: FileSystem.FileSystem, target: string) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(target))) return undefined;
    const content = yield* fs.readFileString(target);
    if (Buffer.byteLength(content, 'utf8') > MAX_ACTIVATION_STATE_BYTES) {
      return yield* ActivationStoreError.make({
        message: `Activation state exceeds ${MAX_ACTIVATION_STATE_BYTES} bytes.`,
      });
    }
    return content;
  });
}

function atomicPrivateWrite(fs: FileSystem.FileSystem, target: string, content: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const parent = path.dirname(target);
    const temporary = `${target}.threadnote-${system.processId}.tmp`;
    yield* fs.makeDirectory(parent, {mode: 0o700, recursive: true});
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
      yield* fs.rename(temporary, target);
    }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  });
}
