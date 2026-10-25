import {spawnSync} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
import {mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {expect, it} from 'vitest';

// This is an OS/compiled CLI boundary, intentionally separate from the fast Python suite.
// The literal directory declares the copied fixture/helper closure to Bazel.
const nativeFixtures = ['native-release-workflows.py', 'release-tools-fixture.ts'];
const archive = process.env.THREADNOTE_RELEASE_ARCHIVE;
it.skipIf(!archive)(
  'runs extracted native workflows without external interpreters or source access',
  async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'threadnote-release-tools-'));
    try {
      const tools = resolve(temporary, process.platform === 'win32' ? 'fixture-tools.exe' : 'fixture-tools');
      const build = await Bun.build({
        entrypoints: [resolve('apps/threadnote/test/dev-skills/release-tools-fixture.ts')],
        compile: {outfile: tools},
      });
      expect(build.success, JSON.stringify(build.logs)).toBe(true);
      const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
      const result = spawnSync(
        python,
        [
          '-B',
          resolve('apps/threadnote/test/dev-skills/release-artifact.py'),
          '--archive',
          resolve(archive!),
          '--checkout',
          process.cwd(),
          '--report',
          resolve(process.env.THREADNOTE_RELEASE_REPORT ?? '.context/release-artifact/result.json'),
          '--tools',
          tools,
          ...(process.platform === 'win32' ? ['--functional-only'] : []),
        ],
        {encoding: 'utf8', timeout: 1_850_000},
      );
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}\nFixtures: ${nativeFixtures.join(', ')}`).toBe(0);
    } finally {
      await rm(temporary, {recursive: true, force: true});
    }
  },
  1_860_000,
);
