import {spawnSync} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
import {expect, it} from 'vitest';

// This is an OS/compiled CLI boundary, intentionally separate from the fast Python suite.
// The literal directory declares the copied fixture/helper closure to Bazel.
const pythonFixtures = 'apps/threadnote/test/dev-skills/python';
const archive = process.env.THREADNOTE_RELEASE_ARCHIVE;
it.skipIf(!archive)(
  'runs the real extracted release and installed workflow helpers outside the checkout',
  () => {
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
        ...(process.platform === 'win32' ? ['--functional-only'] : []),
      ],
      {encoding: 'utf8', timeout: 1_850_000},
    );
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}\nFixtures: ${pythonFixtures}`).toBe(0);
  },
  1_860_000,
);
