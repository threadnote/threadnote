import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {execFile} from '@threadnote/testing/node-child-process';
import {readFile, readdir, rm} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {afterEach, describe} from 'vitest';
import {
  CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES,
  CODE_GRAPH_WORKSET_FIXTURE_SIZES,
  CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES,
  codeGraphWorksetFixturePathExists,
  createCodeGraphWorksetFixturePlan,
  establishCodeGraphWorksetStaleReadySnapshot,
  prepareCodeGraphWorksetFixture,
  readCodeGraphWorksetFixtureFile,
  type CodeGraphWorksetFixtureState,
  type MaterializedCodeGraphWorksetFixtureRepository,
} from '../../../../scripts/support/code-graph-workset-fixture.js';
import {parseSeedManifest} from '@threadnote/workspace/manifest';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const codeGraphWorksetMetadataSchema = Schema.StructWithRest(
  Schema.Struct({
    identity: Schema.StructWithRest(Schema.Struct({id: Schema.String}), [Schema.Record(Schema.String, Schema.Unknown)]),
    members: Schema.Array(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(EffectArray.map(temporaryRoots.splice(0), root => rm(root, {force: true, recursive: true})));
});

describe('deterministic code graph workset fixtures', () => {
  it('plans every required workset size from bounded in-code archetypes', () => {
    for (const size of CODE_GRAPH_WORKSET_FIXTURE_SIZES) {
      const plan = createCodeGraphWorksetFixturePlan(size);

      expect(plan.repositories).toHaveLength(size);
      expect(plan.members).toHaveLength(size);
      expect(new Set(EffectArray.map(plan.repositories, repository => repository.repositoryKey)).size).toBe(size);
      expect(plan.identity.repositoryCount).toBe(size);
      expect(plan.identity.id).toMatch(/^cgwf_[a-f0-9]{32}$/u);
      expect(EffectArray.map(plan.worksets, workset => workset.size)).toEqual(
        EffectArray.filter(CODE_GRAPH_WORKSET_FIXTURE_SUPPORTED_SIZES, candidate => candidate <= size),
      );
      expect(plan.worksets.at(-1)?.repositoryKeys).toEqual(
        EffectArray.map(plan.repositories, repository => repository.repositoryKey),
      );
    }

    const full = createCodeGraphWorksetFixturePlan(128);
    const archetypeIds = new Set(EffectArray.map(full.repositories, repository => repository.archetype));
    expect(archetypeIds.size).toBeLessThanOrEqual(CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES.length);
    expect(
      EffectArray.every(CODE_GRAPH_WORKSET_FIXTURE_ARCHETYPES, archetype => /^[a-f0-9]{64}$/u.test(archetype.sha256)),
    ).toBe(true);
    expect(createCodeGraphWorksetFixturePlan(50).workset.name).toBe('code-graph-workset-50');
    expect(EffectArray.map(full.worksets, workset => workset.size)).toContain(50);
    for (const size of [1, 8] as const) {
      expect(EffectArray.map(createCodeGraphWorksetFixturePlan(size).queries, query => query.id)).toEqual(
        EffectArray.map(
          EffectArrayPipe(full.queries, __effectArrayValues =>
            EffectArray.filter(
              __effectArrayValues,
              (query, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && query.sizes.includes(size),
            ),
          ),
          query => query.id,
        ),
      );
    }
  });

  it('includes authoritative contracts, consumers, distractors, and an unanswerable query', () => {
    const plan = createCodeGraphWorksetFixturePlan(8);
    const content = EffectArray.join(
      EffectArray.flatMap(plan.repositories, repository => EffectArray.map(repository.files, file => file.content)),
      '\n',
    );

    expect(content).toContain('resolveTenantSession');
    expect(content).toContain('@threadnote-fixture/session-contract');
    expect(content).toContain('workspaces');
    expect(content).toContain('TenantSessionByTenant');
    expect(content).toContain('threadnote.session.v1.SessionDirectory');
    expect(content).toContain('/v1/tenant-sessions/{tenantId}');
    expect(content).toContain('tenant.session.changed');
    expect(
      EffectArray.filter(plan.repositories, repository => repository.archetype === 'same-name-distractor'),
    ).toHaveLength(1);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(plan.queries, query => query.category === 'no-answer')),
    ).toMatchObject({
      relevantRepositoryKeys: [],
      text: 'quantumMarzipanLeaseCoordinator',
    });
  });

  it('keeps the 50-repository latency gate queryable without adding it to the default correctness matrix', () => {
    const plan = createCodeGraphWorksetFixturePlan(50);

    expect(CODE_GRAPH_WORKSET_FIXTURE_SIZES).not.toContain(50);
    expect(plan.worksets.at(-1)).toMatchObject({size: 50});
    expect(plan.queries.length).toBeGreaterThan(0);
    expect(EffectArray.every(plan.queries, query => query.sizes.includes(50))).toBe(true);
  });

  it('places relevant scale queries beyond the current manifest-prefix admission cap', () => {
    const plan = createCodeGraphWorksetFixturePlan(128);

    for (const size of [32, 50, 64, 128] as const) {
      const repositorySuffix = `Repo${Effect.pipe(String(size - 1), EffectString.padStart(3, '0'))}`;
      const query = EffectOption.getOrUndefined(
        EffectArray.findFirst(plan.queries, candidate => candidate.id === `tail-repository-marker-${size}`),
      );
      expect(query).toMatchObject({
        expectedRepositories: [`repo-${Effect.pipe(String(size - 1), EffectString.padStart(3, '0'))}`],
        expectedSymbols: [
          {
            repositoryId: `repo-${Effect.pipe(String(size - 1), EffectString.padStart(3, '0'))}`,
            symbol: `src/health.ts#repositoryHealthMarker${repositorySuffix}`,
          },
        ],
      });
      expect(query?.sizes).toContain(size);
      expect(
        Number(
          Effect.pipe(query?.expectedRepositories[0], effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect.pipe(effectOptionalString, EffectString.slice('repo-'.length)),
          ),
        ),
      ).toBeGreaterThanOrEqual(8);
      expect(
        EffectOption.getOrUndefined(
          EffectOption.flatMap(
            EffectOption.fromNullishOr(plan.repositories[size - 1]?.files),
            __effectOptionalArrayReceiver =>
              EffectArray.findFirst(__effectOptionalArrayReceiver, file => file.path === 'src/health.ts'),
          ),
        )?.content,
      ).toContain(
        `/** Deterministic repository marker repo-${Effect.pipe(String(size - 1), EffectString.padStart(3, '0'))}:ready. */`,
      );
    }
  });

  fcProp(
    it,
    'keeps identity and members stable when state override insertion order changes',
    {offset: FC.integer({max: 5, min: 0}), reverse: FC.boolean()},
    ({offset, reverse}) => {
      const entries = [
        ['repo-000', 'clean'],
        ['repo-001', 'dirty'],
        ['repo-002', 'stale'],
        ['repo-003', 'missing'],
        ['repo-004', 'failed'],
        ['repo-005', 'worktree'],
        ['repo-006', 'cold'],
      ] as const satisfies readonly (readonly [string, CodeGraphWorksetFixtureState])[];
      const reordered = [...entries.slice(offset), ...entries.slice(0, offset)];
      if (reverse) {
        reordered.reverse();
      }
      const baseline = createCodeGraphWorksetFixturePlan(8, {repositoryStates: EffectRecord.fromEntries(entries)});
      const candidate = createCodeGraphWorksetFixturePlan(8, {repositoryStates: EffectRecord.fromEntries(reordered)});

      expect(candidate.identity).toEqual(baseline.identity);
      expect(candidate.members).toEqual(baseline.members);
      expect(candidate.repositories).toEqual(baseline.repositories);
    },
    {fastCheck: {numRuns: 60}},
  );

  it('materializes clean Git repositories and a resolvable prefix-workset manifest', async () => {
    const fixture = await prepareCodeGraphWorksetFixture({concurrency: 4, size: 8});
    temporaryRoots.push(fixture.root);

    const repositoryDirectories = await readdir(fixture.repositoriesRoot);
    expect(repositoryDirectories.sort()).toEqual(
      Array.from({length: 8}, (_, index) => `repo-${Effect.pipe(String(index), EffectString.padStart(3, '0'))}`),
    );
    const manifest = parseSeedManifest(await readFile(fixture.manifestPath, 'utf8'), fixture.manifestPath);
    expect(manifest.projects).toHaveLength(8);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(manifest.worksets), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, workset => ({name: workset.name, size: workset.projects.length})),
        ),
      ),
    ).toEqual([
      {name: 'code-graph-workset-1', size: 1},
      {name: 'code-graph-workset-8', size: 8},
    ]);
    expect(manifest.worksets?.[1]?.projects).toEqual(EffectArray.map(manifest.projects, project => project.name));
    expect(
      await readCodeGraphWorksetFixtureFile(fixture, 'repo-001', 'packages/session-client/package.json'),
    ).toContain('@threadnote-fixture/session-contract');
    for (const repository of fixture.repositories) {
      expect(repository.headCommit).toMatch(/^[a-f0-9]{40}$/u);
      expect(await git(repository.path, ['status', '--porcelain'])).toBe('');
    }
    const metadata = Schema.decodeUnknownSync(codeGraphWorksetMetadataSchema)(
      JSON.parse(await readFile(fixture.metadataPath, 'utf8')),
    );
    expect(metadata.identity.id).toBe(fixture.identity.id);
    expect(metadata.members).toHaveLength(8);
  });

  it('produces path-independent fixture identities and deterministic Git commits', async () => {
    const first = await prepareCodeGraphWorksetFixture({size: 1});
    const second = await prepareCodeGraphWorksetFixture({size: 1});
    temporaryRoots.push(first.root, second.root);

    expect(first.identity).toEqual(second.identity);
    expect(first.repositories[0]?.contentDigest).toBe(second.repositories[0]?.contentDigest);
    expect(first.repositories[0]?.headCommit).toBe(second.repositories[0]?.headCommit);
    expect(await readFile(first.metadataPath, 'utf8')).toBe(await readFile(second.metadataPath, 'utf8'));
  });

  it('materializes clean, cold, dirty, stale, missing, failed, and sibling-worktree controls', async () => {
    const fixture = await prepareCodeGraphWorksetFixture({concurrency: 4, size: 8, stateProfile: 'mixed'});
    temporaryRoots.push(fixture.root);
    const byState = new Map(EffectArray.map(fixture.repositories, repository => [repository.state, repository]));

    expect(new Set(EffectArray.map(fixture.repositories, repository => repository.state))).toEqual(
      new Set(['clean', 'cold', 'dirty', 'stale', 'missing', 'failed', 'worktree']),
    );
    const clean = required(byState, 'clean');
    const cold = required(byState, 'cold');
    const dirty = required(byState, 'dirty');
    const stale = required(byState, 'stale');
    const missing = required(byState, 'missing');
    const failed = required(byState, 'failed');
    const worktree = required(byState, 'worktree');

    expect(await git(clean.path, ['status', '--porcelain'])).toBe('');
    expect(await git(cold.path, ['status', '--porcelain'])).toBe('');
    expect(await codeGraphWorksetFixturePathExists(join(cold.path, '.git'))).toBe(true);
    expect(await git(dirty.path, ['status', '--porcelain'])).toContain('README.md');
    expect(stale.readyCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(stale.headCommit).not.toBe(stale.readyCommit);
    await establishCodeGraphWorksetStaleReadySnapshot(stale, async repositoryPath => {
      expect(await git(repositoryPath, ['rev-parse', 'HEAD'])).toBe(stale.readyCommit);
    });
    expect(await git(stale.path, ['rev-parse', 'HEAD'])).toBe(stale.headCommit);
    expect(await codeGraphWorksetFixturePathExists(missing.path)).toBe(false);
    expect(await codeGraphWorksetFixturePathExists(failed.path)).toBe(true);
    expect(await codeGraphWorksetFixturePathExists(join(failed.path, '.git'))).toBe(false);
    expect(await git(worktree.path, ['status', '--porcelain'])).toBe('');
    expect(worktree.siblingWorktreePath).toBeDefined();
    const siblingWorktreePath = worktree.siblingWorktreePath;
    if (siblingWorktreePath === undefined) throw TestError.make({message: 'Missing sibling worktree path.'});
    expect(await git(siblingWorktreePath, ['status', '--porcelain'])).toContain('src/worktree-only.ts');
  });
});

function required(
  repositories: ReadonlyMap<CodeGraphWorksetFixtureState, MaterializedCodeGraphWorksetFixtureRepository>,
  state: CodeGraphWorksetFixtureState,
): MaterializedCodeGraphWorksetFixtureRepository {
  const repository = repositories.get(state);
  if (!repository) {
    throw TestError.make({message: `Missing ${state} fixture repository.`});
  }
  return repository;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
  return Effect.pipe(result.stdout, EffectString.trim);
}
