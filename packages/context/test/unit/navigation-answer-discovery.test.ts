import * as EffectString from 'effect/String';
import * as EffectOption from 'effect/Option';
import * as EffectArray from 'effect/Array';
import {expect, vi} from 'vitest';
import * as sourceFacts from '../../src/navigation/source_facts.js';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphParserPool} from '@threadnote/graph/parser_worker';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphObservability, CodeGraphProcessActivity} from '@threadnote/graph/runtime_ports';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {makeReadDeadline} from '@threadnote/platform/read_deadline';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect} from '@threadnote/platform/command';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {retrieveTaskNavigationAnswer} from '@threadnote/context/navigation/discovery';
import type {TaskDiscoveryBudget} from '@threadnote/graph/query/task_discovery';

const frozen = [
  {
    id: 'a.ts',
    language: 'ts',
    path: 'a.ts',
    sourceSha256: 'fe74764ddaa7c45ecfd3f0b4d4df14c100fe4438117ab7a32dcc42c9e9847fec',
    expectedOwner: {
      name: 'f',
      kind: 'function',
      span: {
        startLine: 1,
        startColumn: 1,
        endLine: 8,
        endColumn: 2,
      },
    },
    expectedNeighbor: {
      name: 'g',
      kind: 'function',
      span: {
        startLine: 10,
        startColumn: 1,
        endLine: 12,
        endColumn: 2,
      },
      basis: 'direct same-file call from g to f; source expression independently inspected',
    },
    naturalBehaviorPrompt: 'Which routine repeatedly collects pending items?',
    sourceText:
      'export function f(limit: number): number {\n  let count = 0;\n  while (count < limit) {\n    count += 1;\n  }\n  console.info("collector pending items", count);\n  return count;\n}\n\nexport function g(limit: number): number {\n  return f(limit);\n}\n',
    oracleComment:
      'Source inspection supports a candidate and direct-call neighbor only. Textual clues do not prove executed behavior, Python binding, or a qualified effect observation. TS/Python journal code contains an append operation syntactically; that is not evidence it ran.',
  },
  {
    id: 'b.ts',
    language: 'ts',
    path: 'b.ts',
    sourceSha256: 'ecd39fe2c2e3a7ed43a59c82972c383af350dbba8011cd4524b3caa2c4eb16ac',
    expectedOwner: {
      name: 'f',
      kind: 'function',
      span: {
        startLine: 3,
        startColumn: 1,
        endLine: 7,
        endColumn: 2,
      },
    },
    expectedNeighbor: {
      name: 'g',
      kind: 'function',
      span: {
        startLine: 9,
        startColumn: 1,
        endLine: 11,
        endColumn: 2,
      },
      basis: 'direct same-file call from g to f; source expression independently inspected',
    },
    naturalBehaviorPrompt: 'Where is text appended to a journal file?',
    sourceText:
      'import {appendFile} from "node:fs/promises";\n\nexport async function f(x: string, y: string): Promise<void> {\n  const line = `${y}\\n`;\n  await appendFile(x, line, "utf8");\n  console.info("appended journal text", x);\n}\n\nexport async function g(x: string, y: string): Promise<void> {\n  await f(x, y);\n}\n',
    oracleComment:
      'Source inspection supports a candidate and direct-call neighbor only. Textual clues do not prove executed behavior, Python binding, or a qualified effect observation. TS/Python journal code contains an append operation syntactically; that is not evidence it ran.',
  },
  {
    id: 'a.py',
    language: 'py',
    path: 'a.py',
    sourceSha256: '1a18b9d25deeafc0ad67951e74333b9e6a6a67c4bf51b885daf81ebdaf9d177e',
    expectedOwner: {
      name: 'f',
      kind: 'function',
      span: {
        startLine: 1,
        startColumn: 1,
        endLine: 6,
        endColumn: 17,
      },
    },
    expectedNeighbor: {
      name: 'g',
      kind: 'function',
      span: {
        startLine: 8,
        startColumn: 1,
        endLine: 9,
        endColumn: 20,
      },
      basis: 'direct same-file call from g to f; source expression independently inspected',
    },
    naturalBehaviorPrompt: 'Which routine repeatedly collects pending items?',
    sourceText:
      'def f(limit):\n    count = 0\n    while count < limit:\n        count += 1\n    print("collector pending items", count)\n    return count\n\ndef g(limit):\n    return f(limit)\n',
    oracleComment:
      'Source inspection supports a candidate and direct-call neighbor only. Textual clues do not prove executed behavior, Python binding, or a qualified effect observation. TS/Python journal code contains an append operation syntactically; that is not evidence it ran.',
  },
  {
    id: 'b.py',
    language: 'py',
    path: 'b.py',
    sourceSha256: '6740f7d63336e6634d3ffead3c7969d2cd48cad47b5d4cd6a059cf90155f7c8c',
    expectedOwner: {
      name: 'f',
      kind: 'function',
      span: {
        startLine: 1,
        startColumn: 1,
        endLine: 4,
        endColumn: 38,
      },
    },
    expectedNeighbor: {
      name: 'g',
      kind: 'function',
      span: {
        startLine: 6,
        startColumn: 1,
        endLine: 7,
        endColumn: 19,
      },
      basis: 'direct same-file call from g to f; source expression independently inspected',
    },
    naturalBehaviorPrompt: 'Where is text appended to a journal file?',
    sourceText:
      'def f(x, y):\n    with open(x, "a", encoding="utf-8") as journal:\n        journal.write(f"{y}\\n")\n    print("appended journal text", x)\n\ndef g(x, y):\n    return f(x, y)\n',
    oracleComment:
      'Source inspection supports a candidate and direct-call neighbor only. Textual clues do not prove executed behavior, Python binding, or a qualified effect observation. TS/Python journal code contains an append operation syntactically; that is not evidence it ran.',
  },
] as const;
const platform = Layer.effect(
  SystemInfo,
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return SystemInfo.of({
      ...system,
      developmentEntrypoint: yield* path.fromFileUrl(
        new URL('../../../../apps/threadnote/src/standalone.ts', import.meta.url),
      ),
      environment: () => ({...system.environment(), THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '1'}),
    });
  }),
).pipe(Layer.provideMerge(citationPlatformLayer));
const ports = Layer.mergeAll(
  Layer.succeed(CodeGraphProcessActivity, {withActivity: (_role, _operation, program) => program}),
  Layer.succeed(CodeGraphObservability, {
    makeBuildReporter: () =>
      Effect.succeed({
        observeExtractedFactBytes: () => Effect.void,
        observeInventory: () => Effect.void,
        observeOverlay: () => Effect.void,
        progress: () => Effect.void,
        terminal: () => Effect.void,
      }),
    makeWorksetReporter: Effect.succeed({
      failure: () => Effect.void,
      progress: () => Effect.void,
      terminal: () => Effect.void,
    }),
    backgroundFailure: () => Effect.void,
  }),
  Layer.succeed(CodeGraphEmbeddingIndex, {
    check: () => Effect.succeed({state: 'unavailable' as const, reason: 'vectors disabled'}),
    ensure: () => Effect.die('No inference'),
    search: () => Effect.die('No query inference'),
  }),
  FetchHttpClient.layer,
);
const base = Layer.mergeAll(platform, ports);
const storeLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(base));
const dependencies = Layer.mergeAll(
  CodeGraphMaintenanceCoordinator.layer.pipe(Layer.provideMerge(storeLayer)),
  CodeGraphParserPool.layer.pipe(Layer.provideMerge(base)),
  TreeSitterRuntime.layer.pipe(Layer.provideMerge(base)),
  CodeGraphLanguagePackRegistry.layer,
);

