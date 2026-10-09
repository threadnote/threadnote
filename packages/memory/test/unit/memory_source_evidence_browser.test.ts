import {describe, expect, it} from 'vitest';

describe('source evidence citation browser boundary', () => {
  it('bundles memory documents without server or native runtime dependencies', async () => {
    const result = await Bun.build({
      entrypoints: [Bun.fileURLToPath(new URL('../../src/document.ts', import.meta.url))],
      target: 'browser',
    });

    expect(result.success, result.logs.map(log => log.message).join('\n')).toBe(true);
    expect(result.outputs.length).toBeGreaterThan(0);
  });
});
