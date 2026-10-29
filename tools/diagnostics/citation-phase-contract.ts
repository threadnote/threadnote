import {Array as EffectArray} from 'effect';
import type {ContextBriefCitationScaleObservationDescriptor} from '@threadnote/threadnote/evaluation/context-brief-citation-scale';
import {
  CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
  type ContextBriefCitationScaleArtifactV2,
  type ContextBriefCitationScaleObservationV2,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-contract';

export const DIAGNOSTIC_INVOCATION_MODE = 'development-smoke' as const;
export const DIAGNOSTIC_SAMPLES = 100;
export const DIAGNOSTIC_WARMUPS = 5;
export const DIAGNOSTIC_MEMORY_CANDIDATES = 100_000;

export function parseDiagnosticArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--candidate', '--output', '--built-artifact-sha256'].includes(key) || !value || values.has(key))
      throw new Error('Invalid citation diagnostic arguments.');
    values.set(key, value);
  }
  const candidate = values.get('--candidate');
  const builtArtifactSha256 = values.get('--built-artifact-sha256');
  if (!candidate || !/^[0-9a-f]{40}$/.test(candidate)) throw new Error('An exact candidate SHA is required.');
  if (!builtArtifactSha256 || !/^[0-9a-f]{64}$/.test(builtArtifactSha256))
    throw new Error('A built diagnostic digest is required.');
  return {
    candidate,
    builtArtifactSha256,
    output: values.get('--output') ?? 'artifacts/context-brief-citation-phase-diagnostic.json',
  };
}

export interface ObservationMarker extends ContextBriefCitationScaleObservationDescriptor {
  readonly id: number;
  readonly details: 'collected' | 'intentionally-omitted';
  readonly outcome: 'success' | 'typed-error' | 'defect' | 'interrupted';
  readonly counters?: ContextBriefCitationScaleObservationV2['counters'];
  readonly exactValidationReceipts?: number;
  readonly validationReceipts?: number;
  readonly selectedMemories?: number;
}

export function expectedObservationDescriptors(
  samples: number,
  warmups: number,
): readonly ContextBriefCitationScaleObservationDescriptor[] {
  const rss = EffectArray.flatMap(CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS, profileId =>
    Array.from({length: samples}, (_, ordinal) => ({pass: 'rss-memory' as const, profileId, ordinal})),
  );
  return [
    ...rss,
    ...EffectArray.flatMap(CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS, profileId => [
      ...Array.from({length: warmups}, (_, ordinal) => ({pass: 'warmup' as const, profileId, ordinal})),
      ...Array.from({length: samples}, (_, ordinal) => ({pass: 'timed' as const, profileId, ordinal})),
    ]),
  ];
}

export function observationCoverage(markers: readonly ObservationMarker[], samples: number, warmups: number) {
  const expected = expectedObservationDescriptors(samples, warmups);
  const actual = EffectArray.map(markers, ({pass, profileId, ordinal}) => ({pass, profileId, ordinal}));
  return {
    complete:
      JSON.stringify(actual) === JSON.stringify(expected) &&
      EffectArray.every(markers, marker => marker.outcome === 'success' && marker.counters !== undefined),
    expectedObservations: expected.length,
    observedObservations: markers.length,
    detailedObservations: EffectArray.filter(markers, marker => marker.details === 'collected').length,
    intentionallyOmittedObservations: EffectArray.filter(markers, marker => marker.details === 'intentionally-omitted')
      .length,
    profiles: EffectArray.map(CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS, profileId => ({
      profileId,
      passes: EffectArray.map(['rss-memory', 'warmup', 'timed'] as const, pass => ({
        pass,
        observed: EffectArray.filter(markers, marker => marker.profileId === profileId && marker.pass === pass).length,
      })),
    })),
  };
}

/**
 * Deliberately project away the entire release envelope, even if a caller supplies
 * a fully qualifying artifact. No nested object is a release-scale artifact.
 */
export function diagnosticEvidence(artifact: ContextBriefCitationScaleArtifactV2) {
  return {
    classification: 'instrumented-diagnostic-only' as const,
    releaseQualification: false as const,
    actualRunner: artifact.environment,
    actualWorkload: {
      fixture: artifact.fixture,
      samples: artifact.samples,
      warmups: artifact.warmups,
      profiles: EffectArray.map(artifact.profiles, profile => profile.profile),
    },
    builtExecution: artifact.execution,
    metrics: EffectArray.map(artifact.profiles, profile => ({
      profileId: profile.profile.id,
      measurements: profile.measurements,
      counters: profile.counters,
    })),
  };
}
