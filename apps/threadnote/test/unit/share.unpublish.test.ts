import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {existsSync} from '@threadnote/testing/node-fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {afterEach, beforeEach, vi} from 'vitest';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {runShareUnpublish as runShareUnpublishEffect} from '@threadnote/threadnote/effect/share';
import {readMemoryWithRelocations} from '@threadnote/memory/relocation';
import {setMemoryVisibility, shareUnpublishTargetDisposition} from '@threadnote/threadnote/share/index';
import type {CommandResult} from '@threadnote/platform/command';
import type {ShareRuntime} from '@threadnote/threadnote/types';
import * as utils from '@threadnote/threadnote/utils';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

vi.mock('@threadnote/threadnote/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/utils')>();
  return {
    ...actual,
    requiredExecutable: vi.fn().mockReturnValue(Effect.succeed('git')),
    runCommand: vi.fn(),
  };
});

const SOURCE_URI = 'threadnote://user/test-user/memories/shared/default/durable/projects/foo/bar.md';
const TARGET_URI = 'threadnote://user/test-user/memories/durable/projects/foo/bar.md';
const RELATIVE_PATH = 'durable/projects/foo/bar.md';
const SHARED_CONTENT =
  'MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: foo\ntopic: bar\nmemory_id: tn_share_unpublish\n\nShared body\n';
const PERSONAL_CONTENT = setMemoryVisibility(SHARED_CONTENT, 'personal');

interface UnpublishFixture {
  readonly config: ShareRuntime;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly worktree: string;
  readonly worktreePath: string;
}

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stderr: '', stdout});

function canonicalResourceFile(home: string, uri: string): string {
  return join(
    home,
    'data',
    'local',
    ...Effect2.pipe(uri, __effectPipeInput => {
      const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.slice('threadnote://'.length));
      const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.split('/'));
      return __effectPipeStage1;
    }),
  );
}

async function writeCanonicalResource(home: string, uri: string, content: string): Promise<void> {
  const file = canonicalResourceFile(home, uri);
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, content, 'utf8');
}

