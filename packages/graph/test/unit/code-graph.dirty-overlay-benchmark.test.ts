import {Array as EffectArray} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import {describe, expect, it} from 'vitest';
import {Predicate, Schema} from 'effect';
import {
  dirtyOverlayAmplificationEvidence,
  dirtyOverlayChangedSource,
  dirtyOverlayRatchetArtifact,
  dirtyOverlayReplayEvidence,
  parseDirtyOverlayBenchmarkArguments,
} from '../../../../scripts/benchmark-code-graph-dirty-overlay.js';
import {
  enforceCodeGraphBenchmarkRatchet,
  validateCodeGraphBenchmarkRatchet,
} from '../../../../scripts/benchmark-code-graph.js';
import {generatedStaticReexportControlStatement} from '../../../../scripts/code-graph-fixture.js';
import * as EffectRecord from 'effect/Record';

const extraValues = [Schema.Record(Schema.String, Schema.Unknown)] as const;
const replaySchema = Schema.StructWithRest(
  Schema.Struct({
    attributedFiles: Schema.Finite,
    cachedFactReplayBytes: Schema.Finite,
    changedFactBytes: Schema.Finite,
    crossGenerationShardFiles: Schema.Finite,
    exactGenerationShardFiles: Schema.Finite,
    materializedShardReplayBytes: Schema.Finite,
    rawFactReplayBytes: Schema.Finite,
  }),
  extraValues,
);
const dirtyOverlayEvidenceSchema = Schema.StructWithRest(
  Schema.Struct({
    environment: Schema.StructWithRest(
      Schema.Struct({
        availableBytes: Schema.Finite,
        commit: Schema.String,
        minimumFreeBytes: Schema.Finite,
        provenance: Schema.StructWithRest(Schema.Struct({sourceCommit: Schema.String}), extraValues),
        storage: Schema.StructWithRest(Schema.Struct({location: Schema.String, medium: Schema.String}), extraValues),
      }),
      extraValues,
    ),
    measurements: Schema.StructWithRest(
      Schema.Struct({
        full: Schema.StructWithRest(
          Schema.Struct({durationMilliseconds: Schema.Finite, stagedFiles: Schema.Finite}),
          extraValues,
        ),
        incremental: Schema.StructWithRest(
          Schema.Struct({durationMilliseconds: Schema.Finite, stagedFiles: Schema.Finite}),
          extraValues,
        ),
      }),
      extraValues,
    ),
    observations: Schema.StructWithRest(
      Schema.Struct({
        full: Schema.StructWithRest(
          Schema.Struct({edges: Schema.Finite, symbols: Schema.Finite, totalFiles: Schema.Finite}),
          extraValues,
        ),
        incremental: Schema.StructWithRest(
          Schema.Struct({
            attributionContextFiles: Schema.Finite,
            baseFactsLoaded: Schema.Finite,
            changedFiles: Schema.Finite,
            closureProjects: Schema.Finite,
            edges: Schema.Finite,
            inventoryFilesInspected: Schema.Finite,
            probedDependencyPaths: Schema.Finite,
            replay: replaySchema,
            resolutionClosure: Schema.String,
            symbols: Schema.Finite,
            totalFiles: Schema.Finite,
          }),
          extraValues,
        ),
      }),
      extraValues,
    ),
  }),
  extraValues,
);

