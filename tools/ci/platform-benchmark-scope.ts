import {Array as EffectArray} from 'effect';
import {isPurePrivateReleaseEvidenceDiff} from './private-release-evidence-family.js';
import {CI_TEST_POLICY_PATHS} from './code-graph-production-ratchet-scope.js';
import {isJsonObject, type JsonObject} from '@threadnote/platform/json';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface PlatformBenchmarkDiff {
  readonly afterPackageJson?: string;
  readonly beforePackageJson?: string;
  readonly changedPaths: Iterable<unknown>;
}

export interface PlatformBenchmarkScope {
  readonly changedCount: number;
  readonly invalidPath: boolean;
  readonly paths: readonly string[];
  readonly runCodeGraphPr: boolean;
  readonly runRecallPr: boolean;
}

const RECALL_SCRIPTS = /^(?:bench:recall|eval:recall|capture-recall|recall-vector)/u;
const CODE_GRAPH_SCRIPTS = /^(?:bench:code-graph|eval:code-graph|code-graph)/u;
const RELEASE_READINESS_SCRIPTS = new Set(['assemble:threadnote-5-observer-authority']);

const RELEASE_READINESS_PATHS = new Set([
  'docs/release-readiness.md',
  'scripts/assemble-threadnote-5-observer-authority.ts',
  'apps/threadnote/src/evaluation/threadnote-5-release-readiness-observer-authority.ts',
  'apps/threadnote/test/unit/evaluation.threadnote-5-release-readiness-observer-authority.test.ts',
  'apps/threadnote/test/unit/release-tool-help.contract.test.ts',
]);

const RECALL_PATHS = new Set([
  'scripts/benchmark-recall-vectors.ts',
  'scripts/evaluate-recall.ts',
  'scripts/recall-vector-performance-budget.ts',
  'scripts/recall-vector-storage-budget.ts',
  'packages/recall/src/chunker.ts',
  'packages/recall/src/vector-index.ts',
  'packages/inference/src/vector-search.ts',
]);

const CODE_GRAPH_PATHS = new Set([
  'scripts/adjudicate-code-graph-windows-replicas.ts',
  'scripts/benchmark-code-graph.ts',
  'scripts/benchmark-code-graph-embedding-contexts.ts',
  'scripts/benchmark-code-graph-heavy-tail.ts',
  'scripts/benchmark-code-graph-workset.ts',
  'scripts/code-graph-benchmark-sampler.ts',
  'scripts/code-graph-fixture.ts',
  'scripts/evaluate-code-graph-workset.ts',
  'scripts/generate-code-graph-production-ratchet.ts',
  'packages/evidence/src/benchmark.ts',
  'apps/threadnote/src/evaluation/code-graph.ts',
  'packages/evidence/src/external-evidence.ts',
  'packages/evidence/src/public-controls.ts',
]);

const SHARED_PATHS = new Set([
  'packages/platform/src/command.ts',
  'packages/platform/src/digest.ts',
  'apps/threadnote/src/effect/runtime.ts',
  'packages/platform/src/system.ts',
  'packages/store/src/layout.ts',
]);

const PACKAGE_DEPENDENCY_KEYS = new Set([
  'bundledDependencies',
  'bundleDependencies',
  'catalog',
  'catalogs',
  'cpu',
  'dependencies',
  'devDependencies',
  'engines',
  'installConfig',
  'libc',
  'optionalDependencies',
  'os',
  'overrides',
  'packageManager',
  'peerDependencies',
  'peerDependenciesMeta',
  'pnpm',
  'resolutions',
  'trustedDependencies',
  'volta',
]);

const PACKAGE_RELEASE_METADATA_KEYS = new Set([
  'author',
  'bugs',
  'contributors',
  'description',
  'funding',
  'homepage',
  'keywords',
  'license',
  'name',
  'private',
  'repository',
  'version',
]);

