import {readFileSync} from '@threadnote/testing/node-fs';
import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {Schema} from 'effect';

import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

const stringRecordSchema = Schema.Record(Schema.String, Schema.String);
const stepSchema = Schema.StructWithRest(
  Schema.Struct({
    env: Schema.optionalKey(stringRecordSchema),
    if: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    run: Schema.optionalKey(Schema.String),
    uses: Schema.optionalKey(Schema.String),
    with: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean, Schema.Finite])),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const jobSchema = Schema.StructWithRest(
  Schema.Struct({
    env: Schema.optionalKey(stringRecordSchema),
    environment: Schema.optionalKey(Schema.String),
    if: Schema.optionalKey(Schema.String),
    'runs-on': Schema.optionalKey(Schema.Array(Schema.String)),
    steps: Schema.optionalKey(Schema.Array(stepSchema)),
    'timeout-minutes': Schema.optionalKey(Schema.Finite),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const workflowSchema = Schema.StructWithRest(
  Schema.Struct({
    concurrency: Schema.Struct({
      'cancel-in-progress': Schema.Boolean,
      group: Schema.String,
    }),
    jobs: Schema.Record(Schema.String, jobSchema),
    on: Schema.StructWithRest(Schema.Struct({workflow_dispatch: Schema.optionalKey(Schema.Unknown)}), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const actionlintSchema = Schema.StructWithRest(
  Schema.Struct({
    'self-hosted-runner': Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({labels: Schema.optionalKey(Schema.Array(Schema.String))}), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

describe('governed large ready-query workflow', () => {
  it('is manual-only and requires the pinned preprovisioned dedicated runner', () => {
    const parsedWorkflow: unknown = load(
      readFileSync('.github/workflows/code-graph-ready-query-evidence.yml', 'utf8'),
      {
        schema: JSON_SCHEMA,
      },
    );
    if (!Schema.is(workflowSchema)(parsedWorkflow))
      throw new Error('The ready-query workflow fixture does not match the expected schema');
    const workflow = parsedWorkflow;
    const parsedActionlint: unknown = load(readFileSync('.github/actionlint.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    });
    const actionlint = Schema.decodeUnknownSync(actionlintSchema)(parsedActionlint);
    const job = workflow.jobs['ready-query-evidence'];
    const steps = job.steps;
    const command = EffectOption.getOrElse(
      EffectOption.map(EffectOption.fromNullishOr(steps), values =>
        EffectArray.join(
          EffectArray.flatMap(values, (step, index) => (index in values && step.run ? [step.run] : [])),
          '\n',
        ),
      ),
      () => '',
    );
    const upload = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(step =>
                Effect.pipe(step.uses, effectOptionalString =>
                  effectOptionalString == null
                    ? undefined
                    : Effect.pipe(effectOptionalString, EffectString.startsWith('actions/upload-artifact@')),
                ))(__effectArrayValue),
          ),
        ),
      ),
    );
    const checkout = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(step =>
                Effect.pipe(step.uses, effectOptionalString =>
                  effectOptionalString == null
                    ? undefined
                    : Effect.pipe(effectOptionalString, EffectString.startsWith('actions/checkout@')),
                ))(__effectArrayValue),
          ),
        ),
      ),
    );
    const setupBun = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(step =>
                Effect.pipe(step.uses, effectOptionalString =>
                  effectOptionalString == null
                    ? undefined
                    : Effect.pipe(effectOptionalString, EffectString.startsWith('oven-sh/setup-bun@')),
                ))(__effectArrayValue),
          ),
        ),
      ),
    );
    const guard = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(step =>
                Effect.pipe(step.name, effectOptionalString =>
                  effectOptionalString == null
                    ? undefined
                    : Effect.pipe(effectOptionalString, EffectString.startsWith('Require canonical')),
                ))(__effectArrayValue),
          ),
        ),
      ),
    );
    const preflight = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(step =>
                Effect.pipe(step.name, effectOptionalString =>
                  effectOptionalString == null
                    ? undefined
                    : Effect.pipe(effectOptionalString, EffectString.startsWith('Fail-closed preflight')),
                ))(__effectArrayValue),
          ),
        ),
      ),
    );
    const measurement = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(step =>
                Effect.pipe(step.name, effectOptionalString =>
                  effectOptionalString == null
                    ? undefined
                    : Effect.pipe(effectOptionalString, EffectString.startsWith('Capture fixed-rate')),
                ))(__effectArrayValue),
          ),
        ),
      ),
    );

    // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
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
