import {test, expect} from '@playwright/test';
import {access, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {spawnSync} from '@threadnote/testing/node-child-process';
import {join} from '@threadnote/testing/node-path';
import {ManagerRuntime} from './fixtures/runtime.js';
import {configureProviders} from './fixtures/providers.js';
import {pipe} from 'effect';
import * as EffectString from 'effect/String';
import {findExecutable, repositoryRoot} from './fixtures/environment.js';
import {Array as EffectArray} from 'effect';

test('S01 simultaneous homes remain isolated and cleanup includes the detached coordinator', async () => {
  const first = await ManagerRuntime.create();
  const second = await ManagerRuntime.create();
  let coordinatorPid = 0;
  try {
    await Promise.all([first.start(), second.start()]);
    expect(first.origin).not.toBe(second.origin);
    await Promise.all([
      first.remember('first-home-only', 'first-home-only'),
      second.remember('second-home-only', 'second-home-only'),
    ]);
    const firstTree = JSON.stringify(await first.api('/api/tree'));
    const secondTree = JSON.stringify(await second.api('/api/tree'));
    expect(firstTree).toContain('first-home-only');
    expect(firstTree).not.toContain('second-home-only');
    expect(secondTree).toContain('second-home-only');
    expect(secondTree).not.toContain('first-home-only');
    await configureProviders(first);
    await first.api('/api/integrations/obsidian', {
      action: 'sync-source',
      id: 'fixture-obsidian',
      apply: true,
      confirm: true,
    });
    const endpoint = JSON.parse(
      await readFile(join(first.home, 'threadnote/integration-coordinator/endpoint.json'), 'utf8'),
    );
    coordinatorPid = endpoint.pid;
    expect(coordinatorPid).toBeGreaterThan(0);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
  await expect(access(first.root)).rejects.toThrow();
  await expect(access(second.root)).rejects.toThrow();
  expect(
    pipe(spawnSync('ps', ['-p', String(coordinatorPid), '-o', 'stat='], {encoding: 'utf8'}).stdout, EffectString.trim),
  ).toBe('');
});

test('S01 failed startup and timed out CLI both release owned processes and homes', async () => {
  const failed = await ManagerRuntime.create();
  try {
    await rm(failed.home, {recursive: true});
    await writeFile(failed.home, 'A file cannot be a Manager home.');
    await expect(failed.start()).rejects.toThrow('Fixture CLI failed');
  } finally {
    await failed.dispose();
  }
  await expect(access(failed.root)).rejects.toThrow();
  const timedOut = await ManagerRuntime.create();
  try {
    await expect(timedOut.cli(['manage', '--ui-port', '0', '--no-open'], undefined, 100)).rejects.toThrow('timed out');
  } finally {
    await timedOut.dispose();
  }
  await expect(access(timedOut.root)).rejects.toThrow();
});

test('S01 failed OS spawn and registered non-Bun descendants are cleaned up', async () => {
  const manager = await ManagerRuntime.create();
  let descendantPid = 0;
  try {
    const missing = manager.launch(join(manager.root, 'missing-executable'), []);
    await new Promise<void>(resolve => missing.once('error', () => resolve()));
    const child = manager.launch(findExecutable('bun'), [
      '--eval',
      `const child = Bun.spawn(['/bin/sleep', '30'], {detached:true, stdout:'inherit', stderr:'inherit', env:process.env}); child.unref(); console.log(child.pid); await Bun.sleep(60_000);`,
    ]);
    descendantPid = await new Promise<number>((resolve, reject) => {
      child.stdout?.once('data', chunk => resolve(Number(String(chunk))));
      child.once('error', reject);
    });
    expect(descendantPid).toBeGreaterThan(0);
  } finally {
    await manager.dispose();
  }
  expect(
    pipe(
      spawnSync('/bin/ps', ['-p', String(descendantPid), '-o', 'stat='], {encoding: 'utf8'}).stdout,
      EffectString.trim,
    ),
  ).toBe('');
  await expect(access(manager.root)).rejects.toThrow();
});

test('S01 runner timeout, interruption and retry replace fixtures during agent work', async () => {
  const info = test.info();
  test.setTimeout(60_000);
  for (const mode of ['timeout', 'interrupt', 'retry']) {
    const driver = await ManagerRuntime.create();
    const report = join(driver.root, 'lifecycle.jsonl');
    driver.environment.MANAGER_E2E_LIFECYCLE_REPORT = report;
    driver.environment.MANAGER_E2E_LIFECYCLE_MODE = mode;
    driver.environment.MANAGER_E2E_LIFECYCLE_OUTPUT = info.outputPath(mode);
    try {
      const child = driver.launch(findExecutable('node'), [
        join(repositoryRoot, 'node_modules/@playwright/test/cli.js'),
        'test',
        '--config',
        join(import.meta.dirname, 'fixtures/lifecycle-runner.config.ts'),
      ]);
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      await expect.poll(async () => (await readFile(report, 'utf8').catch(() => '')).length).toBeGreaterThan(0);
      if (mode === 'interrupt') child.kill('SIGINT');
      const code = await exit;
      expect(code, driver.output).toBe(mode === 'retry' ? 0 : mode === 'timeout' ? 1 : 130);
      const records = pipe(
        await readFile(report, 'utf8'),
        EffectString.trim,
        EffectString.split('\n'),
        EffectArray.map(line => JSON.parse(line)),
      );
      expect(records).toHaveLength(mode === 'retry' ? 2 : 1);
      if (mode === 'retry') expect(records[0].root).not.toBe(records[1].root);
      for (const record of records) {
        await expect(access(record.root)).rejects.toThrow();
        expect(
          pipe(
            spawnSync('/bin/ps', ['-p', String(record.pid), '-o', 'stat='], {encoding: 'utf8'}).stdout,
            EffectString.trim,
          ),
        ).toBe('');
        await expect(fetch(record.origin, {signal: AbortSignal.timeout(500)})).rejects.toThrow();
      }
    } finally {
      await info.attach(`lifecycle-driver-${mode}`, {body: driver.output, contentType: 'text/plain'});
      await driver.dispose();
    }
  }
});
