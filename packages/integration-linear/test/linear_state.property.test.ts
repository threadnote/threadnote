import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Result, Schema} from 'effect';
import {describe, expect} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  LINEAR_MAX_RETAINED_OBJECTS,
  LINEAR_MAX_SYNC_STATE_BYTES,
  readLinearSyncState,
  writeLinearSyncState,
  type LinearSyncState,
} from '../src/state.js';
import {uuid} from './fixtures.js';

const retainedId = (n: number) => `document-${n.toString(16).padStart(40, '0')}`;
const checkpoint = (retained: readonly string[]): LinearSyncState => ({
  version: 1,
  fingerprint: 'a'.repeat(64),
  accessEpoch: 'b'.repeat(64),
  projectIndex: 64,
  issueIds: [],
  enumerated: true,
  offset: 42,
  retained,
  incomplete: false,
});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'linear-state-'}));
  return {fs, config: {agentContextHome: home} as RuntimeConfig};
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const stateInputs = Schema.Struct({
  projects: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 64})),
  issueNumbers: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 10000}))).check(
    Schema.isMaxLength(100),
  ),
  retainedNumbers: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 10000}))).check(
    Schema.isMaxLength(200),
  ),
  enumerated: Schema.Boolean,
  incomplete: Schema.Boolean,
});

describe('Linear checkpoint persistence', () => {
  effectIt.effect.prop(
    'round-trips bounded valid checkpoints without mutating their input',
    [stateInputs],
    ([input]) =>
      Effect.gen(function* () {
        const {config} = yield* fixture;
        const issueIds = [...new Set(input.issueNumbers)].map(uuid);
        const state: LinearSyncState = {
          ...checkpoint([...new Set(input.retainedNumbers)].map(retainedId)),
          projectIndex: input.projects,
          issueIds,
          offset: input.enumerated ? issueIds.length + input.projects : 0,
          enumerated: input.enumerated,
          incomplete: input.incomplete,
        };
        const before = JSON.stringify(state);
        yield* writeLinearSyncState(config, 'property-source', state, Effect.void);
        expect(yield* readLinearSyncState(config, 'property-source')).toEqual(state);
        yield* writeLinearSyncState(config, 'property-source', state, Effect.void);
        expect(yield* readLinearSyncState(config, 'property-source')).toEqual(state);
        expect(JSON.stringify(state)).toBe(before);
      }).pipe(provide),
    {arbitrary: {runs: 30}},
  );
  effectIt.effect('resumes a selected-project checkpoint above 8,192 retained objects', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      const initial = checkpoint(Array.from({length: 42 * 201}, (_, n) => retainedId(n)));
      yield* writeLinearSyncState(config, 'many-projects', initial, Effect.void);
      const saved = yield* readLinearSyncState(config, 'many-projects');
      expect(saved).toEqual(initial);
      const resumed = {...initial, offset: 54, retained: [...initial.retained, retainedId(42 * 201)]};
      yield* writeLinearSyncState(config, 'many-projects', resumed, Effect.void);
      expect(yield* readLinearSyncState(config, 'many-projects')).toEqual(resumed);
    }).pipe(provide),
  );
  effectIt.effect('accepts the maximum supported cumulative collection within its byte limit', () =>
    Effect.gen(function* () {
      const {config, fs} = yield* fixture;
      const state = {
        ...checkpoint(Array.from({length: LINEAR_MAX_RETAINED_OBJECTS}, (_, n) => retainedId(n))),
        issueIds: Array.from({length: 2000}, (_, n) => uuid(n + 1)),
        offset: 2064,
      };
      yield* writeLinearSyncState(config, 'maximum', state, Effect.void);
      const size = (yield* fs.stat(`${config.agentContextHome}/threadnote/integrations/linear/maximum.json`)).size;
      expect(size).toBeGreaterThan(1024n * 1024n);
      expect(size).toBeLessThanOrEqual(BigInt(LINEAR_MAX_SYNC_STATE_BYTES));
      expect(yield* readLinearSyncState(config, 'maximum')).toEqual(state);
    }).pipe(provide),
  );
  effectIt.effect('rejects invalid or oversized writes before replacing a valid checkpoint', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture;
      const state = checkpoint([retainedId(1)]);
      yield* writeLinearSyncState(config, 'protected', state, Effect.void);
      for (const invalid of [
        {...state, retained: [retainedId(1), retainedId(1)]},
        {...state, issueIds: ['not-a-uuid']},
        {...state, extra: 'x'.repeat(LINEAR_MAX_SYNC_STATE_BYTES)},
      ]) {
        const result = yield* writeLinearSyncState(config, 'protected', invalid, Effect.void).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(yield* readLinearSyncState(config, 'protected')).toEqual(state);
      }
    }).pipe(provide),
  );
});
