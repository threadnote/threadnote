import {Array as EffectArray} from 'effect';
import {ScriptError} from './effect/errors.js';
import {Effect, FileSystem, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MEBIBYTE = 1_048_576;

export interface CodeGraphHeavyTailProfile {
  readonly callsPerPathologicalTypeScriptFile: number;
  readonly generatedTypeScriptBytes: number;
  readonly id: 'large-monorepo-heavy-tail';
  readonly interruptAfterPersistedFiles: number;
  readonly lowSignalJsonBytes: number;
  readonly parallelWorkers: number;
  readonly pathologicalTypeScriptFiles: number;
  readonly regularTypeScriptFiles: number;
  readonly textlessSvgFiles: number;
  readonly version: 1;
}

export interface PreparedCodeGraphHeavyTailFixture {
  readonly repository: string;
  readonly root: string;
}

export const CODE_GRAPH_HEAVY_TAIL_JSON_PATH = 'test/__snapshots__/large-state.snapshot.json';
export const CODE_GRAPH_HEAVY_TAIL_GENERATED_TYPESCRIPT_PATH = 'src/generated-surface.ts';
export const CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES = 2;

/**
 * This is a reviewed workload shape, not a portable latency budget. It represents the pathological file classes from
 * the beta.29 field audit while keeping the full run suitable for an opt-in or scheduled benchmark.
 */
export const CODE_GRAPH_HEAVY_TAIL_PROFILE = {
  callsPerPathologicalTypeScriptFile: 12_000,
  generatedTypeScriptBytes: 3 * MEBIBYTE,
  id: 'large-monorepo-heavy-tail',
  interruptAfterPersistedFiles: 256,
  lowSignalJsonBytes: 25 * MEBIBYTE,
  parallelWorkers: 4,
  pathologicalTypeScriptFiles: 8,
  regularTypeScriptFiles: 256,
  textlessSvgFiles: 4_000,
  version: 1,
} as const satisfies CodeGraphHeavyTailProfile;

export const CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE = {
  ...CODE_GRAPH_HEAVY_TAIL_PROFILE,
  callsPerPathologicalTypeScriptFile: 64,
  generatedTypeScriptBytes: 32 * 1_024,
  interruptAfterPersistedFiles: 8,
  lowSignalJsonBytes: 256 * 1_024,
  pathologicalTypeScriptFiles: 2,
  regularTypeScriptFiles: 12,
  textlessSvgFiles: 24,
} as const satisfies CodeGraphHeavyTailProfile;

export function parseCodeGraphHeavyTailProfile(value: unknown): CodeGraphHeavyTailProfile {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) {
    throw ScriptError.make({message: 'Heavy-tail profile must be an object.'});
  }
  if (!('id' in value) || value.id !== 'large-monorepo-heavy-tail' || !('version' in value) || value.version !== 1) {
    throw ScriptError.make({message: 'Unsupported code graph heavy-tail profile.'});
  }
  for (const field of [
    'callsPerPathologicalTypeScriptFile',
    'generatedTypeScriptBytes',
    'interruptAfterPersistedFiles',
    'lowSignalJsonBytes',
    'parallelWorkers',
    'pathologicalTypeScriptFiles',
    'regularTypeScriptFiles',
    'textlessSvgFiles',
  ] as const) {
    const current: unknown = Reflect.get(value, field);
    if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 1) {
      throw ScriptError.make({message: `Heavy-tail profile ${field} must be a positive safe integer.`});
    }
  }
  if (!isCodeGraphHeavyTailProfile(value)) {
    throw ScriptError.make({message: 'Heavy-tail profile has an invalid shape.'});
  }
  const profile = value;
  if (profile.parallelWorkers > 8)
    throw ScriptError.make({message: 'Heavy-tail profile parallelWorkers must not exceed 8.'});
  const eligibleFiles = codeGraphHeavyTailEligibleFiles(profile);
  if (profile.interruptAfterPersistedFiles >= eligibleFiles) {
    throw ScriptError.make({
      message: 'Heavy-tail interruption point must be smaller than the eligible fixture file count.',
    });
  }
  if (profile.lowSignalJsonBytes < 128 || profile.generatedTypeScriptBytes < 128) {
    throw ScriptError.make({message: 'Heavy-tail large-file shapes must be at least 128 bytes.'});
  }
  return profile;
}

