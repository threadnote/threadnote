import {readFileSync} from '@threadnote/testing/node-fs';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';

interface Workflow {
  readonly concurrency: {readonly 'cancel-in-progress': boolean; readonly group: string};
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly env?: Readonly<Record<string, string>>;
        readonly environment?: string;
        readonly if?: string;
        readonly 'runs-on'?: readonly string[];
        readonly steps?: readonly {
          readonly env?: Readonly<Record<string, string>>;
          readonly if?: string;
          readonly name?: string;
          readonly run?: string;
          readonly uses?: string;
          readonly with?: Readonly<Record<string, string | boolean>>;
        }[];
        readonly 'timeout-minutes'?: number;
      }
    >
  >;
  readonly on: {readonly workflow_dispatch?: unknown};
}

interface ActionlintConfiguration {
  readonly 'self-hosted-runner'?: {readonly labels?: readonly string[]};
}

describe('governed large ready-query workflow', () => {
  it('is manual-only and requires the pinned preprovisioned dedicated runner', () => {
    const workflow = load(readFileSync('.github/workflows/code-graph-ready-query-evidence.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as Workflow;
    const actionlint = load(readFileSync('.github/actionlint.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as ActionlintConfiguration;
    const job = workflow.jobs['ready-query-evidence'];
    const command = job.steps?.flatMap(step => (step.run ? [step.run] : [])).join('\n') ?? '';
    const upload = job.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    const checkout = job.steps?.find(step => step.uses?.startsWith('actions/checkout@'));
    const setupBun = job.steps?.find(step => step.uses?.startsWith('oven-sh/setup-bun@'));
    const guard = job.steps?.find(step => step.name?.startsWith('Require canonical'));
    const preflight = job.steps?.find(step => step.name?.startsWith('Fail-closed preflight'));
    const measurement = job.steps?.find(step => step.name?.startsWith('Capture fixed-rate'));

    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.concurrency).toEqual({
      'cancel-in-progress': false,
      group: 'code-graph-ready-query-evidence',
    });
    expect(job.environment).toBe('large-repository-evidence');
    expect(job.if).toContain("github.repository == 'Kashkovsky/threadnote'");
    expect(job.if).toContain("github.repository == 'threadnote/threadnote'");
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).toContain('github.ref_protected == true');
    expect(job.if).toContain("vars.THREADNOTE_READY_QUERY_EVIDENCE_ENABLED == 'true'");
    expect(job['runs-on']).toEqual(['self-hosted', 'linux', 'x64', 'threadnote-large-graph']);
    expect(actionlint['self-hosted-runner']?.labels).toContain('threadnote-large-graph');
    expect(job['timeout-minutes']).toBe(30);
    expect(checkout?.uses).toBe('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(checkout?.with).toMatchObject({'persist-credentials': false});
    expect(setupBun?.with).toEqual({'bun-version': '1.4.4'});
    expect(setupBun?.uses).toBe('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    expect(job.env).toBeUndefined();
    expect(guard?.env).toEqual({
      THREADNOTE_READY_QUERY_ENVIRONMENT: 'large-repository-evidence',
      THREADNOTE_READY_QUERY_ENVIRONMENT_ATTESTATION: '${{ vars.THREADNOTE_READY_QUERY_ENVIRONMENT_ATTESTATION }}',
      THREADNOTE_READY_QUERY_EVIDENCE_ENABLED: 'true',
      THREADNOTE_READY_QUERY_HOME: '${{ vars.THREADNOTE_READY_QUERY_HOME }}',
      THREADNOTE_READY_QUERY_REPOSITORY: '${{ vars.THREADNOTE_READY_QUERY_REPOSITORY }}',
    });
    expect(preflight?.env).toEqual({
      THREADNOTE_READY_QUERY_DEDICATED_RUNNER: 'true',
      THREADNOTE_READY_QUERY_HOME: '${{ vars.THREADNOTE_READY_QUERY_HOME }}',
      THREADNOTE_READY_QUERY_REPOSITORY: '${{ vars.THREADNOTE_READY_QUERY_REPOSITORY }}',
    });
    expect(measurement?.env).toEqual({
      THREADNOTE_READY_QUERY_DEDICATED_RUNNER: 'true',
      THREADNOTE_READY_QUERY_ENVIRONMENT: 'large-repository-evidence',
      THREADNOTE_READY_QUERY_ENVIRONMENT_ATTESTATION: '${{ vars.THREADNOTE_READY_QUERY_ENVIRONMENT_ATTESTATION }}',
      THREADNOTE_READY_QUERY_EVIDENCE_ENABLED: 'true',
      THREADNOTE_READY_QUERY_HOME: '${{ vars.THREADNOTE_READY_QUERY_HOME }}',
      THREADNOTE_READY_QUERY_REPOSITORY: '${{ vars.THREADNOTE_READY_QUERY_REPOSITORY }}',
    });
    expect(command).toContain('--preflight');
    expect(command).toContain('Kashkovsky/threadnote|threadnote/threadnote');
    expect(command).toContain('test "$GITHUB_REPOSITORY_ID" = \'1230070449\'');
    expect(command).toContain('test "$GITHUB_JOB" = \'ready-query-evidence\'');
    expect(command).toContain('test "$GITHUB_REF" = \'refs/heads/main\'');
    expect(command).toContain('test "$GITHUB_REF_PROTECTED" = \'true\'');
    expect(command).toContain(
      'Kashkovsky/threadnote/.github/workflows/code-graph-ready-query-evidence.yml@refs/heads/main|threadnote/threadnote/.github/workflows/code-graph-ready-query-evidence.yml@refs/heads/main',
    );
    expect(command).toContain('test "$GITHUB_WORKFLOW_SHA" = "$GITHUB_SHA"');
    expect(command).toContain('test "$RUNNER_ENVIRONMENT" = \'self-hosted\'');
    expect(command).toContain('test "$RUNNER_OS" = \'Linux\'');
    expect(command).toContain('test "$RUNNER_ARCH" = \'X64\'');
    expect(command).toContain(
      'test "$THREADNOTE_READY_QUERY_ENVIRONMENT_ATTESTATION" = \'intellij-ready-query-v1:3cbdad9ee6c8a5135fc0f01cc90114fc25c0655c:047481e05148b1c11a52fa813e13323c23abbc0d\'',
    );
    expect(preflight?.run).toContain('${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}.json');
    expect(measurement?.run).toContain('${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}.json');
    expect(command).toContain('bench:code-graph:ready-query');
    expect(command).not.toContain('benchmark-code-graph.ts');
    expect(command).not.toContain('graph index');
    expect(command).not.toContain('git clone');
    expect(upload?.if).toBe('always()');
    expect(upload?.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(upload?.with).toMatchObject({
      'if-no-files-found': 'error',
      'retention-days': 90,
      name: 'code-graph-ready-query-${{ runner.os }}-${{ runner.arch }}-${{ github.run_id }}-${{ github.run_attempt }}',
    });
    expect(upload?.with?.path).toBe(
      'artifacts/code-graph-ready-query-preflight-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}.json\n' +
        'artifacts/code-graph-ready-query-evidence-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}.json\n',
    );
  });
});
