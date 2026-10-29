import {it as effectIt} from '@effect/vitest';
import {
  Array as EffectArray,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Ref,
  String as EffectString,
} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, vi} from 'vitest';
import * as FC from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {EmbeddingFailed} from '@threadnote/inference/engine/errors';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {writeModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import * as relocation from '@threadnote/memory/relocation';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {ensureVectorIndex, vectorIndexGenerationReadiness, vectorIndexStatus} from '@threadnote/recall/vector-index';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runShareSync, syncSharedReposBeforeAgentRead} from '@threadnote/threadnote/effect/share';
import {runCommand} from '@threadnote/threadnote/utils';
import {observeSharedRepositoryHomeLock} from '@threadnote/threadnote/effect/share/lock';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const embedding = Option.getOrThrow(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, value => value.id === 'bge-small-en-v1.5-q8'),
);
const memory = (id: string, text: string) =>
  `MEMORY\nkind: durable\nstatus: active\nvisibility: shared\nproject: threadnote\ntopic: incoming\nmemory_id: ${id}\n\n${text}\n`;

function withEmbedding<A, E, R>(
  home: string,
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly fail?: Ref.Ref<boolean>;
    readonly pause?: {readonly started: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void>};
  } = {},
) {
  const installation = {
    bytes: embedding.size,
    installed: true,
    modelId: embedding.id,
    partialBytes: 0,
    path: `${home}/fake-model.gguf`,
    verified: true,
  };
  const unexpected = () => Effect.die(TestError.make({message: 'Unexpected model operation'}));
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
    embedMany: ({inputs}) =>
      (options.fail ? Ref.get(options.fail) : Effect.succeed(false)).pipe(
        Effect.flatMap(failed =>
          failed
            ? Effect.fail(
                EmbeddingFailed.make({
                  cause: TestError.make({message: 'Synthetic embedding failure'}),
                  message: 'Synthetic embedding failure',
                  modelId: embedding.id,
                }),
              )
            : Effect.succeed(
                EffectArray.map(inputs, () =>
                  Array.from({length: embedding.dimensions ?? 0}, (_, i) => (i === 0 ? 1 : 0)),
                ),
              ),
        ),
        Effect.tap(() =>
          options.pause
            ? Deferred.succeed(options.pause.started, undefined).pipe(
                Effect.andThen(Deferred.await(options.pause.release)),
              )
            : Effect.void,
        ),
      ),
    generate: unexpected,
    rerank: unexpected,
  });
  const store = LocalModelStore.of({
    install: unexpected,
    remove: unexpected,
    path: () => installation.path,
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
  return effect.pipe(Effect.provideService(LocalModelRuntime, runtime), Effect.provideService(LocalModelStore, store));
}

const git = (cwd: string, args: readonly string[]) =>
  runCommand(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Threadnote Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    {cwd},
  );

const makeFixture = Effect.fn('test.shareRecallFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-share-recall-'});
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  const home = path.join(root, 'home');
  const worktree = path.join(home, 'share', 'worktrees', 'default');
  const gitdir = path.join(home, 'share', 'teams', 'default.gitdir');
  yield* fs.makeDirectory(seed, {recursive: true});
  yield* git(root, ['init', '--bare', remote]);
  yield* git(seed, ['init', '-b', 'main']);
  yield* fs.writeFileString(path.join(seed, 'README.md'), '# Synthetic shared memories\n');
  yield* fs.writeFileString(path.join(seed, '.gitignore'), '**/.abstract.md\n**/.overview.md\n');
  yield* git(seed, ['add', '.']);
  yield* git(seed, ['commit', '-m', 'fixture baseline']);
  yield* git(seed, ['remote', 'add', 'origin', remote]);
  yield* git(seed, ['push', '-u', 'origin', 'main']);
  yield* git(root, ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  yield* fs.makeDirectory(path.dirname(worktree), {recursive: true});
  yield* fs.makeDirectory(path.dirname(gitdir), {recursive: true});
  yield* git(root, ['clone', `--separate-git-dir=${gitdir}`, '--branch', 'main', '--', remote, worktree]);
  yield* fs.writeFileString(
    path.join(home, 'share', 'teams.json'),
    JSON.stringify({
      version: 1,
      defaultTeam: 'default',
      teams: {default: {name: 'default', remote, worktree, gitdir, addedAt: '1970-01-01T00:00:00.000Z'}},
    }),
  );
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    user: 'fixture',
    manifestPath: path.join(home, 'seed-manifest.yaml'),
  };
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  return {config, root, seed, home, worktree};
});

const publishIncoming = Effect.fn('test.publishIncoming')(function* (seed: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = path.join(seed, 'durable', 'projects', 'threadnote', 'incoming.md');
  yield* fs.makeDirectory(path.dirname(destination), {recursive: true});
  yield* fs.writeFileString(destination, memory('tn_recall_incoming', text));
  yield* git(seed, ['add', '.']);
  yield* git(seed, ['commit', '-m', 'incoming memory']);
  yield* git(seed, ['push', 'origin', 'main']);
});

