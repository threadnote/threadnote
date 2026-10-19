import fc from 'fast-check';
import {spawnSync} from '@threadnote/testing/node-child-process';
import {resolve} from '@threadnote/testing/node-path';
import {describe, expect, it} from 'vitest';

// Keep the payload and relocated suite paths explicit for the Bazel data closure.
const payloads = [
  'config/agent-skills/dev-spec',
  'config/agent-skills/dev-plan',
  'config/agent-skills/dev-cycle',
  'config/agent-skills/watch-pr',
];
const suites = [
  'apps/threadnote/test/dev-skills/python/dev-spec/test_dev_spec.py',
  'apps/threadnote/test/dev-skills/python/dev-plan/test_dev_plan.py',
  'apps/threadnote/test/dev-skills/python/dev-cycle/test_dev_cycle.py',
  'apps/threadnote/test/dev-skills/python/dev-cycle/test_phase_state.py',
  'apps/threadnote/test/dev-skills/python/watch-pr/test_watch_pr.py',
  'apps/threadnote/test/dev-skills/python/test_portability.py',
  'apps/threadnote/test/dev-skills/python/test_workflow_transport.py',
  'apps/threadnote/test/dev-skills/python/test_personal_cloud_workflow.py',
];

describe('bundled development workflow Python contracts', () => {
  for (const suite of suites) {
    it(
      suite,
      () => {
        const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
        const result = spawnSync(python, ['-B', resolve(suite), '-q'], {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 60_000,
          env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: ''},
        });
        expect(result.error, result.error?.message).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}\nPayloads: ${payloads.join(', ')}`).toBe(0);
      },
      65_000,
    );
  }
});

it('replay and acknowledgement preserve arbitrary event order across delivery boundaries', () => {
  fc.assert(
    fc.property(fc.array(fc.integer(), {maxLength: 250}), ids => {
      const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
      const result = spawnSync(
        python,
        ['-B', resolve('apps/threadnote/test/dev-skills/python/test_portability.py'), '--replay-fixture'],
        {
          encoding: 'utf8',
          input: JSON.stringify(ids),
          timeout: 10_000,
          env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: ''},
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ids, replaysIdentical: true});
    }),
    {numRuns: 20, examples: [[[1]], [Array.from({length: 201}, (_, index) => index)]]},
  );
}, 30_000);
