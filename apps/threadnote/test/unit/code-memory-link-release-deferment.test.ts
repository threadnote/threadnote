import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assertCodeMemoryLinkReleaseDefermentGovernance,
  CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE,
  CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT,
  CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_TREE,
  codeMemoryLinkReleaseDefermentPath,
  parseCodeMemoryLinkReleaseDefermentV1,
  type CodeMemoryLinkReleaseDefermentGovernanceChange,
  type CodeMemoryLinkReleaseDefermentV1,
} from '../../../../scripts/verify-code-memory-link-release-deferment.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const GOVERNANCE = Effect.pipe('4', EffectString.repeat(40));
const WAIVER_PATH = codeMemoryLinkReleaseDefermentPath('v4.6.0');

describe('Code Memory Link 4.6 release deferment', () => {
  it('parses only the exact canonical, version-bound deferment and fixed candidate receipt', () => {
    const source = `${JSON.stringify(waiver(), undefined, 2)}\n`;
    expect(
      parseCodeMemoryLinkReleaseDefermentV1({
        expectedReleaseTag: 'v4.6.0',
        repositoryPath: WAIVER_PATH,
        source,
      }),
    ).toEqual(waiver());
    expect(() =>
      parseCodeMemoryLinkReleaseDefermentV1({
        expectedReleaseTag: 'v4.6.0',
        repositoryPath: WAIVER_PATH,
        source: JSON.stringify(waiver()),
      }),
    ).toThrow(/canonical JSON/u);
    expect(() =>
      parseCodeMemoryLinkReleaseDefermentV1({
        expectedReleaseTag: 'v4.6.0',
        repositoryPath: WAIVER_PATH,
        source: `${JSON.stringify(
          {...waiver(), candidate: {...waiver().candidate, commit: Effect.pipe('a', EffectString.repeat(40))}},
          undefined,
          2,
        )}\n`,
      }),
    ).toThrow(/exact qualified 4\.6\.0 receipt/u);
    expect(() => codeMemoryLinkReleaseDefermentPath('v4.6.1')).toThrow(/only for v4\.6\.0/u);
  });

  it('binds one bounded CI correction to the qualified candidate and four cumulative 100644 non-runtime paths', () => {
    expect(
      assertCodeMemoryLinkReleaseDefermentGovernance({
        changes: changes(),
        governanceCommit: GOVERNANCE,
        initialGovernanceParentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE.commit,
        initialGovernanceTree: CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_TREE,
        packageVersion: '4.6.0',
        parentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT,
        waiver: waiver(),
        waiverPath: WAIVER_PATH,
      }),
    ).toEqual({
      candidate: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE,
      governanceCommit: GOVERNANCE,
      initialGovernanceCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT,
      waiverPath: WAIVER_PATH,
    });
    expect(() =>
      assertCodeMemoryLinkReleaseDefermentGovernance({
        changes: EffectArray.map(changes(), change =>
          change.path === '.github/workflows/publish.yml' ? {...change, mode: '100755'} : change,
        ),
        governanceCommit: GOVERNANCE,
        initialGovernanceParentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE.commit,
        initialGovernanceTree: CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_TREE,
        packageVersion: '4.6.0',
        parentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT,
        waiver: waiver(),
        waiverPath: WAIVER_PATH,
      }),
    ).toThrow(/executable path/u);
    expect(() =>
      assertCodeMemoryLinkReleaseDefermentGovernance({
        changes: changes(),
        governanceCommit: GOVERNANCE,
        initialGovernanceParentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE.commit,
        initialGovernanceTree: CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_TREE,
        packageVersion: '4.6.0',
        parentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE.commit,
        waiver: waiver(),
        waiverPath: WAIVER_PATH,
      }),
    ).toThrow(/exact bounded CI correction/u);
  });

  it('rejects every generated extra governance path', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_.'), {minLength: 1, maxLength: 48})
          .map(parts => `unexpected/${EffectArray.join(parts, '')}`)
          .filter(path => !EffectArray.some(changes(), change => change.path === path)),
        repositoryPath => {
          expect(() =>
            assertCodeMemoryLinkReleaseDefermentGovernance({
              changes: [...changes(), {mode: '100644', path: repositoryPath, status: 'A'}],
              governanceCommit: GOVERNANCE,
              initialGovernanceParentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE.commit,
              initialGovernanceTree: CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_TREE,
              packageVersion: '4.6.0',
              parentCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT,
              waiver: waiver(),
              waiverPath: WAIVER_PATH,
            }),
          ).toThrow(/unsupported, missing, or executable path/u);
        },
      ),
      {numRuns: 50},
    );
  });

  it('keeps the one-shot v4.6.0 deferment out of later release publication', async () => {
    const workflow = await Bun.file(`${process.cwd()}/.github/workflows/publish.yml`).text();
    const recovery = await Bun.file(`${process.cwd()}/.github/workflows/publish-v4.6.0-recovery.yml`).text();
    const shippingJobs = Effect.pipe(
      workflow,
      EffectString.slice(
        Effect.pipe(
          workflow,
          EffectString.indexOf('\n  linux:'),
          Effect.Option.getOrElse(() => -1),
        ),
        Effect.pipe(
          workflow,
          EffectString.indexOf('\n  windows-sign:'),
          Effect.Option.getOrElse(() => -1),
        ),
      ),
    );

    expect(recovery).toContain('bun scripts/verify-code-memory-link-release-deferment.ts');
    expect(recovery).toContain('apps/threadnote/test/unit/code-memory-link-release-deferment.test.ts');
    expect(workflow).not.toContain('verify-code-memory-link-release-deferment.ts');
    expect(workflow).not.toContain('verify-code-memory-link-release.ts');
    expect(workflow).toContain('release_commit: ${{ steps.release_source.outputs.release_commit }}');
    expect(
      Effect.pipe(
        shippingJobs,
        EffectString.match(/name: Select exact verified release source/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        shippingJobs,
        EffectString.match(/fetch-depth: 3/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        shippingJobs,
        EffectString.match(/git checkout --detach "\$selected_commit"/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        shippingJobs,
        EffectString.match(/needs\.verify\.outputs\.release_commit/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        shippingJobs,
        EffectString.match(/GITHUB_EVENT_NAME" == 'workflow_dispatch'/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        shippingJobs,
        EffectString.match(/GITHUB_EVENT_NAME" == 'push'/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(
      Effect.pipe(
        shippingJobs,
        EffectString.match(/missing the exact verifier-selected tag commit/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(3);
    expect(shippingJobs).not.toContain('CANDIDATE_COMMIT');
  });
});

function waiver(): CodeMemoryLinkReleaseDefermentV1 {
  return {
    candidate: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE,
    deferredExperiment: {
      canonicalTrialsExecuted: 0,
      followUpVersion: '4.6.1',
      minimumObservedProviderTokens: 192_000,
      scope: 'code-memory-link-c-a-g-external-agent-experiment',
    },
    reason: 'pinned-codex-0.144.5-agent-turn-exceeded-192000-tokens-without-a-file-action',
    releaseTag: 'v4.6.0',
    type: 'code-memory-link-release-experiment-deferment',
    version: 1,
  };
}

function changes(): readonly CodeMemoryLinkReleaseDefermentGovernanceChange[] {
  return [
    {mode: '100644', path: '.github/workflows/publish.yml', status: 'M'},
    {mode: '100644', path: WAIVER_PATH, status: 'A'},
    {mode: '100644', path: 'scripts/verify-code-memory-link-release-deferment.ts', status: 'A'},
    {mode: '100644', path: 'apps/threadnote/test/unit/code-memory-link-release-deferment.test.ts', status: 'A'},
  ];
}
