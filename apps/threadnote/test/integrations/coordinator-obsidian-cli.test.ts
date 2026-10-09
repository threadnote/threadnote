import {execFile, type ChildProcess} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from 'vitest';

const entrypoint = 'apps/threadnote/src/standalone.ts';

describe('integration coordinator standalone Obsidian composition', () => {
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