effectIt.layer(citationPlatformLayer)(it => {
  for (const oracle of frozen)
    it.effect(
      `projects first working ${oracle.path} body candidate and structural caller without effect claims`,
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'task-answer-'});
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const fixtureServices = yield* Layer.build(dependencies);
                return yield* Effect.gen(function* () {
                  const cwd = path.join(root, 'repo');
                  const home = path.join(root, 'home');
                  yield* fs.makeDirectory(cwd);
                  yield* fs.makeDirectory(home);
                  expect(sha256HexSync(oracle.sourceText)).toBe(oracle.sourceSha256);
                  yield* fs.writeFileString(path.join(cwd, oracle.path), oracle.sourceText);
                  for (let i = 0; i < 16; i += 1) {
                    const content =
                      oracle.language === 'ts'
                        ? `/** ${oracle.naturalBehaviorPrompt} */\nexport function constant${i}() { return 0; }\n`
                        : `# ${oracle.naturalBehaviorPrompt}\ndef constant${i}():\n    return 0\n`;
                    yield* fs.writeFileString(path.join(cwd, `decoy${i}.${oracle.language}`), content);
                  }
                  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
                  yield* git(['init', '--quiet']);
                  yield* git(['add', '.']);
                  yield* git([
                    '-c',
                    'user.name=Fixture',
                    '-c',
                    'user.email=fixture@example.invalid',
                    '-c',
                    'core.hooksPath=/dev/null',
                    '-c',
                    'commit.gpgsign=false',
                    'commit',
                    '-qm',
                    'oracle',
                  ]);
                  const context = yield* Layer.build(CodeGraphIndexer.layer);
                  const indexer = Context.get(context, CodeGraphIndexer);
                  const summary = yield* indexer.index({
                    cwd,
                    threadnoteHome: home,
                    sourceOnly: true,
                    vectorPolicy: 'off',
                  });
                  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
                  const observation = {
                    repository: {
                      repositoryId: summary.identity.repositoryId,
                      displayName: summary.identity.displayName,
                    },
                    snapshot: {
                      id: summary.snapshot.id,
                      commit: summary.snapshot.commit,
                      worktreeId: summary.snapshot.worktreeId,
                      dirty: summary.snapshot.dirty,
                    },
                    freshness: 'current' as const,
                  };
                  const scope = {
                    repository: summary.identity.repositoryId,
                    worktree: summary.identity.worktreeId,
                    project: 'fixture',
                    view: {kind: 'disk' as const, id: 'disk', owner: 'fixture', epoch: 1},
                  };
                  const budget: TaskDiscoveryBudget = {
                    remainingReads: 17,
                    remainingBytes: 4 * 1024 * 1024,
                    remainingNodes: 12,
                    remainingEdges: 1,
                    deadline: yield* makeReadDeadline(1500),
                  };
                  const answer = yield* retrieveTaskNavigationAnswer({
                    databasePath: layout.databasePath,
                    observation,
                    task: oracle.naturalBehaviorPrompt,
                    budget,
                    identity: summary.identity,
                    repositoryKey: 'fixture',
                    scope,
                  });
                  const owner = answer.discovery!.result.nodes[0];
                  const caller = EffectOption.getOrUndefined(
                    EffectArray.findFirst(answer.discovery!.result.nodes, node => node.name === 'g'),
                  );
                  expect(owner).toMatchObject({name: 'f', path: oracle.path});
                  expect(caller).toBeDefined();
                  expect(EffectArray.map(answer.structural.answer.nodes, node => node.id)).toContain(owner.id);
                  expect(EffectArray.map(answer.structural.answer.nodes, node => node.id)).toContain(caller!.id);
                  expect(
                    EffectOption.getOrUndefined(
                      EffectArray.findFirst(answer.structural.answer.roles, role => role.role === 'entrypoint'),
                    )!.nodeIds,
                  ).toContain(caller!.id);
                  expect(
                    EffectArray.some(answer.projection.structuredContent.nodes, node => node[0] === owner.id),
                  ).toBe(true);
                  expect(answer.projection.structuredContent.effects).toEqual([]);
                  expect(answer.structural.proofLocators).toEqual([]);
                  expect(answer.discovery!.evidence.vector.ran).toBe(false);
                  expect(answer.stageMilliseconds.pureCombined).toBeGreaterThanOrEqual(0);
                  expect(answer.stageMilliseconds.pureCombined).toBeCloseTo(
                    answer.stageMilliseconds.normalization +
                      answer.stageMilliseconds.assembly +
                      answer.stageMilliseconds.projection,
                    5,
                  );
                  expect(answer.stageMilliseconds.total).toBeGreaterThanOrEqual(answer.stageMilliseconds.pureCombined);
                  expect(budget.remainingReads).toBeGreaterThanOrEqual(0);
                  expect(budget.remainingBytes).toBeGreaterThanOrEqual(0);
                  // An already validated explicit anchor uses the same snapshot and never reruns task discovery.
                  const anchored = {...answer.discovery!.result, nodes: [caller!], edges: []};
                  const anchoredAnswer = yield* retrieveTaskNavigationAnswer({
                    databasePath: '/unused',
                    observation,
                    task: 'unrelated behavior',
                    anchoredResult: anchored,
                    budget: {...budget, remainingBytes: 1024},
                    identity: summary.identity,
                    repositoryKey: 'fixture',
                    scope,
                  });
                  expect(anchoredAnswer.discovery).toBeUndefined();
                  expect(EffectArray.map(anchoredAnswer.structural.answer.nodes, node => node.id)).toEqual([
                    caller!.id,
                  ]);
                }).pipe(Effect.provideContext(fixtureServices));
              }),
            );
          }),
        ),
      30000,
    );
});

