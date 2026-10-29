import {JSON_SCHEMA, load} from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {
  MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
  MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH,
  MEMORY_CONNECTIONS_SCALE_ID,
  MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS,
} from '@threadnote/threadnote/evaluation/memory-connections-scale-contract';
import {
  MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH,
  MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ID,
} from '@threadnote/threadnote/evaluation/memory-connections-retrieval-bench-contract';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';

const unknownFields = [Schema.Record(Schema.String, Schema.Unknown)];
const workflowStepSchema = Schema.StructWithRest(
  Schema.Struct({
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    run: Schema.optional(Schema.String),
    uses: Schema.optional(Schema.String),
    with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  unknownFields,
);
const workflowJobSchema = Schema.StructWithRest(
  Schema.Struct({
    if: Schema.optional(Schema.String),
    'runs-on': Schema.optional(Schema.String),
    steps: Schema.optional(Schema.Array(workflowStepSchema)),
    'timeout-minutes': Schema.optional(Schema.Finite),
  }),
  unknownFields,
);
const benchmarkWorkflowSchema = Schema.StructWithRest(
  Schema.Struct({
    jobs: Schema.Record(Schema.String, workflowJobSchema),
    on: Schema.StructWithRest(
      Schema.Struct({
        workflow_dispatch: Schema.optional(
          Schema.StructWithRest(
            Schema.Struct({inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))}),
            unknownFields,
          ),
        ),
      }),
      unknownFields,
    ),
  }),
  unknownFields,
);
const packageManifestSchema = Schema.StructWithRest(
  Schema.Struct({scripts: Schema.Record(Schema.String, Schema.String)}),
  unknownFields,
);

describe('memory-connections release-scale workflow', () => {
  it('requires the governed candidate-C job and documents the frozen acceptance contract', async () => {
    const workflow = Schema.decodeUnknownSync(benchmarkWorkflowSchema)(
      load(await Bun.file('.github/workflows/benchmarks.yml').text(), {schema: JSON_SCHEMA}),
    );
    const releaseGuide = await Bun.file('docs/releasing.md').text();
    const packageManifest = Schema.decodeUnknownSync(packageManifestSchema)(await Bun.file('package.json').json());
    const targetSource = await Bun.file('scripts/benchmark-memory-connections-scale-target.ts').text();
    const job = workflow.jobs['memory-connections-one-hop-scale'];
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
                    : Effect.pipe(effectOptionalString, EffectString.includes('bench:memory-connections-scale')),
                ))(__effectArrayValue),
          ),
        ),
      ),
    );
    const verification = EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(job.steps), __effectArrayReceiver =>
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(step =>
                Effect.pipe(step.run, effectOptionalString =>
                  effectOptionalString == null
                    ? undefined
                    : Effect.pipe(
                        effectOptionalString,
                        EffectString.includes('verify:memory-connections-scale-artifact'),
                      ),
                ))(__effectArrayValue),
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

    expect(workflow.on.workflow_dispatch?.inputs).toHaveProperty('include_memory_connections_scale');
    expect(job.if).toContain('inputs.include_memory_connections_scale');
    expect(job['runs-on']).toBe('macos-15');
    expect(job['timeout-minutes']).toBe(120);
    expect(benchmark?.run).toContain('--candidate-commit "${{ github.sha }}"');
    expect(benchmark?.run).not.toContain('--development-smoke');
    expect(benchmark?.env?.THREADNOTE_BENCHMARK_RUNNER_CLASS).toBe(MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS);
    expect(verification?.run).toContain('--candidate-commit "${{ github.sha }}"');
    expect(verification?.run).toContain(
      '--artifact artifacts/memory-connections-scale-${{ runner.os }}-${{ runner.arch }}-${{ github.run_id }}.json',
    );
    expect(job.steps?.indexOf(verification!)).toBeGreaterThan(job.steps?.indexOf(benchmark!) ?? -1);
    expect(job.steps?.indexOf(verification!)).toBeLessThan(job.steps?.indexOf(upload!) ?? Number.MAX_SAFE_INTEGER);
    expect(packageManifest.scripts['verify:memory-connections-scale-artifact']).toBe(
      'bun scripts/verify-memory-connections-scale-artifact.ts',
    );
    expect(targetSource).toContain("environment.GITHUB_ACTIONS === 'true'");
    expect(targetSource).toContain('environment.RUNNER_ARCH');
    expect(targetSource).toContain('environment.RUNNER_ENVIRONMENT');
    expect(targetSource).toContain('environment.RUNNER_OS');
    expect(targetSource).toContain('sourceVersion: candidate.sourceVersion');
    expect(
      Effect.pipe(
        targetSource,
        EffectString.indexOf('parseMemoryConnectionsScaleArtifactV1(evaluated'),
        Effect.Option.getOrElse(() => -1),
      ),
    ).toBeLessThan(
      Effect.pipe(
        targetSource,
        EffectString.indexOf('atomicWrite(options.outputPath'),
        Effect.Option.getOrElse(() => -1),
      ),
    );
    expect(upload?.with?.['retention-days']).toBe(90);

    expect(releaseGuide).toContain('include_memory_connections_scale=true');
    expect(releaseGuide).toContain(`suite \`${MEMORY_CONNECTIONS_SCALE_ID}\``);
    expect(releaseGuide).toContain(MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH);
    expect(releaseGuide).toContain(`\`${MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ID}\``);
    expect(releaseGuide).toContain(MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH);
    expect(releaseGuide).toContain(
      `Measured lookup p95 must be at most ${MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumLookupP95Milliseconds} ms`,
    );
    expect(releaseGuide).toContain(
      `No response may exceed ${MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumResponseEstimatedTokens.toLocaleString('en-US')} estimated tokens, ${MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumRawLinkRowsPerLookup} raw link rows, or ${MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumCanonicalRereadsPerLookup} canonical rereads`,
    );
  });
});
