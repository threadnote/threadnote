import {Array as EffectArray} from 'effect';
import {mkdtemp, mkdir, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {inheritedProcessEnvironment} from '@threadnote/testing/process-environment';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {ApplicationLayer, type ApplicationServices} from '@threadnote/threadnote/effect/runtime';
import * as fc from 'fast-check';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {shareAgentArtifact, shareBundlePack} from '@threadnote/threadnote/share/index';
import {
  installSharedAgentArtifacts as installSharedAgentArtifactsEffect,
  listSharedAgentArtifacts as listSharedAgentArtifactsEffect,
  runShareInstallArtifacts as runShareInstallArtifactsEffect,
} from '@threadnote/threadnote/effect/share';
import type {CommandResult} from '@threadnote/platform/command';
import type {ShareRuntime} from '@threadnote/threadnote/types';
import * as utils from '@threadnote/threadnote/utils';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

const runShareInstallArtifacts = (...args: Parameters<typeof runShareInstallArtifactsEffect>) =>
  runEffect(runShareInstallArtifactsEffect(...args));
const listSharedAgentArtifacts = (...args: Parameters<typeof listSharedAgentArtifactsEffect>) =>
  runEffect(listSharedAgentArtifactsEffect(...args));
const installSharedAgentArtifacts = (...args: Parameters<typeof installSharedAgentArtifactsEffect>) =>
  runEffect(installSharedAgentArtifactsEffect(...args));
const provideApplicationTestLayer = <A, E>(effect: Effect.Effect<A, E, ApplicationServices>) =>
  effect.pipe(provideTestLayer(ApplicationLayer));

vi.mock('@threadnote/threadnote/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/utils')>();
  return {
    ...actual,
    maybeRun: vi.fn(),
    requiredExecutable: vi.fn().mockReturnValue(Effect.succeed('git')),
    runCommand: vi.fn(),
    sleep: vi.fn().mockReturnValue(Effect.void),
  };
});

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stdout, stderr: ''});

async function makeRuntime(): Promise<ShareRuntime> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-share-artifacts-'));
  const worktree = join(home, 'shared', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(join(home, 'share'), {recursive: true});
  await mkdir(worktree, {recursive: true});
  await writeFile(
    join(home, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-06-10T00:00:00.000Z',
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
  );
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    user: 'test-user',
  };
}

function mockPublishCommands(): void {
  vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
    if (executable === 'git' && (args.includes('add') || args.includes('commit') || args.includes('push'))) {
      return Effect.succeed(ok('ok'));
    }
    return Effect.succeed(ok());
  });
  vi.mocked(utils.maybeRun).mockImplementation((dryRun, executable, args, options) =>
    dryRun ? succeedUndefined : vi.mocked(utils.runCommand)(executable, args, options),
  );
}