function normalizeGitPath(path: string): string | undefined {
  if (Effect.pipe(path, EffectString.includes('\\'))) return undefined;
  if (
    path.length === 0 ||
    Effect.pipe(path, EffectString.startsWith('/')) ||
    Effect.pipe(path, EffectString.includes('\0')) ||
    EffectArray.some(
      Effect.pipe(path, EffectString.split('/')),
      segment => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    return undefined;
  }
  return path;
}

function parseJsonObject(source: string | undefined): JsonObject | undefined {
  if (source === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(source);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (EffectArray.isArray(left) || EffectArray.isArray(right)) {
    return (
      EffectArray.isArray(left) &&
      EffectArray.isArray(right) &&
      left.length === right.length &&
      EffectArray.every(left, (value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftObject = left;
  const rightObject = right;
  const leftKeys = EffectRecord.keys(leftObject).sort();
  const rightKeys = EffectRecord.keys(rightObject).sort();
  return (
    leftKeys.length === rightKeys.length &&
    EffectArray.every(
      leftKeys,
      (key, index) => key === rightKeys[index] && jsonValuesEqual(leftObject[key], rightObject[key]),
    )
  );
}

function changedPackageKeys(
  beforeSource: string | undefined,
  afterSource: string | undefined,
): Set<string> | undefined {
  const before = parseJsonObject(beforeSource);
  const after = parseJsonObject(afterSource);
  if (!before || !after) return undefined;
  const keys = new Set([...EffectRecord.keys(before), ...EffectRecord.keys(after)]);
  return new Set(EffectArray.filter([...keys], key => !jsonValuesEqual(before[key], after[key])));
}

function packageScope(
  beforeSource: string | undefined,
  afterSource: string | undefined,
): {readonly runCodeGraphPr: boolean; readonly runRecallPr: boolean} {
  const changed = changedPackageKeys(beforeSource, afterSource);
  if (!changed) return {runCodeGraphPr: true, runRecallPr: true};

  let runCodeGraphPr = false;
  let runRecallPr = false;
  for (const key of changed) {
    if (PACKAGE_DEPENDENCY_KEYS.has(key)) return {runCodeGraphPr: true, runRecallPr: true};
    if (key === 'scripts') {
      const before = parseJsonObject(beforeSource)?.scripts;
      const after = parseJsonObject(afterSource)?.scripts;
      if (!isJsonObject(before) || !isJsonObject(after)) {
        return {runCodeGraphPr: true, runRecallPr: true};
      }
      const beforeScripts = before;
      const afterScripts = after;
      const scriptNames = new Set([...EffectRecord.keys(beforeScripts), ...EffectRecord.keys(afterScripts)]);
      for (const script of scriptNames) {
        if (jsonValuesEqual(beforeScripts[script], afterScripts[script])) continue;
        if (RECALL_SCRIPTS.test(script)) runRecallPr = true;
        else if (CODE_GRAPH_SCRIPTS.test(script)) runCodeGraphPr = true;
        else if (!RELEASE_READINESS_SCRIPTS.has(script)) return {runCodeGraphPr: true, runRecallPr: true};
      }
      continue;
    }
    if (!PACKAGE_RELEASE_METADATA_KEYS.has(key)) return {runCodeGraphPr: true, runRecallPr: true};
  }
  return {runCodeGraphPr, runRecallPr};
}

function isLockfileOrManifest(path: string): boolean {
  return (
    /^packages\/[^/]+\/package\.json$/u.test(path) ||
    /(?:^|\/)(?:bun\.lock(?:b)?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(path)
  );
}

function isIgnoredPath(path: string): boolean {
  return (
    CI_TEST_POLICY_PATHS.has(path) ||
    RELEASE_READINESS_PATHS.has(path) ||
    path === 'README.md' ||
    path === 'LICENSE' ||
    path === 'THIRD_PARTY.md' ||
    Effect.pipe(path, EffectString.startsWith('docs/')) ||
    Effect.pipe(path, EffectString.startsWith('.github/release-notes/'))
  );
}

function markPath(path: string): {readonly runCodeGraphPr: boolean; readonly runRecallPr: boolean} {
  if (RECALL_PATHS.has(path)) return {runCodeGraphPr: false, runRecallPr: true};
  if (CODE_GRAPH_PATHS.has(path)) return {runCodeGraphPr: true, runRecallPr: false};
  if (SHARED_PATHS.has(path)) return {runCodeGraphPr: true, runRecallPr: true};
  if (
    Effect.pipe(path, EffectString.startsWith('packages/recall/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/fixtures/recall-v1/')) ||
    Effect.pipe(path, EffectString.startsWith('src/recall/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/fixtures/recall-v1/'))
  ) {
    return {runCodeGraphPr: false, runRecallPr: true};
  }
  if (
    Effect.pipe(path, EffectString.startsWith('packages/inference/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/src/effect/ai/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/src/models/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/src/crypto/')) ||
    Effect.pipe(path, EffectString.startsWith('src/effect/ai/')) ||
    Effect.pipe(path, EffectString.startsWith('src/models/')) ||
    Effect.pipe(path, EffectString.startsWith('src/crypto/'))
  ) {
    return {runCodeGraphPr: true, runRecallPr: true};
  }
  if (
    Effect.pipe(path, EffectString.startsWith('packages/graph/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/src/code_graph/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/baselines/code-graph-v1/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/baselines/code-graph-workset-v1/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/fixtures/code-graph-v1/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/fixtures/code-graph-workset-v1/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/unit/code-graph.')) ||
    Effect.pipe(path, EffectString.startsWith('packages/graph/test/')) ||
    Effect.pipe(path, EffectString.startsWith('src/code_graph/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/baselines/code-graph-v1/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/baselines/code-graph-workset-v1/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/fixtures/code-graph-v1/')) ||
    Effect.pipe(path, EffectString.startsWith('apps/threadnote/test/evaluation/fixtures/code-graph-workset-v1/')) ||
    Effect.pipe(path, EffectString.startsWith('test/unit/code-graph.'))
  ) {
    return {runCodeGraphPr: true, runRecallPr: false};
  }
  return {runCodeGraphPr: true, runRecallPr: true};
}

export function classifyPlatformBenchmarkScope(diff: PlatformBenchmarkDiff): PlatformBenchmarkScope {
  const paths = new Set<string>();
  let invalidPath = false;
  try {
    for (const path of diff.changedPaths) {
      const normalized = typeof path === 'string' ? normalizeGitPath(path) : undefined;
      if (normalized) paths.add(normalized);
      else invalidPath = true;
    }
  } catch {
    invalidPath = true;
  }
  const sortedPaths = [...paths].sort();
  if (invalidPath || sortedPaths.length === 0) {
    return {changedCount: sortedPaths.length, invalidPath, paths: sortedPaths, runCodeGraphPr: true, runRecallPr: true};
  }
  if (isPurePrivateReleaseEvidenceDiff(sortedPaths)) {
    return {
      changedCount: sortedPaths.length,
      invalidPath,
      paths: sortedPaths,
      runCodeGraphPr: false,
      runRecallPr: false,
    };
  }

  let runCodeGraphPr = false;
  let runRecallPr = false;
  for (const path of sortedPaths) {
    if (isIgnoredPath(path)) continue;
    if (isLockfileOrManifest(path)) {
      runCodeGraphPr = true;
      runRecallPr = true;
      continue;
    }
    if (path === 'package.json') {
      const scope = packageScope(diff.beforePackageJson, diff.afterPackageJson);
      runCodeGraphPr ||= scope.runCodeGraphPr;
      runRecallPr ||= scope.runRecallPr;
      continue;
    }
    const scope = markPath(path);
    runCodeGraphPr ||= scope.runCodeGraphPr;
    runRecallPr ||= scope.runRecallPr;
  }
  return {changedCount: sortedPaths.length, invalidPath, paths: sortedPaths, runCodeGraphPr, runRecallPr};
}

function commitArgument(name: '--base' | '--head'): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

function isCommitId(value: string | undefined): value is string {
  return Boolean(value && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value) && !/^0+$/u.test(value));
}

function runGit(arguments_: readonly string[]): {readonly exitCode: number; readonly stdout: Uint8Array} {
  const result = Bun.spawnSync({cmd: ['git', ...arguments_], stderr: 'pipe', stdout: 'pipe'});
  return {exitCode: result.exitCode, stdout: result.stdout};
}

function readGitFile(commit: string, path: string): string | undefined {
  const result = runGit(['show', `${commit}:${path}`]);
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout) : undefined;
}

function classifyCurrentDiff(
  base: string | undefined,
  head: string | undefined,
): {
  readonly reason: string;
  readonly scope: PlatformBenchmarkScope;
} {
  const failSafe = (reason: string): {readonly reason: string; readonly scope: PlatformBenchmarkScope} => ({
    reason,
    scope: classifyPlatformBenchmarkScope({changedPaths: []}),
  });
  if (!isCommitId(base) || !isCommitId(head)) return failSafe('missing-or-invalid-commit-range');
  const mergeBaseResult = runGit(['merge-base', base, head]);
  const mergeBase = Effect.pipe(new TextDecoder().decode(mergeBaseResult.stdout), EffectString.trim);
  if (mergeBaseResult.exitCode !== 0 || !isCommitId(mergeBase)) return failSafe('git-merge-base-failed');
  const diffResult = runGit(['diff', '--name-only', '--no-renames', '-z', `${mergeBase}..${head}`, '--']);
  if (diffResult.exitCode !== 0) return failSafe(`git-diff-failed-${diffResult.exitCode}`);
  const changedPaths = EffectArray.filter(
    Effect.pipe(new TextDecoder().decode(diffResult.stdout), EffectString.split('\0')),
    Boolean,
  );
  const scope = classifyPlatformBenchmarkScope({
    afterPackageJson: readGitFile(head, 'package.json'),
    beforePackageJson: readGitFile(mergeBase, 'package.json'),
    changedPaths,
  });
  return {
    reason: scope.runCodeGraphPr || scope.runRecallPr ? 'benchmark-relevant-or-ambiguous-diff' : 'unrelated-diff',
    scope,
  };
}

async function writeGitHubOutputs(scope: PlatformBenchmarkScope, reason: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    await Bun.write(
      outputPath,
      `run_code_graph_pr=${String(scope.runCodeGraphPr)}\nrun_recall_pr=${String(scope.runRecallPr)}\nchanged_count=${scope.changedCount}\nreason=${reason}\n`,
    );
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await Bun.write(
      summaryPath,
      `### Platform benchmark scope\n\n- Changed paths: ${scope.changedCount}\n- Reason: \`${reason}\`\n- Recall PR lane: ${scope.runRecallPr ? 'yes' : 'no'}\n- Code graph PR lane: ${scope.runCodeGraphPr ? 'yes' : 'no'}\n`,
    );
  }
}

if (import.meta.main) {
  const {reason, scope} = classifyCurrentDiff(commitArgument('--base'), commitArgument('--head'));
  await writeGitHubOutputs(scope, reason);
  process.stdout.write(`${JSON.stringify({reason, ...scope})}\n`);
}
