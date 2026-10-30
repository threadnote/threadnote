import * as EffectString from 'effect/String';
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
import {
  fetchWindowsReplicaSelection,
  selectWindowsReplicaArtifacts,
  WINDOWS_REPLICA_UPLOAD_STEP,
} from '../select-windows-replica-artifacts.js';

const binding = {
  repository: 'threadnote/threadnote',
  repositoryId: 1230070449,
  runId: 41107953980,
  consumerAttempt: 2,
  headSha: EffectString.repeat(40)('6'),
};
const now = Date.parse('2026-10-30T20:00:00Z');
function fixture(reused = [true, true, true]) {
  const jobs = EffectArray.map([1, 2, 3], replica => ({
    id: 100 + replica,
    name: `Code graph Windows replica ${replica} · windows-latest`,
    run_id: binding.runId,
    run_attempt: binding.consumerAttempt,
    head_sha: binding.headSha,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-10-30T18:33:00Z',
    completed_at: '2026-10-30T18:38:00Z',
    steps: [
      {
        name: WINDOWS_REPLICA_UPLOAD_STEP,
        status: 'completed',
        conclusion: 'success',
        started_at: `2026-10-30T18:3${replica}:00Z`,
        completed_at: `2026-10-30T18:3${replica}:01Z`,
      },
    ],
  }));
  // Upload execution is enclosed by its job; distinct minutes keep replicas independent.
  for (const job of jobs) job.started_at = '2026-10-30T18:30:00Z';
  const artifacts = EffectArray.map([1, 2, 3], replica => ({
    id: 200 + replica,
    name: `code-graph-benchmarks-Windows-X64-replica-${replica}-${binding.runId}-${reused[replica - 1] ? 1 : 2}`,
    expired: false,
    created_at: jobs[replica - 1].steps[0].completed_at,
    expires_at: '2026-11-29T18:33:00Z',
    digest: `sha256:${EffectString.repeat(64)(String(replica))}`,
    workflow_run: {
      id: binding.runId,
      repository_id: binding.repositoryId,
      head_repository_id: binding.repositoryId,
      head_sha: binding.headSha,
    },
  }));
  return {jobs, artifacts};
}
function select(f = fixture()) {
  return selectWindowsReplicaArtifacts(binding, f.jobs, f.artifacts, now);
}

describe('Windows retry replica artifacts', () => {
  it('reproduces projected attempt2 jobs selecting original attempt1 artifacts at inclusive upload completion', () => {
    const f = fixture();
    f.jobs[0].steps[0].name = 'Run actions/upload-artifact@v7';
    const result = select(f);
    expect(result.artifactIds).toBe('201,202,203');
    expect(EffectArray.map(result.selected, x => [x.consumerAttempt, x.artifactAttempt])).toEqual([
      [2, 1],
      [2, 1],
      [2, 1],
    ]);
  });
  it('selects a new execution and cannot use an old passing artifact outside its upload window', () => {
    const f = fixture([false, true, true]);
    const previous = {
      ...f.artifacts[0],
      id: 999,
      name: EffectString.replace(/-2$/u, '-1')(f.artifacts[0].name),
      created_at: '2026-10-30T18:20:00Z',
    };
    f.artifacts.push(previous);
    expect(select(f).selected[0].artifactAttempt).toBe(2);
    f.artifacts.shift();
    expect(() => select(f)).toThrow('execution-bound artifact');
  });
  it('is invariant to pagination order, old irrelevant artifacts and projected reuse across mixed producers', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([0, 1, 2], {minLength: 3, maxLength: 3}),
        fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
        (order, reused) => {
          const f = fixture(reused);
          const expected = select(f);
          const irrelevant = EffectArray.map(f.artifacts, x => ({
            ...x,
            id: x.id + 1000,
            created_at: '2026-10-29T18:00:00Z',
          }));
          const actual = selectWindowsReplicaArtifacts(
            binding,
            EffectArray.map(order, n => f.jobs[n]),
            [...EffectArray.map(order, n => f.artifacts[n]), ...irrelevant],
            now,
          );
          expect(actual).toEqual(expected);
          const projected = selectWindowsReplicaArtifacts(
            {...binding, consumerAttempt: 3},
            EffectArray.map(f.jobs, job => ({...job, id: job.id + 2000, run_attempt: 3})),
            f.artifacts,
            now,
          );
          expect(projected.artifactIds).toBe(expected.artifactIds);
          expect(EffectArray.map(projected.selected, x => x.digest)).toEqual(
            EffectArray.map(expected.selected, x => x.digest),
          );
        },
      ),
      {numRuns: 40},
    );
  });
  it.each([
    'failed-job',
    'missing-job',
    'duplicate-job',
    'failed-upload',
    'missing-upload',
    'duplicate-upload',
    'missing-window',
    'inverted-window',
    'wrong-job-run',
    'wrong-job-attempt',
    'wrong-job-sha',
    'expired',
    'expired-clock',
    'wrong-run',
    'wrong-repository',
    'wrong-head-repository',
    'wrong-sha',
    'wrong-name',
    'future-attempt',
    'missing-artifact',
    'ambiguous-artifact',
    'invalid-digest',
    'outside-window',
    'duplicate-id',
  ])('fails closed for %s', defect => {
    const f = fixture();
    switch (defect) {
      case 'failed-job':
        f.jobs[0].conclusion = 'failure';
        break;
      case 'missing-job':
        f.jobs.shift();
        break;
      case 'duplicate-job':
        f.jobs.push({...f.jobs[0]});
        break;
      case 'failed-upload':
        f.jobs[0].steps[0].conclusion = 'failure';
        break;
      case 'missing-upload':
        f.jobs[0].steps = [];
        break;
      case 'duplicate-upload':
        f.jobs[0].steps.push({...f.jobs[0].steps[0]});
        break;
      case 'missing-window':
        f.jobs[0].steps[0].started_at = '';
        break;
      case 'inverted-window':
        f.jobs[0].steps[0].started_at = '2026-10-30T19:00:00Z';
        break;
      case 'wrong-job-run':
        f.jobs[0].run_id++;
        break;
      case 'wrong-job-attempt':
        f.jobs[0].run_attempt++;
        break;
      case 'wrong-job-sha':
        f.jobs[0].head_sha = EffectString.repeat(40)('a');
        break;
      case 'expired':
        f.artifacts[0].expired = true;
        break;
      case 'expired-clock':
        f.artifacts[0].expires_at = '2026-10-29T00:00:00Z';
        break;
      case 'wrong-run':
        f.artifacts[0].workflow_run.id++;
        break;
      case 'wrong-repository':
        f.artifacts[0].workflow_run.repository_id++;
        break;
      case 'wrong-head-repository':
        f.artifacts[0].workflow_run.head_repository_id++;
        break;
      case 'wrong-sha':
        f.artifacts[0].workflow_run.head_sha = EffectString.repeat(40)('a');
        break;
      case 'wrong-name':
        f.artifacts[0].name += '-other';
        break;
      case 'future-attempt':
        f.artifacts[0].name = EffectString.replace(/-1$/u, '-3')(f.artifacts[0].name);
        break;
      case 'missing-artifact':
        f.artifacts.shift();
        break;
      case 'ambiguous-artifact':
        f.artifacts.push({...f.artifacts[0], id: 888});
        break;
      case 'invalid-digest':
        f.artifacts[0].digest = 'sha256:bad';
        break;
      case 'outside-window':
        f.artifacts[0].created_at = '2026-10-30T19:00:00Z';
        break;
      case 'duplicate-id':
        f.artifacts[1].id = f.artifacts[0].id;
        break;
    }
    expect(() => select(f)).toThrow();
  });
});

