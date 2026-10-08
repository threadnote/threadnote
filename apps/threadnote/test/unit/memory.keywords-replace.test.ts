import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {mkdtemp, rm, writeFile, mkdir} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Cause, Effect, Exit} from 'effect';
import * as FC from 'fast-check';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as aiEnrichment from '@threadnote/threadnote/effect/ai/enrichment';
import {normalizeManualMemoryKeywords} from '@threadnote/threadnote/effect/ai/enrichment';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {succeedUndefined} from '@threadnote/platform/optional';
import {readMemoryRecordsByUri, runHandoff, runRemember} from '@threadnote/threadnote/memory/index';
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

const PROJECT = 'threadnote';
const TOPIC = 'keyword-preserve';
const STABLE_URI = 'threadnote://user/test-user/memories/durable/projects/threadnote/keyword-preserve.md';

async function makePersonalRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-keywords-replace-'));
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: join(home, 'manifest.json'),
    user: 'test-user',
  };
}

async function makeSharedRuntime(): Promise<RuntimeConfig> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-keywords-shared-'));
  const worktree = join(home, 'shared', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(join(home, 'share'), {recursive: true});
  await mkdir(worktree, {recursive: true});
  const sharedContent = [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: orion-worker',
    'topic: lease',
    'memory_id: tn_shared_lease',
    'keywords: arc',
    'keywords: karpenter',
    'keywords: jitconfig',
    '',
    'Original shared lease memory.',
    '',
  ].join('\n');
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
  await mkdir(join(canonicalSharedPath, '..'), {recursive: true});
  await mkdir(join(worktreeSharedPath, '..'), {recursive: true});
  await writeFile(canonicalSharedPath, sharedContent);
  await writeFile(worktreeSharedPath, sharedContent);
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

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : 'Operation unexpectedly succeeded.';

describe('remember keywords on replace', () => {
  const homes: string[] = [];

  beforeEach(() => {
    vi.mocked(utils.maybeRun).mockImplementation((dryRun, executable, args, options) =>
      dryRun ? succeedUndefined : vi.mocked(utils.runCommand)(executable, args, options),
    );
    vi.mocked(utils.requiredExecutable).mockReturnValue(Effect.succeed('git'));
    vi.mocked(utils.runCommand).mockReset().mockReturnValue(Effect.succeed(ok()));
    vi.mocked(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).mockClear();
    vi.mocked(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).mockImplementation((_config, metadata) =>
      Effect.succeed({...metadata, keywords: ['generated retrieval alias']}),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('preserves prior keywords on replace by default and skips automatic enrichment', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makePersonalRuntime);
      homes.push(config.agentContextHome);

      yield* runRemember(config, {
        kind: 'durable',
        project: PROJECT,
        sourceAgentClient: 'vitest',
        text: 'Original memory body.',
        topic: TOPIC,
      }).pipe(provideTestLayer(ApplicationLayer));

      vi.mocked(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).mockClear();
      vi.mocked(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).mockImplementation((_config, metadata) =>
        Effect.succeed({...metadata, keywords: ['second generation phrase']}),
      );

      const captured = yield* captureConsole(
        runRemember(config, {
          kind: 'durable',
          project: PROJECT,
          replace: STABLE_URI,
          sourceAgentClient: 'vitest',
          text: 'Updated memory body.',
          topic: TOPIC,
        }).pipe(provideTestLayer(ApplicationLayer)),
      );

      expect(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).not.toHaveBeenCalled();
      expect(captured.output).toContain('Preserved 1 prior keyword(s)');

      const [record] = yield* readMemoryRecordsByUri(config, [STABLE_URI]).pipe(provideTestLayer(ApplicationLayer));
      expect(record?.metadata.keywords).toEqual(['generated retrieval alias']);
    }),
  );

  effectIt.effect('drops keywords only with clearKeywords', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makePersonalRuntime);
      homes.push(config.agentContextHome);

      yield* runRemember(config, {
        kind: 'durable',
        project: PROJECT,
        sourceAgentClient: 'vitest',
        text: 'Original memory body.',
        topic: TOPIC,
      }).pipe(provideTestLayer(ApplicationLayer));

      vi.mocked(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).mockClear();

      const captured = yield* captureConsole(
        runRemember(config, {
          clearKeywords: true,
          kind: 'durable',
          project: PROJECT,
          replace: STABLE_URI,
          sourceAgentClient: 'vitest',
          text: 'Updated memory body.',
          topic: TOPIC,
        }).pipe(provideTestLayer(ApplicationLayer)),
      );

      expect(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).not.toHaveBeenCalled();
      expect(captured.output).toContain('Cleared 1 prior keyword(s)');

      const [record] = yield* readMemoryRecordsByUri(config, [STABLE_URI]).pipe(provideTestLayer(ApplicationLayer));
      expect(record?.metadata.keywords).toBeUndefined();
    }),
  );

  effectIt.effect('stores explicit manual keywords and skips automatic enrichment', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makePersonalRuntime);
      homes.push(config.agentContextHome);

      yield* runRemember(config, {
        kind: 'durable',
        project: PROJECT,
        sourceAgentClient: 'vitest',
        text: 'Original memory body.',
        topic: TOPIC,
      }).pipe(provideTestLayer(ApplicationLayer));

      vi.mocked(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).mockClear();

      yield* runRemember(config, {
        keywords: ['arc', 'karpenter', 'jitconfig'],
        kind: 'durable',
        project: PROJECT,
        replace: STABLE_URI,
        sourceAgentClient: 'vitest',
        text: 'Updated memory body.',
        topic: TOPIC,
      }).pipe(provideTestLayer(ApplicationLayer));

      expect(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).not.toHaveBeenCalled();

      const [record] = yield* readMemoryRecordsByUri(config, [STABLE_URI]).pipe(provideTestLayer(ApplicationLayer));
      expect(record?.metadata.keywords).toEqual(['arc', 'karpenter', 'jitconfig']);
    }),
  );

  effectIt.effect('authors, preserves, and clears explicit handoff keywords without enrichment', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makePersonalRuntime);
      homes.push(config.agentContextHome);
      const uri = 'threadnote://user/test-user/memories/handoffs/active/threadnote/keyword-handoff.md';
      const options = {
        project: PROJECT,
        sourceAgentClient: 'vitest',
        task: 'No PR has merged to main.',
        topic: 'keyword-handoff',
      };
      yield* runHandoff(config, {...options, keywords: [' review pending ', 'review pending']}).pipe(
        provideTestLayer(ApplicationLayer),
      );
      const [authored] = yield* readMemoryRecordsByUri(config, [uri]).pipe(provideTestLayer(ApplicationLayer));
      expect(authored?.metadata.keywords).toEqual(['review pending']);
      expect(authored?.body).toContain('No PR has merged to main.');

      yield* runHandoff(config, {...options, replace: uri}).pipe(provideTestLayer(ApplicationLayer));
      const [preserved] = yield* readMemoryRecordsByUri(config, [uri]).pipe(provideTestLayer(ApplicationLayer));
      expect(preserved?.metadata.keywords).toEqual(['review pending']);

      yield* runHandoff(config, {...options, clearKeywords: true, replace: uri}).pipe(
        provideTestLayer(ApplicationLayer),
      );
      const [cleared] = yield* readMemoryRecordsByUri(config, [uri]).pipe(provideTestLayer(ApplicationLayer));
      expect(cleared?.metadata.keywords).toBeUndefined();
      expect(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('regenerates keywords when requested, discarding preserved ones', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makePersonalRuntime);
      homes.push(config.agentContextHome);

      yield* runRemember(config, {
        kind: 'durable',
        project: PROJECT,
        sourceAgentClient: 'vitest',
        text: 'Original memory body.',
        topic: TOPIC,
      }).pipe(provideTestLayer(ApplicationLayer));

      vi.mocked(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).mockImplementation((_config, metadata) =>
        Effect.succeed({...metadata, keywords: ['fresh retrieval phrase']}),
      );

      yield* runRemember(config, {
        kind: 'durable',
        project: PROJECT,
        regenerateKeywords: true,
        replace: STABLE_URI,
        sourceAgentClient: 'vitest',
        text: 'Updated memory body.',
        topic: TOPIC,
      }).pipe(provideTestLayer(ApplicationLayer));

      const [record] = yield* readMemoryRecordsByUri(config, [STABLE_URI]).pipe(provideTestLayer(ApplicationLayer));
      expect(record?.metadata.keywords).toEqual(['fresh retrieval phrase']);
    }),
  );

  effectIt.effect('rejects mutually exclusive keyword options', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makePersonalRuntime);
      homes.push(config.agentContextHome);

      for (const options of [
        {keywords: ['arc'], clearKeywords: true},
        {keywords: ['arc'], regenerateKeywords: true},
        {clearKeywords: true, regenerateKeywords: true},
      ] as const) {
        const exit = yield* Effect.exit(
          runRemember(config, {
            kind: 'durable',
            project: PROJECT,
            sourceAgentClient: 'vitest',
            text: 'Updated memory body.',
            topic: TOPIC,
            ...options,
          }).pipe(provideTestLayer(ApplicationLayer)),
        );
        expect(failureMessage(exit)).toMatch(/keyword/i);
      }
    }),
  );

  effectIt.effect('treats fresh-memory clear as automatic enrichment', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makePersonalRuntime);
      homes.push(config.agentContextHome);

      yield* runRemember(config, {
        clearKeywords: true,
        kind: 'durable',
        project: PROJECT,
        sourceAgentClient: 'vitest',
        text: 'Fresh memory body with clear flag and no prior.',
        topic: TOPIC,
      }).pipe(provideTestLayer(ApplicationLayer));

      expect(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).toHaveBeenCalledTimes(1);
      const [record] = yield* readMemoryRecordsByUri(config, [STABLE_URI]).pipe(provideTestLayer(ApplicationLayer));
      expect(record?.metadata.keywords).toEqual(['generated retrieval alias']);
    }),
  );

  effectIt.effect('preserves keywords when a handoff replaces a memory', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makePersonalRuntime);
      homes.push(config.agentContextHome);

      yield* runRemember(config, {
        kind: 'durable',
        project: PROJECT,
        sourceAgentClient: 'vitest',
        text: 'Original memory body.',
        topic: TOPIC,
      }).pipe(provideTestLayer(ApplicationLayer));

      const captured = yield* captureConsole(
        runHandoff(config, {
          dryRun: true,
          replace: STABLE_URI,
          sourceAgentClient: 'vitest',
          task: 'keyword handoff check',
        }).pipe(provideTestLayer(ApplicationLayer)),
      );

      expect(captured.output).toContain('keywords: generated retrieval alias');
    }),
  );

  effectIt.effect('preserves shared keywords on dry-run replace', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeSharedRuntime);
      homes.push(config.agentContextHome);
      const sharedUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/lease.md';

      const captured = yield* captureConsole(
        runRemember(config, {
          dryRun: true,
          kind: 'durable',
          replace: sharedUri,
          sourceAgentClient: 'vitest',
          text: 'Updated shared lease memory.',
        }).pipe(provideTestLayer(ApplicationLayer)),
      );

      expect(aiEnrichment.enrichMemoryMetadataWithConfiguredLocalAi).not.toHaveBeenCalled();
      expect(captured.output).toContain('keywords: arc');
      expect(captured.output).toContain('keywords: karpenter');
      expect(captured.output).toContain('keywords: jitconfig');
    }),
  );

  effectIt.effect('rejects keyword regeneration for shared replacements', () =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(makeSharedRuntime);
      homes.push(config.agentContextHome);
      const sharedUri = 'threadnote://user/test-user/memories/shared/default/durable/projects/orion-worker/lease.md';

      const exit = yield* Effect.exit(
        runRemember(config, {
          dryRun: true,
          kind: 'durable',
          regenerateKeywords: true,
          replace: sharedUri,
          sourceAgentClient: 'vitest',
          text: 'Updated shared lease memory.',
        }).pipe(provideTestLayer(ApplicationLayer)),
      );
      expect(failureMessage(exit)).toMatch(/shared.*keyword|keyword.*shared/i);
    }),
  );
});

