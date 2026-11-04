import {it as effectIt, expect} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {memoryLaunchUri} from '@threadnote/memory/navigation-link';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {MemoryPreviewRead, runMemoryPreview} from '../../src/preview/server.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const launchUri = memoryLaunchUri({kind: 'id', ref: 'tn_startup_test'});
const unusedConfig: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-preview-startup-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-preview-startup-test/seed-manifest.yaml',
  user: 'tester',
};
const provide = provideTestLayer(
  Layer.merge(
    ApplicationLayer,
    Layer.succeed(MemoryPreviewRead, {
      read: async () => {
        throw new Error('unused');
      },
    }),
  ),
);

effectIt.effect('reports a bounded bind error without exposing its cause in the user message', () =>
  Effect.gen(function* () {
    const error = yield* runMemoryPreview(unusedConfig, launchUri, {
      listen: () => {
        throw new Error('sensitive bind detail');
      },
    }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toContain('Retry');
    expect(error.message).not.toContain('sensitive bind detail');
    expect(error.cause).toBeInstanceOf(Error);
  }).pipe(provide),
);

effectIt.effect('closes a bound listener when the OS opener fails', () =>
  Effect.gen(function* () {
    let stopped = false;
    const error = yield* runMemoryPreview(unusedConfig, launchUri, {
      listen: () => ({
        port: 43118,
        stop: () => {
          stopped = true;
        },
      }),
      openUrl: () => Effect.die(new Error('sensitive opener detail')),
    }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toContain('threadnote doctor');
    expect(error.message).not.toContain('sensitive opener detail');
    expect(stopped).toBe(true);
  }).pipe(provide),
);

effectIt.effect('stops the preview listener at its idle deadline', () =>
  Effect.gen(function* () {
    let stopped = false;
    yield* runMemoryPreview(unusedConfig, launchUri, {
      listen: () => ({
        port: 43119,
        stop: () => {
          stopped = true;
        },
      }),
      openUrl: () => Effect.void,
      idleMs: 5,
    });
    expect(stopped).toBe(true);
  }).pipe(TestClock.withLive, provide),
);
