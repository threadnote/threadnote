import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

const workflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      if: Schema.optionalKey(Schema.String),
      'runs-on': Schema.optionalKey(Schema.String),
      steps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
            if: Schema.optionalKey(Schema.String),
            name: Schema.optionalKey(Schema.String),
            run: Schema.optionalKey(Schema.String),
            uses: Schema.optionalKey(Schema.String),
            with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
          }),
        ),
      ),
      'timeout-minutes': Schema.optionalKey(Schema.Finite),
    }),
  ),
  on: Schema.Struct({
    pull_request: Schema.optionalKey(
      Schema.Union([Schema.Literal(''), Schema.Struct({paths: Schema.optionalKey(Schema.Array(Schema.String))})]),
    ),
    workflow_dispatch: Schema.optionalKey(
      Schema.Struct({inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))}),
    ),
  }),
});

describe('code-memory-link inverse-selector scale workflow', () => {
  it('runs the fixed 100k profile only on the release macOS class and stages a content-addressed G artifact', async () => {
    const workflow = Schema.decodeUnknownSync(workflowSchema)(
      load(await Bun.file('.github/workflows/benchmarks.yml').text(), {schema: JSON_SCHEMA}),
    );
    const job = workflow.jobs['code-memory-link-inverse-scale'];
    const benchmark = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(step =>
                Effect.pipe(step.run, effectOptionalString =>
                  effectOptionalString == null
                    ? undefined
                    : Effect.pipe(effectOptionalString, EffectString.includes('bench:code-memory-link-scale')),
                ))(__effectArrayValue),
          ),
        ),
      ),
    );
    const stage = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            step => step.name === 'Stage the exact content-addressed G artifact',
          ),
        ),
      ),
    );
    const upload = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(__effectArrayReceiver, step => step.uses === 'actions/upload-artifact@v7'),
        ),
      ),
    );
    const command = benchmark?.run ?? '';

    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_code_memory_link_scale');
    expect(typeof workflow.on.pull_request === 'object' ? workflow.on.pull_request.paths : undefined).toBeUndefined();
    expect(job.if).toContain("github.event_name == 'schedule'");
    expect(job.if).toContain('inputs.include_code_memory_link_scale');
    expect(job.if).not.toContain("github.event_name == 'pull_request'");
    expect(job['runs-on']).toBe('macos-15');
    expect(job['timeout-minutes']).toBe(120);
    expect(command).toContain('--candidate-commit "${{ github.sha }}"');
    expect(command).not.toContain('--development-smoke');
    expect(command).not.toContain('--memory-candidates');
    expect(command).not.toContain('--samples');
    expect(command).not.toContain('--warmups');
    expect(benchmark?.env?.THREADNOTE_BENCHMARK_RUNNER_CLASS).toBe('github-hosted-macos-15-ARM64');
    expect(stage?.run).toContain('shasum -a 256');
    expect(stage?.run).toContain('apps/threadnote/test/evaluation/retained/code-memory-link-scale');
    expect(upload?.with?.path).toBe('artifacts/test/evaluation/retained/code-memory-link-scale/*.json');
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.['retention-days']).toBe(90);
  });

  it('exposes the built-target wrapper as a dedicated package command', async () => {
    const manifest = Schema.decodeUnknownSync(
      Schema.Struct({scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))}),
    )(JSON.parse(await Bun.file('package.json').text()));
    expect(manifest.scripts?.['bench:code-memory-link-scale']).toBe('bun scripts/benchmark-code-memory-link-scale.ts');
  });
});
