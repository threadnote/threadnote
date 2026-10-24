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
  'apps/threadnote/test/dev-skills/python/product_skills_fixture.py',
  'apps/threadnote/test/dev-skills/release-artifact.py',
];
const suites = [
  'apps/threadnote/test/dev-skills/python/dev-spec/test_dev_spec.py',
  'apps/threadnote/test/dev-skills/python/dev-plan/test_dev_plan.py',
  'apps/threadnote/test/dev-skills/python/dev-plan/test_closeout.py',
  'apps/threadnote/test/dev-skills/python/dev-plan/test_archive_transport.py',
  'apps/threadnote/test/dev-skills/python/dev-cycle/test_dev_cycle.py',
  'apps/threadnote/test/dev-skills/python/dev-cycle/test_phase_state.py',
  'apps/threadnote/test/dev-skills/python/watch-pr/test_watch_pr.py',
  'apps/threadnote/test/dev-skills/python/test_portability.py',
  'apps/threadnote/test/dev-skills/python/test_workflow_transport.py',
  'apps/threadnote/test/dev-skills/python/test_personal_cloud_workflow.py',
  'apps/threadnote/test/dev-skills/python/test_product_skills_fixture.py',
  'apps/threadnote/test/dev-skills/python/test_release_artifact.py',
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

it('source helper generation ignores Finder metadata while retaining real payload changes', () => {
  fc.assert(
    fc.property(
      fc.record({
        skill: fc.constantFrom('dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr'),
        directory: fc.constantFrom('', 'scripts', 'resources'),
        metadata: fc.array(fc.integer({min: 0, max: 255}), {maxLength: 256}),
        payload: fc.array(fc.integer({min: 0, max: 255}), {maxLength: 64}),
      }),
      sample => {
        const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
        const result = spawnSync(
          python,
          [
            '-B',
            resolve('apps/threadnote/test/dev-skills/python/test_workflow_transport.py'),
            '--source-generation-fixture',
          ],
          {
            encoding: 'utf8',
            input: JSON.stringify(sample),
            timeout: 10_000,
            env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: ''},
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({metadataStable: true, payloadTracked: true, readOnly: true});
      },
    ),
    {numRuns: 12},
  );
}, 30_000);

it('plan revisions remain durable and idempotent across readiness changes and legacy migration', () => {
  fc.assert(
    fc.property(
      fc.record({
        phases: fc.integer({min: 1, max: 18}),
        legacy: fc.boolean(),
        drafts: fc.array(fc.boolean(), {minLength: 1, maxLength: 5}),
      }),
      sequence => {
        const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
        const result = spawnSync(
          python,
          ['-B', resolve('apps/threadnote/test/dev-skills/python/dev-plan/test_dev_plan.py'), '--durability-fixture'],
          {
            encoding: 'utf8',
            input: JSON.stringify(sequence),
            timeout: 10_000,
            env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: ''},
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({roundtrip: true, durable: true, idempotent: true});
      },
    ),
    {numRuns: 12, examples: [[{phases: 18, legacy: true, drafts: [true, false, true]}]]},
  );
}, 45_000);

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

it('phase advancement requires every completed delivery without changing the plan', () => {
  fc.assert(
    fc.property(
      fc.record({
        delivery: fc.constantFrom('local', 'commit', 'pr'),
        receipts: fc.array(fc.boolean(), {minLength: 1, maxLength: 8}),
        changeHead: fc.boolean(),
      }),
      sequence => {
        const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
        const result = spawnSync(
          python,
          ['-B', resolve('apps/threadnote/test/dev-skills/python/dev-cycle/test_phase_state.py'), '--delivery-fixture'],
          {
            encoding: 'utf8',
            input: JSON.stringify(sequence),
            timeout: 10_000,
            env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: ''},
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const firstUndelivered =
          sequence.delivery === 'local'
            ? -1
            : sequence.receipts.findIndex((recorded, index) => !recorded || (index === 0 && sequence.changeHead));
        const allowed = firstUndelivered === -1;
        expect(JSON.parse(result.stdout)).toEqual({
          action: allowed ? 'implement' : 'deliver',
          phase: `p${allowed ? sequence.receipts.length : firstUndelivered}`,
          packetAllowed: allowed,
          cachedPacketAllowed: allowed,
        });
      },
    ),
    {
      numRuns: 24,
      examples: [
        [{delivery: 'pr', receipts: [false], changeHead: false}],
        [{delivery: 'pr', receipts: [true], changeHead: true}],
        [{delivery: 'commit', receipts: [true, false, true], changeHead: false}],
        [{delivery: 'local', receipts: [false, false], changeHead: true}],
      ],
    },
  );
}, 30_000);

it('graph timeout diagnostics stay bounded, private and unchanged by arbitrary captured streams', () => {
  fc.assert(
    fc.property(
      fc.record({
        stdout: fc.uint8Array({maxLength: 20_000}),
        stderr: fc.uint8Array({maxLength: 20_000}),
        phases: fc.array(
          fc.constantFrom(
            'registering',
            'sharing',
            'waiting',
            'reclaiming',
            'scanning',
            'materializing',
            'resolving',
            'activating',
            'embedding',
            'unknown-phase',
          ),
          {maxLength: 20},
        ),
        ordinal: fc.integer({min: -2, max: 5}),
      }),
      input => {
        const records = input.phases.map(phase =>
          JSON.stringify({
            type: 'code-graph-progress',
            version: 2,
            phase,
            repository: '/private/diagnostic-secret-repository',
            activity: {path: '/private/diagnostic-secret-path'},
            body: 'diagnostic-secret-body',
            credentials: 'diagnostic-secret-credentials',
          }),
        );
        const request = JSON.stringify({
          stdoutBase64: Buffer.from(input.stdout).toString('base64'),
          stderrBase64: Buffer.concat([Buffer.from(input.stderr), Buffer.from(`\n${records.join('\n')}\n`)]).toString(
            'base64',
          ),
          ordinal: input.ordinal,
        });
        const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
        const result = spawnSync(
          python,
          [
            '-B',
            resolve('apps/threadnote/test/dev-skills/python/dev-spec/test_dev_spec.py'),
            '--graph-timeout-fixture',
          ],
          {
            encoding: 'utf8',
            input: request,
            timeout: 10_000,
            env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: ''},
          },
        );
        expect(result.error, result.error?.message).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          bounded: true,
          deterministic: true,
          nonmutating: true,
          private: true,
        });
      },
    ),
    {
      numRuns: 20,
      examples: [
        [{stdout: new Uint8Array(), stderr: new Uint8Array(), phases: [], ordinal: 1}],
        [
          {
            stdout: new Uint8Array(32_768).fill(255),
            stderr: new Uint8Array(32_768).fill(0),
            phases: Array.from({length: 20}, () => 'scanning'),
            ordinal: 2,
          },
        ],
      ],
    },
  );
}, 30_000);

it('write admission isolates stale attempts while preserving exact matching replay', () => {
  fc.assert(
    fc.property(
      fc.record({
        first: fc.constantFrom('dev-spec', 'dev-plan'),
        mode: fc.constantFrom('foreign', 'completed', 'pending', 'drift', 'advance', 'regress', 'completed-drift'),
        change: fc.constantFrom(
          'body',
          'artifactKey',
          'sourceRunId',
          'operationId',
          'citationPolicy',
          'relations',
          'codeRefs',
          'role',
          'storageKind',
          'preview',
          'key',
          'stage',
          'stage-list',
          'binding',
          'malformed',
          'context',
        ),
        salt: fc.string({maxLength: 24}),
      }),
      sequence => {
        const python = process.env.THREADNOTE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
        const result = spawnSync(
          python,
          [
            '-B',
            resolve('apps/threadnote/test/dev-skills/python/test_workflow_transport.py'),
            '--stale-attempt-fixture',
          ],
          {
            encoding: 'utf8',
            input: JSON.stringify(sequence),
            timeout: 10_000,
            env: {
              ...process.env,
              DEV_SPEC_NATIVE: '0',
              DEV_PLAN_NATIVE: '0',
              PYTHONDONTWRITEBYTECODE: '1',
              PYTHONPATH: '',
            },
          },
        );
        expect(result.error, result.error?.message).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({isolated: true, matchingReplay: true, refusedWithoutMutation: true});
      },
    ),
    {
      numRuns: 20,
      examples: [
        [{first: 'dev-plan', mode: 'foreign', change: 'body', salt: ''}],
        [{first: 'dev-spec', mode: 'drift', change: 'operationId', salt: 'same body'}],
        [{first: 'dev-plan', mode: 'completed', change: 'preview', salt: 'idempotent'}],
      ],
    },
  );
}, 30_000);
