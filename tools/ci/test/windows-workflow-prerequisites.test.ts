import {spawnSync} from '@threadnote/testing/node-child-process';
import fc from 'fast-check';
import {expect, it} from 'vitest';

it('checks Windows prerequisite integrity, execution admission and nonmutation contracts', () => {
  const result = spawnSync(
    'python3',
    ['-B', 'tools/ci/test/python/test_windows_workflow_prerequisites.py', 'tools/ci/windows-workflow-prerequisites.py'],
    {encoding: 'utf8', timeout: 15_000},
  );
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});

it('refuses arbitrary pinned-archive corruption before executing or publishing a tool', () => {
  fc.assert(
    fc.property(fc.integer({min: 0, max: 1_000_000}), fc.integer({min: 0, max: 7}), (offset, bit) => {
      const result = spawnSync(
        'python3',
        [
          '-B',
          'tools/ci/test/python/test_windows_workflow_prerequisites.py',
          'tools/ci/windows-workflow-prerequisites.py',
          'WindowsPrerequisiteTests.test_every_corrupted_archive_is_rejected_before_path_publication',
        ],
        {
          encoding: 'utf8',
          timeout: 15_000,
          env: {...process.env, THREADNOTE_CI_ARCHIVE_OFFSET: String(offset), THREADNOTE_CI_ARCHIVE_BIT: String(bit)},
        },
      );
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }),
    {numRuns: 20},
  );
});