function isCodeGraphHeavyTailProfile(value: unknown): value is CodeGraphHeavyTailProfile {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) return false;
  return (
    'id' in value &&
    value.id === 'large-monorepo-heavy-tail' &&
    'version' in value &&
    value.version === 1 &&
    'callsPerPathologicalTypeScriptFile' in value &&
    isPositiveSafeInteger(value.callsPerPathologicalTypeScriptFile) &&
    'generatedTypeScriptBytes' in value &&
    isPositiveSafeInteger(value.generatedTypeScriptBytes) &&
    'interruptAfterPersistedFiles' in value &&
    isPositiveSafeInteger(value.interruptAfterPersistedFiles) &&
    'lowSignalJsonBytes' in value &&
    isPositiveSafeInteger(value.lowSignalJsonBytes) &&
    'parallelWorkers' in value &&
    isPositiveSafeInteger(value.parallelWorkers) &&
    'pathologicalTypeScriptFiles' in value &&
    isPositiveSafeInteger(value.pathologicalTypeScriptFiles) &&
    'regularTypeScriptFiles' in value &&
    isPositiveSafeInteger(value.regularTypeScriptFiles) &&
    'textlessSvgFiles' in value &&
    isPositiveSafeInteger(value.textlessSvgFiles)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export function codeGraphHeavyTailEligibleFiles(profile: CodeGraphHeavyTailProfile): number {
  return 4 + profile.pathologicalTypeScriptFiles + profile.regularTypeScriptFiles;
}

export function codeGraphHeavyTailJsonFixtures(
  profile: CodeGraphHeavyTailProfile,
): readonly {readonly bytes: number; readonly path: string}[] {
  const sizes =
    profile.lowSignalJsonBytes >= 25 * MEBIBYTE
      ? [64 * 1_024, Math.round(0.8 * MEBIBYTE), Math.round(5.7 * MEBIBYTE), profile.lowSignalJsonBytes]
      : [
          Math.max(128, Math.floor(profile.lowSignalJsonBytes / 16)),
          Math.max(128, Math.floor(profile.lowSignalJsonBytes / 4)),
          Math.max(128, Math.floor(profile.lowSignalJsonBytes / 2)),
          profile.lowSignalJsonBytes,
        ];
  const labels = ['small', 'medium', 'large', 'extreme'] as const;
  return EffectArray.flatMap(sizes, (bytes, sizeIndex) =>
    Array.from({length: CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES}, (_, duplicateIndex) => ({
      bytes,
      path:
        sizeIndex === sizes.length - 1 && duplicateIndex === 0
          ? CODE_GRAPH_HEAVY_TAIL_JSON_PATH
          : `test/__snapshots__/${labels[sizeIndex]}-state-${duplicateIndex + 1}.snapshot.json`,
    })),
  );
}

export function codeGraphHeavyTailRepositoryFiles(profile: CodeGraphHeavyTailProfile): number {
  return (
    codeGraphHeavyTailEligibleFiles(profile) + codeGraphHeavyTailJsonFixtures(profile).length + profile.textlessSvgFiles
  );
}

export function codeGraphHeavyTailPathologicalTypeScript(index: number, calls: number): string {
  const suffix = Effect2.pipe(String(index), EffectString.padStart(3, '0'));
  return EffectArray.join(
    [
      'import {dependency} from "./dependency.js";',
      `export function pathological${suffix}(): number {`,
      '  let value = 0;',
      ...Array.from({length: calls}, (_, call) => `  value += dependency(${call});`),
      '  return value;',
      '}',
      `export {dependency as forwarded${suffix}} from "./dependency.js";`,
      `export interface PreservedTail${suffix} { readonly value: string }`,
      '',
    ],
    '\n',
  );
}

export function codeGraphHeavyTailGeneratedTypeScript(targetBytes: number): string {
  const prefix = EffectArray.join(['import {dependency} from "./dependency.js";', '/* generated payload: '], '\n');
  const suffix = EffectArray.join(
    [
      ' */',
      'export function generatedSurface(): number { return dependency(1); }',
      'export {dependency as generatedForward} from "./dependency.js";',
      'export interface GeneratedSurfaceTail { readonly value: string }',
      '',
    ],
    '\n',
  );
  if (targetBytes < prefix.length + suffix.length) {
    throw ScriptError.make({
      message: `Generated TypeScript target must be at least ${prefix.length + suffix.length} bytes.`,
    });
  }
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
  return `${prefix}${'x'.repeat(targetBytes - prefix.length - suffix.length)}${suffix}`;
}

export function codeGraphHeavyTailLowSignalJson(targetBytes: number): string {
  const prefix = '{"kind":"test-snapshot","frames":[],"payload":"';
  const suffix = '"}\n';
  if (targetBytes < prefix.length + suffix.length) {
    throw ScriptError.make({
      message: `Low-signal JSON target must be at least ${prefix.length + suffix.length} bytes.`,
    });
  }
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
  return `${prefix}${'x'.repeat(targetBytes - prefix.length - suffix.length)}${suffix}`;
}

export function codeGraphHeavyTailTextlessSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 8h14"/></svg>\n';
}

