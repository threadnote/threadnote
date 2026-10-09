import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {makeSourceConfigurationRegistry, sourceConfigurationStoreLayer} from '@threadnote/integration-runtime/config';
import {SourceCoordinator} from '@threadnote/integration-core/source-coordinator';
import {obsidianSourceCodec} from '../src/config.js';
import {obsidianSourceWork, runObsidianSourceAdd, runObsidianSourceSync} from '../src/source.js';

const base = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'obsidian-work.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: value => ({...value}),
          sanitizeExternal: value => ({...value}),
        }),
      ),
    ),
  ),
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const services = Layer.merge(
  base,
  sourceConfigurationStoreLayer(
    makeSourceConfigurationRegistry({sources: [obsidianSourceCodec], projections: []}),
  ).pipe(Layer.provide(base)),
);
const layer = Layer.merge(services, ResourceStore.layer.pipe(Layer.provide(services)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const options = {mode: 'automatic', requestId: 'test', credentialEnvironment: {}} as const;
const setup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'obsidian-work-'});
  const config = {agentContextHome: home, account: 'local', user: 'tester'} as RuntimeConfig;
  const vault = path.join(home, 'vault');
  yield* fs.makeDirectory(vault);
  yield* runObsidianSourceAdd(config, {id: 'vault', vault, include: ['**/*.md'], apply: true});
  const statePath = path.join(home, 'threadnote', 'sources', 'obsidian', 'vault', 'state-v1.json');
  const readState = fs.readFileString(statePath).pipe(
    Effect.map(
      raw =>
        JSON.parse(raw) as {
          files: Record<string, {noteId?: string}>;
          scan?: unknown;
          sourceInstanceId?: string;
        },
    ),
  );
  return {fs, path, config, vault, readState};
});

