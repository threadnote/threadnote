import {BunCrypto, BunFileSystem, BunPath} from '@effect/platform-bun';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect} from 'vitest';
import {
  runRemoteMemoryOperator,
  type RemoteMemoryOperatorRuntime,
} from '@threadnote/threadnote/remote_memory/operator/main';
import type {RemoteMemoryOperatorAdapter} from '@threadnote/remote-memory/operator';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const databaseUrl = 'postgresql://localhost/threadnote';

describe('remote memory operator ci-control command', () => {
  effectIt.effect('rejects control when the adapter does not advertise the capability', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ci-control-'});
        const input = path.join(root, 'action.json');
        const receipt = path.join(root, 'receipt.json');
        let calls = 0;
        yield* fs.writeFileString(input, JSON.stringify({action: 'enable'}));

        const exitCode = yield* runRemoteMemoryOperator(
          ['ci-control', '--input', input, '--receipt', receipt],
          {THREADNOTE_REMOTE_DATABASE_URL: databaseUrl},
          runtime({
            capabilities: capabilities([]),
            controlContextCi: async () => {
              calls += 1;
              return {status: 'enabled'};
            },
          }),
        );

        expect(exitCode).toBe(1);
        expect(calls).toBe(0);
        expect(yield* fs.exists(receipt)).toBe(false);
      }),
    ).pipe(testLayer),
  );

  effectIt.effect('reads bounded action files, forwards the webhook key, and does not overwrite receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ci-control-'});
        const input = path.join(root, 'action.json');
        const receipt = path.join(root, 'receipt.json');
        const action = {action: 'enqueue', repository: 'threadnote'};
        let received: unknown;
        let webhookKey: string | undefined;
        let calls = 0;
        yield* fs.writeFileString(input, JSON.stringify(action));

        const operator = runtime({
          capabilities: capabilities(['manage_context_ci']),
          controlContextCi: async (value, key) => {
            calls += 1;
            received = value;
            webhookKey = key;
            return {jobId: 'job-1', status: 'enqueued', version: 1};
          },
        });
        const environment = {
          THREADNOTE_CONTEXT_CI_WEBHOOK_KEY: 'webhook-key',
          THREADNOTE_REMOTE_DATABASE_URL: databaseUrl,
        };

        expect(
          yield* runRemoteMemoryOperator(['ci-control', '--input', input, '--receipt', receipt], environment, operator),
        ).toBe(0);
        expect(received).toEqual(action);
        expect(webhookKey).toBe('webhook-key');
        expect(JSON.parse(yield* fs.readFileString(receipt))).toEqual({jobId: 'job-1', status: 'enqueued', version: 1});

        expect(
          yield* runRemoteMemoryOperator(['ci-control', '--input', input, '--receipt', receipt], environment, operator),
        ).toBe(1);
        expect(calls).toBe(2);
        expect(JSON.parse(yield* fs.readFileString(receipt))).toEqual({jobId: 'job-1', status: 'enqueued', version: 1});

        const oversized = path.join(root, 'oversized-action.json');
        yield* fs.writeFileString(
          oversized,
          JSON.stringify({action: 'enqueue', value: Effect2.pipe('x', EffectString.repeat(4 * 1024 * 1024))}),
        );
        expect(
          yield* runRemoteMemoryOperator(
            ['ci-control', '--input', oversized, '--receipt', path.join(root, 'oversized-receipt.json')],
            environment,
            operator,
          ),
        ).toBe(1);
        expect(calls).toBe(2);
      }),
    ).pipe(testLayer),
  );

  effectIt.effect('returns exit code 2 for control receipts that need operator attention', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ci-control-'});
        const input = path.join(root, 'action.json');
        const statuses = ['denied', 'queue-full', 'rate-limited'] as const;
        let index = 0;
        yield* fs.writeFileString(input, JSON.stringify({action: 'enqueue'}));
        const operator = runtime({
          capabilities: capabilities(['manage_context_ci']),
          controlContextCi: async () => ({status: statuses[index++], version: 1}),
        });

        for (const status of statuses) {
          const receipt = path.join(root, `${status}.json`);
          expect(
            yield* runRemoteMemoryOperator(
              ['ci-control', '--input', input, '--receipt', receipt],
              {THREADNOTE_REMOTE_DATABASE_URL: databaseUrl},
              operator,
            ),
          ).toBe(2);
          expect(JSON.parse(yield* fs.readFileString(receipt))).toEqual({status, version: 1});
        }
      }),
    ).pipe(testLayer),
  );
});

const testLayer = provideTestLayer(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer));

function capabilities(available: readonly 'manage_context_ci'[]): RemoteMemoryOperatorAdapter['capabilities'] {
  return {available, unavailable: {}, version: 1};
}

function runtime(adapter: RemoteMemoryOperatorAdapter): RemoteMemoryOperatorRuntime {
  return {createAdapter: () => adapter};
}
