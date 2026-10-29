import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from 'node:util';
import * as FC from 'fast-check';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, it} from 'vitest';
import {
  canonicalProcedureManifest,
  canonicalProcedureVerificationReceipt,
  createProcedureVerificationReceipt,
  parseProcedureManifest,
} from '@threadnote/context/procedure/contract';
import {publishVerifiedProcedure} from '@threadnote/threadnote/procedure/publication';
import {loadPublishedProcedureCandidates} from '@threadnote/threadnote/procedure/repository';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const execute = promisify(execFile);
const standalone = join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(EffectArray.map(roots.splice(0), root => rm(root, {force: true, recursive: true})));
});

describe('verified procedure Git publication', () => {
  it('exposes the same read-only publication proposal through the CLI', async () => {
    const fixture = await makeFixture();
    const output = await execute(
      process.execPath,
      [
        standalone,
        'procedure',
        'publish',
        fixture.options.manifest,
        '--artifact',
        fixture.options.artifact,
        '--receipt',
        fixture.options.receipt,
      ],
      {
        cwd: fixture.worktree,
        env: {
          ...process.env,
          NO_COLOR: '1',
          THREADNOTE_HOME: fixture.config.agentContextHome,
          THREADNOTE_MCP_CLIENT: 'codex',
          THREADNOTE_USER: fixture.config.user,
        },
      },
    );
    expect(JSON.parse(output.stdout)).toMatchObject({mode: 'preview', team: 'default', version: 1});
    expect(await git(fixture.worktree, ['status', '--porcelain'])).toBe('');
  });

  effectIt.effect('previews without mutation, applies exact CAS files, and preserves unrelated files', () =>
    procedureFixture(fixture =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const before = yield* gitEffect(fixture.worktree, ['status', '--porcelain']);
        const preview = yield* publishVerifiedProcedure(fixture.config, fixture.options);

        expect(preview.mode).toBe('preview');
        expect(preview.repository).toMatchObject({
          branchRef: expect.stringMatching(/^refs\/heads\//u),
          targets: EffectArray.map(preview.paths, path => ({path, state: 'absent'})),
        });
        expect(yield* publishVerifiedProcedure(fixture.config, fixture.options)).toEqual(preview);
        const pushPreview = yield* publishVerifiedProcedure(fixture.config, {...fixture.options, push: true});
        expect(pushPreview.push).toBe(true);
        expect(pushPreview.proposalId).not.toBe(preview.proposalId);
        expect(yield* gitEffect(fixture.worktree, ['status', '--porcelain'])).toBe(before);
        expect(yield* fs.exists(join(fixture.worktree, preview.paths[0]))).toBe(false);

        const applied = yield* publishVerifiedProcedure(fixture.config, {
          ...fixture.options,
          apply: true,
          approved: true,
          proposalId: preview.proposalId,
        });
        expect(applied).toMatchObject({mode: 'apply', proposalId: preview.proposalId});
        expect(yield* fs.readFileString(join(fixture.worktree, 'unrelated.txt'))).toBe('keep me');
        expect(yield* fs.readFileString(join(fixture.worktree, applied.paths[2]))).toBe(fixture.artifactContent);
        expect(yield* loadPublishedProcedureCandidates(fixture.config)).toEqual({
          candidates: [expect.objectContaining({artifactSha256: applied.artifact.sha256, team: 'default'})],
          gaps: [],
        });
        const committed = yield* gitEffect(fixture.worktree, ['rev-parse', 'HEAD']);
        const retried = yield* publishVerifiedProcedure(fixture.config, {
          ...fixture.options,
          apply: true,
          approved: true,
          proposalId: preview.proposalId,
        });
        expect(retried).toEqual(applied);
        expect(yield* gitEffect(fixture.worktree, ['rev-parse', 'HEAD'])).toBe(committed);
        expect(yield* gitEffect(fixture.worktree, ['status', '--porcelain'])).toBe('');
      }),
    ),
  );

  effectIt.effect('fails closed on a stable-path conflict before changing sibling or unrelated files', () =>
    procedureFixture(fixture =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const preview = yield* publishVerifiedProcedure(fixture.config, fixture.options);
        const target = join(fixture.worktree, preview.paths[0]);
        yield* fs.makeDirectory(join(target, '..'), {recursive: true});
        yield* fs.writeFileString(target, 'conflicting manifest');

        const error = yield* Effect.flip(
          publishVerifiedProcedure(fixture.config, {
            ...fixture.options,
            apply: true,
            approved: true,
            proposalId: preview.proposalId,
          }),
        );
        expect(error).toMatchObject({
          message: expect.stringContaining('Refusing to overwrite changed shared worktree file'),
        });
        expect(yield* fs.readFileString(target)).toBe('conflicting manifest');
        expect(yield* fs.readFileString(join(fixture.worktree, 'unrelated.txt'))).toBe('keep me');
        expect(yield* fs.exists(join(fixture.worktree, preview.paths[1]))).toBe(false);
      }),
    ),
  );

  effectIt.effect('commits only procedure paths while preserving unrelated staged entries byte-for-byte', () =>
    procedureFixture(fixture =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(join(fixture.worktree, 'unrelated.txt'), 'staged tracked change\n');
        yield* fs.writeFileString(join(fixture.worktree, 'new-staged.txt'), 'staged new file\n');
        yield* gitEffect(fixture.worktree, ['add', 'unrelated.txt', 'new-staged.txt']);
        const cachedBefore = yield* gitEffect(fixture.worktree, ['diff', '--cached', '--binary']);
        const unrelatedBlobBefore = yield* gitEffect(fixture.worktree, ['rev-parse', ':unrelated.txt']);
        const newBlobBefore = yield* gitEffect(fixture.worktree, ['rev-parse', ':new-staged.txt']);
        const preview = yield* publishVerifiedProcedure(fixture.config, fixture.options);

        yield* publishVerifiedProcedure(fixture.config, {
          ...fixture.options,
          apply: true,
          approved: true,
          proposalId: preview.proposalId,
        });

        expect(
          Effect2.pipe(
            yield* gitEffect(fixture.worktree, ['show', '--format=', '--name-only', 'HEAD']),
            EffectString.split('\n'),
          ).sort(),
        ).toEqual([...preview.paths].sort());
        expect(yield* gitEffect(fixture.worktree, ['diff', '--cached', '--binary'])).toBe(cachedBefore);
        expect(yield* gitEffect(fixture.worktree, ['rev-parse', ':unrelated.txt'])).toBe(unrelatedBlobBefore);
        expect(yield* gitEffect(fixture.worktree, ['rev-parse', ':new-staged.txt'])).toBe(newBlobBefore);
        expect(yield* fs.readFileString(join(fixture.worktree, 'unrelated.txt'))).toBe('staged tracked change\n');
        expect(yield* fs.readFileString(join(fixture.worktree, 'new-staged.txt'))).toBe('staged new file\n');
      }),
    ),
  );

  effectIt.effect('rejects an unrelated branch advance after preview before writing procedure files', () =>
    procedureFixture(fixture =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const preview = yield* publishVerifiedProcedure(fixture.config, fixture.options);
        yield* fs.writeFileString(join(fixture.worktree, 'advance.txt'), 'new base\n');
        yield* gitEffect(fixture.worktree, ['add', 'advance.txt']);
        yield* gitEffect(fixture.worktree, ['commit', '-m', 'advance base']);

        const error = yield* Effect.flip(
          publishVerifiedProcedure(fixture.config, {
            ...fixture.options,
            apply: true,
            approved: true,
            proposalId: preview.proposalId,
          }),
        );
        expect(error).toMatchObject({message: expect.stringContaining('base changed after preview')});
        expect(yield* fs.exists(join(fixture.worktree, preview.paths[0]))).toBe(false);
      }),
    ),
  );

  effectIt.effect('leaves targets untouched when the branch compare-and-swap cannot acquire its ref lock', () =>
    procedureFixture(fixture =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const preview = yield* publishVerifiedProcedure(fixture.config, fixture.options);
        const refLock = join(fixture.worktree, '.git', `${preview.repository.branchRef}.lock`);
        yield* fs.makeDirectory(join(refLock, '..'), {recursive: true});
        yield* fs.writeFileString(refLock, 'external ref transaction\n');

        yield* Effect.flip(
          publishVerifiedProcedure(fixture.config, {
            ...fixture.options,
            apply: true,
            approved: true,
            proposalId: preview.proposalId,
          }),
        );
        for (const relativePath of preview.paths) {
          expect(yield* fs.exists(join(fixture.worktree, relativePath))).toBe(false);
        }
      }),
    ),
  );

  effectIt.effect('pushes an exact existing publication when a fresh proposal requests remote publication', () =>
    procedureFixture(fixture =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const remote = join(fixture.root, 'remote.git');
        yield* fs.makeDirectory(remote, {recursive: true});
        yield* gitEffect(remote, ['init', '--bare']);
        yield* gitEffect(fixture.worktree, ['remote', 'add', 'origin', remote]);
        const initial = yield* gitEffect(fixture.worktree, ['rev-parse', 'HEAD']);
        const branchRef = yield* gitEffect(fixture.worktree, ['symbolic-ref', 'HEAD']);
        yield* gitEffect(fixture.worktree, ['push', 'origin', `${initial}:${branchRef}`]);

        const localPreview = yield* publishVerifiedProcedure(fixture.config, fixture.options);
        yield* publishVerifiedProcedure(fixture.config, {
          ...fixture.options,
          apply: true,
          approved: true,
          proposalId: localPreview.proposalId,
        });
        const publishedCommit = yield* gitEffect(fixture.worktree, ['rev-parse', 'HEAD']);
        expect(yield* gitEffect(remote, ['rev-parse', branchRef])).toBe(initial);

        const pushPreview = yield* publishVerifiedProcedure(fixture.config, {...fixture.options, push: true});
        yield* publishVerifiedProcedure(fixture.config, {
          ...fixture.options,
          apply: true,
          approved: true,
          proposalId: pushPreview.proposalId,
          push: true,
        });

        expect(yield* gitEffect(remote, ['rev-parse', branchRef])).toBe(publishedCommit);
      }),
    ),
  );

  effectIt.effect('rejects non-text procedure inputs with a specific bounded diagnostic', () =>
    procedureFixture(fixture =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFile(fixture.options.artifact, Uint8Array.from([0xff, 0xfe]));
        const invalidUtf8 = yield* Effect.flip(publishVerifiedProcedure(fixture.config, fixture.options));
        expect(invalidUtf8).toMatchObject({message: 'Procedure input must be strict UTF-8 text.'});
        yield* fs.writeFileString(fixture.options.artifact, 'reviewed\u0000workflow\n');
        const nul = yield* Effect.flip(publishVerifiedProcedure(fixture.config, fixture.options));
        expect(nul).toMatchObject({message: 'Procedure input must be exact, NUL-free UTF-8 text.'});
        const linkedArtifact = join(fixture.root, 'artifact-link.txt');
        yield* fs.writeFileString(fixture.options.artifact, fixture.artifactContent);
        yield* fs.symlink(fixture.options.artifact, linkedArtifact);
        const linked = yield* Effect.flip(
          publishVerifiedProcedure(fixture.config, {...fixture.options, artifact: linkedArtifact}),
        );
        expect(linked).toMatchObject({message: 'Procedure input must not be a symbolic link.'});
      }),
    ),
  );

  fcEffectProp(
    effectIt,
    'preserves arbitrary unrelated worktree content while committing only procedure paths',
    {unrelatedContent: FC.string({maxLength: 128})},
    ({unrelatedContent}) =>
      procedureFixture(fixture =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const unrelated = join(fixture.worktree, 'unrelated.txt');
          yield* fs.writeFileString(unrelated, unrelatedContent);
          const preview = yield* publishVerifiedProcedure(fixture.config, fixture.options);
          yield* publishVerifiedProcedure(fixture.config, {
            ...fixture.options,
            apply: true,
            approved: true,
            proposalId: preview.proposalId,
          });
          expect(yield* fs.readFileString(unrelated)).toBe(unrelatedContent);
          expect(yield* gitEffect(fixture.worktree, ['diff', '--name-only'])).toBe(
            unrelatedContent === 'keep me' ? '' : 'unrelated.txt',
          );
        }),
      ),
    {fastCheck: {numRuns: 6}},
  );
});