describe('shared agent artifacts', () => {
  const homes: string[] = [];
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.mocked(utils.runCommand).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    vi.restoreAllMocks();
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  async function blockNativeArtifactWrites(config: ShareRuntime): Promise<void> {
    const parent = join(config.agentContextHome, 'data', 'local', 'user', 'test-user', 'memories', 'shared', 'default');
    await mkdir(parent, {recursive: true});
    await writeFile(join(parent, 'agent-artifacts'), 'blocks canonical directory creation');
  }

  it('publishes a Codex skill into the shared artifact catalog and indexes it', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourcePath = join(config.agentContextHome, '.codex', 'skills', 'reviewer', 'SKILL.md');
    await mkdir(join(sourcePath, '..'), {recursive: true});
    await writeFile(sourcePath, '# Reviewer\n\nReview local diffs.\n');
    mockPublishCommands();

    const result = await runEffect(shareAgentArtifact(config, sourcePath, {}));

    expect(result.targetUri).toBe(
      'threadnote://user/test-user/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md',
    );
    expect(vi.mocked(utils.runCommand).mock.calls).toEqual(
      expect.arrayContaining([
        [
          'git',
          [
            '-C',
            join(config.agentContextHome, 'shared', 'default'),
            'add',
            '--',
            'agent-artifacts/skills/codex/reviewer/SKILL.md',
          ],
          {allowFailure: true},
        ],
      ]),
    );
    await expect(
      readFile(
        join(
          config.agentContextHome,
          'data',
          'local',
          'user',
          'test-user',
          'memories',
          'shared',
          'default',
          'agent-artifacts',
          'skills',
          'codex',
          'reviewer',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('Reviewer');
    await expect(
      readFile(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'skills',
          'codex',
          'reviewer',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).resolves.toContain('Reviewer');
  });

  effectIt.effect('publishes and installs a Cursor skill under the native Cursor skill root', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);
      const installHome = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), 'threadnote-cursor-artifact-install-home-')),
      );
      homes.push(installHome);
      inheritedProcessEnvironment().HOME = installHome;
      const sourcePath = join(config.agentContextHome, '.cursor', 'skills', 'reviewer', 'SKILL.md');
      yield* Effect.promise(() => mkdir(join(sourcePath, '..'), {recursive: true}));
      yield* Effect.promise(() => writeFile(sourcePath, '# Cursor Reviewer\n'));
      mockPublishCommands();

      const published = yield* provideApplicationTestLayer(shareAgentArtifact(config, sourcePath, {}));
      expect(published.artifact).toEqual({agent: 'cursor', kind: 'skill', name: 'reviewer'});
      expect(published.targetPath).toBe(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'skills',
          'cursor',
          'reviewer',
          'SKILL.md',
        ),
      );

      yield* provideApplicationTestLayer(
        installSharedAgentArtifactsEffect(config, {
          agent: 'cursor',
          apply: true,
          kind: 'skill',
          name: 'reviewer',
          sync: false,
        }),
      );
      const installed = yield* Effect.promise(() =>
        readFile(join(installHome, '.cursor', 'skills', 'threadnote', 'default', 'reviewer', 'SKILL.md'), 'utf8'),
      );
      expect(installed).toBe('# Cursor Reviewer\n');
    }),
  );

  effectIt.effect('keeps command artifacts Claude-only', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);
      const sourcePath = join(config.agentContextHome, 'review.md');
      yield* Effect.promise(() => writeFile(sourcePath, '# Review command\n'));

      for (const agent of ['codex', 'cursor'] as const) {
        const exit = yield* provideApplicationTestLayer(
          shareAgentArtifact(config, sourcePath, {agent, kind: 'command', name: 'review'}),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({message: 'Only Claude command artifacts are supported.'});
        }
      }
    }),
  );

  it('refuses to overwrite a different shared artifact unless forced', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourcePath = join(config.agentContextHome, '.claude', 'commands', 'review.md');
    const sharedPath = join(config.agentContextHome, 'shared', 'default', 'agent-artifacts', 'commands', 'claude');
    await mkdir(join(sourcePath, '..'), {recursive: true});
    await mkdir(sharedPath, {recursive: true});
    await writeFile(sourcePath, 'new command\n');
    await writeFile(join(sharedPath, 'review.md'), 'old command\n');
    mockPublishCommands();

    await expect(runEffect(shareAgentArtifact(config, sourcePath, {}))).rejects.toThrow(
      /already exists with different content/,
    );
    await expect(readFile(join(sharedPath, 'review.md'), 'utf8')).resolves.toBe('old command\n');
  });

  it('does not leave a shared artifact file behind when the native canonical write fails', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourcePath = join(config.agentContextHome, '.codex', 'skills', 'reviewer', 'SKILL.md');
    await mkdir(join(sourcePath, '..'), {recursive: true});
    await writeFile(sourcePath, '# Reviewer\n');
    await blockNativeArtifactWrites(config);

    await expect(runEffect(shareAgentArtifact(config, sourcePath, {}))).rejects.toThrow(
      /directory|path|exist|resource stat/i,
    );

    await expect(
      readFile(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'skills',
          'codex',
          'reviewer',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('installs shared artifacts into namespaced local agent paths only when applied', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-install-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'claude',
      'triage',
      'SKILL.md',
    );
    await mkdir(join(sharedSkill, '..'), {recursive: true});
    await writeFile(sharedSkill, '# Triage\n');

    await runShareInstallArtifacts(config, {apply: true, sync: false});

    await expect(
      readFile(join(installHome, '.claude', 'skills', 'threadnote', 'default', 'triage', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Triage\n');
  });

  it('lists shared artifacts with install status', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-list-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
      'SKILL.md',
    );
    await mkdir(join(sharedSkill, '..'), {recursive: true});
    await writeFile(sharedSkill, '# Reviewer\n');

    const result = await listSharedAgentArtifacts(config, {sync: false});

    expect(result.team).toBe('default');
    expect(result.artifacts).toMatchObject([
      {
        artifact: {agent: 'codex', kind: 'skill', name: 'reviewer'},
        installStatus: 'not_installed',
      },
    ]);
  });

  it('requires disambiguation when installing a shared artifact name with multiple matches', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-ambiguous-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const codexSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
      'SKILL.md',
    );
    const claudeSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'claude',
      'reviewer',
      'SKILL.md',
    );
    await mkdir(join(codexSkill, '..'), {recursive: true});
    await mkdir(join(claudeSkill, '..'), {recursive: true});
    await writeFile(codexSkill, '# Codex Reviewer\n');
    await writeFile(claudeSkill, '# Claude Reviewer\n');

    await expect(installSharedAgentArtifacts(config, {apply: true, name: 'reviewer', sync: false})).rejects.toThrow(
      /ambiguous/,
    );

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    await expect(
      readFile(join(installHome, '.codex', 'skills', 'threadnote', 'default', 'reviewer', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Codex Reviewer\n');
  });

  it('reports update available when the shared artifact changes after install', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-update-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
      'SKILL.md',
    );
    await mkdir(join(sharedSkill, '..'), {recursive: true});
    await writeFile(sharedSkill, '# Reviewer v1\n');

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });
    await writeFile(sharedSkill, '# Reviewer v2\n');

    const listed = await listSharedAgentArtifacts(config, {sync: false});

    expect(listed.artifacts).toMatchObject([
      {
        artifact: {agent: 'codex', kind: 'skill', name: 'reviewer'},
        installStatus: 'update_available',
      },
    ]);

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    await expect(
      readFile(join(installHome, '.codex', 'skills', 'threadnote', 'default', 'reviewer', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Reviewer v2\n');
  });

  it('protects local modifications when the shared artifact changes too', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-artifact-local-mod-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedSkill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
      'SKILL.md',
    );
    const installPath = join(installHome, '.codex', 'skills', 'threadnote', 'default', 'reviewer', 'SKILL.md');
    await mkdir(join(sharedSkill, '..'), {recursive: true});
    await writeFile(sharedSkill, '# Reviewer v1\n');

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });
    await writeFile(sharedSkill, '# Reviewer v2\n');
    await writeFile(installPath, '# Local edit\n');

    const listed = await listSharedAgentArtifacts(config, {sync: false});

    expect(listed.artifacts[0]?.installStatus).toBe('remote_changed_and_local_modified');
    await expect(
      installSharedAgentArtifacts(config, {
        agent: 'codex',
        apply: true,
        kind: 'skill',
        name: 'reviewer',
        sync: false,
      }),
    ).rejects.toThrow(/Refusing to overwrite/);

    await installSharedAgentArtifacts(config, {
      agent: 'codex',
      apply: true,
      force: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    await expect(readFile(installPath, 'utf8')).resolves.toBe('# Reviewer v2\n');
  });

  function findGitAddArgs(): readonly string[] | undefined {
    const call = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        vi.mocked(utils.runCommand).mock.calls,
        __effectArrayValue =>
          !!(([executable, args]) => executable === 'git' && args.includes('add'))(__effectArrayValue),
      ),
    );
    return call?.[1];
  }

  it('publishes a multi-file skill as a bundle with a manifest', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'scripts'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n\nRun scripts/run.ts.\n');
    await writeFile(join(skillDir, 'scripts', 'run.ts'), 'export const run = () => 1;\n');
    mockPublishCommands();

    const result = await runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}));

    expect(result.targetUri).toBe(
      'threadnote://user/test-user/memories/shared/default/agent-artifacts/skills/codex/reviewer/SKILL.md',
    );
    const sharedRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
    );
    await expect(readFile(join(sharedRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe(
      'export const run = () => 1;\n',
    );
    await expect(readFile(join(sharedRoot, 'SKILL.md'), 'utf8')).resolves.toContain('Reviewer');
    const manifest = JSON.parse(await readFile(join(sharedRoot, '.threadnote-bundle.json'), 'utf8'));
    expect(manifest.members.map((m: {path: string}) => m.path)).toEqual(['SKILL.md', 'scripts/run.ts']);
    const addArgs = findGitAddArgs();
    expect(addArgs).toContain('agent-artifacts/skills/codex/reviewer/SKILL.md');
    expect(addArgs).toContain('agent-artifacts/skills/codex/reviewer/scripts/run.ts');
    expect(addArgs).toContain('agent-artifacts/skills/codex/reviewer/.threadnote-bundle.json');
  });

  it('ignores runtime artifact dirs and local junk when bundling a skill', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'reviews', 'mobile', '1'), {recursive: true});
    await mkdir(join(skillDir, 'repos', 'coda'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    await writeFile(join(skillDir, 'run.ts'), 'export const run = () => 1;\n');
    await writeFile(join(skillDir, '.DS_Store'), 'junk');
    await writeFile(join(skillDir, 'debug.log'), 'noise');
    await writeFile(join(skillDir, 'reviews', 'mobile', '1', 'state.json'), '{}');
    await writeFile(join(skillDir, 'repos', 'coda', 'CLAUDE.md'), '# nope\n');
    mockPublishCommands();

    await runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}));

    const sharedRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
    );
    const manifest = JSON.parse(await readFile(join(sharedRoot, '.threadnote-bundle.json'), 'utf8'));
    expect(manifest.members.map((m: {path: string}) => m.path)).toEqual(['SKILL.md', 'run.ts']);
    await expect(readFile(join(sharedRoot, 'reviews', 'mobile', '1', 'state.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(sharedRoot, 'repos', 'coda', 'CLAUDE.md'), 'utf8')).rejects.toThrow();
  });

  it('blocks a binary skill member by default and includes it with allowBinary', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'assets'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x01, 0x02, 0xff]);
    await writeFile(join(skillDir, 'assets', 'logo.png'), png);
    mockPublishCommands();

    await expect(runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}))).rejects.toThrow(/binary file/);

    await runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {allowBinary: true}));
    const sharedRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
    );
    await expect(readFile(join(sharedRoot, 'assets', 'logo.png'))).resolves.toEqual(png);
  });

  it('blocks a credential embedded in a binary member even with allowBinary', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(skillDir, {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    const secretBlob = Buffer.concat([
      Buffer.from([0x00, 0x01]),
      Buffer.from(`sk-${Effect2.pipe('a', EffectString.repeat(24))}`),
    ]);
    await writeFile(join(skillDir, 'helper.bin'), secretBlob);
    mockPublishCommands();

    await expect(
      runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {allowBinary: true})),
    ).rejects.toThrow(/embedded in binary file/);
  });

  it('publishes a companion script with a credential-shaped token unchanged', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    const script = `const token = "ghp_${Effect2.pipe('b', EffectString.repeat(36))}";\n`;
    await mkdir(join(skillDir, 'scripts'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    await writeFile(join(skillDir, 'scripts', 'run.ts'), script);
    mockPublishCommands();

    await runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}));
    await expect(
      readFile(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'skills',
          'codex',
          'reviewer',
          'scripts',
          'run.ts',
        ),
        'utf8',
      ),
    ).resolves.toBe(script);
  });

  it('publishes skill markdown that mentions /tmp and JS escapes unchanged', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const sourcePath = join(config.agentContextHome, '.claude', 'skills', 'reviewer', 'SKILL.md');
    const body =
      '# Reviewer\n\nRun `bun scripts/digest-stats.ts > /tmp/digest-prompt.md`.\n\n' +
      "Normalize with `str.replace(/\\\\/g, '\\\\\\\\')`.\n";
    await mkdir(join(sourcePath, '..'), {recursive: true});
    await writeFile(sourcePath, body);
    mockPublishCommands();

    const result = await runEffect(shareAgentArtifact(config, sourcePath, {redact: true}));
    expect(EffectArray.join(result.messages, '\n')).toMatch(/--redact is ignored/);
    await expect(
      readFile(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'skills',
          'claude',
          'reviewer',
          'SKILL.md',
        ),
        'utf8',
      ),
    ).resolves.toBe(body);
  });

  it('does not materialize bundle companions when the native SKILL.md write fails', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const skillDir = join(config.agentContextHome, '.codex', 'skills', 'reviewer');
    await mkdir(join(skillDir, 'scripts'), {recursive: true});
    await writeFile(join(skillDir, 'SKILL.md'), '# Reviewer\n');
    await writeFile(join(skillDir, 'scripts', 'run.ts'), 'export const run = () => 1;\n');
    await blockNativeArtifactWrites(config);

    await expect(runEffect(shareAgentArtifact(config, join(skillDir, 'SKILL.md'), {}))).rejects.toThrow(
      /directory|path|exist|resource stat/i,
    );
    const sharedRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'codex',
      'reviewer',
    );
    await expect(readFile(join(sharedRoot, 'scripts', 'run.ts'), 'utf8')).rejects.toThrow();
  });

  async function seedSharedBundle(config: ShareRuntime): Promise<string> {
    const root = join(config.agentContextHome, 'shared', 'default', 'agent-artifacts', 'skills', 'claude', 'reviewer');
    await mkdir(join(root, 'scripts'), {recursive: true});
    await writeFile(join(root, 'SKILL.md'), '# Reviewer v1\n');
    await writeFile(join(root, 'scripts', 'run.ts'), 'export const run = () => 1;\n');
    return root;
  }

  it('installs a multi-file bundle tree and tracks it with a bundle sidecar', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-bundle-install-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    await seedSharedBundle(config);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote', 'default', 'reviewer');
    await expect(readFile(join(installRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# Reviewer v1\n');
    await expect(readFile(join(installRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe(
      'export const run = () => 1;\n',
    );
    await expect(readFile(join(installRoot, '.threadnote-bundle-install.json'), 'utf8')).resolves.toMatch(
      /scripts\/run\.ts/,
    );
  });

  it('updates a bundle member and protects local edits across members', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-bundle-update-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const sharedRoot = await seedSharedBundle(config);
    const installRoot = join(installHome, '.claude', 'skills', 'threadnote', 'default', 'reviewer');

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    // Upstream changes one member; reinstall adopts it.
    await writeFile(join(sharedRoot, 'scripts', 'run.ts'), 'export const run = () => 2;\n');
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe(
      'update_available',
    );
    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });
    await expect(readFile(join(installRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe(
      'export const run = () => 2;\n',
    );

    // Local edit to one member + upstream edit to a different member -> conflict.
    await writeFile(join(installRoot, 'SKILL.md'), '# Locally edited\n');
    await writeFile(join(sharedRoot, 'scripts', 'run.ts'), 'export const run = () => 3;\n');
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe(
      'remote_changed_and_local_modified',
    );
    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'skill', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/Refusing to overwrite/);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      force: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });
    await expect(readFile(join(installRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# Reviewer v1\n');
    await expect(readFile(join(installRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe(
      'export const run = () => 3;\n',
    );
  });

  const PACK_TOKEN = '${THREADNOTE_PACK_ROOT}';

  async function makeReviewerManifestRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'threadnote-pack-src-'));
    homes.push(repo);
    await mkdir(join(repo, '.claude', 'skills', 'review-pr'), {recursive: true});
    await mkdir(join(repo, '.claude', 'skills', 'pr-status'), {recursive: true});
    await mkdir(join(repo, 'scripts'), {recursive: true});
    await mkdir(join(repo, 'lib'), {recursive: true});
    await writeFile(join(repo, '.claude', 'skills', 'review-pr', 'SKILL.md'), '# Review PR\n\nRun scripts/vcs.ts.\n');
    await writeFile(join(repo, '.claude', 'skills', 'pr-status', 'SKILL.md'), '# PR Status\n');
    await writeFile(
      join(repo, 'scripts', 'vcs.ts'),
      `const foreign = "/Users/yaroslavvoloshchuk/code/reviewer/scripts";\nconst here = "${repo}/scripts";\nimport "../lib/types";\n`,
    );
    await writeFile(join(repo, 'lib', 'types.ts'), 'export type T = string;\n');
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        deps: {cli: ['gh', 'glab'], mcp: ['mcp__pal__clink'], runtime: ['bun']},
        description: 'PR review constellation',
        include: ['scripts', 'lib'],
        name: 'reviewer',
        pathRewrites: [{from: '/Users/yaroslavvoloshchuk/code/reviewer'}],
        skills: ['.claude/skills/review-pr', '.claude/skills/pr-status'],
        version: 1,
      })}\n`,
    );
    return repo;
  }

  it('publishes a constellation pack, tokenizing hardcoded repo-root paths', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    mockPublishCommands();

    const result = await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));

    expect(result.targetUri).toBe(
      'threadnote://user/test-user/memories/shared/default/agent-artifacts/packs/claude/reviewer/reviewer.pack.md',
    );
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    const sharedVcs = await readFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'utf8');
    expect(sharedVcs).toContain(`${PACK_TOKEN}/scripts`);
    expect(sharedVcs).not.toContain('/Users/yaroslavvoloshchuk');
    expect(sharedVcs).not.toContain(repo);
    await expect(readFile(join(packRoot, 'reviewer.pack.md'), 'utf8')).resolves.toContain('# reviewer');
    await expect(
      readFile(join(packRoot, 'files', '.claude', 'skills', 'review-pr', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Review PR');
    const packJson = JSON.parse(await readFile(join(packRoot, 'reviewer.pack.json'), 'utf8'));
    expect(packJson.deps.mcp).toEqual(['mcp__pal__clink']);
    expect(packJson.members.map((m: {path: string}) => m.path)).toContain('scripts/vcs.ts');
    const addArgs = findGitAddArgs();
    expect(addArgs).toContain('agent-artifacts/packs/claude/reviewer/reviewer.pack.md');
    expect(addArgs).toContain('agent-artifacts/packs/claude/reviewer/files/scripts/vcs.ts');
  });

  it('publishes a residual local path that no pathRewrite covers unchanged', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    const leak = 'const home = "/Users/someone/secret/notes";\n';
    await writeFile(join(repo, 'scripts', 'leak.ts'), leak);
    mockPublishCommands();

    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));
    await expect(
      readFile(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'packs',
          'claude',
          'reviewer',
          'files',
          'scripts',
          'leak.ts',
        ),
        'utf8',
      ),
    ).resolves.toBe(leak);
  });

  async function seedSharedPack(config: ShareRuntime): Promise<string> {
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', '.claude', 'skills', 'review-pr'), {recursive: true});
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n\n# reviewer\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: ['gh'], mcp: ['mcp__pal__clink'], os: [], runtime: ['bun']},
        members: [],
        version: 1,
      })}\n`,
    );
    await writeFile(join(packRoot, 'files', '.claude', 'skills', 'review-pr', 'SKILL.md'), '# Review PR\n');
    await writeFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'const root = "${THREADNOTE_PACK_ROOT}/scripts";\n');
    return packRoot;
  }

  it('installs a pack tree, expands the pack-root token, and surfaces requirements', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-pack-install-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    await seedSharedPack(config);

    const result = await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await expect(readFile(join(installRoot, '.claude', 'skills', 'review-pr', 'SKILL.md'), 'utf8')).resolves.toBe(
      '# Review PR\n',
    );
    const installedVcs = await readFile(join(installRoot, 'scripts', 'vcs.ts'), 'utf8');
    expect(installedVcs).toBe(`const root = "${installRoot}/scripts";\n`);
    expect(Effect2.pipe(installedVcs, EffectString.includes('${THREADNOTE_PACK_ROOT}'))).toBe(false);
    await expect(readFile(join(installRoot, '.threadnote-bundle-install.json'), 'utf8')).resolves.toMatch(
      /scripts\/vcs\.ts/,
    );
    expect(EffectArray.join(result.messages, '\n')).toContain('mcp__pal__clink');
  });

  effectIt.effect('publishes and installs a Cursor skill pack in the Cursor pack namespace', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);
      const installHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-cursor-pack-install-home-')));
      homes.push(installHome);
      inheritedProcessEnvironment().HOME = installHome;
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-cursor-pack-src-')));
      homes.push(repo);
      const skillRoot = join(repo, '.cursor', 'skills', 'review-pr');
      yield* Effect.promise(() => mkdir(skillRoot, {recursive: true}));
      yield* Effect.promise(() => writeFile(join(skillRoot, 'SKILL.md'), '# Cursor Review\n'));
      const manifestPath = join(repo, 'threadnote-bundle.json');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          `${JSON.stringify({
            agent: 'cursor',
            deps: {},
            include: [],
            name: 'reviewer',
            pathRewrites: [],
            skills: ['.cursor/skills/review-pr'],
            version: 1,
          })}\n`,
        ),
      );
      mockPublishCommands();

      const published = yield* provideApplicationTestLayer(shareBundlePack(config, manifestPath, {}));
      expect(published.artifact).toEqual({agent: 'cursor', kind: 'pack', name: 'reviewer'});
      const packRoot = join(
        config.agentContextHome,
        'shared',
        'default',
        'agent-artifacts',
        'packs',
        'cursor',
        'reviewer',
      );
      const publishedManifest = yield* Effect.promise(() => readFile(join(packRoot, 'reviewer.pack.json'), 'utf8'));
      expect(JSON.parse(publishedManifest)).toMatchObject({
        artifact: {agent: 'cursor', kind: 'pack', name: 'reviewer'},
        members: [{binary: false, path: '.cursor/skills/review-pr/SKILL.md'}],
      });

      const listed = yield* provideApplicationTestLayer(
        listSharedAgentArtifactsEffect(config, {agent: 'cursor', kind: 'pack', sync: false}),
      );
      expect(listed.artifacts).toHaveLength(1);
      yield* provideApplicationTestLayer(
        installSharedAgentArtifactsEffect(config, {
          agent: 'cursor',
          apply: true,
          kind: 'pack',
          name: 'reviewer',
          sync: false,
        }),
      );
      const installRoot = join(installHome, '.cursor', 'skills', 'threadnote-packs', 'default', 'reviewer');
      const installed = yield* Effect.promise(() =>
        readFile(join(installRoot, '.cursor', 'skills', 'review-pr', 'SKILL.md'), 'utf8'),
      );
      expect(installed).toBe('# Cursor Review\n');
    }),
  );

  it('reports current after install despite token expansion, and update_available on change', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-pack-status-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = await seedSharedPack(config);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });

    // Token expansion changes installed bytes vs shared bytes; status must still
    // read as current (not perpetually update_available).
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe('current');

    await writeFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'const root = "${THREADNOTE_PACK_ROOT}/scripts2";\n');
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe(
      'update_available',
    );
  });

  it('does not expand the pack-root token in a multi-file skill bundle', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-skill-token-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const root = join(config.agentContextHome, 'shared', 'default', 'agent-artifacts', 'skills', 'claude', 'docskill');
    await mkdir(join(root, 'scripts'), {recursive: true});
    await writeFile(join(root, 'SKILL.md'), '# Doc skill\n');
    await writeFile(join(root, 'scripts', 'note.ts'), 'const t = "${THREADNOTE_PACK_ROOT}";\n');

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'docskill',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote', 'default', 'docskill');
    await expect(readFile(join(installRoot, 'scripts', 'note.ts'), 'utf8')).resolves.toBe(
      'const t = "${THREADNOTE_PACK_ROOT}";\n',
    );
  });

  it('reads a pristine pack as current even when the install sidecar is missing', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-pack-nosidecar-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    await seedSharedPack(config);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });
    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await rm(join(installRoot, '.threadnote-bundle-install.json'), {force: true});

    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe('current');
  });

  it('installs only the .pack.json member list, not files orphaned in files/', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-pack-orphan-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n\n# reviewer\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: [], mcp: [], os: [], runtime: []},
        members: [{binary: false, path: 'scripts/keep.ts', sha256: 'x'}],
        version: 1,
      })}\n`,
    );
    await writeFile(join(packRoot, 'files', 'scripts', 'keep.ts'), 'keep\n');
    await writeFile(join(packRoot, 'files', 'scripts', 'orphan.ts'), 'orphan\n');

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await expect(readFile(join(installRoot, 'scripts', 'keep.ts'), 'utf8')).resolves.toBe('keep\n');
    await expect(readFile(join(installRoot, 'scripts', 'orphan.ts'), 'utf8')).rejects.toThrow();
  });

  it('rejects a pack manifest with a non-absolute pathRewrite', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        include: ['scripts', 'lib'],
        name: 'reviewer',
        pathRewrites: [{from: 'lib'}],
        skills: ['.claude/skills/review-pr'],
        version: 1,
      })}\n`,
    );
    mockPublishCommands();

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /absolute repo-root path/,
    );
  });

  it('blocks publishing a pack whose member already contains the reserved token', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(join(repo, 'scripts', 'tok.ts'), 'const x = "${THREADNOTE_PACK_ROOT}/y";\n');
    mockPublishCommands();

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /reserved/,
    );
  });

  it('rejects a pack manifest include entry that escapes the pack root', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        include: ['../secret'],
        name: 'reviewer',
        skills: ['.claude/skills/review-pr'],
        version: 1,
      })}\n`,
    );
    mockPublishCommands();

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /within the pack root/,
    );
  });

  it('keeps a pack and a same-named skill in separate install roots', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-collision-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    await seedSharedBundle(config); // skills/claude/reviewer (multi-file skill)
    await seedSharedPack(config); // packs/claude/reviewer (pack)

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });
    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'skill',
      name: 'reviewer',
      sync: false,
    });

    const skillRoot = join(installHome, '.claude', 'skills', 'threadnote', 'default', 'reviewer');
    const packRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    // Installing the skill must not have destroyed the pack tree (separate roots).
    await expect(readFile(join(packRoot, 'scripts', 'vcs.ts'), 'utf8')).resolves.toContain('/scripts');
    await expect(readFile(join(skillRoot, 'scripts', 'run.ts'), 'utf8')).resolves.toBe('export const run = () => 1;\n');
  });

  it('skips an incomplete pack index (no .pack.json) without breaking discovery of other artifacts', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-ghost-pack-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const skill = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'skills',
      'claude',
      'triage',
      'SKILL.md',
    );
    await mkdir(join(skill, '..'), {recursive: true});
    await writeFile(skill, '# Triage\n');
    const ghost = join(config.agentContextHome, 'shared', 'default', 'agent-artifacts', 'packs', 'claude', 'ghost');
    await mkdir(ghost, {recursive: true});
    await writeFile(join(ghost, 'ghost.pack.md'), '---\nname: ghost\nkind: pack\n---\n');

    const result = await listSharedAgentArtifacts(config, {sync: false});
    const names = EffectArray.map(result.artifacts, entry => entry.artifact.name);
    expect(names).toContain('triage');
    expect(names).not.toContain('ghost');
  });

  it('does not crash listing when a .pack.json member is missing from files/', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-missing-member-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: [], mcp: [], os: [], runtime: []},
        members: [{binary: false, path: 'scripts/missing.ts', sha256: 'x'}],
        version: 1,
      })}\n`,
    );

    const result = await listSharedAgentArtifacts(config, {sync: false});
    expect(EffectArray.map(result.artifacts, entry => entry.artifact.name)).toContain('reviewer');
  });

  it('publishes a residual /home path in a pack member unchanged', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    const deploy = 'const key = "/home/deploy/.ssh/id_rsa";\n';
    await writeFile(join(repo, 'scripts', 'deploy.ts'), deploy);
    mockPublishCommands();

    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));
    await expect(
      readFile(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'packs',
          'claude',
          'reviewer',
          'files',
          'scripts',
          'deploy.ts',
        ),
        'utf8',
      ),
    ).resolves.toBe(deploy);
  });

  it('treats --redact as a no-op and publishes a residual local path unchanged', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    const leak = 'const home = "/Users/someone/secret/x";\n';
    await writeFile(join(repo, 'scripts', 'leak.ts'), leak);
    mockPublishCommands();

    const result = await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {redact: true}));
    expect(EffectArray.join(result.messages, '\n')).toMatch(/--redact is ignored/);
    await expect(
      readFile(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'packs',
          'claude',
          'reviewer',
          'files',
          'scripts',
          'leak.ts',
        ),
        'utf8',
      ),
    ).resolves.toBe(leak);
  });

  it('publishes skill markdown with path-shaped literals unchanged', async () => {
    const fragment = fc.oneof(
      fc.constant('/tmp/digest-prompt.md'),
      fc.constant('/Users/someone/secret/notes'),
      fc.constant('/home/deploy/.ssh/id_rsa'),
      fc.constant("str.replace(/\\\\/g, '\\\\\\\\')"),
      fc
        .string({maxLength: 24})
        .map(value => `/tmp/${Effect2.pipe(value, EffectString.replaceAll(/[/\\\0]/g, '_')) || 'x'}`),
    );
    await fc.assert(
      fc.asyncProperty(fragment, async value => {
        const config = await makeRuntime();
        homes.push(config.agentContextHome);
        const sourcePath = join(config.agentContextHome, '.codex', 'skills', 'reviewer', 'SKILL.md');
        const body = `# Reviewer\n\nSee ${value}\n`;
        await mkdir(join(sourcePath, '..'), {recursive: true});
        await writeFile(sourcePath, body);
        mockPublishCommands();
        await runEffect(shareAgentArtifact(config, sourcePath, {}));
        await expect(
          readFile(
            join(
              config.agentContextHome,
              'shared',
              'default',
              'agent-artifacts',
              'skills',
              'codex',
              'reviewer',
              'SKILL.md',
            ),
            'utf8',
          ),
        ).resolves.toBe(body);
      }),
      {numRuns: 15},
    );
  });

  it('flags a locally-edited member removed upstream as a conflict, not a silent update', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-removed-member-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n');
    const writeManifest = async (members: Array<{path: string}>): Promise<void> =>
      writeFile(
        join(packRoot, 'reviewer.pack.json'),
        `${JSON.stringify({artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'}, deps: {}, members, version: 1})}\n`,
      );
    await writeManifest([{path: 'scripts/a.ts'}, {path: 'scripts/b.ts'}]);
    await writeFile(join(packRoot, 'files', 'scripts', 'a.ts'), 'a\n');
    await writeFile(join(packRoot, 'files', 'scripts', 'b.ts'), 'b\n');
    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });

    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await writeFile(join(installRoot, 'scripts', 'b.ts'), 'b-local-edit\n');
    await writeManifest([{path: 'scripts/a.ts'}]);
    await rm(join(packRoot, 'files', 'scripts', 'b.ts'), {force: true});

    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe(
      'remote_changed_and_local_modified',
    );
    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'pack', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/Refusing to overwrite/);
  });

  it('rolls back a pack publish, materializing nothing when the native canonical write fails', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await blockNativeArtifactWrites(config);

    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /directory|path|exist|resource stat/i,
    );
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await expect(readFile(join(packRoot, 'reviewer.pack.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'utf8')).rejects.toThrow();
  });

  it('tokenizes a repo-root path embedded in pack deps', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        deps: {cli: [`${repo}/bin/tool`]},
        include: ['scripts', 'lib'],
        name: 'reviewer',
        pathRewrites: [{from: '/Users/yaroslavvoloshchuk/code/reviewer'}],
        skills: ['.claude/skills/review-pr'],
        version: 1,
      })}\n`,
    );
    mockPublishCommands();

    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));

    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    const json = await readFile(join(packRoot, 'reviewer.pack.json'), 'utf8');
    expect(json).toContain('${THREADNOTE_PACK_ROOT}/bin/tool');
    expect(json).not.toContain(repo);
  });

  it('protects work when the sidecar is gone and a member differs: blocks without --force, applies with it', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-nosidecar-update-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = await seedSharedPack(config);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });
    const installRoot = join(installHome, '.claude', 'skills', 'threadnote-packs', 'default', 'reviewer');
    await rm(join(installRoot, '.threadnote-bundle-install.json'), {force: true});
    await writeFile(
      join(packRoot, 'files', 'scripts', 'vcs.ts'),
      'const root = "${THREADNOTE_PACK_ROOT}/scripts-v2";\n',
    );

    // Without a baseline the mismatch is ambiguous (local edit vs upstream
    // change), so it is treated protectively and blocked until --force.
    expect((await listSharedAgentArtifacts(config, {sync: false})).artifacts[0]?.installStatus).toBe('local_modified');
    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'pack', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/Refusing to overwrite/);

    await installSharedAgentArtifacts(config, {
      agent: 'claude',
      apply: true,
      force: true,
      kind: 'pack',
      name: 'reviewer',
      sync: false,
    });
    await expect(readFile(join(installRoot, 'scripts', 'vcs.ts'), 'utf8')).resolves.toContain('/scripts-v2');
  });

  it('publishes a residual rewrite-root path the tokenizer leaves intact', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    // `${repo}-logs` is a sibling of the repo root: the tokenizer will not rewrite
    // it (the `-` is not a path boundary). Residual-root blocking no longer applies.
    const log = `const dir = "${repo}-logs/run";\n`;
    await writeFile(join(repo, 'scripts', 'log.ts'), log);
    mockPublishCommands();

    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));
    await expect(
      readFile(
        join(
          config.agentContextHome,
          'shared',
          'default',
          'agent-artifacts',
          'packs',
          'claude',
          'reviewer',
          'files',
          'scripts',
          'log.ts',
        ),
        'utf8',
      ),
    ).resolves.toBe(log);
  });

  it('accepts a skill entry given as a path to SKILL.md', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        include: [],
        name: 'reviewer',
        pathRewrites: [{from: '/Users/yaroslavvoloshchuk/code/reviewer'}],
        skills: ['.claude/skills/review-pr/SKILL.md'],
        version: 1,
      })}\n`,
    );
    mockPublishCommands();

    const result = await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));
    expect(result.targetUri).toContain('packs/claude/reviewer/reviewer.pack.md');
  });

  it('refuses to install a pack with an unreadable declared member without --force', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-incomplete-pack-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files', 'scripts'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: [], mcp: [], os: [], runtime: []},
        members: [
          {binary: false, path: 'scripts/a.ts', sha256: 'x'},
          {binary: false, path: 'scripts/missing.ts', sha256: 'y'},
        ],
        version: 1,
      })}\n`,
    );
    await writeFile(join(packRoot, 'files', 'scripts', 'a.ts'), 'a\n');
    // scripts/missing.ts is declared but absent from files/.

    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'pack', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/unreadable|Retry after sync/);
  });

  it('warns (without blocking) about a non-home machine-local path it cannot rewrite', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(join(repo, 'scripts', 'deploy.ts'), 'const dir = "/opt/work/secrets/run";\n');
    mockPublishCommands();

    const result = await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));
    expect(EffectArray.join(result.messages, '\n')).toContain('/opt/work/secrets/run');
    expect(EffectArray.join(result.messages, '\n')).toMatch(/machine-local/);
  });

  it('re-publishes a changed pack with --force, leaving the new version in place', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    mockPublishCommands();
    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));

    await writeFile(
      join(repo, 'scripts', 'vcs.ts'),
      `const v = 2;\nconst here = "${repo}/scripts";\nimport '../lib/types';\n`,
    );
    // Differing content must be refused without --force, then replace cleanly with it.
    await expect(runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}))).rejects.toThrow(
      /already exists with different content/,
    );
    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {force: true}));

    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    const sharedVcs = await readFile(join(packRoot, 'files', 'scripts', 'vcs.ts'), 'utf8');
    expect(sharedVcs).toContain('v = 2');
    expect(sharedVcs).toContain('${THREADNOTE_PACK_ROOT}/scripts');
    expect(sharedVcs).not.toContain(repo);
  });

  it('skips a pack whose .pack.json member path escapes the pack root (no traversal write)', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const installHome = await mkdtemp(join(tmpdir(), 'threadnote-traversal-home-'));
    homes.push(installHome);
    process.env.HOME = installHome;
    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    await mkdir(join(packRoot, 'files'), {recursive: true});
    await writeFile(join(packRoot, 'reviewer.pack.md'), '---\nname: reviewer\nkind: pack\n---\n');
    await writeFile(
      join(packRoot, 'reviewer.pack.json'),
      `${JSON.stringify({
        artifact: {agent: 'claude', kind: 'pack', name: 'reviewer'},
        deps: {cli: [], mcp: [], os: [], runtime: []},
        members: [{binary: false, path: '../../../../../../escape.ts', sha256: 'x'}],
        version: 1,
      })}\n`,
    );
    await writeFile(join(packRoot, 'files', 'a.ts'), 'a\n');

    // The unsafe member path makes discovery skip the whole pack, so install finds
    // nothing to install — and crucially writes nothing outside the install root.
    await expect(
      installSharedAgentArtifacts(config, {agent: 'claude', apply: true, kind: 'pack', name: 'reviewer', sync: false}),
    ).rejects.toThrow(/No shared agent artifacts/);
    await expect(readFile(join(installHome, 'escape.ts'), 'utf8')).rejects.toThrow();
  });

  it('normalizes a trailing-slash pathRewrites entry so a bare-directory reference is rewritten', async () => {
    const config = await makeRuntime();
    homes.push(config.agentContextHome);
    const repo = await makeReviewerManifestRepo();
    await writeFile(
      join(repo, 'threadnote-bundle.json'),
      `${JSON.stringify({
        agent: 'claude',
        include: ['scripts', 'lib'],
        name: 'reviewer',
        pathRewrites: [{from: '/Users/yaroslavvoloshchuk/code/reviewer'}, {from: '/opt/acme/reviewer/'}],
        skills: ['.claude/skills/review-pr'],
        version: 1,
      })}\n`,
    );
    await writeFile(join(repo, 'scripts', 'opt.ts'), 'const d = "/opt/acme/reviewer";\n');
    mockPublishCommands();

    await runEffect(shareBundlePack(config, join(repo, 'threadnote-bundle.json'), {}));

    const packRoot = join(
      config.agentContextHome,
      'shared',
      'default',
      'agent-artifacts',
      'packs',
      'claude',
      'reviewer',
    );
    const sharedOpt = await readFile(join(packRoot, 'files', 'scripts', 'opt.ts'), 'utf8');
    expect(sharedOpt).toContain('${THREADNOTE_PACK_ROOT}');
    expect(sharedOpt).not.toContain('/opt/acme/reviewer');
  });
});
