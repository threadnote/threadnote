import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {describe, expect, it} from 'vitest';
import {readPreparedInventory} from '../prepare.mjs';
import fc from 'fast-check';
import {ciRequiredLongRunningTestGroupNames} from '../../ci/vitest-plan.js';
import {selectTargets} from '../../ci/selection.mjs';
import {createVitestConfig} from '../../../vitest.config.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import * as Schema from 'effect/Schema';

interface TargetInventoryEntry {
  readonly dependsOn?: readonly string[];
  readonly entries?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly inputs: readonly string[];
  readonly kind: string;
  readonly label: string;
  readonly requiresNetwork?: boolean;
  readonly timeout?: string | null;
  readonly workspace?: boolean;
}

const targetInventoryEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    dependsOn: Schema.String.pipe(Schema.Array, Schema.optional),
    entries: Schema.String.pipe(Schema.Array, Schema.optional),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    inputs: Schema.Array(Schema.String),
    kind: Schema.String,
    label: Schema.String,
    requiresNetwork: Schema.optional(Schema.Boolean),
    timeout: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
    workspace: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const inventorySchema = Schema.StructWithRest(
  Schema.Struct({
    testSuites: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({name: Schema.String, package: Schema.String, tests: Schema.Array(Schema.String)}),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
    targets: Schema.Array(targetInventoryEntrySchema),
    version: Schema.Literal(1),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const {inventory: preparedInventory} = await readPreparedInventory({allowStaged: true});
const inventory = Schema.decodeUnknownSync(inventorySchema)(preparedInventory);
const packageManifestSchema = Schema.StructWithRest(Schema.Struct({version: Schema.String}), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const packageManifest = await Bun.file('package.json').json();
const rootManifest = Schema.decodeUnknownSync(packageManifestSchema)(packageManifest);
const targetEntries = (entry: TargetInventoryEntry): readonly string[] => {
  if (!entry.entries) throw new Error(`Generated target ${entry.label} omitted entries`);
  return entry.entries;
};
const targetEnvironmentValue = (entry: TargetInventoryEntry, key: string): string => {
  const value = entry.env?.[key];
  if (value === undefined) throw new Error(`Generated target ${entry.label} omitted environment value ${key}`);
  return value;
};
const target = (label: string) => {
  const found = EffectOption.getOrUndefined(
    EffectArray.findFirst(inventory.targets, candidate => candidate.label === label),
  );
  if (!found) throw new Error(`Missing generated target ${label}`);
  return found;
};
const applicationTargets = () =>
  EffectArrayPipe(inventory.targets, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (candidate, __effectArrayIndex) =>
        __effectArrayIndex in __effectArrayValues &&
        (Effect.pipe(candidate.label, EffectString.startsWith('//apps/threadnote:test_standard_')) ||
          Effect.pipe(candidate.label, EffectString.startsWith('//apps/threadnote:test_integration_'))),
    ),
  );
const applicationTargetForEntry = (entry: string) => {
  const found = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      applicationTargets(),
      __effectArrayValue => !!(candidate => candidate.entries?.includes(entry) ?? false)(__effectArrayValue),
    ),
  );
  if (!found) throw new Error(`Missing generated application target for ${entry}`);
  return found;
};
const integrationPackageTargets = () => {
  const targets = inventory.targets;
  return EffectArray.filter(
    targets,
    (candidate, __effectArrayIndex) =>
      __effectArrayIndex in targets && /^\/\/packages\/integration-[^:]+:test$/u.test(candidate.label),
  ).sort((left, right) => Effect.pipe(left.label, EffectString.localeCompare(right.label)));
};
const integrationPackageTarget = (name: string) =>
  EffectOption.getOrUndefined(
    EffectArray.findFirst(integrationPackageTargets(), candidate => candidate.label === `//packages/${name}:test`),
  )!;
const selectForChangedInput = (changedFile: string) =>
  selectTargets({
    inventory: EffectArray.map(inventory.targets, candidate => candidate.label),
    impacted: [],
    changedFiles: [changedFile],
    knownInputs: EffectArray.flatMap(inventory.targets, candidate => candidate.inputs),
    targetDependencies: EffectRecord.fromEntries(
      EffectArray.map(inventory.targets, candidate => [candidate.label, candidate.dependsOn ?? []]),
    ),
    targetInputs: EffectRecord.fromEntries(
      EffectArray.map(inventory.targets, candidate => [candidate.label, candidate.inputs]),
    ),
  });
const selectedIntegrationPackageTests = (changedFile: string) => {
  const targets = selectForChangedInput(changedFile).targets;
  return EffectArray.filter(
    targets,
    (label, __effectArrayIndex) =>
      __effectArrayIndex in targets && /^\/\/packages\/integration-[^:]+:test$/u.test(label),
  );
};

describe('generated Bazel test contracts', () => {
  it('selects Windows smoke when its workflow changes', () => {
    expect(selectForChangedInput('.github/workflows/ci.yml').targets).toContain('//:windows_smoke');
  });

  it.each([
    'apps/threadnote/test/dev-skills/native-closeout-lifecycle-fixture.ts',
    'apps/threadnote/test/dev-skills/native-cycle-lifecycle-fixture.ts',
  ])('preserves Windows smoke selection for extracted lifecycle helper %s', file => {
    expect(target('//:windows_smoke_inputs').inputs).toContain(file);
    const selection = selectForChangedInput(file);
    expect(selection.mode).toBe('selective');
    expect(selection.targets).toContain('//:windows_smoke');
  });

  it.each([
    'apps/threadnote/test/dev-skills/native-authoring-lifecycle.test.ts',
    'apps/threadnote/test/dev-skills/native-closeout-lifecycle.test.ts',
    'apps/threadnote/test/dev-skills/native-closeout-recall-batch.test.ts',
    'apps/threadnote/test/dev-skills/native-cycle-lifecycle.test.ts',
    'apps/threadnote/test/integration/cli.dev-skills.test.ts',
    'packages/integrations/test/dev-skills-catalog.test.ts',
  ])('selects Windows smoke when executed test %s changes', changedFile => {
    expect(target('//:windows_smoke').inputs).toContain(changedFile);
    const selection = selectForChangedInput(changedFile);
    expect(selection.mode).toBe('selective');
    expect(selection.targets).toContain('//:windows_smoke');
  });

  it('keeps the inventory byte-stable across filesystem enumeration orders', () => {
    const labels = EffectArray.map(inventory.targets, candidate => candidate.label);
    expect(labels).toEqual([...labels].sort());
  });

  it('excludes ignored install artifacts from generated inputs', () => {
    const inputs = EffectArray.flatMap(inventory.targets, candidate => candidate.inputs);

    expect(EffectArray.some(inputs, input => Effect.pipe(input, EffectString.startsWith('.husky/_/')))).toBe(false);
  });

  it('owns every PostgreSQL-gated suite in the localhost-enabled target', () => {
    const expected = [
      'apps/threadnote/test/integration/remote-memory-git-authority.test.ts',
      'apps/threadnote/test/integration/remote-memory-git-binding.test.ts',
      'apps/threadnote/test/integration/remote-memory-git-composer.test.ts',
      'apps/threadnote/test/integration/remote-memory-git-lifecycle.test.ts',
      'apps/threadnote/test/integration/remote-memory-hosted-context-ci.test.ts',
      'apps/threadnote/test/integration/remote-memory-hosted-context-health.test.ts',
      'apps/threadnote/test/integration/remote-memory-oauth-provider.test.ts',
      'apps/threadnote/test/integration/remote-memory-org-cloud.test.ts',
      'apps/threadnote/test/integration/remote-memory-postgres.test.ts',
      'apps/threadnote/test/integration/remote-memory-review-gated.test.ts',
      'apps/threadnote/test/integration/remote-memory-runtime-privileges.test.ts',
    ];
    const postgres = target('//apps/threadnote:test_postgres');
    const standardEntries = EffectArray.flatMap(applicationTargets(), candidate => candidate.entries ?? []);

    expect(postgres.entries).toEqual(expected);
    expect(postgres.workspace).toBe(false);
    expect(postgres.requiresNetwork).toBe(true);
    expect(targetEnvironmentValue(postgres, 'THREADNOTE_TEST_POSTGRES_URL')).toContain('127.0.0.1:5432');
    expect(postgres.inputs).toContain('packages/remote-memory/src/migrations/001_initial.sql');
    expect(EffectArray.every(expected, entry => !standardEntries.includes(entry))).toBe(true);
  });

  it('keeps the application suite contributor-friendly while generating bounded feature targets', () => {
    const targets = applicationTargets();
    const entries = EffectArray.flatMap(targets, candidate => targetEntries(candidate));
    const suite = EffectOption.getOrUndefined(
      EffectArray.findFirst(inventory.testSuites, candidate => candidate.package === 'apps/threadnote'),
    );

    expect(targets.length).toBeGreaterThan(8);
    // Bound grouping overhead with corpus growth while retaining isolated provider targets.
    const integrationTargets = EffectArray.filter(
      targets,
      __effectArrayValue =>
        !!(candidate => Effect.pipe(candidate.label, EffectString.startsWith('//apps/threadnote:test_integration_')))(
          __effectArrayValue,
        ),
    );
    const standardEntryCount =
      entries.length -
      EffectArray.reduce(integrationTargets, 0, (count, candidate) => count + targetEntries(candidate).length);
    expect(targets.length).toBeLessThanOrEqual(integrationTargets.length + Math.ceil(standardEntryCount / 12));
    expect(EffectArray.every(targets, candidate => candidate.workspace === true)).toBe(true);
    expect(
      EffectArray.every(
        targets,
        candidate => targetEntries(candidate).length > 0 && targetEntries(candidate).length <= 40,
      ),
    ).toBe(true);
    expect(new Set(entries).size).toBe(entries.length);
    expect(suite).toEqual({
      name: 'test',
      package: 'apps/threadnote',
      tests: EffectArray.map(targets, candidate => `:${Effect.pipe(candidate.label, EffectString.split(':'))[1]}`),
    });
  });

  it('discovers provider package tests in Vitest and exactly one Bazel target', () => {
    const expectedPackages = [
      'integration-core',
      'integration-runtime',
      'integration-obsidian',
      'integration-superhuman',
      'integration-pocket',
      'integration-github',
      'integration-linear',
    ];
    const providerTargets = integrationPackageTargets();
    const entries = EffectArray.flatMap(providerTargets, candidate => targetEntries(candidate));

    expect(EffectArray.map(providerTargets, candidate => candidate.label)).toEqual(
      EffectArray.map(expectedPackages, name => `//packages/${name}:test`).sort(),
    );
    expect(EffectArray.every(providerTargets, candidate => targetEntries(candidate).length > 0)).toBe(true);
    expect(new Set(entries).size).toBe(entries.length);
    expect(createVitestConfig().test?.include).toContain('packages/*/test/**/*.test.{ts,tsx}');
    for (const entry of entries) {
      expect(
        EffectArrayPipe(inventory.targets, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (candidate, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues && (candidate.entries?.includes(entry) ?? false),
          ),
        ),
      ).toHaveLength(1);
    }
  });

  it('keeps application integration composition tests in separate Bazel targets', () => {
    const targets = EffectArrayPipe(inventory.targets, __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (candidate, __effectArrayIndex) =>
          __effectArrayIndex in __effectArrayValues &&
          Effect.pipe(candidate.label, EffectString.startsWith('//apps/threadnote:test_integration_')),
      ),
    );
    const entries = EffectArray.flatMap(targets, candidate => targetEntries(candidate));
    const suite = EffectOption.getOrUndefined(
      EffectArray.findFirst(inventory.testSuites, candidate => candidate.package === 'apps/threadnote'),
    );

    expect(entries.length).toBeGreaterThan(0);
    expect(
      EffectArray.every(entries, entry =>
        Effect.pipe(entry, EffectString.startsWith('apps/threadnote/test/integrations/')),
      ),
    ).toBe(true);
    expect(new Set(entries).size).toBe(entries.length);
    expect(createVitestConfig().test?.include).toContain('apps/threadnote/test/**/*.test.{ts,tsx}');
    expect(suite?.tests).toEqual(
      expect.arrayContaining(
        EffectArray.map(targets, candidate => `:${Effect.pipe(candidate.label, EffectString.split(':'))[1]}`),
      ),
    );
  });

  it.each([
    'integration-obsidian',
    'integration-superhuman',
    'integration-pocket',
    'integration-github',
    'integration-linear',
  ])('selects only the owning provider suite for %s source, test, and manifest edits', packageName => {
    const provider = integrationPackageTarget(packageName);
    const source = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        provider.inputs,
        __effectArrayValue =>
          !!(path => Effect.pipe(path, EffectString.startsWith(`packages/${packageName}/src/`)))(__effectArrayValue),
      ),
    );
    const test = targetEntries(provider)[0];
    const manifest = `packages/${packageName}/package.json`;

    expect(source).toBeDefined();
    expect(provider.inputs).toContain(manifest);
    for (const changedFile of [source!, test, manifest]) {
      const result = selectForChangedInput(changedFile);

      expect(result.mode).toBe('selective');
      expect(result.targets).not.toEqual(EffectArray.map(inventory.targets, candidate => candidate.label));
      expect(selectedIntegrationPackageTests(changedFile)).toEqual([provider.label]);
      if (changedFile === source || changedFile === manifest) {
        const standardApplicationTargets = EffectArrayPipe(result.targets, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (label, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues &&
              Effect.pipe(label, EffectString.startsWith('//apps/threadnote:test_standard_')),
          ),
        );
        const providerName = Effect.pipe(packageName, EffectString.slice('integration-'.length));

        expect(
          EffectArray.every(
            standardApplicationTargets,
            label =>
              Effect.pipe(label, EffectString.includes(`test_standard_integration_${providerName}_`)) ||
              Effect.pipe(label, EffectString.includes('integration_all_')),
          ),
        ).toBe(true);
      }
    }
  });

  it.each([
    [
      'packages/integration-core/src/config.ts',
      [
        '//packages/integration-github:test',
        '//packages/integration-linear:test',
        '//packages/integration-obsidian:test',
        '//packages/integration-pocket:test',
        '//packages/integration-runtime:test',
        '//packages/integration-superhuman:test',
      ],
    ],
    [
      'packages/integration-runtime/src/config.ts',
      [
        '//packages/integration-github:test',
        '//packages/integration-linear:test',
        '//packages/integration-obsidian:test',
        '//packages/integration-pocket:test',
        '//packages/integration-runtime:test',
        '//packages/integration-superhuman:test',
      ],
    ],
    [
      'packages/integration-runtime/src/access-policy.ts',
      [
        '//packages/integration-github:test',
        '//packages/integration-linear:test',
        '//packages/integration-pocket:test',
        '//packages/integration-superhuman:test',
      ],
    ],
  ])('fans shared integration source %s out to its declared package-test dependents', (changedFile, expected) => {
    const result = selectForChangedInput(changedFile);

    expect(result.mode).toBe('selective');
    expect(selectedIntegrationPackageTests(changedFile)).toEqual(expected);
  });

  it.each([
    [
      'packages/integration-core/package.json',
      [
        '//packages/integration-core:test',
        '//packages/integration-github:test',
        '//packages/integration-linear:test',
        '//packages/integration-obsidian:test',
        '//packages/integration-pocket:test',
        '//packages/integration-runtime:test',
        '//packages/integration-superhuman:test',
      ],
    ],
    [
      'packages/integration-runtime/package.json',
      [
        '//packages/integration-github:test',
        '//packages/integration-linear:test',
        '//packages/integration-obsidian:test',
        '//packages/integration-pocket:test',
        '//packages/integration-runtime:test',
        '//packages/integration-superhuman:test',
      ],
    ],
  ])('selects package tests from shared workspace manifest %s without falling back', (changedFile, expected) => {
    const result = selectForChangedInput(changedFile);

    expect(result.mode).toBe('selective');
    expect(selectedIntegrationPackageTests(changedFile)).toEqual(expected);
  });

  it('infers runtime and repository inputs without coupling every application target to them', () => {
    const runtime = applicationTargetForEntry('apps/threadnote/test/unit/command-shim.test.ts');
    const runtimeOwners = EffectArrayPipe(applicationTargets(), __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (candidate, __effectArrayIndex) =>
          __effectArrayIndex in __effectArrayValues && candidate.inputs.includes('apps/threadnote/src/standalone.ts'),
      ),
    );
    const graphFeatureOwners = EffectArrayPipe(applicationTargets(), __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (candidate, __effectArrayIndex) =>
          __effectArrayIndex in __effectArrayValues &&
          candidate.inputs.includes('packages/graph/src/git/worktree/registration_worker.ts'),
      ),
    );

    expect(runtime.inputs).toContain('apps/threadnote/src/standalone.ts');
    expect(runtimeOwners.length).toBeLessThan(applicationTargets().length);
    expect(graphFeatureOwners.length).toBeGreaterThan(0);
    expect(graphFeatureOwners.length).toBeLessThan(applicationTargets().length);
  });

  it.each([
    ['apps/threadnote/test/unit/publish-workflow.test.ts', `.github/release-notes/v${rootManifest.version}.md`],
    ['apps/threadnote/test/unit/update.test.ts', 'assets/code-graph/runtime/web-tree-sitter.wasm'],
    ['apps/threadnote/test/unit/update.test.ts', 'cursor-plugin/README.md'],
  ])('selects the owning generated target when the dynamic input %s reads changes', (entry, changedFile) => {
    const owner = applicationTargetForEntry(entry);
    const result = selectTargets({
      inventory: EffectArray.map(inventory.targets, candidate => candidate.label),
      impacted: [],
      changedFiles: [changedFile],
      knownInputs: EffectArray.flatMap(inventory.targets, candidate => candidate.inputs),
      targetDependencies: EffectRecord.fromEntries(
        EffectArray.map(inventory.targets, candidate => [candidate.label, candidate.dependsOn ?? []]),
      ),
      targetInputs: EffectRecord.fromEntries(
        EffectArray.map(inventory.targets, candidate => [candidate.label, candidate.inputs]),
      ),
    });

    expect(owner.inputs).toContain(changedFile);
    expect(result.mode).toBe('selective');
    expect(result.targets).toContain(owner.label);
  });

  it('does not select telemetry or graph suites for a website source change', () => {
    const changedFile = 'apps/website/src/main.tsx';
    const result = selectTargets({
      inventory: EffectArray.map(inventory.targets, candidate => candidate.label),
      impacted: [],
      changedFiles: [changedFile],
      knownInputs: EffectArray.flatMap(inventory.targets, candidate => candidate.inputs),
      targetDependencies: EffectRecord.fromEntries(
        EffectArray.map(inventory.targets, candidate => [candidate.label, candidate.dependsOn ?? []]),
      ),
      targetInputs: EffectRecord.fromEntries(
        EffectArray.map(inventory.targets, candidate => [candidate.label, candidate.inputs]),
      ),
    });
    const selectedEntries = EffectArray.flatMap(
      EffectArrayPipe(inventory.targets, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (candidate, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues && result.targets.includes(candidate.label),
        ),
      ),
      candidate => targetEntries(candidate),
    );

    expect(result.mode).toBe('selective');
    expect(result.targets).not.toContain('//packages/graph:test');
    expect(selectedEntries).not.toContain('apps/threadnote/test/integration/code-graph.telemetry.test.ts');
  });

  it('models required long groups while leaving scheduled load evidence to its dedicated workflow', () => {
    const generatedGroups = EffectArray.map(
      EffectArrayPipe(inventory.targets, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (candidate, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues &&
            Effect.pipe(candidate.label, EffectString.startsWith('//apps/threadnote:test_long_')),
        ),
      ),
      candidate => targetEnvironmentValue(candidate, 'THREADNOTE_VITEST_LONG_GROUP'),
    ).sort();

    expect(generatedGroups).toEqual([...ciRequiredLongRunningTestGroupNames].sort());
    expect(generatedGroups).not.toContain('load-evidence');
    for (const group of generatedGroups) {
      expect(
        target(`//apps/threadnote:test_long_${Effect.pipe(group, EffectString.replaceAll('-', '_'))}`).timeout,
      ).toBe('long');
      expect(
        target(`//apps/threadnote:test_long_${Effect.pipe(group, EffectString.replaceAll('-', '_'))}`).workspace,
      ).toBe(true);
    }
  });

  it('propagates modeled build and package impacts into platform CI lanes', () => {
    expect(target('//:release_matrix').dependsOn).toEqual([
      '//:release_check',
      '//:threadnote_build',
      '//:release_smoke_inputs',
    ]);
    expect(target('//:compile_targets').dependsOn).toEqual(['//:compile_inputs']);
    expect(target('//:recall_quality').dependsOn).toEqual(['//:recall_quality_inputs']);
    expect(target('//:windows_smoke').dependsOn).toEqual(['//:windows_smoke_inputs']);
  });

  it('keeps the PR #918 timeout-only edit in its owning tests and Windows lane', () => {
    const file = 'apps/threadnote/test/dev-skills/native-closeout-lifecycle.test.ts';
    const selection = selectForChangedInput(file);

    expect(selection.mode).toBe('selective');
    expect(selection.targets).toContain(applicationTargetForEntry(file).label);
    expect(selection.targets).toContain('//:windows_smoke');
    expect(selection.targets).not.toContain('//:release_matrix');
    expect(selection.targets).not.toContain('//:compile_targets');
  });

  it.each([
    'apps/threadnote/test/dev-skills/release-artifact.test.ts',
    'apps/threadnote/test/dev-skills/native-release-workflows.ts',
    'apps/threadnote/test/dev-skills/native-release-process.ts',
    'apps/threadnote/test/dev-skills/native-release-network-probe.ts',
    'apps/threadnote/test/dev-skills/release-tools-fixture.ts',
    'apps/threadnote/test/fixtures/cli-output-consumer.ts',
    'apps/threadnote/test/e2e/model-setup-upgrade.e2e.ts',
    'scripts/smoke-self-contained.ts',
    'scripts/archive-release.ts',
    'vitest.config.ts',
    'vitest.e2e.config.ts',
    'tools/ci/vitest-plan.ts',
  ])('selects release smoke independently of compilation for consumer input %s', file => {
    expect(target('//:release_smoke_inputs').inputs).toContain(file);
    const selection = selectForChangedInput(file);

    expect(selection.mode).toBe('selective');
    expect(selection.targets).toContain('//:release_matrix');
    expect(selection.targets).not.toContain('//:compile_targets');
  });

  it('selects only the compile lane for its cross-compilation entrypoint', () => {
    const selection = selectForChangedInput('scripts/compile-targets.ts');

    expect(selection.mode).toBe('selective');
    expect(selection.targets).toContain('//:compile_targets');
    expect(selection.targets).not.toContain('//:release_matrix');
  });

  it.each([
    'apps/threadnote/src/standalone.ts',
    'bun.lock',
    'package.json',
    'packages/graph/package.json',
    'assets/models/licenses/bge-small-en-v1.5.LICENSE',
    '.github/workflows/ci.yml',
  ])('retains compile and release coverage for shared input %s', file => {
    const selection = selectForChangedInput(file);

    expect(selection.mode).toBe('selective');
    expect(selection.targets).toEqual(expect.arrayContaining(['//:compile_targets', '//:release_matrix']));
  });

  it.each([
    'packages/integration-obsidian/static/integrations/obsidian.svg',
    'packages/integration-superhuman/static/integrations/superhuman-docs.png',
    'packages/integration-pocket/static/integrations/pocket.png',
    'packages/integration-github/static/integrations/github.svg',
    'packages/integration-linear/static/integrations/linear.svg',
  ])('packages %s and selects release validation for asset-only changes', asset => {
    expect(target('//:threadnote_build').inputs).toContain(asset);
    expect(target('//:release_check').inputs).toContain(asset);

    const selection = selectForChangedInput(asset);

    expect(selection.mode).toBe('selective');
    expect(selection.targets).toEqual(
      expect.arrayContaining(['//:threadnote_build', '//:release_check', '//:release_matrix']),
    );
    expect(selectedIntegrationPackageTests(asset)).toEqual([]);
  });

  it('declares the benchmark correctness preflight without treating it as measured execution', () => {
    const preflight = target('//:platform_benchmark_preflight');

    expect(preflight.kind).toBe('test');
    expect(preflight.workspace).toBe(true);
    expect(preflight.timeout).toBe('long');
    expect(preflight.entries).toEqual([
      'apps/threadnote/test/integration/code-graph.benchmark-failure.test.ts',
      'apps/threadnote/test/integration/code-graph.benchmark-preflight.test.ts',
      'apps/threadnote/test/unit/code-graph.benchmark-harness.test.ts',
      'apps/threadnote/test/unit/evaluation.recall-benchmark-runners.test.ts',
      'packages/graph/test/unit/code-graph.benchmark-sampler.test.ts',
      'tools/ci/test/benchmark-workflow.test.ts',
      'tools/ci/test/platform-benchmark-scope.test.ts',
    ]);
    expect(preflight.inputs).toContain('.github/workflows/benchmarks.yml');
    expect(preflight.inputs).toContain('.github/workflows/production-large-evidence.yml');
    expect(preflight.inputs).toContain('scripts/benchmark-code-graph.ts');
    expect(preflight.inputs).toContain('scripts/code-graph-benchmark-sampler.ts');
    expect(EffectArray.some(preflight.inputs, input => Effect.pipe(input, EffectString.startsWith('artifacts/')))).toBe(
      false,
    );
  });

  it('keeps application runtime closure out of ordinary package tests', () => {
    for (const packageName of ['context', 'graph', 'manager', 'memory', 'platform']) {
      const ordinary = target(`//packages/${packageName}:test`);
      const runtime = target(`//packages/${packageName}:test_runtime`);
      expect(ordinary.inputs).not.toContain('apps/threadnote/src/standalone.ts');
      expect(runtime.inputs).toContain('apps/threadnote/src/standalone.ts');
    }
  });

  it.each([
    ['packages/graph/package.json', '//:threadnote_build', '//:release_matrix'],
    [
      'apps/threadnote/embedded/models/bge-small-en-v1.5-q8/f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804.gguf',
      '//:release_check',
      '//:release_matrix',
    ],
    ['packages/inference/src/vector-search.ts', '//packages/inference:test', '//:recall_quality'],
    ['scripts/support/code-graph-workset-fixture.ts', '//:recall_quality_inputs', '//:recall_quality'],
    ['apps/threadnote/test/helpers/runtime-policy.ts', '//:windows_smoke_inputs', '//:windows_smoke'],
  ])('selects %s via the transitive lane contract', (changedFile, impactedTarget, lane) => {
    const result = selectTargets({
      inventory: EffectArray.map(inventory.targets, candidate => candidate.label),
      impacted: [impactedTarget],
      changedFiles: [changedFile],
      knownInputs: EffectArray.flatMap(inventory.targets, candidate => candidate.inputs),
      targetDependencies: EffectRecord.fromEntries(
        EffectArray.map(inventory.targets, candidate => [candidate.label, candidate.dependsOn ?? []]),
      ),
      targetInputs: EffectRecord.fromEntries(
        EffectArray.map(inventory.targets, candidate => [candidate.label, candidate.inputs]),
      ),
    });

    expect(result.targets).toContain(lane);
  });

  it('keeps lifecycle partitions distinct and preserves long-group timeouts and serialization', () => {
    const examples = {
      'lifecycle-alpha': 'native code graph lifecycle > aliases a checkout',
      'lifecycle-beta': 'native code graph lifecycle > fails closed',
      'lifecycle-gamma':
        'native code graph lifecycle > keeps status read-only and converges disposable incomplete graph state',
      'lifecycle-delta': 'native code graph lifecycle > reconciles an unknown verb',
    } as const;

    for (const [group, title] of EffectRecord.toEntries(examples)) {
      const config = createVitestConfig(group);
      const pattern = config.test?.testNamePattern;
      expect(pattern).toBeInstanceOf(RegExp);
      if (!(pattern instanceof RegExp)) throw new Error(`Expected a RegExp for group ${group}`);
      expect(EffectArray.filter(EffectRecord.toEntries(examples), ([, candidate]) => pattern.test(candidate))).toEqual([
        [group, title],
      ]);
      expect(config.test?.testTimeout).toBe(180_000);
    }

    const serialized = createVitestConfig('heavy-state');
    expect(serialized.test).toMatchObject({fileParallelism: false, maxWorkers: 1, testTimeout: 180_000});
    expect(createVitestConfig('load-evidence').test?.testTimeout).toBe(600_000);
  });

  it('assigns runtime lifecycle names to their intended group for arbitrary test suffixes', () => {
    const cases = [
      {group: 'lifecycle-alpha', title: 'aliases a checkout'},
      {group: 'lifecycle-beta', title: 'fails closed'},
      {group: 'lifecycle-beta', title: 'full materialization fallback > fails closed'},
      {group: 'lifecycle-gamma', title: 'keeps a ready snapshot'},
      {group: 'lifecycle-delta', title: 'reconciles an unknown verb'},
    ];
    const groups = ['lifecycle-alpha', 'lifecycle-beta', 'lifecycle-gamma', 'lifecycle-delta'];
    const patterns = EffectArray.map(groups, group => {
      const pattern = createVitestConfig(group).test?.testNamePattern;
      if (!(pattern instanceof RegExp)) throw new Error(`Missing lifecycle pattern for ${group}`);
      return {group, pattern};
    });
    const suffix = fc
      .array(fc.integer({min: 32, max: 126}), {maxLength: 48})
      .map(characters => String.fromCharCode(...characters));
    fc.assert(
      fc.property(fc.constantFrom(...cases), suffix, (example, tail) => {
        const name = `native code graph lifecycle > ${example.title} ${tail}`;
        const selected = EffectArray.map(
          EffectArray.filter(patterns, ({pattern}) => pattern.test(name)),
          ({group}) => group,
        );
        expect(selected).toEqual([example.group]);
      }),
      {numRuns: 40},
    );
  });
});
