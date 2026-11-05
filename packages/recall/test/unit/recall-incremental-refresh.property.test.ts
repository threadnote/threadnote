import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {expect} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {ResourceStore, type ResourceStoreMutation} from '@threadnote/store/resource-store';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import type {RecallMemoryLinkMatch} from '@threadnote/recall/memory/links';
import {
  expireRecallIndexValidation,
  loadRecallIndexData,
  readRecallIndexData,
  readRecallExactMatches,
  readRecallMemoryLinks,
  recallIndexDatabaseFilename,
  recallIndexStatus,
} from '@threadnote/recall/index';

interface Entry {
  readonly id: number;
  readonly variant: number;
  readonly project: 'one' | 'two';
  readonly archived: boolean;
  readonly moved: boolean;
  readonly target: number;
}
type Operation =
  | {readonly kind: 'put'; readonly entry: Entry}
  | {readonly kind: 'remove' | 'move'; readonly id: number}
  | {readonly kind: 'lose-marker'}
  | {readonly kind: 'overflow'};

const root = 'threadnote://user/me/memories';
const memoryId = (id: number) => `tn_shared_${id % 3}`;
const uriFor = (entry: Pick<Entry, 'id' | 'archived' | 'moved'>) =>
  `${root}/${entry.archived ? 'archived' : 'durable'}/${entry.moved ? 'moved' : 'slot'}-${entry.id}.md`;
const referenceFor = (entry: Entry) => uriFor({id: entry.target, archived: false, moved: false});
const edgeKey = (link: RecallMemoryLinkMatch) =>
  JSON.stringify([
    link.direction,
    link.requestedOrdinal,
    link.sourceUri,
    link.sourceMemoryId,
    link.relationOrigin,
    link.relationType,
    link.relationOrdinal,
    link.targetMemoryId,
  ]);
const render = (entry: Entry) =>
  formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      project: entry.project,
      status: entry.archived ? 'archived' : 'active',
      memoryId: memoryId(entry.id),
      references: [referenceFor(entry)],
      sourceAgentClient: 'codex',
      timestamp: '2026-11-01T00:00:00.000Z',
      topic: 'incremental-property',
    },
    `# Alpha\nalpha variant${entry.variant} evidence.`,
  );

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
    ),
  ),
);
const platform = Layer.mergeAll(BunServices.layer, cryptoLayer, system, recallResourceInvalidationLayer);
const services = ResourceStore.layer.pipe(Layer.provideMerge(platform));
const entry = fc.record({
  id: fc.integer({min: 0, max: 4}),
  variant: fc.integer({min: 0, max: 2}),
  project: fc.constantFrom('one' as const, 'two' as const),
  archived: fc.boolean(),
  moved: fc.boolean(),
  target: fc.integer({min: 0, max: 4}),
});
const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({kind: fc.constant('put' as const), entry}),
  fc.record({kind: fc.constantFrom('remove' as const, 'move' as const), id: fc.integer({min: 0, max: 4})}),
  fc.record({kind: fc.constantFrom('lose-marker' as const, 'overflow' as const)}),
);

