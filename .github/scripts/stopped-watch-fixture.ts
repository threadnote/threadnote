import {realpathSync} from 'node:fs';

const source = process.env.WATCH_PROOF_SOURCE;
const fixtureRepo = process.env.WATCH_PROOF_REPO;
const home = process.env.THREADNOTE_HOME;
if (!source || !fixtureRepo || !home) throw new Error('Missing disposable fixture roots');

const {Effect} = await import(source + '/node_modules/effect/dist/index.js');
const {StandaloneBrokerLayer} = await import(source + '/apps/threadnote/src/effect/runtime-bootstrap.ts');
const {runtimeConfigForTest} = await import(source + '/packages/workspace/test/helpers/runtime-config.ts');
const {initializeNativeWatch, attachNativeWatchConsumer, recordNativeWatchLifecycle} = await import(
  source + '/packages/workflow-automations/src/watch.ts'
);
const {withNativeWatchControlLock, writeNativeWatch} = await import(
  source + '/apps/threadnote/src/workflow_automation/watch_store.ts'
);
const {stableJson} = await import(source + '/apps/threadnote/src/workflow_memory/protocol.ts');

const binding = {
  version: 1,
  checkout: realpathSync(fixtureRepo),
  prUrl: 'https://github.com/example/private-watch-fixture/pull/1',
  baseBranch: 'main',
  headBranch: 'fixture',
  wakeup: {host: 'codex', executable: '/usr/bin/codex', threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
};
const digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(stableJson(value)).digest('hex');
const watchId = 'standalone-pr-' + digest({checkout: binding.checkout, prUrl: binding.prUrl}).slice(0, 48);
const owner = 'standalone-' + digest(binding).slice(0, 48);
const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const state = recordNativeWatchLifecycle(
  attachNativeWatchConsumer(initializeNativeWatch(watchId, binding.prUrl, 0), {id: owner, wakeupId: owner}, 0),
  'watcher_error',
  'fixture',
  1,
);
const config = runtimeConfigForTest({agentContextHome: home});
await Effect.runPromise(
  withNativeWatchControlLock(
    config,
    watchId,
    writeNativeWatch(
      config,
      {
        format: 'threadnote-native-watch-runtime',
        version: 1,
        state,
        provider: {pages: []},
        collector: {
          token,
          pid: 0,
          startedAt: 0,
          lastSeenAt: 1,
          nextPollAt: 1,
          status: 'stopped',
          reason: 'stop-requested',
          consecutiveErrors: 0,
        },
        stopRequested: true,
        stopReason: 'superseded',
        supersededBy: 'pr-fixture-successor',
        metrics: {
          requests: 0,
          notModified: 0,
          responseBytes: 0,
          graphqlCost: 0,
          providerMilliseconds: 0,
          sweeps: 0,
          consumerReads: 0,
        },
        notification: {
          consumerId: owner,
          wakeupId: owner,
          target: binding.wakeup,
          notifiedThrough: 0,
          lastConsumerAt: 0,
          outbox: {
            key: watchId + ':1:1',
            first: 1,
            last: 1,
            createdAt: 1,
            attempts: 1,
            nextAttemptAt: 1,
            attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            collectorToken: token,
            status: 'queued',
            receipt: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            consumedThrough: 0,
          },
        },
      },
      null,
    ),
  ).pipe(Effect.provide(StandaloneBrokerLayer)),
);
console.log('threadnote-standalone-watch-v1:' + Buffer.from(stableJson(binding)).toString('base64url'));
