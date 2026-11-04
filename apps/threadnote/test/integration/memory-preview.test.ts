import {describe, expect, it} from '@effect/vitest';
import {Cause, Effect, Exit, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {memoryLaunchUri} from '@threadnote/memory/navigation-link';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {createMemoryPreviewHandler, MemoryPreviewRead, runMemoryPreview} from '../../src/preview/server.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const origin = 'http://127.0.0.1:41377';
const token = 'private-test-token';
const node = {
  isDir: false,
  isShared: false,
  isSystem: false,
  name: 'preview.md',
  relativePath: 'durable/projects/test/preview.md',
  uri: 'threadnote://user/alice/memories/durable/projects/test/preview.md',
};

describe('fixed-target memory preview HTTP handler', () => {
  it('re-reads the fixed memory on each authorized reload and never caches unavailable content', async () => {
    let content = '# Original';
    let reads = 0;
    const handler = createMemoryPreviewHandler({
      token,
      port: () => 41377,
      read: async () => {
        reads++;
        if (!content) throw new Error('missing');
        return {content, node};
      },
    });
    const request = () => new Request(`${origin}/${token}`);
    const first = await handler(request());
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('Original');
    content = '# Changed';
    const second = await handler(request());
    expect(await second.text()).toContain('Changed');
    expect(second.headers.get('Cache-Control')).toContain('no-store');
    expect(second.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    content = '';
    const third = await handler(request());
    expect(third.status).toBe(404);
    expect(await third.text()).not.toContain('Changed');
    expect(reads).toBe(3);
  });

  it('rejects other paths, origins, methods, and cross-site requests before reading', async () => {
    let reads = 0;
    const handler = createMemoryPreviewHandler({
      token,
      port: () => 41377,
      read: async () => {
        reads++;
        return {content: '# Hidden', node};
      },
    });
    const requests = [
      new Request(`${origin}/wrong`),
      new Request(`${origin}/${token}?uri=threadnote://memory/tn_other`),
      new Request(`http://example.test:41377/${token}`),
      new Request(`${origin}/${token}`, {method: 'POST'}),
      new Request(`${origin}/${token}`, {headers: {Origin: 'https://evil.example'}}),
      new Request(`${origin}/${token}`, {headers: {'Sec-Fetch-Site': 'cross-site'}}),
    ];
    for (const request of requests) {
      const response = await handler(request);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Hidden');
    }
    expect(reads).toBe(0);
  });
});

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

it.effect('reports a bounded bind error without exposing its cause in the user message', () =>
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
    expect(error.cause).toBeUndefined();
  }).pipe(provide),
);

it.effect('closes a bound listener when the OS opener fails', () =>
  Effect.gen(function* () {
    let stopped = false;
    let openedUrl = '';
    const exit = yield* runMemoryPreview(unusedConfig, launchUri, {
      listen: () => ({
        port: 43118,
        stop: () => {
          stopped = true;
        },
      }),
      openUrl: url => {
        openedUrl = url;
        return Effect.die(new Error(`sensitive opener detail: ${url}`));
      },
    }).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(openedUrl).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    const formatted = Cause.pretty(exit.cause);
    expect(formatted).toContain('threadnote doctor');
    expect(formatted).not.toContain('sensitive opener detail');
    expect(formatted).not.toContain(openedUrl);
    expect(stopped).toBe(true);
  }).pipe(provide),
);

it.effect('stops the preview listener at its idle deadline', () =>
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
