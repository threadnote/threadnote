import {test, expect} from '@playwright/test';
import {readFile, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {ManagerRuntime} from './fixtures/runtime.js';

test('S01 model policy, agent subprocess and release checks use disposable boundaries', async () => {
  const manager = await ManagerRuntime.create();
  try {
    await manager.cli(['models', 'setup', '--auto', 'off']);
    delete manager.environment.THREADNOTE_MODEL_SETUP;
    await writeFile(
      join(manager.root, 'bin/claude'),
      `#!/bin/sh
while IFS= read -r line; do :; done
printf '%s' "$HOME" > "$HOME/agent-fixture-home.txt"
printf '%s\\n' '# Synthetic consolidation' 'agent-e2e-needle'
`,
      {mode: 0o755},
    );
    await manager.start();
    const setup = await manager.api('/api/models/setup');
    expect(setup).toMatchObject({policy: 'off', environmentOff: false, artifactReady: false});
    const policy = await manager.api('/api/models/setup', {
      action: 'policy',
      policy: 'off',
      expectedEpoch: setup.intentEpoch,
      confirm: true,
    });
    expect(policy).toMatchObject({policy: 'off', artifactReady: false});
    expect(await manager.api('/api/consolidation-models?agent=local-ai')).toEqual({models: []});
    expect(await manager.api('/api/consolidation-models?agent=claude')).toMatchObject({
      models: [{id: 'sonnet'}, {id: 'opus'}, {id: 'haiku'}],
    });
    const uris = await Promise.all([
      manager.remember('first synthetic source', 'agent-first'),
      manager.remember('second synthetic source', 'agent-second'),
    ]);
    const result = await manager.api('/api/consolidations', {
      agent: 'claude',
      model: 'sonnet',
      uris,
      kind: 'handoff',
      status: 'active',
      project: 'manager-e2e',
      topic: 'agent-draft',
    });
    expect(result.job).toMatchObject({status: 'completed', draft: '# Synthetic consolidation\nagent-e2e-needle'});
    expect(await readFile(join(manager.home, 'agent-fixture-home.txt'), 'utf8')).toBe(manager.home);
    const updates = await manager.api('/api/runtime/updates', {action: 'check'});
    expect(updates).toMatchObject({
      runningVersion: manager.expectedVersion,
      latestVersion: manager.expectedVersion,
      updateAvailable: false,
    });
    expect(updates.checkError).toBeUndefined();
    expect(updates.notesError).toBeUndefined();
    expect(await manager.networkJournal()).toEqual(
      expect.arrayContaining([expect.objectContaining({origin: 'https://api.github.com', matched: true})]),
    );
    expect(await manager.networkJournal()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({matched: false})]),
    );
  } finally {
    await manager.dispose();
  }
});
