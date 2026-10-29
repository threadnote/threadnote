import {Effect, FileSystem, Path, Schema} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withActivationReceiptLock} from '../lock.js';
import {activationStatePathsV1} from '../store.js';

const MAX_MUTATION_INTENT_BYTES = 8 * 1_024;

export interface ActivationMutationIntentV1 {
  readonly activationId: string;
  readonly afterStateHash?: string;
  readonly beforeStateHash: string;
  readonly operationId: ActivationMutationOperationIdV1;
  readonly ownership: 'activation-created' | 'preexisting';
  readonly phase: 'completed' | 'disowned' | 'prepared';
  readonly revision: string;
  readonly targetHash: string;
  readonly type: 'threadnote-activation-mutation-intent';
  readonly version: 1;
}

export type ActivationMutationOperationIdV1 =
  'surface-primary' | 'surface-secondary' | 'team-share' | `candidate-${string}`;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const IntentSchema = Schema.Struct({
  activationId: Sha256,
  afterStateHash: Schema.optionalKey(Sha256),
  beforeStateHash: Sha256,
  operationId: Schema.Union([
    Schema.Literals(['surface-primary', 'surface-secondary', 'team-share']),
    Schema.String.check(Schema.isPattern(/^candidate-[0-9a-f]{64}$/u)),
  ]),
  ownership: Schema.Literals(['activation-created', 'preexisting']),
  phase: Schema.Literals(['completed', 'disowned', 'prepared']),
  revision: Sha256,
  targetHash: Sha256,
  type: Schema.Literal('threadnote-activation-mutation-intent'),
  version: Schema.Literal(1),
});

export const readActivationMutationIntentV1 = Effect.fn('activation.mutationIntent.read')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  activationId: string,
  operationId: ActivationMutationIntentV1['operationId'],
) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* mutationIntentPath(config, activationId, operationId);
  if (!(yield* fs.exists(target))) return undefined;
  const raw = yield* fs.readFileString(target);
  if (Buffer.byteLength(raw, 'utf8') > MAX_MUTATION_INTENT_BYTES) {
    throw new Error('Activation mutation intent is oversized.');
  }
  return parseIntent(JSON.parse(raw) as unknown, activationId, operationId);
});

export const prepareActivationMutationIntentV1 = Effect.fn('activation.mutationIntent.prepare')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  input: Pick<
    ActivationMutationIntentV1,
    'activationId' | 'beforeStateHash' | 'operationId' | 'ownership' | 'targetHash'
  >,
) {
  return yield* withActivationReceiptLock(
    config.agentContextHome,
    input.activationId,
    Effect.gen(function* () {
      const existing = yield* readActivationMutationIntentV1(config, input.activationId, input.operationId);
      if (existing !== undefined) {
        if (existing.targetHash !== input.targetHash) {
          throw new Error('Activation mutation intent target changed after preparation.');
        }
        if (
          existing.phase !== 'prepared' ||
          (existing.beforeStateHash === input.beforeStateHash && existing.ownership === input.ownership)
        ) {
          return existing;
        }
        const disowned = intentWithRevision({
          ...withoutRevision(existing),
          afterStateHash: input.beforeStateHash,
          ownership: 'preexisting',
          phase: 'disowned',
        });
        yield* writeIntent(config, disowned);
        return disowned;
      }
      const intent = intentWithRevision({
        ...input,
        phase: 'prepared',
        type: 'threadnote-activation-mutation-intent' as const,
        version: 1 as const,
      });
      yield* writeIntent(config, intent);
      return intent;
    }),
  );
});

export const completeActivationMutationIntentV1 = Effect.fn('activation.mutationIntent.complete')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  input: {
    readonly activationId: string;
    readonly afterStateHash: string;
    readonly expectedRevision: string;
    readonly operationId: ActivationMutationIntentV1['operationId'];
  },
) {
  return yield* withActivationReceiptLock(
    config.agentContextHome,
    input.activationId,
    Effect.gen(function* () {
      const current = yield* readActivationMutationIntentV1(config, input.activationId, input.operationId);
      if (current === undefined) throw new Error('Activation mutation intent disappeared before completion.');
      if (current.phase === 'completed') {
        if (current.afterStateHash !== input.afterStateHash) {
          throw new Error('Completed activation mutation evidence changed.');
        }
        return current;
      }
      if (current.revision !== input.expectedRevision) {
        throw new Error('Activation mutation intent changed concurrently.');
      }
      const completed = intentWithRevision({
        ...withoutRevision(current),
        afterStateHash: input.afterStateHash,
        phase: 'completed',
      });
      yield* writeIntent(config, completed);
      return completed;
    }),
  );
});

function isActivationMutationOperationIdV1(value: string): value is ActivationMutationOperationIdV1 {
  return (
    value === 'surface-primary' ||
    value === 'surface-secondary' ||
    value === 'team-share' ||
    /^candidate-[0-9a-f]{64}$/u.test(value)
  );
}

export function activationCandidateMutationOperationIdV1(reviewId: string, candidateId: string) {
  return `candidate-${sha256HexSync(canonicalJson({candidateId, reviewId, version: 1}))}` as const;
}

function parseIntent(
  value: unknown,
  activationId: string,
  operationId: ActivationMutationIntentV1['operationId'],
): ActivationMutationIntentV1 {
  const decoded = Schema.decodeUnknownSync(IntentSchema, {errors: 'all', onExcessProperty: 'error'})(value);
  const decodedOperationId = decoded.operationId;
  if (!isActivationMutationOperationIdV1(decodedOperationId)) {
    throw new Error('Activation mutation intent operation ID is invalid.');
  }
  const intent = {...decoded, operationId: decodedOperationId};
  if (intent.activationId !== activationId || intent.operationId !== operationId) {
    throw new Error('Activation mutation intent target does not match its path.');
  }
  const {revision: _, ...body} = intent;
  if (sha256HexSync(canonicalJson(body)) !== intent.revision) {
    throw new Error('Activation mutation intent hash is invalid.');
  }
  if (
    (intent.phase === 'prepared' && intent.afterStateHash !== undefined) ||
    (intent.phase !== 'prepared' && intent.afterStateHash === undefined) ||
    (intent.phase === 'disowned' && intent.ownership !== 'preexisting')
  ) {
    throw new Error('Activation mutation intent phase evidence is invalid.');
  }
  return intent;
}

function intentWithRevision(body: Omit<ActivationMutationIntentV1, 'revision'>): ActivationMutationIntentV1 {
  return parseIntent({...body, revision: sha256HexSync(canonicalJson(body))}, body.activationId, body.operationId);
}

function withoutRevision(intent: ActivationMutationIntentV1): Omit<ActivationMutationIntentV1, 'revision'> {
  const {revision: _, ...body} = intent;
  return body;
}

const mutationIntentPath = Effect.fn('activation.mutationIntent.path')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  activationId: string,
  operationId: ActivationMutationIntentV1['operationId'],
) {
  const paths = yield* activationStatePathsV1(config, activationId);
  const path = yield* Path.Path;
  return path.join(paths.root, 'mutation-intents', `${operationId}.json`);
});

const writeIntent = Effect.fn('activation.mutationIntent.write')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  intent: ActivationMutationIntentV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const target = yield* mutationIntentPath(config, intent.activationId, intent.operationId);
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  const temporary = `${target}.${system.processId}.tmp`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(intent)}\n`, {flag: 'wx', mode: 0o600});
  yield* fs.rename(temporary, target).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});