describe('read-only GitHub metadata adapter', () => {
  it('uses the exact consumer attempt, follows every page, and retries only transient metadata HTTP errors', async () => {
    const f = fixture();
    const jobs = [...f.jobs, ...EffectArray.makeBy(98, i => ({...f.jobs[0], id: i + 3000, name: `unrelated ${i}`}))];
    const fetch = vi.fn(async (address: string, request: RequestInit) => {
      expect(request.headers).toEqual(expect.objectContaining({Authorization: 'Bearer test-token'}));
      if (fetch.mock.calls.length === 1) return new Response('transient', {status: 502});
      const url = new URL(address);
      if (EffectString.endsWith('/jobs')(url.pathname)) {
        expect(url.pathname).toContain('/attempts/2/jobs');
        return Response.json({
          total_count: jobs.length,
          jobs: url.searchParams.get('page') === '1' ? jobs.slice(0, 100) : jobs.slice(100),
        });
      }
      return Response.json({total_count: 3, artifacts: f.artifacts});
    });
    const sleep = vi.fn(async () => {});
    expect((await fetchWindowsReplicaSelection(binding, 'test-token', {fetch, sleep})).artifactIds).toBe('201,202,203');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it('rejects truncated pages and non-transient failures without falling back to old artifacts', async () => {
    await expect(
      fetchWindowsReplicaSelection(binding, 'token', {fetch: async () => Response.json({total_count: 101, jobs: []})}),
    ).rejects.toThrow('pagination');
    const fetch = vi.fn(async () => new Response('denied', {status: 403}));
    await expect(fetchWindowsReplicaSelection(binding, 'token', {fetch})).rejects.toThrow('HTTP 403');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds retries, page count and response size', async () => {
    const fetch = vi.fn(async () => new Response('unavailable', {status: 503}));
    await expect(fetchWindowsReplicaSelection(binding, 'token', {fetch, sleep: async () => {}})).rejects.toThrow(
      'HTTP 503',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    const f = fixture();
    const endless = vi.fn(async () =>
      Response.json({total_count: 3000, jobs: EffectArray.makeBy(100, () => f.jobs[0])}),
    );
    await expect(fetchWindowsReplicaSelection(binding, 'token', {fetch: endless})).rejects.toThrow('page bound');
    expect(endless).toHaveBeenCalledTimes(20);
    await expect(
      fetchWindowsReplicaSelection(binding, 'token', {
        fetch: async () => new Response(EffectString.repeat(2 * 1024 * 1024 + 1)('x')),
      }),
    ).rejects.toThrow('response bound');
  });
});
