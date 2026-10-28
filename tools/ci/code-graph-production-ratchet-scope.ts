import {isPurePrivateReleaseEvidenceDiff} from './private-release-evidence-family.js';

export interface CodeGraphProductionRatchetDiff {
  readonly afterCiWorkflow?: string;
  readonly afterPackageJson?: string;
  readonly beforeCiWorkflow?: string;
  readonly beforePackageJson?: string;
  readonly changedPaths: Iterable<string>;
}

export interface CodeGraphProductionRatchetScope {
  readonly changedCount: number;
  readonly paths: readonly string[];
  readonly runBenchmark: boolean;
  readonly skipReason?:
    'private-release-evidence-only' | 'release-metadata-only' | 'unrelated-evaluation-only' | 'ci-and-test-policy-only';
}

type JsonObject = Readonly<Record<string, unknown>>;

function normalizeGitPath(path: string): string | undefined {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return path;
}

function isReleaseNotePath(path: string): boolean {
  return /^\.github\/release-notes\/v[^/\n\r]+\.md$/u.test(path);
}

const PRODUCTION_RATCHET_EVALUATION_DEPENDENCIES = new Set([
  'packages/evidence/src/benchmark.ts',
  'apps/threadnote/src/evaluation/code-graph.ts',
  'packages/evidence/src/external-evidence.ts',
  'packages/evidence/src/public-controls.ts',
]);

const PRODUCTION_RATCHET_CONTRACT_TEST_PATHS = new Set(['tools/ci/test/benchmark-workflow.test.ts']);

function isUnrelatedEvaluationPath(path: string): boolean {
  if (PRODUCTION_RATCHET_EVALUATION_DEPENDENCIES.has(path) || PRODUCTION_RATCHET_CONTRACT_TEST_PATHS.has(path)) {
    return false;
  }
  return (
    /^apps\/threadnote\/src\/evaluation\/context-brief-citation-[^/]+$/u.test(path) ||
    /^apps\/threadnote\/test\/evaluation\/(?:baselines|fixtures)\/context-brief-citations[^/]*(?:\/|$)/u.test(path) ||
    /^apps\/threadnote\/test\/unit\/(?:evaluation\.)?context-brief-citation-[^/]+\.test\.ts$/u.test(path) ||
    /^src\/evaluation\/context-brief-citation-[^/]+$/u.test(path) ||
    /^test\/evaluation\/(?:baselines|fixtures)\/context-brief-citations[^/]*(?:\/|$)/u.test(path) ||
    /^test\/unit\/(?:evaluation\.)?context-brief-citation-[^/]+\.test\.ts$/u.test(path)
  );
}

const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const WINDOWS_VITEST_SHARD_COMMAND = '          bun --bun vitest run --no-file-parallelism --shard=${{ matrix.shard }}';
const WINDOWS_VITEST_DEFAULT_COMMAND =
  '          bun --bun vitest run --no-file-parallelism --testTimeout=120000 --shard=${{ matrix.shard }}';

const CI_TEST_POLICY_PATHS = new Set([
  'apps/threadnote/test/dev-skills/native-authoring-lifecycle.test.ts',
  'apps/threadnote/test/dev-skills/native-authoring-progress-diagnostics.test.ts',
  'apps/threadnote/test/dev-skills/native-closeout-cloud.test.ts',
  'apps/threadnote/test/dev-skills/native-closeout-lifecycle.test.ts',
  'apps/threadnote/test/dev-skills/native-closeout-recall-batch.test.ts',
  'apps/threadnote/test/dev-skills/native-cycle-lifecycle.test.ts',
  'apps/threadnote/test/dev-skills/native-release-workflows.ts',
  'apps/threadnote/test/dev-skills/release-artifact.test.ts',
  'apps/threadnote/test/dev-skills/release-artifact-preview-fence.test.ts',
  'apps/threadnote/test/e2e/local-bins.e2e.ts',
  'tools/bazel/target-specs.mjs',
  'tools/bazel/test/target-contracts.test.ts',
  'tools/ci/code-graph-production-ratchet-scope.ts',
  'tools/ci/test/ci-workflow.test.ts',
  'tools/ci/test/code-graph.production-ratchet-scope.property.test.ts',
]);

