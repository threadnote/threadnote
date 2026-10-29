import {enforceCodeGraphBenchmarkRatchet} from '../../scripts/benchmark-code-graph.js';
import {parseBenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface GateArguments {
  readonly artifactPath: string;
  readonly controlPath?: string;
  readonly expectedCandidateCommit?: string;
  readonly expectedControlCommit?: string;
  readonly initialCandidatePath?: string;
  readonly ratchetPath: string;
}

function requiredValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || Effect.pipe(value, EffectString.startsWith('--'))) throw new Error(`${name} requires a value.`);
  return value;
}

export function parseCodeGraphProductionRatchetGateArguments(args: readonly string[]): GateArguments {
  const known = new Set([
    '--artifact',
    '--control',
    '--expected-candidate-commit',
    '--expected-control-commit',
    '--initial-candidate',
    '--ratchet',
  ]);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index] ?? '') || args[index + 1] === undefined) {
      throw new Error(`Unknown or incomplete production ratchet gate argument: ${args[index] ?? '<missing>'}`);
    }
  }
  const artifactPath = requiredValue(args, '--artifact');
  const ratchetPath = requiredValue(args, '--ratchet');
  const controlPath = args.includes('--control') ? requiredValue(args, '--control') : undefined;
  const expectedCandidateCommit = args.includes('--expected-candidate-commit')
    ? requiredValue(args, '--expected-candidate-commit')
    : undefined;
  const expectedControlCommit = args.includes('--expected-control-commit')
    ? requiredValue(args, '--expected-control-commit')
    : undefined;
  const initialCandidatePath = args.includes('--initial-candidate')
    ? requiredValue(args, '--initial-candidate')
    : undefined;
  if (
    (controlPath === undefined) !== (expectedCandidateCommit === undefined) ||
    (controlPath === undefined) !== (expectedControlCommit === undefined) ||
    (controlPath === undefined) !== (initialCandidatePath === undefined)
  ) {
    throw new Error(
      '--control, --expected-candidate-commit, --expected-control-commit, and --initial-candidate must be provided together.',
    );
  }
  return {
    artifactPath,
    controlPath,
    expectedCandidateCommit,
    expectedControlCommit,
    initialCandidatePath,
    ratchetPath,
  };
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Production ratchet gate input does not exist: ${path}`);
  return file.json() as Promise<unknown>;
}

export async function runCodeGraphProductionRatchetGate(args: readonly string[]): Promise<void> {
  const options = parseCodeGraphProductionRatchetGateArguments(args);
  const [artifactValue, ratchet, controlValue, initialCandidateValue] = await Promise.all([
    readJson(options.artifactPath),
    readJson(options.ratchetPath),
    options.controlPath ? readJson(options.controlPath) : Promise.resolve(undefined),
    options.initialCandidatePath ? readJson(options.initialCandidatePath) : Promise.resolve(undefined),
  ]);
  const artifact = parseBenchmarkArtifactV1(artifactValue);
  const pairedControl =
    controlValue === undefined ||
    initialCandidateValue === undefined ||
    options.expectedCandidateCommit === undefined ||
    options.expectedControlCommit === undefined
      ? undefined
      : {
          artifact: parseBenchmarkArtifactV1(controlValue),
          expectedCandidateCommit: options.expectedCandidateCommit,
          expectedCommit: options.expectedControlCommit,
          initialCandidateArtifact: parseBenchmarkArtifactV1(initialCandidateValue),
        };
  enforceCodeGraphBenchmarkRatchet(artifact, ratchet, pairedControl);
}

if (import.meta.main) await runCodeGraphProductionRatchetGate(Bun.argv.slice(2));