describe('normalizeManualMemoryKeywords', () => {
  it('is idempotent and drops duplicates case-insensitively', () => {
    FC.assert(
      FC.property(FC.array(FC.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,30}$/), {maxLength: 10}), keywords => {
        const once = normalizeManualMemoryKeywords(keywords);
        expect(normalizeManualMemoryKeywords(once)).toEqual(once);
        expect(new Set(once.map(keyword => keyword.toLowerCase())).size).toBe(once.length);
        expect(once.length).toBeLessThanOrEqual(32);
      }),
    );
  });

  it('filters unusable values and caps at 32 on hostile inputs', () => {
    FC.assert(
      FC.property(
        FC.array(
          FC.oneof(
            FC.string({maxLength: 120}),
            FC.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,100}$/),
            FC.constantFrom('', ' ', '  - ', '* ', 'x', 'a'.repeat(81), 'one two three four five six seven eight nine'),
          ),
          {maxLength: 40},
        ),
        keywords => {
          const once = normalizeManualMemoryKeywords(keywords);
          expect(normalizeManualMemoryKeywords(once)).toEqual(once);
          expect(once.length).toBeLessThanOrEqual(32);
          for (const keyword of once) {
            expect(keyword.length).toBeGreaterThanOrEqual(2);
            expect(keyword.length).toBeLessThanOrEqual(80);
            expect(keyword.split(/\s+/).length).toBeLessThanOrEqual(8);
            expect(keyword).toMatch(/[a-z0-9]/i);
          }
        },
      ),
    );
  });
});