async function makeFixture(): Promise<UnpublishFixture> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-share-unpublish-'));
  const worktree = join(home, 'share', 'worktrees', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  const worktreePath = join(worktree, ...Effect2.pipe(RELATIVE_PATH, EffectString.split('/')));
  await mkdir(dirname(worktreePath), {recursive: true});
  await writeFile(worktreePath, SHARED_CONTENT, 'utf8');
  await writeCanonicalResource(home, SOURCE_URI, SHARED_CONTENT);
  await mkdir(join(home, 'share'), {recursive: true});
  await writeFile(
    join(home, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-08-08T00:00:00.000Z',
            gitdir,
            name: 'default',
            remote: 'git@example.com:team/memories.git',
            worktree,
          },
        },
        version: 1,
      },
      undefined,
      2,
    )}\n`,
    'utf8',
  );
  return {
    config: {account: 'local', agentContextHome: home, agentId: 'threadnote', user: 'test-user'},
    sourcePath: canonicalResourceFile(home, SOURCE_URI),
    targetPath: canonicalResourceFile(home, TARGET_URI),
    worktree,
    worktreePath,
  };
}

function mockGit(
  fixture: UnpublishFixture,
  options: {readonly indexedContent?: string; readonly tracked?: boolean} = {},
): void {
  let tracked = options.tracked !== false;
  vi.mocked(utils.runCommand).mockImplementation((_executable, args) => {
    if (args.includes('ls-files') && args.includes('-u')) return Effect.succeed(ok());
    if (args.includes('ls-files')) return Effect.succeed(ok(tracked ? `${RELATIVE_PATH}\n` : ''));
    if (args.includes('show')) return Effect.succeed(ok(options.indexedContent ?? SHARED_CONTENT));
    if (args.includes('rm')) {
      return Effect.promise(async () => {
        await rm(fixture.worktreePath, {force: true});
        tracked = false;
        return ok();
      });
    }
    if (args.includes('commit')) return Effect.succeed(ok('[main abc123] share'));
    if (args.includes('push')) return Effect.succeed(ok('pushed'));
    return Effect.succeed(ok());
  });
}

describe('runShareUnpublish preflight and resume', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(utils.runCommand).mockReset();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  fcProp(
    it,
    'classifies every destination from exact content identity',
    {expected: FC.string(), suffix: FC.string({minLength: 1})},
    ({expected, suffix}) => {
      expect(shareUnpublishTargetDisposition(undefined, expected)).toBe('create');
      expect(shareUnpublishTargetDisposition(expected, expected)).toBe('resume');
      expect(shareUnpublishTargetDisposition(`${expected}${suffix}`, expected)).toBe('conflict');
    },
    {fastCheck: {numRuns: 100}},
  );

  it('previews an absent destination as create after reading real state without mutation', async () => {
    const fixture = await makeFixture();
    homes.push(fixture.config.agentContextHome);
    mockGit(fixture);

    const preview = await runShareUnpublishEffect(fixture.config, SOURCE_URI, {dryRun: true, push: false}).pipe(
      captureConsole,
      runEffect,
    );

    expect(preview.output).toContain(`Would write native resource: ${TARGET_URI} --mode create`);
    expect(preview.output).toContain(`Would unpublish ${SOURCE_URI} -> ${TARGET_URI} --mode create`);
    expect(preview.output).not.toContain('<dry-run memory body>');
    expect(existsSync(fixture.sourcePath)).toBe(true);
    expect(existsSync(fixture.targetPath)).toBe(false);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(EffectArray.some(vi.mocked(utils.runCommand).mock.calls, ([, args]) => args.includes('rm'))).toBe(false);
  });

  it('refuses the same non-byte-identical collision in preview and apply before Git or canonical writes', async () => {
    const fixture = await makeFixture();
    homes.push(fixture.config.agentContextHome);
    await writeCanonicalResource(
      fixture.config.agentContextHome,
      TARGET_URI,
      Effect2.pipe(PERSONAL_CONTENT, EffectString.replaceAll('\n', '\r\n')),
    );
    mockGit(fixture);

    await expect(
      runEffect(runShareUnpublishEffect(fixture.config, SOURCE_URI, {dryRun: true, push: false})),
    ).rejects.toThrow(/personal memory already exists.*different content/);
    await expect(runEffect(runShareUnpublishEffect(fixture.config, SOURCE_URI, {push: false}))).rejects.toThrow(
      /personal memory already exists.*different content/,
    );

    expect(await readFile(fixture.sourcePath, 'utf8')).toBe(SHARED_CONTENT);
    expect(await readFile(fixture.targetPath, 'utf8')).toContain('\r\n');
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(EffectArray.some(vi.mocked(utils.runCommand).mock.calls, ([, args]) => args.includes('rm'))).toBe(false);
  });

  it('resumes from a byte-identical personal target and completes Git and canonical cleanup', async () => {
    const fixture = await makeFixture();
    homes.push(fixture.config.agentContextHome);
    await writeCanonicalResource(fixture.config.agentContextHome, TARGET_URI, PERSONAL_CONTENT);
    mockGit(fixture);

    const preview = await runShareUnpublishEffect(fixture.config, SOURCE_URI, {dryRun: true, push: false}).pipe(
      captureConsole,
      runEffect,
    );
    expect(preview.output).toContain(`Would resume unpublish with byte-identical personal memory: ${TARGET_URI}`);
    expect(preview.output).toContain(`Would unpublish ${SOURCE_URI} -> ${TARGET_URI} --mode resume`);
    expect(existsSync(fixture.sourcePath)).toBe(true);
    expect(existsSync(fixture.worktreePath)).toBe(true);

    const result = await runShareUnpublishEffect(fixture.config, SOURCE_URI, {push: false}).pipe(
      captureConsole,
      runEffect,
    );

    expect(result.output).toContain(`Resuming unpublish with byte-identical personal memory: ${TARGET_URI}`);
    expect(result.output).toContain(`Unpublished ${SOURCE_URI} -> ${TARGET_URI} --mode resume`);
    expect(existsSync(fixture.sourcePath)).toBe(false);
    expect(await readFile(fixture.targetPath, 'utf8')).toBe(PERSONAL_CONTENT);
    expect(await runEffect(readMemoryWithRelocations(fixture.config, SOURCE_URI))).toMatchObject({
      canonicalUri: TARGET_URI,
      requestedUri: SOURCE_URI,
    });
    expect(existsSync(fixture.worktreePath)).toBe(false);
    expect(vi.mocked(utils.runCommand).mock.calls).toContainEqual([
      'git',
      ['-C', fixture.worktree, 'rm', '--ignore-unmatch', '--', RELATIVE_PATH],
      {allowFailure: true},
    ]);
  });

  it('finishes canonical cleanup when a prior attempt already removed the Git path', async () => {
    const fixture = await makeFixture();
    homes.push(fixture.config.agentContextHome);
    await writeCanonicalResource(fixture.config.agentContextHome, TARGET_URI, PERSONAL_CONTENT);
    await rm(fixture.worktreePath);
    mockGit(fixture, {tracked: false});

    const result = await runShareUnpublishEffect(fixture.config, SOURCE_URI, {push: false}).pipe(
      captureConsole,
      runEffect,
    );

    expect(result.output).toContain(`Shared Git path is already removed; continuing cleanup: ${RELATIVE_PATH}`);
    expect(existsSync(fixture.sourcePath)).toBe(false);
    expect(await readFile(fixture.targetPath, 'utf8')).toBe(PERSONAL_CONTENT);
    expect(
      EffectArray.some(vi.mocked(utils.runCommand).mock.calls, ([, args]) => args.includes('--ignore-unmatch')),
    ).toBe(true);
  });

  it('refuses a canonical/worktree mismatch before creating the personal destination', async () => {
    const fixture = await makeFixture();
    homes.push(fixture.config.agentContextHome);
    await writeFile(fixture.worktreePath, `${SHARED_CONTENT}newer worktree edit\n`, 'utf8');
    mockGit(fixture);

    await expect(
      runEffect(runShareUnpublishEffect(fixture.config, SOURCE_URI, {dryRun: true, push: false})),
    ).rejects.toThrow(/canonical source does not match worktree file/);

    expect(existsSync(fixture.sourcePath)).toBe(true);
    expect(existsSync(fixture.targetPath)).toBe(false);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(EffectArray.some(vi.mocked(utils.runCommand).mock.calls, ([, args]) => args.includes('rm'))).toBe(false);
  });

  it('refuses tracked Git content that differs from the shared canonical source', async () => {
    const fixture = await makeFixture();
    homes.push(fixture.config.agentContextHome);
    mockGit(fixture, {indexedContent: `${SHARED_CONTENT}stale index content\n`});

    await expect(
      runEffect(runShareUnpublishEffect(fixture.config, SOURCE_URI, {dryRun: true, push: false})),
    ).rejects.toThrow(/canonical source does not match tracked Git content/);

    expect(existsSync(fixture.sourcePath)).toBe(true);
    expect(existsSync(fixture.targetPath)).toBe(false);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(EffectArray.some(vi.mocked(utils.runCommand).mock.calls, ([, args]) => args.includes('rm'))).toBe(false);
  });
});