describe('shared sync recall readiness', () => {
  for (const mode of ['explicit', 'automatic'] as const) {
    effectIt.effect(`finishes ${mode} import with current lexical recall in a fresh process`, () =>
      Effect.gen(function* () {
        const {config, seed, home} = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* loadRecallIndexData(config, {includeInactive: false});
        expect((yield* recallIndexStatus(config)).ready).toBe(true);
        yield* publishIncoming(seed, 'New canonical recall anchor.');

        if (mode === 'explicit') yield* runShareSync(config, {push: false});
        else expect(yield* syncSharedReposBeforeAgentRead(config)).toEqual({syncedTeams: ['default'], warnings: []});

        expect(
          yield* fs.readFileString(
            path.join(
              home,
              'data',
              'local',
              'user',
              'fixture',
              'memories',
              'shared',
              'default',
              'durable',
              'projects',
              'threadnote',
              'incoming.md',
            ),
          ),
        ).toContain('New canonical recall anchor.');
        // Status is read-only: a query must not repair the index before this assertion.
        expect(yield* recallIndexStatus(config)).toMatchObject({ready: true, documentCount: 1});
        const observer = EffectArray.join(
          [
            "import {recallIndexStatus} from '@threadnote/recall/index';",
            "import {runEffect} from './apps/threadnote/test/helpers/effect-runtime.ts';",
            'process.stdout.write(JSON.stringify(await runEffect(recallIndexStatus(JSON.parse(process.argv[1])))));',
          ],
          '\n',
        );
        const fresh = yield* runCommand('bun', ['--eval', observer, JSON.stringify(config)]);
        expect(JSON.parse(fresh.stdout)).toMatchObject({ready: true, documentCount: 1});
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    );
  }

  effectIt.effect('refreshes an existing selected vector index and leaves an unchanged sync alone', () =>
    Effect.gen(function* () {
      const {config, home, seed} = yield* makeFixture();
      yield* withEmbedding(
        home,
        Effect.gen(function* () {
          yield* writeModelSelection(home, {version: 1, roles: {embedding: embedding.id}});
          const initial = yield* loadRecallIndexData(config, {includeInactive: false});
          yield* ensureVectorIndex(config, embedding, initial.candidates, {corpusGeneration: initial.generation});
          yield* publishIncoming(seed, 'Selected vector refresh anchor.');
          yield* runShareSync(config, {push: false});

          const lexical = yield* recallIndexStatus(config);
          expect(lexical).toMatchObject({ready: true, documentCount: 1});
          expect(yield* vectorIndexGenerationReadiness(home, embedding, lexical.generation!)).toBe('current');
          const vector = yield* vectorIndexStatus(home, embedding);
          yield* runShareSync(config, {push: false});
          expect(yield* recallIndexStatus(config)).toEqual(lexical);
          expect(yield* vectorIndexStatus(home, embedding)).toEqual(vector);
        }),
      );
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('returns deferred refresh warnings while preserving the successful canonical import', () =>
    Effect.gen(function* () {
      const {config, home, seed} = yield* makeFixture();
      const fail = yield* Ref.make(false);
      yield* withEmbedding(
        home,
        Effect.gen(function* () {
          yield* writeModelSelection(home, {version: 1, roles: {embedding: embedding.id}});
          const initial = yield* loadRecallIndexData(config, {includeInactive: false});
          yield* ensureVectorIndex(config, embedding, initial.candidates, {corpusGeneration: initial.generation});
          yield* publishIncoming(seed, 'Preserved despite a failed vector refresh.');
          yield* Ref.set(fail, true);
          const result = yield* syncSharedReposBeforeAgentRead(config);
          expect(result.syncedTeams).toEqual(['default']);
          expect(EffectArray.join(result.warnings, '\n')).toContain('recall refresh is deferred');
          expect(EffectArray.join(result.warnings, '\n')).toContain('threadnote repair');
          const lexical = yield* recallIndexStatus(config);
          expect(lexical).toMatchObject({ready: true, documentCount: 1});
          expect(yield* vectorIndexGenerationReadiness(home, embedding, lexical.generation!)).toBe('stale');
          const current = yield* loadRecallIndexData(config, {includeInactive: false});
          expect(current.candidates[0]?.text).toContain('Preserved despite a failed vector refresh.');
        }),
        {fail},
      );
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('releases the shared lock when a caller cancels a stalled post-commit vector refresh', () =>
    Effect.gen(function* () {
      const {config, home, seed} = yield* makeFixture();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      yield* withEmbedding(
        home,
        Effect.gen(function* () {
          yield* writeModelSelection(home, {version: 1, roles: {embedding: embedding.id}});
          const initial = yield* loadRecallIndexData(config, {includeInactive: false});
          yield* ensureVectorIndex(config, embedding, initial.candidates, {corpusGeneration: initial.generation});
          yield* publishIncoming(seed, 'Durable before vector-refresh cancellation.');
          const sync = yield* syncSharedReposBeforeAgentRead(config).pipe(
            Effect.ensuring(Deferred.succeed(returned, undefined)),
            Effect.forkScoped,
          );
          yield* Deferred.await(started);
          expect(yield* observeSharedRepositoryHomeLock(home)).toBe('active');
          yield* Fiber.interrupt(sync).pipe(Effect.forkScoped);
          expect(Option.isSome(yield* Deferred.await(returned).pipe(Effect.timeoutOption('500 millis')))).toBe(true);
          expect(yield* observeSharedRepositoryHomeLock(home)).toBe('available');
          const lexical = yield* recallIndexStatus(config);
          expect(lexical).toMatchObject({ready: true, documentCount: 1});
          expect(yield* vectorIndexGenerationReadiness(home, embedding, lexical.generation!)).toBe('stale');
        }),
        {pause: {started, release}},
      ).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('refreshes successful imports while preserving a failed identity change for retry', () =>
    Effect.gen(function* () {
      const {config, home, seed} = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const badUri = 'threadnote://user/fixture/memories/shared/default/durable/projects/threadnote/identity.md';
      const original = memory('tn_original_shared', 'Original must remain.');
      const store = yield* ResourceStore;
      yield* store.write({home, account: config.account, user: config.user}, badUri, original, {mode: 'create'});
      yield* loadRecallIndexData(config, {includeInactive: false});
      const destination = path.join(seed, 'durable', 'projects', 'threadnote', 'identity.md');
      yield* fs.makeDirectory(path.dirname(destination), {recursive: true});
      yield* fs.writeFileString(destination, memory('tn_different_shared', 'Unapproved identity replacement.'));
      yield* publishIncoming(seed, 'Valid independent import.');
      const result = yield* syncSharedReposBeforeAgentRead(config);
      expect(EffectArray.join(result.warnings, '\n')).toContain('1 pending shared memory ingest failure');
      expect(yield* store.read({home, account: config.account, user: config.user}, badUri)).toBe(original);
      expect(yield* recallIndexStatus(config)).toMatchObject({ready: true, documentCount: 2});
      expect(yield* fs.readFileString(path.join(home, 'share', 'auto-sync-pending-reindexes.json'))).toContain(
        'identity.md',
      );
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('tracks a committed import even when its relocation cleanup fails', () =>
    Effect.gen(function* () {
      const {config, seed} = yield* makeFixture();
      yield* loadRecallIndexData(config, {includeInactive: false});
      yield* publishIncoming(seed, 'Committed before cleanup failed.');
      const spy = vi
        .spyOn(relocation, 'discardMemoryRelocation')
        .mockImplementationOnce(() =>
          Effect.fail(relocation.MemoryRelocationError.make({message: 'Synthetic post-commit cleanup failure'})),
        );
      yield* runShareSync(config, {push: false}).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
      expect(yield* recallIndexStatus(config)).toMatchObject({ready: true, documentCount: 1});
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  fcEffectProp(
    effectIt,
    'preserves current lexical content through bounded add, replace and remove batches without installing a model',
    {
      count: FC.integer({min: 1, max: 4}),
      payload: FC.array(FC.constantFrom('a', 'b', 'ç', '中', '_', '-', '0'), {minLength: 1, maxLength: 20}).map(parts =>
        EffectArray.join(parts, ''),
      ),
    },
    ({count, payload}) =>
      Effect.gen(function* () {
        const {config, home, seed} = yield* makeFixture();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* loadRecallIndexData(config, {includeInactive: false});
        const expected = new Map<string, string>();
        const directory = path.join(seed, 'durable', 'projects', 'threadnote');
        yield* fs.makeDirectory(directory, {recursive: true});
        for (const step of ['add', 'replace', 'remove'] as const) {
          for (let i = 0; i < count; i += 1) {
            const name = `generated-${i}.md`;
            if (step === 'remove') {
              yield* fs.remove(path.join(directory, name));
              expected.delete(name);
            } else {
              const text = `${step}-${i}-${payload}`;
              yield* fs.writeFileString(path.join(directory, name), memory(`tn_generated_${i}`, text));
              expected.set(name, text);
            }
          }
          yield* git(seed, ['add', '.']);
          yield* git(seed, ['commit', '-m', step]);
          yield* git(seed, ['push', 'origin', 'main']);
          yield* runShareSync(config, {push: false});
          expect(yield* recallIndexStatus(config)).toMatchObject({ready: true, documentCount: expected.size});
          const index = yield* loadRecallIndexData(config, {includeInactive: false});
          expect(index.candidates).toHaveLength(expected.size);
          for (const text of expected.values())
            expect(EffectArray.some(index.candidates, candidate => EffectString.includes(text)(candidate.text))).toBe(
              true,
            );
        }
        expect(yield* fs.exists(path.join(home, 'models'))).toBe(false);
      }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {fastCheck: {numRuns: 6}},
  );
});
