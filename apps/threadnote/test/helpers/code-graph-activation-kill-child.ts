import {TestError} from '@threadnote/testing/test-error';
import {Console, Effect} from 'effect';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {runEffect} from './effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const databasePath = Bun.argv[2];
if (!databasePath) throw TestError.make({message: 'Expected the code-graph database path as the first argument.'});

const identity: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
  displayName: 'materialization-kill-fixture',
  gitCommonDirectory: databasePath,
  headCommit: Effect2.pipe('1', EffectString.repeat(40)),
  objectFormat: 'sha1',
  repoRoot: databasePath,
  repositoryId: Effect2.pipe('r', EffectString.repeat(64)),
  worktreeId: Effect2.pipe('w', EffectString.repeat(64)),
};
const file: CodeGraphInventoryFile = {
  blobId: Effect2.pipe('b', EffectString.repeat(40)),
  contentHash: Effect2.pipe('h', EffectString.repeat(64)),
  language: 'typescript',
  mode: '100644',
  path: 'src/materialization.ts',
  size: 128,
  source: 'commit',
};
const original = activationSymbol('original');
const replacements = Array.from({length: 5_100}, (_, index) =>
  activationSymbol(`replacement-${Effect2.pipe(String(index), EffectString.padStart(5, '0'))}`),
);
const originalSnapshot = activationSnapshot(identity, 1);
const interruptedSnapshot = activationSnapshot(identity, replacements.length);
let paused = false;

await runEffect(
  Effect.gen(function* () {
    const store = yield* CodeGraphStore;
    yield* store.withSession(
      databasePath,
      Effect.gen(function* () {
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [original], []);
        yield* store.activateStaged(databasePath, identity, originalSnapshot);
        yield* store.promote(databasePath, identity, originalSnapshot.id);

        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, replacements, []);
        yield* store.activateStaged(databasePath, identity, interruptedSnapshot, undefined, undefined, progress => {
          if (paused || progress.stage !== 'copying-symbols' || progress.state !== 'progress') return Effect.void;
          paused = true;
          return Console.log(JSON.stringify({event: 'activation-chunk-committed', rows: progress.rows})).pipe(
            Effect.andThen(Effect.never),
          );
        });
      }),
    );
  }),
);

function activationSymbol(id: string): CodeGraphSymbol {
  return {
    contentHash: `hash-${id}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:name:${id}`],
    name: id,
    path: file.path,
    qualifiedName: id,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function activationSnapshot(repository: RepositoryIdentity, symbolCount: number): CodeGraphSnapshot {
  return {
    commit: repository.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'materialization-kill-test',
    fileCount: 1,
    id: `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}-full-${Effect2.pipe(symbolCount.toString(16), EffectString.padStart(16, '0'))}`,
    repositoryId: repository.repositoryId,
    state: 'ready',
    symbolCount,
    worktreeId: repository.worktreeId,
  };
}
