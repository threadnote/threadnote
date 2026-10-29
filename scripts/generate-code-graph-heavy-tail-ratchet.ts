import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  assertHeavyTailReleaseRatchet,
  parseCodeGraphHeavyTailReleaseEvidence,
  type HeavyTailReleaseFreshnessPolicy,
  type CodeGraphHeavyTailBenchmarkArtifact,
} from './benchmark-code-graph-heavy-tail.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const generate = Effect.gen(function* () {
  const {artifacts, candidateCommit, freshness, outputPath, ratchetPath, runnerClass, runnerIdentity} = parseArguments(
    yield* scriptArguments(),
  );
  const path = yield* Path.Path;
  const checkedRatchetPath = path.resolve(
    yield* path.fromFileUrl(new URL('..', import.meta.url)),
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/heavy-tail-scheduler-ratchet.json',
  );
  if (path.resolve(ratchetPath) !== checkedRatchetPath) {
    return yield* ScriptError.make({
      message: `--ratchet must name the checked heavy-tail ratchet at ${checkedRatchetPath}.`,
    });
  }
  const parsed: CodeGraphHeavyTailBenchmarkArtifact[] = [];
  for (const artifactPath of artifacts) {
    parsed.push(parseCodeGraphHeavyTailReleaseEvidence(yield* readJsonFile(artifactPath)));
  }
  const ratchet = assertHeavyTailReleaseRatchet(parsed, {
    candidateCommit,
    checkedRatchet: yield* readJsonFile(checkedRatchetPath),
    freshness,
    runnerClass,
    runnerIdentity,
  });
  yield* atomicWrite(outputPath, `${JSON.stringify(ratchet, undefined, 2)}\n`);
  yield* printJson(ratchet);
});

function parseArguments(args: readonly string[]): {
  readonly artifacts: readonly string[];
  readonly candidateCommit: string;
  readonly freshness: HeavyTailReleaseFreshnessPolicy;
  readonly outputPath: string;
  readonly ratchetPath: string;
  readonly runnerClass: string;
  readonly runnerIdentity: string;
} {
  const artifacts: string[] = [];
  let candidateCommit: string | undefined;
  let outputPath: string | undefined;
  let ratchetPath: string | undefined;
  let releaseObservedAt: string | undefined;
  let releaseNotBefore: string | undefined;
  let maximumEvidenceAgeMilliseconds: number | undefined;
  let maximumRunSpanMilliseconds: number | undefined;
  let futureSkewMilliseconds: number | undefined;
  let runnerClass: string | undefined;
  let runnerIdentity: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      const value = args[++index];
      if (
        !Effect2.pipe(value, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        )
      )
        throw ScriptError.make({message: '--output requires a path.'});
      outputPath = value;
    } else if (argument === '--candidate-commit') {
      const value = args[++index];
      if (!value || !/^[0-9a-f]{40}$/u.test(value))
        throw ScriptError.make({message: '--candidate-commit requires a 40-character lowercase SHA.'});
      candidateCommit = value;
    } else if (argument === '--runner-class') {
      const value = args[++index];
      if (
        !Effect2.pipe(value, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        )
      )
        throw ScriptError.make({message: '--runner-class requires a value.'});
      runnerClass = value;
    } else if (argument === '--runner-identity') {
      const value = args[++index];
      if (
        !Effect2.pipe(value, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        )
      )
        throw ScriptError.make({message: '--runner-identity requires a value.'});
      runnerIdentity = value;
    } else if (argument === '--ratchet') {
      const value = args[++index];
      if (
        !Effect2.pipe(value, effectOptionalString =>
          effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
        )
      )
        throw ScriptError.make({message: '--ratchet requires a path.'});
      ratchetPath = value;
    } else if (argument === '--release-observed-at') {
      releaseObservedAt = timestamp(args[++index], argument);
    } else if (argument === '--release-not-before') {
      releaseNotBefore = timestamp(args[++index], argument);
    } else if (argument === '--maximum-evidence-age-ms') {
      maximumEvidenceAgeMilliseconds = integer(args[++index], argument, 1);
    } else if (argument === '--maximum-run-span-ms') {
      maximumRunSpanMilliseconds = integer(args[++index], argument, 1);
    } else if (argument === '--future-skew-ms') {
      futureSkewMilliseconds = integer(args[++index], argument, 0);
    } else if (Effect2.pipe(argument, EffectString.startsWith('-'))) {
      throw ScriptError.make({message: `Unknown heavy-tail ratchet generator option: ${argument}`});
    } else {
      artifacts.push(argument);
    }
  }
  if (outputPath === undefined) throw ScriptError.make({message: 'Heavy-tail ratchet generation requires --output.'});
  if (candidateCommit === undefined) throw ScriptError.make({message: '--candidate-commit is required.'});
  if (runnerClass === undefined) throw ScriptError.make({message: '--runner-class is required.'});
  if (runnerIdentity === undefined) throw ScriptError.make({message: '--runner-identity is required.'});
  if (ratchetPath === undefined) throw ScriptError.make({message: '--ratchet is required.'});
  if (releaseObservedAt === undefined) throw ScriptError.make({message: '--release-observed-at is required.'});
  if (releaseNotBefore === undefined) throw ScriptError.make({message: '--release-not-before is required.'});
  if (maximumEvidenceAgeMilliseconds === undefined)
    throw ScriptError.make({message: '--maximum-evidence-age-ms is required.'});
  if (maximumRunSpanMilliseconds === undefined) throw ScriptError.make({message: '--maximum-run-span-ms is required.'});
  if (futureSkewMilliseconds === undefined) throw ScriptError.make({message: '--future-skew-ms is required.'});
  return {
    artifacts,
    candidateCommit,
    freshness: {
      futureSkewMilliseconds,
      maximumAgeMilliseconds: maximumEvidenceAgeMilliseconds,
      maximumSpanMilliseconds: maximumRunSpanMilliseconds,
      notBefore: releaseNotBefore,
      observedAt: releaseObservedAt,
    },
    outputPath,
    ratchetPath,
    runnerClass,
    runnerIdentity,
  };
}

function timestamp(value: string | undefined, option: string): string {
  if (!value || !Number.isFinite(Date.parse(value)))
    throw ScriptError.make({message: `${option} requires a timestamp.`});
  return value;
}

function integer(value: string | undefined, option: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw ScriptError.make({message: `${option} requires an integer of at least ${minimum}.`});
  }
  return parsed;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(generate, ApplicationLayer));