const verifyHistory = (includeInactive: boolean, operations: readonly Operation[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* ResourceStore;
    const homes = yield* Effect.forEach(['incremental-', 'clean-'], prefix => fs.makeTempDirectoryScoped({prefix}));
    const configs = EffectArray.map(homes, agentContextHome => ({account: 'local', user: 'me', agentContextHome}));
    const locations = EffectArray.map(homes, home => ({account: 'local', user: 'me', home}));
    const model = new Map<number, Entry>([
      [0, {id: 0, variant: 0, project: 'one', archived: false, moved: false, target: 5}],
      [1, {id: 1, variant: 1, project: 'one', archived: false, moved: false, target: 0}],
      [3, {id: 3, variant: 0, project: 'one', archived: false, moved: false, target: 5}],
      [4, {id: 4, variant: 2, project: 'two', archived: false, moved: false, target: 0}],
      [5, {id: 5, variant: 2, project: 'one', archived: false, moved: false, target: 0}],
    ]);
    const mutate = (mutations: readonly ResourceStoreMutation[]) =>
      mutations.length === 0
        ? Effect.void
        : Effect.forEach(locations, location => store.mutateChecked(location, mutations, Effect.void), {
            discard: true,
          });
    yield* mutate(
      EffectArray.map([...model.values()], value => ({
        type: 'write' as const,
        uri: uriFor(value),
        content: render(value),
        options: {mode: 'upsert' as const},
      })),
    );

    const verify = Effect.fn('test.verifyIncrementalRecallSemantics')(function* () {
      yield* loadRecallIndexData(configs[0], {includeInactive, memoryIds: []});
      yield* fs.remove(path.join(homes[1], 'indexes', 'lexical'), {force: true, recursive: true});
      yield* loadRecallIndexData(configs[1], {includeInactive, memoryIds: [], forceRefresh: true});
      const visible = EffectArray.filter([...model.values()], value => includeInactive || !value.archived);
      const expectedUris = EffectArray.map(visible, uriFor).sort();
      const expectedLinks = EffectArray.flatMap(visible, source => {
        const target = EffectArray.findFirst(visible, value => uriFor(value) === referenceFor(source));
        // Legacy URI references resolve only to a unique, active physical claim.
        const resolved =
          target._tag === 'Some' &&
          !target.value.archived &&
          EffectArray.filter(visible, value => memoryId(value.id) === memoryId(target.value.id)).length === 1;
        const outgoing: RecallMemoryLinkMatch = {
          direction: 'outgoing',
          requestedOrdinal: source.id % 3,
          sourceUri: uriFor(source),
          sourceMemoryId: memoryId(source.id),
          relationOrigin: 'references',
          relationType: 'references',
          relationOrdinal: 0,
          ...(resolved && target._tag === 'Some' ? {targetMemoryId: memoryId(target.value.id)} : {}),
        };
        return [
          outgoing,
          ...(resolved ? [{...outgoing, direction: 'incoming' as const, requestedOrdinal: source.target % 3}] : []),
        ];
      });
      const snapshots = yield* Effect.forEach(configs, config =>
        Effect.gen(function* () {
          const data = yield* readRecallIndexData(config, {
            includeInactive,
            allowedUriScopes: [root],
            memoryIds: ['tn_shared_0', 'tn_shared_1', 'tn_shared_2'],
          });
          expect(
            EffectArray.flatMap(data.candidates, candidate => [
              candidate.uri,
              ...(candidate.equivalentUris ?? []),
            ]).sort(),
          ).toEqual(expectedUris);
          expect(data.readState).toEqual({freshness: 'current', maintenance: 'unneeded'});
          for (const candidate of data.candidates) {
            const claims = EffectArray.filter(visible, value => memoryId(value.id) === candidate.memoryId);
            expect(candidate.identityConflict === true).toBe(
              new Set(EffectArray.map(claims, value => value.variant)).size > 1,
            );
          }
          const status = yield* recallIndexStatus(config, includeInactive);
          expect(status).toMatchObject({ready: true, documentCount: visible.length});
          const exact = yield* Effect.forEach([0, 1, 2], variant =>
            readRecallExactMatches(config, {
              includeInactive,
              terms: [`variant${variant}`],
              uriScopes: [root],
            }).pipe(
              Effect.tap(matches =>
                Effect.sync(() => {
                  expect(EffectArray.map(matches, match => match.uri).sort()).toEqual(
                    EffectArray.map(
                      EffectArray.filter(visible, value => value.variant === variant),
                      uriFor,
                    ).sort(),
                  );
                }),
              ),
            ),
          );
          const links = yield* readRecallMemoryLinks(config, {
            includeInactive,
            allowedUriScopes: [root],
            limit: 64,
            memorySeeds: EffectArray.map([0, 1, 2], id => ({memoryId: memoryId(id), requestedOrdinal: id})),
          });
          expect(EffectArray.map(links, edgeKey).sort()).toEqual(EffectArray.map(expectedLinks, edgeKey).sort());
          return {candidates: data.candidates, corpusStatistics: data.corpusStatistics, exact, links};
        }),
      );
      expect(snapshots[0]).toEqual(snapshots[1]);
    });
    yield* verify();
    for (const change of operations) {
      if (change.kind === 'lose-marker') {
        // A managed mutation without its per-URI marker must force reconciliation.
        const previous = model.get(0);
        const next: Entry = previous
          ? {...previous, variant: (previous.variant + 1) % 3}
          : {id: 0, variant: 0, project: 'one', archived: false, moved: false, target: 1};
        model.set(0, next);
        yield* mutate([{type: 'write', uri: uriFor(next), content: render(next), options: {mode: 'upsert'}}]);
        yield* fs.remove(
          path.join(homes[0], 'indexes', 'lexical', recallIndexDatabaseFilename(includeInactive)) + '.stale',
          {force: true},
        );
      } else if (change.kind === 'overflow') {
        yield* expireRecallIndexValidation(
          homes[0],
          includeInactive,
          Array.from({length: 1_025}, (_, i) => `${root}/durable/unknown-${i}.md`),
        );
      } else {
        const id = change.kind === 'put' ? change.entry.id : change.id;
        const previous = model.get(id);
        const next =
          change.kind === 'put'
            ? change.entry
            : change.kind === 'move' && previous
              ? {...previous, moved: !previous.moved}
              : undefined;
        const mutations: ResourceStoreMutation[] = [];
        if (previous && (!next || uriFor(previous) !== uriFor(next)))
          mutations.push({type: 'remove', uri: uriFor(previous)});
        if (next) {
          model.set(id, next);
          mutations.push({type: 'write', uri: uriFor(next), content: render(next), options: {mode: 'upsert'}});
        } else model.delete(id);
        yield* mutate(mutations);
      }
      yield* verify();
    }
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Focused store, platform and invalidation layers; actual SQLite and file leases use live time.
  }).pipe(Effect.provide(services), TestClock.withLive);

fcEffectProp(
  effectIt,
  'managed mutation histories preserve prepared reads, backlinks and statistics versus a clean rebuild',
  {includeInactive: fc.boolean(), operations: fc.array(operation, {minLength: 1, maxLength: 5})},
  ({includeInactive, operations}) => verifyHistory(includeInactive, operations),
  {fastCheck: {numRuns: 8}},
);

for (const includeInactive of [false, true])
  effectIt.effect(
    `preserves identity conflicts after archiving for the ${includeInactive ? 'inactive' : 'active'} variant`,
    () =>
      verifyHistory(includeInactive, [
        {kind: 'put', entry: {id: 1, variant: 0, project: 'one', archived: true, moved: false, target: 3}},
      ]),
  );
effectIt.effect('re-resolves unchanged legacy backlinks after alias removal, target move and recreation', () =>
  verifyHistory(false, [
    {kind: 'remove', id: 3},
    {kind: 'move', id: 0},
    {kind: 'put', entry: {id: 0, variant: 0, project: 'one', archived: false, moved: false, target: 5}},
  ]),
);
effectIt.effect('reconciles missed and overflowed per-URI invalidations', () =>
  verifyHistory(false, [{kind: 'lose-marker'}, {kind: 'overflow'}]),
);
