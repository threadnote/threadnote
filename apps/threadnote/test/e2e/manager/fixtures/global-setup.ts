import {spawnSync} from '@threadnote/testing/node-child-process';
import {mkdir} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {findExecutable, repositoryRoot} from './environment.js';

export default async function globalSetup(): Promise<void> {
  const output = join(repositoryRoot, '.context/manager-e2e/runtime');
  await mkdir(output, {recursive: true});
  const result = spawnSync(
    findExecutable('bun'),
    [
      'build',
      'apps/threadnote/test/e2e/manager/fixtures/network-preload.mjs',
      '--target=bun',
      '--outfile',
      join(output, 'network-preload.mjs'),
    ],
    {cwd: repositoryRoot, encoding: 'utf8'},
  );
  if (result.status !== 0) throw new Error(`Could not build the fixture I/O preload: ${result.stderr}`);
}
