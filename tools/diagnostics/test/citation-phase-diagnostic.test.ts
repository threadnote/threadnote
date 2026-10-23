import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Exit, Fiber} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import {load, JSON_SCHEMA} from 'js-yaml';
import {
  observeContextBriefCitationScaleObservation,
  type ContextBriefCitationScaleObservationWrapper,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale';
import {
  contextBriefCitationScaleCandidateBinding,
  parseContextBriefCitationScaleArtifactV2,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-contract';
import {
  DIAGNOSTIC_INVOCATION_MODE,
  DIAGNOSTIC_MEMORY_CANDIDATES,
  DIAGNOSTIC_SAMPLES,
  DIAGNOSTIC_WARMUPS,
  diagnosticEvidence,
  expectedObservationDescriptors,
  observationCoverage,
  parseDiagnosticArguments,
} from '../citation-phase-contract.js';
import {budget, releaseScaleArtifact} from './citation-phase.fixture.js';

describe('citation observation wrapper', () => {
  const descriptor = {pass: 'timed' as const, profileId: 'local-100k' as const, ordinal: 0};
  it('returns the identical observation Effect when the optional hook is absent', () => {
    const effect = Effect.succeed({marker: 'identity'});
    expect(observeContextBriefCitationScaleObservation(undefined, descriptor, effect)).toBe(effect);
  });

  effectIt.effect('forwards success, typed failure, defect and interruption with finalizers', () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const hook: ContextBriefCitationScaleObservationWrapper = (info, effect) =>
        Effect.suspend(() => {
          seen.push(info);
          return effect;
        });
      const result = {marker: 'same-object'};
      const failure = {marker: 'same-failure'};
      const defect = {marker: 'same-defect'};
      expect(yield* observeContextBriefCitationScaleObservation(hook, descriptor, Effect.succeed(result))).toBe(result);
      expect(
        yield* observeContextBriefCitationScaleObservation(hook, descriptor, Effect.fail(failure)).pipe(Effect.exit),
      ).toEqual(yield* Effect.fail(failure).pipe(Effect.exit));
      expect(
        yield* observeContextBriefCitationScaleObservation(hook, descriptor, Effect.die(defect)).pipe(Effect.exit),
      ).toEqual(yield* Effect.die(defect).pipe(Effect.exit));
      let finalized = 0;
      const entered = yield* Deferred.make<void>();
      const fiber = yield* observeContextBriefCitationScaleObservation(
        hook,
        descriptor,
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized++;
            }),
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const interrupted = yield* Fiber.await(fiber);
      expect(Exit.isFailure(interrupted)).toBe(true);
      expect(finalized).toBe(1);
      expect(seen).toHaveLength(4);
      expect(seen.every(value => value === descriptor)).toBe(true);
    }),
  );

  it('requires explicit, ordered descriptors for all 615 full-history observations and rejects omissions or duplicates', () => {
    const expected = expectedObservationDescriptors(DIAGNOSTIC_SAMPLES, DIAGNOSTIC_WARMUPS);
    expect(expected).toHaveLength(615);
    const artifact = releaseScaleArtifact('threadnote-5.3.0', 'bun/1.4.2');
    const markers = expected.map((entry, id) => ({
      ...entry,
      id,
      outcome: 'success' as const,
      details: entry.profileId === 'local-100k' ? ('collected' as const) : ('intentionally-omitted' as const),
      counters: artifact.profiles.find(profile => profile.profile.id === entry.profileId)!.observations[0].counters,
    }));
    expect(observationCoverage(markers, 100, 5)).toMatchObject({
      complete: true,
      detailedObservations: 205,
      intentionallyOmittedObservations: 410,
    });
    expect(observationCoverage(markers.slice(1), 100, 5).complete).toBe(false);
    expect(observationCoverage([...markers, markers[0]], 100, 5).complete).toBe(false);
    expect(observationCoverage([...markers].reverse(), 100, 5).complete).toBe(false);
  });
});

