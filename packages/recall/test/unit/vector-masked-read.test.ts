import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Cause, Effect, Exit, FileSystem, Layer, Path, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {ResourceStore} from '@threadnote/store/resource-store';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {TestError} from '@threadnote/testing/test-error';
import {RECALL_CHUNKER_VERSION} from '../../src/chunker.js';
import type {RecallChangeEntry} from '../../src/index/change_log.js';
import {VECTOR_SCOPE_MAPPING_VERSION} from '../../src/vector/generation-compatibility.js';
import {recallVectorPreparationIdentity, recallVectorPreparationJobId} from '../../src/vector/preparation-identity.js';
import {RECALL_MASKED_READ_MAX_URIS} from '../../src/read_boundary.js';
import {
  decideRecallMaskedRead,
  readRecallMaskLexicalInputs,
  recallVectorMaskPredicate,
  type RecallMaskLexicalInputs,
  type RecallVectorGroupMember,
} from '../../src/vector/masked-read.js';
import type {RecallVectorGenerationMetadata} from '../../src/vector/generation-compatibility.js';

const recipe = EffectString.repeat(64)('b');
const expected = {
  modelId: 'model',
  modelSha256: EffectString.repeat(64)('a'),
  dimensions: 4,
  embeddingRecipe: recipe,
  chunkerVersion: RECALL_CHUNKER_VERSION,
  scopeMappingVersion: VECTOR_SCOPE_MAPPING_VERSION,
};
const authorizationKey = EffectString.repeat(64)('c');
const generation: RecallVectorGenerationMetadata = {
  generation: '1-ab',
  job_id: recallVectorPreparationJobId(
    recallVectorPreparationIdentity('old-corpus', authorizationKey, 'model', recipe),
  ),
  corpus_generation: 'old-corpus',
  model_id: 'model',
  model_sha256: EffectString.repeat(64)('a'),
  dimensions: 4,
  embedding_recipe: recipe,
  chunker_version: RECALL_CHUNKER_VERSION,
  normalized: 'l2',
  scope_mapping_version: VECTOR_SCOPE_MAPPING_VERSION,
  state: 'ready',
};
const uri = (name: string) => `threadnote://user/me/memories/durable/${name}.md`;
const changed = (name: string, kind: RecallChangeEntry['kind'] = 'changed', ids: Partial<RecallChangeEntry> = {}) =>
  ({
    uri: uri(name),
    kind,
    beforeMemoryId: null,
    beforeContentHash: null,
    afterMemoryId: null,
    afterContentHash: null,
    ...ids,
  }) satisfies RecallChangeEntry;
const known = (entries: readonly RecallChangeEntry[], identityUris: readonly string[] = []) =>
  ({state: 'known', contentGeneration: 'new-corpus', changed: entries, identityUris}) satisfies RecallMaskLexicalInputs;

const decide = (
  lexical: RecallMaskLexicalInputs | Effect.Effect<RecallMaskLexicalInputs, TestError>,
  members: readonly RecallVectorGroupMember[] = [],
  overrides: {
    readonly generation?: Partial<RecallVectorGenerationMetadata>;
    readonly authorizationKey?: string;
    readonly cap?: number;
  } = {},
) =>
  decideRecallMaskedRead({
    generation: {...generation, ...overrides.generation},
    expected,
    authorizationKey: 'authorizationKey' in overrides ? overrides.authorizationKey : authorizationKey,
    ...(overrides.cap === undefined ? {} : {cap: overrides.cap}),
    readLexicalInputs: from =>
      from !== 'old-corpus'
        ? Effect.succeed({state: 'unknown' as const})
        : Effect.isEffect(lexical)
          ? lexical
          : Effect.succeed(lexical),
    readGroupMembers: seeds =>
      Effect.sync(() =>
        EffectArray.filter(members, member =>
          EffectArray.some(
            members,
            seed =>
              seed.representativeUri === member.representativeUri &&
              (seeds.includes(seed.uri) || seeds.includes(seed.representativeUri)),
          ),
        ),
      ),
  });

