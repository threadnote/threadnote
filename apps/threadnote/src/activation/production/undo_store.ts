import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withActivationReceiptLock} from '../lock.js';
import {activationStatePathsV1} from '../store.js';

const MAX_UNDO_RECEIPT_BYTES = 32 * 1_024;

export interface ActivationUndoReceiptV1 {
  readonly activationId: string;
  readonly completedOperationIds: readonly string[];
  readonly operationIds: readonly string[];
  readonly publicationEvidenceHash: string;
  readonly retainedOperationIds: readonly string[];
  readonly revision: string;
  readonly status: 'in-progress' | 'completed';
  readonly type: 'threadnote-activation-undo-receipt';
  readonly undoPlanHash: string;
  readonly version: 1;
}

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const ReceiptSchema = Schema.Struct({
  activationId: Sha256,
  completedOperationIds: Schema.Array(Identifier).check(Schema.isMaxLength(10)),
  operationIds: Schema.Array(Identifier).check(Schema.isMaxLength(10)),
  publicationEvidenceHash: Sha256,
  retainedOperationIds: Schema.Array(Identifier).check(Schema.isMaxLength(10)),
  revision: Sha256,
  status: Schema.Literals(['in-progress', 'completed']),
  type: Schema.Literal('threadnote-activation-undo-receipt'),
  undoPlanHash: Sha256,
  version: Schema.Literal(1),
});

export const readActivationUndoReceiptV1 = Effect.fn('activation.undoStore.read')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  activationId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* undoReceiptPath(config, activationId);
  if (!(yield* fs.exists(target))) return undefined;
  const raw = yield* fs.readFileString(target);
  if (Buffer.byteLength(raw, 'utf8') > MAX_UNDO_RECEIPT_BYTES) throw new Error('Activation undo receipt is oversized.');
  return parseReceipt(JSON.parse(raw) as unknown, activationId);
});

export const initializeActivationUndoReceiptV1 = Effect.fn('activation.undoStore.initialize')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  input: {
    readonly activationId: string;
    readonly operationIds: readonly string[];
    readonly publicationEvidenceHash: string;
    readonly retainedOperationIds: readonly string[];
    readonly undoPlanHash: string;
  },
) {
  return yield* withActivationReceiptLock(
    config.agentContextHome,
    input.activationId,
    Effect.gen(function* () {
      const existing = yield* readActivationUndoReceiptV1(config, input.activationId);
      if (existing !== undefined) {
        if (
          existing.undoPlanHash !== input.undoPlanHash ||
          canonicalJson(existing.operationIds) !== canonicalJson(input.operationIds) ||
          existing.publicationEvidenceHash !== input.publicationEvidenceHash ||
          canonicalJson(existing.retainedOperationIds) !== canonicalJson(input.retainedOperationIds)
        ) {
          throw new Error('Activation undo receipt does not match the current undo plan.');
        }
        return existing;
      }
      const receipt = receiptWithRevision({
        activationId: input.activationId,
        completedOperationIds: [],
        operationIds: input.operationIds,
        publicationEvidenceHash: input.publicationEvidenceHash,
        retainedOperationIds: input.retainedOperationIds,
        status: input.operationIds.length === 0 ? 'completed' : 'in-progress',
        type: 'threadnote-activation-undo-receipt',
        undoPlanHash: input.undoPlanHash,
        version: 1,
      });
      yield* writeReceipt(config, receipt);
      return receipt;
    }),
  );
});

export const recordActivationUndoCompletionV1 = Effect.fn('activation.undoStore.recordCompletion')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  input: {
    readonly activationId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
  },
) {
  return yield* withActivationReceiptLock(
    config.agentContextHome,
    input.activationId,
    Effect.gen(function* () {
      const current = yield* readActivationUndoReceiptV1(config, input.activationId);
      if (current === undefined) throw new Error('Activation undo receipt disappeared.');
      if (current.completedOperationIds.includes(input.operationId)) return current;
      if (current.revision !== input.expectedRevision) throw new Error('Activation undo receipt changed concurrently.');
      if (!current.operationIds.includes(input.operationId))
        throw new Error('Activation undo operation is not planned.');
      const completedOperationIds = EffectArrayPipe(current.operationIds, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (operationId, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues &&
            (current.completedOperationIds.includes(operationId) || operationId === input.operationId),
        ),
      );
      const next = receiptWithRevision({
        activationId: current.activationId,
        completedOperationIds,
        operationIds: current.operationIds,
        publicationEvidenceHash: current.publicationEvidenceHash,
        retainedOperationIds: current.retainedOperationIds,
        status: completedOperationIds.length === current.operationIds.length ? 'completed' : 'in-progress',
        type: current.type,
        undoPlanHash: current.undoPlanHash,
        version: current.version,
      });
      yield* writeReceipt(config, next);
      return next;
    }),
  );
});

function parseReceipt(value: unknown, activationId: string): ActivationUndoReceiptV1 {
  const receipt = Schema.decodeUnknownSync(ReceiptSchema, {errors: 'all', onExcessProperty: 'error'})(value);
  if (receipt.activationId !== activationId) throw new Error('Activation undo receipt target does not match its path.');
  if (new Set(receipt.operationIds).size !== receipt.operationIds.length) throw new Error('Duplicate undo operations.');
  if (new Set(receipt.completedOperationIds).size !== receipt.completedOperationIds.length)
    throw new Error('Duplicate completed undo operations.');
  if (EffectArray.some(receipt.completedOperationIds, operationId => !receipt.operationIds.includes(operationId)))
    throw new Error('Completed undo operation is not planned.');
  const expectedStatus =
    receipt.completedOperationIds.length === receipt.operationIds.length ? 'completed' : 'in-progress';
  if (receipt.status !== expectedStatus) throw new Error('Activation undo receipt status is invalid.');
  const {revision: _, ...body} = receipt;
  if (sha256HexSync(canonicalJson(body)) !== receipt.revision)
    throw new Error('Activation undo receipt hash is invalid.');
  return receipt;
}

function receiptWithRevision(body: Omit<ActivationUndoReceiptV1, 'revision'>): ActivationUndoReceiptV1 {
  return parseReceipt({...body, revision: sha256HexSync(canonicalJson(body))}, body.activationId);
}

const undoReceiptPath = Effect.fn('activation.undoStore.path')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  activationId: string,
) {
  const paths = yield* activationStatePathsV1(config, activationId);
  const path = yield* Path.Path;
  return path.join(paths.root, 'undo.json');
});

const writeReceipt = Effect.fn('activation.undoStore.write')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  receipt: ActivationUndoReceiptV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const target = yield* undoReceiptPath(config, receipt.activationId);
  const temporary = `${target}.${system.processId}.tmp`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(receipt)}\n`, {flag: 'wx', mode: 0o600});
  yield* fs.rename(temporary, target).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});
