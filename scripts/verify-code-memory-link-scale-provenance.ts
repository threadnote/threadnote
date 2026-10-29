#!/usr/bin/env bun
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, Layer, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {rebuildCodeMemoryLinkScaleTargetDigest} from './benchmark-code-memory-link-scale.js';
import {
  CodeMemoryLinkScaleProvenanceLive,
  verifyCodeMemoryLinkScaleProvenance,
} from './code-memory-link-scale-provenance.js';
import {loadCodeMemoryLinkScaleCandidateBindingAtCommit} from './verify-code-memory-link-release.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function parseScaleProvenanceArguments(args: readonly string[]) {
  const values: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!['--capture', '--candidate-commit', '--output'].includes(option))
      throw ScriptError.make({message: `Unknown scale provenance option: ${option}`});
    const value = args[++index];
    if (!value || Effect2.pipe(value, EffectString.startsWith('--')) || values[option] !== undefined)
      throw ScriptError.make({message: `Invalid ${option}`});
    values[option] = value;
  }
  const capture = values['--capture'];
  const candidateCommit = values['--candidate-commit'];
  const output = values['--output'];
  if (!capture || !output || !candidateCommit || !/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    throw ScriptError.make({
      message: 'Scale provenance verification requires --capture, --candidate-commit (40 lowercase hex), and --output.',
    });
  }
  return {capture, candidateCommit, output};
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const options = parseScaleProvenanceArguments(yield* scriptArguments());
    const path = yield* Path.Path;
    const sourceRoot = yield* path.fromFileUrl(new URL('../', import.meta.url));
    const candidate = yield* loadCodeMemoryLinkScaleCandidateBindingAtCommit(sourceRoot, options.candidateCommit);
    const {artifact} = yield* verifyCodeMemoryLinkScaleProvenance(yield* readJsonFile(options.capture), candidate);
    const rebuiltDigest = yield* rebuildCodeMemoryLinkScaleTargetDigest();
    if (artifact.identity.builtArtifactSha256 !== rebuiltDigest)
      return yield* ScriptError.make({message: 'Attested capture differs from independently rebuilt target.'});
    yield* atomicWrite(options.output, `${JSON.stringify(artifact, undefined, 2)}\n`);
  }),
);

if (import.meta.main)
  BunRuntime.runMain(
    provideScriptLayer(program, CodeMemoryLinkScaleProvenanceLive.pipe(Layer.provideMerge(ApplicationLayer))),
  );