function isCiTestPolicyPath(path: string): boolean {
  return path === CI_WORKFLOW_PATH || CI_TEST_POLICY_PATHS.has(path);
}

function windowsSmokeTimeoutLine(lines: readonly string[]): number | undefined {
  const starts = lines.flatMap((line, index) => (line === '  windows-smoke:' ? [index] : []));
  if (starts.length !== 1) return undefined;
  const start = starts[0];
  const end = lines.findIndex((line, index) => index > start && /^ {2}[^\s:#][^:]*:$/u.test(line));
  const timeoutLines = lines.flatMap((line, index) =>
    index > start && (end === -1 || index < end) && /^ {4}timeout-minutes:/u.test(line) ? [index] : [],
  );
  return timeoutLines.length === 1 ? timeoutLines[0] : undefined;
}

function validTimeoutMinutes(line: string): number | undefined {
  const match = /^ {4}timeout-minutes: ([1-9]\d*)$/u.exec(line);
  const minutes = Number(match?.[1]);
  return Number.isSafeInteger(minutes) && minutes <= 360 ? minutes : undefined;
}

function windowsSmokeShardCommandLine(lines: readonly string[], command: string): number | undefined {
  const starts = lines.flatMap((line, index) => (line === '  windows-smoke:' ? [index] : []));
  if (starts.length !== 1) return undefined;
  const start = starts[0];
  const end = lines.findIndex((line, index) => index > start && /^ {2}[^\s:#][^:]*:$/u.test(line));
  const matches = lines.flatMap((line, index) =>
    index > start && (end === -1 || index < end) && line === command ? [index] : [],
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function changesOnlyWindowsSmokeBudget(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const beforeTimeout = windowsSmokeTimeoutLine(beforeLines);
  const afterTimeout = windowsSmokeTimeoutLine(afterLines);
  const beforeCommand = windowsSmokeShardCommandLine(beforeLines, WINDOWS_VITEST_SHARD_COMMAND);
  const addedDefault =
    beforeCommand !== undefined &&
    beforeCommand === windowsSmokeShardCommandLine(afterLines, WINDOWS_VITEST_DEFAULT_COMMAND);
  return (
    beforeTimeout !== undefined &&
    beforeTimeout === afterTimeout &&
    validTimeoutMinutes(beforeLines[beforeTimeout]) !== undefined &&
    validTimeoutMinutes(afterLines[afterTimeout]) !== undefined &&
    (beforeLines[beforeTimeout] !== afterLines[afterTimeout] || addedDefault) &&
    beforeLines.length === afterLines.length &&
    beforeLines.every(
      (line, index) =>
        index === beforeTimeout || (index === beforeCommand && addedDefault) || line === afterLines[index],
    )
  );
}

function parseJsonObject(source: string | undefined): JsonObject | undefined {
  if (source === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(source);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;

  const leftObject = left as JsonObject;
  const rightObject = right as JsonObject;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(leftObject[key], rightObject[key]))
  );
}

function changesOnlyTopLevelVersion(beforeSource: string | undefined, afterSource: string | undefined): boolean {
  const before = parseJsonObject(beforeSource);
  const after = parseJsonObject(afterSource);
  if (!before || !after) return false;
  if (typeof before.version !== 'string' || typeof after.version !== 'string' || before.version === after.version) {
    return false;
  }

  const beforeKeys = Object.keys(before)
    .filter(key => key !== 'version')
    .sort();
  const afterKeys = Object.keys(after)
    .filter(key => key !== 'version')
    .sort();
  return (
    beforeKeys.length === afterKeys.length &&
    beforeKeys.every((key, index) => key === afterKeys[index] && jsonValuesEqual(before[key], after[key]))
  );
}

export function classifyCodeGraphProductionRatchetScope(
  diff: CodeGraphProductionRatchetDiff,
): CodeGraphProductionRatchetScope {
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
  const packageChanged = paths.has('package.json');
  const pathsAreReleaseMetadata = sortedPaths.every(path => path === 'package.json' || isReleaseNotePath(path));
  const releaseMetadataOnly =
    !invalidPath &&
    sortedPaths.length > 0 &&
    packageChanged &&
    pathsAreReleaseMetadata &&
    changesOnlyTopLevelVersion(diff.beforePackageJson, diff.afterPackageJson);

  const evaluationOnly = !invalidPath && sortedPaths.length > 0 && sortedPaths.every(isUnrelatedEvaluationPath);
  const ciAndTestPolicyOnly =
    !invalidPath &&
    sortedPaths.length > 0 &&
    sortedPaths.every(isCiTestPolicyPath) &&
    (!paths.has(CI_WORKFLOW_PATH) || changesOnlyWindowsSmokeBudget(diff.beforeCiWorkflow, diff.afterCiWorkflow));
  const skipReason =
    !invalidPath && isPurePrivateReleaseEvidenceDiff(sortedPaths)
      ? 'private-release-evidence-only'
      : releaseMetadataOnly
        ? 'release-metadata-only'
        : evaluationOnly
          ? 'unrelated-evaluation-only'
          : ciAndTestPolicyOnly
            ? 'ci-and-test-policy-only'
            : undefined;
  return {changedCount: sortedPaths.length, paths: sortedPaths, runBenchmark: skipReason === undefined, skipReason};
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
  readonly scope: CodeGraphProductionRatchetScope;
} {
  const failSafe = (reason: string): {readonly reason: string; readonly scope: CodeGraphProductionRatchetScope} => ({
    reason,
    scope: classifyCodeGraphProductionRatchetScope({changedPaths: []}),
  });
  if (!isCommitId(base) || !isCommitId(head)) return failSafe('missing-or-invalid-commit-range');

  const mergeBaseResult = runGit(['merge-base', base, head]);
  const mergeBase = new TextDecoder().decode(mergeBaseResult.stdout).trim();
  if (mergeBaseResult.exitCode !== 0 || !isCommitId(mergeBase)) return failSafe('git-merge-base-failed');

  const diffResult = runGit(['diff', '--name-only', '--no-renames', '-z', `${mergeBase}..${head}`, '--']);
  if (diffResult.exitCode !== 0) return failSafe(`git-diff-failed-${diffResult.exitCode}`);
  const changedPaths = new TextDecoder().decode(diffResult.stdout).split('\0').filter(Boolean);
  const scope = classifyCodeGraphProductionRatchetScope({
    afterCiWorkflow: changedPaths.includes(CI_WORKFLOW_PATH) ? readGitFile(head, CI_WORKFLOW_PATH) : undefined,
    afterPackageJson: readGitFile(head, 'package.json'),
    beforeCiWorkflow: changedPaths.includes(CI_WORKFLOW_PATH) ? readGitFile(mergeBase, CI_WORKFLOW_PATH) : undefined,
    beforePackageJson: readGitFile(mergeBase, 'package.json'),
    changedPaths,
  });
  return {
    reason: scope.skipReason ?? 'ratchet-relevant-or-ambiguous-diff',
    scope,
  };
}

async function writeGitHubOutput(scope: CodeGraphProductionRatchetScope, reason: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    await Bun.write(
      outputPath,
      `run_benchmark=${String(scope.runBenchmark)}\nchanged_count=${scope.changedCount}\nreason=${reason}\n`,
    );
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await Bun.write(
      summaryPath,
      `### Code graph production ratchet scope\n\n- Changed paths: ${scope.changedCount}\n- Reason: \`${reason}\`\n- Run benchmark: ${scope.runBenchmark ? 'yes' : 'no'}\n`,
    );
  }
}

if (import.meta.main) {
  const {reason, scope} = classifyCurrentDiff(commitArgument('--base'), commitArgument('--head'));
  await writeGitHubOutput(scope, reason);
  process.stdout.write(`${JSON.stringify({reason, ...scope})}\n`);
}
