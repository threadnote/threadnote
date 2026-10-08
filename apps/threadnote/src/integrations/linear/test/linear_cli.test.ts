import {execFileSync} from '@threadnote/testing/node-child-process';
import {describe, expect, it} from 'vitest';
describe('Linear CLI registration', () => {
  it('exposes explicit identity and scope flags through the real command parser', () => {
    const help = execFileSync(process.execPath, ['apps/threadnote/src/standalone.ts', 'source', 'add', '--help'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    for (const flag of [
      '--organization-id',
      '--principal-id',
      '--team-id',
      '--linear-project-id',
      '--issue-id',
      '--credential-env',
    ])
      expect(help).toContain(flag);
    expect(help).toContain('linear');
  });
});