export const prepareCodeGraphHeavyTailFixture = Effect.fn('codeGraphHeavyTailFixture.prepare')(function* (
  requested: CodeGraphHeavyTailProfile = CODE_GRAPH_HEAVY_TAIL_PROFILE,
) {
  const profile = parseCodeGraphHeavyTailProfile(requested);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-heavy-tail-'});
  const repository = path.join(root, 'repository');
  yield* fs.makeDirectory(path.join(repository, 'assets', 'icons'), {recursive: true});
  yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
  yield* fs.makeDirectory(path.join(repository, 'test', '__snapshots__'), {recursive: true});
  yield* fs.writeFileString(
    path.join(repository, 'package.json'),
    `${JSON.stringify({name: '@threadnote/heavy-tail-fixture', private: true, version: '1.0.0'}, undefined, 2)}\n`,
  );
  yield* fs.writeFileString(
    path.join(repository, 'tsconfig.json'),
    `${JSON.stringify({compilerOptions: {strict: true}, include: ['src/**/*.ts']}, undefined, 2)}\n`,
  );
  yield* fs.writeFileString(
    path.join(repository, 'src', 'dependency.ts'),
    'export function dependency(value: number): number { return value + 1; }\n',
  );
  yield* fs.writeFileString(
    path.join(repository, CODE_GRAPH_HEAVY_TAIL_GENERATED_TYPESCRIPT_PATH),
    codeGraphHeavyTailGeneratedTypeScript(profile.generatedTypeScriptBytes),
  );
  yield* Effect.forEach(
    codeGraphHeavyTailJsonFixtures(profile),
    fixture => fs.writeFileString(path.join(repository, fixture.path), codeGraphHeavyTailLowSignalJson(fixture.bytes)),
    {concurrency: 1, discard: true},
  );
  yield* Effect.forEach(
    Array.from({length: profile.pathologicalTypeScriptFiles}, (_, index) => index),
    index =>
      fs.writeFileString(
        path.join(repository, 'src', `pathological-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.ts`),
        codeGraphHeavyTailPathologicalTypeScript(index, profile.callsPerPathologicalTypeScriptFile),
      ),
    {concurrency: 8, discard: true},
  );
  yield* Effect.forEach(
    Array.from({length: profile.regularTypeScriptFiles}, (_, index) => index),
    index =>
      fs.writeFileString(
        path.join(repository, 'src', `regular-${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}.ts`),
        `export function regular${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}(): number { return ${index}; }\n`,
      ),
    {concurrency: 32, discard: true},
  );
  const svg = codeGraphHeavyTailTextlessSvg();
  yield* Effect.forEach(
    Array.from({length: profile.textlessSvgFiles}, (_, index) => index),
    index =>
      fs.writeFileString(
        path.join(
          repository,
          'assets',
          'icons',
          `icon-${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}.svg`,
        ),
        svg,
      ),
    {concurrency: 32, discard: true},
  );
  yield* git(repository, ['init', '-q']);
  yield* git(repository, ['add', '.'], 10 * 60_000);
  yield* git(
    repository,
    [
      '-c',
      'user.name=Threadnote Evaluation',
      '-c',
      'user.email=evaluation@threadnote.local',
      'commit',
      '-qm',
      'large-monorepo heavy-tail fixture',
    ],
    10 * 60_000,
  );
  return {repository, root} satisfies PreparedCodeGraphHeavyTailFixture;
});

const git = Effect.fn('codeGraphHeavyTailFixture.git')((cwd: string, args: readonly string[], timeoutMs = 30_000) =>
  runCommandEffect('git', ['-C', cwd, ...args], {
    maxOutputBytes: 16 * MEBIBYTE,
    timeoutMs,
  }).pipe(Effect.asVoid),
);
