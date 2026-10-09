import {execFile, type ChildProcess} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from 'vitest';
import {INTEGRATION_SYNC_WORKER_ARGUMENT} from '../../src/worker_protocol.js';

const entrypoint = 'apps/threadnote/src/standalone.ts';

describe('integration coordinator standalone Obsidian composition', () => {
  it('projects forced worker startup failures as safe queue and engine phases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-coordinator-startup-failure-'));
    try {
      for (const stage of ['queue', 'engine']) {
        const home = join(root, stage);
        const directory = join(home, 'threadnote', 'integration-coordinator');
        const databasePath = join(directory, 'jobs.sqlite');
        await mkdir(directory, {recursive: true, mode: 0o700});
        await writeFile(databasePath, stage === 'queue' ? 'synthetic-private-database-detail' : '', {mode: 0o600});
        if (stage === 'engine') {
          const database = new Database(databasePath);
          try {
            database.run('CREATE TABLE source_jobs (key TEXT PRIMARY KEY)');
          } finally {
            database.close();
          }
        }
        const result = await new Promise<{readonly code: string | number | undefined; readonly stderr: string}>(
          resolve => {
            execFile(
              process.execPath,
              [entrypoint, INTEGRATION_SYNC_WORKER_ARGUMENT, '--home', home],
              {env: {...process.env, HOME: root, THREADNOTE_TELEMETRY: 'off'}, timeout: 15_000, maxBuffer: 64 * 1024},
              (error, _stdout, stderr) => resolve({code: error?.code, stderr}),
            );
          },
        );
        expect(result.code).toBe(1);
        expect(result.stderr.trim()).toBe(
          `Integration sync coordinator stopped during ${stage} initialization. Retry source sync to restart it.`,
        );
        expect(result.stderr).not.toContain('synthetic-private');
        expect(await readFile(join(directory, 'endpoint.json'), 'utf8').catch(() => undefined)).toBeUndefined();
        expect(await readFile(join(directory, 'worker.lock'), 'utf8').catch(() => undefined)).toBeUndefined();
      }
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });

  it('cold-starts the worker from a real CLI client and publishes usable snapshots for concurrent clients', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-coordinator-obsidian-'));
    const home = join(root, 'home');
    const vault = join(root, 'vault');
    const endpoint = join(home, 'threadnote', 'integration-coordinator', 'endpoint.json');
    const clients = new Set<ChildProcess>();
    const env = {
      ...process.env,
      HOME: join(root, 'user-home'),
      THREADNOTE_HOME: home,
      THREADNOTE_USER: 'process-test',
      THREADNOTE_ACCOUNT: 'local',
      THREADNOTE_MANIFEST: join(home, 'seed-manifest.yaml'),
      THREADNOTE_TELEMETRY: 'off',
      NO_COLOR: '1',
    };
    const runCli = (args: readonly string[]) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [entrypoint, ...args],
          {env, timeout: 15_000, maxBuffer: 128 * 1024},
          (error, stdout, stderr) => {
            clients.delete(child);
            if (error) reject(new Error(`CLI failed: ${stderr || error.message}`));
            else resolve(stdout);
          },
        );
        clients.add(child);
      });
    try {
      await Promise.all([
        mkdir(home, {recursive: true}),
        mkdir(vault, {recursive: true}),
        mkdir(env.HOME, {recursive: true}),
      ]);
      await writeFile(env.THREADNOTE_MANIFEST, 'version: 1\nprojects: []\n');
      await writeFile(
        join(vault, 'Note.md'),
        '# Synthetic local fixture\n\nInitial publication through the coordinator.\n',
      );
      await runCli(['source', 'add', '--id', 'local-vault', '--vault', vault, '--include', '**/*.md', '--apply']);
      expect(await readFile(endpoint, 'utf8').catch(() => undefined)).toBeUndefined();
      expect(await runCli(['source', 'sync', 'local-vault', '--apply'])).toContain('Obsidian source sync complete:');
      expect(JSON.parse(await readFile(endpoint, 'utf8'))).toMatchObject({home: await realpath(home), protocol: 1});
      const outputs = await Promise.all([
        runCli(['source', 'sync', 'local-vault', '--apply']),
        runCli(['source', 'sync', 'local-vault', '--apply']),
      ]);
      for (const output of outputs) expect(output).toContain('Obsidian source sync complete:');
      const database = new Database(join(home, 'threadnote', 'integration-coordinator', 'jobs.sqlite'), {
        readonly: true,
      });
      try {
        const jobs = database
          .query<{descriptor_json: string; state: string}, []>('SELECT descriptor_json,state FROM source_jobs')
          .all();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.state).toBe('idle');
        expect(JSON.parse(jobs[0]?.descriptor_json ?? '{}')).toMatchObject({
          provider: 'obsidian',
          sourceId: 'local-vault',
        });
      } finally {
        database.close();
      }
      const uri = 'threadnote://resources/external/obsidian/local-vault/Note.md';
      expect(await runCli(['read', uri])).toContain('Initial publication through the coordinator.');
      await writeFile(
        join(vault, 'Note.md'),
        '# Synthetic local fixture\n\nRefreshed publication through the coordinator.\n',
      );
      expect(await runCli(['source', 'sync', 'local-vault', '--apply'])).toContain('1 updated');
      expect(await runCli(['read', uri])).toContain('Refreshed publication through the coordinator.');
    } finally {
      for (const child of clients) child.kill('SIGKILL');
      const state = await readFile(endpoint, 'utf8')
        .then(text => JSON.parse(text) as {pid: number})
        .catch(() => undefined);
      if (state) {
        try {
          process.kill(state.pid, 'SIGKILL');
        } catch {
          /* A worker can exit during cleanup. */
        }
      }
      await rm(root, {force: true, recursive: true});
    }
  });
});
