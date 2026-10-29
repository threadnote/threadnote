import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {existsSync} from '@threadnote/testing/node-fs';
import {spawn, type ChildProcess} from '@threadnote/testing/node-child-process';
import {join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {Effect, Path} from 'effect';
import {expect} from 'vitest';
import {prepareCodeGraphFixture} from '../../../../scripts/code-graph-fixture.js';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphStore} from '@threadnote/graph/store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

interface HeldWriter {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly stderr: () => string;
}

effectIt.effect('serves parallel ready-snapshot reads while another process holds the WAL writer', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* prepareCodeGraphFixture('code-graph-v1');
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;
      const path = yield* Path.Path;
      const indexed = yield* indexer.index({cwd: fixture.repository, threadnoteHome: fixture.home});
      const databasePath = codeGraphLayout(
        path,
        fixture.home,
        indexed.identity.checkoutId,
        indexed.identity.worktreeId,
      ).databasePath;
      const marker = path.join(fixture.root, '.held-writer-ready');
      const writer = yield* Effect.acquireRelease(
        Effect.sync(() => startHeldWriter(databasePath, marker)),
        stopHeldWriter,
      );
      yield* Effect.tryPromise({
        try: () => waitForWriter(marker, writer),
        catch: cause => TestError.make({message: 'Held SQLite writer did not become ready.', cause}),
      });

      const snapshots = yield* Effect.all(
        Array.from({length: 8}, () => store.readySnapshot(databasePath, indexed.identity.worktreeId)),
        {concurrency: 'unbounded'},
      );

      expect(writer.child.exitCode).toBeNull();
      expect(writer.child.signalCode).toBeNull();
      expect(snapshots).toHaveLength(8);
      expect(EffectArray.every(snapshots, snapshot => snapshot?.id === indexed.snapshot.id)).toBe(true);
    }),
  ).pipe(provideTestLayer(ApplicationLayer)),
);

function startHeldWriter(databasePath: string, markerPath: string): HeldWriter {
  const helper = join(import.meta.dirname, '../../../../packages/testing/src/code-graph-held-writer-child.ts');
  const child = spawn(process.execPath, [helper, databasePath, markerPath], {
    cwd: process.cwd(),
    env: {...process.env, NODE_ENV: 'test'},
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => (stderr += String(chunk)));
  const exited = new Promise<void>(resolve => {
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
  return {child, exited, stderr: () => stderr};
}

function stopHeldWriter(writer: HeldWriter): Effect.Effect<void> {
  return Effect.promise(async () => {
    if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill();
    await writer.exited;
  });
}

async function waitForWriter(markerPath: string, writer: HeldWriter): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(markerPath)) {
    if (writer.child.exitCode !== null || writer.child.signalCode !== null) {
      throw TestError.make({message: `Held-writer child exited before acquiring SQLite: ${writer.stderr()}`});
    }
    if (Date.now() >= deadline)
      throw TestError.make({message: `Timed out waiting for held-writer marker: ${writer.stderr()}`});
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
