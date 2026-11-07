import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  loadRecallMemoryIdentities,
  readRecallIndexData,
  recallIndexStatus,
  RecallReadyReadUnavailable,
} from '@threadnote/recall/index';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {RecallIndexSourceChanged} from '../../src/index/refresh_cut.js';

const scopes = [
  {account: 'first', user: 'alice'},
  {account: 'second', user: 'alice'},
  {account: 'second', user: 'bob'},
  {account: 'first', user: 'bob'},
] as const;
const platform = Layer.mergeAll(
  BunServices.layer,
  cryptoLayer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
        Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
      ),
    ),
  ),
);

const materialize = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-scope-rebind-'});
  const manifestPath = path.join(home, 'manifest.yaml');
  yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
  for (const account of ['first', 'second']) {
    const directory = path.join(home, 'data', account, 'resources', 'repos', 'fixture');
    yield* fs.makeDirectory(directory, {recursive: true});
    yield* fs.writeFileString(path.join(directory, `${account}.md`), `# Resource\n\nscope-rebind-sentinel ${account}`);
  }
  for (const scope of scopes) {
    const directory = path.join(home, 'data', scope.account, 'user', scope.user, 'memories', 'durable');
    yield* fs.makeDirectory(directory, {recursive: true});
    yield* fs.writeFileString(
      path.join(directory, `${scope.account}-${scope.user}.md`),
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          memoryId: `tn_${scope.account}_${scope.user}`,
          status: 'active',
          sourceAgentClient: 'test',
          timestamp: '2026-08-31T00:00:00.000Z',
          topic: 'scope-rebind',
        },
        `scope-rebind-sentinel private ${scope.account} ${scope.user}`,
      ),
    );
  }
  return {home, manifestPath};
});

const verifySequence = (order: readonly number[], useHomeAlias = false) =>
  Effect.gen(function* () {
    const shared = yield* materialize;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const aliasRoot = useHomeAlias ? yield* fs.makeTempDirectoryScoped({prefix: 'recall-home-alias-'}) : undefined;
    const alias = aliasRoot === undefined ? shared.home : path.join(aliasRoot, 'home');
    if (useHomeAlias) yield* fs.symlink(shared.home, alias);
    let previous: number | undefined;
    for (const ordinal of order) {
      const scope = scopes[ordinal];
      const config = {...scope, agentContextHome: alias, manifestPath: shared.manifestPath};
      if (previous !== undefined && previous !== ordinal) {
        const before = yield* recallIndexStatus(config, false);
        const unavailable = yield* readRecallIndexData(config, {includeInactive: false}).pipe(Effect.flip);
        expect(Schema.is(RecallReadyReadUnavailable)(unavailable)).toBe(true);
        expect(yield* recallIndexStatus(config, false)).toEqual(before);
      }
      yield* loadRecallMemoryIdentities(config, {allowedUriScopes: [], memoryIds: []});
      const selected = yield* readRecallIndexData(config, {includeInactive: false, query: 'scope-rebind-sentinel'});
      const fresh = yield* materialize;
      const freshConfig = {...scope, agentContextHome: fresh.home, manifestPath: fresh.manifestPath};
      yield* loadRecallMemoryIdentities(freshConfig, {allowedUriScopes: [], memoryIds: []});
      const clean = yield* readRecallIndexData(freshConfig, {includeInactive: false, query: 'scope-rebind-sentinel'});
      const project = (data: typeof selected) =>
        EffectArray.map(data.candidates, candidate => ({uri: candidate.uri, text: candidate.text})).sort((a, b) =>
          a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0,
        );
      expect(project(selected)).toEqual(project(clean));
      expect(EffectArray.map(project(selected), candidate => candidate.uri)).toEqual(
        [
          `threadnote://resources/repos/fixture/${scope.account}.md`,
          `threadnote://user/${scope.user}/memories/durable/${scope.account}-${scope.user}.md`,
        ].sort(),
      );
      expect(yield* recallIndexStatus(config, false)).toMatchObject({ready: true, documentCount: 2});
      previous = ordinal;
    }
  }).pipe(TestClock.withLive);

describe('explicit recall logical-scope preparation', () => {
  effectIt.layer(platform)(layerIt => {
    layerIt.effect('rebinds accounts with still-live old private and resource files', () => verifySequence([0, 1, 0]));
    layerIt.effect('normalizes an aliased home before account and user rebinds', () =>
      verifySequence([0, 1, 2, 0], true),
    );
    layerIt.effect('rejects a still-live current-root omission during a full manifest rebind', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const f = yield* materialize;
        const config = {...scopes[0], agentContextHome: f.home, manifestPath: f.manifestPath};
        yield* loadRecallMemoryIdentities(config, {allowedUriScopes: [], memoryIds: []});
        const filename = path.join(f.home, 'data', 'first', 'resources', 'repos', 'fixture', 'first.md');
        const content = yield* fs.readFileString(filename);
        yield* fs.remove(filename);
        const manifestPath = path.join(f.home, 'next-manifest.yaml');
        yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
        let restored = false;
        const failure = yield* loadRecallIndexData(
          {...config, manifestPath},
          {
            includeInactive: false,
            memoryIds: [],
            onProgress: progress =>
              Effect.gen(function* () {
                if (progress.phase !== 'indexing' || progress.completed !== 0 || restored) return;
                restored = true;
                yield* fs.writeFileString(filename, content);
              }),
          },
        ).pipe(Effect.flip);
        expect(restored).toBe(true);
        expect(Schema.is(RecallIndexSourceChanged)(failure)).toBe(true);
        expect(yield* recallIndexStatus(config, false)).toMatchObject({ready: true, documentCount: 2});
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('does not exempt an omitted source whose parent acquired a new physical alias', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const f = yield* materialize;
        const first = {...scopes[0], agentContextHome: f.home, manifestPath: f.manifestPath};
        yield* loadRecallMemoryIdentities(first, {allowedUriScopes: [], memoryIds: []});
        const original = path.join(f.home, 'data', 'first', 'resources');
        const moved = path.join(f.home, 'moved-resources');
        yield* fs.rename(original, moved);
        yield* fs.symlink(moved, original);
        const failure = yield* loadRecallMemoryIdentities(
          {...first, ...scopes[1]},
          {allowedUriScopes: [], memoryIds: []},
        ).pipe(Effect.flip);
        expect(Schema.is(RecallIndexSourceChanged)(failure)).toBe(true);
        expect(yield* recallIndexStatus(first, false)).toMatchObject({ready: true, documentCount: 2});
      }).pipe(TestClock.withLive),
    );
    fcEffectProp(
      layerIt,
      'matches a clean authorized corpus across bounded account and user binding changes',
      {order: fc.shuffledSubarray([0, 1, 2, 3], {minLength: 4, maxLength: 4})},
      ({order}) => verifySequence([...order, order[0]]),
      {fastCheck: {numRuns: 6}},
    );
  });
});
