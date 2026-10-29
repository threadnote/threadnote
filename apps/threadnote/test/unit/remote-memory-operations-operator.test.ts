import {BunCrypto, BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect} from 'vitest';
import {runRemoteMemoryOperator} from '@threadnote/threadnote/remote_memory/operator/main';
import {buildOperationsManifest, operationsEvidenceTemplate} from '@threadnote/remote-memory/operations';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  checkedAt,
  observedOperationsEvidence,
  operationsDraft,
} from '@threadnote/remote-memory/test/helpers/operations-fixtures';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const testLayer = provideTestLayer(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer));
const noDatabase = {
  createAdapter: () => {
    throw new Error('Operations must never create a database adapter.');
  },
};

describe('operations file commands', () => {
  effectIt.effect(
    'plans, creates pending templates, verifies and exclusively writes receipts without database credentials',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-operations-'});
          const draftPath = path.join(root, 'draft.json');
          const manifestPath = path.join(root, 'manifest.json');
          const evidencePath = path.join(root, 'evidence.json');
          const receiptPath = path.join(root, 'receipt.json');
          yield* fs.writeFileString(draftPath, JSON.stringify(operationsDraft()));
          expect(
            yield* runRemoteMemoryOperator(
              ['operations-plan', '--input', draftPath, '--output', manifestPath],
              {},
              noDatabase,
            ),
          ).toBe(0);
          const manifest = buildOperationsManifest(operationsDraft());
          expect(JSON.parse(yield* fs.readFileString(manifestPath))).toEqual(manifest);
          expect(
            yield* runRemoteMemoryOperator(
              [
                'operations-template',
                '--manifest',
                manifestPath,
                '--drill',
                Effect2.pipe('b', EffectString.repeat(32)),
                '--target',
                Effect2.pipe('c', EffectString.repeat(32)),
                '--output',
                evidencePath,
              ],
              {},
              noDatabase,
            ),
          ).toBe(2);
          const pending = operationsEvidenceTemplate(
            manifest,
            Effect2.pipe('b', EffectString.repeat(32)),
            Effect2.pipe('c', EffectString.repeat(32)),
          );
          expect(JSON.parse(yield* fs.readFileString(evidencePath))).toEqual(pending);
          const args = [
            '--manifest',
            manifestPath,
            '--evidence',
            evidencePath,
            '--at',
            checkedAt,
            '--receipt',
            receiptPath,
          ];
          expect(yield* runRemoteMemoryOperator(['operations-verify', ...args], {}, noDatabase)).toBe(2);
          const originalReceipt = yield* fs.readFileString(receiptPath);
          expect(yield* runRemoteMemoryOperator(['operations-receipt-verify', ...args], {}, noDatabase)).toBe(2);
          expect(yield* runRemoteMemoryOperator(['operations-verify', ...args], {}, noDatabase)).toBe(1);
          expect(yield* fs.readFileString(receiptPath)).toBe(originalReceipt);
          expect(yield* fs.readFileString(evidencePath)).toBe(JSON.stringify(pending, undefined, 2) + '\n');

          yield* fs.writeFileString(evidencePath, JSON.stringify(observedOperationsEvidence(manifest)));
          const observedArgs = [...args.slice(0, -1), path.join(root, 'observed-receipt.json')];
          expect(yield* runRemoteMemoryOperator(['operations-verify', ...observedArgs], {}, noDatabase)).toBe(0);
          expect(yield* runRemoteMemoryOperator(['operations-receipt-verify', ...observedArgs], {}, noDatabase)).toBe(
            0,
          );
        }),
      ).pipe(testLayer),
  );

  effectIt.effect('rejects malformed, private, oversized and linked inputs without producing a receipt', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-operations-invalid-'});
        const input = path.join(root, 'input.json');
        const output = path.join(root, 'output.json');
        const args = ['operations-plan', '--input', input, '--output', output];
        for (const content of [
          '{"private-secret":',
          JSON.stringify({...operationsDraft(), rawLog: 'private-secret'}),
          Effect2.pipe('x', EffectString.repeat(4 * 1024 * 1024 + 1)),
        ]) {
          yield* fs.writeFileString(input, content);
          expect(yield* runRemoteMemoryOperator(args, {}, noDatabase)).toBe(1);
          expect(yield* fs.exists(output)).toBe(false);
        }
        yield* fs.writeFileString(input, JSON.stringify(operationsDraft()));
        const linked = path.join(root, 'linked.json');
        yield* fs.symlink(input, linked);
        expect(
          yield* runRemoteMemoryOperator(['operations-plan', '--input', linked, '--output', output], {}, noDatabase),
        ).toBe(1);
        for (const invalidArgs of [
          args.slice(0, -1),
          [...args, '--extra', 'private-secret'],
          ['operations-unknown'],
          ['operations-plan', '--input', input, '--input', output],
        ]) {
          expect(yield* runRemoteMemoryOperator(invalidArgs, {}, noDatabase)).toBe(1);
        }
        expect(yield* fs.exists(output)).toBe(false);
      }),
    ).pipe(testLayer),
  );
});