effectIt.layer(citationPlatformLayer)(it => {
  it.effect('denies exhausted inherited allowances before opening the unused database', () =>
    Effect.gen(function* () {
      const observation = {
        repository: {repositoryId: 'r', displayName: 'fixture'},
        snapshot: {id: 's', commit: 'c', worktreeId: 'w', dirty: false},
        freshness: 'current' as const,
      };
      const identity = {
        caseMode: 'sensitive',
        checkoutId: 'fixture',
        displayName: 'fixture',
        gitCommonDirectory: '/unused',
        headCommit: 'c',
        objectFormat: 'sha1',
        repoRoot: '/unused',
        repositoryId: 'r',
        worktreeId: 'w',
      } as const;
      const scope = {
        repository: 'r',
        worktree: 'w',
        project: 'fixture',
        view: {kind: 'disk' as const, id: 'disk', owner: 'fixture', epoch: 0},
      };
      const deadline = yield* makeReadDeadline(10);
      yield* TestClock.adjust(10);
      const budget = {
        remainingReads: 17,
        remainingBytes: 4 * 1024 * 1024,
        remainingNodes: 12,
        remainingEdges: 1,
        deadline,
      };
      const answer = yield* retrieveTaskNavigationAnswer({
        databasePath: '/unused',
        observation,
        identity,
        repositoryKey: 'fixture',
        scope,
        task: 'collect pending items',
        budget,
      });
      expect(answer.discovery!.evidence.counters.reads).toBe(0);
      expect(budget.remainingReads).toBe(17);
      expect(answer.structural.answer.nodes).toEqual([]);
      expect(answer.structural.answer.gaps).toContain('task-budget-exhausted');
    }),
  );
});

