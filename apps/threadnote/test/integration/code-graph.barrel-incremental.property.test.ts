import {Array as EffectArray, Option as EffectOption} from 'effect';
import {pipe as EffectArrayPipe} from 'effect';

import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'fast-check';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {compareCodeUnits} from '@threadnote/graph/ordering';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphStore, type StoredCodeGraph} from '@threadnote/graph/store';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const barrelScenarioArbitrary = FC.record({
  barrelDepth: FC.integer({max: 4, min: 1}),
  cleanZero: FC.boolean(),
  cleanTwo: FC.boolean(),
  dirtyZero: FC.boolean(),
  dirtyTwo: FC.boolean(),
  revision: FC.integer({max: 10_000, min: 1}),
}).map(({barrelDepth, cleanTwo, cleanZero, dirtyTwo, dirtyZero, revision}) => ({
  barrelDepth,
  cleanArities: EffectArray.filter([cleanZero ? 0 : -1, cleanTwo ? 2 : -1], arity => arity >= 0),
  dirtyArities: EffectArray.filter([dirtyZero ? 0 : -1, dirtyTwo ? 2 : -1], arity => arity >= 0),
  revision,
}));

describe('code graph incremental barrel differential properties', () => {
  fcEffectProp(
    it,
    'matches a full rebuild through randomized transitive and cyclic named barrels',
    {scenario: barrelScenarioArbitrary},
    ({scenario}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const command = yield* CommandExecutor;
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-barrel-property-'});
          const homesRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-barrel-homes-'});
          const sourceRoot = path.join(root, 'src');
          const incrementalHome = path.join(homesRoot, 'incremental');
          const fullHome = path.join(homesRoot, 'full');
          const writeConsumer = (arities: readonly number[], revision: number) => {
            const calls = EffectArray.map(arities, arity => (arity === 0 ? 'decode()' : 'decode("a", "b")'));
            return fs.writeFileString(
              path.join(sourceRoot, 'use.ts'),
              EffectArray.join(
                [
                  `import {decode} from './barrel-${scenario.barrelDepth - 1}.js';`,
                  'export function useDecode(): string {',
                  `  const revision = ${revision};`,
                  `  return [String(revision)${EffectArray.join(
                    EffectArray.map(calls, call => `, ${call}`),
                    '',
                  )}].join(":");`,
                  '}',
                  '',
                ],
                '\n',
              ),
            );
          };

          yield* fs.makeDirectory(sourceRoot, {recursive: true});
          yield* fs.writeFileString(
            path.join(sourceRoot, 'declarations.ts'),
            EffectArray.join(
              [
                'export declare function decode(): string;',
                'export declare function decode(a: string, b: string): string;',
                '',
              ],
              '\n',
            ),
          );
          yield* fs.writeFileString(path.join(sourceRoot, 'cycle-a.ts'), 'export {decode} from "./cycle-b.js";\n');
          yield* fs.writeFileString(
            path.join(sourceRoot, 'cycle-b.ts'),
            EffectArray.join(
              ['export {decode} from "./cycle-a.js";', 'export {decode} from "./declarations.js";', ''],
              '\n',
            ),
          );
          for (let index = 0; index < scenario.barrelDepth; index += 1) {
            const target = index === 0 ? 'cycle-a' : `barrel-${index - 1}`;
            yield* fs.writeFileString(
              path.join(sourceRoot, `barrel-${index}.ts`),
              `export {decode} from "./${target}.js";\n`,
            );
          }
          yield* writeConsumer(scenario.cleanArities, 0);
          yield* command.execute('git', ['init', '-q'], {cwd: root});
          yield* command.execute('git', ['add', '.'], {cwd: root});
          yield* command.execute(
            'git',
            [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '-qm',
              'barrel property fixture',
            ],
            {cwd: root},
          );

          yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          yield* writeConsumer(scenario.dirtyArities, scenario.revision);
          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
          const incrementalLayout = codeGraphLayout(
            path,
            incrementalHome,
            incremental.identity.checkoutId,
            incremental.identity.worktreeId,
          );
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
          const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
          const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);

          expect(incremental.materialization).toEqual({
            mode: 'incremental-overlay',
            resolutionLookupKeyForm: 'typescript-path-unscoped',
            resolutionPublicationGate: 'own-path-local',
            stagedFiles: 1,
            totalFiles: scenario.barrelDepth + 4,
          });
          expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
          const resolvedArities = new Set(
            EffectArray.flatMap(
              EffectArrayPipe(incrementalGraph.edges, __effectFilterValues =>
                EffectArray.filter(
                  __effectFilterValues,
                  (edge, __effectFilterIndex) =>
                    __effectFilterIndex in __effectFilterValues &&
                    edge.relation === 'calls' &&
                    edge.targetName === 'decode' &&
                    edge.targetId !== undefined,
                ),
              ),
              edge => {
                const target = EffectOption.getOrUndefined(
                  EffectArray.findFirst(incrementalGraph.symbols, symbol => symbol.id === edge.targetId),
                );
                return target?.arity === undefined ? [] : [target.arity];
              },
            ),
          );
          expect(resolvedArities).toEqual(new Set(scenario.dirtyArities));
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {
      fastCheck: {interruptAfterTimeLimit: 180_000, markInterruptAsFailure: true, numRuns: 6},
      timeout: 190_000,
    },
  );
});

function normalizeGraph(graph: StoredCodeGraph): Pick<StoredCodeGraph, 'edges' | 'symbols'> {
  return {
    edges: [...graph.edges].sort((left, right) => compareCodeUnits(left.id, right.id)),
    symbols: [...graph.symbols].sort((left, right) => compareCodeUnits(left.id, right.id)),
  };
}
