import {it as effectIt} from '@effect/vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {Observation} from '@threadnote/semantic/contracts';
/* oxlint-disable effecttsgo/strict-effect-provide -- Each Effect example supplies only its narrow crypto layer. */
import {Array as EffectArray, String as EffectString, Effect, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {makeSemanticActionChoices, semanticActionChoiceLimits} from '../../src/semantic/action_choices.js';
const observation: Observation = {
  version: 1,
  repository: 'repo',
  worktree: 'file:///workspace',
  project: 'file:///workspace',
  configuration: sha256HexSync('config'),
  toolchain: sha256HexSync('tools'),
  provider: {id: 'typescript-language-server', version: '6.0.2', generation: 1},
  view: {kind: 'disk', id: 'view', owner: 'owner', epoch: 0},
  uri: 'file:///workspace/a.ts',
  content: sha256HexSync('source'),
  documentVersion: null,
  projectEpoch: 1,
};
const choice = {
  kind: 'action-choice',
  title: 'Sort Imports',
  actionKind: 'source.sortImports.ts',
  disabled: null,
  command: false,
  qualified: true,
  selector: sha256HexSync('selector'),
  queryDigest: sha256HexSync('query'),
  blocker: null,
};
effectIt.effect('expires absolute capabilities and conserves aggregate quota without evicting live choices', () =>
  Effect.gen(function* () {
    const store = yield* makeSemanticActionChoices();
    const first = yield* store.retain([choice], 'principal/profile/view/query', observation);
    const handle = first.choices[0].choiceHandle;
    for (let i = 1; i < semanticActionChoiceLimits.maxListings; i++)
      yield* store.retain([choice], 'scope', observation);
    expect((yield* store.retain([choice], 'scope', observation).pipe(Effect.exit))._tag).toBe('Failure');
    expect(yield* store.get(handle, 'principal/profile/view/query', observation)).toEqual(choice);
    yield* TestClock.adjust(semanticActionChoiceLimits.ttlMilliseconds);
    expect(yield* store.get(handle, 'principal/profile/view/query', observation)).toBeUndefined();
    const next = yield* store.retain([choice], 'scope', observation);
    yield* store.discard(
      EffectArray.map(next.choices, item => item.choiceHandle),
      'wrong-scope',
    );
    expect(yield* store.get(next.choices[0].choiceHandle, 'scope', observation)).toEqual(choice);
    yield* store.discard(
      EffectArray.map(next.choices, item => item.choiceHandle),
      'scope',
    );
    expect(yield* store.get(next.choices[0].choiceHandle, 'scope', observation)).toBeUndefined();
    expect(
      yield* (yield* makeSemanticActionChoices()).get(next.choices[0].choiceHandle, 'scope', observation),
    ).toBeUndefined();
  }).pipe(Effect.provide(cryptoLayer)),
);
effectIt.effect('rejects whole oversized choice sets and does not retain caller mutation', () =>
  Effect.gen(function* () {
    const store = yield* makeSemanticActionChoices();
    expect(
      (yield* store
        .retain(
          Array.from({length: 129}, () => choice),
          'scope',
          observation,
        )
        .pipe(Effect.exit))._tag,
    ).toBe('Failure');
    const large = {...choice, title: EffectString.repeat(8192)('x'), disabled: EffectString.repeat(8192)('x')};
    expect(
      (yield* store
        .retain(
          Array.from({length: 128}, () => large),
          'scope',
          observation,
        )
        .pipe(Effect.exit))._tag,
    ).toBe('Failure');
    const mutable = {...choice};
    const retained = yield* store.retain([mutable], 'scope', observation);
    mutable.title = 'changed';
    expect(yield* store.get(retained.choices[0].choiceHandle, 'scope', observation)).toEqual(choice);
  }).pipe(Effect.provide(cryptoLayer)),
);
effectIt.effect.prop(
  'changing any bound observation dimension or host/query binding invalidates the choice',
  [
    Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 17})),
    Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 99})),
  ],
  ([field, amount]) =>
    Effect.gen(function* () {
      const store = yield* makeSemanticActionChoices();
      const retained = yield* store.retain([choice], 'scope', observation);
      const mutations: Observation[] = [
        {...observation, repository: observation.repository + amount},
        {...observation, worktree: observation.worktree + amount},
        {...observation, project: observation.project + amount},
        {...observation, configuration: sha256HexSync(String(amount))},
        {...observation, toolchain: sha256HexSync(String(amount))},
        {...observation, provider: {...observation.provider, id: observation.provider.id + amount}},
        {...observation, provider: {...observation.provider, version: observation.provider.version + amount}},
        {...observation, provider: {...observation.provider, generation: observation.provider.generation + amount}},
        {...observation, view: {...observation.view, kind: 'overlay'}},
        {...observation, view: {...observation.view, id: observation.view.id + amount}},
        {...observation, view: {...observation.view, owner: observation.view.owner + amount}},
        {...observation, view: {...observation.view, epoch: observation.view.epoch + amount}},
        {...observation, uri: observation.uri + amount},
        {...observation, content: sha256HexSync(String(amount))},
        {...observation, documentVersion: amount},
        {...observation, projectEpoch: observation.projectEpoch + amount},
      ];
      const changed = mutations[field] ?? observation;
      expect(
        yield* store.get(
          retained.choices[0].choiceHandle,
          field >= mutations.length ? 'changed-' + amount : 'scope',
          changed,
        ),
      ).toBeUndefined();
    }).pipe(Effect.provide(cryptoLayer)),
  {arbitrary: {runs: 40}},
);
