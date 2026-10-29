import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {readContextBriefCitationScaleCandidate} from '../../../../scripts/benchmark-context-brief-citations-target.js';
import {runCommandEffect} from '@threadnote/platform/command';

import {
  contextBriefCitationScaleCandidateBinding,
  contextBriefCitationScaleReleaseIdentityFailures,
  type ContextBriefCitationScaleReleaseIdentityV1,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-contract';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const COMMIT = Effect2.pipe('a', EffectString.repeat(40));
const identity: ContextBriefCitationScaleReleaseIdentityV1 = {
  architecture: 'arm64',
  candidateCommit: COMMIT,
  commit: COMMIT,
  cpu: 'Apple M1 (Virtual)',
  dirty: false,
  gitStatusObserved: true,
  githubActions: true,
  operatingSystem: 'macOS 15.6.1',
  runnerArchitecture: 'ARM64',
  runnerClass: 'github-hosted-macos-15-ARM64',
  runnerEnvironment: 'github-hosted',
  runnerOperatingSystem: 'macOS',
  runtime: 'bun/1.3.14',
  sourceVersion: 'threadnote-4.6.0',
};
const commandLayer = TestCommandExecutorLayer.pipe(Layer.provide(TestSystemInfoLayer));
const candidateLayer = commandLayer.pipe(Layer.provideMerge(BunServices.layer));

describe('Context Brief release candidate version binding', () => {
  it('retains historical 4.6.0 validation and requires external binding for later versions', () => {
    expect(contextBriefCitationScaleReleaseIdentityFailures(identity)).toEqual([]);
    const current = {...identity, runtime: 'bun/1.4.2', sourceVersion: 'threadnote-4.6.8'};
    expect(contextBriefCitationScaleReleaseIdentityFailures(current)).toContain(
      'source version threadnote-4.6.8; required threadnote-4.6.0',
    );
    expect(
      contextBriefCitationScaleReleaseIdentityFailures(
        current,
        contextBriefCitationScaleCandidateBinding(COMMIT, {version: '4.6.8', packageManager: 'bun@1.4.2'}),
      ),
    ).toEqual([]);
  });

  it('rejects malformed package versions and directly constructed malformed bindings', () => {
    for (const manifest of [
      null,
      {},
      {version: ''},
      {version: 4.6},
      {version: 'latest'},
      {version: '04.6.8'},
      {version: '4.6.8-..'},
      {version: '4.6.8+.'},
      {version: '4.6.8-01'},
      {version: '4.6.8-rc..1'},
      {version: '4.6.8', packageManager: 'bun@latest'},
      {version: '4.6.8', packageManager: 'npm@1.4.2'},
    ]) {
      expect(() => contextBriefCitationScaleCandidateBinding(COMMIT, manifest)).toThrow();
    }
    expect(
      contextBriefCitationScaleReleaseIdentityFailures(
        {...identity, sourceVersion: 'garbage'},
        {commit: COMMIT, runtime: 'bun/1.4.2', sourceVersion: 'garbage'},
      ),
    ).toContain('candidate binding source version must name an explicit package version');
    expect(
      contextBriefCitationScaleReleaseIdentityFailures(
        {...identity, runtime: 'bun/whatever'},
        {commit: COMMIT, runtime: 'bun/whatever', sourceVersion: identity.sourceVersion},
      ),
    ).toContain('candidate binding runtime must name an explicit Bun version');
  });

  it('accepts explicit prerelease and build metadata versions', () => {
    for (const version of ['0.0.0', '4.6.8-rc.1', '4.6.8-0', '4.6.8+build.01', '4.6.8-rc.1+build.2']) {
      expect(contextBriefCitationScaleCandidateBinding(COMMIT, {version, packageManager: 'bun@1.4.2'})).toEqual({
        commit: COMMIT,
        runtime: 'bun/1.4.2',
        sourceVersion: `threadnote-${version}`,
      });
    }
  });

  it('accepts exactly the independently supplied candidate commit and package version', () => {
    fc.assert(
      fc.property(
        fc.record({major: fc.integer({min: 1, max: 20}), minor: fc.nat(30), patch: fc.nat(100)}),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        ({major, minor, patch}, commitMatches, versionMatches, runtimeMatches) => {
          const version = `${major}.${minor}.${patch}`;
          const candidate = contextBriefCitationScaleCandidateBinding(COMMIT, {
            version,
            packageManager: 'bun@1.4.2',
          });
          const observed = {
            ...identity,
            candidateCommit: commitMatches ? COMMIT : Effect2.pipe('b', EffectString.repeat(40)),
            commit: commitMatches ? COMMIT : Effect2.pipe('b', EffectString.repeat(40)),
            runtime: runtimeMatches ? 'bun/1.4.2' : 'bun/1.4.3',
            sourceVersion: `threadnote-${major}.${minor}.${versionMatches ? patch : patch + 1}`,
          };
          expect(contextBriefCitationScaleReleaseIdentityFailures(observed, candidate).length === 0).toBe(
            commitMatches && versionMatches && runtimeMatches,
          );
        },
      ),
      {numRuns: 50},
    );
  });

  // provideTestLayer owns the Effect scope, including the temporary Git checkout.
  effectIt.effect('reads committed package bytes and rejects dirty, wrong-commit, and wrong-build observations', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-candidate-'});
      const manifestPath = path.join(root, 'package.json');
      yield* fs.writeFileString(manifestPath, '{"version":"4.6.8","packageManager":"bun@1.4.2"}\n');
      yield* runCommandEffect('git', ['init', '--quiet'], {cwd: root});
      yield* runCommandEffect('git', ['add', 'package.json'], {cwd: root});
      yield* runCommandEffect(
        'git',
        [
          '-c',
          'commit.gpgSign=false',
          '-c',
          'user.name=Threadnote Test',
          '-c',
          'user.email=test@threadnote.local',
          'commit',
          '--quiet',
          '-m',
          'candidate',
        ],
        {cwd: root},
      );
      const commit = Effect2.pipe(
        (yield* runCommandEffect('git', ['rev-parse', 'HEAD'], {cwd: root})).stdout,
        EffectString.trim,
      );
      expect(yield* readContextBriefCitationScaleCandidate(commit, 'threadnote-4.6.8', root)).toEqual({
        commit,
        runtime: 'bun/1.4.2',
        sourceVersion: 'threadnote-4.6.8',
      });
      const wrongBuild = yield* readContextBriefCitationScaleCandidate(commit, 'threadnote-4.6.0', root).pipe(
        Effect.result,
      );
      expect(Result.isFailure(wrongBuild)).toBe(true);
      if (Result.isFailure(wrongBuild))
        expect(wrongBuild.failure.message).toContain('required candidate package version threadnote-4.6.8');
      const wrongCommit = yield* readContextBriefCitationScaleCandidate(COMMIT, 'threadnote-4.6.8', root).pipe(
        Effect.result,
      );
      expect(Result.isFailure(wrongCommit)).toBe(true);
      yield* fs.writeFileString(manifestPath, '{"version":"4.6.9","packageManager":"bun@1.4.2"}\n');
      const dirty = yield* readContextBriefCitationScaleCandidate(commit, 'threadnote-4.6.9', root).pipe(Effect.result);
      expect(Result.isFailure(dirty)).toBe(true);
      if (Result.isFailure(dirty)) expect(dirty.failure.message).toContain('clean candidate checkout');
    }).pipe(provideTestLayer(candidateLayer), TestClock.withLive),
  );
});
