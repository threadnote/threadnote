import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {existsSync} from '@threadnote/testing/node-fs';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS,
  CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  calibratedCodeGraphEtaConfidence,
  makeCodeGraphBuildReporter,
  observeCodeGraphBuildStatus,
  readAllCodeGraphBuildStatuses,
  readCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
} from '@threadnote/graph/build_status';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {writerSessionOptions} from '@threadnote/graph/indexer/build';
import {runCodeGraphStatus} from '@threadnote/threadnote/code_graph/commands';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import {codeGraphLanguagePackStatuses} from '@threadnote/graph/query/status_helpers';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {isJsonObject} from '@threadnote/platform/json';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphProgress,
  type CodeGraphResolutionActivity,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '@threadnote/graph/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function object(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object.');
  return value;
}

function objects(value: unknown): Record<string, unknown>[] {
  if (!EffectArray.isArray(value)) throw new Error('Expected an array of JSON objects.');
  return EffectArray.map(value, object);
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string.');
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Expected a number.');
  return value;
}

describe('code graph cross-process build status', () => {
  const homes: string[] = [];
  const languagePackTotal = codeGraphLanguagePackStatuses(BUILTIN_LANGUAGE_PACK_REGISTRY).length;

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  it('calibrates ETA confidence from variance, prediction error, and silent intervals', () => {
    const stable = {
      completed: 500,
      cumulativeRate: 1,
      intervalSamplesMilliseconds: Array.from({length: 24}, () => 1_000),
      rateForecastErrorSamples: Array.from({length: 23}, () => 0.05),
      rateSamples: Array.from({length: 24}, (_, index) => 1 + ((index % 3) - 1) * 0.01),
      sampleCount: 24,
      silenceMilliseconds: 1_000,
      total: 1_000,
    };
    expect(calibratedCodeGraphEtaConfidence(stable)).toBe('high');
    expect(
      calibratedCodeGraphEtaConfidence({
        ...stable,
        rateForecastErrorSamples: Array.from({length: 23}, (_, index) => (index % 2 === 0 ? 0.9 : 0.1)),
        rateSamples: Array.from({length: 24}, (_, index) => (index % 2 === 0 ? 0.1 : 4)),
      }),
    ).toBe('low');
    expect(calibratedCodeGraphEtaConfidence({...stable, silenceMilliseconds: 60_000})).toBe('low');
    expect(
      calibratedCodeGraphEtaConfidence({...stable, rateSamples: stable.rateSamples.slice(0, 2), sampleCount: 2}),
    ).toBeUndefined();
  });

  effectIt.effect('round-trips additive project-closure boundary evidence without changing legacy assessment', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectory({prefix: 'threadnote-graph-fallback-boundary-'});
      homes.push(home);
      const identity = fixtureIdentity(home);
      const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
      const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
      yield* reporter.progress({
        completed: 0,
        metrics: {
          batchesCompleted: 0,
          batchesTotal: 1,
          fallbackBoundary: {
            changedFiles: 3,
            limit: 128,
            metric: 'affected-files',
            observedAtDecision: 1_404,
            stage: 'project-closure-selection',
          },
          fallbackReason: 'project-closure-unbounded',
          mode: 'full',
          sourceBytesCompleted: 0,
          sourceBytesTotal: 1,
        },
        phase: 'materializing',
        reused: 0,
        total: 1,
        unit: 'files',
      });

      expect((yield* readCodeGraphBuildStatuses(layout))[0]).toMatchObject({
        materialization: {
          metrics: {
            fallbackBoundary: {
              changedFiles: 3,
              limit: 128,
              metric: 'affected-files',
              observedAtDecision: 1_404,
              stage: 'project-closure-selection',
            },
            fallbackReason: 'project-closure-unbounded',
          },
        },
      });

      const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
      const statusFile = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          yield* fs.readDirectory(directory),
          __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
        ),
      )!;
      const statusPath = path.join(directory, statusFile);
      const status = object(JSON.parse(yield* fs.readFileString(statusPath)));
      const materialization = object(status.materialization);
      const metrics = object(materialization.metrics);
      const fallbackBoundary = object(metrics.fallbackBoundary);
      yield* fs.writeFileString(
        statusPath,
        `${JSON.stringify({
          ...status,
          materialization: {
            ...materialization,
            metrics: {
              ...metrics,
              fallbackBoundary: {
                ...fallbackBoundary,
                metric: 'candidate-projection-observations',
                stage: 'resolution-candidate-scan',
              },
            },
          },
        })}\n`,
      );
      expect((yield* readCodeGraphBuildStatuses(layout))[0]).toMatchObject({
        materialization: {
          metrics: {
            fallbackBoundary: {
              metric: 'candidate-projection-observations',
              stage: 'resolution-candidate-scan',
            },
          },
        },
      });
      for (const [stage, metric] of [
        ['project-closure-selection', 'candidate-reexports'],
        ['resolution-candidate-scan', 'affected-files'],
        ['resolution-candidate-rewrite', 'candidate-lookup-keys'],
      ] as const) {
        yield* fs.writeFileString(
          statusPath,
          `${JSON.stringify({
            ...status,
            materialization: {
              ...materialization,
              metrics: {
                ...metrics,
                fallbackBoundary: {...fallbackBoundary, metric, stage},
              },
            },
          })}\n`,
        );
        expect(yield* readCodeGraphBuildStatuses(layout)).toEqual([]);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('round-trips candidate-closure fallback reasons without inventing file-set evidence', () =>
    Effect.forEach(
      ['cache-incomplete', 'fact-budget-expanded', 'project-closure-incomplete', 'project-closure-unbounded'] as const,
      fallbackReason =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectory({prefix: 'threadnote-graph-candidate-fallback-'});
          homes.push(home);
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
          yield* reporter.progress({
            completed: 0,
            metrics: {
              batchesCompleted: 0,
              batchesTotal: 1,
              fallbackReason,
              mode: 'full',
              sourceBytesCompleted: 0,
              sourceBytesTotal: 1,
            },
            phase: 'materializing',
            reused: 0,
            total: 1,
            unit: 'files',
          });
          const status = (yield* readCodeGraphBuildStatuses(layout))[0];
          expect(status).toMatchObject({
            materialization: {metrics: {fallbackReason}},
          });
          expect(status?.materialization?.metrics?.fallbackAssessment).toBeUndefined();
        }),
      {concurrency: 1},
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('publishes a reporter ETA only after stable phase-local throughput', () =>
    Effect.gen(function* () {
      const confidenceFor = (delays: readonly number[]) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectory({prefix: 'threadnote-graph-eta-reporter-'});
          homes.push(home);
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
          yield* reporter.progress({completed: 0, phase: 'materializing', reused: 0, total: 50, unit: 'files'});
          for (const [index, milliseconds] of delays.entries()) {
            yield* TestClock.adjust(milliseconds);
            yield* reporter.progress({
              completed: index + 1,
              phase: 'materializing',
              reused: 0,
              total: 50,
              unit: 'files',
            });
          }
          return (yield* readCodeGraphBuildStatuses(layout))[0]?.eta;
        }).pipe(provideTestLayer(ApplicationLayer));

      const stable = yield* confidenceFor(Array.from({length: 24}, () => 50));
      expect(stable).toMatchObject({scope: 'phase'});
      expect(['high', 'medium']).toContain(stable?.confidence);
      expect(yield* confidenceFor(Array.from({length: 24}, (_, index) => (index % 2 === 0 ? 5 : 90)))).toBeUndefined();
    }),
  );

  it('keeps active owner and queued observer jobs separate and atomically readable', async () => {
    const home = await mkdtemp('threadnote-graph-build-status-');
    homes.push(home);
    const result = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const owner = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* owner.progress({completed: 8, phase: 'materializing', reused: 5, total: 20, unit: 'files'});
        const observer = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* observer.progress({phase: 'waiting', reason: 'database-writer'});
        return {
          global: yield* readAllCodeGraphBuildStatuses(home),
          scoped: yield* readCodeGraphBuildStatuses(layout),
        };
      }),
    );
    const statuses = result.scoped;

    expect(statuses).toHaveLength(2);
    expect(new Set(EffectArray.map(statuses, status => status.buildId)).size).toBe(2);
    expect(EffectArray.every(statuses, status => status.observation.liveness === 'active')).toBe(true);
    expect(EffectArray.map(statuses, status => status.state).sort()).toEqual(['queued', 'running']);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(statuses, status => status.state === 'queued'))?.subphase,
    ).toBe('database-writer');
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(statuses, status => status.state === 'running'))?.counters,
    ).toMatchObject({
      completed: 8,
      reused: 5,
      total: 20,
      unit: 'files',
    });
    expect(JSON.stringify(statuses)).not.toContain(home);
    expect(result.global).toHaveLength(2);
    expect(
      EffectArray.every(result.global, status => status.managerContext?.worktreePath === `${home}/repository`),
    ).toBe(true);
    expect(EffectArray.every(result.global, status => status.managerContext?.branch === 'feature/manager-labels')).toBe(
      true,
    );
  });

  effectIt.effect('keeps scoped Manager progress separate and verifies each scope-specific owner lock', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* Effect.acquireRelease(
            fs.makeTempDirectory({prefix: 'threadnote-graph-scoped-manager-status-'}),
            directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.ignore),
          );
          const identity = fixtureIdentity(home);
          const fullLayout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const scopeId = `code-graph-scope:${Effect2.pipe('a', EffectString.repeat(64))}`;
          const scopedLayout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId, scopeId);
          const full = yield* makeCodeGraphBuildReporter(identity, fullLayout);
          const scoped = yield* makeCodeGraphBuildReporter(identity, scopedLayout);

          const fullStatuses = yield* readCodeGraphBuildStatuses(fullLayout);
          const scopedStatuses = yield* readCodeGraphBuildStatuses(scopedLayout);

          expect(EffectArray.map(fullStatuses, status => status.identity.scopeId ?? 'full-repository')).toEqual([
            'full-repository',
          ]);
          expect(EffectArray.map(scopedStatuses, status => status.identity.scopeId)).toEqual([scopeId]);

          const observed = yield* withExclusiveFileLock(
            fs,
            fullLayout.lockPath,
            {
              onAcquired: () => full.markWorktreeLockHeld(true),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 1_000,
              waitTimeoutMilliseconds: 1_000,
            },
            withExclusiveFileLock(
              fs,
              scopedLayout.lockPath,
              {
                onAcquired: () => scoped.markWorktreeLockHeld(true),
                retryIntervalMilliseconds: 5,
                staleAfterMilliseconds: 1_000,
                waitTimeoutMilliseconds: 1_000,
              },
              readAllCodeGraphBuildStatuses(home),
            ),
          );
          const selected = selectCodeGraphBuildStatuses(observed);

          expect(selected.builds).toHaveLength(2);
          expect(
            EffectArray.map(selected.builds, status => status.identity.scopeId ?? 'full-repository').sort(),
          ).toEqual([scopeId, 'full-repository']);
          expect(EffectArray.every(selected.builds, status => status.coordination?.role === 'owner')).toBe(true);
          expect(EffectArray.every(selected.builds, status => status.coordination?.lockVerified === true)).toBe(true);
          expect(
            EffectArray.every(selected.builds, status => status.managerContext?.worktreePath === identity.repoRoot),
          ).toBe(true);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    ),
  );

  effectIt.effect('resumes the builder status when it acquires a contended writer lock', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectory({prefix: 'threadnote-graph-writer-acquired-'});
      homes.push(home);
      const identity = fixtureIdentity(home);
      const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
      const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
      const activeProgress = {completed: 8, phase: 'materializing', reused: 0, total: 10, unit: 'files'} as const;
      yield* reporter.progress(activeProgress);
      const writer = writerSessionOptions(layout, {onProgress: progress => reporter.progress(progress)}, () =>
        reporter.progress(activeProgress),
      );

      yield* writer.onWriterContention();
      expect((yield* readCodeGraphBuildStatuses(layout))[0]).toMatchObject({
        phase: 'waiting',
        state: 'queued',
        subphase: 'database-writer',
      });
      yield* writer.onWriterAcquired();
      expect((yield* readCodeGraphBuildStatuses(layout))[0]).toMatchObject({
        counters: {completed: 8, total: 10},
        phase: 'materializing',
        state: 'running',
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('persists privacy-safe superseded-snapshot reclamation progress', async () => {
    const home = await mkdtemp('threadnote-graph-reclaim-status-');
    homes.push(home);
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          completed: 0,
          pagesCompleted: 0,
          phase: 'reclaiming',
          rowsDeleted: 0,
          total: 1,
          unit: 'snapshots',
        });
        yield* reporter.progress({
          completed: 0,
          pagesCompleted: 3,
          phase: 'reclaiming',
          rowsDeleted: 15_000,
          total: 1,
          unit: 'snapshots',
        });
        return (yield* readCodeGraphBuildStatuses(layout))[0];
      }),
    );

    expect(status).toMatchObject({
      counters: {
        completed: 0,
        pagesCompleted: 3,
        rowsDeleted: 15_000,
        total: 1,
        unit: 'snapshots',
      },
      phase: 'reclaiming',
      subphase: 'superseded-snapshots',
    });
    expect(JSON.stringify(status)).not.toContain(home);
  });

  it('persists materialization commits while throttling ordinary steady-state counter writes', async () => {
    const home = await mkdtemp('threadnote-graph-build-throttle-');
    homes.push(home);
    const observations = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({completed: 1, phase: 'materializing', reused: 0, total: 10, unit: 'files'});
        const afterTransition = (yield* readCodeGraphBuildStatuses(layout))[0];
        yield* reporter.progress({completed: 2, phase: 'materializing', reused: 0, total: 10, unit: 'files'});
        const afterThrottledCounter = (yield* readCodeGraphBuildStatuses(layout))[0];
        yield* reporter.progress({
          completed: 0,
          embedded: 0,
          phase: 'embedding',
          reused: 0,
          total: 10,
          unit: 'symbols',
        });
        const afterPhaseTransition = (yield* readCodeGraphBuildStatuses(layout))[0];
        yield* reporter.progress({
          completed: 1,
          embedded: 1,
          phase: 'embedding',
          reused: 0,
          total: 10,
          unit: 'symbols',
        });
        const afterThrottledEmbeddingCounter = (yield* readCodeGraphBuildStatuses(layout))[0];
        yield* Effect.sleep(CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS + 10);
        yield* reporter.progress({
          completed: 3,
          embedded: 3,
          phase: 'embedding',
          reused: 0,
          total: 10,
          unit: 'symbols',
        });
        const afterInterval = (yield* readCodeGraphBuildStatuses(layout))[0];
        return {
          afterInterval,
          afterPhaseTransition,
          afterThrottledCounter,
          afterThrottledEmbeddingCounter,
          afterTransition,
        };
      }),
    );

    expect(observations.afterTransition).toMatchObject({
      counters: {completed: 1},
      phase: 'materializing',
    });
    expect(observations.afterThrottledCounter).toMatchObject({
      counters: {completed: 2},
      phase: 'materializing',
    });
    expect(observations.afterPhaseTransition).toMatchObject({
      counters: {completed: 0},
      phase: 'embedding',
    });
    expect(observations.afterThrottledEmbeddingCounter).toMatchObject({
      counters: {completed: 0},
      phase: 'embedding',
    });
    expect(observations.afterInterval).toMatchObject({
      counters: {completed: 3, embedded: 3},
      phase: 'embedding',
    });
  });

  effectIt.effect.each(['scanning', 'materializing'] as const)(
    'throttles %s ETA metric updates without delaying completed file batches',
    phase => checkProgressWriteThrottle(phase, 1_000_000, 3),
  );

  fcEffectProp(
    effectIt,
    'keeps status write throttling independent of ETA unit scale and update count',
    {
      phase: FC.constantFrom('scanning' as const, 'materializing' as const),
      unitScale: FC.integer({min: 100, max: 1_000_000}),
      updates: FC.integer({min: 1, max: 8}),
    },
    ({phase, unitScale, updates}) => checkProgressWriteThrottle(phase, unitScale, updates),
    {fastCheck: {numRuns: 20}},
  );

  it('persists completed scan batches immediately without leaking the in-flight path', async () => {
    const home = await mkdtemp('threadnote-graph-build-scan-progress-');
    homes.push(home);
    const secretPath = 'customers/private-project/internal/architecture.ts';
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          accepted: 8,
          activity: {
            batchCompleted: 1,
            batchTotal: 8,
            bytes: 4_096,
            classifier: 'typescript',
            factsBytes: 2_048,
            language: 'typescript',
            parseMilliseconds: 1_250,
            path: secretPath,
            relations: 7,
            role: 'source',
            sizeBucket: '0-16KiB',
            stage: 'extracting',
            symbols: 3,
          },
          completed: 0,
          excluded: 2,
          metrics: {
            factsBytesCompleted: 2_048,
            sourceBytesCompleted: 4_096,
            sourceBytesTotal: 32_768,
            workUnitsCompleted: 8_192,
            workUnitsTotal: 65_536,
          },
          phase: 'scanning',
          skipped: 0,
          timings: {
            extractionMilliseconds: 1_250,
            persistenceMilliseconds: 0,
            readingMilliseconds: 1.5,
            serializationMilliseconds: 25,
          },
          total: 10,
          unit: 'files',
        });
        yield* reporter.progress({
          accepted: 8,
          completed: 8,
          excluded: 2,
          phase: 'scanning',
          skipped: 0,
          total: 10,
          unit: 'files',
        });
        return (yield* readCodeGraphBuildStatuses(layout))[0];
      }),
    );

    expect(status.counters).toMatchObject({completed: 8, total: 10});
    expect(status.extraction).toMatchObject({
      completedFiles: 1,
      metrics: {
        factsBytesCompleted: 2_048,
        sourceBytesCompleted: 4_096,
        sourceBytesTotal: 32_768,
        workUnitsCompleted: 8_192,
        workUnitsTotal: 65_536,
      },
      slowFiles: 1,
      topSlowFiles: [
        {
          classifier: 'typescript',
          durationMilliseconds: 1_250,
          extension: '.ts',
          factsBytes: 2_048,
          language: 'typescript',
          relations: 7,
          role: 'source',
          sizeBucket: '0-16KiB',
          sourceBytes: 4_096,
          symbols: 3,
        },
      ],
    });
    expect(status.extraction?.topSlowFiles[0]?.pathHash).toMatch(/^[a-f0-9]{64}$/);
    expect(status.timings).toEqual({
      extractionMilliseconds: 1_250,
      persistenceMilliseconds: 0,
      readingMilliseconds: 1.5,
      serializationMilliseconds: 25,
    });
    expect(JSON.stringify(status)).not.toContain(secretPath);
  });

  it('keeps cumulative resolution activity anchored to the phase across alias passes', async () => {
    const home = await mkdtemp('threadnote-graph-resolution-phase-time-');
    homes.push(home);
    const observations = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          activity: resolutionActivity({pass: 1, referencesCompleted: 5_000, referencesExamined: 5_000}),
          phase: 'resolving',
          subphase: 'references',
        });
        const first = (yield* readCodeGraphBuildStatuses(layout))[0];
        yield* Effect.sleep(10);
        yield* reporter.progress({
          activity: resolutionActivity({pass: 2, referencesCompleted: 5_000, referencesExamined: 15_000}),
          phase: 'resolving',
          subphase: 'references',
        });
        const second = (yield* readCodeGraphBuildStatuses(layout))[0];
        return {first, second};
      }),
    );

    expect(observations.second.resolution?.activity.pass).toBe(2);
    expect(observations.second.resolution?.activity.transactionStageMilliseconds).toEqual({
      preparingBatch: 5,
      retiringReferences: 5,
      updatingAnalysis: 10,
      writingAliases: 0,
      writingEdges: 30,
    });
    expect(observations.second.resolution?.activity.startedAt).toBe(observations.first.resolution?.activity.startedAt);
    expect(observations.second.timestamps.phaseStartedAt).toBe(observations.first.timestamps.phaseStartedAt);
  });

  it('persists privacy-safe materialization substages, row totals, timings, and TEMP database high-water', async () => {
    const home = await mkdtemp('threadnote-graph-build-materialization-progress-');
    homes.push(home);
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        const metrics = (completed: number) => ({
          attributionMilliseconds: completed * 3,
          batchesCompleted: completed,
          batchesTotal: 10,
          cachedFactBytesCompleted: completed * 40_000,
          cachedFactBytesTotal: 400_000,
          factsBytesCompleted: completed * 50_000,
          factsBytesTotal: 500_000,
          loadingMilliseconds: completed * 2,
          rows: {
            deduplicatedEdges: completed * 5,
            deduplicatedReferences: completed * 3,
            edges: completed * 700,
            lookupKeys: completed * 300,
            referenceCandidates: completed * 500,
            references: completed * 100,
            symbols: completed * 200,
            terms: completed * 1_100,
          },
          sourceBytesCompleted: completed * 10_000,
          sourceBytesTotal: 100_000,
          subphaseMilliseconds: {
            attributionCompute: completed,
            factBatchPreparation: completed * 2,
            shardAssociation: completed * 3,
            shardPersistence: completed * 4,
            shardSerialization: completed * 5,
          },
          storage: {
            availableBytes: 2_000_000,
            estimateBasis: 'final-fact-bytes' as const,
            estimatedConcurrentBuildBytes: 500_000,
            estimatedDurableSnapshotBytes: 200_000,
            estimatedJournalBytes: 100_000,
            estimatedRequiredBytes: 1_000_000,
            estimatedTemporaryDatabaseBytes: 200_000,
            temporaryDatabaseBytes: completed * 20_000,
            temporaryDatabaseHighWaterBytes: completed * 25_000,
          },
          transactionMilliseconds: completed * 10,
        });
        yield* reporter.progress({
          activity: {
            batchCompleted: 0,
            batchTotal: 10,
            sourceBytes: 10_000,
            stage: 'loading-cache',
          },
          completed: 0,
          metrics: metrics(0),
          phase: 'materializing',
          reused: 90,
          total: 10,
          unit: 'files',
        });
        for (let completed = 1; completed <= 5; completed += 1) {
          yield* Effect.sleep(20);
          yield* reporter.progress({
            activity: {
              batchCompleted: completed,
              batchTotal: 10,
              cachedFactBytes: 40_000,
              elapsedMilliseconds: 20,
              factsBytes: 50_000,
              rows: {
                deduplicatedEdges: 5,
                deduplicatedReferences: 3,
                edges: 700,
                lookupKeys: 300,
                referenceCandidates: 500,
                references: 100,
                symbols: 200,
                terms: 1_100,
              },
              sourceBytes: 10_000,
              stage: 'committing',
              transactionMilliseconds: 10,
            },
            completed,
            metrics: metrics(completed),
            phase: 'materializing',
            reused: 90,
            total: 10,
            unit: 'files',
          });
          if (completed < 5) {
            yield* reporter.progress({
              activity: {
                batchCompleted: completed,
                batchTotal: 10,
                sourceBytes: 10_000,
                stage: 'loading-cache',
              },
              completed,
              metrics: metrics(completed),
              phase: 'materializing',
              reused: 90,
              total: 10,
              unit: 'files',
            });
          }
        }
        return (yield* readCodeGraphBuildStatuses(layout))[0];
      }),
    );

    expect(status).toMatchObject({
      counters: {completed: 5, reused: 90, total: 10},
      materialization: {
        activity: {
          batchCompleted: 5,
          batchTotal: 10,
          cachedFactBytes: 40_000,
          factsBytes: 50_000,
          rows: {edges: 700, symbols: 200, terms: 1_100},
          stage: 'committing',
          transactionMilliseconds: 10,
        },
        metrics: {
          batchesCompleted: 5,
          batchesTotal: 10,
          cachedFactBytesCompleted: 200_000,
          cachedFactBytesTotal: 400_000,
          factsBytesCompleted: 250_000,
          factsBytesTotal: 500_000,
          rows: {
            deduplicatedEdges: 25,
            deduplicatedReferences: 15,
            edges: 3_500,
            symbols: 1_000,
            terms: 5_500,
          },
          sourceBytesCompleted: 50_000,
          sourceBytesTotal: 100_000,
          subphaseMilliseconds: {
            attributionCompute: 5,
            factBatchPreparation: 10,
            shardAssociation: 15,
            shardPersistence: 20,
            shardSerialization: 25,
          },
          storage: {
            availableBytes: 2_000_000,
            estimateBasis: 'final-fact-bytes',
            estimatedConcurrentBuildBytes: 500_000,
            estimatedDurableSnapshotBytes: 200_000,
            estimatedJournalBytes: 100_000,
            estimatedRequiredBytes: 1_000_000,
            estimatedTemporaryDatabaseBytes: 200_000,
            temporaryDatabaseBytes: 100_000,
            temporaryDatabaseHighWaterBytes: 125_000,
          },
        },
      },
      phase: 'materializing',
      subphase: 'committing',
    });
    expect(status).not.toHaveProperty('eta');
    expect(Date.parse(status.materialization!.activity!.startedAt)).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(home);
  });

  it('persists the active durable-snapshot activation substage without repository data', async () => {
    const home = await mkdtemp('threadnote-graph-build-activation-progress-');
    homes.push(home);
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          activity: {
            elapsedMilliseconds: 500,
            rows: 4_200,
            stage: 'copying-symbols',
            stageElapsedMilliseconds: 0,
            state: 'started',
          },
          phase: 'activating',
          snapshotId: 'cgsn_activation-progress',
        });
        yield* reporter.progress({
          activity: {
            elapsedMilliseconds: 1_250,
            rows: 42_000,
            stage: 'copying-terms',
            stageElapsedMilliseconds: 750,
            state: 'completed',
            transactionMilliseconds: 125,
          },
          phase: 'activating',
          snapshotId: 'cgsn_activation-progress',
        });
        return (yield* readCodeGraphBuildStatuses(layout))[0];
      }),
    );

    expect(status).toMatchObject({
      activation: {
        activity: {
          elapsedMilliseconds: 1_250,
          rows: 42_000,
          stage: 'copying-terms',
          stageElapsedMilliseconds: 750,
          state: 'completed',
          transactionMilliseconds: 125,
        },
      },
      phase: 'activating',
      subphase: 'copying-terms',
    });
    expect(Date.parse(status.activation!.activity.startedAt)).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(home);
  });

  it('validates owner start identity before trusting a live PID and detects stale heartbeats', async () => {
    const home = await mkdtemp('threadnote-graph-build-owner-');
    homes.push(home);
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({phase: 'waiting'});
        return (yield* readCodeGraphBuildStatuses(layout))[0];
      }),
    );
    const now = Date.parse(status.timestamps.heartbeatAt);

    expect(
      observeCodeGraphBuildStatus(status, {
        isRunning: true,
        nowMilliseconds: now,
        processStartIdentity: `${status.owner.processStartIdentity ?? 'known'}-replacement`,
      }).observation,
    ).toMatchObject({liveness: 'abandoned', reason: 'pid-reused'});

    expect(
      observeCodeGraphBuildStatus(status, {
        isRunning: true,
        nowMilliseconds: now + CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS + 1,
        processStartIdentity: status.owner.processStartIdentity,
      }).observation,
    ).toMatchObject({liveness: 'stalled', reason: 'heartbeat-stale'});

    expect(
      observeCodeGraphBuildStatus(status, {
        isRunning: false,
        nowMilliseconds: now,
      }).observation,
    ).toMatchObject({liveness: 'abandoned', reason: 'owner-exited'});
  });

  it('keeps a lock-verified CPU-bound owner authoritative while counting live waiters separately', async () => {
    const home = await mkdtemp('threadnote-graph-build-selection-');
    homes.push(home);
    const statuses = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const running = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* running.progress({
          completed: 12,
          phase: 'scanning',
          accepted: 12,
          excluded: 0,
          skipped: 0,
          total: 100,
          unit: 'files',
        });
        const waiting = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* waiting.progress({phase: 'waiting'});
        return yield* readCodeGraphBuildStatuses(layout);
      }),
    );
    const running = EffectOption.getOrUndefined(EffectArray.findFirst(statuses, status => status.state === 'running'))!;
    const waiting = EffectOption.getOrUndefined(EffectArray.findFirst(statuses, status => status.state === 'queued'))!;
    const owner = {
      ...running,
      coordination: {lockVerified: true, role: 'owner' as const},
      observation: {
        heartbeatAgeMilliseconds: 60_000,
        liveness: 'stalled' as const,
        reason: 'heartbeat-stale' as const,
      },
    };
    const waiter = {
      ...waiting,
      coordination: {lockVerified: false, role: 'waiter' as const},
      observation: {heartbeatAgeMilliseconds: 10, liveness: 'active' as const},
    };

    const selected = selectCodeGraphBuildStatuses([waiter, owner]);

    expect(selected.builds).toEqual([owner]);
    expect(selected.waiters).toEqual([waiter]);

    const completed = {
      ...owner,
      coordination: {lockVerified: false, role: 'history' as const},
      observation: {heartbeatAgeMilliseconds: 1_000, liveness: 'completed' as const},
      state: 'completed' as const,
    };
    const abandoned = {
      ...owner,
      coordination: {lockVerified: false, role: 'history' as const},
      observation: {
        heartbeatAgeMilliseconds: 120_000,
        liveness: 'abandoned' as const,
        reason: 'owner-exited' as const,
      },
    };
    expect(selectCodeGraphBuildStatuses([abandoned, completed]).builds).toEqual([completed]);

    const otherCheckout = {
      ...owner,
      buildId: `${Effect2.pipe(owner.buildId, EffectString.slice(0, -1))}0`,
      identity: {...owner.identity, checkoutId: Effect2.pipe('f', EffectString.repeat(64))},
    };
    expect(selectCodeGraphBuildStatuses([owner, otherCheckout]).builds).toHaveLength(2);
  });

  it('uses the validated lock lease to keep a progress-silent owner live', async () => {
    const home = await mkdtemp('threadnote-graph-build-lock-liveness-');
    homes.push(home);
    const owner = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({completed: 1, phase: 'materializing', reused: 0, total: 10, unit: 'files'});
        yield* reporter.markWorktreeLockHeld(true);
        const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
        const statusFile = EffectOption.getOrUndefined(
          EffectArray.findFirst(
            yield* fs.readDirectory(directory),
            __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
          ),
        )!;
        const statusPath = path.join(directory, statusFile);
        const status = object(JSON.parse(yield* fs.readFileString(statusPath)));
        const timestamps = object(status.timestamps);
        const stale = DateTime.formatIso(
          DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS - 5_000),
        );
        yield* fs.writeFileString(
          statusPath,
          `${JSON.stringify({...status, timestamps: {...timestamps, heartbeatAt: stale}})}\n`,
        );
        return yield* withExclusiveFileLock(
          fs,
          layout.lockPath,
          {
            retryIntervalMilliseconds: 5,
            staleAfterMilliseconds: 1_000,
            waitTimeoutMilliseconds: 1_000,
          },
          Effect.map(readCodeGraphBuildStatuses(layout), statuses => statuses[0]),
        );
      }),
    );

    expect(owner.coordination).toEqual({lockVerified: true, progressSilent: true, role: 'owner'});
    expect(owner.observation).toMatchObject({liveness: 'active'});
  });

  effectIt.effect('keeps same-process pre-lock contenders separate from their builder', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* Effect.acquireRelease(
            fs.makeTempDirectory({prefix: 'threadnote-graph-same-process-waiter-'}),
            directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.ignore),
          );
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const builder = yield* makeCodeGraphBuildReporter(identity, layout);
          const contenders = yield* Effect.forEach(
            ['home-builder-cap', 'repository-lock', 'request-lock'] as const,
            reason => Effect.map(makeCodeGraphBuildReporter(identity, layout), reporter => ({reason, reporter})),
          );
          const selections = yield* withExclusiveFileLock(
            fs,
            layout.lockPath,
            {
              onAcquired: () => builder.markWorktreeLockHeld(true),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 1_000,
              waitTimeoutMilliseconds: 1_000,
            },
            Effect.gen(function* () {
              yield* builder.progress({completed: 1, phase: 'materializing', reused: 0, total: 2, unit: 'files'});
              yield* Effect.forEach(contenders, contender =>
                contender.reporter.progress({phase: 'waiting', reason: contender.reason}),
              );
              const running = selectCodeGraphBuildStatuses(yield* readCodeGraphBuildStatuses(layout));
              yield* builder.progress({phase: 'waiting', reason: 'database-writer'});
              const writerQueued = selectCodeGraphBuildStatuses(yield* readCodeGraphBuildStatuses(layout));
              return {running, writerQueued};
            }),
          );
          expect(selections.running.builds).toHaveLength(1);
          expect(selections.running.builds[0]?.state).toBe('running');
          expect(selections.running.builds[0]?.coordination?.role).toBe('owner');
          expect(selections.running.waiters).toHaveLength(3);
          expect(EffectArray.every(selections.running.waiters, status => status.coordination?.role === 'waiter')).toBe(
            true,
          );
          expect(selections.writerQueued.builds[0]?.state).toBe('queued');
          expect(selections.writerQueued.builds[0]?.coordination?.role).toBe('owner');
          expect(selections.writerQueued.waiters).toHaveLength(3);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    ),
  );

  effectIt.effect('does not assign a newly registered same-process contender the held worktree lock', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* Effect.acquireRelease(
            fs.makeTempDirectory({prefix: 'threadnote-graph-registered-contender-'}),
            directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.ignore),
          );
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const builder = yield* makeCodeGraphBuildReporter(identity, layout);
          const selected = yield* withExclusiveFileLock(
            fs,
            layout.lockPath,
            {
              onAcquired: () => builder.markWorktreeLockHeld(true),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 1_000,
              waitTimeoutMilliseconds: 1_000,
            },
            Effect.gen(function* () {
              yield* builder.progress({completed: 1, phase: 'materializing', reused: 0, total: 2, unit: 'files'});
              yield* Effect.sleep(2);
              yield* makeCodeGraphBuildReporter(identity, layout);
              return selectCodeGraphBuildStatuses(yield* readCodeGraphBuildStatuses(layout));
            }),
          );
          expect(selected.builds[0]?.buildId).toBe(builder.ownerIdentity.buildId);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    ),
  );

  effectIt.effect('identifies the writer and repository lock owners while indexing waits', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* Effect.acquireRelease(
            fs.makeTempDirectory({prefix: 'threadnote-graph-wait-owners-'}),
            directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.ignore),
          );
          const repository = path.join(home, 'repository');
          yield* fs.makeDirectory(repository, {recursive: true});
          yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const value = 1;\n');
          yield* Effect.sync(() => {
            runGit(repository, ['init', '--quiet']);
            runGit(repository, ['config', 'user.email', 'test@example.invalid']);
            runGit(repository, ['config', 'user.name', 'Threadnote Test']);
            runGit(repository, ['add', 'source.ts']);
            runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
          });
          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath: path.join(home, 'manifest.yaml'),
            user: 'tester',
          };
          const identity = yield* resolveRepositoryIdentity(repository);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
          const lockOptions = {
            retryIntervalMilliseconds: 5,
            staleAfterMilliseconds: 120_000,
            waitTimeoutMilliseconds: 1_000,
          };
          const outputs = yield* withExclusiveFileLock(
            fs,
            layout.lockPath,
            lockOptions,
            withExclusiveFileLock(
              fs,
              layout.databaseWriteLockPath,
              lockOptions,
              Effect.gen(function* () {
                yield* reporter.progress({phase: 'waiting', reason: 'database-writer'});
                const ownerHuman = (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository}))).output;
                const ownerJson = (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true})))
                  .output;
                const waiter = yield* makeCodeGraphBuildReporter(identity, layout);
                yield* waiter.progress({phase: 'waiting', reason: 'repository-lock'});
                return {
                  human: (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository}))).output,
                  json: (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}))).output,
                  ownerHuman,
                  ownerJson,
                };
              }),
            ),
          );
          const status = object(JSON.parse(outputs.json));
          const locks = status.locks === undefined ? undefined : object(status.locks);
          expect(locks?.databaseWriter).toMatchObject({state: 'active', owner: {processId: process.pid}});
          expect(locks?.repository).toMatchObject({state: 'active', owner: {processId: process.pid}});
          expect(outputs.human).toContain(`Database writer lock: PID ${process.pid}`);
          expect(outputs.human).toContain(`Repository lock: PID ${process.pid}`);
          expect(outputs.ownerHuman).toContain('Build: queued · active · waiting/database-writer');
          expect(outputs.ownerHuman).not.toContain('held by build owner');
          expect(JSON.parse(outputs.ownerJson).locks.databaseWriter).toEqual({
            owner: {processId: process.pid},
            state: 'active',
          });
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    ),
  );

  effectIt.effect('attributes a linked worktree repository wait to its own lock', () =>
    TestClock.withLive(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* Effect.acquireRelease(
            fs.makeTempDirectory({prefix: 'threadnote-graph-linked-wait-owner-'}),
            directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.ignore),
          );
          const repository = path.join(home, 'repository');
          yield* fs.makeDirectory(repository, {recursive: true});
          yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const value = 1;\n');
          yield* Effect.sync(() => {
            runGit(repository, ['init', '--quiet']);
            runGit(repository, ['config', 'user.email', 'test@example.invalid']);
            runGit(repository, ['config', 'user.name', 'Threadnote Test']);
            runGit(repository, ['add', 'source.ts']);
            runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
          });
          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath: path.join(home, 'manifest.yaml'),
            user: 'tester',
          };
          const identity = yield* resolveRepositoryIdentity(repository);
          const otherIdentity = {...identity, worktreeId: Effect2.pipe('e', EffectString.repeat(64))};
          const requestedLayout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const otherLayout = codeGraphLayout(path, home, otherIdentity.checkoutId, otherIdentity.worktreeId);
          const reporter = yield* makeCodeGraphBuildReporter(otherIdentity, otherLayout);
          const outputs = yield* withExclusiveFileLock(
            fs,
            otherLayout.lockPath,
            {
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 1_000,
            },
            Effect.gen(function* () {
              yield* reporter.progress({phase: 'waiting', reason: 'repository-lock'});
              return {
                human: (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository}))).output,
                json: (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}))).output,
              };
            }),
          );
          expect(yield* fs.exists(requestedLayout.lockPath)).toBe(false);
          const status = object(JSON.parse(outputs.json));
          const locks = status.locks === undefined ? undefined : object(status.locks);
          expect(locks?.repository).toMatchObject({
            owner: {processId: process.pid},
            state: 'active',
            worktreeId: otherIdentity.worktreeId,
          });
          expect(outputs.human).toContain(`Repository lock (worktree eeeeeeee): PID ${process.pid}`);
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    ),
  );

  it('retains a bounded privacy-safe terminal result without source paths', async () => {
    const home = await mkdtemp('threadnote-graph-build-terminal-');
    homes.push(home);
    const result = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const completed = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* completed.completeSnapshot(fixtureSnapshot(identity));
        const failed = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* failed.fail(TestError.make({message: `Could not read ${home}/private/source.ts while indexing`}));
        return yield* readCodeGraphBuildStatuses(layout);
      }),
    );

    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result, status => status.state === 'completed')),
    ).toMatchObject({
      observation: {liveness: 'completed'},
      result: {edges: 34, files: 12, symbols: 56},
    });
    const failure = EffectOption.getOrUndefined(EffectArray.findFirst(result, status => status.state === 'failed'));
    expect(failure?.observation.liveness).toBe('failed');
    expect(failure?.error?.summary).toContain('<local-path>');
    expect(failure?.error?.summary).not.toContain(home);
    expect(failure?.error?.summary.length).toBeLessThanOrEqual(300);
  });

  it('serves graph status JSON from the sidecar without creating or opening the graph database', async () => {
    const home = await mkdtemp('threadnote-graph-status-command-');
    homes.push(home);
    const repository = join(home, 'repository');
    await mkdir(repository, {recursive: true});
    await writeFile(join(repository, 'source.ts'), 'export const value = 1;\n');
    runGit(repository, ['init', '--quiet']);
    runGit(repository, ['config', 'user.email', 'test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Threadnote Test']);
    runGit(repository, ['add', 'source.ts']);
    runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'tester',
    };

    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const identity = yield* resolveRepositoryIdentity(repository);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const idleOutput = yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}));
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          activity: {
            batchCompleted: 3,
            batchTotal: 10,
            cachedFactBytes: 6_000,
            rows: {edges: 30, symbols: 20},
            sourceBytes: 4_000,
            stage: 'writing-facts',
          },
          completed: 3,
          metrics: {
            batchesCompleted: 3,
            batchesTotal: 10,
            fallbackAssessment: {
              addedFiles: 1,
              changedFiles: 2,
              deletedFiles: 0,
              detail: 'resolution-domain-unowned',
              stage: 'file-set-seed-assessment',
            },
            fallbackReason: 'project-closure-incomplete',
            mode: 'full',
            rows: {edges: 90, symbols: 60},
            sourceBytesCompleted: 12_000,
            sourceBytesTotal: 40_000,
            storage: {
              availableBytes: 100_000,
              durableAvailableBytes: 100_000,
              durableDatabaseBytes: 48_000,
              durableDatabaseFileBytes: 48_000,
              durableDatabaseFileHighWaterBytes: 56_000,
              durableDatabaseGrowthBytes: 8_000,
              durableDatabaseGrowthHighWaterBytes: 16_000,
              durableDatabaseHighWaterBytes: 64_000,
              durableDatabaseStartBytes: 40_000,
              durableFilesystemBytes: 70_000,
              durableFilesystemHighWaterBytes: 90_000,
              durableJournalBytes: 2_000,
              durableJournalHighWaterBytes: 10_000,
              durableSidecarDatabaseBytes: 30_000,
              durableSidecarDatabaseHighWaterBytes: 40_000,
              durableSidecarJournalBytes: 1_000,
              durableSidecarJournalHighWaterBytes: 5_000,
              durableSidecarWalBytes: 0,
              durableSidecarWalHighWaterBytes: 0,
              durableSharedMemoryBytes: 1_000,
              durableSharedMemoryHighWaterBytes: 4_000,
              durableWalBytes: 19_000,
              durableWalHighWaterBytes: 25_000,
              estimatedDurableFilesystemRequiredBytes: 200_000,
              estimatedRequiredBytes: 500_000,
              estimatedTemporaryFilesystemRequiredBytes: 300_000,
              filesystemsShared: true,
              materializationMode: 'direct-persistent',
              temporaryAvailableBytes: 100_000,
              temporaryDatabaseBytes: 24_000,
              temporaryDatabaseHighWaterBytes: 32_000,
            },
          },
          phase: 'materializing',
          reused: 2,
          total: 10,
          unit: 'files',
        });
        yield* fs.writeFileString(path.join(layout.repositoryRoot, 'graph-v2.sqlite'), 'obsolete graph\n');
        yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}));
        const startedAt = yield* Clock.currentTimeMillis;
        const output = yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}));
        const human = yield* captureConsole(runCodeGraphStatus(config, {cwd: repository}));
        return {
          databasePath: layout.databasePath,
          elapsedMilliseconds: (yield* Clock.currentTimeMillis) - startedAt,
          human: human.output,
          idleOutput: Effect2.pipe(idleOutput.output, EffectString.trim),
          output: Effect2.pipe(output.output, EffectString.trim),
        };
      }),
    );

    expect(existsSync(result.databasePath)).toBe(false);
    expect(result.elapsedMilliseconds).toBeLessThan(2_000);
    const status = object(JSON.parse(result.output));
    expect(status).toMatchObject({
      build: {index: 0},
      builds: [{counters: {completed: 3, reused: 2, total: 10}, state: 'running'}],
      obsoleteStores: {bytes: 15, fileCount: 1, unsafeEntryCount: 0},
      projection: {
        builds: {limit: 4, omitted: 0, returned: 1, total: 1},
        languagePacks: {limit: 4, omitted: languagePackTotal - 4, returned: 4, total: languagePackTotal},
        queuedWorktreeIds: {limit: 4, omitted: 0, returned: 0, total: 0},
        waiters: {limit: 4, omitted: 0, returned: 0, total: 0},
      },
      type: 'code-graph-status',
      version: 5,
    });
    expect(JSON.stringify(status)).not.toContain('fallbackAssessment');
    expect(JSON.stringify(status)).not.toContain('temporaryDatabaseHighWaterBytes');
    expect(Buffer.byteLength(result.output)).toBeLessThan(9_000);
    const idleStatus = object(JSON.parse(result.idleOutput));
    expect(idleStatus).toMatchObject({build: null, builds: [], type: 'code-graph-status', version: 5});
    expect(EffectRecord.keys(idleStatus).sort()).toEqual(EffectRecord.keys(status).sort());
    expect(result.human).toContain('Current activity: writing graph facts');
    expect(result.human).toContain('full materialization');
    expect(result.human).toContain('incremental fallback: project closure incomplete');
    expect(result.human).toContain('23.4 KiB current TEMP database');
    expect(result.human).toContain('31.3 KiB TEMP database high-water');
    expect(result.human).toContain('46.9 KiB allocated durable pages');
    expect(result.human).toContain('62.5 KiB allocated-page high-water');
    expect(result.human).toContain('15.6 KiB main-database growth');
    expect(result.human).toContain('87.9 KiB DB + sidecars high-water');
    expect(result.human).toContain('24.4 KiB WAL high-water');
    expect(result.human).toContain('9.77 KiB rollback-journal high-water');
    expect(result.human).toContain('direct persistent materialization');
    expect(result.human).toContain('488 KiB combined estimate');
    expect(result.human).toContain('rollback journals excluded from TEMP totals');
    expect(result.human).toContain(
      'Warning: low disk: 97.7 KiB available is below the 488 KiB conservative combined estimate',
    );
    expect(result.human).toContain('indexing continues with live telemetry');
  });

  effectIt.effect('serves an in-flight scoped build before its first ready snapshot', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-scoped-status-command-'));
      homes.push(home);
      const repository = join(home, 'repository');
      yield* Effect.promise(() => mkdir(join(repository, 'apps', 'scoped', 'src'), {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(repository, 'package.json'), '{"private":true,"workspaces":["apps/*"]}\n'),
      );
      yield* Effect.promise(() =>
        writeFile(join(repository, 'apps', 'scoped', 'package.json'), '{"name":"scoped-status-fixture"}\n'),
      );
      yield* Effect.promise(() =>
        writeFile(join(repository, 'apps', 'scoped', 'src', 'source.ts'), 'export const scopedValue = 1;\n'),
      );
      runGit(repository, ['init', '--quiet']);
      runGit(repository, ['config', 'user.email', 'test@example.invalid']);
      runGit(repository, ['config', 'user.name', 'Threadnote Test']);
      runGit(repository, ['add', '.']);
      runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
      const manifestPath = join(home, 'manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          `version: 1\nprojects:\n  - name: scoped\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/scoped\n    seed: []\n    graph:\n      roots: ["apps/scoped"]\n      closure: dependencies\n      include: []\n`,
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'tester',
      };

      const path = yield* Path.Path;
      const query = yield* CodeGraphQueryService;
      const observed = yield* query.status(home, repository, {manifestPath, project: 'scoped'});
      const scopeKey = observationFromCodeGraphStatus(observed)?.projectScope?.scope?.scopeKey;
      if (scopeKey === undefined) return yield* Effect.die('Expected a resolved project graph scope.');
      const reporter = yield* makeCodeGraphBuildReporter(
        observed.identity,
        codeGraphLayout(path, home, observed.identity.checkoutId, observed.identity.worktreeId, scopeKey),
      );
      yield* reporter.progress({
        accepted: 1,
        completed: 1,
        excluded: 0,
        phase: 'scanning',
        skipped: 0,
        total: 2,
        unit: 'files',
      });
      const result = yield* captureConsole(
        runCodeGraphStatus(config, {cwd: repository, json: true, project: 'scoped'}),
      );
      const output = Effect2.pipe(result.output, EffectString.trim);

      expect(JSON.parse(output)).toMatchObject({
        build: {index: 0},
        builds: [
          {
            phase: 'scanning',
            state: 'running',
          },
        ],
        readySnapshot: null,
        stale: true,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('does not let another worktree sidecar hide the current ready snapshot', async () => {
    const home = await mkdtemp('threadnote-graph-status-ready-');
    homes.push(home);
    const repository = join(home, 'repository');
    await mkdir(repository, {recursive: true});
    await writeFile(join(repository, 'source.ts'), 'export const readyValue = 1;\n');
    runGit(repository, ['init', '--quiet']);
    runGit(repository, ['config', 'user.email', 'test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Threadnote Test']);
    runGit(repository, ['add', 'source.ts']);
    runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'tester',
    };

    const output = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const indexer = yield* CodeGraphIndexer;
        const summary = yield* indexer.index({cwd: repository, threadnoteHome: home});
        const currentLayout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
        yield* fs.remove(path.join(currentLayout.repositoryRoot, 'build-status', summary.identity.worktreeId), {
          force: true,
          recursive: true,
        });
        const otherIdentity = {...summary.identity, worktreeId: Effect2.pipe('e', EffectString.repeat(64))};
        const otherLayout = codeGraphLayout(path, home, otherIdentity.checkoutId, otherIdentity.worktreeId);
        const other = yield* makeCodeGraphBuildReporter(otherIdentity, otherLayout);
        yield* other.completeSnapshot({...summary.snapshot, worktreeId: otherIdentity.worktreeId});
        return {
          human: (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository}))).output,
          json: Effect2.pipe(
            (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}))).output,
            EffectString.trim,
          ),
        };
      }),
    );
    const status = object(JSON.parse(output.json));
    expect(status.build).toBeNull();
    const builds = objects(status.builds);
    expect(builds).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({worktreeId: Effect2.pipe('e', EffectString.repeat(64))}),
      }),
    ]);
    const readySnapshot = status.readySnapshot === undefined ? undefined : object(status.readySnapshot);
    expect(string(readySnapshot?.id)).toMatch(/^cgsn_/);
    expect(status.stale).toBe(false);
    expect(output.human).toContain('Ready snapshot: cgsn_');
  });

  it('bounds graph status JSON and pins the exact current worktree build', async () => {
    const home = await mkdtemp('threadnote-graph-status-bounded-');
    homes.push(home);
    const repository = join(home, 'repository');
    await mkdir(repository, {recursive: true});
    await writeFile(join(repository, 'source.ts'), 'export const bounded = true;\n');
    runGit(repository, ['init', '--quiet']);
    runGit(repository, ['config', 'user.email', 'test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Threadnote Test']);
    runGit(repository, ['add', 'source.ts']);
    runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'tester',
    };

    const result = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = yield* resolveRepositoryIdentity(repository);
        const identities = [identity];
        for (let index = 1; index <= 12; index += 1) {
          identities.push({...identity, worktreeId: Effect2.pipe(index.toString(16), EffectString.repeat(64))});
        }
        for (const candidate of identities) {
          const reporter = yield* makeCodeGraphBuildReporter(
            candidate,
            codeGraphLayout(path, home, candidate.checkoutId, candidate.worktreeId),
          );
          yield* reporter.completeSnapshot(fixtureSnapshot(candidate));
        }
        const json = yield* captureConsole(
          runCodeGraphStatus(config, {buildLimit: 2, cwd: repository, json: true, languagePackLimit: 2}),
        );
        const human = yield* captureConsole(runCodeGraphStatus(config, {cwd: repository}));
        const humanLimitError = yield* runCodeGraphStatus(config, {buildLimit: 2, cwd: repository}).pipe(
          Effect.match({
            onFailure: error => (error instanceof Error ? error.message : String(error)),
            onSuccess: () => undefined,
          }),
        );
        const humanLanguagePackLimitError = yield* runCodeGraphStatus(config, {
          cwd: repository,
          languagePackLimit: 2,
        }).pipe(
          Effect.match({
            onFailure: error => (error instanceof Error ? error.message : String(error)),
            onSuccess: () => undefined,
          }),
        );
        return {
          human: human.output,
          humanLanguagePackLimitError,
          humanLimitError,
          json: Effect2.pipe(json.output, EffectString.trim),
          worktreeId: identity.worktreeId,
        };
      }),
    );
    const status = object(JSON.parse(result.json));
    const build = status.build === null ? null : object(status.build);
    const builds = objects(status.builds);
    const projection = object(status.projection);
    const projectedBuilds = object(projection.builds);
    const projectedLanguagePacks = object(projection.languagePacks);
    if (build === null) throw new Error('Expected an active build.');
    const buildIndex = number(build.index);
    expect(number(status.version)).toBe(5);
    expect(string(build.worktreeId)).toBe(result.worktreeId);
    expect(builds).toHaveLength(2);
    expect(EffectArray.map(builds, entry => string(object(entry.identity).worktreeId))).toContain(result.worktreeId);
    expect(string(object(builds[buildIndex]).buildId)).toBe(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(builds, entry => string(object(entry.identity).worktreeId) === result.worktreeId),
      )?.buildId,
    );
    expect(projectedBuilds).toEqual({limit: 2, omitted: 11, returned: 2, total: 13});
    if (!EffectArray.isArray(status.languagePacks)) throw new Error('Expected language-pack summaries.');
    const languagePacks = status.languagePacks;
    expect(languagePacks).toHaveLength(2);
    expect(projectedLanguagePacks).toEqual({
      limit: 2,
      omitted: languagePackTotal - languagePacks.length,
      returned: languagePacks.length,
      total: languagePackTotal,
    });
    expect(result.human).toContain('Build: completed');
    expect(result.humanLimitError).toBe('Use --build-limit only with --json.');
    expect(result.humanLanguagePackLimitError).toBe('Use --language-pack-limit only with --json.');
  });
});

