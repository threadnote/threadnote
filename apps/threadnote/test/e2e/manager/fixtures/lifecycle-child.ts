import {test, expect} from './test.js';
import {appendFile, readFile, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {findExecutable} from './environment.js';

// Invoked only by lifecycle.spec.ts through the dedicated child-runner config.
test('owned lifecycle child', async ({manager}, info) => {
  const report = process.env.MANAGER_E2E_LIFECYCLE_REPORT;
  if (!report) throw new Error('Missing parent lifecycle report path.');
  const mode = process.env.MANAGER_E2E_LIFECYCLE_MODE;
  const agentFile = join(manager.home, 'agent-pid');
  await writeFile(
    join(manager.root, 'bin/claude'),
    `#!${findExecutable('bun')}
await Bun.write(process.env.HOME + '/agent-pid', String(process.pid));
await Bun.sleep(60_000);
`,
    {mode: 0o755},
  );
  const uris = await Promise.all([
    manager.remember('first source', 'first'),
    manager.remember('second source', 'second'),
  ]);
  const generation = manager
    .api('/api/consolidations', {
      agent: 'claude',
      model: 'sonnet',
      uris,
      kind: 'handoff',
      status: 'active',
      project: 'manager-e2e',
      topic: 'interrupted',
    })
    .catch(() => undefined);
  let pid = 0;
  await expect
    .poll(async () => {
      pid = Number(await readFile(agentFile, 'utf8').catch(() => '0'));
      return pid;
    })
    .toBeGreaterThan(0);
  await appendFile(report, JSON.stringify({root: manager.root, origin: manager.origin, pid, retry: info.retry}) + '\n');
  if (mode === 'retry') {
    expect(info.retry).toBe(1);
    return;
  }
  if (mode === 'timeout') info.setTimeout(1_500);
  await generation;
  await new Promise(() => {});
});