describe('Obsidian bounded source work', () => {
  effectIt.effect.prop(
    'checkpointed quanta converge to the independent vault inventory and preserve previous files until reconciliation',
    {count: Schema.Int.check(Schema.isBetween({minimum: 66, maximum: 80}))},
    ({count}) =>
      Effect.gen(function* () {
        const {fs, path, config, vault, readState} = yield* setup();
        const names = Array.from({length: count}, (_, index) => `note-${String(index).padStart(3, '0')}.md`);
        yield* Effect.forEach(
          names,
          name => fs.writeFileString(path.join(vault, name), `# ${name}\nPublic documentation.`),
          {concurrency: 8},
        );
        const first = yield* obsidianSourceWork.run(config, 'vault', options);
        expect(first.syncedDocuments).toHaveLength(64);
        expect(first.more).toBe(true);
        expect(Object.keys((yield* readState).files)).toHaveLength(64);
        const firstState = yield* readState;
        const firstNoteId = firstState.files[names[0]]?.noteId;
        expect(firstNoteId).toBeDefined();
        expect(firstState.sourceInstanceId).toBeDefined();
        const second = yield* obsidianSourceWork.run(config, 'vault', options);
        expect(second.more).toBe(false);
        expect(Object.keys((yield* readState).files).sort()).toEqual(names);
        expect((yield* readState).files[names[0]]?.noteId).toBe(firstNoteId);
        expect((yield* readState).sourceInstanceId).toBe(firstState.sourceInstanceId);
        const repeated = yield* obsidianSourceWork.run(config, 'vault', options);
        expect(repeated.syncedDocuments).toEqual([]);
        expect(Object.keys((yield* readState).files)).toHaveLength(count);
        expect((yield* readState).files[names[0]]?.noteId).toBe(firstNoteId);
        if (repeated.more) yield* obsidianSourceWork.run(config, 'vault', options);
        yield* fs.remove(path.join(vault, names[0]));
        yield* obsidianSourceWork.run(config, 'vault', options);
        expect(Object.keys((yield* readState).files)).toHaveLength(count);
        yield* obsidianSourceWork.run(config, 'vault', options);
        expect(Object.keys((yield* readState).files).sort()).toEqual(names.slice(1));
      }).pipe(TestClock.withLive, provide),
    {arbitrary: {runs: 3}},
  );

  effectIt.effect('continues into nested directories and excludes symlinks and private folders', () =>
    Effect.gen(function* () {
      const {fs, path, config, vault, readState} = yield* setup();
      yield* fs.makeDirectory(path.join(vault, 'notes'));
      yield* fs.makeDirectory(path.join(vault, '.obsidian'));
      yield* fs.writeFileString(path.join(vault, 'notes', 'public.md'), '# Public');
      yield* fs.writeFileString(path.join(vault, '.obsidian', 'private.md'), '# Private');
      yield* fs.symlink(path.join(vault, '.obsidian', 'private.md'), path.join(vault, 'linked.md'));
      expect((yield* obsidianSourceWork.run(config, 'vault', options)).more).toBe(true);
      expect((yield* obsidianSourceWork.run(config, 'vault', options)).more).toBe(false);
      expect(Object.keys((yield* readState).files)).toEqual(['notes/public.md']);
    }).pipe(TestClock.withLive, provide),
  );

  effectIt.effect('routes explicit apply through the central service and preserves the public result', () =>
    Effect.gen(function* () {
      const {config} = yield* setup();
      const value = {source: {id: 'vault'}, entries: []};
      let calls = 0;
      const result = yield* runObsidianSourceSync(config, {id: 'vault', apply: true}).pipe(
        Effect.provideService(SourceCoordinator, {
          requestRefresh: () => Effect.void,
          sync: (_config, sourceId) =>
            Effect.sync(() => {
              calls++;
              return {sourceId, syncedDocuments: [], warnings: [], value};
            }),
        }),
      );
      expect(calls).toBe(1);
      expect(result).toBe(value);
    }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect('scopes checkpoints to the resource account', () =>
    Effect.gen(function* () {
      const {fs, path, config, vault} = yield* setup();
      yield* fs.writeFileString(path.join(vault, 'public.md'), '# Public');
      expect((yield* obsidianSourceWork.run(config, 'vault', options)).syncedDocuments).toEqual(['public.md']);
      expect((yield* obsidianSourceWork.run({...config, account: 'other'}, 'vault', options)).syncedDocuments).toEqual([
        'public.md',
      ]);
      expect((yield* obsidianSourceWork.run(config, 'vault', options)).syncedDocuments).toEqual([]);
    }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect('bounds deletion reconciliation and removes rejected cached notes before a scan completes', () =>
    Effect.gen(function* () {
      const {fs, path, config, vault, readState} = yield* setup();
      const names = Array.from({length: 130}, (_, index) => `note-${String(index).padStart(3, '0')}.md`);
      yield* Effect.forEach(names, name => fs.writeFileString(path.join(vault, name), '# Public'), {concurrency: 8});
      const firstPage = yield* obsidianSourceWork.run(config, 'vault', options);
      expect(firstPage.syncedDocuments).toHaveLength(64);
      const rejectedName = firstPage.syncedDocuments[0];
      for (let run = 0; run < 2; run++) yield* obsidianSourceWork.run(config, 'vault', options);
      // Directory entry order is filesystem-specific; reject a file observed on the first page.
      yield* fs.writeFileString(path.join(vault, rejectedName), 'x'.repeat(512 * 1024 + 1));
      const rejected = yield* obsidianSourceWork.run(config, 'vault', options);
      expect(rejected.more).toBe(true);
      expect(rejected.syncedDocuments).toContain(rejectedName);
      expect((yield* readState).files[rejectedName]).toBeUndefined();
      for (let run = 0; run < 3; run++) {
        if (!(yield* obsidianSourceWork.run(config, 'vault', options)).more) break;
      }
      yield* fs.remove(vault, {recursive: true});
      yield* fs.makeDirectory(vault);
      const first = yield* obsidianSourceWork.run(config, 'vault', options);
      expect(first.syncedDocuments).toHaveLength(64);
      expect(first.more).toBe(true);
      expect((yield* obsidianSourceWork.run(config, 'vault', options)).syncedDocuments).toHaveLength(64);
      expect((yield* obsidianSourceWork.run(config, 'vault', options)).more).toBe(false);
      expect(Object.keys((yield* readState).files)).toEqual([]);
    }).pipe(TestClock.withLive, provide),
  );
  effectIt.effect.prop(
    'directory mutations between pages never remove an existing cached allowlisted file',
    {count: Schema.Int.check(Schema.isBetween({minimum: 66, maximum: 80}))},
    ({count}) =>
      Effect.gen(function* () {
        const {fs, path, config, vault, readState} = yield* setup();
        const names = Array.from({length: count}, (_, index) => `note-${String(index).padStart(3, '0')}.md`);
        yield* Effect.forEach(names, name => fs.writeFileString(path.join(vault, name), '# Public'), {concurrency: 8});
        for (let run = 0; run < 3; run++) {
          if (!(yield* obsidianSourceWork.run(config, 'vault', options)).more) break;
        }
        yield* obsidianSourceWork.run(config, 'vault', options);
        const removed = Object.keys((yield* readState).files)[0];
        yield* fs.remove(path.join(vault, removed));
        yield* fs.writeFileString(path.join(vault, 'added-after-page.md'), '# Added');
        for (let run = 0; run < 4; run++) {
          if (!(yield* obsidianSourceWork.run(config, 'vault', options)).more) break;
        }
        const retained = Object.keys((yield* readState).files);
        for (const name of names.filter(name => name !== removed)) expect(retained).toContain(name);
      }).pipe(TestClock.withLive, provide),
    {arbitrary: {runs: 3}},
  );
});