type ProcedureFixture = Awaited<ReturnType<typeof makeFixture>>;

function procedureFixture<A, E, R>(use: (fixture: ProcedureFixture) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(() => makeFixture(false)),
    use,
    fixture => Effect.promise(() => rm(fixture.root, {force: true, recursive: true})),
  ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);
}

function gitEffect(cwd: string, args: readonly string[]) {
  return Effect.promise(() => git(cwd, args));
}

async function makeFixture(trackForAfterEach = true) {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-procedure-publish-'));
  if (trackForAfterEach) roots.push(root);
  const home = join(root, 'home');
  const worktree = join(root, 'shared');
  await mkdir(join(home, 'share'), {recursive: true});
  await mkdir(worktree, {recursive: true});
  await git(worktree, ['init']);
  await git(worktree, ['config', 'user.email', 'test@example.invalid']);
  await git(worktree, ['config', 'user.name', 'Threadnote Test']);
  await writeFile(join(worktree, 'unrelated.txt'), 'keep me');
  await git(worktree, ['add', 'unrelated.txt']);
  await git(worktree, ['commit', '-m', 'initial']);
  await writeFile(
    join(home, 'share', 'teams.json'),
    JSON.stringify({
      defaultTeam: 'default',
      teams: {
        default: {
          access: 'read-write',
          addedAt: '2026-09-17T00:00:00.000Z',
          gitdir: join(root, 'unused.gitdir'),
          name: 'default',
          remote: 'https://example.invalid/shared.git',
          worktree,
        },
      },
      version: 1,
    }),
  );
  const artifactContent = 'reviewed workflow\n';
  const manifest = parseProcedureManifest({
    artifact: {id: 'team/deploy', semanticVersion: '1.0.0', sha256: sha256HexSync(artifactContent)},
    compatible: {capabilities: ['mcp'], surfaceIds: ['codex']},
    dependencies: [],
    owner: 'platform-team',
    presentation: {summary: 'Deploy the service using the reviewed workflow.', taskKeywords: ['deploy']},
    relatedDurableMemoryIds: [],
    reviewedOn: '2026-09-17',
    rollout: {channel: 'stable', percentage: 100},
    schemaVersion: 2,
    verification: {commands: [{argv: ['bun', 'test'], id: 'test'}], fixtures: []},
  });
  const receipt = createProcedureVerificationReceipt(manifest, {
    hostVersion: 'test-host',
    threadnoteVersion: '5.0.0',
    verifiedAt: '2026-09-17T12:00:00.000Z',
    verifier: 'test-verifier',
  });
  const manifestPath = join(root, 'procedure.json');
  const receiptPath = join(root, 'receipt.json');
  const artifactPath = join(root, 'artifact.txt');
  await writeFile(manifestPath, canonicalProcedureManifest(manifest));
  await writeFile(receiptPath, canonicalProcedureVerificationReceipt(receipt));
  await writeFile(artifactPath, artifactContent);
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'codex',
    manifestPath: join(root, 'threadnote.json'),
    user: 'test-user',
  };
  return {
    artifactContent,
    config,
    options: {artifact: artifactPath, manifest: manifestPath, push: false, receipt: receiptPath},
    root,
    worktree,
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return Effect2.pipe((await execute('git', ['-C', cwd, ...args])).stdout, EffectString.trim);
}
