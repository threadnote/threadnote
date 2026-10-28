import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {classifyPlatformBenchmarkScope} from '../platform-benchmark-scope.js';
import {privateReleaseEvidenceFamilies} from '../private-release-evidence-family.js';

const productCaptureFamily = privateReleaseEvidenceFamilies[0];
const releaseCollectionFamily = privateReleaseEvidenceFamilies[1];

const beforePackage = JSON.stringify({
  dependencies: {effect: '4.0.0-rc.112'},
  name: 'threadnote',
  scripts: {
    'bench:code-graph': 'bun scripts/benchmark-code-graph.ts',
    'bench:recall:vectors': 'bun scripts/benchmark-recall-vectors.ts',
    test: 'vitest run',
  },
  version: '5.0.0',
});

function scope(
  changedPaths: readonly string[],
  afterPackageJson = beforePackage,
): ReturnType<typeof classifyPlatformBenchmarkScope> {
  return classifyPlatformBenchmarkScope({afterPackageJson, beforePackageJson: beforePackage, changedPaths});
}

describe('Platform benchmark PR scope', () => {
  it('skips the audited native workflow test-policy edits including PR #918', () => {
    for (const path of [
      'apps/threadnote/test/dev-skills/native-closeout-lifecycle.test.ts',
      'apps/threadnote/test/dev-skills/native-authoring-lifecycle.test.ts',
      'apps/threadnote/test/dev-skills/native-release-workflows.ts',
      'apps/threadnote/test/dev-skills/release-artifact.test.ts',
    ])
      expect(scope([path])).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
    for (const path of [
      'apps/threadnote/test/dev-skills/native-closeout-lifecycle-next.test.ts',
      'apps/threadnote/test/dev-skills/native-closeout-lifecycle.test.ts.backup',
      '.github/workflows/ci.yml',
      'tools/ci/test/benchmark-workflow.test.ts',
    ])
      expect(scope([path])).toMatchObject({runRecallPr: true, runCodeGraphPr: true});
  });

  it('keeps audited test-policy exemptions deterministic without hiding mixed changes', () => {
    const paths = [
      'apps/threadnote/test/dev-skills/native-closeout-lifecycle.test.ts',
      'apps/threadnote/test/dev-skills/release-artifact.test.ts',
      'tools/bazel/test/target-contracts.test.ts',
    ];
    fc.assert(
      fc.property(fc.shuffledSubarray(paths, {minLength: 1}), selected => {
        expect(scope([...selected, ...selected].reverse())).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
        expect(scope([...selected, 'packages/graph/src/index.ts'])).toMatchObject({
          runRecallPr: false,
          runCodeGraphPr: true,
        });
        expect(scope([...selected, 'packages/recall/src/index.ts'])).toMatchObject({
          runRecallPr: true,
          runCodeGraphPr: false,
        });
        for (const path of ['bun.lock', 'unknown/input.ts', '', '../escape.ts']) {
          expect(scope([...selected, path])).toMatchObject({runRecallPr: true, runCodeGraphPr: true});
        }
      }),
      {numRuns: 50},
    );
  });

  it('skips the PR #601 release-readiness-only diff for both expensive lanes', () => {
    const after = JSON.stringify({
      dependencies: {effect: '4.0.0-rc.112'},
      name: 'threadnote',
      scripts: {
        'assemble:threadnote-5-observer-authority': 'bun scripts/assemble-threadnote-5-observer-authority.ts',
        'bench:code-graph': 'bun scripts/benchmark-code-graph.ts',
        'bench:recall:vectors': 'bun scripts/benchmark-recall-vectors.ts',
        test: 'vitest run',
      },
      version: '5.0.0',
    });
    const result = classifyPlatformBenchmarkScope({
      beforePackageJson: beforePackage,
      afterPackageJson: after,
      changedPaths: [
        'docs/release-readiness.md',
        'package.json',
        'scripts/assemble-threadnote-5-observer-authority.ts',
        'apps/threadnote/src/evaluation/threadnote-5-release-readiness-observer-authority.ts',
        'apps/threadnote/test/unit/evaluation.threadnote-5-release-readiness-observer-authority.test.ts',
        'apps/threadnote/test/unit/release-tool-help.contract.test.ts',
      ],
    });
    expect(result.runRecallPr).toBe(false);
    expect(result.runCodeGraphPr).toBe(false);
  });

  it('skips both expensive lanes only for exact private release-evidence families', () => {
    for (const family of privateReleaseEvidenceFamilies) {
      expect(scope(family.paths)).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
    }
    for (const paths of [
      [...productCaptureFamily.paths, 'src/evaluation/threadnote-5-product-capture-future.ts'],
      [...releaseCollectionFamily.paths, 'scripts/threadnote-5-collection-transport-next.ts'],
      [...productCaptureFamily.paths, ...releaseCollectionFamily.paths],
      [...productCaptureFamily.paths, 'unknown/private-evaluation-payload.bin'],
      [...productCaptureFamily.paths, ''],
    ]) {
      expect(scope(paths)).toMatchObject({runRecallPr: true, runCodeGraphPr: true});
    }
    for (const paths of [
      productCaptureFamily.paths.map(path => path.replaceAll('/', '\\')),
      releaseCollectionFamily.paths.map(path => `./${path}`),
    ]) {
      expect(scope(paths)).toMatchObject({invalidPath: true, runRecallPr: true, runCodeGraphPr: true});
    }
  });

  it('selects independent lanes and treats shared dependencies as both lanes', () => {
    expect(scope(['packages/recall/src/index.ts'])).toMatchObject({runRecallPr: true, runCodeGraphPr: false});
    expect(scope(['packages/graph/src/index.ts'])).toMatchObject({runRecallPr: false, runCodeGraphPr: true});
    expect(scope(['scripts/benchmark-code-graph.ts'])).toMatchObject({runRecallPr: false, runCodeGraphPr: true});
    expect(scope(['packages/recall/src/vector-index.ts'])).toMatchObject({runRecallPr: true, runCodeGraphPr: false});
    expect(scope(['apps/threadnote/src/effect/runtime.ts'])).toMatchObject({runRecallPr: true, runCodeGraphPr: true});
    expect(scope(['apps/threadnote/test/evaluation/fixtures/code-graph-v1/fixture.ts'])).toMatchObject({
      runRecallPr: false,
      runCodeGraphPr: true,
    });
    expect(scope(['apps/threadnote/test/evaluation/fixtures/recall-v1/fixture.json'])).toMatchObject({
      runRecallPr: true,
      runCodeGraphPr: false,
    });
  });

  it('runs both lanes fail safe for dependency manifests, invalidity, and ambiguous paths', () => {
    expect(scope(['bun.lock'])).toMatchObject({runRecallPr: true, runCodeGraphPr: true});
    expect(scope(['package.json'], JSON.stringify({dependencies: {effect: 'later'}}))).toMatchObject({
      runRecallPr: true,
      runCodeGraphPr: true,
    });
    expect(
      classifyPlatformBenchmarkScope({
        changedPaths: ['packages/recall/src/index.ts', undefined] as unknown as Iterable<string>,
      }),
    ).toMatchObject({invalidPath: true, runRecallPr: true, runCodeGraphPr: true});
    expect(classifyPlatformBenchmarkScope({changedPaths: []})).toMatchObject({runRecallPr: true, runCodeGraphPr: true});
    expect(scope(['src/unknown-broad-dependency.ts'])).toMatchObject({runRecallPr: true, runCodeGraphPr: true});
  });

  it('does not ignore adjacent release-readiness paths or scripts', () => {
    expect(scope(['src/evaluation/threadnote-5-release-readiness-future.ts'])).toMatchObject({
      runRecallPr: true,
      runCodeGraphPr: true,
    });
    expect(scope(['scripts/evaluate-threadnote-5-release-readiness-future.ts'])).toMatchObject({
      runRecallPr: true,
      runCodeGraphPr: true,
    });
    const adjacentScriptAfter = JSON.stringify({
      ...JSON.parse(beforePackage),
      scripts: {...JSON.parse(beforePackage).scripts, 'assemble:threadnote-5-observer-authority-future': 'bun noop.ts'},
    });
    expect(scope(['package.json'], adjacentScriptAfter)).toMatchObject({runRecallPr: true, runCodeGraphPr: true});
  });

  it('classifies package scripts per lane while ignoring unrelated release metadata', () => {
    const recallAfter = JSON.stringify({
      dependencies: {effect: '4.0.0-rc.112'},
      name: 'threadnote',
      scripts: {...JSON.parse(beforePackage).scripts, 'bench:recall:extra': 'bun scripts/benchmark-recall-extra.ts'},
      version: '5.0.0',
    });
    expect(scope(['package.json'], recallAfter)).toMatchObject({runRecallPr: true, runCodeGraphPr: false});
    const metadataAfter = JSON.stringify({...JSON.parse(beforePackage), version: '5.0.1'});
    expect(scope(['package.json'], metadataAfter)).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
  });

  it('is invariant to path order and duplication, and adding a relevant path is monotone', () => {
    const ignored = [
      'docs/release-readiness.md',
      'scripts/assemble-threadnote-5-observer-authority.ts',
      'apps/threadnote/test/unit/release-tool-help.contract.test.ts',
    ];
    fc.assert(
      fc.property(fc.shuffledSubarray(ignored, {minLength: 1}), paths => {
        expect(scope(paths)).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
        expect(scope([...paths].reverse())).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
        expect(scope([...paths, ...paths])).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
      }),
      {numRuns: 100},
    );
    fc.assert(
      fc.property(fc.shuffledSubarray(ignored, {minLength: 1}), paths => {
        expect(scope([...paths, 'packages/recall/src/index.ts'])).toMatchObject({
          runRecallPr: true,
          runCodeGraphPr: false,
        });
      }),
      {numRuns: 100},
    );
  });

  it('keeps private release-evidence exemptions order/duplicate invariant and fails safe for mixed paths', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([...releaseCollectionFamily.paths], {minLength: 1}), paths => {
        expect(scope(paths)).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
        expect(scope([...paths].reverse())).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
        expect(scope([...paths, ...paths])).toMatchObject({runRecallPr: false, runCodeGraphPr: false});
        expect(scope([...paths, ...productCaptureFamily.paths])).toMatchObject({
          runRecallPr: true,
          runCodeGraphPr: true,
        });
      }),
      {numRuns: 100},
    );
  });
});
