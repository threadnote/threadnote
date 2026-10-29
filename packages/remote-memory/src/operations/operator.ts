import {Console, Effect} from 'effect';
import {readOperatorJson, writeOperatorJsonExclusive} from '../operator/files.js';
import {
  buildOperationsManifest,
  operationsEvidenceTemplate,
  verifyOperationsEvidence,
  verifyOperationsReceipt,
} from '../operations.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const runOperationsFileCommand = Effect.fn('remoteMemory.operations.fileCommand')(function* (
  command: string,
  arguments_: readonly string[],
) {
  return yield* Effect.gen(function* () {
    const options = parseOptions(command, arguments_);
    if (command === 'operations-plan') {
      const raw = yield* readOperatorJson(options.get('input')!);
      const manifest = yield* Effect.try(() => buildOperationsManifest(raw));
      yield* writeOperatorJsonExclusive(options.get('output')!, manifest);
      yield* Console.log(
        JSON.stringify({
          manifestDigest: manifest.manifestDigest,
          status: 'planned',
          providerActions: 'none',
          version: 1,
        }),
      );
      return 0;
    }
    const manifest = yield* readOperatorJson(options.get('manifest')!);
    if (command === 'operations-template') {
      const evidence = yield* Effect.try(() =>
        operationsEvidenceTemplate(manifest, options.get('drill')!, options.get('target')!),
      );
      yield* writeOperatorJsonExclusive(options.get('output')!, evidence);
      yield* Console.log(JSON.stringify({status: 'pending', providerActions: 'none', version: 1}));
      return 2;
    }
    const evidence = yield* readOperatorJson(options.get('evidence')!);
    const existing =
      command === 'operations-receipt-verify' ? yield* readOperatorJson(options.get('receipt')!) : undefined;
    const receipt = yield* Effect.try(() =>
      command === 'operations-receipt-verify'
        ? verifyOperationsReceipt(manifest, evidence, existing, options.get('at')!)
        : verifyOperationsEvidence(manifest, evidence, options.get('at')!),
    );
    if (command === 'operations-verify') yield* writeOperatorJsonExclusive(options.get('receipt')!, receipt);
    yield* Console.log(JSON.stringify(receipt));
    return receipt.status === 'verified' ? 0 : 2;
  }).pipe(
    Effect.catchCause(() =>
      Console.error('Operations command failed: invalid input or unavailable file.').pipe(Effect.as(1)),
    ),
  );
});

function parseOptions(command: string, arguments_: readonly string[]): ReadonlyMap<string, string> {
  const allowed =
    command === 'operations-plan'
      ? ['input', 'output']
      : command === 'operations-template'
        ? ['manifest', 'drill', 'target', 'output']
        : command === 'operations-verify' || command === 'operations-receipt-verify'
          ? ['manifest', 'evidence', 'at', 'receipt']
          : [];
  const options = new Map<string, string>();
  if (allowed.length === 0 || arguments_.length !== allowed.length * 2) throw new Error('Invalid operations options.');
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    const key = Effect2.pipe(option, EffectString.slice(2));
    if (
      !Effect2.pipe(option, EffectString.startsWith('--')) ||
      !allowed.includes(key) ||
      options.has(key) ||
      !value ||
      Effect2.pipe(value, EffectString.startsWith('--'))
    ) {
      throw new Error('Invalid operations options.');
    }
    options.set(key, value);
  }
  return options;
}
