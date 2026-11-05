import {spawnSync} from '@threadnote/testing/node-child-process';
import {mkdtempSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join, resolve} from '@threadnote/testing/node-path';
import {pathToFileURL} from '@threadnote/testing/node-url';
import {describe, expect, it} from 'vitest';

const repositoryDirectory = resolve(import.meta.dirname, '../../../..');
const workUrl = pathToFileURL(resolve(import.meta.dirname, '../../src/incremental/work.ts')).href;
const closureUrl = pathToFileURL(resolve(import.meta.dirname, '../../src/incremental/closure.ts')).href;

describe('incremental module initialization', () => {
  it.each([
    {name: 'work first', order: [workUrl, closureUrl]},
    {name: 'closure first', order: [closureUrl, workUrl]},
  ])(
    'preserves budget exports with $name in a fresh Bun process',
    ({order}) => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'threadnote-incremental-module-'));
      try {
        // A fresh source loader catches entry-order TDZ failures hidden by Vitest transforms or cached imports.
        const child = spawnSync(
          process.versions.bun ? process.execPath : 'bun',
          [
            '--no-env-file',
            '--no-install',
            '--eval',
            `
for (const path of ${JSON.stringify(order)}) await import(path);
const work = await import(${JSON.stringify(workUrl)});
const closure = await import(${JSON.stringify(closureUrl)});
const publicWork = await import('@threadnote/graph/incremental/work');
const publicClosure = await import('@threadnote/graph/incremental/closure');
if (
  work.CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES !== 33_554_432 ||
  closure.PROJECT_INCREMENTAL_CLOSURE_MAX_CACHED_FACT_BYTES !== 33_554_432 ||
  publicWork.CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES !== work.CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES ||
  publicClosure.PROJECT_INCREMENTAL_CLOSURE_MAX_CACHED_FACT_BYTES !== closure.PROJECT_INCREMENTAL_CLOSURE_MAX_CACHED_FACT_BYTES
) throw new Error('Incremental budget export compatibility changed.');
process.stdout.write('incremental-module-initialization:ok\\n');
`,
          ],
          {
            cwd: repositoryDirectory,
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              TMPDIR: temporaryDirectory,
              TEMP: temporaryDirectory,
              TMP: temporaryDirectory,
              BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
              BUN_INSTALL_CACHE_DIR: join(temporaryDirectory, 'bun-install-cache'),
              XDG_CACHE_HOME: join(temporaryDirectory, 'xdg-cache'),
              LANG: 'C.UTF-8',
              CI: '1',
            },
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1_024,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
          },
        );
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.signal, child.stderr).toBeNull();
        expect(child.status, child.stderr).toBe(0);
        expect(child.stderr).toBe('');
        expect(child.stdout).toBe('incremental-module-initialization:ok\n');
      } finally {
        // spawnSync waits for exit, including SIGKILL on timeout, before this owned directory is removed.
        rmSync(temporaryDirectory, {force: true, recursive: true});
      }
    },
    25_000,
  );
});
