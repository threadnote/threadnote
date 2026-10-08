import {defineConfig} from 'vitest/config';
import {
  CI_STANDARD_TEST_TIMEOUT_MILLISECONDS,
  ciLongRunningTestGroups,
  ciSerializedLongRunningTestGroups,
  type CiLongRunningTestGroupName,
} from './tools/ci/vitest-plan.js';

const lifecycleAlphaVerbs =
  'aliases|atomically|attaches|batches|builds|changes|coalesces|collapses|counts|falls|materializes|serves|shares';
const lifecycleBetaVerbs = 'does|fails|sanitizes|streams|synchronously|treats|uses|visibly|waits';
const lifecycleBetaNested = 'full materialization fallback .* fails closed';
const lifecycleGammaVerbs = 'holds|indexes|keeps|marks|pauses|performs|preserves|prunes|publishes|purges';
const knownLifecycleVerbs = `${lifecycleAlphaVerbs}|${lifecycleBetaVerbs}|${lifecycleGammaVerbs}`;
const lifecycleTestPrefix = 'native code graph lifecycle ';

const ciLongRunningTestPatterns: Partial<Record<string, RegExp>> = {
  'lifecycle-alpha': new RegExp(`${lifecycleTestPrefix}(?:${lifecycleAlphaVerbs})\\b`, 'u'),
  'lifecycle-beta': new RegExp(`${lifecycleTestPrefix}(?:(?:${lifecycleBetaVerbs})\\b|${lifecycleBetaNested})`, 'u'),
  'lifecycle-gamma': new RegExp(`${lifecycleTestPrefix}(?:${lifecycleGammaVerbs})\\b`, 'u'),
  // The final group is deliberately a fallback. New lifecycle tests cannot be
  // silently omitted merely because their title starts with a new verb.
  'lifecycle-delta': new RegExp(
    `${lifecycleTestPrefix}(?!(?:${knownLifecycleVerbs})\\b|${lifecycleBetaNested}).+`,
    'u',
  ),
};

export const createVitestConfig = (ciLongRunningGroupName = process.env.THREADNOTE_VITEST_LONG_GROUP) => {
  const ciLongRunningGroup = ciLongRunningGroupName
    ? ciLongRunningTestGroups[ciLongRunningGroupName as CiLongRunningTestGroupName]
    : undefined;
  const ciSerializedLongGroup = ciLongRunningGroupName
    ? ciSerializedLongRunningTestGroups.has(ciLongRunningGroupName as CiLongRunningTestGroupName)
    : false;

  if (ciLongRunningGroupName && !ciLongRunningGroup) {
    throw new Error(`Unknown CI long-running test group: ${ciLongRunningGroupName}`);
  }

  return defineConfig({
    assetsInclude: ['**/*.gguf'],
    test: {
      // Test files use isolated Threadnote homes, so the production home-scoped
      // parser-slot locks cannot bound child processes across Vitest workers.
      // Dedicated parser-pool and heavy-tail tests exercise parallel extraction.
      env: {THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '1'},
      environment: 'node',
      // Keep worker pressure invariant across local and hosted runs. Four outer
      // CI shards provide parallelism; varying an inner pool with runner capacity
      // only makes contention-sensitive test timing nondeterministic.
      maxWorkers: ciSerializedLongGroup ? 1 : 2,
      ...(ciSerializedLongGroup ? {fileParallelism: false} : {}),
      hookTimeout: 30_000,
      include: ciLongRunningGroup
        ? [...ciLongRunningGroup]
        : [
            'apps/threadnote/test/**/*.test.ts',
            'apps/threadnote/src/integrations/**/test/**/*.test.ts',
            'apps/website/test/**/*.test.ts',
            'infra/*/test/**/*.test.ts',
            'packages/*/test/**/*.test.{ts,tsx}',
            'tools/bazel/test/*.test.ts',
            'tools/ci/test/*.test.ts',
            'tools/workspace/test/*.test.ts',
          ],
      testNamePattern: ciLongRunningGroupName ? ciLongRunningTestPatterns[ciLongRunningGroupName] : undefined,
      // Long groups are independently bounded jobs; ordinary shards retain the
      // same fast timeout as local runs so new regressions fail promptly.
      testTimeout:
        ciLongRunningGroupName === 'load-evidence'
          ? 600_000
          : ciLongRunningGroupName
            ? 180_000
            : CI_STANDARD_TEST_TIMEOUT_MILLISECONDS,
      coverage: {
        provider: 'istanbul',
        reporter: ['text', 'html', 'lcov'],
        include: ['apps/threadnote/src/**/*.ts', 'packages/*/src/**/*.ts'],
        exclude: [
          '**/test/**',
          'packages/testing/**',
          'apps/threadnote/src/types.ts',
          'apps/threadnote/src/threadnote.ts',
          'apps/threadnote/src/mcp/server/index.ts',
          'apps/threadnote/src/mcp/index.ts',
          'apps/threadnote/src/mcp/install.ts',
          'apps/threadnote/src/hooks.ts',
          'apps/threadnote/src/lifecycle.ts',
          'apps/threadnote/src/seeding.ts',
          'apps/threadnote/src/memory/index.ts',
          'apps/threadnote/src/memory/commands.ts',
          'apps/threadnote/src/runtime.ts',
          'apps/threadnote/src/release/check.ts',
        ],
      },
    },
  });
};

export default createVitestConfig();
