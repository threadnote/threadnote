import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {inheritedProcessEnvironment} from '@threadnote/testing/process-environment';
import {ResourceStore} from '@threadnote/store/resource-store';
import {loadRecallIndex} from '@threadnote/recall/index';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {hasAgentSkillCatalogIntent, runRecall, stripAdvancedSearchFlags} from '@threadnote/threadnote/memory/index';
import {projectRecallCliResponse} from '@threadnote/threadnote/recall/cli_response';
import type {RecallMemoryConnectionsResult} from '@threadnote/recall/memory/connections';
import type {RecallOptions} from '@threadnote/threadnote/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as utils from '@threadnote/threadnote/utils';
vi.mock('@threadnote/threadnote/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/threadnote/utils')>();
  return {
    ...actual,
  };
});
const runtime: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-test/seed-manifest.yaml',
  user: 'denys',
};
const captureRecall = (config: RuntimeConfig, options: RecallOptions) =>
  captureConsole(runRecall(config, options)).pipe(provideTestLayer(ApplicationLayer));
afterEach(() => {
  vi.restoreAllMocks();
});
describe('recall skill catalog intent inference', () => {
  it('does not treat seed-skills maintenance queries as agent skill lookup', () => {
    expect(hasAgentSkillCatalogIntent('threadnote seed skills claude commands')).toBe(false);
    expect(hasAgentSkillCatalogIntent('fix seed-skills not recognizing claude commands')).toBe(false);
    expect(hasAgentSkillCatalogIntent('skill seeding should include repo commands')).toBe(false);
  });
  it('still recognizes explicit skill catalog lookup queries', () => {
    expect(hasAgentSkillCatalogIntent('skills')).toBe(true);
    expect(hasAgentSkillCatalogIntent('find skill for swiftui performance')).toBe(true);
    expect(hasAgentSkillCatalogIntent('show skills that help with release notes')).toBe(true);
    expect(hasAgentSkillCatalogIntent('skills for ios debugging')).toBe(true);
  });
});
describe('runRecall native index', () => {
  it('does not claim verified navigation when a resolved neighbor belongs to an unresolved premise', () => {
    const memoryConnections: RecallMemoryConnectionsResult = {
      candidates: [],
      connections: [
        {
          currentness: 'current',
          direction: 'outgoing',
          distance: 1,
          neighborMemoryId: 'tn_neighbor',
          neighborUri: 'threadnote://memory/tn_neighbor',
          origin: 'relation',
          relationOrdinal: 0,
          relationType: 'references',
          requestedOrdinal: 0,
          resolution: 'resolved',
          sourceMemoryId: 'tn_unresolved_seed',
        },
      ],
      coverage: {connectionCount: 1, premiseCount: 1, resultCount: 1, truncated: true, version: 1},
      diagnostics: {
        canonicalMismatches: 0,
        canonicalRereads: 1,
        currentnessTruncatedMemoryIds: ['tn_unresolved_seed'],
        rawLinkRows: 1,
        refreshRepairs: 0,
        truncatedSeedOrdinals: [0],
      },
      premises: [
        {
          memoryId: 'tn_unresolved_seed',
          requestedOrdinal: 0,
          requestedRef: 'threadnote://memory/tn_unresolved_seed',
          state: 'unresolved',
        },
      ],
    };

    const projected = projectRecallCliResponse({memoryConnections}, true);

    expect(projected.confidence).toBeUndefined();
    expect(projected.sections.join('\n')).toContain('threadnote://memory/tn_neighbor');
    expect(projected.sections.join('\n')).not.toContain('explicit-memory-connection');
    expect(projected.sections.join('\n')).not.toContain('Next: threadnote read');
    expect(projected.sections.join('\n')).toContain('threadnote recall-feedback');
    expect(projected.sections.join('\n')).toContain('applied');
  });

  effectIt.effect('uses the native recall index without a repair subprocess', () =>
    Effect.gen(function* () {
      const {output} = yield* captureRecall(runtime, {
        dryRun: true,
        query: 'availability check',
      });
      expect(output).not.toContain('repair failed');
      expect(output).toContain('Would search native recall index');
      expect(output).toContain('availability check');
    }),
  );
  effectIt.effect('restricts unqualified CLI recall to the caller repository project', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-caller-project-'});
      const manifestPath = path.join(home, 'seed-manifest.yaml');
      yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };
      const outerRepo = path.join(home, 'outer-repository');
      const callerRepo = path.join(home, 'caller-repository');
      yield* fs.makeDirectory(outerRepo, {recursive: true});
      yield* fs.makeDirectory(callerRepo, {recursive: true});
      yield* utils.runCommand('git', ['init', '--quiet'], {cwd: outerRepo});
      yield* utils.runCommand('git', ['remote', 'add', 'origin', 'https://github.com/synthetic/outer-project.git'], {
        cwd: outerRepo,
      });
      yield* utils.runCommand('git', ['init', '--quiet'], {cwd: callerRepo});
      yield* utils.runCommand('git', ['remote', 'add', 'origin', 'https://github.com/synthetic/caller-project.git'], {
        cwd: callerRepo,
      });

      const query = 'orbital gearbox calibration';
      const outerUri = 'threadnote://user/denys/memories/durable/projects/outer-project/orbital.md';
      const callerUri = 'threadnote://user/denys/memories/durable/projects/caller-project/orbital.md';
      const memory = (project: string) =>
        [
          'MEMORY',
          'kind: durable',
          'status: active',
          `project: ${project}`,
          'topic: calibration',
          'source_agent_client: integration-test',
          'timestamp: 2026-09-01T00:00:00.000Z',
          '',
          `The ${query} procedure uses a guarded service boundary.`,
        ].join('\n');
      const store = yield* ResourceStore;
      yield* store.mutate(
        {account: config.account, home, user: config.user},
        [outerUri, callerUri].map((uri, index) => ({
          content: memory(index === 0 ? 'outer-project' : 'caller-project'),
          options: {mode: 'create' as const},
          type: 'write' as const,
          uri,
        })),
      );
      yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false, query});

      const recalled = yield* captureRecall(config, {callerCwd: callerRepo, query});
      expect(recalled.value.ranked.map(candidate => candidate.uri)).toContain(callerUri);
      expect(recalled.value.ranked.map(candidate => candidate.uri)).not.toContain(outerUri);
      expect(recalled.output).toContain('caller-project');
      expect(recalled.output).not.toContain('outer-project');
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
  effectIt.effect('accepts bounded seeded one-hop controls and prints premise evidence', () =>
    Effect.gen(function* () {
      const {output} = yield* captureRecall(runtime, {
        dryRun: true,
        memoryRefs: ['tn_cli_seed'],
        query: 'connection navigation',
        relationTypes: ['depends_on'],
      });
      expect(output).toContain('Memory connections (one hop');
      expect(output).toContain('threadnote://memory/tn_cli_seed [unresolved]');
      expect(output).toContain('Relations are navigation evidence, not entailment.');
    }),
  );
  effectIt.effect('supports seed-only navigation without entering the topical query lane', () =>
    Effect.gen(function* () {
      const {output, value} = yield* captureRecall(runtime, {
        dryRun: true,
        memoryRefs: ['tn_cli_seed_only'],
        relationTypes: ['references'],
      });
      expect(output).toContain('Would expand 1 explicit memory premise(s) by one hop.');
      expect(output).not.toContain('Would search native recall index');
      expect(output).not.toContain('No semantically-relevant matches');
      expect(output).toContain('threadnote://memory/tn_cli_seed_only [unresolved]');
      expect(output).not.toContain('explicit-memory-connection');
      expect(output).not.toContain('Next: threadnote read');
      expect(value.queryExpansions).toEqual([]);
    }),
  );
  effectIt.effect('rejects recall without either a topical query or a memory premise', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(captureRecall(runtime, {dryRun: true, query: '   '}));
      expect(String(failure)).toContain(
        'Threadnote recall needs either a non-empty --query or at least one --memory-ref seed.',
      );
      expect(String(failure)).toContain('threadnote recall --memory-ref tn_example');
    }),
  );
  effectIt.effect('rejects a CLI relation filter without a memory premise', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        captureRecall(runtime, {dryRun: true, query: 'invalid connection controls', relationTypes: ['depends_on']}),
      );
      expect(String(failure)).toContain('--relation-type requires at least one --memory-ref');
    }),
  );
  effectIt.effect('ignores obsolete local-AI service configuration while deterministic recall remains available', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-malformed-local-ai-')));
      yield* Effect.promise(() =>
        mkdir(join(dir, 'threadnote'), {
          recursive: true,
        }),
      );
      yield* Effect.promise(() => writeFile(join(dir, 'threadnote', 'local-ai.json'), '{invalid', 'utf8'));
      const runCommand = vi.spyOn(utils, 'runCommand').mockReturnValue(
        Effect.succeed({
          exitCode: 0,
          stderr: '',
          stdout: '[]',
        }),
      );
      let output = '';
      try {
        output = (yield* captureRecall(
          {
            ...runtime,
            agentContextHome: dir,
            manifestPath: join(dir, 'missing-seed-manifest.yaml'),
          },
          {
            inferScope: false,
            query: 'deterministic fallback',
          },
        )).output;
      } finally {
        runCommand.mockRestore();
        yield* Effect.promise(() =>
          rm(dir, {
            force: true,
            recursive: true,
          }),
        );
      }
      expect(output).not.toContain('Invalid Threadnote local AI configuration');
      expect(output).not.toContain('background service');
    }),
  );
  effectIt.effect('adds remote-derived project memory scopes for current repo recall', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-remote-project-')));
      const repoRoot = join(dir, 'easy-to-type');
      const previousCallerCwd = inheritedProcessEnvironment().THREADNOTE_CALLER_CWD;
      const gitEnvKeys = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;
      const previousGitEnv = new Map(gitEnvKeys.map(key => [key, inheritedProcessEnvironment()[key]]));
      for (const key of gitEnvKeys) {
        delete inheritedProcessEnvironment()[key];
      }
      let output = '';
      try {
        yield* Effect.promise(() => mkdir(repoRoot));
        yield* utils
          .runCommand('git', ['init'], {
            cwd: repoRoot,
          })
          .pipe(provideTestLayer(ApplicationLayer));
        yield* utils
          .runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {
            cwd: repoRoot,
          })
          .pipe(provideTestLayer(ApplicationLayer));
        inheritedProcessEnvironment().THREADNOTE_CALLER_CWD = repoRoot;
        output = (yield* captureRecall(
          {
            ...runtime,
            manifestPath: join(dir, 'missing-seed-manifest.yaml'),
          },
          {
            dryRun: true,
            query: 'current repo latest handoff',
          },
        )).output;
      } finally {
        if (previousCallerCwd === undefined) {
          delete inheritedProcessEnvironment().THREADNOTE_CALLER_CWD;
        } else {
          inheritedProcessEnvironment().THREADNOTE_CALLER_CWD = previousCallerCwd;
        }
        for (const key of gitEnvKeys) {
          const value = previousGitEnv.get(key);
          if (value === undefined) {
            delete inheritedProcessEnvironment()[key];
          } else {
            inheritedProcessEnvironment()[key] = value;
          }
        }
        yield* Effect.promise(() =>
          rm(dir, {
            force: true,
            recursive: true,
          }),
        );
      }
      expect(output).toContain('current repo latest handoff');
      expect(output).toContain('threadnote');
      expect(output).toContain('--uri threadnote://user/denys/memories/durable/projects/threadnote');
      expect(output).toContain('--uri threadnote://user/denys/memories/handoffs/active/threadnote');
      expect(output).not.toContain('easy-to-type');
    }),
  );
  effectIt.effect('prefers a project named by the query over the current workspace project', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-query-project-')));
      const repoRoot = join(dir, 'easy-to-type');
      const manifestPath = join(dir, 'seed-manifest.yaml');
      const previousCallerCwd = inheritedProcessEnvironment().THREADNOTE_CALLER_CWD;
      const gitEnvKeys = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;
      const previousGitEnv = new Map(gitEnvKeys.map(key => [key, inheritedProcessEnvironment()[key]]));
      for (const key of gitEnvKeys) {
        delete inheritedProcessEnvironment()[key];
      }
      let output = '';
      try {
        yield* Effect.promise(() => mkdir(repoRoot));
        yield* utils
          .runCommand('git', ['init'], {
            cwd: repoRoot,
          })
          .pipe(provideTestLayer(ApplicationLayer));
        yield* utils
          .runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {
            cwd: repoRoot,
          })
          .pipe(provideTestLayer(ApplicationLayer));
        yield* Effect.promise(() =>
          writeFile(
            manifestPath,
            [
              'version: 1',
              'projects:',
              '  - name: threadnote',
              `    path: ${repoRoot}`,
              '    uri: threadnote://resources/repos/threadnote',
              '    seed: []',
              '  - name: orion-worker',
              `    path: ${dir}/orion-worker`,
              '    uri: threadnote://resources/repos/orion-worker',
              '    seed: []',
              '',
            ].join('\n'),
            'utf8',
          ),
        );
        inheritedProcessEnvironment().THREADNOTE_CALLER_CWD = repoRoot;
        output = (yield* captureRecall(
          {
            ...runtime,
            manifestPath,
          },
          {
            dryRun: true,
            query: 'worker lease renewal',
          },
        )).output;
      } finally {
        if (previousCallerCwd === undefined) {
          delete inheritedProcessEnvironment().THREADNOTE_CALLER_CWD;
        } else {
          inheritedProcessEnvironment().THREADNOTE_CALLER_CWD = previousCallerCwd;
        }
        for (const key of gitEnvKeys) {
          const value = previousGitEnv.get(key);
          if (value === undefined) {
            delete inheritedProcessEnvironment()[key];
          } else {
            inheritedProcessEnvironment()[key] = value;
          }
        }
        yield* Effect.promise(() =>
          rm(dir, {
            force: true,
            recursive: true,
          }),
        );
      }
      expect(output).toContain('--uri threadnote://user/denys/memories/durable/projects/orion-worker');
      expect(output).toContain('--uri threadnote://resources/repos/orion-worker');
      expect(output).not.toContain('--uri threadnote://user/denys/memories/durable/projects/threadnote');
    }),
  );
  effectIt.effect('does not duplicate current project durable scope through workset expansion', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-workset-dedupe-')));
      const repoRoot = join(dir, 'easy-to-type');
      const manifestPath = join(dir, 'seed-manifest.yaml');
      const previousCallerCwd = inheritedProcessEnvironment().THREADNOTE_CALLER_CWD;
      const gitEnvKeys = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;
      const previousGitEnv = new Map(gitEnvKeys.map(key => [key, inheritedProcessEnvironment()[key]]));
      for (const key of gitEnvKeys) {
        delete inheritedProcessEnvironment()[key];
      }
      let output = '';
      try {
        yield* Effect.promise(() => mkdir(repoRoot));
        yield* utils
          .runCommand('git', ['init'], {
            cwd: repoRoot,
          })
          .pipe(provideTestLayer(ApplicationLayer));
        yield* utils
          .runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {
            cwd: repoRoot,
          })
          .pipe(provideTestLayer(ApplicationLayer));
        yield* Effect.promise(() =>
          writeFile(
            manifestPath,
            [
              'version: 1',
              'projects:',
              '  - name: threadnote',
              `    path: ${repoRoot}`,
              '    uri: threadnote://resources/repos/threadnote',
              '    seed: []',
              'worksets:',
              '  - name: platform',
              '    projects: [threadnote]',
              '',
            ].join('\n'),
            'utf8',
          ),
        );
        inheritedProcessEnvironment().THREADNOTE_CALLER_CWD = repoRoot;
        output = (yield* captureRecall(
          {
            ...runtime,
            manifestPath,
          },
          {
            dryRun: true,
            query: 'current repo latest handoff',
            workset: 'platform',
          },
        )).output;
      } finally {
        if (previousCallerCwd === undefined) {
          delete inheritedProcessEnvironment().THREADNOTE_CALLER_CWD;
        } else {
          inheritedProcessEnvironment().THREADNOTE_CALLER_CWD = previousCallerCwd;
        }
        for (const key of gitEnvKeys) {
          const value = previousGitEnv.get(key);
          if (value === undefined) {
            delete inheritedProcessEnvironment()[key];
          } else {
            inheritedProcessEnvironment()[key] = value;
          }
        }
        yield* Effect.promise(() =>
          rm(dir, {
            force: true,
            recursive: true,
          }),
        );
      }
      const durableScope = '--uri threadnote://user/denys/memories/durable/projects/threadnote';
      expect(output.split(durableScope)).toHaveLength(2);
    }),
  );
  effectIt.effect('honors an explicit workset when inference is disabled', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-workset-')));
      const manifestPath = join(dir, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: alpha',
            `    path: ${dir}/alpha`,
            '    uri: threadnote://resources/repos/alpha',
            '    seed: []',
            'worksets:',
            '  - name: platform',
            '    projects: [alpha]',
            '',
          ].join('\n'),
          'utf8',
        ),
      );
      let output = '';
      try {
        output = (yield* captureRecall(
          {
            ...runtime,
            manifestPath,
          },
          {
            dryRun: true,
            inferScope: false,
            query: 'current status',
            workset: 'platform',
          },
        )).output;
      } finally {
        yield* Effect.promise(() =>
          rm(dir, {
            force: true,
            recursive: true,
          }),
        );
      }
      expect(output).toContain('Workset scope: platform (alpha)');
      expect(output).toContain('threadnote://resources/repos/alpha');
    }),
  );
  effectIt.effect('reports an unknown explicit workset instead of running unscoped', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-missing-workset-')));
      const manifestPath = join(dir, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: alpha',
            `    path: ${dir}/alpha`,
            '    uri: threadnote://resources/repos/alpha',
            '    seed: []',
            'worksets:',
            '  - name: platform',
            '    projects: [alpha]',
            '',
          ].join('\n'),
          'utf8',
        ),
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        expect(
          String(
            yield* Effect.flip(
              runRecall(
                {
                  ...runtime,
                  manifestPath,
                },
                {
                  dryRun: true,
                  query: 'current status',
                  workset: 'platfrom',
                },
              ).pipe(provideTestLayer(ApplicationLayer)),
            ),
          ),
        ).toContain(`No workset named "platfrom" in ${manifestPath}.`);
      } finally {
        yield* Effect.promise(() =>
          rm(dir, {
            force: true,
            recursive: true,
          }),
        );
      }
      expect(log.mock.calls.map(call => call.join(' ')).join('\n')).not.toContain('/ov search');
    }),
  );
  effectIt.effect('validates an explicit workset before a pinned uri search', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-recall-pinned-workset-')));
      const manifestPath = join(dir, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: alpha',
            `    path: ${dir}/alpha`,
            '    uri: threadnote://resources/repos/alpha',
            '    seed: []',
            'worksets:',
            '  - name: platform',
            '    projects: [alpha]',
            '',
          ].join('\n'),
          'utf8',
        ),
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        expect(
          String(
            yield* Effect.flip(
              runRecall(
                {
                  ...runtime,
                  manifestPath,
                },
                {
                  dryRun: true,
                  query: 'current status',
                  uri: 'threadnote://resources/repos/alpha',
                  workset: 'platfrom',
                },
              ).pipe(provideTestLayer(ApplicationLayer)),
            ),
          ),
        ).toContain(`No workset named "platfrom" in ${manifestPath}.`);
      } finally {
        yield* Effect.promise(() =>
          rm(dir, {
            force: true,
            recursive: true,
          }),
        );
      }
      expect(log.mock.calls.map(call => call.join(' ')).join('\n')).not.toContain('/ov search');
    }),
  );
});
describe('stripAdvancedSearchFlags', () => {
  it('removes --threshold and --level with their values, keeping the rest', () => {
    expect(
      stripAdvancedSearchFlags(['search', 'q', '--threshold', '0.45', '--level', '2', '--uri', 'threadnote://x']),
    ).toEqual(['search', 'q', '--uri', 'threadnote://x']);
  });
  it('is a no-op when no advanced flags are present', () => {
    expect(stripAdvancedSearchFlags(['search', 'q', '--node-limit', '5'])).toEqual([
      'search',
      'q',
      '--node-limit',
      '5',
    ]);
  });
});