describe('masked read decision', () => {
  effectIt.effect('serves an unchanged generation with an empty mask bound to the current lexical generation', () =>
    Effect.gen(function* () {
      expect(yield* decide(known([]))).toEqual({
        servable: true,
        mask: {contentGeneration: 'new-corpus', uris: []},
      });
    }),
  );

  // P3-A4 at the decision layer: each compatibility input alone makes the generation incompatible.
  for (const [label, generationChange, key] of [
    ['model id', {model_id: 'other-model'}, authorizationKey],
    ['model sha256', {model_sha256: EffectString.repeat(64)('d')}, authorizationKey],
    ['dimensions', {dimensions: 8}, authorizationKey],
    ['embedding recipe', {embedding_recipe: EffectString.repeat(64)('e')}, authorizationKey],
    ['chunker version', {chunker_version: RECALL_CHUNKER_VERSION + 1}, authorizationKey],
    ['scope mapping version', {scope_mapping_version: VECTOR_SCOPE_MAPPING_VERSION - 1}, authorizationKey],
    ['building state', {state: 'building'}, authorizationKey],
    ['authorization key', {}, EffectString.repeat(64)('f')],
    ['identity without an authorization key', {job_id: EffectString.repeat(64)('a')}, authorizationKey],
    ['missing current authorization key', {}, undefined],
  ] as const)
    effectIt.effect(`refuses a changed ${label}`, () =>
      Effect.gen(function* () {
        expect(yield* decide(known([]), [], {generation: generationChange, authorizationKey: key})).toEqual({
          servable: false,
          reason: 'incompatible',
        });
      }),
    );

  effectIt.effect('refuses an unknown change set and every mask over the cap', () =>
    Effect.gen(function* () {
      expect(yield* decide({state: 'unknown'})).toEqual({servable: false, reason: 'unknown-changes'});
      expect(yield* decide({state: 'over-cap'})).toEqual({servable: false, reason: 'over-cap'});
      const many = Array.from({length: RECALL_MASKED_READ_MAX_URIS}, (_, index) => changed(`m${index}`));
      expect((yield* decide(known(many))).servable).toBe(true);
      expect(yield* decide(known(many, [uri('extra')]))).toEqual({servable: false, reason: 'over-cap'});
      // One changed member of a group whose extension crosses the cap.
      const group = Array.from({length: RECALL_MASKED_READ_MAX_URIS + 1}, (_, index) => ({
        uri: uri(`g${index}`),
        representativeUri: uri('g0'),
      }));
      expect(yield* decide(known([changed('g1')]), group)).toEqual({servable: false, reason: 'over-cap'});
      // The cap is a parameter of the decision and its readers.
      expect(yield* decide(known([changed('a'), changed('b')]), [], {cap: 1})).toEqual({
        servable: false,
        reason: 'over-cap',
      });
    }),
  );

  // A defect in a decision read is a programming error: it propagates instead of becoming stale.
  effectIt.effect('propagates a defect in a decision read', () =>
    Effect.gen(function* () {
      const exit = yield* decide(Effect.die('programming error')).pipe(Effect.exit);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  );

  // A failed decision read is not servable, so the read keeps today's stale behavior.
  effectIt.effect('refuses a decision whose change-log read fails', () =>
    Effect.gen(function* () {
      expect(yield* decide(Effect.fail(TestError.make({message: 'change log unreadable'})))).toEqual({
        servable: false,
        reason: 'unreadable',
      });
    }),
  );

  // P3-A3 at the decision layer.
  effectIt.effect('masks every member of an old group that contains a changed or removed member', () =>
    Effect.gen(function* () {
      const members = [
        {uri: uri('rep'), representativeUri: uri('rep')},
        {uri: uri('alias-a'), representativeUri: uri('rep')},
        {uri: uri('alias-b'), representativeUri: uri('rep')},
        {uri: uri('other'), representativeUri: uri('other')},
      ];
      expect(yield* decide(known([changed('alias-a')]), members)).toEqual({
        servable: true,
        mask: {contentGeneration: 'new-corpus', uris: [uri('alias-a'), uri('alias-b'), uri('rep')]},
      });
      // A representative seed extends to its aliases as well.
      expect(yield* decide(known([changed('rep', 'removed')]), members)).toEqual({
        servable: true,
        mask: {contentGeneration: 'new-corpus', uris: [uri('alias-a'), uri('alias-b'), uri('rep')]},
      });
    }),
  );

  effectIt.effect('masks the old group of an unchanged memory that a new member joins by identity', () =>
    Effect.gen(function* () {
      const members = [
        {uri: uri('unchanged'), representativeUri: uri('unchanged')},
        {uri: uri('unchanged-alias'), representativeUri: uri('unchanged')},
      ];
      const joining = changed('new', 'added', {afterMemoryId: 'tn_shared', afterContentHash: 'h1'});
      // The lexical read supplies the identity match; the old group adds the alias.
      expect(yield* decide(known([joining], [uri('unchanged')]), members)).toEqual({
        servable: true,
        mask: {contentGeneration: 'new-corpus', uris: [uri('new'), uri('unchanged-alias'), uri('unchanged')]},
      });
    }),
  );

  effectIt.effect('emits no exclusion without masked URIs and string params only with them', () =>
    Effect.sync(() => {
      const base = {params: ['p'], restricted: false, sql: 'chunk.project = ?'};
      expect(recallVectorMaskPredicate(base, 'chunk.uri', undefined)).toBe(base);
      expect(recallVectorMaskPredicate(base, 'chunk.uri', {contentGeneration: 'g', uris: []})).toBe(base);
      const masked = recallVectorMaskPredicate(base, 'chunk.uri', {contentGeneration: 'g', uris: ["a'b", 'c']});
      expect(masked).toEqual({
        params: ['p', "a'b", 'c'],
        restricted: true,
        sql: '(chunk.project = ?) AND chunk.uri NOT IN (?, ?)',
      });
      // The native reader rejects quotes, statement ends and comments in a predicate.
      expect(masked.sql).not.toMatch(/['";`[\]]|--|\/\*/u);
    }),
  );
});

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
    ),
  ),
);
const services = ResourceStore.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, cryptoLayer, system, recallResourceInvalidationLayer)),
);
const document = (memoryId: string, body: string) =>
  `MEMORY\nkind: durable\nstatus: active\nmemory_id: ${memoryId}\nsource_agent_client: test\ntimestamp: 2026-11-03T00:00:00.000Z\n\n${body}`;

