import {describe, expect, it} from '@effect/vitest';
import {createMemoryPreviewHandler} from '../../src/preview/server.js';

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
