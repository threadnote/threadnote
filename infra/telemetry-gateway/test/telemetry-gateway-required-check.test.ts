import {Schema} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import {join} from '@threadnote/testing/node-path';
import {JSON_SCHEMA, load} from 'js-yaml';
import {expect, it} from 'vitest';

interface Workflow {
  readonly on: {
    readonly pull_request: Readonly<{
      branches: readonly string[];
      paths?: readonly string[];
      'paths-ignore'?: readonly string[];
    }>;
    readonly push: Readonly<{branches: readonly string[]; paths: readonly string[]}>;
    readonly workflow_dispatch: Readonly<{inputs: Readonly<{redeploy_production: Readonly<{default: boolean}>}>}>;
  };
  readonly jobs: Readonly<Record<string, Readonly<{name: string; if?: string; needs?: string | readonly string[]}>>>;
}
const WorkflowSchema = Schema.Struct({
  on: Schema.Struct({
    pull_request: Schema.Struct({
      branches: Schema.Array(Schema.String),
      paths: Schema.optionalKey(Schema.Array(Schema.String)),
      'paths-ignore': Schema.optionalKey(Schema.Array(Schema.String)),
    }),
    push: Schema.Struct({branches: Schema.Array(Schema.String), paths: Schema.Array(Schema.String)}),
    workflow_dispatch: Schema.Struct({
      inputs: Schema.Struct({redeploy_production: Schema.Struct({default: Schema.Boolean})}),
    }),
  }),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.String,
      if: Schema.optionalKey(Schema.String),
      needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    }),
  ),
});

const rawWorkflow: unknown = load(
  readFileSync(join(process.cwd(), '.github/workflows/telemetry-gateway.yml'), 'utf8'),
  {schema: JSON_SCHEMA},
);
if (!Schema.is(WorkflowSchema)(rawWorkflow)) throw new Error('Invalid Gateway workflow.');
const workflow: Workflow = rawWorkflow;

it('reports the globally required Gateway status for PRs outside gateway paths', () => {
  expect(workflow.on.pull_request.branches).toContain('main');
  expect(workflow.on.pull_request).not.toHaveProperty('paths');
  expect(workflow.on.pull_request).not.toHaveProperty('paths-ignore');
  expect(workflow.jobs.classify.if).toBeUndefined();
  expect(workflow.jobs.complete.name).toBe('Gateway checks complete');
  expect(workflow.jobs.complete.if).toBe('always()');
  expect(workflow.jobs.complete.needs).toEqual(['classify', 'validate', 'validate-fly', 'deploy', 'storage-canary']);
});

it('retains scoped main pushes and explicit production redeployment', () => {
  expect(workflow.on.push.branches).toEqual(['main']);
  expect(workflow.on.push.paths).toContain('infra/telemetry-gateway/**');
  expect(workflow.on.workflow_dispatch.inputs.redeploy_production.default).toBe(false);
  expect(workflow.jobs.deploy.if).toContain("github.event_name != 'pull_request'");
  expect(workflow.jobs.deploy.if).toContain("github.ref == 'refs/heads/main'");
  expect(workflow.jobs.deploy.if).toContain("needs.classify.outputs.deploy == 'true'");
});