effectIt.layer(citationPlatformLayer)(it => {
  it.effect(
    'preserves source-supported test callers and denies large retained source behind a tiny excerpt before acquisition',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'task-source-retention-'});
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(dependencies);
              return yield* Effect.gen(function* () {
                const cwd = path.join(root, 'repo');
                const home = path.join(root, 'home');
                yield* fs.makeDirectory(path.join(cwd, 'src'), {recursive: true});
                yield* fs.makeDirectory(path.join(cwd, 'test'));
                yield* fs.makeDirectory(home);
                const content =
                  'export function f(){console.info("pending items");}\n' +
                  EffectString.repeat(200)('\n') +
                  '/*' +
                  EffectString.repeat(500000)('x') +
                  '*/\n';
                yield* fs.writeFileString(path.join(cwd, 'src/a.ts'), content);
                yield* fs.writeFileString(
                  path.join(cwd, 'test/a.test.ts'),
                  'import {f} from "../src/a";\nexport function check(){return f();}\n',
                );
                const git = (args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
                yield* git(['init', '--quiet']);
                yield* git(['add', '.']);
                yield* git([
                  '-c',
                  'user.name=Fixture',
                  '-c',
                  'user.email=fixture@example.invalid',
                  '-c',
                  'core.hooksPath=/dev/null',
                  '-c',
                  'commit.gpgsign=false',
                  'commit',
                  '-qm',
                  'regression',
                ]);
                const context = yield* Layer.build(CodeGraphIndexer.layer);
                const indexer = Context.get(context, CodeGraphIndexer);
                const summary = yield* indexer.index({
                  cwd,
                  threadnoteHome: home,
                  sourceOnly: true,
                  vectorPolicy: 'off',
                });
                const databasePath = codeGraphLayout(
                  path,
                  home,
                  summary.identity.checkoutId,
                  summary.identity.worktreeId,
                ).databasePath;
                const observation = {
                  repository: {repositoryId: summary.identity.repositoryId, displayName: summary.identity.displayName},
                  snapshot: {
                    id: summary.snapshot.id,
                    commit: summary.snapshot.commit,
                    worktreeId: summary.snapshot.worktreeId,
                    dirty: false,
                  },
                  freshness: 'current' as const,
                };
                const scope = {
                  repository: summary.identity.repositoryId,
                  worktree: summary.identity.worktreeId,
                  project: 'fixture',
                  view: {kind: 'disk' as const, id: 'disk', owner: 'fixture', epoch: 0},
                };
                const request = {
                  databasePath,
                  observation,
                  identity: summary.identity,
                  repositoryKey: 'fixture',
                  scope,
                  task: 'pending items',
                };
                const budget = {
                  remainingReads: 17,
                  remainingBytes: 4 * 1024 * 1024,
                  remainingNodes: 12,
                  remainingEdges: 2,
                  deadline: yield* makeReadDeadline(1500),
                };
                const answer = yield* retrieveTaskNavigationAnswer({...request, budget});
                const caller = EffectOption.getOrUndefined(
                  EffectArray.findFirst(
                    answer.structural.input.candidates,
                    candidate => candidate.testAssociation === 'source-supported',
                  ),
                );
                expect(caller?.roles).toEqual(['tests']);
                expect(
                  EffectOption.getOrUndefined(
                    EffectArray.findFirst(answer.structural.answer.roles, role => role.role === 'tests'),
                  )!.nodeIds,
                ).toContain(caller!.id);
                expect(answer.byteAccounting.retainedSourceReservedBytes).toBe(3 * 512 * 1024);
                expect(answer.byteAccounting.retainedSourceChargedUpperBoundBytes).toBe(3 * 512 * 1024);
                expect(answer.byteAccounting.retainedSourceActualBytes).toBeNull();
                expect(answer.byteAccounting.excerptBytes).toBeLessThan(Buffer.byteLength(content));
                expect(4 * 1024 * 1024 - budget.remainingBytes).toBeGreaterThanOrEqual(3 * 512 * 1024);
                const acquire = vi.spyOn(sourceFacts, 'retrieveNavigationSourceProofs');
                yield* Effect.addFinalizer(() => Effect.sync(() => acquire.mockRestore()));
                const tiny = {
                  remainingReads: 17,
                  remainingBytes: 3 * 1024 * 1024,
                  remainingNodes: 12,
                  remainingEdges: 2,
                  deadline: yield* makeReadDeadline(1500),
                };
                const denied = yield* retrieveTaskNavigationAnswer({
                  ...request,
                  anchoredResult: answer.discovery!.result,
                  budget: tiny,
                });
                expect(acquire).not.toHaveBeenCalled();
                expect(tiny.remainingReads).toBe(17);
                expect(tiny.remainingBytes).toBe(3 * 1024 * 1024);
                expect(denied.byteAccounting.retainedSourceReservedBytes).toBe(0);
                expect(denied.structural.answer.gaps).toContain('task-source-byte-or-read-reserve-unavailable');
              }).pipe(Effect.provideContext(services));
            }),
          );
        }),
      ),
    30000,
  );
});