function resolutionActivity(
  overrides: Pick<CodeGraphResolutionActivity, 'pass' | 'referencesCompleted' | 'referencesExamined'>,
): CodeGraphResolutionActivity {
  return {
    aliasesDiscovered: 2,
    elapsedMilliseconds: overrides.referencesExamined,
    matchingMilliseconds: 100,
    pageCompleted: 1,
    pageTotal: 2,
    pagesCompleted: overrides.referencesExamined / 5_000,
    referencesTotal: 10_000,
    resolved: 3,
    transactionMilliseconds: 50,
    transactionStageMilliseconds: {
      preparingBatch: 5,
      retiringReferences: 5,
      updatingAnalysis: 10,
      writingAliases: 0,
      writingEdges: 30,
    },
    ...overrides,
  };
}

function checkProgressWriteThrottle(phase: 'scanning' | 'materializing', unitScale: number, updates: number) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-build-throttle-units-'});
    const identity = fixtureIdentity(home);
    const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
    let writes = 0;
    const observedFs = FileSystem.FileSystem.of({
      ...fs,
      rename: (from, to) =>
        fs.rename(from, to).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (Effect2.pipe(to, EffectString.endsWith('.json'))) writes += 1;
            }),
          ),
        ),
    });
    const reporter = yield* makeCodeGraphBuildReporter(identity, layout).pipe(
      Effect.provideService(FileSystem.FileSystem, observedFs),
    );
    const totalUnits = (updates + 3) * unitScale;
    const progress = (completed: number, completedUnits: number): CodeGraphProgress =>
      phase === 'scanning'
        ? {
            accepted: 10,
            completed,
            excluded: 0,
            metrics: {
              factsBytesCompleted: completedUnits,
              sourceBytesCompleted: completedUnits,
              sourceBytesTotal: totalUnits,
              workUnitsCompleted: completedUnits,
              workUnitsTotal: totalUnits,
            },
            phase,
            skipped: 0,
            total: 10,
            unit: 'files',
          }
        : {
            completed,
            metrics: {
              batchesCompleted: completed,
              batchesTotal: 10,
              factsBytesCompleted: completedUnits,
              factsBytesTotal: totalUnits,
              sourceBytesCompleted: completedUnits,
              sourceBytesTotal: totalUnits,
            },
            phase,
            reused: 0,
            total: 10,
            unit: 'files',
          };

    expect(writes).toBe(1);
    yield* reporter.progress(progress(0, 0));
    expect(writes).toBe(2);
    for (let index = 1; index <= updates; index += 1) {
      yield* reporter.progress(progress(0, index * unitScale));
    }
    expect(writes).toBe(2);

    yield* reporter.progress(progress(1, updates * unitScale));
    expect(writes).toBe(3);
    yield* TestClock.adjust(CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS);
    yield* reporter.progress(progress(1, (updates + 1) * unitScale));
    expect(writes).toBe(4);
    yield* reporter.progress(progress(1, totalUnits));
    expect(writes).toBe(5);
    yield* reporter.progress({phase: 'waiting', reason: 'repository-lock'});
    expect(writes).toBe(6);
  }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)));
}

function fixtureIdentity(home: string): RepositoryIdentity {
  return {
    branch: 'feature/manager-labels',
    caseMode: 'sensitive',
    checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
    displayName: 'example/repository',
    gitCommonDirectory: `${home}/repository/.git`,
    headCommit: Effect2.pipe('d', EffectString.repeat(40)),
    objectFormat: 'sha1',
    remoteIdentity: 'example.invalid/repository',
    repoRoot: `${home}/repository`,
    repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
    worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
  };
}

function fixtureSnapshot(identity: RepositoryIdentity): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: new Date().toISOString(),
    dirty: false,
    edgeCount: 34,
    extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
    fileCount: 12,
    id: 'cgsn_fixture',
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 56,
    worktreeId: identity.worktreeId,
  };
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync({cmd: ['git', '-C', cwd, ...args], stderr: 'pipe', stdout: 'pipe'});
  if (result.exitCode !== 0) throw TestError.make({message: result.stderr.toString()});
}