it('removes release envelopes even from otherwise fully qualifying hosted evidence, preserving actual runner and workload', () => {
  const candidate = contextBriefCitationScaleCandidateBinding('a'.repeat(40), {
    version: '5.3.0',
    packageManager: 'bun@1.4.2',
  });
  const qualifying = parseContextBriefCitationScaleArtifactV2(
    releaseScaleArtifact(candidate.sourceVersion, candidate.runtime),
    budget,
    candidate,
  );
  expect(qualifying.gate.passed).toBe(true);
  expect([
    qualifying.fixture.indexedMemoryCandidates,
    qualifying.samples,
    qualifying.warmups,
    qualifying.profiles.length,
  ]).toEqual([100_000, 100, 5, 3]);
  const projected = diagnosticEvidence(qualifying);
  expect(DIAGNOSTIC_INVOCATION_MODE).toBe('development-smoke');
  expect(projected.releaseQualification).toBe(false);
  expect(projected.actualRunner).toEqual(qualifying.environment);
  expect(projected.actualWorkload.samples).toBe(100);
  expect(projected).not.toHaveProperty('suite');
  expect(projected).not.toHaveProperty('gate');
  expect(() => parseContextBriefCitationScaleArtifactV2(projected, budget, candidate)).toThrow();
  for (const nested of Object.values(projected))
    expect(() => parseContextBriefCitationScaleArtifactV2(nested, budget, candidate)).toThrow();
});

it('fixes workload parameters and accepts only candidate/output/internal digest options', () => {
  expect([DIAGNOSTIC_MEMORY_CANDIDATES, DIAGNOSTIC_SAMPLES, DIAGNOSTIC_WARMUPS]).toEqual([100_000, 100, 5]);
  const args = ['--candidate', 'a'.repeat(40), '--built-artifact-sha256', 'b'.repeat(64)];
  expect(parseDiagnosticArguments(args)).toMatchObject({candidate: 'a'.repeat(40)});
  for (const extra of [
    ['--samples', '1'],
    ['--script', 'anything'],
    ['--candidate', 'b'.repeat(40)],
    ['--mode', 'release-scale'],
  ])
    expect(() => parseDiagnosticArguments([...args, ...extra])).toThrow();
});

it('uses a default-off separate ARM64 diagnostic job and leaves the ordinary scale gate command intact', () => {
  interface Step {
    readonly run?: string;
  }
  interface Job {
    readonly if: string;
    readonly 'runs-on': string;
    readonly steps: readonly Step[];
  }
  const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {schema: JSON_SCHEMA}) as {
    readonly on: {readonly workflow_dispatch: {readonly inputs: Readonly<Record<string, unknown>>}};
    readonly jobs: Readonly<Record<string, Job>>;
  };
  expect(workflow.on.workflow_dispatch.inputs.include_context_brief_citation_diagnostics).toMatchObject({
    type: 'boolean',
    default: false,
    required: false,
  });
  const diagnostic = workflow.jobs['context-brief-citation-phase-diagnostic'];
  expect(diagnostic.if).toBe(
    "github.event_name == 'workflow_dispatch' && inputs.include_context_brief_citation_diagnostics",
  );
  expect(diagnostic['runs-on']).toBe('macos-15');
  const run = diagnostic.steps.find(step => step.run?.includes('build-citation-phase-diagnostic'))?.run;
  expect(run).toBe(
    'bun tools/diagnostics/build-citation-phase-diagnostic.ts --candidate "${{ github.sha }}" --output artifacts/context-brief-citation-phase-diagnostic.json',
  );
  expect(run).not.toContain('inputs.');
  expect(diagnostic.steps.find(step => step.run?.includes('RUNNER_ARCH'))?.run).toBe('test "$RUNNER_ARCH" = "ARM64"');
  const gate = workflow.jobs['context-brief-citations-scale'];
  expect(gate.if).toBe("github.event_name == 'schedule' || inputs.include_context_brief_citations_scale");
  expect(gate.steps.find(step => step.run?.includes('bench:context-brief-citations'))?.run).toBe(
    'bun run bench:context-brief-citations -- --candidate-commit "${{ github.sha }}" --memory-candidates 100000 --samples 100 --warmups 5 --fail-on-budget --output artifacts/context-brief-citations-scale-${{ runner.os }}-${{ runner.arch }}-${{ github.run_id }}.json',
  );
});