effectIt.effect('reads the changes and the identity matches of one real lexical snapshot', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* ResourceStore;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'recall-masked-read-'}));
    const config = {account: 'local', user: 'me', agentContextHome: home, manifestPath: path.join(home, 'm.json')};
    yield* fs.writeFileString(config.manifestPath, JSON.stringify({version: 1, projects: []}));
    const location = {account: 'local', user: 'me', home};
    const write = (name: string, memoryId: string, body: string) =>
      store.mutateChecked(
        location,
        [{type: 'write', uri: uri(name), content: document(memoryId, body), options: {mode: 'upsert'}}],
        Effect.void,
      );
    yield* write('stable', 'tn_stable', 'stable body');
    yield* write('shared', 'tn_shared', 'shared body');
    yield* write('edited', 'tn_edited', 'edited body');
    const before = (yield* loadRecallIndexData(config, {includeInactive: false, memoryIds: []})).generation;
    // A new memory that joins the identity of an unchanged one, and one edited memory.
    yield* write('joining', 'tn_shared', 'shared body');
    yield* write('edited', 'tn_edited', 'edited body, revised');
    const after = (yield* loadRecallIndexData(config, {includeInactive: false, memoryIds: []})).generation;
    const inputs = yield* readRecallMaskLexicalInputs(config, before);
    expect(inputs.state).toBe('known');
    if (inputs.state !== 'known') return;
    expect(inputs.contentGeneration).toBe(after);
    expect(EffectArray.map(inputs.changed, entry => `${entry.kind}:${entry.uri}`).sort()).toEqual([
      `added:${uri('joining')}`,
      `changed:${uri('edited')}`,
    ]);
    expect([...inputs.identityUris].sort()).toEqual([uri('edited'), uri('joining'), uri('shared')]);
    expect(yield* readRecallMaskLexicalInputs(config, 'no-such-generation')).toEqual({state: 'unknown'});
  }).pipe(
    Effect.scoped,
    effect =>
      Effect.scoped(Layer.build(services).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context))))),
    TestClock.withLive,
  ),
);
