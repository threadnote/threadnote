import {resolve} from 'node:path';
import {Resvg} from '@resvg/resvg-js';
import {expect, it} from 'vitest';

it('loads a native addon from its declared optional platform package', () => {
  const result = new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="red"/></svg>',
  ).render();
  expect(result.width).toBe(2);
  expect(result.height).toBe(3);
  expect(result.asPng().byteLength).toBeGreaterThan(0);
});

it('loads parser WASM in a Bun worker from declared package assets', async () => {
  const worker = new Worker(resolve('tools/bazel/spike/parser-worker.ts'));
  try {
    const result = new Promise((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = reject;
    });
    worker.postMessage('export const answer: number = 42');
    await expect(result).resolves.toBe('program');
  } finally {
    worker.terminate();
  }
});
