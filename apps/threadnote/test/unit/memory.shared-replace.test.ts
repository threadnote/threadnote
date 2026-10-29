import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Cause, Effect, Exit} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {afterEach, beforeEach, describe, expect, vi} from 'vitest';
import * as aiEnrichment from '@threadnote/threadnote/effect/ai/enrichment';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {runRemember} from '@threadnote/threadnote/memory/index';
import type {MemoryMetadata} from '@threadnote/memory/document';
import type {CommandResult} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as utils from '@threadnote/threadnote/utils';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

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

vi.mock('@threadnote/threadnote/effect/ai/enrichment', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/effect/ai/enrichment')>();
  return {
    ...actual,
    enrichMemoryMetadataWithConfiguredLocalAi: vi.fn((_config: RuntimeConfig, metadata: MemoryMetadata) =>
      Effect.succeed({...metadata, keywords: ['generated retrieval alias']}),
    ),
  };
});

const ok = (stdout = ''): CommandResult => ({exitCode: 0, stdout, stderr: ''});
const fail = (stderr: string): CommandResult => ({exitCode: 1, stdout: '', stderr});

async function makeRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-shared-replace-'));
  const worktree = join(home, 'shared', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(join(home, 'share'), {recursive: true});
  await mkdir(worktree, {recursive: true});
  const sharedContent =
    'MEMORY\nkind: durable\nstatus: active\nproject: orion-worker\ntopic: lease\nmemory_id: tn_shared_lease\n\nOriginal shared lease memory.\n';
  const dependencyContent =
    'MEMORY\nkind: durable\nstatus: active\nproject: orion-worker\ntopic: dependency\nmemory_id: tn_shared_dependency\n\nShared dependency.\n';
  const canonicalSharedPath = join(
    home,
    'data',
    'local',
    'user',
    'test-user',
    'memories',
    'shared',
    'default',
    'durable',
    'projects',
    'orion-worker',
    'lease.md',
  );
  const worktreeSharedPath = join(worktree, 'durable', 'projects', 'orion-worker', 'lease.md');
  const canonicalDependencyPath = join(
    home,
    'data',
    'local',
    'user',
    'test-user',
    'memories',
    'shared',
    'default',
    'durable',
    'projects',
    'orion-worker',
    'dependency.md',
  );
  const worktreeDependencyPath = join(worktree, 'durable', 'projects', 'orion-worker', 'dependency.md');
  await mkdir(join(canonicalSharedPath, '..'), {recursive: true});
  await mkdir(join(worktreeSharedPath, '..'), {recursive: true});
  await writeFile(canonicalSharedPath, sharedContent);
  await writeFile(worktreeSharedPath, sharedContent);
  await writeFile(canonicalDependencyPath, dependencyContent);
  await writeFile(worktreeDependencyPath, dependencyContent);
  await writeFile(
    join(home, 'share', 'teams.json'),
    `${JSON.stringify(
      {
        defaultTeam: 'default',
        teams: {
          default: {
            addedAt: '2026-06-03T00:00:00.000Z',
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
    manifestPath: join(home, 'manifest.json'),
    user: 'test-user',
  };
}

describe('remember shared replacement', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(utils.maybeRun).mockImplementation((dryRun, executable, args, options) =>
      dryRun ? succeedUndefined : vi.mocked(utils.runCommand)(executable, args, options),
    );
    vi.mocked(utils.requiredExecutable).mockReturnValue(Effect.succeed('git'));
    vi.mocked(utils.runCommand).mockReset();
    vi.mocked(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect(
    'updates a shared replaceUri in place instead of writing personal memory and forgetting shared copy',
    () =>
      Effect.gen(function* () {
        const config = yield* Effect.promise(makeRuntime);
        homes.push(config.agentContextHome);

        const sharedUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/lease.md';
        const captured = yield* captureConsole(
          runRemember(config, {
            dryRun: true,
            kind: 'durable',
            replace: sharedUri,
            sourceAgentClient: 'codex',
            text: 'Updated shared lease memory.',
          }).pipe(provideTestLayer(ApplicationLayer)),
        );

        const output = captured.output;
        expect(output).toContain(sharedUri);
        expect(output).toContain('project: orion-worker');
        expect(output).toContain('topic: lease');
        expect(output).toContain('--mode replace');
        expect(output).toContain('share: update durable/projects/orion-worker/lease.md');
        expect(output).toContain('Updated shared memory:');
        expect(output).not.toContain('supersedes:');
        expect(output).not.toContain(` rm ${sharedUri}`);
        expect(output).not.toContain('memories/durable/projects/orion-worker/lease.md --from-file');
      }),
  );

  effectIt.effect('routes a stable shared memory alias to its canonical shared replacement target', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);
      const alias = 'threadnote://memory/tn_shared_lease';
      const sharedUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/lease.md';

      const captured = yield* captureConsole(
        runRemember(config, {
          dryRun: true,
          kind: 'durable',
          replace: alias,
          sourceAgentClient: 'codex',
          text: 'Updated shared lease through its stable identity.',
        }).pipe(provideTestLayer(ApplicationLayer)),
      );

      expect(captured.output).toContain(`Updated shared memory: ${sharedUri}`);
      expect(captured.output).toContain('share: update durable/projects/orion-worker/lease.md');
    }),
  );

  effectIt.effect('keeps the project from the storage path when the caller requests a different one', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);

      const sharedUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/lease.md';
      const captured = yield* captureConsole(
        runRemember(config, {
          dryRun: true,
          kind: 'durable',
          project: 'atlas-cache', // differs from the path project (orion-worker)
          replace: sharedUri,
          sourceAgentClient: 'codex',
          text: 'Updated shared lease memory.',
        }).pipe(provideTestLayer(ApplicationLayer)),
      );

      const output = captured.output;
      // Frontmatter tracks the path, not the differing request — no divergence.
      expect(output).toContain('project: orion-worker');
      expect(output).not.toContain('project: atlas-cache');
      expect(output).toContain('keeping shared memory project "orion-worker"');
      expect(output).toContain('ignoring requested "atlas-cache"');
    }),
  );

  effectIt.effect('normalizes and preserves stable relations on direct shared replacement', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);

      const sharedUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/lease.md';
      const targetUri =
        'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/dependency.md';
      const captured = yield* captureConsole(
        runRemember(config, {
          dryRun: true,
          kind: 'durable',
          relations: [`depends_on=${targetUri}`],
          replace: sharedUri,
          sourceAgentClient: 'codex',
          text: 'Updated shared lease memory.',
        }).pipe(provideTestLayer(ApplicationLayer)),
      );

      expect(captured.output).toContain('relation: depends_on threadnote://memory/tn_shared_dependency');
      expect(captured.output).not.toContain(`relation: depends_on ${targetUri}`);
    }),
  );

  effectIt.effect('does not warn when the caller project matches the storage path', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);

      const sharedUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/lease.md';
      const captured = yield* captureConsole(
        runRemember(config, {
          dryRun: true,
          kind: 'durable',
          project: 'orion-worker', // matches the path project → no drift
          replace: sharedUri,
          sourceAgentClient: 'codex',
          text: 'Updated shared lease memory.',
        }).pipe(provideTestLayer(ApplicationLayer)),
      );

      const output = captured.output;
      expect(output).toContain('project: orion-worker');
      expect(output).not.toContain('keeping shared memory project');
    }),
  );

  effectIt.effect('rejects non-durable shared replacements', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);
      const exit = yield* Effect.exit(
        runRemember(config, {
          dryRun: true,
          kind: 'handoff',
          replace: 'threadnote://user/test-user/memories/shared/default/durable/projects/foo/bar.md',
          text: 'Not shareable.',
        }).pipe(provideTestLayer(ApplicationLayer)),
      );
      expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : 'Operation unexpectedly succeeded.').toMatch(
        /only supports durable/,
      );
    }),
  );

  effectIt.effect('never sends a shared replacement through automatic enrichment', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);
      vi.mocked(utils.runCommand).mockReturnValue(Effect.succeed(ok()));

      yield* runRemember(config, {
        kind: 'durable',
        replace: 'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/lease.md',
        text: 'Updated shared lease memory.',
      }).pipe(provideTestLayer(ApplicationLayer));

      expect(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('surfaces git push failures instead of reporting a successful shared update', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeRuntime);
      homes.push(config.agentContextHome);
      const sharedUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/lease.md';
      vi.mocked(utils.runCommand).mockImplementation((executable, args) => {
        if (executable === '/ov' && args[0] === 'stat') {
          return Effect.succeed(ok());
        }
        if (executable === '/ov' && args[0] === 'write') {
          return Effect.succeed(ok('written'));
        }
        if (executable === 'git' && args.includes('add')) {
          return Effect.succeed(ok());
        }
        if (executable === 'git' && args.includes('commit')) {
          return Effect.succeed(ok('[main abc123] share'));
        }
        if (executable === 'git' && args.includes('push')) {
          return Effect.succeed(fail('permission denied'));
        }
        return Effect.succeed(ok());
      });

      const exit = yield* Effect.exit(
        runRemember(config, {
          kind: 'durable',
          replace: sharedUri,
          sourceAgentClient: 'codex',
          text: 'Updated shared lease memory.',
        }).pipe(provideTestLayer(ApplicationLayer)),
      );
      expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : 'Operation unexpectedly succeeded.').toMatch(
        /git push failed/,
      );
    }),
  );
});