describe('code graph dirty-overlay benchmark evidence', () => {
  it('retains governed 300k dependency-closure evidence with proportional work', () => {
    const evidence = Schema.decodeUnknownSync(dirtyOverlayEvidenceSchema)(
      JSON.parse(
        readFileSync(
          'apps/threadnote/test/evaluation/baselines/code-graph-v1/dirty-overlay-dependency-surface-development.json',
          'utf8',
        ),
      ) as unknown,
    );
    expect(evidence.environment.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.environment.provenance.sourceCommit).toBe(evidence.environment.commit);
    expect(evidence.environment.availableBytes).toBeGreaterThanOrEqual(evidence.environment.minimumFreeBytes);
    expect(evidence.environment.storage).toEqual({location: 'internal', medium: 'solid-state'});
    expect(evidence.measurements.incremental.durationMilliseconds).toBeLessThan(30_000);
    expect(evidence.measurements.incremental.durationMilliseconds).toBeLessThan(
      evidence.measurements.full.durationMilliseconds,
    );
    expect(evidence.measurements.incremental.stagedFiles).toBe(4);
    expect(evidence.measurements.full.stagedFiles).toBe(3_006);
    expect(evidence.observations.incremental).toMatchObject({
      attributionContextFiles: 4,
      baseFactsLoaded: 4,
      changedFiles: 4,
      closureProjects: 2,
      inventoryFilesInspected: 4,
      probedDependencyPaths: 10,
      replay: {cachedFactReplayBytes: 0, materializedShardReplayBytes: 0, rawFactReplayBytes: 0},
      resolutionClosure: 'project',
    });
    expect(evidence.observations.incremental.symbols).toBe(evidence.observations.full.symbols);
    expect(evidence.observations.incremental.edges).toBe(evidence.observations.full.edges);
    expect(evidence.observations.incremental.totalFiles).toBe(evidence.observations.full.totalFiles);
  });

  it('preserves the body-only default and opts into the static re-export case', () => {
    expect(parseDirtyOverlayBenchmarkArguments([])).toEqual({
      governed: false,
      minimumFreeGiB: 120,
      samples: 3,
      scaleSymbols: 10_000,
      scenario: 'body-only',
    });
    expect(
      parseDirtyOverlayBenchmarkArguments([
        '--scenario',
        'unchanged-static-reexport',
        '--scale-symbols',
        '101',
        '--samples',
        '1',
      ]),
    ).toEqual({
      governed: false,
      minimumFreeGiB: 120,
      samples: 1,
      scaleSymbols: 101,
      scenario: 'unchanged-static-reexport',
    });
    expect(
      parseDirtyOverlayBenchmarkArguments([
        '--scenario',
        'changed-export',
        '--scale-symbols',
        '300000',
        '--samples',
        '1',
      ]),
    ).toEqual({
      governed: false,
      minimumFreeGiB: 120,
      samples: 1,
      scaleSymbols: 300000,
      scenario: 'changed-export',
    });
  });

  it('requires retained evidence and the 120 GiB floor for governed runs', () => {
    expect(() => parseDirtyOverlayBenchmarkArguments(['--governed'])).toThrow('requires --output');
    expect(() =>
      parseDirtyOverlayBenchmarkArguments([
        '--governed',
        '--minimum-free-gib',
        '119',
        '--output',
        '/tmp/evidence.json',
      ]),
    ).toThrow('at least 120');
    expect(() =>
      parseDirtyOverlayBenchmarkArguments(['--ratchet', '/tmp/ratchet.json', '--output', '/tmp/evidence.json']),
    ).toThrow('requires --governed');
    expect(
      parseDirtyOverlayBenchmarkArguments([
        '--governed',
        '--output',
        '/tmp/evidence.json',
        '--ratchet',
        '/tmp/ratchet.json',
      ]),
    ).toMatchObject({
      governed: true,
      minimumFreeGiB: 120,
      outputPath: '/tmp/evidence.json',
      ratchetPath: '/tmp/ratchet.json',
    });
  });

  it('moves only the static re-export evidence span', () => {
    const statement = generatedStaticReexportControlStatement();
    const committed = `export function value(): number { return 1; }\n${statement}\n`;

    expect(dirtyOverlayChangedSource('unchanged-static-reexport', committed)).toBe(
      `// Span-only benchmark edit; resolver input below is byte-identical.\n${committed}`,
    );
  });

  it('adds one published symbol to the dependency-surface control', () => {
    const committed = 'export function dependencySurfaceControl(): number { return 1; }\n';
    expect(dirtyOverlayChangedSource('changed-export', committed)).toBe(
      `${committed}export function publishedDependencySurfaceControl(): number { return 2; }\n`,
    );
  });

  it('projects exact structural amplification without timing predicates', () => {
    expect(
      dirtyOverlayAmplificationEvidence({
        cachedFactReplayBytes: 0,
        changedFactBytes: 512,
        deltaFiles: 1,
        stagedFiles: 1,
      }),
    ).toEqual({factReplayAmplification: 0, rewriteAmplification: 1});
    expect(
      dirtyOverlayAmplificationEvidence({
        cachedFactReplayBytes: 65_536,
        changedFactBytes: 512,
        deltaFiles: 1,
        stagedFiles: 102,
      }),
    ).toEqual({factReplayAmplification: 128, rewriteAmplification: 102});
  });

  it('ratchets timing, closure work, and structural metrics independently', () => {
    const replay = {
      attributedFiles: 0,
      cachedFactReplayBytes: 0,
      changedFactBytes: 512,
      crossGenerationShardFiles: 0,
      exactGenerationShardFiles: 0,
      materializedShardReplayBytes: 0,
      rawFactReplayBytes: 0,
    };
    const full = {
      cpuMilliseconds: 900,
      durationMilliseconds: 1_000,
      edges: 2_000,
      factReplayAmplification: 64,
      materializationMilliseconds: 800,
      materializationMode: 'full',
      replay: {...replay, attributedFiles: 100, cachedFactReplayBytes: 32_768},
      rewriteAmplification: 100,
      stagedFiles: 100,
      symbols: 1_000,
      totalFiles: 100,
    } as const;
    const incremental = {
      attributionContextFiles: 4,
      baseFactsLoaded: 4,
      changedFiles: 4,
      closureProjects: 2,
      cpuMilliseconds: 300,
      durationMilliseconds: 400,
      edges: 2_000,
      factReplayAmplification: 0,
      inventoryFilesInspected: 4,
      materializationMilliseconds: 100,
      materializationMode: 'incremental-overlay',
      probedDependencyPaths: 10,
      replay,
      resolutionClosure: 'project',
      rewriteAmplification: 4,
      stagedFiles: 4,
      symbols: 1_000,
      totalFiles: 100,
    } as const;
    const options = parseDirtyOverlayBenchmarkArguments([
      '--scenario',
      'changed-export',
      '--scale-symbols',
      '1000',
      '--samples',
      '1',
    ]);
    const artifact = dirtyOverlayRatchetArtifact({
      full: [full],
      hardware: {cpuModel: 'test', memoryBytes: 1_000_000, operatingSystem: 'test'},
      incremental: [incremental],
      options,
      runtimePlatform: 'test',
      runtimeVersion: '1.0.0',
    });
    const ratchet = {
      environment: {
        fixtureHash: artifact.environment.fixtureHash,
        node: artifact.environment.node,
        runner: artifact.environment.runner,
        runnerVersion: artifact.environment.runnerVersion,
      },
      measurements: {
        'incremental-base-facts-loaded': {maximum: 4, unit: 'count'},
        'incremental-duration': {maximum: 500, unit: 'milliseconds'},
        'incremental-duration-reduction': {minimum: 50, unit: 'percent'},
        'incremental-staged-files': {maximum: 4, unit: 'count'},
        'incremental-symbols': {minimum: 1_000, unit: 'count'},
      },
      metadata: {
        runnerClass: artifact.metadata.runnerClass,
        runtimePlatform: artifact.metadata.runtimePlatform,
        vectorEnabled: false,
      },
      suite: artifact.suite,
      version: 1,
    } as const;
    expect(() => enforceCodeGraphBenchmarkRatchet(artifact, ratchet)).not.toThrow();
    const regressed = dirtyOverlayRatchetArtifact({
      full: [full],
      hardware: {cpuModel: 'test', memoryBytes: 1_000_000, operatingSystem: 'test'},
      incremental: [{...incremental, baseFactsLoaded: 5, durationMilliseconds: 600, stagedFiles: 5}],
      options,
      runtimePlatform: 'test',
      runtimeVersion: '1.0.0',
    });
    expect(() => enforceCodeGraphBenchmarkRatchet(regressed, ratchet)).toThrow(
      'incremental-base-facts-loaded maximum 5 exceeds 4',
    );

    const parsedRatchet: unknown = JSON.parse(
      readFileSync(
        'apps/threadnote/test/evaluation/baselines/code-graph-v1/dirty-overlay-dependency-surface-ratchet.json',
        'utf8',
      ),
    );
    expect(() => validateCodeGraphBenchmarkRatchet(parsedRatchet)).not.toThrow();
    if (!Predicate.isObject(parsedRatchet)) throw new Error('Validated ratchet must be an object');
    const measurements = parsedRatchet.measurements;
    if (!Predicate.isObject(measurements)) throw new Error('Validated ratchet must expose its measurements record');
    const checkedRatchet = {measurements};
    expect(EffectRecord.keys(checkedRatchet.measurements).sort()).toEqual(
      EffectArray.map(artifact.measurements, measurement => measurement.name).sort(),
    );
  });

  it('projects the local physical replay split and rejects inconsistent benchmark evidence', () => {
    const metrics = {
      attributedFilesCompleted: 7,
      batchesCompleted: 1,
      batchesTotal: 1,
      cachedFactReplayBytesCompleted: 4_096,
      changedFactBytesCompleted: 256,
      crossGenerationShardFilesCompleted: 0,
      exactGenerationShardFilesCompleted: 5,
      materializedShardReplayBytesCompleted: 3_072,
      rawFactReplayBytesCompleted: 1_024,
      sourceBytesCompleted: 2_048,
      sourceBytesTotal: 2_048,
    };

    expect(dirtyOverlayReplayEvidence(metrics, 256)).toEqual({
      attributedFiles: 7,
      cachedFactReplayBytes: 4_096,
      changedFactBytes: 256,
      crossGenerationShardFiles: 0,
      exactGenerationShardFiles: 5,
      materializedShardReplayBytes: 3_072,
      rawFactReplayBytes: 1_024,
    });
    expect(() => dirtyOverlayReplayEvidence({...metrics, cachedFactReplayBytesCompleted: 4_095}, 256)).toThrow(
      'replay-byte split is inconsistent',
    );
    expect(() => dirtyOverlayReplayEvidence({...metrics, rawFactReplayBytesCompleted: undefined}, 256)).toThrow(
      'did not retain complete physical replay evidence',
    );
    expect(() => dirtyOverlayReplayEvidence(undefined, 0)).toThrow('did not retain complete physical replay evidence');
    expect(() => dirtyOverlayReplayEvidence(metrics, 255)).toThrow('changed-fact byte evidence is inconsistent');
  });
});
